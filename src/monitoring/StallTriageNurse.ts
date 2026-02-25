/**
 * StallTriageNurse — LLM-powered session recovery for stalled sessions.
 *
 * Instar version: Uses IntelligenceProvider for LLM calls, EventEmitter for
 * typed events, and StateManager for persistence across restarts.
 *
 * When a message goes unanswered, the nurse:
 * 1. Gathers context (tmux output, session liveness, recent messages)
 * 2. Diagnoses the problem via LLM (IntelligenceProvider or direct API)
 * 3. Executes a treatment action (nudge, interrupt, unstick, restart)
 * 4. Verifies the action worked
 * 5. Escalates if needed (up to maxEscalations)
 */

import { EventEmitter } from 'events';
import type { IntelligenceProvider, IntelligenceOptions } from '../core/types.js';
import type { StateManager } from '../core/StateManager.js';
import type {
  StallTriageConfig,
  TreatmentAction,
  TriageDiagnosis,
  TriageContext,
  TriageResult,
  TriageRecord,
  TriageEvents,
  TriageDeps,
} from './StallTriageNurse.types.js';

// Re-export types for convenience
export type {
  StallTriageConfig,
  TreatmentAction,
  TriageDiagnosis,
  TriageContext,
  TriageResult,
  TriageRecord,
  TriageEvents,
  TriageDeps,
};

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_CONFIG: Required<StallTriageConfig> = {
  enabled: true,
  apiKey: '',
  model: 'claude-sonnet-4-5-20250514',
  maxTokens: 1024,
  apiTimeoutMs: 15000,
  cooldownMs: 180000,
  verifyDelayMs: 10000,
  maxEscalations: 2,
  useIntelligenceProvider: true,
};

const ACTION_ESCALATION_ORDER: TreatmentAction[] = [
  'status_update',
  'nudge',
  'interrupt',
  'unstick',
  'restart',
];

const SYSTEM_PROMPT = `You are a session recovery specialist for Claude Code sessions running in tmux. Your job is to diagnose why a session is not responding to a user's Telegram message and recommend the best recovery action.

You will receive terminal output from the session, the session's liveness status, recent message history, and the pending message that went unanswered.

Diagnose the situation and recommend ONE of these actions:

1. **status_update** — The session is actively working (you see tool calls, output, thinking indicators). It just hasn't replied yet. Tell the user to wait.
   Terminal signatures: spinner characters, "Read", "Write", "Edit", "Bash", "Grep", "Glob" tool names, "thinking", token counts, active output scrolling.

2. **nudge** — The session might be waiting for input or slightly stuck. A newline keystroke could unstick it.
   Terminal signatures: blank prompt, "Press Enter to continue", cursor blinking at end of output, session idle but alive.

3. **interrupt** — The session is stuck in a loop or waiting state. An Escape key should break it out.
   Terminal signatures: repeated patterns, "waiting for", spinning without progress, same output for extended period, permission prompts.

4. **unstick** — The session is running a hung process (build, test, network call). Ctrl+C should kill the stuck process.
   Terminal signatures: long-running command with no output, build/test hanging, curl/fetch timeout, "npm run" with no progress.

5. **restart** — The session is dead, crashed, or so broken that only a full restart will help.
   Terminal signatures: "Session ended", exit codes, error stack traces, empty/no output, "bash" prompt (Claude exited).

Respond with a JSON object (no markdown fences):
{
  "summary": "Brief technical diagnosis of what's happening",
  "action": "status_update|nudge|interrupt|unstick|restart",
  "confidence": "high|medium|low",
  "userMessage": "Friendly message to send to the user explaining what's happening and what you're doing"
}`;

// ─── Class ──────────────────────────────────────────────────

export class StallTriageNurse extends EventEmitter {
  private config: Required<StallTriageConfig>;
  private deps: TriageDeps;
  private state: StateManager | null;
  private intelligence: IntelligenceProvider | null;
  private cooldowns = new Map<number, number>();
  private activeCases = new Map<number, { sessionName: string; startedAt: number }>();
  private history: TriageRecord[] = [];
  private static readonly MAX_HISTORY = 50;
  private static readonly STATE_KEY = 'triage-active';

  constructor(
    deps: TriageDeps,
    opts?: {
      config?: Partial<StallTriageConfig>;
      state?: StateManager;
      intelligence?: IntelligenceProvider;
    },
  ) {
    super();
    this.deps = deps;
    this.state = opts?.state ?? null;
    this.intelligence = opts?.intelligence ?? null;
    this.config = {
      ...DEFAULT_CONFIG,
      ...opts?.config,
      apiKey: opts?.config?.apiKey || process.env.ANTHROPIC_API_KEY || '',
    };

    // Load persisted state
    this.loadState();
  }

