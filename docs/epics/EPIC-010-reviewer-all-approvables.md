---
id: EPIC-010
slug: reviewer-all-approvables
title: Reviewer Across All Approvables
status: active
order: 10
---

# EPIC-010: Reviewer Across All Approvables

## Goal

Ship the independent AI reviewer — established for PRs by
[DR-033 §6](../decisions/DR-033.md) — for **every Approvable type** (Spec, Plan,
DR, constitution invariant, Epic, PR). Every artifact that enters the human
approval gate must first be greenlit by a fresh-context opus reviewer that is
never the author. The human queue becomes a pre-filtered, AI-greenlit set
across all types; the rubber-stamp failure class (#344–349) becomes structurally
unreachable.

"Done" = an independent reviewer-agent exists and runs for each Approvable type;
the signpost predicate (greenlit-for-type ∧ prior-stage-gates-clear) applies
uniformly; the doc-before-code ordering gate is enforced; per-type verdict
recording (`ai-review/<type>:*`) is wired.

## Principle

**Independence is the value (DR-033 §6).** The reviewer is always a second agent
with fresh context — never the one that authored the artifact. Reviewing your own
work is worth approximately zero. Every design choice here follows from that
axiom and from the never-wrong / HITL invariant: the reviewer advises, the human
decides; the reviewer can never approve, merge, or modify an artifact.

The PR reviewer (DR-033 §6, #342) is the **precedent pattern** — the per-type
reviewers for Specs, Plans, DRs, constitution invariants, and Epics share its
shape: fresh-context opus agent, verdict + findings block, bounded auto-loop on
`request-changes` (default 2 cycles → `agent-escalated`), `ai-review:*` family
recording.

Rationale: [DR-047](../decisions/DR-047.md) — full context, decision, and
alternatives.

## Checklist

- [ ] **Spec substance reviewer** — fresh-context opus agent audits FRs for
  internal consistency, scope correctness for tier, grounded context, and
  resolved OQs before the spec enters the human queue.
- [ ] **Plan substance reviewer** — audits plan for alignment with spec FRs,
  correct T0-first test sequencing, and risk coverage.
- [ ] **DR substance reviewer** — audits alternatives-genuinely-considered,
  Costly-to-Refactor accuracy, and DR-023 follow-up materialisation.
- [ ] **Constitution invariant reviewer** — audits testability, non-contradiction
  with existing invariants, and tier scoping.
- [ ] **Epic reviewer** — audits member-artifact consistency with the epic goal
  and goal measurability.
- [ ] **Signpost-predicate generalisation** — extend the `ai-review:pass`
  predicate in SPEC-012's resolver from PR-only to all Approvable types; an
  un-reviewed or `ai-review:changes` Approvable of any type must not appear in
  the human queue (extends #182).
- [ ] **Doc-before-code ordering gate** — enforce that when a PR carries an
  Approvable doc, that doc is AI-reviewed and greenlit before the PR's code
  review stage runs (DR-047 §3).
- [ ] **Per-type recording** — wire `ai-review/<type>` status checks and the
  `ai-review:<type>:pass` / `:changes` / `:pending` / `:escalated` label family
  for all Approvable types; extend the #342 poster step.

> Issues for each checklist item are tracked individually (see DR-047 Follow-ups).
> Do NOT create member issues from this epic — file them separately per DR-023.

## Related

- [DR-047](../decisions/DR-047.md) — decision rationale (this epic's anchor DR)
- [DR-033 §6](../decisions/DR-033.md) — PR reviewer precedent; #342 = implementation
- [DR-041](../decisions/DR-041.md) — canonical Approvable term
- [SPEC-010](../../specs/minspec/SPEC-010-next-task-signpost/requirements.md) /
  [SPEC-012](../../specs/minspec/SPEC-012-next-task-resolver/requirements.md) — signpost +
  resolver that the predicate generalisation extends (#182)
- Issues: label `epic:reviewer-all-approvables`
