#!/usr/bin/env bash
# post-compact.sh — reinjects context after conversation compaction

SCOPE_FILE=".claude/.session-scope"

echo "━━━ Context reinject after compaction ━━━"
echo "Repo: harvest316/minspec"
if [ -f "$SCOPE_FILE" ]; then
  echo "Scope: $(cat $SCOPE_FILE)"
else
  echo "Scope: [not declared — redeclare before continuing]"
fi
echo "Invariants: CLAUDE.md ## Invariants"
echo "Tasks: specs/minspec/tasks.md"
echo "Decisions: docs/decisions/INDEX.md"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