  // ─── Typed Event Emitters ─────────────────────────────────

  override emit<K extends keyof TriageEvents>(event: K, data: TriageEvents[K]): boolean {
    return super.emit(event, data);
  }

  override on<K extends keyof TriageEvents>(event: K, listener: (data: TriageEvents[K]) => void): this {
    return super.on(event, listener);
  }

  // ─── Public API ───────────────────────────────────────────

  /**
   * Check if a topic was recently triaged and is in cooldown.
   */
  isInCooldown(topicId: number): boolean {
    const lastTriaged = this.cooldowns.get(topicId);
    if (!lastTriaged) return false;
    return Date.now() - lastTriaged < this.config.cooldownMs;
  }

  /**
   * Get current status for health checks and API.
   */
  getStatus(): { enabled: boolean; activeCases: number; historyCount: number; cooldowns: number } {
    return {
      enabled: this.config.enabled,
      activeCases: this.activeCases.size,
      historyCount: this.history.length,
      cooldowns: this.cooldowns.size,
    };
  }

  /**
   * Get the history of past triage records (capped at MAX_HISTORY).
   */
  getHistory(limit?: number): TriageRecord[] {
    const records = [...this.history];
    return limit ? records.slice(-limit) : records;
  }

  /**
   * Main entry point. Gathers context, diagnoses via LLM, executes treatment,
   * verifies, and escalates if needed.
   */
  async triage(
    topicId: number,
    sessionName: string,
    pendingMessage: string,
    injectedAt: number,
    trigger: 'watchdog' | 'telegram_stall' | 'manual' = 'telegram_stall',
  ): Promise<TriageResult> {
    if (!this.config.enabled) {
      return { resolved: false, actionsTaken: [], diagnosis: null, fallbackReason: 'disabled', trigger };
    }

    // Check cooldown
    if (this.isInCooldown(topicId)) {
      return { resolved: false, actionsTaken: [], diagnosis: null, fallbackReason: 'cooldown_active', trigger };
    }

    // Prevent concurrent triage on same topic
    if (this.activeCases.has(topicId)) {
      return { resolved: false, actionsTaken: [], diagnosis: null, fallbackReason: 'already_triaging', trigger };
    }

    this.activeCases.set(topicId, { sessionName, startedAt: Date.now() });
    this.saveState();
    this.emit('triage:started', { topicId, sessionName, trigger });

    const actionsTaken: TreatmentAction[] = [];
    let lastDiagnosis: TriageDiagnosis | null = null;

    try {
      // Gather context
      const context = this.gatherContext(topicId, sessionName, pendingMessage, injectedAt);

      // Short-circuit: dead/missing session → restart immediately (no LLM needed)
      if (context.sessionStatus === 'missing' || context.sessionStatus === 'dead') {
        const userMessage = `Session "${sessionName}" is ${context.sessionStatus}. Restarting it now...`;
        const diagnosis: TriageDiagnosis = {
          summary: `Session ${context.sessionStatus}`,
          action: 'restart',
          confidence: 'high',
          userMessage,
        };
        await this.executeAction('restart', context, userMessage);
        actionsTaken.push('restart');
        this.deps.clearStallForTopic(topicId);
        this.emit('triage:resolved', { topicId, actionsTaken });

        const result: TriageResult = { resolved: true, actionsTaken, diagnosis, trigger };
        this.recordResult(topicId, sessionName, result);
        return result;
      }

      // Diagnose via LLM
      lastDiagnosis = await this.diagnose(context);
      this.emit('triage:diagnosed', { topicId, diagnosis: lastDiagnosis });
      actionsTaken.push(lastDiagnosis.action);

      // Execute the recommended action
      await this.executeAction(lastDiagnosis.action, context, lastDiagnosis.userMessage);
      this.emit('triage:treated', { topicId, action: lastDiagnosis.action });

      // Verify the action worked
      const recovered = await this.verifyAction(lastDiagnosis.action, context);
      if (recovered) {
        this.deps.clearStallForTopic(topicId);
        this.emit('triage:resolved', { topicId, actionsTaken });
        const result: TriageResult = { resolved: true, actionsTaken, diagnosis: lastDiagnosis, trigger };
        this.recordResult(topicId, sessionName, result);
        return result;
      }

      // Escalation loop
      let currentActionIndex = ACTION_ESCALATION_ORDER.indexOf(lastDiagnosis.action);
      let escalations = 0;

      while (escalations < this.config.maxEscalations && currentActionIndex < ACTION_ESCALATION_ORDER.length - 1) {
        escalations++;
        currentActionIndex++;
        const nextAction = ACTION_ESCALATION_ORDER[currentActionIndex];
        const prevAction = ACTION_ESCALATION_ORDER[currentActionIndex - 1];
        actionsTaken.push(nextAction);

        this.emit('triage:escalated', { topicId, from: prevAction, to: nextAction });
        console.log(`[StallTriageNurse] Escalating from ${prevAction} to ${nextAction} for topic ${topicId}`);

        const escalationMessage = `Previous recovery didn't work. Trying ${nextAction}...`;
        await this.executeAction(nextAction, context, escalationMessage);
        this.emit('triage:treated', { topicId, action: nextAction });

        const escalationRecovered = await this.verifyAction(nextAction, context);
        if (escalationRecovered) {
          this.deps.clearStallForTopic(topicId);
          this.emit('triage:resolved', { topicId, actionsTaken });
          const result: TriageResult = { resolved: true, actionsTaken, diagnosis: lastDiagnosis, trigger };
          this.recordResult(topicId, sessionName, result);
          return result;
        }
      }

      // Exhausted all escalations
      const failReason = 'max_escalations_reached';
      this.emit('triage:failed', { topicId, reason: failReason, actionsTaken });
      const result: TriageResult = {
        resolved: false, actionsTaken, diagnosis: lastDiagnosis,
        fallbackReason: failReason, trigger,
      };
      this.recordResult(topicId, sessionName, result);
      return result;

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[StallTriageNurse] Triage failed for topic ${topicId}:`, err);
      this.emit('triage:failed', { topicId, reason: errMsg, actionsTaken });
      const result: TriageResult = {
        resolved: false, actionsTaken, diagnosis: lastDiagnosis,
        fallbackReason: `error: ${errMsg}`, trigger,
      };
      this.recordResult(topicId, sessionName, result);
      return result;
    } finally {
      this.activeCases.delete(topicId);
      this.saveState();
    }
  }

  // ─── Private Methods ──────────────────────────────────────

  private gatherContext(
    topicId: number,
    sessionName: string,
    pendingMessage: string,
    injectedAt: number,
  ): TriageContext {
    const tmuxOutput = this.deps.captureSessionOutput(sessionName, 50) || '';
    const alive = this.deps.isSessionAlive(sessionName);
    const sessionStatus: TriageContext['sessionStatus'] = alive ? 'alive' : 'missing';

    const rawHistory = this.deps.getTopicHistory(topicId, 10);
    const recentMessages = rawHistory.map(m => ({
      sender: m.fromUser ? 'User' : 'Agent',
      text: m.text.slice(0, 200),
      timestamp: m.timestamp,
    }));

    return {
      sessionName,
      topicId,
      tmuxOutput: tmuxOutput.slice(-3000),
      sessionStatus,
      recentMessages,
      pendingMessage: pendingMessage.slice(0, 100),
      waitMinutes: Math.floor((Date.now() - injectedAt) / 60000),
    };
  }

  private async diagnose(context: TriageContext): Promise<TriageDiagnosis> {
    try {
      const prompt = this.buildDiagnosisPrompt(context);
      let rawResponse: string;

      if (this.config.useIntelligenceProvider && this.intelligence) {
        rawResponse = await this.intelligence.evaluate(prompt, {
          model: 'balanced',
          maxTokens: this.config.maxTokens,
        });
      } else if (this.config.apiKey) {
        rawResponse = await this.callAnthropicApi(prompt);
      } else {
        throw new Error('No intelligence provider or API key configured');
      }

      return this.parseDiagnosis(rawResponse);
    } catch (err) {
      console.warn(`[StallTriageNurse] LLM diagnosis failed, falling back to nudge:`, err);
      return {
        summary: `LLM diagnosis failed: ${err instanceof Error ? err.message : String(err)}`,
        action: 'nudge',
        confidence: 'low',
        userMessage: `Session "${context.sessionName}" isn't responding. Trying to nudge it...`,
      };
    }
  }

  private buildDiagnosisPrompt(context: TriageContext): string {
    const messageHistory = context.recentMessages.length > 0
      ? context.recentMessages.map(m => `[${m.timestamp}] ${m.sender}: ${m.text}`).join('\n')
      : '(no recent messages)';

    return [
      SYSTEM_PROMPT,
      '',
      '--- Current Situation ---',
      `Session: ${context.sessionName}`,
      `Status: ${context.sessionStatus}`,
      `Wait time: ${context.waitMinutes} minutes`,
      `Pending message: "${context.pendingMessage}"`,
      '',
      '--- Recent messages ---',
      messageHistory,
      '',
      '--- Terminal output (last 50 lines) ---',
      context.tmuxOutput || '(empty — no output captured)',
    ].join('\n');
  }

  async callAnthropicApi(prompt: string): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('No Anthropic API key configured');
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(this.config.apiTimeoutMs),
    });

    if (response.status === 429) {
      throw new Error('Rate limited (429)');
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    const textBlock = data?.content?.find((b: any) => b.type === 'text');
    return textBlock?.text || '';
  }

  parseDiagnosis(rawResponse: string): TriageDiagnosis {
    const fallback: TriageDiagnosis = {
      summary: 'Could not parse LLM response',
      action: 'nudge',
      confidence: 'low',
      userMessage: 'Session may be stuck. Trying to nudge it...',
    };

    if (!rawResponse || rawResponse.trim().length === 0) {
      return fallback;
    }

    try {
      let cleaned = rawResponse.trim();
      // Strip markdown code fences if present
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      // Sometimes the response has text before the JSON — find the JSON object
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return fallback;

      const parsed = JSON.parse(jsonMatch[0]);

      const validActions: TreatmentAction[] = ['status_update', 'nudge', 'interrupt', 'unstick', 'restart'];
      const validConfidences = ['high', 'medium', 'low'];

      if (!validActions.includes(parsed.action)) {
        return { ...fallback, summary: `Invalid action: ${parsed.action}` };
      }

      return {
        summary: String(parsed.summary || fallback.summary),
        action: parsed.action as TreatmentAction,
        confidence: validConfidences.includes(parsed.confidence) ? parsed.confidence : 'low',
        userMessage: String(parsed.userMessage || fallback.userMessage),
      };
    } catch {
      return fallback;
    }
  }

  private async executeAction(
    action: TreatmentAction,
    context: TriageContext,
    userMessage: string,
  ): Promise<void> {
    console.log(`[StallTriageNurse] Executing ${action} for session "${context.sessionName}" (topic ${context.topicId})`);

    switch (action) {
      case 'status_update':
        await this.deps.sendToTopic(context.topicId, userMessage).catch(err => {
          console.warn(`[StallTriageNurse] sendToTopic failed:`, err);
        });
        break;

      case 'nudge':
        this.deps.sendInput(context.sessionName, '');  // sendInput adds Enter
        await this.deps.sendToTopic(context.topicId, userMessage).catch(err => {
          console.warn(`[StallTriageNurse] sendToTopic failed:`, err);
        });
        break;

      case 'interrupt':
        this.deps.sendKey(context.sessionName, 'Escape');
        await this.deps.sendToTopic(context.topicId, userMessage).catch(err => {
          console.warn(`[StallTriageNurse] sendToTopic failed:`, err);
        });
        break;

      case 'unstick':
        this.deps.sendKey(context.sessionName, 'C-c');
        await this.deps.sendToTopic(context.topicId, userMessage).catch(err => {
          console.warn(`[StallTriageNurse] sendToTopic failed:`, err);
        });
        break;

      case 'restart':
        await this.deps.sendToTopic(context.topicId, userMessage).catch(err => {
          console.warn(`[StallTriageNurse] sendToTopic failed:`, err);
        });
        await this.deps.respawnSession(context.sessionName, context.topicId);
        break;
    }
  }

  async verifyAction(action: TreatmentAction, context: TriageContext): Promise<boolean> {
    if (action === 'status_update') {
      return true;
    }

    await this.delay(this.config.verifyDelayMs);

    if (action === 'restart') {
      return this.deps.isSessionAlive(context.sessionName);
    }

    // For nudge/interrupt/unstick: check if tmux output changed
    const newOutput = this.deps.captureSessionOutput(context.sessionName, 50);
    return newOutput !== null && newOutput !== context.tmuxOutput;
  }

  // ─── State Persistence ────────────────────────────────────

  private loadState(): void {
    if (!this.state) return;
    try {
      const saved = this.state.get<TriageRecord[]>(StallTriageNurse.STATE_KEY);
      if (Array.isArray(saved)) {
        this.history = saved.slice(-StallTriageNurse.MAX_HISTORY);
      }
    } catch {
      // State not available yet — no problem
    }
  }

  private saveState(): void {
    if (!this.state) return;
    try {
      this.state.set(StallTriageNurse.STATE_KEY, this.history);
    } catch {
      // Non-critical
    }
  }

  private recordResult(topicId: number, sessionName: string, result: TriageResult): void {
    this.cooldowns.set(topicId, Date.now());

    const record: TriageRecord = {
      topicId,
      sessionName,
      timestamp: new Date().toISOString(),
      result,
    };
    this.history.push(record);
    if (this.history.length > StallTriageNurse.MAX_HISTORY) {
      this.history.shift();
    }

    this.saveState();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
