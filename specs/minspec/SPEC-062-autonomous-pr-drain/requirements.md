---
id: SPEC-062
type: requirements
status: specifying   # DERIVED, not a regression. `deriveStatus` (lifecycle.ts:140) returns
  # 'specifying' whenever approvalState !== 'approved' — INV-1, and that guard fires BEFORE
  # the phases are consulted. The 2026-09-05 approval was staled by the #1811 review fixes,
  # so 'planning' here would be DRIFT (`facts status SPEC-062` confirms: MATCH on
  # 'specifying'). Reading `plan: in-progress` below and concluding 'planning' applies
  # `getSpecStatus` (lifecycle.ts:172), the phases-ONLY twin that DR-069 §3 says must NOT be
  # aligned to deriveStatus. Re-approval flips this back to 'planning' automatically.
tier: T4
product: minspec
epic: EPIC-007  # Agent Execute — the dev-time autonomous build/merge pipeline (this is its scheduling + PR-completeness layer)
aspects: [autonomous-pipeline, drain, pull-request, auto-merge, scheduling, github-actions, signpost, hitl, sidecar-hash, git-recovery, tier-0, offline, no-silent-gate, blast-radius]
depends_on: []  # see "Blocking dependencies" — #810/#811 (ready-to-merge gate) and #880 (docs-lane approvals) gate the fully-autonomous outcome, not this spec's authorship
relates_to: [SPEC-044, SPEC-024, SPEC-050, SPEC-012, DR-057, DR-061, DR-067, DR-076, DR-015, DR-004]
implements: [.github/workflows/drain.yml]  # NEW - the session-independent trigger (FR-1). D1 RESOLVED 2026-08-23 as Option A (the Action runs only the non-LLM steps), so this path is settled. All four Clarify decisions are now resolved (D2/D3/D4 on 2026-09-05) — D3's routing rule is decided, its mechanism deferred to #1608; none of them changed the owned set.
affects: [scripts/drain-inbox.sh, scripts/dispatch-issue.sh, scripts/remediate-pr.sh, scripts/auto-merge-gate.ts]  # drain-inbox/dispatch-issue/remediate-pr are OWNED by SPEC-044 via implements: - this spec modifies them, never owns them (INV: one owner per file). auto-merge-gate.ts is currently unowned; SPEC-024 owns the decideAutoMerge decision this spec only invokes.
phases:
  specify: done
  clarify: done
  plan: in-progress
  tasks: pending
  implement: pending
---

# MinSpec — Autonomous PR review/rework/merge drain (Requirements)

