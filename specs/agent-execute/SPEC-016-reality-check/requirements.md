---
id: SPEC-016
type: requirements
# 🔒 Once approved, hash-locked: approved bytes recorded in .minspec/approvals.json[SPEC-016].specHash. ANY edit voids approval (hash → stale) — re-run "MinSpec: Approve Spec". DR-012.
status: implementing
tier: T3
product: agent-execute
epic: EPIC-007  # Agent Execute Extension
depends_on: [DR-029, DR-030, DR-004, DR-015, DR-026]  # DR-029 keystone; DR-030 isolation; DR-004 tiering; DR-015 packaging; DR-026 offer-never-silent
relates_to: [SPEC-013, SPEC-010, SPEC-011]
---

# MinSpec — Reality-Check Reviewer + Round-Table (Slices 2-3)

> **Slices 2-3 of [DR-029](../../../docs/decisions/DR-029.md) (§8).** The **Tier-1**
> amplifier over SPEC-013's deterministic floor: an independent adversarial
> second-reviewer (Slice 2) and an opt-in multi-lens round-table (Slice 3). Ships in
> the **agent-execute** extension ([DR-015](../../../docs/decisions/DR-015.md)) —
> **never** in `packages/minspec` / `packages/shared` (Invariant #1). The core
> consumes a verdict JSON only; absent → degrade to the SPEC-013 floor. Untrusted
> input handled per [DR-030](../../../docs/decisions/DR-030.md). Makes **no skim claim**
> (gated on the study, [#127](https://github.com/harvest316/minspec/issues/127)).

**Date:** 2026-06-03
**Decision:** [DR-029](../../../docs/decisions/DR-029.md) §5 · isolation [DR-030](../../../docs/decisions/DR-030.md) · tiering [DR-004](../../../docs/decisions/DR-004.md) · reuses the [SPEC-011](../../minspec/epic-backfill/requirements.md) `claude -p` pattern.
**Epic:** [EPIC-007 Agent Execute Extension](../../../docs/epics/EPIC-007-agent-execute.md)

---

## Context

SPEC-013's deterministic floor catches **omission**, never **vacuity** — a
specific-but-empty self-audit line ("FR-3: risk that FR-3 fails; mitigate it") clears
every Tier-0 layer (DR-029 R1). The only thing that can judge whether a risk is
*material* or a mitigation *actually addresses* its FR is a reasoning reviewer. This
spec adds that: an **independent adversarial agent** that re-reads the finished
self-audit and tries to break it, returning an **advisory verdict**.

It is the gap-closer, not the floor. It is opt-in, degrades to the floor when absent,
never blocks, and — critically — its output is **advisory** until the validation
study earns the skim claim (DR-029 §6). The agent reviews; it does not author content
into the doc (LLM authoring is the spec-author flow, DR-029).

## Requirements

### Reality-check reviewer (Slice 2)

- **FR-1 (independent reviewer).** A different agent instance with a different system
  prompt than the spec's author (no grading its own homework). Runs in the
  **cross-checks** phase after the self-audit is written.
- **FR-2 (inputs; floor gaps as exclusions).** Inputs: frozen Zone A + FR-set + the
  written self-audit + constitution/invariants + SPEC-013's Tier-0 report. The Tier-0
  gaps are passed as **exclusions, not a to-do list**: "these FRs are already covered
  deterministically — do NOT re-report them; spend all tokens on what the matrix
  cannot see." (Prevents the agent from just closing named gaps and stopping.)
- **FR-3 (what it checks).** Per FR: a *material* risk the section missed; a
  mitigation/test that does not actually address its FR (specific-but-wrong); semantic
  contradiction Zone A↔B or a violated invariant; a false/unverifiable Assumption or
  unhandled-unacknowledged edge case; under-stated blast-radius vs the real import
  graph (codegraph, the one factual anchor → least hallucination-prone).
- **FR-4 (two-lens default at T3).** Default = two decorrelated lenses
  ("find the bug" + "defend the spec", roles per [#129](https://github.com/harvest316/minspec/issues/129)),
  to blunt same-model collusion (~2× the cheap-check cost, accepted). Single-lens
  permitted at lower opt-in tiers.
- **FR-5 (advisory verdict → B1/B2, never block, never auto-write).** The verdict is
  **advisory**: flagged items float to **B2 "please read"** (SPEC-013 FR-8) and stamp
  provenance (which lenses ran, against which hash); it adds **zero** friction clicks,
  is **not** logged/shamed (Invariant #5), and **never blocks** final-approve (only
  DR-012). The agent **never writes content into the artifact**; a suggested edit, if
  offered, is confirm-before-write (DR-026) — content stays author-owned.

### Round-table (Slice 3)

- **FR-6 (opt-in multi-lens, T3/T4).** Escalation of FR-1 to N lenses that debate;
  **opt-in**, **advisory**, never blocks. Default off; never runs unprompted.
- **FR-7 (cost is explicit + metered; resumable on quota-exhaust).** Each round-table
  shows its cost (Scrooge-metered: "round-table: $0.40, 3 concerns") and the user
  accepts before it runs; spend/concurrency is hard-bounded (DR-017 broker; the model
  call carries `--max-budget-usd`). A quota-exhausted run yields a **partial verdict
  clearly marked partial** (never a partial latched as complete) **plus a checkpoint** —
  `{ specHash, lensesCompleted, concernsSoFar, roundIndex }` — so a later run **resumes
  the remaining lenses instead of re-paying for the completed ones**. The checkpoint is
  a *cache, not state of record*: resume only when `specHash` still matches the current
  Zone A; on **any** mismatch the checkpoint is **discarded** and the round-table
  restarts (a stale partial must never be stitched onto edited content — DR-012
  hash-lock + INV-advisory). Resume is advisory and never blocks; a discarded checkpoint
  is a silent no-op, not an error.

### Tier-1 mechanics (reuse SPEC-011) + isolation (DR-030)

- **FR-8 (claude -p pattern, graceful degradation).** Reuse SPEC-011's pattern
  verbatim: `isClaudeAvailable()` probe; `execFile` (never shell/http); JSON-only
  schema instruction; tolerant `extractJson`; a pure normaliser that drops anything
  unrecognised. **Any failure (binary absent / timeout / non-JSON / empty / non-zero)
  is `catch → log the reason → return a typed fallback`** — NEVER throws to the caller,
  but is **never a silent black hole**. The fallback is a discriminated result
  (`{ ok: false, reason: 'absent' | 'timeout' | 'bad-json' | 'empty' | 'exit' }`), not
  a bare `null`, so *expected degradation* (claude absent) is distinguishable from *a
  bug*; the swallowed reason is logged + **observable** (debug log / inspectable
  "last error" in the UI — auditable-via-UI). The caller falls back to the SPEC-013
  Tier-0 floor on any `ok: false`. Keep the never-throw shell **thin** — complex logic
  lives in inner functions that throw normally (real stack traces); the shell only
  catches at the seam, logs, and degrades. With no AI installed, MinSpec is
  byte-for-byte the structure-only product; the only added surface is an "install
  agent-execute to enable review" affordance.
- **FR-9 (untrusted input — DR-030; injection bounded structurally, not just textually).**
  Spec content is passed as **delimited DATA, not instructions** (XML-tagged untrusted
  envelope) via **stdin, not an argv string** (no shell/quoting surface; `execFile` per
  FR-8); the system prompt states the content may attempt injection and must be reviewed,
  never obeyed. Textual framing only bounds *quality*; the *integrity* bound is
  **structural, enforced at the model-call parameters**: the reviewer is spawned
  **tools-off** (`--tools ""`, no `--mcp-config`, `--strict-mcp-config`), **single-shot**
  (`--max-turns 1`), **schema-bound** (`--output-format json` → Zod, FR-10), **default
  permissions** (never `bypassPermissions`), and **`--bare`** (no CLAUDE.md / auto-memory /
  keychain bleed into the untrusted context). Combined with **credential-free, no write,
  no network beyond the single broker call** (DR-008/DR-004), a fully-successful injection
  has **no tool to call, no credential to spend, no turn to chain, and no output channel
  outside the schema** — so it can at worst bias one **advisory**, never an action,
  approval, exfiltration, or write. *Honest limit: no parameter makes the model immune to
  being persuaded toward a wrong advisory (R2, residual); parameters bound the blast
  radius, two-lens decorrelation (FR-4) blunts the persuasion.*
- **FR-10 (verdict contract).** The verdict is a **Zod-validated JSON contract**; its
  *type* may live in `packages/shared` (Tier-0 type only — no invocation), the
  *invocation* lives in agent-execute. Free text outside the schema is dropped. The
  verdict is **never executed**.

### Trust boundary

- **FR-11 (no skim claim here).** This spec **does not** activate the "skim instead of
  read" affordance — the appendix label stays `Self-Audit · read what you want` even
  when the agent ran (an agent-ran provenance stamp is allowed; a *skim licence* is
  not). The claim is unlocked only by the study (DR-029 §6; #127).

## Costly to Refactor

*The expensive-to-reverse commitments — read these closely; everything else is cheap
to change on live. Ranked most→least costly.*

1. **Agent in agent-execute, never in core; core consumes verdict JSON only** (FR-8,
   INV-Tier-1; DR-015) — agent code landing in `packages/minspec` breaks invariant #1
   and is very costly to extract. *Check: invocation in agent-execute; minspec only
   reads the verdict.*
2. **Never-throw graceful degradation to the Tier-0 floor** (FR-8, INV-degrades) — if
   the agent can throw/block, the air-gap guarantee dies; retrofitting never-throw is
   costly. Never-throw must NOT be a silent black hole: `catch → log reason → typed
   fallback`, thin shell over throwing inner fns. *Check: T0 never-throw-contract test
   — every failure path (absent/timeout/bad-json/empty/exit) returns `{ok:false,
   reason}`, never throws; the floor stands with claude absent; the reason is logged.*
3. **Zod verdict contract** (FR-10, OQ-1) — the cross-boundary contract between Tier-1
   agent and core; changing it later breaks both sides. *Check: schema fixed before
   build (contracts-first).*
4. **Untrusted input as DATA + credential-free** (FR-9; DR-030) — if the agent gets
   creds/write/network or treats content as instructions, injection becomes an action.
   *Check: credential-free, data-framed, no write.*
5. **Advisory — never blocks, never auto-writes** (FR-5, INV-advisory) — coupling the
   verdict into the approval path or auto-edits breaks offer-never-silent. *Check:
   verdict advisory-only.*

## Invariants (must hold)

- **INV — Tier-1, degrades to Tier-0 (T0).** No code path makes MinSpec core depend on
  this agent; absent/failed → the SPEC-013 floor is the full experience (FR-8). No AI
  or network in `packages/minspec` / `packages/shared`.
- **INV — Advisory, never blocks, never auto-writes (T0).** The verdict never blocks
  final-approve and never writes content into the artifact (FR-5; DR-026; Invariant #5).
- **INV — Untrusted input is data (T0).** Spec content is never executed as
  instructions; the agent is credential-free and cannot act (FR-9; DR-030).

## Acceptance Criteria

*Definition-of-done — each item traces a concrete FR/invariant. Checked = built + its
T0/T1 test green. Tier-scaled (T3); the deterministic-degradation criterion is the
load-bearing one — it is the only guarantee that survives with no AI installed.*

- [ ] **Reviewer is independent** — a different instance + different system prompt than
  the author runs in the cross-checks phase; no path lets the author grade its own work.
  *(FR-1)*
- [ ] **Floor gaps passed as exclusions, not a to-do** — the Tier-0 report is injected as
  "already covered, do NOT re-report"; the agent does not just close named gaps and stop.
  *(FR-2)*
- [ ] **Per-FR material checks** — for each FR the verdict can flag a missed *material*
  risk, a specific-but-wrong mitigation/test, a Zone A↔B contradiction / violated
  invariant, a false Assumption / unhandled edge case, or under-stated blast-radius vs the
  codegraph import graph. *(FR-3)*
- [ ] **Two decorrelated lenses by default at T3** — "find the bug" + "defend the spec"
  run by default; single-lens only at lower opt-in tiers. *(FR-4)*
- [ ] **Advisory only — never blocks, never auto-writes** — flagged items float to B2
  "please read" with a provenance stamp (lenses + hash), add zero friction clicks, are not
  logged/shamed, never block final-approve, and never write content into the artifact;
  a suggested edit is confirm-before-write. *(FR-5, INV-advisory)*
- [ ] **Round-table is opt-in and off by default** — N-lens debate never runs unprompted;
  advisory, never blocks. *(FR-6)*
- [ ] **Cost shown + accepted + resumable** — each round-table shows its metered cost and
  is accepted before running; spend is `--max-budget-usd`-capped; a quota-exhausted run
  emits a clearly-marked partial **and** a `{specHash,…}` checkpoint that resumes only the
  remaining lenses, and is **discarded on any specHash mismatch** (no stale partial onto
  edited content). *(FR-7)*
- [ ] **Degradation is provable with AI absent** — with `claude` not installed (or forced
  to time out / emit non-JSON / empty / non-zero), the reviewer returns a typed
  `{ ok:false, reason }`, **never throws**, the SPEC-013 Tier-0 floor stands as the full
  experience, and the swallowed reason is logged + UI-inspectable — **all verified by a T0
  test that spawns no model** (the never-throw-contract test). *(FR-8, INV-Tier-1)*
- [ ] **Injection is bounded structurally, not just textually** — the reviewer is spawned
  tools-off, single-turn, schema-bound, default-permission, `--bare`, credential-free,
  with content via stdin as delimited DATA; a successful injection has no tool/credential/
  turn/out-of-schema channel, so its worst case is one bad advisory — never an action,
  approval, exfiltration, or write. *(FR-9, INV-untrusted-input)*
- [ ] **Zod verdict contract holds** — the verdict is Zod-validated, free text outside the
  schema is dropped, and the verdict is never executed. *(FR-10)*
- [ ] **No skim claim ships here** — the appendix label stays `Self-Audit · read what you
  want` even when the agent ran; an agent-ran provenance stamp is allowed, a skim licence
  is not. *(FR-11)*

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|---|---|---|
| R1 | **Same-model collusion** — author + reviewer share priors; a shared hallucination gets "clear". | Med · High | Two-lens disagreement-as-signal (FR-4); evidence-ref-or-dropped; no skim claim until the study (FR-11). Residual named. |
| R2 | **Prompt injection** via untrusted spec → false "no concerns". | Med · Med | DATA-framing + injection-aware prompt + advisory-only + credential-free (FR-9, DR-030); two-lens decorrelation. Residual: degraded verdict (quality, not integrity). |
| R3 | **Plausible-but-wrong fabricated risk** (Stella-Lorenzo) rubber-stamped in. | Med · Med | Verdict advisory; author/DR-012 review; structural normalise (FR-10) can't judge truth — residual, bounded by no-claim. |
| R4 | **Degradation gap** — agent throws/blocks instead of falling back; or fails *silently* (bare null, no why) and can't be debugged. | Low · High | FR-8 `catch → log reason → typed fallback` ({ok:false,reason}) + Tier-0 floor as unconditional fallback; never-throw-contract T0 test (every failure path → typed fallback, never throws, reason logged); floor stands with claude absent. |
| R5 | **Cost surprise** — round-table burns quota. | Med · Med | FR-7 metered + opt-in + `--max-budget-usd` cap + bounded concurrency; partial verdicts marked partial; hash-bound checkpoint resumes remaining lenses so exhaust doesn't waste completed ones (stale partial discarded on hash mismatch). |

## Out of scope

- **The deterministic floor** — SPEC-013 (Slice 1); this spec consumes its report.
- **The trust-claim activation + telemetry** — DR-029 §6; #127 (activate), #128 (telemetry).
- **LLM authoring section *content* into the doc** — content is the spec-author flow (DR-029), not a fill-service here; the agent reviews, it does not author.
- **The DR-022 reach axis** — gated #91.

## Open questions

- **OQ-1 — verdict schema fields.** Exact Zod shape (per-FR findings? severity? evidence-ref required?). Resolve at plan; FR-10 fixes the contract before impl (CDD).
- **OQ-2 — round-table lens set + count.** Which lenses, and the N cap per tier. Lean: 3 (correctness / security / repro) at T3, configurable; bounded by FR-7.
- **OQ-3 — checkpoint persistence (FR-7 resume).** Where the partial-verdict checkpoint
  lives (workspace `.minspec/` cache vs ephemeral), its TTL, and cleanup. Since it is a
  cache discarded on any `specHash` mismatch, a missing/corrupt checkpoint must degrade to
  "restart", never error. Resolve at plan; it is not state of record.
