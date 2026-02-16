/**
 * `agent-kit init` — Initialize agent infrastructure in a project.
 *
 * Creates:
 *   .agent-kit/           — Runtime state directory
 *   .agent-kit/config.json — Agent configuration
 *   .agent-kit/jobs.json  — Job definitions (empty)
 *   .agent-kit/users.json — User profiles (empty)
 *
 * Appends to CLAUDE.md:
 *   Agency principles, anti-patterns, and infrastructure awareness
 */

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { detectTmuxPath, detectClaudePath, ensureStateDir } from '../core/Config.js';
import type { AgentKitConfig } from '../core/types.js';

interface InitOptions {
  dir?: string;
  name?: string;
  port?: number;
}

export async function initProject(options: InitOptions): Promise<void> {
  const projectDir = path.resolve(options.dir || process.cwd());
  const projectName = options.name || path.basename(projectDir);
  const port = options.port || 4040;

  console.log(pc.bold(`\nInitializing agent-kit in: ${pc.cyan(projectDir)}`));
  console.log();

  // Verify prerequisites
  const tmuxPath = detectTmuxPath();
  const claudePath = detectClaudePath();

  if (!tmuxPath) {
    console.log(pc.red('  tmux not found.'));
    console.log('  Install with: brew install tmux (macOS) or apt install tmux (Linux)');
    process.exit(1);
  }
  console.log(pc.green('  tmux found:') + ` ${tmuxPath}`);

  if (!claudePath) {
    console.log(pc.red('  Claude CLI not found.'));
    console.log('  Install from: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }
  console.log(pc.green('  Claude CLI found:') + ` ${claudePath}`);
  console.log();

  // Create state directory
  const stateDir = path.join(projectDir, '.agent-kit');
  ensureStateDir(stateDir);
  console.log(pc.green('  Created:') + ' .agent-kit/');

  // Write config
  const config: Partial<AgentKitConfig> = {
    projectName,
    port,
    sessions: {
      tmuxPath,
      claudePath,
      projectDir,
      maxSessions: 3,
      protectedSessions: [`${projectName}-server`],
      completionPatterns: [
        'has been automatically paused',
        'Session ended',
        'Interrupted by user',
      ],
    },
    scheduler: {
      jobsFile: path.join(stateDir, 'jobs.json'),
      enabled: false,
      maxParallelJobs: 2,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    },
    users: [],
    messaging: [],
    monitoring: {
      quotaTracking: false,
      memoryMonitoring: true,
      healthCheckIntervalMs: 30000,
    },
  };

  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify(config, null, 2)
  );
  console.log(pc.green('  Created:') + ' .agent-kit/config.json');

  // Write empty jobs
  fs.writeFileSync(
    path.join(stateDir, 'jobs.json'),
    JSON.stringify([], null, 2)
  );
  console.log(pc.green('  Created:') + ' .agent-kit/jobs.json');

  // Write empty users
  fs.writeFileSync(
    path.join(stateDir, 'users.json'),
    JSON.stringify([], null, 2)
  );
  console.log(pc.green('  Created:') + ' .agent-kit/users.json');

  // Append to .gitignore
  const gitignorePath = path.join(projectDir, '.gitignore');
  const agentKitIgnores = '\n# Agent Kit runtime state\n.agent-kit/state/\n.agent-kit/logs/\n';
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.agent-kit/')) {
      fs.appendFileSync(gitignorePath, agentKitIgnores);
      console.log(pc.green('  Updated:') + ' .gitignore');
    }
  } else {
    fs.writeFileSync(gitignorePath, agentKitIgnores.trim() + '\n');
    console.log(pc.green('  Created:') + ' .gitignore');
  }

  // Append agency principles to CLAUDE.md if it exists
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    if (!content.includes('## Agent Infrastructure')) {
      fs.appendFileSync(claudeMdPath, getAgencyPrinciples(projectName));
      console.log(pc.green('  Updated:') + ' CLAUDE.md (added agency principles)');
    }
  }

  console.log();
  console.log(pc.bold('Next steps:'));
  console.log(`  1. Review ${pc.cyan('.agent-kit/config.json')} and adjust settings`);
  console.log(`  2. Add users: ${pc.cyan('agent-kit user add --id justin --name Justin')}`);
  console.log(`  3. Add capabilities: ${pc.cyan('agent-kit add telegram')}`);
  console.log(`  4. Start server: ${pc.cyan('agent-kit server start')}`);
  console.log();
}

function getAgencyPrinciples(projectName: string): string {
  return `

## Agent Infrastructure

This project uses [claude-agent-kit](https://github.com/sagemindai/claude-agent-kit) for persistent agent capabilities.

### Runtime
- State directory: \`.agent-kit/\`
- Config: \`.agent-kit/config.json\`
- Jobs: \`.agent-kit/jobs.json\`
- Users: \`.agent-kit/users.json\`
- Server: \`agent-kit server start\` (runs on port in config)

### Agency Principles

**Act, don't ask** — When the next step is obvious and within your capabilities, do it. "Want me to restart the server?" after changing server code is a dressed-up permission request. The answer is always yes.

**Follow through to done** — Implementation isn't done when code compiles. Rebuild, restart, configure, verify, test. Don't present a menu of "next steps" — do them all.

**Research before escalating** — "Needs human" is a last resort. 5 minutes of research usually reveals an existing solution. If no solution exists, build one.

**Autonomy means ownership** — Manage domains, deployments, dashboards, and services directly. The human provides strategic direction and credentials, not button clicks.

### Anti-Patterns to Avoid

- **"I'm just a CLI tool"** — You have persistent infrastructure. Use it.
- **"Needs human action"** — Check your tools first. You probably have what you need.
- **Presenting options instead of acting** — If you know the next steps, they're your job.
- **Asking permission for obvious follow-through** — Rebuild after code changes. Restart after config changes. Test after implementation.
`;
}
