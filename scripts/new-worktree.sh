#!/usr/bin/env bash
# new-worktree.sh — make an isolated worktree for a parallel Claude/VS Code session.
#
# Why: multiple sessions on ONE checkout corrupt each other (a `git checkout` in one
# moves the shared HEAD and rewrites files under the others). A worktree gives each
# session its own folder + own HEAD, sharing the same .git — so nobody's branch or
# files move under them. (Global CLAUDE.md rule #8; product guardrail tracked at #168.)
#
# Usage:   scripts/new-worktree.sh <name>      # e.g. scripts/new-worktree.sh spec-018
# Cleanup: git worktree remove ../<repo>-<name>   (after the branch is merged)
set -euo pipefail

name="${1:-}"
if [ -z "$name" ]; then
  echo "Usage: $0 <name>    (e.g. $0 spec-018)" >&2
  echo "Makes a sibling worktree on its own branch for a parallel session." >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
repo_name="$(basename "$repo_root")"
dest="$(dirname "$repo_root")/${repo_name}-${name}"
branch="$name"

if [ -e "$dest" ]; then
  echo "✗ $dest already exists — pick another name or 'git worktree remove' it first." >&2
  exit 1
fi

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
