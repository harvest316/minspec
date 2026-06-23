---
id: SPEC-025
type: requirements
status: specifying
tier: T3
product: minspec
epic: EPIC-003  # SDD Core Methodology
---

# MinSpec — Constitution Proposer (LLM-drafted, MinSpec-orchestrated) — Requirements

**Date:** 2026-06-23
**Status:** Specifying (SDD Specify phase)
**Triggered by:** [#269](https://github.com/harvest316/minspec/issues/269) — "shouldn't MinSpec propose Invariants/Principles/Constraints alongside Goals at init, instead of empty placeholders?"
**Related:** [#270](https://github.com/harvest316/minspec/issues/270) (enforce invariants as gates — the sequel), [#242](https://github.com/harvest316/minspec/issues/242) (init tech-debt scan), DR-039 (Goals), DR-004/DR-015 (Tier-0 boundary), DR-017 (agent-execute model access)

## Problem

`Initialize SDD Structure` scaffolds `.minspec/constitution.md` with **empty**
Invariants/Principles/Constraints (template comments) and **no Goals section**. Every
MinSpec project starts with an empty *foundational* doc, and nothing surfaces that it is
empty — the same asymmetry MinSpec exists to prevent (the scaffolder writes the section
but never asserts it should be filled). An empty constitution is a bad state.

## Scope (one sentence)

At Initialize/Refresh, **MinSpec orchestrates (Tier-0) and an LLM assistant generates
(Tier-1)** a DRAFT constitution (Invariants/Principles/Constraints/Goals) from codebase
context — never empty placeholders — with a deterministic rule-based seed as the offline
fallback, and a soft nudge when the constitution is empty.

## Architecture — who does what

The rich draft is **LLM-generated**, but **not by MinSpec-the-extension** (Tier-0,
air-gapped). MinSpec orchestrates deterministically; the LLM lives in the user's assistant
or the Tier-1 `agent-execute` extension.

| Step | Who | Tier |
|---|---|---|
| Detect empty constitution → nudge | MinSpec | Tier-0 |
| Scaffold structure incl. `## Goals` | MinSpec | Tier-0 |
| Assemble codebase **context manifest** + a **prepared prompt** | MinSpec | Tier-0 |
| **Generate the rich draft** | assistant / `agent-execute` | **Tier-1 (LLM)** |
| Integrate result, mark DRAFT, offer compact, gate | MinSpec | Tier-0 |
| Rule-based **seed** when no LLM available | MinSpec | Tier-0 fallback |

This mirrors the product thesis: **the LLM thinks, MinSpec harnesses/gates** ("just enough
human"). It also matches how this very session's Goals were drafted (assistant LLM), not
by the extension.

## Invariants (this change must preserve)

- **INV-1 — MinSpec extension stays Tier-0.** MinSpec itself makes no LLM call and no
  network call (DR-004/DR-015/DR-019 §6). The LLM generation is **external** — the
  assistant or `agent-execute` (Tier-1, DR-017). MinSpec only *assembles the prompt/context*
  and *integrates the returned draft*, both pure-FS operations.
- **INV-2 — Never assert, never overwrite human content.** Proposals are marked DRAFT. A
  section already holding human-authored (non-DRAFT) content is left untouched. Idempotent
  across repeated Initialize/Refresh runs (additive only).
- **INV-3 — Populate, do not enforce.** This spec only *writes* candidate invariants; it
  does **not** wire invariants as resolver gates — that is #270. (populate ≠ enforce.)
- **INV-4 — Degrade, never block.** No assistant present → fall back to the deterministic
  seed (FR-5); never leave the constitution empty and never hard-block init on an LLM.

## Functional Requirements

- **FR-1 — Deterministic context assembly (Tier-0).** Read, without executing or
  networking: `package.json` (`engines`, dependencies), monorepo layout / Tier boundaries,
  bundle config, and existing `CLAUDE.md` / `docs/decisions/*` / `docs/epics/*` prose.
  Output: a structured **context manifest** + typed `Signal` records. Pure function.
- **FR-2 — Prepared generation prompt (Tier-0).** From the manifest + the constitution's
  section schema (Invariants/Principles/Constraints/Goals), MinSpec builds a deterministic
  **prompt** instructing the LLM to propose DRAFT entries with per-item provenance, biased
  to **silence > noise** (few high-confidence items; list other notable signals separately,
  not as entries).
- **FR-3 — LLM generation via assistant / agent-execute (Tier-1).** The prepared prompt is
  fulfilled by the LLM: automatically when `agent-execute` is present (subscription
  `claude -p` default per DR-017), otherwise MinSpec surfaces the prompt for the user to run
  in their own assistant and paste back / apply. MinSpec never calls the model itself.
- **FR-4 — Integrate the returned draft (Tier-0).** Parse the LLM's proposal into the
  section schema, write entries marked **DRAFT** with stable IDs, **whole-doc & additive**:
  offer if any section is empty; on re-run, add only what is **not already present**; never
  touch human content (INV-2). Notable-but-unwritten signals are surfaced to the human
  ("found these, didn't write them up — might trigger thoughts").
- **FR-5 — Deterministic seed fallback (Tier-0).** With no assistant available, a fixed
  catalog maps `Signal → Candidate` (e.g. no network deps → DRAFT "runs offline / no
  network without consent"; Tier-0 package → "shared stays `vscode`/network-free"). Shallow
  but never empty. Same DRAFT/additive/non-overwrite rules.
- **FR-6 — Empty-constitution nudge.** When the constitution is empty/all-template, a
  **soft** advisory (signpost/validator, never a block) surfaces "author your constitution"
  as a next human task (RCDD phase-4: surface the bad state).
- **FR-7 — Provenance is review-time only.** Each candidate's "proposed because <signal>"
  is shown in the proposal preview so the human can judge it; it need not persist, and any
  DRAFT/provenance markers that land are removed by compaction (FR-8) — so provenance
  cannot rot (OQ-3 resolved).
- **FR-8 — Offer to compact after review.** The constitution is read in (almost) every
  session, so its token weight matters. After human review, offer to **compact**: strip
  `DRAFT` markers and provenance, tighten prose — never silently, always human-confirmed,
  meaning-preserving.

## Out of scope

- **Building `agent-execute`** or its model-access broker (DR-017) — this spec *consumes*
  the Tier-1 LLM path; it does not build it.
- **MinSpec calling an LLM in-process** — forbidden by INV-1; the model is always external.
- **Invariant enforcement** (wiring invariants as `gate-violation`) → [#270](https://github.com/harvest316/minspec/issues/270).
- **Constitution hash/approval integrity** — not needed while invariants are unenforced;
  once #270 makes them load-bearing gates, a deliberate-edit checkpoint (DR-012-style
  approval/hash, also confirming a compaction rewrite) lands with **#270**.
- Re-proposing / churning a human-authored constitution.

## Open questions — resolved (Clarify)

- **OQ-1 (noise) → resolved.** Silence > noise in the prompt (FR-2) and the seed (FR-5);
  other notable signals surfaced, not written (FR-4).
- **OQ-2 (ergonomics) → resolved.** Whole-doc: offer if any section empty; re-run adds
  anything missing (FR-4).
- **OQ-3 (provenance rot) → resolved.** Review-time only; removed by compaction (FR-7/FR-8).
- **OQ-4 (who runs the LLM) → resolved.** The assistant / `agent-execute` (Tier-1), never
  MinSpec core (FR-3, INV-1).

## Acceptance (T2 feature tests, happy + primary failure)

- With `agent-execute` present, a fresh `Initialize` produces a DRAFT constitution whose
  sections contain LLM-proposed entries with review-time provenance — not empty placeholders.
- With **no** assistant, `Initialize` falls back to the deterministic seed (e.g. a DRAFT
  "runs offline" invariant) — still never empty (INV-4/FR-5).
- `Refresh` on a constitution with human-authored Invariants but empty Constraints adds
  **only** to Constraints (INV-2 additive/non-overwrite).
- An all-template constitution triggers the soft "author your constitution" advisory (FR-6);
  a populated one does not.
- The offered compaction strips all `DRAFT`/provenance and leaves meaning-equivalent prose;
  never runs silently (FR-8).

## Traceability

Materializes #269. Enforcement sequel: #270. Consumes the Tier-1 LLM path (DR-017 / agent-execute).
