---
id: SPEC-010
type: requirements
status: specifying
product: minspec
epic: EPIC-002
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

- Topological ordering when multiple specs are simultaneously incomplete — most
  recently edited, lowest SPEC-NNN, or explicit priority/WSJF? (Affects which
  single "next step" surfaces globally.)
- Where the coverage DAG lives: derived on demand from `.minspec/traceability.json`
  + frontmatter, or cached. (Leans on-demand per DR-004 pure-fs.)
- Exact "ready/transition" trigger set for FR-11 (reuse SPEC-006 RD-2
  `status: done` transition vs a distinct signpost-ready signal).
