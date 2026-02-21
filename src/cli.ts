#!/usr/bin/env node

/**
 * instar CLI — Persistent autonomy infrastructure for AI agents.
 *
 * Usage:
 *   instar init my-project         # Create a new agent project from scratch
 *   instar init                    # Add agent infrastructure to existing project
 *   instar setup                   # Interactive setup wizard
 *   instar server start            # Start the persistent agent server
 *   instar server stop             # Stop the server
 *   instar status                  # Show agent infrastructure status
 *   instar user add                # Add a user profile
 *   instar job add                 # Add a job definition
 *   instar job list                # List all jobs
 *   instar add telegram            # Add Telegram messaging adapter
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { initProject } from './commands/init.js';
import { runSetup } from './commands/setup.js';
import { startServer, stopServer } from './commands/server.js';
import { showStatus } from './commands/status.js';
import { addUser, listUsers } from './commands/user.js';
import { addJob, listJobs } from './commands/job.js';
import pc from 'picocolors';
import { getInstarVersion } from './core/Config.js';
import { listInstances } from './core/PortRegistry.js';

/**
 * Add or update Telegram configuration in the project config.
 */
async function addTelegram(opts: { token?: string; chatId?: string }): Promise<void> {
  const configPath = path.join(process.cwd(), '.instar', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('No .instar/config.json found. Run `instar init` first.'));
    process.exit(1);
  }

  let token = opts.token;
  let chatId = opts.chatId;

  // If not provided via flags, show usage
  if (!token || !chatId) {
    console.log(pc.yellow('Both --token and --chat-id are required.'));
    console.log();
    console.log('Usage:');
    console.log(`  instar add telegram --token YOUR_BOT_TOKEN --chat-id -100YOUR_GROUP_ID`);
    console.log();
    console.log('Get a bot token from @BotFather on Telegram.');
    console.log('Get the chat ID by adding @RawDataBot to your forum group.');
    process.exit(1);
  }

  // Read, update, write config
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    console.log(pc.red('Failed to parse .instar/config.json. Check that it contains valid JSON.'));
    process.exit(1);
  }

  if (!config.messaging) config.messaging = [];

  // Remove existing Telegram config if any
  config.messaging = config.messaging.filter((m: { type: string }) => m.type !== 'telegram');

  config.messaging.push({
    type: 'telegram',
    enabled: true,
    config: {
      token,
      chatId,
      pollIntervalMs: 2000,
    },
  });

  const tmpPath = configPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  console.log(pc.green('Telegram adapter configured successfully!'));
  console.log(`  Bot token: ${token!.slice(0, 8)}...`);
  console.log(`  Chat ID: ${chatId}`);
  console.log();
  console.log(`Restart the server to apply: ${pc.cyan('instar server stop && instar server start')}`);
}

/**
 * Add Sentry error monitoring configuration.
 */
async function addSentry(opts: { dsn?: string }): Promise<void> {
  const configPath = path.join(process.cwd(), '.instar', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('No .instar/config.json found. Run `instar init` first.'));
    process.exit(1);
  }

  if (!opts.dsn) {
    console.log(pc.yellow('The --dsn option is required.'));
    console.log();
    console.log('Usage:');
    console.log(`  instar add sentry --dsn https://examplePublicKey@o0.ingest.sentry.io/0`);
    console.log();
    console.log('Get your DSN from https://sentry.io → Project Settings → Client Keys (DSN)');
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    console.log(pc.red('Failed to parse .instar/config.json. Check that it contains valid JSON.'));
    process.exit(1);
  }

  if (!config.monitoring) {
    config.monitoring = {};
  }

  config.monitoring.sentry = {
    enabled: true,
    dsn: opts.dsn,
  };

  const tmpPath = configPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  console.log(pc.green('Sentry error monitoring configured!'));
  console.log(`  DSN: ${opts.dsn.slice(0, 30)}...`);
  console.log();
  console.log(`Restart the server to apply: ${pc.cyan('instar server stop && instar server start')}`);
}

