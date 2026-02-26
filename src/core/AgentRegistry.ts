/**
 * Agent Registry — unified agent tracking and port allocation.
 *
 * Maintains a machine-wide registry at ~/.instar/registry.json tracking
 * ALL agents on the machine (both standalone and project-bound).
 *
 * Replaces the older PortRegistry with:
 *   - Agent type awareness (standalone vs project-bound)
 *   - Status tracking with heartbeat
 *   - File locking for safe concurrent access
 *   - Migration from legacy port-registry.json
 *
 * The canonical unique key is `path` (absolute path to the project directory).
 * Agent names are display labels only — NOT unique.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import lockfile from 'proper-lockfile';
import type { AgentRegistry, AgentRegistryEntry, AgentType, AgentStatus } from './types.js';
import { getInstarVersion } from './Config.js';

// Paths are computed lazily from os.homedir() so they pick up mocks in tests
function registryDir(): string { return path.join(os.homedir(), '.instar'); }
function registryPath(): string { return path.join(registryDir(), 'registry.json'); }
function legacyRegistryPath(): string { return path.join(registryDir(), 'port-registry.json'); }

const DEFAULT_PORT_RANGE_START = 4040;
const DEFAULT_PORT_RANGE_END = 4099;

/** Agent name validation: alphanumeric, underscore, hyphen. Max 64 chars. */
const AGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const LOCK_OPTIONS_ASYNC = {
  stale: 10_000,
  retries: { retries: 5, factor: 2, minTimeout: 100 },
};

// lockSync doesn't support retries — use simple stale detection only
const LOCK_OPTIONS_SYNC = {
  stale: 10_000,
};

/**
 * Validate an agent name for use in paths and registration.
 * Rejects names with path separators, null bytes, or `..`.
 */
export function validateAgentName(name: string): boolean {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || name.includes('..')) {
    return false;
  }
  return AGENT_NAME_PATTERN.test(name);
}

/**
 * Check if a process with the given PID is running.
 */
function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // @silent-fallback-ok — signal 0 process check
    return false;
  }
}

/**
 * Ensure the registry directory exists.
 */
function ensureRegistryDir(): void {
  fs.mkdirSync(registryDir(), { recursive: true });
}

/**
 * Load the agent registry from disk.
 * On first load, migrates from legacy port-registry.json if present.
 * Returns an empty registry if no file exists.
 */
