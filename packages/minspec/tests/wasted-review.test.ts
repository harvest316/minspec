/**
 * SPEC-017 Slice 5 — M2 wasted-review bar tests for `computeWastedReview`
 * (FR-6, AC-5).
 *
 * Uses a real git repo in a tmp dir (mirrors trust-metrics.test.ts / Slice 3) so
 * the baseline mint + recover round-trip is exercised end-to-end.
 *
 * AC-5 coverage:
 *   - Supersede an APPROVED fixture → its approved chars appear in
 *     `computeWastedReview`, and are NOT folded into any M1 (`computeSpecRework`)
 *     denominator (the two are independent surfaces).
 *   - Supersession adds `superseded-by:` (a canonical content field) → the LIVE
 *     approval goes STALE, YET wasted-review still reports the PRIOR `approvedChars`
 *     read from the preserved baseline (independent of approval freshness).
 *   - A spec superseded BEFORE it was ever approved ⇒ `approvedChars: 0` (no
 *     phantom waste).
 *   - Non-superseded specs contribute no bar.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  approveSpec,
  getApprovalStatus,
  recoverBaseline,
  getApprovalRecord,
} from '../src/lib/approval';
import { computeSpecRework, computeWastedReview } from '../src/lib/trust-metrics';
import type { WastedReviewSpec } from '../src/lib/trust-metrics';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-wasted-review-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@minspec.test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'MinSpec Test'], { cwd: dir, stdio: 'ignore' });
}

/** Frontmatter + body. `status` and optional `superseded-by` are interpolated. */
function specContent(status: string, body: string, supersededBy?: string): string {
  const sb = supersededBy ? `superseded-by: ${supersededBy}\n` : '';
  return `---\nid: SPEC-017-OLD\ntype: requirements\nstatus: ${status}\n${sb}product: minspec\n---\n\n${body}`;
}

