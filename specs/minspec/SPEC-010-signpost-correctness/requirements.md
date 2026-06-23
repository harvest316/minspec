---
id: SPEC-010
type: requirements
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: implementing
tier: T4  # foundational: 17 FRs, DAG model, shared multi-caller contract — full ceremony (manual classification; classifier under-tiers by diff size)
product: minspec
epic: EPIC-002  # Signpost Integrity
relates_to: [SPEC-005, SPEC-006, SPEC-012, SPEC-013]  # repair trigger; predicate strength; global order (DR-019); traceability parse-grammar co-owner
---

# MinSpec — Signpost Correctness (Requirements)

**Date:** 2026-05-31
**Status:** Specifying (SDD Specify phase)
**Decision:** [DR-012](../../../docs/decisions/DR-012.md) (HITL gate consumes this contract)
**Triggered by:** session request — "the signpost must always be correct; cover all the bases"
**Epic:** [EPIC-002 Signpost Integrity](../../../docs/epics/EPIC-002-signpost-integrity.md)

---

## Context

MinSpec's core value proposition is a **signpost**: a status-bar (and explorer)
indicator that always tells the developer and the AI agent the single next SDD
action — "Specify SPEC-NNN", "plan FR-4 is uncovered", "implement task 3",
"validate & commit". It is what makes MinSpec an *opinionated framework* rather
than a folder convention, and it is the marketing hook (guardrails against
vibe-coded AI slop).

A signpost is only valuable if it is **correct**. A green light that doesn't mean
"complete", or a "next: X" that is wrong for the current state, is worse than no
signpost: the developer (and the agent) trusts it, acts on it, and is led astray.
One wrong signpost and trust — the whole product — is gone.

The naive implementation ("which files exist?") is wrong for the common case of
being **partway through a stage**: a spec with FR-1..5 but a plan covering only
FR-1..3 is neither "no plan" nor "planned". Existence checks cannot see the hole.
Correctness therefore requires modelling *coverage*, not *presence* — a
dependency graph (DAG) whose edges carry completeness predicates.

This spec defines the foundational signpost: the DAG state model, the six
correctness mechanisms, the save-time completeness check, and the five
nag-avoidance guardrails. It composes with two existing specs rather than
duplicating them:

- **[SPEC-006](../SPEC-006-stub-completeness-gate/requirements.md)** (Stub & Completeness
  Gate) — strengthens the deterministic completeness predicate so placeholder
  prose / stubs can't pass as "complete".
- **[SPEC-005](../SPEC-005-auto-structure-repair/requirements.md)** (Auto-Structure
  Repair) — the offer-driven recovery path for missing/incoherent structure.
  This spec's *honest-degradation* state (FR-6) is the trigger; SPEC-005's
  offer-never-silent rule (its FR-3) is the contract for any LLM-assisted fix.

## State Model

Nodes = SDD artifacts (`spec`, `plan`, `tasks`, `code`) per feature. Edges =
**coverage** dependencies, each carrying a completeness predicate:

```
spec(FR-1..N) ──covers──▶ plan(items) ──covers──▶ tasks(checkboxes) ──covers──▶ code
```

Signpost = the **first incomplete node in topological order**. A partially-
covered node (plan covers FR-1..3 of FR-1..5) is itself the signpost target,
named to the specific hole (FR-4, FR-5). Multiple specs = multiple chains = a
graph; topo-sort yields the global next step.

## Requirements

### Correctness mechanisms

- **FR-1 (DAG state model — coverage, not presence).** State is modelled as a
  dependency graph of artifact nodes joined by coverage edges, not a file-exists
  checklist. "Partway through a stage" (a node partially covered by its
  predecessor) MUST be a first-class state whose signpost names the specific
  uncovered items.
- **FR-2 (deterministic derivation — *derive, never guess*).** The signpost MUST
  be a pure function of file-system + frontmatter state. Same inputs → same
  signpost; no heuristic guessing, randomness, or hidden state. (Tier 0, DR-004.)
