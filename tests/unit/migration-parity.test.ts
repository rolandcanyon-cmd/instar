/**
 * Migration Parity — Structural enforcement that changes to agent-installed
 * files always include corresponding post-update migrations.
 *
 * This test catches the class of bug where a feature works for new agents
 * (via init) but silently fails for existing agents (no migration).
 *
 * Updated 2026-03-24: HTTP hooks replaced with command hooks due to
 * Claude Code HTTP hooks silently failing to fire (v2.1.78).
 */

import { describe, it, expect } from 'vitest';
import { HOOK_EVENT_TEMPLATES, buildHttpHookSettings } from '../../src/data/http-hook-templates.js';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATOR_PATH = path.join(import.meta.dirname, '../../src/core/PostUpdateMigrator.ts');
const migratorSource = fs.readFileSync(MIGRATOR_PATH, 'utf-8');

describe('Migration Parity', () => {
  describe('Hook event templates ↔ PostUpdateMigrator', () => {
    it('all templates use command type (not HTTP)', () => {
      for (const template of HOOK_EVENT_TEMPLATES) {
        expect(template.config.type).toBe('command');
      }
    });

    it('all templates reference hook-event-reporter.js', () => {
      for (const template of HOOK_EVENT_TEMPLATES) {
        expect(template.config.command).toContain('hook-event-reporter.js');
      }
    });

    it('buildHttpHookSettings produces command hooks (not HTTP)', () => {
      const settings = buildHttpHookSettings('http://localhost:4042');

      for (const [_event, entries] of Object.entries(settings)) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            const hookObj = hook as Record<string, unknown>;
            expect(hookObj.type).toBe('command');
            expect(hookObj.command).toContain('hook-event-reporter.js');
            // Should NOT contain any HTTP-specific fields
            expect(hookObj.url).toBeUndefined();
            expect(hookObj.headers).toBeUndefined();
            expect(hookObj.allowedEnvVars).toBeUndefined();
          }
        }
      }
    });
  });

  describe('PostUpdateMigrator completeness', () => {
    it('migrateSettings is called from migrate()', () => {
      expect(migratorSource).toContain('this.migrateSettings(result)');
    });

    it('migrateHttpHooksToCommandHooks is called from migrateSettings', () => {
      expect(migratorSource).toContain('this.migrateHttpHooksToCommandHooks(');
    });

    it('migrateHttpHookSessionId is still called (for agents not yet migrated to command hooks)', () => {
      // Some agents might still have HTTP hooks from an intermediate version.
      // The session ID migration should still run to patch those before
      // migrateHttpHooksToCommandHooks converts them.
      expect(migratorSource).toContain('this.migrateHttpHookSessionId(');
    });

    it('ensureHttpHooksExist checks for BOTH command and HTTP hooks', () => {
      // The guard that prevents duplicate hooks must recognize both formats
      expect(migratorSource).toContain('hook-event-reporter');
      expect(migratorSource).toContain("h.type === 'command'");
      expect(migratorSource).toContain("h.type === 'http'");
    });

    it('migration installs hook-event-reporter.js script', () => {
      expect(migratorSource).toContain('hook-event-reporter.js');
      expect(migratorSource).toContain('getHookEventReporterScript');
    });

    it('hook-event-reporter.js script includes required env vars', () => {
      // The script content (embedded in PostUpdateMigrator) must reference
      // the env vars needed for authentication and session mapping
      expect(migratorSource).toContain('INSTAR_SERVER_URL');
      expect(migratorSource).toContain('INSTAR_AUTH_TOKEN');
      expect(migratorSource).toContain('INSTAR_SESSION_ID');
    });

    it('hook-event-reporter.js script posts to /hooks/events', () => {
      expect(migratorSource).toContain('/hooks/events');
      expect(migratorSource).toContain('session_id');
    });
  });

  describe('Regression guards', () => {
    it('no HTTP hook templates remain (Claude Code HTTP hooks are broken)', () => {
      // If someone adds HTTP hooks back, this test fails.
      // HTTP hooks silently fail in Claude Code <=2.1.78.
      for (const template of HOOK_EVENT_TEMPLATES) {
        expect(
          template.config.type,
          `Template for "${template.event}" uses HTTP type. ` +
          `Claude Code HTTP hooks silently fail to fire — use command hooks with hook-event-reporter.js instead.`,
        ).not.toBe('http');
      }
    });

    it('migration handles HTTP hooks with unresolved template vars', () => {
      // The migration must handle ${INSTAR_SERVER_URL} in hook URLs
      // (a known bug from earlier migration attempts)
      expect(migratorSource).toContain('${INSTAR_SERVER_URL}');
    });

    it('autonomous stop hook is deployed and registered during migration', () => {
      // Without this, /autonomous mode has no structural enforcement.
      // Sessions would enter "autonomous mode" in name only — the stop hook
      // that blocks exit and feeds tasks back would never fire.
      expect(migratorSource).toContain('ensureAutonomousStopHook');
      expect(migratorSource).toContain('autonomous-stop-hook');
      // Must both deploy files AND register in settings.json
      expect(migratorSource).toContain('autonomous-stop-hook.sh');
      expect(migratorSource).toContain('hooks.Stop');
    });
  });
});
