#!/usr/bin/env node

/**
 * agent-kit CLI — Bootstrap persistent agent infrastructure into any Claude Code project.
 *
 * Usage:
 *   agent-kit init                    # Initialize agent infrastructure in current project
 *   agent-kit init --dir /path/to/repo
 *   agent-kit add telegram            # Add Telegram messaging adapter
 *   agent-kit add email               # Add email integration
 *   agent-kit add sentry              # Add Sentry error monitoring
 *   agent-kit add quota               # Add quota tracking
 *   agent-kit server start            # Start the persistent agent server
 *   agent-kit server stop             # Stop the server
 *   agent-kit status                  # Show agent infrastructure status
 *   agent-kit user add                # Add a user profile
 *   agent-kit job add                 # Add a job definition
 *   agent-kit job list                # List all jobs
 */

import { Command } from 'commander';
import { initProject } from './commands/init.js';

const program = new Command();

program
  .name('agent-kit')
  .description('Bootstrap persistent agent infrastructure into any Claude Code project')
  .version('0.1.0');

// ── Init ──────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize agent infrastructure in a project')
  .option('-d, --dir <path>', 'Project directory (default: current directory)')
  .option('-n, --name <name>', 'Project name (default: directory name)')
  .option('--port <port>', 'Server port (default: 4040)', parseInt)
  .action(initProject);

// ── Add ───────────────────────────────────────────────────────────

const addCmd = program
  .command('add')
  .description('Add capabilities to the agent');

addCmd
  .command('telegram')
  .description('Add Telegram messaging adapter')
  .option('--token <token>', 'Telegram bot token')
  .option('--chat-id <id>', 'Telegram forum chat ID')
  .action((_opts) => {
    console.log('TODO: Add Telegram adapter');
  });

addCmd
  .command('email')
  .description('Add email integration (Gmail)')
  .action((_opts) => {
    console.log('TODO: Add email integration');
  });

addCmd
  .command('sentry')
  .description('Add Sentry error monitoring')
  .option('--dsn <dsn>', 'Sentry DSN')
  .action((_opts) => {
    console.log('TODO: Add Sentry integration');
  });

addCmd
  .command('quota')
  .description('Add Claude API quota tracking')
  .action((_opts) => {
    console.log('TODO: Add quota tracking');
  });

// ── Server ────────────────────────────────────────────────────────

const serverCmd = program
  .command('server')
  .description('Manage the persistent agent server');

serverCmd
  .command('start')
  .description('Start the agent server')
  .option('--foreground', 'Run in foreground (default: background via tmux)')
  .action((_opts) => {
    console.log('TODO: Start server');
  });

serverCmd
  .command('stop')
  .description('Stop the agent server')
  .action(() => {
    console.log('TODO: Stop server');
  });

// ── Status ────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show agent infrastructure status')
  .action(() => {
    console.log('TODO: Show status');
  });

// ── User ──────────────────────────────────────────────────────────

const userCmd = program
  .command('user')
  .description('Manage users');

userCmd
  .command('add')
  .description('Add a user profile')
  .requiredOption('--id <id>', 'User ID')
  .requiredOption('--name <name>', 'User display name')
  .option('--telegram <topicId>', 'Telegram topic ID')
  .option('--email <email>', 'Email address')
  .option('--permissions <perms>', 'Comma-separated permissions', (v: string) => v.split(','))
  .action((_opts) => {
    console.log('TODO: Add user');
  });

userCmd
  .command('list')
  .description('List all users')
  .action(() => {
    console.log('TODO: List users');
  });

// ── Job ───────────────────────────────────────────────────────────

const jobCmd = program
  .command('job')
  .description('Manage scheduled jobs');

jobCmd
  .command('add')
  .description('Add a job definition')
  .requiredOption('--slug <slug>', 'Job identifier')
  .requiredOption('--name <name>', 'Job display name')
  .requiredOption('--schedule <cron>', 'Cron expression')
  .option('--priority <priority>', 'Priority (critical|high|medium|low)', 'medium')
  .option('--model <model>', 'Model tier (opus|sonnet|haiku)', 'sonnet')
  .action((_opts) => {
    console.log('TODO: Add job');
  });

jobCmd
  .command('list')
  .description('List all jobs')
  .action(() => {
    console.log('TODO: List jobs');
  });

program.parse();
