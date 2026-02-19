/**
 * HTTP API routes — health, status, sessions, jobs, events.
 *
 * Extracted/simplified from Dawn's 2267-line routes.ts.
 * All the observability you need, none of the complexity you don't.
 */

import { Router } from 'express';
import { execSync as execSyncFn } from 'node:child_process';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { AgentKitConfig } from '../core/types.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { RelationshipManager } from '../core/RelationshipManager.js';

interface RouteContext {
  config: AgentKitConfig;
  sessionManager: SessionManager;
  state: StateManager;
  scheduler: JobScheduler | null;
  telegram: TelegramAdapter | null;
  relationships: RelationshipManager | null;
  startTime: Date;
}

export function createRoutes(ctx: RouteContext): Router {
  const router = Router();

  // ── Health ──────────────────────────────────────────────────────

  router.get('/health', (_req, res) => {
    const uptimeMs = Date.now() - ctx.startTime.getTime();
    res.json({
      status: 'ok',
      uptime: uptimeMs,
      uptimeHuman: formatUptime(uptimeMs),
      version: '0.1.0',
      project: ctx.config.projectName,
    });
  });

  // ── Status ──────────────────────────────────────────────────────

  router.get('/status', (_req, res) => {
    const sessions = ctx.sessionManager.listRunningSessions();
    const schedulerStatus = ctx.scheduler?.getStatus() ?? null;

    res.json({
      sessions: {
        running: sessions.length,
        max: ctx.config.sessions.maxSessions,
        list: sessions.map(s => ({ id: s.id, name: s.name, jobSlug: s.jobSlug })),
      },
      scheduler: schedulerStatus,
    });
  });

  // ── Sessions ────────────────────────────────────────────────────

  router.get('/sessions', (req, res) => {
    const status = req.query.status as string | undefined;
    const sessions = status
      ? ctx.state.listSessions({ status: status as any })
      : ctx.state.listSessions();

    res.json(sessions);
  });

  router.get('/sessions/:name/output', (req, res) => {
    const lines = parseInt(req.query.lines as string) || 100;
    const output = ctx.sessionManager.captureOutput(req.params.name, lines);

    if (output === null) {
      res.status(404).json({ error: `Session "${req.params.name}" not found or not running` });
      return;
    }

    res.json({ session: req.params.name, output });
  });

  router.post('/sessions/:name/input', (req, res) => {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Request body must include "text" field' });
      return;
    }

    const success = ctx.sessionManager.sendInput(req.params.name, text);
    if (!success) {
      res.status(404).json({ error: `Session "${req.params.name}" not found or not running` });
      return;
    }

    res.json({ ok: true });
  });

  router.post('/sessions/spawn', (req, res) => {
    const { name, prompt, model, jobSlug } = req.body;

    if (!name || !prompt) {
      res.status(400).json({ error: '"name" and "prompt" are required' });
      return;
    }

    try {
      const session = ctx.sessionManager.spawnSession({ name, prompt, model, jobSlug });
      // spawnSession is async but we want to handle errors,
      // so we use .then/.catch
      session.then(s => res.status(201).json(s)).catch(err => {
        res.status(500).json({ error: err.message });
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/sessions/:id', (req, res) => {
    try {
      const killed = ctx.sessionManager.killSession(req.params.id);
      if (!killed) {
        res.status(404).json({ error: `Session "${req.params.id}" not found` });
        return;
      }
      res.json({ ok: true, killed: req.params.id });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Jobs ────────────────────────────────────────────────────────

  router.get('/jobs', (_req, res) => {
    if (!ctx.scheduler) {
      res.json({ jobs: [], scheduler: null });
      return;
    }

    const jobs = ctx.scheduler.getJobs().map(job => {
      const jobState = ctx.state.getJobState(job.slug);
      return { ...job, state: jobState };
    });

    res.json({ jobs, queue: ctx.scheduler.getQueue() });
  });

  router.post('/jobs/:slug/trigger', (req, res) => {
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    const reason = (req.body?.reason as string) || 'manual';

    try {
      const result = ctx.scheduler.triggerJob(req.params.slug, reason);
      res.json({ slug: req.params.slug, result });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  // ── Telegram ────────────────────────────────────────────────────

  router.post('/telegram/reply/:topicId', async (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const topicId = parseInt(req.params.topicId);
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: '"text" field required' });
      return;
    }

    try {
      await ctx.telegram.sendToTopic(topicId, text);
      res.json({ ok: true, topicId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── tmux Sessions (raw) ─────────────────────────────────────────

  router.get('/sessions/tmux', (_req, res) => {
    try {
      const tmuxPath = ctx.config.sessions.tmuxPath;
      const output = execSyncFn(`${tmuxPath} list-sessions -F '#{session_name}' 2>/dev/null || true`, {
        encoding: 'utf-8',
      }).trim();

      const sessions = output
        ? output.split('\n').filter(Boolean).map((name: string) => ({ name }))
        : [];

      res.json({ sessions });
    } catch {
      res.json({ sessions: [] });
    }
  });

  // ── Relationships ─────────────────────────────────────────────────

  router.get('/relationships', (_req, res) => {
    if (!ctx.relationships) {
      res.json({ relationships: [] });
      return;
    }
    const sortBy = (_req.query.sort as 'significance' | 'recent' | 'name') || 'significance';
    res.json({ relationships: ctx.relationships.getAll(sortBy) });
  });

  // Stale must be before :id to avoid "stale" matching as a param
  router.get('/relationships/stale', (req, res) => {
    if (!ctx.relationships) {
      res.json({ stale: [] });
      return;
    }
    const days = parseInt(req.query.days as string) || 14;
    res.json({ stale: ctx.relationships.getStaleRelationships(days) });
  });

  router.get('/relationships/:id', (req, res) => {
    if (!ctx.relationships) {
      res.status(503).json({ error: 'Relationships not configured' });
      return;
    }
    const record = ctx.relationships.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Relationship not found' });
      return;
    }
    res.json(record);
  });

  router.get('/relationships/:id/context', (req, res) => {
    if (!ctx.relationships) {
      res.status(503).json({ error: 'Relationships not configured' });
      return;
    }
    const context = ctx.relationships.getContextForPerson(req.params.id);
    if (!context) {
      res.status(404).json({ error: 'Relationship not found' });
      return;
    }
    res.json({ context });
  });

  // ── Events ──────────────────────────────────────────────────────

  router.get('/events', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const type = req.query.type as string | undefined;
    const sinceHours = parseInt(req.query.since as string) || 24;

    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    const events = ctx.state.queryEvents({ since, type, limit });

    res.json(events);
  });

  return router;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
