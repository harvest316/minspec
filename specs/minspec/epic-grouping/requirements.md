---
id: SPEC-007
type: requirements
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: done
product: minspec
epic: EPIC-001  # Explorer Epic Grouping
---

# MinSpec — Registered Epics & Cross-Artifact Grouping (Requirements)

**Date:** 2026-05-30
**Status:** Specifying (SDD Specify phase)
**Decision:** [DR-013](../../../docs/decisions/DR-013.md)
**Triggered by:** session request — "add an epic field to frontmatter and group DRs, specs and issues by it in the explorer panels."

---

## Context

Specs, ADRs, and issues describe the same bodies of work but are listed flat and
siloed across three explorer panels. There is no grouping dimension above the
individual artifact, so a multi-artifact effort (e.g. "telemetry") is not visible
as one unit. DR-013 introduces **registered epics**: a small new artifact type
the others reference, plus an epic grouping layer in each panel.

## Requirements

- **FR-1 (epic registry).** A new artifact type lives in `docs/epics/EPIC-NNN.md`,
  sequential from `EPIC-001`, with frontmatter `id`, `slug`, `title`, `status`
  (`proposed|active|done|abandoned`), `order` (number). Body is freeform prose.
- **FR-2 (create command).** A **MinSpec: Create Epic** command computes
  next-number = `max(existing EPIC-NNN) + 1`, writes the template, mirroring
  **Create ADR**. No hand-picked numbers.
- **FR-3 (generated index).** A marker-bounded `docs/epics/INDEX.md` is generated
  from the registry, mirroring the ADR `INDEX.md` pattern (DR-011 markers). MinSpec
  owns content inside the markers only.
- **FR-4 (artifact reference).** Specs and ADRs gain an optional `epic:`
  frontmatter field accepting **either** the id (`EPIC-001`) **or** the slug
  (`telemetry`). Issues reference an epic via a GitHub label `epic:<slug>`,
  consistent with existing `wsjf:` / lifecycle / priority label conventions. No
  GitHub Milestones, no new GitHub primitive.
- **FR-5 (single resolver).** One `resolveEpic(ref)` in a new `epic-manager.ts`
  maps id-or-slug → registry entry. Every consumer (3 panels, validator,
  completion) uses it — no duplicate resolution logic.
- **FR-6 (explorer grouping).** Each of the three panels (`spec-tree-provider`,
  `adr-tree-provider`, `backlog-view`) gains a top-level epic grouping layer,
  sorted by epic `order` then `id`. Artifacts with no/unresolved epic ref collect
  under a synthetic **"(no epic)"** group — never hidden.
- **FR-7 (view toggle).** Grouping is a per-panel view toggle, **default on**;
  flat (ungrouped) view remains available. Toggle state persists.
- **FR-8 (completion + template).** Frontmatter completion offers the `epic:`
  field and completes known id/slug values from the registry. Spec/ADR templates
  document the optional field.
- **FR-9 (soft validation).** An `epic:` ref that does not resolve to a registry
  file is a **warning** (diagnostic + "(no epic)" placement), NOT a hard block.
- **FR-10 (scaffold).** `minspec init` / `--refresh` creates `docs/epics/` with a
  generated empty `INDEX.md`. Existing repos without the dir degrade gracefully
  (all artifacts ungrouped, no errors).

## Invariants (must hold)

- **INV — Tier 0 (DR-004):** epic resolution + grouping is pure file-system /
  label parsing. No AI, no network beyond the existing `gh issue list` the backlog
  already calls.
- **INV (ceremony ∝ complexity):** epics are optional everywhere. Absent `epic:` =
  ungrouped, never an error. Unknown epic ref = warning, never a block.
- **INV #5 (user override wins):** grouping is a toggle; flat view always
  available.
- **INV #6 (markers):** generated `docs/epics/INDEX.md` only writes inside MinSpec
  markers (DR-011).
- **INV-1 (`minspec-extension-deployed`):** no public `DR-NNN`/`EPIC-NNN` leakage
  rules unchanged; epic ids are internal, same visibility gate as DR ids if ever
  surfaced publicly.

## Out of scope

- GitHub Milestones or any GitHub write-integration for epics (labels only).
- Bidirectional sync (editing an epic in the panel writing back to many
  artifacts at once).
- Epic completion **roll-up math** beyond a simple done/total count (the `3/7`
  badge); weighted/WSJF roll-up is a future follow-up.
- A merged single "work item" tree collapsing spec/ADR/issue distinctions.
- Auto-assigning epics to existing artifacts (no inference).

## Resolved (were open questions)

- **OQ-1 — done/total badge source. RESOLVED (default).** Badge = (artifacts in
  epic with terminal status) / (total in epic). Terminal per kind: spec
  `status: done`, ADR `status: accepted|done`, issue closed (GitHub state).
- **OQ-2 — toggle granularity. RESOLVED (default).** Per-panel toggle (FR-7), not
  one global setting.
