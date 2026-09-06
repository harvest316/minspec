#!/usr/bin/env python3
"""MinSpec PreToolUse spec gate (DR-362, amended by SPEC-022 / DR-034, scoped #426).

Reads a Claude Code PreToolUse hook envelope on stdin and prints a JSON
permission decision on stdout. Blocks Edit/Write/MultiEdit to a file ONLY when
that file belongs to the OWNED FILE SET of a T3/T4 spec that DERIVES to
`implementing`/`done` and is unapproved (or approved then edited -> stale). This
is the only enforcement that survives bypass-permissions mode, because a
PreToolUse deny blocks the tool call before permission rules.

#426 scoping (DR-047 §3 — doc-before-*CODE*, scoped PAIRWISE to a doc and the code
  that realises THAT doc, never a repo-wide freeze).
  Earlier this gate blocked EVERY non-allowlisted source file while ANY unapproved
  spec was in implementation — freezing unrelated work (e.g. a sibling P1 fix)
  behind a spec it had nothing to do with. That contradicted DR-047 §3, which
  scopes the doc-before-code sequence PAIRWISE to a doc and the code that realises
  THAT doc, never repo-wide. The block is now scoped to the implementation CODE
  each unapproved spec EXPLICITLY declares, from two signals with DELIBERATELY
  DIFFERENT precision:
    - STRUCTURED: a frontmatter `implements:`/`affects:` list. Matched WITHOUT an
      existence filter, so a `Write` to a declared-but-not-yet-existing file is
      DENIED — i.e. this signal blocks CREATION of an unapproved spec's impl code,
      not merely edits to code that already landed. (The primary signal — specs
      across the corpus declare it; see below for the phases gap that still keeps
      some declarations inert.)
    - FUZZY: backtick code-span paths in the spec's own `tasks.md`. Matched ONLY IF
      the file already exists, because a bare backtick token can be prose /
      placeholder / example; the existence filter is what keeps those from widening
      the block set. A necessary consequence is that the fuzzy signal CANNOT block
      creation of a not-yet-existing file.
  A spec that declares NO implementation files owns NOTHING and therefore blocks
  nothing; unrelated source edits pass (fail-OPEN for unrelated files is correct
  per DR-047 §3).

  DOC-BEFORE-*CODE*, NOT DOC-BEFORE-DOC. The gate blocks a spec's implementation
  CODE, never the spec's OWN docs. An unapproved-and-implementing spec's own
  requirements/plan/tasks/design docs stay EDITABLE — you must be able to fix a spec
  to get it approved (the edit-unapproved-specs-directly workflow). Freezing a spec's
  own dir would DEADLOCK approval: you could not edit the very doc whose approval
  unfreezes its code. Approval writes to `.minspec/` are likewise always allowed.
  (An earlier #426 revision wrongly froze each spec's own dir as a "fail-safe
  minimum"; that broke edit-unapproved-specs-directly and is removed — the owned set
  is now EXACTLY the declared impl code, nothing more.)

  HONEST SCOPE (not "DR-362's hole is fully closed"). This gate blocks edits AND
  creation of a spec's STRUCTURALLY-declared (`implements:`/`affects:`) impl files.
  Code an unapproved spec does NOT declare structurally — one that describes its work
  only in prose `tasks.md`, or greenfield code it never names — is NOT gated, because
  the fuzzy `tasks.md` signal is existence-filtered. That is a DELIBERATE, DISCLOSED
  tradeoff to unblock unrelated work per DR-047 §3, NOT a claim that DR-362's
  enforcement hole is fully closed for greenfield/undeclared code.

  The durable fix landed: SPEC-038 / #460 made `implements:`/`affects:` a first-class
  convention, and `validateOwnership` (spec-validator.ts) now REQUIRES a declaration
  from every primary T3/T4 spec whose `plan` phase has started. Specs across the
  corpus carry one, so the STRUCTURED signal below is the primary one — not, as this
  docstring said until #1848, a path nothing exercises.

  The gap that remains is PHASES, not declaration: a spec carrying no `phases:` block
  never reaches the owned-set computation at all (the `phase_intent_status` `continue`
  further down runs BEFORE `owned_file_set`), so its declaration arms nothing. That
  backfill is #1543 / #1649.

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


def fm_list(fm, key):
    """Raw tokens of a frontmatter list `key:`, inline or YAML block form.

    Accepts `key: a, b`, `key: [a, b]`, and the block form:
        key:
          - a
          - b
    Returns a list of raw string tokens (quotes/whitespace stripped). Empty when
    the key is absent. Purely a tokenizer — path validation happens downstream.
    """
    toks = []
    inline = fm_value(fm, key)
    if inline is not None:
        for t in re.split(r'[,\s\[\]]+', inline):
            if t:
                toks.append(t.strip().strip('"').strip("'"))
        return toks
    # Block-list form: `key:` alone on its line, then `  - item` lines.
    lines = fm.split("\n")
    for i, line in enumerate(lines):
        if re.match(r'^' + re.escape(key) + r'[ \t]*:[ \t]*(?:#.*)?$', line):
            for cont in lines[i + 1:]:
                if re.match(r'^[ \t]*$', cont):
                    continue
                m = re.match(r'^[ \t]+-[ \t]*(.+?)[ \t]*(?:#.*)?$', cont)
                if not m:
                    break  # de-indented / next key -> list ended
                toks.append(m.group(1).strip().strip('"').strip("'"))
            break
    return toks


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

    DR-069 §3 — FREEZE-GATE, DO NOT ALIGN TO deriveStatus/#886. deriveStatus now
    returns 'planning' for approved plan/tasks specs (implement not started), but this
    gate MUST keep plan/tasks in the 'implementing' band: narrowing it so plan/tasks
    return 'planning'/'specifying' would drop unapproved plan/tasks specs out of the
    gate range (the `intended not in ('implementing','done')` skip below) and silently
    reopen the freeze hole that DR-012/DR-031 close (the local-register ids; DR-362 is
    the mmo-platform parent-register number, not valid here). The #886 split lives ONLY
    in deriveStatus (the signpost).
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


# --- #426 scoping: derive each spec's OWNED file set (declared impl code only) --

# Source extensions a declared impl-file token must end in (precision filter).
_SRC_EXT_RE = re.compile(
    r'\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|bash|json|jsonc|css|scss|less|html|htm'
    r'|vue|svelte|sql|ya?ml|toml)$', re.I)
_INFRA_PREFIXES = ("node_modules/", "out/", "dist/", "coverage/", ".git/")
_CODE_SPAN_RE = re.compile(r'`([^`]+)`')


def _blocker_reason(sid, verdict):
    if verdict == "stale":
        return "%s (approval stale - spec edited since approval)" % sid
    return "%s (not approved)" % sid


def declared_impl_files(cwd, fm, spec_dir_abs):
    """Source files a spec EXPLICITLY names as its implementation targets.

    This IS the spec's entire owned set (doc-before-CODE): the ONLY files an
    unapproved spec's state blocks. The spec's own doc dir is deliberately NOT
    included — see owned_file_set.

    Two signals with DELIBERATELY DIFFERENT existence handling:
      - STRUCTURED frontmatter `implements:`/`affects:` list (`require_exists=
        False`): a token is owned REGARDLESS of whether the file exists yet, so a
        `Write` to a declared-but-not-yet-created file is blocked. This is what
        makes the gate block CREATION of an unapproved spec's impl code, not only
        edits to code that already landed (#426 review fix; durable convention +
        validator LANDED as SPEC-038 / #460). This is the primary ownership signal:
        specs across the corpus declare it, and the validator requires it of every
        primary T3/T4 spec whose `plan` phase has started. A declaration on a
        PHASELESS spec still arms nothing — see the module docstring — but that is a
        phases gap (#1543), not an unused code path.
      - FUZZY backtick code-span paths in the spec's own `tasks.md`
        (`require_exists=True`): a bare backtick token can be prose / example /
        placeholder, so it only counts when it RESOLVES TO AN EXISTING FILE. That
        existence filter is what stops prose tokens widening the block set — and
        by construction means the fuzzy signal cannot block creation of a
        not-yet-existing file (the disclosed greenfield gap, #460).

    Shared precision/safety filters apply to BOTH signals: a token counts only if
    it contains '/', ends in a known source extension, and is not an absolute /
    parent-escape / infra path. Fail-safe by construction: the STRUCTURED signal
    reads only the already-loaded frontmatter (no I/O), so a structurally-declared
    impl file is always owned regardless; only the FUZZY tasks.md read can raise,
    and it degrades to an empty contribution — consistent with that signal's own
    existence filter (an unreadable/absent tasks.md simply declares no fuzzy paths).
    """
    files = set()

    def consider(token, require_exists):
        token = token.strip().strip('"').strip("'").strip()
        if not token or "/" not in token:
            return
        p = token.replace("\\", "/")
        if p.startswith("./"):
            p = p[2:]
        # No absolute / parent-escape / infra paths (kept for BOTH signals).
        if p.startswith("/") or p.startswith("../") or ".." in p.split("/"):
            return
        if p.startswith(_INFRA_PREFIXES):
            return
        if not _SRC_EXT_RE.search(p):
            return
        # Existence filter applies ONLY to the fuzzy tasks.md signal. Structured
        # declarations are owned regardless of existence, so creation is blocked.
        if require_exists and not os.path.isfile(os.path.join(cwd, p)):
            return
        files.add(p)

    # STRUCTURED signal: block regardless of existence (creation-blocking).
    for key in ("implements", "affects"):
        for tok in fm_list(fm, key):
            consider(tok, require_exists=False)

    # FUZZY signal: backtick paths in tasks.md, existence-filtered.
    try:
        with open(os.path.join(spec_dir_abs, "tasks.md"), "r", encoding="utf-8") as fh:
            tasks_text = fh.read()
    except Exception:
        tasks_text = ""
    for m in _CODE_SPAN_RE.finditer(tasks_text):
        consider(m.group(1), require_exists=True)
    return files


def owned_file_set(cwd, sp, fm):
    """The set of files a spec OWNS — the ONLY files its unapproved state blocks.

    DOC-BEFORE-*CODE*, NOT doc-before-doc (DR-047 §3). The owned set is EXACTLY the
    implementation CODE the spec declares (structured `implements:`/`affects:` +
    fuzzy existing tasks.md paths) — NEVER the spec's own doc dir. An unapproved-
    and-implementing spec's own requirements/plan/tasks/design docs stay EDITABLE so
    the spec can be fixed and approved (edit-unapproved-specs-directly); freezing
    them would deadlock approval. A spec that declares NO impl files owns NOTHING
    and therefore blocks nothing. Returns a set of exact POSIX rel paths.
    """
    return declared_impl_files(cwd, fm, os.path.dirname(sp))


def owned_match(rel, files):
    """True if `rel` (POSIX, cwd-relative) is in a spec's owned (declared-impl) set.

    Membership is CASE-INSENSITIVE, consistent with the `os.path.isfile` existence
    check (which resolves case-insensitively on a case-insensitive filesystem).
    Otherwise a declared `thing.ts` could be added to the owned set while a `Write`
    to the real-cased `Thing.ts` slipped a case-SENSITIVE membership test (#426
    review fix). Case-folding only ever WIDENS the block set (fail-closed) — it
    never unfreezes a file.
    """
    return rel.lower() in {f.lower() for f in files}


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

    # A path outside the repo (../…) can never be part of a spec's file set.
    if rel.startswith("../"):
        allow()

    # Approval resolution: committed sidecar under cwd FIRST (FR-1 — present in
    # every clone/worktree/CI checkout), then the DR-031 common-dir fallback for
    # an uncommitted local approval during authoring. The fallback is no longer
    # load-bearing, but its resolution also tells us whether cwd is in a repo for
    # the fail-closed guard below.
    canon_dir = canonical_minspec_dir(cwd)
    canon_resolved = canon_dir is not None

    # Build the blocking set: every T3/T4 spec whose PHASES put it in the
    # implementation range (plan/tasks/implement/done) AND whose approval is
    # missing/stale, paired with the file set it OWNS. A target file is blocked
    # ONLY if it falls inside one of these owned sets (#426 / DR-047 §3 — the
    # doc-before-code gate applies to the code implementing THAT doc, never a
    # repo-wide freeze).
    gated = 0
    blocking = []      # (sid, verdict, files)
    migrated = []      # (sid, files)
    seen_ids = set()
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

        # One entry per spec identity. In practice only requirements.md carries
        # the tier, but dedup defensively so a spec is never double-listed.
        if sid in seen_ids:
            continue
        seen_ids.add(sid)
        gated += 1

        files = owned_file_set(cwd, sp, fm)

        if approval in ("unapproved", "stale"):
            blocking.append((sid, approval, files))
        elif rec and rec.get("migrated") is True:
            # WARN phase: migrated counts as approved -> non-blocking, but noted.
            migrated.append((sid, files))

    # Does the target file fall inside any BLOCKING spec's owned set?
    matched = [(sid, verdict) for (sid, verdict, fil) in blocking
               if owned_match(rel, fil)]

    if matched:
        # Fail closed: if the canonical store is unresolvable (cwd is not a git
        # checkout) we cannot positively prove a human approved — and this file IS
        # in an unapproved spec's owned set, so deny rather than risk unfreezing
        # it. Unrelated files never reach here (matched would be empty), so the
        # fail-closed guard no longer freezes unrelated work. (python3-missing is
        # handled fail-open in the .sh.)
        if not canon_resolved:
            deny(
                "MinSpec gate: source edit to '%s' blocked. "
                "Cannot resolve the approval store (no readable git checkout) and "
                "the file is in the owned set of %d unapproved T3/T4 spec(s) in "
                "implementation. Failing closed: a human approval cannot be "
                "verified." % (rel, len(matched))
            )
        names = ", ".join(_blocker_reason(sid, v) for sid, v in matched)
        deny(
            "MinSpec gate: source edit to '%s' blocked. "
            "Unapproved T3/T4 spec(s) in implementation: %s. "
            "A human must review and approve the spec first "
            "(VS Code: 'MinSpec: Approve Spec for Implementation', or the checkmark "
            "in the MinSpec sidebar)."
            % (rel, names)
        )

    # No blocker owns this file. Surface a migrated-approval WARN only when the
    # file is inside a migrated spec's own set (FR-5, scoped), else plain allow.
    warn_ids = [sid for (sid, fil) in migrated if owned_match(rel, fil)]
    if warn_ids:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": (
                "MinSpec gate (WARN): approval migrated for %s — re-approve to "
                "clear (MinSpec: Approve Spec for Implementation). Allowed for "
                "now; promotion to a hard block is pending a clean corpus."
                % ", ".join(warn_ids))}}))
        sys.exit(0)
    allow()


if __name__ == "__main__":
    main()
