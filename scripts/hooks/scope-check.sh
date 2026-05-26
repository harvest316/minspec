#!/usr/bin/env bash
# scope-check.sh — non-blocking context injection
# Called on UserPromptSubmit. Reminds of scope if not declared.

SCOPE_FILE=".claude/.session-scope"

if [ ! -f "$SCOPE_FILE" ]; then
  echo "[MinSpec] No scope declared. Run: echo 'scope: ...' > .claude/.session-scope"
fi