export function loadRegistry(): AgentRegistry {
  ensureRegistryDir();

  // If registry.json doesn't exist, try migrating from legacy
  if (!fs.existsSync(registryPath())) {
    if (fs.existsSync(legacyRegistryPath())) {
      return migrateFromPortRegistry();
    }
    return { version: 1, entries: [] };
  }

  try {
    const data = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    return {
      version: data.version ?? 1,
      entries: Array.isArray(data.entries) ? data.entries : [],
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

/**
 * Save the registry to disk (atomic write via temp file + rename).
 */
export function saveRegistry(registry: AgentRegistry): void {
  ensureRegistryDir();
  const tmpPath = `${registryPath()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2));
    fs.renameSync(tmpPath, registryPath());
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Execute a read-modify-write cycle on the registry with file locking.
 * Uses proper-lockfile with stale detection to prevent deadlocks.
 */
async function withLock<T>(fn: (registry: AgentRegistry) => T): Promise<T> {
  ensureRegistryDir();

  // Ensure the registry file exists before locking (proper-lockfile needs it)
  if (!fs.existsSync(registryPath())) {
    const initial = loadRegistry();
    saveRegistry(initial);
  }

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(registryPath(), LOCK_OPTIONS_ASYNC);
    const registry = loadRegistry();
    const result = fn(registry);
    saveRegistry(registry);
    return result;
  } catch (err) {
    // If lock acquisition fails after retries, provide actionable error
    if (err instanceof Error && err.message.includes('ELOCKED')) {
      throw new Error(
        'Registry is locked by another process. If no other instar process is running, ' +
        'delete ~/.instar/registry.json.lock and retry.'
      );
    }
    throw err;
  } finally {
    if (release) {
      try { await release(); } catch { /* ignore unlock errors */ }
    }
  }
}

/**
 * Synchronous read-modify-write (for use in sync contexts like CLI commands).
 * Uses lockfileSync variant.
 */
function withLockSync<T>(fn: (registry: AgentRegistry) => T): T {
  ensureRegistryDir();

  // Ensure the registry file exists
  if (!fs.existsSync(registryPath())) {
    const initial = loadRegistry();
    saveRegistry(initial);
  }

  let release: (() => void) | undefined;
  try {
    release = lockfile.lockSync(registryPath(), LOCK_OPTIONS_SYNC);
    const registry = loadRegistry();
    const result = fn(registry);
    saveRegistry(registry);
    return result;
  } catch (err) {
    if (err instanceof Error && err.message.includes('ELOCKED')) {
      throw new Error(
        'Registry is locked by another process. If no other instar process is running, ' +
        'delete ~/.instar/registry.json.lock and retry.'
      );
    }
    throw err;
  } finally {
    if (release) {
      try { release(); } catch { /* ignore */ }
    }
  }
}

/**
 * Migrate from legacy port-registry.json to the new agent registry.
 */
function migrateFromPortRegistry(): AgentRegistry {
  try {
    const legacyData = JSON.parse(fs.readFileSync(legacyRegistryPath(), 'utf-8'));
    const legacyEntries: Array<{
      projectName: string;
      port: number;
      pid: number;
      projectDir: string;
      registeredAt: string;
      lastHeartbeat: string;
    }> = Array.isArray(legacyData.entries) ? legacyData.entries : [];

    const registry: AgentRegistry = {
      version: 1,
      entries: legacyEntries.map(e => ({
        name: e.projectName,
        type: 'project-bound' as AgentType,
        path: e.projectDir,
        port: e.port,
        pid: e.pid,
        status: 'stopped' as AgentStatus,
        createdAt: e.registeredAt,
        lastHeartbeat: e.lastHeartbeat,
      })),
    };

    saveRegistry(registry);

    // Rename legacy file to mark migration complete
    fs.renameSync(legacyRegistryPath(), legacyRegistryPath() + '.migrated');
    console.log('[AgentRegistry] Migrated from port-registry.json');

    return registry;
  } catch {
    return { version: 1, entries: [] };
  }
}

/**
 * Remove stale entries where the process is no longer running.
 * Returns the cleaned registry (mutates in-place for efficiency).
 */
export function cleanStaleEntries(registry: AgentRegistry): AgentRegistry {
  registry.entries = registry.entries.filter(entry => {
    if (entry.status === 'running' && !isProcessAlive(entry.pid)) {
      console.log(`[AgentRegistry] Marking stale: ${entry.name} (port ${entry.port}, pid ${entry.pid} dead)`);
      entry.status = 'stale';
    }
    return true; // Keep all entries — just update status
  });
  return registry;
}

/**
 * Register an agent (add or update by canonical path).
 */
export function registerAgent(
  agentPath: string,
  name: string,
  port: number,
  type: AgentType = 'project-bound',
  pid?: number,
): void {
  withLockSync(registry => {
    cleanStaleEntries(registry);

    const canonicalPath = path.resolve(agentPath);

    // Check for port conflicts with other agents
    const conflict = registry.entries.find(e => e.port === port && e.path !== canonicalPath);
    if (conflict) {
      throw new Error(
        `Port ${port} is already in use by "${conflict.name}" (pid ${conflict.pid}). ` +
        `Change the port in .instar/config.json or use a different port.`
      );
    }

    // Find existing entry by canonical path
    const existingIdx = registry.entries.findIndex(e => e.path === canonicalPath);
    const now = new Date().toISOString();

    if (existingIdx >= 0) {
      // Update existing
      const existing = registry.entries[existingIdx];
      existing.name = name;
      existing.port = port;
      existing.pid = pid ?? process.pid;
      existing.status = 'running';
      existing.lastHeartbeat = now;
      existing.type = type;
      existing.instarVersion = getInstarVersion();
    } else {
      // New entry
      registry.entries.push({
        name,
        type,
        path: canonicalPath,
        port,
        pid: pid ?? process.pid,
        status: 'running',
        createdAt: now,
        lastHeartbeat: now,
        instarVersion: getInstarVersion(),
      });
    }
  });
}

/**
 * Unregister an agent by its canonical path.
 */
export function unregisterAgent(agentPath: string): void {
  const canonicalPath = path.resolve(agentPath);
  withLockSync(registry => {
    registry.entries = registry.entries.filter(e => e.path !== canonicalPath);
  });
}

/**
 * Update an agent's status and optionally its PID.
 */
export function updateStatus(agentPath: string, status: AgentStatus, pid?: number): void {
  const canonicalPath = path.resolve(agentPath);
  withLockSync(registry => {
    const entry = registry.entries.find(e => e.path === canonicalPath);
    if (entry) {
      entry.status = status;
      if (pid !== undefined) entry.pid = pid;
      entry.lastHeartbeat = new Date().toISOString();
    }
  });
}

/**
 * Update the heartbeat for an agent by canonical path.
 */
export function heartbeat(agentPath: string): void {
  const canonicalPath = path.resolve(agentPath);
  withLockSync(registry => {
    const entry = registry.entries.find(e => e.path === canonicalPath);
    if (entry) {
      entry.lastHeartbeat = new Date().toISOString();
      entry.pid = process.pid;
    }
  });
}

/**
 * Start a periodic heartbeat. Returns a cleanup function.
 */
export function startHeartbeat(agentPath: string, intervalMs: number = 60_000): () => void {
  const canonicalPath = path.resolve(agentPath);

  const interval = setInterval(() => {
    try {
      heartbeat(canonicalPath);
    } catch (err) {
      console.error(`[AgentRegistry] Heartbeat failed: ${err}`);
    }
  }, intervalMs);

  // Initial heartbeat
  try { heartbeat(canonicalPath); } catch { /* ignore */ }

  return () => clearInterval(interval);
}

/**
 * List all agents, optionally filtered by type and/or status.
 * Cleans stale entries before returning.
 */
export function listAgents(filter?: {
  type?: AgentType;
  status?: AgentStatus;
}): AgentRegistryEntry[] {
  return withLockSync(registry => {
    cleanStaleEntries(registry);

    let entries = [...registry.entries];
    if (filter?.type) {
      entries = entries.filter(e => e.type === filter.type);
    }
    if (filter?.status) {
      entries = entries.filter(e => e.status === filter.status);
    }
    return entries;
  });
}

/**
 * Get a specific agent by canonical path.
 */
export function getAgent(agentPath: string): AgentRegistryEntry | null {
  const canonicalPath = path.resolve(agentPath);
  const registry = loadRegistry();
  return registry.entries.find(e => e.path === canonicalPath) ?? null;
}

/**
 * Allocate a free port from the range, avoiding conflicts.
 * If the agent already has a port, return that port.
 */
export function allocatePort(
  agentPath: string,
  rangeStart: number = DEFAULT_PORT_RANGE_START,
  rangeEnd: number = DEFAULT_PORT_RANGE_END,
): number {
  const canonicalPath = path.resolve(agentPath);
  return withLockSync(registry => {
    cleanStaleEntries(registry);

    // Check if this agent already has a port
    const existing = registry.entries.find(e => e.path === canonicalPath);
    if (existing) {
      return existing.port;
    }

    // Find the first free port in range
    const usedPorts = new Set(registry.entries.map(e => e.port));
    for (let port = rangeStart; port <= rangeEnd; port++) {
      if (!usedPorts.has(port)) {
        return port;
      }
    }

    throw new Error(
      `No free ports available in range ${rangeStart}-${rangeEnd}. ` +
      `${registry.entries.length} Instar instances are registered.`
    );
  });
}

// ── Backward Compatibility Wrappers ───────────────────────────────
// These functions provide the PortRegistry API using AgentRegistry internals,
// allowing a smooth migration where callers use projectName-based lookups.

/**
 * Register a port for a project (PortRegistry compatibility).
 * Uses projectDir as the canonical path key.
 */
export function registerPort(
  projectName: string,
  port: number,
  projectDir: string,
  pid?: number,
): void {
  registerAgent(projectDir, projectName, port, 'project-bound', pid);
}

/**
 * Unregister a port by project name (PortRegistry compatibility).
 * Looks up the agent by name and removes it.
 */
export function unregisterPort(projectName: string): void {
  withLockSync(registry => {
    registry.entries = registry.entries.filter(e => e.name !== projectName);
  });
}

/**
 * Start a heartbeat by project name (PortRegistry compatibility).
 * Looks up the agent's path by name.
 */
export function startHeartbeatByName(projectName: string, intervalMs: number = 60_000): () => void {
  const registry = loadRegistry();
  const entry = registry.entries.find(e => e.name === projectName);
  if (!entry) {
    // Fall back: just do a name-based heartbeat update
    const interval = setInterval(() => {
      try {
        withLockSync(reg => {
          const e = reg.entries.find(en => en.name === projectName);
          if (e) {
            e.lastHeartbeat = new Date().toISOString();
            e.pid = process.pid;
          }
        });
      } catch (err) {
        console.error(`[AgentRegistry] Heartbeat failed: ${err}`);
      }
    }, intervalMs);
    return () => clearInterval(interval);
  }
  return startHeartbeat(entry.path, intervalMs);
}

/**
 * List all instances (PortRegistry compatibility).
 * Returns entries in the legacy PortEntry-compatible shape.
 */
export function listInstances(): AgentRegistryEntry[] {
  return listAgents();
}

/**
 * Allocate a port by project name (PortRegistry compatibility).
 */
export function allocatePortByName(
  projectName: string,
  rangeStart: number = DEFAULT_PORT_RANGE_START,
  rangeEnd: number = DEFAULT_PORT_RANGE_END,
): number {
  return withLockSync(registry => {
    cleanStaleEntries(registry);

    // Check if this project already has a port
    const existing = registry.entries.find(e => e.name === projectName);
    if (existing) {
      return existing.port;
    }

    // Find the first free port in range
    const usedPorts = new Set(registry.entries.map(e => e.port));
    for (let port = rangeStart; port <= rangeEnd; port++) {
      if (!usedPorts.has(port)) {
        return port;
      }
    }

    throw new Error(
      `No free ports available in range ${rangeStart}-${rangeEnd}. ` +
      `${registry.entries.length} Instar instances are registered.`
    );
  });
}
