/**
 * Framework Adapter Unit Tests
 *
 * Tests CrewAI, LangGraph, and AutoGen adapters against a mock ThreadlineClient.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCrewAITools } from '../../../../src/threadline/adapters/CrewAITool.js';
import { createLangGraphTools } from '../../../../src/threadline/adapters/LangGraphTool.js';
import { createAutoGenFunctions } from '../../../../src/threadline/adapters/AutoGenTool.js';
import type { ThreadlineClient, KnownAgent } from '../../../../src/threadline/client/ThreadlineClient.js';

// Mock ThreadlineClient
const createMockClient = () => {
  const knownAgents: KnownAgent[] = [
    {
      agentId: 'abc123def456',
      name: 'test-agent',
      publicKey: Buffer.from('key'),
      x25519PublicKey: Buffer.from('x25519key'),
      framework: 'instar',
      capabilities: ['conversation', 'code-review'],
    },
  ];

  return {
    discover: vi.fn().mockResolvedValue(knownAgents),
    send: vi.fn().mockReturnValue('msg-123'),
    getKnownAgents: vi.fn().mockReturnValue(knownAgents),
    connectionState: 'connected',
    fingerprint: 'myfingerprint123',
  } as unknown as ThreadlineClient;
};

// ── CrewAI ───────────────────────────────────────────────────────────

describe('CrewAI Adapter', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it('creates 4 tools', () => {
    const tools = createCrewAITools(client as unknown as ThreadlineClient);
    expect(tools).toHaveLength(4);
    expect(tools.map(t => t.name)).toEqual([
      'threadline_discover',
      'threadline_send',
      'threadline_list_agents',
      'threadline_status',
    ]);
  });

  it('discover tool calls client.discover', async () => {
    const tools = createCrewAITools(client as unknown as ThreadlineClient);
    const discover = tools.find(t => t.name === 'threadline_discover')!;

    const result = JSON.parse(await discover.func('{"capability": "conversation"}'));
    expect(result.count).toBe(1);
    expect(result.agents[0].name).toBe('test-agent');
    expect(client.discover).toHaveBeenCalledWith({ capability: 'conversation' });
  });

  it('discover tool handles empty input', async () => {
    const tools = createCrewAITools(client as unknown as ThreadlineClient);
    const discover = tools.find(t => t.name === 'threadline_discover')!;

    await discover.func('{}');
    expect(client.discover).toHaveBeenCalled();
  });

  it('discover tool handles invalid JSON', async () => {
    const tools = createCrewAITools(client as unknown as ThreadlineClient);
    const discover = tools.find(t => t.name === 'threadline_discover')!;

    const result = JSON.parse(await discover.func('not json'));
    expect(result.error).toBeDefined();
  });

  it('send tool calls client.send', async () => {
    const tools = createCrewAITools(client as unknown as ThreadlineClient);
    const send = tools.find(t => t.name === 'threadline_send')!;

    const result = JSON.parse(await send.func('{"recipientId": "abc123", "message": "hello"}'));
    expect(result.messageId).toBe('msg-123');
    expect(result.status).toBe('sent');
    expect(client.send).toHaveBeenCalledWith('abc123', 'hello', undefined);
  });

  it('send tool validates required fields', async () => {
    const tools = createCrewAITools(client as unknown as ThreadlineClient);
    const send = tools.find(t => t.name === 'threadline_send')!;

    const result = JSON.parse(await send.func('{"message": "hello"}'));
    expect(result.error).toContain('Missing required');
  });

  it('send tool handles errors', async () => {
    (client.send as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('Unknown agent'); });
    const tools = createCrewAITools(client as unknown as ThreadlineClient);
    const send = tools.find(t => t.name === 'threadline_send')!;

    const result = JSON.parse(await send.func('{"recipientId": "abc", "message": "hi"}'));
    expect(result.error).toBe('Unknown agent');
  });

  it('list_agents returns known agents', async () => {
    const tools = createCrewAITools(client as unknown as ThreadlineClient);
    const list = tools.find(t => t.name === 'threadline_list_agents')!;

    const result = JSON.parse(await list.func(''));
    expect(result.count).toBe(1);
  });

  it('status returns connection info', async () => {
    const tools = createCrewAITools(client as unknown as ThreadlineClient);
    const status = tools.find(t => t.name === 'threadline_status')!;

    const result = JSON.parse(await status.func(''));
    expect(result.connectionState).toBe('connected');
    expect(result.fingerprint).toBe('myfingerprint123');
  });
});

// ── LangGraph ────────────────────────────────────────────────────────

describe('LangGraph Adapter', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it('creates 4 tool definitions in OpenAI format', () => {
    const { definitions } = createLangGraphTools(client as unknown as ThreadlineClient);
    expect(definitions).toHaveLength(4);

    for (const def of definitions) {
      expect(def.type).toBe('function');
      expect(def.function.name).toBeDefined();
      expect(def.function.description).toBeDefined();
      expect(def.function.parameters.type).toBe('object');
    }
  });

  it('creates matching handlers for all definitions', () => {
    const { definitions, handlers } = createLangGraphTools(client as unknown as ThreadlineClient);

    for (const def of definitions) {
      expect(handlers[def.function.name]).toBeDefined();
      expect(typeof handlers[def.function.name]).toBe('function');
    }
  });

  it('discover handler works', async () => {
    const { handlers } = createLangGraphTools(client as unknown as ThreadlineClient);
    const result = JSON.parse(await handlers.threadline_discover({ capability: 'conversation' }));
    expect(result.count).toBe(1);
  });

  it('send handler works', async () => {
    const { handlers } = createLangGraphTools(client as unknown as ThreadlineClient);
    const result = JSON.parse(await handlers.threadline_send({
      recipientId: 'abc123',
      message: 'hello',
    }));
    expect(result.messageId).toBe('msg-123');
  });

  it('send handler validates required fields', async () => {
    const { handlers } = createLangGraphTools(client as unknown as ThreadlineClient);
    const result = JSON.parse(await handlers.threadline_send({}));
    expect(result.error).toBeDefined();
  });

  it('send definition has required fields', () => {
    const { definitions } = createLangGraphTools(client as unknown as ThreadlineClient);
    const sendDef = definitions.find(d => d.function.name === 'threadline_send')!;
    expect(sendDef.function.parameters.required).toEqual(['recipientId', 'message']);
  });

  it('status handler works', async () => {
    const { handlers } = createLangGraphTools(client as unknown as ThreadlineClient);
    const result = JSON.parse(await handlers.threadline_status({}));
    expect(result.connectionState).toBe('connected');
  });
});

// ── AutoGen ──────────────────────────────────────────────────────────

describe('AutoGen Adapter', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it('creates 4 functions', () => {
    const functions = createAutoGenFunctions(client as unknown as ThreadlineClient);
    expect(functions).toHaveLength(4);

    for (const fn of functions) {
      expect(fn.definition.name).toBeDefined();
      expect(fn.definition.description).toBeDefined();
      expect(fn.definition.parameters.type).toBe('object');
      expect(typeof fn.handler).toBe('function');
    }
  });

  it('discover handler works', async () => {
    const functions = createAutoGenFunctions(client as unknown as ThreadlineClient);
    const discover = functions.find(f => f.definition.name === 'threadline_discover')!;

    const result = JSON.parse(await discover.handler({ framework: 'instar' }));
    expect(result.count).toBe(1);
    expect(client.discover).toHaveBeenCalledWith({
      capability: undefined,
      framework: 'instar',
      name: undefined,
    });
  });

  it('send handler works', async () => {
    const functions = createAutoGenFunctions(client as unknown as ThreadlineClient);
    const send = functions.find(f => f.definition.name === 'threadline_send')!;

    const result = JSON.parse(await send.handler({
      recipientId: 'abc123',
      message: 'hello',
      threadId: 'thread-1',
    }));
    expect(result.messageId).toBe('msg-123');
    expect(client.send).toHaveBeenCalledWith('abc123', 'hello', 'thread-1');
  });

  it('send handler validates required fields', async () => {
    const functions = createAutoGenFunctions(client as unknown as ThreadlineClient);
    const send = functions.find(f => f.definition.name === 'threadline_send')!;

    const result = JSON.parse(await send.handler({ message: 'hello' }));
    expect(result.error).toBeDefined();
  });

  it('send definition declares required fields', () => {
    const functions = createAutoGenFunctions(client as unknown as ThreadlineClient);
    const send = functions.find(f => f.definition.name === 'threadline_send')!;
    expect(send.definition.parameters.required).toEqual(['recipientId', 'message']);
  });

  it('list_agents handler works', async () => {
    const functions = createAutoGenFunctions(client as unknown as ThreadlineClient);
    const list = functions.find(f => f.definition.name === 'threadline_list_agents')!;

    const result = JSON.parse(await list.handler({}));
    expect(result.count).toBe(1);
  });

  it('status handler works', async () => {
    const functions = createAutoGenFunctions(client as unknown as ThreadlineClient);
    const status = functions.find(f => f.definition.name === 'threadline_status')!;

    const result = JSON.parse(await status.handler({}));
    expect(result.connectionState).toBe('connected');
    expect(result.fingerprint).toBe('myfingerprint123');
  });
});
