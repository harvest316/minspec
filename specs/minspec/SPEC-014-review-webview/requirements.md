---
id: SPEC-014
type: requirements
status: specifying
tier: T4
product: minspec
epic: EPIC-002  # Signpost Integrity
aspects: [ux]
depends_on: [SPEC-012]
relates_to: [SPEC-010, SPEC-006]
---

# MinSpec — Prettified Spec-Review Webview (Requirements)

**Date:** 2026-06-01
**Status:** Specifying (SDD Specify phase)
**Triggered by:** session request — "expand the planned webview that approximates
ExitPlanMode (pretty not MD, with a text-select → comment → LLM revision → highlight
changes process); a scroll-bottom Approve button that, instead of closing, shows the
next spec/dr/issue/doc that needs approving."
**Materialises:** [#36](https://github.com/harvest316/minspec/issues/36) (parked from
[DR-012](../../../docs/decisions/DR-012.md) — prettified review webview).
**Epic:** [EPIC-002 Signpost Integrity](../../../docs/epics/EPIC-002-signpost-integrity.md)
**Consumes:** [SPEC-012 Next-Task Resolver](../SPEC-012-next-task-resolver/requirements.md)
(ordering authority — this webview is a *surface* over the resolver, never its own queue).
**Composes:** [DR-012](../../../docs/decisions/DR-012.md) approval gate +
[`approval.ts`](../../../packages/minspec/src/lib/approval.ts),
[`spec-validator.ts`](../../../packages/minspec/src/lib/spec-validator.ts).

---

## Context

The current spec surface ([`spec-panel-html.ts`](../../../packages/minspec/src/views/spec-panel-html.ts))
is a lightweight phase stepper + task checklist + classification table. It is **not**
a review surface: it does not render spec prose, cannot select text, has no comment or
revision loop, and its only write action is toggling task checkboxes.

DR-012 parked a richer surface (issue #36): an ExitPlanMode-style **prettified review
webview** — rendered (not raw) markdown, selectable text, inline comment pins, "have
Claude edit the plan from those comments", and an approve action that runs the DR-012
validator gate. DR-012's research finding stands: `ExitPlanMode`'s native approval panel
is **model-only** — an extension cannot invoke it — so this MUST be a custom
`WebviewPanel`.

This spec expands that parked plan along two axes the session added:

1. **Revision loop with change-highlighting.** Not just "write a comment back to the
   spec" — a closed loop: select text → attach a comment/instruction → an LLM revises
   that span → the change is **highlighted as a diff** the human accepts or rejects
   per-hunk → only then approve.
2. **Chained approval (review-session walk).** The scroll-bottom **Approve** button does
   **not** close the panel. It records the approval and **advances to the next artifact
   that needs a human decision**, fed by the SPEC-012 next-task signpost — so a reviewer
   clears the whole pending queue in one continuous surface instead of re-opening the
   panel per artifact.

### Tier-0 reframe — revision is *delegation*, not in-extension AI

The "LLM revision" step looks like it collides with invariant #2 (Tier-0 core:
zero `http`/`https`/`fetch` in `packages/minspec`, DR-004). It does not. The webview
does exactly what a developer already does by hand in their Claude Code chat — *"fix the
paragraph about X"* — only with the selection and instruction pre-assembled. MinSpec
**triggers the host agent the dev is already running**; it does not itself open a socket.

This is the same boundary the extension already lives on for `gh` (DR-004 **Tier 1 — local
tool delegation**): the extension hands an instruction to a locally-installed tool that
owns its own auth and networking, and imports no networking module itself. **Triggering an
agent ≠ calling a model.** The webview ships in core (Tier 0); only the revision *handoff*
crosses into Tier 1, and it degrades gracefully when no agent is present (the comment
persists as a standing review note — FR-6). Change-highlighting (FR-7) is a purely local
file diff and needs no network at all.

> No standalone DR: this spec records the boundary decision inline (session choice —
> "spec only"). The reasoning leans on the existing DR-004 Tier-1 delegation precedent;
> it does not create a new network posture.

## Surfaces & interaction modes

The webview is **additive** — it does not replace the existing stepper panel (#36 out of
scope is preserved). It is a second, richer panel opened for *review*.

The chain walks whatever SPEC-012 emits as the next human task. Resolver node kinds split
into two interaction modes:

| Resolver node kind (SPEC-012) | Mode | Affordances in webview |
|---|---|---|
| `spec-approve` | **content-review** | render + select + comment + revise + highlight-changed + **Approve** (re-hash, DR-012 gate) |
| `adr-accept` (ADR is a doc) | **content-review** | render + select + comment + revise + highlight-changed + **Accept / Reject** |
| `epic-promote` | **decision-only** | summary card + **Promote** control (status flip); no revise loop needed |
| `issue-triage` *(new — see §Dependencies)* | **decision-only** | issue summary + triage control (inbox → P1/P2/P3); Tier-1 `gh` |
| `phase-action` (author a phase) | **not approvable** | NOT an approval — show "next is authoring work: <imperative>" + Open / Dispatch; never a fake Approve |

The primary button is always present; the **comment → revise → diff** loop appears only
for content-bearing artifacts (specs, ADRs).

## Requirements

### Rendering (pretty, not raw MD)

