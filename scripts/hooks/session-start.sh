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

# --- Concurrent-session branch guardrail (issue #168) ---
# One checkout has one HEAD. If a parallel session ran `git checkout`/`merge` in
# THIS folder, the branch moved under you and uncommitted work may be stranded on
# the old branch. Compare the branch to what the last session here left, and warn.
# State lives in $GIT_DIR (per-worktree, never committed) so worktrees don't
# false-positive against each other.
if git rev-parse --git-dir >/dev/null 2>&1; then
  cur="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  gitdir="$(git rev-parse --git-dir 2>/dev/null)"
  state="$gitdir/.claude-last-branch"
  dirty=""
  { git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; } || dirty="yes"
  if [ -f "$state" ]; then
    last="$(cat "$state" 2>/dev/null)"
    if [ -n "$last" ] && [ "$last" != "$cur" ]; then
      cat <<WARN
⚠️  BRANCH CHANGED since the last session in this folder: '$last' → '$cur'
    A parallel session may share this checkout. If you did NOT switch, your
    uncommitted work could be stranded on '$last'. Rule: one session = one
    worktree — \`scripts/new-worktree.sh <name>\` (global CLAUDE.md rule #8, #168).
WARN
    fi
  fi
  [ -n "$dirty" ] && echo "⚠️  Working tree is DIRTY on '$cur' — commit or stash BEFORE any branch switch."
  printf '%s' "$cur" > "$state" 2>/dev/null || true
  echo "Git: on '$cur'${dirty:+ (dirty)}. One session = one worktree; never checkout-switch this shared folder (#168)."
fi

# --- Agent-ready inbox drain (#239) ---
# Piggybacks pending issue work onto active sessions, in the background so the
# session starts immediately. Opt-in gated (#239): once you run
# `scripts/drain-inbox.sh --enable-auto`, this auto-triages + dispatches on every
# session start. Until then it only reports the pending count.
DRAIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/drain-inbox.sh"
PREF="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.minspec/auto-drain"
if [[ -x "$DRAIN" ]]; then
  if [[ "$(cat "$PREF" 2>/dev/null || echo off)" == "on" ]]; then
    "$DRAIN" --auto 2>/dev/null || true
  else
    pending="$("$DRAIN" --dry-run 2>/dev/null || true)"
    if [[ -n "$pending" ]]; then
      printf '%s\n' "$pending"
      # nudge only when there is real pending work
      echo "$pending" | grep -q '📬' && \
        echo "    Auto-drain is OFF. Enable once: scripts/drain-inbox.sh --enable-auto"
    fi
  fi
fi
