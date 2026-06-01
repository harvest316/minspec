---
id: SPEC-011
type: requirements
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: specifying
product: minspec
epic: EPIC-001  # Explorer Epic Grouping
---

# MinSpec — AI-assisted Epic Backfill (Requirements)

**Date:** 2026-05-31
**Status:** Specifying
**Decision:** [DR-016](../../../docs/decisions/DR-016.md)
**Triggered by:** session request — "offer to backfill epics during onboarding, intelligently guessing the epics list then the mappings, via `claude -p`."

---

## Context

DR-013 shipped registered epics; existing artifacts carry no `epic:` ref.
Backfill proposes an epic taxonomy + artifact→epic mapping and offers to apply
it. Two engines: a Tier-0 heuristic (air-gapped) and a Tier-1 `claude -p` AI pass
(opt-in). HITL review before any write. DR-004 already permits the `claude -p`
delegation as Tier 1 — no invariant change.

## Requirements

- **FR-1 (proposal contract).** Both engines return one `BackfillProposal`:
  candidate epics (`slug`, `title`, optional existing `id`, `rationale`) +
  mappings (`artifactId`, `kind: 'spec'|'adr'`, `filePath`, `epicSlug`,
  `confidence`, `rationale`). `source: 'heuristic'|'ai'`.
- **FR-2 (heuristic engine, Tier 0).** Pure file-system. Cluster specs/ADRs by:
  spec-kit subdir name, shared title/tag token overlap (reuse the
  `findSimilarAdrs` Jaccard tokenizer), and existing `epic:` refs. No `claude`,
  no network. Always available.
- **FR-3 (AI engine, Tier 1).** Shell `claude -p` (via `execFile`, mirroring the
  `gh` pattern) with an artifact digest + strict JSON-only schema instruction.
  Parse + validate into `BackfillProposal`. MUST check `claude` availability
  first (mirror `isGhAvailable`).
- **FR-4 (graceful degradation).** `claude` absent / non-JSON output / timeout /
  non-zero exit → fall back to the heuristic proposal. NEVER throw to the user;
  NEVER block.
- **FR-5 (HITL review).** Apply nothing without explicit user approval. Surface
  the proposal (epics + mappings + rationale) for review; a modal confirm gates
  `applyBackfill`.
- **FR-6 (apply).** On approval: create new EPIC-NNN files (via `createEpic`),
  insert `epic:` frontmatter into each mapped artifact, regenerate the epic
  INDEX. Idempotent. Artifacts already carrying an `epic:` are skipped unless the
  user opts to override.
- **FR-7 (frontmatter insert).** A generic `setArtifactEpic(filePath, ref)` adds
  or replaces the `epic:` line inside an existing frontmatter block without
  disturbing other content (mirror `setAdrStatus`). Throws only on a file with no
  frontmatter block.
- **FR-8 (onboarding offer).** `auto-bootstrap` gains `hasUnbackfilledEpics()` +
  an offer step. The offer surfaces during the existing detect-and-offer flow;
  the `claude -p` call runs ONLY on explicit action. First-run stays Tier 0.
- **FR-9 (command).** `minspec.backfillEpics`: build heuristic proposal; if
  `claude` available, offer the AI-enhanced pass; review; apply; refresh panels.

## Invariants (must hold)

- **INV — DR-004 tiering.** Core stays Tier 0: no network/`http`/`fetch` in the
  extension. AI is Tier-1 delegation to the local `claude` binary only; the
  extension makes zero outbound connections. Heuristic engine + apply are pure
  file-system.
- **INV — graceful degradation (DR-004 Tier 1).** Every Tier-1 path degrades to a
  Tier-0 result when `claude` is absent. The feature is never a hard dependency.
- **INV — HITL (DR-012 ethos).** No frontmatter write without explicit approval.
  No silent mass-rewrite.
- **INV #6 (markers).** Regenerated epic INDEX writes only inside MinSpec markers.
- **INV (ceremony ∝ complexity).** Backfill is opt-in; never runs unprompted.

## Out of scope

- Backfilling **issue** epic labels (GitHub writes) — specs/ADRs only in v1.
  (Issues already self-serve via the `epic:<slug>` label.)
- Re-running AI to *critique* an existing taxonomy.
- Auto-apply without review; bidirectional sync; weighted confidence tuning.
- Multi-model / provider choice — `claude -p` only (the locally-installed binary).

## Open questions

- **OQ-1 — review surface.** Modal summary + confirm (simplest) vs. an editable
  generated markdown proposal the user tweaks before apply. Proposed: generated
  markdown preview opened read-only + modal confirm for v1; inline editing later.
- **OQ-2 — AI prompt size.** Full prose vs. title+first-paragraph digest. Proposed:
  digest (id, kind, title, first non-empty paragraph) to bound token cost.
