---
id: SPEC-026
type: design
status: specifying
product: minspec
epic: EPIC-009  # Team Readiness
---

# SPEC-026 — Design / Plan input (DRAFT)

> **Plan-phase draft, not the approved plan.** Captured from the 9-agent design
> workflow (2026-07-01) so the concrete hook bodies + contracts survive outside
> ephemeral scratch. Requirements are authoritative in [requirements.md](./requirements.md);
> this is implementation detail for FR-8..16.

## Build order (vertical slice)

Thinnest end-to-end path first, then expand:

1. **Presence core (FR-1..4)** — `presence.ts`: `SessionPresenceRecord` (incl.
   `worktreeRoot`), atomic write, heartbeat, `getActiveSessions()` liveness/prune.
   `session.ts`: add `sessionId`. Gitignore `.minspec/sessions/`. → T0 INV-1,2,3,5,6.
2. **Predicate + parity (FR-10, FR-14)** — `contendingLiveSessions()` in TS; the bash
   twin; golden-fixture parity test. → T0 INV-8,10,13. This is the keystone: both the
   UI advisory and the hard gate consume this one predicate.
3. **Self-id (FR-11)** — `prepare-commit-msg` hook + `MINSPEC_SESSION_ID` export.
4. **Hard backstop (FR-12,13)** — pre-commit stanza + arbitration. → T0 INV-7,9,11,12.
5. **HEAD guard (FR-15)** — `post-checkout` auto-revert.
6. **UI (FR-5, FR-9, FR-16)** — status-bar `👥`, worktree-steer toast, Quick Pick +
   resolution-prompt/reveal actions.
7. **CLAUDE.md etiquette block (FR-9)** — the SOFT agent binding.

## Contracts

- `SessionPresenceRecord` — FR-2 (on-disk public API; add-only).
- `SessionState.sessionId: string` — new field on `.minspec/session.json`.
- `contendingLiveSessions(paths: string[]): { path: string; peer: SessionPresenceRecord }[]`
  — the single liveness+coverage predicate (TS), mirrored byte-for-verdict in bash.
- Trailer key constant `MinSpec-Session:` — frozen contract, in git history.
- Kill-switches: `MINSPEC_CEDIT_OFF`, `MINSPEC_HEADGUARD_OFF`, `MINSPEC_TRAILER_OFF`.
- Constants: `HEARTBEAT_SECS=30`, `STALE_SECS=120` (paired, 4×); duplicated in bash with tie-back comment.

## Hook bodies (managed-block idiom: `set -u`, fail-open, actor-agnostic, kill-switch)

### 1. APPEND to `.minspec/hooks/pre-commit` (after existing DR-037 stages)

