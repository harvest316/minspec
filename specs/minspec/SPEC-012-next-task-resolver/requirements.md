---
id: SPEC-012
type: requirements
status: specifying
tier: T4
product: minspec
epic: EPIC-002  # Signpost Integrity
---

# MinSpec — Next-Task Resolver (Requirements)

**Date:** 2026-06-01
**Status:** Specifying (SDD Specify phase)
**Decision:** [DR-019](../../../docs/decisions/DR-019.md) (this spec is the contract that decision governs)
**Triggered by:** session request — "a prioritised list of docs/specs/epics/DRs I need to approve … but actually I don't need a list, just the next task; priority via DAG not LLM."
**Epic:** [EPIC-002 Signpost Integrity](../../../docs/epics/EPIC-002-signpost-integrity.md)
**Resolves:** [SPEC-010](../SPEC-010-signpost-correctness/requirements.md) Open Question #1 (global topological ordering across simultaneously-pending items).

---

## Context

[SPEC-010](../SPEC-010-signpost-correctness/requirements.md) makes the **within-feature**
signpost correct: for one feature's `spec→plan→tasks→code` chain it derives the
single next SDD *phase action* ("plan FR-4", "implement task 3"). It explicitly
left open (OQ#1) what happens when **multiple** features / decisions are pending
at once: which single step surfaces *globally*.

Separately, MinSpec has a second class of pending state SPEC-010 does not model:
**cross-artifact approval / status gates** the *human* must clear —

- a **spec** awaiting approval before implement (DR-012 content-hash gate),
- an **epic** still `proposed` that must be promoted to `active` before its
  children are real,
- an **ADR** still `proposed` awaiting accept/reject.

The product promise (EPIC-002) is that MinSpec is **always opinionated about what
must happen next**. The realised form of that promise is **one next task for the
human dev** — not a list. A list is a backlog; a backlog is what MinSpec exists to
collapse into a single pointer. The list is at most an *optional expansion* to
sense the pipeline.

This spec defines the **Next-Task Resolver**: a deterministic engine that unifies
every pending human decision (SPEC-010 phase actions + the three approval/status
gates) into one total order and emits **the single next human task**, with an
optional ranked pipeline behind it.

### Two queues, never merged

The next task is **what the human dev must do** — approve, promote, accept,
author a phase. It is **not** the agent/LLM work queue (the dispatch system,
`scripts/`, agent-execute). Those are a separate substrate with their own
ordering. Conflating them would put "LLM is writing task 3" into the human's
signpost, which is noise. The resolver models the **human** queue only.

## State Model

Each **pending human decision** is a node:

| Node kind | Pending when | Cleared by |
|---|---|---|
| `epic-promote` | epic `status: proposed` | promote → `active` |
| `spec-approve` | spec unapproved/stale AND not `done`/`archived` (DR-012) | Approve Spec |
| `adr-accept` | ADR `status: proposed` | accept/reject |
| `phase-action` | SPEC-010 within-feature hole (uncovered FR / unchecked task) | author the phase |

Edges are of two kinds. **(a) Implicit SDD-tree edges** — derived from structure,
always present:

```
epic(active) ──gates──▶ spec-approve, adr-accept, phase-action of its members
spec(approved) ──gates──▶ implement phase-action of that spec   (DR-012)
phase predecessor ──gates──▶ phase successor                    (SPEC-010 chain)
```

**(b) Explicit cross-cutting edges** — arbitrary dependencies between *any* two
artifacts, *outside* the tree, that the SDD hierarchy cannot express: "this spec
is blocked by that ADR being accepted", "this DR depends on those DRs", "this spec
supersedes that one". Today these live only in prose (`Triggered by:`, `Resolves:`,
`composes`) and are invisible to the engine. They MUST become machine-readable
frontmatter edges (FR-13) so the resolver can rank a blocked node below its
blocker. The union of (a) + (b) is the dependency DAG; **it MUST be acyclic — a
cycle is corruption** (FR-15), and acyclicity is itself a free correctness check.

A node whose gate is **unsatisfied while downstream work has already started** is
a **gate violation** (e.g. spec `implementing` but unapproved; spec `implementing`
under a `proposed` epic; a spec advancing while an ADR it `depends_on` is still
`proposed`). Violations are detectable purely structurally and rank highest — they
are live invariant breaches, not future work.

## Requirements

### Determinism & layering

- **FR-1 (deterministic ranking, no LLM — *derive, never guess*).** The priority
  *ranking* MUST be a pure function of filesystem + frontmatter + approval +
  dependency-edge state. Same inputs → same ranking. No LLM, no network, no hidden
  state. The single permitted non-determinism is an arbitrary choice **among a true
  priority tie** (FR-14) — never in the ranking itself. An LLM-derived next-task is
  non-reproducible and untestable; it is forbidden here. (Tier 0, DR-004; DR-019.)
