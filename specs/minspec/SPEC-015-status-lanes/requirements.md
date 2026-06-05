---
id: SPEC-015
type: requirements
status: implementing  # built: lifecycle status lanes shipped (feat #105) + 98 tests pass (spec-tree-provider.test.ts 59 + lifecycle.test.ts 39)
tier: T3
product: minspec
epic: EPIC-003  # SDD Core Methodology
depends_on: [DR-012]
phases:
  specify: done
  plan: done
  tasks: done
  implement: in-progress
---

# Status Lanes — lifecycle-named SPECS groups

## Context

The SPECS explorer pane, when **not** grouping by epic, buckets specs under three
status groups: **Active / Done / Archived** ([spec-tree-provider.ts](../../../packages/minspec/src/views/spec-tree-provider.ts) `STATUS_GROUPS`).
"Active" lumps three distinct lifecycle states (`new`, `specifying`,
`implementing`) into one lane, so the pane does not show *where* in the SDD
lifecycle a spec sits — you cannot tell an unbuilt-but-being-authored spec from
one that is mid-build at a glance.

This spec relabels and restructures those lanes to read as lifecycle stages:
**Specifying / Implementing / Done / Archived**. It is the chosen **Option B
(pure status rename)** — it maps the existing `SpecStatus` values onto
lifecycle-named lanes. It deliberately does **not** introduce an "Approved" lane:
approval is an orthogonal axis (a spec is `status:implementing` *and*
`approval:approved` simultaneously — [DR-012](../../../docs/decisions/DR-012.md)),
already surfaced by the 🔒 lock row-icon. Folding it into the status lanes would
cross axes and make a spec's lane ambiguous.

Triggered by: #105

## Requirements

### Lanes

- **FR-1 (four lifecycle lanes).** The status-fallback grouping renders exactly
  four lanes in this fixed order: **Specifying**, **Implementing**, **Done**,
  **Archived**.

- **FR-2 (total, disjoint status→lane mapping).** Every `SpecStatus` value maps
  to exactly one lane — no spec can vanish from the pane and none can appear
  twice:

  | Lane | `SpecStatus` values |
  |---|---|
  | Specifying | `new`, `specifying` |
  | Implementing | `implementing` |
  | Done | `done` |
  | Archived | `archived` |

  `new` folds into **Specifying** (a freshly-created spec is pre-authoring, not
  yet building).

