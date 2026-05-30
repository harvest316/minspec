/**
 * T1 — Contract Tests: Epic Manager (SPEC-007 / DR-013)
 *
 * Public exports from src/lib/epic-manager.ts:
 *   listEpics, resolveEpic, groupByEpic, NO_EPIC,
 *   nextEpicNumber, formatEpicId, nextEpicId,
 *   createEpic, generateEpicContent, writeEpicIndex, mergeEpicIndex,
 *   buildEpicIndexContent, resolveEpicsDir
 *
 * Invariants under test (FR-9 / INV ceremony ∝ complexity):
 *   - absent ref → ungrouped, no throw
 *   - unknown ref → resolveEpic null + NO_EPIC bucket, no throw
 *   - INDEX writes only inside markers (preserves user content)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  listEpics,
  resolveEpic,
  groupByEpic,
  NO_EPIC,
  nextEpicNumber,
  formatEpicId,
  nextEpicId,
  createEpic,
  generateEpicContent,
  writeEpicIndex,
  mergeEpicIndex,
  buildEpicIndexContent,
  resolveEpicsDir,
  EPIC_STATUS_VALUES,
  type EpicSummary,
} from '../src/lib/epic-manager';

const EPICS_DIR = 'docs/epics';

function epicFile(tmpDir: string, id: string, body: string): void {
  const dir = path.join(tmpDir, EPICS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}-x.md`), body, 'utf-8');
}

describe('epic-manager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-epic-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── ID utilities ───────────────────────────────────────────────────

  describe('formatEpicId()', () => {
    it('zero-pads to 3 digits', () => {
      expect(formatEpicId(1)).toBe('EPIC-001');
      expect(formatEpicId(42)).toBe('EPIC-042');
    });
    it('does not truncate > 999', () => {
      expect(formatEpicId(1234)).toBe('EPIC-1234');
    });
  });

  describe('nextEpicNumber() / nextEpicId()', () => {
    it('returns 1 for an empty/absent dir', () => {
      expect(nextEpicNumber(path.join(tmpDir, EPICS_DIR))).toBe(1);
      expect(nextEpicId(tmpDir)).toBe('EPIC-001');
    });
    it('returns max+1 across existing epics', () => {
      epicFile(tmpDir, 'EPIC-001', '---\nid: EPIC-001\n---\n');
      epicFile(tmpDir, 'EPIC-007', '---\nid: EPIC-007\n---\n');
      expect(nextEpicNumber(path.join(tmpDir, EPICS_DIR))).toBe(8);
      expect(nextEpicId(tmpDir)).toBe('EPIC-008');
    });
  });

  // ─── listEpics ──────────────────────────────────────────────────────

  describe('listEpics()', () => {
    it('returns [] when the dir does not exist', () => {
      expect(listEpics(tmpDir)).toEqual([]);
    });

    it('parses frontmatter and sorts by order then id', () => {
      epicFile(tmpDir, 'EPIC-001', '---\nid: EPIC-001\nslug: alpha\ntitle: Alpha\nstatus: active\norder: 5\n---\n');
      epicFile(tmpDir, 'EPIC-002', '---\nid: EPIC-002\nslug: beta\ntitle: Beta\nstatus: proposed\norder: 1\n---\n');
      epicFile(tmpDir, 'EPIC-003', '---\nid: EPIC-003\nslug: gamma\ntitle: Gamma\nstatus: done\norder: 1\n---\n');
      const epics = listEpics(tmpDir);
      expect(epics.map(e => e.id)).toEqual(['EPIC-002', 'EPIC-003', 'EPIC-001']);
      expect(epics[0]).toMatchObject({ slug: 'beta', title: 'Beta', status: 'proposed', order: 1 });
    });

    it('defaults missing order to 999 and invalid status to proposed', () => {
      epicFile(tmpDir, 'EPIC-009', '---\nid: EPIC-009\nslug: s\ntitle: T\nstatus: bogus\n---\n');
      const [e] = listEpics(tmpDir);
      expect(e.order).toBe(999);
      expect(e.status).toBe('proposed');
    });

    it('derives a minimal summary for a file with no frontmatter', () => {
      epicFile(tmpDir, 'EPIC-004', 'no frontmatter here\n');
      const [e] = listEpics(tmpDir);
      expect(e.id).toBe('EPIC-004');
      expect(e.status).toBe('proposed');
      expect(e.order).toBe(999);
    });
  });

  // ─── resolveEpic ────────────────────────────────────────────────────

  describe('resolveEpic()', () => {
    const epics: EpicSummary[] = [
      { id: 'EPIC-001', slug: 'telemetry', title: 'Telemetry', status: 'active', order: 1, filePath: '/x' },
    ];

    it('resolves by id (case-insensitive)', () => {
      expect(resolveEpic('EPIC-001', epics)?.slug).toBe('telemetry');
      expect(resolveEpic('epic-001', epics)?.slug).toBe('telemetry');
    });
    it('resolves by slug (case-insensitive)', () => {
      expect(resolveEpic('telemetry', epics)?.id).toBe('EPIC-001');
      expect(resolveEpic('Telemetry', epics)?.id).toBe('EPIC-001');
    });
    it('returns null for absent/empty/unknown refs — never throws', () => {
      expect(resolveEpic(undefined, epics)).toBeNull();
      expect(resolveEpic('', epics)).toBeNull();
      expect(resolveEpic('   ', epics)).toBeNull();
      expect(resolveEpic('nope', epics)).toBeNull();
    });
  });

  // ─── groupByEpic ────────────────────────────────────────────────────

  describe('groupByEpic()', () => {
    const epics: EpicSummary[] = [
      { id: 'EPIC-001', slug: 'a', title: 'A', status: 'active', order: 1, filePath: '/a' },
      { id: 'EPIC-002', slug: 'b', title: 'B', status: 'active', order: 2, filePath: '/b' },
    ];

    it('buckets by resolved epic, drops empty epics, NO_EPIC last', () => {
      const items = [
        { name: 'x', epic: 'EPIC-001' },
        { name: 'y', epic: 'b' },          // by slug
        { name: 'z', epic: 'unknown' },    // unresolved → NO_EPIC
        { name: 'w', epic: undefined },    // absent → NO_EPIC
      ];
      const map = groupByEpic(items, i => i.epic, epics);
      const keys = [...map.keys()];
      expect(keys).toEqual(['EPIC-001', 'EPIC-002', NO_EPIC]);
      expect(map.get('EPIC-001')!.map(i => i.name)).toEqual(['x']);
      expect(map.get('EPIC-002')!.map(i => i.name)).toEqual(['y']);
      expect(map.get(NO_EPIC)!.map(i => i.name)).toEqual(['z', 'w']);
    });

    it('omits NO_EPIC entirely when every item resolves', () => {
      const items = [{ epic: 'a' }, { epic: 'EPIC-002' }];
      const map = groupByEpic(items, i => i.epic, epics);
      expect(map.has(NO_EPIC)).toBe(false);
    });

    it('preserves epic order even when first item belongs to a later epic', () => {
      const items = [{ epic: 'EPIC-002' }, { epic: 'EPIC-001' }];
      expect([...groupByEpic(items, i => i.epic, epics).keys()]).toEqual(['EPIC-001', 'EPIC-002']);
    });
  });

  // ─── createEpic ─────────────────────────────────────────────────────

  describe('createEpic()', () => {
    it('writes a sequential, parseable epic and round-trips via listEpics', () => {
      const s = createEpic(tmpDir, 'Telemetry & RUM');
      expect(s.id).toBe('EPIC-001');
      expect(s.slug).toBe('telemetry-rum');
      expect(fs.existsSync(s.filePath)).toBe(true);
      const [listed] = listEpics(tmpDir);
      expect(listed).toMatchObject({ id: 'EPIC-001', slug: 'telemetry-rum', title: 'Telemetry & RUM' });
    });

    it('honors an explicit slug', () => {
      const s = createEpic(tmpDir, 'Some Long Title', 'short');
      expect(s.slug).toBe('short');
    });

    it('generated content carries id/slug/title/status/order frontmatter', () => {
      const body = generateEpicContent('EPIC-003', 'My Epic', 'my-epic', 3);
      expect(body).toContain('id: EPIC-003');
      expect(body).toContain('slug: my-epic');
      expect(body).toContain('status: proposed');
      expect(body).toContain('order: 3');
    });
  });

  // ─── Index (markers / invariant #6) ─────────────────────────────────

  describe('writeEpicIndex() / mergeEpicIndex()', () => {
    it('wraps content in markers and is idempotent across regenerations', () => {
      createEpic(tmpDir, 'Alpha');
      const { filePath, count } = writeEpicIndex(tmpDir);
      expect(count).toBe(1);
      const first = fs.readFileSync(filePath, 'utf-8');
      expect(first).toContain('<!-- minspec:epic-index:start -->');
      expect(first).toContain('<!-- minspec:epic-index:end -->');
      expect(first).toContain('EPIC-001');
      writeEpicIndex(tmpDir);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(first);
    });

    it('preserves user content outside the markers', () => {
      const userTail = '\n## Hand-written notes\n\nkeep me\n';
      const auto = buildEpicIndexContent([]);
      const merged = mergeEpicIndex(`existing junk${userTail}`, auto);
      expect(merged).toContain('keep me');
      expect(merged).toContain('<!-- minspec:epic-index:start -->');
    });

    it('replaces only the marked block on the second merge', () => {
      const m1 = mergeEpicIndex(null, buildEpicIndexContent([]));
      const withUser = `${m1}\n## User\nmine\n`;
      const m2 = mergeEpicIndex(withUser, buildEpicIndexContent([
        { id: 'EPIC-001', slug: 'a', title: 'A', status: 'active', order: 1, filePath: '/docs/epics/EPIC-001-a.md' },
      ]));
      expect(m2).toContain('## User');
      expect(m2).toContain('EPIC-001');
      expect(m2.match(/minspec:epic-index:start/g)!.length).toBe(1);
    });
  });

  // ─── misc ───────────────────────────────────────────────────────────

  it('resolveEpicsDir honors the default config location', () => {
    expect(resolveEpicsDir(tmpDir)).toBe(path.join(tmpDir, 'docs/epics'));
  });

  it('EPIC_STATUS_VALUES lists the four lifecycle states', () => {
    expect(EPIC_STATUS_VALUES).toEqual(['proposed', 'active', 'done', 'abandoned']);
  });
});
