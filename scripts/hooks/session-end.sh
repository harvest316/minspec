#!/usr/bin/env bash
# session-end.sh — end-of-session reminder

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

echo "━━━ Session End — MinSpec ━━━"
echo ""
echo "Uncommitted changes:"
git -C "$REPO_ROOT" status --short 2>/dev/null || echo "(no git repo)"
echo ""
echo "Unpushed commits:"
git -C "$REPO_ROOT" log --oneline origin/main..HEAD 2>/dev/null || echo "(none)"
echo ""
echo "Reminders:"
echo "  1. Commit logical groups (not one big end-of-session commit)"
echo "  2. Update task status in specs/minspec/tasks.md"
echo "  3. Close or update GitHub issues worked on"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
