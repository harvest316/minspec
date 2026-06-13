#!/usr/bin/env python3
"""MinSpec PreToolUse spec gate (DR-362, amended by SPEC-022 / DR-034).

Reads a Claude Code PreToolUse hook envelope on stdin and prints a JSON
permission decision on stdout. Blocks Edit/Write/MultiEdit to *source* files
while any T3/T4 spec that DERIVES to `implementing`/`done` is unapproved (or
approved then edited -> stale). This is the only enforcement that survives
bypass-permissions mode, because a PreToolUse deny blocks the tool call before
permission rules.

SPEC-022 changes:
  - Approval ground truth is COMMITTED, path-keyed sidecars under
    `.minspec/approvals/<repo-relative-spec-path>.json`, read from `cwd` FIRST.
    The DR-031 `--git-common-dir` resolution is demoted to a FALLBACK for an
    uncommitted local approval during authoring — a committed sidecar exists in
    every clone/worktree/CI checkout, so the common-dir read is no longer
    load-bearing.
  - Status is DERIVED from {phases, approval}, not the literal `status:` line —
    so `implementing`/`done` is structurally impossible without an approval.
  - Hashing is CANONICAL (canonical.py's spec_hash), excluding the lifecycle
    fields, so the tool's own status flips don't void approval.
  - WARN phase (FR-5): a `migrated:true` sidecar counts as approved (non-blocking)
    but its message notes "approval migrated — re-approve to clear". Promotion to
    ERROR (migrated/drift -> deny) is a separate, later one-line change.

Invoked by spec-gate.sh (which handles the MINSPEC_GATE_OFF kill-switch).
"""
import json
import sys
import os
import re
import glob
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import canonical  # noqa: E402  (sibling module; canonical.py spec_hash twin)


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


def spec_hash(path):
    """Canonical spec hash (FR-3) of a file, or None if unreadable."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return canonical.spec_hash(fh.read())
    except Exception:
        return None


def parse_phases(fm):
    """Extract the `phases:` map from a frontmatter block as {phase: status}."""
    phases = {}
    in_block = False
    for line in fm.split("\n"):
        if in_block:
            m = re.match(r'^[ \t]+(\w[\w-]*)[ \t]*:[ \t]*(.+?)[ \t]*(?:#.*)?$', line)
            if re.match(r'^[ \t]+', line):
                if m:
                    phases[m.group(1)] = m.group(2).strip()
                continue
            in_block = False
        if re.match(r'^phases[ \t]*:', line):
            in_block = True
    return phases


_PHASE_ORDER = ["specify", "clarify", "plan", "tasks", "implement"]


def _all_pending(phases):
    return all(phases.get(p, "pending") == "pending" for p in _PHASE_ORDER)


def _all_required_done(phases):
    for p in _PHASE_ORDER:
        st = phases.get(p, "pending")
        if st in ("pending", "in-progress"):
            return False
    return True


def _current_phase(phases):
    """First in-progress phase, else first pending phase, else None (complete)."""
    for p in _PHASE_ORDER:
        if phases.get(p, "pending") == "in-progress":
            return p
    for p in _PHASE_ORDER:
        if phases.get(p, "pending") == "pending":
            return p
    return None


def phase_intent_status(phases, explicit_terminal):
    """Phase-position status — the gate's "is this spec in implementation?" test.

    Mirrors lifecycle.ts getSpecStatus (the preview-only, phase-based derivation):
    distinguishes specify/clarify (-> specifying) from plan/tasks/implement
    (-> implementing) by the CURRENT phase, NOT by approval. The gate uses THIS to
    decide whether a spec is gated (in the plan+ implementation range) — then the
    real approval verdict decides allow/deny. Using deriveStatus here instead
    would mis-gate a specify-phase spec, because deriveStatus discriminates
    specifying<->implementing by approval, not phase.
    """
    if explicit_terminal:
        return explicit_terminal
    if _all_pending(phases):
        return "new"
    if _all_required_done(phases):
        return "done"
    cur = _current_phase(phases)
    if cur in ("specify", "clarify"):
        return "specifying"
    return "implementing"


def canonical_minspec_dir(cwd):
    """Resolve the canonical (main worktree) .minspec/ dir for `cwd` (DR-031).

    DEMOTED to a fallback under SPEC-022: committed sidecars under cwd are read
    first; this only covers an uncommitted local approval during authoring when
    the cwd sidecar is absent. Returns the abs path to `<main-worktree>/.minspec`,
    or None if git is absent / cwd is not a repo / resolution fails.
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
    main_worktree = os.path.dirname(os.path.normpath(common))
    if not main_worktree:
        return None
    return os.path.join(main_worktree, ".minspec")


