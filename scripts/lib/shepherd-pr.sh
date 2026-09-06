#!/usr/bin/env bash
# shepherd-pr.sh — SPEC-044 Slice 2: creator-owned PR shepherding (FR-4, FR-12, INV-5).
#
# The session that OPENED a PR drives it to merge, rather than handing it to the drain.
# Why: the drain's fresh remediator re-clones and starts near the context limit, which
# is the #912 crash-thrash outage. The creator still holds the WARM worktree + branch,
# so it re-drives its own PR without a re-clone and with a NON-exhausted fix agent
# (DR-067 D4). The drain is demoted to orphan-fallback in Slice 3.
#
# Honest scope (D4): the original build agent's in-context reasoning does NOT persist
# across invocations — the fix agent still re-reads the PR feedback and diff. What
# carries over is the warm worktree/branch and a fresh context budget.
#
# Security model — identical to dispatch-issue.sh / remediate-pr.sh, reused not
# re-implemented:
#   • the fix agent is CREDENTIAL-FREE (no gh / git push / remote). It edits + commits
#     locally only; THIS parent performs every credentialed op (INV-5).
#   • every credentialed step is gated by `issue-lease.sh verify-holds` (D3) — an owner
#     that was reclaimed mid-flight stands down instead of pushing.
#   • `ai-review:*` labels are NEVER mutated here — CI owns them (#600). We push; the
#     re-push re-triggers the reviewer.
#   • conflicts are SURFACED, never auto-resolved.
#
# One source of truth for "what is fixable": the action token comes from
# remediate-pr.sh's tested `--classify` seam (D4/D5) — this file never re-implements
# classify_pr.
#
# Testable pure seam (no gh/git/claude):
#   scripts/lib/shepherd-pr.sh --decide <action> <merged:yes|no> <holds:yes|no> \
#       <attempts> <max_attempts> <elapsed_secs> <max_secs> \
#       <checks_pending:yes|no> <automerge_armed:yes|no>
#     → prints ONE token: stop-merged | stand-down | stop-timeout | stop-not-automation
#       | stop-conflict | stop-capped | stop-awaiting-human | do-rebase | do-fix | wait
#       | wait-unknown | stop-unhandled-state
#     wait-unknown and stop-unhandled-state route classify_pr's two #1803 tokens
#     (retry-unknown, skip-unhandled-state — an UNKNOWN or unrecognised
#     mergeStateStatus). Each gets its OWN arm rather than falling through the `*)`
#     default: retry-unknown is transient (GitHub just hasn't finished computing the
#     state) and must not be reported as "outside automation scope", so it is a WAIT,
#     not a stop. skip-unhandled-state must not collapse into skip-clean's branch
#     either — that would silently re-introduce, one layer up, the exact
#     "unrecognised state treated as fine" shape #1803 closed in classify_pr.

set -euo pipefail

# Bounded-shepherd constants (FR-4). These bound only the POST-PR phase; the BUILD
# phase is bounded separately by LEASE_ABS_MAX_SECS (D10/FR-12) in issue-lease.sh.
SHEPHERD_MAX_SECS="${MINSPEC_SHEPHERD_MAX_SECS:-3600}"   # wall-clock ceiling for the whole loop
SHEPHERD_POLL_SECS="${MINSPEC_SHEPHERD_POLL_SECS:-60}"   # gap between PR state reads
SHEPHERD_MAX_ATTEMPTS="${MINSPEC_REMEDIATE_MAX_ATTEMPTS:-2}"  # shares the drain's cap vocabulary

