---
id: SPEC-027
type: requirements
status: new
tier: T3
product: minspec
epic: EPIC-009  # Team Readiness
depends_on: [SPEC-026]  # builds on the presence layer + guard; this is Tier-2 of SPEC-026's conflict-resolution ladder
relates_to: []
phases:
  specify: pending
  plan: pending
  tasks: pending
  implement: pending
---

# Inter-Session Comms — Sessions Auto-Resolve Conflicts (Tier 2)

> **Status: new / not yet specified.** Placeholder for the user's #2-ranked
> conflict-resolution preference (see [SPEC-026](../SPEC-026-session-presence/requirements.md)
> §Conflict-Resolution Ladder). Do not treat as designed or built.

Triggered by: [SPEC-026](../SPEC-026-session-presence/requirements.md) D4 — the user
ranks conflict handling **prevent > sessions auto-resolve > HITL**. SPEC-026 delivers
Tier-1 (prevent, via worktree-steer) and Tier-3 (HITL). This spec is **Tier-2**: two
sessions negotiating a conflict *between themselves*, without a human — the user's
original message-1 idea ("my session is editing X"; "session Y, are you still on Z?").

## Context (to be expanded in Specify)

When prevention (worktree-steer) is bypassed and two live sessions genuinely contend
for the same file, the next-best outcome is for the sessions to resolve it without
pulling the human in. The likely shape is a **file-based session mailbox** under
`.minspec/sessions/` (the shared medium already established by SPEC-026 presence): a
session detecting contention writes a request addressed to the peer's `sessionId`; the
peer's agent, instructed by CLAUDE.md to poll its inbox, replies (release / busy /
hand-off).

## Open questions for Specify (not yet resolved)

- **Who listens?** Autonomous agents do not poll unless instructed. Does the CLAUDE.md
  protocol make inbox-checking a per-turn obligation, and what is the cost/latency?
- **What if a peer isn't polling** (mid-long-operation, or a human-only session)? Timeout
  → fall through to Tier-3 HITL (SPEC-026 FR-16).
- **Message schema + lifecycle** — request/reply/expire; how it rides the existing
  presence heartbeat vs. a separate channel; atomicity with the SPEC-026 atomic-write idiom.
- **Trust / loop-safety** — two agents must not ping-pong indefinitely; bounded rounds.
- **Tier-0 boundary** — must stay offline/local (no network), consistent with the presence
  layer.

## Relationship to SPEC-026

SPEC-026 is a hard dependency: this reuses `SessionPresenceRecord`, the liveness/staleness
machinery, `sessionId`, and the `.minspec/sessions/` directory. It sits *between* SPEC-026's
prevention (Tier-1) and HITL (Tier-3) tiers, invoked only when prevention was bypassed and
before falling through to the human.
