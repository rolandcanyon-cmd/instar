/**
 * File-based state management.
 *
 * All state is stored as JSON files — no database dependency.
 * This is intentional: agent infrastructure should be portable
 * and not require running a DB server.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Session, JobState, ActivityEvent } from './types.js';

export class StateManager {
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  // ── Session State ───────────────────────────────────────────────

  getSession(sessionId: string): Session | null {
    const filePath = path.join(this.stateDir, 'state', 'sessions', `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  saveSession(session: Session): void {
    const filePath = path.join(this.stateDir, 'state', 'sessions', `${session.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  }

  listSessions(filter?: { status?: Session['status'] }): Session[] {
    const dir = path.join(this.stateDir, 'state', 'sessions');
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessions: Session[] = files.map(f =>
      JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
    );

    if (filter?.status) {
      return sessions.filter(s => s.status === filter.status);
    }
    return sessions;
  }

  // ── Job State ─────────────────────────────────────────────────

  getJobState(slug: string): JobState | null {
    const filePath = path.join(this.stateDir, 'state', 'jobs', `${slug}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  saveJobState(state: JobState): void {
    const filePath = path.join(this.stateDir, 'state', 'jobs', `${state.slug}.json`);
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  // ── Activity Events ───────────────────────────────────────────

  appendEvent(event: ActivityEvent): void {
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this.stateDir, 'logs', `activity-${date}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
  }

  queryEvents(options: {
    since?: Date;
    type?: string;
    limit?: number;
  }): ActivityEvent[] {
    const logDir = path.join(this.stateDir, 'logs');
    if (!fs.existsSync(logDir)) return [];

    const files = fs.readdirSync(logDir)
      .filter(f => f.startsWith('activity-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();

    const events: ActivityEvent[] = [];
    const limit = options.limit || 100;

    for (const file of files) {
      const lines = fs.readFileSync(path.join(logDir, file), 'utf-8')
        .split('\n')
        .filter(Boolean);

      for (const line of lines.reverse()) {
        const event: ActivityEvent = JSON.parse(line);

        if (options.since && new Date(event.timestamp) < options.since) {
          return events; // Past the time window
        }

        if (options.type && event.type !== options.type) continue;

        events.push(event);
        if (events.length >= limit) return events;
      }
    }

    return events;
  }

  // ── Generic Key-Value Store ───────────────────────────────────

  get<T>(key: string): T | null {
    const filePath = path.join(this.stateDir, 'state', `${key}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  set<T>(key: string, value: T): void {
    const filePath = path.join(this.stateDir, 'state', `${key}.json`);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  }
}
