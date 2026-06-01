---
id: SPEC-013
type: requirements
status: specifying
tier: T2
product: minspec
epic: EPIC-003  # SDD Core Methodology
depends_on: [DR-020]
---

# MinSpec — Risk-Section Policy Enforcement (Requirements)

**Date:** 2026-06-01
**Status:** Specifying (SDD Specify phase)
**Decision:** [DR-020](../../../docs/decisions/DR-020.md) (this spec implements it)
**Triggered by:** session request — "spec the risk-enforcing policy, then I'll
review it so we can implement + backfill directly after approval."
**Epic:** [EPIC-003 SDD Core Methodology](../../../docs/epics/EPIC-003-sdd-core.md)
**Depends on:** DR-020 accepted (the policy this spec enforces).

---

## Context

[DR-020](../../../docs/decisions/DR-020.md) requires a **Risks & Mitigations**
section on every spec and DR, with depth proportional to tier (one line at T1, a
full table at T4), enforced by a **soft validator warning** — never a block.

This spec turns that policy into three concrete, shared changes: a single
definition of "has a risks section", template stubs that pre-fill it at every
tier, and a validator rule that warns when it is absent. It deliberately does
**not** redefine the policy (DR-020 owns that) — it specifies the mechanism.

## Requirements

### Detection (the shared predicate)

- **FR-1 (one definition of "has a risks section").** A single deterministic
  predicate decides whether an artifact satisfies the policy: presence of a
  heading matching `Risks & Mitigations` (case-insensitive, `##`/`###`) with at
  least one non-empty content line beneath it. This predicate is the **sole**
  source of truth, shared by the validator (FR-4) and any template self-check —
  the stub and the check can never disagree (DR-020 R3).
- **FR-2 (tier-proportional satisfaction).** The predicate MUST accept the
  tier-appropriate forms from DR-020: a full table (T3/T4), a short table or
  bullets (T2), or a single line including an explicit "None material" (T1). It
  checks *presence + non-emptiness*, not depth — depth is guidance, not a gate
  (consistent with advisory-not-blocking).

### Templates

- **FR-3 (every scaffold emits a sized stub).** The artifact-creating surfaces —
  the `specify` / `plan` skill scaffolds and the **Create ADR** command template —
  MUST emit a Risks & Mitigations stub, **sized to tier**: a pre-filled table
  header at T3/T4, a 2–4 bullet prompt at T2, a one-line prompt (with "None
  material" shown as a valid answer) at T1, and the table form for DRs. No tier
  omits the stub. The cost to the author is editing a stub, not authoring from
  blank.

### Validation

- **FR-4 (soft-warn, never block).** The frontmatter/structure validator
  (`scripts/validate-frontmatter.ts`) MUST emit a **warning** for any spec or DR
  whose content fails FR-1, naming the file and the missing section. It MUST NOT
  fail the validation run / exit non-zero on this rule alone — mirrors the soft
  `epic:` unresolved-ref rule (DR-013 §4). Epics are exempt (DR-020: lightweight).
- **FR-5 (warning is actionable).** Each warning MUST give the artifact id/path
  and a one-line fix ("add a `## Risks & Mitigations` section — one line is enough
  at T1"). A warning the author cannot act on is noise.

### Scope boundary

- **FR-6 (policy lives in DR-020, not here).** This spec MUST NOT encode *which
  tiers require what depth* as logic beyond the presence/non-emptiness predicate —
  that taxonomy is DR-020's. If the policy changes, the template stub text changes;
  the predicate (presence) does not. Keeps the mechanism stable across policy
  edits.

## Invariants (must hold)

- **INV — Advisory (T0).** The risk-section rule warns, never blocks (FR-4). Only
  the DR-012 approval gate blocks. No MinSpec validation rule may newly hard-fail a
  build for a missing risks section.
- **INV — Single predicate (T0).** Exactly one definition of "has a risks section"
  (FR-1) is used by both validator and any template self-check; no second
  implementation may exist (prevents the stub/checker drift, DR-020 R3).

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|---|---|---|
| R1 | **Stub/validator drift** — the template emits a heading the predicate doesn't accept (or vice-versa), so freshly-scaffolded docs warn immediately. | Med · High | FR-1 single shared predicate + INV-single-predicate; one T1 test scaffolds each tier and asserts the predicate passes on the raw stub. |
| R2 | **Warning fatigue** — backfilling onto 19 existing DRs floods the validator with warnings, training users to ignore all warnings. | High · Med | Backfill (separate follow-up) lands before/with enabling the rule, or the rule ships warn-once-per-file; sequence handled at plan time. Advisory-only keeps it from blocking meanwhile. |
| R3 | **Predicate too loose** — an empty `## Risks & Mitigations` header with no content passes, defeating the policy. | Med · Med | FR-1 requires ≥1 non-empty content line beneath the heading, not just the heading. |
| R4 | **Scope creep into depth-grading** — pressure to make the validator judge whether the risks are "good enough". | Low · Med | FR-2 + FR-6 explicitly bound the check to presence + non-emptiness; semantic adequacy is out of scope (no programmatic oracle, mirrors SPEC-012 FR-15). |

## Out of scope

- **The policy itself** (which tiers, what depth) — owned by DR-020.
- **Semantic quality of risk content** — no programmatic judge of whether a risk
  analysis is *good*; presence + non-emptiness only (FR-2).
- **Backfilling existing DRs** — a separate, explicitly-sequenced follow-up
  (DR-020 Consequences); this spec defines the forward-going enforcement.
- **Hard-blocking enforcement** — excluded by INV-advisory; the only gate is
  DR-012.

## Open questions

- **Backfill vs enable sequencing.** Enable the warn rule before, during, or after
  the 19-DR backfill? Lean: backfill first (or same change) so enabling the rule
  finds a clean tree — avoids R2 warning-flood. Confirm at plan.
- **Warn surface.** Validator stdout only, or also a VS Code Problems-panel
  diagnostic (like the signpost)? Lean: CLI stdout for v1 (the validator's existing
  channel); editor diagnostic is a later enhancement.
