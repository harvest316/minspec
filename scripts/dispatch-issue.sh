#!/usr/bin/env bash
# dispatch-issue.sh — local agent dispatch via claude --bg
# Usage: scripts/dispatch-issue.sh <issue-number>
#
# Fetches issue body, labels it agent-running, launches claude --bg
# in an isolated worktree. On completion, labels agent-done.

set -euo pipefail

ISSUE="${1:?Usage: dispatch-issue.sh <issue-number>}"
REPO="harvest316/minspec"
WORKTREE_BASE="/tmp/minspec-agent"

# Fetch issue
echo "Fetching issue #$ISSUE..."
ISSUE_BODY=$(gh issue view "$ISSUE" --repo "$REPO" --json body,title,labels -q '
  "# " + .title + "\n\n" + .body
')

ISSUE_TITLE=$(gh issue view "$ISSUE" --repo "$REPO" --json title -q '.title')

# Label as running
gh issue edit "$ISSUE" --repo "$REPO" \
  --remove-label "agent-ready" \
  --add-label "agent-running" 2>/dev/null || true

# Create worktree
BRANCH="agent/issue-${ISSUE}"
WORKTREE="${WORKTREE_BASE}/issue-${ISSUE}"

git worktree add -b "$BRANCH" "$WORKTREE" main

echo "Launching agent for: $ISSUE_TITLE"

# Build prompt with contract-driven context
PROMPT=$(cat <<PROMPT
# Agent Task: Issue #${ISSUE}

${ISSUE_BODY}

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

# Launch background agent
claude --bg --worktree "$WORKTREE" "$PROMPT" && {
  gh issue edit "$ISSUE" --repo "$REPO" \
    --remove-label "agent-running" \
    --add-label "agent-done" 2>/dev/null || true
  echo "Agent completed issue #$ISSUE. Worktree: $WORKTREE"
} || {
  gh issue edit "$ISSUE" --repo "$REPO" \
    --remove-label "agent-running" \
    --add-label "agent-escalated" 2>/dev/null || true
  echo "Agent escalated issue #$ISSUE. Review output in $WORKTREE"
}
