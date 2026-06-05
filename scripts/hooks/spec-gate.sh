#!/usr/bin/env bash
# spec-gate.sh — PreToolUse HITL gate wrapper (DR-362)
#
# Thin wrapper around spec-gate.py:
#   - honours the MINSPEC_GATE_OFF=1 kill-switch (escape hatch)
#   - pipes the hook envelope (stdin) straight through to the Python gate
#
# The real decision logic lives in spec-gate.py so the JSON envelope on stdin
# reaches it cleanly (a `python3 - <<HEREDOC` form would steal stdin). See
# DR-362 for the enforcement rationale.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Kill-switch — the HUMAN-only escape hatch (DR-031 D2). It is honored but is
# NOT advertised in the agent-facing deny reason, and every honored bypass is
# appended to the canonical .minspec/gate-bypass.log so a bypass is always
# auditable after the fact. The dispatch pipeline MUST NOT set this (DR-031 D3).
if [ "${MINSPEC_GATE_OFF:-0}" = "1" ]; then
  # Slurp the envelope so we can record what was bypassed (cwd, tool, target).
  ENVELOPE="$(cat 2>/dev/null || true)"
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date 2>/dev/null || echo unknown)"
  # Resolve the canonical .minspec/ (main checkout) the same way spec-gate.py
  # does, so the audit trail lives with the approval store, not in a worktree.
  AUDIT_CWD=""; AUDIT_TOOL=""; AUDIT_TARGET=""
  if command -v python3 >/dev/null 2>&1; then
    # Extract fields without a JSON dep; failures degrade to blanks, never abort.
    eval "$(printf '%s' "$ENVELOPE" | python3 -c '
import json, sys, shlex
try:
    e = json.load(sys.stdin)
except Exception:
    e = {}
ti = e.get("tool_input") or {}
print("AUDIT_CWD=" + shlex.quote(str(e.get("cwd") or "")))
print("AUDIT_TOOL=" + shlex.quote(str(e.get("tool_name") or "")))
print("AUDIT_TARGET=" + shlex.quote(str(ti.get("file_path") or ti.get("path") or "")))
' 2>/dev/null || true)"
  fi
  [ -n "$AUDIT_CWD" ] || AUDIT_CWD="$PWD"
  CANON_DIR=""
  COMMON="$(git -C "$AUDIT_CWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$COMMON" ]; then
    CANON_DIR="$(dirname "$COMMON")/.minspec"
  fi
  if [ -n "$CANON_DIR" ]; then
    mkdir -p "$CANON_DIR" 2>/dev/null || true
    printf '%s\tcwd=%s\ttool=%s\ttarget=%s\n' \
      "$TS" "$AUDIT_CWD" "$AUDIT_TOOL" "$AUDIT_TARGET" \
      >> "$CANON_DIR/gate-bypass.log" 2>/dev/null || true
  fi
  # Emit nothing → normal permission flow (bypass honored).
  exit 0
fi

# Fail open if python3 is unavailable — never block on a missing interpreter.
if ! command -v python3 >/dev/null 2>&1; then
  exit 0
fi

exec python3 "$HERE/spec-gate.py"
