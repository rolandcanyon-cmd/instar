/**
 * Unit tests for the deterministic Threadline hub commands (CMT-529):
 * parseHubCommand + bindHubConversation + the legacy-ordering fix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHubCommand, bindHubConversation, type HubBindDeps } from '../../src/threadline/hubCommands.js';
import { CollaborationSurfacer, type SurfacerTelegram } from '../../src/threadline/CollaborationSurfacer.js';
import { ConversationStore } from '../../src/threadline/ConversationStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('parseHubCommand', () => {
  it('matches "open this" / "open" / "Open This." → open', () => {
    expect(parseHubCommand('open this')).toEqual({ action: 'open' });
    expect(parseHubCommand('open')).toEqual({ action: 'open' });
    expect(parseHubCommand('  Open This. ')).toEqual({ action: 'open' });
    expect(parseHubCommand('OPEN THIS!')).toEqual({ action: 'open' });
  });
  it('matches "tie this to <name>" and "tie this to #id"', () => {
    expect(parseHubCommand('tie this to my GrowthBook topic')).toEqual({ action: 'tie', targetTopicName: 'my GrowthBook topic' });
    expect(parseHubCommand('tie this to #1234')).toEqual({ action: 'tie', targetTopicId: 1234 });
    expect(parseHubCommand('bind this to 1234')).toEqual({ action: 'tie', targetTopicId: 1234 });
  });
  it('returns null for ordinary prose (falls through to the agent)', () => {
    expect(parseHubCommand('can you open this and explain what it is?')).toBeNull();
    expect(parseHubCommand('open the door for me')).toBeNull();
    expect(parseHubCommand('what is this thread about?')).toBeNull();
    expect(parseHubCommand('')).toBeNull();
    expect(parseHubCommand('I want to tie this to something but not sure which')).toBeNull();
  });
});

function fakeTelegram() {
  const tg = {
    posts: [] as Array<{ topicId: number; text: string }>,
    next: 5000,
    created: [] as string[],
    async findOrCreateForumTopic(name: string) { tg.created.push(name); return { topicId: tg.next++, name, reused: false }; },
    async sendToTopic(topicId: number, text: string) { tg.posts.push({ topicId, text }); return { ok: true }; },
  };
  return tg;
}

describe('bindHubConversation', () => {
  let tmp: string; let stateDir: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hubcmd-')); stateDir = path.join(tmp, '.instar'); fs.mkdirSync(stateDir, { recursive: true }); });
  afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/hubCommands.test.ts' }));

  function deps(tg: ReturnType<typeof fakeTelegram>, surfacer: CollaborationSurfacer, store: ConversationStore): HubBindDeps {
    return { collaborationSurfacer: surfacer, conversationStore: store, commitmentTracker: null, telegram: tg };
  }

  it('open with one unbound conversation binds it + sets boundTopicId', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    await surfacer.surface({ threadId: 't-1', senderName: 'codey', text: 'verify the build please', hasParentTopic: false, warrants: true });
    const r = await bindHubConversation(deps(tg, surfacer, store), { action: 'open' });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.threadId).toBe('t-1'); expect(store.get('t-1')?.boundTopicId).toBe(r.topicId); }
  });

  it('open with zero unbound → 404', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    const r = await bindHubConversation(deps(tg, surfacer, store), { action: 'open' });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('open with >1 unbound → 409 WITHOUT autoPick (API path)', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    await surfacer.surface({ threadId: 't-a', senderName: 'codey', text: 'a', hasParentTopic: false, warrants: true });
    await new Promise(r => setTimeout(r, 5));
    await surfacer.surface({ threadId: 't-b', senderName: 'aiguy', text: 'b', hasParentTopic: false, warrants: true });
    const r = await bindHubConversation(deps(tg, surfacer, store), { action: 'open' });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it('open with >1 unbound + autoPick → binds the MOST RECENT (intercept path)', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    await surfacer.surface({ threadId: 't-old', senderName: 'codey', text: 'old', hasParentTopic: false, warrants: true });
    await new Promise(r => setTimeout(r, 5));
    await surfacer.surface({ threadId: 't-new', senderName: 'aiguy', text: 'new', hasParentTopic: false, warrants: true });
    const r = await bindHubConversation(deps(tg, surfacer, store), { action: 'open', autoPick: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.threadId).toBe('t-new'); // most-recent, not a 409
  });

  it('tie binds an explicit targetTopicId', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    await surfacer.surface({ threadId: 't-tie', senderName: 'codey', text: 'x', hasParentTopic: false, warrants: true });
    const r = await bindHubConversation(deps(tg, surfacer, store), { action: 'tie', threadId: 't-tie', targetTopicId: 4242 });
    expect(r.ok).toBe(true);
    expect(store.get('t-tie')?.boundTopicId).toBe(4242);
  });

  it('open derives a readable topic name from the conversation gist (not peer·threadId)', async () => {
    const tg = fakeTelegram(); const store = new ConversationStore(stateDir); const surfacer = new CollaborationSurfacer({ telegram: tg as unknown as SurfacerTelegram, stateDir });
    // Seed a conversation with a meaningful subject.
    await store.mutate('t-named', (c) => { c.subject = 'GrowthBook rollout coordination'; c.participants = { peers: ['codey'] }; return c; });
    await surfacer.surface({ threadId: 't-named', senderName: 'codey', text: 'about GrowthBook rollout', hasParentTopic: false, warrants: true });
    const r = await bindHubConversation(deps(tg, surfacer, store), { action: 'open', threadId: 't-named' });
    expect(r.ok).toBe(true);
    // The created topic name reflects the gist, not "codey · t-named".
    expect(tg.created.some(n => /GrowthBook/i.test(n))).toBe(true);
  });
});
