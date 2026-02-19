/**
 * Session Manager — spawn and monitor Claude Code sessions via tmux.
 *
 * This is the core capability that transforms Claude Code from a CLI tool
 * into a persistent agent. Sessions run in tmux, survive terminal disconnects,
 * and can be monitored/reaped by the server.
 */

import { execSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Session, SessionManagerConfig, SessionStatus, ModelTier } from './types.js';
import { StateManager } from './StateManager.js';

export interface SessionManagerEvents {
  sessionComplete: [session: Session];
}

export class SessionManager extends EventEmitter {
  private config: SessionManagerConfig;
  private state: StateManager;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: SessionManagerConfig, state: StateManager) {
    super();
    this.config = config;
    this.state = state;
  }

  /**
   * Start polling for completed sessions. Emits 'sessionComplete' when
   * a running session's tmux process disappears.
   */
  startMonitoring(intervalMs: number = 5000): void {
    if (this.monitorInterval) return;

    this.monitorInterval = setInterval(() => {
      const running = this.state.listSessions({ status: 'running' });
      for (const session of running) {
        if (!this.isSessionAlive(session.tmuxSession)) {
          session.status = 'completed';
          session.endedAt = new Date().toISOString();
          this.state.saveSession(session);
          this.emit('sessionComplete', session);
        }
      }
    }, intervalMs);
  }

  /**
   * Stop the monitoring poll.
   */
  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Spawn a new Claude Code session in tmux.
   */
  async spawnSession(options: {
    name: string;
    prompt: string;
    model?: ModelTier;
    jobSlug?: string;
    triggeredBy?: string;
  }): Promise<Session> {
    const runningSessions = this.listRunningSessions();
    if (runningSessions.length >= this.config.maxSessions) {
      throw new Error(
        `Max sessions (${this.config.maxSessions}) reached. ` +
        `Running: ${runningSessions.map(s => s.name).join(', ')}`
      );
    }

    const sessionId = this.generateId();
    const tmuxSession = `${path.basename(this.config.projectDir)}-${options.name}`;

    // Check if tmux session already exists
    if (this.tmuxSessionExists(tmuxSession)) {
      throw new Error(`tmux session "${tmuxSession}" already exists`);
    }

    // Build the claude command
    const claudeArgs = ['--dangerously-skip-permissions'];
    if (options.model) {
      claudeArgs.push('--model', options.model);
    }
    claudeArgs.push('-p', options.prompt);

    // Create tmux session and run claude
    // Unset ANTHROPIC_* env vars so Claude uses OAuth (subscription) not API key
    const cleanEnv = 'unset ANTHROPIC_API_KEY ANTHROPIC_ADMIN_KEY CLAUDECODE;';
    const claudeCmd = `${cleanEnv} ${this.config.claudePath} ${claudeArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;
    const tmuxCmd = [
      this.config.tmuxPath,
      'new-session',
      '-d',
      '-s', tmuxSession,
      '-c', this.config.projectDir,
      `bash -c "${claudeCmd.replace(/"/g, '\\"')}"`,
    ];

    try {
      execSync(tmuxCmd.join(' '), { encoding: 'utf-8' });
    } catch (err) {
      throw new Error(`Failed to create tmux session: ${err}`);
    }

    const session: Session = {
      id: sessionId,
      name: options.name,
      status: 'running',
      jobSlug: options.jobSlug,
      tmuxSession,
      startedAt: new Date().toISOString(),
      triggeredBy: options.triggeredBy,
      model: options.model,
      prompt: options.prompt,
    };

    this.state.saveSession(session);
    return session;
  }

  /**
   * Check if a session is still running by checking tmux.
   */
  isSessionAlive(tmuxSession: string): boolean {
    return this.tmuxSessionExists(tmuxSession);
  }

  /**
   * Kill a session by terminating its tmux session.
   */
  killSession(sessionId: string): boolean {
    const session = this.state.getSession(sessionId);
    if (!session) return false;

    // Don't kill protected sessions
    if (this.config.protectedSessions.includes(session.tmuxSession)) {
      throw new Error(`Cannot kill protected session: ${session.tmuxSession}`);
    }

    try {
      execSync(`${this.config.tmuxPath} kill-session -t '=${session.tmuxSession}'`, {
        encoding: 'utf-8',
      });
    } catch {
      // Session might already be dead
    }

    session.status = 'killed';
    session.endedAt = new Date().toISOString();
    this.state.saveSession(session);
    return true;
  }

  /**
   * Capture the current output of a tmux session.
   */
  captureOutput(tmuxSession: string, lines: number = 100): string | null {
    try {
      // Note: use `=session:` (trailing colon) for pane-level tmux commands
      return execSync(
        `${this.config.tmuxPath} capture-pane -t '=${tmuxSession}:' -p -S -${lines}`,
        { encoding: 'utf-8' }
      );
    } catch {
      return null;
    }
  }

  /**
   * Send input to a running tmux session.
   */
  sendInput(tmuxSession: string, input: string): boolean {
    try {
      // Note: use `=session:` (trailing colon) for pane-level tmux commands
      execSync(
        `${this.config.tmuxPath} send-keys -t '=${tmuxSession}:' ${JSON.stringify(input)} Enter`,
        { encoding: 'utf-8' }
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all sessions that are currently running.
   */
  listRunningSessions(): Session[] {
    const sessions = this.state.listSessions({ status: 'running' });

    // Verify each is actually still alive in tmux
    return sessions.filter(s => {
      const alive = this.isSessionAlive(s.tmuxSession);
      if (!alive) {
        // Mark as completed if tmux session is gone
        s.status = 'completed';
        s.endedAt = new Date().toISOString();
        this.state.saveSession(s);
      }
      return alive;
    });
  }

  /**
   * Detect if a session has completed by checking output patterns.
   */
  detectCompletion(tmuxSession: string): boolean {
    const output = this.captureOutput(tmuxSession, 30);
    if (!output) return false;

    return this.config.completionPatterns.some(pattern =>
      output.includes(pattern)
    );
  }

  /**
   * Reap completed/zombie sessions.
   */
  reapCompletedSessions(): string[] {
    const running = this.state.listSessions({ status: 'running' });
    const reaped: string[] = [];

    for (const session of running) {
      if (this.config.protectedSessions.includes(session.tmuxSession)) continue;

      if (!this.isSessionAlive(session.tmuxSession) || this.detectCompletion(session.tmuxSession)) {
        session.status = 'completed';
        session.endedAt = new Date().toISOString();
        this.state.saveSession(session);
        reaped.push(session.id);

        // Kill the tmux session if it's still hanging around
        if (this.isSessionAlive(session.tmuxSession)) {
          try {
            execSync(`${this.config.tmuxPath} kill-session -t '=${session.tmuxSession}'`);
          } catch { /* ignore */ }
        }
      }
    }

    return reaped;
  }

  /**
   * Spawn an interactive Claude Code session (no -p prompt — opens at the REPL).
   * Used for Telegram-driven conversational sessions.
   * Optionally sends an initial message after Claude is ready.
   */
  async spawnInteractiveSession(initialMessage?: string, name?: string): Promise<string> {
    const sanitized = name
      ? name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
      : null;
    const projectBase = path.basename(this.config.projectDir);
    const tmuxSession = sanitized ? `${projectBase}-${sanitized}` : `${projectBase}-interactive-${Date.now()}`;

    if (this.tmuxSessionExists(tmuxSession)) {
      // Session already exists — just reuse it
      if (initialMessage) {
        this.injectMessage(tmuxSession, initialMessage);
      }
      return tmuxSession;
    }

    // Unset ANTHROPIC_* env vars so Claude uses OAuth (subscription) not API key
    const claudeCmd = `${this.config.claudePath} --dangerously-skip-permissions`;
    const shellCmd = `cd '${this.config.projectDir}' && unset ANTHROPIC_API_KEY ANTHROPIC_ADMIN_KEY CLAUDECODE && ${claudeCmd}`;
    const tmuxCmd = `${this.config.tmuxPath} new-session -d -s '${tmuxSession}' -x 200 -y 50 'bash -c "${shellCmd.replace(/"/g, '\\"')}"'`;

    try {
      execSync(tmuxCmd, { encoding: 'utf-8' });
    } catch (err) {
      throw new Error(`Failed to create interactive tmux session: ${err}`);
    }

    // Track it in state
    const session: Session = {
      id: this.generateId(),
      name: name || tmuxSession,
      status: 'running',
      tmuxSession,
      startedAt: new Date().toISOString(),
      prompt: initialMessage,
    };
    this.state.saveSession(session);

    // Wait for Claude to be ready, then send the initial message
    if (initialMessage) {
      this.waitForClaudeReady(tmuxSession).then((ready) => {
        if (ready) {
          this.injectMessage(tmuxSession, initialMessage);
        } else {
          console.error(`[SessionManager] Claude not ready in session "${tmuxSession}" after timeout`);
        }
      });
    }

    return tmuxSession;
  }

  /**
   * Inject a Telegram message into a tmux session.
   * Short messages go via send-keys; long messages are written to a temp file.
   */
  injectTelegramMessage(tmuxSession: string, topicId: number, text: string): void {
    const FILE_THRESHOLD = 500;
    const taggedText = `[telegram:${topicId}] ${text}`;

    if (taggedText.length <= FILE_THRESHOLD) {
      this.injectMessage(tmuxSession, taggedText);
      return;
    }

    // Write full message to temp file
    const tmpDir = path.join('/tmp', 'agent-kit-telegram');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filename = `msg-${topicId}-${Date.now()}.txt`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, taggedText);

    const ref = `[telegram:${topicId}] [Long message saved to ${filepath} — read it to see the full message]`;
    this.injectMessage(tmuxSession, ref);
  }

  /**
   * Send text to a tmux session via send-keys.
   * Uses -l (literal) flag for text, then sends Enter separately.
   */
  private injectMessage(tmuxSession: string, text: string): void {
    const exactTarget = `=${tmuxSession}:`;
    try {
      // Send the text literally
      execSync(
        `${this.config.tmuxPath} send-keys -t '${exactTarget}' -l ${JSON.stringify(text)}`,
        { encoding: 'utf-8' }
      );
      // Send Enter separately
      execSync(
        `${this.config.tmuxPath} send-keys -t '${exactTarget}' Enter`,
        { encoding: 'utf-8' }
      );
    } catch (err) {
      console.error(`[SessionManager] Failed to inject message into ${tmuxSession}: ${err}`);
    }
  }

  /**
   * Wait for Claude to be ready in a tmux session by polling output.
   */
  private async waitForClaudeReady(tmuxSession: string, timeoutMs: number = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const output = this.captureOutput(tmuxSession, 10);
      if (output && (output.includes('❯') || output.includes('>') || output.includes('$'))) {
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  private tmuxSessionExists(name: string): boolean {
    try {
      execSync(`${this.config.tmuxPath} has-session -t '=${name}' 2>/dev/null`, {
        encoding: 'utf-8',
      });
      return true;
    } catch {
      return false;
    }
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `${timestamp}-${random}`;
  }
}
