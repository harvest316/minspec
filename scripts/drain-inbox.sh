#!/usr/bin/env bash
# drain-inbox.sh — dispatch all ready issues in background
#   ready = `agent-ready` (full build) OR `agent-ready-specify` (auto-buildable
#   T3/T4 — Specify phase only; DR-076 / #1169)
#
# Called from session-start.sh hook so inbox work piggybacks onto active
# sessions without blocking the user. Each issue is dispatched sequentially
# (not in parallel) to respect subscription quota.
#
# Two scheduling modes share ONE dispatch cycle (triage inbox → dispatch every
# resulting agent-ready issue → sweep open PRs and auto-remediate fixable problems
# such as ai-review:changes, failing CI checks, or a branch behind main):
#   • one-shot   — run the cycle once and exit (the original behaviour; still the
#                  default for a MANUAL `scripts/drain-inbox.sh` invocation).
#   • continuous — repeat the cycle on an interval for as long as the launching
#                  Claude session is alive, so newly-arriving agent-ready work is
#                  drained opportunistically (#239). This is the default for the
#                  hook's `--auto` path. It is NOT a daemon: the loop is tied to
#                  the session process and self-terminates when the session ends
#                  (see "Session-lifetime tie" below). It is also quota-aware
#                  (#609): a Claude usage-limit signal pauses the loop and backs
#                  off until the window resets, instead of hard-failing.
#
# Usage:
#   scripts/drain-inbox.sh              # triage + dispatch ONCE now (manual)
#   scripts/drain-inbox.sh --dry-run    # report count, no dispatch
#   scripts/drain-inbox.sh --continuous # continuous loop, tied to THIS shell
#   scripts/drain-inbox.sh --once       # force a single cycle (opt out of loop)
#   scripts/drain-inbox.sh --enable-auto    # opt in: auto-drain every session start
#   scripts/drain-inbox.sh --disable-auto   # opt out
#   scripts/drain-inbox.sh --auto       # drain ONLY if opted in (the hook calls this)
#
# Testable decision seams (pure — no gh/git/claude; used by the loop + unit tests):
#   scripts/drain-inbox.sh --session-alive <pid>            # exit 0 alive / 1 gone
#   scripts/drain-inbox.sh --should-continue <pid> <epoch>  # exit 0 continue / 1 stop
#   scripts/drain-inbox.sh --is-quota   (<text on stdin)    # exit 0 quota / 1 not
#   scripts/drain-inbox.sh --resolve-session-pid            # print session anchor PID
#   scripts/drain-inbox.sh --quota-gate                     # exit 0 admit / 42 defer
#   scripts/drain-inbox.sh --quota-sleep                    # secs to wait for the window
#
# Env knobs (all optional):
#   MINSPEC_DRAIN_CONTINUOUS=0     — force pure one-shot even on --auto/--continuous
#                                    (the "keep it a one-shot" opt-out).
#   MINSPEC_DRAIN_INTERVAL=1200    — seconds between cycles (default 20 min).
#   MINSPEC_DRAIN_QUOTA_BACKOFF=1800 — seconds to pause after a quota signal (30 min).
#                  Now only a FALLBACK: when ~/.claude/quota.json carries a live
#                  reset time, the loop sleeps to that instead of guessing.
#   MINSPEC_QUOTA_FILE=~/.claude/quota.json — the published 5h window deadline.
#   MINSPEC_QUOTA_ADMIT_PCT=90     — defer a cycle at/above this %% of the window.
#   MINSPEC_QUOTA_STALE_SEC=900    — ignore a reading older than this (fails CLOSED — defers).
#   MINSPEC_QUOTA_BOOTSTRAP_ADMITS=3 — admits granted while NO reading has EVER existed,
#                                    before the gate refuses outright (#1775 bootstrap
#                                    carve-out; see quota_gate). 0 disables bootstrap
#                                    entirely (pure fail-closed on every unknown).
#   MINSPEC_DRAIN_POLL=30          — session-liveness poll granularity while waiting.
#   MINSPEC_DRAIN_MAX_LIFETIME=28800 — hard wall-clock cap on a loop (8 h backstop).
#   MINSPEC_DRAIN_MAX_FAILURES=3   — stop after N consecutive non-quota cycle errors.
#   MINSPEC_SESSION_PID=<pid>      — explicit session anchor (else auto-resolved).
#   MINSPEC_DRAIN_SELF_REFRESH=0   — run the pipeline in place from SCRIPT_DIR
#                                    instead of a self-synced run dir (#773 opt-out).
#   MINSPEC_DRAIN_GATED_FF=0       — disable the presence-gated sync step ENTIRELY
#                                    (DR-065): the early return precedes the fetch, so
#                                    neither the dormant-checkout fast-forward NOR the
#                                    read-only origin fetch runs.
#   MINSPEC_DRAIN_RUN_DIR=<path>   — where the self-synced run-dir worktree lives
#                                    (default /tmp/minspec-drain-run).
#
# Opt-in is the once-off permission gate (#239): set it once with --enable-auto,
# then the session-start hook drains automatically thereafter. The pref lives in
# .minspec/auto-drain (gitignored — machine-local, never inherited by teammates).
#
# ── Session-lifetime tie (how the continuous loop dies WITH the session) ──────
# The loop runs in a backgrounded, `disown`ed subshell so it outlives the fast
# session-start hook (the hook must return immediately, it cannot block on a
# long-running loop). `disown` means no SIGHUP reaches it, and being reparented
# to init keeps it running — so it is NOT killed for free. What makes it die with
# the session is an EXPLICIT liveness poll, not process-tree luck:
#   1. Before forking, the FOREGROUND resolves SESSION_PID — the Claude Code
#      session process (comm=claude), which is an ancestor of this hook and lives
#      exactly as long as the session (normal close, crash, or kill all end it).
#      Resolution walks up from $PPID; it must happen in the foreground while that
#      ancestry is still intact (after the fork+disown the loop is reparented and
#      $PPID no longer points at the session).
#   2. The disowned loop polls `kill -0 $SESSION_PID` every MINSPEC_DRAIN_POLL
#      seconds (both between cycles and before each cycle). When the session
#      process is gone the poll fails and the loop exits within one poll interval.
#      => no orphaned daemon survives the session.
#   3. Backstop: a hard MINSPEC_DRAIN_MAX_LIFETIME cap bounds the loop even in the
#      pathological case where the anchor PID is stale/reused, so termination is
#      GUARANTEED, never merely best-effort.

set -euo pipefail

REPO="AIClarityAU/minspec"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The reconcilers below write to GitHub (close, remove-label, add-label). Those are
# AGENT writes, so they must carry the App identity rather than the human's — a write
# made as the human auto-subscribes them to the thread forever and makes the audit
# trail record a person as having done what the drain did (minspec#995, #1355). Arming
# the wrapper once here covers every `gh` call in the process: reads pass through
# untouched, and the first WRITE mints a bot token or aborts.
# shellcheck source=scripts/lib/gh-bot.sh
source "${SCRIPT_DIR}/lib/gh-bot.sh"
gh_bot_init
# Env-overridable for the same reason as MINSPEC_DRAIN_PRIMARY_ROOT below: the
# #1208 concurrency harness points it at a hermetic stub so the fan-out can be
# proven to actually overlap without launching real build agents.
DISPATCH="${MINSPEC_DRAIN_DISPATCH:-${SCRIPT_DIR}/dispatch-issue.sh}"
TRIAGE="${SCRIPT_DIR}/triage-inbox.sh"
REMEDIATE="${SCRIPT_DIR}/remediate-pr.sh"
PREF_FILE="$(cd "${SCRIPT_DIR}/.." && pwd)/.minspec/auto-drain"
# Single source of truth for the quota/transient classifier (tested JS, shared
# with review-branch.sh via decideReviewCheck's isQuotaExhaustion). scripts/ is a
# sibling of .github/scripts/. Reused, never re-implemented — bash and JS must not
# drift on what counts as a session-limit signal.
GUARD="${SCRIPT_DIR}/../.github/scripts/ai-review-guard.js"
DRY_RUN=false
CONTINUOUS=false
# Default lock/log paths; env-overridable so hermetic tests can point them at a
# temp dir instead of the shared /tmp file (behaviour is identical otherwise).
LOCK="${MINSPEC_DRAIN_LOCK:-/tmp/minspec-drain-inbox.lock}"
LOG="${MINSPEC_DRAIN_LOG:-/tmp/minspec-drain-inbox.log}"

# ── Self-refreshing run directory (#773) ─────────────────────────────────────
# The drain is launched from the SHARED primary checkout, which goes stale as main
# advances (rule #8 forbids pulling it) — and auto-merge makes main advance faster.
# The old behaviour self-TERMINATED on staleness (rc 43 → loop exit), so the drain
# died and auto-fix/dispatch never ran. Instead, each cycle runs the pipeline
# scripts from a DEDICATED worktree hard-synced to origin/main: fresh by
# construction, self-healing, and NEVER touching the primary's HEAD/working tree
# (rule #8). Overridable for tests; opt out with MINSPEC_DRAIN_SELF_REFRESH=0.
DRAIN_RUN_DIR="${MINSPEC_DRAIN_RUN_DIR:-/tmp/minspec-drain-run}"
# The shared checkout the drain runs from — the root whose .minspec/sessions/ the
# presence gate reads. Env-overridable so the FR-14 parity harness (and unit tests)
# can point it at a hermetic fixture without a full git clone.
PRIMARY_ROOT="${MINSPEC_DRAIN_PRIMARY_ROOT:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || (cd "${SCRIPT_DIR}/.." && pwd))}"

# ── Continuous-loop tunables (env-overridable) ───────────────────────────────
INTERVAL="${MINSPEC_DRAIN_INTERVAL:-1200}"           # 20 min between cycles
QUOTA_BACKOFF="${MINSPEC_DRAIN_QUOTA_BACKOFF:-1800}"  # 30 min pause on a quota hit
POLL="${MINSPEC_DRAIN_POLL:-30}"                     # liveness-poll granularity
MAX_LIFETIME="${MINSPEC_DRAIN_MAX_LIFETIME:-28800}"  # 8 h hard cap (backstop)
MAX_CONSEC_FAIL="${MINSPEC_DRAIN_MAX_FAILURES:-3}"   # stop after N straight errors

