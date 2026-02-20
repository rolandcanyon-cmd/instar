/**
 * `instar job add|list` — Manage scheduled jobs.
 */

import fs from 'node:fs';
import pc from 'picocolors';
import { loadConfig, ensureStateDir } from '../core/Config.js';
import { loadJobs, validateJob } from '../scheduler/JobLoader.js';
import { StateManager } from '../core/StateManager.js';
import type { JobDefinition, JobPriority, ModelTier } from '../core/types.js';

interface JobAddOptions {
  slug: string;
  name: string;
  schedule: string;
  description?: string;
  priority?: string;
  model?: string;
  type?: string;
  execute?: string;
  enabled?: boolean;
}

export async function addJob(options: JobAddOptions): Promise<void> {
  const config = loadConfig();
  ensureStateDir(config.stateDir);

  const jobsFile = config.scheduler.jobsFile;
  let jobs: JobDefinition[] = [];

  if (fs.existsSync(jobsFile)) {
    jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
  }

  // Check for duplicate slug
  if (jobs.some(j => j.slug === options.slug)) {
    console.log(pc.red(`Job with slug "${options.slug}" already exists.`));
    process.exit(1);
  }

  const newJob: JobDefinition = {
    slug: options.slug,
    name: options.name,
    description: options.description || options.name,
    schedule: options.schedule,
    priority: (options.priority || 'medium') as JobPriority,
    expectedDurationMinutes: 5,
    model: (options.model || 'sonnet') as ModelTier,
    enabled: options.enabled !== false,
    execute: {
      type: (options.type || 'prompt') as 'skill' | 'prompt' | 'script',
      value: options.execute || `Run the ${options.name} job`,
    },
  };

  // Validate before saving
  try {
    validateJob(newJob);
  } catch (err) {
    console.log(pc.red(`Invalid job: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  jobs.push(newJob);
  // Atomic write: unique temp filename prevents concurrent corruption
  const tmpPath = `${jobsFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(jobs, null, 2));
    fs.renameSync(tmpPath, jobsFile);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  console.log(pc.green(`Job "${options.name}" (${options.slug}) added.`));
  console.log(`  Schedule: ${options.schedule}`);
  console.log(`  Priority: ${newJob.priority}`);
  console.log(`  Model:    ${newJob.model}`);
}

export async function listJobs(_options: { dir?: string }): Promise<void> {
  const config = loadConfig();

  let jobs: JobDefinition[];
  try {
    jobs = loadJobs(config.scheduler.jobsFile);
  } catch {
    console.log(pc.dim('No jobs configured.'));
    console.log(`Add one: ${pc.cyan("instar job add --slug health-check --name 'Health Check' --schedule '0 */4 * * *'")}`);
    return;
  }

  if (jobs.length === 0) {
    console.log(pc.dim('No jobs configured.'));
    return;
  }

  const state = new StateManager(config.stateDir);
  const enabled = jobs.filter(j => j.enabled);

  console.log(pc.bold(`Jobs (${enabled.length} enabled / ${jobs.length} total):\n`));

  for (const job of jobs) {
    const icon = job.enabled ? pc.green('●') : pc.dim('○');
    const jobState = state.getJobState(job.slug);
    const lastRun = jobState?.lastRun
      ? new Date(jobState.lastRun).toLocaleString()
      : pc.dim('never');
    const failures = jobState?.consecutiveFailures
      ? pc.red(` (${jobState.consecutiveFailures} failures)`)
      : '';

    console.log(`  ${icon} ${pc.bold(job.slug)} — ${job.name}`);
    console.log(`    Schedule: ${job.schedule} | Priority: ${job.priority} | Model: ${job.model}`);
    console.log(`    Last run: ${lastRun}${failures}`);
    console.log(`    Execute:  ${job.execute.type}:${job.execute.value}`);
  }
}
