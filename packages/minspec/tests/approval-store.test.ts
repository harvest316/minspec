import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  sidecarPath,
  toPosixRel,
  readRecord,
  writeRecord,
  removeRecord,
  listRecords,
} from '../src/lib/approval-store';
import type { ApprovalRecord } from '../src/lib/approval';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-store-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function rec(specPath: string, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    specPath,
    specHash: 'a'.repeat(64),
    approvedAt: '2026-06-06T00:00:00.000Z',
    approvedBy: 'paul@harvest316.com',
    tier: 'T3',
    migrated: false,
    baselineBlob: '', // SPEC-017 FR-1: '' = no M1 datapoint (pre-Slice-3 default)
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INV-5 (key uniqueness) / AC-2. T0 — written before implementation.
//
// AC-10 discipline: the pre-change store was a single id-keyed map in
// `.minspec/approvals.json` (`loadApprovals`/`saveApprovals`). These tests assert
// the NEW path-keyed, one-file-per-spec property — there was no `sidecarPath`,
// `readRecord`, etc. before, so they fail against the old code by construction.
// ─────────────────────────────────────────────────────────────────────────────

describe('INV-5 — sidecarPath is a pure function of the repo-relative spec path', () => {
  it('two distinct spec paths → two distinct sidecars', () => {
    const a = sidecarPath(tmp, 'specs/minspec/SPEC-007-foo/requirements.md');
    const b = sidecarPath(tmp, 'specs/scrooge/SPEC-001-bar/requirements.md');
    expect(a).not.toBe(b);
  });

  it('the same spec path → the same sidecar (merge-conflict-on-same-spec property)', () => {
    const a = sidecarPath(tmp, 'specs/minspec/SPEC-007-foo/requirements.md');
    const b = sidecarPath(tmp, 'specs/minspec/SPEC-007-foo/requirements.md');
    expect(a).toBe(b);
  });

  it('the sidecar lives under .minspec/approvals/ and ends with .json', () => {
    const p = sidecarPath(tmp, 'specs/minspec/SPEC-007-foo/requirements.md');
    expect(p).toBe(
      path.join(tmp, '.minspec', 'approvals', 'specs', 'minspec', 'SPEC-007-foo', 'requirements.md.json'),
    );
  });

  it('cross-product SPEC-id collision (#58) does not collide in the path keyspace', () => {
    // Two specs both id SPEC-001 in different product trees → distinct sidecars.
    const minspec = sidecarPath(tmp, 'specs/minspec/SPEC-001/requirements.md');
    const scrooge = sidecarPath(tmp, 'specs/scrooge/SPEC-001/requirements.md');
    expect(minspec).not.toBe(scrooge);
  });

  it('Windows-style separators normalize to the same key as POSIX', () => {
    expect(toPosixRel('specs\\minspec\\SPEC-007\\requirements.md')).toBe(
      'specs/minspec/SPEC-007/requirements.md',
    );
  });
});

describe('approval-store — read / write / remove / list round-trip', () => {
  const specRel = 'specs/minspec/SPEC-007-foo/requirements.md';

  it('writeRecord then readRecord round-trips the full FR-2 shape', () => {
    const r = rec(specRel);
    writeRecord(tmp, r);
    expect(readRecord(tmp, specRel)).toEqual(r);
  });

  it('writeRecord mkdir -p s the nested sidecar dir', () => {
    writeRecord(tmp, rec(specRel));
    expect(fs.existsSync(sidecarPath(tmp, specRel))).toBe(true);
  });

  it('sidecar is pretty-printed JSON with a trailing newline', () => {
    writeRecord(tmp, rec(specRel));
    const text = fs.readFileSync(sidecarPath(tmp, specRel), 'utf-8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "specHash"');
  });

  it('readRecord returns undefined when absent', () => {
    expect(readRecord(tmp, specRel)).toBeUndefined();
  });

  it('readRecord drops a malformed sidecar (returns undefined, never throws)', () => {
    const p = sidecarPath(tmp, specRel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ not json');
    expect(readRecord(tmp, specRel)).toBeUndefined();
  });

  it('readRecord drops a sidecar missing required FR-2 fields', () => {
    const p = sidecarPath(tmp, specRel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Old-shape record (no specPath/approvedBy/migrated) must be rejected.
    fs.writeFileSync(p, JSON.stringify({ specHash: 'x', approvedAt: 't', tier: 'T3' }));
    expect(readRecord(tmp, specRel)).toBeUndefined();
  });

  it('removeRecord unlinks and reports prior existence', () => {
    writeRecord(tmp, rec(specRel));
    expect(removeRecord(tmp, specRel)).toBe(true);
    expect(readRecord(tmp, specRel)).toBeUndefined();
    expect(removeRecord(tmp, specRel)).toBe(false);
  });

  it('listRecords returns every valid sidecar across the tree', () => {
    writeRecord(tmp, rec('specs/minspec/SPEC-007/requirements.md'));
    writeRecord(tmp, rec('specs/minspec/SPEC-008/requirements.md', { migrated: true }));
    writeRecord(tmp, rec('specs/scrooge/SPEC-001/requirements.md'));
    const all = listRecords(tmp);
    expect(all).toHaveLength(3);
    expect(all.filter((r) => r.migrated)).toHaveLength(1);
  });

  it('listRecords on an empty repo returns []', () => {
    expect(listRecords(tmp)).toEqual([]);
  });
});
