/**
 * MoltBridge module — Public API.
 */

export {
  MoltBridgeClient,
  CAPABILITY_VOCABULARY,
  type MoltBridgeConfig,
  type MoltBridgeAgent,
  type DiscoveryResult,
  type AttestationPayload,
  type RegistrationResult,
} from './MoltBridgeClient.js';

export {
  createMoltBridgeRoutes,
  type MoltBridgeRouteDeps,
} from './routes.js';
