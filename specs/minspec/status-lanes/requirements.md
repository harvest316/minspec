---
id: SPEC-015
type: requirements
status: specifying
tier: T2
product: minspec
epic: EPIC-003  # SDD Core Methodology
depends_on: [DR-012]
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
  and **Archived** collapsed. (Matches today's "active expanded, rest collapsed"
  behaviour.)

- **FR-4 (empty lanes still shown).** A lane with zero specs still renders with
  its `(0)` count — no lane is hidden. (Preserves current behaviour; keeps the
  pane's shape stable.)

### Boundaries

- **FR-5 (status-fallback only).** This changes only the status-group path. Epic
  grouping (the default, FR-7 of SPEC-007) is untouched, as is the `RollupNode`
  done-count (still keyed on `status === 'done'`).

## Invariants

- **INV-1 (no spec lost).** The union of all lanes' `SpecStatus` sets equals the
  full `SpecStatus` enum, and the sets are pairwise disjoint. A spec of any
  status appears in exactly one lane. *(T0 test — must hold even if a new status
  is added to the enum: the test fails loudly, forcing a lane decision.)*
- **INV-2 (deterministic order).** Lane order is always
  `[Specifying, Implementing, Done, Archived]`.

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
