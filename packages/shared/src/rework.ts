/**
 * SPEC-017 M1 — char-level rework metric (FR-2, FR-12). Pure string → number,
 * Tier-0: no `vscode`, no network, ZERO new dependency (the diff is vendored).
 *
 * `reworkPct(baselineBody, currentBody)` = share of the body that changed between
 * the approved baseline and the current body, in [0, 1]. The "current" and
 * "baseline" strings are the FR-4 body-only bytes (frontmatter excluded) — the
 * caller passes `getSpecBodyOnly(raw)` for each.
 */

/**
 * FR-2: share of approved-body chars that differ from the baseline.
 * changed chars ÷ max(approvedChars, currentChars). Char-level (CONFIRMED).
 * Range [0,1]; 0 when identical OR when max length is 0 (empty body).
 */
export function reworkPct(baselineBody: string, currentBody: string): number {
  const denom = Math.max(baselineBody.length, currentBody.length);
  if (denom === 0) return 0; // empty body → no div-by-zero (FR-2 edge)
  return charDelta(baselineBody, currentBody) / denom;
}

/**
 * METRIC v1 — DO NOT change without a full re-baseline of every historical
 * number. changed = max(len) − LCS-SUBSEQUENCE length, standard O(n·m) DP.
 *
 * Worked AC-2 lock: LCS("abcde","abXde") = "abde" (length 4);
 *   changed = max(5,5) − 4 = 1 ⇒ reworkPct = 1/5 = 0.2.  (longest common
 *   SUBSTRING/run would give "ab"/"de" = 2 ⇒ 5 − 2 = 3 ⇒ 3/5 = 0.6 — WRONG,
 *   breaks AC-2. A two-pointer/contiguous-run scan computes substring, not
 *   subsequence; the O(n·m) DP below is required and is what ships.)
 */
function charDelta(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  // DP over the LCS subsequence, rolling two rows to keep memory O(m).
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1] + 1
          : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[m];
  return Math.max(n, m) - lcs; // changed chars
}
