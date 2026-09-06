---
id: SPEC-066
type: requirements
status: specifying
tier: T3
product: minspec
epic: EPIC-007  # Agent Execute — the dev-time autonomous build/merge pipeline (dispatch-issue.sh's own crash-classification lives here)
aspects: [agent-dispatch, quota, labeling, no-silent-gate, tier-0]
relates_to: [SPEC-044, SPEC-062, DR-063, DR-084, DR-076]
implements: [packages/minspec/tests/dispatch-quota-classification.test.ts]  # NEW — the T3 regression test this spec owns
affects: [scripts/dispatch-issue.sh, scripts/dispatch-ready-check.sh]  # dispatch-issue.sh is OWNED by SPEC-044 via implements: — this spec modifies its crash branch, never owns the file (INV: one owner per file). dispatch-ready-check.sh is currently unowned by any spec; this spec adds one line (the countermand list) without claiming ownership of the file.
phases:
  specify: in-progress
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---

# MinSpec — Distinguish provider-quota exhaustion from a genuine dispatch dead end (Requirements)

> **This is a SPECIFICATION ONLY.** No code, script, or test is created by the dispatch
> that produced it. A human reads this spec, resolves the
> **[Decisions needed (Clarify)](#decisions-needed-clarify)** section, and approves it
> through the normal spec-approval gate before anything is built.

Materializes **#1656** — *"provider quota exhaustion is recorded as agent-escalated, so a
wait-for-reset is indistinguishable from a genuine dead end."* Sibling of **#1652** ("the
other way an issue leaves the queue in a state nothing retries" — not read for this spec;
flagged only so a reviewer doesn't conflate the two).

## One-Sentence Scope

When the build agent `scripts/dispatch-issue.sh` launches via `claude -p` dies because the
underlying subscription/session quota is exhausted, label and comment the issue distinctly
from a genuine agent-escalated dead end or an unrecognised crash, without restoring
`agent-ready` — so a human is never summoned to adjudicate a condition that only time can
resolve.

## Context

### The three-way collapse (the defect)

`scripts/dispatch-issue.sh` currently has exactly one terminal state for three causally
different events, all reached through the same `else` branch of the top-level launch
`if` (current line numbers; see `git blame` for drift):

1. **Genuine dead end** — the agent itself emits `ESCALATE:` (detected at `dispatch-issue.
   sh:1579`), the one allowed DR-355 opus retry has already run (`escalate_next_action`,
   `:1505-1598`), and a human's judgement is the only way forward. Correctly labeled
   `agent-escalated,needs-human-review` at `:1594-1598`.
2. **An unrecognised crash** — the `claude -p` pipeline itself exits non-zero for an
   unknown reason. Handled by the `else` at `:2005-2021`, which stamps the SAME
   `agent-escalated,needs-human-review` pair and removes `agent-ready` — added by #1307
   specifically because a crash is "at least as strong a reason to stop as an agent's own
   admission that it cannot proceed" (comment at `:2006-2014`, citing #1112's two-round
   silent-requeue-then-crash-again loop).
3. **Provider quota exhaustion** — the CLI's own subscription/session-limit message (e.g.
   `You've hit your session limit · resets 1pm (Australia/Sydney)`), which is neither an
   agent judgement nor an unknown failure: it is a stated, time-bounded, self-healing
   condition. It currently falls into path 2 — `grep -niE 'session limit|quota|rate.?
   limit|resets'` over `dispatch-issue.sh` returns no detection for it (the only hit is an
   unrelated comment at `:119`, part of the machinery-witness prose, not dispatch logic).

Only case 3 needs nothing but time. Cases 1 and 2 need a human. Collapsing them means a
human is summoned for a condition no human can act on, and — per the issue report — three
dispatch attempts in one session (#1506 twice, #1504 once) each required a full manual
recovery cycle (notice the labels, re-triage to clear `needs-human-review`/`agent-
escalated`, restore `agent-ready`, re-dispatch) that produced zero commits, because the
quota had not actually reset.

It also degrades the signal `agent-escalated` exists to carry. DR-063 already made this
exact move once, for the AI-reviewer's own label (`ai-review:changes` was overloaded
between "reviewer read the code and wants fixes" and "review could not produce a
trustworthy verdict" — DR-063 split out a `blocked` class and the `isQuotaExhaustion`/
`isQuotaExhaustionStrict` predicates in `.github/scripts/ai-review-guard.js` to tell the
two apart without a human). This spec applies the same split to the *dispatch* label
family, using the *same* classifier — see FR-1.