- **FR-2 (severity classes — partial order).** Every pending node is assigned
  exactly one severity class, ranked:
  1. **gate-violation** — downstream work proceeding past an unsatisfied gate
     (incl. an unsatisfied explicit `depends_on`, FR-13).
  2. **blocked-ready** — at a gate whose clearance unblocks the next phase, under
     an `active` epic, with all `depends_on` already cleared.
  3. **promote-parent** — a `proposed` epic with members waiting on it.
  4. **pending** — remaining `proposed` ADRs / unapproved specs.
  Order **within** a class by `(epic.order, priority, artifact-id)` (FR-3 dials;
  `artifact-id` is the final deterministic tie-break). This yields a partial order
  whose top band may contain ties (FR-14); the **next task** is any member of that
  top band.
- **FR-3 (subjective weight is explicit data, never inferred).** Any priority
  input that is a human judgement — relative importance of independent branches —
  MUST be read from explicit frontmatter, NOT inferred by the engine and NOT
  inferred by an LLM. Two dials: `epic.order` (coarse, cross-epic) and a per-spec
  `priority:` field (fine, within a tie — applied at the `(epic.order, …)`
  tie-break, ahead of `artifact-id`). Prose in CLAUDE.md ("ScroogeLLM is future")
  is invisible to the resolver until lifted into structured data. The engine
  computes structure; the human sets weight.
- **FR-3a (deferral is a link to a blocker, never a bare boolean).** "Not now"
  MUST be expressed as a dependency on the thing that unblocks it — reusing
  `depends_on` (FR-13) — not a standalone `deferred: true` flag. A boolean rots:
  it is set once and never unset, so the item stays hidden after its real blocker
  clears. A link instead (a) **auto-clears** when the blocker clears, (b) is
  **explainable** ("hidden because blocked on EPIC-003"), and (c) reuses one
  mechanism. Consequently a deferred node is simply a node with an un-cleared
  `depends_on`, which FR-13 already ranks below its blocker — no separate
  "deferred floor" rule is needed. Purely-temporal deferral with no artifact
  blocker ("after public launch") MUST still link a *named* target, never a flag:
  a **milestone artifact** (`MILESTONE-NNN`, FR-3b) the item `depends_on`.
- **FR-3b (milestones are first-class blockers).** A `MILESTONE-NNN` is a
  lightweight registered artifact (id, title, `status: open|reached`) that exists
  solely to be a `depends_on` target for time/event-based deferral with no spec/DR
  blocker. It clears (unblocks dependents) when a human marks it `reached`. Keeps
  deferral one mechanism end-to-end — temporal "later" becomes "blocked on
  MILESTONE-003 (public launch)", auto-clearing on reach, no rotting boolean.
- **FR-4 (composes with SPEC-010, does not duplicate).** SPEC-010's per-feature
  resolver is consumed as the `phase-action` node source. This spec adds the
  cross-artifact gate nodes and the **global** ordering across all node kinds. It
  MUST NOT re-implement SPEC-010's coverage predicates.

### Output surface

- **FR-5 (single next task is primary).** The primary output is **one** next
  human task: kind, target artifact id, one-line imperative ("Approve SPEC-001",
  "Promote EPIC-004", "Accept DR-003", "Plan FR-4 of SPEC-006"), and the action
  that clears it. Not a list.
- **FR-6 (pipeline is optional expansion).** The full ranked queue MUST be
  available on demand (expand) for pipeline awareness, but MUST be secondary to
  FR-5 — collapsed by default. Sensing what's coming ≠ working a list.
