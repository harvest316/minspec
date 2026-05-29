---
id: SPEC-004
type: tasks
status: implementing
product: minspec
---

# MinSpec — Classifier Validation Harness (Tasks)

**Requirements:** [requirements.md](requirements.md) · **Design:** [design.md](design.md) · **Decision:** [DR-009](../../../docs/decisions/DR-009.md)

---

## T0 — Invariants (before implementation)
- [ ] Test: harness file imports no network module (only fs/child_process/simple-git + analyzer/classifier). (AC-3)
- [ ] Test: harness `describe.skip`s when `.data/` absent — green offline. (AC-1, FR-5)

## Phase 1 — Out-of-tree fetch (FR-1)
- [ ] `.gitignore`: add `scripts/classifier-validation/.data/`
- [ ] `scripts/classifier-validation/fetch-swebench.mjs` — fetch ~50-instance subset → `.data/instances.json` `{instanceId, patch, problemStatement}[]`
- [ ] Script header documents it is the only network component (DR-009 / invariant #2)

## Phase 2 — Labels (FR-2)
- [ ] `scripts/classifier-validation/labels.json` — `{instanceId: Tier}` map + rubric header
- [ ] Hand-label ~50 instances per design.md rubric

## Phase 3 — Harness (FR-3, FR-4)
- [ ] Temp-repo patch application (git init → apply → stage); exclude+count unappliable
- [ ] Per-instance: `analyzeGitDiff` → `classify` → `ValidationResult`
- [ ] Aggregate: accuracy, adjacent accuracy, confusion matrix, outliers
- [ ] Write `report.json` + print summary

## Phase 4 — Wire-up
- [ ] `npm run validate:classifier` script (runs harness against `.data/` if present)
- [ ] Confirm `npm test` green on fresh offline clone (AC-1)
- [ ] Run end-to-end after fetch+label; record baseline accuracy (AC-2, AC-4)