- **FR-1 (rendered markdown, sanitised, Tier-0).** The active artifact MUST render as
  formatted HTML (headings, tables, code blocks, links) — not raw markdown text. The
  renderer + sanitiser MUST run locally with no network fetch (no remote images/scripts/
  fonts) and MUST reuse the existing CSP-nonce pattern
  ([`spec-panel-html.ts:131-138`](../../../packages/minspec/src/views/spec-panel-html.ts#L131-L138)):
  `default-src 'none'`, inline style allowed, scripts only via per-render nonce. Untrusted
  spec content MUST be sanitised before injection (no raw HTML passthrough).
- **FR-2 (frontmatter + gate state header).** The panel MUST show the artifact's id,
  title, tier, status, approval status (`approved`/`stale`/`unapproved` from `approval.ts`),
  and any blocking validator violations (DR-012) at the top, so the reviewer sees *why*
  this artifact is in the queue before reading it (mirrors SPEC-012 FR-7 show-the-evidence).

### Selection → comment pins

- **FR-3 (text-select → comment pin, Google-Docs conversation-pane model).** Selecting
  rendered text MUST offer "Add comment". A pin stores
  `{ anchor, selectedText, thread[], status, createdAt }` in a sidecar
  `.minspec/review/<artifactId>.json`. Pins render in a **right-margin conversation pane**
  (Google-Docs style): one card per anchored span, stacked in **document order**, the card
  aligned to its anchored line; clicking a card highlights its span and vice-versa. (Anchor
  scheme — how a pin re-binds across edits — is FR-OQ1.)
- **FR-3a (threaded comments + resolve — GDocs semantics).** A pin is a **thread**: an
  initial comment plus replies. The reviewer MAY reply, and MUST be able to **Resolve** a
  thread; resolved threads collapse out of the active pane (retained, reachable via
  "show resolved"). This is the conversation-pane behaviour, not a single flat note.
- **FR-4 (pins are non-destructive to the artifact).** Pins live in the sidecar, NOT in
  the spec body. They MUST NOT change the spec's content hash (so adding a comment does
  not by itself invalidate an existing approval — only an actual edit does, per DR-012).
- **FR-5 (pin lifecycle).** A thread is `open` → `resolved` (re-read confirmed / revision
  applied) or `dismissed`. Resolved/dismissed threads are retained for audit and
  de-emphasised. If the anchored span no longer matches after an edit (FR-OQ1), the thread
  is **orphaned** — surfaced as orphaned (GDocs behaviour), never silently re-pointed at
  the wrong span.

### LLM revision (delegated to host agent — Tier-0 preserved)

- **FR-6 (revise = delegate, never in-extension network).** "Revise with AI" on a pin
  MUST assemble `{ selectedText, comment, surrounding context, target file }` into an
  edit instruction and **hand it to the host agent** (Claude Code / `agent-execute`
  broker / a prompt the running session picks up — mechanism is plan-phase, FR-OQ). The
  webview code in `packages/minspec` MUST import no `http`/`https`/`fetch`/`net` (invariant
  #2). If no agent is reachable, the action MUST degrade: the pin persists as a standing
  review note and the UI states "no agent available — comment saved" (never an error).
- **FR-6a (the dev stays in control of the model).** MinSpec MUST NOT choose, configure,
  or pay for a model. It only constructs the instruction; the host agent (the dev's own
  Claude Code session / their `agent-execute` config) decides how the edit is performed.
  This is what keeps "LLM revision" inside the Tier-1 delegation precedent, not a new
  network surface.

### Highlight changes (local, re-read cue)

- **FR-7 (highlight the new/changed spans only).** When a revision lands (the agent edits
  the file on disk), the webview MUST highlight the **new/changed** passages in the
  rendered artifact — the bits the reviewer needs to **re-read**. Computed locally against
  a per-round snapshot; no network. Removed/old text is **NOT** shown and this is **NOT** a
  two-sided diff review — it is a re-read cue. Highlight clears once the artifact is
  approved (or the panel re-opens fresh).
- **FR-7a (per-revision colour — one colour per changeset).** Each revision **round** in
  the review session gets a **distinct highlight colour** from a cycling palette: spans
  changed by revision 1 in colour A (e.g. blue), revision 2 in colour B (e.g. green), and
  so on. Colours **accumulate** across rounds within the session, so the reviewer can see
  *which round* touched each passage and re-read just the latest (or trace the whole
  sequence). Mechanism: the webview snapshots the file **per round** (before each "Revise
  with AI") and diffs round N against round N−1 to assign that round's colour. The map is
  session-scoped and cleared on approve (FR-7). Constraints:
  - **Palette is a small fixed cycle** drawn from VS Code theme tokens (e.g.
    `--vscode-editor-*Highlight` / `charts.*`), readable in light + dark themes; it
    **cycles/wraps** past its length and the **oldest rounds de-emphasise** (fade) so a
    long session does not become an unreadable rainbow.
  - **Never colour-alone (a11y — WCAG 1.4.1).** Colour MUST be paired with a non-colour
    signal — a per-span label/tooltip ("changed · rev 2") and/or an edge marker — so the
    cue survives for colour-blind reviewers and high-contrast themes. Colour is the
    fast-scan affordance, not the only one.
- **FR-8 (revision applied directly — no accept/reject gate).** A revision is written
  straight to the artifact (a normal file edit). There is **no** per-hunk accept/reject
  step and no removed-text panel. If a revision is wrong, the reviewer re-comments /
  re-revises or edits by hand; the revert path is standard editor undo / git, not a bespoke
  hunk UI. FR-7 (re-read cue) + FR-9 (forced re-hash) ensure nothing lands silently.
- **FR-9 (revision invalidates prior approval — by design).** Because approval is
  content-hash bound (DR-012), any revision changes the hash and any prior approval goes
  `stale`. The revise → re-read (FR-7) → approve sequence is the re-review the gate
  intends; the webview MUST make the re-hash explicit at the Approve step.

### Approve + chain to next (the signpost walk)

- **FR-10 (Approve runs the DR-012 gate, never bypasses it).** The scroll-bottom primary
  action MUST run `validateSpec` first and **refuse** on errors (reusing the exact
  `approveSpecCommand` logic — [`approve.ts:70-100`](../../../packages/minspec/src/commands/approve.ts#L70-L100)),
  surfacing blocking violations. On success it records the approval (re-hash) /
  acceptance / promotion appropriate to the node kind. The webview MUST NOT be a softer
  path to approval than the existing command.
- **FR-11 (Approve advances, does not close).** After a successful decision the panel MUST
  **not** close. It MUST request the next human task from the SPEC-012 resolver and load
  that artifact into the same panel. The panel closes only when the resolver reports the
  queue empty — then it shows a terminal "All clear — no pending approvals" state.
- **FR-12 (ordering is SPEC-012's, never re-derived).** The "next" artifact MUST come from
  the SPEC-012 next-task resolver (one engine, every surface — SPEC-012 FR-11). This
  webview MUST NOT implement its own priority/ordering. Whatever the signpost points to is
  what loads next, including gh issues once SPEC-012 models them (§Dependencies).
- **FR-13 (phase-action nodes are not approvable).** If the resolver's next task is a
  `phase-action` (author a phase — not a gate), the webview MUST NOT present an Approve
  button for it. It MUST show the imperative ("Plan FR-4 of SPEC-006") with Open / Dispatch
  affordances and let the reviewer skip to the next *decision-class* node. Approving
  authoring work would be a category error (and a two-queue leak risk — SPEC-012 INV).
- **FR-14 (skip / defer within the walk).** The reviewer MUST be able to skip the current
  artifact without deciding it (advance to next, current stays pending) and to stop the
  walk. Skipping MUST NOT mutate any artifact. (Composes SPEC-012 INV #5 override —
  dismiss does not change the canonical ranking.)
- **FR-15 (progress affordance).** The walk MUST show position ("3 of 7 pending") and let
  the reviewer expand the full pending pipeline on demand (SPEC-012 FR-6 — pipeline is
  optional expansion, collapsed by default).

### Packaging & boundary

- **FR-16 (HTML generation is a pure, testable function).** Following the existing split
  (`spec-panel.ts` = vscode glue, `spec-panel-html.ts` = pure HTML), all render / highlight
  / markup generation MUST be pure functions (no `vscode`, no network) so they are unit-testable;
  the `vscode`-aware shell only wires messages and file I/O.
- **FR-17 (Tier-0 invariant — enforced).** No file in `packages/minspec` reachable from
  this feature may import `http`/`https`/`fetch`/`net`. A T0 test MUST assert this for the
  new module(s), matching the DR-004 code-review boundary.

## Costly to Refactor (Zone A — read first)

Ranked seams whose shape is expensive to change once code lands. Each names the FR(s)
that pin it.

1. **The revision-handoff contract (FR-6, FR-6a, FR-OQ2).** The `{ selectedText, comment,
   surrounding context, target file }` instruction shape handed to the host agent is the
   Tier-0/Tier-1 boundary line. Pick the wrong handoff (FR-OQ2: chat-participant vs
   `minspec.dispatchRevision` into `agent-execute` vs prompt-file vs DR-017 broker) and you
   either smuggle a network module into `packages/minspec` (breaks INV — Tier-0 core / FR-17)
   or you cannot stay dirty-editor-safe (R4). Changing the channel later re-touches every
   FR-6/FR-7 round-trip. **Hardest to reverse — pin in plan, gate with the FR-17 T0 test.**
2. **The comment-pin anchor scheme (FR-3, FR-5, FR-OQ1).** The sidecar
   `.minspec/review/<artifactId>.json` `{ anchor, selectedText, thread[], status, createdAt }`
   record is *persisted data*. If the re-anchor algorithm (heading-path + quoted-span vs
   char-offset) changes after pins exist on disk, every stored anchor must migrate or
   orphan. Char-offset would have to be ripped out the moment any external edit lands.
   Choose content-based re-anchor up front (FR-OQ1) so the on-disk shape survives edits.
3. **The pure-function render/highlight split (FR-16, FR-1, FR-7a).** Mirroring
   `spec-panel.ts` (vscode glue) / `spec-panel-html.ts` (pure HTML): if render/highlight
   logic leaks `vscode` or file-I/O into the pure layer, the FR-16 unit-testability and the
   FR-17 import-ban both collapse and must be re-split. Establish the boundary in the first
   module, not after.
4. **Gate-call reuse of `approveSpecCommand` (FR-10, INV — Gate parity).** FR-10 requires the
   webview reuse `approve.ts:70-100` *verbatim*, not a fork. A copied-then-drifted validator
   path is the exact bypass R2 warns of; refactoring two divergent approval paths back into
   one later is far costlier than wiring the single shared call now.
5. **SPEC-012 resolver as sole "next" source (FR-12, INV — Single ordering authority).** The
   moment this webview caches or re-derives ordering, it can disagree with the status-bar /
   CI signpost (R3) and the single-engine invariant (SPEC-012 FR-11) is broken across
   surfaces. Always call the resolver live; do not snapshot its order into the panel.

## Mockup (ux aspect — DR-012 §2)

```
┌─ MinSpec · Review ──────────────────────────────────────── 3 / 7 pending ─┐
│ SPEC-006  Stub-Completeness Gate            [T3] [stale ⚠]  [▸ pipeline]   │
│ ⚠ approval stale — edited since last approve · validator: 0 errors        │
├───────────────────────────────────────────────────────────────────────────┤
│                                                       ┌── conversation ──┐  │
│  ## Context                                           │ 💬 Paul · 2:14pm  │  │
│  The gate enforces spec completeness but does ────────┤ "tie this to FR-3"│  │
│  not look at implementation code, so a task ──────────┤   ↳ reply…        │  │
│  can be marked done while the code is a stub.         │   [ Resolve ]     │  │
│                                                       ├──────────────────┤  │
│  ## Decision                                          │ 💬 (resolved) ·…  │  │
│                                                       └──────────────────┘  │
│  Add a code-completeness gate that scans ▓only spec-traced files▓ for stub   │
│  markers, ░skipping vendored paths░.                                         │
│     ▓ rev 1 (blue) ▓   ░ rev 2 (green) ░  = changed in that round → re-read.  │
│     colour per revision, accumulates · old text not shown · not a diff ·     │
│     each span also tooltip-labelled "changed · rev N" (not colour-alone)     │
│  ```ts                                                                       │
│  interface StubFinding { file: string; marker: string; line: number }       │
│  ```                                                                         │
│                                                                              │
│   [ select text → 💬 Add comment ]      [ ✨ Revise with AI (delegated) ]    │
│ ─────────────────────────────────────────────────────────────────────────  │
│                                              scroll ⌄                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐│
│ │  ✓ Approve SPEC-006  →  next: Accept DR-018           [ Skip ]  [ Stop ] ││
│ └─────────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘

decision-only node (epic-promote / issue-triage) collapses to a summary card:

┌─ MinSpec · Review ──────────────────────────────────────── 5 / 7 pending ─┐
│ EPIC-004  Classifier Validation              [proposed]                    │
│ 2 member specs are waiting on this epic being promoted to active.          │
│                              [ ✓ Promote → active ]   [ Skip ]   [ Stop ]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Invariants (must hold)

- **INV — Tier-0 core (T0).** The review webview adds no networking import to
  `packages/minspec`. LLM revision is delegation to the host agent only (FR-6, FR-17).
- **INV — Gate parity (T0).** Approving from the webview is never weaker than
  `minspec.approveSpec`: same validator, same refusal on errors, same content-hash
  re-bind (FR-10). The webview is a nicer door to the *same* gate, not a bypass.
- **INV — Single ordering authority (T0).** "Next to approve" is always the SPEC-012
  resolver's output. The webview never computes its own order (FR-12). Surfaces cannot
  disagree (SPEC-012 FR-11).
- **INV — Two queues (T0, inherited).** Only human-decision nodes are walked. Agent/LLM
  dispatch work is never presented as an approvable step; `phase-action` authoring work is
  shown but not "approved" (FR-13, SPEC-012 INV).
- **INV — Non-destructive review (T0).** Comments (FR-4) and skips (FR-14) never mutate the
  artifact or its hash; only an applied revision (FR-8) and an explicit Approve (FR-10) do.

## Acceptance Criteria (Zone A — definition of done)

Checkbox DoD tracing the FRs. The feature is "done" only when all hold.

- [ ] **Renders, not raw** — the active artifact shows formatted HTML (headings, tables,
  code blocks) under the reused CSP-nonce pattern (`spec-panel-html.ts:131-138`),
  `default-src 'none'`, untrusted content sanitised before injection (FR-1).
- [ ] **Gate-state header** — id / title / tier / status / approval state
  (`approved`/`stale`/`unapproved` from `approval.ts`) + blocking validator violations show
  at the top before the body (FR-2).
- [ ] **Comment pins persist non-destructively** — selecting text adds a thread to
  `.minspec/review/<artifactId>.json`; adding/replying/resolving a comment does NOT change
  the artifact's content hash and does NOT invalidate an existing approval (FR-3, FR-3a,
  FR-4); orphaned-on-no-match is surfaced, never silently re-pointed (FR-5).
- [ ] **Revision is delegation, zero network** — "Revise with AI" assembles the instruction
  and hands it to the host agent; no `http`/`https`/`fetch`/`net` import exists in the
  feature's `packages/minspec` modules, asserted by a passing T0 test (FR-6, FR-17). With no
  agent reachable the action degrades to a saved note, not an error (FR-6).
- [ ] **Re-read highlight, per-round colour, a11y-paired** — landed revisions highlight only
  new/changed spans locally; each round gets a distinct, cycling, theme-token colour paired
  with a non-colour "changed · rev N" label/tooltip (WCAG 1.4.1); cleared on approve (FR-7,
  FR-7a, FR-8).
- [ ] **Approve is never softer than the command** — the scroll-bottom action runs
  `validateSpec` and refuses on errors using the exact `approveSpecCommand` logic
  (`approve.ts:70-100`); a revision forces a visible re-hash so prior approval goes `stale`
  (FR-9, FR-10, INV — Gate parity).
- [ ] **Approve advances, does not close** — on success the panel loads the next human task
  from the SPEC-012 resolver into the same panel; closes only on empty queue → terminal
  "All clear" state (FR-11). Ordering is never re-derived locally (FR-12, INV — Single
  ordering authority).
- [ ] **Phase-action is shown, not approvable** — a `phase-action` node renders its
  imperative + Open/Dispatch and presents no Approve button (FR-13, INV — Two queues).
- [ ] **Skip/stop are non-mutating** — skipping advances without deciding and mutates no
  artifact or hash; the walk can be stopped (FR-14, INV — Non-destructive review).
- [ ] **Progress affordance** — position ("3 of 7 pending") shows; full pipeline expands on
  demand, collapsed by default (FR-15).
- [ ] **Pure render layer** — all render/highlight/markup generation is `vscode`-free,
  network-free, and unit-tested; the shell only wires messages + file I/O (FR-16).

## Coverage Map (session asks → FR)

| Concern (from session) | FR |
|---|---|
| Pretty, not raw MD | FR-1 |
| Approximates ExitPlanMode (custom webview, native not invocable) | FR-1, DR-012 finding |
| Text select → comment | FR-3, FR-4 |
| → LLM revision | FR-6, FR-6a |
| → highlight new/changed bits to re-read (no diff, no removals) | FR-7, FR-8 |
| → distinct highlight colour per revision changeset (rev1 blue, rev2 green, …) | FR-7a |
| Scroll-bottom Approve that does NOT close | FR-11 |
| Approve shows the next spec/dr/issue/doc | FR-11, FR-12 |
| "whatever the next-human-task signpost points to" | FR-12 (consume SPEC-012) |
| "probably includes gh issues too" | FR-12 + §Dependencies (SPEC-012 issue node) |
| "rules getting in the way" (Tier-0 vs AI) | §Tier-0 reframe, FR-6, FR-17 |
| Doesn't replace existing stepper | Surfaces §, additive |

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|---|---|---|
| R1 | **Tier-0 erosion.** "Just one fetch" creeps into the webview to call a model directly, breaking the air-gapped selling point (invariant #2). | Med · High | FR-6/FR-17 + a T0 import-ban test; revision is delegation only. Reviewed at the DR-004 code-review boundary. |
| R2 | **Gate bypass via the pretty door.** The webview becomes an easier path that skips the validator the command enforces. | Med · High | FR-10 reuses `approveSpecCommand`'s validate-then-refuse logic verbatim; INV — Gate parity + test. |
| R3 | **Ordering drift.** Webview computes its own "next" and disagrees with the status-bar/CI signpost, destroying trust. | Low · High | FR-12 forbids local ordering; consumes SPEC-012's single engine (its FR-11). |
| R4 | **Unwanted / clobbering revision.** The agent's edit is wrong, or overwrites concurrent manual edits. | Med · Med | Revision is a normal file edit → standard editor undo / git revert (no bespoke hunk UI to get wrong); FR-9 forces re-hash so a bad edit can't sneak past approval; dirty-editor-safe handoff (plan-phase, mirrors SPEC-012 FR-15 dirty-safe rung). Re-comment to re-revise. |
| R5 | **Stale anchors.** A comment pin's anchor drifts after an edit and points at the wrong span. | Med · Med | Content-based re-anchor (FR-OQ1), not char-offset; on no acceptable match the thread is **orphaned** and surfaced as such (FR-5, GDocs behaviour) — never silently re-pointed at the wrong span. Matcher + confidence threshold pinned at plan. |
| R6 | **Approve-chain fatigue → rubber-stamping.** A continuous walk encourages reflexive approval without reading (the DR-020 R1 risk, amplified by flow). | Med · Med | FR-2 surfaces violations + stale state up-front; FR-14 skip is frictionless so "not sure" need not become a click-through approve; validator still refuses incomplete specs (FR-10). |
| R7 | **Phase-action category error.** Authoring work shown with an Approve button → two-queue leak. | Low · Med | FR-13 explicitly de-approves phase-action nodes; INV — Two queues + test. |
| R8 | **Highlight overload / colour-only a11y.** Many revision rounds → rainbow noise; colour-blind / high-contrast reviewers miss colour-coded changes. | Med · Med | FR-7a: small cycling palette from theme tokens, oldest rounds fade; colour never the sole signal — paired "changed · rev N" label/tooltip + edge marker (WCAG 1.4.1). |

## Dependencies

- **`depends_on: SPEC-012`** — this webview is a surface over the next-task resolver; it
  cannot chain without it. The resolver today models `spec-approve`, `adr-accept`,
  `epic-promote`, `phase-action` — it does **not** yet model **gh issues**. The session
  asked the chain to "probably include gh issues too", so SPEC-012 needs an
  **`issue-triage` node kind** (Tier-1, `gh`). That is a SPEC-012 extension, tracked as a
  follow-up below — this spec consumes whatever node kinds the resolver emits and does not
  add ordering of its own.

## Blast-Radius (what breaks if these change)

Beyond the `depends_on: SPEC-012` link above, the declared touch-surface and the failure
each change would trigger:

- **`approve.ts:70-100` (`approveSpecCommand` validate-then-refuse path)** — FR-10 reuses it
  verbatim. If its signature or refusal behaviour changes, the webview's Approve silently
  diverges from `minspec.approveSpec` → INV — Gate parity breaks (R2). Any edit there must
  re-run the gate-parity test for both surfaces.
- **`spec-validator.ts` (DR-012 gate)** — the validator the gate calls. A new violation class
  added there must surface in FR-2's header and be refused by FR-10; a missing-vs-dangling
  asymmetry (the SPEC-004 class of bug) would let an incomplete spec through both doors.
- **`approval.ts` (content-hash + `approved`/`stale`/`unapproved`)** — FR-2 reads its state,
  FR-9 depends on its hash-binding. Change the hash algorithm and every persisted approval +
  every stored pin's "did the artifact change" assumption (FR-4) must be re-evaluated.
- **`spec-panel-html.ts:131-138` (CSP-nonce pattern)** — FR-1 reuses it. Loosen the CSP there
  (e.g. allow remote `img-src`) and the no-network-fetch guarantee of FR-1 silently weakens.
- **SPEC-012 resolver node-kind set** — FR-12 renders whatever it emits. Adding/removing a
  node kind (e.g. the planned `issue-triage`) changes which artifacts the walk loads; an
  unhandled kind must degrade to "shown, not approvable" rather than crash the walk (FR-13).
- **`.minspec/review/<artifactId>.json` sidecar schema** — FR-3's persisted record. New
  consumers (or a schema change) ripple to FR-3a threads, FR-5 lifecycle, and FR-OQ1
  re-anchor. This file is data-on-disk: treat its shape as a contract, not an implementation
  detail.

## Assumptions

- A **host agent is usually but not always present** — Claude Code / `agent-execute` broker
  is reachable for the FR-6 revision handoff in the common case, but FR-6 explicitly handles
  its absence (degrade to saved note). We do not assume an always-on agent.
- **SPEC-012's resolver is the queue** — we assume it already emits, or will emit, the node
  kinds the walk needs (`spec-approve`, `adr-accept`, `epic-promote`, `phase-action`, and the
  follow-up `issue-triage`); this spec adds no ordering and assumes none is needed here.
- **Specs are plain external `.md` files** with no live editor session to track positions —
  the assumption that forces content-based re-anchoring over char-offset (FR-OQ1).
- **VS Code theme tokens** (`--vscode-editor-*Highlight` / `charts.*`) provide enough
  distinct, light/dark-readable colours for the FR-7a cycling palette before it must wrap.

## Test-thought

Verified by: a **T0 import-ban test** asserting no `http`/`https`/`fetch`/`net` in the
feature's `packages/minspec` modules (FR-17), a **gate-parity test** proving webview-Approve
refuses exactly when `minspec.approveSpec` does (FR-10), and **pure-function unit tests** over
the render/highlight markup (FR-16) — comment-pin persistence and re-anchor exercised against
fixture `.minspec/review/*.json`.

## Consequences

**Positive:**

- The review surface and the enforcement command share one gate (FR-10) — there is exactly
  one place approval can happen and one validator (DR-012), so "the pretty door" can never be
  a softer path (closes the R2 class permanently, not per-feature).
- The continuous walk (FR-11/FR-12) over the SPEC-012 single engine means the reviewer clears
  the whole pending queue in one surface, and every surface (status bar, CI, this panel)
  agrees on "what's next" by construction (INV — Single ordering authority).
- LLM revision lands without breaching Tier-0 (FR-6/FR-17): the air-gapped-core selling point
  survives even as the product gains an AI-revision affordance — delegation, not a socket.

**Negative:**

- A new persisted artifact class (`.minspec/review/<artifactId>.json`) now needs lifecycle
  care: orphaned anchors (FR-5), schema migration (Blast-Radius), and audit retention — state
  the product did not previously carry.
- The flow itself introduces a *human* risk the old per-artifact panel did not: approve-chain
  fatigue → rubber-stamping (R6); we accept it and lean on FR-2 up-front evidence + frictionless
  FR-14 skip rather than removing the chain.
- Two Tier boundaries now run through one feature (Tier-0 webview + Tier-1 revision handoff),
  so every change near FR-6 must be re-checked against FR-17 — ongoing review cost.

## Failure-Modes / Edge-Cases

- **No agent reachable at "Revise with AI"** (FR-6) → degrade to a saved standing note with
  "no agent available — comment saved"; never an error, never a dropped comment.
- **Anchored span no longer matches after an external/agent edit** (FR-5, FR-OQ1) → thread is
  marked **orphaned** and surfaced as such; MUST NOT silently re-point at a wrong span.
- **Agent edit clobbers a dirty (unsaved) editor buffer** (R4) → handoff must be dirty-editor-safe
  (FR-OQ2); the recovery path is standard editor undo / git, with FR-9 re-hash ensuring the bad
  edit cannot pass approval unseen.
- **Resolver emits an unmodelled node kind** (e.g. `issue-triage` before this surface handles
  it) → fall back to "shown, not approvable" (FR-13 spirit), never crash or fabricate an Approve.
- **Resolver reports the queue empty mid-walk** (FR-11) → panel shows the terminal "All clear —
  no pending approvals" state rather than loading nothing or closing abruptly.
- **Validator errors on Approve** (FR-10) → refuse and surface the blocking violations; the walk
  stays on the current artifact, does not advance, does not record a partial approval.
- **Long revision session → palette exhausted** (FR-7a) → palette cycles/wraps and oldest rounds
  fade; the non-colour "changed · rev N" label remains the durable signal (WCAG 1.4.1).

## Test / Verification Strategy

Per-FR test tier + a one-line assertion sketch.

| FR | Tier | Assertion sketch |
|---|---|---|
| FR-17 (no-network) | T0 | static-import scan of feature modules under `packages/minspec` asserts zero `http`/`https`/`fetch`/`net`. |
| FR-10 (gate parity) | T0 | given an invalid spec, webview-Approve refuses iff `approveSpecCommand` refuses (same validator, same message). |
| FR-12 (single ordering) | T0 | "next" loaded by the panel `===` the SPEC-012 resolver's emitted next node; panel computes no order of its own. |
| FR-4 (non-destructive pins) | T0 | adding/resolving a thread leaves the artifact content hash unchanged → prior approval stays valid. |
| FR-13 (phase-action) | T1 | a `phase-action` node renders Open/Dispatch and exposes NO Approve control. |
| FR-1 (render + CSP) | T1 | rendered HTML carries the nonce CSP, `default-src 'none'`, and raw HTML in spec body is sanitised out. |
| FR-2 (gate-state header) | T1 | header reflects `approved`/`stale`/`unapproved` from `approval.ts` + blocking violations. |
| FR-5 / FR-OQ1 (re-anchor / orphan) | T2 | after an edit above a pinned span, the thread re-binds by content or is marked orphaned — never wrong-pointed. |
| FR-7 / FR-7a (highlight + a11y) | T2 | a landed revision highlights only changed spans, in the round's colour, with a paired "changed · rev N" label. |
| FR-6 (revise degrades) | T2 | with no agent reachable, "Revise with AI" saves the note and shows the degrade message (no throw). |
| FR-11 (advance not close) | T2 | a successful Approve loads the resolver's next node into the same panel; empty queue → "All clear". |
| FR-14 (skip non-mutating) | T2 | Skip advances and leaves the skipped artifact + its hash untouched. |
| FR-16 (pure functions) | T2 | render/highlight helpers run with no `vscode` and no file I/O in scope. |
| FR-9 (re-hash visible) | T3 | a revision flips a prior `approved` to `stale` and the Approve step shows the re-hash. |

## Alternatives Considered

Named design alternatives weighed for this spec's two pinned seams (Costly#1 revision
handoff; the review-surface medium) plus the viewer-vs-editor framing. Each is "rejected
because Y", consolidating the options scattered across Costly#1 and FR-OQ2 into one
comparison. The handoff alternatives are mutually exclusive *channels* for FR-6's
delegation; FR-OQ2 keeps the final pick open to plan but records why none is the obvious
default and what each costs against the invariants.

**The review surface medium:**

- **Alternative A — invoke ExitPlanMode's native approval panel** instead of a custom
  `WebviewPanel`. *Rejected because* the DR-012 finding (Context §) stands: ExitPlanMode's
  native panel is **model-only** — an extension cannot invoke it — so FR-1's rendered,
  selectable, comment-bearing surface is unreachable that way. The custom webview is forced,
  not chosen.
- **Alternative B — render the artifact in a native VS Code text editor** (a virtual/
  read-only document) rather than a webview. *Rejected because* FR-1 requires *rendered*
  HTML (headings, tables, code blocks — pretty, not raw MD) with the FR-3 Google-Docs
  right-margin conversation pane and FR-7/FR-7a per-round colour highlighting; a text editor
  shows raw markdown and has no margin-card or multi-colour span affordance. It would also
  drop the FR-1 CSP-nonce sandbox (`spec-panel-html.ts:131-138`) the no-network guarantee
  reuses. A native editor is the right surface for *editing* the `.md`, which is exactly the
  viewer-vs-editor split deferred below.

**The revision-handoff channel (FR-6 delegation; Costly#1, FR-OQ2 — Tier-0/Tier-1 line):**

- **Alternative C — call a model directly from the webview** (one `fetch` to an LLM API).
  *Rejected because* it breaks INV — Tier-0 core / FR-17 (no `http`/`https`/`fetch`/`net`
  in `packages/minspec`), erasing the air-gapped-core selling point (R1). This is the exact
  creep FR-6/FR-6a/FR-17 exist to forbid; non-negotiable, not merely deferred.
- **Alternative D — VS Code chat-participant API** as the Tier-1 handoff. *Rejected as the
  default because* it couples the revision loop to a specific chat surface and does not by
  itself guarantee the dirty-editor-safe write FR-6/R4 demand (the agent edits the file on
  disk while an unsaved buffer may be open). Kept as a live candidate in FR-OQ2, not chosen
  here.
- **Alternative E — prompt-file the running session watches.** *Rejected as the default
  because* it is the loosest contract: no acknowledgement that the agent picked the
  instruction up, making FR-6's "no agent available → degrade to saved note" hard to detect
  reliably, and it offers no dirty-editor coordination (R4). Viable fallback, weak primary.
- **Alternative F — `claude -p` via the DR-017 host-side broker** (cred-free sandbox →
  host broker). *Rejected as a hard dependency because* it presumes the `agent-execute`
  /DR-017 broker is installed, whereas FR-6 must degrade gracefully when *no* agent is
  reachable (Assumptions: agent usually-but-not-always present). It remains the preferred
  channel *when present*, but cannot be the sole path. The chosen direction is a
  `minspec.dispatchRevision` command (Costly#1) that targets whatever Tier-1 agent exists
  (broker / chat / session) behind one instruction shape — but the concrete channel stays
  FR-OQ2-open to plan, gated by the FR-17 T0 import-ban test.

**Viewer vs editor (relates to SPEC-018):**

- **Alternative G — make this webview a full spec *editor*** (in-panel direct text editing
  of the `.md`), not a review viewer. *Rejected because* it conflates two surfaces: this
  spec is a *review* surface whose only writes are FR-8 delegated revisions and the FR-10
  Approve gate — comments are FR-4 non-destructive and skips are FR-14 non-mutating (INV —
  Non-destructive review). Direct artifact editing is the viewer-vs-editor concern owned by
  **SPEC-018**; folding it in here would breach the non-destructive invariant and blur the
  Costly#1 handoff boundary. Kept out: editing stays SPEC-018's; this panel reviews.

## Rollback / Reversibility

- **Undo mechanism.** The feature is **additive** (FR — Surfaces §: a second panel, the
  existing stepper untouched) so it can be disabled/removed without touching the spec-panel
  surface or the approval command. A bad revision is reversible by standard editor undo / git
  (FR-8, R4) — no bespoke hunk state to unwind. The one piece of new *persisted* state is the
  `.minspec/review/<artifactId>.json` sidecar; deleting it loses comment threads but harms no
  artifact or approval (FR-4 keeps pins non-destructive), so rollback is clean.
- **ADR-filter answer.** Can this be undone in < 1 day? The *webview* yes (additive, removable).
  But the two seams it pins are **not** cheaply reversible once code + on-disk pins exist: the
  Tier-0/Tier-1 revision-handoff channel (FR-OQ2) and the pin anchor scheme + sidecar schema
  (FR-OQ1). Those cross the Tier-0 invariant and persist data → they warrant the ADR-level
  rigor this spec already carries (composes DR-012; reasons on the DR-004 Tier-1 precedent).
  No *new* DR is created (Context §: boundary recorded inline), but the decision is DR-bound,
  not a < 1-day reversible call.

## Out of scope

- **Replacing the existing stepper panel** (`spec-panel*.ts`) — this is additive (#36 out
  of scope, preserved).
- **The ordering engine** — owned by SPEC-012 (consumed, not redefined).
- **Choosing/configuring/paying for a model** — the host agent owns that (FR-6a).
- **Defining `issue-triage` / arbitrary-doc approval node kinds** — a SPEC-012 concern
  (follow-up). This spec only requires that the chain renders whatever the resolver emits.
- **The blocking enforcement itself** — DR-012's PreToolUse gate is unchanged; this is a
  review *surface*, not a new enforcement primitive.

## Open questions

- **FR-OQ1 — anchor scheme for comment pins.** *Presentation resolved: Google-Docs
  conversation pane* (FR-3/3a — margin cards, document order, threads, resolve, orphan-on-
  delete). **Still open: the re-anchor algorithm.** GDocs keeps anchors live because it
  *owns the editor* and tracks every position through OT; MinSpec does **not** — the spec is
  a plain `.md` file edited externally and rewritten by the agent, with no live session to
  track. So anchors MUST re-bind by **content** on each (re)render, not by char-offset
  (which any edit above the span breaks). Lean: heading-path + quoted-span, fuzzy-match
  fallback, orphan when no acceptable match. Pin the exact matcher + match-confidence
  threshold at plan. *(Open — plan phase.)*
- **FR-OQ2 — revision handoff mechanism.** Which Tier-1 path: VS Code chat-participant API,
  a `minspec.dispatchRevision` command into `agent-execute`, a prompt file the running
  session watches, or `claude -p` via the DR-017 broker? Must be dirty-editor-safe (R4).
  *(Open — plan phase.)*

## Follow-ups (tracked)

- **SPEC-012 `issue-triage` node kind** — so the approve-chain can include gh issues
  (session ask). Cross-spec follow-up, not covered by this spec's own FRs → SPEC-012
  amendment, tracked at
  [#92](https://github.com/harvest316/minspec/issues/92).
