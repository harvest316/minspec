---
id: EPIC-006
slug: trust-and-supply-chain
title: Trust, Consent & Supply Chain
status: active
order: 5
---

# EPIC-006: Trust, Consent & Supply Chain

## Goal

The trust spine shared across all three products: the rules that govern what may
touch the network, what data may leave the machine, what ships in a release, and
under what license. These are the cross-cutting invariants every other epic
builds on top of.

"Done" = a tiered network-consent model enforced by invariant tests (not
convention); a pre-publish supply-chain inventory gate that blocks release on
undeclared dependencies; marker-bounded updates that never surprise-write; a
settled license split across core/extensions/content; and a documented
shared-code boundary with single-writer disk artifacts — **each encoded as a DR
with a mechanism that enforces it.**

## Principle

**Consent and auditability over capability.** Default to Tier 0 (no AI, no
network); every escalation up the tier ladder is explicit, dismissible, and
visible in the UI (opt-in + settings text + status bar counts as auditable). Any
upsell or telemetry must not pry — no inspecting LLM history, percentage savings
rather than dollar anchors, delayed and cooldown-gated — and visibility through
the UI is what makes a capability compliant, not the absence of the capability.

## Artifacts

- **Decisions:**
  [DR-004](../decisions/DR-004.md) — tiered network-consent model (Tier 0 core,
  delegated network out-of-tree; the invariant the no-`fetch` tests enforce).
  [DR-005](../decisions/DR-005.md) — pre-publish supply-chain inventory gate
  (`bumblebee`), the release-blocking SBOM check.
  [DR-011](../decisions/DR-011.md) — marker-bounded auto-update with no permission
  prompt (the bounded exception to "always ask"; shared with
  [EPIC-005](EPIC-005-structure-repair.md)).
  [DR-014](../decisions/DR-014.md) — shared-code boundary: tier→package map,
  single-writer disk artifacts, version lockstep.
  [DR-018](../decisions/DR-018.md) — licensing: MPL-2.0 shared core, MIT
  extensions, CC-BY-4.0 content.
- **Reference:** `bumblebee` binary at `~/go/bin/bumblebee`, catalogs in
  `~/.cache/bumblebee/catalogs/` — the pre-publish gate per DR-005.
- **Related (telemetry/upsell consent):** ScroogeLLM's
  [DR-010](../decisions/DR-010.md) opt-in RUM telemetry lives under
  [EPIC-008](EPIC-008-scroogellm.md) but is governed by this epic's consent
  principle; the upsell-trust rules (no prying, % not $, delay + cooldown) apply
  product-wide.
- **Issues:** label `epic:trust-and-supply-chain`.
