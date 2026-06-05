---
epic: EPIC-002  # Signpost Integrity
id: SPEC-006
type: requirements
tier: T3
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

## Costly to Refactor (Zone A)

Ranked seams — change these and the cost compounds across the gate:

1. **The `validateSpec()` completeness-rule contract (RD-3, FR-4).** The stub check
   is added *as another rule inside* DR-012's pure `validateSpec()`, reusing its
   done/approval refusal path. If a later change forks a parallel scan command
   instead, two completeness engines drift — the exact 113/113-`[x]`-while-stubbed
   divergence (Context) this spec exists to kill. Keep one engine.
2. **The "done-transition is the gate point" decision (RD-2, FR-4).** Gate fires on
   the spec `status: done` transition, not per-task `[x]`. Re-pointing it at task
   toggles (or at PreToolUse src-edits, which FR-4 explicitly disclaims) would
   change firing frequency by orders of magnitude and re-entangle it with DR-012's
   src-edit block it is defined to stay distinct from.
3. **The marker set + match semantics (FR-1, FR-6).** Markers match on word
   boundaries (`\bSTUB\b`) at *code* positions, not raw substring (FR-6). Switching
   to naive substring matching reintroduces the false-positive class (a prompt that
   says "do not stub") that FR-6 was written to exclude; widening the default set in
   `minspec.stubGate.markers` retro-fails specs already marked done.
4. **Scope = `.minspec/traceability.json`-mapped files only (FR-2).** Untraced files
   MUST NOT be scanned. Broadening to whole-tree (an explicit Out-of-scope item)
   makes every vendored/example stub a blocker and inverts the opt-in scope model.

## Invariants (must hold)

- **INV — Tier 0 (DR-004):** detection is pure file-system; no AI, no network.
- **INV (ceremony ∝ complexity):** T1/T2 untouched; gate only bites at T3/T4.
- **INV #5 (user override wins):** master toggle + inline suppression.

## Acceptance Criteria (Zone A)

Definition-of-done — each box traces the FR/RD it discharges:

- [ ] Scanning a traced file containing `TODO`/`FIXME`/`STUB`/`XXX`/`HACK`,
      `throw new Error('not implemented')` / `notImplemented`, or `test.skip` /
      `it.skip` reports a finding; `Stub`/`STUB`/`stub` all trip (word-boundary,
      case-insensitive) — **FR-1**.
- [ ] A file present on disk but absent from `.minspec/traceability.json` is **not**
      scanned (no findings emitted for it) — **FR-2**.
- [ ] On a T1 or T2 spec the gate is inert (no diagnostics, no done-block); on T3/T4
      it is active — **FR-3**.
- [ ] Findings appear as editor diagnostics continuously, AND a `status: done`
      transition on a spec whose traced files still contain stubs is refused with a
      naming reason; a *file edit* is never blocked — **FR-4, RD-2**.
- [ ] Setting `minspec.stubGate.enabled = false` silences the gate entirely; an
      inline `minspec-stub-ok` comment suppresses the single finding on its line —
      **FR-5**.
- [ ] A marker appearing inside a string/comment that *describes* stubbing (e.g.
      prose "do not stub") produces **no** finding — **FR-6**.
- [ ] The stub check is implemented as a rule inside the existing pure
      `validateSpec()` (DR-012), reusing its refusal path — no second scanning
      engine — **RD-3**.

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

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|------|---------------------|------------|
| R1 | RD-1's regex empty-body heuristic flags legitimate no-ops (`deactivate() {}`), making the gate noisy and trained-to-ignore | Med · High | `minspec-stub-ok` inline exemption (FR-5); AST upgrade deferred follow-up if noise proves real (Open questions) |
| R2 | FR-6 misclassifies a marker inside a string/comment as code, blocking a genuinely-done spec (false positive on prose like "do not stub") | Med · High | Backstopped by the Failure-Modes #1 test (`"do not leave a STUB"` → zero findings) and the Test-Strategy FR-6 row (T1); if the test is absent the risk is unmitigated, so the test — not the requirement restated — is the control |
| R3 | Stub check added as a *parallel* path instead of inside `validateSpec()`, re-creating two drifting completeness engines (the 113/113-while-stubbed defect in Context) | Low · High | RD-3 mandates one engine and Costly-to-Refactor seam #1 names it load-bearing; enforced by the Test-Strategy RD-3 row asserting the stub rule is reached *through* `validateSpec()` with no separate scan path invoked |
| R4 | `.minspec/traceability.json` is stale/empty, so FR-2 scans nothing and the gate silently passes a stubbed spec | Med · Med | Scope is explicitly traced-files-only (FR-2); a stale map is a traceability-integrity concern owned elsewhere, surfaced as a follow-up |
| R5 | Widening `minspec.stubGate.markers` (FR-1) retro-fails specs already at `status: done` | Low · Med | Default set is fixed; user-added markers are opt-in via FR-5's override and apply going forward |

## Assumptions

- `.minspec/traceability.json` exists and maps the active spec to its implementation
  files (FR-2 has no input otherwise).