/**
 * Add email (Gmail) integration configuration.
 */
async function addEmail(opts: { credentialsFile?: string; tokenFile?: string }): Promise<void> {
  const configPath = path.join(process.cwd(), '.instar', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('No .instar/config.json found. Run `instar init` first.'));
    process.exit(1);
  }

  if (!opts.credentialsFile) {
    console.log(pc.yellow('The --credentials-file option is required.'));
    console.log();
    console.log('Usage:');
    console.log(`  instar add email --credentials-file ./credentials.json`);
    console.log();
    console.log('To get credentials:');
    console.log('  1. Go to https://console.cloud.google.com → APIs & Services → Credentials');
    console.log('  2. Create OAuth 2.0 Client ID (Desktop app)');
    console.log('  3. Download the credentials JSON file');
    process.exit(1);
  }

  // Read, update, write config
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    console.log(pc.red('Failed to parse .instar/config.json. Check that it contains valid JSON.'));
    process.exit(1);
  }

  if (!config.messaging) config.messaging = [];

  // Remove existing email config if any
  config.messaging = config.messaging.filter((m: { type: string }) => m.type !== 'email');

  config.messaging.push({
    type: 'email',
    enabled: true,
    config: {
      credentialsFile: opts.credentialsFile,
      tokenFile: opts.tokenFile || path.join(process.cwd(), '.instar', 'gmail-token.json'),
    },
  });

  const tmpPath = configPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  console.log(pc.green('Email (Gmail) integration configured!'));
  console.log(`  Credentials: ${opts.credentialsFile}`);
  console.log(`  Token file: ${opts.tokenFile || '.instar/gmail-token.json'}`);
  console.log();
  console.log(`Restart the server to apply: ${pc.cyan('instar server stop && instar server start')}`);
}

/**
 * Enable quota tracking in the project config.
 */
async function addQuota(opts: { stateFile?: string }): Promise<void> {
  const configPath = path.join(process.cwd(), '.instar', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('No .instar/config.json found. Run `instar init` first.'));
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    console.log(pc.red('Failed to parse .instar/config.json. Check that it contains valid JSON.'));
    process.exit(1);
  }

  if (!config.monitoring) {
    config.monitoring = {};
  }

  config.monitoring.quotaTracking = true;

  if (opts.stateFile) {
    config.monitoring.quotaStateFile = opts.stateFile;
  }

  const tmpPath = configPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  console.log(pc.green('Quota tracking enabled!'));
  console.log();
  if (opts.stateFile) {
    console.log(`  State file: ${opts.stateFile}`);
  }
  console.log('The agent will now track Claude API usage and throttle jobs when usage is high.');
  console.log();
  console.log(`Restart the server to apply: ${pc.cyan('instar server stop && instar server start')}`);
}

const program = new Command();

program
  .name('instar')
  .description('Persistent autonomy infrastructure for AI agents')
  .version(getInstarVersion())
  .option('--classic', 'Use the classic inquirer-based setup wizard instead of Claude')
  .action((opts) => runSetup(opts)); // Default: run interactive setup when no subcommand given

// ── Setup (explicit alias) ────────────────────────────────────────

program
  .command('setup')
  .description('Interactive setup wizard (same as running `instar` with no args)')
  .option('--classic', 'Use the classic inquirer-based setup wizard instead of Claude')
  .action((opts) => runSetup(opts));

// ── Init ─────────────────────────────────────────────────────────

program
  .command('init [project-name]')
  .description('Initialize agent infrastructure (fresh project or existing)')
  .option('-d, --dir <path>', 'Project directory (default: current directory)')
  .option('--port <port>', 'Server port (default: 4040)', (v: string) => parseInt(v, 10))
  .action((projectName, opts) => {
    // If a project name is given, it's a fresh install
    // Otherwise, augment the current directory
    return initProject({ ...opts, name: projectName });
  });

// ── Add ───────────────────────────────────────────────────────────

const addCmd = program
  .command('add')
  .description('Add capabilities to the agent');

