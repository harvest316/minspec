---
id: SPEC-044
type: requirements
# 🔒 Once approved, hash-locked: approved bytes recorded in .minspec/approvals.json[SPEC-044].specHash. ANY edit voids approval (hash → stale) — re-run "MinSpec: Approve Spec". DR-012.
status: implementing
tier: T4
product: minspec
epic: EPIC-009  # Team Readiness — concurrent multi-session coordination (the presence lease's third consumer: work-item claims)
aspects: [session-coordination, lease, claim, orphan-fallback, pr-shepherd, wrapup, optimistic-concurrency, tier-0, offline, determinism, never-wrong, exactly-one-owner]
depends_on: [SPEC-026]  # SPEC-026's presence heartbeat IS the lease primitive this spec adds a third consumer to
relates_to: [DR-067, DR-065, DR-060, DR-061, DR-046, DR-004, DR-003]  # DR-067 materializes here; DR-065 = the sync-gate lease consumer; DR-060/061 = the autonomous pipeline this restructures; DR-046 = rule #8 worktree isolation; DR-004 = tier model; DR-003 = RCDD. Issue refs (#912/#900/#888) are in Context + Traceability.
implements: [scripts/lib/issue-lease.sh, scripts/dispatch-issue.sh, scripts/remediate-pr.sh, scripts/drain-inbox.sh]
# ownership (SPEC-038): issue-lease.sh is net-new & owned. dispatch/remediate/drain are the DR-060/061 pipeline surface SPEC-044 restructures — declared implements: to take *primary* ownership (SPEC-043 pattern: existing-but-owned code lives in implements:, not affects:); no other spec declares them, so ownership stays unambiguous. A future coordination spec that co-edits them uses affects:, not implements:.
affects: [packages/minspec/src/lib/presence.ts]  # SPEC-026 owns presence.ts; SPEC-044 only doc-touches + optionally adds a pure predicate export — modifies-not-owns.
phases:
  specify: done
  clarify: done
  plan: done
  tasks: in-progress
  implement: pending
---

# MinSpec — Coordinated self-completing sessions (Requirements)

