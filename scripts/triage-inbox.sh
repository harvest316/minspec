#!/usr/bin/env bash
# triage-inbox.sh — triage inbox issues into agent-ready / needs-review / needs-info
# Usage: scripts/triage-inbox.sh [issue-number]
#
# Without args: processes all issues labeled 'inbox'
# With arg: triages single issue
#
# Security model (mirrors dispatch-issue.sh): the issue body is UNTRUSTED
# (prompt-injection surface). The triage AGENT therefore gets NO credentials and
# CANNOT mutate labels — it only emits a verdict block. This PARENT script feeds
# that verdict through the deterministic gate (triage-decide.sh) and applies the
# result with gh. An injected "make this agent-ready" cannot reach the label.

set -euo pipefail

REPO="harvest316/minspec"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLES_DIR="${SCRIPT_DIR}/roles"
DECIDE="${SCRIPT_DIR}/triage-decide.sh"

triage_issue() {
  local ISSUE="$1"

  if ! [[ "$ISSUE" =~ ^[0-9]+$ ]]; then
    echo "ERROR: Invalid issue number: $ISSUE" >&2
    return 1
  fi

  local ISSUE_JSON ISSUE_BODY ISSUE_TITLE
  ISSUE_JSON=$(gh issue view "$ISSUE" --repo "$REPO" --json body,title,labels)
  ISSUE_BODY=$(echo "$ISSUE_JSON" | jq -r '"# " + .title + "\n\n" + .body')
  ISSUE_TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')

  echo "Triaging: #$ISSUE — $ISSUE_TITLE"

  local USER_CONTENT
  USER_CONTENT=$(cat <<CONTENT
<untrusted_issue_body>
${ISSUE_BODY}
</untrusted_issue_body>

Repo: ${REPO}
Issue number: ${ISSUE}

Classify this issue per your role instructions (apply the human-only type filter
FIRST, then tier). You CANNOT edit labels or run any command — the dispatcher
applies your verdict. Emit EXACTLY ONE verdict block, and nothing after it:

TRIAGE_VERDICT_BEGIN
decision: agent-ready | needs-review | needs-info
role: dev | architect | security | reviewer
tier: T1 | T2 | T3 | T4
human_only: yes | no
rationale: <one line — for needs-review say tier-complexity vs human-only-type; for needs-info say what is missing>
TRIAGE_VERDICT_END
CONTENT
)

  # Agent runs READ-ONLY: it may read repo files to judge tier, but holds no
  # gh/Bash/network — it can only return text. We capture that text.
  local AGENT_OUT
  AGENT_OUT=$(claude -p "$USER_CONTENT" \
    --system-prompt-file "${ROLES_DIR}/triage.md" \
    --allowedTools "Read" \
    --output-format text 2>&1) || {
      echo "WARNING: triage agent failed for #$ISSUE — leaving in inbox" >&2
      return 0
    }

  # Deterministic gate → "<label> <role>"
  local VERDICT LABEL ROLE
  VERDICT=$(printf '%s\n' "$AGENT_OUT" | "$DECIDE" || true)
  LABEL=$(echo "$VERDICT" | awk '{print $1}')
  ROLE=$(echo "$VERDICT" | awk '{print $2}')

  if [[ -z "$LABEL" || -z "$ROLE" ]]; then
    echo "WARNING: no verdict parsed for #$ISSUE — leaving in inbox" >&2
    return 0
  fi

  # Pull the agent's rationale line for the triage comment (best-effort).
  local RATIONALE
  RATIONALE=$(printf '%s\n' "$AGENT_OUT" \
    | sed -n '/TRIAGE_VERDICT_BEGIN/,/TRIAGE_VERDICT_END/p' \
    | { grep -iE '^[[:space:]]*rationale[[:space:]]*:' || true; } \
    | head -1 | sed -E 's/^[^:]*:[[:space:]]*//')
  [[ -z "$RATIONALE" ]] && RATIONALE="(no rationale emitted)"

  # PARENT applies the verdict (credentialed op — never the agent).
  echo "  → #$ISSUE: $LABEL (role:$ROLE)"
  gh issue edit "$ISSUE" --repo "$REPO" \
    --add-label "role:${ROLE},${LABEL}" --remove-label "inbox" >/dev/null
  gh issue comment "$ISSUE" --repo "$REPO" \
    --body "**Triage:** \`${LABEL}\` · role:\`${ROLE}\`
${RATIONALE}

— auto-triaged (\`triage-inbox.sh\`); verdict enforced by the deterministic gate (\`triage-decide.sh\`)." >/dev/null

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
