#!/usr/bin/env bash
# session-start.sh — injected at Claude Code session start

cat <<'SCOPE'
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MinSpec Monorepo — Session Start
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Declare scope before writing code:
  Session scope: [one sentence]
  Project: minspec | scroogellm | shared | infra
  Type: bug | feat | explore | plan

MinSpec status: SDD Implement phase → specs/minspec/tasks.md
ScroogeLLM status: awaiting Specify phase (future session)

Topic drift → GitHub issue (harvest316/minspec), not inline work.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCOPE
