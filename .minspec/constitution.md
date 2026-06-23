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

> **DRAFT — review, re-rank, and edit.** These are seeded from documented strategic
> intent (DR-001, keyword research #59–63, the "just enough human" principle). Goals are
> human-authored: confirm the wording, drop/add, and set the order you actually want.

1. **G-1 — Never-wrong signpost.** MinSpec is always opinionated about the *one* next
   thing to do, and never wrong: priority is deterministic, reproducible, testable — never
   an LLM guess. (EPIC-002 / DR-019)
2. **G-2 — Guardrails against AI slop.** Write-time completeness and quality enforcement
   so AI-assisted code is specified, not vibe-coded. The lead benefit, SDD the mechanism.
3. **G-3 — Just enough human.** The LLM does the thorough thinking; the human verifies
   signal, not content. Minimum ceremony for maximum direction.
4. **G-4 — Determinism as moat.** The same rule fires across editor, commit, CI, and
   agent — auditable and air-gapped (Tier-0, DR-004 / DR-014).
5. **G-5 — Editor-native SDD.** SDD enforced *in the editor at write time*, not bolted on
   as a separate CLI or IDE (the differentiator vs spec-kit / Kiro).
