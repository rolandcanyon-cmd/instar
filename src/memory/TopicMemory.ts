/**
 * TopicMemory — SQLite-backed conversational memory per Telegram topic.
 *
 * Topic history is the HIGHEST priority context for any agent. It represents
 * what the user and agent have been working on — the living relationship.
 * All other context (identity, memory, relationships) supports this primary layer.
 *
 * Architecture:
 *   - Messages: Dual-written to JSONL (append log) AND SQLite (query layer)
 *   - Search: FTS5 full-text search over all messages, filterable by topic
 *   - Summaries: Rolling LLM-generated summaries per topic, updated on session end
 *   - Context: Session-start loads topic summary + recent messages as primary context
 *
 * The JSONL log remains the source of truth for disaster recovery.
 * SQLite is a derived query layer that can be rebuilt from JSONL at any time.
 *
 * Born from the insight: "Topic history represents the highest level of information
 * of what the user and the agent have been working on." — Justin, 2026-02-24
 */

import fs from 'node:fs';
import path from 'node:path';

// Dynamic import for better-sqlite3
type Database = import('better-sqlite3').Database;

export interface TopicMessage {
  messageId: number;
  topicId: number;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
}

export interface TopicSummary {
  topicId: number;
  summary: string;
  messageCountAtSummary: number;
  lastMessageId: number;
  updatedAt: string;
}

export interface TopicMeta {
  topicId: number;
  topicName: string | null;
  messageCount: number;
  lastActivity: string;
  hasSummary: boolean;
}

export interface TopicSearchResult {
  text: string;
  topicId: number;
  fromUser: boolean;
  timestamp: string;
  messageId: number;
  rank: number;
  highlight?: string;
}

export interface TopicContext {
  /** Rolling summary of the full conversation (null if none generated yet) */
  summary: string | null;
  /** Recent messages (most recent N) */
  recentMessages: TopicMessage[];
  /** Total message count for this topic */
  totalMessages: number;
  /** Topic name if known */
  topicName: string | null;
}

const SCHEMA_VERSION = '1';

/**
 * Strip FTS5 special syntax characters from a query.
 */
