/**
 * INV — Non-destructive: approving a spec MUST write zero spec bytes and MUST NOT
 * change the spec's `specHash`.
 *
 * The baseline lives in git objects / `.minspec/snapshots/` / the sidecar
 * `.minspec/approvals/<path>.json` — never in the spec file itself.
 *
 * Opening the trust dashboard (reading the spec + ledger) also MUST NOT mutate
 * any spec byte or invalidate any approval (FR-11, INV — Non-destructive, AC-9).
 *
 * Tests in this file cover:
 *   - Slice 3: approveSpec writes no spec bytes; specHash unchanged before/after.
 *   - Slice 6 (placeholder): TrustChartModel build is read-only (added in Slice 6).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { approveSpec, canonicalSpecHash } from '../src/lib/approval';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-nondestructive-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Initialize a git repo in `dir` with minimal user config. */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@minspec.test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'MinSpec Test'], { cwd: dir, stdio: 'ignore' });
}

/** Write a fixture spec file and return its absolute path and original bytes. */
function writeFixtureSpec(
  rootDir: string,
  relPath: string,
  body = '# Fixture\n\nOriginal spec body — must not change after approve.\n',
): { absPath: string; originalBytes: Buffer } {
  const absPath = path.join(rootDir, relPath);
  const content = `---\nid: SPEC-TEST\ntype: requirements\nstatus: specifying\nproduct: minspec\n---\n\n${body}`;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
  return { absPath, originalBytes: Buffer.from(content, 'utf-8') };
}

const SPEC_REL = 'specs/minspec/SPEC-007-foo/requirements.md';

// ─────────────────────────────────────────────────────────────────────────────
// Slice 3 — Non-destructive: approveSpec writes NO spec bytes
// ─────────────────────────────────────────────────────────────────────────────

describe('INV — Non-destructive: approveSpec writes no spec bytes (Slice 3)', () => {
  it('spec file bytes are byte-identical before and after approveSpec (git repo)', () => {
    initGitRepo(tmp);
    const { absPath, originalBytes } = writeFixtureSpec(tmp, SPEC_REL);

    approveSpec(tmp, absPath, 'T3', 'test@minspec.test');

    const afterBytes = fs.readFileSync(absPath);
    expect(afterBytes.equals(originalBytes)).toBe(true);
  });

  it('spec file bytes are byte-identical before and after approveSpec (non-git dir)', () => {
    // tmp is NOT a git repo — gzip fallback path; still must not touch spec bytes
    const { absPath, originalBytes } = writeFixtureSpec(tmp, SPEC_REL);

    approveSpec(tmp, absPath, 'T2', 'anon@example.com');

    const afterBytes = fs.readFileSync(absPath);
    expect(afterBytes.equals(originalBytes)).toBe(true);
  });

  it('specHash (canonical hash) is identical before and after approveSpec', () => {
    initGitRepo(tmp);
    const { absPath } = writeFixtureSpec(tmp, SPEC_REL);

    const hashBefore = canonicalSpecHash(absPath);
    expect(hashBefore).not.toBeNull();

    approveSpec(tmp, absPath, 'T3', 'test@minspec.test');

    const hashAfter = canonicalSpecHash(absPath);
    expect(hashAfter).toBe(hashBefore);
  });

  it('approveSpec does not create or modify any file under the spec dir (only .minspec/)', () => {
    initGitRepo(tmp);
    const { absPath } = writeFixtureSpec(tmp, SPEC_REL);

    // Snapshot files under the spec's directory before approve
    const specDir = path.dirname(absPath);
    const filesBefore = fs.readdirSync(specDir).sort();

    approveSpec(tmp, absPath, 'T3', 'test@minspec.test');

    const filesAfter = fs.readdirSync(specDir).sort();
    expect(filesAfter).toEqual(filesBefore);
  });

  it('baseline lives in .minspec/snapshots or git objects — never in the spec file', () => {
    initGitRepo(tmp);
    const { absPath, originalBytes } = writeFixtureSpec(tmp, SPEC_REL);

    const record = approveSpec(tmp, absPath, 'T3', 'test@minspec.test');

    // baselineBlob must be non-empty (either SHA or GZIP_MARKER)
    expect(record.baselineBlob).not.toBe('');

    // Spec bytes still untouched
    const afterBytes = fs.readFileSync(absPath);
    expect(afterBytes.equals(originalBytes)).toBe(true);

    // The sidecar lives in .minspec/approvals/, NOT in the spec dir
    const sidecarDir = path.join(tmp, '.minspec', 'approvals');
    expect(fs.existsSync(sidecarDir)).toBe(true);
  });
});
