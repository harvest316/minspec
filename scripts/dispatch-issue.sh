#!/usr/bin/env bash
# dispatch-issue.sh — local agent dispatch via claude --bg
# Usage: scripts/dispatch-issue.sh <issue-number> [--role <role>]
#
# Fetches issue body + labels, resolves agent role, loads role prompt,
# labels agent-running, launches claude --bg in isolated worktree.

set -euo pipefail

ISSUE="${1:?Usage: dispatch-issue.sh <issue-number> [--role <role>]}"
REPO="harvest316/minspec"
WORKTREE_BASE="/tmp/minspec-agent"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLES_DIR="${SCRIPT_DIR}/roles"
FORCE_ROLE=""

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) FORCE_ROLE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "Fetching issue #$ISSUE..."
ISSUE_JSON=$(gh issue view "$ISSUE" --repo "$REPO" --json body,title,labels)
ISSUE_BODY=$(echo "$ISSUE_JSON" | jq -r '"# " + .title + "\n\n" + .body')
ISSUE_TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')
ISSUE_LABELS=$(echo "$ISSUE_JSON" | jq -r '.labels[].name')

# Resolve role: --role flag > role:X label > default to dev
if [[ -n "$FORCE_ROLE" ]]; then
  ROLE="$FORCE_ROLE"
else
  ROLE=$(echo "$ISSUE_LABELS" | grep -oP '^role:\K.*' | head -1)
  ROLE="${ROLE:-dev}"
fi

# Load role prompt
ROLE_FILE="${ROLES_DIR}/${ROLE}.md"
if [[ -f "$ROLE_FILE" ]]; then
  ROLE_PROMPT=$(cat "$ROLE_FILE")
  echo "Role: $ROLE (loaded from $ROLE_FILE)"
else
  echo "Warning: no role file for '$ROLE', using generic prompt"
  ROLE_PROMPT=""
fi

# Label as running
gh issue edit "$ISSUE" --repo "$REPO" \
  --remove-label "agent-ready" \
  --add-label "agent-running" 2>/dev/null || true

# Create worktree
BRANCH="agent/issue-${ISSUE}"
WORKTREE="${WORKTREE_BASE}/issue-${ISSUE}"

if [[ -d "$WORKTREE" ]]; then
  echo "Cleaning up existing worktree at $WORKTREE"
  git worktree remove "$WORKTREE" --force 2>/dev/null || true
  git branch -D "$BRANCH" 2>/dev/null || true
fi

git worktree add -b "$BRANCH" "$WORKTREE" main

echo "Launching $ROLE agent for: $ISSUE_TITLE"

PROMPT=$(cat <<PROMPT
# Agent Task: Issue #${ISSUE} (Role: ${ROLE})

${ISSUE_BODY}

---

## Role Instructions

${ROLE_PROMPT}

---

## Context

Repo: ${REPO}
Worktree: ${WORKTREE}
Branch: ${BRANCH}

Read CLAUDE.md for invariants. Read AGENTS.md for task intake rules.
Tests are in packages/*/tests/. Run \`npm test\` to verify.

After completing work:
1. Run \`npm test\` — must pass
2. Run \`npm run validate\` — must pass
3. Commit with conventional commit message
4. Leave a comment on issue #${ISSUE} summarizing what was done

ESCALATION RULE: If you cannot fully and correctly complete this task — due to complexity, missing context, token limits, or uncertainty — do NOT cut corners, leave stubs, skip edge cases, or simplify the implementation. Instead, output exactly:

ESCALATE: <one-line reason>

Then stop. Do not attempt a partial solution.
PROMPT
)

claude --bg --worktree "$WORKTREE" "$PROMPT" && {
  gh issue edit "$ISSUE" --repo "$REPO" \
    --remove-label "agent-running" \
    --add-label "agent-done" 2>/dev/null || true
  echo "Agent completed issue #$ISSUE (role: $ROLE). Worktree: $WORKTREE"
} || {
  gh issue edit "$ISSUE" --repo "$REPO" \
    --remove-label "agent-running" \
    --add-label "agent-escalated" 2>/dev/null || true
  echo "Agent escalated issue #$ISSUE (role: $ROLE). Review output in $WORKTREE"
}