- **FR-3 (default expansion).** Lanes representing active work expand by default;
  terminal lanes collapse: **Specifying** and **Implementing** expanded; **Done**
  and **Archived** collapsed. (Matches today's "active expanded, terminal lanes
  collapsed" behaviour.)

- **FR-4 (empty lanes still shown).** A lane with zero specs still renders with
  its `(0)` count — no lane is hidden. (Preserves current behaviour; keeps the
  pane's shape stable.)

### Boundaries

- **FR-5 (status-fallback only).** This changes only the status-group path. Epic
  grouping (the default, FR-7 of SPEC-007) is untouched, as is the `RollupNode`
  done-count (still keyed on `status === 'done'`).

## Costly to Refactor (Zone A)

Ranked seam list — the parts of this change that are expensive to reverse or
get wrong, each tied to a concrete FR. Highest-cost first.

1. **The `STATUS_GROUPS` lane labels are the public, user-facing surface (FR-1).**
   Once shipped, "Specifying / Implementing / Done / Archived" become the names
   users build muscle memory around (R3). Renaming a lane again later is a
   visible churn cost — `spec-tree-provider.ts:152` is the single source, but the
   blast radius is every screenshot/doc/CHANGELOG that names the old "Active"
   lane.
2. **The status→lane mapping table (FR-2) is load-bearing for INV-1.** If a future
   `SpecStatus` value is added to the enum but not assigned a lane here, specs
   silently vanish from the pane. Cheap to edit the constant, but the *contract*
   that every status maps to exactly one lane is what is costly to break — guarded
   by the INV-1 T0 test.
3. **The `new → Specifying` fold (FR-2) is a semantic commitment.** Choosing to
   bucket `new` under Specifying (vs its own lane) is a product call; unwinding it
   later means re-teaching users and re-counting fixtures.
4. **Cheap / low-cost:** default-expansion flags (FR-3) and empty-lane rendering
   (FR-4) are pure presentation toggles on the same constant — trivially
   reversible, no contract.

## Invariants

- **INV-1 (no spec lost).** The union of all lanes' `SpecStatus` sets equals the
  full `SpecStatus` enum, and the sets are pairwise disjoint. A spec of any
  status appears in exactly one lane. *(T0 test — must hold even if a new status
  is added to the enum: the test fails loudly, forcing a lane decision.)*
- **INV-2 (deterministic order).** Lane order is always
  `[Specifying, Implementing, Done, Archived]`.

## Acceptance Criteria (Zone A)

Definition-of-done checkboxes, each tracing the FR / invariant it discharges.

- [ ] With epic grouping **off**, the pane renders exactly four group nodes in
  order `Specifying, Implementing, Done, Archived` (FR-1, INV-2).
- [ ] An `implementing` spec sits under **Implementing**; a `new` and a
  `specifying` spec both sit under **Specifying** (FR-2 mapping; the `new` fold).
- [ ] `STATUS_GROUPS` (`spec-tree-provider.ts:152`) is the only production code
  changed; `getStatusGroups()`, `RollupNode`, and `getEpicGroups()` are untouched
  (FR-5).
- [ ] **Specifying** and **Implementing** render `Expanded`; **Done** and
  **Archived** render `Collapsed` by default (FR-3).
- [ ] An empty lane still renders with its `(0)` count — no lane is hidden (FR-4).
- [ ] INV-1 T0 test asserts the union of all lanes' `SpecStatus` sets equals the
  full enum and the sets are pairwise disjoint; it fails loudly if a status is
  added without a lane (INV-1).
- [ ] INV-2 test asserts the lane-label order deep-equals
  `['Specifying','Implementing','Done','Archived']` (INV-2).
- [ ] Existing epic-grouping and `RollupNode` done-count tests remain green (FR-5).

## Non-Goals

- No "Approved" / "Stale" lane. Approval is orthogonal (DR-012), shown via the
  lock/⚠ row-icon — not a status bucket.
- No change to the `SpecStatus` enum, the spec frontmatter, or epic grouping.
- No data migration — purely a presentation relabel.

## Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `new` specs surprising users by appearing under "Specifying" | Low | Low | Documented in FR-2; `new` is pre-authoring, semantically a sub-state of specifying. Group tooltip can name both statuses. |
| R2 | Existing tests assert `Active/Done/Archived` labels, order, and counts → break on rename | High | Low | Update `spec-tree-provider.test.ts` group-label/order/count assertions as part of the change (T2 feature tests). |
| R3 | Users with muscle memory for "Active" lose the combined view | Low | Low | Specifying + Implementing both expanded by default → the former "Active" contents remain visible together at the top. Note in CHANGELOG. |
| R4 | A future `SpecStatus` value silently falls through to no lane | Low | Medium | INV-1 T0 test asserts total coverage of the enum → fails on any unmapped status. |

## Acceptance

- Pane (epic grouping off) shows Specifying / Implementing / Done / Archived in
  order, with correct counts; an `implementing` spec sits under Implementing, a
  `new`/`specifying` spec under Specifying.
- INV-1 / INV-2 tests pass; epic-grouping and rollup tests unchanged and green.

## Assumptions

- The `SpecStatus` enum has exactly these five values — `new`, `specifying`,
  `implementing`, `done`, `archived` — so FR-2's four lanes cover the whole space
  (INV-1 makes this self-checking if the assumption later breaks).
- The pane already renders arbitrary status groups from the `STATUS_GROUPS`
  constant via `getStatusGroups()` (`spec-tree-provider.ts:152,401`), so changing
  the constant's contents is sufficient — no new node type is needed (per
  design.md "Approach").
- `RollupNode`'s done-count keys on `status === 'done'` directly, not on a group
  label, so relabelling lanes cannot perturb the rollup (FR-5).

## Test-thought

Verified by the existing `spec-tree-provider.test.ts` suite: the INV-1/INV-2 T0
tests assert total+disjoint enum coverage and exact lane order; the updated T2
fixture-count tests drive `getStatusGroups()` over `ALL_SPECS` and assert the
four lanes, their counts, and per-lane default expansion (FR-1..FR-4).

## Coverage Map

Maps each mechanism / concern this spec introduces to the FR(s) that own it.

| Mechanism / concern | FR(s) |
|---|---|
| Four fixed lifecycle lanes in fixed order | FR-1, INV-2 |
| Total + disjoint status→lane mapping (`new`→Specifying) | FR-2, INV-1 |
| Default expand/collapse per lane | FR-3 |
| Empty lanes still rendered with `(0)` | FR-4 |
| Status-fallback path only; epic grouping + rollup untouched | FR-5 |

## Consequences

**Positive:**
- The SPECS pane now distinguishes a being-authored spec (`specifying`) from a
  mid-build one (`implementing`) at a glance — the core problem stated in Context
  (FR-1, FR-2).
- INV-1's T0 test turns "a new status silently has no lane" from a latent UI bug
  into a loud test failure (R4 → mitigated).

**Negative:**
- Users lose the single combined "Active" lane; the former contents are now split
  across two lanes (mitigated by both expanding by default — FR-3, R3), and every
  doc/screenshot naming "Active" is now stale (R3, CHANGELOG note required).
- One more lane means slightly more vertical space in the pane even when lanes are
  empty (FR-4 keeps empties visible by design).

## Failure-Modes / Edge-Cases

- **Unmapped future status.** A new `SpecStatus` value added to the enum without a
  lane assignment would make matching specs vanish from the status-fallback view
  (FR-2). Caught by the INV-1 T0 test, which asserts every enum value has a lane.
- **All lanes empty (no specs).** `getStatusGroups()` still emits four `(0)` lanes
  (FR-4); the `RollupNode` is the only node that omits when `allSpecs.length === 0`
  (`spec-tree-provider.ts:371`) — lanes themselves never collapse to nothing.
- **A spec with a malformed/unknown status string** (not a valid `SpecStatus`):
  out of scope here — frontmatter validation owns that gate; this spec assumes a
  valid enum value (see Assumptions). No distinct handling added.

## Test / Verification Strategy

Per-FR/invariant test tier and assertion sketch (file:
`packages/minspec/tests/spec-tree-provider.test.ts`).

| FR / INV | Tier | Assertion sketch |
|---|---|---|
| INV-1 | T0 | union of every `STATUS_GROUPS[].statuses` `===` full `SpecStatus` enum **and** pairwise-disjoint; fails if any enum value is unmapped. |
| INV-2 | T0 | `STATUS_GROUPS.map(g => g.label)` deep-equals `['Specifying','Implementing','Done','Archived']`. |
| FR-1 | T2 | `getChildren(undefined)` returns rollup + 4 group nodes in lane order. |
| FR-2 | T2 | with `ALL_SPECS`, a `new`+`specifying` spec land in Specifying `(2)`, `implementing` in Implementing `(1)`, `done` in Done `(1)`, `archived` in Archived `(1)`. |
| FR-3 | T2 | Specifying/Implementing `collapsibleState === Expanded`; Done/Archived `=== Collapsed`. |
| FR-4 | T2 | a status with zero specs still yields a group node with `(0)` in its label. |
| FR-5 | T3 (regression) | epic-grouping (`getEpicGroups()`) and `RollupNode` done-count tests remain unchanged and green. |

## Alternatives Considered

- **Option A — add an "Approved" lane** alongside the status lanes. Rejected:
  approval is an orthogonal axis to status (a spec is `implementing` *and*
  `approved` simultaneously — DR-012), already shown by the 🔒 row-icon. Folding
  it into the status lanes would cross axes and make a spec's lane ambiguous (see
  Context + Non-Goals).
- **Option C — give `new` its own lane** instead of folding it into Specifying.
  Rejected: `new` is pre-authoring, a sub-state of specifying; a separate lane
  would add an almost-always-empty lane and more vertical noise for no
  lifecycle-distinction value (FR-2 rationale).
- **Chosen: Option B (pure status rename)** — map existing `SpecStatus` values
  onto lifecycle-named lanes; no enum change, no migration (Context).

## Rollback / Reversibility

Fully reversible by reverting the `STATUS_GROUPS` constant in
`spec-tree-provider.ts:152` back to the three Active/Done/Archived lanes and
reverting the `spec-tree-provider.test.ts` label/count assertions — a single-file
production revert plus its test. No data, frontmatter, or enum change to undo
(Non-Goals: "purely a presentation relabel"). **ADR-filter:** undoable in well
under a day → no new DR is warranted for the lane relabel itself; the orthogonal-
axis rationale it leans on already lives in DR-012.

## Dependencies & Blast-Radius

- **Declared dependency:** DR-012 (status vs approval are orthogonal axes) — the
  rationale for *not* adding an Approved lane (Context, Non-Goals).
- **File changed:** `packages/minspec/src/views/spec-tree-provider.ts` — only the
  `STATUS_GROUPS` constant (line 152). `getStatusGroups()`, `RollupNode`, and
  `getEpicGroups()` are read-but-not-modified.
