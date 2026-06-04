---
id: SPEC-017
type: requirements
status: specifying
tier: T3
product: minspec
epic: EPIC-002  # Signpost Integrity
aspects: [ux, data]
depends_on: [DR-012]
relates_to: [SPEC-014, SPEC-015, SPEC-004, SPEC-018]
---

# MinSpec — Trust Dashboard (Requirements)

**Date:** 2026-06-03
**Status:** Specifying (SDD Specify phase)
**Triggered by:** session request — "add a graph showing % documentation chars
reworked after review (even if changed by the dev outside the reviewing webview),
including chars revoked/superseded by a later doc — i.e. how often does the LLM get
it right the first time / how much am I rubber-stamping? Maybe other trust charts.
Maybe record the time a human spent reading a doc to detect rubber-stamping."
**Composes:** [DR-012](../../../docs/decisions/DR-012.md) approval gate +
[`approval.ts`](../../../packages/minspec/src/lib/approval.ts) (hash-lock — the
review baseline this spec extends from *hash* to *snapshot*).
**Epic:** [EPIC-002 Signpost Integrity](../../../docs/epics/EPIC-002-signpost-integrity.md)
— the signpost is only "never wrong" if the human approvals it assumes are *real*.
This dashboard measures whether they are.
**Relates:** [SPEC-014 Review Webview](../review-webview/requirements.md) (its **R6
approve-chain fatigue → rubber-stamping** risk is exactly what this measures; candidate
host for the chart), [SPEC-015 Status Lanes](../status-lanes/requirements.md) (the
`superseded` lane Metric 2 needs), [SPEC-004 Classifier Validation](../classifier-validation/requirements.md)
(the *proxy-trap* precedent — see §The proxy trap).

---

## Context

MinSpec's product thesis is **"just enough human"**: the LLM does the thorough
thinking, the human verifies the *signal*, not the content. The whole guarantee — the
never-wrong signpost (EPIC-002) — rests on that human verification actually happening.
The standing risk, named but unmeasured, is **rubber-stamping**: the human clicks
Approve without engaging, and a false "reviewed" enters the chain. SPEC-014 lists it as
risk R6; nothing today *detects* it.

This spec adds the missing feedback loop: a **Trust Dashboard** that measures how much
LLM-generated documentation survives human review unchanged, and surfaces the
rubber-stamping signal from *outcomes* — not from accusations.

**What exists to build on.** [`approval.ts`](../../../packages/minspec/src/lib/approval.ts)
(DR-012) records an approval as `{ specHash, approvedAt, tier }` and flips status to
`stale` when the file's sha256 changes. That gives us the **review baseline event** and
a binary *did-it-change* — but a hash cannot tell us *how much* changed, and only the
latest approval is kept. Both gaps are this spec's data-model work.

**Measurement is the moat.** A signpost that says "you rubber-stamped 60% of last
sprint's specs" is a differentiator no diff tool offers. The outcome metrics below are
ground truth; reading-time is a correlate only (§The proxy trap).

## The three signals

| # | Signal | Question it answers | Class |
|---|---|---|---|
| **M1** | **Char rework %** | How often does the LLM get it right the first time? | **outcome (ground truth)** |
| **M2** | **Superseded chars** | How much approved doc got thrown away wholesale? | **outcome (ground truth)** |
| **M3** | **Time-to-approve** | *(secondary)* Was this approval plausibly read? | **correlate only — never a verdict** |

M1 and M2 are deterministic, recomputable from files on disk. M3 is a noisy proxy and is
**only ever shown crossed with M1** (§FR-9, §The proxy trap).

## The proxy trap (design constraint, not optional)

The user's first instinct — *"flag any doc approved in <5 min as skimmed"* — is the
**exact failure mode** MinSpec already diagnosed in [SPEC-004](../classifier-validation/requirements.md):
a metric that *looks* rigorous but measures the wrong thing (there, the tier classifier
measured **diff size**, not **difficulty**). Time-on-doc is the same trap:

- A tab left open 3 hours ≠ 3 hours of reading (lunch, context-switch, second monitor).
- A 2-minute approval of a doc the human **co-authored** is not a skim — it deflates falsely.
- Wall-clock open→approve has no idea whether eyes were on the text.

A bare time threshold would fire false "you skimmed this" accusations on good approvals,
and the *first* false accusation destroys trust in the very tool whose job is trust.
Therefore this spec **forbids a standalone time verdict** (no `approved-in: <5min ⇒
skimmed` frontmatter note) and requires that time only ever appear **paired with the
outcome metric**: the rubber-stamp signal is *fast-approve **and** high-later-rework*,
not *fast-approve*. (Decided this session; recorded inline — no separate DR.)

## Requirements

### M1 — Char rework % (outcome)

- **FR-1 (approval snapshot, not just a hash).** On approval, the system MUST persist a
  **content snapshot** of the approved spec body alongside the existing
  `{ specHash, approvedAt, tier }` record (extends the `ApprovalRecord` /
  [`approval.ts`](../../../packages/minspec/src/lib/approval.ts) data model). The hash
  alone (sha256, all-or-nothing) cannot yield a percentage; the snapshot is the diff
  baseline. Storage location/format is FR-OQ4.
- **FR-2 (rework = char delta against the approved snapshot).** Rework % for a spec MUST
  be computed as the share of **approved-body characters** that differ between the
  approved snapshot and the later content (the next approval's snapshot if re-approved,
  else the current on-disk body if `stale`). The char-delta is a **char-level diff**
  (changed chars ÷ `max(approvedChars, currentChars)`), vendored/no-network; it MUST be
  deterministic and recomputable from files alone. *(Resolved FR-OQ2 — see §Clarify.)*
