/**
 * SlackAdapter prompt response wiring — verifies that when a user clicks
 * a prompt button in Slack, the onPromptResponse callback fires and
 * stall tracking is cleared.
 *
 * Root cause: _handleInteraction updated the message text but never called
 * onPromptResponse, so button presses in Slack silently did nothing.
 *
 * Fix: Call onPromptResponse with channelId, promptId, and value after
 * validating the interaction.
 */

import { describe, it, expect, vi } from 'vitest';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';

function createTestAdapter() {
  const adapter = new SlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    authorizedUserIds: ['U_TEST'],
    workspaceMode: 'dedicated',
  } as any, '/tmp/slack-test-prompt');

  return adapter;
}

describe('SlackAdapter prompt response', () => {
  it('calls onPromptResponse when a prompt button is clicked', async () => {
    const adapter = createTestAdapter();
    const responses: Array<{ channelId: string; promptId: string; value: string }> = [];

    adapter.onPromptResponse = (channelId, promptId, value) => {
      responses.push({ channelId, promptId, value });
    };

    // Register a pending prompt
    adapter.registerPendingPrompt('msg.ts.001', 'prompt-123', 'C_CHANNEL', 'test-session');

    // Simulate button click interaction
    // Mock the updateMessage method to avoid Slack API calls
    (adapter as any).updateMessage = vi.fn().mockResolvedValue(undefined);
    (adapter as any).isAuthorized = () => true;

    const handleInteraction = (adapter as any)._handleInteraction.bind(adapter);
    await handleInteraction({
      user: { id: 'U_TEST' },
      actions: [{
        action_id: 'prompt::prompt-123',
        value: '2',
        text: { text: 'Yes, manually approve edits' },
      }],
      message: { ts: 'msg.ts.001' },
      channel: { id: 'C_CHANNEL' },
    });

    expect(responses.length).toBe(1);
    expect(responses[0].channelId).toBe('C_CHANNEL');
    expect(responses[0].promptId).toBe('prompt-123');
    expect(responses[0].value).toBe('2');
  });

  it('does not call onPromptResponse for unknown prompts', async () => {
    const adapter = createTestAdapter();
    const responses: Array<{ channelId: string; promptId: string; value: string }> = [];

    adapter.onPromptResponse = (channelId, promptId, value) => {
      responses.push({ channelId, promptId, value });
    };

    (adapter as any).isAuthorized = () => true;

    const handleInteraction = (adapter as any)._handleInteraction.bind(adapter);
    await handleInteraction({
      user: { id: 'U_TEST' },
      actions: [{
        action_id: 'prompt::unknown-prompt',
        value: '1',
      }],
      message: { ts: 'nonexistent.ts' },
      channel: { id: 'C_CHANNEL' },
    });

    // No response — prompt was not registered
    expect(responses.length).toBe(0);
  });

  it('clears stall tracking when prompt is answered', async () => {
    const adapter = createTestAdapter();

    // Track a stall for this channel
    adapter.trackMessageInjection('C_CHANNEL', 'test-session', 'some message');
    expect(adapter.getPendingStallCount()).toBe(1);

    // Register and answer a prompt
    adapter.registerPendingPrompt('msg.ts.002', 'prompt-456', 'C_CHANNEL', 'test-session');
    (adapter as any).updateMessage = vi.fn().mockResolvedValue(undefined);
    (adapter as any).isAuthorized = () => true;

    const handleInteraction = (adapter as any)._handleInteraction.bind(adapter);
    await handleInteraction({
      user: { id: 'U_TEST' },
      actions: [{
        action_id: 'prompt::prompt-456',
        value: '1',
      }],
      message: { ts: 'msg.ts.002' },
      channel: { id: 'C_CHANNEL' },
    });

    // Stall tracking should be cleared
    expect(adapter.getPendingStallCount()).toBe(0);
  });

  it('stores sessionName in pending prompts', () => {
    const adapter = createTestAdapter();
    adapter.registerPendingPrompt('msg.ts.003', 'prompt-789', 'C_CHAN', 'my-session');

    const pending = (adapter as any).pendingPrompts.get('msg.ts.003');
    expect(pending).toBeDefined();
    expect(pending.sessionName).toBe('my-session');
    expect(pending.channelId).toBe('C_CHAN');
  });
});
