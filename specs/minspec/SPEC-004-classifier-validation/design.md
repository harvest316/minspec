---
id: SPEC-004
type: design
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: implementing  # design realized — harness built + run (n=120, κ=0.80); tracks requirements.md/tasks.md
product: minspec
epic: EPIC-004  # Classifier Validation
---

# MinSpec — Classifier Validation Harness (Design)

**Date:** 2026-05-29
**Requirements:** [requirements.md](requirements.md)
**Decision:** [DR-009](../../../docs/decisions/DR-009.md)

---

## Components

```
scripts/classifier-validation/
  fetch-swebench.mjs        # FR-1: out-of-tree, network-only component
  labels.json               # FR-2: committed { instanceId: expectedTier } map
  .data/                    # gitignored: fetched patches + problem statements

packages/minspec/tests/
  classifier-validation.test.ts   # FR-3..FR-5: harness + report, skips if .data absent
```

`.data/` added to `.gitignore`. `labels.json` committed.

## Data flow

```
fetch-swebench.mjs ──network──> SWE-bench-Verified subset ──> scripts/.../.data/instances.json
                                                                      │
labels.json (committed) ───────────────────────────────────────────┐ │
                                                                    ▼ ▼
classifier-validation.test.ts:
  for each instance with a label:
    tmp = mkdtemp(); git init tmp
    write base files? NO — apply patch to empty-tracked repo (see "Patch application")
    git apply patch ; git add -A
    signals = await analyzeGitDiff(tmp, { staged: true })
    result  = classify(signals, config)
    record { instanceId, expectedTier, predictedTier: result.tier, confidence, match }
  emit accuracy + confusion matrix + outlier list
```

## Patch application

`analyzeGitDiff` only needs `git diffSummary --cached` (file count, insertions,
deletions, extensions, dirs). It does **not** need the pre-image to exist. So:

1. `git init` temp repo, set a throwaway user.
2. `git apply --whitespace=nowarn <patch>` — if it fails because target files are
   absent, fall back to `git apply --include` of additions only, OR synthesise empty
   target files from the diff's `---`/`+++` headers then apply. Simpler robust path:
   parse the diff headers ourselves to create zero-byte target files, then `git add`
   each touched path with its post-image content reconstructed by `git apply`.
3. `git add -A && stage` → `analyzeGitDiff(tmp, { staged: true })`.

If a patch cannot be applied cleanly, the instance is **excluded** and counted in a
`skipped` tally in the report (never silently dropped — NFR/AC-4 transparency).

## Label rubric (committed in labels.json header comment + here)

Hand-labelling `expectedTier` is judgement. Rubric for consistency:

| Tier | Heuristic (human judgement, not the classifier's mechanics) |
|------|-----------------------------------------------------------------|
| T1   | One concept, one/two files, < ~20 lines. Typo, off-by-one, guard. |
| T2   | Small feature or multi-file fix, < ~100 lines, one subsystem.   |
| T3   | Cross-subsystem change, new behaviour, ~100–500 lines.          |
| T4   | Architectural / wide blast radius, 500+ lines or 16+ files.     |

Label the **task as a human would scope it**, independent of what the diff size is —
the whole point is to see whether the size-based classifier agrees with human scope
judgement. Disagreements are the interesting data.

## Report format

Plain text to stdout + a written `scripts/classifier-validation/.data/report.json`:

```
Classifier validation — SWE-bench-Verified (n=NN labelled, MM applied, KK skipped)
Accuracy: XX% (exact tier match)
Adjacent (±1 tier): YY%

Confusion matrix (rows = expected, cols = predicted)
        T1   T2   T3   T4
   T1    .    .    .    .
   ...

Outliers (|expected - predicted| >= 2):
   <instanceId>  expected=T1 predicted=T4  conf=0.83
```

## Contract (FR-2/FR-4)

```ts
interface ValidationInstance {
  instanceId: string;
  patch: string;
  problemStatement: string;
  expectedTier: Tier;   // from labels.json
}

interface ValidationResult {
  instanceId: string;
  expectedTier: Tier;
  predictedTier: Tier;
  confidence: number;
  match: boolean;
}

interface ValidationReport {
  n: number; applied: number; skipped: number;
  accuracy: number; adjacentAccuracy: number;
  confusion: Record<Tier, Record<Tier, number>>;
  outliers: ValidationResult[];
}
```

## Invariant guard (T0)

Existing network-import invariant test already asserts no `http`/`https`/`fetch` in
`packages/minspec`/`packages/shared`. The fetch script lives in `scripts/`, outside
both — so it is outside that test's scan. Add an assertion that
`classifier-validation.test.ts` itself imports nothing that performs network I/O
(only `fs`, `child_process`/`simple-git`, and the analyzer/classifier modules).
