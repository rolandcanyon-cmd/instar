/**
 * WebAccess implementation for openai-codex.
 *
 * Codex `web_search` is on by default and toggleable per profile via
 * `permissions.<name>.network`.
 */

import type {
  WebAccess,
  WebAccessRules,
  WebAccessSpec,
} from '../../../primitives/capability/webAccess.js';
import { CapabilityFlag } from '../../../capabilities.js';

class OpenAiCodexWebAccess implements WebAccess {
  readonly capability = CapabilityFlag.WebAccess;
  buildSpec(rules: WebAccessRules): WebAccessSpec {
    return Object.freeze({ __brand: 'WebAccessSpec', rules }) as WebAccessSpec;
  }
  supportsSearch(): boolean { return true; }
}

export function createWebAccess(): WebAccess { return new OpenAiCodexWebAccess(); }
