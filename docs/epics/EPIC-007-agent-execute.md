---
id: EPIC-007
slug: agent-execute
title: Agent Execute Extension
status: proposed
order: 7
---

# EPIC-007: Agent Execute Extension

## Goal

Ship *execution* — an agent that actually runs SDD tasks against a spec — as a
**separate, opt-in third extension** (`aiclarity.agent-execute`, Tier 1), so that
MinSpec itself stays air-gapped (Tier 0). Execution is where credentials,
network, and autonomy enter; isolating it behind its own extension boundary is
what lets the methodology core keep its no-AI / no-network guarantees.

"Done" = a packaged Execute extension with a **vsix control plane** driving a
**containerised, credential-free exec plane**; tier-gated HITL (T1–T2
auto-dispatch via `agent-ready`, T3–T4 `needs-review` pending human approval of
spec/plan); and a host-side model broker that defaults to subscription
`claude -p` (no pay-as-you-go API spend), with API-key / ScroogeLLM routing as an
explicit opt-in.

## Principle

**Execution never contaminates the methodology core.** MinSpec stays Tier 0; all
credentialed, networked, or agentic capability lives behind the separate
extension. Unattended dispatch is **gated on no-credential execution isolation**
(DR-008): the sandbox holds no secrets and reaches models only through a
host-side broker that injects credentials it never sees — so an escaped or
misbehaving agent has nothing to exfiltrate. Billing defaults to subscription
quota, never silent PAYG.

## Artifacts

- **Decisions:**
  [DR-008](../decisions/DR-008.md) — unattended dispatch gated on no-credential
  execution isolation (the security precondition).
  [DR-015](../decisions/DR-015.md) — the agent system ships as a third "Execute"
  extension shared by MinSpec and ScroogeLLM (packaging boundary).
  [DR-017](../decisions/DR-017.md) — Layer-2 execution substrate: vsix control
  plane + containerised exec plane, host-side model broker defaulting to
  subscription `claude -p`.
- **Dev-time path (today):** `scripts/` dispatch — `scripts/roles/`,
  `scripts/dispatch-issue.sh`, `scripts/triage-inbox.sh`. This is the in-repo
  build harness; the **productized** form is this extension and does **not** ship
  inside MinSpec.
- **Status / open questions:** Specify phase not yet started (future session).
  Resolve subscription OAuth-injection into the cred-free sandbox during Specify.
- **Issues:** label `epic:agent-execute`.
