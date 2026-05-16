/**
 * Unit tests for StaticCatalogProvider (Phase 5b.5.a).
 *
 * Verifies the curated tables and the lookup contract the
 * FrameworkModelRouter consumes.
 */

import { describe, it, expect } from 'vitest';
import {
  StaticCatalogProvider,
  CATALOG_VERSION,
} from '../../../../src/providers/uxConfirm/StaticCatalogProvider.js';

describe('StaticCatalogProvider', () => {
  describe('currentVersion', () => {
    it('returns the default CATALOG_VERSION', () => {
      const c = new StaticCatalogProvider();
      expect(c.currentVersion()).toBe(CATALOG_VERSION);
    });

    it('respects an explicit version override (for tests)', () => {
      const c = new StaticCatalogProvider({ version: 'v0.42' });
      expect(c.currentVersion()).toBe('v0.42');
    });

    it('returns a date-stamped version string by default', () => {
      const c = new StaticCatalogProvider();
      expect(c.currentVersion()).toMatch(/^\d{4}-\d{2}-\d{2}\.v\d+\.\d+$/);
    });
  });

  describe('defaultFor — curated patterns', () => {
    const c = new StaticCatalogProvider();

    it('routes code-generation to Claude Code + Opus 4.7', () => {
      expect(c.defaultFor('code-generation')).toEqual({
        framework: 'claude-code',
        model: 'opus-4.7',
        confidence: 'MEDIUM',
      });
    });

    it('routes code-refactor-typescript to Claude Code + Opus 4.7', () => {
      const d = c.defaultFor('code-refactor-typescript');
      expect(d.framework).toBe('claude-code');
      expect(d.model).toBe('opus-4.7');
    });

    it('routes web-research to Claude Code + Sonnet 4.6 (per BrowseComp)', () => {
      expect(c.defaultFor('web-research')).toEqual({
        framework: 'claude-code',
        model: 'sonnet-4.6',
        confidence: 'MEDIUM',
      });
    });

    it('routes summarize-meeting-transcript to Haiku 4.5 (cheap-suffices)', () => {
      const d = c.defaultFor('summarize-meeting-transcript');
      expect(d.model).toBe('haiku-4.5');
    });

    it('routes shell-one-liner to Haiku 4.5', () => {
      const d = c.defaultFor('shell-one-liner');
      expect(d.model).toBe('haiku-4.5');
    });

    it('routes agentic-execution to Claude Code + Opus 4.7', () => {
      const d = c.defaultFor('agentic-execution');
      expect(d.framework).toBe('claude-code');
      expect(d.model).toBe('opus-4.7');
    });
  });

  describe('defaultFor — global fallback', () => {
    const c = new StaticCatalogProvider();

    it('returns Claude Code + Opus 4.7 LOW for unknown patterns', () => {
      expect(c.defaultFor('this-pattern-does-not-exist-anywhere')).toEqual({
        framework: 'claude-code',
        model: 'opus-4.7',
        confidence: 'LOW',
      });
    });
  });

  describe('confidenceFor — default-pick precision', () => {
    const c = new StaticCatalogProvider();

    it('returns the catalog default confidence when (pattern, framework, model) matches the documented default', () => {
      // code-generation default is claude-code + opus-4.7 @ MEDIUM
      expect(c.confidenceFor('code-generation', 'claude-code', 'opus-4.7')).toBe('MEDIUM');
    });

    it('returns a different confidence when the default for the pattern has a different cited confidence', () => {
      // code-review default is claude-code + opus-4.7 @ LOW
      expect(c.confidenceFor('code-review', 'claude-code', 'opus-4.7')).toBe('LOW');
    });
  });

  describe('confidenceFor — baseline lookup for non-default tuples', () => {
    const c = new StaticCatalogProvider();

    it('returns the framework|model baseline when the tuple does not match the default', () => {
      // User picked codex-cli + gpt-5.3-codex for a refactor task. The
      // default for refactors is claude-code + opus-4.7, so we look up
      // the (codex-cli, gpt-5.3-codex) baseline.
      expect(c.confidenceFor('code-refactor', 'codex-cli', 'gpt-5.3-codex')).toBe('MEDIUM');
    });

    it('returns PROVISIONAL for translation-proxy-routed combinations', () => {
      // Claude Code + DeepSeek via free-claude-code proxy is supported
      // but unverified beyond Phase 5a research.
      expect(c.confidenceFor('code-generation', 'claude-code', 'deepseek-v4')).toBe('LOW');
      expect(c.confidenceFor('code-generation', 'claude-code', 'qwen-3.6')).toBe('PROVISIONAL');
    });

    it('returns PROVISIONAL for unknown (framework, model) tuples', () => {
      expect(c.confidenceFor('code-generation', 'made-up-framework', 'made-up-model')).toBe('PROVISIONAL');
    });
  });

  describe('knownPatterns', () => {
    it('returns the curated pattern list', () => {
      const c = new StaticCatalogProvider();
      const patterns = c.knownPatterns();
      expect(patterns).toContain('code-generation');
      expect(patterns).toContain('web-research');
      expect(patterns).toContain('summarize-meeting-transcript');
      expect(patterns.length).toBeGreaterThan(15);
    });
  });
});
