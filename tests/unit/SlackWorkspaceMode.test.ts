/**
 * Tests for Slack workspace mode behavior:
 * - dedicated vs shared mode defaults
 * - mention-only response filtering
 * - auto-join channel behavior
 * - @mention stripping from message text
 */

import { describe, it, expect } from 'vitest';

// Test the workspace mode default resolution logic directly
// (extracted from SlackAdapter constructor logic)
function resolveWorkspaceDefaults(config: {
  workspaceMode?: 'dedicated' | 'shared';
  autoJoinChannels?: boolean;
  respondMode?: 'all' | 'mention-only';
}) {
  const mode = config.workspaceMode ?? 'dedicated';
  const isDedicated = mode === 'dedicated';
  const autoJoin = config.autoJoinChannels ?? isDedicated;
  const respond = config.respondMode ?? (isDedicated ? 'all' : 'mention-only');
  return { mode, autoJoin, respond };
}

describe('Workspace Mode Defaults', () => {
  it('dedicated mode: auto-join on, respond to all', () => {
    const result = resolveWorkspaceDefaults({ workspaceMode: 'dedicated' });
    expect(result.mode).toBe('dedicated');
    expect(result.autoJoin).toBe(true);
    expect(result.respond).toBe('all');
  });

  it('shared mode: no auto-join, mention-only', () => {
    const result = resolveWorkspaceDefaults({ workspaceMode: 'shared' });
    expect(result.mode).toBe('shared');
    expect(result.autoJoin).toBe(false);
    expect(result.respond).toBe('mention-only');
  });

  it('defaults to dedicated when not specified', () => {
    const result = resolveWorkspaceDefaults({});
    expect(result.mode).toBe('dedicated');
    expect(result.autoJoin).toBe(true);
    expect(result.respond).toBe('all');
  });

  it('explicit overrides beat mode defaults', () => {
    // Shared mode but explicitly enable auto-join
    const result = resolveWorkspaceDefaults({
      workspaceMode: 'shared',
      autoJoinChannels: true,
      respondMode: 'all',
    });
    expect(result.mode).toBe('shared');
    expect(result.autoJoin).toBe(true);
    expect(result.respond).toBe('all');
  });

  it('dedicated mode with mention-only override', () => {
    const result = resolveWorkspaceDefaults({
      workspaceMode: 'dedicated',
      respondMode: 'mention-only',
    });
    expect(result.mode).toBe('dedicated');
    expect(result.autoJoin).toBe(true);
    expect(result.respond).toBe('mention-only');
  });
});

describe('Bot Mention Detection', () => {
  const BOT_USER_ID = 'U0ABC123';

  function isBotMentioned(text: string, botUserId: string | null): boolean {
    if (!botUserId) return false;
    return text.includes(`<@${botUserId}>`);
  }

  function stripBotMention(text: string, botUserId: string | null): string {
    if (!botUserId) return text;
    return text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim();
  }

  it('detects @mention in message', () => {
    expect(isBotMentioned(`<@${BOT_USER_ID}> hello`, BOT_USER_ID)).toBe(true);
  });

  it('detects @mention in middle of message', () => {
    expect(isBotMentioned(`hey <@${BOT_USER_ID}> do something`, BOT_USER_ID)).toBe(true);
  });

  it('does not match other users', () => {
    expect(isBotMentioned('<@U0OTHER99> hello', BOT_USER_ID)).toBe(false);
  });

  it('does not match plain text', () => {
    expect(isBotMentioned('hello world', BOT_USER_ID)).toBe(false);
  });

  it('returns false when botUserId is null', () => {
    expect(isBotMentioned(`<@${BOT_USER_ID}> hello`, null)).toBe(false);
  });

  it('strips @mention from start of message', () => {
    expect(stripBotMention(`<@${BOT_USER_ID}> do something`, BOT_USER_ID)).toBe('do something');
  });

  it('strips @mention from middle of message', () => {
    expect(stripBotMention(`hey <@${BOT_USER_ID}> do something`, BOT_USER_ID)).toBe('hey do something');
  });

  it('strips multiple @mentions', () => {
    expect(stripBotMention(`<@${BOT_USER_ID}> and <@${BOT_USER_ID}> again`, BOT_USER_ID)).toBe('and again');
  });

  it('preserves text when no mention', () => {
    expect(stripBotMention('just a message', BOT_USER_ID)).toBe('just a message');
  });

  it('preserves text when botUserId is null', () => {
    expect(stripBotMention(`<@${BOT_USER_ID}> hello`, null)).toBe(`<@${BOT_USER_ID}> hello`);
  });
});

describe('Mention-Only Mode Message Routing', () => {
  // Simulates the filtering logic in _handleMessage
  function shouldProcess(opts: {
    respondMode: 'all' | 'mention-only';
    channelId: string;
    text: string;
    botUserId: string | null;
  }): boolean {
    const isDM = opts.channelId.startsWith('D');
    if (opts.respondMode === 'mention-only' && !isDM) {
      if (!opts.botUserId) return false;
      return opts.text.includes(`<@${opts.botUserId}>`);
    }
    return true;
  }

  const BOT_ID = 'U0BOT123';

  it('all mode: processes every message', () => {
    expect(shouldProcess({
      respondMode: 'all',
      channelId: 'C123',
      text: 'hello',
      botUserId: BOT_ID,
    })).toBe(true);
  });

  it('mention-only: skips messages without mention', () => {
    expect(shouldProcess({
      respondMode: 'mention-only',
      channelId: 'C123',
      text: 'hello everyone',
      botUserId: BOT_ID,
    })).toBe(false);
  });

  it('mention-only: processes messages with mention', () => {
    expect(shouldProcess({
      respondMode: 'mention-only',
      channelId: 'C123',
      text: `<@${BOT_ID}> help me`,
      botUserId: BOT_ID,
    })).toBe(true);
  });

  it('mention-only: always processes DMs', () => {
    expect(shouldProcess({
      respondMode: 'mention-only',
      channelId: 'D123',
      text: 'hello',
      botUserId: BOT_ID,
    })).toBe(true);
  });

  it('mention-only: DMs work even without bot ID', () => {
    expect(shouldProcess({
      respondMode: 'mention-only',
      channelId: 'D123',
      text: 'hello',
      botUserId: null,
    })).toBe(true);
  });
});
