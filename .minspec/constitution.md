# minspec-monorepo — Constitution

## Invariants

Rules that must never be violated. All changes must preserve them.

<!-- Add invariants here. Example: -->
<!-- 1. No breaking changes to public API without deprecation cycle -->
<!-- 2. All user data stays local — no network calls without consent -->

## Principles

Guidelines that should be followed. Can be bent in exceptional circumstances with justification.

<!-- Add principles here. Example: -->
<!-- 1. Ceremony proportional to complexity -->
<!-- 2. User override always wins -->
<!-- 3. Specs are living documents, not bureaucracy -->

## Constraints

Technical or business constraints that bound the solution space.

<!-- Add constraints here. Example: -->
<!-- 1. Must run offline — zero network dependency -->
<!-- 2. VS Code extension size < 5MB -->
<!-- 3. Node.js 18+ runtime only -->

## Goals

Ranked project goals. **Order = importance** (lower number = higher priority). Each goal
has a **stable ID** (`G-N`) that artifacts reference via `goal: G-N` frontmatter (like
`epic:`, DR-013). The next-task resolver reads `goal-rank` as a deterministic tie-break
within a severity class — never an LLM judgement (DR-039, DR-019).

1. **G-1 — AI-slop guardrails (ensure correctness).** Write-time enforcement that
   AI-assisted code is correct and specified, not vibe-coded slop. The lead benefit.
2. **G-2 — Prevent tech debt.** Avoid the 333Method failure mode — debt accreted through
   rework and scope creep (~3 days bugfixing per 1 day of new function). Rebuild-not-patch;
   guard scope.
3. **G-3 — Just enough human.** The human brain is the bottleneck — automate everything
   else. The LLM does the thorough thinking; the human verifies signal, not content.
4. **G-4 — Opinionated / signpost.** Always tell the human the one thing to review next,
   and park off-topic ideas instead of acting on them. Never a list, never wrong.
5. **G-5 — Top of funnel into Scrooge.** MinSpec is the acquisition surface that feeds
   ScroogeLLM — the money maker.
6. **G-6 — Determinism as moat.** The same rule fires across editor, commit, CI, and
   agent — reproducible, testable, auditable (Tier-0, DR-004 / DR-014).
7. **G-7 — Editor-native SDD / CDD / WSJF.** Methodology enforced *in the editor at write
   time*, not bolted on as a separate CLI or IDE (the differentiator vs spec-kit / Kiro).

## Phases

MinSpec ships in **two phases**. Phase 1 is the gate that unblocks every dependent
project; Phase 2 is public polish. **Phase-1 work always outranks Phase-2 work** until
the Phase-1 line below is met — a priority signal for the next-task resolver (G-4),
not a soft preference.

MinSpec is a **hard dependency** of every other project (ColdForge, LeadForge, coldforge, …):
treat an unmet Phase-1 item as a cross-project blocker, not local backlog.

### Phase 1 — Dogfood-ready (the blocker line)

MinSpec stops being a blocker to dependent projects when a dependent repo can go from
`git init` to its **first implemented vertical slice** using *only* MinSpec Command-Palette
commands — no hand-editing of `.minspec/` state, no working around a missing phase command,
and every gate firing deterministically.

Done = all true:

- [ ] **Init + harness** scaffolds a fresh repo (`.minspec/`, CLAUDE.md, hooks).
- [ ] **Classify** assigns T1–T4 on a real change.
- [ ] **Phase commands** — specify → plan → tasks → implement — each produce *and* validate
      their artifacts.
- [ ] **Gates are deterministic + symmetric**: editor, commit, and CI agree, and the
      validator rejects *missing* and *invalid* values, not just dangling refs (closes the
      asymmetry class — #137).
- [ ] **Signpost never lies**: the resolver surfaces the one next human task and the wiring
      is live (SPEC-012, #288).
- [ ] **Approvals + status foundation** has committed ground truth so signpost/status cannot
      go stale (#95 shared+attributed approvals, #116 deterministic status).

This realises **G-1, G-2, G-3, G-4, G-6, G-7** at solo-dogfood strength. Explicitly **out of
Phase 1**: Marketplace publish, public onboarding, the ScroogeLLM funnel (G-5) beyond a stub,
agent-execute (DR-015), team/CI dispatch, DAG-viz polish, and marketing / site copy.

### Phase 2 — Public-ready (polish)

Everything deferred above: Marketplace listing + onboarding, the Scrooge funnel (G-5),
broader model / UX polish, team mode. May be polished incrementally **as long as no Phase-2
item displaces an unmet Phase-1 item**.
