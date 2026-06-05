---
id: SPEC-017
type: requirements
status: specifying
tier: T4
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
**Relates:** [SPEC-014 Review Webview](../SPEC-014-review-webview/requirements.md) (its **R6
approve-chain fatigue → rubber-stamping** risk is exactly what this measures; candidate
host for the chart), [SPEC-015 Status Lanes](../SPEC-015-status-lanes/requirements.md) (the
`superseded` lane Metric 2 needs), [SPEC-004 Classifier Validation](../SPEC-004-classifier-validation/requirements.md)
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
**exact failure mode** MinSpec already diagnosed in [SPEC-004](../SPEC-004-classifier-validation/requirements.md):
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
  source is [SPEC-018](../SPEC-018-spec-custom-editor/requirements.md) (specs opened in MinSpec's own
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

## Acceptance Criteria

*Definition-of-done; each item traces an FR/INV. Zone A — read before approving.*

- [ ] **AC-1 (FR-1).** On approval, `ApprovalRecord` persists a gzipped latest-approved body
  snapshot + a `reviewStart` timestamp into git-ignored `.minspec/snapshots/`; an old
  `approvals.json` record lacking these fields still reads (back-compat path, per Follow-ups).
- [ ] **AC-2 (FR-2, FR-4).** Rework % for a spec = changed chars ÷ `max(approvedChars,
  currentChars)` over the **body** (frontmatter stripped via `parseSpec`); recomputing it
  twice from the same files yields the identical number (INV — Deterministic).
- [ ] **AC-3 (FR-3).** A manual editor edit, an agent on-disk edit, and a (future) SPEC-014
  in-webview edit each move M1 identically for the same char delta — no surface is
  instrumented; the file is the source of truth.
- [ ] **AC-4 (FR-5).** `superseded` is a member of [`SPEC_STATUSES`](../../../packages/minspec/src/lib/spec.ts#L14)
  with a `superseded-by: SPEC-NNN` field, and SPEC-015's total-coverage T0 lane test passes
  (the status→lane map is updated, not left partial).
- [ ] **AC-5 (FR-6).** A superseded spec's previously-approved chars render as a **separate
  "wasted review" bar**, never summed into the M1 denominator.
- [ ] **AC-6 (FR-7, FR-7a, INV — Outcome over proxy).** M3 duration is engaged reading time
  (first-engagement start, idle gaps > threshold stripped), not `approvedAt − reviewStart`;
  no code path writes a time- or scroll-threshold "skimmed" flag to a spec or fires such a
  warning (T0 test green).
- [ ] **AC-7 (FR-8, INV — Consensual human telemetry).** With the opt-in toggle **off**, M3
  and all engagement sampling are absent and M1/M2 still compute; when on, the state is
  UI-visible and only timestamps + scroll/focus positions (no content) are stored.
- [ ] **AC-8 (FR-9).** The dashboard shows M3 only as an engaged-time × later-rework scatter;
  there is no time-only badge, note, or warning anywhere in the surface.
- [ ] **AC-9 (FR-10, FR-11, FR-12, INV — Tier-0 core / Non-destructive).** The chart renders
  in the existing spec-panel webview via inline SVG / vendored no-fetch renderer reusing the
  CSP-nonce pattern; `packages/minspec` gains no `http`/`https`/`fetch`/`net` import (T0
  import-ban green); opening the dashboard mutates no spec body and invalidates no approval.

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

## Assumptions

- **A1.** [`approval.ts`](../../../packages/minspec/src/lib/approval.ts) (DR-012) remains the
  single approval-write path, so FR-1's snapshot + FR-7's `reviewStart` can be persisted at
  exactly one site; if approvals are ever written elsewhere, the snapshot would be missed.
- **A2.** `parseSpec` reliably splits frontmatter from body (FR-4 leans on it for the diff
  boundary); no separate `coreHash` / two-zone delimiter exists or is needed.
- **A3.** A char-level diff over a single spec body is cheap enough to recompute on demand
  (FR-2 / INV — Deterministic) — no persisted event log; numbers derive from files + the
  approval store each render.
- **A4.** `.minspec/snapshots/` can be git-ignored without losing the trust trend, because the
  numeric history (`{approvedAt, reworkPct, engagedMs}`, FR-OQ4) carries the trend, not the
  bodies (gates R3).

## Test-thought

M1/M2 are pure functions of files-on-disk + the approval store (INV — Deterministic, FR-12),
so verification is fixture-snapshot unit tests: feed an approved-body snapshot + a later body,
assert the exact rework % (FR-2) and the separate wasted-review figure (FR-6); the proxy-trap
ban (INV — Outcome over proxy) is verified by a T0 test asserting no code path emits a
time/scroll-threshold verdict (FR-9), and the Tier-0 guarantee by the import-ban T0 test
(INV — Tier-0 core, mirroring SPEC-014 FR-17).

## Consequences

**Positive:**
- Makes the standing-but-unmeasured **rubber-stamping** risk (SPEC-014 R6) an *observable
  outcome* (M1/M2 ground truth) rather than an accusation — "measurement is the moat" (Context)
  becomes a shippable differentiator.
- Brings specs to status parity with ADRs by adding `superseded` (FR-5), and the SPEC-015 INV-1
  total-coverage T0 turns that addition into a *forced* lane-mapping decision — a gate, not a gap.
- Lands MinSpec's **first chart** (FR-10) as a reusable, host-agnostic pure render (FR-12) that a
  later SPEC-014 review pane can mount with a re-wire, not a rewrite.

**Negative:**
- Grows the `ApprovalRecord` data model and the on-disk `.minspec/` footprint (snapshots +
  numeric history), forcing an `approvals.json` back-compat migration (Follow-ups; Costly #1, #4).
- Adds human-timing telemetry (M3) — even opt-in and content-free (FR-8), it carries a
  surveillance-smell cost (R4) the copy and consent UI must continuously manage.
- The `superseded` enum addition ripples beyond this dashboard into the spec parser, validator,
  and SPEC-015 lane map (Costly #2, Follow-ups) — blast radius wider than the chart itself.

## Failure-Modes / Edge-Cases

- **First-ever approval (no prior snapshot).** FR-2's baseline doesn't exist yet → rework % must
  be defined as 0% / "no prior review" for the first approval, not a divide-by-zero or 100%.
- **`max(approvedChars, currentChars) = 0` (empty body).** A spec whose body is empty must not
  throw in the FR-2 denominator; treat as 0% rework.
- **Legacy `approvals.json` record lacking snapshot/reviewStart (FR-1/FR-7).** The back-compat
  read path (Follow-ups) must yield "no M1/M3 datapoint for this record," never crash the render.
- **Opt-in toggle flipped off mid-review (FR-8).** Engagement sampling stops immediately and any
  partial M3 timing for that artifact is discarded — M1/M2 still compute (INV — Consensual).
- **Spec superseded *before* it was ever approved (FR-6).** Zero previously-approved chars → it
  contributes nothing to the wasted-review bar (no negative / phantom waste).
- **Re-approval with identical body.** Char delta = 0 ⇒ M1 = 0% for that round; not counted as
  "reworked" (FR-2 diffs content, not the approve event).
- **No distinct concurrency edge** — the dashboard is single-repo, read-only over local files
  (FR-11, Out-of-scope cross-repo); accepted because there is no multi-writer surface.

## Test / Verification Strategy

*Per-FR test tier (T0 invariant · T1 contract · T2 feature · T3 regression) + assertion sketch.*

- **FR-1 — T1/T3.** Approve a fixture spec → assert `ApprovalRecord` now carries a gzipped body
  snapshot + `reviewStart`; T3 regression: a pre-migration `approvals.json` record still reads.
- **FR-2, FR-4 — T1.** Snapshot "abcde" vs later "abXde" → assert rework % = 1/5 over body only;
  flip only frontmatter `status:` → assert 0% (frontmatter excluded).
- **FR-3 — T2.** Apply the same char delta via (a) editor edit and (b) on-disk agent edit →
  assert identical M1 (no surface instrumented).
- **FR-5 — T0 (binds SPEC-015 INV-1).** `superseded ∈ SPEC_STATUSES` and the status→lane map is
  total/disjoint — the SPEC-015 coverage test fails if the lane is unmapped.
- **FR-6 — T1.** Supersede an approved fixture → assert its approved chars appear in the separate
  wasted-review figure and are NOT in the M1 denominator.
- **FR-7, FR-7a — T2.** Simulate engagement events with a > idle-threshold gap → assert engaged
  time excludes the gap (≠ wall-clock); start fires on first engagement, not file-open.
- **FR-7b, FR-9 — T0 (INV — Outcome over proxy).** Assert no code path writes a time/scroll
  "skimmed" flag or warning, and M3 surfaces only as the engaged-time × rework scatter.
- **FR-8 — T0 (INV — Consensual).** Toggle off ⇒ no engagement sampling, no stored timestamps,
  M1/M2 intact; stored payload contains positions/timestamps only, never text.
- **FR-10 — T0 (INV — Tier-0 core).** Import-ban test: no `http`/`https`/`fetch`/`net` import in
  `packages/minspec` (mirrors SPEC-014 FR-17).
- **FR-11 — T0 (INV — Non-destructive).** Render the dashboard over a fixture → assert spec bytes
  and content hash are byte-identical before/after (no approval invalidated).
- **FR-12 — T1.** Call metric + chart-markup functions with no `vscode` stub present → assert they
  return numbers/SVG (pure, network-free).

## Alternatives Considered

- **Line-count rework proxy (instead of char-level diff, FR-2).** Rejected at FR-OQ2: line counts
  aren't a true char % and would mis-measure dense prose edits — the same "rigorous-looking, wrong
  thing" failure as SPEC-004's diff-size classifier (§The proxy trap).
- **Standalone time-only "skimmed" verdict (the user's first instinct, "<5min ⇒ skimmed").**
  Rejected by §The proxy trap, INV — Outcome over proxy, and FR-9: a bare time threshold fires
  false accusations on co-authored / good-fast approvals and destroys trust in the trust tool.
- **Store full approved body per spec per approval round (for richer history).** Rejected at
  FR-OQ4 (R3): duplicates the repo many times over; latest-approved gzipped body + numeric trend
  history keeps the signal at a fraction of the storage.
- **Persist snapshot/timestamps into the spec frontmatter (simplest to find).** Rejected by INV —
  Non-destructive + FR-11/R6: writing into the file changes its hash → marks the approval stale;
  all state lives in the `.minspec/` sidecar instead.
- **Mount the chart in the SPEC-014 review webview.** Rejected at FR-OQ1: SPEC-014 is `specifying`
  (unbuilt), so the dashboard ships now in the existing spec-panel; FR-12's host-agnostic render
  keeps the review-pane mount open as a later re-wire.

## Dependencies & Blast-Radius

*Augments the Dependencies section above with what breaks if each changes (T4).*

- **[`approval.ts`](../../../packages/minspec/src/lib/approval.ts) / `ApprovalRecord` (FR-1, FR-7;
  DR-012).** The data model M1/M3 extend. *Breaks if changed:* every approve-write and read, plus
  an `approvals.json` migration (Costly #1, Follow-ups) — the back-compat read path must hold.
- **[`SPEC_STATUSES`](../../../packages/minspec/src/lib/spec.ts#L14) + SPEC-015 lane map (FR-5).**
  *Breaks if changed:* SPEC-015's INV-1 total-coverage T0 test goes red until the new lane is
  mapped, and the spec validator + every superseded spec's frontmatter must agree (Costly #2).
- **[`spec-panel-html.ts`](../../../packages/minspec/src/views/spec-panel-html.ts) CSP-nonce
  render (FR-10).** *Breaks if changed:* the inline-SVG chart's nonce wiring; a regression here can
  silently fail the chart or, worse, admit a network import (violating INV — Tier-0 core).
- **`parseSpec` frontmatter split (FR-4).** *Breaks if changed:* the M1 body boundary — a change to
  what counts as "body" silently shifts *every historical rework number* (Costly #3).
- **`.minspec/snapshots/` location + numeric-history schema (FR-OQ4).** *Breaks if changed:*
  re-snapshot or lose the trust trend; the gitignore entry must land with the first write (Costly
  #4).
- **SPEC-018 Spec Custom Editor (engagement source for FR-7a).** *Soft* dependency only — M3 must
  work via the plain-editor fallback; SPEC-018 being absent must NOT break the dashboard (FR-7a).

## Rollback / Reversibility

- **Undo mechanism.** M3 is the riskiest surface and is independently reversible: the FR-8 opt-in
  toggle off ⇒ M3 + all engagement sampling vanish, M1/M2 stand alone (R7 fallback: "M3 ships
  disabled, M1/M2 stand"). The whole dashboard is a read-only spec-panel section (FR-11) — removing
  the section reverts the UI with no spec-file or hash changes (INV — Non-destructive).
- **Hard-to-reverse residue.** Two changes outlive a UI rollback and are the reason this is **not**
  freely reversible: (1) the `ApprovalRecord` schema + persisted `.minspec/snapshots/` (Costly #1,
  #4) — rolling back means a reverse migration of `approvals.json`; (2) the `superseded` enum +
  any spec frontmatter that adopted `superseded-by:` (Costly #2) — reverting the grammar means
  re-editing every superseded spec and the SPEC-015 lane map.
- **ADR-filter answer.** *Not* undoable in <1 day — the cross-spec `superseded` contract and the
  approval-store schema/migration carry it past the DR threshold. Rationale already lives in
  `depends_on: DR-012`; the `superseded` contract and migration are materialized as the first two
  items under **Follow-ups (tracked)**.

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
  spec → [SPEC-018](../SPEC-018-spec-custom-editor/requirements.md). M3 must not depend on it.
- **Marketing / site copy** — "measure how much you're rubber-stamping" is a sharp
  positioning line (ties to the just-enough-human thesis). Non-code, never enters SDD →
  file a `harvest316/minspec` issue (or AIClarity site) per DR-023 forward rule. `None`
  only if the team declines the angle.