def read_record(minspec_dir, rel_spec_path):
    """Read a path-keyed sidecar `<minspec_dir>/approvals/<rel>.json` or None."""
    if not minspec_dir:
        return None
    sidecar = os.path.join(minspec_dir, "approvals", rel_spec_path + ".json")
    if not os.path.exists(sidecar):
        return None
    try:
        with open(sidecar, "r", encoding="utf-8") as fh:
            rec = json.load(fh)
    except Exception:
        return None
    if not isinstance(rec, dict):
        return None
    # Shallow shape check — a malformed sidecar is treated as "no record".
    if not isinstance(rec.get("specHash"), str):
        return None
    return rec


def resolve_record(cwd, canon_dir, rel_spec_path):
    """Committed sidecar from cwd FIRST, then the common-dir fallback."""
    rec = read_record(os.path.join(cwd, ".minspec"), rel_spec_path)
    if rec is not None:
        return rec
    return read_record(canon_dir, rel_spec_path)


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

    # Approval resolution: committed sidecar under cwd FIRST (FR-1 — present in
    # every clone/worktree/CI checkout), then the DR-031 common-dir fallback for
    # an uncommitted local approval during authoring. The fallback is no longer
    # load-bearing, but its resolution also tells us whether cwd is in a repo for
    # the fail-closed guard below.
    canon_dir = canonical_minspec_dir(cwd)
    canon_resolved = canon_dir is not None

    blockers = []
    migrated_notes = []
    gated = 0
    for sp in glob.glob(os.path.join(cwd, "specs", "**", "*.md"), recursive=True):
        try:
            with open(sp, "r", encoding="utf-8") as fh:
                head = fh.read(8000)
        except Exception:
            continue
        fmatch = re.match(r'^---\n(.*?)\n---', head, re.S)
        if not fmatch:
            continue
        fm = fmatch.group(1)
        tier = (fm_value(fm, "tier") or "").upper()
        sid = fm_value(fm, "id") or ""
        if tier not in ("T3", "T4") or not sid:
            continue

        # Repo-relative POSIX path = the approval store key.
        try:
            spec_rel = os.path.relpath(sp, cwd)
        except Exception:
            spec_rel = sp
        spec_rel = spec_rel.replace(os.sep, "/")

        rec = resolve_record(cwd, canon_dir, spec_rel)
        cur = spec_hash(sp)
        phases = parse_phases(fm)

        # Approval verdict (canonical hash match). A migrated record still counts
        # as approved (WARN phase, FR-5) but is flagged.
        if rec and isinstance(cur, str) and rec.get("specHash") == cur:
            approval = "approved"
        elif rec:
            approval = "stale"
        else:
            approval = "unapproved"

        # The literal status can be archived (explicit terminal, human act) — an
        # archived spec is terminal and never gated.
        literal_status = (fm_value(fm, "status") or "").lower()
        explicit_terminal = "archived" if literal_status == "archived" else None

        # Is this spec gated? A spec is gated when its PHASES put it in the
        # implementation range (plan/tasks/implement), independent of approval.
        # We use the phase-position status (phase_intent_status), NOT deriveStatus:
        # an UNAPPROVED implementing-phase spec must still be recognised as gated
        # (deriveStatus(unapproved) -> 'specifying' would make the gate never fire,
        # the exact enforcement hole this gate exists to close), AND a genuine
        # specify/clarify-phase spec must NOT be gated. The real approval verdict
        # below then decides allow/deny. An explicit terminal (archived) is never
        # gated.
        intended = phase_intent_status(phases, explicit_terminal)
        if intended not in ("implementing", "done"):
            continue  # phases don't put it in implementation — nothing to gate
        gated += 1

        if approval == "unapproved":
            blockers.append("%s (not approved)" % sid)
        elif approval == "stale":
            blockers.append("%s (approval stale - spec edited since approval)" % sid)
        elif rec and rec.get("migrated") is True:
            # WARN phase: migrated counts as approved -> non-blocking, but noted.
            migrated_notes.append(sid)

    # Fail closed: if the canonical store is unresolvable (cwd not a repo) AND
    # gated specs exist with NO committed sidecar found, we cannot prove a human
    # approved -> deny. With a committed sidecar (FR-1) this no longer trips for
    # a normal clone/worktree. (python3-missing is handled fail-open in the .sh.)
    if not canon_resolved and gated > 0 and blockers:
        deny(
            "MinSpec gate: source edit to '%s' blocked. "
            "Cannot resolve the approval store (no readable git checkout) and %d "
            "T3/T4 spec(s) derive to implementation. Failing closed: a human "
            "approval cannot be verified." % (rel, gated)
        )

    if not blockers:
        # WARN phase: migrated records are allowed but surfaced (still allow()).
        if migrated_notes:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": (
                    "MinSpec gate (WARN): approval migrated for %s — re-approve to "
                    "clear (MinSpec: Approve Spec for Implementation). Allowed for "
                    "now; promotion to a hard block is pending a clean corpus."
                    % ", ".join(migrated_notes))}}))
            sys.exit(0)
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
