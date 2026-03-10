/**
 * PresenceRegistry — Tracks which agents are online and their metadata.
 *
 * Part of Threadline Relay Phase 1. Powers agent discovery.
 * In-memory with no persistence (relay is stateless between restarts).
 */

import type {
  AgentFingerprint,
  AgentMetadata,
  AgentVisibility,
  PresenceEntry,
} from './types.js';

export class PresenceRegistry {
  private readonly agents = new Map<AgentFingerprint, PresenceEntry>();
  private readonly subscriptions = new Map<AgentFingerprint, Set<AgentFingerprint>>();
  private readonly maxAgents: number;

  constructor(options?: { maxAgents?: number }) {
    this.maxAgents = options?.maxAgents ?? 10000;
  }

  /**
   * Register an agent as online.
   * Returns the previous entry if the agent was already registered (displacement).
   */
  register(
    agentId: AgentFingerprint,
    publicKey: string,
    metadata: AgentMetadata,
    visibility: AgentVisibility,
    sessionId: string,
  ): PresenceEntry | null {
    const existing = this.agents.get(agentId);
    const now = new Date().toISOString();

    if (this.agents.size >= this.maxAgents && !existing) {
      throw new Error(`Relay at capacity (${this.maxAgents} agents)`);
    }

    const entry: PresenceEntry = {
      agentId,
      publicKey,
      metadata,
      visibility,
      status: 'online',
      connectedSince: existing?.connectedSince ?? now,
      lastSeen: now,
      sessionId,
    };

    this.agents.set(agentId, entry);
    return existing ?? null;
  }

  /**
   * Mark an agent as offline and remove from registry.
   */
  unregister(agentId: AgentFingerprint): PresenceEntry | null {
    const entry = this.agents.get(agentId);
    if (!entry) return null;
    this.agents.delete(agentId);
    // Clean up subscriptions
    this.subscriptions.delete(agentId);
    for (const [, subscribers] of this.subscriptions) {
      subscribers.delete(agentId);
    }
    return entry;
  }

  /**
   * Update last seen timestamp (heartbeat).
   */
  touch(agentId: AgentFingerprint): void {
    const entry = this.agents.get(agentId);
    if (entry) {
      entry.lastSeen = new Date().toISOString();
    }
  }

  /**
   * Get a specific agent's presence entry.
   */
  get(agentId: AgentFingerprint): PresenceEntry | null {
    return this.agents.get(agentId) ?? null;
  }

  /**
   * Check if an agent is online.
   */
  isOnline(agentId: AgentFingerprint): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Discover agents matching a filter.
   * Only returns agents with visibility='public'.
   */
  discover(filter?: {
    capability?: string;
    framework?: string;
    name?: string;
  }): PresenceEntry[] {
    const results: PresenceEntry[] = [];
    for (const entry of this.agents.values()) {
      if (entry.visibility !== 'public') continue;

      if (filter?.name && entry.metadata.name !== filter.name) continue;
      if (filter?.framework && entry.metadata.framework !== filter.framework) continue;
      if (filter?.capability) {
        if (!entry.metadata.capabilities?.includes(filter.capability)) continue;
      }

      results.push(entry);
    }
    return results;
  }

  /**
   * Subscribe an agent to presence changes of other agents.
   */
  subscribe(subscriberId: AgentFingerprint, targetIds?: AgentFingerprint[]): void {
    if (targetIds) {
      for (const targetId of targetIds) {
        if (!this.subscriptions.has(targetId)) {
          this.subscriptions.set(targetId, new Set());
        }
        this.subscriptions.get(targetId)!.add(subscriberId);
      }
    } else {
      // Subscribe to all — use special key '*'
      if (!this.subscriptions.has('*')) {
        this.subscriptions.set('*', new Set());
      }
      this.subscriptions.get('*')!.add(subscriberId);
    }
  }

  /**
   * Get agents subscribed to presence changes of a specific agent.
   */
  getSubscribers(agentId: AgentFingerprint): AgentFingerprint[] {
    const subscribers = new Set<AgentFingerprint>();
    // Specific subscriptions
    const specific = this.subscriptions.get(agentId);
    if (specific) {
      for (const sub of specific) subscribers.add(sub);
    }
    // Wildcard subscriptions
    const wildcard = this.subscriptions.get('*');
    if (wildcard) {
      for (const sub of wildcard) subscribers.add(sub);
    }
    // Don't notify the agent about its own changes
    subscribers.delete(agentId);
    return [...subscribers];
  }

  /**
   * Get total number of registered agents.
   */
  get size(): number {
    return this.agents.size;
  }

  /**
   * Get all registered agents (for admin/debug).
   */
  getAll(): PresenceEntry[] {
    return [...this.agents.values()];
  }
}