# ── Pure decision seam ────────────────────────────────────────────────────────
# Ordering is load-bearing:
#   1. merged wins outright — a terminal, read-only observation; report it honestly
#      even if the claim has since moved.
#   2. holds=no ⇒ stand down BEFORE any credentialed op (D3). A reclaimed owner must
#      never push, arm auto-merge, or dispatch a fix agent.
#   3. the wall-clock ceiling (FR-4) — bound before electing more work.
#   4. then the classify_pr token decides the action.
shepherd_decide() {
  local action="$1" merged="$2" holds="$3" attempts="$4" max_attempts="$5" elapsed="$6" max_secs="$7"
  local checks_pending="${8:-no}" automerge_armed="${9:-no}"

  if [[ "$merged" == "yes" ]]; then
    echo "stop-merged"; return 0
  fi
  if [[ "$holds" != "yes" ]]; then
    echo "stand-down"; return 0
  fi
  if (( elapsed >= max_secs )); then
    echo "stop-timeout"; return 0
  fi

  case "$action" in
    skip-not-automation)
      # Never auto-drive a hand-crafted human PR.
      echo "stop-not-automation" ;;
    skip-conflict)
      # Surface only — a conflict is a human's merge decision, never auto-resolved.
      echo "stop-conflict" ;;
    rebase-only)
      echo "do-rebase" ;;
    agent-remediate-checks|agent-remediate-review)
      if (( attempts >= max_attempts )); then
        echo "stop-capped"
      else
        echo "do-fix"
      fi ;;
    skip-clean)
      # Nothing fixable, and unmerged is NOT success — so we never declare done here.
      # But whether to keep POLLING depends on whether anything asynchronous can still
      # change the outcome:
      #   • checks still running    ⇒ wait (a red check may yet appear)
      #   • auto-merge armed        ⇒ wait (GitHub will merge it without us)
      #   • neither                 ⇒ the only remaining gate is a HUMAN, and no amount
      #     of polling moves a human. Burning the full ceiling here would block the
      #     dispatch for an hour and then emit a "reached its ceiling" hand-off on a
      #     perfectly healthy PR — a self-contradicting false signpost. Exit honestly
      #     instead, and leave the PR to the gate that already labelled it.
      if [[ "$checks_pending" == "yes" || "$automerge_armed" == "yes" ]]; then
        echo "wait"
      else
        echo "stop-awaiting-human"
      fi ;;
    retry-unknown)
      # #1803/#1813: mergeStateStatus is (still) UNKNOWN — GitHub computes it lazily,
      # so this is routine right after a push, not evidence of a problem. It is NOT a
      # fixable problem (there is nothing for do-fix/do-rebase to act on) and it is
      # NOT "outside automation scope" (this IS an automation branch — the *)  default
      # below would say so falsely, which was the exact blocking review finding on
      # PR #1813). Keep polling; the wall-clock ceiling above already bounds this, so
      # there is no separate cap to add here.
      echo "wait-unknown" ;;
    skip-unhandled-state)
      # #1803/#1813: classify_pr saw a mergeStateStatus it doesn't recognise (BLOCKED,
      # UNSTABLE, HAS_HOOKS, or a future GitHub value). This must be its OWN arm:
      #   • NOT skip-clean's branch — that would silently claim "green, just waiting
      #     on checks/a human", re-introducing one layer up the exact "unrecognised
      #     state treated as fine" bug #1803 fixed in classify_pr itself.
      #   • NOT the *) default (stop-not-automation) — this PR IS in automation scope;
      #     the merge state is what's unfamiliar, not the branch.
      # Named honestly instead: this classifier does not know what this state means,
      # so it says so and stops polling rather than guessing either way.
      echo "stop-unhandled-state" ;;
    *)
      # Unknown token ⇒ fail closed: stop and leave it for a human rather than guess.
      echo "stop-not-automation" ;;
  esac
}

# ── Pure seam dispatch ────────────────────────────────────────────────────────
if [[ "${1:-}" == "--decide" ]]; then
  shift
  if [[ $# -ne 9 ]]; then
    echo "Usage: shepherd-pr.sh --decide <action> <merged> <holds> <attempts> <max_attempts> <elapsed_secs> <max_secs> <checks_pending> <automerge_armed>" >&2
    exit 2
  fi
  shepherd_decide "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9"
  exit 0
fi