addCmd
  .command('telegram')
  .description('Add Telegram messaging adapter')
  .option('--token <token>', 'Telegram bot token (from @BotFather)')
  .option('--chat-id <id>', 'Telegram forum supergroup chat ID')
  .action((opts) => addTelegram(opts));

addCmd
  .command('email')
  .description('Add email integration (Gmail)')
  .option('--credentials-file <path>', 'Path to Google OAuth credentials JSON file')
  .option('--token-file <path>', 'Path to store Gmail auth token')
  .action((opts) => addEmail(opts));

addCmd
  .command('sentry')
  .description('Add Sentry error monitoring')
  .option('--dsn <dsn>', 'Sentry DSN')
  .action((opts) => addSentry(opts));

addCmd
  .command('quota')
  .description('Add Claude API quota tracking')
  .option('--state-file <path>', 'Path to quota state file (default: .instar/state/quota.json)')
  .action((opts) => addQuota(opts));

// ── Feedback ─────────────────────────────────────────────────────

program
  .command('feedback')
  .description('Submit feedback about Instar (bugs, features, improvements)')
  .option('--type <type>', 'Feedback type (bug|feature|improvement|question)', 'other')
  .option('--title <title>', 'Short title')
  .option('--description <desc>', 'Detailed description')
  .option('-d, --dir <path>', 'Project directory')
  .option('--port <port>', 'Server port (default: 4040)', (v: string) => parseInt(v, 10))
  .action(async (opts) => {
    const port = opts.port || 4040;
    const title = opts.title || 'CLI feedback submission';
    const description = opts.description || opts.title || 'No description provided';

    // Load config to get auth token if available
    let authToken: string | undefined;
    try {
      const { loadConfig } = await import('./core/Config.js');
      const config = loadConfig(opts.dir);
      authToken = config.authToken;
    } catch { /* project may not be initialized yet */ }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const response = await fetch(`http://localhost:${port}/feedback`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: opts.type, title, description }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        const result = await response.json() as { id: string; forwarded: boolean };
        console.log(`Feedback submitted: ${result.id}`);
        console.log(`Forwarded upstream: ${result.forwarded ? 'yes' : 'no (will retry later)'}`);
      } else {
        console.error(`Failed to submit feedback: ${response.statusText}`);
        console.error('Is the instar server running? Try: instar server start');
        process.exit(1);
      }
    } catch {
      console.error('Could not connect to instar server. Is it running?');
      console.error('Start it with: instar server start');
      process.exit(1);
    }
  });

// ── Server ────────────────────────────────────────────────────────

const serverCmd = program
  .command('server')
  .description('Manage the persistent agent server');

serverCmd
  .command('start')
  .description('Start the agent server')
  .option('--foreground', 'Run in foreground (default: background via tmux)')
  .option('--no-telegram', 'Skip Telegram polling (use when lifeline manages Telegram)')
  .option('-d, --dir <path>', 'Project directory')
  .action(startServer);

serverCmd
  .command('stop')
  .description('Stop the agent server')
  .option('-d, --dir <path>', 'Project directory')
  .action(stopServer);

// ── Status ────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show agent infrastructure status')
  .option('-d, --dir <path>', 'Project directory')
  .action(showStatus);

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
  .option('--slack <userId>', 'Slack user ID')
  .option('--permissions <perms>', 'Comma-separated permissions', (v: string) => v.split(','))
  .action(addUser);

userCmd
  .command('list')
  .description('List all users')
  .option('-d, --dir <path>', 'Project directory')
  .action(listUsers);

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
  .option('--description <desc>', 'Job description')
  .option('--priority <priority>', 'Priority (critical|high|medium|low)', 'medium')
  .option('--model <model>', 'Model tier (opus|sonnet|haiku)', 'sonnet')
  .option('--type <type>', 'Execution type (skill|prompt|script)', 'prompt')
  .option('--execute <value>', 'Execution value (skill name, prompt text, or script path)')
  .action(addJob);

jobCmd
  .command('list')
  .description('List all jobs')
  .option('-d, --dir <path>', 'Project directory')
  .action(listJobs);

// ── Lifeline ──────────────────────────────────────────────────────

const lifelineCmd = program
  .command('lifeline')
  .description('Manage the Telegram lifeline (persistent Telegram connection)');

lifelineCmd
  .command('start')
  .description('Start the Telegram lifeline (owns Telegram polling, supervises server)')
  .option('-d, --dir <path>', 'Project directory')
  .action(async (opts) => {
    const { TelegramLifeline } = await import('./lifeline/TelegramLifeline.js');
    try {
      const lifeline = new TelegramLifeline(opts.dir);
      await lifeline.start();
    } catch (err) {
      console.error(pc.red(`Failed to start lifeline: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

lifelineCmd
  .command('stop')
  .description('Stop the Telegram lifeline')
  .option('-d, --dir <path>', 'Project directory')
  .action(async (opts) => {
    // The lifeline runs in a tmux session — kill it
    const { loadConfig, detectTmuxPath } = await import('./core/Config.js');
    const config = loadConfig(opts.dir);
    const tmuxPath = detectTmuxPath();
    const sessionName = `${config.projectName}-lifeline`;

    if (!tmuxPath) {
      console.log(pc.red('tmux not found'));
      process.exit(1);
    }

    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync(tmuxPath, ['has-session', '-t', `=${sessionName}`], { stdio: 'ignore' });
      execFileSync(tmuxPath, ['send-keys', '-t', `=${sessionName}:`, 'C-c'], { stdio: 'ignore' });
      // Wait briefly for graceful shutdown
      await new Promise(r => setTimeout(r, 3000));
      try {
        execFileSync(tmuxPath, ['kill-session', '-t', `=${sessionName}`], { stdio: 'ignore' });
      } catch { /* already dead */ }
      console.log(pc.green(`Lifeline stopped (session: ${sessionName})`));
    } catch {
      console.log(pc.yellow(`No lifeline running (no tmux session: ${sessionName})`));
    }
  });

lifelineCmd
  .command('status')
  .description('Check lifeline status')
  .option('-d, --dir <path>', 'Project directory')
  .action(async (opts) => {
    const { loadConfig, detectTmuxPath } = await import('./core/Config.js');
    const config = loadConfig(opts.dir);
    const tmuxPath = detectTmuxPath();
    const sessionName = `${config.projectName}-lifeline`;

    if (!tmuxPath) {
      console.log(pc.red('tmux not found'));
      process.exit(1);
    }

    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync(tmuxPath, ['has-session', '-t', `=${sessionName}`], { stdio: 'ignore' });
      console.log(pc.green(`Lifeline is running (tmux session: ${sessionName})`));
      console.log(`  Attach: tmux attach -t '=${sessionName}'`);
    } catch {
      console.log(pc.yellow('Lifeline is not running'));
      console.log(`  Start: instar lifeline start`);
    }
  });

// ── Instances ─────────────────────────────────────────────────────

program
  .command('instances')
  .description('List all Instar instances running on this machine')
  .action(async () => {
    const instances = listInstances();
    if (instances.length === 0) {
      console.log(pc.dim('No Instar instances registered.'));
      console.log(pc.dim('Start a server with: instar server start'));
      return;
    }

    console.log(pc.bold(`\n  Instar Instances (${instances.length})\n`));
    for (const entry of instances) {
      const age = Math.round((Date.now() - new Date(entry.registeredAt).getTime()) / 60000);
      const heartbeatAge = Math.round((Date.now() - new Date(entry.lastHeartbeat).getTime()) / 60000);
      const alive = heartbeatAge < 3 ? pc.green('●') : pc.yellow('○');
      console.log(`  ${alive} ${pc.bold(entry.projectName)}`);
      console.log(`    Port: ${pc.cyan(String(entry.port))}  PID: ${entry.pid}  Up: ${age}m  Heartbeat: ${heartbeatAge}m ago`);
      console.log(`    Dir:  ${pc.dim(entry.projectDir)}`);
      console.log();
    }
  });

program.parse();
