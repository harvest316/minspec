#!/usr/bin/env python3
"""MinSpec PreToolUse spec gate (DR-362).

Reads a Claude Code PreToolUse hook envelope on stdin and prints a JSON
permission decision on stdout. Blocks Edit/Write/MultiEdit to *source* files
while any T3/T4 spec in `status: implementing` is unapproved (or approved then
edited -> stale). This is the only enforcement that survives bypass-permissions
mode, because a PreToolUse deny blocks the tool call before permission rules.

Invoked by spec-gate.sh (which handles the MINSPEC_GATE_OFF kill-switch).
Hashing is sha256 over raw file bytes -> byte-identical to `sha256sum` and to
the extension's Node `crypto`, so hook and UI agree on what "approved" means.
"""
import json
import sys
import os
import re
import hashlib
import glob
import subprocess


def allow():
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow"}}))
    sys.exit(0)


def passthrough():
    # Emit nothing -> Claude Code falls back to its normal permission flow.
    sys.exit(0)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason}}))
    sys.exit(0)


def fm_value(text, key):
    m = re.search(r'^' + re.escape(key) + r':\s*(.+?)\s*$', text, re.M)
    return m.group(1).strip() if m else None


def sha(path):
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except Exception:
        return None


def canonical_minspec_dir(cwd):
    """Resolve the canonical (main worktree) .minspec/ dir for `cwd` (DR-031).

    Approvals are per-machine, per-human local state bound to the main checkout.
    A linked worktree (dispatch-issue.sh's /tmp worktree, the Agent-tool
    worktrees) does NOT copy the gitignored approvals.json, so reading it from
    cwd would make every dispatched edit look unapproved. Instead we resolve the
    shared git dir via `git rev-parse --git-common-dir`: for both the main
    checkout and any linked worktree this points at the MAIN checkout's `.git`,
    whose parent is the main working tree — the single source of approval truth.

    Returns the absolute path to `<main-worktree>/.minspec`, or None if git is
    absent / cwd is not inside a repo / resolution fails (caller fails closed
    when gated specs exist).
    """
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    common = out.stdout.decode("utf-8", "replace").strip()
    if not common:
        return None
    # `--git-common-dir` is the shared `.git` dir of the main checkout; its
    # parent is the main working tree where the canonical `.minspec/` lives.
    main_worktree = os.path.dirname(os.path.normpath(common))
    if not main_worktree:
        return None
    return os.path.join(main_worktree, ".minspec")


def main():
    try:
        env = json.load(sys.stdin)
    except Exception:
        # Can't parse -> fail open, never block on our own bug.
        passthrough()

    tool = env.get("tool_name", "")
    if tool not in ("Edit", "Write", "MultiEdit"):
        passthrough()

    ti = env.get("tool_input", {}) or {}
    fpath = ti.get("file_path") or ti.get("path") or ""
    cwd = env.get("cwd") or os.getcwd()
    if not fpath:
        allow()

    abs_path = fpath if os.path.isabs(fpath) else os.path.join(cwd, fpath)
    try:
        rel = os.path.relpath(abs_path, cwd)
    except Exception:
        rel = fpath
    rel = rel.replace(os.sep, "/")

    # Allowlist: spec/review/config/doc/markdown/scripts are always editable,
    # so the user can always write or fix the specs that unblock the gate.
    allow_prefixes = ("specs/", "docs/", ".minspec/", "scripts/", ".claude/", ".github/")
    if rel.startswith(allow_prefixes) or rel.endswith(".md") or rel.startswith("../"):
        allow()
    if rel.startswith(("node_modules/", "out/", "dist/", "coverage/", ".git/")):
        allow()
    if rel in ("package.json", "package-lock.json", "tsconfig.json"):
        allow()

    # Approvals are resolved from the CANONICAL main checkout (DR-031), not cwd,
    # so a dispatched/linked worktree evaluates against the same human-approved
    # state. None => git missing or cwd not in a repo (handled fail-closed below
    # when gated specs exist). The SPEC files themselves stay read from cwd, so a
    # worktree that *edits* a spec still correctly goes stale.
    canon_dir = canonical_minspec_dir(cwd)
    approvals = {}
    canon_resolved = False
    if canon_dir is not None:
        canon_resolved = True
        ap = os.path.join(canon_dir, "approvals.json")
        if os.path.exists(ap):
            try:
                with open(ap, "r", encoding="utf-8") as fh:
                    approvals = json.load(fh) or {}
            except Exception:
                approvals = {}

    blockers = []
    gated = 0
    for sp in glob.glob(os.path.join(cwd, "specs", "**", "*.md"), recursive=True):
        try:
            with open(sp, "r", encoding="utf-8") as fh:
                head = fh.read(4000)
        except Exception:
            continue
        fmatch = re.match(r'^---\n(.*?)\n---', head, re.S)
        if not fmatch:
            continue
        fm = fmatch.group(1)
        tier = (fm_value(fm, "tier") or "").upper()
        status = (fm_value(fm, "status") or "").lower()
        sid = fm_value(fm, "id") or ""
        if tier not in ("T3", "T4") or status != "implementing" or not sid:
            continue
        gated += 1
        rec = approvals.get(sid)
        cur = sha(sp)
        if not rec:
            blockers.append("%s (not approved)" % sid)
        elif rec.get("specHash") != cur:
            blockers.append("%s (approval stale - spec edited since approval)" % sid)

    # Fail closed: if the canonical approval store is unresolvable AND gated
    # (T3/T4 implementing) specs exist, we cannot prove a human approved -> deny.
    # With no gated specs there is nothing to gate, so allow. (python3-missing is
    # handled fail-open upstream in spec-gate.sh; this is a different failure.)
    if not canon_resolved and gated > 0:
        deny(
            "MinSpec gate: source edit to '%s' blocked. "
            "Cannot resolve the canonical approval store (no readable git "
            "checkout for this working directory), and %d T3/T4 spec(s) are in "
            "implementation. Failing closed: a human approval cannot be verified."
            % (rel, gated)
        )

    if not blockers:
        allow()

    names = ", ".join(blockers)
    deny(
        "MinSpec gate: source edit to '%s' blocked. "
        "Unapproved T3/T4 spec(s) in implementation: %s. "
        "A human must review and approve the spec first "
        "(VS Code: 'MinSpec: Approve Spec for Implementation', or the checkmark "
        "in the MinSpec sidebar)."
        % (rel, names)
    )


if __name__ == "__main__":
    main()
