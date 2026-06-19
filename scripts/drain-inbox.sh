#!/usr/bin/env bash
# drain-inbox.sh — dispatch all agent-ready issues in background
#
# Called from session-start.sh hook so inbox work piggybacks onto active
# sessions without blocking the user. Each issue is dispatched sequentially
# (not in parallel) to respect subscription quota.
#
# Usage:
#   scripts/drain-inbox.sh              # auto-detect + dispatch
#   scripts/drain-inbox.sh --dry-run    # report count, no dispatch

set -euo pipefail

REPO="harvest316/minspec"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH="${SCRIPT_DIR}/dispatch-issue.sh"
TRIAGE="${SCRIPT_DIR}/triage-inbox.sh"
DRY_RUN=false
LOCK="/tmp/minspec-drain-inbox.lock"
LOG="/tmp/minspec-drain-inbox.log"

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# Count pending work across both stages
INBOX_COUNT=0
INBOX_ISSUES=$(gh issue list --repo "$REPO" --label "inbox" \
  --json number --jq '.[].number' 2>/dev/null || true)
[[ -n "$INBOX_ISSUES" ]] && INBOX_COUNT=$(echo "$INBOX_ISSUES" | wc -l | tr -d ' ')

READY_ISSUES=$(gh issue list --repo "$REPO" --label "agent-ready" \
  --json number --jq '.[].number' 2>/dev/null || true)
READY_COUNT=0
[[ -n "$READY_ISSUES" ]] && READY_COUNT=$(echo "$READY_ISSUES" | wc -l | tr -d ' ')

TOTAL=$(( INBOX_COUNT + READY_COUNT ))

if [[ "$TOTAL" -eq 0 ]]; then
  exit 0
fi

echo "📬  $INBOX_COUNT inbox + $READY_COUNT agent-ready issue(s) pending"

if $DRY_RUN; then
  echo "    (dry-run — run scripts/drain-inbox.sh to triage + dispatch)"
  exit 0
fi

# Only one drain process at a time
if [[ -f "$LOCK" ]]; then
  LOCK_PID=$(cat "$LOCK" 2>/dev/null || echo "?")
  echo "⚠️   Drain already running (PID $LOCK_PID, log: $LOG) — skipping."
  exit 0
fi

(
  echo "$$" > "$LOCK"
  trap 'rm -f "$LOCK"' EXIT

  # Step 1: triage inbox issues → labels T1/T2 as agent-ready
  if [[ -n "$INBOX_ISSUES" ]]; then
    echo "[drain] triaging $INBOX_COUNT inbox issue(s)..."
    for n in $INBOX_ISSUES; do
      echo "[drain] triaging #$n..."
      "$TRIAGE" "$n" || echo "[drain] WARNING: triage failed for #$n"
    done
  fi

  # Step 2: drain whatever is now agent-ready (original + newly triaged)
  ALL_READY=$(gh issue list --repo "$REPO" --label "agent-ready" \
    --json number --jq '.[].number' 2>/dev/null || true)
  if [[ -z "$ALL_READY" ]]; then
    echo "[drain] no agent-ready issues after triage — done."
    exit 0
  fi
  echo "[drain] dispatching $(echo "$ALL_READY" | wc -l | tr -d ' ') agent-ready issue(s)..."
  for n in $ALL_READY; do
    echo "[drain] dispatching #$n..."
    "$DISPATCH" "$n" || echo "[drain] WARNING: dispatch failed for #$n"
  done
  echo "[drain] done."
) >>"$LOG" 2>&1 &

DRAIN_PID=$!
disown "$DRAIN_PID"
echo "🚀  Triage + drain in background (PID $DRAIN_PID, log: $LOG)"
