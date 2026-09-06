---
id: SPEC-007
type: requirements
tier: T4
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: done
product: minspec
epic: EPIC-001  # Explorer Epic Grouping
implements:
  - packages/minspec/src/views/epic-grouping.ts
  - packages/minspec/src/commands/epic.ts
  - packages/minspec/tests/epic-manager.test.ts
# NOT `epic-manager.ts`: SPEC-041 already declares it, and one-owner-per-file wins over
# who-created-it (flagged separately — SPEC-007's commits created that file).
# `affects:` is deliberately NARROW rather than complete. Six further files this spec's commits
# touched (commands/approve.ts, commands/validate.ts, tests/backlog.test.ts,
# tests/spec-tree-provider.test.ts, tests/frontmatter-completion.test.ts,
# tests/spec-validator.test.ts) are omitted on the SPEC-060 precedent: listing a shared file
# under `affects:` freezes it for every other spec's work, so only surfaces this spec is the
# reason to touch are listed. This is an explicit exclusion criterion, NOT a claim that nothing
# else was touched.
---

# MinSpec — Registered Epics & Cross-Artifact Grouping (Requirements)

**Date:** 2026-05-30
**Status:** Done
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

## Costly to Refactor (Zone A)

Ranked seams — getting these wrong is expensive to unwind once artifacts carry
the field and panels ship:

1. **`epic-manager.ts` public surface (FR-5).** `listEpics` / `groupByEpic` /
   `NO_EPIC` reach the 3 panels through the `buildEpicGroups` wrapper in
   `views/epic-grouping.ts`; `listEpics` also feeds completion
   (`frontmatter-completion.ts`) and `epicRefValue` feeds the validator
   (`spec-validator.ts`). Their signatures (id-or-slug input, `EpicSummary | null`
   from `resolveEpic`, `NO_EPIC` sentinel) are a de-facto contract — changing them
   means touching `epic-grouping.ts` plus every direct importer. Get the resolver
   shape right first (design lands it first).
2. **The `epic:` frontmatter key + dual id-OR-slug grammar (FR-4).** Once specs
   and ADRs on disk carry `epic: EPIC-001` *or* `epic: telemetry`, renaming the
   key or dropping slug-acceptance is a mass data migration across `specs/**` and
   `docs/decisions/**`. The accept-both decision is hard to reverse.
3. **`EPIC-NNN` id scheme + `docs/epics/` location (FR-1, FR-10).** Sequential
   ids are referenced by other artifacts; relocating the dir or changing the id
   format breaks every `epic:` ref and the generated `INDEX.md` anchor. Mirrors
   the ADR id/dir lock — chosen deliberately to reuse that pattern.
4. **Issue label convention `epic:<slug>` (FR-4).** Lives in GitHub, not the
   repo; rewriting it later means relabelling live issues. Cheaper than the above
   but still external state.

Low-cost / safe to change later: the per-panel toggle default (FR-7), the
done/total badge formula (OQ-1), grouping depth — all UI-local, no on-disk
contract.

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

## Acceptance Criteria (Zone A)

Definition-of-done — each traces to the FR/INV it satisfies:

- [ ] **MinSpec: Create Epic** writes `docs/epics/EPIC-NNN.md` with `id/slug/title/status/order`
      frontmatter, number = `max(EPIC-NNN)+1`, no hand-picked ids (FR-1, FR-2).
