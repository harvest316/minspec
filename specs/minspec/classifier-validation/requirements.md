---
id: SPEC-004
type: requirements
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: specifying
product: minspec
epic: EPIC-004  # Classifier Validation
---

# MinSpec — Classifier Validation Harness (Requirements)

**Date:** 2026-05-29
**Status:** Specifying (SDD Specify phase)
**Triggered by:** session request — validate classifier on real-world issue→PR data
**Related:** [classifier.ts](../../../packages/minspec/src/lib/classifier.ts), DR-009

---

## Problem

The tier classifier ([classifier.ts](../../../packages/minspec/src/lib/classifier.ts))
is currently validated only by synthetic unit tests
([classifier.test.ts](../../../packages/minspec/tests/classifier.test.ts)).
We have no evidence it predicts sensible tiers on **real** code changes. Without
real-diff validation we cannot calibrate thresholds (file-count / line-count /
file-type tiers in [git-analyzer.ts](../../../packages/minspec/src/lib/git-analyzer.ts))
with confidence.

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
- **FR-2 — Fixture shape.** Each instance is normalised to
  `{ instanceId, patch, problemStatement, expectedTier }`. `expectedTier` is
  hand-labelled (T1–T4), stored in a committed labels file keyed by `instanceId`
  (the *labels* are committed; the *patches* are not).
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
- **NFR-2 — Proportional ceremony.** Subset ~50 instances, not all 500. Enough for
  a meaningful accuracy signal, cheap to label and run.

## Invariants Preserved

- **#1 No AI dependency** — harness uses zero AI; pure analyzer + classifier.
- **#2 Tiered network consent** — network confined to the out-of-tree fetch script.
  No `http`/`https`/`fetch` added to `packages/minspec` or `packages/shared`.
  Harness + fixtures are static; the extension is untouched.
- **#3 No lock-in** — fixtures are plain JSON; labels are plain markdown/JSON.

## Out of Scope

- Auto-labelling tiers via AI (violates #1).
- Committing SWE-bench patches (size + licensing; FR-1 keeps them gitignored).
- Auto-tuning classifier weights from results — that is a *separate* follow-up
  (the existing calibration path in classifier.ts handles weight adjustment).
  This harness **measures**; it does not **mutate** the classifier.

## Acceptance Criteria

- AC-1: `npm test` passes on a fresh clone **without** network (harness skips per FR-5).
- AC-2: After running the fetch script + labelling, the harness emits an accuracy
  number and confusion matrix over ~50 instances.
- AC-3: No new network imports in `packages/minspec` / `packages/shared`
  (existing invariant test still green).
- AC-4: Outliers (expected T1 predicted T4 or vice-versa) are listed explicitly in
  the report for human inspection.
