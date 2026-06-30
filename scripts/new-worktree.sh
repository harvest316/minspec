#!/usr/bin/env bash
# new-worktree.sh — make an isolated worktree for a parallel Claude/VS Code session.
#
# Why: multiple sessions on ONE checkout corrupt each other (a `git checkout` in one
# moves the shared HEAD and rewrites files under the others). A worktree gives each
# session its own folder + own HEAD, sharing the same .git — so nobody's branch or
# files move under them. (Global CLAUDE.md rule #8; product guardrail tracked at #168.)
#
# Usage:   scripts/new-worktree.sh <name>      # e.g. scripts/new-worktree.sh spec-018
# Cleanup: git worktree remove ../.worktrees/<repo>/<name>   (after the branch is merged)
#
# Layout: all worktrees live under a shared root OUTSIDE every checkout —
#   ~/code/.worktrees/<repo>/<name>/  — never nested inside a working tree
#   (nesting makes search/lint/watchers recurse a second checkout) and never in
#   .claude/worktrees/ (harness-owned, auto-removed). Standard set by global rule #8.
set -euo pipefail

name="${1:-}"
if [ -z "$name" ]; then
  echo "Usage: $0 <name>    (e.g. $0 spec-018)" >&2
  echo "Makes a worktree (under ~/code/.worktrees/<repo>/) on its own branch for a parallel session." >&2
  exit 1
fi

# Anchor to the MAIN checkout, not the current one — so running this from inside a
# worktree doesn't nest the shared root (.../.worktrees/<repo>/.worktrees/<repo>/...).
# --git-common-dir is shared across all linked worktrees and points at <main>/.git.
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
repo_root="$(dirname "$common_dir")"
repo_name="$(basename "$repo_root")"
dest="$(dirname "$repo_root")/.worktrees/${repo_name}/${name}"
branch="$name"

if [ -e "$dest" ]; then
  echo "✗ $dest already exists — pick another name or 'git worktree remove' it first." >&2
  exit 1
fi

mkdir -p "$(dirname "$dest")"

# Attach an existing branch, else create a fresh one.
if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$repo_root" worktree add "$dest" "$branch"
else
  git -C "$repo_root" worktree add "$dest" -b "$branch"
fi

cat <<DONE

✓ Isolated worktree ready.
  Folder: $dest
  Branch: $branch   (its own HEAD — safe from other sessions)

Open a NEW window on that folder:
  code $dest          # or:  cd $dest

When finished (after the branch is merged to main):
  git worktree remove $dest
DONE