> **This is a SPECIFICATION ONLY.** No code, workflow, or script is created by the
> dispatch that produced it. A human reads this spec, resolves the
> **[Decisions needed (Clarify)](#decisions-needed-clarify)** section, and approves it
> through the normal spec-approval gate before anything is built. The Clarify section is
> the point of the read — it carries the choices this design deliberately does **not**
> make on the founder's behalf.

Materializes **[#888](https://github.com/AIClarityAU/minspec/issues/888)** — *"Automate the
PR review/rework/merge loop — extend the drain to PRs, schedule via GH Actions / fan-out (no
host timer)."* Serves constitution goal **G-8 (git transparency)**: the review/rework/merge
loop should run itself so approvals and code/docs PRs land without a dedicated live Claude
session babysitting them.

## One-Sentence Scope

Make the existing PR-side drain **runnable without a live Claude session** — triggered by a
GitHub Action (`on: schedule` + `pull_request`/`push`) and/or piggybacked on existing
fan-outs rather than a per-machine host timer — and **complete** on the PR side: it
auto-merges genuinely-eligible CODE/DOCS PRs (through the #810/#811 gate, never `--admin`),
**verifies approval sidecar hashes before merging** approval PRs, lands stranded approvals
(#880), recovers broken git states, and routes every **held** item (machinery, DR/spec
acceptance, anything irreversible) into the existing **[SPEC-012](../SPEC-012-next-task-resolver/requirements.md)
next-task signpost** rather than auto-deciding it or inventing a parallel surface.

## Context (grounded, with `file:line` evidence)

This spec sits on top of machinery that **already exists**. Per RCDD evidence discipline,
the following are verified against the code, not assumed:

- **The drain already sweeps open PRs and auto-remediates them.** `drain-inbox.sh` runs one
  cycle of *triage inbox → dispatch every agent-ready issue → sweep open PRs and
  auto-remediate fixable problems* ([`scripts/drain-inbox.sh:9-12`](../../../scripts/drain-inbox.sh#L9),
  sweep loop at [`:622-633`](../../../scripts/drain-inbox.sh#L622)). It delegates each PR to
  `remediate-pr.sh` ([`:90`](../../../scripts/drain-inbox.sh#L90)).
- **PR remediation classes are already handled.** `remediate-pr.sh` fixes `ai-review:changes`
  (feed findings to a credential-free dev agent, re-push), failing non-review CI (reproduce,
  RCDD, fix, re-push), and *behind base* (mechanical `git merge origin/main`, re-push); merge
  **conflicts are surfaced, never auto-resolved** and self-label `needs-human-review`
  ([`scripts/remediate-pr.sh:19-35`](../../../scripts/remediate-pr.sh#L19)). The agent is
  credential-free; the parent does every credentialed op; a pre-push egress guard fails closed
  ([`:37-48`](../../../scripts/remediate-pr.sh#L37)).
- **The drain only adopts ORPHAN PRs.** Per [DR-067](../../../docs/decisions/DR-067.md) /
  [SPEC-044](../SPEC-044-coordinated-self-completing-sessions/requirements.md), the session
  that opened a PR shepherds it; the drain reclaims only PRs with no live lease-claim
  ([`scripts/remediate-pr.sh:50-54`](../../../scripts/remediate-pr.sh#L50)). **SPEC-044 owns
  the "who drives each PR" half of #888; this spec owns the scheduling + PR-completeness +
  signpost half.**
- **The merge gate that removes the `--admin` smell already exists.**
  `.github/workflows/ready-to-merge.yml` posts a required-able `ready-to-merge` commit status
  that is green only for a *verified, non-stale* `ai-review:pass`, and is the **single writer**
  of that status ([`.github/workflows/ready-to-merge.yml:1-16`](../../../.github/workflows/ready-to-merge.yml#L1)).
  This is the #810/#811 native gate the issue depends on.
- **Auto-merge of approval/docs PRs already runs on a label.** `docs-lane.yml` enables native
  GitHub auto-merge for docs-only PRs carrying the `docs-lane` label
  ([DR-061](../../../docs/decisions/DR-061.md)); [SPEC-050](../SPEC-050-silent-approval-pr/requirements.md)
  opens those PRs. The eligibility decision for CODE PRs is [SPEC-024](../SPEC-024-auto-merge-eligibility/requirements.md)'s
  `decideAutoMerge`.
- **The drain today needs a live session.** It is fired from the `session-start.sh` hook and
  its continuous loop is *tied to the launching Claude session process* and self-terminates
  when the session ends ([`scripts/drain-inbox.sh:16-23`](../../../scripts/drain-inbox.sh#L16)).
  **There is no `on: schedule` GitHub Action that fires the drain** — `.github/workflows/`
  contains `ai-review`, `ready-to-merge`, `docs-lane`, `ci`, `deploy-sites`,
  `minspec-validate`, `supply-chain-daily`, and label workflows, but none that runs the
  triage/dispatch/PR-sweep cycle. This is the headline gap #888 names.
- **The drain never runs an LLM in the Tier-0 extension.** [DR-057](../../../docs/decisions/DR-057.md)
  fixes that the background loop phase-advances by *enqueue*, never by running an LLM inside
  the air-gapped extension. This spec preserves that boundary and it shapes
  [Decision D1](#d1--what-runs-the-loop-when-no-session-is-alive) below.

**Core gap (one sentence):** the PR-side drain is built and correct, but it only runs while a
human's Claude session is alive, it does not itself close the loop by merging eligible PRs, it
does not verify approval sidecar hashes at the merge boundary, and its held items have no
defined path into the human's one next-task signpost.

## Scope

### In scope
- **FR-1** a session-independent **trigger** for the drain cycle (GitHub Action and/or
  piggyback), replacing the host-timer idea the founder rejected.
- **FR-2** a **PR-completeness** step: auto-merge genuinely-eligible CODE/DOCS PRs.
- **FR-3** **sidecar-hash verification** as an independent witness before merging an approval PR.
- **FR-4** **stranded-approval landing** and **git-state recovery** as first-class drain steps.
- **FR-5** the **held-item → signpost** hand-off (SPEC-012), and the labelled hold queue.
- **FR-6** the **machinery/governance hold** rule (never auto-merge machinery or acceptance).

### Out of scope (owned elsewhere or explicitly deferred)
- **Who drives each PR** (lease/claim/shepherd/orphan-fallback) — [SPEC-044](../SPEC-044-coordinated-self-completing-sessions/requirements.md) / [DR-067](../../../docs/decisions/DR-067.md).
- **The CODE auto-merge eligibility decision** itself — [SPEC-024](../SPEC-024-auto-merge-eligibility/requirements.md) (`decideAutoMerge`); this spec *invokes* it, it does not re-derive it.
- **Opening the approval PR** — [SPEC-050](../SPEC-050-silent-approval-pr/requirements.md).
- **The next-task resolver internals** — [SPEC-012](../SPEC-012-next-task-resolver/requirements.md); this spec adds a pending-item *source*, it does not re-implement the resolver.
- **Productizing any of this inside MinSpec-the-extension** — this is **dev-time infra for the
  monorepo only** (EPIC-007's prototype). Nothing here ships into a user's repo (INV-4).
- **Merge conflict auto-resolution** — surfaced to a human, never auto-resolved (existing
  `remediate-pr.sh` behaviour, preserved).

### Blocking dependencies (gate the *outcome*, not this spec's authorship)
- **#810/#811** — native `ready-to-merge` gate (**verified present**, `ready-to-merge.yml`)
  so CODE/DOCS PRs merge **without** `--admin`. An unattended runner holding an admin token to
  force-merge is a security smell; the gate removes the need for one.
- **#880** — route Alt+A approvals through the docs-lane so they auto-reach `origin` instead
  of stranding on local `main` (FR-4 landing depends on this being the normal path).

## Functional Requirements

- **FR-1 (session-independent trigger).** The drain cycle MUST be runnable with **no live
  Claude session**. The delivery mechanism is **[D1](#d1--what-runs-the-loop-when-no-session-is-alive),
  resolved 2026-08-23 as Option A**: a GitHub Action runs the non-LLM steps (auto-merge eligible
  PRs, mechanical rebase, stranded-approval landing, git recovery, held → signpost), and LLM
  rework remains session-piggybacked. The trigger MUST be a GitHub Action (`on: schedule` and/or
  `pull_request`/`push`) or a piggyback on an existing fan-out — **never** a `systemctl --user`
  / host cron timer (founder steer, 2026-07-24: a timer needs a per-machine human install and
  changes machine state; a workflow ships with the repo and installs itself). *Rationale: the
  loop should not depend on a founder having a terminal open.*
- **FR-2 (auto-merge eligible CODE/DOCS PRs — through the gate, never `--admin`).** For an
  orphan PR that is a genuine merge candidate, the drain MUST merge it **only** when the
  independent `ready-to-merge` status is `success` (a *verified, non-stale* `ai-review:pass`,
  no `ai-review:changes`) **and** no `needs-human-review` label is present **and**, for CODE,
  `decideAutoMerge` (SPEC-024) returns `eligible`. The merge MUST use native auto-merge / a
  normal merge that the branch-protection gate admits — **never** `gh pr merge --admin` and
  **never** a token that can bypass a required check. *Rationale: #888's own security note —
  an unattended admin force-merge is the smell #810/#811 exists to remove.*
- **FR-3 (sidecar-hash verification before merging an approval PR — independent witness).**
  Before merging any PR that changes `.minspec/approvals/**` (an approval PR), the drain MUST
  verify that the approval sidecar's recorded `specHash` matches the current bytes of the
  artifact it approves, as an **independent** check computed at the merge boundary — not by
  trusting a label or the PR body. A mismatch (stale approval) ⇒ **HOLD**, self-label
  `needs-human-review`, route to FR-5. *Rationale: constitution invariant #2 (no single
  producer; a load-bearing gate needs a second witness) and the "verify hash before believing"
  discipline — a sidecar PR can draw a false "stale approval" verdict, and equally a truly
  stale approval must never ride a green label to `main`. The verification MUST fail **closed
  and visibly**, never `|| true`.*
- **FR-4 (stranded-approval landing + git-state recovery).**
  - **FR-4a (land stranded approvals).** An approval commit pushed to a side branch because the
    primary branch is protected (the #880 / SPEC-050 case) but with no open PR MUST be carried
    to `origin` by opening/adopting its docs-lane PR — idempotently, never fanning out
    duplicates. It MUST NEVER move the primary checkout (no `checkout`/`switch`/`merge`/`rebase`/`reset`
    on the working tree; worktree rule / [DR-046](../../../docs/decisions/DR-046.md)).
  - **FR-4b (recover broken git states).** A recoverable broken state on a PR branch (behind
    base; benign detached/interrupted rebase state left by a crashed agent) MUST be recovered
    mechanically where the recovery is deterministic and non-destructive, and **surfaced, never
    guessed** where it is not (a conflict is FR-6/existing behaviour). Every recovery action is
    logged; a swallowed failure is forbidden (invariant #2).
- **FR-5 (held items feed the SPEC-012 signpost — no parallel surface).** Every item the drain
  cannot auto-decide — a machinery-gate merge (FR-6), a DR/spec **acceptance**, an invariant
  change, a merge conflict, a stale-approval HOLD (FR-3), anything irreversible — MUST become a
  labelled entry in a **hold queue**, routed by who can discharge it. A **human-dischargeable**
  hold — which is every item enumerated above — goes to the
  **[SPEC-012](../SPEC-012-next-task-resolver/requirements.md)** next-task resolver, so the
  signpost picks the single next human action. A hold waiting on an **agent** goes to the
  agent-queue surface instead; none exists in the list above today, but the routing rule is
  stated so a future non-dischargeable hold cannot silently land on the human signpost. The
  drain MUST NOT auto-decide these and MUST NOT invent a second surfacing mechanism (founder
  steer). The
  precise queue representation the resolver consumes is
  **[D3](#d3--how-held-items-reach-the-spec-012-resolver), resolved 2026-09-05**: held items
  split by who can discharge them — human-held to the SPEC-012 signpost, agent-held to the
  agent-queue surface ([DR-085](../../../docs/decisions/DR-085.md) §1 membership test, §4 which establishes the surface) — with the queue
  representation itself deferred to #1608 — verified 2026-09-05 as OPEN and titled *"feat(signpost):
  split the signpost into human queue + agent queue (implements DR-085)"*, so the deferral has a
  tracked owner. "No second surfacing
  mechanism" is unchanged: the two surfaces are DR-085's mandated split, not a parallel signpost.
- **FR-6 (machinery / governance hold).** The drain MUST **hold** (never auto-merge) any PR
  that touches machinery (`.github/`, `scripts/`, hooks, CI, branch-protection config) or that
  is a governance act (DR/spec/epic acceptance, constitution/invariant change). Held ⇒ FR-5.
  *Rationale: a machinery PR cannot earn a trustworthy `ai-review:pass` (the reviewer reviews
  the very automation that would merge it — [machinery-PR `--admin` finding]); acceptance is an
  irreducibly human act ([DR-076](../../../docs/decisions/DR-076.md) keeps HITL for irreversible
  acts).* The exact machinery path set is the SPEC-024 CI/build-boundary matcher; this spec
  reuses it, it does not fork a second list.

## Invariants (must hold)

- **INV-1 (no silent gate — constitution #2).** Every gate this spec adds — the FR-3 sidecar
  check, the FR-2 eligibility conjunction, the FR-6 machinery matcher — fails **closed and
  visibly**. No load-bearing signal is written with a swallowed error (`|| true`); a missing or
  errored witness HOLDS and says why; no required check hinges on a single producer (the
  sidecar-hash witness at merge is independent of the label the reviewer wrote).
- **INV-2 (never bypass a required check).** The unattended merger MUST NOT use `--admin` and
  MUST NOT hold a token that can bypass `ready-to-merge` or any required status. If a merge
  cannot pass the gate, it HOLDS (FR-5). *This is the #888 security requirement made an
  invariant.*
- **INV-3 (never moves the primary checkout).** No `checkout`/`switch`/`merge`/`rebase`/`reset`
  on the developer's working tree; all fixes happen on PR branches / temp worktrees
  ([DR-046](../../../docs/decisions/DR-046.md), rule #8).
- **INV-4 (blast radius — constitution #3; dev-time only).** This is dev-time infra for
  `AIClarityAU/minspec`. Nothing here changes behaviour in a repo/org/machine that did not opt
  in, and **none of it ships inside the MinSpec extension** (Tier-0 / air-gapped; the productized
  path is the separate `agent-execute` extension, [DR-015](../../../docs/decisions/DR-015.md) /
  EPIC-007). The GitHub Action lives in *this* repo's `.github/` and acts only on *this* repo.
- **INV-5 (no LLM inside the Tier-0 extension — DR-057).** The scheduled loop never runs an LLM
  in the extension. LLM rework is dispatched to credential-free agents by the *dev-time script
  layer*; the extension only enqueues. (This shapes D1 — a vanilla GitHub Action cannot run the
  subscription `claude` CLI.)
- **INV-6 (never mints or edits an approval record).** The drain transports and *verifies*
  approval records that **MinSpec: Approve Spec** wrote; it never writes `status`, a sidecar, or
  `approvedBy` ([DR-012](../../../docs/decisions/DR-012.md); the forged-sign-off class). FR-3 is
  read-and-compare only.
- **INV-7 (orphan-only — SPEC-044 / DR-067).** The drain acts only on PRs with no live
  lease-claim; a PR held by a live session is left to that session. This spec does not weaken
  that boundary.

## Decisions needed (Clarify)

These are the choices this spec deliberately does **not** make for the founder. Each states the
options and the trade-off; the human's one read resolves them. Resolving them may promote one or
more into a Decision Record (see [DR note](#dr-note)).

> **Clarify status: all four resolved** — D1 on 2026-08-23, D2/D3/D4 on 2026-09-05. Each keeps
> its options below as the record of what was chosen between, per [DR-086](../../../docs/decisions/DR-086.md)
> §4 (the rejected alternatives are the only review path once they are no longer seen live).
>
> **One residual:** D3's *mechanism* is deferred to #1608, so the Clarify pass is decided but
> not fully discharged. That is a deliberate deferral, not an open question — the routing rule
> is settled; only its representation waits on the surface split.

### D1 — What runs the loop when no session is alive?

> **RESOLVED 2026-08-23 — Option A** (founder). The GitHub Action runs only the **non-LLM**
> steps; LLM rework stays session-piggybacked. The options below are kept as the record of what
> was chosen between, not as an open question.
>
> **Cost accepted with the choice:** rework still needs a live session, so a PR stuck on
> `ai-review:changes` waits on a quiet day. R3 already carries the mitigation — the split is
> explicit and the deferred work is `log()`ged, never silently truncated.
>
> Consequence for ownership: `implements: [.github/workflows/drain.yml]` is now settled. Under
> Option B the owned artifact would have been a runner config, under Option C there would have
> been no new file at all.

The drain's rework step dispatches **LLM agents** (subscription `claude` CLI on a logged-in
machine). A vanilla GitHub Action **cannot** run that CLI, and running LLM rework in CI needs a
PAYG API key as a repo secret — which contradicts the subscription-default billing posture and
adds an exfil surface. So the trigger and the *worker* may not be the same thing.

- **Option A — split the loop by whether the action needs an LLM.** A GitHub Action
  (`on: schedule` + `pull_request`/`push`) runs only the **non-LLM** actions itself
  (auto-merge eligible PRs, mechanical rebase, stranded-approval landing, git recovery, held →
  signpost). LLM **rework** (`ai-review:changes`, failing-CI fixes) stays session-piggybacked
  as today, but is now the *only* thing that needs a session. *Trade-off:* fully autonomous for
  the ~80% #888 targets (merge/land/recover/route); the LLM-rework ~20% still waits for a
  session — but that is already gated on quota and a logged-in CLI, so nothing regresses.
- **Option B — self-hosted runner with the logged-in CLI.** A self-hosted GitHub Actions runner
  on a founder machine *can* run `claude`. *Trade-off:* full autonomy including rework, but it
  reintroduces a per-machine install (the very thing the founder rejected for host timers) and
  puts a credentialed CLI behind a webhook — a larger security surface.
- **Option C — piggyback only, no scheduled Action.** Keep the session-start trigger and add a
  piggyback on existing fan-outs; accept that the loop only advances when *some* session runs.
  *Trade-off:* smallest change, no new CI credential, but does not meet #888's "runs itself
  without a dedicated session" goal on a quiet day.

**Recommendation at authoring time — accepted, see the RESOLVED block above:** Option A — it delivers the autonomy #888 actually asks for (merge/land the
~80%) while keeping the LLM worker on the existing, quota-aware, credential-safe path and adding
no PAYG secret to CI. Downside named: rework still needs a session, so a PR stuck on
`ai-review:changes` on a quiet day waits.

### D2 — Which identity/token merges, and how is INV-2 guaranteed?

> **RESOLVED 2026-09-05 — default `GITHUB_TOKEN`** (founder). Implementation MUST pair it with a
> test asserting it cannot merge past a required check; that test does not exist yet (this spec
> is `implement: pending`). The point of choosing `GITHUB_TOKEN` is that INV-2 then rests on a
> token that *structurally* cannot bypass the gate, rather than on the test alone.
>
> **Rejected:** a fine-grained PAT and a GitHub App installation token. Both buy a distinct
> merger identity in the audit trail, and both are stored secrets that can be over-scoped. The
> deciding factor is R1 — *"a scheduled unattended merger becomes a way to bypass review"*:
> `GITHUB_TOKEN` cannot approve its own required checks, so it is the option that cannot bypass
> the gate even if misconfigured. Least-privilege and self-installing beat a nicer audit line.
>
> **Cost accepted:** no distinct merger identity — every drain merge reads as GitHub itself.
> Mitigated by the merge-reason comment named below.

The scheduled Action needs a token that can merge. Options: the default `GITHUB_TOKEN`
(cannot approve its own required checks; merges only if protection admits — good), a fine-grained
PAT, or a GitHub App installation token. *Trade-off:* `GITHUB_TOKEN` is the least-privilege,
self-installing choice and structurally cannot bypass `ready-to-merge`; a PAT/App can act as a
distinct identity (useful for audit) but is a stored secret and could be over-scoped.
**Recommendation:** default `GITHUB_TOKEN`, with a test asserting it cannot merge past a
required check. Downside: no distinct merger identity in the audit trail — mitigate with a
merge-reason comment.

### D3 — How do held items reach the SPEC-012 resolver?

> **RESOLVED 2026-09-05 — the question splits first; the mechanism is deferred** (founder).
>
> [DR-085](../../../docs/decisions/DR-085.md) landed after this section was written and changes
> its premise. The signpost now carries **only acts the human can discharge**. So "held items
> feed the signpost" is no longer one routing rule but two:
>
> - a PR held for a **human decision** is dischargeable → it belongs on the SPEC-012 signpost;
> - a PR held **waiting on an agent** is not → it belongs on the agent-queue surface (DR-085 §1).
>
> FR-5's "no parallel surface" requirement still holds — the two surfaces are the split DR-085
> mandates, not a second signpost.
>
> **Mechanism (label vs hold-queue file vs extending SPEC-012's pending-item model) is deferred
> to #1608**, which owns the surface split. Picking one now would route both kinds to one
> surface and re-create exactly what DR-085 §1 removed.
>
> **Rejected:** choosing the label mechanism immediately. It is the cheapest and is visible on
> GitHub, but it answers the pre-DR-085 question. **Cost accepted:** D3 is blocked behind #1608,
> so this spec cannot fully close its Clarify pass until that lands.

FR-5 requires held items to feed the existing signpost, not a parallel surface. Options:
(a) a GitHub label (`needs-human-review` / a new `held:*`) the resolver already or newly reads;
(b) a hold-queue file the resolver ingests; (c) extend SPEC-012's pending-item model with a
"held-PR" source. *Trade-off:* a label is zero new storage and visible on GitHub but the
resolver must learn to read PR labels (it reads approval/status gates today); a file is explicit
but is new state to keep in sync. **This is genuinely a SPEC-012 question** — whether the new
source lands here or in SPEC-012 is itself part of the decision.

### D4 — Cadence / cost of the scheduled cycle.

> **RESOLVED 2026-09-05 — both** (founder). Event-driven (`pull_request`/`push`) for promptness,
> plus a slow cron as the liveness floor, on a non-round minute to avoid the fleet-wide `:00`
> spike. Cron interval matches the existing `MINSPEC_DRAIN_INTERVAL=1200` default.
>
> **Rejected:** event-driven only — near-zero idle cost, but misses time-based staleness, which
> is the case the loop exists for (a PR that goes stale while nothing pushes). Cron only —
> a liveness floor with no responsiveness.
>
> **Cost accepted:** Actions minutes burn on a quiet repo even when there is nothing to do. R6
> carries it; the non-round minute and the 20-minute floor are the mitigation.

`on: schedule` cadence trades responsiveness against Actions minutes and API rate limits.
Options: event-driven only (`pull_request`/`push`, near-zero idle cost, misses time-based
staleness), a slow cron (e.g. every ~20 min, matching the existing
`MINSPEC_DRAIN_INTERVAL=1200` default), or both. **Recommendation:** both — event-driven for
promptness plus a slow cron as the liveness floor; pick a non-round minute to avoid the
fleet-wide `:00` spike.

## Acceptance Criteria

- **AC-1 (FR-1, INV-4).** A drain cycle completes with **no** Claude session running, triggered
  by a workflow event, and acts only on `AIClarityAU/minspec`. No `systemctl`/host-cron artifact
  is introduced.
- **AC-2 (FR-2, INV-2).** An eligible orphan CODE PR (green `ready-to-merge`, no
  `needs-human-review`, `decideAutoMerge` eligible) merges via the gate; the merge path invokes
  **no** `--admin` and no bypass token — asserted on the recorded merge argv, not by inspection.
  A PR missing any one conjunct does **not** merge.
- **AC-3 (FR-3, INV-1, INV-6).** For an approval PR whose sidecar `specHash` does **not** match
  the artifact bytes, the drain HOLDS and labels `needs-human-review`; for a matching one it
  proceeds. The check is computed independently at the merge boundary (not read from a label or
  PR body), writes no approval state, and a thrown/errored verification HOLDS (never `|| true`,
  never silently passes) — asserted with an injected error.
- **AC-4 (FR-4a, INV-3, INV-6).** A pushed-but-PR-less approval branch gets its docs-lane PR
  opened/adopted idempotently (no duplicate on re-run); no `checkout`/`switch`/`merge`/`rebase`/`reset`
  touches the primary working tree — asserted on recorded git argv.
- **AC-5 (FR-4b).** A behind-base PR is rebased/merged-forward mechanically and re-pushed; a
  conflict is **not** touched and self-labels `needs-human-review`; every recovery action is
  logged and no recovery failure is swallowed.
- **AC-6 (FR-5, FR-6).** A machinery PR (`.github/`/`scripts/`/hooks/CI) and a DR/spec
  acceptance are **held**, never auto-merged, and each appears as exactly one entry the SPEC-012
  resolver surfaces; no second surfacing mechanism is created. Asserted structurally: a held
  outcome can never produce a merge.
- **AC-7 (INV-5, DR-057).** No LLM is invoked inside the extension on any drain path; LLM rework
  is dispatched by the dev-time script layer to a credential-free agent — asserted on the call
  path, matching the existing egress/credential model of `remediate-pr.sh`.
- **AC-8 (INV-7).** A PR held by a live lease-claim is left untouched by the scheduled drain
  (orphan-only), reusing SPEC-044's `issue-lease.sh reclaim?` seam, failing closed.

## Risks

| # | Risk | Mitigation |
|---|------|-----------|
| R1 | A scheduled unattended merger becomes a way to bypass review | INV-2 (no `--admin`, no bypass token) + FR-2 conjunction + AC-2; the `ready-to-merge` gate (#810/#811) is the single writer and cannot be forged (`ready-to-merge.yml` provenance guards) |
| R2 | A truly stale approval rides a green label to `main` | FR-3 independent sidecar-hash witness at the merge boundary, fail-closed (INV-1) |
| R3 | LLM rework can't run in CI → the loop only *looks* autonomous | D1 Option A makes the split explicit and `log()`s what it deferred; no silent truncation |
| R4 | The GH Action drifts into acting on non-opted-in repos / ships in the extension | INV-4 (dev-time only, this repo's `.github/`, never in the Tier-0 extension) |
| R5 | Held items pile up invisibly | FR-5 routes every hold into the SPEC-012 signpost — one next human task, not a silent queue |
| R6 | Cadence burns Actions minutes / hits rate limits | D4 — event-driven + slow cron, non-round minute |

## DR note

This spec does **not** mint a Decision Record, and **D1's resolution does not change that** —
but the reasoning has moved, so it is restated here rather than left as written.

**Superseded reasoning.** This note previously said no DR was due because the trigger model
(D1) was *"still open"*. That is no longer true: D1 was resolved 2026-08-23 as **Option A**.
Openness was never the operative test anyway — reversibility is.

**The filter, applied to the option actually chosen.** Option A's owned artifact is a single
GitHub Actions workflow that runs only non-LLM steps. It is reversible in well under a day
(delete the workflow, or flip the trigger back to session-piggyback), adds no stored credential
and no PAYG secret to CI, and changes no machine state. The DR-359 ADR filter therefore does
not fire.

**The conditional stays live, narrowed to what would actually trip it.** A later flip to
**Option B** — a self-hosted runner with a credentialed CLI behind a webhook — is
security-relevant and not trivially reversible, and MUST mint a DR at that point. Option C
(piggyback only) would not. So the obligation is now specific to one named future change rather
than conditional on a choice that has already been made.

*Recorded because the panel flagged it (#1658 review, three voters, blocking): two reviewers
read the old wording's "if the founder picks a trigger model … a DR SHOULD be minted then" as
firing on **any** pick, including A. It is written here as firing on the reversibility test,
which A passes and B fails. If the founder wants the choice recorded as a DR regardless, that
is a one-line call and this paragraph is the place it would be noted.*

Checked `docs/decisions/INDEX.md`: the nearest in-force decisions are
[DR-057](../../../docs/decisions/DR-057.md) (drain enqueues, never runs an LLM in Tier-0),
[DR-061](../../../docs/decisions/DR-061.md) (native auto-merge), and
[DR-067](../../../docs/decisions/DR-067.md) (self-completing sessions / orphan-fallback) — this
spec composes with all three and supersedes none, so no existing DR is updated.
[DR-086](../../../docs/decisions/DR-086.md) (`proposed`) is adjacent — it governs *whether an
agent acts on its own recommendation*, not *what triggers the drain* — so it constrains this
spec's autonomy posture without deciding D1.

## Traceability

- **Issue:** [#888](https://github.com/AIClarityAU/minspec/issues/888) — automate the
  PR review/rework/merge loop; schedule via GH Actions / fan-out, no host timer.
- **Sibling / complementary half:** [SPEC-044](../SPEC-044-coordinated-self-completing-sessions/requirements.md)
  ([DR-067](../../../docs/decisions/DR-067.md)) — who *drives* each PR (lease/shepherd/orphan);
  this spec is the *scheduling + PR-completeness + signpost* half. SPEC-044 already names #888 as
  "creator-owned shepherding is its who-drives-each-PR half."
- **Consumes:** [SPEC-024](../SPEC-024-auto-merge-eligibility/requirements.md) (`decideAutoMerge`),
  [SPEC-050](../SPEC-050-silent-approval-pr/requirements.md) (approval PR opening / docs-lane),
  [SPEC-012](../SPEC-012-next-task-resolver/requirements.md) (next-task signpost).
- **Gate / lane:** `.github/workflows/ready-to-merge.yml` (#810/#811),
  `.github/workflows/docs-lane.yml` ([DR-061](../../../docs/decisions/DR-061.md)).
- **Blocking deps for the fully-autonomous outcome:** #810/#811 (verified present), #880
  (docs-lane approvals).
- **Governing decisions:** [DR-057](../../../docs/decisions/DR-057.md) (no LLM in Tier-0 drain),
  [DR-076](../../../docs/decisions/DR-076.md) (solo mode — keep HITL only for irreversible acts),
  [DR-015](../../../docs/decisions/DR-015.md) / EPIC-007 (dev-time prototype, productized path is
  `agent-execute`), [DR-046](../../../docs/decisions/DR-046.md) (worktree rule #8),
  [DR-012](../../../docs/decisions/DR-012.md) (approval hash gate).
