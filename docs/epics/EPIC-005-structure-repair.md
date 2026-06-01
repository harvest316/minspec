---
id: EPIC-005
slug: structure-repair
title: Auto Structure Repair
status: proposed
order: 5
---

# EPIC-005: Auto Structure Repair

## Goal

Make MinSpec's on-disk SDD structure self-healing: detect when required
scaffolding is missing or has gone stale, and **offer** to repair it at any point
in a session — not only at activation — without ever silently writing over user
content.

"Done" = detection that fires on *integrity* (any required artifact missing), not
merely on `.minspec/` presence; a debounced watcher that re-surfaces the repair
offer when an artifact disappears mid-session; idempotent, **missing-only** repair
that never overwrites or merges user files; and marker-bounded silent re-sync of
MinSpec's *own* managed sections — all Tier 0 (no AI, no network) and honoring the
existing consent surface.

## Principle

**Offered, never silent — additive, never destructive.** Repair is surfaced
through the existing `[Fix] / [Not now] / [Don't ask again]` toast and writes only
on a user action; it adds absent files and never overwrites, merges, or deletes
user content. The one permitted exception is **marker-bounded re-sync** (DR-011):
re-writing content *between* MinSpec's `minspec:*` markers is provably incapable
of touching user content (invariant #6), so it may proceed without a prompt. Any
change that would alter content *outside* a marker still asks first.

## Artifacts

- **Decisions:** [DR-006](../decisions/DR-006.md) — detect-and-offer
  auto-bootstrap (the base system this epic deepens); its addendum scopes the
  repair work. [DR-011](../decisions/DR-011.md) — marker-bounded auto-update
  without a permission prompt (underpins FR-6; shared with
  [EPIC-006](EPIC-006-trust-and-supply-chain.md)).
- **Spec:** [SPEC-005 requirements](../../specs/minspec/auto-structure-repair/requirements.md)
  — integrity detection (FR-1), reactive watcher (FR-2), offer-never-silent
  (FR-3), idempotent repair (FR-4), consent reuse (FR-5), marker-bounded silent
  refresh (FR-6). Status: **Specifying**; plan/tasks pending. Open questions:
  exact "required harness files" set; watcher debounce + dedupe vs the
  activation-time run.
- **Code:** `packages/minspec/src/lib/auto-bootstrap.ts` (`isMinspecInitialized`,
  `scaffold`, `generateHarnessFiles`).
- **Issues:** label `epic:structure-repair`.
  [#39](https://github.com/harvest316/minspec/issues/39) — corrupt-artifact
  repair (out of scope; additive/missing-only here).
  [#40](https://github.com/harvest316/minspec/issues/40) — lint for dangling
  "parked as a separate issue" references with no link.
