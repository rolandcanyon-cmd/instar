/**
 * Telegram Messaging Adapter — send/receive messages via Telegram Bot API.
 *
 * Uses long polling to receive messages. Supports forum topics
 * (each user gets a topic thread). Includes topic-session registry
 * and message logging for session respawn with thread history.
 *
 * No external dependencies — uses native fetch for Telegram API calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MessagingAdapter, Message, OutgoingMessage, UserChannel } from '../core/types.js';

interface TelegramConfig {
  /** Bot token from @BotFather */
  token: string;
  /** Forum chat ID (the supergroup where topics live) */
  chatId: string;
  /** Polling interval in ms */
  pollIntervalMs?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number };
    message_thread_id?: number;
    text?: string;
    date: number;
    reply_to_message?: {
      message_id: number;
      forum_topic_created?: { name: string };
    };
  };
}

interface LogEntry {
  messageId: number;
  topicId: number | null;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
}

export class TelegramAdapter implements MessagingAdapter {
  readonly platform = 'telegram';

  private config: TelegramConfig;
  private handler: ((message: Message) => Promise<void>) | null = null;
  private polling = false;
  private pollTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateId = 0;

  // Topic-session registry (persisted to disk)
  private topicToSession: Map<number, string> = new Map();
  private sessionToTopic: Map<string, number> = new Map();
  private topicToName: Map<number, string> = new Map();
  private registryPath: string;
  private messageLogPath: string;

  // Topic message callback — fires on every incoming topic message
  public onTopicMessage: ((message: Message) => void) | null = null;

  constructor(config: TelegramConfig, stateDir: string) {
    this.config = config;
    this.registryPath = path.join(stateDir, 'topic-session-registry.json');
    this.messageLogPath = path.join(stateDir, 'telegram-messages.jsonl');
    this.loadRegistry();
  }

  async start(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    console.log(`[telegram] Starting long-polling...`);
    this.poll();
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    const topicId = message.channel?.identifier;
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text: message.content,
      parse_mode: 'Markdown',
    };

    if (topicId && parseInt(topicId) > 1) {
      params.message_thread_id = parseInt(topicId);
    }

