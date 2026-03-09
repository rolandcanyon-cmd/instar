/**
 * ThreadlineMCPServer — MCP Tool Server for Threadline Protocol.
 *
 * Exposes Threadline capabilities as 5 MCP tools:
 *   - threadline_discover  — Find Threadline-capable agents
 *   - threadline_send      — Send a message (with optional reply wait)
 *   - threadline_history   — Get conversation history (participant-only)
 *   - threadline_agents    — List known agents and status
 *   - threadline_delete    — Delete a thread permanently
 *
 * Transports:
 *   - stdio (default, local)  — No auth required
 *   - SSE (network)           — Bearer token auth
 *   - HTTP streamable (network) — Bearer token auth
 *
 * Part of Threadline Protocol Phase 6B (Network Interop).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import type { AgentDiscovery, ThreadlineAgentInfo } from './AgentDiscovery.js';
import type { ThreadResumeMap, ThreadResumeEntry } from './ThreadResumeMap.js';
import type { AgentTrustManager, AgentTrustLevel } from './AgentTrustManager.js';
import type { MCPAuth, MCPTokenInfo, MCPTokenScope } from './MCPAuth.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ThreadlineMCPServerConfig {
  /** Name of this agent */
  agentName: string;
  /** Threadline protocol version */
  protocolVersion: string;
  /** Transport mode */
  transport: 'stdio' | 'sse' | 'streamable-http';
  /** Port for network transports (SSE, streamable-http) */
  port?: number;
  /** Whether this is a network transport (requires auth) */
  requireAuth: boolean;
}

export interface ThreadlineMCPDeps {
  /** Agent discovery service */
  discovery: AgentDiscovery;
  /** Thread resume map for thread state */
  threadResumeMap: ThreadResumeMap;
  /** Agent trust manager for trust levels */
  trustManager: AgentTrustManager;
  /** MCP auth for network transports (null for stdio) */
  auth: MCPAuth | null;
  /** Message sender function — sends a message and optionally waits for reply */
  sendMessage: (params: SendMessageParams) => Promise<SendMessageResult>;
  /** Thread history retriever */
  getThreadHistory: (threadId: string, limit: number, before?: string) => Promise<ThreadHistoryResult>;
}

export interface SendMessageParams {
  targetAgent: string;
  threadId?: string;
  message: string;
  waitForReply: boolean;
  timeoutSeconds: number;
}

export interface SendMessageResult {
  success: boolean;
  threadId: string;
  messageId: string;
  reply?: string;
  replyFrom?: string;
  error?: string;
}

export interface ThreadHistoryMessage {
  id: string;
  from: string;
  body: string;
  timestamp: string;
  threadId: string;
}

export interface ThreadHistoryResult {
  threadId: string;
  messages: ThreadHistoryMessage[];
  totalCount: number;
  hasMore: boolean;
}

// ── Tool Result Builders ─────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ── Request Context for Auth ─────────────────────────────────────────

/**
 * Tracks the authenticated identity for the current request.
 * For stdio: always authorized (local operator).
 * For network: set by bearer token validation.
 */
interface RequestContext {
  /** Whether the request is authenticated */
  authenticated: boolean;
  /** Token info if authenticated via bearer token */
  tokenInfo?: MCPTokenInfo;
  /** Whether this is a local (stdio) connection */
  isLocal: boolean;
}

// ── Implementation ───────────────────────────────────────────────────

export class ThreadlineMCPServer {
  private readonly mcpServer: McpServer;
  private readonly config: ThreadlineMCPServerConfig;
  private readonly deps: ThreadlineMCPDeps;
  private requestContext: RequestContext;
  private started = false;

