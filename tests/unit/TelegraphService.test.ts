/**
 * Unit tests for TelegraphService.
 *
 * Tests markdown-to-Node conversion (pure functions, no network),
 * state management, and API interaction via mocked fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TelegraphService,
  markdownToNodes,
  parseInline,
  type TelegraphNode,
  type TelegraphElement,
  type TelegraphConfig,
} from '../../src/publishing/TelegraphService.js';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';

// ── Helpers ────────────────────────────────────────────────────────

function el(node: TelegraphNode): TelegraphElement {
  if (typeof node === 'string') throw new Error(`Expected element, got string: "${node}"`);
  return node;
}

function text(node: TelegraphNode): string {
  if (typeof node !== 'string') throw new Error(`Expected string, got element: ${JSON.stringify(node)}`);
  return node;
}

function findByTag(nodes: TelegraphNode[], tag: string): TelegraphElement | undefined {
  for (const node of nodes) {
    if (typeof node !== 'string' && node.tag === tag) return node;
  }
  return undefined;
}

// ── Markdown to Nodes: Block Elements ──────────────────────────────

describe('markdownToNodes', () => {
  describe('headings', () => {
    it('converts # to h3', () => {
      const nodes = markdownToNodes('# Hello');
      expect(nodes).toHaveLength(1);
      expect(el(nodes[0]).tag).toBe('h3');
      expect(el(nodes[0]).children).toEqual(['Hello']);
    });

    it('converts ## to h3', () => {
      const nodes = markdownToNodes('## Section');
      expect(el(nodes[0]).tag).toBe('h3');
    });

    it('converts ### to h3', () => {
      const nodes = markdownToNodes('### Sub');
      expect(el(nodes[0]).tag).toBe('h3');
    });

    it('converts #### to h4', () => {
      const nodes = markdownToNodes('#### Deep');
      expect(el(nodes[0]).tag).toBe('h4');
      expect(el(nodes[0]).children).toEqual(['Deep']);
    });

    it('converts ##### and ###### to h4', () => {
      expect(el(markdownToNodes('##### Five')[0]).tag).toBe('h4');
      expect(el(markdownToNodes('###### Six')[0]).tag).toBe('h4');
    });

    it('preserves inline formatting in headings', () => {
      const nodes = markdownToNodes('## **Bold** heading');
      const h = el(nodes[0]);
      expect(h.tag).toBe('h3');
      expect(h.children).toHaveLength(2);
      expect(el(h.children![0]).tag).toBe('strong');
      expect(text(h.children![1])).toBe(' heading');
    });
  });

  describe('paragraphs', () => {
    it('wraps text in p tags', () => {
      const nodes = markdownToNodes('Hello world');
      expect(nodes).toHaveLength(1);
      expect(el(nodes[0]).tag).toBe('p');
      expect(el(nodes[0]).children).toEqual(['Hello world']);
    });

    it('joins contiguous lines into one paragraph', () => {
      const nodes = markdownToNodes('Line one\nLine two');
      expect(nodes).toHaveLength(1);
      expect(el(nodes[0]).tag).toBe('p');
    });

    it('splits paragraphs on blank lines', () => {
      const nodes = markdownToNodes('Para one\n\nPara two');
      expect(nodes).toHaveLength(2);
      expect(el(nodes[0]).tag).toBe('p');
      expect(el(nodes[1]).tag).toBe('p');
    });
  });

  describe('code blocks', () => {
    it('converts fenced code blocks to pre>code', () => {
      const md = '```\nconst x = 1;\nconst y = 2;\n```';
      const nodes = markdownToNodes(md);
      expect(nodes).toHaveLength(1);
      const pre = el(nodes[0]);
      expect(pre.tag).toBe('pre');
      const code = el(pre.children![0]);
      expect(code.tag).toBe('code');
      expect(code.children).toEqual(['const x = 1;\nconst y = 2;']);
    });

    it('handles code blocks with language specifier', () => {
      const md = '```typescript\ntype Foo = string;\n```';
      const nodes = markdownToNodes(md);
      const pre = el(nodes[0]);
      expect(pre.tag).toBe('pre');
      const code = el(pre.children![0]);
      expect(code.children).toEqual(['type Foo = string;']);
    });

    it('handles empty code blocks', () => {
      const md = '```\n```';
      const nodes = markdownToNodes(md);
      const pre = el(nodes[0]);
      const code = el(pre.children![0]);
      expect(code.children).toEqual(['']);
    });
  });

  describe('blockquotes', () => {
    it('converts > to blockquote', () => {
      const nodes = markdownToNodes('> This is a quote');
      expect(nodes).toHaveLength(1);
      expect(el(nodes[0]).tag).toBe('blockquote');
    });

    it('joins multi-line blockquotes', () => {
      const md = '> Line one\n> Line two';
      const nodes = markdownToNodes(md);
      expect(nodes).toHaveLength(1);
      expect(el(nodes[0]).tag).toBe('blockquote');
    });

    it('preserves inline formatting in blockquotes', () => {
      const nodes = markdownToNodes('> **bold** quote');
      const bq = el(nodes[0]);
      expect(bq.tag).toBe('blockquote');
      expect(el(bq.children![0]).tag).toBe('strong');
    });
  });

  describe('lists', () => {
    it('converts unordered list with -', () => {
      const md = '- Item one\n- Item two\n- Item three';
      const nodes = markdownToNodes(md);
      expect(nodes).toHaveLength(1);
      const ul = el(nodes[0]);
      expect(ul.tag).toBe('ul');
      expect(ul.children).toHaveLength(3);
      expect(el(ul.children![0]).tag).toBe('li');
    });

    it('converts unordered list with *', () => {
      const md = '* Item one\n* Item two';
      const nodes = markdownToNodes(md);
      const ul = el(nodes[0]);
      expect(ul.tag).toBe('ul');
      expect(ul.children).toHaveLength(2);
    });

    it('converts ordered list', () => {
      const md = '1. First\n2. Second\n3. Third';
      const nodes = markdownToNodes(md);
      expect(nodes).toHaveLength(1);
      const ol = el(nodes[0]);
      expect(ol.tag).toBe('ol');
      expect(ol.children).toHaveLength(3);
      expect(el(ol.children![0]).tag).toBe('li');
    });

    it('preserves inline formatting in list items', () => {
      const md = '- **Bold** item\n- *Italic* item';
      const nodes = markdownToNodes(md);
      const ul = el(nodes[0]);
      const firstLi = el(ul.children![0]);
      expect(el(firstLi.children![0]).tag).toBe('strong');
    });

    it('handles ordered list with ) delimiter', () => {
      const md = '1) First\n2) Second';
      const nodes = markdownToNodes(md);
      const ol = el(nodes[0]);
      expect(ol.tag).toBe('ol');
      expect(ol.children).toHaveLength(2);
    });
  });

  describe('horizontal rules', () => {
    it('converts --- to hr', () => {
      const nodes = markdownToNodes('---');
      expect(nodes).toHaveLength(1);
      expect(el(nodes[0]).tag).toBe('hr');
    });

    it('converts *** to hr', () => {
      const nodes = markdownToNodes('***');
      expect(el(nodes[0]).tag).toBe('hr');
    });

    it('converts ___ to hr', () => {
      const nodes = markdownToNodes('___');
      expect(el(nodes[0]).tag).toBe('hr');
    });
  });

  describe('images', () => {
    it('converts standalone image to figure', () => {
      const nodes = markdownToNodes('![Alt text](https://example.com/img.png)');
      expect(nodes).toHaveLength(1);
      const fig = el(nodes[0]);
      expect(fig.tag).toBe('figure');
      const img = el(fig.children![0]);
      expect(img.tag).toBe('img');
      expect(img.attrs?.src).toBe('https://example.com/img.png');
    });

    it('includes figcaption when alt text is present', () => {
      const nodes = markdownToNodes('![My photo](https://example.com/photo.jpg)');
      const fig = el(nodes[0]);
      expect(fig.children).toHaveLength(2);
      const caption = el(fig.children![1]);
      expect(caption.tag).toBe('figcaption');
      expect(caption.children).toEqual(['My photo']);
    });

    it('omits figcaption when alt text is empty', () => {
      const nodes = markdownToNodes('![](https://example.com/photo.jpg)');
      const fig = el(nodes[0]);
      expect(fig.children).toHaveLength(1);
    });
  });

  describe('mixed content', () => {
    it('handles a full document', () => {
      const md = [
        '# Title',
        '',
        'A paragraph with **bold** and *italic*.',
        '',
        '## Section',
        '',
        '- Item 1',
        '- Item 2',
        '',
        '> A quote',
        '',
        '```',
        'code here',
        '```',
        '',
        '---',
        '',
        'Final paragraph.',
      ].join('\n');

      const nodes = markdownToNodes(md);
      const tags = nodes.map(n => typeof n === 'string' ? 'text' : n.tag);
      expect(tags).toEqual(['h3', 'p', 'h3', 'ul', 'blockquote', 'pre', 'hr', 'p']);
    });

    it('handles empty input', () => {
      expect(markdownToNodes('')).toEqual([]);
    });

    it('handles whitespace-only input', () => {
      expect(markdownToNodes('   \n\n  \n')).toEqual([]);
    });
  });
});

// ── Inline Parsing ─────────────────────────────────────────────────

describe('parseInline', () => {
  it('returns plain text as-is', () => {
    const nodes = parseInline('Hello world');
    expect(nodes).toEqual(['Hello world']);
  });

  it('parses **bold**', () => {
    const nodes = parseInline('**bold**');
    expect(nodes).toHaveLength(1);
    expect(el(nodes[0]).tag).toBe('strong');
    expect(el(nodes[0]).children).toEqual(['bold']);
  });

  it('parses __bold__', () => {
    const nodes = parseInline('__bold__');
    expect(el(nodes[0]).tag).toBe('strong');
  });

  it('parses *italic*', () => {
    const nodes = parseInline('*italic*');
    expect(nodes).toHaveLength(1);
    expect(el(nodes[0]).tag).toBe('em');
    expect(el(nodes[0]).children).toEqual(['italic']);
  });

  it('parses _italic_', () => {
    const nodes = parseInline('_italic_');
    expect(el(nodes[0]).tag).toBe('em');
  });

  it('parses ~~strikethrough~~', () => {
    const nodes = parseInline('~~struck~~');
    expect(el(nodes[0]).tag).toBe('s');
    expect(el(nodes[0]).children).toEqual(['struck']);
  });

  it('parses `inline code`', () => {
    const nodes = parseInline('`code`');
    expect(el(nodes[0]).tag).toBe('code');
    expect(el(nodes[0]).children).toEqual(['code']);
  });

  it('parses [link](url)', () => {
    const nodes = parseInline('[Click here](https://example.com)');
    expect(el(nodes[0]).tag).toBe('a');
    expect(el(nodes[0]).attrs?.href).toBe('https://example.com');
    expect(el(nodes[0]).children).toEqual(['Click here']);
  });

  it('handles mixed inline formatting', () => {
    const nodes = parseInline('Hello **bold** and *italic* world');
    expect(nodes).toHaveLength(5);
    expect(text(nodes[0])).toBe('Hello ');
    expect(el(nodes[1]).tag).toBe('strong');
    expect(text(nodes[2])).toBe(' and ');
    expect(el(nodes[3]).tag).toBe('em');
    expect(text(nodes[4])).toBe(' world');
  });

  it('handles bold text with surrounding content', () => {
    const nodes = parseInline('before **middle** after');
    expect(text(nodes[0])).toBe('before ');
    expect(el(nodes[1]).tag).toBe('strong');
    expect(el(nodes[1]).children).toEqual(['middle']);
    expect(text(nodes[2])).toBe(' after');
  });

  it('converts newlines to br', () => {
    const nodes = parseInline('Line one\nLine two');
    expect(nodes).toHaveLength(3);
    expect(text(nodes[0])).toBe('Line one');
    expect(el(nodes[1]).tag).toBe('br');
    expect(text(nodes[2])).toBe('Line two');
  });

  it('handles empty string', () => {
    expect(parseInline('')).toEqual([]);
  });
});

// ── TelegraphService State Management ──────────────────────────────

describe('TelegraphService', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
    vi.restoreAllMocks();
  });

  function createService(opts?: Partial<TelegraphConfig>): TelegraphService {
    return new TelegraphService({
      stateDir: project.stateDir,
      shortName: 'test-agent',
      authorName: 'Test Agent',
      ...opts,
    });
  }

  describe('state management', () => {
    it('starts with empty state', () => {
      const svc = createService();
      expect(svc.listPages()).toEqual([]);
      expect(svc.getState().accessToken).toBeUndefined();
    });

    it('loads existing state from disk', () => {
      const stateFile = path.join(project.stateDir, 'publishing.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        accessToken: 'test-token',
        shortName: 'my-agent',
        pages: [{ path: 'test-page', url: 'https://telegra.ph/test-page', title: 'Test', publishedAt: '2026-01-01T00:00:00Z' }],
      }));

      const svc = createService();
      expect(svc.getState().accessToken).toBe('test-token');
      expect(svc.listPages()).toHaveLength(1);
      expect(svc.listPages()[0].title).toBe('Test');
    });

    it('handles corrupted state file gracefully', () => {
      const stateFile = path.join(project.stateDir, 'publishing.json');
      fs.writeFileSync(stateFile, 'not json!!!');

      const svc = createService();
      expect(svc.listPages()).toEqual([]);
    });

    it('returns a copy of pages (not mutable reference)', () => {
      const svc = createService();
      const pages = svc.listPages();
      pages.push({ path: 'fake', url: 'fake', title: 'fake', publishedAt: 'fake' });
      expect(svc.listPages()).toEqual([]);
    });
  });

  describe('ensureAccount', () => {
    it('returns existing token without API call', async () => {
      const stateFile = path.join(project.stateDir, 'publishing.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        accessToken: 'existing-token',
        pages: [],
      }));

      const svc = createService();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const token = await svc.ensureAccount();
      expect(token).toBe('existing-token');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('creates account when no token exists', async () => {
      const svc = createService();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          result: {
            short_name: 'test-agent',
            author_name: 'Test Agent',
            access_token: 'new-token-abc',
          },
        }), { status: 200 }),
      );

      const token = await svc.ensureAccount();
      expect(token).toBe('new-token-abc');

      // Verify state was persisted
      const state = svc.getState();
      expect(state.accessToken).toBe('new-token-abc');
      expect(state.shortName).toBe('test-agent');

      // Verify state file was written
      const fileState = JSON.parse(fs.readFileSync(path.join(project.stateDir, 'publishing.json'), 'utf-8'));
      expect(fileState.accessToken).toBe('new-token-abc');
    });

    it('throws on API error', async () => {
      const svc = createService();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: 'SHORT_NAME_REQUIRED' }), { status: 200 }),
      );

      await expect(svc.ensureAccount()).rejects.toThrow('SHORT_NAME_REQUIRED');
    });
  });

  describe('publishPage', () => {
    it('publishes markdown and tracks locally', async () => {
      // Pre-seed with token
      const stateFile = path.join(project.stateDir, 'publishing.json');
      fs.writeFileSync(stateFile, JSON.stringify({ accessToken: 'tok', pages: [] }));

      const svc = createService();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          result: {
            path: 'My-Report-02-20',
            url: 'https://telegra.ph/My-Report-02-20',
            title: 'My Report',
          },
        }), { status: 200 }),
      );

      const page = await svc.publishPage('My Report', '# Hello\n\nWorld');
      expect(page.url).toBe('https://telegra.ph/My-Report-02-20');
      expect(page.path).toBe('My-Report-02-20');

      // Verify local tracking
      const pages = svc.listPages();
      expect(pages).toHaveLength(1);
      expect(pages[0].title).toBe('My Report');
      expect(pages[0].publishedAt).toBeTruthy();
      expect(pages[0].markdownHash).toBeTruthy();
    });

    it('sends correct content format to API', async () => {
      const stateFile = path.join(project.stateDir, 'publishing.json');
      fs.writeFileSync(stateFile, JSON.stringify({ accessToken: 'tok', pages: [] }));

      const svc = createService();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          result: { path: 'test', url: 'https://telegra.ph/test', title: 'Test' },
        }), { status: 200 }),
      );

      await svc.publishPage('Test', '**Bold text**');

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.telegra.ph/createPage');
      const body = JSON.parse(opts.body as string);
      expect(body.access_token).toBe('tok');
      expect(body.title).toBe('Test');

      // Content should be JSON-encoded Telegraph nodes
      const content = JSON.parse(body.content);
      expect(content).toHaveLength(1);
      expect(content[0].tag).toBe('p');
    });

    it('rejects content larger than 64KB', async () => {
      const stateFile = path.join(project.stateDir, 'publishing.json');
      fs.writeFileSync(stateFile, JSON.stringify({ accessToken: 'tok', pages: [] }));

      const svc = createService();
      const hugeMarkdown = 'x'.repeat(70000);

      await expect(svc.publishPage('Huge', hugeMarkdown)).rejects.toThrow('Content too large');
    });
  });

  describe('editPage', () => {
    it('edits existing page and updates local index', async () => {
      const stateFile = path.join(project.stateDir, 'publishing.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        accessToken: 'tok',
        pages: [{
          path: 'My-Page',
          url: 'https://telegra.ph/My-Page',
          title: 'Old Title',
          publishedAt: '2026-01-01T00:00:00Z',
        }],
      }));

      const svc = createService();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          result: {
            path: 'My-Page',
            url: 'https://telegra.ph/My-Page',
            title: 'New Title',
          },
        }), { status: 200 }),
      );

      const page = await svc.editPage('My-Page', 'New Title', 'Updated content');
      expect(page.title).toBe('New Title');

      const pages = svc.listPages();
      expect(pages[0].title).toBe('New Title');
      expect(pages[0].updatedAt).toBeTruthy();
    });
  });

  describe('getPageViews', () => {
    it('returns view count', async () => {
      const svc = createService();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          result: { views: 42 },
        }), { status: 200 }),
      );

      const views = await svc.getPageViews('some-page');
      expect(views).toBe(42);
    });
  });

  describe('API error handling', () => {
    it('handles HTTP errors', async () => {
      const stateFile = path.join(project.stateDir, 'publishing.json');
      fs.writeFileSync(stateFile, JSON.stringify({ accessToken: 'tok', pages: [] }));

      const svc = createService();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
      );

      await expect(svc.publishPage('Test', 'content')).rejects.toThrow('500');
    });

    it('handles Telegraph API errors', async () => {
      const stateFile = path.join(project.stateDir, 'publishing.json');
      fs.writeFileSync(stateFile, JSON.stringify({ accessToken: 'tok', pages: [] }));

      const svc = createService();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: false,
          error: 'PAGE_NOT_FOUND',
        }), { status: 200 }),
      );

      await expect(svc.publishPage('Test', 'content')).rejects.toThrow('PAGE_NOT_FOUND');
    });

    it('handles network errors', async () => {
      const stateFile = path.join(project.stateDir, 'publishing.json');
      fs.writeFileSync(stateFile, JSON.stringify({ accessToken: 'tok', pages: [] }));

      const svc = createService();
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(svc.publishPage('Test', 'content')).rejects.toThrow('ECONNREFUSED');
    });
  });
});
