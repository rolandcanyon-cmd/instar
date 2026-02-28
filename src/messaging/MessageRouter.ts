/**
 * MessageRouter — message sending, routing, acknowledgment, and relay.
 *
 * The primary entry point for the messaging subsystem. Handles:
 * - Creating and sending messages with proper envelope wrapping
 * - Routing to local, cross-agent (same machine), or cross-machine targets
 * - Default TTL assignment per message type
 * - Thread auto-creation for query/request types
 * - Echo prevention (cannot send to self)
 * - Relay chain loop detection
 * - Deduplication on relay receipt
 * - Delivery state monotonic transitions
 * - Drop-directory fallback for offline agents
 *
 * Routing decision tree (from INTER-AGENT-MESSAGING-SPEC v3.1):
 *   target machine == local?
 *     → Yes: target agent == local agent?
 *       → Yes: deliver locally (no relay needed)
 *       → No: relay via POST /api/messages/relay-agent (Bearer token)
 *              If agent down → write to drop directory with HMAC
 *     → No: cross-machine relay (Phase 4 — future)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  IMessageRouter,
  AgentMessage,
  MessageEnvelope,
  MessageType,
  MessagePriority,
  SendMessageOptions,
  SendResult,
  DeliveryState,
  MessagingStats,
} from './types.js';
import { DEFAULT_TTL, VALID_TRANSITIONS } from './types.js';
import type { MessageStore } from './MessageStore.js';
import type { MessageDelivery } from './MessageDelivery.js';
import { getAgentToken, computeDropHmac } from './AgentTokenManager.js';
import { listAgents } from '../core/AgentRegistry.js';
import type { AgentRegistryEntry } from '../core/types.js';

export interface MessageRouterConfig {
  localAgent: string;
  localMachine: string;
  serverUrl: string;
}

export class MessageRouter implements IMessageRouter {
  private readonly store: MessageStore;
  private readonly delivery: MessageDelivery;
  private readonly config: MessageRouterConfig;

  constructor(store: MessageStore, delivery: MessageDelivery, config: MessageRouterConfig) {
    this.store = store;
    this.delivery = delivery;
    this.config = config;
  }

  async send(
    from: AgentMessage['from'],
    to: AgentMessage['to'],
    type: MessageType,
    priority: MessagePriority,
    subject: string,
    body: string,
    options?: SendMessageOptions,
  ): Promise<SendResult> {
    // Echo prevention: cannot send to the same session on the same agent
    if (
      from.agent === to.agent &&
      from.session === to.session &&
      (to.machine === 'local' || to.machine === from.machine)
    ) {
      throw new Error('Cannot send a message to the same session (echo prevention)');
    }

    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    const ttlMinutes = options?.ttlMinutes ?? DEFAULT_TTL[type];

    // Auto-create thread for query and request types
    let threadId = options?.threadId;
    if (!threadId && (type === 'query' || type === 'request')) {
      threadId = crypto.randomUUID();
    }

    const message: AgentMessage = {
      id: messageId,
      from,
      to,
      type,
      priority,
      subject,
      body,
      createdAt: now,
      ttlMinutes,
      threadId,
      inReplyTo: options?.inReplyTo,
    };

    const envelope: MessageEnvelope = {
      schemaVersion: 1,
      message,
      transport: {
        relayChain: [],
        originServer: this.config.serverUrl,
        nonce: `${crypto.randomUUID()}:${now}`,
        timestamp: now,
      },
      delivery: {
        phase: 'sent',
        transitions: [
          { from: 'created', to: 'sent', at: now },
        ],
        attempts: 0,
      },
    };

    // Save to local store (outbox)
    await this.store.save(envelope);

    // Route the message based on target
    const isLocalMachine = to.machine === 'local' || to.machine === this.config.localMachine;
    const isLocalAgent = to.agent === this.config.localAgent;

    if (isLocalMachine && !isLocalAgent) {
      // Cross-agent, same machine → relay via HTTP or drop directory
      await this.routeCrossAgentLocal(envelope);
    }
    // If isLocalMachine && isLocalAgent → already saved locally, delivery is handled
    // by the local agent's session delivery mechanism
    // If !isLocalMachine → cross-machine (Task 3 — queued for future implementation)

    return {
      messageId,
      threadId,
      phase: envelope.delivery.phase,
    };
  }

  async acknowledge(messageId: string, sessionId: string): Promise<void> {
    const envelope = await this.store.get(messageId);
    if (!envelope) return;

    // Validate transition: must be at 'delivered' to advance to 'read'
    if (!this.isValidTransition(envelope.delivery.phase, 'read')) {
      return;
    }

    const now = new Date().toISOString();
    const delivery: DeliveryState = {
      ...envelope.delivery,
      phase: 'read',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'read', at: now, reason: `ack by ${sessionId}` },
      ],
    };

    await this.store.updateDelivery(messageId, delivery);
  }

  async relay(envelope: MessageEnvelope, source: 'agent' | 'machine'): Promise<boolean> {
    // Loop prevention: check if our machine is already in the relay chain
    if (envelope.transport.relayChain.includes(this.config.localMachine)) {
      return false;
    }

    // Deduplication: if message already exists, return ACK but don't re-store
    if (await this.store.exists(envelope.message.id)) {
      return true;
    }

    // Update delivery phase to 'received'
    const now = new Date().toISOString();
    envelope.delivery = {
      phase: 'received',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'received', at: now },
      ],
      attempts: 0,
    };

    await this.store.save(envelope);
    return true;
  }

  async getStats(): Promise<MessagingStats> {
    return this.store.getStats();
  }

  // ── Routing: Cross-Agent Same-Machine ───────────────────────────

  /**
   * Route a message to a different agent on the same machine.
   *
   * Resolution order (per spec §Cross-Agent Resolution):
   * 1. Look up target agent in ~/.instar/registry.json
   * 2. Verify agent is running (PID alive + server responds to health)
   * 3. Forward via POST http://localhost:{port}/messages/relay-agent
   *    with Bearer token from ~/.instar/agent-tokens/{agentName}.token
   * 4. If agent server is down → write to drop directory with HMAC
   */
  private async routeCrossAgentLocal(envelope: MessageEnvelope): Promise<void> {
    const targetAgent = envelope.message.to.agent;

    // Look up target agent in registry
    const agents = listAgents({ status: 'running' });
    const targetEntry = agents.find(a => a.name === targetAgent);

    if (!targetEntry) {
      // Agent not registered — drop to filesystem
      await this.dropMessage(envelope, targetAgent, 'agent not registered');
      return;
    }

    // Try HTTP relay first
    const relaySuccess = await this.relayToAgent(envelope, targetEntry);
    if (relaySuccess) {
      // Update delivery phase to 'received' (both store and in-memory envelope)
      const now = new Date().toISOString();
      envelope.delivery = {
        ...envelope.delivery,
        phase: 'received',
        transitions: [
          ...envelope.delivery.transitions,
          { from: 'sent', to: 'received', at: now, reason: `relayed to ${targetAgent}` },
        ],
        attempts: envelope.delivery.attempts + 1,
      };
      await this.store.updateDelivery(envelope.message.id, envelope.delivery);
      return;
    }

    // HTTP relay failed — fall back to drop directory
    await this.dropMessage(envelope, targetAgent, 'relay failed (agent server unreachable)');
  }

  /**
   * Relay an envelope to another agent's server via HTTP.
   * Returns true if the target accepted the message.
   */
  private async relayToAgent(envelope: MessageEnvelope, target: AgentRegistryEntry): Promise<boolean> {
    // Read target agent's token for Bearer auth
    const targetToken = getAgentToken(target.name);
    if (!targetToken) {
      return false; // No token — can't authenticate
    }

    try {
      const url = `http://localhost:${target.port}/messages/relay-agent`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${targetToken}`,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(5000),
      });

      return response.ok;
    } catch {
      // @silent-fallback-ok — network failure, will fall back to drop directory
      return false;
    }
  }

  /**
   * Write a message to the drop directory for offline pickup.
   * The drop is HMAC-signed with the sender's token for tamper protection.
   *
   * Drop path: ~/.instar/messages/drop/{targetAgentName}/{messageId}.json
   */
  private async dropMessage(
    envelope: MessageEnvelope,
    targetAgent: string,
    reason: string,
  ): Promise<void> {
    const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', targetAgent);
    fs.mkdirSync(dropDir, { recursive: true });

    // Compute HMAC with sender's token
    const senderToken = getAgentToken(this.config.localAgent);
    if (senderToken) {
      const hmac = computeDropHmac(senderToken, {
        message: envelope.message,
        originServer: envelope.transport.originServer,
        nonce: envelope.transport.nonce,
        timestamp: envelope.transport.timestamp,
      });
      envelope.transport.hmac = hmac;
      envelope.transport.hmacBy = this.config.localAgent;
    }

    // Update delivery phase to 'queued' (awaiting pickup)
    const now = new Date().toISOString();
    envelope.delivery = {
      ...envelope.delivery,
      phase: 'queued',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'queued', at: now, reason: `drop: ${reason}` },
      ],
      attempts: envelope.delivery.attempts + 1,
    };

    // Write envelope to drop directory
    const dropPath = path.join(dropDir, `${envelope.message.id}.json`);
    fs.writeFileSync(dropPath, JSON.stringify(envelope, null, 2), { encoding: 'utf-8' });

    // Also update local store
    await this.store.updateDelivery(envelope.message.id, envelope.delivery);
  }

  // ── Private Helpers ──────────────────────────────────────────────

  private isValidTransition(from: string, to: string): boolean {
    return VALID_TRANSITIONS.some(([f, t]) => f === from && t === to);
  }
}
