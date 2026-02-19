/**
 * Job Loader — read and validate job definitions from a JSON file.
 *
 * Jobs define recurring work the agent should perform:
 * email checks, health probes, content publishing, etc.
 */

import fs from 'node:fs';
import { Cron } from 'croner';
import type { JobDefinition, JobPriority } from '../core/types.js';

const VALID_PRIORITIES: JobPriority[] = ['critical', 'high', 'medium', 'low'];

/**
 * Load and validate job definitions from a JSON file.
 * Throws on invalid structure — fail loud at startup, not at runtime.
 */
export function loadJobs(jobsFile: string): JobDefinition[] {
  if (!fs.existsSync(jobsFile)) {
    throw new Error(`Jobs file not found: ${jobsFile}`);
  }

  const raw = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));

  if (!Array.isArray(raw)) {
    throw new Error(`Jobs file must contain a JSON array, got ${typeof raw}`);
  }

  return raw.map((job: unknown, index: number) => {
    validateJob(job, index);
    return job as JobDefinition;
  });
}

/**
 * Validate a single job definition.
 * Throws with a descriptive message on any issue.
 */
export function validateJob(job: unknown, index?: number): void {
  const prefix = index !== undefined ? `Job[${index}]` : 'Job';

  if (!job || typeof job !== 'object') {
    throw new Error(`${prefix}: must be an object`);
  }

  const j = job as Record<string, unknown>;

  // Required string fields
  for (const field of ['slug', 'name', 'description', 'schedule']) {
    if (typeof j[field] !== 'string' || !(j[field] as string).trim()) {
      throw new Error(`${prefix}: "${field}" is required and must be a non-empty string`);
    }
  }

  // Priority
  if (!VALID_PRIORITIES.includes(j.priority as JobPriority)) {
    throw new Error(
      `${prefix}: "priority" must be one of ${VALID_PRIORITIES.join(', ')}, got "${j.priority}"`
    );
  }

  // Cron expression — try to parse it
  try {
    new Cron(j.schedule as string);
  } catch (err) {
    throw new Error(`${prefix}: invalid cron expression "${j.schedule}": ${err}`);
  }

  // Enabled must be boolean
  if (typeof j.enabled !== 'boolean') {
    throw new Error(`${prefix}: "enabled" must be a boolean`);
  }

  // Execute block
  if (!j.execute || typeof j.execute !== 'object') {
    throw new Error(`${prefix}: "execute" must be an object with type and value`);
  }
  const exec = j.execute as Record<string, unknown>;
  if (!['skill', 'prompt', 'script'].includes(exec.type as string)) {
    throw new Error(`${prefix}: execute.type must be "skill", "prompt", or "script"`);
  }
  if (typeof exec.value !== 'string' || !(exec.value as string).trim()) {
    throw new Error(`${prefix}: execute.value is required`);
  }
}
