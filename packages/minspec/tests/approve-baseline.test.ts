/**
 * Slice 2 — back-compat tests (AC-1 back-compat clause).
 *
 * HARD REQUIREMENT: a pre-SPEC-017 record lacking `baselineBlob` MUST remain a
 * valid approval. A required-string validation would silently DROP every existing
 * approval (the gate would flag every implementing/done spec as unapproved).
 *
 * These tests are scoped to Slice 2 only (record extension + validator widening).
 * Slice 3 tests (mintBaseline / recoverBaseline / gc-survival) will extend this
 * file in a later slice.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sidecarPath, readRecord } from '../src/lib/approval-store';
import type { ApprovalRecord } from '../src/lib/approval';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-baseline-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write raw JSON directly to the sidecar path (bypasses writeRecord so we can
 *  inject legacy shapes that would never be written by the current code). */
function writeSidecarRaw(specRel: string, json: object): void {
  const p = sidecarPath(tmp, specRel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf-8');
}

const SPEC_REL = 'specs/minspec/SPEC-007-foo/requirements.md';

/** A minimal LEGACY record — shape from before SPEC-017 (no baselineBlob, no reviewStart). */
const legacyRecord = {
  specPath: SPEC_REL,
  specHash: 'a'.repeat(64),
  approvedAt: '2026-06-01T00:00:00.000Z',
  approvedBy: 'paul@harvest316.com',
  tier: 'T3',
  migrated: false,
  // NO baselineBlob — this is the legacy shape.
  // NO reviewStart — also absent in legacy.
};

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 back-compat: legacy records (no baselineBlob) MUST remain valid approvals
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-1 back-compat — legacy record (no baselineBlob) is a valid approval', () => {
  it('readRecord returns the legacy record (not undefined) when baselineBlob is absent', () => {
    writeSidecarRaw(SPEC_REL, legacyRecord);
    const result = readRecord(tmp, SPEC_REL);
    expect(result).not.toBeUndefined();
  });

  it('the returned legacy record carries the expected fields', () => {
    writeSidecarRaw(SPEC_REL, legacyRecord);
    const result = readRecord(tmp, SPEC_REL);
    expect(result?.specPath).toBe(SPEC_REL);
    expect(result?.specHash).toBe('a'.repeat(64));
    expect(result?.approvedBy).toBe('paul@harvest316.com');
    expect(result?.tier).toBe('T3');
    expect(result?.migrated).toBe(false);
  });

  it('readRecord on a legacy record normalizes baselineBlob to empty string (not undefined)', () => {
    // The in-memory ApprovalRecord has required baselineBlob: string.
    // readRecord MUST normalize absent → '' so the type contract holds in memory.
    writeSidecarRaw(SPEC_REL, legacyRecord);
    const result = readRecord(tmp, SPEC_REL) as ApprovalRecord;
    expect(result).not.toBeUndefined();
    expect(result.baselineBlob).toBe('');
  });

  it('readRecord on a legacy record normalizes reviewStart to undefined', () => {
    writeSidecarRaw(SPEC_REL, legacyRecord);
    const result = readRecord(tmp, SPEC_REL) as ApprovalRecord;
    expect(result).not.toBeUndefined();
    expect(result.reviewStart).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 back-compat: record with baselineBlob as a string is valid
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-1 — record with baselineBlob present as string is valid', () => {
  it('a 40-hex SHA as baselineBlob is accepted', () => {
    const sha = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
    writeSidecarRaw(SPEC_REL, { ...legacyRecord, baselineBlob: sha });
    const result = readRecord(tmp, SPEC_REL);
    expect(result).not.toBeUndefined();
    expect(result?.baselineBlob).toBe(sha);
  });

  it('the GZIP_MARKER sentinel as baselineBlob is accepted', () => {
    writeSidecarRaw(SPEC_REL, { ...legacyRecord, baselineBlob: 'gzip:fallback' });
    const result = readRecord(tmp, SPEC_REL);
    expect(result).not.toBeUndefined();
    expect(result?.baselineBlob).toBe('gzip:fallback');
  });

  it('an empty string as baselineBlob is accepted (no-M1-datapoint sentinel)', () => {
    writeSidecarRaw(SPEC_REL, { ...legacyRecord, baselineBlob: '' });
    const result = readRecord(tmp, SPEC_REL);
    expect(result).not.toBeUndefined();
    expect(result?.baselineBlob).toBe('');
  });

  it('reviewStart as a string is valid (M3 reserved field)', () => {
    writeSidecarRaw(SPEC_REL, {
      ...legacyRecord,
      baselineBlob: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
      reviewStart: '2026-06-27T10:00:00.000Z',
    });
    const result = readRecord(tmp, SPEC_REL);
    expect(result).not.toBeUndefined();
    expect(result?.reviewStart).toBe('2026-06-27T10:00:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 — non-string baselineBlob must be rejected (invalid sidecar)
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-1 — non-string baselineBlob is invalid (dropped as malformed)', () => {
  it('a numeric baselineBlob is rejected', () => {
    writeSidecarRaw(SPEC_REL, { ...legacyRecord, baselineBlob: 42 });
    const result = readRecord(tmp, SPEC_REL);
    expect(result).toBeUndefined();
  });

  it('a null baselineBlob is rejected', () => {
    writeSidecarRaw(SPEC_REL, { ...legacyRecord, baselineBlob: null });
    const result = readRecord(tmp, SPEC_REL);
    expect(result).toBeUndefined();
  });

  it('an object baselineBlob is rejected', () => {
    writeSidecarRaw(SPEC_REL, { ...legacyRecord, baselineBlob: { sha: 'x' } });
    const result = readRecord(tmp, SPEC_REL);
    expect(result).toBeUndefined();
  });

  it('a non-string reviewStart is rejected', () => {
    writeSidecarRaw(SPEC_REL, {
      ...legacyRecord,
      baselineBlob: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
      reviewStart: 12345,
    });
    const result = readRecord(tmp, SPEC_REL);
    expect(result).toBeUndefined();
  });
});
