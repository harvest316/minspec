---
id: SPEC-019
type: requirements
# 🔒 Once approved, hash-locked: approved bytes recorded in .minspec/approvals.json[SPEC-019].specHash. ANY edit voids approval (hash → stale) — re-run "MinSpec: Approve Spec". DR-012.
status: implementing
tier: T4
product: agent-execute
epic: EPIC-007  # Agent Execute Extension
depends_on: [DR-008, DR-015, DR-017, DR-030, DR-004, DR-016]  # DR-008 no-cred isolation (Layer-2 precondition); DR-015 third-extension packaging; DR-017 the substrate spec (two-plane / SandboxRunner / broker / attestation); DR-030 untrusted-input-as-data; DR-004 tiering + Tier-0 air-gap; DR-016 detect-or-degrade claude -p pattern
relates_to: [SPEC-016, DR-031]  # SPEC-016 reality-check reviewer ships in this same extension + consumes the broker seam; DR-031 = the dev-time spec-gate, build-time analogue of FR-12 HITL — does NOT transfer to the product (R9)
---

# Agent Execute — Layer-2 Execution Substrate (control plane + credential-free exec plane)

> **The Layer-2 substrate of [DR-017](../../../docs/decisions/DR-017.md), realising
> [DR-008](../../../docs/decisions/DR-008.md)'s no-credential execution isolation in the
> third "Execute" extension placed by [DR-015](../../../docs/decisions/DR-015.md).**
> Two planes: a credentialed **control plane** (vsix, ext host) drives a credential-free
> **execution plane** (container). The agent **never** runs in the extension host. Model
> access is the one narrow seam — a host-side broker the sandbox never authenticates
> through. Tiering + the Tier-0 air-gap are governed by
> [DR-004](../../../docs/decisions/DR-004.md); untrusted issue/spec bodies are **data, not
> instructions** ([DR-030](../../../docs/decisions/DR-030.md)); the detect-or-degrade
> `claude -p` discipline follows [DR-016](../../../docs/decisions/DR-016.md). **Nothing in
> this spec is built** — this is the Specify-phase requirements record; every capability
> below is *specified, not built*.

**Date:** 2026-06-04
**Decision:** [DR-017](../../../docs/decisions/DR-017.md) (substrate) · isolation [DR-008](../../../docs/decisions/DR-008.md) · packaging [DR-015](../../../docs/decisions/DR-015.md) · injection posture [DR-030](../../../docs/decisions/DR-030.md) · tiering/air-gap [DR-004](../../../docs/decisions/DR-004.md) · detect-or-degrade [DR-016](../../../docs/decisions/DR-016.md)
**Epic:** [EPIC-007 Agent Execute Extension](../../../docs/epics/EPIC-007-agent-execute.md)

**Tier — T4.** Full ceremony (specify → clarify → plan → tasks → implement). This is the
load-bearing, security-critical substrate the whole extension is written against; its
contracts (two-plane split, `SandboxRunner` port, broker seam) are explicitly
*not undoable in <1 day* (DR-017 §Costly to Refactor), a gating open question (#74) must be
resolved in **Clarify** before default-mode plumbing, and the attested boundary must clear
its own security review before any unattended dispatch — so the Clarify phase is mandatory,
not optional.

---

## Context

[DR-008](../../../docs/decisions/DR-008.md) made unattended `claude -p` dispatch conditional
on **Layer 2**: the agent must execute inside an isolation boundary with **no host
credentials**, egress denied by default, and the branch leaving the box as a diff/bundle a
credentialed host process reviews and pushes. [DR-008](../../../docs/decisions/DR-008.md)'s
"unavoidable conclusion" is that a *tool allowlist cannot sandbox a dev agent* — an agent
that runs the project's own build/test is executing arbitrary code by definition, because
`package.json` scripts and the test files are code the agent just wrote. The boundary must
therefore be an **environment**, not a permission list.

[DR-015](../../../docs/decisions/DR-015.md) placed that work in a **third Tier-1 extension**
(`aiclarity.agent-execute`) so MinSpec core stays Tier-0 / air-gapped.
[DR-017](../../../docs/decisions/DR-017.md) settled **how** Layer 2 is physically built and
named the category error this spec must not reintroduce: **a vsix cannot be the sandbox** —
a VS Code extension runs in the extension host, which is the user's own process (same
`$HOME`, same `gh`/`CLOUDFLARE_API_TOKEN`/FTP/psql/wrangler creds, same `~/.claude`). Run
`claude -p` there and every Layer-2 condition is violated by construction. Docker (or an
equivalent boundary) is **the execution substrate the vsix structurally lacks**, not an
alternative to it.

This spec is the requirements record for that substrate: the two-plane split, the
`SandboxRunner` port that keeps ~95% of the extension testable without docker, the host-side
model broker as the sole model-access seam, the attestation gate that *verifies* the
boundary rather than assuming it, the manual-vs-autonomous mode split with graceful degrade,
and the tier-gated HITL that is the product's differentiator ("agents you can trust because
they stop"). It synthesises decided architecture; it invents nothing. Two seeds inform the Layer-1
manual-dispatch path, both **learn-functionality-only** references, never adopted product
code. The **closer, battle-tested** one is this repo's own dev-time dispatch harness
(`scripts/dispatch-issue.sh` + `scripts/triage-decide.sh`) — a *running* in-repo proof of the
Layer-1 shape (origin/main base-ref, no-cred agent + parent-side push, deterministic
fail-closed tier-gate, untrusted-body-as-data framing). It is **dev-tooling that ships in no
.vsix** (see Out of scope) — a reference to harvest logic from, **not** the product. The older
seed (`~/code/AgentSystem`, a mmo/333Method DB-queue ops-dispatcher) supplies the
`claude -p` dispatch + retry/confidence/result-handling logic for the **Layer-1
manual-dispatch path only** — its DB-queue/systemd architecture is explicitly **not** the
product architecture; [DR-017](../../../docs/decisions/DR-017.md) is.

**Evidence discipline (CLAUDE.md / DR-003).** Nothing here is implemented, done, or shipped.
Where a requirement traces to a decision it cites the DR by path. Artifact-existence ≠
feature-existence: the existence of this spec, the EPIC file, or the seed repo is **not**
evidence any capability exists.

## Requirements

### Two-plane architecture (the load-bearing split)

- **FR-1 (two planes; agent never in the ext host).** agent-execute is built as two planes:
  a credentialed **control plane** (the vsix, running in the VS Code extension host —
  holds host creds + network, picks the issue, tier-gates, runs the HITL UI, reviews the
  returned diff, `git push` + `gh issue comment`) and a credential-free **execution plane**
  (an isolated container with a clean env — runs `claude -p`, edits code, runs build/test,
  commits locally, emits a diff + `.agent-summary.md`). The vsix **manages** the substrate
  (spawns/monitors the container); it **never becomes** the sandbox, and the agent **never
  runs in the extension host**. Traces to [DR-017](../../../docs/decisions/DR-017.md)
  (Decision §two planes) realising [DR-008](../../../docs/decisions/DR-008.md) Layer 2
  line-for-line.

