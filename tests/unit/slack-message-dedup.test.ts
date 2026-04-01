/**
 * SlackAdapter message deduplication — verifies that duplicate Slack messages
 * (from Socket Mode reconnections) are rejected and not re-injected.
 *
 * Root cause: Socket Mode reconnections can redeliver the same event,
 * causing messages like "Yes, please" to be injected 49+ times.
 *
 * Fix: Track seen message timestamps in a Set and reject duplicates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';

// Minimal config to construct a SlackAdapter
function createTestAdapter() {
  const messages: Array<{ content: string; channel: string }> = [];

  const adapter = new SlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    authorizedUserIds: ['U_TEST'],
    workspaceMode: 'dedicated',
  } as any, '/tmp/slack-test-state');

  // Wire a message handler that records received messages
  adapter.onMessage(async (msg) => {
    messages.push({ content: msg.content, channel: msg.channel.identifier });
  });

  return { adapter, messages };
}

describe('SlackAdapter message deduplication', () => {
  it('rejects messages with duplicate timestamps', async () => {
    const { adapter, messages } = createTestAdapter();

    // Access private method for testing
    const handleMessage = (adapter as any)._handleMessage.bind(adapter);

    const event = {
      user: 'U_TEST',
      text: 'Yes, please',
      channel: 'C_TEST',
      ts: '1774829441.373000',
    };

    // First delivery — should process
    await handleMessage(event);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain('Yes, please');

    // Duplicate delivery (same ts) — should reject
    await handleMessage(event);
    expect(messages.length).toBe(1); // Still 1

    // Third delivery — still rejected
    await handleMessage(event);
    expect(messages.length).toBe(1); // Still 1
  });

  it('allows messages with different timestamps', async () => {
    const { adapter, messages } = createTestAdapter();
    const handleMessage = (adapter as any)._handleMessage.bind(adapter);

    await handleMessage({
      user: 'U_TEST',
      text: 'First message',
      channel: 'C_TEST',
      ts: '1774829441.000001',
    });

    await handleMessage({
      user: 'U_TEST',
      text: 'Second message',
      channel: 'C_TEST',
      ts: '1774829441.000002',
    });

    expect(messages.length).toBe(2);
  });

  it('skips bot messages regardless of dedup', async () => {
    const { adapter, messages } = createTestAdapter();
    const handleMessage = (adapter as any)._handleMessage.bind(adapter);

    await handleMessage({
      user: 'U_BOT',
      text: 'Bot response',
      channel: 'C_TEST',
      ts: '1774829441.000003',
      bot_id: 'B_TEST',
    });

    // Bot messages are stored in ring buffer but not processed
    expect(messages.length).toBe(0);
  });
});