# ── 5-hour quota window: admission control against a DEADLINE ────────────────
# The statusline publishes {used_percentage, resets_at, observed_at} to
# ~/.claude/quota.json on every render. We consume it to answer one question
# before spending anything: is there enough window left to finish a cycle?
#
# The failure this prevents is NOT "a cycle gets interrupted mid-flight". It is a
# cycle ADMITTED into a window too small to finish, which then dies having spent
# everything and produced nothing. Measured instance: a two-agent fan-out started
# near the wall burned 317,898 tokens across 111 tool calls and returned nothing.
#
# Deliberately a DEADLINE, never a paused/unpaused flag. A flag needs someone to
# clear it, which needs a resume signal, which is read on the very channel the
# pause is meant to gate — so it is acted on after the condition already flipped
# (the loop tries to pause exactly when it should be resuming). An epoch needs
# nobody: we compare `now` to resets_at right here, at the moment it matters, and
# the gate opens because time passed. There is no resume path to get wrong.
#
# Fails CLOSED on every unknown — missing, stale, unparseable, or no jq (#1775,
# reversing this gate's original fail-OPEN design). A reading we do not have
# must never read as permission to spend a build agent's quota; it always
# names WHICH unknown, because a silent throttle is indistinguishable from a
# quiet week (constitution invariant 2: no silent gate).
#
# The one carve-out is BOOTSTRAP, not fail-open: a machine that has NEVER once
# produced a reading is a different state from one whose signal went missing or
# stale, because the only reactive producer for a headless/VS Code machine
# (quota_publish_wall, below) fires from INSIDE a dispatch that fail-closed
# would otherwise prevent from ever running — a permanent deadlock, not caution.
# See QUOTA_BOOTSTRAP_ADMITS and quota_gate's "no reading" arm for the small,
# explicit, one-time allowance and its worst case.
QUOTA_FILE="${MINSPEC_QUOTA_FILE:-$HOME/.claude/quota.json}"
QUOTA_ADMIT_PCT="${MINSPEC_QUOTA_ADMIT_PCT:-90}"     # defer at/above this % used
QUOTA_ADMIT_PCT_7D="${MINSPEC_QUOTA_ADMIT_PCT_7D:-95}"  # same, for the WEEKLY window.
# Deliberately higher than the 5h bar: a 5h window reopens within hours, so deferring is
# cheap, but the weekly window can be days out and blocking that long is far worse than
# spending the tail of it. The 7d ceiling is invisible in the 5h reading and can bind
# FIRST — 5h at 30% while 7d sits at 61% is a real observed state.
QUOTA_STALE_SEC="${MINSPEC_QUOTA_STALE_SEC:-900}"    # older reading proves nothing
QUOTA_SLEEP_MAX="${MINSPEC_QUOTA_SLEEP_MAX:-21600}"  # 6 h clamp vs a corrupt epoch
QUOTA_SLEEP_MIN="${MINSPEC_QUOTA_SLEEP_MIN:-60}"     # never spin
QUOTA_SLEEP_MARGIN="${MINSPEC_QUOTA_SLEEP_MARGIN:-15}"  # settle past the boundary

# The bootstrap allowance (see quota_gate's "no reading" arm, below). Default 3
# matches this file's other small-and-bounded defaults (MAX_CONSEC_FAIL, the
# autocompact ac_halt) — not a magic number, a reused convention. Sidecar
# defaults next to QUOTA_FILE so it inherits the same per-environment isolation
# (tests point MINSPEC_QUOTA_FILE at a fresh tmp dir; production writes beside
# ~/.claude/quota.json, which is already writable by the statusline).
QUOTA_BOOTSTRAP_ADMITS="${MINSPEC_QUOTA_BOOTSTRAP_ADMITS:-3}"
QUOTA_BOOTSTRAP_FILE="${MINSPEC_QUOTA_BOOTSTRAP_FILE:-${QUOTA_FILE}.bootstrap}"

# Dispatch fan-out (#1208). Default 1 = the historical strictly-sequential walk,
# byte-for-byte: parallelism is OPT-IN, never inherited. >1 dispatches up to N
# issues concurrently, which is what turns spare quota into backlog throughput —
# wall-clock, not budget, is the binding constraint on a serial drain.
#
# Safe because SPEC-044/DR-067 already built the concurrency invariants and the
# serial loop simply never exercised them: a per-item flock (D11/FR-11),
# claim-unique worktree paths ${BASE}/issue-N-<sessionId> (D11/INV-7, the fix for
# the R7 shared-directory corruption), the PR-per-head CAS, and the D12 sequential
# gate where at-most-one-merge across time actually rests. A racer that loses any
# of those stands down cleanly (exit 0) rather than colliding.
#
# NOT solved here, and deliberately so: two queued issues that touch the SAME file
# still produce competing PRs, because each agent branches from origin/main and
# cannot see an unmerged sibling. That is true serially too (it is just slower to
# hit), so it is tracked separately rather than pretended away — keep the default
# at 1 until same-file serialisation exists, and de-duplicate the queue first.
# (assigned below, once _validated_concurrency is defined)

# ── Pure decision helpers (no gh/git/claude — safe to unit-test in isolation) ──

# _validated_concurrency <raw>: echo a usable fan-out width. A malformed or absurd
# value FAILS SAFE to 1 and says so on stderr — a silently-ignored knob would be a
# gate that lies about what it is doing. Capped at 8: past that the box, not the
# model, is the bottleneck, and every extra racer multiplies worktree disk churn.
_validated_concurrency() {
  local raw="${1-}"
  if [[ ! "$raw" =~ ^[1-9][0-9]*$ ]]; then
    [[ -n "$raw" && "$raw" != "1" ]] && \
      echo "[drain] WARNING: MINSPEC_DRAIN_CONCURRENCY='${raw}' is not a positive integer — falling back to 1." >&2
    echo 1; return 0
  fi
  if (( raw > 8 )); then
    echo "[drain] WARNING: MINSPEC_DRAIN_CONCURRENCY=${raw} exceeds the cap of 8 — using 8." >&2
    echo 8; return 0
  fi
  echo "$raw"
}

