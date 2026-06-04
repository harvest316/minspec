---
id: SPEC-010
type: requirements
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: specifying
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

- **[SPEC-006](../stub-completeness-gate/requirements.md)** (Stub & Completeness
  Gate) — strengthens the deterministic completeness predicate so placeholder
  prose / stubs can't pass as "complete".
- **[SPEC-005](../auto-structure-repair/requirements.md)** (Auto-Structure
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
   every signpost and re-writing every T0 mapping test. *Check: coverage-not-presence
   accepted before implement.*
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
| R6 | **Auto-fix clobbers unsaved work / loops forever.** | Low · High | FR-14 dirty-editor safety (confirmable `WorkspaceEdit`); FR-13 loop cap (default 3) → DR-355 escalation. |
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
  [SPEC-012 Next-Task Resolver](../next-task-resolver/requirements.md) / DR-019:**
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