- **FR-7 (show the evidence — *why, not just what*).** The next task MUST be able
  to show its derivation: the severity class and the gate that produced it
  ("gate-violation: SPEC-001 is `implementing` but unapproved → approve before
  implement, DR-012"). A wrong next-task MUST be diagnosable to the artifact +
  rule that caused it.
- **FR-8 (human queue only — never the agent queue).** The resolver MUST model
  only human decisions. Agent/LLM dispatch work MUST NOT appear as a next task.
  The two queues are separate surfaces (INV — Two Queues).
- **FR-8a (signpost anchored to plan, not to dev activity).** The canonical next
  task is derived solely from artifact + frontmatter + edge state (FR-1). A
  developer **deviating** from it — working out of order, hacking on something
  off-plan — is allowed and is NOT an input to the resolver: it MUST NOT re-rank or
  change the canonical next task. The signpost reflects *what the plan says is
  next*, not *what the dev is doing now*. Deviation only ever moves the signpost by
  changing artifact state (e.g. completing a phase, clearing a gate). Distinct from
  INV #5 override, which is an *explicit* dismissal the dev records; silent
  deviation records nothing and the signpost holds its ground.

### Coherence precondition

- **FR-9 (status-coherence validation, deterministic).** Before emitting a next
  task the resolver MUST check structural coherence: a child MUST NOT be further
  along than its parent (e.g. spec `implementing` under a `proposed` epic; ADR
  `accepted` under a `proposed` epic). A coherence breach is surfaced as the
  highest-priority *gate-violation* next task ("resolve: SPEC-004 implementing
  under proposed EPIC-004"), not silently ranked among normal work.
- **FR-10 (honest degradation — reuse SPEC-010 FR-6).** If state is incoherent
  beyond the FR-9 rules (dangling epic refs, malformed frontmatter), the resolver
  MUST say "state unclear — <file>" rather than fabricate a confident next task,
  and route to the repair ladder (FR-15).

### Cross-cutting dependencies, ties & corruption repair

- **FR-13 (explicit cross-cutting edges — three kinds).** Artifacts MUST be able
  to declare machine-readable relationships to *any* other artifact, independent of
  the SDD tree, via frontmatter. v1 vocabulary:
  - **`depends_on: [ID, …]`** — *blocking*. This node is blocked until each target's
    own gate is cleared; it MUST rank below an un-cleared target, and advancing past
    an un-cleared one is a **gate-violation** (FR-2.1).
  - **`supersedes: [ID, …]`** — *replacement*. The superseded target drops out of
    the queue (no longer a pending task); the superseding node carries forward.
  - **`relates_to: [ID, …]`** — *non-blocking clustering*. Does NOT gate, but the
    resolver SHOULD keep related items **adjacent in ordering** — within a severity
    class, cluster `relates_to` neighbours so kindred work/tests surface together
    rather than scattered. A clustering tie-influence only; never changes severity.

  These edges join the implicit tree edges to form the dependency DAG the resolver
  ranks over, replacing the prose-only links (`Triggered by:`, `Resolves:`,
  `composes`) the engine cannot read today. The edge set is the single structured
  source of cross-artifact relationship truth; an `id` that does not resolve is
  corruption (FR-15), not a silent drop. (`depends_on` + `supersedes` gate the DAG
  and MUST be acyclic; `relates_to` is non-blocking and exempt from the acyclicity
  rule.)
- **FR-14 (ties are an equivalence class — arbitrary pick licensed).** When, after
  all ranking (FR-2) and dependency (FR-13) computation, >1 node shares the top
  priority band, those nodes are **equally-correct** next tasks. The resolver MAY
  pick any of them; correctness does NOT depend on which. The default pick MUST be
  **deterministic-arbitrary** (lowest `artifact-id`) so T0 tests stay reproducible
  — random selection is permitted but discouraged for that reason. The product
  MUST NOT present the tie-break order as carrying meaning, and SHOULD be able to
  reveal "N equally-next tasks" rather than imply a single forced winner.
- **FR-15 (corruption: detect → deterministic repair → offer LLM escalation).**
  Correctness is **reliably assessable for structure, not for meaning.** The
  resolver MUST deterministically detect structural corruption — malformed
  frontmatter, dangling `epic:`/`depends_on` refs, status-incoherence (FR-9),
  **dependency-graph cycles** (the DAG must be acyclic) — and MUST NOT claim a
  confident next task while corruption stands. Semantic corruption (well-formed
  but wrong content) is explicitly **not** programmatically detectable and out of
  scope. On detected structural corruption the response is a ladder, never a
  silent fix: (1) attempt a **deterministic programmatic repair** (e.g. regenerate
  a stale generated INDEX, re-resolve an unambiguous ref) and **offer** it
  (confirm-before-write); (2) only if no deterministic repair applies, **offer to
  escalate to an LLM** repair — confirm-before-write, dirty-editor-safe, bounded
  and escalating per DR-355. This composes
  [SPEC-005 Auto-Structure Repair](../SPEC-005-auto-structure-repair/requirements.md)
  (offer-never-silent, non-destructive) — it MUST NOT reinvent it. The LLM never
  *decides whether* corruption exists (deterministic, step 0); it only *proposes a
  fix* a human confirms.

### Packaging

- **FR-11 (Tier-0 pure function in `packages/shared`).** The resolver is a single
  pure function in `packages/shared` (no `vscode`, no network), consumed
  identically by (a) the status-bar signpost, (b) the explorer rollup, (c) CI /
  `npm run validate`, and (d) any future surface. One engine → one next-task
  everywhere; editor, CI, and explorer can never disagree. (DR-014 tier map.)
- **FR-12 (correctness invariant + T0 tests).** Every (state → next-task) mapping
  — each severity class, each gate edge, each coherence rule — MUST have a T0
  invariant test. The next task is an invariant, not a feature behaviour. No rule
  ships without its test. The two inconsistencies found in the triggering session
  (stale epic INDEX; SPEC-004 implementing-under-proposed) become T3 regression
  fixtures.

## Costly to Refactor (Zone A)

Seams where a v1 mistake is expensive to undo later — ranked. Each is FR-anchored.

1. **The frontmatter edge vocabulary (`depends_on` / `supersedes` / `relates_to`, FR-13).** Once authors write these keys across real specs/DRs/epics, the *names, cardinality (lists), and gating semantics* become a corpus-wide contract. Renaming a key or flipping `depends_on` from blocking→advisory means migrating every artifact that adopted it. Get the v1 vocabulary right (OQ3 resolved to ship all three) — adding a *new* edge kind later is cheap; changing an existing one is a corpus migration.
2. **`MILESTONE-NNN` as a first-class artifact kind (FR-3b).** Introducing a brand-new registered artifact type (id namespace, `status: open|reached`, INDEX participation) is a schema commitment. If temporal deferral were later modelled differently (a date edge, a flag), every `depends_on: [MILESTONE-NNN]` link and every milestone file would have to be rewritten. The "deferral is always a link" decision (FR-3a) is the load-bearing constraint that makes milestones necessary — reversing *that* unwinds FR-3a, FR-3b together.
3. **The severity-class partial order and its boundaries (FR-2's 4 classes).** Callers (status-bar, explorer, CI — FR-11) and every T0 test (FR-12) encode "gate-violation > blocked-ready > promote-parent > pending". Re-splitting or re-ordering classes invalidates the whole T0 fixture set and any UI that colour-codes by class. The class *count and order* is the stable contract; the `(epic.order, priority, artifact-id)` within-class tie-break (FR-3) is comparatively cheap to retune.
4. **`packages/shared` pure-function signature (FR-11).** The resolver's `(filesystem+frontmatter state) → next-task` signature is imported by 4 surfaces. Changing its input shape or return type is a cross-package break (DR-014 tier map). The Tier-0 purity constraint (no `vscode`, no network) is the hard wall — admitting either later contaminates every consumer and breaks CI usage.
5. **"Human queue only" node-source boundary (FR-8, INV — Two Queues).** The set of node kinds the resolver draws from (epic-promote, spec-approve, adr-accept, phase-action) is defined by *exclusion* of the agent/dispatch queue. If an agent-work node kind were ever admitted, the Two-Queues invariant and its tests fall, and the signpost's meaning ("what the human must do") silently changes. The exclusion is structural and should stay structural.

## Invariants (must hold)

- **INV — Next-task correctness (T0).** The resolver MUST NOT present a next task
  that is wrong for the current state, and MUST emit "unclear" rather than guess
  when state is incoherent (FR-10). Because it is a derived view of file truth
  (FR-1), correctness reduces to "reads state + applies the ranked rules" —
  testable (FR-12), not predicted.
- **INV — Two Queues (T0).** The human next-task queue and the agent/LLM dispatch
  queue MUST remain distinct. No agent work item is ever emitted as a human next
  task, and vice versa.
- **INV — Determinism / Tier 0 (DR-004, DR-019).** Resolution is pure
  filesystem + frontmatter; no AI, no network. The LLM's only sanctioned role is
  *suggesting* values for the explicit weight fields (FR-3) for the human to
  accept — never computing the live next task. (DR-019.)
- **INV #5 (user override wins).** Reuses SPEC-010 FR-7 override memory: the human
  may dismiss the current next task ("not this — I'm on X"); the dismissal sticks
  until state changes.

## Acceptance Criteria (Zone A)

Definition-of-done — each item traces FR(s) and is the concrete check that the
requirement is met. The resolver ships only when every box is tickable.

- [ ] **(FR-1, INV-determinism)** Given a fixed fixture tree, the resolver returns the *same* next-task on repeated runs; no LLM/network call is reachable from the resolve path. A test asserts byte-identical output across N runs.
- [ ] **(FR-2)** A fixture with one node of each severity class yields the next-task drawn from **gate-violation** first; T0 tests cover all four class boundaries and the `(epic.order, priority, artifact-id)` within-class tie-break.
- [ ] **(FR-5)** The primary output is exactly **one** task object (kind, target id, imperative string, clearing action) — not a list — verified by output shape.
- [ ] **(FR-6)** The full ranked queue is retrievable on demand and is collapsed/secondary by default.
- [ ] **(FR-7)** Every emitted next-task carries its derivation (severity class + the gate/rule that produced it, e.g. "implementing-but-unapproved → DR-012"); a deliberately-wrong fixture is diagnosable to the artifact+rule.
- [ ] **(FR-8, INV — Two Queues)** No agent/dispatch node ever appears in resolver output; a fixture seeded with a dispatch item proves exclusion.
- [ ] **(FR-8a)** Simulated dev "deviation" (state unchanged) does NOT alter the canonical next-task; only an artifact-state change moves it.
- [ ] **(FR-9, FR-10)** A child-ahead-of-parent fixture surfaces as the top gate-violation; beyond-FR-9 incoherence (dangling ref / malformed frontmatter) yields "state unclear — <file>", never a fabricated task.
- [ ] **(FR-13)** `depends_on` / `supersedes` / `relates_to` are parsed from frontmatter; a `depends_on` blocker ranks its dependent below it; an un-cleared blocker that is advanced-past is reported as gate-violation; a dangling edge id is corruption (FR-15), not a silent drop.
- [ ] **(FR-14)** A top-band tie returns a deterministic-arbitrary pick (lowest `artifact-id`) and can report "N equally-next tasks".
- [ ] **(FR-15)** Structural corruption (malformed frontmatter, dangling refs, DAG cycle) is detected deterministically; the ladder offers programmatic repair first, LLM escalation only when no deterministic repair applies; both confirm-before-write.
- [ ] **(FR-11)** A single pure function in `packages/shared` (no `vscode`, no network) is the *only* resolver, imported by status-bar, explorer rollup, and CI/`npm run validate`.
- [ ] **(FR-12)** Each (state → next-task) mapping has a T0 invariant test; the two triggering-session inconsistencies (stale epic INDEX; SPEC-004 implementing-under-proposed) exist as T3 regression fixtures.

## Coverage Map (all bases)

| Concern (from session) | FR |
|---|---|
| Priority via DAG not LLM | FR-1, FR-2, INV-determinism |
| One next task, not a list | FR-5 |
| Optional expand to see pipeline | FR-6 |
| Next task = human's, not LLM's | FR-8, INV-two-queues |
| Reliable / deterministic assessment | FR-1, FR-2, FR-9, FR-12 |
| Subjective weight (ScroogeLLM=future) | FR-3, FR-3a |
| Two weight dials (order + priority) | FR-3, FR-2 |
| Deferral as a link, not a boolean | FR-3a, FR-13 |
| Temporal deferral via milestones | FR-3b |
| Cross-cutting deps outside SDD tree | FR-13 |
| Relates-to clustering for ordering | FR-13 |
| Deviation must not move signpost | FR-8a |
| Ties → arbitrary pick OK | FR-14 |
| Corruption: detect → fix → escalate | FR-15 |
| Reliable correctness = structural only | FR-15 |
| Gate violations (the 2 found by hand) | FR-9, FR-12 |
| Resolve SPEC-010 OQ#1 (global order) | FR-2, FR-4 |
| One engine, every surface | FR-11 |

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|---|---|---|
| R1 | **Frontmatter rot → confident-wrong next task.** The DAG is only as fresh as the frontmatter; a stale `status`/`order`/`depends_on` yields a wrong signpost stated with full confidence (the stale-INDEX bug, exactly). | High · High | FR-9 coherence + FR-15 structural-corruption checks run as a resolve-time **precondition**; on breach, degrade honestly (FR-10) — emit "unclear", never a wrong step. Acyclicity check catches dependency rot. |
| R2 | **Edge-maintenance burden → cross-cutting deps never authored.** If devs don't write `depends_on`, real blockers stay invisible and the resolver under-orders (ranks a blocked item too high). | High · Med | Prose-link linter flags `Resolves:`/`Triggered by:`/`composes` prose with no matching machine edge; optional opt-in LLM **suggests** edges for human accept (never auto-writes, DR-019). |
| R3 | **Surfaces disagree.** Status-bar, explorer rollup, and CI computing the next task differently destroys trust in the signpost. | Low · High | FR-11 single pure function in `packages/shared` — one engine, one verdict everywhere. T0 tests pin the mapping. |
| R4 | **`epic.order` is a human guess → wrong global next task, confidently.** Determinism faithfully propagates a bad human-set weight. | Med · Med | FR-7 show-the-evidence makes any wrong order diagnosable to the field that caused it; `order` is cheap to edit; INV #5 override lets the human dismiss and proceed. |
| R5 | **Corruption blackout (DoS).** One cycle or malformed file makes the resolver say "unclear" globally → no next task at all, signpost dead. | Med · High | FR-15 localizes the report to the offending edge/file set and offers repair; the rest of the DAG MUST still resolve. A single bad node must not blank the whole signpost. |
| R6 | **Advisory drifts to de-facto blocking.** Human follows the signpost blindly, mis-ordering real-world priorities the model can't see. | Med · Med | FR-5 advisory + INV #5 override + FR-6 pipeline view (see what's behind the one task). The signpost suggests; the human still decides. |
| R7 | **Two-queue leak.** Agent/LLM dispatch work surfaces as a human next task (or vice-versa), polluting the signpost. | Low · Med | INV — Two Queues (T0) + dedicated tests; the resolver's node sources exclude the dispatch queue by construction (FR-8). |

## Assumptions

- SPEC-010's per-feature resolver already exposes a consumable `phase-action` node source (FR-4 composes it, does not re-implement); this spec assumes that interface exists or lands alongside it.
- Artifacts carry parseable YAML frontmatter with `status`, and (where set) `epic`, `epic.order`, `priority`, and the FR-13 edge keys — i.e. the validation gate from `npm run validate` keeps frontmatter well-formed enough to parse.
- The implicit SDD-tree edges (epic→members, spec-approval→implement per DR-012, phase-predecessor→successor per SPEC-010) are derivable from existing structure without new authoring; only the **explicit** cross-cutting edges (FR-13) require new frontmatter authoring.
- A `MILESTONE-NNN` artifact registry / INDEX participation (FR-3b) can reuse the same id+status+index pattern already used for SPECs/DRs/epics rather than needing a new storage substrate.

## Test-thought

Verified by a T0 invariant-fixture suite in `packages/shared/tests`: each (state → next-task) mapping (every FR-2 severity class, every gate edge, every FR-9 coherence rule, the FR-14 tie pick, FR-15 corruption detection) is a deterministic fixture-in → expected-next-task-out assertion (FR-12), with the two triggering-session bugs (stale epic INDEX; SPEC-004 implementing-under-proposed) pinned as T3 regression fixtures. Determinism is itself the test enabler — same input, same output, no mocking of LLM/network because none is reachable (FR-1).

## Consequences

**Positive:**
- Collapses SPEC-010's within-feature signpost and the three cross-artifact approval gates into **one** total order, resolving SPEC-010 OQ#1 (global ordering) with a single engine rather than per-surface logic (FR-2, FR-4).
- Makes prose-only relationships (`Triggered by:`, `Resolves:`, `composes`) machine-readable (FR-13), so blockers the engine was blind to now actually re-rank — and a dangling ref becomes detectable corruption instead of an invisible drop (FR-15).
- One `packages/shared` pure function means status-bar, explorer, and CI can never disagree on "next task" (FR-11) — the signpost has a single source of truth.

**Negative:**
- Adds authoring burden: cross-cutting blockers only count once a human writes `depends_on`/`supersedes` (FR-13) and registers `MILESTONE-NNN` artifacts (FR-3b). Un-authored edges leave the resolver under-ordering (R2).
- Introduces a new corpus-wide frontmatter contract (the edge vocabulary) that, once adopted, is costly to change (see Costly to Refactor #1) — and a new artifact kind (milestones) to maintain.
- The resolver is now a single point of failure for the signpost: a structural-corruption blackout (R5) must be carefully localized (FR-15) or one bad file blanks the global next-task.

## Failure-Modes / Edge-Cases

1. **Dependency-graph cycle** (`A depends_on B`, `B depends_on A`, possibly transitively). The DAG-must-be-acyclic invariant (FR-15) is breached; resolver MUST report the cycle as structural corruption and degrade (FR-10), not loop or pick arbitrarily.
2. **Dangling edge id** — `depends_on: [SPEC-999]` where SPEC-999 doesn't resolve. Corruption (FR-13/FR-15), surfaced for repair; never silently dropped.
3. **Empty queue** — no pending human decisions at all (every gate cleared, no `phase-action` hole). The resolver MUST emit a clean "nothing pending" state — a well-formed empty result, distinct from the FR-10 "state unclear" degradation — and MUST NOT fabricate a task (the inverse of the FR-5 single-task output: zero, not one) nor error.
4. **All-tied top band** — every top-priority node is in one FR-14 equivalence class; resolver returns the deterministic-arbitrary lowest-`artifact-id` pick and can report "N equally-next".
5. **Coherence breach vs deeper incoherence** — child-ahead-of-parent (FR-9) routes to a gate-violation next-task; malformed/dangling state beyond FR-9 routes to "state unclear — <file>" + repair ladder (FR-10/FR-15). The boundary between these two must not be miscategorized.
6. **`supersedes` to an already-`done`/`archived` target** — superseding a node whose target is already out of the queue must be a no-op, not a re-introduction or error (FR-13).
7. **Milestone never reached** — a `depends_on: [MILESTONE-NNN]` whose milestone stays `open` keeps the dependent legitimately hidden indefinitely; this is correct (auto-clears on reach), not a stuck state (FR-3a/FR-3b).

## Test / Verification Strategy

Per-FR tier + one-line assertion sketch:

| FR | Tier | Assertion sketch |
|---|---|---|
| FR-1 | T0 | Repeated resolve on a fixed fixture → byte-identical output; no LLM/network call reachable from the resolve path. |
| FR-2 | T0 | One-node-per-class fixture → next-task is the gate-violation; within-class order follows `(epic.order, priority, artifact-id)`. |
| FR-3 / FR-3a / FR-3b | T0 | `epic.order`/`priority` change re-orders deterministically; a `depends_on` (incl. on a `MILESTONE-NNN`) hides the dependent until the blocker/milestone clears. |
| FR-4 | T1 | Resolver consumes SPEC-010's `phase-action` source; does not re-derive coverage predicates (no duplicate predicate code path). |
| FR-5 / FR-6 | T2 | Primary output = single task object; full queue retrievable on demand, secondary by default. |
| FR-7 | T2 | Emitted task includes severity class + producing rule; a wrong-on-purpose fixture is diagnosable to artifact+rule. |
| FR-8 / FR-8a | T0 | Dispatch-seeded fixture proves no agent node emitted (INV — Two Queues); state-unchanged "deviation" leaves next-task fixed. |
| FR-9 / FR-10 | T0 | Child-ahead-of-parent → top gate-violation; beyond-FR-9 incoherence → "state unclear — <file>", never a fabricated task. |
| FR-13 | T0/T1 | Each edge kind parsed; `depends_on` ranks dependent below blocker; advancing past un-cleared blocker = gate-violation; dangling id = corruption. |
| FR-14 | T0 | Top-band tie → lowest-`artifact-id` pick; "N equally-next" reportable. |
| FR-15 | T0/T2 | Cycle/dangling/malformed detected deterministically; repair ladder offered (deterministic first, LLM second), confirm-before-write. |
| FR-11 | T1 | Single `packages/shared` pure function (no `vscode`/network) imported by status-bar, explorer, CI. |
| FR-12 | T0 | Coverage check: every severity class + gate edge + coherence rule has a mapped T0 test; 2 session bugs exist as T3 fixtures. |

## Alternatives Considered

- **LLM-ranked next task.** Let an LLM read the corpus and pick the next task. **Rejected:** non-reproducible, untestable, and violates Tier-0/determinism (FR-1, INV — Determinism, DR-004/DR-019); the whole point of EPIC-002 is a signpost that can't lie, which requires a derived (not guessed) verdict.
- **Emit a ranked list/backlog instead of one task.** **Rejected:** a backlog is precisely what MinSpec exists to collapse into a single pointer (Context); the list survives only as the optional FR-6 expansion, not the primary output (FR-5).
- **`deferred: true` boolean for "not now".** **Rejected (FR-3a):** a boolean rots — set once, never unset, so the item stays hidden after its blocker clears. Replaced by a `depends_on` link (auto-clears, explainable, one mechanism), with `MILESTONE-NNN` for purely-temporal deferral (FR-3b).
- **Per-surface resolver logic** (status-bar, explorer, CI each compute their own). **Rejected:** surfaces would disagree and destroy signpost trust (R3); replaced by the single `packages/shared` pure function (FR-11).
- **Date-typed deferral edge** for temporal "later". **Rejected (OQ2):** adds a second deferral mechanism and a non-artifact edge type; milestones keep deferral as one uniform link end-to-end (FR-3b).

## Dependencies & Blast-Radius

**Declared dependencies (what this spec consumes / reaches into):**
- [SPEC-010 signpost-correctness](../SPEC-010-signpost-correctness/requirements.md) — `phase-action` node source and FR-6 honest-degradation (FR-4, FR-10); resolves its OQ#1.
- [SPEC-005 auto-structure-repair](../SPEC-005-auto-structure-repair/requirements.md) — composed for the FR-15 repair ladder (offer-never-silent, non-destructive).
- [DR-012](../../../docs/decisions/DR-012.md) content-hash approval gate — defines the `spec-approve` node and the implementing-but-unapproved gate-violation.
- [DR-014](../../../docs/decisions/DR-014.md) tier map — mandates the resolver live in `packages/shared` (FR-11).
- [DR-019](../../../docs/decisions/DR-019.md) — the decision this spec is the contract for (determinism, no-LLM ranking).
- The frontmatter schema across all SPEC/DR/epic artifacts (parsed for `status`, `epic.order`, `priority`, FR-13 edges) and the `MILESTONE-NNN` registry (FR-3b).

**Blast-radius — what breaks if changed:**
- Changing the `packages/shared` resolver signature breaks **all four consumers** (status-bar signpost, explorer rollup, CI/`npm run validate`, future surfaces) simultaneously (FR-11, DR-014).
- Changing the FR-13 edge vocabulary names/semantics requires migrating every artifact that authored them (Costly to Refactor #1).
- Changing the FR-2 severity-class set/order invalidates the entire T0 fixture suite (FR-12) and any class-coded UI.
- A regression that lets an agent/dispatch node leak in breaks INV — Two Queues across every surface at once (FR-8).

## Rollback / Reversibility

- **Undo mechanism — the engine.** The resolver is a pure additive read-only view (FR-1, FR-11): deleting/disabling the `packages/shared` function and its call-sites removes the signpost with no data loss. Nothing it computes is persisted state, so reverting the code fully reverts the feature.
- **Undo mechanism — the data.** The new frontmatter edges (`depends_on`/`supersedes`/`relates_to`, FR-13) and `MILESTONE-NNN` files are additive metadata; left unread they are inert YAML/markdown. Removing the resolver does not require removing them, and removing them does not corrupt artifacts (they're optional keys).
- **Hard-to-reverse seam (the caveat).** Once authors have written FR-13 edges across the corpus, the *vocabulary* is corpus-wide (Costly to Refactor #1) — the code is reversible in <1 day, but un-adopting the edge keys from many artifacts is not. This asymmetry (reversible engine, sticky data contract) is the reason this is T4 and carries a DR (DR-019).
- **ADR-filter answer.** Can this be undone in <1 day? **The engine: yes** (delete code + call-sites). **The data contract + `MILESTONE-NNN` artifact kind: no** — it's a corpus-wide schema commitment, which is exactly why it is governed by a DR (DR-019) rather than done ad-hoc.

## Follow-ups (tracked)

- **Prose-link linter (R2 mitigation):** flag `Resolves:` / `Triggered by:` / `composes` prose that lacks a matching machine-readable FR-13 edge. Cross-cutting tooling — file as a GitHub issue on `harvest316/minspec` if not already covered by a spec; not yet a SPEC.
- **OQ4 (cross-epic gate-violation tie-break)** and **OQ5 (deterministic-repairable vs LLM-only corruption set)** — both deferred to the plan phase (see Open questions); resolve before implement.
- **MILESTONE-NNN registry/INDEX mechanics (FR-3b)** — exact storage + index-participation to be specified at plan time (assumed to reuse the SPEC/DR id+status+INDEX pattern).
- **UX/data-contract handoff** — the status-bar signpost + explorer rollup visual design is a separate downstream UX spec (see Out of scope); this spec hands it the ordering + task-object contract.

## Out of scope

- **Within-feature coverage predicates** — owned by SPEC-010 (consumed, not
  redefined) and strengthened by SPEC-006.
- **Visual / UX design** of the status-bar signpost and explorer rollup (separate
  UX spec; this defines the data contract + ordering only). The pane restructuring
  the session flagged is downstream of this engine.
- **The agent/LLM dispatch queue** and its ordering — separate substrate
  (DR-015/017, agent-execute).
- **LLM suggestion of `order` / `depends_on` values** — a distinct optional
  feature; this spec only mandates that such values, *however* set, are explicit
  data the engine reads (FR-3), never engine/LLM inference at resolve time.
- **Blocking enforcement** — the resolver is advisory (mirrors SPEC-010 FR-5);
  the blocking gate is DR-012.

## Resolved questions

- **OQ1 — per-spec `priority:` field.** **Resolved: keep it.** Both dials ship —
  `epic.order` (coarse) and `priority:` (fine, within tie). (FR-3, FR-2.)
- **OQ2 — temporal deferral with no artifact blocker.** **Resolved: milestones.**
  Add `MILESTONE-NNN` artifacts as `depends_on` targets; deferral stays one
  mechanism (a link), no date-typed edge, no flag. (FR-3a, FR-3b.)
- **OQ3 — edge vocabulary scope.** **Resolved: include `relates_to` in v1.** Ships
  `depends_on` + `supersedes` (blocking, gate the DAG) + `relates_to` (non-blocking
  clustering — keeps kindred work/tests adjacent in ordering). (FR-13.)

## Open questions

- **OQ4 — Cross-epic vs in-epic gate violations.** When two gate-violations exist
  in different epics, is `epic.order` the right tie-break, or should violation
  *recency* / blast-radius win? Lean `epic.order` for determinism; revisit if it
  mis-orders in practice. *(Open — plan phase.)*
- **OQ5 — Auto-repairable vs LLM-only corruption (FR-15).** Which structural
  corruptions have a *deterministic* fix (stale generated INDEX → regenerate;
  unambiguous dangling ref → re-resolve) vs require an LLM offer (ambiguous ref,
  malformed hand-edited frontmatter)? Enumerate the deterministic set at plan time;
  default everything outside it to the LLM-escalation rung. *(Open — plan phase.)*