- **What breaks if `STATUS_GROUPS` is changed wrong:** specs disappear from or
  duplicate in the status-fallback pane (guarded by INV-1); lane order or labels
  drift (guarded by INV-2). Epic grouping and the done-rollup are insulated
  because they do not read the lane labels (FR-5) — so blast radius is confined to
  the status-fallback rendering path and its test fixtures.

## Out of scope

The id-based boundary of the FR set (FR-1..FR-5): concerns that touch the same
SPECS pane / lifecycle surface but are owned elsewhere, framed as the
set-difference against what FR-1..FR-5 actually cover. Complements (does not
restate) **Non-Goals** above — Non-Goals lists the prose exclusions ("no Approved
lane", "no enum change"); this section names the *owning* FR/spec/DR for each
thing outside the FR boundary.

- **Epic grouping (the default view).** The epic-grouped path is explicitly the
  other side of FR-5's "status-fallback only" boundary; it is owned by SPEC-007
  FR-7 and its `getEpicGroups()`. This spec read-but-does-not-modify it
  (Dependencies & Blast-Radius). Out — different rendering path.
- **The `RollupNode` done-count.** Keyed on `status === 'done'` directly, not on a
  lane label (FR-5; Assumptions). Relabelling lanes cannot perturb it, so it is
  outside the FR set even though it lives in the same provider file. Owned by
  SPEC-007's rollup, exercised here only as an FR-5 regression (Test/Verification
  Strategy, FR-5 row).
- **The approval axis / approval gate.** Whether a spec is approved is orthogonal
  to its status lane and stays out by construction — owned by **DR-012** and
  surfaced via the 🔒 lock/⚠ row-icon, never a status bucket (Context;
  Non-Goals). FR-1's four lanes are status-only; no "Approved" lane is in scope.
- **Frontmatter / status-string validation.** A malformed or unknown
  `SpecStatus` string is gated by frontmatter validation, not here; this spec
  assumes a valid enum value (Assumptions; Failure-Modes "malformed status").
  INV-1's T0 test forces a *lane decision* for any newly-added valid status, but
  validating that the string is a legal `SpecStatus` is a separate gate's job.
- **Signpost / next-task correctness.** Which spec or task the pane points the
  human at next is the signpost's concern, owned by SPEC-010 — not the lifecycle
  *lane* a spec is bucketed under. FR-1..FR-4 govern grouping/order/expansion of
  the lanes only, not next-task selection.
- **Self-audit of spec health.** Detecting stale/inconsistent specs (e.g. a
  `done` spec with unchecked acceptance criteria) is owned by the self-audit
  surface, SPEC-013 — out here, since FR-2 maps the *declared* status to a lane
  and does not judge whether that status is correct.
- **Validator / phase-detection follow-ups.** The api-`'rest'` false-positive
  (#108) and phase-detection brittleness + gate policy (#109) raised by the
  sibling design.md are tracked there and explicitly out of this spec
  (Follow-ups; restated here as an id-anchored exclusion).

## Follow-ups (tracked)

- **CHANGELOG note** that "Active" lane is renamed/split into Specifying +
  Implementing (R3) — non-code copy task, not an SDD spec; file at extension
  publish time (DR-023 forward rule).
- Validator/approval-gate items surfaced by the sibling design.md are already
  tracked: #108 (api 'rest' false-positive) and #109 (phase-detection brittleness
  + gate policy). Out of scope for this spec.
- No other follow-ups — the change is a localized presentation relabel.
