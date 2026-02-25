/**
 * Unit test — Hook installation for external operation safety.
 *
 * Verifies that `instar init` installs:
 * - external-operation-gate.js hook in .instar/hooks/
 * - MCP matcher in .claude/settings.json PreToolUse hooks
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../../src/commands/init.js';

describe('Hook installation for external operation safety', () => {
  let tmpDir: string;
  let projectDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hook-test-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    const projectName = 'test-hooks-project';
    await initProject({
      name: projectName,
      skipPrereqs: true,
    });
    projectDir = path.join(tmpDir, projectName);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('installs external-operation-gate.js hook', () => {
    const hookPath = path.join(projectDir, '.instar', 'hooks', 'external-operation-gate.js');
    expect(fs.existsSync(hookPath)).toBe(true);

    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('mcp__');
    expect(content).toContain('/operations/evaluate');
    expect(content).toContain('mutability');
    expect(content).toContain('BLOCKED');
  });

  it('hook is executable', () => {
    const hookPath = path.join(projectDir, '.instar', 'hooks', 'external-operation-gate.js');
    const stats = fs.statSync(hookPath);
    // Check execute bit (0o100 for owner)
    expect(stats.mode & 0o100).toBeTruthy();
  });

  it('hook classifies delete operations correctly in its logic', () => {
    const hookPath = path.join(projectDir, '.instar', 'hooks', 'external-operation-gate.js');
    const content = fs.readFileSync(hookPath, 'utf-8');

    // Verify the regex patterns exist for each mutability category
    expect(content).toContain('delete|remove|trash|purge|destroy|drop|clear');
    expect(content).toContain('send|create|post|write|add|insert|new|compose|publish');
    expect(content).toContain('update|modify|edit|patch|rename|move|change|set|toggle|enable|disable');
  });

  it('adds MCP matcher to .claude/settings.json', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();

    // Find MCP matcher
    const preToolUse = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: unknown[] }>;
    const mcpEntry = preToolUse.find(e => e.matcher === 'mcp__.*');
    expect(mcpEntry).toBeDefined();
    expect(mcpEntry!.hooks.length).toBeGreaterThan(0);

    // Check that the hook command is correct
    const hookCommand = (mcpEntry!.hooks[0] as { command: string }).command;
    expect(hookCommand).toContain('external-operation-gate.js');
  });

  it('preserves Bash hooks alongside MCP hooks', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const preToolUse = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: unknown[] }>;

    // Both Bash and MCP matchers should exist
    const bashEntry = preToolUse.find(e => e.matcher === 'Bash');
    const mcpEntry = preToolUse.find(e => e.matcher === 'mcp__.*');
    expect(bashEntry).toBeDefined();
    expect(mcpEntry).toBeDefined();
  });

  it('MCP hook is blocking', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const preToolUse = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ blocking?: boolean }> }>;
    const mcpEntry = preToolUse.find(e => e.matcher === 'mcp__.*');

    expect(mcpEntry!.hooks[0].blocking).toBe(true);
  });

  it('MCP hook has timeout', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const preToolUse = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ timeout?: number }> }>;
    const mcpEntry = preToolUse.find(e => e.matcher === 'mcp__.*');

    expect(mcpEntry!.hooks[0].timeout).toBe(5000);
  });
});
