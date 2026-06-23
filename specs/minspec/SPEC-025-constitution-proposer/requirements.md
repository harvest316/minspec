---
id: SPEC-025
type: requirements
status: specifying
tier: T3
product: minspec
epic: EPIC-003  # SDD Core Methodology
---

# MinSpec — Constitution Proposer (deterministic, Tier-0) — Requirements

**Date:** 2026-06-23
**Status:** Specifying (SDD Specify phase)
**Triggered by:** [#269](https://github.com/harvest316/minspec/issues/269) — "shouldn't MinSpec propose Invariants/Principles/Constraints alongside Goals at init, instead of empty placeholders?"
**Related:** [#270](https://github.com/harvest316/minspec/issues/270) (enforce invariants as gates — the sequel), [#242](https://github.com/harvest316/minspec/issues/242) (init tech-debt scan), DR-039 (Goals), DR-004/DR-015 (Tier-0 boundary)

## Problem

`Initialize SDD Structure` scaffolds `.minspec/constitution.md` with **empty**
Invariants/Principles/Constraints (template comments) and **no Goals section**. Every
MinSpec project starts with an empty *foundational* doc, and nothing surfaces that it is
empty — the same asymmetry MinSpec exists to prevent (the scaffolder writes the section
but never asserts it should be filled). An empty constitution is a bad state.

## Scope (one sentence)

At Initialize/Refresh, deterministically **propose a DRAFT constitution**
(Invariants/Principles/Constraints/Goals) from codebase signals — never empty
placeholders — and softly surface an empty constitution as a next human task.

## Invariants (this change must preserve)

- **INV-1 — Tier-0.** No LLM, no network. The proposer is a pure function over the
  filesystem (DR-004/DR-015/DR-019 §6). LLM enrichment is explicitly **out of scope**
  (Tier-1 `agent-execute` follow-up).
- **INV-2 — Never assert, never overwrite human content.** Proposals are marked DRAFT.
  A section that already holds human-authored (non-DRAFT) content is left untouched.
  Idempotent across repeated Refresh runs.
- **INV-3 — Populate, do not enforce.** This spec only *writes* candidate invariants. It
  does **not** wire invariants as resolver gates — that is #270. (populate ≠ enforce.)
- **INV-4 — Determinism is auditable.** Every candidate carries machine-readable
  provenance ("proposed because <signal>"), so the proposal is reproducible and
  reviewable.

## Functional Requirements

- **FR-1 — Deterministic signal scan.** Read, without executing or networking:
  `package.json` (`engines` → runtime constraint; dependencies → "runs offline / no
  network without consent" candidate when no network deps), monorepo layout (Tier-0
  packages → "shared stays `vscode`/network-free" invariant candidate), bundle config
  (`.vscodeignore`/size), and existing `CLAUDE.md` / `docs/decisions/*` prose (extract
  already-stated invariants/principles). Output: a list of typed `Signal` records.
- **FR-2 — Two-tier candidate generation (silence > noise, but no signal lost).**
  - *Tier A — written.* A fixed catalog maps `Signal → Candidate` (kind ∈ {invariant,
    principle, constraint, goal}, text, stable ID). Only high-confidence catalog matches
    are written as DRAFT entries. No inference beyond the catalog.
  - *Tier B — surfaced, not written.* Notable signals with no catalog match are **not**
    written into the doc; instead they are surfaced to the human as "other signals found,
    not written up — might trigger thoughts." Keeps the doc clean while never silently
    dropping a notable signal (OQ-1 resolved).
- **FR-3 — Whole-doc proposal (offer if any section empty; additive on re-run).** If
  **any** section is empty/template, offer to propose draft entries across the **whole**
  constitution — including a `## Goals` section (currently absent from the scaffold).
  Re-running `Initialize` does the **full** signal scan and proposes anything **not
  already present** (additive, idempotent, whole-doc; never per-section piecemeal).
  Existing human content is never touched (INV-2). (OQ-2 resolved.)
- **FR-4 — DRAFT marking + human boundary.** Each proposed item is visibly DRAFT and
  removable; the moment a section has human content the proposer never rewrites it.
- **FR-5 — Empty-constitution nudge.** When the constitution is empty/all-template, a
  **soft** advisory (signpost/validator, never a block) surfaces "author your
  constitution" as a next human task (RCDD phase-4: surface the bad state).
- **FR-6 — Provenance is review-time only.** Each candidate's "proposed because <signal>"
  is shown in the **proposal preview** so the human can judge it. It does **not** need to
  persist in the doc; any DRAFT/provenance markers that do land are removed by compaction
  (FR-7). So provenance cannot rot — it is gone after review (OQ-3 resolved).
- **FR-7 — Offer to compact after review.** The constitution is read in (almost) every
  session, so its token weight matters. After the human has reviewed, offer to **compact**
  it: strip `DRAFT` markers and any provenance, tighten prose — never silently, always a
  confirmed human action. Compaction is meaning-preserving; the human confirms the result.

## Out of scope

- **LLM enrichment** of the draft → Tier-1 `agent-execute` follow-up (separate spec).
- **Invariant enforcement** (wiring invariants as `gate-violation` in the resolver) →
  [#270](https://github.com/harvest316/minspec/issues/270).
- **Constitution hash/approval integrity.** Not needed here: while invariants are not
  enforced, the constitution is a freely human-edited doc (INV-2 non-overwrite is the only
  guard). Once #270 makes invariants **load-bearing gates**, a silent edit could silently
  change what's enforced project-wide — so a deliberate-edit checkpoint (DR-012-style
  approval/hash, which also confirms a compaction rewrite) belongs to **#270**, not here.
- Re-proposing / churning a human-authored constitution.

## Open questions — resolved (Clarify)

- **OQ-1 (catalog) → resolved.** Silence > noise: only high-confidence catalog matches are
  written (FR-2 Tier A); other notable signals are surfaced to the human, not written
  (FR-2 Tier B).
- **OQ-2 (ergonomics) → resolved.** Whole-doc: offer if any section empty; re-run scans
  fully and adds anything missing (FR-3).
- **OQ-3 (provenance rot) → resolved.** Provenance is review-time only and removed by
  compaction (FR-6/FR-7) — it never persists to rot.

## Acceptance (T2 feature tests, happy + primary failure)

- A fresh `Initialize` on a repo with no network deps yields a constitution whose
  `## Invariants` contains a DRAFT "runs offline / no network without consent" candidate
  with provenance — not an empty placeholder.
- `Refresh Harness` on a constitution with human-authored Invariants but empty
  Constraints fills **only** Constraints (INV-2 idempotence/non-overwrite).
- An all-template constitution triggers the soft "author your constitution" advisory
  (FR-5); a populated one does not.
- A notable signal with no catalog match is surfaced as a "found, not written up"
  suggestion, not injected into the doc (FR-2 Tier B).
- After review, the offered compaction strips all `DRAFT`/provenance markers and leaves
  meaning-equivalent prose; it never runs silently (FR-7).

## Traceability

Materializes #269. Enforcement sequel: #270. Tier-1 LLM enrichment: future spec.
