#!/usr/bin/env bash
# autonomy.sh — the bash seam onto the DR-086 autonomy gate (#1614).
#
# ── Why this file exists ──────────────────────────────────────────────────────
# `scripts/lib/autonomy.ts` encodes the whole safety property — `mayProceed` and
# its frozen stop list — and is fully unit-tested. It had ZERO production call
# sites: the mechanism was built and verified, and nothing asked it anything, so
# the `autonomy` setting was inert and the unattended merge arms in
# `dispatch-issue.sh` merged without ever asking whether autonomy was on.
#
# This file is how bash asks. It does NOT re-implement the decision — a second
# copy of a rule in a second language is how the two drift, and this repo has
# already paid for that twice (gh-bot.sh's write vocabulary, #1401; the machinery
# regex, #1758). There is ONE authority, in TypeScript, and this shells it.
#
# ── Failure policy: closed, at every edge ─────────────────────────────────────
# The gate can fail to RUN for reasons that have nothing to do with the decision:
# no `node_modules`, no pinned `tsx`, a crash, a non-zero exit, stdout that is not
# a verdict. Every one of those DENIES — including the missing runner, which is
# NOT quietly replaced by an `npx` fetch. A gate that cannot run must not
# admit — constitution invariant 2 (a missing or errored witness fails the gate
# closed and visibly, never silently passes). The shape is the one already at
# dispatch-issue.sh's auto-merge-gate call: substitute a fail-safe hold and carry
# on, never treat "no answer" as "yes".
#
# ── Consequence of landing this ───────────────────────────────────────────────
# `readAutonomy` resolves a MISSING key to `ask`, and `.minspec/config.json` has
# no `autonomy` key. So on merge, the arms that consult this simply STOP FIRING
# until someone sets the key. That is intended, not a regression: turning the
# mechanism on is a separate, human act (#1743).

# Idempotent source guard: several of these scripts source each other.
[[ -n "${_AUTONOMY_SH_LOADED:-}" ]] && return 0
_AUTONOMY_SH_LOADED=1

_AUTONOMY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_AUTONOMY_TS="${_AUTONOMY_LIB_DIR}/autonomy.ts"

# The repo whose `.minspec/config.json` is the policy source. Derived from THIS
# file's location, so a script run from any cwd reads the right repo's setting.
# `MINSPEC_AUTONOMY_REPO_ROOT` is a TEST SEAM (same shape as dr-id-collision's
# `DR_ID_GH_BIN`): it lets a test point at a fixture config without editing the
# real one. It adds no attack surface — anyone who can set it can already edit
# the file it selects.
AUTONOMY_REPO_ROOT="${MINSPEC_AUTONOMY_REPO_ROOT:-$(cd "${_AUTONOMY_LIB_DIR}/../.." && pwd)}"

# TEST SEAM: point at a runner that does not exist to prove an unrunnable gate
# DENIES rather than admits. CI never sets it.
_AUTONOMY_TSX_BIN="${MINSPEC_AUTONOMY_TSX_BIN:-}"

# The fail-safe verdict, printed whenever the gate could not be RUN at all. Shaped
# exactly like a real verdict so every caller parses one thing.
#
# Built with `jq --arg`, not `printf '%s'`: the detail interpolates
# AUTONOMY_REPO_ROOT, and a path holding a quote or a backslash would emit
# malformed JSON — the caller still DENIES (an unparseable verdict is not a
# verdict), but the log line a human reads to find out why would be garbled, and
# a hold whose reason is unreadable is a hold nobody can act on. The printf form
# survives as the fallback for the one case jq cannot cover: jq itself missing.
_autonomy_gate_error() {
  jq -cn --arg d "$1" \
    '{proceed:false, reason:"gate-invocation-failed", detail:$d, autonomy:"ask"}' 2>/dev/null \
    || printf '{"proceed":false,"reason":"gate-invocation-failed","detail":"the autonomy gate could not be run, and jq is unavailable to report why","autonomy":"ask"}\n'
}

# autonomy_verdict_detail <verdict-json> — the human-readable half, for a log line.
# Always exits 0 and always prints something: a hold message is not the place to
# discover that jq is missing.
autonomy_verdict_detail() {
  local json="${1-}" detail=""
  detail=$(printf '%s' "$json" | jq -r '.detail // empty' 2>/dev/null) || detail=""
  [[ -n "$detail" ]] || detail="autonomy gate denied (verdict unreadable: ${json:-<empty>})"
  printf '%s' "$detail"
}

# autonomy_may_proceed <summary> <stop_classes_csv> <rejected_alternatives> [verification_pending]
#
#   stdout: ONE line of JSON — the verdict (or the fail-safe hold above).
#   exit:   0 = proceed, 1 = deny. NOTHING else means proceed.
#
# `rejected_alternatives` is newline-separated (prose contains commas).
autonomy_may_proceed() {
  local summary="${1-}" stop_classes="${2-}" rejected="${3-}" pending="${4:-false}"
  local out rc
  local -a runner

  if [[ -n "$_AUTONOMY_TSX_BIN" ]]; then
    runner=("$_AUTONOMY_TSX_BIN")
  elif [[ -x "${AUTONOMY_REPO_ROOT}/node_modules/.bin/tsx" ]]; then
    runner=("${AUTONOMY_REPO_ROOT}/node_modules/.bin/tsx")
  else
    # NO `npx tsx` FALLBACK. `npx` with no local install FETCHES the package over
    # the network — an unconsented network call made on the repo's behalf (first
    # invariant), to obtain the binary that decides whether an unattended merge may
    # happen. Downloading the judge is not a fallback worth having: a missing pinned
    # runner is exactly the "the gate cannot run" case, and that DENIES.
    _autonomy_gate_error "no pinned tsx runner at ${AUTONOMY_REPO_ROOT}/node_modules/.bin/tsx — refusing to fetch one over the network; failing closed"
    return 1
  fi

  out=$("${runner[@]}" "$_AUTONOMY_TS" --may-proceed \
          --repo-root "$AUTONOMY_REPO_ROOT" \
          --summary "$summary" \
          --stop-classes "$stop_classes" \
          --rejected-alternatives "$rejected" \
          --verification-pending "$pending" 2>/dev/null) && rc=0 || rc=$?

  # Not a verdict ⇒ not permission. Covers an empty stdout (crash, ENOENT, no
  # node_modules), a partial write, and any prose that leaked onto stdout.
  if ! printf '%s' "$out" | jq -e 'has("proceed")' >/dev/null 2>&1; then
    _autonomy_gate_error "the autonomy gate could not be run (exit ${rc}) — failing closed; it is not permission"
    return 1
  fi

  printf '%s\n' "$out"

  # BOTH signals must agree, and both must say yes. A zero exit with
  # "proceed":false — or the reverse — is a contradiction, and a contradictory
  # gate is an unrun gate.
  (( rc == 0 )) || return 1
  [[ "$(printf '%s' "$out" | jq -r '.proceed' 2>/dev/null)" == "true" ]] || return 1
  return 0
}
