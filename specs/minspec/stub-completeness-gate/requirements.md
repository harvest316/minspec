---
epic: EPIC-002  # Signpost Integrity
id: SPEC-006
type: requirements
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: specifying
product: minspec
---

# MinSpec — Code-Completeness (Stub) Gate (Requirements)

**Date:** 2026-05-30
**Status:** Specifying (SDD Specify phase)
**Decision:** [DR-012 addendum](../../../docs/decisions/DR-012.md)
**Triggered by:** session request — "avoid considering code complete while it still has stubs"

---

## Context

`tasks.md` showed 113/113 `[x]` while `statusCommand` was a hardcoded stub. Task
completion is a hand checkbox nothing verifies; DR-012 gates *spec* completeness
(sections present) but never inspects implementation code. This spec adds the
*code*-completeness companion.

## Requirements

- **FR-1 (stub detection).** Pure file-system scan for a configurable marker set:
  `TODO`, `FIXME`, `HACK`, `STUB`, `XXX`, `throw new Error('not implemented')` /
  `notImplemented`, `test.skip` / `it.skip`, and empty/placeholder function
  bodies. Markers match case-insensitively on word boundaries (`\bSTUB\b`) so
  `stub`, `Stub`, `STUB` all trip. Default set configurable via
  `minspec.stubGate.markers`. No AI, no network (Tier 0, DR-004).
- **FR-2 (scope = spec-traced files).** Scan only files mapped to the active spec
  via `.minspec/traceability.json`. Untraced files MUST NOT be scanned.
- **FR-3 (tier gate).** Enforcement applies to **T3/T4 only**. T1/T2 unaffected.
- **FR-4 (warn-level enforcement).** Surface findings as editor diagnostics AND
  block transitioning the spec/phase to **done** while traced files contain
  stubs. MUST NOT block file edits (distinct from DR-012's PreToolUse src-edit
  block).
- **FR-5 (override).** A setting (e.g. `minspec.stubGate.enabled`, default true)
  disables the gate; per-finding suppression via an inline `minspec-stub-ok`
  comment (mirrors the `pii-ok` convention).
- **FR-6 (false-positive guard).** Markers inside strings/comments that are
  *describing* stubs (e.g. a prompt saying "do not stub") MUST NOT trip the gate.
  Match on code positions / line semantics, not raw substring.

## Invariants (must hold)

- **INV — Tier 0 (DR-004):** detection is pure file-system; no AI, no network.
- **INV (ceremony ∝ complexity):** T1/T2 untouched; gate only bites at T3/T4.
- **INV #5 (user override wins):** master toggle + inline suppression.

## Out of scope

- Whole-tree scanning; all-tier enforcement; hard PreToolUse block on stubs.
- Semantic implemented-or-not judgement (would require AI).
- Auto-removing or auto-fixing stubs.

## Resolved design decisions (were open questions)

- **RD-1 — empty-body detection = heuristic, not AST.** v1 uses a line/regex
  heuristic for obvious empty/placeholder bodies (`{}`, `{ return; }`,
  `{ /* ... */ }`, `{ return null; }`-only). No TypeScript AST in v1 (avoids the
  dependency + parse cost; INV ceremony ∝ complexity). Intentional no-ops
  (`deactivate() {}`) are exempted via the `minspec-stub-ok` inline comment
  (FR-5). AST-based precision is a deferred follow-up if false positives prove
  noisy.
- **RD-2 — authoritative completion signal = the spec `status: done` transition.**
  The gate hooks the spec moving to `status: done` (frontmatter transition / the
  spec-tree "mark done" action), NOT the per-task `[x]` toggle (too granular,
  fires constantly). On a done-transition with stubs present in traced files,
  the transition is refused with a naming reason; diagnostics surface
  continuously before that point.
- **RD-3 — extend `spec-validator.ts`, don't add a parallel command path.** The
  stub check becomes an additional completeness rule in DR-012's pure
  `validateSpec()` (reported as a violation), reusing its done/approval refusal
  path. A thin `minspec.scanStubs` command + a VS Code DiagnosticCollection
  provide on-demand + continuous surfacing. No duplicate scanning engine.

## Open questions

- None blocking. (AST-precision upgrade tracked as a future follow-up if RD-1's
  heuristic proves noisy in practice.)
