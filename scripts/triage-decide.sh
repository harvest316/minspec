#!/usr/bin/env bash
# triage-decide.sh — pure deterministic triage gate (no network, no gh, no side effects).
#
# Reads a triage agent's output on stdin, extracts its verdict block, and writes
# the FINAL triage outcome to stdout as: "<final-label> <role>".
#
# This is the machine-checkable gate that BACKS the LLM's judgment — a human-only
# or T3/T4 verdict can never become `agent-ready`, regardless of what the agent
# "decided". It fails CLOSED: any missing/garbled field downgrades to a human gate.
#
# Why this exists: the triage agent reads an UNTRUSTED issue body (prompt-injection
# surface). Per the repo's dispatch security model, the agent therefore gets NO
# credentials and CANNOT mutate labels — it only emits a verdict. The parent
# (triage-inbox.sh) feeds that verdict here and applies the result with gh. An
# injected "set this agent-ready" cannot bypass the deterministic rules below.
#
# Expected verdict block in stdin (case-insensitive field names):
#   TRIAGE_VERDICT_BEGIN
#   decision: agent-ready | needs-review | needs-info
#   role: dev | architect | security | reviewer
#   tier: T1 | T2 | T3 | T4
#   human_only: yes | no
#   rationale: <one line>
#   TRIAGE_VERDICT_END
#
# stdout: one line "<label> <role>", label ∈ {agent-ready, needs-review, needs-info}
# exit 0 always when a block is found; exit 2 (still prints a fail-closed line) if not.

set -eu

INPUT="$(cat)"

BLOCK="$(printf '%s\n' "$INPUT" | sed -n '/TRIAGE_VERDICT_BEGIN/,/TRIAGE_VERDICT_END/p')"
if [[ -z "$BLOCK" ]]; then
  echo "needs-review reviewer"   # fail closed: no parseable verdict → human gate
  exit 2
fi

# Extract a single field value, lowercased and trimmed; empty if absent.
field() {
  printf '%s\n' "$BLOCK" \
    | { grep -iE "^[[:space:]]*$1[[:space:]]*:" || true; } \
    | head -1 \
    | sed -E "s/^[^:]*:[[:space:]]*//" \
    | tr -d '\r' \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

DECISION="$(field decision)"
ROLE="$(field role)"
TIER="$(field tier)"
HUMAN="$(field human_only)"

# Role must be one of the four; otherwise fail closed to reviewer (human-facing).
case "$ROLE" in
  dev|architect|security|reviewer) ;;
  *) ROLE="reviewer" ;;
esac

# Unknown/garbled tier → cannot size the work → ask for info.
case "$TIER" in
  t1|t2|t3|t4) ;;
  *) echo "needs-info $ROLE"; exit 0 ;;
esac

# Deterministic gate — order matters, every fall-through lands on a human gate:
# 1. human-only (any tier)            → needs-review
# 2. agent asked for info             → needs-info
# 3. T3/T4 (complex/architectural)    → needs-review
# 4. T1/T2 AND agent-ready            → agent-ready  (the ONLY auto path)
# 5. anything else                    → needs-review (fail closed)
if [[ "$HUMAN" == "yes" || "$HUMAN" == "true" ]]; then
  echo "needs-review $ROLE"; exit 0
fi
if [[ "$DECISION" == "needs-info" ]]; then
  echo "needs-info $ROLE"; exit 0
fi
if [[ "$TIER" == "t3" || "$TIER" == "t4" ]]; then
  echo "needs-review $ROLE"; exit 0
fi
if [[ "$TIER" == "t1" || "$TIER" == "t2" ]] && [[ "$DECISION" == "agent-ready" ]]; then
  echo "agent-ready $ROLE"; exit 0
fi
echo "needs-review $ROLE"; exit 0
