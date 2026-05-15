/**
 * OneShotCompletion implementation for the openai-codex adapter.
 *
 * Spawns `codex exec PROMPT --skip-git-repo-check --ephemeral -s read-only
 * --output-last-message <tmpfile>` and reads the final agent message from
 * the file. Direct analog of `claude -p` for the headless Anthropic adapter.
 */

import { execFile, type ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  OneShotCompletion,
  OneShotCompletionOptions,
  OneShotCompletionResult,
} from '../../../primitives/transport/oneShotCompletion.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { AbortError } from '../../../errors.js';
import type { OpenAiCodexConfig } from '../config.js';
import { OPENAI_CODEX_ID, mapExecError } from '../errors.js';
import { resolveCliModelFlag } from '../models.js';

const execFileAsync = promisify(execFile);

class OpenAiCodexOneShotCompletion implements OneShotCompletion {
  readonly capability = CapabilityFlag.OneShotCompletion;

  constructor(private readonly config: OpenAiCodexConfig) {}

  async evaluate(
    prompt: string,
    options?: OneShotCompletionOptions,
  ): Promise<OneShotCompletionResult> {
    const timeoutMs = options?.timeoutMs ?? this.config.defaultOneShotTimeoutMs ?? 60_000;
    const model = resolveCliModelFlag(options?.model ?? this.config.defaultModel);
    const sandbox = this.config.defaultSandboxMode ?? 'read-only';

    const outFile = path.join(tmpdir(), `codex-oneshot-${randomBytes(8).toString('hex')}.txt`);

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '-s',
      sandbox,
      '-m',
      model,
      '--output-last-message',
      outFile,
    ];

    if (options?.system) {
      args.push('-c', `instructions=${JSON.stringify(options.system)}`);
    }
    if (this.config.defaultProfile) {
      args.push('-p', this.config.defaultProfile);
    }

    args.push(prompt);

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (this.config.apiKey) {
      childEnv['OPENAI_API_KEY'] = this.config.apiKey;
    }
    if (this.config.codexHome) {
      childEnv['CODEX_HOME'] = this.config.codexHome;
    }

    const abortSignal = options?.signal;
    if (abortSignal?.aborted) {
      throw new AbortError('Aborted before start', OPENAI_CODEX_ID);
    }

    try {
      await execFileAsync(this.config.codexPath, args, {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: childEnv,
        signal: abortSignal,
      });
      const text = await fs.readFile(outFile, 'utf-8').catch(() => '');
      return {
        text: text.trim(),
        usage: null,
        providerSpecific: { [OPENAI_CODEX_ID]: { model, sandbox } },
      };
    } catch (err) {
      const error = err as ExecFileException;
      if (error.name === 'AbortError' || abortSignal?.aborted) {
        throw new AbortError('Aborted during execution', OPENAI_CODEX_ID, err);
      }
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      throw mapExecError(
        error as unknown as Error & { code?: string | number; signal?: string; killed?: boolean; path?: string },
        stderr,
      );
    } finally {
      fs.unlink(outFile).catch(() => undefined);
    }
  }
}

export function createOneShotCompletion(config: OpenAiCodexConfig): OneShotCompletion {
  return new OpenAiCodexOneShotCompletion(config);
}