function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
    .replace(/[*:"^{}().]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class TopicMemory {
  private db: Database | null = null;
  private dbPath: string;
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.dbPath = path.join(stateDir, 'topic-memory.db');
  }

  /**
   * Check if the database is open and ready for queries.
   * Use this to verify TopicMemory is functional before relying on it.
   */
  isReady(): boolean {
    return this.db !== null;
  }

  /**
   * Open the database and create schema if needed.
   */
  async open(): Promise<void> {
    if (this.db) return;

    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new BetterSqlite3(this.dbPath);

    // WAL mode for concurrent reads during writes
    this.db.pragma('journal_mode = WAL');

    this.createSchema();
  }

  /**
   * Close the database cleanly.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Create the schema if it doesn't exist.
   */
  private createSchema(): void {
    if (!this.db) throw new Error('Database not open');

    this.db.exec(`
      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- All messages, indexed by topic
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        topic_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        from_user INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL,
        session_name TEXT,
        UNIQUE(message_id, topic_id)
      );

      -- Indexes for efficient topic queries
      CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_topic_id ON messages(topic_id, message_id);

      -- FTS5 full-text search over messages
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        content='messages',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      -- Triggers to keep FTS5 in sync with messages table
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;

      -- Rolling summaries per topic
      CREATE TABLE IF NOT EXISTS topic_summaries (
        topic_id INTEGER PRIMARY KEY,
        summary TEXT NOT NULL,
        message_count_at_summary INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- Topic metadata
      CREATE TABLE IF NOT EXISTS topic_meta (
        topic_id INTEGER PRIMARY KEY,
        topic_name TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_activity TEXT NOT NULL
      );
    `);

    // Set schema version
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
  }

  // ── Message Operations ──────────────────────────────────────

  /**
   * Insert a message into the database.
   * Idempotent — duplicate messageId+topicId pairs are ignored.
   */
  insertMessage(msg: TopicMessage): void {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (message_id, topic_id, text, from_user, timestamp, session_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(msg.messageId, msg.topicId, msg.text, msg.fromUser ? 1 : 0, msg.timestamp, msg.sessionName);

    // Update topic metadata
    this.db.prepare(`
      INSERT INTO topic_meta (topic_id, message_count, last_activity)
      VALUES (?, 1, ?)
      ON CONFLICT(topic_id) DO UPDATE SET
        message_count = message_count + 1,
        last_activity = excluded.last_activity
    `).run(msg.topicId, msg.timestamp);
  }

  /**
   * Batch-insert messages (for JSONL import).
   */
  insertMessages(messages: TopicMessage[]): number {
    if (!this.db) return 0;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO messages (message_id, topic_id, text, from_user, timestamp, session_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    const tx = this.db.transaction(() => {
      for (const msg of messages) {
        const result = insert.run(msg.messageId, msg.topicId, msg.text, msg.fromUser ? 1 : 0, msg.timestamp, msg.sessionName);
        if (result.changes > 0) count++;
      }
    });
    tx();

    // Rebuild topic_meta from messages after bulk import
    this.rebuildTopicMeta();

    return count;
  }

  /**
   * Get recent messages for a topic.
   */
  getRecentMessages(topicId: number, limit: number = 20): TopicMessage[] {
    if (!this.db) return [];

    return this.db.prepare(`
      SELECT message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser, timestamp, session_name AS sessionName
      FROM messages
      WHERE topic_id = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(topicId, limit).reverse().map((row: any) => ({
      ...row,
      fromUser: !!row.fromUser,
    })) as TopicMessage[];
  }

  /**
   * Get the full context for a topic: summary + recent messages.
   * This is the primary context loader for session spawning.
   */
  getTopicContext(topicId: number, recentLimit: number = 20): TopicContext {
    if (!this.db) return { summary: null, recentMessages: [], totalMessages: 0, topicName: null };

    const summary = this.getTopicSummary(topicId);
    const recentMessages = this.getRecentMessages(topicId, recentLimit);
    const meta = this.getTopicMeta(topicId);

    return {
      summary: summary?.summary ?? null,
      recentMessages,
      totalMessages: meta?.messageCount ?? 0,
      topicName: meta?.topicName ?? null,
    };
  }

  /**
   * Get message count for a topic.
   */
  getMessageCount(topicId: number): number {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE topic_id = ?').get(topicId) as any;
    return row?.count ?? 0;
  }

  // ── Search ──────────────────────────────────────────────────

  /**
   * Full-text search across topic messages.
   * Optionally scoped to a single topic.
   */
  search(query: string, opts?: { topicId?: number; limit?: number }): TopicSearchResult[] {
    if (!this.db) return [];

    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const limit = Math.min(opts?.limit ?? 20, 100);

    let sql: string;
    let params: any[];

    if (opts?.topicId !== undefined) {
      sql = `
        SELECT m.message_id AS messageId, m.topic_id AS topicId, m.text, m.from_user AS fromUser,
               m.timestamp, rank,
               highlight(messages_fts, 0, '<b>', '</b>') AS highlight
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?
          AND m.topic_id = ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [sanitized, opts.topicId, limit];
    } else {
      sql = `
        SELECT m.message_id AS messageId, m.topic_id AS topicId, m.text, m.from_user AS fromUser,
               m.timestamp, rank,
               highlight(messages_fts, 0, '<b>', '</b>') AS highlight
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [sanitized, limit];
    }

    return this.db.prepare(sql).all(...params).map((row: any) => ({
      ...row,
      fromUser: !!row.fromUser,
    })) as TopicSearchResult[];
  }

  // ── Summaries ───────────────────────────────────────────────

  /**
   * Get the rolling summary for a topic.
   */
  getTopicSummary(topicId: number): TopicSummary | null {
    if (!this.db) return null;

    const row = this.db.prepare(`
      SELECT topic_id AS topicId, summary, message_count_at_summary AS messageCountAtSummary,
             last_message_id AS lastMessageId, updated_at AS updatedAt
      FROM topic_summaries
      WHERE topic_id = ?
    `).get(topicId) as TopicSummary | undefined;

    return row ?? null;
  }

  /**
   * Save or update a rolling summary for a topic.
   */
  saveTopicSummary(topicId: number, summary: string, messageCount: number, lastMessageId: number): void {
    if (!this.db) return;

    this.db.prepare(`
      INSERT INTO topic_summaries (topic_id, summary, message_count_at_summary, last_message_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(topic_id) DO UPDATE SET
        summary = excluded.summary,
        message_count_at_summary = excluded.message_count_at_summary,
        last_message_id = excluded.last_message_id,
        updated_at = excluded.updated_at
    `).run(topicId, summary, messageCount, lastMessageId, new Date().toISOString());
  }

  /**
   * Get messages since the last summary for a topic.
   * Used to generate incremental summary updates.
   */
  getMessagesSinceSummary(topicId: number): TopicMessage[] {
    if (!this.db) return [];

    const summary = this.getTopicSummary(topicId);
    const lastMessageId = summary?.lastMessageId ?? -1;

    return this.db.prepare(`
      SELECT message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser, timestamp, session_name AS sessionName
      FROM messages
      WHERE topic_id = ? AND message_id > ?
      ORDER BY timestamp ASC
    `).all(topicId, lastMessageId).map((row: any) => ({
      ...row,
      fromUser: !!row.fromUser,
    })) as TopicMessage[];
  }

  /**
   * Check if a topic needs its summary updated.
   * Returns true if there are more than `threshold` new messages since the last summary.
   */
  needsSummaryUpdate(topicId: number, threshold: number = 20): boolean {
    if (!this.db) return false;

    const summary = this.getTopicSummary(topicId);
    const totalMessages = this.getMessageCount(topicId);

    if (!summary) {
      // No summary yet — need one if there are enough messages
      return totalMessages >= threshold;
    }

    return (totalMessages - summary.messageCountAtSummary) >= threshold;
  }

  // ── Topic Metadata ──────────────────────────────────────────

  /**
   * Get metadata for a topic.
   */
  getTopicMeta(topicId: number): TopicMeta | null {
    if (!this.db) return null;

    const row = this.db.prepare(`
      SELECT topic_id AS topicId, topic_name AS topicName, message_count AS messageCount,
             last_activity AS lastActivity
      FROM topic_meta
      WHERE topic_id = ?
    `).get(topicId) as any;

    if (!row) return null;

    const hasSummary = !!this.db.prepare('SELECT 1 FROM topic_summaries WHERE topic_id = ?').get(topicId);
    return { ...row, hasSummary };
  }

  /**
   * Update topic name in metadata.
   */
  setTopicName(topicId: number, name: string): void {
    if (!this.db) return;

    this.db.prepare(`
      INSERT INTO topic_meta (topic_id, topic_name, message_count, last_activity)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(topic_id) DO UPDATE SET topic_name = excluded.topic_name
    `).run(topicId, name, new Date().toISOString());
  }

  /**
   * List all topics with metadata.
   */
  listTopics(): TopicMeta[] {
    if (!this.db) return [];

    const rows = this.db.prepare(`
      SELECT tm.topic_id AS topicId, tm.topic_name AS topicName,
             tm.message_count AS messageCount, tm.last_activity AS lastActivity,
             CASE WHEN ts.topic_id IS NOT NULL THEN 1 ELSE 0 END AS hasSummary
      FROM topic_meta tm
      LEFT JOIN topic_summaries ts ON ts.topic_id = tm.topic_id
      ORDER BY tm.last_activity DESC
    `).all() as any[];

    return rows.map(r => ({ ...r, hasSummary: !!r.hasSummary }));
  }

  // ── Import / Rebuild ────────────────────────────────────────

  /**
   * Import messages from the JSONL log file.
   * Idempotent — only inserts messages not already in the database.
   * Returns the number of new messages imported.
   */
  importFromJsonl(jsonlPath: string): number {
    if (!this.db) return 0;
    if (!fs.existsSync(jsonlPath)) return 0;

    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    const messages: TopicMessage[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.topicId != null && entry.text) {
          messages.push({
            messageId: entry.messageId,
            topicId: entry.topicId,
            text: entry.text,
            fromUser: entry.fromUser ?? false,
            timestamp: entry.timestamp,
            sessionName: entry.sessionName ?? null,
          });
        }
      } catch { /* @silent-fallback-ok — JSONL parse, skip corrupted */ }
    }

    return this.insertMessages(messages);
  }

  /**
   * Full rebuild — drop all data and reimport from JSONL.
   */
  rebuild(jsonlPath: string): number {
    if (!this.db) return 0;

    this.db.exec('DELETE FROM messages');
    this.db.exec('DELETE FROM topic_meta');
    // Keep summaries — they're LLM-generated and expensive to recreate
    this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);

    return this.importFromJsonl(jsonlPath);
  }

  /**
   * Rebuild topic_meta counts from messages table.
   */
  private rebuildTopicMeta(): void {
    if (!this.db) return;

    this.db.exec(`
      INSERT OR REPLACE INTO topic_meta (topic_id, topic_name, message_count, last_activity)
      SELECT
        topic_id,
        (SELECT topic_name FROM topic_meta WHERE topic_id = m.topic_id),
        COUNT(*),
        MAX(timestamp)
      FROM messages m
      GROUP BY topic_id
    `);
  }

  // ── Stats ───────────────────────────────────────────────────

  /**
   * Get database statistics.
   */
  stats(): {
    totalMessages: number;
    totalTopics: number;
    topicsWithSummaries: number;
    dbSizeBytes: number;
  } {
    if (!this.db) return { totalMessages: 0, totalTopics: 0, topicsWithSummaries: 0, dbSizeBytes: 0 };

    const msgCount = (this.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as any)?.c ?? 0;
    const topicCount = (this.db.prepare('SELECT COUNT(*) AS c FROM topic_meta').get() as any)?.c ?? 0;
    const summaryCount = (this.db.prepare('SELECT COUNT(*) AS c FROM topic_summaries').get() as any)?.c ?? 0;

    let dbSize = 0;
    try {
      dbSize = fs.statSync(this.dbPath).size;
    } catch { /* @silent-fallback-ok — stat returns 0, non-critical */ }

    return {
      totalMessages: msgCount,
      totalTopics: topicCount,
      topicsWithSummaries: summaryCount,
      dbSizeBytes: dbSize,
    };
  }

  /**
   * Format topic context as readable text for session injection.
   * This is the primary interface for loading topic context into a session.
   */
  formatContextForSession(topicId: number, recentLimit: number = 30): string {
    // Return empty string when db is not open — callers use this as a falsy check
    // to trigger JSONL fallback. A non-empty string from a broken db would
    // prevent the fallback and leave the session without conversation history.
    if (!this.db) return '';

    const ctx = this.getTopicContext(topicId, recentLimit);

    // Also return empty if the db is open but has no data for this topic —
    // the JSONL might have messages that weren't imported yet.
    if (ctx.recentMessages.length === 0 && !ctx.summary) return '';

    const lines: string[] = [];

    lines.push(`--- TOPIC CONTEXT (${ctx.totalMessages} total messages) ---`);

    if (ctx.topicName) {
      lines.push(`Topic: ${ctx.topicName}`);
    }

    if (ctx.summary) {
      lines.push('');
      lines.push('CONVERSATION SUMMARY:');
      lines.push(ctx.summary);
    }

    if (ctx.recentMessages.length > 0) {
      lines.push('');
      lines.push(`RECENT MESSAGES (last ${ctx.recentMessages.length}${ctx.summary ? ', since last summary' : ''}):`);
      lines.push('');
      for (const m of ctx.recentMessages) {
        const sender = m.fromUser ? 'User' : 'Agent';
        const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '??:??';
        const text = (m.text || '').slice(0, 500);
        lines.push(`[${ts}] ${sender}: ${text}`);
      }
    }

    lines.push('');
    lines.push('To search conversation history: curl http://localhost:PORT/topic/search?topic=TOPIC_ID&q=QUERY');
    lines.push('--- END TOPIC CONTEXT ---');

    return lines.join('\n');
  }
}