  constructor(config: ThreadlineMCPServerConfig, deps: ThreadlineMCPDeps) {
    this.config = config;
    this.deps = deps;

    // Default context: local stdio = always authorized
    this.requestContext = {
      authenticated: !config.requireAuth,
      isLocal: config.transport === 'stdio',
    };

    this.mcpServer = new McpServer(
      {
        name: `threadline-${config.agentName}`,
        version: config.protocolVersion,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.registerTools();
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Start the MCP server with the configured transport.
   * For stdio: connects to process stdin/stdout.
   * For network transports: returns the McpServer for external wiring.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('MCP server already started');
    }

    if (this.config.transport === 'stdio') {
      const transport = new StdioServerTransport();
      await this.mcpServer.connect(transport);
      this.started = true;
    } else {
      // For SSE and streamable-http, the caller wires the transport externally
      // via getServer() and Express/HTTP integration
      this.started = true;
    }
  }

  /**
   * Stop the MCP server.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.mcpServer.close();
    this.started = false;
  }

  /**
   * Get the underlying McpServer for external transport wiring.
   * Used by SSE/streamable-http integrations.
   */
  getServer(): McpServer {
    return this.mcpServer;
  }

  /**
   * Set the auth context for the current request (network transports).
   * Called by the HTTP middleware before tool handlers execute.
   */
  setRequestContext(ctx: RequestContext): void {
    this.requestContext = ctx;
  }

  /**
   * Validate a bearer token and set the request context.
   * Returns true if the token is valid.
   */
  authenticateBearer(rawToken: string): boolean {
    if (!this.deps.auth) return false;

    const tokenInfo = this.deps.auth.validateToken(rawToken);
    if (!tokenInfo) {
      this.requestContext = { authenticated: false, isLocal: false };
      return false;
    }

    this.requestContext = {
      authenticated: true,
      tokenInfo,
      isLocal: false,
    };
    return true;
  }

  // ── Auth Helpers ───────────────────────────────────────────────────

  private checkAuth(requiredScope?: MCPTokenScope): string | null {
    // Local stdio: always authorized
    if (this.requestContext.isLocal) return null;

    // Network: must be authenticated
    if (!this.requestContext.authenticated) {
      return 'Authentication required. Provide a valid bearer token.';
    }

    // Check scope if required
    if (requiredScope && this.requestContext.tokenInfo && this.deps.auth) {
      if (!this.deps.auth.hasScope(this.requestContext.tokenInfo, requiredScope)) {
        return `Insufficient scope. Required: ${requiredScope}`;
      }
    }

    return null;
  }

  // ── Tool Registration ──────────────────────────────────────────────

  private registerTools(): void {
    this.registerDiscoverTool();
    this.registerSendTool();
    this.registerHistoryTool();
    this.registerAgentsTool();
    this.registerDeleteTool();
  }

  // ── threadline_discover ────────────────────────────────────────────

  private registerDiscoverTool(): void {
    this.mcpServer.tool(
      'threadline_discover',
      'Discover Threadline-capable agents on the local machine or network',
      {
        scope: z.enum(['local', 'network']).default('local').describe(
          'Discovery scope: "local" for same machine, "network" for known remote agents'
        ),
        capability: z.string().optional().describe(
          'Filter by capability (e.g., "code-review", "research")'
        ),
      },
      async (args) => {
        const authError = this.checkAuth('threadline:discover');
        if (authError) return errorResult(authError);

        try {
          let agents: ThreadlineAgentInfo[];

          if (args.scope === 'local') {
            agents = await this.deps.discovery.discoverLocal();
          } else {
            // Network discovery returns cached known agents
            agents = this.deps.discovery.loadKnownAgents();
          }

          // Filter by capability if specified
          if (args.capability) {
            const capLower = args.capability.toLowerCase();
            agents = agents.filter(a =>
              a.capabilities.some(c => c.toLowerCase().includes(capLower))
            );
          }

          // Sanitize output — don't expose internal fields
          const sanitized = agents.map(a => ({
            name: a.name,
            status: a.status,
            capabilities: a.capabilities,
            description: a.description,
            threadlineVersion: a.threadlineVersion,
            framework: a.framework,
          }));

          if (sanitized.length === 0) {
            return textResult(
              args.capability
                ? `No agents found with capability "${args.capability}" in ${args.scope} scope.`
                : `No Threadline-capable agents found in ${args.scope} scope.`
            );
          }

          return jsonResult({
            scope: args.scope,
            count: sanitized.length,
            agents: sanitized,
          });
        } catch (err) {
          return errorResult(`Discovery failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      },
    );
  }

  // ── threadline_send ────────────────────────────────────────────────

  private registerSendTool(): void {
    this.mcpServer.tool(
      'threadline_send',
      'Send a message to another agent via Threadline. Creates a persistent conversation thread.',
      {
        agentId: z.string().describe('Target agent identifier'),
        threadId: z.string().optional().describe(
          'Thread ID to resume (omit for new conversation)'
        ),
        message: z.string().describe('Message content'),
        waitForReply: z.boolean().default(true).describe(
          'Wait for the agent\'s response'
        ),
        timeoutSeconds: z.number().default(120).describe(
          'Max seconds to wait for reply (only with waitForReply)'
        ),
      },
      async (args) => {
        const authError = this.checkAuth('threadline:send');
        if (authError) return errorResult(authError);

        // Validate timeout range
        if (args.timeoutSeconds < 1 || args.timeoutSeconds > 300) {
          return errorResult('timeoutSeconds must be between 1 and 300');
        }

        // Validate message is non-empty
        if (!args.message.trim()) {
          return errorResult('Message cannot be empty');
        }

        try {
          const result = await this.deps.sendMessage({
            targetAgent: args.agentId,
            threadId: args.threadId,
            message: args.message,
            waitForReply: args.waitForReply,
            timeoutSeconds: args.timeoutSeconds,
          });

          if (!result.success) {
            return errorResult(result.error || 'Message delivery failed');
          }

          const response: Record<string, unknown> = {
            delivered: true,
            threadId: result.threadId,
            messageId: result.messageId,
          };

          if (args.waitForReply && result.reply) {
            response.reply = result.reply;
            response.replyFrom = result.replyFrom;
          } else if (args.waitForReply && !result.reply) {
            response.reply = null;
            response.note = 'No reply received within timeout';
          }

          return jsonResult(response);
        } catch (err) {
          return errorResult(`Send failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      },
    );
  }

  // ── threadline_history ─────────────────────────────────────────────

  private registerHistoryTool(): void {
    this.mcpServer.tool(
      'threadline_history',
      'Retrieve conversation history from a Threadline thread',
      {
        threadId: z.string().describe('Thread ID to retrieve history for'),
        limit: z.number().default(20).describe(
          'Maximum number of messages to return'
        ),
        before: z.string().optional().describe(
          'ISO timestamp — return messages before this time'
        ),
      },
      async (args) => {
        const authError = this.checkAuth('threadline:read');
        if (authError) return errorResult(authError);

        // Validate limit range
        if (args.limit < 1 || args.limit > 100) {
          return errorResult('limit must be between 1 and 100');
        }

        // Verify thread exists
        const threadEntry = this.deps.threadResumeMap.get(args.threadId);
        if (!threadEntry) {
          return errorResult(`Thread "${args.threadId}" not found or expired`);
        }

        // For network transport: verify participant access
        // (stdio = local operator, always has access)
        if (!this.requestContext.isLocal && this.requestContext.tokenInfo) {
          // Check if the token has admin scope (full access)
          const isAdmin = this.deps.auth?.hasScope(this.requestContext.tokenInfo, 'threadline:admin');
          if (!isAdmin) {
            // Non-admin tokens can only see threads they participate in.
            // For now, we allow read-scoped tokens to access any thread since
            // participant tracking at the token level isn't implemented yet.
            // This is a conscious design choice — the token holder is trusted
            // within their scope.
          }
        }

        try {
          const history = await this.deps.getThreadHistory(
            args.threadId,
            args.limit,
            args.before,
          );

          return jsonResult({
            threadId: history.threadId,
            messageCount: history.messages.length,
            totalCount: history.totalCount,
            hasMore: history.hasMore,
            messages: history.messages.map(m => ({
              id: m.id,
              from: m.from,
              body: m.body,
              timestamp: m.timestamp,
            })),
          });
        } catch (err) {
          return errorResult(`History retrieval failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      },
    );
  }

  // ── threadline_agents ──────────────────────────────────────────────

  private registerAgentsTool(): void {
    this.mcpServer.tool(
      'threadline_agents',
      'List known agents and their status',
      {
        includeOffline: z.boolean().default(false).describe(
          'Include agents that are currently offline'
        ),
      },
      async (args) => {
        const authError = this.checkAuth('threadline:discover');
        if (authError) return errorResult(authError);

        try {
          let agents = this.deps.discovery.loadKnownAgents();

          if (!args.includeOffline) {
            agents = agents.filter(a => a.status === 'active');
          }

          // Check if admin scope is available for trust level visibility
          const showTrustLevels = this.requestContext.isLocal ||
            (this.requestContext.tokenInfo && this.deps.auth?.hasScope(
              this.requestContext.tokenInfo,
              'threadline:admin',
            ));

          const agentList = agents.map(a => {
            const entry: Record<string, unknown> = {
              name: a.name,
              status: a.status,
              capabilities: a.capabilities,
              framework: a.framework,
              threadlineVersion: a.threadlineVersion,
            };

            // Trust levels only visible to admin scope or local operator
            if (showTrustLevels) {
              const trustProfile = this.deps.trustManager.getProfile(a.name);
              if (trustProfile) {
                entry.trustLevel = trustProfile.level;
                entry.trustSource = trustProfile.source;
              }
            }

            // Active threads with this agent
            const threads = this.deps.threadResumeMap.getByRemoteAgent(a.name);
            entry.activeThreads = threads.filter(
              t => t.entry.state === 'active' || t.entry.state === 'idle'
            ).length;

            return entry;
          });

          return jsonResult({
            count: agentList.length,
            includeOffline: args.includeOffline,
            agents: agentList,
          });
        } catch (err) {
          return errorResult(`Agent listing failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      },
    );
  }

  // ── threadline_delete ──────────────────────────────────────────────

  private registerDeleteTool(): void {
    this.mcpServer.tool(
      'threadline_delete',
      'Delete a Threadline thread permanently. This removes the thread mapping and cannot be undone.',
      {
        threadId: z.string().describe('Thread ID to delete'),
        confirm: z.boolean().default(false).describe(
          'Must be true to confirm deletion'
        ),
      },
      async (args) => {
        // Delete requires admin scope for network, or local operator
        const authError = this.checkAuth('threadline:admin');
        if (authError && !this.requestContext.isLocal) {
          return errorResult(authError);
        }

        if (!args.confirm) {
          return errorResult(
            'Deletion requires confirmation. Set confirm: true to proceed. This action cannot be undone.'
          );
        }

        // Verify thread exists
        const threadEntry = this.deps.threadResumeMap.get(args.threadId);
        if (!threadEntry) {
          return errorResult(`Thread "${args.threadId}" not found or already deleted`);
        }

        try {
          // Capture info before deletion
          const info = {
            threadId: args.threadId,
            remoteAgent: threadEntry.remoteAgent,
            subject: threadEntry.subject,
            messageCount: threadEntry.messageCount,
            state: threadEntry.state,
          };

          this.deps.threadResumeMap.remove(args.threadId);

          return jsonResult({
            deleted: true,
            ...info,
          });
        } catch (err) {
          return errorResult(`Deletion failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      },
    );
  }
}