- **FR-2 (`SandboxRunner` port).** The substrate is consumed through a single
  `SandboxRunner` interface with the lifecycle **spawn → attest → run → collect-diff →
  teardown**, not hardcoded docker calls. The docker/devcontainer runtime is the **v1
  adapter** (devcontainer-flavoured to reuse VS Code's remote-container primitives);
  microVM/gVisor and cloud are future adapters behind the same port. The port keeps ~95% of
  the extension (tier-gating, HITL state, diff handoff, summary→comment) testable with a
  **mock runner**, no docker daemon required — so control-plane/logic tests run anywhere
  (including this docker-less dev container) and only the docker adapter needs a real
  daemon. Traces to [DR-017](../../../docs/decisions/DR-017.md) (Consequences §port;
  Costly-to-Refactor §port).

### Model access — host-side broker (sole seam)

- **FR-3 (broker is the only model-access seam).** The sandbox's `ANTHROPIC_BASE_URL`
  **always** points at a host-side broker socket (a fixed loopback/unix-socket seam that is
  the **only** allowlisted egress). The sandbox `claude -p` runs **credential-free** — it
  sends model requests with no real token; the **broker (host-side) injects** the real
  credential and makes the actual outbound call. The sandbox endpoint is fixed *for all
  time*, so it never has to be edited from inside an egress-denied box.

  **Web research rides this seam — no extra egress, no new seam.** Tasks that need the open
  web (e.g. *research and write a best-practices doc*) use Anthropic's **server-side**
  `web_search`/`web_fetch` tools: Anthropic executes the query/fetch on its **own**
  infrastructure and returns the results inside the model response, so the outbound web call
  leaves Anthropic's servers — **never the sandbox** — and travels the existing
  `/v1/messages` broker call the box already makes. An egress-denied box can therefore
  research the open web with the broker as its only seam. This holds **only** for
  server-side web tools: the claude CLI's **client-side** WebFetch/WebSearch make a direct
  outbound call *from the sandbox* and are **denied by design** — opening egress to satisfy
  them would void INV-sandbox-no-egress and break the FR-6/FR-7 attestation manifest (the
  egress canary must stay refused), i.e. the R7 convenience-grant regression. Sources the
  server-side fetch cannot reach (private / internal / localhost) are pre-fetched
  **host-side** by the control plane and handed to the agent as FR-15 `<untrusted_…>` DATA.
  Traces to [DR-017](../../../docs/decisions/DR-017.md) (§Model access).

- **FR-4 (installing Scrooge repoints the broker, never the sandbox).** Whether the broker
  routes direct→Anthropic or via the local ScroogeLLM proxy is a **host-side config flip**;
  the sandbox endpoint is unchanged. The rejected scoped-key-in-sandbox design (which would
  require editing `ANTHROPIC_BASE_URL` *inside* an isolated, egress-denied box) is out of
  scope and must not be reintroduced. Traces to
  [DR-017](../../../docs/decisions/DR-017.md) (§Model access; Alternatives §scoped key).

- **FR-5 (billing modes — subscription default, no PAYG; API/Scrooge opt-in).** The default
  billing mode is **subscription** (`claude -p` on the dev's Pro/Max quota): the broker
  carries the dev's subscription credential host-side and routes direct→Anthropic, with **no
  pay-as-you-go API spend and no API key anywhere**. **API-key mode is opt-in** — for devs
  who want Scrooge cost-routing or concurrency past the subscription ceiling, the broker
  routes via Scrooge — but **even in Scrooge mode the broker tries the Pro/Max subscription
  first** (the same subscription-default discipline as the direct route), and only injects
  the spend-capped **PAYG API key when the subscription is unavailable or its ceiling is
  hit**; Scrooge then optimizes + measures the PAYG portion. (Refines the CL-9 precedence
  *subscription → API → Scrooge*: subscription-first applies **within** the Scrooge route,
  not only on the direct route — Scrooge is a routing choice, not a billing-mode switch.) The
  *broker-injectability of subscription-oauth* is the gating open question — see **OQ-1
  (#74)** — and the documented fallback (inject the subscription token at spawn; attestation
  must then whitelist exactly that one token) must be resolved in **Clarify** before the
  default-mode plumbing is committed. Traces to
  [DR-017](../../../docs/decisions/DR-017.md) (§Billing mode; OQ lines 111-118), shared
  product-line subscription-default per [DR-016](../../../docs/decisions/DR-016.md) Tier-1
  framing.

### Boundary verification — control-plane attestation

- **FR-6 (attestation gate, fail-closed, attest-the-box-you-execute-in).** Before any issue
  is handed to the agent, the control plane spawns the container, injects a **probe**,
  captures a structured result, compares it to an **expected-deny manifest**, and **fails
  closed**: any should-be-denied capability that *succeeds* aborts the dispatch (the agent
  never runs) and a red report goes to the dev. The probe runs in the **same** container
  lifecycle — same env/mounts/netns — **before** any agent code, since network policy and
  mounts are fixed at creation and immutable from inside without privilege. The probe is a
  table of **negative assertions** (each must *fail* inside the sandbox to pass):

  | Check | Attempt | Pass = |
  |---|---|---|
  | Egress | connect a canary host (gh API / control-plane beacon) | refused / timeout |
  | Creds (env) | read `$GH_TOKEN`, `$CLOUDFLARE_API_TOKEN`, `$ANTHROPIC_API_KEY` | unset |
  | Creds (files) | stat `~/.claude`, `~/.config/gh`, `~/.cache/wrangler-home`, `~/.aws`, `~/.ssh`, `.netrc` | absent |
  | Auth | `gh auth status` | fails |
  | Push | `git push origin` | fails (no cred / no net) |
  | FS boundary | read host `$HOME` / `/host` | not mounted |
  | Privilege | docker socket present? running privileged? | no |

  **Egress check vs. web research (not a conflict).** The Egress row failing (canary
  refused) does **not** block web-research tasks — server-side `web_search`/`web_fetch` ride
  the broker `/v1/messages` call (FR-3), not a sandbox-originated web connection, so they
  keep working while the box stays egress-denied. A sandbox that *can* reach the canary is
  mis-configured and must fail closed, regardless of any research need. Web research is
  therefore **never** a reason to relax this deny-check.

  Traces to [DR-017](../../../docs/decisions/DR-017.md) (§Boundary verification).

- **FR-7 (positive controls — never infer "secure" from a dead probe).** Each negative
  deny-check is **paired with a positive control**: the *allowlisted* endpoint (broker
  socket / model API) **must succeed**. If both the deny-check and its control fail →
  **broken probe, verdict FAIL**, not a proven boundary (a dead `curl` could mean
  egress-blocked, curl-missing, or canary-down — never assume the safe reading). Traces to
  [DR-017](../../../docs/decisions/DR-017.md) (§Boundary verification, requirement 1).

- **FR-8 (probe suite IS the substrate integration test — two-for-one).** One mechanism
  serves both as the per-dispatch runtime gate (FR-6) **and** as the CI substrate
  integration test that runs against a docker-capable runner — so the boundary check is
  never a separate artifact that can drift. Substrate integration tests need a real daemon
  (they cannot run in this docker-less dev container); control-plane/logic tests run anywhere
  on the mock `SandboxRunner` (FR-2). **Scope honesty:** attestation proves *"as configured,
  this box cannot reach X"* (a config-correctness gate) — it does **not** prove the absence
  of a kernel/container-escape 0-day; that residual is the microVM/gVisor hardening path
  (OQ-2, #73). Traces to [DR-017](../../../docs/decisions/DR-017.md) (§Two-for-one;
  §Scope honesty).

### Mode split & graceful degrade

- **FR-9 (manual Layer-1 vs autonomous Layer-2 mode split).** Two distinct dispatch modes:

  | Mode | Trigger | Sandbox | DR-008 |
  |---|---|---|---|
  | **Manual dispatch** | human, per-issue, trusted/self-authored body | not required | Layer 1 — already permitted |
  | **Autonomous / cron** | unattended loop | **required** (must pass FR-6 attestation) | Layer 2 |

  The agent never runs in the extension host in *either* mode. Manual dispatch is the floor
  (works without docker); the sandbox is required only for unattended runs. The reusable
  seed for manual dispatch (claude -p invocation + retry/confidence/result-parsing) may be
  adapted from `~/code/AgentSystem`'s `dispatcher.js`/`result-handler.js`, **not** its
  DB-queue/systemd architecture. Traces to
  [DR-017](../../../docs/decisions/DR-017.md) (§Graceful degrade) and
  [DR-008](../../../docs/decisions/DR-008.md) (Layer 1 / Layer 2).

- **FR-10 (no container runtime → degrade to Layer-1 manual, NOT "off").** When no usable
  container runtime is detected, the correct degrade is **fall back to Layer-1 manual
  dispatch** (human-initiated, trusted self-authored body, unsandboxed — which
  [DR-008](../../../docs/decisions/DR-008.md) already permits), **never** "disabled". "No
  docker" downgrades **autonomy**, never the **boundary**: the agent still never runs in the
  ext host. The product reason to install agent-execute is *any code-writing dispatch*, not
  autonomy alone. Traces to [DR-017](../../../docs/decisions/DR-017.md) (§Graceful degrade).

- **FR-11 (mandatory detect-or-degrade; never-throw typed fallbacks).** Container-runtime
  detection **mirrors** the `isGhAvailable()` / `claude` availability probes
  ([DR-016](../../../docs/decisions/DR-016.md), [DR-004](../../../docs/decisions/DR-004.md)
  Tier-1 rule): probe at activation; absent → degrade gracefully (show an "install a
  container runtime to enable autonomous dispatch" affordance), **never error**. Every
  runtime/probe seam is `catch → log the reason → return a typed, discriminated fallback`
  (`{ ok: false, reason: 'no-runtime' | 'spawn-failed' | 'attest-failed' | 'timeout' |
  'base-advanced' | 'base-advanced-conflict' | 'git-lock-contention' | 'checkout-moved' | ... }`
  — the last four are the concurrent-git-mutation fail-soft reasons added by FR-13's
  reconciliation + isolation rules and [DR-046](../../../docs/decisions/DR-046.md)),
  **not** a bare `null` and **never** a silent black hole — expected degradation
  (no runtime) must be distinguishable from a bug, and the swallowed reason logged +
  inspectable (auditable-via-UI). The never-throw shell stays **thin**; complex logic lives
  in inner functions that throw normally (real stack traces). This mirrors SPEC-016's
  never-throw/typed-fallback discipline. Traces to
  [DR-016](../../../docs/decisions/DR-016.md) (mandatory fallback) and
  [DR-017](../../../docs/decisions/DR-017.md) (§Graceful degrade).

### Tier-gated HITL (the differentiator)

- **FR-12 (consume the shared classifier; tier-gate dispatch).** The control plane consumes
  the **shared classifier** ([DR-014](../../../docs/decisions/DR-014.md) — the same engine
  the IDE uses) to tier each `agent-ready` issue: **T1–T2 auto-dispatch** (`agent-ready`);
  **T3–T4 → `needs-review`**, blocked pending **human approval** of spec/plan before the
  agent starts. This is the product's stated differentiator — *not "an AI that does
  everything" but an agent that knows when to ask a human* ("agents you can trust because
  they stop"). Traces to [DR-015](../../../docs/decisions/DR-015.md) (§three-extension pitch)
  and [DR-017](../../../docs/decisions/DR-017.md) (control-plane responsibilities).

### Diff/bundle handoff (no in-sandbox push)

- **FR-13 (branch exits as a diff + `.agent-summary.md`; control plane pushes).** The branch
  leaves the sandbox as a **diff/bundle** plus an `.agent-summary.md`, **not** a push. The
  credentialed control plane reviews the diff, composes the `gh issue comment` from
  `.agent-summary.md`, and performs the `git push` + `gh issue comment` **after** the agent
  process has exited — so the agent never holds the `gh` token. **No in-sandbox push** is a
  permanent contract, not a config; the summary is **data the parent renders**, never
  instructions. Traces to [DR-017](../../../docs/decisions/DR-017.md) (§Diff-handoff) and
  [DR-008](../../../docs/decisions/DR-008.md) (Layer 1 parent-side push/comment).

  - **Base-ref freshness + pinned base (control-plane creation-time precondition).**
    *Complementing FR-13's exit-time handoff:* when the control plane **creates** the agent's
    exec context it branches off **`origin/main` (fetched parent-side), never the stale local
    `main`.** On a shared checkout the local `main` is frequently stale (global rule #8 — it is
    never switched/pulled from a session), so basing agent work on it makes the agent build on
    an outdated tree and emit factually-wrong output (observed: an agent documented an
    already-merged script as "does not exist" because its base predated the merge). **The base
    is captured as an immutable SHA** (`git rev-parse FETCH_HEAD` immediately after the
    parent-side fetch; the exec context is created off that exact SHA, not the live shared
    ref), so a concurrent peer fetch or a human merge cannot re-point the base between fetch
    and create; the `baseSha` travels onto the OutcomeStore record (CL-4) and into the agent's
    `<untrusted_…>` DATA caveat ("tree pinned at `<sha>`; do not assert non-existence of what
    you cannot see"). **The exec context is materialised as a dedicated git worktree rooted
    OUTSIDE every checkout** (`~/code/.worktrees/<repo>/sealbox-<runId>/` — never nested in a
    working tree, never `/tmp` where the dir vanishes but the `.git` worktree record survives);
    for L1 (no container, CL-1) this worktree is the agent's **only** fs isolation, for L2 it
    is what gets snapshotted into the otherwise-clean container. The fetch is a parent-side
    credentialed op; the agent still gets no network tools. (The in-repo
    `scripts/dispatch-issue.sh` dev-seed demonstrates the fetch-and-base discipline —
    dev-tooling, not the product substrate; see Out of scope.) Traces to
    [DR-046](../../../docs/decisions/DR-046.md).

  - **Base-ref reconciliation + safe push (control-plane exit-time precondition).** *The
    symmetric partner the creation-time rule lacked — base-freshness gated BOTH directions
    ([DR-046](../../../docs/decisions/DR-046.md), closing the FR-13 validator asymmetry).*
    Because `origin/main` is a moving ref and runs are unbounded, **before** the parent push
    the control plane re-fetches `origin/main` and compares it to `baseSha`:
    - **Unchanged →** push as today.
    - **Advanced →** rebase the agent branch onto the fresh tip **in the worktree** (never on
      the shared HEAD); on clean rebase, **re-run the FR-13/CL-5 gate** (tests/validate) and
      **recompute the diff range + `changedFiles`** against the fresh `origin/main` so the
      `.agent-summary.md` and `gh` comment describe the branch as it will actually merge.
    - **Rebase conflict, or the merged range overlaps the agent's diff →** do **not** push or
      comment: emit `{ ok: false, reason: 'base-advanced-conflict' }` (FR-11), label
      `needs-review`/`agent-rebase-conflict`, surface the diff for human reconciliation
      (CL-10's asymmetric fail-soft applied at the exit boundary — skip the push only on
      positive proof of conflict/overlap, never push blind).

    **Push protocol (enforce-by-construction, CL-12).** The push targets a **per-dispatch-unique
    branch** (`sealbox/<issue>-<ulid>`) — never a reused name, never `main`/`master` — and is
    **create / fast-forward-only: never `--force`, `--force-with-lease`, or any reset of a
    remote ref** (unique branches make a force unnecessary, so the push primitive carries no
    force code path — grep-gated in review, mirroring R7's cred grep). On any non-fast-forward
    → abort and surface, never auto-force.

    **cwd discipline (bug #83 + base-SHA-guard-misses-switch).** Every parent-side git op runs
    `git -C <worktree>` with an **explicit refspec** — never a bare `git push`, never a
    `branch -f`/reset that can move the shared HEAD. The control plane **verifies the user's
    primary checkout is untouched — branch NAME == intended AND HEAD SHA unmoved — immediately
    before and after** handoff (a SHA-only guard misses a concurrent `git switch`; check the
    NAME); on mismatch → STOP, `{ ok: false, reason: 'checkout-moved' }`, push nothing.
    Git-lock contention (`index.lock`/`packed-refs.lock`/worktrees lock) is a retryable
    `{ ok: false, reason: 'git-lock-contention' }` that fail-closes rather than dispatching
    into a half-initialised worktree. **`teardown` is defined for L1** (`git worktree remove
    --force` + `git branch -D <tempBranch>` on every terminal exit, in a finally/trap, after
    diff+push); CL-7 orphan reclamation is extended to GC orphaned worktrees + temp branches,
    and a re-queue mints a **fresh** worktree off a **fresh** fetch (never reuses a stale
    orphan). Governed by the rule-#8 isolation invariant below.

### Caps (concurrency always; spend in API mode)

- **FR-14 (concurrency cap always; spend cap in API mode; shared-account quota respected).**
  The dispatch loop carries a **concurrency cap at all times** — N concurrent sandboxes = N
  concurrent `claude -p` against the **shared** account quota, so in the subscription default
  the cap must respect the 5h-window / weekly / session limits or runs throttle mid-flight.
  **API mode** additionally carries a **spend cap** on the injected key (trading PAYG dollars
  for headroom past the subscription ceiling). Exact current Anthropic-plan limits must be
  verified before wiring caps. Traces to
  [DR-017](../../../docs/decisions/DR-017.md) (§Usage/quota limits).

  - **Spend-cap time shape — calendar daily + weekly, NOT a mirror of the 5h/7d subscription
    windows.** The PAYG key is injected **only** as overage spillover (FR-5: subscription-first;
    PAYG only when the subscription is unavailable or its ceiling is hit), so the spend cap's
    *trigger* is the subscription 5h/weekly window but its *job* is bounding **dollars** — a
    budget concept the human reasons about in **calendar** units (the Scrooge budget-owner
    audience). Two calendar-aligned windows: a **daily cap** (the runaway guard — a stuck loop
    burning the night) and a **weekly cap** (the actual overage ceiling). Distinct failure
    modes, not redundant: daily-only over-provisions the week; weekly-only lets one bad day eat
    the whole budget before anyone notices. The spend cap is **decoupled from the 5h-window
    mechanics** — FR-14's *concurrency* cap already respects the subscription 5h/weekly quota;
    the *spend* cap stays a pure dollar budget over calendar time. **Rejected: mirroring
    Claude's own 5h-rolling / 7d-rolling windows** — (a) the 5h→7d ratio is a *behavioral
    assumption* (cycles/day × working-days), wrong for weekend/part-time/shared-account devs;
    (b) rolling windows don't tile, so a rolling-5h cap can't be cleanly multiplied into a
    weekly number; (c) a rolling window has no clean reset instant, so its "remaining" gauge
    **cannot be displayed truthfully** — a mis-modelled gauge → surprise mid-task cutoff or
    silent overspend (never-wrong violation). Calendar windows reset at honest, deterministic
    instants ("resets at midnight" / "resets Monday").

  - **Spend-cap settings UI — two dollar inputs + an honest derived ratio, no behavioral
    multiplier.** The surface takes a **daily** and a **weekly** dollar figure directly and
    shows the *truthful* derived relationship `weekly ÷ daily = N days of headroom` ("at your
    daily max you'd hit the weekly cap in N days") — a pure ratio that **describes what the user
    set**, never prescribes a working pattern. Warn when `weekly ÷ daily < ~5` (daily cap loose
    relative to weekly — one runaway day eats most of the week). Seed default `daily = weekly ÷
    5` (5 working days), surfaced as an **editable assumption**, never a hard-coded mapping.
    This **replaces the rejected "reasonable 5h→7d multiplier" affordance**, which would have
    baked an unstated, often-wrong working-pattern assumption into the UI.

  - **Spend-cap cutoff = degrade to subscription, never hard-fail.** When a PAYG request would
    exceed either cap, the broker **stops injecting the PAYG key and falls back to
    subscription-only** (runs throttle on the subscription window) — it does **not** hard-fail
    the dispatch. Consistent with the FR-10/FR-11 never-throw degrade posture: hitting the spend
    cap downgrades *throughput*, never the *boundary* or the run. The **broker is the only meter**
    (CL-15), so the cap reads the broker's running daily/weekly PAYG tally.

### Untrusted input & injection posture

- **FR-15 (untrusted issue/spec body is DATA, credential-free; injection ≤ a bad
  advisory).** The issue/spec body is passed to the agent as explicitly **delimited DATA,
  not instructions** (`<untrusted_issue_body>` envelope + "data, not instructions"
  preamble); the system prompt states the content may attempt injection and must be reviewed,
  never obeyed. The agent runs **credential-free** with no host secrets, no push, and no
  egress beyond the broker seam (FR-3). Therefore prompt injection at worst yields a **bad
  advisory / degraded output** (a quality/DoS risk) — **never an action, approval,
  exfiltration, or write** (an integrity risk). **v1 is scoped to trusted self-authored
  issues only**; dispatching **untrusted** (non-self-authored) bodies is gated on the
  microVM/gVisor hardening path (OQ-2, #73). Traces to
  [DR-030](../../../docs/decisions/DR-030.md) (data-framing, blast-radius scales with trust)
  and [DR-008](../../../docs/decisions/DR-008.md) (untrusted-body delimiters).

### Tier-0 isolation

- **FR-16 (nothing here makes MinSpec core depend on this extension).** No code path,
  dependency, or contract introduced by this spec may make `packages/minspec` or
  `packages/shared` depend on agent-execute, the container runtime, the broker, or any
  network/AI module. MinSpec core stays **Tier-0 / air-gapped**; the container dependency is
  confined to the *autonomous* path of this separate Tier-1 extension. A shared **type** (if
  any) may live in `packages/shared` (Tier-0 type only — no invocation, no network); the
  invocation lives here. Traces to [DR-004](../../../docs/decisions/DR-004.md) (Tier 0 rule)
  and [DR-015](../../../docs/decisions/DR-015.md) (single home, air-gap preserved).

## Costly to Refactor

*The expensive-to-reverse commitments — read these closely; everything else is cheap to
change. Ranked most→least costly. (DR-017 §Costly-to-Refactor: ADR-filter NO, not undoable
in <1 day.)*

1. **The two-plane split (control vsix / execution container)** (FR-1; INV-two-plane;
   [DR-017](../../../docs/decisions/DR-017.md)) — collapsing it back into the extension host
   is not a refactor: it re-introduces the category error (a vsix *is* the user's
   credentialed process) and re-violates every [DR-008](../../../docs/decisions/DR-008.md)
   Layer-2 condition, and would unwind [DR-015](../../../docs/decisions/DR-015.md)'s
   placement. Effectively un-undoable without re-litigating DR-008/DR-015. *Check: the agent
   process is spawned into the container; no `claude -p` (or equivalent agent invocation)
   executes in the extension host in any code path.*
2. **The host-side broker as the sole model-access seam** (FR-3, FR-4; INV-broker-seam;
   [DR-017](../../../docs/decisions/DR-017.md)) — because the sandbox endpoint
   (`ANTHROPIC_BASE_URL` → broker socket) is fixed "for all time", any later move to a
   sandbox-owned credential would require repointing config *inside* an egress-denied box —
   the exact unworkable path the broker exists to avoid; reversing it is a security
   re-architecture. *Check: the sandbox holds no Anthropic credential; its only allowlisted
   egress is the broker socket; Scrooge routing is a host-side flip.*
3. **The `SandboxRunner` port** (FR-2; [DR-017](../../../docs/decisions/DR-017.md)) — *cheap*
   to swap adapters under it (docker → microVM → cloud are alternate adapters by design — the
   deliberately reversible axis); *expensive* to remove the port itself, since ~95% of the
   extension is written against `spawn→attest→run→collect-diff→teardown`. *Check: the
   spawn→attest→run→collect-diff→teardown interface is fixed before build (contracts-first);
   a mock runner exercises the control plane with no docker.*
4. **Attestation fails closed + positive controls** (FR-6, FR-7, FR-8;
   INV-attest-fail-closed; [DR-017](../../../docs/decisions/DR-017.md)) — if the gate ever
   defaults open, or infers "secure" from a dead probe, the entire Layer-2 guarantee
   evaporates; retrofitting a fail-closed gate after dispatch is wired is costly. *Check:
   any should-be-denied capability that succeeds aborts dispatch; a deny-check whose positive
   control also fails → verdict FAIL, never "secure".*
5. **Diff-handoff, no in-sandbox push** (FR-13;
   [DR-017](../../../docs/decisions/DR-017.md)/[DR-008](../../../docs/decisions/DR-008.md)) —
   moving push into the sandbox re-adds a push-credential surface the design exists to
   remove. *Check: the only push/comment is parent-side, after the agent exits; the sandbox
   has no push capability.*
6. **Never-throw degrade to Layer-1 (not "off")** (FR-10, FR-11; INV-degrades) — if the
   substrate path can throw/block, the air-gap + graceful-degrade guarantees die;
   retrofitting never-throw is costly. *Check: no-runtime/spawn/attest failure returns a
   typed `{ok:false,reason}`, logs the reason, and falls back to Layer-1 manual — never
   throws, never silently "off".*

## Invariants (must hold)

- **INV — Agent never executes in the extension host (T0).** The agent process runs only
  inside the execution-plane container; no code path runs `claude -p` (or an equivalent agent
  invocation) in the vsix / extension host (FR-1; [DR-017](../../../docs/decisions/DR-017.md),
  [DR-008](../../../docs/decisions/DR-008.md)).
- **INV — Sandbox holds no host credentials and no egress except the broker seam (T0).** The
  execution plane gets no `~/.claude`, no `gh`/`CLOUDFLARE_API_TOKEN`/FTP/psql/wrangler
  creds, no `~/.config`/`~/.cache`/keychain, and no network except the single allowlisted
  broker socket (FR-3, FR-6; [DR-017](../../../docs/decisions/DR-017.md),
  [DR-008](../../../docs/decisions/DR-008.md)).
- **INV — Attestation fails closed (T0).** Any should-be-denied capability that *succeeds*
  inside the sandbox aborts the dispatch (the agent never runs); a deny-check whose positive
  control also fails yields verdict FAIL, never an inferred "secure" (FR-6, FR-7;
  [DR-017](../../../docs/decisions/DR-017.md)).
- **INV — Untrusted input is data, never instructions; the agent is credential-free (T0).**
  The issue/spec body is delimited DATA the agent reviews, never obeys; injection at worst
  yields a bad advisory/degraded output, never an action, approval, exfiltration, or write
  (FR-15; [DR-030](../../../docs/decisions/DR-030.md),
  [DR-008](../../../docs/decisions/DR-008.md)).
- **INV — MinSpec Tier-0 core never depends on this extension (T0).** No code path,
  dependency, or contract here makes `packages/minspec` / `packages/shared` depend on
  agent-execute, the container runtime, the broker, or any network/AI module; the air-gap is
  preserved (FR-16; [DR-004](../../../docs/decisions/DR-004.md),
  [DR-015](../../../docs/decisions/DR-015.md)).
- **INV — SealBox obeys rule #8; it never mutates the user's shared checkout (T0).** SealBox
  is a concurrent automated git actor: every dispatched agent (L1 and L2) operates in a
  **dedicated worktree** rooted *outside every checkout*
  (`~/code/.worktrees/<repo>/sealbox-<runId>/` — never nested in a working tree, never `/tmp`).
  No SealBox code path runs a HEAD-moving git op (checkout/switch/merge/rebase/reset/`branch
  -f`) on the user's primary checkout, moves the shared HEAD, force-pushes, or force-deletes a
  ref a peer session may hold; the agent's base is a captured immutable SHA (not a live shared
  ref); every parent-side git op is `git -C <worktree>` + explicit refspec; the primary
  checkout's branch NAME + HEAD are verified unchanged before and after handoff; the worktree +
  temp branch are removed on every terminal exit. Shared `.git` is left as found (FR-13
  creation/exit sub-bullets; FR-11; global rule #8; [bug #83](../../../docs/decisions/DR-046.md);
  [DR-046](../../../docs/decisions/DR-046.md)).
- **INV — Base-freshness is gated symmetrically: creation AND push (T0).** No agent branch is
  pushed or summarised against a base older than `origin/main` at push time. The base is fresh
  at creation (pinned SHA off a parent-side fetch) **and** re-validated at exit (re-fetch →
  rebase-in-worktree on advance → fail-soft to `needs-review` on conflict/overlap), so the
  "factually-wrong output" failure cannot re-enter mid-run; the push is create/fast-forward-only
  to a per-dispatch-unique branch — never `--force`/reset of a remote ref (FR-13 reconciliation
  sub-bullet; CL-5; [DR-046](../../../docs/decisions/DR-046.md)).

## Acceptance Criteria

*Definition-of-done — each item traces its FR(s)/invariant and is the concrete check that the
requirement is met. All unchecked: nothing here is built (Specify-phase record). **Milestone
split** (per the v1 / Layer-2 table in Clarify): the Layer-2 items **AC-3, AC-4, AC-5, AC-6,
AC-7** and the FR-14 **spend** cap gate the autonomous milestone (and #74); the rest are v1
manual Layer-1.*

- [ ] **(FR-1, INV-agent-never-in-ext-host)** No code path runs `claude -p` (or any agent
  invocation) in the vsix / extension host; a test greps the exec path and asserts the agent
  process is spawned only into the execution plane (L2 container / L1 subprocess-in-worktree).
- [ ] **(FR-2)** The substrate is consumed through one `SandboxRunner` port
  (`spawn → attest → run → collect-diff → teardown`); a **mock runner** exercises tier-gating,
  HITL state, diff-handoff and summary→comment with **no docker daemon**; only the docker
  adapter requires a real daemon (CI-gated). `collect-diff`/push take `execContext` as a
  **required** typed param (no cwd defaulting).
- [ ] **(FR-3, INV-sandbox-no-egress)** The sandbox's `ANTHROPIC_BASE_URL` resolves only to the
  broker socket and carries no real token; the broker is the sole allowlisted egress. Server-side
  `web_search`/`web_fetch` ride the `/v1/messages` broker call; the CLI's client-side
  WebFetch/WebSearch are disabled and a sandbox-originated web connection is **refused** (the
  egress canary stays refused).
- [ ] **(FR-4)** Switching direct→Scrooge is a **host-side** broker config flip; the sandbox
  `ANTHROPIC_BASE_URL` is byte-identical before and after, and no scoped key is ever written
  inside the box.
- [ ] **(FR-5, OQ-1/#74)** Default billing is **subscription** with **no API key present**
  (attestation cred-env row asserts `$ANTHROPIC_API_KEY` unset); API/Scrooge mode is opt-in, and
  even in Scrooge mode the broker tries the subscription first and injects the spend-capped PAYG
  key only when the subscription is unavailable / at ceiling. (Default-mode plumbing gated on the
  #74 spike.)
- [ ] **(FR-6, FR-7, INV-attest-fail-closed)** The attestation probe runs in the **same**
  container lifecycle **before** any agent code; every negative deny-check (egress, creds-env,
  creds-files, auth, push, fs-boundary, privilege) **fails** inside the box and is **paired with
  a positive control that must succeed**. Any should-be-denied capability that succeeds **aborts
  dispatch** (agent never runs); a deny-check whose positive control also fails → verdict
  **FAIL**, never inferred-secure.
- [ ] **(FR-8)** One probe mechanism is **both** the per-dispatch runtime gate and the CI
  substrate integration test (real daemon); control-plane/logic tests run on the mock with no
  daemon. The probe asserts **config-correctness only** — it makes no escape-resistance claim
  (kernel-0-day residual = OQ-2/#73).
- [ ] **(FR-9, FR-10, FR-11, DR-045)** Manual L1 needs no sandbox; autonomous/cron **requires** a
  sandbox that passed FR-6. No container runtime → degrade to **L1 manual** (typed
  `{ok:false, reason:'no-runtime'}` + an install affordance), **never** "off" and **never**
  unsandboxed autonomy — an ambient host-IDE async runner never enables autonomy. Every
  runtime/probe seam returns a typed discriminated fallback, never a bare `null`, never throws.
- [ ] **(FR-12, CL-2, CL-8)** The control plane consumes the **shared classifier**: **T1–T2
  auto-dispatch**, **T3–T4 → `needs-review`** pending human spec/plan approval. Low self-reported
  confidence **escalates** a T1–T2 run to review (never auto-approves). The gate's input is the
  classifier-over-spec (no outcome self-poisoning), with an explicit recovery path so no class is
  permanently stuck.
- [ ] **(FR-13, INV-base-freshness-symmetric)** The branch exits as a **diff + `.agent-summary.md`**;
  the parent reviews, pushes, and comments **after** the agent exits (agent holds no `gh` token;
  no in-sandbox push). The base is a **pinned SHA** at creation and is **re-validated at push**
  (re-fetch → rebase-in-worktree on advance → recompute the diff range; conflict/overlap →
  fail-soft to `needs-review`). A fixture where `origin/main` advances mid-run yields **no
  stale-based push or comment**.
- [ ] **(FR-13 push protocol + INV-rule-8)** The push targets a **per-dispatch-unique branch**,
  is **create/fast-forward-only, never `--force`/reset** (the push wrapper has no force code path
  — grep-gated). A T0 test runs the handoff while a **sibling worktree on the same checkout
  switches branches** and asserts the user's primary checkout branch-NAME + HEAD are **unmoved**
  and the push hit only the agent branch.
- [ ] **(INV-rule-8, FR-13 cwd/lifecycle, bug #83)** Every dispatched agent runs in a **dedicated
  worktree** under `~/code/.worktrees/<repo>/sealbox-<runId>/` outside every checkout; all
  parent-side git ops use `git -C <worktree>`; `teardown` removes the worktree + temp branch on
  **every** terminal exit; a simulated crash + reclamation sweep leaves **zero** orphan
  worktrees/branches; git-lock contention → typed retryable fail-closed.
- [ ] **(FR-14, CL-3, CL-14, CL-15)** A **global concurrency cap** bounds in-flight sandboxes,
  respecting the shared-account window/weekly/session limits; **API mode** adds a **spend cap**
  read from the broker meter (the sole billing observer); per-field truncation + a total
  prompt-size cap guard DoS/cost. (Exact current Anthropic-plan limits verified before wiring.)
- [ ] **(FR-15, INV-untrusted-data)** The issue/spec body is passed as delimited
  `<untrusted_…>` **DATA** with an injection-aware preamble; the agent runs credential-free, no
  push, no egress beyond the broker. A red-team fixture that injects instructions yields **at
  most a degraded advisory** — never an action, approval, exfiltration, or write. (v1 = trusted
  self-authored bodies; untrusted gated on #73.)
- [ ] **(FR-16, INV-tier0)** A dependency-graph test asserts `packages/minspec` and
  `packages/shared` import **nothing** from agent-execute, the container runtime, the broker, or
  any network/AI module; any shared type in `packages/shared` is **type-only** (no invocation, no
  network).
- [ ] **(CL-5, CL-7, FR-11)** The agent-output contract is **Zod-validated** (seed shape **and**
  the nested `results[]` shape, so no run silently null-fails); a bundle is rejectable on empty
  diff / missing-or-empty summary / malformed confidence / tests-failed / `stale-base` /
  `base-advanced-conflict`. **3 attempts → `blocked`** (terminal ∈ {`completed`|`blocked`|`cancelled`});
  orphaned runs are reclaimed (soft→re-queue, hard→blocked) and their git-state GC'd **before**
  re-queue.
- [ ] **(CL-10, CL-11, CL-13)** A pre-dispatch **"still-actionable?"** re-check runs with
  asymmetric fail-soft (skip only on positive proof of resolution); empty-diff / no-op outcomes
  are **closed without a push**; post-success side-effects are a **declared, orchestrator-routed**
  set run in the control plane — the result handler never reaches into foreign state.

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|---|---|---|
| R1 | **Subscription-oauth is not broker-injectable** — if `claude -p` subscription auth binds the token to where the CLI runs (or ToS/endpoint-pinning forbids pointing it at a proxy), the credential-free-sandbox **default** billing mode cannot stand. | Med · High | Resolve **OQ-1 (#74)** in Clarify *before* committing default-mode plumbing. Documented fallback: inject the subscription token at spawn (weaker — attestation must then whitelist exactly that one token, nothing else); API-key mode is definitely injectable, so a working path exists either way (FR-5). |
| R2 | **Container escape (kernel/0-day)** — namespace isolation is not kernel isolation; the boundary is strong but namespace-level. | Low · High | Attestation explicitly does **not** claim escape-resistance (FR-8 scope honesty); microVM (Firecracker)/gVisor hardening path tracked **OQ-2 (#73)**, required before **untrusted** (non-self-authored) bodies are dispatched. **v1 scoped to trusted self-authored issues only** (FR-15). Residual named. |
| R3 | **Attestation lies (dead-probe false pass)** — a failed `curl` reads as "egress blocked" when it actually means curl-missing or canary-down. | Med · High | Positive controls (FR-7): each deny-check paired with the allowlisted broker/model endpoint that **must succeed**; both failing → verdict FAIL. Fail-closed (FR-6): any should-be-denied capability that succeeds aborts dispatch. Probe = substrate integration test, so it cannot drift (FR-8). |
| R4 | **Operator wires the loop/cron treating Layer-1 as sufficient** — `npm run <script>` still executes editable `package.json` scripts in an unsandboxed Layer-1 run. | Med · High | Mode split (FR-9): autonomous/cron **requires** a sandbox that passes attestation (FR-6); Layer-1 stays human-initiated on trusted self-authored bodies only; cron stays **blocked** until the substrate ships, passes attestation, and clears security review. |
| R5 | **Shared-account quota throttling mid-run** — N concurrent sandboxes hit one account's Pro/Max window/weekly/session cap. | Med · Med | Concurrency cap always (FR-14); API mode adds a spend cap for headroom past the subscription ceiling; verify exact current Anthropic-plan limits before wiring caps. |
| R6 | **Degradation gap** — substrate path throws/blocks (or fails *silently* — bare null, no reason) instead of falling back to Layer-1. | Low · High | FR-11 `catch → log reason → typed {ok:false,reason}` over thin never-throw shells; FR-10 Layer-1 manual is the unconditional fallback (not "off"); never-throw-contract T0 test covers every failure path (no-runtime/spawn/attest/timeout). |
| R7 | **Isolation regression via a "convenience" grant** — a future edit gives the sandbox creds/network/write to "just push" or "auto-fix". | Low · High | The no-cred/no-egress invariants are standing (T0); any grant needs a superseding DR; the attestation gate (FR-6) would *detect* the regression and fail closed; code-review grep for creds/network in the exec path. |
| R8 | **Prompt injection via untrusted body** steers the agent to a false result. | Med · Med | DATA-framing + injection-aware prompt + credential-free + no-write (FR-15); blast-radius bounded to a degraded advisory (quality/DoS, not integrity); untrusted bodies gated on #73 (R2). Residual: degraded output, not a breach. |
| R9 | **HITL-gate confusion — dev-time spec-gate ≠ product gate.** The dev-time dispatch harness enforces spec-approval inside a linked worktree by resolving the canonical `.minspec/approvals.json` via `git rev-parse --git-common-dir` ([DR-031](../../../docs/decisions/DR-031.md), dev-tooling). A future build might try to reuse that mechanism for FR-12's product HITL. | Low · Med | **It does not transfer — record, do not adopt.** FR-12's HITL is the tier-gate + shared classifier + human spec/plan approval, **not** the dev PreToolUse hook. At Layer-2 the `git-common-dir` trick is moot anyway: FR-6 requires the host `$HOME`/checkout **unmounted**, so no canonical main tree exists inside the box to resolve against. DR-031 is the build-time analogue only (`relates_to`, not `depends_on`). |
| R10 | **Concurrent git mutation corrupts a run or the user's tree.** While a run is in flight the human merges PRs (`origin/main` advances), edits `main` directly, and sibling sessions work in other worktrees on the same `.git`. A 7-lens adversarial audit ([DR-046](../../../docs/decisions/DR-046.md)) confirmed all paths integrity-class: stale-base **factually-wrong output** + mis-stated diff range at exit; a **stale-based / non-ff push**; and (L1, no fs isolation) the agent running in / pushing from the **user's primary checkout** → moved shared HEAD + stranded work (the rule-#8 corruption, SealBox as culprit). | Med · High | The rule-#8 worktree-isolation INV + the symmetric base-freshness INV (creation pin + exit reconcile) + create/ff-only-no-force push + `git -C <worktree>` with pre/post primary-checkout verify + defined L1 teardown & git-state orphan GC (FR-13 creation/exit sub-bullets; FR-11 typed reasons; [DR-046](../../../docs/decisions/DR-046.md)). Residual: a kernel/escape 0-day is out of scope (R2); this closes the *git-concurrency* class only. |

## Out of scope

- **microVM/gVisor hardening + untrusted (non-self-authored) issue dispatch** — the kernel
  boundary and the threat model it unlocks (OQ-2, #73). v1 is trusted self-authored issues
  only.
- **Remote/cloud sandbox substrate** — deferred ([DR-017](../../../docs/decisions/DR-017.md)
  Alternatives): reintroduces network + a credential-handoff surface + per-run cost.
- **The reality-check reviewer / round-table feature** — SPEC-016 (the Tier-1 review
  amplifier that ships in this same extension and *consumes* the broker seam this spec
  defines); its verdict contract + lenses are its own scope.
- **ScroogeLLM proxy internals** — the broker *routes* to it (FR-4); how Scrooge
  routes/caches/measures is the ScroogeLLM repo's concern (private; DR-027).
- **The `scripts/` dev-time dispatch harness** — remains dev-tooling for building this
  monorepo ([DR-015](../../../docs/decisions/DR-015.md)); it is not the product surface and
  ships in no `.vsix`.
- **The AgentSystem DB-queue / systemd architecture** — `~/code/AgentSystem` is a seed for
  the Layer-1 dispatch/retry/confidence logic only; its `tel.agent_tasks` queue + systemd
  timer model is **not** the product architecture.
- **Public brand name + marketplace positioning** — deferred pending marketing/SEO scan
  ([DR-015](../../../docs/decisions/DR-015.md)); "AgentSystem" is a working name only,
  `aiclarity.agent-execute` a working technical id only (OQ-4).

## Open questions

- **OQ-1 — subscription-oauth broker-injectability ([#74](https://github.com/harvest316/minspec/issues/74)).**
  Can the claude CLI's subscription oauth be broker-injected (sandbox sends sans-credential,
  broker adds the token), or does subscription auth bind the token to where the CLI runs
  (and/or does ToS/endpoint-pinning forbid pointing subscription `claude -p` at a proxy)?
  **API-key mode is definitely injectable; subscription mode is the unknown.** Gates the
  default billing-mode plumbing (FR-5). **Must resolve in Clarify**, before committing the
  default. Documented fallback recorded in FR-5 / R1.
- **OQ-2 — microVM/gVisor hardening before untrusted dispatch ([#73](https://github.com/harvest316/minspec/issues/73)).**
  Namespace isolation is not kernel isolation; the kernel-level boundary (Firecracker /
  gVisor) is the hardening path required **before** non-self-authored issue bodies are
  dispatched unattended. v1 is scoped to **trusted self-authored issues only** (FR-15, R2);
  do not resolve here — record.
- **OQ-3 — where the product code lives (packaging). RESOLVED (2026-06-04, session decision).**
  New `packages/agent-execute` in this monorepo, per [DR-015](../../../docs/decisions/DR-015.md)
  — beside `packages/minspec`, sharing `@aiclarity/shared`, shipped in the Pro pack. The existing
  `~/code/AgentSystem` (the old 333Method/mmo DB-queue ops fix-dispatcher) is a
  **learn-functionality-only seed** for the Layer-1 dispatch/retry/confidence logic; its
  DB-queue/systemd architecture is **not** adopted (Out of scope). "Reuse" = *adapt logic*, not
  *adopt structure*.
- **OQ-4 — public brand name + domain ([#66](https://github.com/harvest316/minspec/issues/66)).**
  Still deferred per [DR-015](../../../docs/decisions/DR-015.md) pending marketing/SEO +
  competitive scan (tracked in #66); working name "AgentSystem", working technical id
  `aiclarity.agent-execute`. Do not treat either as the product name on any public surface.

## Clarify

Clarify session **2026-06-05**. Inputs: the 5 governing DRs + the mining of the old
AgentSystem ([docs/research/agent-execute-mining-old-agentsystem.md](../../../docs/research/agent-execute-mining-old-agentsystem.md),
which surfaced 17 spec gaps + 10 questions). Four product forks resolved by the user; the
rest by engineering default from the DRs + mining evidence. No question remains blocking
Plan. The single empirical unknown (#74) is a tracked spike that does **not** block the v1
manual path.

| ID | Decision | By | Lands in |
|---|---|---|---|
| **CL-1 — v1 scope** | **Manual Layer-1 ships first.** Human-initiated dispatch; `claude -p` runs as a spawned **subprocess** (never embedded in the ext host — FR-1 still holds), no container (DR-008 Layer-1 permits this). **Credential-free for the push surface even without a container:** FR-13 already removes push/`gh` from the agent (parent pushes after the agent exits — listed as a v1 item below), so the L1 subprocess holds **no `gh`/push token**. It is **not egress-isolated** — it still shares the host's ambient `$HOME`/env; stripping that is the **Layer-2** container's job. Autonomous **Layer-2** (container + attestation + broker) is a **follow-on milestone**. See the v1/Layer-2 FR split below. | user | FR-9/10 + scope split |
| **CL-2 — confidence = 2nd HITL axis** | Low agent **self-reported** confidence **escalates** an auto-dispatched (T1–T2) run to human review — an axis orthogonal to tier. **Never** used to auto-*approve* (self-reported → hallucination-prone, per mining; it only ever pushes toward a human, the safe direction). | user | FR-12 |
| **CL-3 — concurrency granularity** | **Global cap** for v1. Roadmap: **per-class caps v2**; **full-auto, load-scaled worker pool** (scale up/down by system load per task — the old-333 model) **v3**, behind the FR-14 cap abstraction. | user | FR-14 |
| **CL-4 — outcome/trust store** | An **`OutcomeStore` port** (mirrors the `SandboxRunner` port). v1 backend = **one file per attempt** (`.minspec/agent-execute/outcomes/<ulid>.json`, **gitignored**), each a **Zod-validated** record. Per-attempt files → **zero write contention by construction** (multi-window/multi-process safe); aggregates = read-dir (cheap at v1–v2 volume). **SQLite** backend swapped behind the port at **v3** when throughput/query demand it. MinSpec core **never reads** this dir (FR-16). | user | FR-13/FR-16 (new) |
| **CL-5 — agent-output contract** | Zod result: seed `{fix_description, confidence, tests_passed, files_changed}`; **must also accept the nested/batched shape** (META-MONITOR-style `results[]`) so no run silently null-fails. Rejectable bundle = empty diff / missing-or-empty summary / malformed-or-missing confidence / tests-failed. Exact severity/evidence fields → Plan. | eng default | FR-13 |
| **CL-6 — infra-vs-quality split + one type-set** | Substrate/infra failures (`{no-runtime, spawn-failed, attest-failed, timeout, oom, …}`) **never** count against tier eligibility or the quality signal. The **dispatchable-type set ≡ executable-type set** (single source of truth) — closes the `crai_*`-class false-failure the mining found. | eng default | FR-11/FR-12 |
| **CL-7 — retry + terminal-state + crash recovery** | **3 total attempts → `blocked`** (terminal). Terminal set = `completed \| blocked \| cancelled`. Orphan reclamation: a run abandoned mid-flight (control plane died) is reclaimed by a lifecycle sweep (soft timeout → re-queue, hard timeout → blocked), adapted from the seed's `recoverStaleTasks`. | eng default | FR-2/FR-11 |
| **CL-8 — deterministic-gate anti-deadlock** | The tier gate's input is the **classifier over the spec**, not outcome history → **no self-poisoning input** → the seed's "never-record-own-rejection" escape is **N/A and dropped**. Retained: self-repair-type exemption + an explicit recovery path so a perpetually-`needs-review` class is never permanently stuck. | eng default | FR-12 |
| **CL-9 — model/effort/thinking locus + cred precedence** | The **broker** is the single resolution seam for model + effort + thinking (collapses the seed's 3 drifting call-sites). Credential precedence: **subscription → API → Scrooge**. effort/thinking tunable per-task; defaults per-tier. (Broker = Layer-2.) | eng default | FR-3/4/5 |
| **CL-10 — staleness re-check** | A cheap **"still-actionable?"** re-check runs between human-approval and dispatch (re-read issue/PR state; re-run the failing test). **Asymmetric fail-soft**: on error → do the work; skip **only** on positive proof of resolution. | eng default | FR-12/FR-13 |
| **CL-11 — empty-diff / no-op close** | "Already resolved / not a bug / operational" outcomes (no diff) are closed by the control plane **without a push**. | eng default | FR-13 |
| **CL-12 — full forbidden-set is enforce-by-construction** | The **entire** forbidden set — push, `.env`/secrets, `package.json`, migrations, new deps, `systemctl`, foreign-DB writes — is denied by **sandbox capability + no-cred** (Layer-2) / by the **control-plane-only action boundary** (Layer-1), **never** by prompt prose (the old system's failure mode). | eng default | FR-13/INV |
| **CL-13 — post-success side-effects** | A **declared, orchestrator-routed** post-merge action set (close issue, update linked records) runs in the control plane after merge; the result handler **never** reaches into foreign state. | eng default | FR-13 |
| **CL-14 — input-size cap** | Per-field truncation + a total prompt-size cap, as a DoS/cost guard (distinct from FR-14's spend/concurrency caps). | eng default | FR-14 |
| **CL-15 — usage/telemetry locus** | Exec plane is credential-free → **structurally cannot observe billing**; the **broker is the only meter** (stage/provider/model/tokens/cost). FR-14's spend cap reads the broker's meter. (Layer-2.) | eng default | FR-14/FR-3 |

### v1 vs Layer-2 milestone split (from CL-1)

- **v1 — manual Layer-1 (no container, ships first):** FR-1 (subprocess, never ext-host-embedded),
  FR-9/FR-10/FR-11 (mode detect + degrade-to-manual + never-throw), FR-12 (tier-gate + the CL-2
  confidence escalation), FR-13 (diff handoff + verdict/retry/`OutcomeStore` logic), FR-15
  (untrusted-as-data inner framing), FR-16 (Tier-0). Plus the ported pure logic
  (`parseClaudeOutput`/`extractFixSummary`/verdict-ladder, staleness re-check).
- **Layer-2 milestone — autonomous (gated, later):** FR-2 (`SandboxRunner` container adapter),
  FR-3/4/5 (host-side broker + billing modes), FR-6/7/8 (attestation), FR-14 **spend** cap
  (calendar daily+weekly, degrade-to-subscription cutoff; the concurrency cap itself is v1).
  Gated by #74 + a dedicated security review (DR-017).

### OQ disposition

- **OQ-1 (subscription-oauth)** → tracked spike **#74**; Layer-2 only, **non-blocking for v1**.
- **OQ-2 (microVM)** → confirmed **out of scope**, **#73** (required only before *untrusted* dispatch).
- **OQ-3 (packaging)** → already **resolved**: `packages/agent-execute` (DR-015).
- **OQ-4 (public name)** → deferred, **#66**.

## Follow-ups (tracked)

- **#74 — subscription-oauth broker-injection spike.** Empirical: can the claude CLI subscription
  oauth be broker-injected (sandbox sans-credential, broker adds token)? Fallback = spawn-token
  injection / API-key mode. **Layer-2** concern → resolve before default-mode plumbing; does **not**
  block v1 manual.
- **Exact verdict Zod fields + severity/evidence (CL-5)** → Plan phase (contracts-first, CDD).
  **Non-binding reference for Plan:** the dev-time `/loop` review-signals renderer
  (`scripts/render-review-signals.mjs`, [#180](https://github.com/harvest316/minspec/issues/180)
  / [DR-033](../../../docs/decisions/DR-033.md) — monorepo dev-tooling, ships in no `.vsix`,
  **not** the agent-execute product surface) shows one shape for *proven, not self-reported*
  evidence fields: a named `regressionTest` gated behind separate `regressionProvenBaseRed` /
  `regressionProvenHeadGreen` proof flags, with **NO FALSE GREEN** (an unproven regression
  renders ⚠️ UNVERIFIED, **never** ✅). Whether Plan adopts any of it is undecided — and note
  its inputs are caller-**measured** facts, distinct from CL-5's **self-reported** `confidence`
  (CL-2).
- **#73 — microVM/gVisor hardening** → required only before *untrusted* (non-self-authored) issue
  dispatch; out of v1 and the v1 Layer-2 milestone.
- **`OutcomeStore` SQLite backend (CL-4)** → v3, behind the port; no caller changes.
- **Per-class caps (v2) + load-scaled worker pool (v3)** → roadmap, behind the FR-14 cap abstraction.
- **Public brand name + domain** → non-code marketing follow-up, **#66** (DR-023 forward rule).
- **Agent web-tooling config (FR-3)** → Plan must wire the agent to Anthropic **server-side**
  `web_search`/`web_fetch` and **disable** the CLI's client-side WebFetch/WebSearch inside the
  sandbox (client-side fetch is egress-denied by design); host-side pre-fetch → FR-15 DATA is
  the path for sources the server-side fetch can't reach (private/internal/localhost). Plain
  config, no new dep.
