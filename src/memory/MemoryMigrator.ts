/**
 * MemoryMigrator — Ingests knowledge from legacy memory systems into SemanticMemory.
 *
 * Phase 2 of the memory architecture (PROP-memory-architecture.md).
 * Transforms flat files (MEMORY.md, JSON, JSONL) into typed entities
 * with relationships and confidence scores.
 *
 * Supported sources:
 *   - MEMORY.md → fact/pattern entities (confidence 0.7)
 *   - RelationshipManager JSON → person entities + edges
 *   - CanonicalState quick-facts → fact entities (confidence 0.95)
 *   - CanonicalState anti-patterns → lesson entities
 *   - CanonicalState projects → project entities
 *   - DecisionJournal JSONL → decision entities
 *
 * Key design decisions:
 *   - Idempotent: uses sourceKey-based dedup to skip already-migrated items
 *   - Incremental: can be run repeatedly as sources grow
 *   - No mocking in tests: real filesystem, real SQLite
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SemanticMemory } from './SemanticMemory.js';
import type { EntityType } from '../core/types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface MigrationSource {
  source: string;
  entitiesCreated: number;
  entitiesSkipped: number;
  edgesCreated: number;
  errors: string[];
  durationMs: number;
}

export interface MigrationReport extends MigrationSource {}

export interface FullMigrationReport {
  sources: MigrationSource[];
  totalEntitiesCreated: number;
  totalEdgesCreated: number;
  totalErrors: number;
  durationMs: number;
}

export interface MemoryMigratorConfig {
  stateDir: string;
  semanticMemory: SemanticMemory;
}

// ─── Implementation ─────────────────────────────────────────────

export class MemoryMigrator {
  private stateDir: string;
  private memory: SemanticMemory;

  constructor(config: MemoryMigratorConfig) {
    this.stateDir = config.stateDir;
    this.memory = config.semanticMemory;
  }

  // ─── MEMORY.md Migration ────────────────────────────────────────

  /**
   * Parse a MEMORY.md file into SemanticMemory entities.
   * Each H2/H3 section becomes a separate entity.
   * Sections about patterns → 'pattern' type; others → 'fact' type.
   */
  async migrateMemoryMd(filePath: string): Promise<MigrationReport> {
    const start = Date.now();
    const report: MigrationReport = {
      source: 'MEMORY.md',
      entitiesCreated: 0,
      entitiesSkipped: 0,
      edgesCreated: 0,
      errors: [],
      durationMs: 0,
    };

    if (!fs.existsSync(filePath)) {
      report.errors.push(`File not found: ${filePath}`);
      report.durationMs = Date.now() - start;
      return report;
    }

    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) {
      report.durationMs = Date.now() - start;
      return report;
    }

    const sections = this.parseMarkdownSections(content);

    for (const section of sections) {
      if (!section.content.trim()) continue;

      const sourceKey = `memory-md:${section.heading}`;

      // Check for duplicate using search by source
      if (this.entityExistsForSource(sourceKey)) {
        report.entitiesSkipped++;
        continue;
      }

      const type = this.inferEntityType(section.heading, section.content);

      try {
        this.memory.remember({
          type,
          name: section.heading,
          content: section.content.trim(),
          confidence: 0.7, // Not recently verified
          lastVerified: new Date().toISOString(),
          source: sourceKey,
          tags: this.extractTags(section.heading, section.content),
          domain: this.inferDomain(section.heading, section.content),
        });
        report.entitiesCreated++;
      } catch (err) {
        report.errors.push(`Failed to create entity for section "${section.heading}": ${err}`);
      }
    }

    report.durationMs = Date.now() - start;
    return report;
  }

  // ─── Relationship Migration ─────────────────────────────────────

  /**
   * Migrate RelationshipManager JSON files into person entities.
   * Each .json file in {stateDir}/relationships/ becomes a person entity.
   */
  async migrateRelationships(): Promise<MigrationReport> {
    const start = Date.now();
    const report: MigrationReport = {
      source: 'relationships',
      entitiesCreated: 0,
      entitiesSkipped: 0,
      edgesCreated: 0,
      errors: [],
      durationMs: 0,
    };

    const relDir = path.join(this.stateDir, 'relationships');
    if (!fs.existsSync(relDir)) {
      report.durationMs = Date.now() - start;
      return report;
    }

    const files = fs.readdirSync(relDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filePath = path.join(relDir, file);
        const record = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        const sourceKey = `relationship:${record.id || file}`;

        if (this.entityExistsForSource(sourceKey)) {
          report.entitiesSkipped++;
          continue;
        }

        // Build content from relationship fields
        const contentParts: string[] = [];
        if (record.notes) contentParts.push(record.notes);
        if (record.arcSummary) contentParts.push(`Arc: ${record.arcSummary}`);
        if (record.channels?.length) {
          const channelStr = record.channels
            .map((c: { type: string; identifier: string }) => `${c.type}: ${c.identifier}`)
            .join(', ');
          contentParts.push(`Channels: ${channelStr}`);
        }
        if (record.themes?.length) {
          contentParts.push(`Themes: ${record.themes.join(', ')}`);
        }
        contentParts.push(`Interactions: ${record.interactionCount || 0}`);
        if (record.category) contentParts.push(`Category: ${record.category}`);

        const content = contentParts.join('\n') || `Person: ${record.name}`;

        // Map significance (0-10) to confidence (0-1)
        const confidence = Math.min(1.0, Math.max(0.1, (record.significance || 1) / 10));

        this.memory.remember({
          type: 'person',
          name: record.name || 'Unknown',
          content,
          confidence,
          lastVerified: record.lastInteraction || new Date().toISOString(),
          source: sourceKey,
          tags: record.tags || [],
          domain: 'relationships',
        });
        report.entitiesCreated++;
      } catch (err) {
        report.errors.push(`Failed to migrate ${file}: ${err}`);
      }
    }

    report.durationMs = Date.now() - start;
    return report;
  }

  // ─── Canonical State Migration ──────────────────────────────────

  /**
   * Migrate CanonicalState files (quick-facts, anti-patterns, projects)
   * into SemanticMemory entities.
   */
  async migrateCanonicalState(): Promise<MigrationReport> {
    const start = Date.now();
    const report: MigrationReport = {
      source: 'canonical-state',
      entitiesCreated: 0,
      entitiesSkipped: 0,
      edgesCreated: 0,
      errors: [],
      durationMs: 0,
    };

    // Quick facts → fact entities
    this.migrateQuickFacts(report);

    // Anti-patterns → lesson entities
    this.migrateAntiPatterns(report);

    // Projects → project entities
    this.migrateProjects(report);

    report.durationMs = Date.now() - start;
    return report;
  }

  private migrateQuickFacts(report: MigrationReport): void {
    const facts = this.loadJson<Array<{
      question: string;
      answer: string;
      lastVerified: string;
      source: string;
    }>>(path.join(this.stateDir, 'quick-facts.json'), [], report);

    for (const fact of facts) {
      const sourceKey = `quick-fact:${fact.question}`;

      if (this.entityExistsForSource(sourceKey)) {
        report.entitiesSkipped++;
        continue;
      }

      try {
        this.memory.remember({
          type: 'fact',
          name: fact.question,
          content: fact.answer,
          confidence: 0.95, // Quick facts are high-confidence
          lastVerified: fact.lastVerified || new Date().toISOString(),
          source: sourceKey,
          tags: [],
          domain: this.inferDomain(fact.question, fact.answer),
        });
        report.entitiesCreated++;
      } catch (err) {
        report.errors.push(`Failed to migrate quick-fact "${fact.question}": ${err}`);
      }
    }
  }

  private migrateAntiPatterns(report: MigrationReport): void {
    const patterns = this.loadJson<Array<{
      id: string;
      pattern: string;
      consequence: string;
      alternative: string;
      learnedAt: string;
      incident?: string;
    }>>(path.join(this.stateDir, 'anti-patterns.json'), [], report);

    for (const ap of patterns) {
      const sourceKey = `anti-pattern:${ap.id}`;

      if (this.entityExistsForSource(sourceKey)) {
        report.entitiesSkipped++;
        continue;
      }

      const content = [
        `Pattern: ${ap.pattern}`,
        `Consequence: ${ap.consequence}`,
        `Alternative: ${ap.alternative}`,
        ap.incident ? `Incident: ${ap.incident}` : '',
      ].filter(Boolean).join('\n');

      try {
        this.memory.remember({
          type: 'lesson',
          name: ap.pattern,
          content,
          confidence: 0.9, // Lessons from incidents are well-established
          lastVerified: ap.learnedAt || new Date().toISOString(),
          source: sourceKey,
          tags: ['anti-pattern'],
        });
        report.entitiesCreated++;
      } catch (err) {
        report.errors.push(`Failed to migrate anti-pattern "${ap.id}": ${err}`);
      }
    }
  }

  private migrateProjects(report: MigrationReport): void {
    const projects = this.loadJson<Array<{
      name: string;
      dir: string;
      gitRemote?: string;
      type?: string;
      description?: string;
      topicIds?: number[];
      deploymentTargets?: string[];
      lastVerified?: string;
    }>>(path.join(this.stateDir, 'project-registry.json'), [], report);

    for (const proj of projects) {
      const sourceKey = `project:${proj.name}`;

      if (this.entityExistsForSource(sourceKey)) {
        report.entitiesSkipped++;
        continue;
      }

      const contentParts: string[] = [];
      if (proj.description) contentParts.push(proj.description);
      contentParts.push(`Directory: ${proj.dir}`);
      if (proj.gitRemote) contentParts.push(`Git: ${proj.gitRemote}`);
      if (proj.type) contentParts.push(`Type: ${proj.type}`);
      if (proj.topicIds?.length) contentParts.push(`Topics: ${proj.topicIds.join(', ')}`);
      if (proj.deploymentTargets?.length) contentParts.push(`Deploy targets: ${proj.deploymentTargets.join(', ')}`);

      try {
        this.memory.remember({
          type: 'project',
          name: proj.name,
          content: contentParts.join('\n'),
          confidence: 0.9,
          lastVerified: proj.lastVerified || new Date().toISOString(),
          source: sourceKey,
          tags: proj.type ? [proj.type] : [],
          domain: 'projects',
        });
        report.entitiesCreated++;
      } catch (err) {
        report.errors.push(`Failed to migrate project "${proj.name}": ${err}`);
      }
    }
  }

  // ─── Decision Journal Migration ─────────────────────────────────

  /**
   * Migrate DecisionJournal JSONL entries into decision entities.
   */
  async migrateDecisionJournal(): Promise<MigrationReport> {
    const start = Date.now();
    const report: MigrationReport = {
      source: 'decision-journal',
      entitiesCreated: 0,
      entitiesSkipped: 0,
      edgesCreated: 0,
      errors: [],
      durationMs: 0,
    };

    const journalPath = path.join(this.stateDir, 'decision-journal.jsonl');
    if (!fs.existsSync(journalPath)) {
      report.durationMs = Date.now() - start;
      return report;
    }

    const content = fs.readFileSync(journalPath, 'utf-8').trim();
    if (!content) {
      report.durationMs = Date.now() - start;
      return report;
    }

    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      let entry: {
        timestamp: string;
        sessionId: string;
        decision: string;
        alternatives?: string[];
        principle?: string;
        confidence?: number;
        context?: string;
        conflict?: boolean;
        tags?: string[];
        jobSlug?: string;
      };

      try {
        entry = JSON.parse(line);
      } catch {
        // Skip corrupt lines
        continue;
      }

      const sourceKey = `decision:${entry.timestamp}:${entry.sessionId}`;

      if (this.entityExistsForSource(sourceKey)) {
        report.entitiesSkipped++;
        continue;
      }

      const contentParts: string[] = [entry.decision];
      if (entry.alternatives?.length) {
        contentParts.push(`Alternatives considered: ${entry.alternatives.join('; ')}`);
      }
      if (entry.principle) {
        contentParts.push(`Guiding principle: ${entry.principle}`);
      }
      if (entry.context) {
        contentParts.push(`Context: ${entry.context}`);
      }
      if (entry.conflict) {
        contentParts.push('Note: This decision conflicted with an org-level constraint.');
      }

      try {
        this.memory.remember({
          type: 'decision',
          name: entry.decision.length > 80
            ? entry.decision.slice(0, 77) + '...'
            : entry.decision,
          content: contentParts.join('\n'),
          confidence: entry.confidence ?? 0.8,
          lastVerified: entry.timestamp,
          source: sourceKey,
          sourceSession: entry.sessionId,
          tags: entry.tags || [],
          domain: 'decisions',
        });
        report.entitiesCreated++;
      } catch (err) {
        report.errors.push(`Failed to migrate decision from ${entry.timestamp}: ${err}`);
      }
    }

    report.durationMs = Date.now() - start;
    return report;
  }

  // ─── Full Migration ─────────────────────────────────────────────

  /**
   * Run all migration sources. Returns aggregate report.
   */
  async migrateAll(options: {
    memoryMdPath?: string;
  }): Promise<FullMigrationReport> {
    const start = Date.now();
    const sources: MigrationSource[] = [];

    // Run all migrations
    if (options.memoryMdPath) {
      sources.push(await this.migrateMemoryMd(options.memoryMdPath));
    } else {
      // Try default location
      const defaultPath = path.join(path.dirname(this.stateDir), 'MEMORY.md');
      sources.push(await this.migrateMemoryMd(defaultPath));
    }

    sources.push(await this.migrateRelationships());
    sources.push(await this.migrateCanonicalState());
    sources.push(await this.migrateDecisionJournal());

    return {
      sources,
      totalEntitiesCreated: sources.reduce((sum, s) => sum + s.entitiesCreated, 0),
      totalEdgesCreated: sources.reduce((sum, s) => sum + s.edgesCreated, 0),
      totalErrors: sources.reduce((sum, s) => sum + s.errors.length, 0),
      durationMs: Date.now() - start,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────

  /**
   * Check if an entity with this source key already exists.
   * Uses direct SQL lookup on the indexed source column.
   */
  private entityExistsForSource(sourceKey: string): boolean {
    return this.memory.findBySource(sourceKey) !== null;
  }

  /**
   * Parse markdown content into heading + content sections.
   * Extracts H2 and H3 sections (ignoring H1 which is usually the title).
   */
  private parseMarkdownSections(content: string): Array<{ heading: string; content: string }> {
    const sections: Array<{ heading: string; content: string }> = [];
    const lines = content.split('\n');

    let currentHeading: string | null = null;
    let currentContent: string[] = [];

    for (const line of lines) {
      // Match H2, H3, or H4 headings
      const headingMatch = line.match(/^(#{2,4})\s+(.+)/);

      if (headingMatch) {
        // Save previous section
        if (currentHeading && currentContent.length > 0) {
          sections.push({
            heading: currentHeading,
            content: currentContent.join('\n'),
          });
        }
        currentHeading = headingMatch[2].trim();
        currentContent = [];
      } else if (currentHeading) {
        currentContent.push(line);
      }
    }

    // Save last section
    if (currentHeading && currentContent.length > 0) {
      sections.push({
        heading: currentHeading,
        content: currentContent.join('\n'),
      });
    }

    // If no sections found but there's content, create one from the whole file
    if (sections.length === 0 && content.trim()) {
      // Only if there's substantial content (not just a title)
      const nonHeadingContent = content.replace(/^#[^\n]*\n?/gm, '').trim();
      if (nonHeadingContent) {
        sections.push({
          heading: 'General',
          content: nonHeadingContent,
        });
      }
    }

    return sections;
  }

  /**
   * Infer entity type from section heading and content.
   */
  private inferEntityType(heading: string, content: string): EntityType {
    const lower = (heading + ' ' + content).toLowerCase();

    if (/pattern|convention|rule|principle|always|never/.test(lower)) return 'pattern';
    if (/lesson|learned|mistake|avoid|anti-?pattern/.test(lower)) return 'lesson';
    if (/decision|chose|decided|alternative/.test(lower)) return 'decision';
    if (/person|people|team|collaborat|who/.test(lower)) return 'person';
    if (/project|repo|codebase|application/.test(lower)) return 'project';
    if (/tool|library|framework|package|command/.test(lower)) return 'tool';

    return 'fact';
  }

  /**
   * Extract simple tags from heading and content.
   */
  private extractTags(heading: string, content: string): string[] {
    const tags: string[] = [];
    const lower = (heading + ' ' + content).toLowerCase();

    const tagPatterns: [RegExp, string][] = [
      [/deploy|vercel|production|staging/, 'deployment'],
      [/database|postgres|sqlite|prisma|xata/, 'database'],
      [/test|jest|vitest|cypress/, 'testing'],
      [/api|endpoint|route|rest/, 'api'],
      [/security|auth|token|credential/, 'security'],
      [/git|commit|branch|merge/, 'git'],
      [/telegram|slack|email|discord/, 'communication'],
      [/memory|context|knowledge/, 'memory'],
    ];

    for (const [pattern, tag] of tagPatterns) {
      if (pattern.test(lower)) tags.push(tag);
    }

    return tags;
  }

  /**
   * Infer a domain from heading and content.
   */
  private inferDomain(heading: string, content: string): string | undefined {
    const lower = (heading + ' ' + content).toLowerCase();

    if (/deploy|server|host|infra|docker|vercel|port/.test(lower)) return 'infrastructure';
    if (/person|team|collaborat|relationship/.test(lower)) return 'relationships';
    if (/business|revenue|customer|growth/.test(lower)) return 'business';
    if (/develop|code|debug|build|test/.test(lower)) return 'development';

    return undefined;
  }

  /**
   * Safely load a JSON file, returning default on error.
   */
  private loadJson<T>(filePath: string, defaultValue: T, report?: MigrationReport): T {
    try {
      if (!fs.existsSync(filePath)) return defaultValue;
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (err) {
      if (report) {
        report.errors.push(`Failed to parse ${path.basename(filePath)}: ${err}`);
      }
      return defaultValue;
    }
  }
}
