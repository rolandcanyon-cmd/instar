/**
 * MoltBridgeClient — Client for the MoltBridge trust network.
 *
 * Wraps the MoltBridge API for:
 * - Agent registration using canonical identity
 * - Capability-based discovery
 * - Trust score (IQS) queries with caching
 * - Peer attestation submission
 *
 * Includes circuit breaker for resilience when MoltBridge is unavailable.
 */

import crypto from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────

export interface MoltBridgeConfig {
  enabled: boolean;
  apiUrl: string;                // e.g. "https://api.moltbridge.ai"
  autoRegister: boolean;         // default false
  enrichmentMode: 'manual' | 'cached-only' | 'auto';
}

export interface MoltBridgeAgent {
  agentId: string;
  canonicalId: string;
  displayName?: string;
  capabilities: string[];
  iqsBand: 'high' | 'medium' | 'low';
  iqsScore?: number;             // exact score (only visible to agent itself)
  lastSeen?: string;
}

export interface DiscoveryResult {
  agents: MoltBridgeAgent[];
  source: 'moltbridge';
  queryTimeMs: number;
  cached: boolean;
}

export interface AttestationPayload {
  attestor: string;              // fingerprint
  subject: string;               // fingerprint
  capability: string;            // from controlled vocabulary
  outcome: 'success' | 'partial' | 'failure';
  confidence: number;            // 0.0-1.0
  context: 'direct-interaction' | 'observed' | 'delegated';
}

export interface RegistrationResult {
  agentId: string;
  registered: boolean;
  needsCrossVerification: boolean;
  needsDeposit: boolean;
}

/** Controlled vocabulary for capability tags (spec Section 3.13.1) */
export const CAPABILITY_VOCABULARY = new Set([
  // Communication
  'messaging', 'email', 'voice', 'translation', 'summarization',
  // Development
  'code-generation', 'code-review', 'debugging', 'testing', 'deployment',
  // Data
  'data-analysis', 'data-collection', 'data-transformation', 'visualization',
  // Research
  'web-research', 'document-analysis', 'fact-checking', 'literature-review',
  // Content
  'writing', 'editing', 'design', 'image-generation', 'video',
  // Operations
  'scheduling', 'monitoring', 'alerting', 'automation', 'workflow',
  // Domain
  'legal', 'financial', 'medical', 'scientific', 'engineering',
  // Meta
  'coordination', 'delegation', 'brokering', 'teaching',
]);

// ── Circuit Breaker ──────────────────────────────────────────────────

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  open: boolean;
  openedAt: number;
}

const CB_THRESHOLD = 3;
const CB_RESET_MS = 5 * 60 * 1000; // 5 minutes

// ── Client ───────────────────────────────────────────────────────────

export class MoltBridgeClient {
  private config: MoltBridgeConfig;
  private circuitBreaker: CircuitBreakerState = {
    failures: 0, lastFailure: 0, open: false, openedAt: 0,
  };
  private iqsCache: Map<string, { band: MoltBridgeAgent['iqsBand']; cachedAt: number }> = new Map();
  private readonly IQS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  constructor(config: MoltBridgeConfig) {
    this.config = config;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get enrichmentMode(): string {
    return this.config.enrichmentMode;
  }

  /**
   * Register an agent with MoltBridge.
   */
  async register(
    canonicalId: string,
    publicKey: Buffer,
    capabilities: string[],
    displayName?: string,
  ): Promise<RegistrationResult> {
    this.checkCircuitBreaker();

    try {
      const response = await this.apiCall('POST', '/v1/agents/register', {
        canonicalId,
        publicKey: publicKey.toString('base64'),
        capabilities,
        displayName,
      });
      this.recordSuccess();
      return response as RegistrationResult;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Discover agents by capability.
   */
  async discover(
    capability: string,
    limit = 10,
  ): Promise<DiscoveryResult> {
    this.checkCircuitBreaker();

    const startTime = Date.now();
    try {
      const response = await this.apiCall('POST', '/v1/discover', {
        capability,
        limit,
      });
      this.recordSuccess();

      const agents = (response as any).agents ?? [];
      return {
        agents,
        source: 'moltbridge',
        queryTimeMs: Date.now() - startTime,
        cached: false,
      };
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Get IQS band for an agent (cached).
   */
  async getIQSBand(agentCanonicalId: string): Promise<MoltBridgeAgent['iqsBand'] | null> {
    // Check cache first
    const cached = this.iqsCache.get(agentCanonicalId);
    if (cached && Date.now() - cached.cachedAt < this.IQS_CACHE_TTL_MS) {
      return cached.band;
    }

    this.checkCircuitBreaker();

    try {
      const response = await this.apiCall('GET', `/v1/trust/${agentCanonicalId}`);
      this.recordSuccess();

      const band = (response as any).iqsBand ?? 'unknown';
      this.iqsCache.set(agentCanonicalId, { band, cachedAt: Date.now() });
      return band;
    } catch (err) {
      this.recordFailure();
      return null; // graceful degradation
    }
  }

  /**
   * Submit a peer attestation.
   */
  async submitAttestation(attestation: AttestationPayload): Promise<boolean> {
    // Validate capability tag
    if (!CAPABILITY_VOCABULARY.has(attestation.capability)) {
      throw new Error(`Invalid capability tag: "${attestation.capability}". Must be from controlled vocabulary.`);
    }

    // Validate confidence range
    if (attestation.confidence < 0 || attestation.confidence > 1) {
      throw new Error('Confidence must be between 0.0 and 1.0');
    }

    this.checkCircuitBreaker();

    try {
      await this.apiCall('POST', '/v1/attestations', attestation);
      this.recordSuccess();
      return true;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Check registration status and wallet balance.
   */
  async getStatus(canonicalId: string): Promise<{
    registered: boolean;
    walletBalance?: string;
    iqsBand?: string;
  }> {
    this.checkCircuitBreaker();

    try {
      const response = await this.apiCall('GET', `/v1/agents/${canonicalId}/status`);
      this.recordSuccess();
      return response as any;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Check if the circuit breaker is currently open.
   */
  get isCircuitBreakerOpen(): boolean {
    if (!this.circuitBreaker.open) return false;
    if (Date.now() - this.circuitBreaker.openedAt > CB_RESET_MS) {
      this.circuitBreaker.open = false;
      this.circuitBreaker.failures = 0;
      return false;
    }
    return true;
  }

  // ── Private ─────────────────────────────────────────────────────

  private checkCircuitBreaker(): void {
    if (this.isCircuitBreakerOpen) {
      throw new Error('MoltBridge circuit breaker is open — service temporarily unavailable');
    }
  }

  private recordSuccess(): void {
    this.circuitBreaker.failures = 0;
  }

  private recordFailure(): void {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = Date.now();
    if (this.circuitBreaker.failures >= CB_THRESHOLD) {
      this.circuitBreaker.open = true;
      this.circuitBreaker.openedAt = Date.now();
    }
  }

  private async apiCall(method: string, path: string, body?: any): Promise<unknown> {
    const url = `${this.config.apiUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body && { body: JSON.stringify(body) }),
    };

    const response = await fetch(url, options);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`MoltBridge API error: ${response.status} ${response.statusText} — ${errorBody}`);
    }
    return response.json();
  }
}