> Materializes **[DR-067](../../../docs/decisions/DR-067.md)**. Traces to the **[#912](https://github.com/AIClarityAU/minspec/issues/912)** drain-remediator crash-thrash outage and the four founder requests of 2026-07-25 (claim-before-work · creator-owned PR shepherding · auto-wrapup · drain = orphan fallback). Built on **[SPEC-026](../SPEC-026-session-presence/requirements.md)**'s presence heartbeat — the observation ([DR-067](../../../docs/decisions/DR-067.md) §Context) that presence *is already an expiring lease* — and is the coordination sibling of **[DR-065](../../../docs/decisions/DR-065.md)** (the lease's second consumer, the sync gate). Governed by the constitution's [offline invariant #1](../../../.minspec/constitution.md#L5) and [*"Don't hope an LLM will follow rules — enforce it via code"*](../../../.minspec/constitution.md#L17).

## One-Sentence Scope

Make the **first** step of processing any work item a **check-then-claim under an expiring presence-lease** so exactly one session works it; have the session that **opens a PR shepherd it to merge** (poll CI + the independent ai-review, fix failures in its own worktree, fast-forward a behind-base branch, confirm the DR-061 auto-merge lands) instead of handing every PR to a fresh drain remediator that re-derives its intent; run **auto-wrapup on session exit** (commit/push chat-only work, file follow-ups, save memory, prune merged branches/worktrees, release held leases); and **demote the drain from primary fixer to orphan-fallback** that adopts a work item only once its owning session is gone (its lease expired) — with the **offline lease primitive kept in Tier-0 core** and **every networked consumer in Tier-1 machinery** (Phase 1: repo `scripts/`; Phase 2: the agent-execute "Execute" ext, deferred cross-repo).

## Context

The autonomous pipeline (triage → dispatch → build → review → merge) is live ([DR-060](../../../docs/decisions/DR-060.md)/[DR-061](../../../docs/decisions/DR-061.md)), but its **work-assignment model is a single shared drain that both dispatches AND fixes everything**, with no atomic notion of *who owns this item right now*. The four founder requests name the same missing primitive from four angles:

- **Claim-before-work.** Today `dispatch-issue.sh` flips `agent-ready → agent-running` ([dispatch-issue.sh:218-221](../../../scripts/dispatch-issue.sh#L218)) — a *de-facto* running-marker, but with **no check-before-claim** (nothing reads the marker first and stands down if the item is already owned) and it is **drain-only** (a human interactive session editing files never claims). A GitHub label is a **last-write-wins attribute, not a compare-and-swap**: two drainers (or a drain + a hand-run dispatch) can both read `agent-ready`, both flip, and both build the same issue.
- **Creator-owned PR shepherding.** The session that opens a PR ([dispatch-issue.sh:422-464](../../../scripts/dispatch-issue.sh#L422)) currently **exits**, handing every open PR to a *fresh* drain remediator ([remediate-pr.sh](../../../scripts/remediate-pr.sh) via [drain-inbox.sh:471-496](../../../scripts/drain-inbox.sh#L471)) that must **re-derive** the change's intent from the diff — even though the creator still holds the worktree, the branch, and the reasoning.
- **Auto-wrapup.** `/wrapup` is a manual, human-invoked skill; an autonomous session that dies mid-flight leaves loose chat-only work and leftover worktrees behind.
- **Drain = orphan fallback only.** The drain must stop being the *primary* fixer and become a safety-net reaper that adopts an item **only** when its owning session is gone.

### RCDD (DR-003) — the #912 root cause · symptom · mechanism · missing gate

The motivating incident is a *bug*, root-caused per [DR-003 RCDD](../../../docs/decisions/DR-003.md), even though the spec's remedy is a coordination feature.

- **Symptom (bad state).** [#912](https://github.com/AIClarityAU/minspec/issues/912): the drain's PR sweep dispatched build agents that started **near the context limit** and crash-thrashed the whole `agent-ready` queue to zero PRs. The current in-tree mitigation is an *autocompact circuit-breaker* that HALTS dispatch after N consecutive crashes ([drain-inbox.sh:425-468](../../../scripts/drain-inbox.sh#L425)) — a **bounded band-aid on the symptom, not the cause**.
- **Mechanism (what produced it).** The drain is the **primary fixer**: it hands *every* open PR to a **fresh** remediator ([drain-inbox.sh:471-496](../../../scripts/drain-inbox.sh#L471) → [remediate-pr.sh](../../../scripts/remediate-pr.sh)) that **re-derives** a PR's intent from its diff and launches a *new* agent to do so. Re-derivation is expensive context the creator already had for free; a fresh agent that must reconstruct it is exactly the one that starts near the limit and thrashes. There is no notion of *the creator owns this PR* and no *claim* to stop a stranger from re-processing an item its author is (or was) already handling.
- **Missing gate.** There is **no atomic, general, expiring claim** on a work item. `dispatch-issue.sh:218-221` writes a running-marker with **no check-before-claim** and it is **drain-only**, so nothing reads an existing claim and defers to a live owner. The gate that should exist: *check-then-claim before any work, and reclaim only on positive proof the owner is gone* — which is precisely the SPEC-026 presence lease, given a third consumer.

**Core gap (one sentence):** there is no atomic, general, expiring claim on a work item, so two processors can adopt the same item (double-work) and a fresh drain remediator re-derives a PR's intent its creator already held — when the creator should drive its own PR and a claim should stop anyone else from touching a live-owned item.

### The unifying insight — presence is already a lease

All four requests describe **an advisory lock that EXPIRES unless a heartbeat renews it, whose reaper reclaims the stale ones** — i.e. a **lease**. The project already ships that primitive: SPEC-026's presence layer heartbeats `.minspec/sessions/<uuid>.session.json` every `HEARTBEAT_SECS=30` ([presence.ts:32](../../../packages/minspec/src/lib/presence.ts#L32)); a record is *held* iff `lastSeen` is within `STALE_SECS=120` **and** `process.kill(pid,0)` proves the PID alive ([presence.ts:86-91](../../../packages/minspec/src/lib/presence.ts#L86)); a dead record is reaped on read ([presence.ts:431-452](../../../packages/minspec/src/lib/presence.ts#L431)); and DR-065 already made the sync gate a *consumer* of that lease ([presence.ts:202-224](../../../packages/minspec/src/lib/presence.ts#L202)). So **issue/PR claim = a new consumer of the same lease semantics**, **"drain reclaims orphans" = lease expiry**, and **arbitration = the FR-13 key already defined** (`startedAt`, fixed-width ISO-8601 ms, lexical == chronological; `sessionId` as secondary tie-break — [presence.ts:53](../../../packages/minspec/src/lib/presence.ts#L53)). No new lock store, no new coordination bus.

### The atomicity gap this spec must close honestly

SPEC-026's lease is **single-machine** — `process.kill(pid,0)` is meaningless for a PID on another host ([DR-065](../../../docs/decisions/DR-065.md) records this). Issue/PR ownership is **cross-machine**: two developers, a CI runner, and a laptop drain can reach for the same open issue, and **a GitHub label is not a CAS**. So the cross-machine claim needs an explicit **optimistic-concurrency protocol** (read-modify-write + a deterministic tiebreak) layered over a substrate that IS atomic — not over the label. The correctness of the one costly outcome (at-most-one *merge*) must rest on a genuine server-side compare-and-swap; the soft claim is an optimization that only dedups *wasted work*. This is designed explicitly in [design.md](design.md) §D1 and is the one part the human ratifies at Accept (OQ-1).

## Design spine (never-wrong)

One primitive — an **expiring lease** — carries the load-bearing properties, and correctness rests on the **hard** layers, never the soft one:

1. **Exactly-one-owner, correctness rests on the HARD layers.** A **soft** claim record with a deterministic winner (optimistic concurrency) dedups concurrent claimants *before* the expensive build. The costly outcomes rest on hard layers instead: (a) **concurrent** at-most-one-merge = GitHub's **one-open-PR-per-head-branch** server CAS (even a false soft double-winner collapses to **one** PR while the head is open — FR-3); (b) **sequential** at-most-one-merge (the CAS window closes on merge + head-delete) = an **open-issue + already-shipped-marker** gate before any re-claim (FR-3b); (c) **same-host** no-double-build-corruption = a per-item **`flock` + claim-unique worktree path** (FR-11), since the server CAS does not reach local FS. The soft claim is an *optimization*; these three are the *guarantees*.
2. **Self-healing via expiry — with a wall-clock ceiling.** No manual release: a stale lease (heartbeat older than TTL, or a dead same-machine pid) is *reclaimable* by definition, and the drain's "adopt an orphan" is exactly SPEC-026's dead-record prune generalized to work-item claims. Two honesty guards on top (FR-8/FR-12): a **two-phase grace-interval** reclaim + **owner re-verify** so a *suspended-but-alive* owner is not overridden on a lapsed heartbeat, and an **absolute max-claim-lifetime** so a *live-but-hung* owner cannot hold forever.
3. **Tier-0 offline primitive, Tier-1 networked consumers.** The lease *semantics* (heartbeat record, **liveness** predicate) stay in the air-gapped core — with the winner function substrate-specific and out of core; every networked consumer (GitHub claim/poll/merge, `/wrapup` push) plus the local `flock`/worktree machinery lives in Tier-1 — invariant #1, the same split [DR-065 §5](../../../docs/decisions/DR-065.md) uses for the drain's `fetch`/ff.

## Functional Requirements

- **FR-1 (check-then-claim as the first step).** The **first** action of processing a work item — before the worktree, before any edit — is *check-then-claim*: read the item's current claim; if a **live** claim exists that this session does not own, **stand down** (do not build); otherwise acquire the claim (taking the FR-11 same-host `flock` and using a claim-unique worktree path), then **re-read and verify** this session is the deterministic winner before proceeding (and, per FR-3b, that the item is still open and unshipped). Applies to `dispatch-issue.sh` (issue-claim) and to the PR-open path (PR-claim). This replaces the unchecked, drain-only marker flip at [dispatch-issue.sh:218-221](../../../scripts/dispatch-issue.sh#L218).
- **FR-2 (deterministic winner — optimistic concurrency).** Acquisition is *check → post claim → re-read → verify-winner*. The winner among live claims is the **earliest server-ordered claim** (GitHub's monotonic comment/record id — the server-assigned total order a label cannot give), with `sessionId` as a final deterministic tiebreak for the degenerate equal-id case. The client clock `claimedAt` is **NOT** a deciding key (cross-machine skew-unsafe; carried only as metadata) — the monotonic server id decides, and it is a strict total order so `claimedAt` never breaks a tie; the claim-*ref* substrate has no tiebreak at all (the git CAS is the winner — one ref ever exists). This is the *shape* of SPEC-026 FR-13 arbitration (monotonic primary → `sessionId`) but **not** byte-identical to it (presence keys on `startedAt`, not a server id, and exports no winner function — FR-10). **The re-read that verifies the winner MUST enumerate every competing claim to exhaustion** (paginate fully; compare against the served/expected count; detect truncation). On **any** read error or a provably-incomplete enumeration the session **stands down** — an incomplete read can never prove `own` (INV-6). A racer that is not the winner **retracts** (best-effort) and stands down. The decision — `claim` | `stand-down` | `own` — is computed by a **pure, unit-testable seam** (no `gh`/`git`/`claude`), mirroring `remediate-pr.sh`'s `--classify` seam ([remediate-pr.sh:97-108](../../../scripts/remediate-pr.sh#L97)); the *completeness* check on the enumeration is a credentialed-read responsibility that feeds the seam a flag, so a partial read maps to `stand-down`.
- **FR-3 (hard backstop — at-most-one-merge by CAS, not by optimism — CONCURRENT window).** The dispatch branch is deterministic (`agent/issue-N` — [dispatch-issue.sh:224](../../../scripts/dispatch-issue.sh#L224)); GitHub permits exactly one open PR per head branch and rejects a duplicate `gh pr create` atomically at the server. The system MUST rely on this uniqueness — not on GitHub comment-list read-after-write consistency — as the guarantee that at most one PR (hence one merge) exists per item **while that PR/head is open**. This CAS is scoped to the concurrent window: once the first PR merges and `agent/issue-N` is auto-deleted, `gh pr create` on a fresh `agent/issue-N` would succeed again.
- **FR-3b (sequential guard — a shipped item is never re-dispatched).** Because FR-3's CAS window closes on merge, at-most-one-merge across *time* is a **separate** gate: any (re-)claim or dispatch MUST first verify the item is **still OPEN** *and* carries **no already-shipped marker** (the merged-PR number recorded on the issue / a commit trailer / the closed-issue check). A stale drain cycle, a reopened issue, or a soft-claim miss that re-derives a merged change is refused here — merge-correctness across sequential attempts rests on this open-issue + shipped-marker check, **not** on the PR-per-head CAS.
- **FR-4 (creator-owned PR shepherding).** The session that opens a PR **claims it** (a PR-claim, same lease shape) and drives it to merge instead of exiting: poll CI + the independent ai-review; on `ai-review:changes` or a failing check, fix **in its own worktree** — it **reuses the preserved worktree/branch (no re-clone, no rebuild from scratch) and dispatches a fresh fix agent that is not context-exhausted**, rather than the #912 fresh drain remediator that started near the context limit. (Honest scope: the original build agent's in-context reasoning does **not** persist across invocations; what carries over is the *warm worktree + branch* and a *non-exhausted* fix agent that still re-reads the PR feedback and diff. The benefit is "no re-clone / no near-limit agent", not literally "holds the intent".) It then ffs a behind-base branch and confirms the [DR-061](../../../docs/decisions/DR-061.md) native auto-merge lands. Shepherding is **bounded and heartbeated** — a wall-clock cap and an attempt cap mirroring `MINSPEC_REMEDIATE_MAX_ATTEMPTS` ([remediate-pr.sh:51](../../../scripts/remediate-pr.sh#L51)); these caps bound the **post-PR** phase only — the **build** phase (claim → commit → push → pr-open) is bounded by FR-12's absolute max-claim-lifetime. Merge **conflicts are surfaced to a human, never LLM-resolved** (unchanged — [remediate-pr.sh:78-81](../../../scripts/remediate-pr.sh#L78)).
- **FR-5 (auto-wrapup on session exit — MECHANICAL release first, COGNITIVE wrapup after).** The two halves are **split and ordered**, because a single trap that bundled a cheap must-happen op with an expensive fragile one would let a hung/erroring `/wrapup` strand a lease. (a) **Mechanical teardown fires from the parent `EXIT` trap, first and unconditionally:** `issue-lease.sh release-all` (a cheap `gh`/ref op — **never** gated on wrapup), prune merged branches/worktrees, push already-committed work. This runs even after the agent subprocess has exited and makes the item immediately reclaimable rather than TTL-delayed. (b) **Cognitive wrapup runs best-effort *after* release, and only on a CLEAN exit:** filing `inbox` follow-ups and saving durable memory are an **LLM/agent act** (the `/wrapup` skill needs the live agent), so they execute as the live agent's **last act before** the parent trap fires — they **cannot** run from a bash trap after the agent process has already exited, and are **impossible on a killed session**. A headless dispatch has no chat-only work to capture, so its "wrapup" is effectively *release + worktree-prune*. Wired on the same `resolve_session_pid`/`session_alive` liveness the continuous drain already uses ([drain-inbox.sh:134](../../../scripts/drain-inbox.sh#L134), [drain-inbox.sh:258](../../../scripts/drain-inbox.sh#L258)). A session that is **killed** (SIGKILL, no trap) fires no release and no cognition — its leases fall to the FR-8 / FR-12 expiry path (mechanical/TTL-only), which is what orphan-fallback (FR-6) exists for.
- **FR-6 (drain demoted to orphan-fallback).** The drain's dispatch loop and PR sweep become **claim-aware**: it adopts an issue only if unclaimed-or-expired, and remediates a PR only if its creator-claim is **absent or stale** (owner gone). `classify_pr` ([remediate-pr.sh:71-95](../../../scripts/remediate-pr.sh#L71)) gains a new terminal token **`skip-live-owned`**, returned when a **live, non-self** creator-claim exists, so a PR under active shepherding is left alone. The drain becomes the **reaper**: it reclaims **only** expired leases.
- **FR-7 (Tier-0 split — offline primitive in core, networked consumers out).** The lease *semantics* stay in `presence.ts` (Tier-0: imports only `fs/path/crypto/child_process(git,local)`, zero network — [presence.ts:1-13](../../../packages/minspec/src/lib/presence.ts#L1)). This spec's core contribution is **naming and documenting** these as *the lease primitive* and (optionally) extracting the pure **liveness** predicate the networked readers must mirror byte-for-byte (the winner function is substrate-specific and stays out of the byte-parity — FR-10). The host-equality the predicate needs (`sameMachine`) is **decided outside core and passed in** — a local `os.hostname()` syscall only, never a DNS/network lookup. Every networked consumer — GitHub claim/poll/merge, the shepherd, the reaper, the `/wrapup` push — plus the local `flock`/worktree machinery lives in Tier-1 `scripts/` (Phase 1) and, later, the Execute ext (Phase 2). **No network enters core.**
- **FR-8 (lease liveness — cross-machine safe degrade; grace-interval reclaim; owner re-verify).** A claim is **live** iff `lastRenewed` is within the lease TTL **and** (same machine only) its pid is alive — the SPEC-026 `isRecordLive` predicate, extended cross-machine by **TTL alone** (a foreign host's pid is unobservable, so a foreign claim is judged purely by heartbeat age, degrading to the safe side: an un-renewed foreign claim expires and becomes reclaimable). The owner **renews** on a wall-clock timer while working and **releases** on normal completion. **The predicate can misjudge a suspended-but-alive owner as dead:** a stale heartbeat *alone* marks a claim reclaimable **before** the pid is even checked ([drain-inbox.sh:196-197](../../../scripts/drain-inbox.sh#L196) checks `age < STALE` then `kill -0`, in that order), so a still-alive owner whose heartbeat merely lapsed — laptop sleep past TTL, renew-HTTP failures over TTL, `SIGSTOP`/load starving the renew timer (all **unbounded**, so no TTL sizing fixes them) — is reclaimable **on the same machine too**. Therefore reclamation is **two-phase with a grace interval**: the reaper posts "reclaiming in one renew interval unless the owner renews", waits one renew interval, re-reads, and **backs off** if the owner re-asserts (a woken/slow owner re-renews and keeps its claim). Complementarily, **before every credentialed op** (push, pr-create, arm-auto-merge, label-mirror) the **owner re-verifies it still holds the claim** and stands down if it was reclaimed. The grace/re-verify handshake — **not** TTL sizing — is what keeps a still-alive owner from being overridden.
- **FR-9 (the label is a mirror, never the authority).** `agent-running` is retained only as a **human-visible mirror** of the claim, never the source of truth — a label alone is a single, overwritable, non-atomic producer, precisely the "single disableable producer" [DR-066](../../../docs/decisions/DR-066.md) forbids for anything load-bearing. Ownership decisions read the claim record, never the label.
- **FR-10 (lease-LIVENESS parity — the genuinely-shared predicate, N readers; the winner is NOT in the byte-parity gate).** The parity gate covers **only the liveness predicate** (`isRecordLive`/`isClaimLive`: heartbeat-within-TTL **and** (foreign-host OR pid-alive)) — which genuinely IS shared. It now has three readers — `presence.ts` (TS core), the drain's bash reader ([drain-inbox.sh:157-205](../../../scripts/drain-inbox.sh#L157)), and the new claim seam — which MUST agree byte-for-byte on the same fixtures; the constants (`HEARTBEAT_SECS`/`STALE_SECS`, paired) are named once per language with a tie-back comment, and the [DR-065 §4](../../../docs/decisions/DR-065.md) golden-fixture parity test is extended to cover the claim reader's liveness half. The **winner/arbitration function is deliberately excluded** from this byte-parity: `presence.ts` **exports no winner function** and its FR-13 key is `startedAt`, whereas the claim winner keys on the server-assigned id (FR-2) — different keys, so a cross-reader byte-comparison of arbitration is neither possible nor meaningful. The winner gets its **own substrate-specific test** (AC-9), not a parity claim. Per *enforce, don't trust the model*: liveness agreement is a **gate**, not a comment.
- **FR-11 (same-machine hard mutual exclusion — `flock` + claim-unique worktree path).** The soft GitHub claim and the server PR-per-head CAS give **zero** protection against two racers on **one host** (a drain + a hand-run dispatch, each seeing only its own claim on a machine-independent stale read) that derive the **same** deterministic worktree path (`${WORKTREE_BASE}/issue-N` — [dispatch-issue.sh:225](../../../scripts/dispatch-issue.sh#L225)) and both `git worktree remove --force` + `git branch -D` it ([dispatch-issue.sh:227-231](../../../scripts/dispatch-issue.sh#L227)) before any push — racer B clobbering racer A's **live** worktree mid-build, a local-FS corruption the server CAS never sees. Two same-host guards close it deterministically, **complementary to** (not the rejected global singleton lock — DR-067 §Alternatives): **(a)** the per-item worktree path is made **claim-unique** (`${WORKTREE_BASE}/issue-N-<sessionId>`) so two racers never share a directory; **(b)** an OS-level **`flock`** on a per-item lockfile (`.minspec/locks/issue-N.lock`) — a genuine same-host compare-and-swap, self-releasing on process death — is held before any worktree/branch mutation for that item. A worktree owned by a **live** claim is **never** `git worktree remove --force`-d by another racer. This machinery is Tier-1 `scripts/` (a local `flock`/`fs` op — no network, INV-3 preserved).
- **FR-12 (absolute max-claim-lifetime — a live-but-hung owner cannot hold forever).** Because renew is a wall-clock timer independent of build progress (so a quiet build never expires its own live claim — FR-8), a **wedged** `claude -p` build with a live parent + live renewer would keep its claim **live indefinitely** and never be reaped, breaking self-heal-via-expiry (INV-2) for a live zombie; the FR-4 shepherd caps cover only the post-PR phase, leaving the build phase uncapped. So each claim carries an **absolute max-lifetime** (independent of renew, sized ~2× expected-build-max): on expiry the owner **self-releases to `needs-human-review`**, or the claim is **force-expired despite a live pid**, so even a hung owner eventually becomes reclaimable. (Equivalently a progress-coupled liveness signal — last-commit / agent-heartbeat — would achieve the same; the absolute cap is the chosen mechanism, tuned in Plan.)

## Invariants

- **INV-1 (exactly-one-owner per item ⇒ at-most-one merge).** At any instant a work item has at most one *live* owner, and a given change is merged **at most once**. The at-most-one-merge half is split by time-window: **concurrently** it rests on the **hard** PR-per-head CAS (FR-3), not on the soft claim (FR-2); **sequentially** (after the first PR merges and the head is deleted, closing the CAS window) it rests on the FR-3b open-issue + already-shipped-marker gate — a shipped item is never re-dispatched. The soft claim only prevents wasted double-*work*. Enforce, don't trust — the guarantees are a server-side CAS and a persisted shipped-marker, not an LLM's carefulness ([constitution L17](../../../.minspec/constitution.md#L17)).
- **INV-2 (a stale lease is reclaimable — including a live-but-hung owner, eventually).** A lease whose heartbeat is older than the TTL (or whose same-machine pid is dead) is reclaimable **without any manual release** — expiry self-heals. No orphaned item is stranded beyond one TTL after its owner is gone. A **live-but-hung** owner (parent + renew-ticker alive, build wedged) does **not** hold forever either: the FR-12 absolute max-claim-lifetime force-expires it (self-release to `needs-human-review`, or force-expire despite a live pid), so even a live zombie eventually becomes reclaimable. (This is SPEC-026's reap-on-read generalized to work-item claims, plus a wall-clock ceiling the presence lease did not need.)
- **INV-3 (no networked call in Tier-0 core).** The offline lease primitive in `packages/minspec/src/lib/presence.ts` reaches **no** network — no `http`/`https`/`fetch`/`net` — and the `tier0-import-ban` test stays green. Every claim/poll/merge/push consumer lives in Tier-1 `scripts/` (Phase 1) or the Execute ext (Phase 2). Constitution invariant #1 (core works offline).
- **INV-4 (creator-first; drain touches only orphans).** The drain adopts or remediates a work item **only** when its owner-claim is **absent or the liveness predicate deems it expired**. A claim the predicate deems **live** is never overridden by the drain (`skip-live-owned`). The predicate can misjudge a **suspended-but-alive** owner as expired (FR-8); it is the **two-phase grace-interval reclaim + owner re-verify-before-credentialed-op** (FR-8) — **not** TTL sizing — that prevents a still-alive owner from being overridden. (Laptop sleep is unbounded; no TTL solves it, so the invariant is stated over the *predicate's* verdict, with the handshake as the correctness bridge.)
- **INV-5 (credential model unchanged).** The build/fix agent stays **credential-free** (no `gh`/push/remote/network — [remediate-pr.sh:127-129](../../../scripts/remediate-pr.sh#L127), [dispatch-issue.sh EGRESS GUARD](../../../scripts/dispatch-issue.sh#L495)); the **parent** dispatch/shepherd process performs every credentialed op. The `ai-review:*` labels remain **CI-bot-owned** and are never mutated by the shepherd or the drain ([dispatch-issue.sh:466-492](../../../scripts/dispatch-issue.sh#L466), the #600 provenance rule).
- **INV-6 (fail toward not-double-working).** An **ambiguous** claim state causes the session to **stand down** (never proceed), and a claim is **reclaimed only on positive proof of expiry** — never on absence of evidence. Ambiguous **explicitly includes**: an unreadable/corrupt/inconsistent claim record; an inability to prove the session is the winner; **and an incomplete claim enumeration** — a paginated-short, rate-limited, truncated, or errored read that cannot be proven to have listed *all* competing claims (such a read could silently omit an earlier competitor and let a loser compute a false `own`). Winner-completeness must be proven (paginate to exhaustion; compare against the served count) before an `own` verdict is honoured; on any doubt, **stand down**. This is the SPEC-026 / DR-065 fail-safe bias applied to claims: a false "unowned" double-works (wasteful, and — absent the FR-3 backstop — could double-merge), so under doubt, defer.
- **INV-7 (no two same-machine processors share a worktree/branch for one item).** On a single host, at most one live processor holds an item's worktree/branch at a time — enforced by the FR-11 per-item `flock` + claim-unique worktree path, a real same-host compare-and-swap. No racer `git worktree remove --force`-es a directory a **live** claim owns. (The server PR-per-head CAS does not reach local FS; this invariant is what closes that gap.)

## Vertical slices (thinnest-first; Phase 1 machinery; ordering is load-bearing)

Build the thinnest end-to-end claim path first, then layer shepherding, orphan-fallback, and wrapup. The **Tier-0 core naming** lands with Slice 1 as the shared contract every later slice mirrors.

1. **Slice 1 — the lease seam + issue check-then-claim + same-host hard lock (FR-1, FR-2, FR-3, FR-3b, FR-7, FR-8, FR-9, FR-11, INV-1, INV-2, INV-6, INV-7).** Add `scripts/lib/issue-lease.sh` with a **pure `--classify-claim` seam** (records + self + now + enumeration-complete flag → `claim`|`stand-down`|`own`, plus the winner sessionId) and the `gh`-backed acquire/renew/release/reclaim ops. Insert the check-then-claim first-step into `dispatch-issue.sh` before the worktree, taking the per-item `flock` and switching the worktree path to `issue-N-<sessionId>` (FR-11), and gating dispatch on open-issue + unshipped (FR-3b). Name/document the lease primitive in `presence.ts` (Tier-0), optionally extracting the pure *liveness* predicate. **Thinnest end-to-end path:** one issue claimed by one session; a second concurrent dispatch stands down; the FR-3 PR-per-head backstop caps merges at one even under a forced race; two same-host racers do not share a worktree. Ships with the T0 exactly-one-owner + reclaim-on-expiry + no-network-in-core tests, the FR-11 same-host mutual-exclusion test, and the FR-10 **liveness** parity test.
2. **Slice 2 — creator-owned PR shepherding (FR-4, FR-12, INV-5).** After opening a PR, the creator claims it and drives it to merge **in-process** by reusing `remediate-pr.sh`'s `classify_pr` + attempt caps — reusing the warm worktree/branch and dispatching a fresh, non-exhausted fix agent (not re-cloning, not launching a near-limit agent). The build phase is bounded by the FR-12 absolute max-claim-lifetime. Conflicts surfaced, labels CI-owned, credential model unchanged. Ships with AC-4.
3. **Slice 3 — drain demoted to orphan-fallback (FR-6, INV-4).** `classify_pr` gains `skip-live-owned`; the drain's dispatch loop and PR sweep become claim-aware, add the reaper, and reclaim expired leases via the **two-phase grace-interval handshake** (FR-8) so a suspended owner is not overridden. Ships with AC-5 and the #912 regression (the drain does not re-derive a live-owned PR).
4. **Slice 4 — auto-wrapup on exit (FR-5).** Wire the parent `EXIT` trap keyed on `resolve_session_pid`/`session_alive` to run **mechanical release-all + worktree-prune + push-committed FIRST and unconditionally**, then attempt **cognitive** `/wrapup` best-effort (the live agent's last act on a clean exit only); a killed session falls to the FR-8/FR-12 expiry path. This slice also tears down the parent-side **renew ticker** started at claim time (see design §D10) in the same trap. Ships with AC-6.

**Phase 2 (deferred, cross-repo follow-up — NOT specified here).** Productize claim/shepherd/wrapup in the agent-execute "Execute" ext ([`AIClarityAU/sealbox`](https://github.com/AIClarityAU/sealbox), EPIC-007, Tier-1). Filed as a separate follow-up spec in the sealbox repo (Traceability); this spec fixes the split and the primitive so Phase 2 inherits them.

## Out of scope (tracked elsewhere)

- **Phase-2 Execute-ext productization** — cross-repo (sealbox), premature before Phase-1 dogfoods the primitive. Filed as a follow-up spec (Traceability), not built here.
- **Cross-machine pid liveness.** A foreign host's pid is unobservable; foreign claims are judged by TTL alone (FR-8), degrading safe — the SPEC-026 / DR-065 precedent. Full cross-machine presence stays out of scope.
- **The DR-065 gated fast-forward** — a *different* lease consumer, unchanged by this spec.
- **The #912 autocompact circuit-breaker** ([drain-inbox.sh:425-468](../../../scripts/drain-inbox.sh#L425)) — a symptom band-aid **retained as defence-in-depth**, not removed; it simply stops being load-bearing once the creator shepherds (design.md §D9).
- **Merge-conflict auto-resolution** — unchanged: surfaced to a human, never LLM-resolved ([remediate-pr.sh:78-81](../../../scripts/remediate-pr.sh#L78)).
- **Retiring `agent-running`** — the label survives as a cosmetic mirror (FR-9); removing it from the pipeline UI is separate.

## Open Questions

- **OQ-1 (claim substrate: comment-order vs claim-ref CAS).** Should the soft claim be a structured **claim comment** (ordered by GitHub's monotonic comment id) or a **claim ref** `refs/minspec/claims/issue-N` (a genuine git-server CAS via `--force-with-lease` expecting-absent)? *Proposed:* **comment-order as the default soft layer, with the PR-per-head CAS as the hard backstop** (correctness never rests on comment linearizability); the claim-ref CAS is offered as the **hardening option** if the soft layer's rare double-*build* is judged too wasteful. **This is the one substrate decision the human ratifies at Accept.** Resolve in Clarify (drafted below); mirrors [DR-067](../../../docs/decisions/DR-067.md) OQ-1.
- **OQ-2 (work-item lease TTL vs presence STALE_SECS; + the live-zombie ceiling).** A build/shepherd runs many minutes; the presence `STALE_SECS=120` is fine only if the owner **renews** faster than TTL regardless of build progress. Should the work-item claim reuse `STALE_SECS=120` with an independent renew timer, or carry a **distinct, longer** work-item TTL? *Proposed:* a **distinct work-item TTL** sized to the renew cadence with margin, renewed on a wall-clock timer **independent of build progress** (so a long, quiet build never expires its own live claim mid-flight → self-inflicted double-work) — **paired with an absolute max-claim-lifetime (FR-12)** so that build-independent renewal cannot let a *hung* owner hold forever (the two together bound both the false-expiry and the never-expiry failure modes). Resolve in Clarify.
- **OQ-3 (wrapup push credential in Phase 1).** Where does auto-wrapup's push credential come from? *Proposed:* the **parent-side ambient `gh`/git credential**, identical to the dispatch parent's publish path (INV-5 — the agent stays credential-free; the parent pushes). Resolve in Clarify.
- **OQ-4 (does a human interactive session claim too, or only autonomous dispatch?).** Request #1 frames claim-before-work as *the first step of processing an issue* — any processor. *Proposed:* **Phase 1 wires the claim into the dispatch/drain machinery**; the interactive `/wrapup` skill already covers humans on exit, and the presence heartbeat already covers human sessions for the edit-guard. A **full human-session issue-claim UX is Phase 2 / ext** (the offline core cannot open a networked claim — invariant #1). Resolve in Clarify.

## Clarify

*Resolutions drafted by Claude (agent) 2026-07-25 as engineering defaults, per the maintainer's "you draft" instruction. Each is the proposed default from Open Questions, chosen with rationale. **These are confirm-or-redirect drafts — the human ratifies them at Approve Spec** (the hash-lock gate); nothing here is a human sign-off. OQ-1 in particular is the substrate ratification DR-067 flags for Accept.*

- **OQ-1 — claim substrate → RESOLVED: comment-order soft layer + PR-per-head hard backstop; claim-ref CAS is the recorded hardening option. The design is sound.**
  The correctness invariant is **at-most-one merge** (INV-1), and it rests on a **genuine server-side CAS**: GitHub allows exactly one open PR per head branch and rejects a duplicate `gh pr create` atomically (FR-3). The dispatch branch is deterministic (`agent/issue-N`), so two racers that both (wrongly) believe they won the soft claim still collapse to **one** PR — and even the *push* to a deterministic branch name is first-writer-wins (the second is a non-fast-forward reject, and the credential-free agent cannot force-push). The soft comment-order claim is therefore an **optimization** that avoids the wasted double-*build* in the common case; it is explicitly **not** trusted for merge-correctness, so GitHub's lack of a formal read-after-write linearizability guarantee does not threaten INV-1. The residual — a rare inconsistent comment-list read admits two builders → one wasted build — is **accepted** (bounded, self-correcting at the PR-per-head gate). If that waste is later judged unacceptable, promote the soft layer to the **claim-ref CAS** (`git push --force-with-lease=refs/minspec/claims/issue-N:` expecting the ref absent — a transactional create-if-not-exists at the git server), which makes the soft layer itself atomic. This is a closed, sound decision with a named upgrade path — **not** a hand-wave; the human confirms the default vs the hardening at Accept.
- **OQ-2 — work-item TTL → RESOLVED: distinct work-item TTL, build-independent renew, *plus* an absolute lifetime ceiling.**
  Reusing `STALE_SECS=120` directly is unsafe for a long build unless renewal is guaranteed faster than TTL *regardless of what the agent is doing*. The resolution is a **distinct work-item lease TTL** (a named constant, paired with its renew interval as `TTL = k × RENEW`, mirroring the `STALE = 4 × HEARTBEAT` discipline) and a **renew heartbeat on a wall-clock timer independent of build progress** — so a slow, quiet build cannot expire its own live claim and hand itself to the drain. **But build-independent renew has a dual failure mode:** a *hung* owner (live parent + live renewer, wedged build) would then hold its claim **forever** and never be reaped — self-heal-via-expiry failing for a live zombie. So the shape is **distinct TTL + build-independent renew + an absolute max-claim-lifetime (FR-12)** that force-expires (or self-releases to `needs-human-review`) even a live-pid owner past ~2× expected-build-max. The two values are tuned in Plan; the *shape* (distinct TTL + independent renew + absolute ceiling) is the decision.
- **OQ-3 — wrapup push credential → RESOLVED: parent-side ambient credential (unchanged model).**
  Auto-wrapup runs in the **parent** (the same process that already pushes the dispatched diff and opens the PR), under the operator's ambient `gh`/git credential — INV-5 is preserved: the build/fix agent never gains network/push. No new credential surface is introduced.
- **OQ-4 — human-session claim scope → RESOLVED: Phase-1 machinery-only; human issue-claim UX is Phase-2/ext.**
  The offline core cannot open a networked claim (invariant #1), so a full human-session issue-claim belongs in the Tier-1 Execute ext (Phase 2). Phase 1 wires claim/shepherd/reclaim into the dispatch/drain machinery, where the credentialed parent already lives; humans keep the existing interactive `/wrapup` skill and the presence-based edit-guard. This holds Phase 1 at a tight, dogfoodable scope.

No Clarify resolution blocks the Plan phase; all four resolve to a stated default. OQ-1's substrate default (comment-order + PR-per-head) is the human's to ratify at Accept.

## Acceptance Criteria

- **AC-1 (FR-1, FR-2, INV-1, INV-6) — concurrent dispatch stands down.** Two concurrent dispatches of the same issue: exactly **one** proceeds to build; the other reads the live claim, loses the winner check, retracts, and **stands down without editing any file**. **Must FAIL on pre-fix `dispatch-issue.sh`** (no check-before-claim — both proceed to build). The pure `--classify-claim` seam returns `own` for the winner and `stand-down` for the loser on the same fixture.
- **AC-2 (FR-3, INV-1) — at-most-one merge by CAS (concurrent window).** Even with the soft claim forcibly bypassed so **both** sessions build, at most **one** open PR exists for `agent/issue-N` and at most **one** merge occurs — the second `gh pr create` (or the second push to the deterministic branch) is rejected at the server. Verifies concurrent correctness rests on the hard backstop, not the soft claim.
- **AC-2b (FR-3b, INV-1) — a shipped item is never re-merged (sequential).** Given an item whose PR has **already merged** (issue closed, `agent/issue-N` deleted, shipped-marker persisted), a later (re-)claim/dispatch — a stale drain cycle or a soft-claim miss — is **refused** before any build: the open-issue check and the already-shipped-marker check both fail the gate, so no fresh `agent/issue-N` PR is created. **Must FAIL on a pre-fix path** that only checks PR-per-head (which would let the deleted-head re-create succeed).
- **AC-3 (INV-2, FR-8) — reclaim only on positive expiry.** A session that dies mid-work leaves its claim; **before** the TTL the claim reads live and blocks reclamation (drain leaves the item alone); **after** the TTL (heartbeat stale, or same-machine pid dead) the claim is reclaimable and the drain adopts the item. A foreign-host claim is judged by TTL alone (pid unobservable) and still reclaims safely once stale.
- **AC-3b (FR-8, INV-4) — grace interval protects a suspended-but-alive owner.** A same-machine owner whose heartbeat has lapsed **but whose process is still alive** (simulating laptop-sleep / renew-stall): the drain's reclaim posts the "reclaiming in one renew interval" notice and waits; the owner **renews within the grace interval**; the drain then **re-reads and backs off**, leaving the claim with its original owner. Separately, an owner that finds its claim was reclaimed **re-verifies before its next credentialed op and stands down** rather than pushing. **Must FAIL on a one-phase reclaim** (stale-heartbeat-alone reclaim with no grace).
- **AC-3c (FR-12, INV-2) — a live-but-hung owner is force-expired.** An owner whose parent + renew-ticker stay alive while the build is wedged past the **absolute max-claim-lifetime**: the claim is force-expired (or self-released to `needs-human-review`) despite the live pid, and the item becomes reclaimable. Verifies the wall-clock ceiling, not just heartbeat freshness, governs a live zombie.
- **AC-4 (FR-4, FR-12, INV-5, INV-7) — creator shepherds its own PR.** After opening a PR the creator claims and drives it: on `ai-review:changes` it fixes **in its own worktree** (reusing the warm branch, dispatching a fresh non-exhausted fix agent — no re-clone) and re-pushes; the `ai-review:*` labels are **never mutated** by the shepherd; the credential-free agent never runs `gh`/push; a merge conflict is **surfaced, never resolved**; shepherding stops at the attempt/wall-clock cap and falls to a human; and a build (pre-PR) that exceeds the FR-12 absolute lifetime is force-expired to `needs-human-review` rather than holding its claim forever.
- **AC-5 (FR-6, INV-4) — drain is orphan-fallback.** `classify_pr` returns **`skip-live-owned`** when a **live, non-self** creator-claim exists, and the drain leaves that PR untouched; when the creator-claim is **absent or expired**, `classify_pr` returns its normal remediation token and the drain adopts the PR. **The #912 regression:** with a live creator-claim present, the drain's PR sweep dispatches **no** remediator for that PR (no re-derivation, no fresh near-limit agent).
- **AC-6 (FR-5) — auto-wrapup: mechanical release FIRST, cognition after.** On a clean session exit the parent `EXIT` trap **releases every held lease + prunes merged branches/worktrees + pushes committed work FIRST and unconditionally** (so the item is immediately reclaimable, not TTL-delayed), and only **then** attempts cognitive `/wrapup` (file `inbox` follow-ups, save memory) as the live agent's last act. **Ordering is asserted:** an injected failure/hang in the cognitive `/wrapup` step still leaves the leases **released** (release must not be gated on wrapup). A **killed** session (SIGKILL) fires no trap — no release, no cognition — and its claim falls to the AC-3/AC-3c expiry path (mechanical/TTL-only). A headless dispatch's "wrapup" is release + worktree-prune (no chat to save).
- **AC-11 (FR-11, INV-7) — same-host racers never share a worktree.** Two dispatches of the same issue **on one host**: they take distinct claim-unique worktree paths (`issue-N-<sessionId>`), and the per-item `flock` serialises any shared-path mutation, so neither `git worktree remove --force`-es the other's **live** worktree. **Must FAIL on the pre-fix deterministic path** (`issue-N`, shared) where racer B force-removes racer A's live worktree mid-build. Asserted with a real same-host two-process race, not a mock.
- **AC-7 (FR-7, INV-3) — Tier-0 core stays offline.** `packages/minspec/src/lib/presence.ts` reaches no network; the `tier0-import-ban` test stays green; a grep of the ext bundle finds **no** GitHub claim/poll/merge/push code — every networked consumer is under `scripts/` (Phase 1).
- **AC-8 (FR-10) — lease-LIVENESS parity.** The **liveness** predicate agrees **byte-for-byte** across `presence.ts`, the drain's bash reader, and `issue-lease.sh` on the golden fixtures (the DR-065 §4 parity test, extended to the claim reader's liveness half). Drift fails the test. The winner/arbitration function is **out of scope** for this byte-parity (it is substrate-specific and `presence.ts` exports none — see AC-9).
- **AC-9 (FR-2) — deterministic winner (own test, not a parity claim).** Given a set of claim records, the winner is the **earliest server-ordered id**, with `sessionId` as the final tiebreak; the client-clock `claimedAt` is **not** a deciding key. Property-checked over {no claim, single claim, multiple live claims by server id, equal-id degenerate → `sessionId`, stale + live mix, incomplete/truncated enumeration → `stand-down`}. This is the *shape* of SPEC-026 FR-13 arbitration (monotonic primary → `sessionId`) but keyed on the server id, so it is tested **independently** of the presence winner, not asserted byte-identical to it.

## Risks

| # | Risk | Mitigation |
|---|------|-----------|
| R1 | **Soft-claim linearizability** — GitHub comment-list read-after-write is not formally linearizable, so a rare inconsistent read admits two soft-winners. | Correctness (INV-1 at-most-one-merge) rests on the **hard** PR-per-head CAS (FR-3), never on the soft read. The only residual is a wasted double-*build*, bounded and self-correcting at the PR gate. Hardening path recorded (OQ-1 claim-ref CAS). |
| R2 | **Lease TTL vs build duration** — a long, quiet build that fails to renew expires its own claim mid-flight → the drain reclaims → self-inflicted double-work. | Distinct work-item TTL + a renew heartbeat on a wall-clock timer **independent of build progress** (OQ-2); TTL sized with margin over the renew interval, paired-constant discipline. |
| R3 | **Three implementations of the lease LIVENESS predicate drift** (TS core, drain bash reader, claim seam). | Paired named constants + the DR-065 §4 golden-fixture parity test **extended** to the claim reader's liveness half (FR-10, AC-8) — a gate, not a comment. The winner function is substrate-specific (own test, AC-9), deliberately outside the byte-parity. |
| R4 | **A hung shepherd or a hung build** ties up its parent longer than a fire-and-forget dispatch, or holds its claim forever (live parent + live renewer). | Post-PR: bounded wall-clock + attempt caps (FR-4). Build phase: the **FR-12 absolute max-claim-lifetime** force-expires a live-but-hung owner (self-release to `needs-human-review`) so a live zombie cannot hold indefinitely; a killed shepherd's PR falls to orphan-fallback (AC-3/AC-5). |
| R5 | **Demoting the drain strands PRs** if both the creator-shepherd and wrapup fail (e.g. the session is killed before release). | Orphan-fallback: the drain still reaps a PR whose creator-claim expired (INV-4/AC-5), the **mechanical release fires first** in the exit trap so a hung `/wrapup` never strands a lease (FR-5/AC-6), and the #912 autocompact breaker is **retained as defence-in-depth** (out-of-scope note, design §D9). No PR is left with no eventual fixer. |
| R6 | **Cross-machine crashed owner** strands its item for up to one TTL before reclamation (foreign pid unobservable). | Accepted — the failure lands on the **safe** side (stale ⇒ reclaimable), identical to DR-065's foreign-record case; bounded by the TTL. |
| R7 | **Same-host double-build corruption** — two local racers derive the **same** deterministic worktree path and one `git worktree remove --force`-es the other's **live** worktree mid-build; the server PR-per-head CAS does not see local FS. | **FR-11:** claim-unique worktree path (`issue-N-<sessionId>`) + a per-item `flock` (a real same-host CAS, self-releasing on process death); a live-claimed worktree is never force-removed by another racer (INV-7/AC-11). Complementary to, not the rejected global singleton lock. |
| R8 | **Sequential double-merge** — after the first PR merges and `agent/issue-N` is deleted, the PR-per-head CAS window is gone; a stale drain cycle / reopened issue / soft-claim miss pushes a fresh `agent/issue-N` and re-merges the same change. | **FR-3b:** any (re-)claim/dispatch is gated on the item being **still open** *and* carrying **no already-shipped marker** (merged-PR number / commit trailer / closed-issue check), verified before build (INV-1/AC-2b). |
| R9 | **Suspended-but-alive owner reclaimed on a lapsed heartbeat** — laptop sleep / renew-stall (all unbounded) makes the liveness predicate misjudge a live owner as dead, and the drain adopts its live PR (a partial #912 thrash return). | **FR-8:** two-phase grace-interval reclaim (post-notice → wait one renew → re-read → back off if the owner re-asserts) + owner **re-verify before every credentialed op**; the handshake, not TTL sizing, is the fix (no TTL bounds laptop sleep). INV-4 restated over the predicate's verdict (AC-3b). |
| R10 | **Incomplete claim enumeration** — a paginated-short / rate-limited / truncated read omits an earlier competitor, so a loser computes a false `own`. | **INV-6/FR-2:** the verify-read must be provably complete (paginate to exhaustion; compare against served count; detect truncation) before honouring `own`; any read error or partial page ⇒ **stand-down** (AC-9). |

## Amendment A (2026-09-05) - PROPOSED, not accepted

**Splits FR-4. Ownership of a fix stays with the creator; ordering of the merge queue moves
to a single central driver.** FR-4 as written makes the creating session responsible for
both, and the two are different problems: it solved *who fixes this PR* and never addressed
*which PR should move first*. Two measured holes follow, neither reachable by tuning the
existing design. Recorded as `proposed` and held until the founder ratifies it; this is a
T4 spec and acceptance is a separate human act. Triggered by [minspec #1750].

### Hole 1 - shepherding is bounded to one hour and dies with its session

`scripts/lib/shepherd-pr.sh:39` caps the whole loop at `MINSPEC_SHEPHERD_MAX_SECS` (default
**3600**), and the loop is in-process, so it also ends when its session exits. After either
limit, **nothing** drives that PR. FR-6 demoted the drain to orphan-fallback precisely
because the creator was expected to be driving; when the creator's hour is up, the fallback
is all that remains, and #1803 shows the fallback's classifier returns `skip-clean` on a
cold `UNKNOWN` merge state - it declares the stale PR healthy.

Measured 2026-09-05 on this repository:

```
$ pgrep -af "shepherd|dispatch-issue"
(no output - zero shepherds running)

$ gh pr list --state open --json number,createdAt,updatedAt,mergeStateStatus  # BEHIND only
#1740 created 08-30   #1742 created 08-30   #1744 created 08-30
#1748 created 08-30   #1760 created 08-31, last touched 08-31T03:45
```

Twenty-four PRs `BEHIND`, the oldest six days old, one untouched for five. Every shepherd
that ever held them expired long ago. This is not sessions failing to honour FR-4 - it is
FR-4 working exactly as specified and then stopping.

### Hole 2 - FR-4 assigns an owner, never a priority

A creator-shepherd sees one PR. It has no view of the queue, so it cannot know that landing
#1813 unblocks every other PR while #1821 unblocks nothing. Ordering is therefore whatever
order sessions happen to be alive in - first-in-best-dressed at best, and in practice
whoever survived longest.

Under `strict_required_status_checks_policy` (SPEC-065 DQ-1) ordering is not a nicety, it is
the whole cost model: every merge to `main` puts every other open PR back to `BEHIND`.
Updating N branches independently burns roughly **N²/2** CI runs plus review panels, because
the first merge invalidates the rest; updating exactly one, letting it land, then the next,
costs **N**. `scripts/lib/shepherd-pr.sh` cannot make that choice, because the information
needed to make it is not in its scope. Nothing in SPEC-044 owns it.

### What `skip-live-owned` does and does not cover

FR-6's `skip-live-owned` token (`scripts/remediate-pr.sh:113,446`, seam at
`scripts/lib/issue-lease.sh:360`, pinned by
`packages/minspec/tests/remediate-pr-classify.test.ts:145`) is correct and stays. It prevents
**two** drivers contending for one PR. It is silent on the case actually observed, which is
**zero** drivers, and silent on ordering, which was never a contention question. An
absent-owner case and a competing-owner case are different defects; only the second was
specified against.

### The change

- **FR-4a (creator-owned FIXES - unchanged in substance).** The session that opened a PR
  remains the owner of *fixing* it: on `ai-review:changes` or a failing check it reuses its
  warm worktree and branch and dispatches a fresh, non-exhausted fix agent. This is FR-4's
  real value and the reason not to move fixes centrally - the warm tree cannot be recreated
  cheaply elsewhere. Conflicts are still surfaced to a human, never LLM-resolved.
- **FR-4b (central merge ordering - new).** A single driver holds the queue view and owns
  branch updates and merge confirmation. It picks the next PR to update, waits for it to
  land, then picks the next - the serialisation that turns N²/2 into N. It is unbounded in
  the sense that matters: it does not expire after an hour, and it does not vanish when a
  build session exits.
- **FR-6 (adjusted).** The drain stops being the only fallback for an expired creator, since
  under FR-4b there is no gap to fall back from. It remains the reaper for expired *leases*.

### The mechanism - capability REMOVED, not merely reassigned

Saying "the driver owns ordering" changes nothing on its own. `shepherd_decide` can emit
`do-rebase` today (`scripts/lib/shepherd-pr.sh:72-73`), so on any merge to `main` every live
shepherd independently observes `BEHIND` and each one updates its own branch - N branch
pushes, N CI runs, N full review panels, for a state that the next merge invalidates
anyway. A rule telling shepherds to refrain is the exact "trust the model" shape the
constitution names as the failure mode.

So the amendment **removes the capability**: `do-rebase` leaves the shepherd's vocabulary
and is replaced by a wait token. A shepherd that finds itself `BEHIND` does nothing and
waits, because updating a branch is no longer something it can express. Only the driver
can update, because only the driver *can*. This is checkable by a test over
`shepherd_decide`'s output set, in the same shape as the existing
`packages/minspec/tests/shepherd-decide.test.ts` priority-gate sweep.

Note this is independent of who approves. A human keystroke on one PR puts every other PR
`BEHIND` exactly as an unattended merge does, so the stampede is a property of `strict`
plus N independent updaters, not of automation.

### The driver may already exist - GitHub's native merge queue

[SPEC-065](../SPEC-065-solo-mode-ceremony-cut/requirements.md) recorded both halves of this
before the pain arrived: line 204 notes that `main` has **no merge queue** configured, and
line 226 that "a merge queue (option (b)) remains the better" answer, deferred against a
throughput trade. A merge queue does natively what FR-4b describes: it serialises, updates
one branch at a time, and owns the order.

Building a custom driver when a native one was already identified as the better answer
needs a reason. The Clarify pass should compare them explicitly rather than assume the
custom path.

**UNVERIFIED and load-bearing for that comparison:** whether a machinery PR can enter a
merge queue at all. A queue requires the PR to satisfy required checks, and
`machinery-review-required` is `ACTION_REQUIRED` by design, so machinery may be
unqueueable - which would leave exactly the PR class this spec most needs to move outside
the native mechanism. Settle this before choosing.

### What this does not change

`INV-5` is untouched: the fix agent stays credential-free and the parent performs every
credentialed op. `ai-review:*` labels remain CI-bot-owned. Merge conflicts are still surfaced
to a human. The FR-12 absolute max-claim-lifetime still bounds the build phase. Nothing here
grants a new merge authority - machinery PRs still require the founder's keystroke, because
a gate cannot certify a change to itself.

### Rejected alternatives

- **Raise `MINSPEC_SHEPHERD_MAX_SECS`.** Rejected: it postpones hole 1 without touching it,
  since the loop still dies with its session, and it does nothing at all for hole 2.
- **Delete creator-shepherding entirely and centralise both halves.** Rejected: it discards
  FR-4's warm worktree and non-exhausted fix agent, which is the part that measurably works
  and the reason #912 was raised. Central fixing would re-clone and re-read from cold.
- **Leave it and rely on the drain.** Rejected on the evidence above - the drain is the
  fallback and it has not moved these PRs in six days, for a reason #1803 documents.

### Open questions for Clarify

1. **Where does the driver live?** It is machine-wide and long-lived, which sits awkwardly
   with constitution invariant 3 (blast radius is the repo that opted in) and with the Tier-0
   boundary, since driving merges is networked. Candidates: the Tier-1 `scripts/` harness, the
   Execute ext (EPIC-007), or a supervisor session. This is the load-bearing question and
   should be settled before Plan.
2. **What is the priority function?** "Unblocks the most other PRs" is the obvious first
   answer, but it needs a definition that is computable without an LLM, per the never-wrong
   spine.
3. **Exactly-one-driver.** The driver is a singleton and needs the same lease treatment as
   every other claim in this spec, or it reintroduces the contention FR-6 removed.
4. **Relationship to [minspec #1750] and [minspec #1803].** Both are in flight and both
   overlap this; the amendment should say which of them it supersedes rather than leaving
   three descriptions of one problem.


## Traceability

- **Issue:** [#912](https://github.com/AIClarityAU/minspec/issues/912) (the drain-remediator crash-thrash outage that motivates creator-owned shepherding + orphan-fallback). Related: [#900](https://github.com/AIClarityAU/minspec/issues/900) (the stalled, unmerged PR carrying a prior "DR-067" draft — superseded by the on-`main` DR-067), [#888](https://github.com/AIClarityAU/minspec/issues/888) (the G-8 autonomous sync/merge loop — creator-owned shepherding is its "who drives each PR to merge" half).
- **Decision:** [DR-067](../../../docs/decisions/DR-067.md) (materializes this spec — claim under a lease · shepherd your own PR · wrap up on exit · drain reclaims only orphans; the Tier-0 split and phased rollout).
- **Methodology:** [DR-003 RCDD](../../../docs/decisions/DR-003.md) (the #912 root cause is the drain-as-primary-fixer mechanism + the missing claim gate, not the autocompact symptom).
- **Constitution:** [offline invariant #1](../../../.minspec/constitution.md#L5), [*enforce it via code*](../../../.minspec/constitution.md#L17).
- **Depends on:** [SPEC-026](../SPEC-026-session-presence/requirements.md) (the presence heartbeat IS the lease primitive — FR-2/FR-3/FR-4/FR-13 liveness + arbitration).
- **Relates to:** [DR-065](../../../docs/decisions/DR-065.md) (the lease's sync-gate consumer + the §4 parity discipline this reuses), [DR-060](../../../docs/decisions/DR-060.md)/[DR-061](../../../docs/decisions/DR-061.md) (the autonomous pipeline this restructures), [DR-046](../../../docs/decisions/DR-046.md) (rule #8 / dedicated-worktree isolation), [DR-004](../../../docs/decisions/DR-004.md) (the tier model bounding what ships in the offline ext), [SPEC-031](../SPEC-031-reviewer-all-approvables/requirements.md) (the reviewer machinery the shepherd polls).
- **Follow-up (Phase 2, cross-repo):** productize claim/shepherd/wrapup in the agent-execute "Execute" ext ([`AIClarityAU/sealbox`](https://github.com/AIClarityAU/sealbox), EPIC-007) — a separate spec filed on Accept (DR-023 forward rule: cross-repo, non-code-in-this-repo work must be a filed issue/spec, not prose).
</content>
</invoke>
