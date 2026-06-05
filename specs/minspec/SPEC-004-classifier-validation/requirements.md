---
id: SPEC-004
type: requirements
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: implementing  # harness built + run (n=120, κ=0.80); findings in tasks.md drove DR-021/022/024
product: minspec
tier: T3
epic: EPIC-004  # Classifier Validation
---

# MinSpec — Classifier Validation Harness (Requirements)

**Date:** 2026-05-29 · updated 2026-06-01
**Status:** Implementing — harness built + run; findings recorded in [tasks.md](tasks.md#findings).
**Triggered by:** session request — validate classifier on real-world issue→PR data
**Related:** [classifier.ts](../../../packages/minspec/src/lib/classifier.ts), [DR-009](../../../docs/decisions/DR-009.md)
**Outcome:** [DR-021](../../../docs/decisions/DR-021.md) (reframe to scope + upward-only ratchet) · [DR-024](../../../docs/decisions/DR-024.md) (tier → derived label, reach axis gated)

---

## Problem

The tier classifier ([classifier.ts](../../../packages/minspec/src/lib/classifier.ts))
is currently validated only by synthetic unit tests
([classifier.test.ts](../../../packages/minspec/tests/classifier.test.ts)).
We have no evidence it predicts sensible tiers on **real** code changes. Without
real-diff validation we cannot calibrate thresholds (file-count / line-count /
file-type tiers in [git-analyzer.ts](../../../packages/minspec/src/lib/git-analyzer.ts))
with confidence.

> **Outcome (resolved 2026-06-01).** The harness ran (n=120, 11 repos; size-blind
> consensus labels, Fleiss κ=0.80). It found the classifier measures **mechanical
> scope, not cognitive difficulty** — exact 34.2% / adjacent 86.7%, never over-tiers
> (predicted tier is a 100%-precise lower bound) but systematically under-tiers subtle
> small fixes. **Tuning thresholds cannot fix this** — size-identical diffs differ in
> difficulty, so the "calibrate thresholds" framing above is *measured and rejected*.
> Remediation moved to [DR-021](../../../docs/decisions/DR-021.md) (reframe to scope +
> upward-only ratchet) and [DR-022](../../../docs/decisions/DR-022.md)/[DR-024](../../../docs/decisions/DR-024.md)
> (reach axis; tier → derived label). Full analysis: [tasks.md](tasks.md#findings).

## Goal

A repeatable, **offline-by-default** test harness that:
1. Runs the real analyzer → classifier path on real GitHub issue→PR diffs.
2. Compares predicted tier against a hand-labelled expected tier.
3. Reports per-instance results + aggregate accuracy.

Data source: **SWE-bench-Verified** (500 human-vetted issue→PR pairs, each with a
gold patch and problem statement).

## Functional Requirements

- **FR-1 — Fetch (out-of-tree).** A standalone download script fetches a curated
  subset of SWE-bench-Verified into a **gitignored** directory. Nothing fetched is
  committed. The script is the only component permitted to touch the network.
- **FR-2 — Fixture shape + labelling protocol.** Each instance is normalised to
  `{ instanceId, patch, problemStatement, expectedTier }`. `expectedTier` (T1–T4) is a
  **size-blind consensus label**: majority vote of 3 independent blind LLM raters
  judging the *problem statement only* (no diff, no line counts) + 1 human on the
  overlap, with **Fleiss κ reported** (achieved κ=0.80, 22/120 split votes recorded).
  Labels are committed keyed by `instanceId`
  ([labels.json](../../../scripts/classifier-validation/labels.json)); patches are not.
  Size-blind labelling is load-bearing: labelling from the diff makes the test circular
  against a size-based classifier (Run A scored 95.8% by construction — see tasks.md).
- **FR-3 — Real path reuse.** For each instance the harness applies `patch` to a
  temporary git repo, stages it, and calls the real `analyzeGitDiff()` →
  `classify()`. No reimplementation of analyzer logic in the harness.
- **FR-4 — Report.** Output per-instance `{ instanceId, expectedTier,
  predictedTier, confidence, match }` plus aggregate accuracy and a confusion
  matrix (expected × predicted).
- **FR-5 — Graceful skip.** If the gitignored data dir is absent (fresh clone, CI
  without network), the harness test **skips** rather than fails. Offline
  developers are never blocked.

## Non-Functional Requirements

- **NFR-1 — Determinism.** Same fixtures + same labels → same report. No network at
  run time (only the separate fetch script hits the network).
- **NFR-2 — Proportional ceremony.** Subset ~50–120 instances, not all 500 (run: 120
  across 11 repos). Enough for a meaningful accuracy signal, cheap to label and run.
  **Known corpus gap:** SWE-bench-Verified is single-PR bug fixes → **zero true-T4**
  (architectural) instances; the T4 row/column is unexercised and the T3 boundary is
  sparse (only 4 predicted ≥T3). Conclusions are firm for T1–T2; T3+ need a different
  corpus.

## Costly to Refactor (Zone A)

Ranked seams where a wrong choice is expensive to walk back later:

1. **Size-blind labelling protocol (FR-2).** The κ=0.80 consensus labels in
   [labels.json](../../../scripts/classifier-validation/labels.json) are the single
   most expensive artifact — 3 blind LLM raters + human overlap, 120 instances. If the
   labelling rule changes (e.g. labelling *from the diff*), the whole corpus must be
   re-labelled and every finding in tasks.md is invalidated. FR-2 itself records why
   this is load-bearing: diff-based labels scored a circular 95.8% (Run A).
2. **Real-path reuse seam (FR-3).** Calling the real `analyzeGitDiff()` → `classify()`
   ([classifier.ts](../../../packages/minspec/src/lib/classifier.ts)) instead of
   reimplementing analyzer logic. If the harness ever forks its own copy of the signal
   math, the test stops measuring the shipped classifier and silently rots.
3. **Patch-application strategy (FR-3 / design.md "Patch application").** The
   parse-headers-then-`git apply` path is fiddly; a redesign that needs base-image
   files would force every fixture to carry full repo state — a corpus-size blowup.
4. **Out-of-tree network boundary (FR-1, invariant #2).** Moving the fetch into
   `packages/minspec` to "simplify" would breach the no-network-import invariant and the
   T0 guard in design.md — costly to undo once callers depend on it.

## Invariants Preserved

- **#1 No AI dependency** — harness uses zero AI; pure analyzer + classifier.
- **#2 Tiered network consent** — network confined to the out-of-tree fetch script.
  No `http`/`https`/`fetch` added to `packages/minspec` or `packages/shared`.
  Harness + fixtures are static; the extension is untouched.
- **#3 No lock-in** — fixtures are plain JSON; labels are plain markdown/JSON.

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|------|---------------------|------------|
| 1 | **Circular validation** — labelling from diff size makes the test trivially agree with the size-based classifier (FR-2). | Med · High | FR-2 mandates *size-blind* consensus labels (problem statement only); Run A's 95.8% is kept in tasks.md as the documented failure to argue against any regression to diff-based labels. |
| 2 | **Corpus has zero true-T4** (NFR-2): SWE-bench-Verified is single-PR bug fixes, so the T4 row/column is unexercised and T3 is sparse (4 predicted ≥T3). | High · Med | NFR-2 + the confusion matrix in tasks.md state conclusions are firm only for T1–T2; T3+ flagged as needing a different corpus, not silently claimed. |
| 3 | **Patch fails to apply** for some SWE-bench instances (FR-3), shrinking n. | Med · Low | design.md "Patch application" parses diff headers to synthesise targets; un-appliable instances are counted in a `skipped` tally (FR-4 / AC-4), never silently dropped. |
| 4 | **Network leak** — a future edit imports `http`/`fetch` into the harness, breaching invariant #2. | Low · High | Network confined to `scripts/.../fetch-swebench.mjs` (FR-1); design.md adds a T0 assertion that the harness imports only `fs`/`child_process`/`simple-git` + analyzer modules. |
| 5 | **Misread as a fix mandate** — readers take the under-tiering finding as "tune the thresholds", which the data rejects. | Med · Med | Problem-section Outcome box + Out-of-Scope state the harness *measures, does not mutate*; remediation routed to DR-021/DR-024, not threshold tuning. |

## Assumptions

- SWE-bench-Verified gold patches are unified diffs that `git apply` (or header-parse
  reconstruction per design.md) can stage without the pre-image repo — FR-3 depends on
  `analyzeGitDiff` needing only `git diffSummary --cached`, not file contents.
- A ~50–120 instance subset (NFR-2) is a statistically meaningful accuracy signal for
  the T1–T2 boundary, where the corpus is dense.
- `analyzeGitDiff()` / `classify()` signatures in
  [classifier.ts](../../../packages/minspec/src/lib/classifier.ts) are stable enough
  that the harness can call them as the real path (FR-3) without an adapter shim.

## Test-thought

Verified by running the harness test against a labelled `.data/` subset and confirming
it emits an accuracy number + confusion matrix (AC-2); on a fresh offline clone the
same test must `skipIf` `.data/` is absent and leave `npm test` green (AC-1, FR-5).

## Coverage Map

| Mechanism / concern | FR(s) / invariant |
|---|---|
| Out-of-tree network-only fetch, nothing committed | FR-1, invariant #2 |
| Normalised fixture shape + size-blind consensus labelling (κ reported) | FR-2 |
| Real `analyzeGitDiff → classify` path, no reimplementation | FR-3 |
| Per-instance result + accuracy + confusion matrix | FR-4 |
| Offline graceful skip (never blocks devs / CI) | FR-5, invariant #1 |
| Determinism, no run-time network | NFR-1, invariant #2 |
| Proportional subset; honest T3/T4 corpus-gap caveat | NFR-2 |
| Plain-JSON fixtures + labels, no lock-in | invariant #3 |

## Consequences

**Positive:**
- Produces decision-grade evidence (n=120, κ=0.80) that the classifier is a 100%-precise
  *lower bound* on ceremony — directly enabling the upward-only ratchet in DR-021.
- Establishes a repeatable, offline-by-default measurement harness (FR-5) that future
  signal changes can be re-scored against without network or AI (invariants #1, #2).

**Negative:**
- The size-blind labelling protocol (FR-2) is expensive to produce and to re-run if the
  rubric ever changes — see "Costly to Refactor" #1.
- Conclusions are bounded to T1–T2 by the corpus (NFR-2); the spec ships a known T3/T4
  blind spot rather than a complete picture.

## Failure-Modes / Edge-Cases

- **Instance with no committed label** — only instances keyed in
  [labels.json](../../../scripts/classifier-validation/labels.json) (FR-2) are scored;
  an unlabelled instance is skipped, not counted against accuracy (distinct from the
  `skipped`-tally case below, which is a *patch-apply* failure, not a missing label).
- **Patch applies partially / hunk rejects** — instance excluded and added to the
  `skipped` tally per design.md, surfaced in the report, not silently dropped.
- **All instances skip (`.data/` absent)** — the whole `describe` is skipped (FR-5);
  `npm test` stays green rather than failing red on a fresh clone.
- **Confusion-matrix T4 row/column entirely zero** — expected, not a bug: NFR-2 records
  the corpus has zero true-T4 instances; the report must not infer T4 behaviour.
- **Adjacent-but-wrong prediction** (e.g. true-T2 predicted-T1) — the dominant real
  failure (false-T1 for 64/120 in tasks.md); counted in adjacent-accuracy, listed only
  when `|expected − predicted| ≥ 2` per AC-4 outlier rule.

## Test / Verification Strategy

| FR | Tier | Assertion sketch |
|----|------|------------------|
| FR-1 | T2 | Fetch script writes `.data/instances.json` with `{instanceId, repo, patch, problemStatement}[]`; nothing under `.data/` is git-tracked. |
| FR-2 | T1 | `labels.json` parses to `{instanceId: Tier}`; sample instances carry the documented size-blind consensus tier; κ recorded in tasks.md. |
| FR-3 | T2 | Given a known patch, the harness stages it and the value returned equals a direct `analyzeGitDiff → classify` call (no forked logic). |
| FR-4 | T2 | Report object matches the `ValidationReport` shape (design.md contract): accuracy, adjacentAccuracy, confusion matrix, outliers. |
| FR-5 | T0 | With `.data/` removed, the harness `describe` skips and `npm test` exits green (AC-1). |
| inv #2 | T0 | Static-import scan: harness imports only `fs`/`child_process`/`simple-git` + analyzer/classifier — no `http`/`https`/`fetch`. |

## Alternatives Considered

- **Synthetic-only unit tests (status quo, [classifier.test.ts](../../../packages/minspec/tests/classifier.test.ts)).** Rejected: gives no evidence on *real* diffs — the exact gap this spec exists to close (Problem section).
- **Label directly from the diff/line counts.** Rejected as circular: Run A scored 95.8% by construction (FR-2, tasks.md) because diff-based labels agree with a size-based classifier definitionally.
- **Commit SWE-bench patches into the repo for reproducibility.** Rejected on size + licensing; FR-1 keeps them gitignored and the fetch script reproducible instead.
- **Add AST/cyclomatic difficulty signals to close the false-T1 gap.** Considered and *measured-rejected* in tasks.md: the 64 misses are median 1 file / 5 lines — no local complexity exists to measure; routed to DR-021/DR-024 reframe instead.

## Follow-ups (tracked)

- **Reframe tier = mechanical/blast-radius scope + upward-only ratchet** — design
  resolved in [DR-021](../../../docs/decisions/DR-021.md).
- **Reach axis / tier → derived label** — resolved in
  [DR-022](../../../docs/decisions/DR-022.md) / [DR-024](../../../docs/decisions/DR-024.md).
- **Expand corpus to include true-T4 (architectural) instances** to exercise the
  unexercised T4 row (NFR-2 gap) — needs a non-SWE-bench corpus; not in this spec.
- **Finish labelling toward ~50+ with T4 examples** — tasks.md Phase 2 is `[~]` (24→120
  done for T1–T3; T4 still absent by corpus limit).
- Opt-in semantic/NLP difficulty signal (the only path that closes the false-T1 gap) is
  gated by invariant #1 (no-AI) — explicitly out of this harness's scope.

## Out of Scope

- Auto-labelling tiers via AI (violates #1).
- Committing SWE-bench patches (size + licensing; FR-1 keeps them gitignored).
- Auto-tuning classifier weights from results — that is a *separate* follow-up
  (the existing calibration path in classifier.ts handles weight adjustment).
  This harness **measures**; it does not **mutate** the classifier.

## Acceptance Criteria

- AC-1: `npm test` passes on a fresh clone **without** network (harness skips per FR-5).
- AC-2: After running the fetch script (FR-1) + labelling (FR-2), the harness emits
  the FR-4 report — accuracy, adjacent accuracy, and confusion matrix — over the
  labelled corpus (run: n=120, the n every other section cites; the FR-4
  `ValidationReport.n` field).
- AC-3: No new network imports (`http`/`https`/`fetch`) in `packages/minspec` /
  `packages/shared` — invariant #2, network confined to the FR-1 fetch script; the
  existing inv-#2 static-import test (Test/Verification Strategy row "inv #2")
  stays green.
- AC-4: The FR-4 report lists non-adjacent outliers (`|expected − predicted| ≥ 2`,
  e.g. expected-T1 predicted-T4) explicitly in the `ValidationReport.outliers`
  field (design.md contract) for human inspection — never silently averaged into
  the accuracy number.