function writeSpecFile(rootDir: string, relPath: string, content: string): string {
  const absPath = path.join(rootDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
  return absPath;
}

const SPEC_REL = 'specs/minspec/SPEC-017-old/requirements.md';

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 — approved-then-superseded: approved chars surface; NOT in M1 denominator;
// supersession stales the live approval yet wasted-review still reports prior chars.
// ─────────────────────────────────────────────────────────────────────────────

describe('computeWastedReview — AC-5: approved-then-superseded', () => {
  it('reports the prior approved chars even though supersession STALED the live approval', () => {
    initGitRepo(tmp);
    const body = 'The fully reviewed and approved spec body.\n';
    const specPath = writeSpecFile(tmp, SPEC_REL, specContent('implementing', body));

    // 1. Approve while live — mints the body-only baseline.
    approveSpec(tmp, specPath, 'T3', 'test@minspec.test');
    expect(getApprovalStatus(tmp, specPath)).toBe('approved');

    // Capture the approved-char count from the preserved baseline (ground truth).
    const record = getApprovalRecord(tmp, specPath);
    expect(record).toBeDefined();
    const baselineBody = recoverBaseline(tmp, record!);
    expect(baselineBody).toBeDefined();
    const approvedChars = baselineBody!.length;
    expect(approvedChars).toBeGreaterThan(0);

    // 2. Supersede: write `status: superseded` + a `superseded-by:` successor ref.
    //    `superseded-by` is a canonical content field → it changes the canonical
    //    hash → the live approval goes STALE.
    fs.writeFileSync(specPath, specContent('superseded', body, 'SPEC-017'), 'utf-8');
    expect(getApprovalStatus(tmp, specPath)).toBe('stale'); // supersession voided the live approval

    // 3. Wasted-review STILL reports the prior approvedChars — read from the
    //    PRESERVED baseline, independent of the now-stale approval.
    const specs: WastedReviewSpec[] = [{ status: 'superseded', filePath: specPath }];
    const bars = computeWastedReview(tmp, specs);
    expect(bars).toHaveLength(1);
    expect(bars[0].specPath).toBe(SPEC_REL);
    expect(bars[0].approvedChars).toBe(approvedChars);
    expect(bars[0].approvedChars).toBeGreaterThan(0);
  });

  it('the wasted chars are NOT folded into any M1 (computeSpecRework) denominator', () => {
    initGitRepo(tmp);
    const body = 'Approved body that will be wasted on supersession.\n';
    const specPath = writeSpecFile(tmp, SPEC_REL, specContent('implementing', body));

    approveSpec(tmp, specPath, 'T3', 'test@minspec.test');
    // M1 on the unchanged body == 0 (no rework yet) — a concrete, separate number.
    expect(computeSpecRework(tmp, specPath)).toBe(0);

    // Supersede.
    fs.writeFileSync(specPath, specContent('superseded', body, 'SPEC-017'), 'utf-8');

    const wasted = computeWastedReview(tmp, [{ status: 'superseded', filePath: specPath }]);
    const m1 = computeSpecRework(tmp, specPath);

    // M2 is a CHAR COUNT (≫ 1); M1 is a fraction in [0,1]. They are different
    // surfaces — the wasted chars are never summed into the M1 denominator.
    expect(wasted[0].approvedChars).toBeGreaterThan(1);
    // M1 stays a bounded fraction (now non-zero: superseded-by changed the body's
    // surrounding frontmatter only, but the on-disk BODY is unchanged → still 0).
    expect(m1).toBe(0);
    // The two numbers are independent: M2's char count is not M1's denominator.
    expect(wasted[0].approvedChars).not.toBe(m1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 — superseded BEFORE ever approved ⇒ 0 (no phantom waste).
// ─────────────────────────────────────────────────────────────────────────────

describe('computeWastedReview — AC-5: superseded-before-approved ⇒ 0', () => {
  it('a superseded spec with no approval record contributes approvedChars: 0', () => {
    initGitRepo(tmp);
    const specPath = writeSpecFile(
      tmp,
      SPEC_REL,
      specContent('superseded', 'Never reviewed, straight to superseded.\n', 'SPEC-017'),
    );
    // No approveSpec call → no record at all.
    expect(getApprovalRecord(tmp, specPath)).toBeUndefined();

    const bars = computeWastedReview(tmp, [{ status: 'superseded', filePath: specPath }]);
    expect(bars).toHaveLength(1);
    expect(bars[0].approvedChars).toBe(0); // no phantom waste
  });

  it('a superseded spec whose baseline blob is unrecoverable contributes 0, no throw', () => {
    initGitRepo(tmp);
    const specPath = writeSpecFile(tmp, SPEC_REL, specContent('superseded', 'Body.\n', 'SPEC-017'));

    // Approve while live (creates the proper sidecar via the real store keying),
    // then corrupt its baselineBlob to a phantom SHA so recovery fails.
    fs.writeFileSync(specPath, specContent('implementing', 'Body.\n'), 'utf-8');
    approveSpec(tmp, specPath, 'T3', 'test@minspec.test');
    fs.writeFileSync(specPath, specContent('superseded', 'Body.\n', 'SPEC-017'), 'utf-8');

    const rec = getApprovalRecord(tmp, specPath)!;
    // Rewrite the sidecar with a phantom 40-hex SHA (blob does not exist).
    const phantom = 'deadbeef'.repeat(5);
    const corrupted = { ...rec, baselineBlob: phantom };
    // Find the sidecar file and overwrite it.
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    const sidecarFile = walk(path.join(tmp, '.minspec')).find((p) => p.endsWith('.json'));
    expect(sidecarFile).toBeDefined();
    fs.writeFileSync(sidecarFile!, JSON.stringify(corrupted, null, 2) + '\n', 'utf-8');

    let bars: ReturnType<typeof computeWastedReview> | undefined;
    expect(() => { bars = computeWastedReview(tmp, [{ status: 'superseded', filePath: specPath }]); }).not.toThrow();
    expect(bars).toHaveLength(1);
    expect(bars![0].approvedChars).toBe(0); // unrecoverable → 0, no throw
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-superseded specs contribute no bar.
// ─────────────────────────────────────────────────────────────────────────────

describe('computeWastedReview — only superseded specs produce bars', () => {
  it('skips non-superseded specs entirely', () => {
    initGitRepo(tmp);
    const specPath = writeSpecFile(tmp, SPEC_REL, specContent('implementing', 'Active body.\n'));
    approveSpec(tmp, specPath, 'T3', 'test@minspec.test');

    const specs: WastedReviewSpec[] = [
      { status: 'implementing', filePath: specPath },
      { status: 'done', filePath: specPath },
      { status: 'new', filePath: specPath },
      { status: 'archived', filePath: specPath },
    ];
    const bars = computeWastedReview(tmp, specs);
    expect(bars).toHaveLength(0); // none are superseded
  });

  it('mixes: only the superseded entry yields a bar', () => {
    initGitRepo(tmp);
    const activePath = writeSpecFile(tmp, 'specs/minspec/SPEC-A/requirements.md', specContent('implementing', 'Active.\n'));
    const oldPath = writeSpecFile(tmp, SPEC_REL, specContent('implementing', 'Reviewed body.\n'));
    approveSpec(tmp, oldPath, 'T3', 'test@minspec.test');
    fs.writeFileSync(oldPath, specContent('superseded', 'Reviewed body.\n', 'SPEC-A'), 'utf-8');

    const specs: WastedReviewSpec[] = [
      { status: 'implementing', filePath: activePath },
      { status: 'superseded', filePath: oldPath },
    ];
    const bars = computeWastedReview(tmp, specs);
    expect(bars).toHaveLength(1);
    expect(bars[0].specPath).toBe(SPEC_REL);
    expect(bars[0].approvedChars).toBeGreaterThan(0);
  });
});