    try {
      await this.apiCall('sendMessage', params);
    } catch {
      // Fallback to plain text on parse errors
      delete params.parse_mode;
      await this.apiCall('sendMessage', params);
    }
  }

  /**
   * Send a message to a specific forum topic.
   */
  async sendToTopic(topicId: number, text: string): Promise<void> {
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text,
    };
    // Topic ID 1 = General topic (our fallback) — omit message_thread_id for General
    if (topicId > 1) {
      params.message_thread_id = topicId;
    }

    try {
      await this.apiCall('sendMessage', { ...params, parse_mode: 'Markdown' });
    } catch {
      await this.apiCall('sendMessage', params);
    }

    // Log outbound messages too
    this.appendToLog({
      messageId: 0,
      topicId,
      text,
      fromUser: false,
      timestamp: new Date().toISOString(),
      sessionName: this.topicToSession.get(topicId) ?? null,
    });
  }

  /**
   * Create a forum topic in the supergroup.
   */
  async createForumTopic(name: string, iconColor?: number): Promise<{ topicId: number; name: string }> {
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      name,
    };
    if (iconColor !== undefined) {
      params.icon_color = iconColor;
    }

    const result = await this.apiCall('createForumTopic', params) as {
      message_thread_id: number;
      name: string;
    };

    this.topicToName.set(result.message_thread_id, name);
    this.saveRegistry();

    console.log(`[telegram] Created forum topic: "${name}" (ID: ${result.message_thread_id})`);
    return { topicId: result.message_thread_id, name: result.name };
  }

  onMessage(handler: (message: Message) => Promise<void>): void {
    this.handler = handler;
  }

  async resolveUser(channelIdentifier: string): Promise<string | null> {
    return null;
  }

  // ── Topic-Session Registry ─────────────────────────────────

  registerTopicSession(topicId: number, sessionName: string): void {
    this.topicToSession.set(topicId, sessionName);
    this.sessionToTopic.set(sessionName, topicId);
    this.saveRegistry();
    console.log(`[telegram] Registered topic ${topicId} <-> session "${sessionName}"`);
  }

  getSessionForTopic(topicId: number): string | null {
    return this.topicToSession.get(topicId) ?? null;
  }

  getTopicForSession(sessionName: string): number | null {
    return this.sessionToTopic.get(sessionName) ?? null;
  }

  getTopicName(topicId: number): string | null {
    return this.topicToName.get(topicId) ?? null;
  }

  // ── Message Log ────────────────────────────────────────────

  /**
   * Get recent messages for a topic (for thread history on respawn).
   */
  getTopicHistory(topicId: number, limit: number = 20): LogEntry[] {
    if (!fs.existsSync(this.messageLogPath)) return [];

    const lines = fs.readFileSync(this.messageLogPath, 'utf-8')
      .split('\n')
      .filter(Boolean);

    const matching: LogEntry[] = [];
    for (const line of lines) {
      try {
        const entry: LogEntry = JSON.parse(line);
        if (entry.topicId === topicId) {
          matching.push(entry);
        }
      } catch { /* skip malformed */ }
    }

    return matching.slice(-limit);
  }

  private appendToLog(entry: LogEntry): void {
    try {
      fs.appendFileSync(this.messageLogPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error(`[telegram] Failed to append to message log: ${err}`);
    }
  }

  // ── Registry Persistence ───────────────────────────────────

  private loadRegistry(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      if (data.topicToSession) {
        for (const [k, v] of Object.entries(data.topicToSession)) {
          this.topicToSession.set(Number(k), v as string);
          this.sessionToTopic.set(v as string, Number(k));
        }
      }
      if (data.topicToName) {
        for (const [k, v] of Object.entries(data.topicToName)) {
          this.topicToName.set(Number(k), v as string);
        }
      }
      console.log(`[telegram] Loaded ${this.topicToSession.size} topic-session mappings from disk`);
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  private saveRegistry(): void {
    try {
      const data = {
        topicToSession: Object.fromEntries(this.topicToSession),
        topicToName: Object.fromEntries(this.topicToName),
      };
      fs.writeFileSync(this.registryPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[telegram] Failed to save registry: ${err}`);
    }
  }

  // ── Polling ────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.polling) return;

    try {
      const updates = await this.getUpdates();
      for (const update of updates) {
        if (update.message?.text) {
          const msg = update.message;
          const text = msg.text!;
          // Use message_thread_id if present; fall back to 1 (General topic) for forum groups
          const numericTopicId = msg.message_thread_id ?? 1;
          const topicId = numericTopicId.toString();

          // Auto-capture topic name from reply_to_message
          if (msg.reply_to_message?.forum_topic_created?.name) {
            if (!this.topicToName.has(numericTopicId)) {
              this.topicToName.set(numericTopicId, msg.reply_to_message.forum_topic_created.name);
              this.saveRegistry();
            }
          }

          const message: Message = {
            id: `tg-${msg.message_id}`,
            userId: msg.from.id.toString(),
            content: text,
            channel: { type: 'telegram', identifier: topicId },
            receivedAt: new Date(msg.date * 1000).toISOString(),
            metadata: {
              telegramUserId: msg.from.id,
              username: msg.from.username,
              firstName: msg.from.first_name,
              messageThreadId: numericTopicId,
            },
          };

          // Log the message
          this.appendToLog({
            messageId: msg.message_id,
            topicId: numericTopicId,
            text,
            fromUser: true,
            timestamp: new Date(msg.date * 1000).toISOString(),
            sessionName: this.topicToSession.get(numericTopicId) ?? null,
          });

          // Fire topic message callback (always fires — General topic falls back to ID 1)
          if (this.onTopicMessage) {
            this.onTopicMessage(message);
          }

          // Fire general handler
          if (this.handler) {
            try {
              await this.handler(message);
            } catch (err) {
              console.error(`[telegram] Handler error: ${err}`);
            }
          }
        }

        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
      }
    } catch (err) {
      console.error(`[telegram] Poll error: ${err}`);
    }

    // Schedule next poll
    const interval = this.config.pollIntervalMs ?? 2000;
    this.pollTimeout = setTimeout(() => this.poll(), interval);
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const result = await this.apiCall('getUpdates', {
      offset: this.lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message'],
    });

    return (result as TelegramUpdate[]) ?? [];
  }

  private async apiCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    const url = `https://api.telegram.org/bot${this.config.token}/${method}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Telegram API error (${response.status}): ${text}`);
    }

    const data = await response.json() as { ok: boolean; result: unknown };
    if (!data.ok) {
      throw new Error(`Telegram API returned not ok: ${JSON.stringify(data)}`);
    }

    return data.result;
  }
}
