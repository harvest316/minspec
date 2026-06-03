/**
 * T1 — Contract Tests: ADR Manager
 *
 * Tests all public exports from src/lib/adr-manager.ts:
 *   - createAdr, listAdrs
 *   - nextAdrNumber, formatAdrId, slugify
 *   - generateAdrContent
 *   - resolveDecisionsDir
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  createAdr,
  listAdrs,
  nextAdrNumber,
  formatAdrId,
  slugify,
  generateAdrContent,
  resolveDecisionsDir,
  setAdrStatus,
  findSimilarAdrs,
  ADR_SIMILARITY_THRESHOLD,
  ADR_STATUS_VALUES,
} from '../src/lib/adr-manager';
import { DEFAULT_CONFIG } from '../src/lib/config';

describe('adr-manager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-adr-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── ID Utilities ─────────────────────────────────────────────────────

  describe('formatAdrId()', () => {
    it('zero-pads to 3 digits', () => {
      expect(formatAdrId(1)).toBe('DR-001');
      expect(formatAdrId(42)).toBe('DR-042');
      expect(formatAdrId(123)).toBe('DR-123');
    });

    it('does not truncate numbers > 999', () => {
      expect(formatAdrId(1234)).toBe('DR-1234');
    });
  });

  describe('slugify()', () => {
    it('lowercases and hyphenates', () => {
      expect(slugify('Use Rate Limiting')).toBe('use-rate-limiting');
    });

    it('collapses multiple hyphens', () => {
      expect(slugify('foo---bar')).toBe('foo-bar');
    });

    it('trims leading and trailing hyphens', () => {
      expect(slugify('--hello world--')).toBe('hello-world');
    });

    it('strips non-alphanumeric characters', () => {
      expect(slugify("What's the plan?")).toBe('what-s-the-plan');
    });

    it('truncates to 50 characters', () => {
      const longTitle = 'A'.repeat(60);
      const slug = slugify(longTitle);
      expect(slug.length).toBeLessThanOrEqual(50);
    });

    it('does not leave trailing hyphen after truncation', () => {
      const title = 'a-'.repeat(30); // would truncate mid-hyphen
      const slug = slugify(title);
      expect(slug.endsWith('-')).toBe(false);
    });
  });

  // ─── Sequential Numbering ────────────────────────────────────────────

  describe('nextAdrNumber()', () => {
    it('returns 1 when directory does not exist', () => {
      expect(nextAdrNumber(path.join(tmpDir, 'nonexistent'))).toBe(1);
    });

    it('returns 1 when directory is empty', () => {
      const dir = path.join(tmpDir, 'decisions');
      fs.mkdirSync(dir, { recursive: true });
      expect(nextAdrNumber(dir)).toBe(1);
    });

    it('returns max+1', () => {
      const dir = path.join(tmpDir, 'decisions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'DR-001-first.md'), '');
      fs.writeFileSync(path.join(dir, 'DR-003-third.md'), '');
      // Skipped DR-002, should still return 4
      expect(nextAdrNumber(dir)).toBe(4);
    });

    it('ignores non-ADR files', () => {
      const dir = path.join(tmpDir, 'decisions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'DR-005-adr.md'), '');
      fs.writeFileSync(path.join(dir, 'INDEX.md'), '');
      fs.writeFileSync(path.join(dir, 'README.md'), '');
      expect(nextAdrNumber(dir)).toBe(6);
    });
  });

  // ─── ADR Content Generation ──────────────────────────────────────────

  describe('generateAdrContent()', () => {
    it('produces valid frontmatter with provided values', () => {
      const content = generateAdrContent('DR-001', 'Use PostgreSQL', '2026-05-26');

      expect(content).toContain('---');
      expect(content).toContain('id: DR-001');
      expect(content).toContain('title: Use PostgreSQL');
      expect(content).toContain('status: proposed');
      expect(content).toContain('date: 2026-05-26');
    });

    it('includes Context, Decision, Costly to Refactor, and Consequences sections', () => {
      const content = generateAdrContent('DR-042', 'Switch to Vitest', '2026-01-01');

      expect(content).toContain('## Context');
      expect(content).toContain('## Decision');
      expect(content).toContain('## Costly to Refactor');
      expect(content).toContain('## Consequences');
    });

    it('places Costly to Refactor after Decision and before Consequences', () => {
      const content = generateAdrContent('DR-042', 'X', '2026-01-01');
      expect(content.indexOf('## Decision'))
        .toBeLessThan(content.indexOf('## Costly to Refactor'));
      expect(content.indexOf('## Costly to Refactor'))
        .toBeLessThan(content.indexOf('## Consequences'));
    });

    it('includes the heading with id and title', () => {
      const content = generateAdrContent('DR-010', 'My Decision', '2026-05-26');
      expect(content).toContain('# DR-010: My Decision');
    });
  });

  // ─── Decisions Directory Resolution ──────────────────────────────────

  describe('resolveDecisionsDir()', () => {
    it('uses default config when no config file exists', () => {
      const dir = resolveDecisionsDir(tmpDir);
      expect(dir).toBe(path.join(tmpDir, DEFAULT_CONFIG.decisionsDir));
    });

    it('uses config file value when present', () => {
      const minspecDir = path.join(tmpDir, '.minspec');
      fs.mkdirSync(minspecDir, { recursive: true });
      fs.writeFileSync(
        path.join(minspecDir, 'config.json'),
        JSON.stringify({ ...DEFAULT_CONFIG, decisionsDir: 'custom/adr' }),
      );

      const dir = resolveDecisionsDir(tmpDir);
      expect(dir).toBe(path.join(tmpDir, 'custom/adr'));
    });

    it('respects vscode overrides', () => {
      const dir = resolveDecisionsDir(tmpDir, { decisionsDir: 'vscode/decisions' });
      expect(dir).toBe(path.join(tmpDir, 'vscode/decisions'));
    });
  });

  // ─── CRUD Operations ────────────────────────────────────────────────

  describe('createAdr()', () => {
    it('creates ADR file with correct frontmatter', () => {
      const result = createAdr(tmpDir, 'Use PostgreSQL');

      expect(result.id).toBe('DR-001');
      expect(result.title).toBe('Use PostgreSQL');
      expect(result.status).toBe('proposed');
      expect(result.date).toBeTruthy();
      expect(fs.existsSync(result.filePath)).toBe(true);

      const content = fs.readFileSync(result.filePath, 'utf-8');
      expect(content).toContain('id: DR-001');
      expect(content).toContain('title: Use PostgreSQL');
      expect(content).toContain('status: proposed');
    });

    it('creates decisions directory if it does not exist', () => {
      const decisionsDir = path.join(tmpDir, DEFAULT_CONFIG.decisionsDir);
      expect(fs.existsSync(decisionsDir)).toBe(false);

      createAdr(tmpDir, 'Test ADR');

      expect(fs.existsSync(decisionsDir)).toBe(true);
    });

    it('auto-increments ID sequentially', () => {
      const first = createAdr(tmpDir, 'First decision');
      const second = createAdr(tmpDir, 'Second decision');
      const third = createAdr(tmpDir, 'Third decision');

      expect(first.id).toBe('DR-001');
      expect(second.id).toBe('DR-002');
      expect(third.id).toBe('DR-003');
    });

    it('generates slugified filename', () => {
      const result = createAdr(tmpDir, 'Use Rate Limiting Middleware');

      expect(path.basename(result.filePath)).toBe('DR-001-use-rate-limiting-middleware.md');
    });

    it('respects vscode overrides for directory', () => {
      const result = createAdr(tmpDir, 'Test ADR', { decisionsDir: 'my-adrs' });

      expect(result.filePath).toContain('my-adrs');
      expect(fs.existsSync(result.filePath)).toBe(true);
    });
  });

  describe('listAdrs()', () => {
    it('returns empty array when no decisions directory exists', () => {
      expect(listAdrs(tmpDir)).toEqual([]);
    });

    it('returns empty array when directory is empty', () => {
      fs.mkdirSync(path.join(tmpDir, DEFAULT_CONFIG.decisionsDir), { recursive: true });
      expect(listAdrs(tmpDir)).toEqual([]);
    });

    it('lists created ADRs sorted by ID', () => {
      createAdr(tmpDir, 'Third');
      createAdr(tmpDir, 'First');
      createAdr(tmpDir, 'Second');

      // IDs are sequential based on creation order
      const adrs = listAdrs(tmpDir);
      expect(adrs).toHaveLength(3);
      expect(adrs[0].id).toBe('DR-001');
      expect(adrs[1].id).toBe('DR-002');
      expect(adrs[2].id).toBe('DR-003');
    });

    it('reads frontmatter from ADR files', () => {
      createAdr(tmpDir, 'My Decision');

      const adrs = listAdrs(tmpDir);
      expect(adrs).toHaveLength(1);
      expect(adrs[0].title).toBe('My Decision');
      expect(adrs[0].status).toBe('proposed');
      expect(adrs[0].date).toBeTruthy();
    });

    it('handles ADR files without frontmatter gracefully', () => {
      const decisionsDir = path.join(tmpDir, DEFAULT_CONFIG.decisionsDir);
      fs.mkdirSync(decisionsDir, { recursive: true });
      fs.writeFileSync(path.join(decisionsDir, 'DR-001-no-frontmatter.md'), '# Just a heading\n');

      const adrs = listAdrs(tmpDir);
      expect(adrs).toHaveLength(1);
      expect(adrs[0].id).toContain('DR-');
      expect(adrs[0].status).toBe('proposed'); // default
    });

    it('ignores non-ADR files', () => {
      const decisionsDir = path.join(tmpDir, DEFAULT_CONFIG.decisionsDir);
      fs.mkdirSync(decisionsDir, { recursive: true });
      fs.writeFileSync(path.join(decisionsDir, 'INDEX.md'), '# Index');
      fs.writeFileSync(path.join(decisionsDir, 'README.md'), '# Readme');

      createAdr(tmpDir, 'Real ADR');

      const adrs = listAdrs(tmpDir);
      expect(adrs).toHaveLength(1);
      expect(adrs[0].id).toBe('DR-001');
    });

    it('respects vscode overrides', () => {
      createAdr(tmpDir, 'Test', { decisionsDir: 'custom-adrs' });

      const adrs = listAdrs(tmpDir, { decisionsDir: 'custom-adrs' });
      expect(adrs).toHaveLength(1);

      // Default dir should be empty
      expect(listAdrs(tmpDir)).toEqual([]);
    });
  });

  // ─── Integration ─────────────────────────────────────────────────────

  describe('Integration: create → list → verify numbering', () => {
    it('creates multiple ADRs with sequential numbering and lists them correctly', () => {
      createAdr(tmpDir, 'Use PostgreSQL');
      createAdr(tmpDir, 'Switch to Vitest');
      createAdr(tmpDir, 'Adopt TypeScript Strict Mode');

      const adrs = listAdrs(tmpDir);
      expect(adrs).toHaveLength(3);

      // Sequential IDs
      expect(adrs.map(a => a.id)).toEqual(['DR-001', 'DR-002', 'DR-003']);

      // All proposed
      expect(adrs.every(a => a.status === 'proposed')).toBe(true);

      // Titles preserved
      expect(adrs.map(a => a.title)).toEqual([
        'Use PostgreSQL',
        'Switch to Vitest',
        'Adopt TypeScript Strict Mode',
      ]);
    });
  });

  // ─── setAdrStatus() ──────────────────────────────────────────────────

  describe('setAdrStatus()', () => {
    it('rewrites the status line and is reflected by listAdrs', () => {
      const dir = path.join(tmpDir, 'decisions');
      const adr = createAdr(tmpDir, 'Use PostgreSQL');
      expect(adr.status).toBe('proposed');

      const result = setAdrStatus(adr.filePath, 'accepted');
      expect(result).toBe('accepted');

      const reloaded = listAdrs(tmpDir).find(a => a.id === adr.id);
      expect(reloaded?.status).toBe('accepted');
      expect(dir).toContain('decisions'); // dir resolution sanity
    });

    it('preserves other frontmatter fields and body', () => {
      const adr = createAdr(tmpDir, 'Adopt Vitest');
      setAdrStatus(adr.filePath, 'superseded');
      const content = fs.readFileSync(adr.filePath, 'utf-8');

      expect(content).toContain(`id: ${adr.id}`);
      expect(content).toContain('title: Adopt Vitest');
      expect(content).toContain('status: superseded');
      expect(content).not.toContain('status: proposed');
      expect(content).toContain('## Context');
    });

    it('adds a status field when frontmatter has none', () => {
      const dir = path.join(tmpDir, 'decisions');
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, 'DR-009-no-status.md');
      fs.writeFileSync(fp, '---\nid: DR-009\ntitle: No Status\n---\n\n## Context\n', 'utf-8');

      setAdrStatus(fp, 'accepted');
      const content = fs.readFileSync(fp, 'utf-8');
      expect(content).toContain('status: accepted');
      expect(content).toContain('title: No Status');
    });

    it('throws on a file with no frontmatter', () => {
      const dir = path.join(tmpDir, 'decisions');
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, 'DR-010-bare.md');
      fs.writeFileSync(fp, '# Just a heading\n', 'utf-8');

      expect(() => setAdrStatus(fp, 'accepted')).toThrow(/frontmatter/);
    });

    it('throws on an invalid status value', () => {
      const adr = createAdr(tmpDir, 'Bad Status');
      // @ts-expect-error testing runtime guard against invalid status
      expect(() => setAdrStatus(adr.filePath, 'bogus')).toThrow(/Invalid ADR status/);
    });

    it('ADR_STATUS_VALUES lists all four lifecycle states in order', () => {
      expect(ADR_STATUS_VALUES).toEqual([
        'proposed',
        'accepted',
        'deprecated',
        'superseded',
      ]);
    });
  });

  // ─── findSimilarAdrs() — dedup gate ──────────────────────────────────

  describe('findSimilarAdrs()', () => {
    it('flags a near-duplicate title above threshold', () => {
      createAdr(tmpDir, 'Use PostgreSQL for persistence');
      const hits = findSimilarAdrs(tmpDir, 'Use PostgreSQL for storage');
      expect(hits.length).toBe(1);
      expect(hits[0].adr.title).toBe('Use PostgreSQL for persistence');
      expect(hits[0].score).toBeGreaterThanOrEqual(ADR_SIMILARITY_THRESHOLD);
    });

    it('returns nothing for an unrelated title', () => {
      createAdr(tmpDir, 'Use PostgreSQL for persistence');
      expect(findSimilarAdrs(tmpDir, 'Adopt Tailwind for styling')).toEqual([]);
    });

    it('ignores stopwords so only meaningful tokens count', () => {
      createAdr(tmpDir, 'Rate limiting middleware');
      // Shares only stopwords with the existing title → no match.
      expect(findSimilarAdrs(tmpDir, 'Use the for a to of')).toEqual([]);
    });

    it('excludes superseded and deprecated records', () => {
      const sup = createAdr(tmpDir, 'Use Webpack for bundling');
      setAdrStatus(sup.filePath, 'superseded');
      const dep = createAdr(tmpDir, 'Use Webpack for builds');
      setAdrStatus(dep.filePath, 'deprecated');
      // Re-deciding a topic whose prior records are out of force is not a dup.
      expect(findSimilarAdrs(tmpDir, 'Use Webpack for bundling')).toEqual([]);
    });

    it('sorts multiple matches by score descending', () => {
      createAdr(tmpDir, 'Use PostgreSQL for persistence');
      createAdr(tmpDir, 'Use PostgreSQL for persistence and caching');
      const hits = findSimilarAdrs(tmpDir, 'Use PostgreSQL for persistence', undefined, 0.3);
      expect(hits.length).toBe(2);
      expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
      expect(hits[0].adr.title).toBe('Use PostgreSQL for persistence'); // exact = 1.0
    });

    it('returns empty for an all-stopword candidate title', () => {
      createAdr(tmpDir, 'Use PostgreSQL for persistence');
      expect(findSimilarAdrs(tmpDir, 'the a an for')).toEqual([]);
    });
  });
});
