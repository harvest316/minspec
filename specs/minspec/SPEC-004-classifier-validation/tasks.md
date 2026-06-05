---
id: SPEC-004
type: tasks
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: implementing
product: minspec
epic: EPIC-004  # Classifier Validation
---

# MinSpec — Classifier Validation Harness (Tasks)

**Requirements:** [requirements.md](requirements.md) · **Design:** [design.md](design.md) · **Decision:** [DR-009](../../../docs/decisions/DR-009.md)

---

## T0 — Invariants (before implementation)
- [x] Test: harness file imports no network module (only fs/child_process/simple-git + analyzer/classifier). (AC-3)
- [x] Test: harness `describe.skipIf`s when `.data/` absent — green offline. (AC-1, FR-5)

## Phase 1 — Out-of-tree fetch (FR-1)
- [x] `.gitignore`: add `scripts/classifier-validation/.data/`
- [x] `scripts/classifier-validation/fetch-swebench.mjs` — fetch subset → `.data/instances.json` `{instanceId, repo, patch, problemStatement}[]`
- [x] Script header documents it is the only network component (DR-009 / invariant #2)
- [x] Stride-sample across the dataset (not first-N) for repo/size diversity

## Phase 2 — Labels (FR-2)
- [x] `scripts/classifier-validation/labels.json` — `{instanceId: Tier}` map + rubric header
- [~] Hand-label instances per rubric — 24 labelled (9 repos). Expand toward ~50 + add T4 examples.

## Phase 3 — Harness (FR-3, FR-4)
- [x] Patch application: parse unified diff → feed real `analyzeGitDiff` via injectable git seam; count unparseable as `skipped`
- [x] Per-instance: `analyzeGitDiff` → `classify` → `ValidationResult`
- [x] Aggregate: accuracy, adjacent accuracy, confusion matrix, outliers
- [x] Write `report.json` + print summary

## Phase 4 — Wire-up
- [x] `npm run validate:classifier` script (runs harness against `.data/` if present)
- [x] Confirm `npm test` green on fresh offline clone (AC-1) — 987 pass, harness skips
- [x] Run end-to-end after fetch+label; record baseline (AC-2, AC-4)

## Findings

### Run A — size-based labels (n=24)
Exact 95.8%, adjacent 100%. High — but labels followed the size rubric, which
correlates with the size-based classifier by construction. Circular; not a real test.

### Run C — consensus semantic labels (n=120, 11 repos) — STRONGEST EVIDENCE
Ground truth = majority vote of 3 independent blind LLM labellers (given only the
problem statement — no diff, no size) + 1 human on the overlap. **Fleiss κ = 0.80**
(almost-perfect inter-rater agreement); 82% unanimous 3/3; human agreed 79% with
consensus. Consensus tier distribution: T1=25, T2=62, T3=33, **T4=0** (the dataset
has no architectural changes — single-PR bug fixes).

- **Exact 34.2%, adjacent 86.7%.** Confusion (rows=expected, cols=predicted):
  ```
          T1   T2   T3   T4
   T1     25    0    0    0
   T2     48   13    1    0
   T3     16   14    3    0
  ```
- **Conservative floor, not random:** every true-T1 predicted T1 (perfect recall on
  trivial); the classifier never over-tiers. "Predicted > T1" is therefore reliable.
- **But severe false-T1:** predicts T1 for 89/120 (74%); only 25 truly are. 64
  bounded/subtle changes (48 T2, 16 T3) get one-sentence-spec ceremony. Never
  predicts T4, almost never T3.
- This confirms Run B at scale on de-subjectified ground truth: the size-based
  classifier is a sound *lower bound* on ceremony but systematically under-tiers
  cognitive difficulty. Same root cause + same options as below.

### Error analysis (n=120) — decision-grade
Two questions: is "predicted > T1" a safe upward ratchet, and can any size signal
rescue the T1 bucket?

**Ratchet precision (P(true ≥ t | pred ≥ t)):**
- `pred ≥ T2` → true ≥ T2: **100%** (31/31). Over-tiering across the whole set is
  **1/120** (django-11532, T2→T3). So a predicted tier is a near-perfect *lower
  bound* — safe to auto-apply as a ceremony floor that only ratchets UP, never down.
- `pred ≥ T3` → true ≥ T3: 75% (3/4) — too sparse to trust the T3 boundary.

**Can size subdivide the predicted-T1 bucket? No.** Within the 89 predicted-T1:
```
                 TRUE-T1 (25)   FALSE-T1 (64)
  lines median        4              5
  lines max          15             20
  files median        1              1
  dirs median         1              1
```
true-T1 lines `1..15`, false-T1 lines `2..20` — fully overlapping; both have many
2-line cases. **No line/file/dir threshold separates a trivial 2-line fix from a
subtle 2-line fix.** Lowering thresholds only inflates the genuine T1s.

**Consequences for the options:**
- Option 2 (AST complexity signals) is a **dead end**: the 64 misses are median
  1 file / 5 lines — no local complexity exists to measure. AST would also score
  them low. Drop it.
- The classifier IS shippable as an **upward-only ratchet / floor** (100% precise at
  T1→T2). Recommend: apply predicted tier as a minimum, prompt-to-bump-up only.
- Closing the false-T1 gap requires a semantic/text signal (problem description) →
  invariant #1 (no-AI) constrained; only viable as opt-in. This is the real fork:
  reframe+ratchet [no-AI, ship now] vs opt-in semantic difficulty [needs AI consent].

### Run B — semantic labels (n=50, 10 repos) — single-labeller pilot
Labels assigned from `problem_statement` difficulty, independent of diff size.

- **Exact 18%, adjacent 80%.** Classifier predicted **T1 for 42 of 50** instances.
- Confusion (rows=expected, cols=predicted):
  ```
          T1   T2   T3   T4
   T1      4    0    0    0
   T2     28    4    0    0
   T3     10    3    1    0
  ```
- **10 outliers, all T3→T1**: subtle bugs (nested CompoundModel separability,
  GFK+UUID prefetch, tz reverse-conversion, ConditionSet subs, …) shipped as small
  gold patches → classifier calls them T1.

### Root cause (not a bug, a design limit)
Every signal is size/blast-radius (file count, line count, cross-dir, file-types,
new-files, deps). **Semantic difficulty is orthogonal to diff size.**
`astropy-12907` (T3, +1/-1) and `django-11790` (T1, +3/-1) are size-identical →
both T1. No threshold setting separates them. **Tuning thresholds cannot fix this**;
it would only inflate the genuine T1s. The classifier measures *mechanical scope*,
not *cognitive difficulty*, and systematically **under-tiers subtle small fixes** —
recommending one-sentence-spec (T1) ceremony for changes that demand deep
understanding (T3).

### Implications (for user decision — NOT actioned)
1. **Reframe (cheapest):** document tier = mechanical/blast-radius scope; rely on the
   existing user-override + calibration path to bump subtle work up. Honest about scope.
2. **Augment signals (real work):** add non-AI difficulty proxies (AST cyclomatic
   complexity of changed hunks, symbol count, nesting depth) via the existing
   ast-analyzer. Limited gain — subtle fixes often have low *local* complexity too.
3. **NLP difficulty scoring:** highest signal, but reads issue text → near invariant
   #1 (no AI). Out unless reframed as opt-in.

Park (2) and (3) as issues; (1) is a doc change pending user call.
