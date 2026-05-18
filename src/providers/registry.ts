/**
 * Registry — runtime adapter discovery and selection.
 *
 * The single point of access for application code that needs a provider.
 * Adapters register themselves on startup; consumers query by capability
 * and receive an adapter that can satisfy the request.
 *
 * Design:
 *   - Adapters declare their capabilities up front (no late binding).
 *   - The registry stores adapters keyed by ProviderId.
 *   - `resolve()` returns the first adapter matching a capability set,
 *     or the adapter chosen by an injected `RoutingPolicy`.
 *   - All resolution is synchronous once adapters are registered;
 *     registration is async to allow adapters to do setup at register time.
 */

import type { ProviderId } from './types.js';
import type { CapabilityFlag, CapabilitySet } from './capabilities.js';
import { hasAllCapabilities, missingCapability } from './capabilities.js';
import type { RoutingPolicy, RoutingDecision } from './routing.js';
import { UnsupportedCapabilityError } from './errors.js';

/**
 * Adapter registration record. Adapters implement this contract by
 * exporting a factory that produces one of these.
 */
export interface ProviderAdapter {
  /** Stable identifier for this adapter. */
  readonly id: ProviderId;
  /** Capabilities this adapter supports. */
  readonly capabilities: CapabilitySet;
  /**
   * Optional self-test the registry can run during registration to
   * validate the adapter is healthy. Resolves on success; rejects with
   * a ProviderError on failure (the registration is rejected).
   */
  readonly selfTest?: () => Promise<void>;
  /** Optional cleanup hook called when the adapter is unregistered. */
  readonly dispose?: () => Promise<void>;
  /**
   * Get the implementation of a specific primitive by capability flag.
   * Returns undefined if the capability isn't supported. Callers should
   * check `capabilities` first or use the registry's `resolve()`.
   *
   * The type of the returned implementation is provider-specific; callers
   * cast at the use site (or use the higher-level helpers below).
   */
  readonly primitive: (capability: CapabilityFlag) => unknown;
}

export interface ResolveRequest {
  /** Capabilities the caller requires. */
  requires: ReadonlyArray<CapabilityFlag>;
  /**
   * Optional capabilities (preferred if available, but not required).
   * Used by the routing policy to break ties.
   */
  prefers?: ReadonlyArray<CapabilityFlag>;
  /**
   * Optional adapter id pin. If set, only that adapter is considered.
   * Throws UnsupportedCapabilityError if pinned adapter is missing
   * required capabilities.
   */
  pinTo?: ProviderId;
  /**
   * Optional context for the routing policy (cost preference, quota
   * state, user override, etc.).
   */
  routingContext?: Readonly<Record<string, unknown>>;
}

export class Registry {
  private adapters = new Map<ProviderId, ProviderAdapter>();
  private routingPolicy: RoutingPolicy | null = null;

  /** Register an adapter. Runs selfTest if present. */
  async register(adapter: ProviderAdapter): Promise<void> {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Adapter already registered: ${adapter.id}`);
    }
    if (adapter.selfTest) {
      await adapter.selfTest();
    }
    this.adapters.set(adapter.id, adapter);
  }

  /** Unregister an adapter, calling dispose if present. */
  async unregister(id: ProviderId): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    if (adapter.dispose) {
      await adapter.dispose();
    }
    this.adapters.delete(id);
  }

  /** Set or replace the routing policy. */
  setRoutingPolicy(policy: RoutingPolicy | null): void {
    this.routingPolicy = policy;
  }

  /** List all registered adapter IDs. */
  list(): ReadonlyArray<ProviderId> {
    return Array.from(this.adapters.keys());
  }

  /** Get an adapter by ID directly (no routing). Returns undefined if absent. */
  get(id: ProviderId): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * Find adapters that support the given capability set.
   * Returns all matching adapters; use `resolve` for routing-based selection.
   */
  candidates(required: ReadonlyArray<CapabilityFlag>): ReadonlyArray<ProviderAdapter> {
    return Array.from(this.adapters.values()).filter((a) =>
      hasAllCapabilities(a.capabilities, [...required]),
    );
  }

  /**
   * Resolve a request to a specific adapter. Uses the routing policy when
   * multiple candidates match; falls back to first-match-by-registration
   * order when no policy is set.
   *
   * Throws UnsupportedCapabilityError when no adapter can satisfy the
   * required capabilities.
   */
  async resolve(request: ResolveRequest): Promise<ProviderAdapter> {
    if (request.pinTo) {
      const pinned = this.adapters.get(request.pinTo);
      if (!pinned) {
        throw new UnsupportedCapabilityError(
          `pinned-adapter-not-registered:${request.pinTo}`,
          request.pinTo,
        );
      }
      const missing = missingCapability(pinned.capabilities, [...request.requires]);
      if (missing) {
        throw new UnsupportedCapabilityError(missing, request.pinTo);
      }
      return pinned;
    }

    const candidates = this.candidates(request.requires);
    if (candidates.length === 0) {
      throw new UnsupportedCapabilityError(
        request.requires.join(','),
        '<no-adapter>' as ProviderId,
      );
    }
    if (candidates.length === 1) {
      return candidates[0]!;
    }

    if (this.routingPolicy) {
      const decision: RoutingDecision = await this.routingPolicy.decide(
        candidates,
        request,
      );
      const chosen = this.adapters.get(decision.chosen);
      if (!chosen) {
        throw new Error(
          `Routing policy returned unknown adapter: ${decision.chosen}`,
        );
      }
      return chosen;
    }

    // No policy — first candidate by registration order
    return candidates[0]!;
  }

  /**
   * Convenience: resolve and return a specific primitive implementation.
   * Caller casts to the appropriate primitive type.
   */
  async resolvePrimitive(
    capability: CapabilityFlag,
    request: Omit<ResolveRequest, 'requires'> = {},
  ): Promise<unknown> {
    const adapter = await this.resolve({ ...request, requires: [capability] });
    return adapter.primitive(capability);
  }
}

/** The application-wide default registry instance. */
export const registry = new Registry();
