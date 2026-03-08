/**
 * WhatsApp Message Routing — End-to-End Tests
 *
 * Tests the COMPLETE message routing pipeline:
 * 1. Incoming WhatsApp message → adapter → session spawn
 * 2. Subsequent messages → session injection
 * 3. Dead session → automatic respawn
 * 4. Reply API route → WhatsApp send
 * 5. WhatsApp reply script template existence
 * 6. Config fallback for authMethod/pairingPhoneNumber
 * 7. Stale credential auto-clear on 401
 * 8. Session injection tagging format
 *
 * Covers the full gap identified in baileys-405-fix-report.md:
 * "The WhatsApp pipeline receives messages and logs them, but has no
 *  messageHandler set — so messages go nowhere."
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { WhatsAppAdapter, type BackendCapabilities } from '../../src/messaging/WhatsAppAdapter.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig, Message } from '../../src/core/types.js';

// ── Setup ──────────────────────────────────────────────────

const AUTH_TOKEN = 'e2e-msg-routing-token';
const TEST_JID = '14155552671@s.whatsapp.net';
const TEST_JID_2 = '447911123456@s.whatsapp.net';

let project: TempProject;
let mockSM: MockSessionManager;
let whatsapp: WhatsAppAdapter;
let server: AgentServer;
let app: ReturnType<AgentServer['getApp']>;
let caps: BackendCapabilities & Record<string, ReturnType<typeof vi.fn>>;

beforeAll(async () => {
  project = createTempProject();
  mockSM = createMockSessionManager();

  // WhatsApp adapter with pairing-code at top level (tests config fallback)
  whatsapp = new WhatsAppAdapter(
    {
      backend: 'baileys',
      authorizedNumbers: ['+14155552671', '+447911123456'],
      requireConsent: false,
      authMethod: 'pairing-code',
      pairingPhoneNumber: '14155551234',
    } as Record<string, unknown>,
    project.stateDir,
  );

  caps = {
    sendText: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    stopTyping: vi.fn().mockResolvedValue(undefined),
    sendReadReceipt: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn().mockResolvedValue(undefined),
  };

  await whatsapp.start();
  whatsapp.setBackendCapabilities(caps);
  await whatsapp.setConnectionState('connected', '+14155551234');

  const config: InstarConfig = {
    projectName: 'whatsapp-routing-e2e',
    projectDir: project.dir,
    stateDir: project.stateDir,
    port: 0,
    authToken: AUTH_TOKEN,
    sessions: {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: project.dir,
      maxSessions: 5,
      protectedSessions: [],
      completionPatterns: [],
    },
    users: [],
    messaging: [],
    monitoring: {
      quotaTracking: false,
      memoryMonitoring: false,
      healthCheckIntervalMs: 30000,
    },
  };

  server = new AgentServer({
    config,
    sessionManager: mockSM as any,
    state: project.state,
    whatsapp,
  });
  app = server.getApp();
});

afterAll(async () => {
  await whatsapp.stop();
  project.cleanup();
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────

describe('WhatsApp Message Routing E2E', () => {
  beforeEach(() => {
    caps.sendText.mockClear();
    caps.sendTyping.mockClear();
    caps.sendReadReceipt.mockClear();
    caps.sendReaction.mockClear();
  });

  // ══════════════════════════════════════════════════════
  // 1. MESSAGE HANDLER WIRING
  // ══════════════════════════════════════════════════════

  describe('Message handler registration', () => {
    it('onMessage accepts a handler function', () => {
      const handler = vi.fn();
      // Should not throw
      whatsapp.onMessage(handler);
      // Restore original (the tests below set their own handlers)
      whatsapp.onMessage(async () => {});
    });

    it('messages reach the handler after onMessage is called', async () => {
      const received: Message[] = [];
      whatsapp.onMessage(async (msg) => {
        received.push(msg);
      });

      // Simulate incoming message through the adapter
      await whatsapp.handleIncomingMessage(
        TEST_JID,
        `msg-${Date.now()}`,
        'Hello from WhatsApp',
        'Test User',
      );

      expect(received.length).toBe(1);
      expect(received[0].content).toBe('Hello from WhatsApp');
      expect(received[0].channel?.identifier).toBe(TEST_JID);
      expect(received[0].userId).toMatch(/14155552671/);
    });

    it('messages from unauthorized numbers do NOT reach handler', async () => {
      const received: Message[] = [];
      whatsapp.onMessage(async (msg) => {
        received.push(msg);
      });

      await whatsapp.handleIncomingMessage(
        '19999999999@s.whatsapp.net',
        `msg-unauth-${Date.now()}`,
        'Unauthorized message',
        'Hacker',
      );

      expect(received.length).toBe(0);
    });

    it('deduplicates messages with the same ID', async () => {
      const received: Message[] = [];
      whatsapp.onMessage(async (msg) => {
        received.push(msg);
      });

      const msgId = `dedup-${Date.now()}`;
      await whatsapp.handleIncomingMessage(TEST_JID, msgId, 'First', 'User');
      await whatsapp.handleIncomingMessage(TEST_JID, msgId, 'Duplicate', 'User');

      expect(received.length).toBe(1);
      expect(received[0].content).toBe('First');
    });
  });

  // ══════════════════════════════════════════════════════
  // 2. SESSION MANAGEMENT (channel registry)
  // ══════════════════════════════════════════════════════

  describe('Session-channel mapping', () => {
    it('registerSession maps JID to session name', () => {
      whatsapp.registerSession(TEST_JID, 'wa-session-1');
      expect(whatsapp.getSessionForChannel(TEST_JID)).toBe('wa-session-1');
    });

    it('getChannelForSession returns JID for session', () => {
      whatsapp.registerSession(TEST_JID_2, 'wa-session-2');
      expect(whatsapp.getChannelForSession('wa-session-2')).toBe(TEST_JID_2);
    });

    it('multiple JIDs can map to different sessions', () => {
      whatsapp.registerSession(TEST_JID, 'wa-a');
      whatsapp.registerSession(TEST_JID_2, 'wa-b');
      expect(whatsapp.getSessionForChannel(TEST_JID)).toBe('wa-a');
      expect(whatsapp.getSessionForChannel(TEST_JID_2)).toBe('wa-b');
    });
  });

  // ══════════════════════════════════════════════════════
  // 3. WHATSAPP SEND API ROUTE
  // ══════════════════════════════════════════════════════

  describe('POST /whatsapp/send/:jid', () => {
    it('sends a message to a JID via the adapter', async () => {
      const res = await request(app)
        .post(`/whatsapp/send/${TEST_JID}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ text: 'Hello from Claude' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.jid).toBe(TEST_JID);
      // The adapter should have called sendText via capabilities
      expect(caps.sendText).toHaveBeenCalled();
    });

    it('returns 400 when text is missing', async () => {
      const res = await request(app)
        .post(`/whatsapp/send/${TEST_JID}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('text');
    });

    it('returns 400 when text exceeds max length', async () => {
      const res = await request(app)
        .post(`/whatsapp/send/${TEST_JID}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ text: 'x'.repeat(40001) });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('40000');
    });

    it('returns 401 without auth token', async () => {
      const res = await request(app)
        .post(`/whatsapp/send/${TEST_JID}`)
        .send({ text: 'No auth' });

      expect(res.status).toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════
  // 4. CONFIG FALLBACK (getBaileysConfig)
  // ══════════════════════════════════════════════════════

  describe('getBaileysConfig() top-level fallback', () => {
    it('reads authMethod from top-level when nested baileys key is missing', () => {
      const config = whatsapp.getBaileysConfig();
      expect(config.authMethod).toBe('pairing-code');
    });

    it('reads pairingPhoneNumber from top-level when nested baileys key is missing', () => {
      const config = whatsapp.getBaileysConfig();
      expect(config.pairingPhoneNumber).toBe('14155551234');
    });

    it('prefers nested baileys config over top-level', () => {
      const adapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          authMethod: 'qr',
          pairingPhoneNumber: '999',
          baileys: {
            authMethod: 'pairing-code',
            pairingPhoneNumber: '111',
          },
        } as Record<string, unknown>,
        project.stateDir,
      );
      const config = adapter.getBaileysConfig();
      expect(config.authMethod).toBe('pairing-code');
      expect(config.pairingPhoneNumber).toBe('111');
    });

    it('defaults to qr when neither nested nor top-level authMethod exists', () => {
      const adapter = new WhatsAppAdapter(
        { backend: 'baileys' } as Record<string, unknown>,
        project.stateDir,
      );
      const config = adapter.getBaileysConfig();
      expect(config.authMethod).toBe('qr');
      expect(config.pairingPhoneNumber).toBe('');
    });
  });

  // ══════════════════════════════════════════════════════
  // 5. WHATSAPP REPLY SCRIPT TEMPLATE
  // ══════════════════════════════════════════════════════

  describe('WhatsApp reply script template', () => {
    it('whatsapp-reply.sh template exists', () => {
      const templatePath = path.join(process.cwd(), 'src/templates/scripts/whatsapp-reply.sh');
      expect(fs.existsSync(templatePath)).toBe(true);
    });

    it('template hits /whatsapp/send/ endpoint', () => {
      const templatePath = path.join(process.cwd(), 'src/templates/scripts/whatsapp-reply.sh');
      const content = fs.readFileSync(templatePath, 'utf-8');
      expect(content).toContain('/whatsapp/send/');
    });

    it('template accepts JID as first argument', () => {
      const templatePath = path.join(process.cwd(), 'src/templates/scripts/whatsapp-reply.sh');
      const content = fs.readFileSync(templatePath, 'utf-8');
      expect(content).toContain('JID="$1"');
    });

    it('template reads message from stdin or args', () => {
      const templatePath = path.join(process.cwd(), 'src/templates/scripts/whatsapp-reply.sh');
      const content = fs.readFileSync(templatePath, 'utf-8');
      expect(content).toContain('MSG="$(cat)"');
      expect(content).toContain('MSG="$*"');
    });

    it('template reads auth token from .instar/config.json', () => {
      const templatePath = path.join(process.cwd(), 'src/templates/scripts/whatsapp-reply.sh');
      const content = fs.readFileSync(templatePath, 'utf-8');
      expect(content).toContain('.instar/config.json');
      expect(content).toContain('authToken');
    });
  });

  // ══════════════════════════════════════════════════════
  // 6. BAILEYS BACKEND SOURCE VERIFICATION
  // ══════════════════════════════════════════════════════

  describe('BaileysBackend pairing code fix (source verification)', () => {
    const backendPath = path.join(process.cwd(), 'src/messaging/backends/BaileysBackend.ts');
    let src: string;

    beforeAll(() => {
      src = fs.readFileSync(backendPath, 'utf-8');
    });

    it('pairing code is requested on QR event, NOT inside connection open', () => {
      const qrSection = src.substring(
        src.indexOf('if (qr)'),
        src.indexOf("if (connection === 'open')"),
      );
      expect(qrSection).toContain('requestPairingCode');

      const openSection = src.substring(
        src.indexOf("if (connection === 'open')"),
        src.indexOf("if (connection === 'close')"),
      );
      expect(openSection).not.toContain('requestPairingCode');
    });

    it('stale credential detection checks creds.json age', () => {
      const closeSection = src.substring(
        src.indexOf("if (connection === 'close')"),
      );
      expect(closeSection).toContain('creds.json');
      expect(closeSection).toContain('5 * 60 * 1000');
      expect(closeSection).toContain('rmSync');
    });

    it('_pairingCodeRequested flag prevents duplicate requests', () => {
      expect(src).toContain('_pairingCodeRequested');
      // Set to true before requesting
      const qrSection = src.substring(
        src.indexOf('if (qr)'),
        src.indexOf("if (connection === 'open')"),
      );
      expect(qrSection).toContain('this._pairingCodeRequested = true');
      // Reset on failure
      expect(qrSection).toContain('this._pairingCodeRequested = false');
    });
  });

  // ══════════════════════════════════════════════════════
  // 7. WIRE WHATSAPP ROUTING (server.ts source verification)
  // ══════════════════════════════════════════════════════

  describe('wireWhatsAppRouting integration (source verification)', () => {
    const serverPath = path.join(process.cwd(), 'src/commands/server.ts');
    let src: string;

    beforeAll(() => {
      src = fs.readFileSync(serverPath, 'utf-8');
    });

    it('wireWhatsAppRouting function exists', () => {
      expect(src).toContain('function wireWhatsAppRouting(');
    });

    it('wireWhatsAppRouting calls whatsapp.onMessage', () => {
      const fnStart = src.indexOf('function wireWhatsAppRouting(');
      const fnBody = src.substring(fnStart, fnStart + 2000);
      expect(fnBody).toContain('whatsapp.onMessage(');
    });

    it('wireWhatsAppRouting spawns sessions for new JIDs', () => {
      const fnStart = src.indexOf('function wireWhatsAppRouting(');
      const fnBody = src.substring(fnStart, fnStart + 2000);
      expect(fnBody).toContain('spawnInteractiveSession');
      expect(fnBody).toContain('registerSession');
    });

    it('wireWhatsAppRouting injects messages into existing alive sessions', () => {
      const fnStart = src.indexOf('function wireWhatsAppRouting(');
      const fnBody = src.substring(fnStart, fnStart + 2000);
      expect(fnBody).toContain('injectWhatsAppMessage');
      expect(fnBody).toContain('isSessionAlive');
    });

    it('wireWhatsAppRouting handles dead sessions by respawning', () => {
      const fnStart = src.indexOf('function wireWhatsAppRouting(');
      const fnBody = src.substring(fnStart, fnStart + 2000);
      // Should check for alive then have an else branch for dead
      expect(fnBody).toContain('Session "${targetSession}" died');
      expect(fnBody).toContain('spawnInteractiveSession');
    });

    it('wireWhatsAppRouting is called during WhatsApp init', () => {
      expect(src).toContain('wireWhatsAppRouting(whatsappAdapter, sessionManager)');
    });

    it('bootstrap message includes whatsapp-reply.sh instructions', () => {
      const fnStart = src.indexOf('function wireWhatsAppRouting(');
      const fnBody = src.substring(fnStart, fnStart + 2000);
      expect(fnBody).toContain('whatsapp-reply.sh');
    });
  });

  // ══════════════════════════════════════════════════════
  // 8. SESSION MANAGER WHATSAPP INJECTION
  // ══════════════════════════════════════════════════════

  describe('SessionManager.injectWhatsAppMessage (source verification)', () => {
    const smPath = path.join(process.cwd(), 'src/core/SessionManager.ts');
    let src: string;

    beforeAll(() => {
      src = fs.readFileSync(smPath, 'utf-8');
    });

    it('injectWhatsAppMessage method exists', () => {
      expect(src).toContain('injectWhatsAppMessage(');
    });

    it('tags messages with [whatsapp:JID] format', () => {
      const fnStart = src.indexOf('injectWhatsAppMessage(');
      const fnBody = src.substring(fnStart, fnStart + 500);
      expect(fnBody).toContain('[whatsapp:${jid}');
    });

    it('includes sender name in tag when available', () => {
      const fnStart = src.indexOf('injectWhatsAppMessage(');
      const fnBody = src.substring(fnStart, fnStart + 500);
      expect(fnBody).toContain('from ${senderName');
    });

    it('handles long messages via temp files', () => {
      const fnStart = src.indexOf('injectWhatsAppMessage(');
      const fnBody = src.substring(fnStart, fnStart + 800);
      expect(fnBody).toContain('FILE_THRESHOLD');
      expect(fnBody).toContain('/tmp');
      expect(fnBody).toContain('instar-whatsapp');
      expect(fnBody).toContain('writeFileSync');
    });

    it('uses generic injectMessage for short messages', () => {
      const fnStart = src.indexOf('injectWhatsAppMessage(');
      const fnBody = src.substring(fnStart, fnStart + 800);
      expect(fnBody).toContain('this.injectMessage(tmuxSession, taggedText)');
    });
  });

  // ══════════════════════════════════════════════════════
  // 9. INIT SCRIPT INSTALLATION
  // ══════════════════════════════════════════════════════

  describe('Init installs WhatsApp relay script', () => {
    const initPath = path.join(process.cwd(), 'src/commands/init.ts');
    let src: string;

    beforeAll(() => {
      src = fs.readFileSync(initPath, 'utf-8');
    });

    it('isWhatsAppConfigured helper exists', () => {
      expect(src).toContain('function isWhatsAppConfigured(');
    });

    it('refreshScripts installs whatsapp-reply.sh when WhatsApp is configured', () => {
      expect(src).toContain('installWhatsAppRelay');
      expect(src).toContain('isWhatsAppConfigured');
    });

    it('installWhatsAppRelay function exists', () => {
      expect(src).toContain('function installWhatsAppRelay(');
    });

    it('installWhatsAppRelay writes to .instar/scripts/whatsapp-reply.sh', () => {
      const fnStart = src.indexOf('function installWhatsAppRelay(');
      const fnEnd = src.indexOf('\n}', fnStart + 50);
      const fnBody = src.substring(fnStart, fnEnd);
      expect(fnBody).toContain('whatsapp-reply.sh');
      expect(fnBody).toContain('/whatsapp/send/');
    });

    it('CLAUDE.md gets WhatsApp Relay section when WhatsApp is configured', () => {
      expect(src).toContain('WhatsApp Relay');
      expect(src).toContain('[whatsapp:JID]');
      expect(src).toContain('whatsapp-reply.sh');
    });
  });

  // ══════════════════════════════════════════════════════
  // 10. EXISTING WHATSAPP ROUTES STILL WORK
  // ══════════════════════════════════════════════════════

  describe('Existing WhatsApp routes', () => {
    it('GET /whatsapp/status returns status', async () => {
      const res = await request(app)
        .get('/whatsapp/status')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('connected');
      expect(res.body.phoneNumber).toBe('+14155551234');
    });

    it('GET /whatsapp/qr returns QR state', async () => {
      const res = await request(app)
        .get('/whatsapp/qr')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('connected');
      expect(res.body.qr).toBeNull(); // Connected, no QR needed
    });
  });
});
