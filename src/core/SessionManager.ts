/**
 * Session Manager — spawn and monitor Claude Code sessions via tmux.
 *
 * This is the core capability that transforms Claude Code from a CLI tool
 * into a persistent agent. Sessions run in tmux, survive terminal disconnects,
 * and can be monitored/reaped by the server.
 */

import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import type { Session, SessionManagerConfig, SessionStatus, ModelTier } from './types.js';
import { StateManager } from './StateManager.js';

export class SessionManager {
  private config: SessionManagerConfig;
  private state: StateManager;

  constructor(config: SessionManagerConfig, state: StateManager) {
    this.config = config;
    this.state = state;
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
    const tmuxCmd = [
      this.config.tmuxPath,
      'new-session',
      '-d',
      '-s', tmuxSession,
      '-c', this.config.projectDir,
      `${this.config.claudePath} ${claudeArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`,
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
