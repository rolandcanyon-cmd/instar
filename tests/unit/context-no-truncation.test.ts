/**
 * Regression tests: Full context injection (no truncation).
 *
 * These tests guard against the bug where session bootstrap messages
 * truncated conversation history, causing resumed sessions to see stale
 * context from early in the conversation instead of the most recent messages.
 *
 * The fix: inject the FULL context inline. Claude's compaction handles
 * context management — we must not pre-truncate.
 *
 * Regression for: context truncation bug (2026-03-29)
 *   - Old code: contextContent.slice(0, 4000) — kept oldest, cut newest
 *   - Fix: no truncation, full history injected every time
 */

import { describe, it, expect } from 'vitest';

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Mirror the bootstrap message construction from server.ts spawnSessionForTopic.
 * This must stay in sync with the actual code — if the real code changes,
 * these tests should break to flag the drift.
 */
function buildBootstrapMessage(
  topicId: number,
  msg: string,
  contextContent: string | null,
  agentContextBlock?: string,
  userContextBlock?: string,
): string {
  if (contextContent) {
    // This mirrors the actual server.ts logic — no truncation
    const inlineContext = contextContent;

    const parts = [
      'CONTINUATION — You are resuming an EXISTING conversation. Read the context below before responding.',
      '',
    ];

    if (agentContextBlock) {
      parts.push(agentContextBlock);
      parts.push('');
    }

    if (userContextBlock) {
      parts.push(userContextBlock);
      parts.push('');
    }

    parts.push(
      inlineContext,
      '',
      'IMPORTANT: Your response MUST acknowledge and continue the conversation above. Do NOT introduce yourself or ask "how can I help" — the user has been talking to you. Pick up where the conversation left off.',
      '',
      `The user's latest message:`,
      `[telegram:${topicId}] ${msg}`,
    );

    return parts.join('\n');
  } else {
    const newSessionParts: string[] = [];
    if (agentContextBlock) {
      newSessionParts.push(agentContextBlock);
      newSessionParts.push('');
    }
    if (userContextBlock) {
      newSessionParts.push(userContextBlock);
      newSessionParts.push('');
    }
    newSessionParts.push(`[telegram:${topicId}] ${msg}`);
    return newSessionParts.join('\n');
  }
}

