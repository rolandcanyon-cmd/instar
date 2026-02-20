/**
 * Tests for the job command module.
 *
 * Verifies atomic writes, duplicate detection, and validation.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Job command (source verification)', () => {
  it('uses atomic write (tmp + rename) for jobs.json', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/commands/job.ts'),
      'utf-8',
    );
    // Should use atomic write with unique temp filenames (pid + random)
    expect(source).toContain('`${jobsFile}.${process.pid}');
    expect(source).toContain('fs.renameSync(tmpPath, jobsFile)');
  });

  it('checks for duplicate slugs before adding', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/commands/job.ts'),
      'utf-8',
    );
    expect(source).toContain('j.slug === options.slug');
    expect(source).toContain('already exists');
  });

  it('validates job before saving', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/commands/job.ts'),
      'utf-8',
    );
    expect(source).toContain('validateJob(newJob)');
  });

  it('sets sensible defaults for optional fields', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/commands/job.ts'),
      'utf-8',
    );
    // Priority defaults to medium
    expect(source).toContain("options.priority || 'medium'");
    // Model defaults to sonnet
    expect(source).toContain("options.model || 'sonnet'");
    // Execute type defaults to prompt
    expect(source).toContain("options.type || 'prompt'");
  });
});
