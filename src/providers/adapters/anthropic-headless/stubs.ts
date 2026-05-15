/**
 * Throwing-stub factory for primitives the adapter declares but doesn't
 * yet implement. Calling any method on a stub raises
 * UnsupportedCapabilityError with a clear "not yet implemented" message.
 *
 * The adapter still declares the capability so the registry can find it
 * (preventing a different adapter from silently winning routing). When a
 * consumer eventually calls a stubbed primitive, the throw is loud and
 * gives Phase 3a or later a clear todo target.
 */

import { UnsupportedCapabilityError } from '../../errors.js';
import type { CapabilityFlag } from '../../capabilities.js';
import { ANTHROPIC_HEADLESS_ID } from './errors.js';

/**
 * Returns a Proxy-style stub for any primitive. Every property access
 * returns a function that throws with the capability name and the
 * specific method that was called.
 */
export function createStubPrimitive(capability: CapabilityFlag): { capability: typeof capability } {
  return new Proxy(
    { capability },
    {
      get(target, prop, receiver) {
        if (prop === 'capability') {
          return target.capability;
        }
        // Return a function that throws when called
        return (..._args: unknown[]) => {
          throw new UnsupportedCapabilityError(
            `${String(capability)}.${String(prop)} (not yet implemented in anthropic-headless adapter)`,
            ANTHROPIC_HEADLESS_ID,
          );
        };
      },
    },
  ) as { capability: typeof capability };
}
