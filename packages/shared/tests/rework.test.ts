/**
 * T0/T1 — `reworkPct` METRIC v1 lock (SPEC-017 Slice 1; FR-2, FR-4, FR-12, AC-2,
 * AC-3 metric-side; INV — Deterministic).
 *
 * `reworkPct(baselineBody, currentBody)` = changed chars ÷ max(len), where
 * `changed = max(len) − LCS-SUBSEQUENCE length` (standard O(n·m) DP). These cases
 * are the frozen lock — they pin the algorithm so a future "optimisation" cannot
 * silently re-compute every historical number (Costly #3).
 *
 * THE HARD INVARIANT (T0): reworkPct("abcde","abXde") === 0.2 exactly.
 *   LCS("abcde","abXde") = "abde" (length 4); changed = 5 − 4 = 1 ⇒ 1/5 = 0.2.
 *   A longest-common-SUBSTRING impl gives "ab"/"de" = 2 ⇒ 5 − 2 = 3 ⇒ 3/5 = 0.6,
 *   which MUST fail this test.
 *
 * Determinism + purity: recompute twice ⇒ identical; no `vscode` import anywhere
 * in the metric's module graph.
 */

import { describe, it, expect } from 'vitest';
import { reworkPct } from '@aiclarity/shared';

describe('reworkPct — METRIC v1 lock (AC-2)', () => {
  it('HARD INVARIANT: reworkPct("abcde","abXde") === 0.2 (LCS-subsequence, NOT substring)', () => {
    // LCS-subsequence = "abde" (4) ⇒ changed = 5 − 4 = 1 ⇒ 1/5 = 0.2 exactly.
    // A longest-common-SUBSTRING impl yields 3/5 = 0.6 and fails here.
    expect(reworkPct('abcde', 'abXde')).toBe(0.2);
  });

  it('exact 1/5 — guards against floating drift', () => {
    expect(reworkPct('abcde', 'abXde')).toBe(1 / 5);
  });

  it('identical bodies ⇒ 0 (re-approval with no edit is not rework)', () => {
    expect(reworkPct('the same body', 'the same body')).toBe(0);
    expect(reworkPct('', '')).toBe(0);
  });

  it('empty body (max length 0) ⇒ 0 (denom guard, no div-by-zero)', () => {
    expect(reworkPct('', '')).toBe(0);
  });

  it('frontmatter-only flip ⇒ 0 — bodies are identical, so no rework', () => {
    // `getSpecBodyOnly` excludes ALL frontmatter, so a status:/phases: flip leaves
    // the body bytes unchanged. The metric sees two identical body strings ⇒ 0.
    const bodyBefore = '# Title\n\nThe prose the human reviewed.\n';
    const bodyAfter = '# Title\n\nThe prose the human reviewed.\n';
    expect(reworkPct(bodyBefore, bodyAfter)).toBe(0);
  });

  it('totally different bodies of equal length ⇒ near-total rework', () => {
    // LCS("aaaa","bbbb") = 0 ⇒ changed = 4 ⇒ 4/4 = 1.
    expect(reworkPct('aaaa', 'bbbb')).toBe(1);
  });

  it('pure insertion — denom is max(len)', () => {
    // baseline "abc" (3), current "abcdef" (6); LCS = "abc" (3) ⇒ changed = 6−3 = 3
    // ⇒ 3/6 = 0.5.
    expect(reworkPct('abc', 'abcdef')).toBe(0.5);
  });

  it('pure deletion is symmetric in denominator', () => {
    // baseline "abcdef" (6), current "abc" (3); LCS = 3 ⇒ changed = 6−3 = 3 ⇒ 3/6 = 0.5.
    expect(reworkPct('abcdef', 'abc')).toBe(0.5);
  });

  it('result is always within [0,1]', () => {
    for (const [a, b] of [
      ['abcde', 'abXde'],
      ['aaaa', 'bbbb'],
      ['abc', 'abcdef'],
      ['hello world', 'hella warld'],
      ['', 'nonempty'],
    ] as const) {
      const r = reworkPct(a, b);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
  });

  it('INV — Deterministic: recompute twice from the same strings ⇒ identical number', () => {
    const a = 'The quick brown fox jumps over the lazy dog.';
    const b = 'The quick brown cat jumps over the lazy dog!';
    const first = reworkPct(a, b);
    const second = reworkPct(a, b);
    expect(second).toBe(first);
  });

  it('FR-12 purity: the metric module graph imports no `vscode`', async () => {
    // Importing the barrel must not pull in a `vscode` stub; if it did, this import
    // would resolve a `vscode` module that does not exist outside the extension host.
    const mod = await import('@aiclarity/shared');
    expect(typeof mod.reworkPct).toBe('function');
    // The function source must contain no reference to vscode (pure string math).
    expect(mod.reworkPct.toString()).not.toContain('vscode');
  });
});
