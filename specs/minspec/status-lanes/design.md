---
id: SPEC-015
type: design
status: specifying
tier: T2
product: minspec
epic: EPIC-003  # SDD Core Methodology
depends_on: [DR-012]
---

# Status Lanes — Plan

Plan phase for [SPEC-015](./requirements.md). Implements the four lifecycle lanes
(Specifying / Implementing / Done / Archived) defined in the requirements.

## Approach

Single localized change to the status-fallback grouping in
[spec-tree-provider.ts](../../../packages/minspec/src/views/spec-tree-provider.ts).
The pane already supports arbitrary status groups via the `STATUS_GROUPS`
constant and `getStatusGroups()`; only the constant's contents change. No new
node types, no API changes, no migration.

## Changes

### 1. `STATUS_GROUPS` constant

Replace the three-lane table with four lifecycle lanes (FR-1, FR-2, FR-3):

```ts
const STATUS_GROUPS: StatusGroup[] = [
  { label: 'Specifying',   statuses: ['new', 'specifying'], defaultExpanded: true  },
  { label: 'Implementing', statuses: ['implementing'],      defaultExpanded: true  },
  { label: 'Done',         statuses: ['done'],              defaultExpanded: false },
  { label: 'Archived',     statuses: ['archived'],          defaultExpanded: false },
];
```

`new` folds into **Specifying** (FR-2). Order is the array order (FR-1). Active
lanes expanded, terminal lanes collapsed (FR-3).

### 2. No other production code

`getStatusGroups()` already maps over `STATUS_GROUPS` and filters specs by each
group's `statuses`, rendering `(N)` counts for every lane including empties
(FR-4). `RollupNode` keys its done-count on `status === 'done'` directly — not on
group labels — so it is unaffected (FR-5). Epic grouping is a separate path
(`getEpicGroups()`) and is untouched (FR-5).

## Tests (`spec-tree-provider.test.ts`)

### Invariant tests (T0 — write first)

- **INV-1 (total + disjoint).** Assert the union of every `STATUS_GROUPS[].statuses`
  equals the full `SpecStatus` enum, and no status appears in two lanes. Drive it
  from a literal list of all `SpecStatus` values so that adding a status to the
  enum without assigning a lane fails this test loudly.
- **INV-2 (order).** Assert `STATUS_GROUPS.map(g => g.label)` deep-equals
  `['Specifying', 'Implementing', 'Done', 'Archived']`.

To assert INV-1 against the enum, export the canonical status list (or reuse the
existing `SpecStatus` union via a const array) so the test can detect drift.

### Feature/regression tests (T2 — update existing)

The current suite asserts `Active/Done/Archived` labels, order, counts, and
default-expansion. Update those expectations:

- `getChildren(undefined)` returns rollup + **4** group nodes.
- Group order: `Specifying, Implementing, Done, Archived`.
- Specifying + Implementing `collapsibleState === Expanded (2)`; Done + Archived
  `=== Collapsed (1)`.
- Counts: with `ALL_SPECS` (SPEC-001 new→Specifying, SPEC-002 specifying→
  Specifying, SPEC-003 implementing→Implementing, SPEC-010 done→Done, SPEC-020
  archived→Archived): Specifying `(2)`, Implementing `(1)`, Done `(1)`,
  Archived `(1)`.
- `getChildren(specifyingGroup)` returns the two specifying-stage specs;
  `getChildren(implementingGroup)` returns the implementing spec.

## Risks & Mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | A future `SpecStatus` value silently has no lane | INV-1 T0 test fails on any unmapped status (DR-003 asymmetry: assert every status *has* a lane, not just that mapped ones are valid). |
| R2 | Existing fixture-count tests break on the relabel | Updated in this plan's test section; counts recomputed against `ALL_SPECS`. |
| R3 | Epic-grouping fixtures accidentally affected | They exercise `getEpicGroups()`, a separate path; left unchanged and must stay green. |

## Out of scope

Validator/approval-gate changes (parked: #108 api 'rest' false-positive, #109
phase-detection brittleness + gate policy). This spec only relabels the lanes.