```bash
# ── Concurrent-Edit Guard (SPEC-026 FR-12/13): local-runtime advisory gate ──
# NOT a deterministic gate — keys on gitignored live presence. No-op where presence
# is absent (CI/fresh clone) so it never emits a verdict CI can't reproduce (FR-8).
# Fail-open on ANY error. Bypass: MINSPEC_CEDIT_OFF=1
minspec_cedit_gate() {
  [ "${MINSPEC_CEDIT_OFF:-0}" = "1" ] && return 0
  sess_dir="$repo_root/.minspec/sessions"
  [ -d "$sess_dir" ] || return 0                          # CI/absent → no-op (FR-8)
  set -- "$sess_dir"/*.session.json 2>/dev/null
  [ -e "$1" ] || return 0                                  # empty dir → no-op
  wt=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  now=$(date +%s 2>/dev/null) || return 0
  # self-id from the composed message trailer (FR-11); may be empty (fail-open self)
  me=""; [ -n "${MINSPEC_COMMIT_MSG_FILE:-}" ] && me=$(grep -m1 '^MinSpec-Session:' "$MINSPEC_COMMIT_MSG_FILE" 2>/dev/null | sed 's/^MinSpec-Session:[[:space:]]*//')
  [ -n "$me" ] || me=$(grep -m1 '"sessionId"' "$repo_root/.minspec/session.json" 2>/dev/null | sed -E 's/.*"sessionId"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
  my_start=$(grep -m1 '"startedAt"' "$repo_root/.minspec/session.json" 2>/dev/null | sed -E 's/.*"startedAt"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
  staged=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null) || return 0
  gate_fail=0
  for rec in "$sess_dir"/*.session.json; do
    r_id=$(grep -m1 '"sessionId"' "$rec" 2>/dev/null | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/'); [ -n "$r_id" ] || continue
    [ "$r_id" = "$me" ] && continue                         # self (FR-11) — never block own
    r_wt=$(grep -m1 '"worktreeRoot"' "$rec" 2>/dev/null | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/'); [ "$r_wt" = "$wt" ] || continue   # P2 same tree
    r_pid=$(grep -m1 '"pid"' "$rec" 2>/dev/null | sed -E 's/.*:[[:space:]]*([0-9]+).*/\1/'); [ -n "$r_pid" ] || continue
    r_seen=$(grep -m1 '"lastSeen"' "$rec" 2>/dev/null | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')
    r_epoch=$(date -d "$r_seen" +%s 2>/dev/null) || continue
    [ $(( now - r_epoch )) -lt 120 ] || continue           # P3 fresh heartbeat
    kill -0 "$r_pid" 2>/dev/null || continue               # P3 alive PID
    r_allow=$(sed -n '/"fileAllowlist"[[:space:]]*:[[:space:]]*\[/,/\]/p' "$rec" 2>/dev/null | grep -oE '"[^"]+"' | sed 's/"//g' | grep -v fileAllowlist)
    [ -n "$r_allow" ] || continue                           # P4 empty allowlist = no claim
    for P in $staged; do
      case "$P" in specs/*|docs/decisions/*|docs/domain/*|docs/epics/*) ;; *) continue ;; esac
      for A in $r_allow; do
        if [ "$P" = "$A" ] || [ "${P#$A/}" != "$P" ] || { [ "${A%/\*}" != "$A" ] && d=${A%/\*} && [ "${P#$d/}" != "$P" ]; }; then
          # arbitration (FR-13): earlier startedAt holds; block only the later self
          r_start=$(grep -m1 '"startedAt"' "$rec" 2>/dev/null | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')
          if [ -z "$my_start" ] || [ -z "$r_start" ] || [ "$r_start" \< "$my_start" ]; then
            echo "✗ MinSpec Concurrent-Edit Guard: '$P' is being edited by LIVE session $r_id (pid $r_pid, seen ${r_seen}) in this working tree." >&2
            echo "  It started earlier and holds this file. Open a worktree (scripts/new-worktree.sh) or wait — it drops off within 120s when done." >&2
            echo "  Bypass: MINSPEC_CEDIT_OFF=1 git commit ..." >&2
            gate_fail=1
          fi
        fi
      done
    done
  done
  return $gate_fail
}
minspec_cedit_gate || exit 1
```

> **FR-15 branch-assertion** deliberately omitted from this draft pending the Plan
> decision on the heartbeat-self-heal subtlety (requirements.md FR-15.2). Structural
> (FR-9) + post-checkout (below) are the load-bearing (c) protections.

### 2. NEW `.minspec/hooks/prepare-commit-msg` (FR-11)

```sh
#!/usr/bin/env sh
# >>> minspec:managed:prepare-commit-msg-hook >>>
# Stamp MinSpec-Session: <sessionId> so pre-commit can identify self without PID
# ancestry (robust to a shared ext-host PID). Fail-open. Bypass: MINSPEC_TRAILER_OFF=1
set -u
[ "${MINSPEC_TRAILER_OFF:-0}" = "1" ] && exit 0
msg_file="${1:-}"; [ -n "$msg_file" ] && [ -w "$msg_file" ] || exit 0
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
sid="${MINSPEC_SESSION_ID:-}"
[ -n "$sid" ] || sid=$(grep -m1 '"sessionId"' "$repo_root/.minspec/session.json" 2>/dev/null | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')
[ -n "$sid" ] || exit 0                                    # no id → append nothing (fail-open)
grep -q '^MinSpec-Session:' "$msg_file" 2>/dev/null && exit 0
printf '\nMinSpec-Session: %s\n' "$sid" >> "$msg_file" 2>/dev/null || true
exit 0
# <<< minspec:managed:prepare-commit-msg-hook <<<
```

### 3. NEW `.minspec/hooks/post-checkout` (FR-15.1 — auto-revert, D2)