- **FR-3 (L1 coverage predicates via traceability IDs).** Edge completeness is
  checked deterministically using the existing traceability convention: every
  `FR-N` in a spec has a downstream reference in the plan; every plan item has a
  task; task checkbox state is read directly. Greppable, fast, 100% precise.
  Predicate strength is extended by SPEC-006; semantic judgement is out of scope.
- **FR-4 (show the evidence — *why, not just what*).** Every signpost MUST be
  able to show its derivation on demand (hover / click): the exact state that
  produced it ("plan.md exists; FR-4, FR-5 have no plan ref → next: cover FR-4,
  FR-5"). A wrong signpost MUST be diagnosable to the file/ID that caused it, so
  an error becomes a bug report, not an uninstall.
- **FR-5 (advisory, never blocking — *suggest, never block*).** The signpost is
  advisory: a pointer the developer may ignore, skip, or act on out of order. It
  MUST NOT block edits or commits. (Blocking enforcement is the separate, opt-in
  HITL gate, DR-012, which *consumes* this completeness contract.)
- **FR-6 (honest degradation — *degrade honestly*).** When state is *incoherent*
  (tasks with no parent plan, dangling ID references, colliding hand-edited IDs),
  the resolver MUST say so explicitly ("state unclear — open tasks.md") and MUST
  NOT fabricate a confident next step. This is the documented trigger for
  LLM-assisted repair (SPEC-005). Distinct from "incomplete but coherent", which
  is normal and points forward.
- **FR-7 (override memory — *dismissible + sticky*).** The developer MUST be able
  to dismiss/override the signpost ("not this — I'm on X"). An override persists
  and suppresses the same guidance until state changes; the signpost MUST NOT
  re-nag the identical step. A confirmed repair result is cached the same way,
  making it deterministic thereafter. (Reuses the `preferences.json` /
  INV #5 override model.)
- **FR-8 (correctness invariant + T0 tests — *test = invariant*).** Every state →
  signpost mapping (each edge predicate, each degradation case) MUST have a T0
  invariant test. Signpost correctness is an invariant (see Invariants), not a
  feature behaviour. No mapping ships without its test.

### Save-time completeness check + nag-avoidance guardrails

- **FR-9 (save-time check).** On save of a tracked artifact (`specs/**`,
  `plan`/`tasks`), the L1 checker runs (debounced) and refreshes the signpost.
  Holes surface immediately — the gate runs continuously, not only at commit/CI.
- **FR-10 (authorship branch — agent vs human).** Action on detected holes
  depends on author: **agent-authored** (`claude -p` dispatch) → auto-bounce
  (feed holes back; agent fixes and re-checks, in-loop). **Human-authored** →
  non-blocking diagnostics (Problems panel) + signpost + an offered "Fix with AI"
  action; MUST NOT auto-invoke the LLM on a human save.
- **FR-11 (draft vs ready — *guardrail 1*).** A half-written artifact is normally
  incomplete. Holes are treated as errors only when the artifact declares
  `status` at a ready/transition point (e.g. moving to `done`/gate) — mirrors
  SPEC-006 RD-2. Before that, holes are a forward-looking checklist, not red
  squiggles. (No nagging on every keystroke of a draft.)
- **FR-12 (deterministic check, LLM repair only — *guardrail 2*).** *Detection*
  of holes stays deterministic (L1) and runs every save at zero LLM cost. An LLM
  is invoked only to *propose a fix*, never to *decide whether* a hole exists.
  Keeps the every-save path cheap, offline-capable, trustworthy.
- **FR-13 (loop cap — *guardrail 3*).** Agent auto-bounce (FR-10) is bounded
  (config, default 3 iterations); repeated failure escalates per DR-355 (higher
  model, then human). Never an infinite write→check→rewrite loop.
- **FR-14 (dirty-editor safety — *guardrail 4*).** An LLM/auto fix MUST NOT
  clobber a file open with unsaved changes; fixes apply as a confirmable
  `WorkspaceEdit` / suggested edit, or defer until saved. (Upholds advisory
  invariant; mirrors SPEC-005 non-destructive INV.)
- **FR-15 (debounce + index lag — *guardrail 5*).** The save-time check debounces
  (~500ms), fires on save not keystroke, and MUST NOT re-check the same write
  twice. One save → at most one check.
- **FR-16 (shared checker, four callers — the leverage).** The L1 checker is a
  single pure function in `packages/shared`, consumed identically by (a) the
  extension save hook, (b) the pre-commit hook, (c) CI (`npm run validate`), and
  (d) agent dispatch. One checker → one verdict everywhere; editor, commit, CI,
  and agent can never disagree about "complete".

### Bug report — close the loop on a wrong signpost

- **FR-17 (one-click bug report — *capture the wrongness*).** When a signpost is
  wrong, the developer MUST be able to file it in **one action**: a **"Report wrong
  signpost"** command that opens a **pre-filled GitHub issue** (`harvest316/minspec`,
  labels `bug,signpost`) whose body is **FR-4's derivation evidence** (the exact state
  that produced the signpost) plus the MinSpec version and a **sanitised** state
  snapshot. The extension MUST NOT submit silently — it opens the pre-filled URL in the
  browser; the developer **reviews and submits** (upholds INV-Tier-0: no extension-side
  network; visible + opt-in per INV #5). FR-4 already produces the report *content*;
  FR-17 is the *channel*. Rationale: a wrong signpost is the single highest-value signal
  a never-wrong product can capture — this makes it captured **by default** rather than
  lost to a manual copy-paste (or an uninstall). Verified by a **T2 feature test**:
  derivation state → correctly pre-filled issue URL. (Not a state→signpost mapping, so
  not a T0 case under FR-8.)

## Costly to Refactor

*Expensive-to-reverse commitments — read these closely; everything else is cheap to
change. Ranked most→least costly.*

1. **DAG coverage model — edges-not-presence (FR-1).** The entire correctness story keys
   off "first incomplete node in topo order." Retreating to file-exists checks = re-deriving
   every signpost and re-writing every T0 mapping test. *Check: Acceptance Criterion 1
   ("coverage, not presence" — spec FR-1..5 + plan covering FR-1..3 names holes FR-4/FR-5)
   passes against fixtures, and the DAG model is the one recorded in DR-019, before implement.*
2. **Shared L1 checker — one pure fn, four callers (FR-16).** A near-public contract
   consumed by extension, pre-commit, CI, and agent dispatch. A second implementation =
   permanent drift; the four surfaces disagree about "complete." *Check: one function in
   `packages/shared`, imported everywhere, no fork.*
3. **L1 predicate grammar — traceability IDs (FR-3).** The `FR-N` → plan-ref → task grammar
   the predicate greps; co-owned with SPEC-013's parse contract. Changing it = re-parse +
   migrate every spec. *Check: grammar fixed before specs depend on it.*
4. **Advisory boundary (FR-5, INV-Advisory).** Shipping advisory then later making the
   signpost block = a behaviour reversal users feel. Blocking lives only in the separate
   opt-in DR-012 gate. *Check: advisory-only confirmed; blocking stays in DR-012.*
5. **Derive-on-demand, no cache (OQ2 resolved).** Pure-fs derivation is the contract; any
   future DAG cache must stay an internal optimisation behind the same pure fn, never a
   second source of truth. *Check: cache (if ever) cannot become a new way to be wrong.*

## Invariants (must hold)

- **INV — Signpost correctness (T0).** The signpost MUST NOT present a next step
  that is wrong for the current state, MUST NOT show "complete/green" unless the
  DAG is fully covered, and MUST say "unclear" rather than guess when state is
  incoherent. Because the signpost is a derived view of file-system truth (FR-2),
  correctness reduces to "reads state correctly" — testable (FR-8), not predicted.
- **INV — Advisory (T0).** The signpost and the save-time checker MUST NOT write
  to the developer's artifacts or block the developer's own edits/commits without
  explicit confirmation. All LLM repair is confirm-before-write (SPEC-005 FR-3)
  and dirty-editor-safe (FR-14).
- **INV — Tier 0 (DR-004).** L1 detection is pure file-system; no AI, no network.
- **INV #5 (user override wins).** Master toggle + per-signpost dismissal (FR-7).

## Acceptance Criteria

The signpost is **done** when all hold (each traces to its FR/INV; each is a T0/T1/T2 test per FR-8):

- [ ] **Coverage, not presence** — given a spec with FR-1..5 and a plan covering only FR-1..3, the signpost names the specific holes (FR-4, FR-5), not "planned" or "no plan". (FR-1, FR-3)
- [ ] **Deterministic, one verdict everywhere** — identical filesystem + frontmatter state yields an identical signpost across repeated runs *and* across all four callers (extension save hook, pre-commit, CI, agent dispatch), proven by a T1 contract test. (FR-2, FR-16)
- [ ] **Show why** — every signpost renders its derivation on demand (hover/click): the exact state + IDs that produced it ("plan.md exists; FR-4, FR-5 have no plan ref → next: cover FR-4, FR-5"). (FR-4)
- [ ] **One-click bug report** — a wrong signpost files a pre-filled `harvest316/minspec` issue from that derivation in a single action, and the extension never submits silently. (FR-17)
- [ ] **Advisory** — the signpost and the save-time checker never block edits or commits, and never write to the developer's artifacts without explicit confirmation. (FR-5, FR-14, INV-Advisory)
- [ ] **Honest degradation** — incoherent state (dangling/colliding IDs) surfaces "state unclear — open <file>" and never fabricates a confident next step. (FR-6)
- [ ] **Dismissible + sticky** — a dismissed signpost stays suppressed for the identical step until state changes; it never re-nags the same step. (FR-7)
- [ ] **Every mapping tested (T0)** — each state→signpost edge predicate and each degradation case has a passing T0 invariant test; no mapping ships without one. (FR-8, INV-correctness)
- [ ] **Tier-0** — the L1 detection path contains no AI and no network in `packages/minspec` / `packages/shared`. (INV-Tier-0, DR-004)
- [ ] **Ready-gated, debounced** — holes are a forward checklist (not errors) until `status: done`; the check is debounced, fires on save not keystroke, and runs at most once per save. (FR-11, FR-15)

## Coverage Map (all bases)

Explicit trace from the discussed mechanisms to FRs — nothing dropped.

| Correctness mechanism | FR |
|---|---|
| 1. Derive, never guess (pure fn) | FR-2 |
| 2. Show *why*, not just *what* | FR-4 |
| 3. Suggest, never block (advisory) | FR-5, INV-advisory |
| 4. Degrade honestly | FR-6 |
| 5. Dismissible + sticky (override memory) | FR-7 |
| 6. T0 test = invariant | FR-8, INV-correctness |
| LLM escalation (recovery) | FR-6 trigger → SPEC-005 |
| Partway-through-a-stage (DAG) | FR-1, FR-3 |
| Capture the wrongness (one-click bug report) | FR-17 (channel) ← FR-4 (content) |

| Nag-avoidance guardrail | FR |
|---|---|
| 1. Draft vs ready | FR-11 |
| 2. L1 checks, LLM only fixes | FR-12 |
| 3. Loop cap → escalate | FR-13 |
| 4. Dirty-editor safety | FR-14 |
| 5. Debounce + index lag | FR-15 |
| Authorship branch (agent vs human) | FR-10 |
| Save-time gate | FR-9 |
| Shared checker (one fn, four callers) | FR-16 |
| Bug-report channel | FR-17 |

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|---|---|---|
| R1 | **A wrong signpost ships — trust gone (the core threat).** A state→signpost mapping is incorrect; dev/agent is led astray. | Low · High | FR-8 T0 test per mapping; FR-2 pure derivation (testable, not predicted); FR-6 says "unclear" rather than guess; FR-17 captures any miss as a filed report. |
| R2 | **Checker drift across the four callers (FR-16).** Editor, pre-commit, CI, agent disagree on "complete". | Med · High | One pure fn in `packages/shared`; INV — single checker; T1 contract test asserts identical verdict across all four callers. |
| R3 | **Partial-coverage hole missed.** A presence check passes a plan covering FR-1..3 of FR-1..5. | Med · High | FR-1 DAG models coverage not presence; FR-3 greps every `FR-N` for a downstream ref; FR-8 T0 case for partway-through. |
| R4 | **Nag fatigue.** Every-keystroke squiggles on a half-written draft → users disable the signpost. | High · Med | FR-11 holes are errors only at the ready/transition (`status: done`); FR-15 debounce, save-not-keystroke; FR-7 dismissible + sticky, never re-nag. |
| R5 | **Incoherent state → confident-but-wrong next step.** Dangling/colliding IDs produce a fabricated "next". | Med · High | FR-6 honest degradation ("state unclear — open tasks.md") routes to SPEC-005 repair offer, never a guess. |
| R6 | **Auto-fix clobbers unsaved work / loops forever (the FR-10 agent-bounce path).** A `WorkspaceEdit` overwrites a dirty buffer, or the write→check→rewrite cycle never converges. | Low · High | FR-14 dirty-editor safety (confirmable `WorkspaceEdit`); FR-13 loop cap (default 3) → DR-355 escalation. |
| R7 | **FR-17 leaks private spec content to GitHub.** Pre-filled issue body carries paths / spec text. | Med · Med | Sanitised snapshot; extension never auto-submits — opens pre-filled URL, dev reviews + submits (INV-Tier-0; INV #5 visible + opt-in). |
| R8 | **Floor depends on unbuilt specs.** Predicate strength (SPEC-006) is `specifying`. | Med · Med | FR-3 ships with the L1 grammar today; SPEC-006 strengthens the predicate behind the same interface; SPEC-012/DR-019 already resolved global order (OQ1). Sequence SPEC-006 before the L4 layer is trusted. |

## Consequences

**Positive:**
- A signpost **correct by construction** — derived (FR-2) and tested per-mapping (FR-8). The product's whole trust claim becomes *earnable*, not asserted.
- One checker, four callers (FR-16) → editor / commit / CI / agent can never disagree about "complete".
- The rare wrong signpost is **captured** (FR-17), not lost — it feeds back instead of churning a user.

**Negative:**
- A DAG + coverage grammar is more machinery than a file-exists check — more to build, test, and keep coherent with SPEC-006/SPEC-013's parse contract.
- Derive-on-demand (no cache) trades per-query cost for correctness; very large repos may later need the optimisation (additive — OQ2).
- The traceability `FR-N`-ref grammar becomes load-bearing: specs that don't follow it degrade to "unclear" (honest, but a real authoring constraint).

## Alternatives Considered

- **File-exists checklist (the naive impl).** Rejected (Context): can't see a partial-coverage hole — a plan covering FR-1..3 of FR-1..5 is neither "no plan" nor "planned". Correctness requires coverage, not presence (FR-1).
- **LLM-judged "is the next step right?"** Rejected: breaks Tier-0 (DR-004) + derive-never-guess (FR-2); non-deterministic, un-T0-testable, costs tokens every save. The LLM is confined to *repair* (SPEC-005), never *detection*.
- **Blocking the signpost (hard gate at every hole).** Rejected here: the signpost is advisory (FR-5 / INV-Advisory). Blocking is the separate opt-in DR-012 gate that *consumes* this contract; keeping them apart preserves "suggest, never block".
- **Persisted DAG cache as source of truth.** Rejected (OQ2): adds a cache-coherence failure surface — a new way to be wrong — against a product whose one job is never being wrong. Derive on-demand; cache only ever as an internal optimisation behind the pure fn.
- **FR-17 auto-submit telemetry.** Rejected: silent network breaks INV-Tier-0 / air-gap. Pre-filled URL + manual submit keeps capture visible + opt-in.

## Dependencies

- **`relates_to: SPEC-006`** (Stub & Completeness Gate) — strengthens the L1 completeness
  predicate (FR-3, and the hollow-test layer) so stubs / placeholder prose can't pass as
  complete. This spec defines the predicate *interface* and consumes it; SPEC-006 is
  `specifying` — sequence it before that layer is trusted.
- **`relates_to: SPEC-005`** (Auto-Structure Repair) — the honest-degradation state (FR-6)
  is the trigger; SPEC-005's offer-never-silent (its FR-3) is the contract for any LLM
  repair. Confirm-before-write + dirty-editor-safe (FR-14).
- **`relates_to: SPEC-012`** (Next-Task Resolver) / **DR-019** — resolved OQ1: the
  deterministic global order `(severity-class, epic.order, artifact-id)` when multiple
  specs are simultaneously incomplete.
- **`relates_to: SPEC-013`** (Self-Audit floor) — co-owns the traceability parse grammar
  the L1 predicate greps; its FR-11 *consumes* this spec's DAG coverage edge (amended
  under [#121](https://github.com/harvest316/minspec/issues/121)).
- **DR-012** — the HITL approval gate *consumes* this completeness contract (blocking lives
  there, not here). **DR-004** — Tier-0 pure-fs. **DR-355** — escalation for the FR-13 loop cap.

### Blast-Radius (what breaks if changed)

The shared L1 checker (FR-16) is the highest-blast-radius surface in this spec: a single
pure function in `packages/shared` imported by four callers, so a change ripples outward.

- **Change the L1 checker's verdict shape / predicate semantics (FR-3, FR-16)** → breaks all
  four consumers at once: the extension save hook (FR-9), the pre-commit hook
  (`.githooks`), CI (`npm run validate`), and agent dispatch (`scripts/dispatch-issue.sh`,
  FR-10). The four-caller leverage cuts both ways — one edit, four surfaces. Mitigated by the
  T1 contract test (Acceptance Criterion 2) asserting identical verdict across all callers.
- **Change the traceability `FR-N`→plan-ref→task grammar (FR-3)** → breaks SPEC-013's
  co-owned parse contract (Dependencies) and forces a re-parse/migrate of every spec under
  `specs/**`; also breaks SPEC-013 FR-11 which *consumes* this DAG coverage edge (#121).
- **Retreat the DAG coverage model to file-exists (FR-1)** → every signpost re-derives and
  every T0 mapping test (FR-8) is rewritten (Costly #1).
- **Make the signpost block (reverse FR-5 / INV-Advisory)** → breaks the advisory contract
  DR-012's opt-in gate relies on; users feel a behaviour reversal (Costly #4).
- **Change `preferences.json` override schema (FR-7)** → breaks dismissal stickiness and the
  cached-repair determinism that reuses the INV #5 override model.

Low-blast-radius (isolated to this spec): FR-17 bug-report channel, the debounce timing
(FR-15), and the loop-cap default (FR-13) — all tunable without touching consumers.

## Assumptions

- The traceability `FR-N`→plan-ref→task grammar (FR-3) is actually followed by spec authors;
  specs that don't follow it deliberately degrade to "unclear" (FR-6) rather than to a wrong
  signpost (accepted authoring constraint, see Consequences negative #3).
- `status: done` (reused from SPEC-006 RD-2 per resolved OQ) is the single ready/transition
  trigger for FR-11 — no separate signpost-ready signal exists or is needed.
- Topological global order is already resolved by SPEC-012 / DR-019 `(severity-class,
  epic.order, artifact-id)`; this spec consumes that order and does not re-derive it (OQ1).
- The DAG is derived on-demand from `.minspec/traceability.json` + frontmatter with no
  persisted cache (resolved OQ2) — repo sizes are assumed small enough that per-query
  derivation cost is acceptable until proven otherwise.
- Agent-authored saves are reliably distinguishable from human saves (FR-10) via the
  `claude -p` dispatch path, so the auto-bounce vs offered-fix branch is decidable.

## Test-thought

Verified by the FR-8 T0 mapping suite: each state→signpost edge predicate and each
degradation case (FR-6) has a passing T0 invariant test, plus a T1 contract test proving the
shared checker (FR-16) returns an identical verdict across all four callers, and a T2 feature
test for the FR-17 pre-filled-issue channel. Because the signpost is a pure function of
filesystem state (FR-2), correctness is *tested against fixtures*, not predicted.

## Failure-Modes / Edge-Cases

- **Partial coverage straddling a stage (FR-1, FR-3).** Plan covers FR-1..3 of FR-1..5 →
  signpost MUST name the specific holes (FR-4, FR-5), not collapse to "planned" or "no plan".
- **Incoherent state — dangling/colliding IDs (FR-6).** A `task` with no parent plan item, a
  dangling `FR-N` reference, or two hand-edited specs colliding on the same `FR-N` → resolver
  emits "state unclear — open <file>" and routes to SPEC-005, never a fabricated "next".
- **Dirty editor during auto-fix (FR-14).** Target file open with unsaved changes → fix MUST
  apply as a confirmable `WorkspaceEdit` or defer until saved; MUST NOT clobber.
- **Agent auto-bounce non-convergence (FR-13).** Holes persist after the loop cap (default 3)
  → escalate per DR-355 (higher model, then human); never an infinite write→check→rewrite.
- **Save storm / double-fire (FR-15).** Rapid saves or the ~500ms index-lag debounce window
  → at most one check per write; the same write is never re-checked twice.
- **Draft-stage noise (FR-11).** Holes in an artifact still below `status: done` → surfaced
  as a forward checklist, NOT red-squiggle errors (no every-keystroke nagging).
- **Private content in a bug report (FR-17).** Pre-filled issue body would carry spec paths /
  prose → sanitised snapshot; extension opens the URL, dev reviews + submits (never silent).

## Test / Verification Strategy

Per-FR test tier (T0 = invariant, T1 = contract, T2 = feature) with a one-line assertion
sketch. T0 is mandated by FR-8 for every state→signpost mapping.

| FR | Tier | Assertion sketch |
|---|---|---|
| FR-1 | T0 | Spec FR-1..5 + plan covering FR-1..3 → signpost == "cover FR-4, FR-5" (not "planned"). |
| FR-2 | T1 | Same fixture run twice → byte-identical signpost; no randomness/hidden state. |
| FR-3 | T0 | Each `FR-N` without a downstream plan ref is flagged; every covered FR passes. |
| FR-4 | T2 | Hover/derivation request returns the exact state string + IDs that produced the signpost. |
| FR-5 | T0 | Edits/commits proceed with the signpost present; no block raised. |
| FR-6 | T0 | Dangling/colliding ID fixture → "state unclear — open <file>", never a confident next. |
| FR-7 | T0 | Dismiss step X → X stays suppressed until state changes; re-nag never fires for identical X. |
| FR-8 | T0 | Meta: assert each edge predicate + degradation case owns a passing T0 test (no orphan mapping). |
| FR-9 | T2 | Save of `specs/**` (debounced) → signpost refreshes; holes surface without commit/CI. |
| FR-10 | T2 | Agent-authored save → auto-bounce; human-authored save → diagnostics + offered fix, no auto-LLM. |
| FR-11 | T0 | Holes below `status: done` → checklist (no errors); at `done` transition → errors. |
| FR-12 | T0 | Detection path invokes no LLM; LLM entered only on an explicit fix request. |
| FR-13 | T2 | Auto-bounce hits cap (3) on persistent hole → escalates per DR-355, loop terminates. |
| FR-14 | T0 | Fix against a dirty file → applied as confirmable `WorkspaceEdit`/deferred; original untouched. |
| FR-15 | T0 | N rapid saves of one write → exactly one check; same write never re-checked. |
| FR-16 | T1 | Same state → identical verdict from extension hook, pre-commit, CI, agent (one fn, no fork). |
| FR-17 | T2 | Derivation state → correctly pre-filled `harvest316/minspec` issue URL; no silent submit. |

## Rollback / Reversibility

- **Undo mechanism.** The signpost is a pure derived view (FR-2) with no persisted DAG cache
  (resolved OQ2) — disabling it writes nothing back, so removal is a clean revert plus the
  INV #5 master toggle (FR-7) lets a user switch it off without a code change. Per-caller
  wiring (extension hook FR-9, pre-commit, CI, agent FR-10) can each be unhooked independently
  because they share one `packages/shared` function (FR-16).
- **ADR-filter answer.** Reversible in <1 day for the *advisory surface and its callers*, but
  **NOT** for the load-bearing commitments — the DAG coverage model (FR-1, Costly #1), the
  shared checker contract (FR-16, Costly #2), and the traceability grammar (FR-3, Costly #3)
  are co-owned with SPEC-013 and depended on by SPEC-006/SPEC-012; these crossed the ADR
  threshold and are recorded in DR-012 (gate consumer) and DR-019 (global order). So: the
  feature wiring is cheap to pull; the model and contract are not, and already carry DRs.

## Out of scope

- **Stub / placeholder predicate body** — owned by SPEC-006 (this spec defines
  the predicate interface and consumes it).
- **Semantic adequacy** ("is this a *good* plan") — would require AI judgement;
  the LLM only repairs structure (SPEC-005), it does not score quality.
- **Incoherent-structure offer/repair mechanics** — owned by SPEC-005; this spec
  defines only the honest-degradation trigger and the confirm-before-write
  contract.
- Visual/UX design of the status-bar and explorer surfaces (separate UX spec).
- Blocking enforcement (the HITL gate is DR-012; the signpost itself is advisory).

## Open questions

- ~~Topological ordering when multiple specs are simultaneously incomplete — most
  recently edited, lowest SPEC-NNN, or explicit priority/WSJF? (Affects which
  single "next step" surfaces globally.)~~ **Resolved by
  [SPEC-012 Next-Task Resolver](../SPEC-012-next-task-resolver/requirements.md) / DR-019:**
  deterministic total order `(severity-class, epic.order, artifact-id)`; subjective
  weight in explicit frontmatter, never inferred.
- ~~Where the coverage DAG lives: derived on demand from `.minspec/traceability.json`
  + frontmatter, or cached.~~ **Resolved (this review): derive on-demand**, no persisted
  cache — honours DR-004 pure-fs / FR-2 derive-never-guess and avoids a cache-coherence
  failure surface. If perf demands it later, a cache is an additive optimisation behind
  the same pure fn (Costly #5).
- ~~Exact "ready/transition" trigger set for FR-11 (reuse SPEC-006 RD-2 `status: done`
  transition vs a distinct signpost-ready signal).~~ **Resolved (this review): reuse
  SPEC-006 RD-2 `status: done` transition** — no new signal. Holes are a forward-looking
  checklist before `done`; they become errors at the `done`/gate transition. One trigger,
  fewer dependencies (FR-11).

**None open.**

## Follow-ups (tracked)

- **FR-17 "Report wrong signpost" command** — contributed command + pre-filled
  `harvest316/minspec` issue body (labels `bug,signpost`); lands at implement with the
  signpost surface — no separate issue (same spec/epic). The issue *template* is a
  one-time repo setup → file a `harvest316/minspec` issue per DR-023 if the team wants it
  tracked separately.
- **SPEC-006 predicate strength** must land before the FR-9 L4 (hollow-test) layer is
  trusted — sequencing note for SPEC-006's plan; not a new issue (same epic).
- **[#121](https://github.com/harvest316/minspec/issues/121)** (approved-spec amend:
  SPEC-013 FR-11 consumes this DAG coverage edge) — already tracked; this spec's edge
  ships independently of #121.
- **Site / marketplace copy** — "the signpost is never wrong, and the one time it is, you
  report it in one click" is a positioning beat (FR-17); non-code → `harvest316/minspec`
  issue per DR-023 forward rule if the team wants it surfaced.
