/**
 * Port Registry — shared multi-instance port allocation and discovery.
 *
 * Maintains a machine-wide registry at ~/.instar/port-registry.json so
 * multiple Instar installations can coexist without port conflicts.
 *
 * Features:
 *   - Auto-allocate a free port from a configurable range
 *   - Detect and reclaim stale entries (process no longer running)
 *   - Discover all running Instar instances on this machine
 *   - Atomic file writes to prevent corruption from concurrent access
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REGISTRY_DIR = path.join(os.homedir(), '.instar');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'port-registry.json');
const DEFAULT_PORT_RANGE_START = 4040;
const DEFAULT_PORT_RANGE_END = 4099;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without heartbeat = stale

export interface PortEntry {
  /** Project name (from config.json) */
  projectName: string;
  /** Allocated port */
  port: number;
  /** Process ID of the server */
  pid: number;
  /** Absolute path to the project directory */
  projectDir: string;
  /** When this entry was registered */
  registeredAt: string;
  /** Last heartbeat timestamp (updated periodically) */
  lastHeartbeat: string;
}

export interface PortRegistry {
  entries: PortEntry[];
}

/**
 * Load the port registry from disk.
 * Returns an empty registry if the file doesn't exist.
 */
export function loadPortRegistry(): PortRegistry {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) {
      return { entries: [] };
    }
    const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
    return { entries: Array.isArray(data.entries) ? data.entries : [] };
  } catch {
    return { entries: [] };
  }
}

/**
 * Save the port registry to disk (atomic write).
 */
function savePortRegistry(registry: PortRegistry): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const tmpPath = `${REGISTRY_PATH}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2));
    fs.renameSync(tmpPath, REGISTRY_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Check if a process with the given PID is running.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a port is actually in use by trying to connect to it.
 */
async function isPortInUse(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: controller.signal,
      });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Remove stale entries where the process is no longer running.
 * Returns the cleaned registry.
 */
export function cleanStaleEntries(registry: PortRegistry): PortRegistry {
  const cleaned = registry.entries.filter(entry => {
    if (!isProcessAlive(entry.pid)) {
      console.log(`[PortRegistry] Removing stale entry: ${entry.projectName} (port ${entry.port}, pid ${entry.pid} dead)`);
      return false;
    }
    return true;
  });
  return { entries: cleaned };
}

/**
 * Register a port for a project. Overwrites any existing entry for the same project.
 */
export function registerPort(
  projectName: string,
  port: number,
  projectDir: string,
  pid?: number,
): void {
  let registry = loadPortRegistry();
  registry = cleanStaleEntries(registry);

  // Check for port conflicts with other projects
  const conflict = registry.entries.find(e => e.port === port && e.projectName !== projectName);
  if (conflict) {
    throw new Error(
      `Port ${port} is already in use by "${conflict.projectName}" (pid ${conflict.pid}). ` +
      `Change the port in .instar/config.json or use a different port.`
    );
  }

  // Remove existing entry for this project (will be replaced)
  registry.entries = registry.entries.filter(e => e.projectName !== projectName);

  const now = new Date().toISOString();
  registry.entries.push({
    projectName,
    port,
    pid: pid ?? process.pid,
    projectDir,
    registeredAt: now,
    lastHeartbeat: now,
  });

  savePortRegistry(registry);
}

/**
 * Unregister a project's port entry.
 */
export function unregisterPort(projectName: string): void {
  const registry = loadPortRegistry();
  registry.entries = registry.entries.filter(e => e.projectName !== projectName);
  savePortRegistry(registry);
}

/**
 * Update the heartbeat for a project's entry.
 */
export function heartbeat(projectName: string): void {
  const registry = loadPortRegistry();
  const entry = registry.entries.find(e => e.projectName === projectName);
  if (entry) {
    entry.lastHeartbeat = new Date().toISOString();
    entry.pid = process.pid; // Update PID in case of restart
    savePortRegistry(registry);
  }
}

/**
 * Allocate a free port from the range, avoiding conflicts.
 * Returns the first available port not in use by another instance.
 */
export function allocatePort(
  projectName: string,
  rangeStart: number = DEFAULT_PORT_RANGE_START,
  rangeEnd: number = DEFAULT_PORT_RANGE_END,
): number {
  let registry = loadPortRegistry();
  registry = cleanStaleEntries(registry);

  // Check if this project already has a port
  const existing = registry.entries.find(e => e.projectName === projectName);
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
    `${registry.entries.length} Instar instances are running.`
  );
}

/**
 * List all registered instances (after cleaning stale entries).
 */
export function listInstances(): PortEntry[] {
  let registry = loadPortRegistry();
  registry = cleanStaleEntries(registry);
  savePortRegistry(registry);
  return registry.entries;
}

/**
 * Get a specific project's entry.
 */
export function getEntry(projectName: string): PortEntry | null {
  const registry = loadPortRegistry();
  return registry.entries.find(e => e.projectName === projectName) ?? null;
}

/**
 * Start a periodic heartbeat that updates the registry entry.
 * Returns a cleanup function to stop the interval.
 */
export function startHeartbeat(projectName: string, intervalMs: number = 60_000): () => void {
  const interval = setInterval(() => {
    try {
      heartbeat(projectName);
    } catch (err) {
      console.error(`[PortRegistry] Heartbeat failed: ${err}`);
    }
  }, intervalMs);

  // Initial heartbeat
  try { heartbeat(projectName); } catch { /* ignore */ }

  return () => clearInterval(interval);
}
