---
epic: EPIC-005  # Auto Structure Repair
id: SPEC-005
type: requirements
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: specifying
product: minspec
---

# MinSpec — Auto-Structure-Repair (Requirements)

**Date:** 2026-05-30
**Status:** Specifying (SDD Specify phase)
**Decision:** [DR-006 addendum](../../../docs/decisions/DR-006.md)
**Triggered by:** session request — "auto-fix the SDD structure whenever needed"

---

## Context

The detect-and-offer auto-bootstrap system (DR-006, `src/lib/auto-bootstrap.ts`)
already offers `init` / `refresh` / `classify` on activation. Two gaps make it
fall short of "whenever needed":

- **A — shallow detection:** `isMinspecInitialized()` checks only that `.minspec/`
  exists. A partial structure (dir present, `config.json`/`constitution.md`
  missing) reports initialized → no repair offered.
- **B — activation-only:** detection fires once at startup; mid-session breakage
  is never re-detected.

## Requirements

- **FR-1 (integrity detection).** Detection MUST treat the structure as
  incomplete when any *required artifact* is missing, not merely when `.minspec/`
  is absent. Required set: `.minspec/`, `.minspec/config.json`,
  `.minspec/constitution.md`, and the required harness output files.
- **FR-2 (reactive trigger).** A debounced watcher on `.minspec/**` and required
  harness paths MUST re-run detection on delete/change and surface the existing
  offer toast when a required artifact goes missing mid-session.
- **FR-3 (offer, never silent).** Repair is offered via the existing toast
  (`[Fix] / [Not now] / [Don't ask again]`); it MUST NOT auto-write without a
  user action. No new silent-apply setting.
- **FR-4 (idempotent repair).** Accepting the offer runs `minspec.init`, which
  writes only absent files (existing `scaffold()` / `generateHarnessFiles()`
  semantics). MUST NOT overwrite or merge existing user files.
- **FR-5 (consent reuse).** Honors existing per-check `preferences.json`
  dismissals and the `minspec.autoBootstrap.enabled` master toggle. No new
  consent surface.
- **FR-6 (silent marker-bounded refresh — DR-011 Layer 2).** Once the project is
  initialized, the refresh path MAY re-sync MinSpec's own `minspec:*` marker
  sections **without a toast**, because the merge only ever rewrites content
  between markers (invariant #6). Any change that would alter content OUTSIDE a
  marker, and the initial missing-structure offer, still prompt. Gated by
  `minspec.autoBootstrap.enabled`.

## Invariants (must hold)

- **INV — Tier 0 (DR-004):** detection + repair are pure file-system; no AI, no
  network.
- **INV #5 (user override wins):** every offer dismissible; master toggle exits.
- **INV (non-destructive):** repair never overwrites or deletes user content.

## Out of scope

- Repairing *corrupt* artifacts (invalid `config.json`, malformed constitution).
  Additive/missing-only. Corrupt-file repair parked as
  [harvest316/minspec#39](https://github.com/harvest316/minspec/issues/39).
  (A lint to catch future dangling "parked as a separate issue" references with
  no link is tracked as
  [#40](https://github.com/harvest316/minspec/issues/40).)
- Any change to the consent model or new silent-apply behavior.

## Open questions

- Exact "required harness files" list — derive from `TEMPLATE_OUTPUT_PATHS` vs a
  curated subset (some harness files may be optional).
- Watcher debounce interval + dedupe against the activation-time run.
