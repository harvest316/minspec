/**
 * SPEC-017 Slice 4 — M1 glue: `computeSpecRework` (FR-2, FR-3, FR-4, FR-12).
 *
 * `vscode`-free glue layer: git/fs reads live here; pure math stays in
 * `@aiclarity/shared`. Composes:
 *   - `getApprovalRecord`   — reads the committed approval sidecar
 *   - `recoverBaseline`     — recovers the FR-4 body-only baseline string
 *   - `getSpecBodyOnly`     — extracts the body of the current on-disk spec
 *   - `reworkPct`           — pure char-delta ÷ max(len) metric (METRIC v1)
 *
 * INV — Deterministic: same inputs (spec file, ledger) ⇒ same output number.
 * INV — Non-destructive: reads only, writes nothing.
 */

import * as fs from 'fs';
import { reworkPct, getSpecBodyOnly } from '@aiclarity/shared';
import { getApprovalRecord, recoverBaseline, specRelPath } from './approval';
import type { SpecStatus } from './spec';

/**
 * Compute the M1 char-rework percentage for a spec relative to its approved
 * baseline.
 *
 * Returns:
 *   - `number` in [0, 1]  — share of body chars that changed since the last
 *     approval (per METRIC v1 in `rework.ts`).
 *   - `undefined`         — no datapoint. Reasons:
 *       • No approval record exists (spec was never approved).
 *       • `baselineBlob` is absent or `''` (legacy record, or both mint paths
 *         failed — see SPEC-017 §Data model back-compat).
 *       • `recoverBaseline` returned `undefined` (blob gone / unrecoverable).
 *       • The spec file is unreadable.
 *
 * The "current" side is the on-disk body at call time (FR-2: file is the
 * source of truth). A first-ever approval has no PRIOR baseline to diff against
 * — `baselineBlob` will be `''` only if both mint paths failed; the normal case
 * is that the record exists with a fresh blob, and the NEXT approval will diff
 * against it. However, if this function is called AFTER the approval in the
 * same session with the same file content, reworkPct will be 0 (no diff yet
 * vs the just-minted baseline). The "first-ever / no prior review" edge in
 * AC-2 means a missing/empty baseline (before the first approval) → `undefined`.
 *
 * NEVER throws. Any error degrades to `undefined` (INV — Deterministic).
 */
export function computeSpecRework(
  rootDir: string,
  specFilePath: string,
): number | undefined {
  // 1. Fetch the committed approval record.
  let record;
  try {
    record = getApprovalRecord(rootDir, specFilePath);
  } catch {
    return undefined;
  }
  if (!record) return undefined; // no approval → no datapoint

  // 2. baselineBlob absent or '' → no prior baseline → no datapoint (AC-2, back-compat).
  if (!record.baselineBlob || record.baselineBlob === '') return undefined;

  // 3. Recover the baseline body string from the ledger pointer.
  let baselineBody: string | undefined;
  try {
    baselineBody = recoverBaseline(rootDir, record);
  } catch {
    return undefined; // recoverBaseline is documented never-throw, but belt-and-suspenders
  }
  if (baselineBody === undefined) return undefined; // blob gone / unrecoverable → no datapoint

  // 4. Read the current on-disk body (the file is the source of truth — FR-2, AC-3).
  let currentBody: string;
  try {
    currentBody = getSpecBodyOnly(fs.readFileSync(specFilePath, 'utf-8'));
  } catch {
    return undefined; // file unreadable → no datapoint
  }

  // 5. Pure reworkPct — same inputs always produce the same number (INV — Deterministic).
  return reworkPct(baselineBody, currentBody);
}

// ─────────────────────────────────────────────────────────────────────────────
// SPEC-017 Slice 5 — M2: superseded "wasted review" bar (FR-6, AC-5).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One bar in the M2 "wasted review" chart: the chars a human reviewed and
 * approved for a spec that was later WHOLLY REPLACED (`status: superseded`), and
 * thus thrown away. `specPath` is the repo-relative POSIX spec path (the ledger
 * key); `approvedChars` is the length of the approved body at approval time.
 */
export interface WastedBar {
  readonly specPath: string;
  readonly approvedChars: number;
}

/**
 * Minimal structural view of a spec needed to compute the wasted-review bar.
 * `SpecSummary` (and any richer summary) satisfies this — kept narrow so this
 * `vscode`-free module never depends on the tree/summary construction layer.
 */
export interface WastedReviewSpec {
  readonly status: SpecStatus;
  /** Absolute on-disk path users open (`SpecSummary.filePath`). */
  readonly filePath: string;
}

/**
 * M2 — compute the wasted-review bars: for each SUPERSEDED spec, the number of
 * chars that were approved at approval time (now thrown away by the wholesale
 * replacement). FR-6: this is a SEPARATE bar — it is NEVER folded into any M1
 * (`computeSpecRework`) denominator.
 *
 * The approved-char count is read from the spec's PRIOR `baselineBlob` body
 * length, recovered via `getApprovalRecord` + `recoverBaseline`. That baseline is
 * preserved by the content-addressed blob + ref + committed ledger SHA
 * INDEPENDENTLY of approval freshness — so even though writing `superseded-by:`
 * is a canonical content change that VOIDS (stales) the live approval (SPEC-022),
 * the prior approved-char figure still surfaces correctly. This function does NOT
 * read or require a fresh `approved` verdict; it reads the surviving baseline.
 *
 * A spec superseded BEFORE it was ever approved (no record / no `baselineBlob` /
 * unrecoverable blob) contributes `approvedChars: 0` — no phantom waste, never a
 * negative or fabricated figure.
 *
 * Non-superseded specs are skipped entirely (no bar). NEVER throws — any per-spec
 * recovery error degrades that spec to `0`.
 */
export function computeWastedReview(
  rootDir: string,
  specs: readonly WastedReviewSpec[],
): WastedBar[] {
  const bars: WastedBar[] = [];
  for (const spec of specs) {
    if (spec.status !== 'superseded') continue; // only wholly-replaced specs waste review

    const specPath = specRelPath(rootDir, spec.filePath);
    let approvedChars = 0;

    // Read the PRIOR approved baseline length — preserved independently of approval
    // freshness. No record / absent-or-empty baselineBlob / unrecoverable ⇒ 0
    // (superseded-before-approved, or both mint paths failed) — no phantom waste.
    let record;
    try {
      record = getApprovalRecord(rootDir, spec.filePath);
    } catch {
      record = undefined;
    }
    if (record && record.baselineBlob && record.baselineBlob !== '') {
      let baselineBody: string | undefined;
      try {
        baselineBody = recoverBaseline(rootDir, record);
      } catch {
        baselineBody = undefined; // documented never-throw; belt-and-suspenders
      }
      if (baselineBody !== undefined) approvedChars = baselineBody.length;
    }

    bars.push({ specPath, approvedChars });
  }
  return bars;
}