```sh
#!/usr/bin/env sh
# >>> minspec:managed:post-checkout-hook >>>
# Detect a branch switch under a live same-worktree peer with uncommitted work and
# revert it (only actor-agnostic hook that fires on switch; fires AFTER → remediate,
# not veto). Fail-open. Bypass: MINSPEC_HEADGUARD_OFF=1
set -u
[ "${MINSPEC_HEADGUARD_OFF:-0}" = "1" ] && exit 0
prev="${1:-}"; new="${2:-}"; branch_flag="${3:-0}"
[ "$branch_flag" = "1" ] || exit 0                          # only branch changes
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
sess_dir="$repo_root/.minspec/sessions"; [ -d "$sess_dir" ] || exit 0
[ -n "$(git status --porcelain 2>/dev/null)" ] || exit 0   # only if uncommitted work present
wt=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
now=$(date +%s 2>/dev/null) || exit 0
live_peer=0
for rec in "$sess_dir"/*.session.json; do
  [ -e "$rec" ] || continue
  r_wt=$(grep -m1 '"worktreeRoot"' "$rec" 2>/dev/null | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/'); [ "$r_wt" = "$wt" ] || continue
  r_pid=$(grep -m1 '"pid"' "$rec" 2>/dev/null | sed -E 's/.*:[[:space:]]*([0-9]+).*/\1/'); [ -n "$r_pid" ] || continue
  r_seen=$(grep -m1 '"lastSeen"' "$rec" 2>/dev/null | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')
  r_epoch=$(date -d "$r_seen" +%s 2>/dev/null) || continue
  [ $(( now - r_epoch )) -lt 120 ] || continue
  kill -0 "$r_pid" 2>/dev/null || continue
  live_peer=1; break
done
if [ "$live_peer" = "1" ]; then
  echo "✗ MinSpec: HEAD moved under a LIVE session with uncommitted work — reverting the switch." >&2
  echo "  Use a worktree for a different branch: scripts/new-worktree.sh <name> (rule #8)." >&2
  echo "  Bypass: MINSPEC_HEADGUARD_OFF=1" >&2
  git switch - >/dev/null 2>&1 || git checkout - >/dev/null 2>&1 || true
fi
exit 0
# <<< minspec:managed:post-checkout-hook <<<
```

## CLAUDE.md "Concurrent-Session Etiquette" block (FR-9 — the SOFT agent binding)

Added to the CLAUDE.md template (the only layer an autonomous agent reads on its own):

```markdown
## Concurrent-Session Etiquette (SPEC-026 Concurrent-Edit Guard)

You may be one of 2-4 Claude/VS Code sessions on ONE checkout. Before you edit or
switch branches, check for LIVE peers by reading `.minspec/sessions/*.session.json`
with your file/shell tools (you cannot see the status bar).

A peer is LIVE iff `(now - lastSeen) < 120s` AND `kill -0 <pid>` succeeds. Ignore
dead/stale peers.

1. Before EDITING a corpus file F (specs/**, docs/decisions/**, docs/domain/**,
   docs/epics/**): if a LIVE peer whose `worktreeRoot` equals yours
   (`git rev-parse --show-toplevel`) lists F (or a covering dir/glob) in its
   `fileAllowlist`, do NOT edit F — pick different work, or open your own worktree
   (`scripts/new-worktree.sh <name>` then `cd` in).
2. Before any HEAD-MOVING git op (`switch`/`checkout <branch>`/`reset --hard`/`merge`)
   on the PRIMARY checkout: if ANY other LIVE session shares your `worktreeRoot`, do
   NOT move HEAD — use a worktree (rule #8). Verify the current branch first; if it
   changed unexpectedly, STOP and surface it.
3. Keep your `fileAllowlist` honest and current — the backstop can only serialize
   files a peer actually declared.
4. Advisory; the pre-commit hook is the backstop if you skip them — so skipping WASTES
   work, it does not unblock you. If the hook rejects your commit naming a live peer,
   that peer started earlier and holds the file: open a worktree or wait (it drops off
   within 120s).
```

## Open plan questions (carried from the design workflow)

- **OQ-5 (self-id plumbing):** git does not pass the message-file to `pre-commit`.
  Confirm the ext reliably exports `MINSPEC_COMMIT_MSG_FILE` to the agent's
  integrated-terminal shell; else self-id degrades to the `session.json` read (fine for
  single-checkout).
- **FR-15.2 branch-assertion:** decide snapshot-intent vs drop (heartbeat self-heal).
- **fileAllowlist hygiene:** whether to make an accurate allowlist mandatory at session
  start (closes the both-non-compliant blind spot) — #380 fan-out.