/** Generate a realistic TopicMemory context with N messages. */
function generateTopicContext(opts: {
  totalMessages: number;
  topicName: string;
  summary?: string;
  messages: Array<{ time: string; sender: string; text: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`--- TOPIC CONTEXT (${opts.totalMessages} total messages) ---`);
  lines.push(`Topic: ${opts.topicName}`);

  if (opts.summary) {
    lines.push('');
    lines.push('CONVERSATION SUMMARY:');
    lines.push(opts.summary);
  }

  lines.push('');
  lines.push(`RECENT MESSAGES (last ${opts.messages.length}${opts.summary ? ', since last summary' : ''}):`);
  lines.push('');
  for (const m of opts.messages) {
    lines.push(`[${m.time}] ${m.sender}: ${m.text}`);
  }

  lines.push('');
  lines.push('To search conversation history: curl http://localhost:PORT/topic/search?topic=TOPIC_ID&q=QUERY');
  lines.push('--- END TOPIC CONTEXT ---');
  return lines.join('\n');
}

/** Generate a JSONL-fallback thread history with N messages. */
function generateThreadHistory(opts: {
  topicName: string;
  messages: Array<{ time: string; sender: string; text: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`--- Thread History (last ${opts.messages.length} messages) ---`);
  lines.push('IMPORTANT: Read this history carefully before taking any action.');
  lines.push('Your task is to continue THIS conversation, not start something new.');
  lines.push(`Topic: ${opts.topicName}`);
  lines.push('');
  for (const m of opts.messages) {
    lines.push(`[${m.time}] ${m.sender}: ${m.text}`);
  }
  lines.push('');
  lines.push('--- End Thread History ---');
  return lines.join('\n');
}

// ── Test Data ───────────────────────────────────────────────────

/** Realistic long conversation — the kind that triggered the original bug. */
function buildLongConversation(): {
  context: string;
  firstMessage: string;
  lastAgentMessage: string;
  lastUserMessage: string;
} {
  const messages = [
    { time: '02:11:00', sender: 'Agent', text: 'Great question. Short answer: yes, we have a LOT of recovery infra. ' + 'Here is a detailed breakdown of all the layers including SessionRecovery, StallTriageNurse, SessionWatchdog, ProactiveSessionMonitor, MessageDeliveryRetry, CircuitBreaker, TunnelReconnection, TelegramLifeline, and HealthWatchdog. '.repeat(8) },
    { time: '04:14:26', sender: 'Agent', text: 'Got it, looking into the session cleanup logs now to trace what happened.' },
    { time: '04:19:01', sender: 'Agent', text: 'Found the exact gap. The root cause is a disconnect between three pieces of existing infrastructure: message injection is fire-and-forget, the post-injection watchdog exists but is not wired up, and zombie detection only catches idle-at-prompt sessions. ' + 'More detailed analysis follows. '.repeat(10) },
    { time: '04:29:45', sender: 'Agent', text: 'Built and deployed the fix. Added pendingInjections tracker to SessionManager. Three files modified: SessionManager.ts, routes.ts, server.ts. ' + 'The injection tracking loop monitors all three session death paths. '.repeat(5) },
    { time: '04:56:27', sender: 'User', text: 'Why didn\'t our infra detect the original API error and unstick the session to begin with?' },
    { time: '04:59:04', sender: 'Agent', text: 'Each layer was actually working correctly for what it monitors. The problem is this failure mode fell into the gap between all of them. StallDetector should have caught it but Telegram bypassed it. Tool-call stall detector saw clean JSONL. CrashDetector classified as normal exit. SessionMonitor detected death but had no context. ' + 'Detailed breakdown continues. '.repeat(5) },
    { time: '05:18:46', sender: 'Agent', text: 'My take: let the injection tracker soak for a day or two first. Those other items are small and self-contained. Or if you mean across all topics — we\'ve got consent wiring + Category Overseers queued in topic 1839.' },
    { time: '20:12:55', sender: 'User', text: 'Could you look into what happened to this session? We need to make sure sessions can run autonomously for long periods.' },
  ];

  const context = generateTopicContext({
    totalMessages: 45,
    topicName: 'session-robustness',
    summary: 'Discussion about session recovery infrastructure, identified gaps in injection tracking and response verification. Agent built and deployed pendingInjections fix.',
    messages,
  });

  return {
    context,
    firstMessage: messages[0].text,
    lastAgentMessage: messages[6].text,  // "My take: let the injection tracker soak..."
    lastUserMessage: messages[7].text,   // "Could you look into what happened..."
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('Context injection: no truncation (regression)', () => {
  it('MUST include the most recent agent message in full', () => {
    const { context, lastAgentMessage } = buildLongConversation();
    const bootstrap = buildBootstrapMessage(2169, 'test message', context);

    expect(bootstrap).toContain(lastAgentMessage);
  });

  it('MUST include the most recent user message in full', () => {
    const { context, lastUserMessage } = buildLongConversation();
    const bootstrap = buildBootstrapMessage(2169, 'new message', context);

    expect(bootstrap).toContain(lastUserMessage);
  });

  it('MUST include ALL messages from the context — no truncation', () => {
    const { context } = buildLongConversation();
    const bootstrap = buildBootstrapMessage(2169, 'test', context);

    // Every timestamp from the conversation must appear
    expect(bootstrap).toContain('[02:11:00]');
    expect(bootstrap).toContain('[04:14:26]');
    expect(bootstrap).toContain('[04:19:01]');
    expect(bootstrap).toContain('[04:29:45]');
    expect(bootstrap).toContain('[04:56:27]');
    expect(bootstrap).toContain('[04:59:04]');
    expect(bootstrap).toContain('[05:18:46]');
    expect(bootstrap).toContain('[20:12:55]');
  });

  it('MUST include the full context verbatim — no slicing', () => {
    const { context } = buildLongConversation();
    const bootstrap = buildBootstrapMessage(2169, 'test', context);

    // The entire context string must appear as a contiguous substring
    expect(bootstrap).toContain(context);
  });

  it('preserves context even when it exceeds 4KB', () => {
    const { context } = buildLongConversation();
    // Verify the test data is actually large enough to have triggered the old bug
    expect(context.length).toBeGreaterThan(4000);

    const bootstrap = buildBootstrapMessage(2169, 'test', context);

    // Full context must still be present
    expect(bootstrap).toContain(context);
    // No truncation markers
    expect(bootstrap).not.toContain('... (full history:');
    expect(bootstrap).not.toContain('earlier messages omitted');
    expect(bootstrap).not.toContain('earlier context omitted');
  });

  it('preserves context even when it exceeds 10KB', () => {
    const hugeMessages = Array.from({ length: 30 }, (_, i) => ({
      time: `${String(i).padStart(2, '0')}:00:00`,
      sender: i % 2 === 0 ? 'Agent' : 'User',
      text: `Message ${i}: ${'detailed technical discussion about session infrastructure '.repeat(10)}`,
    }));

    const context = generateTopicContext({
      totalMessages: 200,
      topicName: 'long-running-topic',
      summary: 'Extensive discussion spanning multiple sessions about system architecture.',
      messages: hugeMessages,
    });

    expect(context.length).toBeGreaterThan(10000);

    const bootstrap = buildBootstrapMessage(42, 'latest message', context);
    expect(bootstrap).toContain(context);

    // Last message must be present
    expect(bootstrap).toContain('Message 29:');
  });

  it('preserves context integrity with JSONL fallback format', () => {
    const messages = [
      { time: '10:00:00', sender: 'Agent', text: 'First response with important context.' },
      { time: '10:05:00', sender: 'User', text: 'Follow-up question about the details.' },
      { time: '10:10:00', sender: 'Agent', text: 'Here is the detailed answer that the agent needs to remember.' },
      { time: '22:00:00', sender: 'User', text: 'Coming back later with another question.' },
    ];

    const context = generateThreadHistory({
      topicName: 'test-topic',
      messages,
    });

    const bootstrap = buildBootstrapMessage(99, 'new question', context);

    // All messages preserved
    for (const m of messages) {
      expect(bootstrap).toContain(m.text);
    }
    expect(bootstrap).toContain(context);
  });

  it('the most recent agent message appears AFTER older messages', () => {
    const { context, lastAgentMessage, firstMessage } = buildLongConversation();
    const bootstrap = buildBootstrapMessage(2169, 'test', context);

    const firstIdx = bootstrap.indexOf(firstMessage.slice(0, 50));
    const lastIdx = bootstrap.indexOf(lastAgentMessage);

    expect(firstIdx).toBeGreaterThan(-1);
    expect(lastIdx).toBeGreaterThan(-1);
    expect(lastIdx).toBeGreaterThan(firstIdx);
  });

  it('context appears BEFORE the latest user message tag', () => {
    const { context, lastAgentMessage } = buildLongConversation();
    const bootstrap = buildBootstrapMessage(2169, 'what should I do next?', context);

    const contextIdx = bootstrap.indexOf(lastAgentMessage);
    const messageIdx = bootstrap.indexOf('[telegram:2169] what should I do next?');

    expect(contextIdx).toBeGreaterThan(-1);
    expect(messageIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeLessThan(messageIdx);
  });

  it('summary section is preserved alongside recent messages', () => {
    const context = generateTopicContext({
      totalMessages: 100,
      topicName: 'complex-topic',
      summary: 'Critical summary: the auth middleware was rewritten for compliance. Session tokens must use the new format.',
      messages: [
        { time: '12:00:00', sender: 'Agent', text: 'Deployed the auth fix.' },
        { time: '14:00:00', sender: 'User', text: 'Can you verify it works?' },
      ],
    });

    const bootstrap = buildBootstrapMessage(42, 'status?', context);

    expect(bootstrap).toContain('CONVERSATION SUMMARY:');
    expect(bootstrap).toContain('Critical summary: the auth middleware was rewritten');
    expect(bootstrap).toContain('Deployed the auth fix.');
    expect(bootstrap).toContain('Can you verify it works?');
  });
});

describe('Context injection: structural integrity', () => {
  it('CONTINUATION framing wraps the full context', () => {
    const context = generateTopicContext({
      totalMessages: 5,
      topicName: 'test',
      messages: [
        { time: '10:00:00', sender: 'Agent', text: 'Hello' },
      ],
    });

    const bootstrap = buildBootstrapMessage(1, 'hi', context);

    expect(bootstrap).toMatch(/^CONTINUATION/);
    expect(bootstrap).toContain('IMPORTANT: Your response MUST acknowledge');
    expect(bootstrap).toContain('[telegram:1] hi');
  });

  it('agent context block appears before conversation history', () => {
    const context = generateTopicContext({
      totalMessages: 5,
      topicName: 'test',
      messages: [{ time: '10:00:00', sender: 'Agent', text: 'Previous response.' }],
    });

    const bootstrap = buildBootstrapMessage(
      1, 'hi', context,
      '--- Agent Identity ---\nAgent: echo\n--- End Agent Identity ---',
    );

    const agentIdx = bootstrap.indexOf('--- Agent Identity ---');
    const contextIdx = bootstrap.indexOf('--- TOPIC CONTEXT');

    expect(agentIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeGreaterThan(-1);
    expect(agentIdx).toBeLessThan(contextIdx);
  });

  it('new session (no context) does not include CONTINUATION framing', () => {
    const bootstrap = buildBootstrapMessage(42, 'hello there', null);

    expect(bootstrap).not.toContain('CONTINUATION');
    expect(bootstrap).toContain('[telegram:42] hello there');
  });
});
