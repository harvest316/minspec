#!/usr/bin/env bash
# triage-inbox.sh — run triage agent on all inbox issues
# Usage: scripts/triage-inbox.sh [issue-number]
#
# Without args: processes all issues labeled 'inbox'
# With arg: triages single issue

set -euo pipefail

REPO="harvest316/minspec"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLES_DIR="${SCRIPT_DIR}/roles"
TRIAGE_PROMPT=$(cat "${ROLES_DIR}/triage.md")

triage_issue() {
  local ISSUE="$1"
  local ISSUE_JSON
  ISSUE_JSON=$(gh issue view "$ISSUE" --repo "$REPO" --json body,title,labels)
  local ISSUE_BODY
  ISSUE_BODY=$(echo "$ISSUE_JSON" | jq -r '"# " + .title + "\n\n" + .body')
  local ISSUE_TITLE
  ISSUE_TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')

  echo "Triaging: #$ISSUE — $ISSUE_TITLE"

  local PROMPT
  PROMPT=$(cat <<PROMPT
# Triage Task: Issue #${ISSUE}

${ISSUE_BODY}

---

## Role Instructions

${TRIAGE_PROMPT}

---

## Context

Repo: ${REPO}
Read CLAUDE.md for project invariants and tier definitions.

Available roles: dev, architect, security, reviewer
Available priority labels: P1, P2, P3

Use \`gh\` CLI to:
- Add labels: \`gh issue edit ${ISSUE} --repo ${REPO} --add-label "role:dev,agent-ready,P2" --remove-label "inbox"\`
- Comment: \`gh issue comment ${ISSUE} --repo ${REPO} --body "triage summary"\`
- Request info: \`gh issue edit ${ISSUE} --repo ${REPO} --add-label "needs-info" --remove-label "inbox"\`

ESCALATION RULE: If you cannot fully and correctly complete this task — due to complexity, missing context, token limits, or uncertainty — do NOT cut corners, leave stubs, skip edge cases, or simplify the implementation. Instead, output exactly:

ESCALATE: <one-line reason>

Then stop. Do not attempt a partial solution.
PROMPT
)

  claude -p "$PROMPT"
  echo "Triage complete for #$ISSUE"
}

if [[ "${1:-}" ]]; then
  triage_issue "$1"
else
  ISSUES=$(gh issue list --repo "$REPO" --label "inbox" --json number -q '.[].number')
  if [[ -z "$ISSUES" ]]; then
    echo "No inbox issues found."
    exit 0
  fi
  for ISSUE in $ISSUES; do
    triage_issue "$ISSUE"
  done
fi
