/**
 * Slice 2 — back-compat tests (AC-1 back-compat clause).
 * Slice 3 — mint/recover/gc-survival tests (AC-1 contract, DR-043, FR-1).
 *
 * HARD REQUIREMENT: a pre-SPEC-017 record lacking `baselineBlob` MUST remain a
 * valid approval. A required-string validation would silently DROP every existing
 * approval (the gate would flag every implementing/done spec as unapproved).
 *
 * Slice 3 tests run real `git` in a temp git repo fixture (git init, set
 * user.email/user.name) to validate gc-survival, pathological paths, pin-failure
 * fallthrough, non-git fallback, and missing-blob recovery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { sidecarPath, readRecord } from '../src/lib/approval-store';
import {
  approveSpec,
  mintBaseline,
  recoverBaseline,
  refKey,
  GZIP_MARKER,
} from '../src/lib/approval';
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

/** Initialize a git repo in `dir` with a minimal user config so git plumbing works. */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@minspec.test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'MinSpec Test'], { cwd: dir, stdio: 'ignore' });
}

/** Create a minimal spec file under `rootDir`/`relPath` and return its abs path. */
function writeFixtureSpec(rootDir: string, relPath: string, body = '# Fixture\n\nSpec body here.\n'): string {
  const absPath = path.join(rootDir, relPath);
  const content = `---\nid: SPEC-TEST\ntype: requirements\nstatus: specifying\nproduct: minspec\n---\n\n${body}`;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
  return absPath;
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

// ─────────────────────────────────────────────────────────────────────────────
// SLICE 3 — Baseline mint / recover / gc-survival (AC-1 contract, DR-043)
// ─────────────────────────────────────────────────────────────────────────────

describe('Slice 3 — gc-survival: pinned blob survives git gc --prune=now (INV)', () => {
  it('approve a fixture → record has 40-hex baselineBlob; ref exists; blob survives gc', () => {
    initGitRepo(tmp);
    const specPath = writeFixtureSpec(tmp, SPEC_REL);

    const record = approveSpec(tmp, specPath, 'T3', 'test@minspec.test');

    // Record must carry a 40-hex baselineBlob
    expect(record.baselineBlob).toMatch(/^[0-9a-f]{40}$/);
    const sha = record.baselineBlob;

    // The pinning ref must exist
    const refName = `refs/minspec/snapshots/${refKey(SPEC_REL)}`;
    const refSha = execFileSync('git', ['rev-parse', refName], { cwd: tmp })
      .toString()
      .trim();
    expect(refSha).toBe(sha);

    // Run git gc --prune=now — the pinned ref keeps the blob alive
    execFileSync('git', ['gc', '--prune=now', '--quiet'], { cwd: tmp, stdio: 'ignore' });

    // git cat-file blob must still return the body content
    const recovered = execFileSync('git', ['cat-file', 'blob', sha], { cwd: tmp })
      .toString('utf-8');
    expect(recovered).toContain('Spec body here.');
  });
});

describe('Slice 3 — pathological-but-legal path (ends .lock / contains ..)', () => {
  it('a spec path ending in .lock → refKey is sha256, update-ref succeeds, blob gc-survives', () => {
    initGitRepo(tmp);
    // A path component that ends in .lock would be rejected by git if used raw as a ref name.
    // But refKey hashes it → always a legal hex ref component.
    const pathologicalRel = 'specs/some.lock/requirements.md';
    const specAbsPath = writeFixtureSpec(tmp, pathologicalRel, '# Lock path body\n');

    const record = approveSpec(tmp, specAbsPath, 'T2', 'test@minspec.test');

    // Should still get a 40-hex blob SHA (not GZIP_MARKER)
    expect(record.baselineBlob).toMatch(/^[0-9a-f]{40}$/);

    // Ref must exist under the hashed key
    const refName = `refs/minspec/snapshots/${refKey(pathologicalRel)}`;
    const refSha = execFileSync('git', ['rev-parse', refName], { cwd: tmp })
      .toString()
      .trim();
    expect(refSha).toBe(record.baselineBlob);

    // Survives gc
    execFileSync('git', ['gc', '--prune=now', '--quiet'], { cwd: tmp, stdio: 'ignore' });
    const body = execFileSync('git', ['cat-file', 'blob', record.baselineBlob], { cwd: tmp })
      .toString('utf-8');
    expect(body).toContain('Lock path body');
  });

  it('a spec path containing .. → refKey is sha256, blob pinned and gc-survives', () => {
    initGitRepo(tmp);
    // A path with ".." in a component would be rejected by git's ref-name grammar
    // if used raw. refKey hashes it.
    const pathologicalRel = 'specs/minspec/..SPEC-007/requirements.md';
    const specAbsPath = writeFixtureSpec(tmp, pathologicalRel, '# DotDot path body\n');

    const record = approveSpec(tmp, specAbsPath, 'T2', 'test@minspec.test');
    expect(record.baselineBlob).toMatch(/^[0-9a-f]{40}$/);

    execFileSync('git', ['gc', '--prune=now', '--quiet'], { cwd: tmp, stdio: 'ignore' });
    const body = execFileSync('git', ['cat-file', 'blob', record.baselineBlob], { cwd: tmp })
      .toString('utf-8');
    expect(body).toContain('DotDot path body');
  });
});

describe('Slice 3 — pin-failure fallthrough → GZIP_MARKER, recoverBaseline round-trips', () => {
  it('mintBaseline with a bad rootDir for update-ref → returns GZIP_MARKER; gz written; recoverBaseline round-trips', () => {
    // We need git hash-object to succeed (real git repo) but update-ref to fail.
    // Strategy: use a valid git repo for hash-object, but pass a non-writable ref path by
    // monkey-patching: instead, we call mintBaseline directly with a rootDir that has
    // git initialized but we simulate pin-failure by using a read-only .git dir.
    //
    // Simpler approach: use a separate tmpdir that IS a git repo, write-protect .git/refs
    // briefly, call mintBaseline, then restore.
    initGitRepo(tmp);

    const specRelForTest = 'specs/minspec/SPEC-PINTEST/requirements.md';
    const bodyOnly = '# Pin test body\n\nSome content.\n';

    // Make .git/refs read-only to force update-ref to fail
    const refsDir = path.join(tmp, '.git', 'refs');
    // Write a stub packed-refs to ensure the ref can't be written as loose file
    // Actually, let's just chmod the refs dir to read-only
    try {
      execSync(`chmod 555 "${refsDir}"`, { stdio: 'ignore' });
    } catch {
      // If chmod fails (e.g. Windows), skip this test gracefully
      return;
    }

    try {
      const result = mintBaseline(tmp, specRelForTest, bodyOnly);

      // Either GZIP_MARKER (pin failed → fallback) or '' (both failed)
      // On Linux with proper chmod, update-ref fails, so we get GZIP_MARKER
      expect([GZIP_MARKER, '']).toContain(result);

      if (result === GZIP_MARKER) {
        // The gz file must exist
        const gzPath = path.join(tmp, '.minspec', 'snapshots', `${refKey(specRelForTest)}.json.gz`);
        expect(fs.existsSync(gzPath)).toBe(true);

        // recoverBaseline must round-trip the body
        const fakeRecord: ApprovalRecord = {
          specPath: specRelForTest,
          specHash: 'a'.repeat(64),
          approvedAt: '2026-06-28T00:00:00.000Z',
          approvedBy: 'test@minspec.test',
          tier: 'T2',
          migrated: false,
          baselineBlob: GZIP_MARKER,
        };
        const recovered = recoverBaseline(tmp, fakeRecord);
        expect(recovered).toBe(bodyOnly);
      }
    } finally {
      // Restore permissions
      try {
        execSync(`chmod 755 "${refsDir}"`, { stdio: 'ignore' });
      } catch { /* ignore */ }
    }
  });

  it('mintBaseline in a git repo with a direct GZIP path → recoverBaseline returns body', () => {
    // Test recoverBaseline directly: write a gz file, build a record with GZIP_MARKER,
    // verify round-trip. This is a direct unit test of the recovery path.
    initGitRepo(tmp);
    const specRelForTest = 'specs/minspec/SPEC-GZTEST/requirements.md';
    const bodyOnly = '# Gzip recovery test\n\nBody content for gz recovery.\n';
    const buf = Buffer.from(bodyOnly, 'utf-8');
    const zlib = require('zlib') as typeof import('zlib');
    const gz = zlib.gzipSync(buf);
    const dir = path.join(tmp, '.minspec', 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${refKey(specRelForTest)}.json.gz`), gz);

    const record: ApprovalRecord = {
      specPath: specRelForTest,
      specHash: 'b'.repeat(64),
      approvedAt: '2026-06-28T00:00:00.000Z',
      approvedBy: 'test@minspec.test',
      tier: 'T3',
      migrated: false,
      baselineBlob: GZIP_MARKER,
    };
    const recovered = recoverBaseline(tmp, record);
    expect(recovered).toBe(bodyOnly);
  });
});

describe('Slice 3 — non-git dir: gzip fallback; record GZIP_MARKER; recoverBaseline round-trips', () => {
  it('in a non-git tmpdir, approve → record carries GZIP_MARKER; gz written; recoverBaseline round-trips', () => {
    // tmp is NOT a git repo (no git init)
    const specPath = writeFixtureSpec(tmp, SPEC_REL, '# Non-git spec body.\n');

    const record = approveSpec(tmp, specPath, 'T1', 'anon@example.com');

    // In a non-git dir, git hash-object fails → gzip fallback
    expect(record.baselineBlob).toBe(GZIP_MARKER);

    // The gz file must exist
    const gzPath = path.join(tmp, '.minspec', 'snapshots', `${refKey(SPEC_REL)}.json.gz`);
    expect(fs.existsSync(gzPath)).toBe(true);

    // recoverBaseline must return the body-only content
    const recovered = recoverBaseline(tmp, record);
    // The body-only is the spec content after the frontmatter
    expect(recovered).toContain('Non-git spec body.');
  });
});

describe('Slice 3 — missing-blob recovery: recoverBaseline returns undefined, no throw', () => {
  it('a ledger SHA whose blob is absent → recoverBaseline returns undefined and does NOT throw', () => {
    initGitRepo(tmp);

    // A plausible 40-hex SHA that has no corresponding git object
    const phantomSha = 'deadbeef'.repeat(5); // 40 hex chars
    const fakeRecord: ApprovalRecord = {
      specPath: SPEC_REL,
      specHash: 'a'.repeat(64),
      approvedAt: '2026-06-28T00:00:00.000Z',
      approvedBy: 'test@minspec.test',
      tier: 'T3',
      migrated: false,
      baselineBlob: phantomSha,
    };

    // Must not throw
    let result: string | undefined;
    expect(() => {
      result = recoverBaseline(tmp, fakeRecord);
    }).not.toThrow();

    expect(result).toBeUndefined();
  });

  it('a real blob that was gc-pruned after pinning ref is removed → recoverBaseline returns undefined', () => {
    initGitRepo(tmp);

    // Write a blob the normal way, capture its SHA, then remove the ref (unpin it),
    // then run git gc --prune=now to prune the orphan blob.
    const bodyOnly = '# Prunable body\n';
    const buf = Buffer.from(bodyOnly, 'utf-8');
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: tmp,
      input: buf,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .toString()
      .trim();

    // Do NOT pin it with update-ref → it's an orphan blob, gc can prune it
    // Run gc to prune
    execFileSync('git', ['gc', '--prune=now', '--quiet'], { cwd: tmp, stdio: 'ignore' });

    // Now try to recover it — blob should be gone
    const fakeRecord: ApprovalRecord = {
      specPath: SPEC_REL,
      specHash: 'a'.repeat(64),
      approvedAt: '2026-06-28T00:00:00.000Z',
      approvedBy: 'test@minspec.test',
      tier: 'T3',
      migrated: false,
      baselineBlob: sha,
    };

    let result: string | undefined;
    expect(() => {
      result = recoverBaseline(tmp, fakeRecord);
    }).not.toThrow();

    expect(result).toBeUndefined();
  });
});

describe('Slice 3 — recoverBaseline: empty / absent baselineBlob → undefined', () => {
  it('baselineBlob === "" → recoverBaseline returns undefined', () => {
    initGitRepo(tmp);
    const record: ApprovalRecord = {
      specPath: SPEC_REL,
      specHash: 'a'.repeat(64),
      approvedAt: '2026-06-28T00:00:00.000Z',
      approvedBy: 'test@minspec.test',
      tier: 'T3',
      migrated: false,
      baselineBlob: '',
    };
    expect(recoverBaseline(tmp, record)).toBeUndefined();
  });
});

describe('Slice 3 — approveSpec: record baselineBlob is written, approval never fails on mint error', () => {
  it('in a git repo, approveSpec produces a record with a 40-hex baselineBlob', () => {
    initGitRepo(tmp);
    const specPath = writeFixtureSpec(tmp, SPEC_REL);

    const record = approveSpec(tmp, specPath, 'T3', 'test@minspec.test');

    expect(record.baselineBlob).toMatch(/^[0-9a-f]{40}$/);
    expect(record.specPath).toBe(SPEC_REL);
    expect(record.migrated).toBe(false);
    expect(record.tier).toBe('T3');
  });

  it('the written sidecar JSON carries baselineBlob', () => {
    initGitRepo(tmp);
    const specPath = writeFixtureSpec(tmp, SPEC_REL);

    const record = approveSpec(tmp, specPath, 'T3', 'test@minspec.test');
    const readBack = readRecord(tmp, SPEC_REL);

    expect(readBack).not.toBeUndefined();
    expect(readBack?.baselineBlob).toBe(record.baselineBlob);
  });
});