# _breaker_decide <halt> <outcomes-csv>: the autocompact circuit-breaker, made a
# pure function so concurrency cannot quietly weaken it (#912/#1203 — it has now
# caught a REAL systemic outage twice, so it must stay honest).
#
# Serially the rule was "N consecutive thrashed dispatches". Under fan-out
# "consecutive" is ill-defined, so the rule becomes "the last N COMPLETIONS were
# all thrash", ordered by completion. For width 1 the two are identical, which is
# why the default path keeps exactly its old meaning. Outcomes are `1` (thrash) /
# `0` (not), oldest first. halt=0 disables the breaker.
_breaker_decide() {
  local halt="${1:-3}" csv="${2-}"
  [[ "$halt" == "0" ]] && { echo continue; return 0; }
  local -a o=(); IFS=',' read -r -a o <<<"$csv"
  local n=${#o[@]}
  (( n < halt )) && { echo continue; return 0; }
  local i
  for (( i = n - halt; i < n; i++ )); do
    [[ "${o[$i]}" == "1" ]] || { echo continue; return 0; }
  done
  echo halt
}

DISPATCH_CONCURRENCY="$(_validated_concurrency "${MINSPEC_DRAIN_CONCURRENCY:-1}")"

# is_quota: read combined agent output on stdin; exit 0 iff it is a quota /
# rate-limit / overload / retry signal (a transient, NOT-your-code condition).
# Delegates to the SAME tested classifier review-branch.sh uses, so the two never
# drift. If node/guard is somehow absent, treat as NOT quota (conservative → a
# real crash is never mistaken for a retryable limit).
is_quota() {
  [[ -f "$GUARD" ]] || return 1
  GUARD="$GUARD" node -e 'const g=require(process.env.GUARD);let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(g.isQuotaExhaustion(s)?0:1));' 2>/dev/null
}

# session_alive <pid>: exit 0 while the session process is alive, 1 once it is
# gone. `kill -0` sends no signal — it only probes existence/permission.
session_alive() { kill -0 "${1:?session_alive needs a pid}" 2>/dev/null; }

# ── Session-presence reader (SPEC-026 FR-4 / the sync gate) ────────────────────
# These shell constants MUST equal presence.ts HEARTBEAT_SECS / STALE_SECS
# (SPEC-026 FR-3/FR-14). threshold = 4 × heartbeat. Change BOTH or neither — the
# golden-fixture parity test (FR-14 family) fails on drift.
PRESENCE_HEARTBEAT_SECS=30                 # MUST equal presence.ts HEARTBEAT_SECS
PRESENCE_STALE_SECS=120                    # MUST equal presence.ts STALE_SECS (= 4 × PRESENCE_HEARTBEAT_SECS)
SESSIONS_DIR_REL=".minspec/sessions"

# checkout_occupied <checkout_root>
#   exit 0 → OCCUPIED (fail-safe): caller stays fetch-only.
#   exit 1 → PROVABLY DORMANT: caller may fast-forward.
# Mirrors presence.ts isCheckoutOccupied EXACTLY (jq-free, grep/sed per the FR-12
# hook idiom; parses the atomic pretty-printed records, one field per line).
# FAIL-SAFE: missing dir / empty / unreadable / unparseable / date/kill error ⇒
# exit 0. Positive dormancy = (≥1 LIVE record ANYWHERE) AND (0 live records for
# this root). "Nobody demonstrably live" is treated as occupied, not ff-able.
# Each session writes into ITS OWN worktree's .minspec/sessions/ (presence.ts
# writeHeartbeat), NOT the primary's — so BOTH conditions scan EVERY worktree's own
# sessions dir. Reading only PRIMARY_ROOT would miss a live on-main sibling and ff
# a live tree (PR #846). Enumerate worktrees via `git worktree list --porcelain`;
# ALWAYS include PRIMARY_ROOT; dedup by canonical path; git failure ⇒ just primary.
checkout_occupied() {
  local target now f body wt seen pid seen_epoch age wt_canon root sdir wt_line p pcanon
  local live_total=0 claims=0
  local -a roots=() files=()
  local seen_roots=" "
  target="$(readlink -m -- "${1:?checkout_occupied needs a root}" 2>/dev/null || echo "$1")"
  now="$(date -u +%s 2>/dev/null)" || return 0

  # Collect every worktree root (canonical, deduped), ALWAYS including PRIMARY_ROOT.
  while IFS= read -r wt_line; do
    p="${wt_line#worktree }"
    [[ -n "$p" ]] || continue
    pcanon="$(readlink -m -- "$p" 2>/dev/null || echo "$p")"
    [[ "$seen_roots" == *" $pcanon "* ]] && continue
    seen_roots+="$pcanon "
    roots+=( "$pcanon" )
  done < <(git -C "$PRIMARY_ROOT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  pcanon="$(readlink -m -- "$PRIMARY_ROOT" 2>/dev/null || echo "$PRIMARY_ROOT")"
  [[ "$seen_roots" == *" $pcanon "* ]] || roots+=( "$pcanon" )   # ALWAYS include primary

  # Gather *.session.json across EVERY worktree's own sessions dir.
  shopt -s nullglob
  for root in "${roots[@]}"; do
    sdir="${root}/${SESSIONS_DIR_REL}"
    [[ -d "$sdir" ]] || continue
    files+=( "$sdir"/*.session.json )
  done
  shopt -u nullglob
  (( ${#files[@]} > 0 )) || return 0                            # no records anywhere ⇒ occupied

  for f in "${files[@]}"; do
    body="$(cat "$f" 2>/dev/null)" || return 0
    wt="$(  sed -n 's/.*"worktreeRoot"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$body" | head -n1)"
    seen="$(sed -n 's/.*"lastSeen"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'     <<<"$body" | head -n1)"
    pid="$( sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p'      <<<"$body" | head -n1)"
    [[ -n "$wt" && -n "$seen" && -n "$pid" ]] || return 0      # malformed ⇒ occupied
    seen_epoch="$(date -u -d "$seen" +%s 2>/dev/null)" || return 0
    [[ -n "$seen_epoch" ]] || return 0
    age=$(( now - seen_epoch ))
    (( age < PRESENCE_STALE_SECS )) || continue                # stale ⇒ dead
    kill -0 "$pid" 2>/dev/null      || continue                # pid gone ⇒ dead
    live_total=$(( live_total + 1 ))
    wt_canon="$(readlink -m -- "$wt" 2>/dev/null || echo "$wt")"
    [[ "$wt_canon" == "$target" ]] && claims=$(( claims + 1 ))
  done
  (( live_total > 0 )) || return 0     # nobody demonstrably live ⇒ occupied
  (( claims == 0 )) && return 1        # dormant → safe to ff
  return 0                             # a live peer claims it ⇒ occupied
}

# sync_shared_checkouts (#168 / DR-051 §4a; reconciles "keep checkouts current"
# with rule #8 "never mutate a live session's tree"). For EACH checkout git tracks,
# ff to origin/<default> ONLY when ALL hold; else fetch-only:
#   G1 on the default branch (HEAD == main) — never touch a feature-branch WIP tree
#   G2 content-clean (`git status --porcelain` empty) — no WIP to stomp
#   G3 NOT presence-occupied (checkout_occupied → exit 1: provably dormant)
#   G4 a TRUE fast-forward (HEAD is an ancestor of origin/<default>) — never a
#      merge commit, never reset/rebase (no commit/WIP loss).
# Fetch is read-only (never moves HEAD) ⇒ always safe, runs unconditionally.
# FAIL-SAFE: any doubt (occupied / dirty / off-main / diverged / git error) ⇒
# fetch-only. Skipped ff ⇒ stale checkout (harmless, retried); wrong ff ⇒ live-WIP
# corruption (unrecoverable). Kill-switch MINSPEC_DRAIN_GATED_FF=0.
sync_shared_checkouts() {
  [[ "${MINSPEC_DRAIN_GATED_FF:-1}" == "0" ]] && return 0
  local db origin_ref root head_sha origin_sha base
  # `|| true` inside the substitution: under `set -euo pipefail` an unset origin/HEAD
  # makes symbolic-ref exit 128, which would otherwise abort the whole drain.
  db="$(git -C "$PRIMARY_ROOT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
  db="${db:-main}"                                   # origin/HEAD often unset locally → main
  origin_ref="origin/${db}"
  # GIT_TERMINAL_PROMPT=0: this loop is disowned/background — a checkout without
  # cached credentials must fail fast, never block the cycle on a hidden prompt.
  GIT_TERMINAL_PROMPT=0 git -C "$PRIMARY_ROOT" fetch origin "$db" -q 2>/dev/null || true   # read-only; safe on occupied trees
  origin_sha="$(git -C "$PRIMARY_ROOT" rev-parse "$origin_ref" 2>/dev/null)" || return 0
  [[ -n "$origin_sha" ]] || return 0

  git -C "$PRIMARY_ROOT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' \
  | while IFS= read -r root; do
      [[ -n "$root" && -d "$root" ]] || continue
      # never touch the drain's own detached run-dir (hard-reset elsewhere)
      [[ "$(readlink -m -- "$root" 2>/dev/null)" == "$(readlink -m -- "$DRAIN_RUN_DIR" 2>/dev/null)" ]] && continue
      [[ "$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)" == "$db" ]] || continue   # G1
      [[ -z "$(git -C "$root" status --porcelain 2>/dev/null)" ]] || continue                   # G2
      checkout_occupied "$root" && continue                                                     # G3 (occupied ⇒ skip)
      head_sha="$(git -C "$root" rev-parse HEAD 2>/dev/null)" || continue
      [[ "$head_sha" == "$origin_sha" ]] && continue          # already current
      base="$(git -C "$root" merge-base HEAD "$origin_ref" 2>/dev/null)" || continue
      [[ "$base" == "$head_sha" ]] || continue                # G4: diverged (local commits) ⇒ skip, never reset
      git -C "$root" merge --ff-only "$origin_ref" -q 2>/dev/null \
        && echo "[drain] fast-forwarded DORMANT checkout $root → ${origin_ref} (${origin_sha:0:7})." \
        || echo "[drain] WARNING: ff of $root refused by git — left as-is (fetch-only)." >&2
    done || true   # never let the loop pipeline's exit status trip `set -e`
  return 0
}

# resolve_session_pid: print the PID of the Claude Code session that (transitively)
# launched us, so the loop can watch it. MUST be called in the FOREGROUND, before
# any fork/disown, while $PPID still chains up to the session. Prefers an explicit
# MINSPEC_SESSION_PID; else walks up the process tree to the nearest `claude`
# ancestor; else falls back to $PPID (a manual run's own shell — so a hand-started
# continuous drain still dies with the terminal that launched it).
resolve_session_pid() {
  if [[ -n "${MINSPEC_SESSION_PID:-}" ]] && kill -0 "${MINSPEC_SESSION_PID}" 2>/dev/null; then
    printf '%s' "$MINSPEC_SESSION_PID"; return 0
  fi
  local pid="$PPID" guard=0 comm args
  while [[ -n "$pid" && "$pid" != "0" && "$pid" != "1" && "$guard" -lt 20 ]]; do
    comm="$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' \t' || true)"
    args="$(ps -o args= -p "$pid" 2>/dev/null || true)"
    if [[ "$comm" == *claude* || "$args" == *claude-code* || "$args" == *anthropic.claude* ]]; then
      printf '%s' "$pid"; return 0
    fi
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' \t' || true)"
    guard=$((guard + 1))
  done
  printf '%s' "$PPID"
  return 0
}

# ensure_fresh_run_dir (#773): guarantee the pipeline scripts we run this cycle are
# CURRENT, by maintaining a dedicated worktree hard-synced to origin/main and
# repointing TRIAGE/DISPATCH/REMEDIATE at ITS copies. This replaces the old
# terminal "die on staleness" (rc 43) with self-healing: staleness is impossible by
# construction because we resync every cycle.
#
# RULE #8 SAFETY (load-bearing): every git op targets an EXPLICIT dir via `-C`.
# `git -C "$PRIMARY_ROOT" fetch` is read-only (never moves HEAD). `git worktree add`
# creates a SEPARATE worktree — it does not switch the primary's branch. `git -C
# "$DRAIN_RUN_DIR" reset --hard` acts on the RUN DIR only. NONE of these touch the
# shared primary checkout's HEAD or working tree, so concurrent sessions are safe.
#
# Fails OPEN, never fatal: if the worktree can't be created/synced (git/network),
# it logs and falls back to the in-place SCRIPT_DIR scripts (whose own #481 guard
# then applies) — the loop keeps going and retries next cycle. Opt out entirely
# with MINSPEC_DRAIN_SELF_REFRESH=0 (runs in place, pre-#773 behaviour).
ensure_fresh_run_dir() {
  [[ "${MINSPEC_DRAIN_SELF_REFRESH:-1}" == "0" ]] && return 0
  [[ -z "$DRAIN_RUN_DIR" ]] && { echo "[drain] WARNING: MINSPEC_DRAIN_RUN_DIR is empty — self-refresh disabled, running in place." >&2; return 0; }

  # SAFETY (rule #8): the run dir must resolve OUTSIDE the primary checkout — we
  # hard-reset and may remove it. CANONICALIZE both paths first (readlink -m resolves
  # symlinks + `..`/`.`/`//` without requiring existence), so a run dir symlinked or
  # relatively-pointed INTO the primary cannot slip past a purely-lexical compare
  # (#773 review, BLOCKING). Require absolute too.
  local run_canon primary_canon
  run_canon="$(readlink -m -- "$DRAIN_RUN_DIR" 2>/dev/null || echo "$DRAIN_RUN_DIR")"
  primary_canon="$(readlink -m -- "$PRIMARY_ROOT" 2>/dev/null || echo "$PRIMARY_ROOT")"
  case "$run_canon" in
    "$primary_canon"|"$primary_canon"/*)
      echo "[drain] WARNING: MINSPEC_DRAIN_RUN_DIR ('$DRAIN_RUN_DIR' → '$run_canon') is inside the primary checkout — self-refresh disabled, running in place." >&2
      return 0 ;;
    /*) : ;;  # absolute, outside primary — ok
    *)  echo "[drain] WARNING: MINSPEC_DRAIN_RUN_DIR ('$DRAIN_RUN_DIR') must be an absolute path — self-refresh disabled." >&2
        return 0 ;;
  esac

  GIT_TERMINAL_PROMPT=0 git -C "$PRIMARY_ROOT" fetch origin main -q 2>/dev/null || true

  # (Re)create the worktree if it is missing or not a usable checkout. Use git's own
  # worktree removal (not a blind rm) to unregister a stale/broken one; only rm a
  # leftover path when it is NOT a populated checkout, so we never nuke real content.
  if [[ ! -e "${DRAIN_RUN_DIR}/scripts/drain-inbox.sh" ]]; then
    git -C "$PRIMARY_ROOT" worktree remove --force "$DRAIN_RUN_DIR" 2>/dev/null || true
    git -C "$PRIMARY_ROOT" worktree prune 2>/dev/null || true
    [[ -e "$DRAIN_RUN_DIR" && ! -d "${DRAIN_RUN_DIR}/scripts" ]] && rm -rf "$DRAIN_RUN_DIR" 2>/dev/null || true
    if ! git -C "$PRIMARY_ROOT" worktree add --detach "$DRAIN_RUN_DIR" origin/main 2>/dev/null; then
      echo "[drain] WARNING: could not create run-dir worktree at $DRAIN_RUN_DIR — running in place (SCRIPT_DIR)." >&2
      return 0
    fi
  fi

  # DEFENSE IN DEPTH (rule #8): even past the lexical guard, refuse to reset/repoint if
  # git reports the run dir IS the primary working tree (a symlink/bind that fooled the
  # path compare). The reset below must never touch the primary.
  local run_toplevel
  run_toplevel="$(git -C "$DRAIN_RUN_DIR" rev-parse --show-toplevel 2>/dev/null || echo '')"
  if [[ -z "$run_toplevel" || "$(readlink -m -- "$run_toplevel" 2>/dev/null || echo "$run_toplevel")" == "$primary_canon" ]]; then
    echo "[drain] WARNING: run dir resolves to the primary checkout — self-refresh disabled (rule #8), running in place." >&2
    return 0
  fi

  # Hard-sync to origin/main — the self-heal. On any git error we do NOT trust the run
  # dir (see the verify-before-repoint below); we never die.
  git -C "$DRAIN_RUN_DIR" reset --hard origin/main -q 2>/dev/null \
    || echo "[drain] WARNING: could not resync run-dir to origin/main." >&2

  # node/tsx helpers (render-review-signals.mjs, auto-merge-gate.ts) need the
  # workspace's hoisted modules; symlink the primary's so children resolve without a
  # per-cycle install. HONEST CAVEAT (#773 review, minor): this uses the primary's
  # COMPILED deps — including @aiclarity/shared's gitignored `out/` — which can lag
  # origin/main's source. Those helpers are best-effort and degrade if it mismatches
  # (the render block is skipped, not corrupted), so the staleness is accepted, not fatal.
  [[ -d "${PRIMARY_ROOT}/node_modules" ]] \
    && ln -sfn "${PRIMARY_ROOT}/node_modules" "${DRAIN_RUN_DIR}/node_modules" 2>/dev/null || true
  [[ -d "${PRIMARY_ROOT}/packages/minspec/node_modules" ]] \
    && ln -sfn "${PRIMARY_ROOT}/packages/minspec/node_modules" "${DRAIN_RUN_DIR}/packages/minspec/node_modules" 2>/dev/null || true

  # VERIFY the run dir is ACTUALLY at origin/main before trusting it (#773 review,
  # MAJOR). Only then repoint children + tell them freshness is validated. If the reset
  # failed (e.g. a leftover index.lock from a killed prior cycle left the run dir
  # behind), do NOT export MINSPEC_FRESHNESS_CHECKED — fall back to in-place so each
  # child's own #481 guard fires instead of silently running STALE orchestration.
  local run_head origin_head
  run_head="$(git -C "$DRAIN_RUN_DIR" rev-parse HEAD 2>/dev/null || echo 'norun')"
  origin_head="$(git -C "$PRIMARY_ROOT" rev-parse origin/main 2>/dev/null || echo 'noorigin')"
  if [[ "$run_head" == "$origin_head" && -x "${DRAIN_RUN_DIR}/scripts/dispatch-issue.sh" ]]; then
    TRIAGE="${DRAIN_RUN_DIR}/scripts/triage-inbox.sh"
    DISPATCH="${DRAIN_RUN_DIR}/scripts/dispatch-issue.sh"
    REMEDIATE="${DRAIN_RUN_DIR}/scripts/remediate-pr.sh"
    export MINSPEC_FRESHNESS_CHECKED=1
    echo "[drain] run dir verified at origin/main (${run_head:0:7}) — pipeline scripts are current."
  else
    echo "[drain] WARNING: run dir NOT verified at origin/main (run=${run_head:0:7} origin=${origin_head:0:7}) — running in place; children re-check freshness (#481)." >&2
  fi
  return 0
}

# run_cycle: ONE drain pass = triage inbox → dispatch every resulting agent-ready
# issue → sweep open PRs and remediate fixable problems, all sequentially. Return
# code drives the
# continuous loop's scheduling (it is ignored by the one-shot path):
#   0  — cycle completed (work done or nothing ready).
#   42 — a Claude quota/limit signal was seen mid-dispatch → loop should back off.
#   1  — a transient error → loop counts it toward MAX_CONSEC_FAIL, keeps going.
# (There is no longer a terminal "stale" code: #773 self-heals the run dir each
#  cycle instead of stopping the loop when the checkout falls behind main.)
# ── Step 0 reconcilers (#1306, #1322) ────────────────────────────────────────
#
# Every other label transition in this system is written OPTIMISTICALLY at the moment
# an action starts or finishes, and nothing ever checks it again. That is why the
# board drifted so far from reality: on 2026-08-06 it showed EIGHT agents running
# when exactly one was, two of the claims three weeks old (#663, #627), and two
# issues (#1067, #1068) sat open and queued with their work already merged.
#
# These two functions are the missing second half — they compare the labels against
# something observable (a live process, a merged PR) and correct the difference. They
# are reconcilers, not gates: they never block a cycle, and every failure degrades to
# "leave the label alone", because a reconciler that guesses wrong is worse than one
# that does nothing.

# How long an `agent-running` claim may sit before it is considered orphaned. Deliberately
# well above the absolute claim lifetime so a slow-but-live dispatch is never reaped.
RECONCILE_CLAIM_STALE_SECS="${MINSPEC_RECONCILE_STALE_SECS:-21600}"   # 6 h

# Epoch seconds when `agent-running` was most recently applied to <issue>, or empty.
# The timeline is the only honest source: `updatedAt` moves on any activity at all.
claim_applied_at() {
  local iso
  iso=$(gh api "repos/${REPO}/issues/$1/timeline" --paginate \
    --jq '[.[] | select(.event=="labeled" and .label.name=="agent-running") | .created_at] | last // empty' \
    2>/dev/null | tail -1) || return 1
  [[ -n "$iso" ]] || return 1
  date -u -d "$iso" +%s 2>/dev/null || return 1
}

# Is a dispatch process for <issue> actually running? Anchored on the argument so
# `dispatch-issue.sh 88` cannot match issue 885, and matched against the process
# table rather than any string this script builds, so it cannot match itself.
dispatch_alive_for() {
  # `pgrep -f` matches with ERE, NOT BRE. In ERE `\+`, `\(`, `\|` and `\)` are the
  # LITERAL characters +, (, | and ) — a BRE-escaped pattern here matches nothing at
  # all, which reads exactly like "no dispatch is running" and silently kills this
  # witness (#1352). Keep these unescaped; `\.` is correct in both dialects.
  pgrep -f "dispatch-issue\.sh[[:space:]]+$1([[:space:]]|$)" >/dev/null 2>&1
}

# #1306 — release `agent-running` claims that no dispatch is holding.
# TWO independent witnesses must agree before anything is touched: the claim is older
# than the stale threshold AND no live dispatch process exists for it. Either one alone
# could be wrong (a long build looks old; pgrep cannot see a dispatch on another host),
# so requiring both means the reaper fails toward leaving the claim in place.
reconcile_stale_claims() {
  local running n applied age
  running=$(gh issue list --repo "$REPO" --state open --label "agent-running" \
    --json number --jq '.[].number' 2>/dev/null || true)
  [[ -n "$running" ]] || return 0

  while read -r n; do
    [[ -n "$n" ]] || continue
    if dispatch_alive_for "$n"; then continue; fi          # witness 2: genuinely live
    applied=$(claim_applied_at "$n") || {
      echo "[drain] reconcile: #$n carries agent-running but its claim time is unreadable — leaving it alone (failing toward no-op)."
      continue
    }
    age=$(( $(date -u +%s) - applied ))
    (( age >= RECONCILE_CLAIM_STALE_SECS )) || continue    # witness 1: genuinely old
    echo "[drain] reconcile: releasing orphaned agent-running on #$n (claimed ${age}s ago, no live dispatch) — #1306."
    gh issue edit "$n" --repo "$REPO" --remove-label "agent-running" 2>/dev/null \
      || echo "[drain] reconcile: could not release the claim on #$n — it stays as-is."
  done <<< "$running"
}

# #1628 — was <issue>'s most recent `reopened` event LATER than its most recent
# `closed` event? A reopen after an automated close is the strongest signal
# available that the close's inference was wrong: a human or agent looked at the
# conclusion and rejected it. Reuses the exact `gh api .../timeline --paginate`
# shape `claim_applied_at` above already relies on — REST timeline events carry
# `.event` ("closed"/"reopened"/…) and `.created_at`, both proven-working here
# already, rather than guessing at `gh issue view --json timelineItems`'s GraphQL
# field/type-discriminator shape untested elsewhere in this script. `.created_at`
# is ISO-8601 zero-padded UTC, so it sorts correctly as a plain string — no date
# parsing needed. Fails toward "no veto" (never blocks a close) so an API hiccup
# degrades to #1322's pre-#1628 behavior rather than wedging every candidate open
# forever.
reopened_after_close() {
  local n="$1" verdict
  # NOTE: the `// ""` fallbacks are deliberately an empty STRING, not jq's `empty`
  # generator — `last` on a filtered-to-nothing array is `null`, and `null // empty`
  # produces ZERO output values, which makes the `as $r`/`as $c` bindings run zero
  # times and the whole filter print nothing at all (silently, for the exact "never
  # reopened" case this function exists to rule out as a veto). `// ""` keeps the
  # binding real so the trailing `if` always runs and always prints yes/no.
  verdict=$(gh api "repos/${REPO}/issues/$1/timeline" --paginate \
    --jq '([.[] | select(.event=="reopened") | .created_at] | last // "") as $r
          | ([.[] | select(.event=="closed") | .created_at] | last // "") as $c
          | if ($r != "" and ($c == "" or $r > $c)) then "yes" else "no" end' \
    2>/dev/null) || return 1
  [[ "$verdict" == "yes" ]]
}

# #1322 — an OPEN issue stamped `agent-done` is a contradiction. Resolve it against
# the one observable fact that settles it: did the work actually land?
#
#   merged PR on agent/issue-<N>  → a branch named for the issue merged; close it,
#                                   citing the PR — but only if the issue's history
#                                   doesn't already contain a human's rejection of
#                                   that exact inference (#1628 reopen veto below).
#   no merged PR                  → `agent-done` is unearned. Strip it and surface,
#                                   because "we recorded completion but nothing
#                                   merged" is a real failure a human should see.
#
# The second branch is the valuable one: it is the only check anywhere that would
# catch a FALSE agent-done. Branch naming is deterministic (the dispatcher creates
# `agent/issue-<N>`), so the join needs no heuristics.
#
# #1628: the close branch used to leave `agent-done` in place, so a reopened issue
# landed straight back in the `--label agent-done` selector above and was re-closed
# on the next cycle — forever, with the identical comment, no matter how many times
# a human corrected it. Two independent fixes here: (a) strip the label on the close
# path too, so the two branches are symmetric about label hygiene; (b) skip closing
# outright when the issue's own history shows a reopen after the last close — that
# is a standing human veto on the merged-branch inference, and re-deriving the same
# conclusion from the same branch state on every cycle cannot see it otherwise.
reconcile_done_issues() {
  local done_issues n pr
  done_issues=$(gh issue list --repo "$REPO" --state open --label "agent-done" \
    --json number --jq '.[].number' 2>/dev/null || true)
  [[ -n "$done_issues" ]] || return 0

  while read -r n; do
    [[ -n "$n" ]] || continue
    pr=$(gh pr list --repo "$REPO" --state merged --head "agent/issue-${n}" \
      --json number --jq '.[0].number // empty' 2>/dev/null || true)
    if [[ -n "$pr" ]]; then
      if reopened_after_close "$n"; then
        echo "[drain] reconcile: skipping #$n — it was reopened after a prior automated close, which vetoes the merged-branch inference; a human or agent rejected this exact conclusion once already (#1628). Leaving agent-done in place for a human to clear."
        continue
      fi
      echo "[drain] reconcile: closing #$n — a branch named for it, agent/issue-${n}, merged in #$pr and nothing ever closed it (#1322)."
      if gh issue close "$n" --repo "$REPO" \
        --comment "Closed by the drain reconciler: a branch named for this issue, \`agent/issue-${n}\`, merged in #${pr}. That is an observation, not a verification that the issue's full scope is covered — a branch can merge having done only part of the work. If this doesn't fully cover the issue, reopen it; a reopen is treated as a veto and this reconciler will not re-close it (#1628). See #1322 for the root cause and the deterministic \`Closes #N\` trailer that prevents the guess going forward." \
        2>/dev/null; then
        gh issue edit "$n" --repo "$REPO" --remove-label "agent-done" 2>/dev/null \
          || echo "[drain] reconcile: closed #$n but could not strip agent-done — it may re-select next cycle unless the reopen veto (#1628) catches it first."
      else
        echo "[drain] reconcile: could not close #$n — left open."
      fi
    else
      echo "[drain] reconcile: #$n is labelled agent-done but NO merged PR exists for agent/issue-${n} — stripping the stamp and surfacing (#1322)."
      gh issue edit "$n" --repo "$REPO" \
        --remove-label "agent-done" --add-label "needs-human-review" 2>/dev/null \
        || echo "[drain] reconcile: could not correct #$n — left as-is."
    fi
  done <<< "$done_issues"
}

# Never fatal: a reconciler exists to reduce drift, and must not become a new way for
# a cycle to die. Failures are reported, then the cycle proceeds.
reconcile_labels() {
  reconcile_stale_claims || echo "[drain] reconcile: stale-claim pass errored — continuing."
  reconcile_done_issues  || echo "[drain] reconcile: agent-done pass errored — continuing."
}

run_cycle() {
  local inbox_issues all_ready n out drc cap
  local ac_halt ac_sig
  local quota_verdict

  # Admission control: never START a cycle the quota window cannot finish. This
  # runs before ensure_fresh_run_dir so a deferred cycle costs nothing at all —
  # no git, no gh, no dispatch. Returning 42 reuses the existing quota-pause arm
  # in run_loop, which sleeps and retries rather than counting a failure.
  if ! quota_verdict=$(quota_gate); then
    echo "[drain] $quota_verdict"
    return 42
  fi

  # #773: refresh the run dir FIRST, so triage/dispatch/remediate all execute the
  # CURRENT orchestration (self-heal, not die-on-stale). Never fatal — on failure it
  # falls back to in-place scripts and the cycle proceeds.
  ensure_fresh_run_dir

  # Keep USER-FACING dormant shared checkouts current (gated; #168 / DR-051 §4a).
  # Runs every one-shot AND every continuous-loop iteration, which is the whole
  # requirement — it is deliberately AFTER ensure_fresh_run_dir so #773's "refresh
  # before dispatching" guarantee stays literal. The two are independent: the run
  # dir is hard-reset by ensure_fresh_run_dir and is explicitly excluded from the
  # sync loop, so neither can observe the other's effect. Never mutates a live
  # session's tree — fail-safe toward fetch-only.
  sync_shared_checkouts

  # Step 0: reconcile the label board against observable reality (#1306, #1322).
  # Runs BEFORE triage so a cycle never enumerates a queue it already knows is wrong.
  reconcile_labels

  # Step 1: triage inbox issues → labels T1/T2 as agent-ready
  inbox_issues=$(gh issue list --repo "$REPO" --label "inbox" \
    --json number --jq '.[].number' 2>/dev/null || true)
  if [[ -n "$inbox_issues" ]]; then
    echo "[drain] triaging $(echo "$inbox_issues" | wc -l | tr -d ' ') inbox issue(s)..."
    for n in $inbox_issues; do
      echo "[drain] triaging #$n..."
      "$TRIAGE" "$n" || echo "[drain] WARNING: triage failed for #$n"
    done
  fi

  # Step 2: drain whatever is now dispatchable (original + newly triaged).
  #
  # BOTH ready classes (#1169): `agent-ready` (full build) and `agent-ready-specify`
  # (auto-buildable T3/T4 — Specify phase only, DR-076). Two separate `gh issue list`
  # calls because `--label A --label B` is an AND, not an OR: one combined call would
  # silently return the empty intersection and the specify queue would never drain —
  # a verdict nothing dispatches is just a differently-shaped backlog. Which mode each
  # issue runs in is decided by dispatch-issue.sh from the VERDICT RECORD, never from
  # the label that put it in this list (#983).
  all_ready=$(
    {
      gh issue list --repo "$REPO" --label "agent-ready" \
        --json number --jq '.[].number' 2>/dev/null || true
      gh issue list --repo "$REPO" --label "agent-ready-specify" \
        --json number --jq '.[].number' 2>/dev/null || true
    } | sort -un
  )
  if [[ -z "$all_ready" ]]; then
    echo "[drain] no agent-ready / agent-ready-specify issues after triage — cycle done."
    return 0
  fi

  # Freshness is guaranteed by ensure_fresh_run_dir at the top of this cycle (#773):
  # the pipeline scripts run from a worktree hard-synced to origin/main, and
  # MINSPEC_FRESHNESS_CHECKED is exported so the children trust it. No terminal
  # "die on stale" (the old rc-43 path) — staleness is impossible by construction.

  # ── Autocompact circuit-breaker (#912) ──────────────────────────────────────
  # Failure mode this guards: EVERY dispatched build agent dies with the autocompact
  # context-thrash signature (a systemically-broken dispatch path — e.g. a bloated
  # ambient context, a bad model pin), so the drain burns quota escalating the whole
  # agent-ready queue to zero PRs. Count CONSECUTIVE dispatches whose output carries
  # the signature; after N in a row (MINSPEC_DISPATCH_AUTOCOMPACT_HALT, default 3),
  # HALT dispatch for the REST of this cycle and alert loudly instead of grinding
  # through every remaining issue. A dispatch that does NOT show the signature resets
  # the run to 0, so a one-off blip never trips it. The PR sweep (Step 3) still runs.
  # Threshold 0 disables the breaker; the signature is overridable in case the
  # harness reworks the wording (MINSPEC_DISPATCH_AUTOCOMPACT_SIG).
  ac_halt="${MINSPEC_DISPATCH_AUTOCOMPACT_HALT:-3}"
  ac_sig="${MINSPEC_DISPATCH_AUTOCOMPACT_SIG:-Autocompact is thrashing}"
  ac_consec=0

  echo "[drain] dispatching $(echo "$all_ready" | wc -l | tr -d ' ') agent-ready issue(s) (concurrency=${DISPATCH_CONCURRENCY})..."

  # `ac_outcomes` is the breaker's completion-ordered history for this cycle: `1`
  # per dispatch that carried the thrash signature, `0` otherwise. Both paths below
  # append to it and both ask the SAME pure `_breaker_decide`, so widening the fan-out
  # can never quietly weaken the gate that has already caught two real outages.
  local ac_outcomes=""

  # classify_dispatch <issue> <rc> <output>: shared post-processing for one finished
  # dispatch. Prints "<thrash><quota>" as two digits. It must RETURN both verdicts
  # rather than set a variable: every call site runs it inside `$(...)`, which is a
  # SUBSHELL, so an assignment made in here would be discarded and the quota pause
  # would silently never fire. Reads the TEXT, never the exit code — dispatch-issue.sh
  # exits 0 even on a quota-blocked claude run.
  classify_dispatch() {
    local n="$1" drc="$2" out="$3" thrash=0 quota=0
    if is_quota <<<"$out"; then
      quota=1
      # Publish the deadline the wall message carries. This is the only producer that
      # fires on a machine whose sessions never render a statusline — without it the
      # loop falls back to guessing 1800s. Advisory: a parse failure is not an error
      # here, it just leaves the fallback in place. Safe in this subshell because it
      # writes a file rather than setting a variable.
      quota_publish_wall <<<"$out" >/dev/null 2>&1 || true
    fi
    [[ "$drc" -ne 0 ]] && echo "[drain] WARNING: dispatch failed for #$n (rc=$drc)" >&2
    if [[ "$ac_halt" != "0" ]] && grep -qiF -- "$ac_sig" <<<"$out"; then
      echo "[drain] ⚠️  dispatch #$n crashed with the autocompact context-thrash signature — see #912." >&2
      thrash=1
    fi
    printf '%s%s' "$thrash" "$quota"
  }

  announce_halt() {
    echo "[drain] 🛑 HALTING dispatch for the rest of this cycle: the last ${ac_halt} dispatches to COMPLETE all crashed with '${ac_sig}'." >&2
    echo "[drain]     The dispatched build agent is starting near the context limit — refusing to burn more quota on a broken path (#912)." >&2
    echo "[drain]     Tune/disable with MINSPEC_DISPATCH_AUTOCOMPACT_HALT=<N> (0 disables). PR remediation (Step 3) still runs." >&2
  }

  local saw_quota=0 verdict=""

  if (( DISPATCH_CONCURRENCY <= 1 )); then
    # ── Serial path — the historical behaviour, unchanged. Output still streams
    # LIVE through `tee`, which matters for a multi-minute build: a captured-then-
    # dumped block would leave the log silent while work is happening.
    for n in $all_ready; do
      echo "[drain] dispatching #$n..."
      cap=$(mktemp)
      if "$DISPATCH" "$n" 2>&1 | tee "$cap"; then drc=0; else drc=$?; fi
      out=$(cat "$cap" 2>/dev/null || true); rm -f "$cap"
      verdict="$(classify_dispatch "$n" "$drc" "$out")"
      ac_outcomes="${ac_outcomes:+$ac_outcomes,}${verdict:0:1}"
      [[ "${verdict:1:1}" == "1" ]] && saw_quota=1
      if (( saw_quota )); then
        echo "[drain] Claude usage-limit signal while dispatching #$n — pausing this cycle (will back off, not fail)."
        return 42
      fi
      [[ "$(_breaker_decide "$ac_halt" "$ac_outcomes")" == "halt" ]] && { announce_halt; break; }
    done
  else
    # ── Parallel path (#1208) — launch up to N, reap as they finish.
    # Each job tees to its own capture file AND to a per-issue prefixed stream, so
    # concurrent builds stay live AND readable instead of interleaving anonymously.
    local -A pid_issue=() pid_cap=()
    local -a queue=($all_ready)
    local qi=0 stop_launching=0 p rc n out qv

    launch_next() {
      local n="${queue[$qi]}"; qi=$(( qi + 1 ))
      local cap; cap=$(mktemp)
      echo "[drain] dispatching #$n... (in flight: $(( ${#pid_issue[@]} + 1 ))/${DISPATCH_CONCURRENCY})"
      ( "$DISPATCH" "$n" 2>&1 | tee "$cap" | sed -u "s/^/[#${n}] /" ) &
      local pid=$!
      pid_issue[$pid]="$n"; pid_cap[$pid]="$cap"
    }

    while (( qi < ${#queue[@]} || ${#pid_issue[@]} > 0 )); do
      while (( ! stop_launching && qi < ${#queue[@]} && ${#pid_issue[@]} < DISPATCH_CONCURRENCY )); do
        # Admission control per LAUNCH, not just per cycle. A fan-out can outlive
        # the window it started in, and an agent begun near the wall dies partway
        # having spent everything — the expensive failure this whole gate exists
        # to prevent. Re-checking here costs one local file read per launch.
        if ! qv=$(quota_gate); then
          echo "[drain] $qv — holding the rest of the queue for the window."
          saw_quota=1; stop_launching=1
          break
        fi
        launch_next
      done
      (( ${#pid_issue[@]} == 0 )) && break

      # Reap exactly one finished job. `wait -n -p` needs bash 5.1+; `|| rc=$?` keeps
      # a failed child from tripping `set -e`.
      p=""; rc=0
      wait -n -p p || rc=$?
      [[ -z "$p" ]] && continue
      n="${pid_issue[$p]:-}"; [[ -z "$n" ]] && continue
      out=$(cat "${pid_cap[$p]}" 2>/dev/null || true); rm -f "${pid_cap[$p]}"
      unset 'pid_issue[$p]' 'pid_cap[$p]'

      verdict="$(classify_dispatch "$n" "$rc" "$out")"
      ac_outcomes="${ac_outcomes:+$ac_outcomes,}${verdict:0:1}"
      [[ "${verdict:1:1}" == "1" ]] && saw_quota=1

      # A quota signal or a tripped breaker stops us LAUNCHING more, but never
      # abandons work already in flight — an orphaned build would hold its claim
      # until the TTL lapsed and leave a worktree behind.
      if (( saw_quota )) && (( ! stop_launching )); then
        echo "[drain] Claude usage-limit signal while dispatching #$n — draining ${#pid_issue[@]} in-flight build(s), then pausing this cycle."
        stop_launching=1
      fi
      if (( ! stop_launching )) && [[ "$(_breaker_decide "$ac_halt" "$ac_outcomes")" == "halt" ]]; then
        announce_halt; stop_launching=1
      fi
    done

    (( saw_quota )) && return 42
  fi

  # Step 3: sweep open PRs for FIXABLE problems and auto-remediate them (conflicts
  # are surfaced, not touched). remediate-pr.sh owns ALL the decision-making —
  # branch-prefix scope, classification, attempt caps — so the drain stays thin and
  # there is ONE source of truth for what "fixable" means. We only enumerate open,
  # non-draft PRs and hand each to it; a clean/out-of-scope PR self-skips cheaply
  # (one gh fetch, no agent). Disable with MINSPEC_DRAIN_REMEDIATE_PRS=0.
  if [[ "${MINSPEC_DRAIN_REMEDIATE_PRS:-1}" != "0" ]]; then
    local open_prs pr rcap rout
    open_prs=$(gh pr list --repo "$REPO" --state open --json number,isDraft \
      --jq '.[] | select(.isDraft==false) | .number' 2>/dev/null || true)
    if [[ -n "$open_prs" ]]; then
      echo "[drain] sweeping $(echo "$open_prs" | wc -l | tr -d ' ') open PR(s) for fixable problems..."
      for pr in $open_prs; do
        # Same quota discipline as dispatch: remediation may launch claude, which
        # exits 0 even under a usage limit — the signal is in the OUTPUT. Capture
        # + classify; a quota hit pauses the whole cycle (loop backs off).
        rcap=$(mktemp)
        "$REMEDIATE" "$pr" 2>&1 | tee "$rcap" || true
        rout=$(cat "$rcap" 2>/dev/null || true); rm -f "$rcap"
        if is_quota <<<"$rout"; then
          echo "[drain] Claude usage-limit signal while remediating PR #$pr — pausing this cycle (will back off, not fail)."
          return 42
        fi
      done
    fi
  fi

  echo "[drain] cycle done."
  return 0
}

# _quota_bootstrap_count: bootstrap admits already granted at QUOTA_BOOTSTRAP_FILE
# (0 if the file is absent/unparseable — never fatal, matches every other reader
# in this file). Once a real reading has ever been observed, _quota_read (below)
# pins this at QUOTA_BOOTSTRAP_ADMITS forever, so it reads as "exhausted" even if
# QUOTA_BOOTSTRAP_FILE itself is later lost — re-derived from empty by design.
_quota_bootstrap_count() {
  local n
  n=$(cat "$QUOTA_BOOTSTRAP_FILE" 2>/dev/null || true)
  [[ "$n" =~ ^[0-9]+$ ]] && printf '%s\n' "$n" || printf '0\n'
}

# _quota_bootstrap_consume <want>: try to persist that <want> admits have now been
# granted. Write-then-VERIFY, not fire-and-forget: if the sidecar can't be written
# (read-only dir, full disk), the count never advances and every future call keeps
# recomputing the same low <want> — the allowance only ever shrinks on a write
# failure, never grows past QUOTA_BOOTSTRAP_ADMITS. Returns 1 on a failed/unverified
# write so the caller can refuse to admit rather than hand out an admit it cannot
# remember granting (which would be unbounded, not bootstrap).
_quota_bootstrap_consume() {
  local want="$1" tmp
  tmp="${QUOTA_BOOTSTRAP_FILE}.$$.tmp"
  # Braced so 2>/dev/null covers a FAILED redirect too (e.g. the dir doesn't
  # exist): bash reports that error on the original stderr before a trailing
  # `2>/dev/null` on the same simple command ever takes effect, so an unbraced
  # `printf ... > "$tmp" 2>/dev/null` still leaks "No such file or directory".
  { printf '%s\n' "$want" > "$tmp" && mv -f "$tmp" "$QUOTA_BOOTSTRAP_FILE"; } 2>/dev/null \
    || { rm -f "$tmp" 2>/dev/null; return 1; }
  [[ "$(_quota_bootstrap_count)" == "$want" ]]
}

# _quota_bootstrap_graduate: called the instant _quota_read observes a REAL reading
# (below). Pins the counter at the cap so bootstrap can never reopen for this
# QUOTA_FILE — including later, if that reading goes missing or stale again. That
# "signal lost" state is exactly what #1775's fail-closed protects; bootstrap only
# ever covers "never had a signal at all". Best-effort: a failed write here just
# means the next successful read tries again, which self-heals as soon as the
# sidecar is writable — it can only delay graduation, never un-graduate.
_quota_bootstrap_graduate() {
  local tmp="${QUOTA_BOOTSTRAP_FILE}.$$.tmp"
  # See _quota_bootstrap_consume above for why this is braced before 2>/dev/null.
  { printf '%s\n' "$QUOTA_BOOTSTRAP_ADMITS" > "$tmp" && mv -f "$tmp" "$QUOTA_BOOTSTRAP_FILE"; } 2>/dev/null \
    || rm -f "$tmp" 2>/dev/null
  return 0
}

# _quota_read: print "<pct_int> <resets_at> <observed_at> <7d_pct> <7d_resets_at>", or
# fail if there is no usable reading. Every caller treats failure as "unknown" and
# proceeds. The two weekly fields are -1 when the producer could not see that window.
_quota_read() {
  [[ -r "$QUOTA_FILE" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  local raw p r o wp wr
  # 7d fields are OPTIONAL: only some producers can see the weekly window, so their
  # absence is normal and must not invalidate the 5h reading. Missing → -1 → ignored.
  raw=$(jq -r '[(.used_percentage//empty),(.resets_at//empty),(.observed_at//empty),
                (.seven_day_percentage//-1),(.seven_day_resets_at//-1)] | @tsv' \
        "$QUOTA_FILE" 2>/dev/null) || return 1
  IFS=$'\t' read -r p r o wp wr <<<"$raw"
  [[ -n "$p" && -n "$r" && -n "$o" ]] || return 1
  # A real reading exists: retire the bootstrap allowance for good (see
  # _quota_bootstrap_graduate). Runs on EVERY successful read, not just quota_gate's,
  # so quota_health/quota_sleep_secs graduate it just as fast.
  _quota_bootstrap_graduate
  # Truncate any fractional part: these are fed to integer arithmetic below.
  printf '%s %s %s %s %s\n' "${p%%.*}" "${r%%.*}" "${o%%.*}" "${wp%%.*}" "${wr%%.*}"
}

# quota_gate: exit 0 = admit, 42 = defer. Prints the verdict AND its reason, so a
# deferral is never silent. An UNKNOWN budget (no reading, or a stale one) DEFERS
# rather than admits — a missing or expired witness must read as "hold", never as
# permission to spend a build agent's quota (constitution invariant 2; #1775). 42
# is deliberate: run_loop already treats it as "pause, not a failure", so admission
# control needs no new branch — a denied cycle here is a sleep-and-retry, not an
# outage.
#
# The "no reading" arm below is NOT plain fail-closed — it is fail-closed WITH a
# bounded bootstrap carve-out (see QUOTA_BOOTSTRAP_ADMITS above). Plain fail-closed
# deadlocks a machine that has never produced a reading: quota_publish_wall (the
# only reactive producer on a headless/VS Code machine) fires from INSIDE a
# dispatch, and this gate runs BEFORE every dispatch — so a machine that starts
# with no reading and no external poller would defer every cycle forever, and the
# one producer that could break the tie would never get to run. The allowance
# grants up to QUOTA_BOOTSTRAP_ADMITS admits (default 3) while _quota_read has
# NEVER once succeeded at this path, then refuses outright and names what to
# install.
#
# WORST CASE while blind: up to QUOTA_BOOTSTRAP_ADMITS admitted decisions, each
# with the SAME blast radius as any ordinary admitted cycle (this allowance does
# not widen what one admit can do, only how many blind ones are handed out). In
# the default serial dispatch mode (DISPATCH_CONCURRENCY=1) that means up to
# QUOTA_BOOTSTRAP_ADMITS cycles, each free to dispatch the ENTIRE agent-ready
# backlog with no further quota check until a real usage-limit hit ends it — no
# different from any single legitimately-admitted cycle today. In parallel mode
# (DISPATCH_CONCURRENCY>1), quota_gate is re-consulted per LAUNCH (see the
# `qv=$(quota_gate)` call in run_cycle's parallel path), so the allowance caps at
# exactly QUOTA_BOOTSTRAP_ADMITS concurrent launches before the rest of the queue
# holds for the window.
quota_gate() {
  local vals p r o wp wr now
  now=$(date +%s)
  if ! vals=$(_quota_read); then
    local bc="$(_quota_bootstrap_count)"
    if (( bc < QUOTA_BOOTSTRAP_ADMITS )) && _quota_bootstrap_consume "$(( bc + 1 ))"; then
      echo "open:bootstrap $(( bc + 1 ))/${QUOTA_BOOTSTRAP_ADMITS} (no reading has ever existed at $QUOTA_FILE — admitting a bounded bootstrap cycle so the drain can reach a first reading; install a quota producer before this allowance runs out)"
      return 0
    fi
    echo "defer:no-reading (no usable $QUOTA_FILE, and the ${QUOTA_BOOTSTRAP_ADMITS}-admit bootstrap allowance is exhausted or unrecordable — refusing to run further blind. Install a quota producer: run a session whose statusline renders on this machine, or pipe a wall message into '$0 --quota-publish-wall'.)"
    return 42
  fi
  read -r p r o wp wr <<<"$vals"
  if (( now - o > QUOTA_STALE_SEC )); then
    echo "defer:stale (reading is $(( now - o ))s old, limit ${QUOTA_STALE_SEC}s, $QUOTA_FILE — holding until refreshed)"
    return 42
  fi
  # The WEEKLY ceiling is checked before anything to do with the 5h window, because the
  # two are INDEPENDENT: the 5h window turning over does not refill the weekly one. This
  # ordering is load-bearing — when the weekly check sat below the window-reset return,
  # a fresh reading whose 5h window had just reset was admitted with the weekly window
  # exhausted, which is precisely the wall this gate exists to prevent. It was reachable
  # on every single wake: sleep to the 5h reset, wake, get admitted, hit the weekly wall.
  if (( wp >= 0 )) && (( wp >= QUOTA_ADMIT_PCT_7D )); then
    if (( wr > now )); then
      echo "defer:$(( wr - now )) (7d window ${wp}% used — the WEEKLY ceiling, resets in $(( (wr - now + 3599) / 3600 )) h)"
    else
      echo "defer:$QUOTA_SLEEP_MAX (7d window ${wp}% used — the WEEKLY ceiling, no usable reset time)"
    fi
    return 42
  fi
  if (( r <= now )); then
    echo "open:window-reset (resets_at already passed — proceeding)"
    return 0
  fi
  if (( p >= QUOTA_ADMIT_PCT )); then
    echo "defer:$(( r - now )) (5h window ${p}% used, resets in $(( (r - now + 59) / 60 )) min)"
    return 42
  fi
  echo "open:${p}% of the 5h window used"
  return 0
}

# quota_sleep_secs: how long to wait for the window, from the PUBLISHED reset
# rather than a fixed guess. Falls back to QUOTA_BACKOFF when there is no usable
# deadline, and is clamped both ways so a corrupt epoch can neither spin the loop
# nor park it for a week.
quota_sleep_secs() {
  local vals p r o wp wr now secs=""
  now=$(date +%s)
  if vals=$(_quota_read); then
    read -r p r o wp wr <<<"$vals"
    if (( now - o <= QUOTA_STALE_SEC )); then
      # Sleep toward whichever window is actually BINDING. When the weekly ceiling is
      # what deferred us, the 5h reset is the wrong deadline — it can be minutes away
      # while the weekly window is days out, so the loop would wake, re-defer, and
      # report "sleeping to the published reset" while sleeping to an irrelevant one.
      if (( wp >= 0 )) && (( wp >= QUOTA_ADMIT_PCT_7D )) && (( wr > now )); then
        secs=$(( wr - now + QUOTA_SLEEP_MARGIN ))
      elif (( r > now )); then
        secs=$(( r - now + QUOTA_SLEEP_MARGIN ))
      fi
    fi
  fi
  [[ -n "$secs" ]] || secs="$QUOTA_BACKOFF"
  (( secs < QUOTA_SLEEP_MIN )) && secs="$QUOTA_SLEEP_MIN"
  (( secs > QUOTA_SLEEP_MAX )) && secs="$QUOTA_SLEEP_MAX"
  printf '%d\n' "$secs"
}

# quota_health: one line, once per loop, saying whether admission control is actually
# SEEING DATA. A STALE reading, or a MISSING one whose bootstrap allowance is
# exhausted, correctly HOLDS the gate shut (defers every cycle, #1775) rather than
# admitting blind — but that hold is still uninformed, not weighing a real usage
# number, just refusing on principle until one exists. A MISSING reading with
# bootstrap admits still available is a THIRD state, distinct from both: not yet
# failing closed, still admitting blind on a small bounded budget (see
# QUOTA_BOOTSTRAP_ADMITS / quota_gate). An inert gate and a healthy one still look
# identical from the outside otherwise (constitution invariant 2: no silent gate).
# This is the difference between installed and adopted: say out loud when the gate
# cannot see anything, and which of the three states it is actually in — never
# consumes a bootstrap admit itself, this only READS the counter (_quota_bootstrap_count).
quota_health() {
  local vals p r o wp wr now
  now=$(date +%s)
  if ! vals=$(_quota_read); then
    local bc; bc=$(_quota_bootstrap_count)
    if (( bc < QUOTA_BOOTSTRAP_ADMITS )); then
      echo "inert: no reading at $QUOTA_FILE — admission control is BLIND but NOT YET FAILING CLOSED: bootstrap allowance ${bc}/${QUOTA_BOOTSTRAP_ADMITS} recorded, and the gate still attempts a bounded blind admit until it is exhausted, a real reading appears, or $QUOTA_BOOTSTRAP_FILE turns out to be unwritable (an attempt that can't be recorded is refused rather than granted uncounted — this reports the counter, not writability). Install a quota producer before it runs out."
    else
      echo "inert: no reading at $QUOTA_FILE, and the ${QUOTA_BOOTSTRAP_ADMITS}-admit bootstrap allowance is exhausted — admission control is BLIND and HOLDING (failing closed). Install a quota producer: run a session whose statusline renders on this machine, or pipe a wall message into '--quota-publish-wall'."
    fi
    return 0
  fi
  read -r p r o wp wr <<<"$vals"
  if (( now - o > QUOTA_STALE_SEC )); then
    echo "inert: reading is $(( (now - o) / 60 )) min old (limit $(( QUOTA_STALE_SEC / 60 )) min) — admission control is BLIND and HOLDING (failing closed) at $QUOTA_FILE."
    return 0
  fi
  if (( wp >= 0 )); then
    echo "live: 5h window ${p}% used, resets in $(( (r - now) / 60 )) min; 7d window ${wp}% used."
  else
    echo "live: 5h window ${p}% used, resets in $(( (r - now) / 60 )) min (no weekly reading)."
  fi
}

# quota_publish_wall: the REACTIVE producer, reading the wall message on stdin.
#
# The statusline publisher only runs when a statusline RENDERS. VS Code and headless
# sessions never render one, so on those machines nothing is ever published — and this
# producer only ever fires from INSIDE a dispatch (classify_dispatch calls it after a
# dispatch reports a usage-limit hit). On a machine that has never had a reading, that
# is exactly what quota_gate's bootstrap allowance exists to unblock: without it, no
# dispatch could ever run, so this producer could never run either — a permanent
# deadlock, not a hold (#1775 review, BLOCKING). The bootstrap allowance is small and
# self-exhausting (QUOTA_BOOTSTRAP_ADMITS); once it runs out with still no reading, the
# gate HOLDS every cycle closed for real, loud not invisible: quota_gate prints why on
# every deferred cycle. This is the reading that is always available once a dispatch
# CAN run: it arrives at the exact moment the window is exhausted.
#
# It is strictly worse than the statusline reading (no percentage, so no PREDICTIVE
# admission — only the deadline) but it needs no credentials and makes no network call,
# and it is what turns the backoff from a blind 1800s guess into a real deadline.
#
# The message carries a clock time and a zone but NO DATE, so the rollover is inferred:
# a time already past today means tomorrow.
#
# MULTI-PRODUCER NOTE — do not "fix" this into a bug. More than one producer writes
# QUOTA_FILE (a statusline render, this wall parser, and a poller). Last-writer-wins is
# correct in BOTH directions here, but by convergence rather than by design:
#   • at a wall hit this writes 100, which is true and beats any older live reading;
#   • ~10 min later a poller overwrites it with a real level, which is also true,
#     because a wall reading is a point measurement that never decays on its own.
# Making the wall reading STICKY — e.g. suppressing refresh until resets_at — would
# pin the level at 100 for hours and starve the queue long after the window reopened.
# The staleness rule, not stickiness, is what keeps a wall reading from being believed
# forever.
quota_publish_wall() {
  local text clock zone target now
  text=$(cat)
  # e.g. "You've hit your session limit · resets 10:10pm (Australia/Sydney)"
  clock=$(printf '%s' "$text" | grep -oiE 'resets[[:space:]]+(at[[:space:]]+)?[0-9]{1,2}(:[0-9]{2})?[[:space:]]*(am|pm)' | head -1 \
          | grep -oiE '[0-9]{1,2}(:[0-9]{2})?[[:space:]]*(am|pm)' | head -1)
  [[ -n "$clock" ]] || { echo "no reset time in text" >&2; return 1; }
  zone=$(printf '%s' "$text" | grep -oE '\([A-Za-z]+/[A-Za-z_]+\)' | head -1 | tr -d '()')

  now=$(date +%s)
  if [[ -n "$zone" ]]; then
    target=$(TZ="$zone" date -d "$clock" +%s 2>/dev/null)
  else
    target=$(date -d "$clock" +%s 2>/dev/null)
  fi
  [[ -n "$target" ]] || { echo "could not parse '$clock'" >&2; return 1; }
  # No date in the message: a time already gone means tomorrow.
  (( target <= now )) && target=$(( target + 86400 ))

  # At the wall the window is spent by definition. 100 makes every consumer defer,
  # which is exactly right until the deadline passes.
  local tmp="${QUOTA_FILE}.$$.tmp"
  mkdir -p "$(dirname "$QUOTA_FILE")" 2>/dev/null
  printf '{"used_percentage":100,"resets_at":%s,"observed_at":%s,"source":"wall"}\n' \
    "$target" "$now" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$QUOTA_FILE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  echo "published:$target (from the wall message, resets $clock${zone:+ $zone})"
}

# quota_backoff_sleep: the rc=42 rest. Sleeps to the deadline; wait_interval still
# bails the moment the session dies, so a multi-hour wait stays interruptible.
quota_backoff_sleep() {
  local secs
  secs=$(quota_sleep_secs)
  echo "[drain] quota window exhausted — sleeping ${secs}s, to the published reset rather than a guess."
  wait_interval "$secs"
}

# wait_interval <seconds>: sleep in POLL-sized chunks, bailing the moment the
# session dies so the loop reacts within MINSPEC_DRAIN_POLL, not a whole interval.
wait_interval() {
  local remaining="$1" chunk
  while (( remaining > 0 )); do
    session_alive "$SESSION_PID" || return 0
    chunk=$(( remaining < POLL ? remaining : POLL ))
    sleep "$chunk"
    remaining=$(( remaining - chunk ))
  done
}

# run_loop: the session-scoped continuous scheduler. Repeats run_cycle until the
# session ends, the wall-clock cap is hit, freshness fails persistently, or too
# many consecutive cycle errors accrue. Quota signals pause-and-retry; a single
# cycle error never kills the loop (log + continue).
run_loop() {
  local deadline consec=0 rc
  deadline=$(( $(date +%s) + MAX_LIFETIME ))
  echo "[drain] continuous loop started (session=$SESSION_PID, interval=${INTERVAL}s, quota_backoff=${QUOTA_BACKOFF}s, max_lifetime=${MAX_LIFETIME}s)."
  echo "[drain] quota gate — $(quota_health)"
  while :; do
    if ! session_alive "$SESSION_PID"; then
      echo "[drain] session $SESSION_PID ended — stopping loop (drain dies with the session)."; break
    fi
    if (( $(date +%s) >= deadline )); then
      echo "[drain] max lifetime (${MAX_LIFETIME}s) reached — stopping loop (backstop cap)."; break
    fi

    rc=0; run_cycle || rc=$?
    case "$rc" in
      0)
        consec=0
        wait_interval "$INTERVAL"
        ;;
      42)
        # Quota window exhausted (#609): pause, do NOT count as a failure, and
        # keep probing — the window resets on its own and the next cycle resumes.
        consec=0
        quota_backoff_sleep
        ;;
      *)
        consec=$((consec + 1))
        echo "[drain] cycle error (rc=$rc) — ${consec}/${MAX_CONSEC_FAIL} consecutive."
        if (( consec >= MAX_CONSEC_FAIL )); then
          echo "[drain] $consec consecutive cycle errors — stopping loop cleanly (likely a persistent auth/config failure, not transient)."
          break
        fi
        wait_interval "$INTERVAL"
        ;;
    esac
  done
  echo "[drain] loop exited."
}

# Parse EVERY argument, not just $1 (#1591). This was a bare `case "${1:-}"` with no
# loop and no shift, so `--auto --dry-run` matched `--auto` and silently DISCARDED
# `--dry-run` — a preview command that started a real drain and wrote to GitHub. The
# unknown-arg arm below was asymmetric in the same way: it rejected a typo in first
# position while dropping anything after it in silence.
#
# The seam cases (--session-alive, --should-continue, --checkout-occupied, ...) read
# their operands from $2/$3 and `exit` immediately, so they never reach the shift and
# are unaffected by the loop.
while [[ $# -gt 0 ]]; do
case "$1" in
  --concurrency)
    # Pure seam (#1208): print the VALIDATED fan-out width the loop would use, so a
    # test can assert the default and the fail-safe without running a dispatch.
    _validated_concurrency "${MINSPEC_DRAIN_CONCURRENCY:-1}"
    exit 0
    ;;
  --breaker-decide)
    # Pure seam (#1208): `--breaker-decide <halt> <outcomes-csv>` → halt|continue.
    # The autocompact breaker is the gate that caught two real outages, so its rule
    # is unit-tested directly rather than inferred from a live run.
    shift
    _breaker_decide "${1-}" "${2-}"
    exit 0
    ;;
  --pref-path)
    # Single source of truth for the opt-in pref location. The session-start
    # hook lives one directory deeper (scripts/hooks/) than this script, so it
    # MUST NOT recompute PREF_FILE with its own relative `..` walk — that drift
    # is exactly what silently disabled auto-drain (the hook read
    # scripts/.minspec/auto-drain, one level too shallow, while --enable-auto
    # wrote the correct repo-root .minspec/auto-drain). The hook asks us instead.
    echo "$PREF_FILE"
    exit 0
    ;;
  --quota-health)
    # Pure seam: is admission control live or inert? Always exit 0 — this reports, it
    # never gates.
    quota_health; exit 0
    ;;
  --quota-publish-wall)
    # Pure seam: read a wall message on stdin, publish its deadline. Offline.
    quota_publish_wall; exit $?
    ;;
  --quota-gate)
    # Pure seam: would the drain admit a cycle right now? exit 0 admit / 42 defer,
    # with the reason on stdout. Offline by construction — reads local files only
    # (QUOTA_FILE, and its QUOTA_BOOTSTRAP_FILE sidecar on a "no reading" verdict).
    quota_gate; exit $?
    ;;
  --quota-sleep)
    # Pure seam: how many seconds to wait for the window, from the published
    # deadline. Always a bare integer, because it is fed straight to sleep.
    quota_sleep_secs; exit 0
    ;;
  --session-alive)
    # Pure seam: is the session (or any pid) still alive?
    if session_alive "${2:?Usage: drain-inbox.sh --session-alive <pid>}"; then exit 0; else exit 1; fi
    ;;
  --dispatch-alive)
    # Pure seam: is a dispatch for <issue> genuinely running? This is witness 2 of
    # the reaper, so it gets driven against a REAL process rather than asserted on
    # source text — a pattern that silently never matches is indistinguishable from
    # "nothing is running", and reads as a dead issue rather than a broken witness.
    if dispatch_alive_for "${2:?Usage: drain-inbox.sh --dispatch-alive <issue>}"; then exit 0; else exit 1; fi
    ;;
  --should-continue)
    # Pure seam: combined loop guard = session-alive AND before the lifetime cap.
    # Exit 0 (print "continue") to keep looping; exit 1 (print the stop reason) to
    # stop. Mirrors the checks run_loop makes at the top of each iteration.
    _pid="${2:?Usage: drain-inbox.sh --should-continue <pid> <deadline-epoch>}"
    _deadline="${3:?Usage: drain-inbox.sh --should-continue <pid> <deadline-epoch>}"
    if (( $(date +%s) >= _deadline )); then echo "max-lifetime reached"; exit 1; fi
    if ! session_alive "$_pid"; then echo "session $_pid ended"; exit 1; fi
    echo "continue"; exit 0
    ;;
  --is-quota)
    # Pure seam: classify combined agent output (stdin) as quota/limit or not.
    if is_quota; then exit 0; else exit 1; fi
    ;;
  --resolve-session-pid)
    resolve_session_pid; echo
    exit 0
    ;;
  --checkout-occupied)
    # Pure seam mirroring presence.ts isCheckoutOccupied — the FR-14 golden-fixture
    # parity harness drives this against the TS engine. Prints occupied/dormant.
    if checkout_occupied "${2:?Usage: drain-inbox.sh --checkout-occupied <root>}"; then
      echo "occupied"; exit 0; else echo "dormant"; exit 1; fi
    ;;
  --sync-checkouts)
    # Seam: run ONE gated-ff pass over the shared checkouts without the whole loop,
    # so a test can assert dormant checkouts advance and live/dirty ones don't.
    sync_shared_checkouts
    exit 0
    ;;
  --refresh-run-dir)
    # Seam (#773): refresh the dedicated run dir and print the ref it synced to
    # (or "in-place" when self-refresh is off / fell back). Lets a test assert the
    # run dir tracks origin/main without driving the whole loop.
    ensure_fresh_run_dir
    if [[ "${MINSPEC_DRAIN_SELF_REFRESH:-1}" != "0" && -e "${DRAIN_RUN_DIR}/.git" ]]; then
      git -C "$DRAIN_RUN_DIR" rev-parse HEAD 2>/dev/null || echo "in-place"
    else
      echo "in-place"
    fi
    exit 0
    ;;
  --dry-run) DRY_RUN=true ;;
  --continuous) CONTINUOUS=true ;;
  --once) CONTINUOUS=false ;;
  --enable-auto)
    mkdir -p "$(dirname "$PREF_FILE")"
    echo "on" > "$PREF_FILE"
    echo "✅  Auto-drain ENABLED. Each session start will triage + dispatch pending work."
    echo "    Pref: $PREF_FILE (gitignored — only affects your machine). Disable: scripts/drain-inbox.sh --disable-auto"
    exit 0
    ;;
  --disable-auto)
    mkdir -p "$(dirname "$PREF_FILE")"
    echo "off" > "$PREF_FILE"
    echo "🛑  Auto-drain DISABLED. Drains run only when you invoke scripts/drain-inbox.sh."
    exit 0
    ;;
  --auto)
    # Hook entrypoint: honor the opt-in, stay silent otherwise (no opt-in = no nag here).
    if [[ "$(cat "$PREF_FILE" 2>/dev/null || echo off)" != "on" ]]; then
      exit 0
    fi
    # The session path drains continuously by default (#239) — the whole point is
    # to keep piggybacking new agent-ready work onto the live session.
    CONTINUOUS=true
    ;;
  "") ;;
  *) echo "Unknown arg: $1"; exit 1 ;;
esac
shift
done

# Global opt-out (#239): MINSPEC_DRAIN_CONTINUOUS=0 forces pure one-shot even on
# --auto/--continuous, for anyone who wants the old single-pass behaviour back.
[[ "${MINSPEC_DRAIN_CONTINUOUS:-1}" == "0" ]] && CONTINUOUS=false

# Count pending work across both stages
INBOX_COUNT=0
INBOX_ISSUES=$(gh issue list --repo "$REPO" --label "inbox" \
  --json number --jq '.[].number' 2>/dev/null || true)
[[ -n "$INBOX_ISSUES" ]] && INBOX_COUNT=$(echo "$INBOX_ISSUES" | wc -l | tr -d ' ')

# Both ready classes (#1169) — same OR-not-AND reason as run_cycle's Step 2. This
# count decides whether a one-shot run exits early, so undercounting here would make
# the drain report "nothing to do" while specify work sat queued.
READY_ISSUES=$(
  {
    gh issue list --repo "$REPO" --label "agent-ready" \
      --json number --jq '.[].number' 2>/dev/null || true
    gh issue list --repo "$REPO" --label "agent-ready-specify" \
      --json number --jq '.[].number' 2>/dev/null || true
  } | sort -un
)
READY_COUNT=0
[[ -n "$READY_ISSUES" ]] && READY_COUNT=$(echo "$READY_ISSUES" | wc -l | tr -d ' ')

TOTAL=$(( INBOX_COUNT + READY_COUNT ))

# Nothing to do right now. A one-shot (or any dry-run) exits quietly, unchanged.
# A CONTINUOUS run still starts its loop even on an empty inbox — new agent-ready
# work may arrive later in the session, which is exactly what #239 is for.
if [[ "$TOTAL" -eq 0 ]] && { ! $CONTINUOUS || $DRY_RUN; }; then
  exit 0
fi

if [[ "$TOTAL" -gt 0 ]]; then
  echo "📬  $INBOX_COUNT inbox + $READY_COUNT ready issue(s) pending (agent-ready + agent-ready-specify)"
fi

if $DRY_RUN; then
  echo "    (dry-run — run scripts/drain-inbox.sh to triage + dispatch)"
  exit 0
fi

# Freshness is no longer a fail-loud FOREGROUND gate (#773 supersedes the #481
# foreground guard): both the one-shot and continuous paths call run_cycle, which
# runs ensure_fresh_run_dir first and executes the pipeline from a run dir
# hard-synced to origin/main. A stale primary checkout no longer blocks a manual
# run — the drain self-heals instead of refusing. (dispatch-issue.sh keeps its own
# #481 guard for direct invocation.)

# Resolve the session anchor NOW, in the foreground, while $PPID still chains up to
# the Claude session (after the fork+disown below the loop is reparented and this
# ancestry is gone). Only needed for the continuous loop.
SESSION_PID=""
if $CONTINUOUS; then
  SESSION_PID="$(resolve_session_pid)"
fi

# Only one drain process at a time. The lock holds the background driver's PID; if
# a previous driver died WITHOUT its EXIT trap firing (e.g. SIGKILL), the PID is
# dead and we reclaim the stale lock rather than blocking every future session.
if [[ -f "$LOCK" ]]; then
  LOCK_PID=$(cat "$LOCK" 2>/dev/null || echo "")
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "⚠️   Drain already running (PID $LOCK_PID, log: $LOG) — skipping."
    exit 0
  fi
  echo "ℹ️   Reclaiming stale drain lock (holder PID ${LOCK_PID:-?} no longer running)."
  rm -f "$LOCK"
fi

(
  # $BASHPID, NOT $$: inside a subshell `$$` is still the PARENT script's PID
  # (POSIX keeps it constant across subshells), and the parent exits right after
  # `disown` below — so writing $$ would record a PID that is dead within
  # milliseconds, and the stale-lock reclaim above would then fire on EVERY later
  # session and spawn a second concurrent loop (double-dispatch / quota abuse).
  # $BASHPID is this subshell's own PID (== $DRAIN_PID), i.e. the long-lived loop
  # the reclaim's `kill -0` must actually probe. (ai-review #676: BLOCKING/HIGH.)
  echo "$BASHPID" > "$LOCK"
  trap 'rm -f "$LOCK"' EXIT

  if $CONTINUOUS; then
    run_loop
  else
    run_cycle || true
    echo "[drain] done."
  fi
) >>"$LOG" 2>&1 &

DRAIN_PID=$!
disown "$DRAIN_PID"
if $CONTINUOUS; then
  echo "🔁  Continuous drain in background (PID $DRAIN_PID, session $SESSION_PID, every $((INTERVAL / 60))m; dies with the session; log: $LOG)"
else
  echo "🚀  Triage + drain in background (PID $DRAIN_PID, log: $LOG)"
fi