### Prior art already in this repo that this spec must reuse, not duplicate

- **`.github/scripts/ai-review-guard.js`** exports `isQuotaExhaustion(text)` (loose,
  correct for harness/CLI diagnostic text), `isQuotaExhaustionStrict(text)` (tight,
  correct for agent-authored prose that might merely *discuss* quotas), and
  `parseResetInstant(text, nowMs)` (extracts an ISO-8601 reset instant from either a
  relative "`resets in 25 minutes`" or absolute "`resets 1pm (Australia/Sydney)`"
  phrasing, or returns `null` — which callers MUST read as "retry on the normal cadence",
  never as "never retry"). All three are already unit-tested
  (`.github/scripts/ai-review-guard.test.js`) and already consumed by
  `scripts/review-pr.sh`, `scripts/review-decide.sh`, `scripts/review-approvable.sh`,
  `scripts/review-branch.sh`, and `scripts/drain-inbox.sh` (`is_quota()`, `:264-267`).
  `scripts/dispatch-issue.sh` is the one dispatch-family script that does **not** yet call
  into this module.
- **`scripts/drain-inbox.sh`** already classifies dispatch-issue.sh's *combined stdout*
  with `is_quota()` (`classify_dispatch`, `:722-737`) and, on a hit, pauses the whole drain
  **cycle** for a backoff (`return 42`) — but this is orchestrator-level throttling. It
  does not touch the per-issue GitHub labels dispatch-issue.sh itself writes, which is
  exactly the gap #1656 reports. The two are complementary, not overlapping: this spec's
  fix makes the *label* correct; drain-inbox.sh's existing gate makes the *next dispatch
  attempt* wait. Both should keep working after this change (AC-7).
- **`scripts/dispatch-ready-check.sh:635`** already carries a "countermand list" — labels
  that must block re-readying an issue even if a stale `agent-ready` lingers — specifically
  because of the #1068/#1112 defense-in-depth lesson (comment at `:616-634`): a single
  missed label write must not reopen the hole. A new label that removes `agent-ready` but
  is absent from this list repeats exactly the bug that list exists to prevent.

### Why no new DR

DR-359's filter (costly-to-reverse in under a day) doesn't apply: this reuses an existing,
already-tested classifier, adds one new GitHub label (revertible by deleting it), and
changes one script's branch ordering. DR-063 and DR-084 already establish the governing
precedents (split an overloaded label; the pipeline can jam on shared quota) — this spec
applies them, it doesn't set new policy. No DR is proposed; `docs/decisions/INDEX.md` has
no existing entry for this narrower question either.

## Functional Requirements

- **FR-1 (single-sourced detection, no new regex).** Before the existing generic-crash
  branch (`dispatch-issue.sh`'s `else` at `:2005`) applies any label, the captured `$LOG`
  MUST be tested with the SAME `isQuotaExhaustion(text)` predicate `drain-inbox.sh` and the
  `review-*.sh` family already use (`.github/scripts/ai-review-guard.js`), invoked the same
  way (`GUARD="$GUARD" node -e '...'`, mirroring `drain-inbox.sh:264-267`). Loose variant,
  not strict: `$LOG` is the CLI's own transcript (harness/diagnostic text), the same shape
  `drain-inbox.sh` feeds it, not agent-authored prose. *Rationale: a second, hand-rolled
  regex in dispatch-issue.sh would drift from the tested one the instant either changes —
  the exact class of bug DR-063 exists to prevent.*

- **FR-2 (reset time, best-effort).** When FR-1 matches, `$LOG` MUST also be run through
  `parseResetInstant` from the same module to recover a reset instant. A `null` result
  (no reset time stated, or unparseable) MUST be treated as "reset time not stated" in the
  posted comment (FR-4) — never as grounds to skip the quota classification or to imply
  "never retry."

- **FR-3 (distinct label, no requeue).** On an FR-1 match, the issue MUST receive a new
  label `agent-blocked-quota` in place of `agent-escalated`. `needs-human-review` MUST NOT
  be applied. `agent-running` and `agent-ready` MUST still be removed, exactly as the
  existing crash branch does today — preserving the #1112 no-silent-requeue protection
  without change. `agent-blocked-quota` MUST be added to `scripts/dispatch-ready-check.sh`
  `:635`'s countermand list, so a stale `agent-ready` cannot outvote it (the same
  defense-in-depth the comment at `:616-634` already documents for `agent-quarantined`,
  `agent-done`, and `agent-escalated`).