- **FR-3 (counts edits made *anywhere*).** Because FR-2 diffs **content**, not webview
  events, rework MUST count every edit equally — a SPEC-014 in-webview revision, a manual
  edit in the editor, or an agent edit on disk. The metric MUST NOT instrument any single
  surface; the file is the source of truth. *(This is the user's "even if changed by the
  dev outside the reviewing webview" requirement.)*
- **FR-4 (body bytes only — frontmatter churn is not rework).** The diff MUST be taken
  over the spec **body**, excluding frontmatter, so a `status:` flip, a `stale`/`approved`
  transition, or a hash-lock notice does not register as the human reworking the LLM's
  prose. The body is taken via the existing `parseSpec` frontmatter split (no new
  two-zone delimiter needed). *(Resolved FR-OQ5 — see §Clarify.)*

### M2 — Superseded chars (outcome)

- **FR-5 (`superseded` status + `superseded-by` link).** A spec that is wholly replaced by
  a later one MUST be expressible as `status: superseded` with a `superseded-by: SPEC-NNN`
  frontmatter field. `superseded` MUST be added to
  [`SPEC_STATUSES`](../../../packages/minspec/src/lib/spec.ts#L14); per SPEC-015 INV-1
  (total, disjoint status→lane map, T0-tested) adding it **forces** a lane-mapping decision
  — that is the intended gate, not an accident. (ADRs already model `superseded` in
  [`adr-manager.ts`](../../../packages/minspec/src/lib/adr-manager.ts); this brings specs to parity.)
- **FR-6 (superseded approved chars count as reworked-wasted).** When a spec is superseded,
  the chars the human **previously approved** in it MUST be attributable as wasted review
  in the dashboard, shown as a **separate "wasted review" bar** — distinct from M1 per-spec
  edit churn, NOT folded into the M1 denominator — because a fully-superseded approved doc
  is a different, more expensive failure (100% of that review thrown away) and conflating it
  with edit-churn would blur both signals. *(Resolved FR-OQ3 — see §Clarify.)*

### M3 — Time-to-approve (secondary correlate)

- **FR-7 (record a review-start timestamp).** In addition to `approvedAt`, the system MUST
  record a **review-start** timestamp. Review-start = the first engagement event on the
  artifact (focus / first visible-range change), NOT mere file-open, so a doc opened in a
  background tab does not start the clock. *(Resolved FR-OQ6 — see §Clarify.)*
- **FR-7a (engaged time, not wall-clock — idle-stripped).** M3's duration MUST be **active
  reading time**, not `approvedAt − reviewStart` wall-clock. The system samples engagement
  events — in the spec-panel webview, full DOM scroll/focus/visibility; in a plain editor,
  [`onDidChangeTextEditorVisibleRanges`](https://code.visualstudio.com/api) (scroll),
  `onDidChangeTextEditorSelection` (cursor/click), `onDidChangeActiveTextEditor` (focus) —
  and **strips idle gaps** (no event for > an idle threshold, e.g. 60s) so a tab left open
  at lunch does not count as reading. This denoises M3's worst flaw (R7) but does **not**
  promote it: engaged time is still a *correlate*, still shown only crossed with rework
  (FR-9), never a comprehension score. Scroll/focus events are **content-free** telemetry
  (positions + timestamps, never text), under the same opt-in as FR-8. The **richest**
  source is [SPEC-018](../spec-custom-editor/requirements.md) (specs opened in MinSpec's own
  webview editor → full-DOM events); the plain-editor path is the fallback when that editor
  is off. This metric MUST work with **either** source — it never *requires* SPEC-018.
- **FR-7b (engagement is a proxy, not comprehension — no scroll-verdict).** "Scrolled fast"
  / "didn't scroll to bottom" MUST NOT become a skimmed verdict. Scroll-to-bottom to unlock
  Approve defeats any such signal — the same proxy trap (§The proxy trap). Engagement is
  used **only** to subtract idle time from M3 (FR-7a); it never produces a standalone
  judgment. *(Bound by INV — Outcome over proxy.)*
- **FR-8 (opt-in + auditable — no covert human telemetry).** Recording reading time is
  telemetry about the *human*. It MUST be **opt-in**, its state MUST be visible in the UI
  (settings text + an indicator), and it MUST store **no content** of what was read — only
  timestamps and **scroll/focus positions** (never text, never keystrokes). This mirrors
  the constitution's consent constraint ("no network calls / data capture without consent")
  and the auditable-visibility invariant (#8). When the toggle is off, M3 and all engagement
  sampling (FR-7a) are simply absent; M1/M2 still work.
- **FR-9 (time is shown only crossed with rework — never alone).** The dashboard MUST
  present M3 only as a **scatter of engaged reading time (x, FR-7a) vs later-rework % (y)**, so the
  rubber-stamp read is the *pairing* (fast + high-rework = suspect; fast + zero-rework =
  a sharp reviewer on a good doc, **not** flagged). The system MUST NOT emit any
  time-only judgment — no "approved in <Nmin, likely skimmed" frontmatter note, badge, or
  warning. (Enforces §The proxy trap; T0-tested per INV — Outcome over proxy.)

### The chart pane (first chart in MinSpec)

- **FR-10 (Tier-0 local rendering).** Charts MUST render with **no network import** in
  `packages/minspec` (invariant #2 / DR-004): inline SVG or a vendored no-fetch renderer,
  reusing the existing CSP-nonce pattern in
  [`spec-panel-html.ts`](../../../packages/minspec/src/views/spec-panel-html.ts). No chart
  CDN, no remote fonts/scripts. This is the **first** chart in MinSpec (the spec panel uses
  `vscode-charts` *colours* only). It ships as a **new section in the existing spec-panel
  webview** — independent of the unbuilt SPEC-014 review webview — so the dashboard is not
  blocked on SPEC-014. *(Resolved FR-OQ1 — see §Clarify.)* FR-12 keeps render host-agnostic
  so it can later also mount in the review pane.
- **FR-11 (the dashboard reads, never writes, specs).** Computing and displaying metrics
  MUST be read-only over specs and the approval store. It MUST NOT mutate any spec body or
  change any content hash (so opening the dashboard can never invalidate an approval —
  same non-destructive guarantee as SPEC-014 FR-4).
- **FR-12 (pure, testable metric + render functions).** Following the existing split
  (`spec-panel.ts` glue / `spec-panel-html.ts` pure HTML), metric computation and chart
  markup MUST be pure functions (no `vscode`, no network) so the numbers are unit-testable
  against fixture snapshots; the `vscode` shell only wires file I/O and the webview.

## Costly to Refactor

*The expensive-to-reverse commitments — read closely; everything else is cheap to change
live. Ranked most→least costly.*

1. **`ApprovalRecord` schema gains a snapshot + reviewStart (FR-1, FR-7).** The
   approval-store data model every approve/read touches; changing it later means migrating
   `.minspec/approvals.json` and every stored snapshot. *Check: snapshot storage shape and
   `approvals.json` migration settled before any approval writes the new fields.*
2. **`superseded` status + `superseded-by` field (FR-5).** A doc-adopted frontmatter
   contract + an enum addition that SPEC-015's total-coverage T0 test binds; changing the
   grammar = re-edit every superseded spec + the lane map + validator. *Check: field name
   and lane placement fixed before any spec adopts it.*
3. **Rework metric definition — char-delta algorithm + body boundary (FR-2, FR-4).**
   Decided (§Clarify): char-level diff ÷ `max` chars, body via `parseSpec` split. Still the
   costliest *contract* — changing it silently changes *every historical number* shown.
   *Check: the exact diff library + `max`-denominator locked before the dashboard ships a
   single percentage.*
4. **Snapshot storage location/format/retention (FR-1).** Decided (§Clarify): latest-approved
   body, gzipped, git-ignored `.minspec/snapshots/`, numeric trend history. Moving it later =
   re-snapshot or lose trend. *Check: the gitignore entry + numeric-history schema land with
   the first snapshot write.*
5. **Chart host (FR-10).** Decided (§Clarify): own spec-panel section. Cheap to re-host
   *only because* FR-12 keeps render a pure `vscode`-free function. *Check: render stays
   host-agnostic so a later review-pane mount is a re-wire, not a rewrite.*

## Invariants (must hold)

- **INV — Outcome over proxy (T0).** No proxy-only rubber-stamp verdict is ever emitted —
  not from time, not from engagement (scroll/click). Time and engagement appear only crossed
  with rework (FR-9), and engagement only ever *subtracts idle* from M3 (FR-7a/7b), never
  scores reading. A T0 test asserts no code path writes a time/scroll-threshold flag to a
  spec or fires such a warning. *(Encodes §The proxy trap; the SPEC-004 lesson made
  un-repeatable.)*
- **INV — Non-destructive measurement (T0).** Computing/recording metrics never changes a
  spec body or its content hash; snapshots and timestamps live in `.minspec/`, never in the
  spec file (FR-11). Opening the dashboard cannot invalidate an approval.
- **INV — Consensual human telemetry (T0).** Reading-time capture is opt-in, UI-visible,
  and content-free (FR-8). Off by default ⇒ M3 absent, M1/M2 intact.
- **INV — Tier-0 core (T0).** The chart adds no `http`/`https`/`fetch`/`net` import to
  `packages/minspec` (FR-10, invariant #2 / DR-004). Import-ban T0 test, as SPEC-014 FR-17.
- **INV — Deterministic, recomputable outcomes (T0).** M1/M2 are pure functions of files on
  disk + the approval store; same inputs ⇒ same numbers, no hidden event log required (FR-2,
  FR-3, FR-12).

## Coverage Map (session asks → FR)

| Concern (from session) | FR |
|---|---|
| % documentation chars reworked after review | M1: FR-1, FR-2 |
| "even if changed by the dev outside the reviewing webview" | FR-3 (diff content, not webview events) |
| chars of doc revoked/superseded by a later doc | M2: FR-5, FR-6 |
| "how often does the LLM get it right the first time" | M1 (rework % = inverse) |
| "how much am I rubber-stamping" | FR-9 (time × rework pairing) |
| same graph pane as the other chart | FR-10 (own spec-panel section; first chart) |
| other trust charts | M1/M2/M3 dashboard scope |
| record time the human spent reading | FR-7a (engaged time, idle-stripped; opt-in, FR-8) |
| track scroll/click engagement for "real" reading time | FR-7a (denoise only) · FR-7b (never a verdict) |
| "<5min ⇒ likely skimmed" frontmatter note | **Rejected** — §The proxy trap, INV-Outcome-over-proxy, FR-9 |

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|---|---|---|
| R1 | **Proxy-trap resurfaces.** A future change re-adds a time-only "skimmed" flag; first false accusation kills trust in the trust tool. | Med · High | INV-Outcome-over-proxy + FR-9 (time only as scatter) + a T0 test that fails on any time-threshold verdict. The lesson is encoded, not just documented. |
| R2 | **"Rework = LLM failure" misframing.** Healthy iteration (a slow, careful rewrite) reads as "the LLM got it wrong," punishing engagement. | Med · Med | Frame M1 as **review churn**, not LLM error; the *diagnostic* value is rework **crossed with** time (FR-9): high rework after a *slow* review = healthy iteration; high rework after a *fast* approve = rubber-stamp. Copy must not say "LLM was wrong." |
| R3 | **Snapshot storage bloat / repo duplication.** Storing full approved bodies per spec per round duplicates the repo many times over. | Med · Med | Resolved FR-OQ4 (§Clarify): latest-approved body only, gzipped, git-ignored `.minspec/snapshots/`; trend kept as a small numeric history, not per-round bodies. |
| R4 | **Human-surveillance smell.** Timing the developer feels like spyware, off-brand vs the no-prying principle. | Med · Med | FR-8: opt-in, UI-visible, timestamps-only (no content), off by default. It is self-quantification the dev switches on, never covert. |
| R5 | **Frontmatter churn counted as rework.** Status flips / hash-lock notices inflate M1. | Med · Low | FR-4: diff body bytes only; reuse a defined body/zone boundary (FR-OQ5). |
| R6 | **Snapshot/timestamp write invalidates the approval.** Persisting into the spec file changes its hash → marks it stale. | Low · High | INV-Non-destructive + FR-11: all state in `.minspec/` sidecar; never touch spec bytes. |
| R7 | **"Review-start" / wall-clock is unmeasurable.** Tab-open ≠ reading; idle time inflates duration → M3 garbage in. | Med · Med | FR-7/7a: start on first *engagement* event (not file-open) + strip idle gaps → **active reading time**, not wall-clock. Still secondary, crossed-only (FR-9). If even engaged-time proves untrustworthy, M3 ships disabled and M1/M2 stand alone. |
| R8 | **Engagement-as-comprehension creep.** Scroll/click telemetry gets promoted to a "did they read it" score; scroll-to-bottom games it. | Med · High | FR-7b + INV-Outcome-over-proxy: engagement only *subtracts idle* from M3, never a standalone verdict; T0 test forbids a scroll/time verdict path. |

## Dependencies

- **`depends_on: DR-012`** — the approval gate + [`approval.ts`](../../../packages/minspec/src/lib/approval.ts)
  is the baseline event and the data model FR-1/FR-7 extend (hash → hash+snapshot+reviewStart).
- **`relates_to: SPEC-015`** — `superseded` must join [`SPEC_STATUSES`](../../../packages/minspec/src/lib/spec.ts#L14)
  and the status→lane map; SPEC-015 INV-1 (T0) makes that addition forcing, not optional.
- **`relates_to: SPEC-014`** — SPEC-014 is `specifying` (not built), so the chart ships in
  the existing spec-panel now (FR-OQ1 resolved), not in the review pane. When SPEC-014 lands
  it becomes a richer engagement source (full-DOM scroll/focus, FR-7a) and a second mount
  point — FR-12's host-agnostic render allows it. This spec assumes none of SPEC-014's code.

## Out of scope

- **The blocking enforcement / gate itself** — DR-012's PreToolUse approval gate is
  unchanged; this is a *measurement* surface over it, not a new enforcement primitive.
- **Cross-repo / aggregate trust reporting** (e.g. trust over ScroogeLLM or org-wide) —
  single-repo, local-only here.
- **Choosing what "good" rework % is** — the dashboard reports the number and the pairing;
  it does not set or enforce a target threshold (a threshold would re-introduce the proxy
  trap at the rework axis).
- **A two-sided diff review UI** — that is SPEC-014's highlight-changes job (its FR-7); this
  spec consumes the *quantity* of change, not a per-hunk review surface.

## Clarify

Clarify session 2026-06-04. All six open questions resolved — three by the user
(product-level), three by engineering default (recomputability / least-surprise). No
question remains blocking Plan.

| OQ | Decision | By | Lands in |
|---|---|---|---|
| **FR-OQ1 — chart host** | **New section in the existing `spec-panel` webview.** Ships independent of the unbuilt SPEC-014; FR-12 keeps render host-agnostic so it can *also* mount in the review pane later. | user | FR-10 |
| **FR-OQ2 — char-delta algorithm** | **Char-level diff over the body** (vendored, no-network — e.g. `diff-match-patch` char mode or `diff`), rework % = changed chars ÷ `max(approvedChars, currentChars)`. Deterministic, recomputable from files. *Line-count proxy rejected — it isn't a true char %.* | eng default | FR-2 |
| **FR-OQ3 — superseded accounting** | **Separate "wasted review" bar**, NOT folded into the M1 denominator — supersession (100% thrown away) is a distinct failure from edit-churn. | user | FR-6 |
| **FR-OQ4 — snapshot storage + retention** | **Latest-approved body only**, gzip-compressed, in a **git-ignored** `.minspec/snapshots/` sidecar; rework datapoints appended to a small numeric history (`{approvedAt, reworkPct, engagedMs}`) so the *trend* survives without storing every body. Bounds R3 (no per-round body history). | eng default | FR-1, gates R3 |
| **FR-OQ5 — body/frontmatter boundary** | **Strip frontmatter by the existing `parseSpec` split**, diff the body only. No new two-zone delimiter / `coreHash` needed — the parser already separates frontmatter. | eng default | FR-4 |
| **FR-OQ6 — review-start + engagement** | **Start on first engagement event** (focus / first visible-range change), not file-open; M3 duration = **engaged reading time**, idle gaps > threshold stripped (FR-7a). Engagement (scroll/focus) is sampled — webview DOM fully, plain editor via `onDidChangeTextEditorVisibleRanges`/`Selection`/`ActiveTextEditor` — **only to denoise time**, never a comprehension verdict (FR-7b). Opt-in, content-free (FR-8). | user | FR-7, FR-7a, FR-7b |

**Engagement-tracking question (this session) — resolved:** *Yes*, scroll/click engagement
is trackable (webview: full; plain editor: scroll + cursor + focus, no mouse-move/gaze).
Its **only** sanctioned role is subtracting idle time from M3 so "tab open at lunch" stops
counting as reading. It does **not** become an engagement/comprehension score —
scroll-to-bottom would game it, the same trap as the rejected "<5min ⇒ skimmed" note
(§The proxy trap). Bound by INV — Outcome over proxy + new risk R8.

**Plan-phase details (not blocking):** exact idle threshold for FR-7a (~60s lean);
diff library choice (FR-OQ2 shortlist); scatter bucketing for sparse data.

## Follow-ups (tracked)

- **`superseded` status + `superseded-by` field across spec parser, validator, and SPEC-015
  lane map (FR-5).** Cross-spec data-model change beyond this spec's dashboard FRs → file a
  SPEC-015 amendment / `harvest316/minspec` issue before implementation.
- **Approval-store schema migration (FR-1/FR-7).** `approvals.json` gains fields; needs a
  back-compat read path (old records lack snapshot/reviewStart) → tracked at implement, T3
  regression test for the migration.
- **SPEC-018 Spec Custom Editor** — the scoped, opt-in webview editor that opens specs in
  MinSpec's surface (richer engagement source for FR-7a). Separate surface concern, its own
  spec → [SPEC-018](../spec-custom-editor/requirements.md). M3 must not depend on it.
- **Marketing / site copy** — "measure how much you're rubber-stamping" is a sharp
  positioning line (ties to the just-enough-human thesis). Non-code, never enters SDD →
  file a `harvest316/minspec` issue (or AIClarity site) per DR-023 forward rule. `None`
  only if the team declines the angle.