- [ ] `docs/epics/INDEX.md` regenerates from the registry, writing **only** inside
      the `minspec:epic-index` markers; content outside markers is untouched (FR-3, INV #6).
- [ ] A spec/ADR with `epic: EPIC-001` and one with `epic: telemetry` both resolve
      to the same registry entry via `resolveEpic` (FR-4, FR-5).
- [ ] An issue labelled `epic:telemetry` groups under that epic in the backlog; no
      GitHub Milestone is created (FR-4).
- [ ] All three panels (`spec-tree-provider`, `adr-tree-provider`, `backlog-view`)
      show a top-level epic layer sorted by `order` then `id`, with a trailing
      **"(no epic)"** group for unref'd/unresolved artifacts (FR-6).
- [ ] Each panel's grouping toggle defaults **on**, persists across reload, and a
      flat view remains reachable (FR-7, INV #5).
- [ ] With grouping **off**, each tree is byte-identical to pre-feature behaviour (INV #5).
- [ ] Frontmatter completion offers `epic:` and completes known ids + slugs; spec/ADR
      templates document the field (FR-8).
- [ ] An `epic:` ref with no matching registry file produces a **warning** diagnostic
      and "(no epic)" placement — never a hard block (FR-9, INV ceremony∝complexity).
- [ ] A repo with no `docs/epics/` dir loads with all artifacts ungrouped and no
      errors; `minspec init`/`--refresh` creates the dir + empty marker INDEX (FR-10).
- [ ] Epic resolution + grouping perform no AI call and no network beyond the
      backlog's existing `gh issue list` (INV — Tier 0 / DR-004).

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|------|---------------------|------------|
| 1 | Duplicate resolution logic creeps into individual panels instead of `resolveEpic`, so id-vs-slug handling drifts between panels (FR-5). | Med · High | Single `epic-manager.ts` resolver; design lands it first; T1 contract test covers id+slug parity. |
| 2 | `epic:` value typo (wrong id/slug) silently hides an artifact from its epic (FR-4, FR-9). | Med · Med | Unresolved ref = warning diagnostic **and** visible "(no epic)" placement (FR-6) — never hidden. |
| 3 | Index regeneration clobbers hand-written prose in `docs/epics/INDEX.md` (FR-3). | Low · High | `minspec:epic-index` marker boundary (DR-011, INV #6); writer only touches inside markers; T0 test asserts outside-marker bytes preserved. |
| 4 | Grouping-on path diverges from legacy flat tree, regressing the default panel UX (FR-6, FR-7). | Med · Med | Toggle-off must be byte-identical (INV #5); T0 snapshot test guards it. |
| 5 | `order` missing/non-numeric in an epic file breaks the sort (FR-1, FR-6). | Low · Med | `Number()` coercion with default `999` (per design); malformed epics sink to the end, not crash. |
| 6 | Scaffold on an existing repo without `docs/epics/` throws instead of degrading (FR-10). | Low · High | Absent dir → all-ungrouped graceful path; T0 test runs against a dir-less fixture. |

## Assumptions

- The ADR manager's lightweight YAML parser pattern (`parseFrontmatterYaml`) is
  reusable for `EPIC-NNN.md` frontmatter — no new YAML dependency needed (per design).
- The `gh issue list` call the backlog already makes returns label arrays, so
  `epic:<slug>` extraction needs no new network call (INV — Tier 0).
- Config gains an `epicsDir` key mirroring `decisionsDir`; default `docs/epics`
  is writable in the workspace.
- Issue label namespace `epic:` does not collide with existing `wsjf:` / priority /
  lifecycle label prefixes (FR-4).

## Test-thought

Verified three ways: T1 contract tests on `epic-manager` (id+slug resolve, sort,
`nextEpicId` padding, `NO_EPIC` bucketing); T0 invariant tests (toggle-off
byte-identical tree, unknown-ref no-throw + warning, markers-only INDEX write,
dir-less graceful load); T2 feature tests (panel groups render with correct
done/total badges, backlog `epic:<slug>` label resolution).

## Consequences

**Positive:**
- A multi-artifact effort (spec + ADR + issues) becomes one visible unit across
  all three panels (FR-6) — the core gap Context names.
- `resolveEpic` (FR-5) is a single reuse point; future consumers (reports,
  roll-up math) inherit consistent id/slug handling for free.
- Fully additive + optional (INV ceremony∝complexity): existing repos and
  artifacts work unchanged with zero migration (FR-10).

**Negative:**
- A fourth artifact type (EPIC) adds registry/index/create-command surface to
  maintain alongside specs and ADRs (FR-1–FR-3).
- Three panels now carry a grouping code path + toggle state, doubling each
  panel's tree-construction branches (FR-6, FR-7).
- The id-OR-slug dual grammar (FR-4) is a permanent acceptance burden on the
  resolver and completion.

## Failure-Modes / Edge-Cases

- **Slug collision:** two epics declare the same `slug` — `resolveEpic` must pick
  deterministically (first by `order` then `id`) or the validator should warn; not
  yet specified beyond FR-5's single-resolver mandate. Enumerated for design.
- **Epic ref points at an `abandoned` epic:** resolves fine (FR-4) but should the
  artifact still group under it? Default: yes, group; badge reflects status.
- **Empty epic (registered, zero members):** appears as a group with `0/0` badge
  vs being hidden — FR-6 says never hide a real group; `0/0` is acceptable.
- **Issue with multiple `epic:<slug>` labels:** first-match-wins via
  `extractEpicSlug`; multi-epic membership is out of scope (single grouping dim).
- **Malformed `EPIC-NNN.md` (bad frontmatter):** skipped from `listEpics`, not a
  crash; its referrers fall to "(no epic)" with the FR-9 warning.

## Test / Verification Strategy

Per-FR test tier + assertion sketch:

| FR | Tier | Assertion sketch |
|----|------|------------------|
| FR-1 registry | T1 | `listEpics` parses id/slug/title/status/order; malformed file skipped. |
| FR-2 create cmd | T2 | `createEpic` writes file with `nextEpicId` = max+1, zero-padded. |
| FR-3 index | T0 | `writeEpicIndex` mutates only bytes between `minspec:epic-index` markers. |
| FR-4 ref grammar | T1 | `resolveEpic('EPIC-001')` === `resolveEpic('telemetry')`; issue `epic:<slug>` label extracted. |
| FR-5 single resolver | T1 | All consumers call `resolveEpic`; no duplicate resolver (grep gate / review). |
| FR-6 grouping | T2 | Each provider yields epic groups sorted order→id + trailing `NO_EPIC`. |
| FR-7 toggle | T0 | Toggle off → tree byte-identical to legacy; state persists across reload. |
| FR-8 completion | T2 | Completion offers `epic:` key + known id/slug values. |
| FR-9 soft validation | T0 | Unresolved ref → warning diagnostic, never throws / blocks. |
| FR-10 scaffold | T0 | Dir-less repo loads ungrouped no-error; `init` creates dir + marker INDEX. |

## Alternatives Considered

- **GitHub Milestones as the grouping primitive** — rejected (FR-4 explicit): adds
  a GitHub write-integration, breaks the Tier-0 / label-only constraint (INV —
  Tier 0), and couples grouping to one issue tracker.
- **A merged single "work item" tree** collapsing spec/ADR/issue into one node —
  rejected (Out of scope): erases the artifact-kind distinction the three panels
  exist to preserve; epics group *across* panels without merging them.
- **Inferring epics from existing artifacts** (auto-assign by heuristic) — rejected
  (Out of scope): violates the no-AI Tier-0 invariant and risks wrong groupings;
  epic refs stay explicit.
- **A global single grouping toggle** instead of per-panel — rejected (OQ-2): a dev
  may want grouped specs but flat backlog; per-panel (FR-7) is the resolved default.

## Dependencies & Blast-Radius

Declared dependencies and what breaks if each changes:

- **`lib/epic-manager.ts` (new contract, FR-5)** — directly imported by
  `views/epic-grouping.ts` (`listEpics` / `groupByEpic` / `NO_EPIC`),
  `views/frontmatter-completion.ts` (`listEpics`), `lib/spec-validator.ts` +
  `lib/adr-manager.ts` (`epicRefValue`), `views/backlog-view.ts`
  (`extractEpicSlug` via `lib/backlog.ts`), and `commands/epic.ts` (`createEpic` /
  `writeEpicIndex`). The three panels reach grouping only through
  `epic-grouping.ts`'s `buildEpicGroups`, so changing `groupByEpic` / `EpicSummary`
  ripples to `epic-grouping.ts` first, then the panels behind it.
- **`lib/spec.ts` + `lib/spec-manager.ts`** — `SpecFrontmatter.epic?` / `SpecSummary.epic?`.
  Additive; removing the field breaks spec grouping but not parsing.
- **`lib/adr-manager.ts`** — `AdrFrontmatter.epic?` / `AdrSummary.epic?`. Same shape
  as spec; shared YAML parser, so a parser change hits both.
- **`lib/config.ts`** — new `epicsDir` key; mis-defaulting relocates the whole registry.
- **`lib/scaffold.ts` + `package.json` (commands/menus) + `extension.ts`** — wiring;
  a missing registration silently disables Create Epic or a toggle.
- **External: GitHub issue labels `epic:<slug>`** — not in-repo; backlog grouping
  depends on label hygiene.

Blast-radius note: highest concentration is the panel-facing `buildEpicGroups`
wrapper in `views/epic-grouping.ts` (all 3 tree providers route through it) over
`epic-manager`'s `listEpics` / `groupByEpic`, plus the dual-grammar `epic:` field
on-disk; the `epic-manager` surface and the on-disk grammar are both flagged in
"Costly to Refactor". UI toggles/badges are blast-radius-low (panel-local).

## Rollback / Reversibility

- **Undo mechanism:** the feature is additive and toggle-gated. Disabling grouping
  (toggle off, INV #5) returns each panel to byte-identical legacy behaviour with
  no data change. Fully removing it = delete `epic-manager.ts` + the `epic?` fields
  + revert panel/command/scaffold wiring; on-disk `epic:` frontmatter and
  `epic:<slug>` labels become inert (ignored), not errors.
- **ADR-filter answer:** can this be undone in < 1 day? **No** for the contract +
  on-disk grammar — once artifacts carry `epic:` refs and the `EPIC-NNN` registry
  exists, reversal is a data migration. Hence DR-013 records the rationale, and the
  resolver/grammar/id-scheme seams are pinned in "Costly to Refactor".

## Coverage Map

| Mechanism / Concern | FR(s) |
|---|---|
| Epic registry artifact + id scheme | FR-1, FR-2 |
| Generated marker-bounded index | FR-3 (INV #6, DR-011) |
| Cross-artifact reference grammar (id/slug/label) | FR-4 |
| Single resolution point | FR-5 |
| Explorer grouping + "(no epic)" group | FR-6 |
| Per-panel toggle + flat fallback | FR-7 (INV #5) |
| Completion + template docs | FR-8 |
| Soft (warning) validation | FR-9 (INV ceremony∝complexity) |
| Scaffold + graceful degradation | FR-10 |
| Tier-0 / no-network / no-AI | INV — Tier 0 (DR-004) |

## Follow-ups (tracked)

- Weighted / WSJF epic roll-up math beyond the simple `done/total` badge —
  deferred (Out of scope); future follow-up, no issue filed yet.
- Slug-collision handling in `resolveEpic` (Failure-Modes) — surface to design;
  decide deterministic tiebreak vs validator warning before implement closes FR-5.
- Public-leakage gate for `EPIC-NNN` ids if epics are ever surfaced in published
  output (INV-1) — inherits the DR-id visibility rule; no new work until that
  surfacing exists.

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
