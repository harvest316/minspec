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
