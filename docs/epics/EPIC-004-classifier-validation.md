---
id: EPIC-004
slug: classifier-validation
title: Classifier Validation
status: proposed
order: 4
---

# EPIC-004: Classifier Validation

## Goal

Replace synthetic-only confidence in the tier classifier (T1–T4) with real-diff
evidence, then decide what that evidence means for how MinSpec applies tiers.
Validate the classifier against a real GitHub issue→PR corpus
(SWE-bench-Verified), measure its accuracy against **difficulty-based** ground
truth rather than the size-based labels it trivially matches, and resolve the
positioning fork the result exposes.

"Done" =
1. a repeatable, **offline-by-default** harness that exercises the *real*
   analyzer→classifier path on real diffs (no reimplemented logic, graceful skip
   with no data);
2. a **decision-grade** accuracy result against de-subjectified ground truth; and
3. a chosen direction for the classifier — recorded as a DR — for what the
   evidence implies about shipping and marketing the tiers.

Items 1–2 are **done**; item 3 is **resolved** by [DR-021](../decisions/DR-021.md).

## Finding

The classifier measures **mechanical scope / blast-radius** (file count, line
count, cross-dir spread, file-type diversity), which is **orthogonal to cognitive
difficulty**. Against consensus semantic labels (n=120, 11 repos; ground truth =
3 blind LLM labellers + human, Fleiss κ=0.80) it scored **34.2% exact / 86.7%
adjacent**, predicting T1 for 74% of instances while only 21% truly are — it
systematically **under-tiers subtle small fixes** (a 2-line subtle bug and a
2-line trivial fix are size-identical; no threshold separates them).

Two consequences for the direction decision:
- **It is a sound lower bound.** `pred ≥ T2` → `true ≥ T2` was 100% precise
  (31/31); the classifier never over-tiers. So a predicted tier is safe to apply
  as a **ceremony floor that ratchets up, never down**.
- **AST complexity signals are a dead end** — the 64 misses are median 1 file /
  5 lines, with no local complexity to measure. Closing the gap needs a
  *semantic* (problem-text) signal, which collides with invariant #1 (no-AI) and
  is viable only as opt-in.

The real fork: **reframe docs + ship the upward-only ratchet** (no-AI, ship now)
vs **opt-in semantic difficulty scoring** (needs AI consent). **Resolved** by
[DR-021](../decisions/DR-021.md): ship the ratchet/floor + reframe now; defer
semantic scoring to opt-in; drop AST augmentation as a dead end.

## Artifacts

- **Decisions:** [DR-009](../decisions/DR-009.md) — validate via out-of-tree
  SWE-bench fixtures (gitignored patches, committed labels, real-path reuse,
  graceful skip). [DR-021](../decisions/DR-021.md) — resolves the direction fork:
  ship as an upward-only ceremony ratchet, reframe docs (scope ≠ difficulty),
  drop AST augmentation, defer semantic difficulty to opt-in.
- **Spec:** [SPEC-004 requirements](../../specs/minspec/classifier-validation/requirements.md),
  [design](../../specs/minspec/classifier-validation/design.md),
  [tasks](../../specs/minspec/classifier-validation/tasks.md) — the harness;
  `tasks.md` "Findings" holds Runs A/B/C + the decision-grade error analysis.
- **Code:** `scripts/classifier-validation/` (fetch + labels), harness in
  `packages/minspec/tests/classifier-validation.test.ts`, run
  `npm run validate:classifier` after fetching.
- **Issues:** label `epic:classifier-validation`. Option (2) AST signals
  (recommend **drop**) and option (3) NLP difficulty scoring parked as issues.