- **FR-4 (legible, not just labeled).** On an FR-1 match, dispatch-issue.sh MUST post an
  issue comment stating plainly that the issue was NOT dispatched because of provider quota
  exhaustion, and MUST include the reset time from FR-2 when known ("resets 1pm (Australia/
  Sydney)") or an explicit "reset time not stated in the CLI output" when not. *Rationale
  (the issue's own words): "A human then knows there is nothing to review."*

- **FR-5 (the other two paths are unchanged).** The `ESCALATE:` path (`:1579-1598`,
  including the DR-355 opus retry) and the generic-crash path for anything FR-1 does NOT
  match MUST behave exactly as they do today: same labels, same retry behaviour. FR-1's
  check is a new, narrower branch spliced in ahead of the generic crash handling, not a
  replacement for it.

- **FR-6 (drain-orchestrated runs are not double-counted incorrectly).** When
  dispatch-issue.sh is launched by `drain-inbox.sh`'s fan-out, `drain-inbox.sh`'s own
  `classify_dispatch`/`is_quota` (`:722-737`) reads dispatch-issue.sh's *entire* stdout —
  which will now include the FR-4 comment-echo — and will therefore continue to detect the
  outage and pause the drain cycle, unchanged. This spec MUST NOT alter drain-inbox.sh's
  own detection or backoff; the two layers (per-issue label, per-cycle pause) are
  independent witnesses to the same event, not a hand-off (constitution invariant 2 — an
  independent second witness is a feature here, not redundancy to remove).

## Acceptance Criteria

- **AC-1 (FR-1/FR-3, the reported case).** A fixture `$LOG` containing the session-limit
  signature (`You've hit your session limit · resets 1pm (Australia/Sydney)`) produces
  `agent-blocked-quota`, and NEITHER `agent-escalated` NOR `needs-human-review`. `agent-
  ready` is not present afterward (removed, never restored).
- **AC-2 (FR-5, negative — escalation unchanged).** A fixture `$LOG` containing `ESCALATE:
  <reason>` still takes the existing escalation path, including the one DR-355 opus retry
  when eligible, and still ends in `agent-escalated,needs-human-review` when the retry
  budget is spent. Asserted by execution against `escalate_next_action`, not by reading
  source text.
- **AC-3 (FR-5, negative — unknown crash unchanged).** A fixture `$LOG` that is a crash but
  matches neither `ESCALATE:` nor `isQuotaExhaustion` still takes today's `:2005-2021`
  path unchanged: `agent-escalated,needs-human-review`, `agent-ready` removed.
- **AC-4 (FR-2/FR-4).** A `$LOG` with an absolute reset phrase produces a posted comment
  that states the parsed instant/time; a `$LOG` that matches FR-1 but carries no parseable
  reset phrase (e.g. a bare "quota exceeded" with no `resets`/`try again` clause) still
  produces `agent-blocked-quota` and a comment that explicitly says the reset time is not
  stated — never a thrown error, never a silently skipped comment.
- **AC-5 (FR-3, countermand list).** With `agent-blocked-quota` present and a stale
  `agent-ready` also present, `scripts/dispatch-ready-check.sh` refuses (does not admit the
  issue as ready), mirroring the existing `agent-quarantined`/`agent-done`/`agent-escalated`
  rows in the same list.
- **AC-6 (FR-1, no drift).** The predicate dispatch-issue.sh uses and the one
  `drain-inbox.sh`'s `is_quota()` uses are the SAME function from the SAME file, asserted
  by a test that would fail if dispatch-issue.sh ever inlined its own copy.
- **AC-7 (FR-6, non-regression).** With drain-inbox.sh orchestrating a dispatch that hits
  the AC-1 fixture, drain-inbox.sh's own cycle-level pause (`return 42`) still fires,
  unchanged by this spec.

## Invariants

- **INV-1 (constitution #2, no silent gate).** The quota branch changes *which* label is
  applied, never *whether* the outcome is visible: `agent-blocked-quota` plus the FR-4
  comment is at least as visible as today's `agent-escalated,needs-human-review`, just
  correctly classified. A quota hit must never fall through to silence.
- **INV-2 (#1112, no silent requeue).** `agent-ready` is never restored by this change,
  under any of the three paths. This is the property #1307 added for crashes generally and
  this spec must not weaken it for the quota subclass.
- **INV-3 (single source of truth).** No second, hand-maintained quota-detection regex may
  exist in `scripts/dispatch-issue.sh`. If `.github/scripts/ai-review-guard.js`'s exports
  ever need widening for this call site, they are widened THERE, in the tested module, not
  forked.
- **INV-4 (constitution #3, blast radius).** This change is internal dev-tooling for this
  repo's own dispatch pipeline; it introduces no network call, no new external dependency,
  and no behaviour reachable outside a repo that opts in via `.minspec/`.

## Decisions needed (Clarify)

### DQ-1 (scope) — bounded auto-reconsideration after the reset passes

The issue's step 4 proposes, as an explicit **optional** extra: letting the drain
reconsider an `agent-blocked-quota` issue once the recorded reset timestamp has passed,
capped at a small attempt count and logged each time.

- **Option A — split out (rec).** Ship FR-1 through FR-6 now (detection, labeling,
  comment, countermand-list fix) as this spec's whole scope; file a follow-up issue for
  reconsideration. *Cost:* an issue correctly diagnosed as "just wait" still needs a human
  (or a future session) to notice the reset has passed and manually restore `agent-ready` —
  the exact manual step the issue is trying to eliminate, just narrowed to "restore one
  label" instead of "diagnose, then clear two labels, then restore one."
- **Option B — build it now.** Add reconsideration logic to this spec. *Cost:* real new
  design surface this issue explicitly declined to specify — where the attempt counter
  lives (a label-encoded count? a sidecar file, matching this repo's existing sidecar-hash
  pattern? an issue-comment marker the countermand-list check would then need to parse?),
  how it composes with `drain-inbox.sh`'s OWN `quota_gate`/backoff cadence (which may
  already re-admit the whole `agent-ready` queue once its local `quota.json` reading shows
  the window reopened, in which case FR-6-style reconsideration might be solving a problem
  the drain's cycle-level gate already solves for free — unconfirmed, needs a read of
  `quota_gate`'s admit path against this specific scenario before designing on top of it).

Recommendation: **Option A.** The measured cost in the issue (three manual recovery
cycles) is eliminated by FR-1–FR-6 alone — the human no longer has to *diagnose* anything,
only to glance at a self-explanatory label once. Reconsideration is a genuine convenience
feature layered on top, not the fix for the reported defect, and bundling it risks
delaying the narrower, clearly-scoped fix on unresolved design questions.

### DQ-2 (scope boundary) — the creator-shepherd's own fix-agent call site

`shepherd_own_pr`'s fix-agent invocation (`scripts/dispatch-issue.sh:1762`, a SEPARATE
`claude -p` launch used to repair an already-opened PR's failing gate) has a structurally
similar shape — a `claude -p` call whose failure is handled generically — but it is not
named in #1656 and is not covered by this spec's FR/AC set.

- **Option A — out of scope (rec).** This spec's blast radius stays exactly what #1656
  named: the main build-dispatch crash branch. *Cost:* if the shepherd's fix-agent can also
  crash on quota (unconfirmed — not investigated for this spec), that call site keeps
  today's behaviour until a sibling issue covers it.
- **Option B — extend this spec** to cover the shepherd call site too. *Cost:* widens a T3
  spec answering a specifically-scoped bug report into a broader audit, without first
  confirming the shepherd path actually exhibits the same defect.

Recommendation: **Option A**, per this repo's own triage rule (CLAUDE.md: "detection ≠
integration," confirm-or-park rather than silently expand). If a human confirms the same
defect there, park it as a follow-up issue referencing this spec.

## Test

Matches the issue's own T3 regression spec:

1. A fixture log containing the session-limit line produces `agent-blocked-quota` and
   neither `agent-escalated` nor `needs-human-review`, and does not restore `agent-ready`
   (AC-1).
2. Negative: a log with `ESCALATE:` still takes the escalation path, including the DR-355
   opus retry (AC-2).
3. Negative: an unrecognised crash still takes the existing `:2005-2021` hold, unchanged
   (AC-3).
4. `dispatch-ready-check.sh` refuses re-readying an issue carrying `agent-blocked-quota`
   (AC-5).
5. A single shared-classifier assertion (AC-6) — e.g. both scripts' quota checks resolve to
   the same `require(...)` target — so the two can never silently diverge.

New test file (owned by this spec):
`packages/minspec/tests/dispatch-quota-classification.test.ts`.
