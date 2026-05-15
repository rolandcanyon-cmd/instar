/**
 * AgenticSessionHeadless implementation for the openai-codex adapter.
 *
 * Two implementation choices for headless Codex sessions:
 *   1. `codex exec --json PROMPT` in a tmux session, parse stdout JSONL
 *      events into CanonicalEvent stream.
 *   2. `codex app-server` JSON-RPC `thread/start` method (richer, but
 *      requires running the app-server).
 *
 * Phase 4 uses (1) — mirrors the Anthropic adapter's tmux pattern, gives
 * us live stdout to parse, doesn't require app-server lifecycle
 * management. The app-server path is reserved for `agenticSessionRpc`.
 *
 * Event normalization per the deep-dive (02-codex-deep-dive.md §C):
 *   - `thread.started` → session-lifecycle (started)
 *   - `turn.started` → no canonical event (boundary marker only)
 *   - `turn.completed` → turn-end (with usage)
 *   - `item.agentMessage.delta` → message-delta
 *   - `item.commandExecution.*` → tool-call / tool-result
 *   - `error` → error
 *   - `turn.failed` → error + session-lifecycle (ended)
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type {
  AgenticSessionHeadless,
  AgenticSessionHeadlessOptions,
  AgenticSessionHandle,
} from '../../../primitives/transport/agenticSessionHeadless.js';
import type { CanonicalEvent } from '../../../events.js';
import type { SessionHandle } from '../../../types.js';
import { sessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnexpectedError } from '../../../errors.js';
import { OPENAI_CODEX_ID } from '../errors.js';
import { resolveCliModelFlag } from '../models.js';
import { normalizeCodexJsonlEvent } from '../observability/eventNormalizer.js';
import type { OpenAiCodexConfig } from '../config.js';

class OpenAiCodexAgenticSession implements AgenticSessionHeadless {
  readonly capability = CapabilityFlag.AgenticSessionHeadless;

  constructor(private readonly config: OpenAiCodexConfig) {}

  async start(options: AgenticSessionHeadlessOptions): Promise<AgenticSessionHandle> {
    const sessionId = `ocs-${randomBytes(8).toString('hex')}`;
    const tmuxName = `instar-${sessionId}`;
    const cwd = options.workingDirectory ?? this.config.defaultWorkingDirectory ?? process.cwd();
    const model = resolveCliModelFlag(options.model ?? this.config.defaultModel);
    const sandbox = this.config.defaultSandboxMode ?? 'workspace-write';

    const codexArgs = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      sandbox,
      '-m',
      model,
      '-C',
      cwd,
      options.prompt,
    ];

    const sessionEnv: Array<[string, string]> = [
      ['INSTAR_SESSION_ID', sessionId],
    ];
    if (this.config.apiKey) sessionEnv.push(['OPENAI_API_KEY', this.config.apiKey]);
    if (this.config.codexHome) sessionEnv.push(['CODEX_HOME', this.config.codexHome]);
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) sessionEnv.push([k, v]);
    }

    const tmuxArgs = ['new-session', '-d', '-s', tmuxName, '-c', cwd];
    for (const [k, v] of sessionEnv) tmuxArgs.push('-e', `${k}=${v}`);
    tmuxArgs.push(this.config.codexPath, ...codexArgs);

    try {
      execFileSync(this.config.tmuxPath, tmuxArgs, { encoding: 'utf-8' });
      try {
        execFileSync(
          this.config.tmuxPath,
          ['set-option', '-t', `=${tmuxName}:`, 'history-limit', '50000'],
          { encoding: 'utf-8', timeout: 5000 },
        );
      } catch {
        /* nice-to-have */
      }
    } catch (err) {
      throw new UnexpectedError(
        `Failed to spawn codex tmux session: ${(err as Error).message}`,
        OPENAI_CODEX_ID,
        err,
      );
    }

    const handle = sessionHandle(`${OPENAI_CODEX_ID}/${tmuxName}`);

    // The events stream tails the tmux pane. Codex `--json` writes JSONL to
    // stdout, which tmux captures. We tail by polling capture-pane and
    // parsing newline-delimited JSON entries.
    const tmuxPath = this.config.tmuxPath;
    const events: AsyncIterable<CanonicalEvent> = {
      async *[Symbol.asyncIterator]() {
        let lastSeenLineIdx = 0;
        // emit session-lifecycle start
        yield {
          type: 'session-lifecycle',
          timestamp: new Date().toISOString(),
          providerId: OPENAI_CODEX_ID,
          lifecycleKind: 'started',
          sessionHandle: handle,
        } as CanonicalEvent;

        while (true) {
          const sessionAlive = await new Promise<boolean>((resolve) => {
            const child = spawn(tmuxPath, ['has-session', '-t', tmuxName], {
              stdio: 'ignore',
            });
            child.on('exit', (code) => resolve(code === 0));
            child.on('error', () => resolve(false));
          });

          let pane = '';
          try {
            pane = execFileSync(tmuxPath, ['capture-pane', '-p', '-J', '-S', '-1000', '-t', tmuxName], {
              encoding: 'utf-8',
              timeout: 5000,
            });
          } catch {
            pane = '';
          }

          const lines = pane.split('\n');
          for (let i = lastSeenLineIdx; i < lines.length; i++) {
            const raw = lines[i]?.trim();
            if (!raw || !raw.startsWith('{')) continue;
            const ev = normalizeCodexJsonlEvent(raw);
            if (ev) yield ev;
          }
          lastSeenLineIdx = lines.length;

          if (!sessionAlive) {
            yield {
              type: 'session-lifecycle',
              timestamp: new Date().toISOString(),
              providerId: OPENAI_CODEX_ID,
              lifecycleKind: 'ended',
              sessionHandle: handle,
            } as CanonicalEvent;
            return;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      },
    };

    return {
      handle,
      events,
      providerSpecific: {
        [OPENAI_CODEX_ID]: { tmuxSession: tmuxName, sessionId, model, cwd, sandbox },
      },
    };
  }
}

/**
 * Extract the tmux session name from a SessionHandle issued by this adapter.
 */
export function tmuxSessionFromHandle(handle: SessionHandle): string {
  const prefix = `${OPENAI_CODEX_ID}/`;
  if (!handle.startsWith(prefix)) {
    throw new UnexpectedError(
      `SessionHandle was not issued by openai-codex: ${handle}`,
      OPENAI_CODEX_ID,
    );
  }
  return handle.slice(prefix.length);
}

export function createAgenticSessionHeadless(
  config: OpenAiCodexConfig,
): AgenticSessionHeadless {
  return new OpenAiCodexAgenticSession(config);
}
