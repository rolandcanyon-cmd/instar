/**
 * claude-agent-kit — Bootstrap persistent agent infrastructure into any Claude Code project.
 *
 * Public API for programmatic usage.
 */

// Core
export { SessionManager } from './core/SessionManager.js';
export { StateManager } from './core/StateManager.js';
export { loadConfig, detectTmuxPath, detectClaudePath, ensureStateDir } from './core/Config.js';

// Users
export { UserManager } from './users/UserManager.js';

// Types
export type {
  Session,
  SessionStatus,
  SessionManagerConfig,
  ModelTier,
  JobDefinition,
  JobPriority,
  JobExecution,
  JobState,
  JobSchedulerConfig,
  UserProfile,
  UserChannel,
  UserPreferences,
  Message,
  OutgoingMessage,
  MessagingAdapter,
  MessagingAdapterConfig,
  QuotaState,
  AccountQuota,
  HealthStatus,
  ComponentHealth,
  ActivityEvent,
  AgentKitConfig,
  MonitoringConfig,
} from './core/types.js';
