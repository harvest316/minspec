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
DRY_RUN=false
LOCK="/tmp/minspec-drain-inbox.lock"
LOG="/tmp/minspec-drain-inbox.log"

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# Query agent-ready queue
ISSUES=$(gh issue list --repo "$REPO" --label "agent-ready" \
  --json number --jq '.[].number' 2>/dev/null || true)

COUNT=0
if [[ -n "$ISSUES" ]]; then
  COUNT=$(echo "$ISSUES" | wc -l | tr -d ' ')
fi

if [[ "$COUNT" -eq 0 ]]; then
  exit 0
fi

echo "📬  $COUNT agent-ready issue(s): $(echo "$ISSUES" | tr '\n' ' ')"

if $DRY_RUN; then
  echo "    (dry-run — run scripts/drain-inbox.sh to dispatch)"
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

  for n in $ISSUES; do
    echo "[drain] dispatching #$n..."
    "$DISPATCH" "$n" || echo "[drain] WARNING: dispatch failed for #$n"
  done
  echo "[drain] done."
) >>"$LOG" 2>&1 &

DRAIN_PID=$!
disown "$DRAIN_PID"
echo "🚀  Draining in background (PID $DRAIN_PID, log: $LOG)"