- DR-012's `validateSpec()` is pure and already owns the done/approval refusal path
  that RD-3 reuses — this spec extends it rather than introducing a new gate point.
- Each spec carries a resolvable `tier:` so FR-3 can decide T3/T4-vs-T1/T2 enforcement.

## Test-thought

Verified by feeding `validateSpec()` a spec whose traced files contain known markers
and asserting (a) findings emit at T3/T4 only, (b) the `status: done` transition is
refused, and (c) untraced files and `minspec-stub-ok` lines produce none.

## Coverage Map

| Mechanism / concern | FR / RD |
|---|---|
| Marker detection (word-boundary, case-insensitive, configurable set) | FR-1 |
| Empty/placeholder-body heuristic | RD-1 |
| Scope limited to traced files | FR-2 |
| Tier gating (T3/T4 only) | FR-3 |
| Diagnostics + done-transition block (not file-edit block) | FR-4, RD-2 |
| Master toggle + inline `minspec-stub-ok` suppression | FR-5 |
| String/comment false-positive guard | FR-6 |
| Single engine inside `validateSpec()` (no parallel path) | RD-3 |

## Consequences

**Positive:**
- Closes the Context defect: a spec can no longer reach `status: done` (RD-2, FR-4)
  while traced files (FR-2) still hold stubs — *code*-completeness now mirrors
  DR-012's *spec*-completeness gate.
- Stays Tier 0 (INV DR-004): pure file-system, no AI/network, so it ships inside
  air-gapped MinSpec without the agent-execute split.
- Reuses DR-012's refusal path (RD-3) — no new scanning engine to maintain.

**Negative:**
- RD-1's heuristic (not AST) will have a false-positive tail; users pay the
  `minspec-stub-ok` annotation cost (FR-5) until/unless the AST follow-up lands.
- Adds a new failure mode to the done-transition: a stale `traceability.json` (R4)
  can make the gate pass vacuously, shifting trust onto a map this spec doesn't own.

## Failure-Modes / Edge-Cases

1. **Marker inside a describing string/comment** (FR-6) — e.g. a prompt literal
   `"do not leave a STUB"`. Expected: no finding. The defining false-positive case.
2. **Intentional no-op body** `deactivate() {}` (RD-1) — empty-body heuristic would
   trip; expected suppressed only when annotated `minspec-stub-ok` (FR-5).
3. **Empty / missing `traceability.json`** (FR-2) — no traced files → zero findings;
   gate passes vacuously (R4). Honest edge: detection is correct, scope is empty.
4. **Stub in an untraced sibling file** (FR-2) — MUST NOT trip; verifies scope is
   the trace map, not the working tree.
5. **T1/T2 spec with stubs** (FR-3) — gate inert; no diagnostics, no done-block.

## Test / Verification Strategy

| FR / RD | Tier | Assertion sketch |
|---|---|---|
| FR-1 | T2 | `validateSpec()` on a traced file with each marker (incl. `Stub`/`STUB`) yields one finding per marker; word-boundary excludes `substub` |
| FR-2 | T0 | Untraced file with `TODO` → zero findings; only `traceability.json` entries are scanned (invariant of scope) |
| FR-3 | T0 | Same stubbed file: T1/T2 spec → inert; T3/T4 → active (ceremony ∝ complexity invariant) |
| FR-4 | T2 | Stubbed traced file blocks `status: done` transition with a naming reason; a file *edit* is not blocked |
| FR-5 | T2 | `enabled=false` → no findings; `minspec-stub-ok` on a line suppresses only that line |
| FR-6 | T1 | Marker inside a comment/string describing stubbing → zero findings (defining edge case) |
| RD-3 | T1 | Stub rule reached via `validateSpec()` (one engine); no separate scan path invoked |

## Alternatives Considered

- **AST-based empty-body detection (v1).** Rejected for v1 (RD-1): adds a TypeScript
  AST dependency + parse cost, violating ceremony ∝ complexity; deferred as a
  follow-up gated on real false-positive noise.
- **Gate on per-task `[x]` toggle.** Rejected (RD-2): fires constantly and is the
  unverified hand-checkbox the Context defect rode in on; the `status: done`
  transition is the authoritative signal.
- **Parallel `minspec.scanStubs`-only command as the gate.** Rejected (RD-3): two
  completeness engines drift; the gate must live inside `validateSpec()`. The
  command exists only for on-demand surfacing, not as the enforcement path.
- **Whole-tree / all-tier scan with a hard PreToolUse block.** Rejected (Out of
  scope): inverts the opt-in trace scope (FR-2) and collides with DR-012's existing
  src-edit block that FR-4 is defined to stay distinct from.

## Follow-ups (tracked)

- AST-precision upgrade for empty-body detection if RD-1's heuristic proves noisy —
  Open questions item; file a `harvest316/minspec` issue when noise is observed.
- Stale/empty `.minspec/traceability.json` integrity check so FR-2 cannot pass
  vacuously (R4) — cross-cutting with traceability ownership; not this spec's gate.
  File as a sibling issue.

## Open questions

- None blocking. (AST-precision upgrade tracked as a future follow-up if RD-1's
  heuristic proves noisy in practice.)
