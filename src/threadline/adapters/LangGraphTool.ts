/**
 * LangGraphTool — LangGraph-compatible tool definitions for Threadline.
 *
 * Provides Threadline as tool definitions compatible with LangGraph's
 * tool calling interface (which follows the OpenAI function calling format).
 *
 * Part of Threadline Relay Phase 4.
 *
 * @example
 * ```typescript
 * import { ThreadlineClient } from '@anthropic-ai/threadline';
 * import { createLangGraphTools } from '@anthropic-ai/threadline/adapters/langgraph';
 *
 * const client = new ThreadlineClient({ name: 'my-agent' });
 * await client.connect();
 *
 * const { definitions, handlers } = createLangGraphTools(client);
 * // Add definitions to your LangGraph tool node
 * // Use handlers to execute tool calls
 * ```
 */

import type { ThreadlineClient } from '../client/ThreadlineClient.js';

// ── LangGraph / OpenAI Function Call Format ──────────────────────────

export interface LangGraphToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, {
        type: string;
        description: string;
        enum?: string[];
      }>;
      required?: string[];
    };
  };
}

export type LangGraphToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface LangGraphTools {
  definitions: LangGraphToolDefinition[];
  handlers: Record<string, LangGraphToolHandler>;
}

// ── Tool Creation ────────────────────────────────────────────────────

/**
 * Create LangGraph-compatible tool definitions and handlers.
 */
export function createLangGraphTools(client: ThreadlineClient): LangGraphTools {
  const handlers: Record<string, LangGraphToolHandler> = {
    threadline_discover: async (args) => {
      const agents = await client.discover({
        capability: args.capability as string | undefined,
        framework: args.framework as string | undefined,
        name: args.name as string | undefined,
      });
      return JSON.stringify({
        agents: agents.map(a => ({
          agentId: a.agentId,
          name: a.name,
          framework: a.framework,
          capabilities: a.capabilities,
        })),
        count: agents.length,
      });
    },

    threadline_send: async (args) => {
      const recipientId = args.recipientId as string;
      const message = args.message as string;
      const threadId = args.threadId as string | undefined;

      if (!recipientId || !message) {
        return JSON.stringify({ error: 'recipientId and message are required' });
      }

      try {
        const messageId = client.send(recipientId, message, threadId);
        return JSON.stringify({ messageId, status: 'sent' });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    threadline_list_agents: async () => {
      const agents = client.getKnownAgents();
      return JSON.stringify({
        agents: agents.map(a => ({
          agentId: a.agentId,
          name: a.name,
          framework: a.framework,
          capabilities: a.capabilities,
        })),
        count: agents.length,
      });
    },

    threadline_status: async () => {
      return JSON.stringify({
        connectionState: client.connectionState,
        fingerprint: client.fingerprint,
      });
    },
  };

  const definitions: LangGraphToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'threadline_discover',
        description: 'Discover agents on the Threadline relay by capability, framework, or name.',
        parameters: {
          type: 'object',
          properties: {
            capability: {
              type: 'string',
              description: 'Filter by capability (e.g., "conversation", "code-review")',
            },
            framework: {
              type: 'string',
              description: 'Filter by framework (e.g., "crewai", "langgraph", "instar")',
            },
            name: {
              type: 'string',
              description: 'Filter by agent name (partial match)',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'threadline_send',
        description: 'Send a message to another agent on the Threadline relay. The recipient must be discovered first.',
        parameters: {
          type: 'object',
          properties: {
            recipientId: {
              type: 'string',
              description: 'The recipient agent fingerprint (from discover results)',
            },
            message: {
              type: 'string',
              description: 'The message text to send',
            },
            threadId: {
              type: 'string',
              description: 'Optional thread ID for continuing a conversation',
            },
          },
          required: ['recipientId', 'message'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'threadline_list_agents',
        description: 'List all previously discovered agents.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'threadline_status',
        description: 'Get the current Threadline connection status and agent fingerprint.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
  ];

  return { definitions, handlers };
}
