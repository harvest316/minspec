---
id: SPEC-026
type: requirements
status: specifying
tier: T4
product: minspec
epic: EPIC-009  # Team Readiness — concurrent multi-session coordination
depends_on: [SPEC-022]  # SPEC-022 FR-1 resolved the approvals race (per-spec sidecars); this spec adds presence + the concurrent-edit guard on top
relates_to: [SPEC-015]  # SPEC-015 status lanes own the status-bar surface this spec extends
phases:
  specify: done
  clarify: done   # 4 gating decisions resolved by Paul Harvey 2026-07-01 (see Resolved Decisions)
  plan: pending
  tasks: pending
  implement: pending
---

# Session Presence + Concurrent-Edit Guard

> Gives concurrent MinSpec sessions awareness of each other via a lightweight
> file-based heartbeat directory (FR-1..7), then layers a **Concurrent-Edit Guard**
> (FR-8..16) that turns silent inter-session collisions into prevented conflicts —
> structurally where possible, and loud + actionable where not.

Triggered by: [#380](https://github.com/harvest316/minspec/issues/380) — session
presence heartbeat. Guard layer designed + adversarially verified via a 9-agent
judge-panel workflow (2026-07-01); the winning design is worktree-steer (structural
prevention) + a liveness-gated pre-commit backstop, reusing the presence heartbeat
as the claim-map (no separate lock store).

## Context

A MinSpec user routinely runs 2–4 Claude/VS Code sessions concurrently on the
same checkout. Each session has its own `session.json` (scope, project, type, specs
in-flight, file allowlist) but zero visibility into what the others are doing.
This produces invisible conflicts: two sessions touching the same spec, the same
approvable, or the same branch at the same moment, with no signal until git reports
a conflict or VS Code shows "file changed on disk."

**Root cause of invisible collisions:** there is no shared, always-current, process-local
presence signal. Each session is an island.

**Approvals race already fixed.** SPEC-022 FR-1 converts the single `approvals.json`
to per-spec committed sidecars under `.minspec/approvals/`. Two sessions approving
different specs no longer produce merge conflicts. SPEC-026 does not re-solve that.

**What remains** are the residual conflicts SPEC-022 did not touch:
- **(a) Same-file edit** — two live sessions editing the same corpus file → wasted
  work + a clobber at commit.
- **(b) Same-status/checkbox edit** — reduces to (a): derived status lives in a file.
- **(c) HEAD corruption** — a `git switch`/`checkout`/`reset`/`merge` moving HEAD
  under another live session on the shared checkout (global rule #8; the user hits
  this roughly every two hours and does not grok git, so tooling must self-enforce).

This was observed live while authoring this very spec: a `git push` of an unrelated
housekeeping commit was rejected non-fast-forward because four other sessions' PRs
had merged to `origin/main` in parallel.

### The critical constraint — what binds an autonomous agent

Autonomous Claude Code agents do **not** read the VS Code status bar and do **not**
invoke Command-Palette commands on their own initiative. They edit files directly and
run git via the shell. So a solution binds on an agent only via:
1. **SOFT / editor-time** — instructions the agent reads at session start (CLAUDE.md).
   Advisory, bypassable.
2. **HARD / actor-agnostic** — a git hook that fires deterministically no matter who
   commits. The only thing that binds an agent that ignored the advisory. This is the
   existing MinSpec idiom (`.minspec/hooks/`, DR-037; fail-open, env kill-switch).

### Relationship to existing `session.json`

`session.json` (singular, gitignored) is a single-session view: the active scope,
project, type, and file allowlist for **this** session. SPEC-026 adds a **`sessions/`
presence directory** (also gitignored, ephemeral) where **every** active session
writes its own heartbeat file, derived from its `session.json`. The two are
complementary: `session.json` = "what am I doing"; `sessions/<uuid>.json` = "who
else is here and what are they doing." The guard (FR-8+) reads the presence directory
as its **claim-map** — a peer's `fileAllowlist`, written ≤30s ago and leased by its
heartbeat, IS its live claim. No separate `.minspec/locks/` store is introduced.

## Resolved Decisions (Clarify phase — Paul Harvey, 2026-07-01)

| # | Question | Resolution |
|---|---|---|
| D1 | Worktree enforcement strength | **Steer + commit backstop.** Advisory steer (toast + CLAUDE.md) into a worktree; the hard pre-commit gate blocks ONLY a genuine live-clobber (two live sessions staging the same file in the same tree). Solo/sequential never blocked. |
| D2 | HEAD-switch remediation | **Auto-revert.** `post-checkout` switches back automatically when a live same-tree peer has uncommitted work (no git hook can veto the switch itself — confirmed on git 2.43). |
| D3 | Self-identification in a public repo | **Stamp `MinSpec-Session: <uuid>` trailer** into commit messages. Random per-session UUID, no personal data; enables a CI-visible self-id the runtime gate never depends on. |
| D4 | Findability → **conflict resolution** | Reframed by the user: the need is to *resolve* conflicts, ranked **prevent > sessions auto-resolve > HITL**. HITL must name the peer by its human-readable **scope/title** (never a worktree path to guess) + give a copy/paste prompt. Tier-2 auto-resolve (inter-session comms) is a genuinely separate feature → fast-follow SPEC-027. |

## Requirements — Layer 1: Presence (FR-1..7)

### FR-1 — Sessions presence directory

- `.minspec/sessions/` is the presence directory, gitignored by construction
  (added to `MINSPEC_GITIGNORE_ENTRIES` in `scaffold.ts`).
- Each active session writes exactly **one file** at
  `.minspec/sessions/<sessionId>.session.json` where `sessionId` is a UUID-v4
  generated on extension activation.
- The directory is created if absent on first write. It is never committed; a fresh
  `git clone` will not contain it.

### FR-2 — `SessionPresenceRecord` shape

Each presence file is a JSON object matching this contract:

```typescript
interface SessionPresenceRecord {
  sessionId: string;       // UUID-v4, stable for extension lifetime
  scope: string;           // from session.json (empty string if none active) — the human-readable session title (D4)
  project: string;         // from session.json (empty string if none active)
  type: SessionType | null;// from session.json
  branch: string;          // result of `git branch --show-current` at last heartbeat
  worktreeRoot: string;    // `git rev-parse --show-toplevel` at last heartbeat — the "same working tree?" discriminator (FR-9)
  specIds: string[];       // from session.json
  fileAllowlist: string[]; // from session.json (repo-relative paths) — the live CLAIM the guard keys on (FR-12)
  pid: number;             // process.pid of the VS Code extension host
  lastSeen: string;        // ISO-8601 UTC, updated every heartbeat
  startedAt: string;       // ISO-8601 UTC, set on first write, never changed — the arbitration key (FR-13)
}
```

- All fields are required. Fields sourced from `session.json` reflect the **current**
  `session.json` content at heartbeat time (dynamically updated, not snapshot-at-start).
- `pid` is the extension host process ID: used for dead-process detection (FR-4).
- `branch` is resolved via `git branch --show-current` in the repo root; empty string
  if not a git repo or detached HEAD.
- `worktreeRoot` **differs per worktree even though `.git` is shared** — it is how the
  guard tells a real conflict (equal roots) from a legitimate separate-worktree peer
  (different roots).
- **No network calls.** All data is local and process-local (Tier-0 / offline).

### FR-3 — Heartbeat write

- On extension activation, `SessionPresenceManager.start()`:
  1. Generates a stable UUID-v4 `sessionId` (stable for the lifetime of this
     extension host activation; regenerated each activation).
  2. Writes the presence file immediately.
  3. Starts a 30-second interval timer that re-writes the file with updated
     `lastSeen`, `scope`, `project`, `type`, `specIds`, `fileAllowlist`, `branch`,
     and `worktreeRoot`.
- The heartbeat interval (30s) and stale threshold (120s) are **named constants** in
  `presence.ts` — not magic numbers — so changing them is a single-file edit. They are
  **paired** (threshold = 4 × heartbeat) and duplicated as shell constants in the hook
  (FR-14) with a comment tying the two together.
- The write is **atomic**: write to a temp file in the same directory, then
  `fs.rename()` over the target. Prevents another session reading a half-written file.
- The session's `sessionId` is **also written into the singular `.minspec/session.json`**
  (`SessionState.sessionId`) and exported to the integrated-terminal environment as
  `MINSPEC_SESSION_ID`, so a shell-driven agent's commit can self-identify (FR-11).

### FR-4 — Dead session pruning

A session is considered **dead** if either condition holds:
1. `lastSeen` is more than **120 seconds** ago (stale heartbeat — crashed or hung).
2. `process.kill(pid, 0)` throws ESRCH (process no longer exists on this machine).

`SessionPresenceManager.getActiveSessions()`:
1. Lists all `*.session.json` files in `.minspec/sessions/`.
2. Parses each; skips files that fail to parse (corrupt → treated as dead, candidate
   for pruning).
3. Applies both dead-session checks.
4. **Removes** any dead session file (best-effort `fs.unlinkSync`; failure is logged
   and swallowed — pruning must never crash the caller).
5. Returns the surviving `SessionPresenceRecord[]`, **excluding this session itself**
   (callers want *other* sessions, not a mirror of self).

> **Cross-machine note:** `process.kill(pid, 0)` is meaningless for a PID from a
> different machine. In practice all sessions are on the same machine (same checkout,
> same extension host). Cross-machine presence is out of scope; if a stale file from a
> different machine survives, the 120s timestamp threshold evicts it.

### FR-5 — Status bar integration

- `SessionPresenceManager` exposes a `VSCode EventEmitter` that fires whenever the
  active session count changes (on `getActiveSessions()` returning a different count
  than the previous call, or on `fs.watch` event).
- The **existing MinSpec status bar item** gains a `👥 N` suffix when `N ≥ 1` other
  sessions are detected (N = other sessions, not counting self).
- When N = 0, the suffix is hidden — no visual noise for single-session use.
- The status bar item's **tooltip** lists the other sessions: one line per session
  in the format `[scope] (project, type) — branch — last seen Xs ago`.
- Clicking the status bar item while sessions are active opens a **VS Code Quick Pick**
  listing the same information (no new webview; Quick Pick is Tier-0 / zero VSIX size
  delta). The Quick Pick is the surface for the FR-16 resolution actions.
- Status bar update fires at most once per 10 seconds (debounced via timer; not on
  every fs.watch event — which can fire rapidly during bursts).

### FR-6 — Graceful cleanup

- On extension deactivate (`context.subscriptions`), `SessionPresenceManager.stop()`:
  1. Clears the heartbeat timer.
  2. Removes the own presence file with `fs.unlinkSync` (best-effort; logs and swallows
     failure — deactivate path must be synchronous and must not throw).
- A crash or `SIGKILL` leaves the stale file; FR-4 handles it within 120s on the next
  `getActiveSessions()` call from any surviving session.

### FR-7 — `fs.watch` for low-latency detection

- `SessionPresenceManager.start()` opens a `fs.watch` watcher on `.minspec/sessions/`.
- On any `change` or `rename` event, calls `getActiveSessions()` and fires the
  EventEmitter if the count or session IDs changed.
- The watcher is closed in `stop()`.
- If `fs.watch` is unavailable or throws (rare; CI runners with tmpfs quirks), fall
  back to polling via the 30s heartbeat: `getActiveSessions()` is called on each
  heartbeat write and fires the EventEmitter if the count changed. The watcher failure
  is logged at `info` level, not `error`.

## Requirements — Layer 2: Concurrent-Edit Guard (FR-8..16)

### The Conflict-Resolution Ladder (the organizing frame — D4)

The user's ranked preference, best-to-worst. Each tier is the smallest mechanism at
its altitude; higher tiers carry most of the value, lower tiers are the safety net.

| Tier | Goal | This spec | FRs |
|---|---|---|---|
| **1. Prevent** (best) | Make the conflict structurally impossible | **In scope** — worktree-steer (two worktrees = two working trees + two private HEADs, dissolving (a)(b)(c) at once) + a hard commit backstop for the ignored case | FR-9..15 |
| **2. Sessions auto-resolve** (next) | Sessions negotiate the conflict between themselves, no human | **Deferred → SPEC-027** — inter-session comms is a genuinely separate feature surface (the user's original message-1 idea). Sketched in Out of Scope; issue filed. | — |
| **3. HITL** (last resort) | Human resolves, given a copy/paste prompt + a way to reach the peer by its title | **In scope** — every conflict signal names the peer by its human-readable scope + gives a resolution prompt | FR-16 |

### FR-8 — Guard scope, layering, and the determinism carve-out

FR-9..16 add the Concurrent-Edit Guard on top of the presence layer. It targets the
residual (a)(b)(c). It is delivered in three graduated layers, each the smallest thing
that binds at its altitude:

1. **SOFT / structural steer (FR-9, CLAUDE.md + command).** Steer a second live
   session into its own worktree. Primary layer; carries most of the value. Binds an
   autonomous agent only via CLAUDE.md (advisory).
2. **SOFT / presence advisory (FR-10).** Warn before editing when a live same-tree peer
   already claims the file. Advisory; never blocks; the only layer that can prevent
   *wasted work*.
3. **HARD / pre-commit backstop (FR-12..15).** The only layer that binds an agent that
   ignored 1–2. Fires actor-agnostically at `git commit`.

**Determinism carve-out (mandatory).** The hard backstop keys on `.minspec/sessions/` —
gitignored, wall-clock- and PID-dependent *local-runtime* state. It is therefore
**explicitly classified a local-runtime concurrency advisory-gate, categorically
distinct from the deterministic SDD/frontmatter/DR gates (G-6), and exempt from the
cross-surface determinism invariant** ("the same rule fires identically across editor,
commit, CI, agent"). To make that exemption safe and non-lying: when `.minspec/sessions/`
is absent or empty (fresh clone, CI runner), the backstop is a **hard no-op (exit 0)** —
it never blocks where it cannot observe live presence, so it never emits a verdict CI
cannot reproduce. This carve-out MUST be stated in-repo next to the gate so the guard is
never mistaken for a deterministic gate.

### FR-9 — SOFT: worktree-steer (structural prevention; the agent-binding path)

- Add `worktreeRoot` to `SessionPresenceRecord` (FR-2), populated from
  `git rev-parse --show-toplevel` at each heartbeat.
- New command **"MinSpec: New Session Worktree"** wraps `scripts/new-worktree.sh <name>`
  (`git worktree add ~/code/.worktrees/<repo>/<name> -b <name>`). On activation, if
  `getActiveSessions()` returns ≥1 other live session whose `worktreeRoot` equals this
  session's, surface a **non-modal toast** over the visible editor: *"N other live
  session(s) share this working tree — open an isolated worktree? [Create Worktree]"*.
  One keystroke; **never auto-runs** (creating a worktree is a low-frequency one-off; a
  hotkey/command path satisfies the keyboard-over-mouse rule without forcing automation).
- **CLAUDE.md "Concurrent-Session Etiquette" block (the ONLY layer that binds an
  autonomous agent** — it reads CLAUDE.md at session start but never the status bar):
  at session start, if `.minspec/sessions/` shows a live peer (lastSeen<120s AND pid
  alive) sharing this `worktreeRoot`, run `scripts/new-worktree.sh <name>` and `cd` into
  it **before editing**. Advisory and bypassable; the FR-12 backstop catches the
  non-compliant case, so skipping the steer **wastes work, it does not unblock**.

### FR-10 — SOFT: presence-derived pre-edit contention advisory

`presence.ts` exposes a pure `contendingLiveSessions(paths: string[]): { path, peer }[]`
returning, for each input path, every other session that is (i) LIVE per FR-4, (ii) has
`worktreeRoot` equal to this session's, and (iii) has a **non-empty** `fileAllowlist`
that **covers** the path under `isFileInScope` semantics (exact / `dir/` prefix /
`dir/*` glob). An **empty peer allowlist is NO claim** (an unscoped session must not
appear to lock the whole repo). On a non-empty result at edit-intent time, the status-bar
tooltip / a toast warns, naming each contended path + peer. Advisory only; never blocks.
This is the layer that can prevent *wasted work* (fires before both agents sink tokens),
and honestly the only one that can — the hard backstop prevents the clobber-commit, not
the wasted edit.

### FR-11 — Self-identification via a committed session trailer

The backstop must identify "self" to avoid blocking a session on its own claim, and must
do so **without /proc ancestry** — the committing shell shares no ancestry with the
ext-host PID, and (verified) **all concurrent sessions share ONE ext-host PID**, so PID
ancestry cannot disambiguate sessions. Solution: the committer stamps its own id.

- A **`prepare-commit-msg`** managed hook (DR-037 idiom: `set -u`, fail-open, kill-switch
  `MINSPEC_TRAILER_OFF=1`) appends `MinSpec-Session: <sessionId>` to the commit message,
  reading the id from `$MINSPEC_SESSION_ID` or `.minspec/session.json`. If neither
  resolves, it appends nothing (fail-open) → the backstop treats the commit as having no
  self-id (FR-13 self-fallback).
- The backstop derives `MY_SESSION` from that trailer on the composed message. Because
  the committer names itself in the composed artifact, `MY_SESSION` is unambiguous
  regardless of the shared ext-host PID, and — unlike presence state — the trailer IS
  visible in CI on the pushed commit (enables an optional deterministic post-hoc check
  the runtime gate never depends on).
- **Plan-phase note:** git passes the message-file to `commit-msg`/`prepare-commit-msg`,
  **not** to `pre-commit`. The exact plumbing by which the pre-commit stanza reads the
  trailer (an exported `MINSPEC_COMMIT_MSG_FILE`, a shared commit-msg stage, or the
  `.minspec/session.json` fallback) is resolved in Plan (OQ-5).

### FR-12 — HARD: pre-commit contention backstop (actor-agnostic, fail-open, liveness-gated)

Append a stanza to the existing `.minspec/hooks/pre-commit` DR-037 managed block
(already `set -u` + fail-open — do NOT introduce `set -e`). It fires on `git commit`
no matter who commits, reads the composed staged set, and **REJECTS** iff, for some
staged path P, ALL hold:

- **P1.** `.minspec/sessions/` exists and holds ≥1 record with `sessionId != MY_SESSION`
  (self excluded via the FR-11 trailer);
- **P2.** that peer's `worktreeRoot == git rev-parse --show-toplevel` (same working tree
  — a separate-worktree peer never contends);
- **P3.** that peer is **LIVE**: `(now − lastSeen) < 120s` AND `kill -0 <peer.pid>`
  succeeds (a dead/stale peer ⇒ sequential handoff / crash ⇒ ALLOW);
- **P4.** that peer's `fileAllowlist` is non-empty AND covers P under `isFileInScope`
  semantics, where P ∈ `git diff --cached --name-only` filtered to the corpus
  (`specs/**`, `docs/decisions/**`, `docs/domain/**`, `docs/epics/**`).

ALLOW otherwise. On block: print the peer's **scope**/branch/pid/lastSeen and the
resolution ("open a worktree: scripts/new-worktree.sh, or wait — the peer drops off
within 120s"). **Fail-open:** any parse/read/`kill`/`git` error ⇒ that P does not block.
**Kill-switch:** `MINSPEC_CEDIT_OFF=1`. **CI/absent no-op:** missing/empty
`.minspec/sessions/` ⇒ exit 0 immediately (FR-8 carve-out). Shell-only, jq-free
(grep/sed/awk), and the shell predicate MUST agree with `presence.ts` on a golden
fixture (FR-14).

Because self-owned, dead-owner, stale, separate-worktree, empty-allowlist, and
absent-presence ALL pass, the **only** rejection is two provably-LIVE sessions staging
the SAME file in the SAME working tree at the SAME time — the genuine concurrent clobber.
Resolves residual (a), and (b) at whole-file granularity (sub-file locking is out of
scope).

### FR-13 — HARD: arbitration + self-fallback (defuse mutual-deadlock; never self-block)

1. **Arbitration.** Without a tie-break, two live sessions each staging the shared file
   each see the other as a live contender and BOTH are rejected — a deadlock. Rule: when
   FR-12 would reject P, compare `startedAt` of self (from `.minspec/session.json`) with
   the contending peer's. The **earlier-started session is the holder and is ALLOWED**;
   only the **later-started session is rejected** and told to worktree-or-wait. Single
   deterministic winner + single clear loser instruction, not a symmetric stall. (If self
   has no resolvable `startedAt`, treat self as later → the conservative side blocks,
   never both.)
2. **Self-fallback.** If `MY_SESSION` is unresolved (trailer absent — bare-terminal human,
   or trailer hook bypassed), the backstop MUST NOT let a session's own presence record
   block its own commit. It additionally excludes any record whose `pid` is the committing
   process's own tree root when derivable; if still ambiguous, fail open toward ALLOW for
   that P. A null `MY_SESSION` degrades to warn/allow, never self-deadlock.

### FR-14 — Bash⇔TypeScript predicate parity (anti-drift)

The guard has two implementations of the liveness+coverage predicate: `presence.ts`
(used by FR-10 + UI) and the pre-commit bash stanza (FR-12). They MUST agree. Add a
golden-fixture parity test (the `gitignore.test.ts` literal-tie-back idiom): a shared
fixture set of records (live / stale-heartbeat / dead-PID / empty-allowlist /
same-vs-different worktreeRoot / covering-vs-non-covering path) is evaluated by BOTH the
TS `contendingLiveSessions` and the bash stanza (invoked in a harness), and CI fails on
any divergence. This is the guard's **only** cross-surface determinism obligation:
given identical inputs, identical verdicts. It does NOT (and per FR-8 need not) make the
verdict reproducible across environments — the *inputs* (who is live now) are intrinsically
local-runtime. `STALE_SECS=120` / `HEARTBEAT_SECS=30` are duplicated as shell constants
with a comment tying them to the `presence.ts` named constants.

### FR-15 — HARD: git-HEAD-switch guard (residual (c)): auto-revert + branch-assertion

Empirically (git 2.43.0), `git switch`/`checkout <branch>` emit ZERO
`reference-transaction` events (only `post-checkout`, which fires AFTER the move and
cannot veto). **Therefore no git hook can PREVENT the switch**; hard prevention of (c)
is provided **structurally** by FR-9 (a peer in its own worktree has a private HEAD no
`git switch` in the shared checkout can move). On top of that:

1. **`post-checkout` detect-and-auto-remediate** (managed hook; `set -u`; fail-open;
   kill-switch `MINSPEC_HEADGUARD_OFF=1`). Receives `<prev> <new> <branch-flag>`; when
   `branch-flag==1` AND ≥1 other LIVE session shares this `worktreeRoot` AND
   `git status --porcelain` is non-empty (uncommitted work present), it immediately
   `git switch -` back and prints the rule-#8 worktree alert. (D2 = auto-revert.) Honest
   limits: it fires AFTER the move, so a switch onto a genuinely conflicting tree may
   perturb it momentarily; and it cannot fire under the kill-switch or `--no-verify`.
   Structural worktree separation remains the real guarantee.
2. **Deterministic pre-commit branch-assertion (best-effort; refine in Plan).** Assert
   `git branch --show-current` matches the branch this session expects. **Subtlety flagged
   for Plan:** because `branch` updates every heartbeat (FR-2), a naive assertion self-heals
   within one heartbeat and false-positives on a legitimate in-place branch creation. Plan
   must decide whether to snapshot an *intent* branch or drop this part in favour of the
   structural + post-checkout protection (which D2 already provides). This FR is scoped as
   **detect + auto-remediate + (optionally) assert, NOT prevent**.

### FR-16 — HITL conflict resolution + session findability (Tier 3)

Every conflict signal — the FR-10 advisory toast/tooltip, the FR-12 pre-commit rejection
message, and the FR-5 Quick Pick — MUST identify the peer by its **human-readable
`scope`** (the session's declared "Session scope:" one-liner), plus `branch`,
`worktreeRoot`, and `startedAt` — **never a bare UUID or a path the human must
reverse-engineer** (the user's explicit complaint: *"if we mention another session, I
need a way to find it… not guessing based on the name"*).

- The **FR-5 Quick Pick**, for a selected peer, offers two keyboard-accessible actions:
  1. **Copy resolution prompt** — copies a ready-to-paste block naming the contended
     file(s) and asking the peer to release or coordinate, e.g.:
     *"Another MinSpec session (scope: '<my-scope>') needs `<file>` which your session
     (scope: '<peer-scope>') is editing on branch `<branch>`. Are you still on it? If
     done, commit/close; if not, reply and I'll take a different file."*
  2. **Reveal worktree** — opens the peer's `worktreeRoot` folder in a new window (the
     worktree path is the machine-level locator).
- **Honest limitation (stated in-spec):** MinSpec is agent-agnostic and has no
  cross-extension API to focus a specific Claude Code tab. It surfaces the peer's `scope`
  so the human recognizes the tab by its title; it does not programmatically switch to it.
  Programmatic session-switching and true inter-session negotiation are Tier-2 (SPEC-027).

## Invariants (T0 — tests before implementation)

**Presence (from Layer 1):**
- **INV-1 (no commit).** `.minspec/sessions/` is gitignored; no presence file ever
  appears in `git status --porcelain`.
- **INV-2 (ephemeral lifetime).** A presence file for a dead process (ESRCH) is never
  returned by `getActiveSessions()` — pruned on the same call that detects it.
- **INV-3 (session uniqueness).** No two concurrently active sessions share a `sessionId`.
- **INV-4 (no-noise single session).** `getActiveSessions() == []` ⇒ no `👥` suffix.
- **INV-5 (offline only).** `presence.ts` makes zero network calls (static import check).
- **INV-6 (deactivate safety).** `stop()` never throws; FS errors caught and logged.

**Guard (from Layer 2):**
- **INV-7 (solo never blocks).** No live peer (or only self) ⇒ no commit and no
  `git switch` is ever blocked/reverted by the guard.
- **INV-8 (sequential handoff never blocks).** A staged path whose only same-worktree
  claimant is DEAD/STALE/absent is ALLOWED — liveness is the sole discriminator, no
  lock-release step.
- **INV-9 (concurrent pair blocks exactly the later committer).** Two live records, equal
  worktreeRoot, overlapping non-empty allowlist, both staging P ⇒ the earlier `startedAt`
  commits (exit 0), the later is rejected (exit 1) — never both, never the earlier.
- **INV-10 (separate-worktree / empty-allowlist never block).** A live peer with a
  different `worktreeRoot`, or an empty `fileAllowlist`, is never a contender.
- **INV-11 (no-op when presence absent).** Missing/empty `.minspec/sessions/` ⇒ the
  pre-commit stanza and the post-checkout guard exit 0 immediately (FR-8 carve-out; CI-safe).
- **INV-12 (fail-open).** Any parse/read/`kill`/`git` error, or an unset trailer, ⇒
  ALLOW / no-revert. Each hook carries its env kill-switch
  (`MINSPEC_CEDIT_OFF` / `MINSPEC_HEADGUARD_OFF` / `MINSPEC_TRAILER_OFF`).
- **INV-13 (bash ≡ TS predicate).** The two engines agree on every golden fixture; CI
  fails on drift. The guard's only cross-surface determinism obligation.
- **INV-14 (no new git noise, no lock store).** No new tracked state beyond the
  `MinSpec-Session:` trailer on commit objects; `.minspec/sessions/` + `.minspec/session.json`
  stay gitignored; no `.minspec/locks/` directory exists. Zero network from any guard path.

## Acceptance Criteria

**Presence:**
- [ ] **Multi-session badge** — two windows on the same checkout each show `👥 1` within
  35s. (FR-3, FR-5)
- [ ] **Graceful close** — closing one clears the badge in the survivor within 10s. (FR-6, FR-5)
- [ ] **Crash recovery** — SIGKILL clears the badge within 125s. (FR-4)
- [ ] **PID pruning** — a synthesized dead-PID record is pruned on the next
  `getActiveSessions()`. (FR-4)
- [ ] **Zero git noise** — `git status --porcelain` shows nothing under `.minspec/sessions/`. (INV-1, INV-14)
- [ ] **Single-session silence** — no `👥` when only one session is active. (INV-4)
- [ ] **Offline** — no network from `presence.ts` (static import check). (INV-5)

**Guard:**
- [ ] **Worktree-steer offered** — opening a 2nd window while a 1st is live surfaces the
  "open a worktree?" toast within ≤35s; accepting yields distinct `worktreeRoot`s. (FR-9)
- [ ] **Concurrent clobber blocked + arbitrated** — two live same-worktree sessions both
  stage `SPEC-026/requirements.md`; the earlier-started commit succeeds, the later is
  rejected naming the peer's scope/pid/lastSeen. Neither mutual-blocks. (FR-12, FR-13, INV-9)
- [ ] **Sequential handoff passes** — A claims+commits+ends (or SIGKILL); B later stages
  and commits the same file with no block, no warning. (FR-12, INV-8)
- [ ] **Solo + CI never blocked** — a single live session commits any corpus file exit 0;
  the identical diff in CI (no `.minspec/sessions/`) also exits 0. (FR-8, INV-7, INV-11)
- [ ] **Self-id survives shared ext-host PID** — with 2+ sessions on one ext-host PID, a
  session committing its OWN locked file is not blocked (self from the trailer, not PID). (FR-11, FR-13)
- [ ] **HEAD-switch auto-reverted** — while X has uncommitted work, Y `git switch`es on the
  shared checkout; post-checkout detects branch-flag=1 + live same-tree peer + dirty tree
  and switches back with the rule-#8 alert. (FR-15)
- [ ] **Fails open + honors kill-switches** — malformed record / unset `MINSPEC_SESSION_ID`
  never blocks; each `MINSPEC_*_OFF=1` disables its gate. (FR-12, FR-15, INV-12)
- [ ] **Predicate parity in CI** — golden-fixture test: TS and bash predicates agree on
  every fixture. (FR-14, INV-13)
- [ ] **No lock store, no git noise** — nothing new under `.minspec/`; no `.minspec/locks/`;
  only committed addition is the trailer. (INV-14)

**HITL (findability):**
- [ ] **Peer named by scope, resolvable** — every conflict signal names the peer by its
  human-readable `scope` (not a UUID/path); the Quick Pick offers "Copy resolution prompt"
  and "Reveal worktree", both keyboard-accessible. (FR-16)

- [ ] **T0 discipline** — INV-1..INV-14 each have a test that fails against pre-change code
  and passes after — written before implementation.

## Costly to Refactor

Ranked most-to-least expensive to change after shipping.

1. **On-disk shapes are public API.** `SessionPresenceRecord` (+ its new `worktreeRoot`)
   and `SessionState.sessionId` in `session.json` are read by hooks, the UI, and possibly
   external tooling. **Add fields freely; never rename/remove without migration.** Lock
   the keys with a round-trip test. *Check:* the parity fixture (FR-14) also pins the shape.
2. **The `MinSpec-Session:` trailer is a frozen contract in permanent git history.**
   Changing the trailer KEY later means old commits carry the old key. Treat the name as
   immutable; any reader must tolerate its absence on non-MinSpec commits. *Check:* one
   named constant for the trailer key, referenced by both the hook and any CI reader.
3. **`.minspec/sessions/` directory path** — wired into `MINSPEC_GITIGNORE_ENTRIES`,
   `scaffold.ts`, `fs.watch`, and all three hooks. *Check:* single `SESSIONS_DIR` constant;
   no magic strings; the #383 gitignore-drift gate covers the ignore entry.
4. **The three new managed hooks join the DR-037 refresh/merge family.** `pre-commit`
   (extended), `prepare-commit-msg` (new), `post-checkout` (new) are scaffolded, hashed
   into `template-baseline.json`, and 3-way-merged on refresh — the managed-block path now
   owns three hook files. *Check:* each wrapped in `>>> minspec:managed:… >>>` markers so
   refresh preserves user edits.
5. **Bash⇔TS predicate parity is a standing two-place edit.** Any change to
   `isFileInScope` coverage or the liveness constants must be mirrored in the bash stanza or
   CI breaks (FR-14). Intentional (it protects the guard), but recurring. *Check:* the
   golden fixture is the single forcing function.
6. **Heartbeat/stale constants are paired.** 30s × 4 = 120s tuned together; drifting one
   can prune a live session or hide a dead one. *Check:* co-located named constants, comment
   states the pairing, duplicated (with tie-back comment) in the hook.

## Out of Scope

- **Tier-2 inter-session comms / auto-negotiation → deferred to SPEC-027.** Sessions
  talking to each other to resolve a conflict without a human (the user's #2 preference,
  and the original message-1 idea). A file-based session mailbox each agent is instructed
  to poll is the likely shape, but it is a distinct feature surface with its own protocol
  (who listens, what if a peer isn't polling, message schema) — not folded into this spec.
  Issue filed; SPEC-027 to follow.
- **Sub-file / per-line / per-checkbox locking.** Contention is whole-file granularity;
  two sessions editing different lines of the same `tasks.md` still serialize at commit.
- **Preventing wasted in-flight editing when both agents ignore the steer AND the
  advisory.** The hard backstop prevents the clobber-COMMIT, not the tokens already spent;
  only the SOFT advisory (FR-10) can prevent waste, and only if obeyed. Stated, not solved.
- **Hard PREVENTION of `git switch`/`checkout`.** Empirically impossible via git hooks on
  2.43 (no pre-switch veto). Prevention is structural (FR-9); FR-15 detects + auto-reverts.
- **Both-parties-non-compliant blind spot.** If NEITHER session declares an accurate
  `fileAllowlist`, FR-12 has no claim to key on and the clobber falls through to git
  last-write-wins. Mitigated only by allowlist hygiene (the CLAUDE.md protocol requests it,
  #380 fan-out may make it mandatory) — not guaranteed here.
- **Committed branch-RESERVATION artifact.** A committed "I own branch X, don't switch"
  file would make (c) deterministic + CI-visible, but is heavier committed coordination
  than this iteration warrants (was an OQ-1 option; user chose the lighter auto-revert).
  Flag for follow-up if (c) recurs after FR-15 ships.
- **Cross-machine sessions** on a shared NFS mount. `kill -0` is machine-local; a remote
  live peer looks dead and the 120s threshold is the only evictor.

## Traceability

- **Triggered by:** [#380](https://github.com/harvest316/minspec/issues/380) — session presence heartbeat.
- **Depends on:** SPEC-022 (approvals sidecar model; the presence layer follows its per-file precedent).
- **Relates to:** SPEC-015 (status lanes own the status-bar surface FR-5/FR-16 extend);
  global rule #8 (worktree-per-session — FR-9/FR-15 are its in-tool enforcement);
  #383 (the gitignore-drift gate that must also cover `.minspec/sessions/`).
- **Design provenance:** the guard (FR-8..16) is the synthesis of a 9-agent judge-panel
  workflow (4 design lenses → adversarial verify → synthesize), 2026-07-01. Worktree-steer
  won as the only structural fix; the liveness-gated backstop + trailer self-id + carve-out
  were grafted from the runners-up and the adversarial verdicts.
- **Follow-up specs:** SPEC-027 (Tier-2 inter-session comms / auto-resolution).
- **Files to modify (allowlist for implementation agents):**
  - `packages/minspec/src/lib/presence.ts` (new — manager, record, `contendingLiveSessions`)
  - `packages/minspec/src/lib/session.ts` (add `sessionId` to `SessionState`)
  - `packages/minspec/src/lib/scaffold.ts` (add `SESSIONS_DIR` + gitignore entry; register 3 managed hooks)
  - `packages/minspec/src/lib/template-registry.ts` (register `prepare-commit-msg` + `post-checkout` templates)
  - `packages/minspec/src/extension.ts` (wire `SessionPresenceManager.start/stop`; export `MINSPEC_SESSION_ID`)
  - `packages/minspec/src/views/status-bar.ts` (add `👥 N` suffix + tooltip + Quick Pick + FR-16 actions)
  - `.minspec/hooks/pre-commit`, `.minspec/hooks/prepare-commit-msg` (new), `.minspec/hooks/post-checkout` (new)
  - CLAUDE.md template (Concurrent-Session Etiquette block — the SOFT agent binding)
  - `packages/minspec/tests/presence.test.ts` (new — INV-1..14 T0), `tests/gitignore.test.ts` (add `.minspec/sessions/`)
