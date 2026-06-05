---
id: EPIC-002
slug: signpost-integrity
title: Signpost Integrity
status: active
order: 2
---

# EPIC-002: Signpost Integrity

## Goal

The signpost is MinSpec's core differentiator: it always tells the developer and
the AI agent the single next SDD action. The product promise — and the marketing
hook (guardrails against vibe-coded AI slop) — is that the signpost is **never
wrong**. A wrong next-step, or a false "complete", destroys the trust the whole
tool depends on.

"Done" = a deterministic, DAG-derived signpost; deterministic completeness
predicates that run at write-time across editor / commit / CI / agent dispatch;
and a recovery path that repairs incoherent state without the LLM ever becoming
the signpost itself.

## Principle

Determinism is both the correctness strategy and the moat. The signpost is a
derived **view** of file-system truth (cheap to keep correct), never a
**prediction** (expensive, untrustworthy). The LLM repairs the inputs the view
reads — it does not drive the view. This is what a CLI (spec-kit) or a separate
IDE (Kiro) structurally cannot do: completeness enforced at write-time,
in-editor, by the *same rule* as CI and agent dispatch.

## Artifacts

- **Specs:**
  [SPEC-010 Signpost Correctness](../../specs/minspec/SPEC-010-signpost-correctness/requirements.md)
  — DAG state model, six correctness mechanisms, save-time completeness check,
  five nag-avoidance guardrails, correctness + advisory invariants.
  [SPEC-012 Next-Task Resolver](../../specs/minspec/SPEC-012-next-task-resolver/requirements.md)
  — cross-artifact priority DAG over approval/status gates + SPEC-010 phase
  actions; single deterministic next human task + optional pipeline; resolves
  SPEC-010 OQ#1.
- **Composed specs (pre-existing):**
  [SPEC-006 Stub & Completeness Gate](../../specs/minspec/SPEC-006-stub-completeness-gate/requirements.md)
  (strengthens the deterministic predicate);
  [SPEC-005 Auto-Structure Repair](../../specs/minspec/SPEC-005-auto-structure-repair/requirements.md)
  (offer-driven recovery; triggered by SPEC-010 honest-degradation, never silent).
- **Decisions:** [DR-012](../decisions/DR-012.md) — HITL gate consumes the
  completeness contract for blocking enforcement (the signpost itself is advisory).
  [DR-019](../decisions/DR-019.md) — next-task priority is a deterministic
  cross-artifact DAG, never an LLM judgement (governs SPEC-012).
- **Issues:** label `epic:signpost-integrity`.
