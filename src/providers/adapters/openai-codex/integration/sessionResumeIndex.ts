/**
 * SessionResumeIndex implementation for openai-codex.
 *
 * Codex rollouts live at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * with a SQLite index at `sqlite_home` (per the deep-dive). This adapter
 * walks the filesystem directly; the SQLite index is a Phase 5 optimization.
 *
 * `codex resume --last` / `codex resume --all` are the CLI-side picker
 * surfaces; this primitive exposes a programmatic equivalent.
 */

import { promises as fs } from 'node:fs';
import type { CancellationOptions, SessionHandle } from '../../../types.js';
import type {
  SessionResumeIndex,
  FindRecentOptions,
  ResumeOptions,
  ResumableSession,
} from '../../../primitives/integration/sessionResumeIndex.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnsupportedCapabilityError } from '../../../errors.js';
import { OPENAI_CODEX_ID } from '../errors.js';
import { listAllRollouts, findRolloutFile } from '../observability/sessionPaths.js';
import { syntheticHandleForThread, bindCodexThreadId } from '../observability/sessionId.js';
import type { OpenAiCodexConfig } from '../config.js';

function uuidFromFilename(filename: string): string | null {
  const m = filename.match(/rollout-[^-]+-(.+)\.jsonl$/);
  return m?.[1] ?? null;
}

async function readSummary(filePath: string): Promise<{ projectRoot?: string; turnCount?: number; summary?: string }> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    let projectRoot: string | undefined;
    let turnCount = 0;
    let firstUserMessage: string | undefined;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed['cwd'] && !projectRoot) projectRoot = String(parsed['cwd']);
        const type = String(parsed['type'] ?? '');
        if (type === 'turn.started' || type === 'turn.completed') turnCount++;
        if (!firstUserMessage && type === 'item.completed') {
          const item = parsed['item'] as Record<string, unknown> | undefined;
          if (item?.['type'] === 'user_message') {
            firstUserMessage = String(item['text'] ?? '').slice(0, 200);
          }
        }
      } catch {
        continue;
      }
    }
    return { projectRoot, turnCount, summary: firstUserMessage };
  } catch {
    return {};
  }
}

class OpenAiCodexSessionResumeIndex implements SessionResumeIndex {
  readonly capability = CapabilityFlag.SessionResumeIndex;

  constructor(private readonly config: OpenAiCodexConfig) {}

  async findById(providerSessionId: string, _options?: CancellationOptions): Promise<ResumableSession | null> {
    const file = await findRolloutFile(providerSessionId, this.config.codexHome);
    if (!file) return null;
    const meta = await readSummary(file);
    const stat = await fs.stat(file);
    return {
      providerSessionId,
      projectRoot: meta.projectRoot,
      lastActiveAt: new Date(stat.mtimeMs).toISOString(),
      turnCount: meta.turnCount,
      summary: meta.summary,
      providerSpecific: { [OPENAI_CODEX_ID]: { rolloutPath: file } },
    };
  }

  async findRecent(options?: FindRecentOptions): Promise<ReadonlyArray<ResumableSession>> {
    const limit = options?.limit ?? 10;
    const rollouts = await listAllRollouts(this.config.codexHome, limit * 3);
    const out: ResumableSession[] = [];
    const cutoff = options?.maxAgeMs ? Date.now() - options.maxAgeMs : 0;
    for (const r of rollouts) {
      if (r.mtime < cutoff) continue;
      const uuid = uuidFromFilename(r.path);
      if (!uuid) continue;
      const meta = await readSummary(r.path);
      if (options?.projectRoot && meta.projectRoot !== options.projectRoot) continue;
      out.push({
        providerSessionId: uuid,
        projectRoot: meta.projectRoot,
        lastActiveAt: new Date(r.mtime).toISOString(),
        turnCount: meta.turnCount,
        summary: meta.summary,
        providerSpecific: { [OPENAI_CODEX_ID]: { rolloutPath: r.path } },
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async listByProject(projectRoot: string, options?: CancellationOptions): Promise<ReadonlyArray<ResumableSession>> {
    return this.findRecent({ projectRoot, limit: 100, signal: options?.signal });
  }

  async resume(providerSessionId: string, options?: ResumeOptions): Promise<SessionHandle> {
    if (options?.fromTurnIndex !== undefined) {
      // Codex supports thread/rollback via app-server; the headless `codex
      // resume` CLI path is "latest turn." Surface as unsupported until we
      // wire the app-server path in Phase 5.
      throw new UnsupportedCapabilityError(CapabilityFlag.SessionResumeIndex, OPENAI_CODEX_ID);
    }
    const handle = syntheticHandleForThread(providerSessionId);
    bindCodexThreadId(handle, providerSessionId);
    return handle;
  }
}

export function createSessionResumeIndex(config: OpenAiCodexConfig): SessionResumeIndex {
  return new OpenAiCodexSessionResumeIndex(config);
}
