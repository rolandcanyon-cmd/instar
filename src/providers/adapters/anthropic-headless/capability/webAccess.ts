/**
 * WebAccess: Claude has WebFetch + WebSearch built-in.
 */

import type {
  WebAccess,
  WebAccessRules,
  WebAccessSpec,
} from '../../../primitives/capability/webAccess.js';
import { CapabilityFlag } from '../../../capabilities.js';

class AnthropicHeadlessWebAccess implements WebAccess {
  readonly capability = CapabilityFlag.WebAccess;
  buildSpec(rules: WebAccessRules): WebAccessSpec {
    return { __brand: 'WebAccessSpec', rules } as WebAccessSpec;
  }
  supportsSearch(): boolean {
    return true;
  }
}

export function createWebAccess(): WebAccess {
  return new AnthropicHeadlessWebAccess();
}
