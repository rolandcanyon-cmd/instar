/**
 * DegradationReporter — makes fallback activations LOUD, not silent.
 *
 * When a feature falls back to a secondary path, that's a bug. The fallback
 * keeps the system running, but someone needs to know the primary path failed.
 * Silent fallbacks are almost as bad as silent failures — the user gets a
 * degraded experience and nobody knows about it.
 *
 * This reporter:
 *   1. Logs visibly to console with [DEGRADATION] prefix
 *   2. Queues reports until downstream systems (feedback, telegram) are ready
 *   3. Drains to FeedbackManager (files bug report back to Instar)
 *   4. Sends Telegram alert to agent-attention topic
 *   5. Stores all degradations in a structured file for health checks
 *
 * Usage:
 *   const reporter = DegradationReporter.getInstance();
 *   reporter.report({
 *     feature: 'TopicMemory',
 *     primary: 'SQLite-backed context with summaries',
 *     fallback: 'JSONL-based last 20 messages',
 *     reason: 'better-sqlite3 failed to load',
 *     impact: 'Sessions start without conversation summaries',
 *   });
 *
 * Born from the insight: "Fallbacks should only and always be associated
 * with a bug report back to Instar." — Justin, 2026-02-25
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface DegradationEvent {
  /** Which feature degraded */
  feature: string;
  /** What the primary path does */
  primary: string;
  /** What the fallback does (the degraded path) */
  fallback: string;
  /** Why the primary path failed */
  reason: string;
  /** User-facing impact of the degradation */
  impact: string;
  /** When the degradation was detected */
  timestamp: string;
  /** Whether this was reported to the feedback system */
  reported: boolean;
  /** Whether this was sent as a Telegram alert */
  alerted: boolean;
}

type TelegramSender = (topicId: number, text: string) => Promise<unknown>;
type FeedbackSubmitter = (item: {
  type: 'bug';
  title: string;
  description: string;
  agentName: string;
  instarVersion: string;
  nodeVersion: string;
  os: string;
  context?: string;
}) => Promise<unknown>;

export class DegradationReporter {
  private static instance: DegradationReporter | null = null;

  private events: DegradationEvent[] = [];
  private stateDir: string | null = null;
  private agentName: string = 'unknown';
  private instarVersion: string = '0.0.0';

  // Downstream systems — connected once the server is fully up
  private feedbackSubmitter: FeedbackSubmitter | null = null;
  private telegramSender: TelegramSender | null = null;
  private alertTopicId: number | null = null;

  private constructor() {}

  static getInstance(): DegradationReporter {
    if (!DegradationReporter.instance) {
      DegradationReporter.instance = new DegradationReporter();
    }
    return DegradationReporter.instance;
  }

  /**
   * Reset singleton for testing.
   */
  static resetForTesting(): void {
    DegradationReporter.instance = null;
  }

  /**
   * Configure with agent identity and storage.
   * Called during server startup before features initialize.
   */
  configure(opts: {
    stateDir: string;
    agentName: string;
    instarVersion: string;
  }): void {
    this.stateDir = opts.stateDir;
    this.agentName = opts.agentName;
    this.instarVersion = opts.instarVersion;
  }

  /**
   * Connect downstream reporting systems.
   * Called once the server is fully started and feedback/telegram are available.
   * Drains any queued events that were reported before downstream was ready.
   */
  connectDownstream(opts: {
    feedbackSubmitter?: FeedbackSubmitter;
    telegramSender?: TelegramSender;
    alertTopicId?: number | null;
  }): void {
    this.feedbackSubmitter = opts.feedbackSubmitter ?? null;
    this.telegramSender = opts.telegramSender ?? null;
    this.alertTopicId = opts.alertTopicId ?? null;

    // Drain queued events that weren't reported yet
    this.drainQueue();
  }

  /**
   * Report a degradation event.
   *
   * This is the primary API. Call this whenever a fallback activates.
   * If downstream systems aren't ready yet, the event is queued.
   */
  report(event: Omit<DegradationEvent, 'timestamp' | 'reported' | 'alerted'>): void {
    const full: DegradationEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      reported: false,
      alerted: false,
    };

    // Always log to console — never silent
    console.warn(
      `[DEGRADATION] ${event.feature}: ${event.reason}\n` +
      `  Primary: ${event.primary}\n` +
      `  Fallback: ${event.fallback}\n` +
      `  Impact: ${event.impact}`
    );

    this.events.push(full);
    this.persistToDisk(full);

    // Try to report immediately if downstream is connected
    this.reportEvent(full);
  }

  /**
   * Get all degradation events (for health check API).
   */
  getEvents(): DegradationEvent[] {
    return [...this.events];
  }

  /**
   * Get unreported events (for monitoring).
   */
  getUnreportedEvents(): DegradationEvent[] {
    return this.events.filter(e => !e.reported);
  }

  /**
   * Check if any degradations have occurred.
   */
  hasDegradations(): boolean {
    return this.events.length > 0;
  }

  // ── Internal ──────────────────────────────────────────────

  private async reportEvent(event: DegradationEvent): Promise<void> {
    // Submit to feedback system
    if (this.feedbackSubmitter && !event.reported) {
      try {
        await this.feedbackSubmitter({
          type: 'bug',
          title: `[DEGRADATION] ${event.feature}: ${event.reason}`,
          description: [
            `A feature fallback was activated, indicating the primary path is broken.`,
            ``,
            `**Feature**: ${event.feature}`,
            `**Primary path**: ${event.primary}`,
            `**Fallback used**: ${event.fallback}`,
            `**Reason**: ${event.reason}`,
            `**Impact**: ${event.impact}`,
            `**Timestamp**: ${event.timestamp}`,
          ].join('\n'),
          agentName: this.agentName,
          instarVersion: this.instarVersion,
          nodeVersion: process.version,
          os: `${os.platform()} ${os.release()}`,
          context: JSON.stringify({
            feature: event.feature,
            reason: event.reason,
            nodeArch: process.arch,
            nodeVersion: process.version,
          }),
        });
        event.reported = true;
      } catch (err) {
        // @silent-fallback-ok — self-referential (cannot report own failures)
        // Don't fail on reporting failures — the console log is the safety net
        console.error(`[DEGRADATION] Failed to submit feedback: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Send Telegram alert
    if (this.telegramSender && this.alertTopicId && !event.alerted) {
      try {
        await this.telegramSender(
          this.alertTopicId,
          `⚠️ DEGRADATION: ${event.feature}\n\n` +
          `Reason: ${event.reason}\n` +
          `Impact: ${event.impact}\n` +
          `Fallback: ${event.fallback}`,
        );
        event.alerted = true;
      } catch {
        // Don't fail on alerting failures
      }
    }

    // Update persisted state
    this.persistToDisk(event);
  }

  private drainQueue(): void {
    for (const event of this.events) {
      if (!event.reported || !event.alerted) {
        this.reportEvent(event);
      }
    }
  }

  private persistToDisk(event: DegradationEvent): void {
    if (!this.stateDir) return;

    try {
      const filePath = path.join(this.stateDir, 'degradations.json');
      let existing: DegradationEvent[] = [];
      try {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch { /* first write */ }

      // Update or append
      const idx = existing.findIndex(
        e => e.feature === event.feature && e.timestamp === event.timestamp
      );
      if (idx >= 0) {
        existing[idx] = event;
      } else {
        existing.push(event);
      }

      // Keep only last 100 events
      if (existing.length > 100) {
        existing = existing.slice(-100);
      }

      fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
    } catch {
      // Disk persistence is best-effort
    }
  }
}
