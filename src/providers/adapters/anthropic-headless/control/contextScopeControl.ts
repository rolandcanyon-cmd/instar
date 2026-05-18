/**
 * ContextScopeControl: maps to Claude's --setting-sources flag.
 *
 * The setting-sources flag accepts 'user', 'project', 'managed'. Our
 * abstract scopes map roughly: user → 'user', project → 'project',
 * directory → 'project' (subdir-level isn't directly supported), override
 * → 'project' too. 'builtin' is always included by Claude.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ContextScopeControl,
  ContextScopeRules,
  ContextScopeSpec,
  ContextScope,
} from '../../../primitives/control/contextScopeControl.js';
import { CapabilityFlag } from '../../../capabilities.js';

class AnthropicHeadlessContextScopeControl implements ContextScopeControl {
  readonly capability = CapabilityFlag.ContextScopeControl;

  buildSpec(rules: ContextScopeRules): ContextScopeSpec {
    return { __brand: 'ContextScopeSpec', rules } as ContextScopeSpec;
  }

  supportedScopes(): ReadonlySet<ContextScope> {
    return new Set<ContextScope>(['builtin', 'user', 'project', 'directory']);
  }

  async writeInstructionFile(
    scope: ContextScope,
    filePath: string,
    content: string,
  ): Promise<void> {
    // Scope mostly affects WHERE we write — caller already knows; we just write.
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }
}

export function createContextScopeControl(): ContextScopeControl {
  return new AnthropicHeadlessContextScopeControl();
}
