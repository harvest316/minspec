#!/usr/bin/env bash
# session-autonomy.sh — print the autonomy state and stop list (DR-086).
#
# Deliberately its OWN file rather than a stanza inside session-start.sh. That
# hook is not decomposed: running it also fires the #168 branch guardrail (writes
# $GIT_DIR/.claude-last-branch), the #239 inbox drain (can dispatch agent work),
# and the #1210 tooling radar (can file GitHub issues). A test that executed the
# whole hook to assert one banner line was therefore non-hermetic and
# outward-facing — it could file issues from a unit test run.
#
# Split out, this unit has NO side effects, so it can be executed directly in a
# test. That keeps the assertion honest: the printer is genuinely run, rather
# than a source-text grep that would pass just as happily against dead wiring.
#
# Never fatal — a broken printer must not wedge a session start.
_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)
if [ -n "$_root" ] && [ -f "$_root/scripts/autonomy-status.ts" ] && command -v npx >/dev/null 2>&1; then
  npx tsx "$_root/scripts/autonomy-status.ts" "$_root" 2>/dev/null || true
fi
