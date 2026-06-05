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
  epicRefValue,
  formatEpicRef,
  setArtifactEpic,
  setEpicStatus,
  readArtifactEpic,
  detectEpicStub,
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

    it('derives a clean slug + title from a no-frontmatter filename (#153)', () => {
      // File: EPIC-012-user-auth-flow.md, no frontmatter.
      const dir = path.join(tmpDir, EPICS_DIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'EPIC-012-user-auth-flow.md'), 'body, no frontmatter\n');

      const e = listEpics(tmpDir).find(x => x.id === 'EPIC-012')!;
      // Bug: slug was the bare digits ("012") and title was the raw filename incl ".md".
      expect(e.slug).toBe('user-auth-flow');
      expect(e.title).toBe('User Auth Flow');
      expect(e.title).not.toContain('.md');
    });

    it('derives a fallback slug/title for a no-frontmatter file with only an id (#153)', () => {
      const dir = path.join(tmpDir, EPICS_DIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'EPIC-013.md'), 'body, no frontmatter\n');

      const e = listEpics(tmpDir).find(x => x.id === 'EPIC-013')!;
      expect(e.slug).toBe('epic-013');
      expect(e.title).toBe('EPIC-013');
      expect(e.title).not.toContain('.md');
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
    it('tolerates an inline title comment on the ref', () => {
      expect(resolveEpic('EPIC-001  # Telemetry', epics)?.slug).toBe('telemetry');
      expect(resolveEpic('telemetry # whatever the comment says', epics)?.id).toBe('EPIC-001');
      expect(resolveEpic('   #just a comment, no ref', epics)).toBeNull();
    });
  });

  // ─── epic ref value/format helpers ───────────────────────────────────

  describe('epicRefValue() / formatEpicRef()', () => {
    it('strips an inline comment back to the bare ref', () => {
      expect(epicRefValue('EPIC-001  # Telemetry & Privacy')).toBe('EPIC-001');
      expect(epicRefValue('telemetry#x')).toBe('telemetry');
      expect(epicRefValue('  EPIC-002  ')).toBe('EPIC-002');
    });
    it('returns undefined for absent/empty/comment-only values', () => {
      expect(epicRefValue(undefined)).toBeUndefined();
      expect(epicRefValue(null)).toBeUndefined();
      expect(epicRefValue('   ')).toBeUndefined();
      expect(epicRefValue('# only a comment')).toBeUndefined();
    });
    it('formats with a comment only when a non-empty title is given', () => {
      expect(formatEpicRef('EPIC-001', 'Telemetry')).toBe('EPIC-001  # Telemetry');
      expect(formatEpicRef('EPIC-001')).toBe('EPIC-001');
      expect(formatEpicRef('EPIC-001', '   ')).toBe('EPIC-001');
    });
    it('round-trips: epicRefValue(formatEpicRef(ref, title)) === ref', () => {
      expect(epicRefValue(formatEpicRef('EPIC-007', 'Some Title'))).toBe('EPIC-007');
    });
  });

  // ─── setArtifactEpic / readArtifactEpic ──────────────────────────────

  describe('setEpicStatus()', () => {
    it('rewrites the status line and listEpics reflects it', () => {
      const s = createEpic(tmpDir, 'Telemetry');
      expect(listEpics(tmpDir)[0].status).toBe('proposed');
      setEpicStatus(s.filePath, 'active');
      expect(listEpics(tmpDir)[0].status).toBe('active');
    });
    it('throws on invalid status', () => {
      const s = createEpic(tmpDir, 'X');
      // @ts-expect-error invalid status
      expect(() => setEpicStatus(s.filePath, 'bogus')).toThrow();
    });
  });

  describe('setArtifactEpic() / readArtifactEpic()', () => {
    function artifact(body: string): string {
      const p = path.join(tmpDir, 'SPEC-001.md');
      fs.writeFileSync(p, body, 'utf-8');
      return p;
    }

    it('writes the title as an inline comment and reads back the bare ref', () => {
      const p = artifact('---\nid: SPEC-001\ntitle: X\n---\n# X\n');
      setArtifactEpic(p, 'EPIC-001', 'Telemetry & Privacy');
      expect(fs.readFileSync(p, 'utf-8')).toContain('epic: EPIC-001  # Telemetry & Privacy');
      expect(readArtifactEpic(p)).toBe('EPIC-001');
    });

    it('omits the comment when no title is given', () => {
      const p = artifact('---\nid: SPEC-001\n---\n');
      setArtifactEpic(p, 'EPIC-002');
      expect(fs.readFileSync(p, 'utf-8')).toContain('epic: EPIC-002\n');
      expect(readArtifactEpic(p)).toBe('EPIC-002');
    });

    it('replaces an existing epic line (comment and all)', () => {
      const p = artifact('---\nid: SPEC-001\nepic: EPIC-009  # Old\ntitle: X\n---\n');
      setArtifactEpic(p, 'EPIC-003', 'New Name');
      const out = fs.readFileSync(p, 'utf-8');
      expect(out).toContain('epic: EPIC-003  # New Name');
      expect(out).not.toContain('EPIC-009');
      expect(out).not.toContain('Old');
    });

    // ─── #152: a $-special epic title comment must be written verbatim ──
    it('writes an epic title containing $-special sequences verbatim', () => {
      const p = artifact('---\nid: SPEC-001\ntitle: X\n---\n# X\n');
      // `$5`/`$1` look like back-references; `$&`/$` exercise the named specials.
      const epicTitle = 'cost is $5 ($1 each) for A$AP — $& $`';
      setArtifactEpic(p, 'EPIC-001', epicTitle);
      const out = fs.readFileSync(p, 'utf-8');
      expect(out).toContain(`epic: EPIC-001  # ${epicTitle}`);
      // The resolvable ref reads back cleanly (comment stripped at the first #).
      expect(readArtifactEpic(p)).toBe('EPIC-001');
    });

    it('preserves a $-special title field when only the status block is rewritten', () => {
      // setEpicStatus rewrites the WHOLE frontmatter block; a $ in any sibling
      // field (title) must survive the replacement (#152).
      const title = 'A$AP costs $5 ($1 each) $& $`';
      const before = `---\nid: EPIC-001\nslug: a\ntitle: ${title}\nstatus: proposed\norder: 1\n---\n\n## Goal\n\ng\n\n## Artifacts\n\na\n`;
      epicFile(tmpDir, 'EPIC-001', before);
      const fp = path.join(tmpDir, EPICS_DIR, 'EPIC-001-x.md');
      setEpicStatus(fp, 'active');
      const out = fs.readFileSync(fp, 'utf-8');
      // Exact-equality: a $-driven corruption duplicates/reorders the block, which
      // a loose `toContain` misses because the expanded $1/$& re-inject the title.
      expect(out).toBe(before.replace('status: proposed', 'status: active'));
      expect(out.match(/^---$/gm)).toHaveLength(2);
      expect(out.match(/^title:/gm)).toHaveLength(1);
      expect(out.match(/^status:/gm)).toHaveLength(1);
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

    // ── #67 regression: registered member-less epics must NOT be pruned ──
    it('retains a registered epic that has zero members (#67)', () => {
      // Only EPIC-001 has a member; EPIC-002 is a registered-but-empty epic.
      const items = [{ name: 'x', epic: 'EPIC-001' }];
      const map = groupByEpic(items, i => i.epic, epics);
      expect([...map.keys()]).toEqual(['EPIC-001', 'EPIC-002']);
      expect(map.get('EPIC-002')).toEqual([]); // present, empty
    });

    it('retains ALL registered epics when none have members, NO_EPIC only when populated (#67)', () => {
      // No items at all → both registered epics survive, no NO_EPIC bucket.
      const empty = groupByEpic([] as { epic?: string }[], i => i.epic, epics);
      expect([...empty.keys()]).toEqual(['EPIC-001', 'EPIC-002']);
      expect(empty.has(NO_EPIC)).toBe(false);

      // Only an unresolved item → registered epics survive empty, NO_EPIC last.
      const orphan = groupByEpic([{ epic: 'ghost' }], i => i.epic, epics);
      expect([...orphan.keys()]).toEqual(['EPIC-001', 'EPIC-002', NO_EPIC]);
      expect(orphan.get('EPIC-001')).toEqual([]);
      expect(orphan.get(NO_EPIC)).toHaveLength(1);
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

  // ─── stub detection (#85) ───────────────────────────────────────────
  // Tier-0 soft warning (advisory, never blocking): an epic whose ## Goal or
  // ## Artifacts section is empty or still only the template placeholder.

  describe('detectEpicStub() / listEpics().isStub', () => {
    it('flags a freshly-generated epic (placeholder Goal AND Artifacts) as a stub', () => {
      const body = generateEpicContent('EPIC-001', 'My Epic', 'my-epic', 1);
      const res = detectEpicStub(body);
      expect(res.stub).toBe(true);
      expect(res.reasons).toContain('goal');
      expect(res.reasons).toContain('artifacts');
    });

    it('does NOT flag an epic whose Goal AND Artifacts have real prose', () => {
      const body = [
        '---', 'id: EPIC-001', 'slug: s', 'title: T', 'status: active', 'order: 1', '---',
        '', '# EPIC-001: T', '',
        '## Goal', '', 'Ship the whole billing pipeline end to end.', '',
        '## Artifacts', '', '- SPEC-001 — billing core', '',
      ].join('\n');
      expect(detectEpicStub(body).stub).toBe(false);
    });

    it('flags when ONLY the Goal is filled but Artifacts is still the placeholder', () => {
      const body = generateEpicContent('EPIC-002', 'E', 'e', 2, 'A concrete, filled-in goal.');
      const res = detectEpicStub(body);
      expect(res.stub).toBe(true);
      expect(res.reasons).toEqual(['artifacts']); // Goal is filled, Artifacts is not
    });

    it('treats a whitespace-only section body as a stub', () => {
      const body = [
        '---', 'id: EPIC-003', 'slug: s', 'title: T', 'status: proposed', 'order: 3', '---',
        '', '## Goal', '', '   ', '', '## Artifacts', '', 'real artifact text', '',
      ].join('\n');
      const res = detectEpicStub(body);
      expect(res.stub).toBe(true);
      expect(res.reasons).toEqual(['goal']);
    });

    it('treats a missing section entirely as a stub reason', () => {
      const body = [
        '---', 'id: EPIC-004', 'slug: s', 'title: T', 'status: proposed', 'order: 4', '---',
        '', '## Goal', '', 'A real goal lives here.', '',
        // no ## Artifacts section at all
      ].join('\n');
      const res = detectEpicStub(body);
      expect(res.stub).toBe(true);
      expect(res.reasons).toContain('artifacts');
    });

    it('listEpics surfaces isStub per epic (filled vs placeholder)', () => {
      // EPIC-001: filled both sections → not a stub.
      epicFile(tmpDir, 'EPIC-001', [
        '---', 'id: EPIC-001', 'slug: a', 'title: A', 'status: active', 'order: 1', '---',
        '', '## Goal', '', 'Real goal.', '', '## Artifacts', '', '- SPEC-001', '',
      ].join('\n'));
      // EPIC-002: freshly generated → stub.
      epicFile(tmpDir, 'EPIC-002', generateEpicContent('EPIC-002', 'B', 'b', 2));
      const byId = new Map(listEpics(tmpDir).map(e => [e.id, e]));
      expect(byId.get('EPIC-001')!.isStub).toBe(false);
      expect(byId.get('EPIC-002')!.isStub).toBe(true);
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

    // ─── #152: a $-special epic title must not corrupt the INDEX on remerge ──
    it('keeps an epic title with $-special sequences intact when replacing markers', () => {
      const title = 'cost is $5 ($1 each) for A$AP — $& $`';
      const auto = buildEpicIndexContent([
        { id: 'EPIC-001', slug: 'a', title, status: 'active', order: 1, filePath: '/docs/epics/EPIC-001-a.md' },
      ]);
      // Existing markered content forces the `existing.replace(markerRe, …)` path.
      const existing = mergeEpicIndex(null, buildEpicIndexContent([]));
      const merged = mergeEpicIndex(existing, auto);
      expect(merged).toContain(`## [EPIC-001 — ${title}]`);
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
