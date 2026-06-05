---
id: SPEC-018
type: requirements
status: specifying
tier: T3
product: minspec
epic: EPIC-002  # Signpost Integrity
aspects: [ux]
depends_on: [SPEC-014]
relates_to: [SPEC-017, DR-012]
---

# MinSpec — Spec Custom Editor (webview-default routing) (Requirements)

**Date:** 2026-06-04
**Status:** Specifying (SDD Specify phase)
**Triggered by:** session request (SPEC-017 clarify) — "the webview gives better
[engagement] tracking, so default to webview for all operations: click targets from any
MinSpec explorer pane, and hook Ctrl-P to open .md files in our webview."
**Scoped decision (this session):** own-tree-click routing **+ a scoped, opt-in custom
editor for spec paths only** — *not* a global Ctrl-P / all-markdown hijack (rejected, see
§What this is NOT).
**Composes:** [SPEC-014](../SPEC-014-review-webview/requirements.md) renderer (one render function,
reused — DRY) + [DR-012](../../../docs/decisions/DR-012.md) approval gate.
**Epic:** [EPIC-002 Signpost Integrity](../../../docs/epics/EPIC-002-signpost-integrity.md).
**Serves:** [SPEC-017 Trust Dashboard](../SPEC-017-trust-dashboard/requirements.md) FR-7a as the
*richest* engagement source — but SPEC-017 must work without it.

---

## Context

Specs are `.md` files; today they open in VS Code's default text editor. SPEC-017's
engagement-denoised time metric (FR-7a) is richer when the human reads a spec **inside a
webview** MinSpec owns (full-DOM scroll/focus/dwell) than in the plain editor (only
`onDidChangeTextEditorVisibleRanges` / `Selection` / `ActiveTextEditor`). The session asked
to therefore "default to the webview for all operations."

Two mechanisms were proposed; only one is real:

- **Hooking Ctrl-P** to redirect `.md` opens — **not possible.** VS Code Quick Open exposes
  no interception API; an extension cannot reroute "open this file" from the Quick Open path.
- **A custom editor** (`customEditors` contribution) — the *only* API that makes a file open
  in an extension-owned webview by any path (tree click, Ctrl-P, explorer). This spec uses
  that, **scoped to spec paths and opt-in**, to deliver the intent without the hijack.

The premise also needs a guardrail: this routing serves **only M3** (SPEC-017's secondary,
opt-in correlate). **M1** (char rework %, the ground truth) diffs files and needs no webview
(SPEC-017 FR-3). So this feature is a *nice-to-have engagement source + review ergonomics*,
never load-bearing for the trust metrics — reflected in INV — Metrics-independent below.

## What this is NOT (rejected this session)

- **No global markdown hijack.** Registration MUST NOT target `**/*.md`. Owning every
  README/note in the workspace replaces the user's editor wholesale — the exact intrusive
  over-reach the "just enough human" thesis sells against.
- **No forced default.** The editor MUST NOT seize specs as the unavoidable default with no
  easy way back to text (no `priority:"default"` with no escape).
- **No Ctrl-P keybinding hook.** Routing is achieved by the custom-editor registration, not
  by intercepting the Quick Open keystroke (which has no API). Documented so no one tries.
- **No telemetry coupling.** The editor existing does NOT mean reading-time capture is on;
  capture stays its own SPEC-017 FR-8 opt-in (INV — Metrics-independent).

## Requirements

### Routing into MinSpec's surface

- **FR-1 (tree-click → webview, with a text escape).** Clicking a spec in MinSpec's own
  tree view ([`spec-tree-provider.ts`](../../../packages/minspec/src/views/spec-tree-provider.ts))
  MUST open it in the MinSpec webview editor (FR-2), and MUST always offer a one-click
  "Open as plain text" affordance. A setting MUST let the user revert tree-clicks to the
  plain text editor.
- **FR-2 (scoped custom-editor registration).** MinSpec MUST register a `customEditors`
  contribution whose selector matches **spec paths only** (e.g. `**/specs/**/*.md`; ADRs
  under `docs/decisions/**` are FR-OQ3), never all markdown. The `viewType` is a stable
  public contract once shipped (Costly #1).
- **FR-3 (opt-in priority — `option`, not `default`).** The custom editor MUST ship with
  `priority: "option"`: it appears in "Reopen Editor With…" but does NOT become the default
  for specs unless the user opts in via a setting (`minspec.specEditor.useByDefault`, default
  **off**). This makes "specs always open in our webview" a deliberate choice, satisfying
  least-surprise and SPEC-017's opt-in posture. Even when default-on, FR-5 escape holds.

### Don't strand the editor

- **FR-4 (editing preserved — `CustomTextEditorProvider`, not a replacement editor).** The
  custom editor MUST be a `CustomTextEditorProvider` backed by the real `TextDocument`, so
  **save, undo/redo, find, git gutter, the frontmatter validator, and the RCDD/commit hooks
  keep working** on the underlying file. A read-only viewer that strips editing is NOT
  acceptable as the *default* path (it would make specs un-editable in place). If full
  in-webview editing parity proves infeasible at plan (FR-OQ1), the fallback is **viewer +
  always-adjacent text editor**, never a strand.
- **FR-5 (always-available escape hatch).** From the webview editor the user MUST be able to
  reach the raw text in one action ("Open as plain text" / standard "Reopen Editor With"),
  always — regardless of FR-3 default state. The native `workbench.action.reopenWithEditor`
  MUST continue to work.

### Reuse + boundary

- **FR-6 (one renderer — reuse SPEC-014, no second markdown path).** The editor MUST mount
  the **same pure render function** SPEC-014 defines (its FR-1/FR-16) / SPEC-017 FR-12 — no
  duplicate markdown renderer/sanitiser. Same CSP-nonce, same Tier-0 sanitisation.
- **FR-7 (engagement source for SPEC-017, gated by *its* opt-in).** When SPEC-017 FR-8
  telemetry is ON, this editor MUST emit the richer full-DOM scroll/focus/dwell events feeding
  SPEC-017 FR-7a. When OFF, it captures nothing. The editor's usefulness (reading/reviewing)
  MUST NOT depend on telemetry being on.
- **FR-8 (Tier-0 — inherited).** The editor adds no `http`/`https`/`fetch`/`net` import to
  `packages/minspec` (SPEC-014 FR-17 / invariant #2 / DR-004). Import-ban T0 test.

## Costly to Refactor

*Expensive-to-reverse commitments, ranked most→least.*

1. **`customEditors` `viewType` + selector glob (FR-2).** A public-ish contract: once users
   associate specs with this editor (and `Reopen With` remembers it), changing the viewType
   or narrowing the glob churns their settings + muscle memory. *Check: viewType name + glob
   scope fixed before first release.*
2. **Edit vs viewer decision (FR-4, FR-OQ1).** Shipping a read-only viewer then later adding
   editing = a near-rewrite of the webview's interaction layer. *Check: edit-parity feasibility
   settled at plan, before any release sets expectations.*
3. **Priority/default posture (FR-3).** Shipping `priority:"default"` then retreating to
   `option` (or vice-versa) re-trains users and may strand `Reopen With` associations.
   *Check: `option` + opt-in-setting posture confirmed before release.*

## Invariants (must hold)

- **INV — No global hijack (T0).** The `customEditors` selector targets spec (and opt
  ADR) paths only, never `**/*.md`. A test asserts the contributed glob is path-scoped.
- **INV — Reversible / never stranded (T0).** A raw-text path is always one action away
  (FR-5); the user can always edit a spec as text. No configuration removes the escape.
- **INV — Metrics-independent (T0).** SPEC-017's M1/M2 (and M3's existence) do **not** depend
  on this editor; with this feature disabled, the Trust Dashboard still computes. This editor
  only *enriches* M3's engagement source (FR-7). A test asserts the metric layer has no hard
  dependency on the custom-editor module.
- **INV — One renderer (T0).** No second markdown render/sanitise path; SPEC-014's pure
  function is reused (FR-6). Tier-0 sanitisation preserved.
- **INV — Tier-0 core (T0).** No networking import added (FR-8).

## Acceptance Criteria

*Definition-of-done; each traces an FR / INV. Zone A — read before approving.*

- [ ] **AC-1 (FR-2 / INV-No-global-hijack).** The `customEditors` contribution's
  `selector` glob is path-scoped to specs (e.g. `**/specs/**/*.md`) and is **never**
  `**/*.md`; the T0 glob-scope test asserts this and fails on a global pattern.
- [ ] **AC-2 (FR-1).** Clicking a spec in
  [`spec-tree-provider.ts`](../../../packages/minspec/src/views/spec-tree-provider.ts)
  opens it in the MinSpec webview editor, and a one-click "Open as plain text"
  affordance is visible from that editor.
- [ ] **AC-3 (FR-3).** The contribution ships `priority: "option"`; with
  `minspec.specEditor.useByDefault` at its default (**off**), opening a spec by any
  path still uses the native text editor, and the webview is reachable only via
  "Reopen Editor With…".
- [ ] **AC-4 (FR-4).** Inside the webview editor, save, undo/redo, find, git gutter,
  the frontmatter validator, and the RCDD/commit hooks all act on the underlying
  `TextDocument` (T1 tests for save/undo/validator pass); the provider is a
  `CustomTextEditorProvider`, not a replacement editor.
- [ ] **AC-5 (FR-5 / INV-Reversible).** From the webview editor the raw text is
  reachable in one action regardless of FR-3 state; `workbench.action.reopenWithEditor`
  still works. No setting removes this escape.
- [ ] **AC-6 (FR-6 / INV-One-renderer).** The editor mounts SPEC-014's pure render
  function (SPEC-014 FR-1/FR-16); no second markdown renderer or sanitiser is introduced;
  same CSP-nonce and Tier-0 sanitisation.
- [ ] **AC-7 (FR-7 / INV-Metrics-independent).** With SPEC-017 FR-8 telemetry OFF the
  editor captures nothing and remains fully usable for reading/reviewing; the metric
  layer has no hard import of the custom-editor module (T0 dependency-direction test).
- [ ] **AC-8 (FR-8 / INV-Tier-0).** No `http`/`https`/`fetch`/`net` import is added to
  `packages/minspec`; the import-ban T0 test passes.

## Coverage Map (session ask → FR)

| Concern (from session) | FR |
|---|---|
| click targets from MinSpec explorer pane → webview | FR-1 |
| "hook Ctrl-P to open .md in our webview" | FR-2 (custom editor — the real mechanism) + §What this is NOT (no Ctrl-P hook) |
| "default to webview for all operations" | FR-2/FR-3 (scoped + opt-in), bounded by INV-No-global-hijack |
| better engagement tracking (motivation) | FR-7 (gated by SPEC-017 FR-8) |
| don't lose normal editing | FR-4, FR-5 |
| don't re-implement rendering | FR-6 |

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|---|---|---|
| R1 | **Fights other markdown extensions for specs.** Markdown All-in-One / preview / linters lose their grip on spec files. | Med · Med | `priority:"option"` (FR-3) so default behaviour is unchanged until opt-in; scoped glob; FR-5 escape. |
| R2 | **Editing regressions.** find/replace, LSP, git gutter, validator break inside a custom editor. | Med · High | FR-4 `CustomTextEditorProvider` over the real `TextDocument`; T1 tests for save/undo/validator; viewer-fallback never the default. |
| R3 | **Hijack/surprise perception.** Users feel MinSpec seized their editor → marketplace backlash. | Med · High | INV-No-global-hijack + FR-3 opt-in default-off + FR-5 escape + scoped glob. Never `**/*.md`, never silent default. |
| R4 | **Telemetry-coupling confusion.** "Webview editor = I'm being watched." | Med · Med | INV-Metrics-independent + FR-7: editor works fully with telemetry OFF; capture is SPEC-017 FR-8's separate, visible opt-in. |
| R5 | **FR-1 mount of SPEC-014's renderer (FR-6) is slower than the native editor on a large spec** — the reused render function builds full DOM where the text editor virtualises lines for free. | Low · Med | No FR mandates virtualised render today; the committed mitigation is FR-5's text path used as a size-triggered fallback (Failure-Modes "Large spec performance"), with the byte/line threshold set at plan. Whether FR-6's renderer itself must virtualise is an FR-OQ1-adjacent plan call, not assumed here. |

## Dependencies

- **`depends_on: SPEC-014`** — reuses its renderer/sanitiser and CSP-nonce pattern (FR-6).
  SPEC-014 is `specifying` (not built); this spec's render layer cannot ship before that
  render function exists, so sequencing: SPEC-014 render → SPEC-018 editor wrapper.
- **`relates_to: SPEC-017`** — provides FR-7a's richest engagement source; the relationship
  is *enrich-only* (INV-Metrics-independent), never a hard dependency in either direction.

## Assumptions

- VS Code's `CustomTextEditorProvider` API can back a webview with the real `TextDocument`
  so save/undo/find/git-gutter keep working (FR-4); FR-OQ1 exists precisely because this
  edit-parity assumption is *not yet proven* and may force the viewer-fallback.
- SPEC-014's render function will be extracted as a reusable pure function (FR-6) before
  this editor needs to mount it — the sequencing assumption recorded in Dependencies and
  Follow-ups (SPEC-014 is `specifying`, not built).
- Specs live under a `**/specs/**/*.md`-shaped path so a path-scoped glob (FR-2) can
  select them without touching other markdown (INV-No-global-hijack).
- The richer full-DOM scroll/focus/dwell signal (FR-7) is only ever consumed by SPEC-017's
  M3 (opt-in correlate), never by M1/M2 — so disabling this editor cannot break trust metrics.

## Test-thought

Verified by: (1) a T0 test asserting the contributed `customEditors` selector is
path-scoped and not `**/*.md` (INV-No-global-hijack, FR-2); (2) a T0 test asserting the
SPEC-017 metric layer has no import of the custom-editor module (INV-Metrics-independent);
(3) T1 tests that save/undo/validator still operate on the `TextDocument` through the
`CustomTextEditorProvider` (FR-4); and (4) the inherited import-ban T0 test for FR-8.

## Consequences

**Positive:**
- Delivers the session's "default to webview for all operations" intent via the only real
  mechanism (`customEditors`, FR-2) without the rejected Ctrl-P/global-markdown hijack.
- Reuses SPEC-014's single renderer (FR-6) — no duplicate markdown/sanitise path to drift.
- Gives SPEC-017 FR-7a its richest engagement source (FR-7) while staying enrich-only.

**Negative:**
- Adds a public-ish `viewType` + selector-glob contract (FR-2, Costly #1) that is expensive
  to rename or rescope once users' `Reopen With` associations remember it.
- Introduces editing-regression surface (FR-4, R2): find/replace, LSP, git gutter, and the
  validator must be re-proven to work inside a custom editor rather than the native one.
- Couples this spec's render layer to SPEC-014's still-unbuilt render function (Dependencies),
  so it cannot ship ahead of SPEC-014.

## Failure-Modes / Edge-Cases

- **Edit-parity infeasible at plan (FR-OQ1 resolves "no").** If `CustomTextEditorProvider`
  cannot give acceptable in-webview editing, FR-4's fallback (viewer + always-adjacent text
  editor) engages — must never strand the spec as un-editable.
- **Large spec performance (R5).** A very large spec makes FR-1's mount of SPEC-014's
  full-DOM renderer (FR-6) degrade vs the line-virtualising native editor; the FR-5 text
  path is reused as a size-triggered fallback, with the threshold set at plan.
- **Competing markdown extension on a spec path (R1).** Markdown All-in-One / linters lose
  their grip on spec files; mitigated because `priority:"option"` (FR-3) leaves default
  behaviour unchanged until the user opts in.
- **User opts FR-3 default-on then wants out.** The FR-5 escape (`reopenWithEditor`) MUST
  still reach raw text even when `useByDefault` is on (INV-Reversible).
- **Telemetry OFF.** Editor emits nothing (FR-7) and remains fully usable for reading —
  reviewing must not silently depend on capture being on (INV-Metrics-independent).
- **ADR paths (FR-OQ3).** Until the glob is widened to `docs/decisions/**`, opening an ADR
  uses the native editor by design — not a bug.

## Test / Verification Strategy

| FR | Tier | Assertion sketch |
|---|---|---|
| FR-1 | T2 | Clicking a node in `spec-tree-provider.ts` opens the webview editor and a visible "Open as plain text" affordance; the revert setting restores plain-text open. |
| FR-2 | T0 | The contributed `customEditors` selector glob is path-scoped (matches a `specs/**` path, rejects a top-level `README.md`); never equals `**/*.md`. |
| FR-3 | T2 | With `minspec.specEditor.useByDefault` off, a spec opens in the native editor; the webview appears in "Reopen Editor With…"; flipping the setting makes it default while FR-5 still holds. |
| FR-4 | T1 | Through the `CustomTextEditorProvider`, save / undo-redo / find / frontmatter-validator each operate on the backing `TextDocument` and produce identical results to the native editor. |
| FR-5 | T1 | `workbench.action.reopenWithEditor` from the webview yields the raw text editor regardless of FR-3 state; no config disables it. |
| FR-6 | T0 | Only SPEC-014's pure render function is imported; a test asserts no second markdown renderer/sanitiser symbol exists in this module; CSP-nonce present. |
| FR-7 | T1 | With SPEC-017 FR-8 ON the editor emits scroll/focus/dwell events; with it OFF zero capture calls fire and the editor still renders. |
| FR-8 | T0 | Import-ban test: no `http`/`https`/`fetch`/`net` import reachable from `packages/minspec` via this editor (SPEC-014 FR-17 / invariant #2 / DR-004). |

## Alternatives Considered

- **Hook Ctrl-P / Quick Open to reroute `.md` opens** — rejected: VS Code Quick Open exposes
  no interception API (§What this is NOT); the intent is unachievable this way.
- **Global markdown custom editor (`**/*.md`)** — rejected: owning every README/note is the
  intrusive over-reach the "just enough human" thesis sells against (INV-No-global-hijack).
- **Read-only webview viewer** — rejected as the *default* path: it strips save/undo/find and
  makes specs un-editable in place (FR-4); only acceptable as the FR-OQ1 fallback with an
  always-adjacent text editor.
- **Ship `priority:"default"` immediately** — rejected: seizing specs as the unavoidable
  default re-trains users and may strand `Reopen With` (Costly #3); FR-3 ships `option` + an
  opt-in setting instead.

## Out of scope

- **The review/comment/approve loop** — that is SPEC-014 (this editor may host it, but the
  loop is defined there).
- **The trust metrics themselves** — SPEC-017.
- **Any non-spec markdown** — README/notes/etc. are explicitly untouched (INV-No-global-hijack).
- **Intercepting Quick Open / keybindings** — no such API; not attempted.

## Open questions

- **FR-OQ1 — edit parity vs viewer-fallback.** Can a `CustomTextEditorProvider` give
  acceptable in-webview *editing* (or is the webview a rich *viewer* with edits round-tripped
  to the text doc / "edit as text" for heavy edits)? Determines FR-4's shape. *(Open — plan;
  Costly #2.)*
- **FR-OQ2 — default posture offered at all?** Ship only `priority:"option"` (user picks
  Reopen With per-file), or also offer the `useByDefault` setting (FR-3)? Lean: option-only
  for v1, add the setting once edit-parity (FR-OQ1) is proven. *(Open — plan.)*
- **FR-OQ3 — scope: specs only, or ADRs too?** Extend the glob to `docs/decisions/**`
  (ADRs are also reviewed docs) or keep to `specs/**` for v1? Widening later is cheap;
  start narrow. *(Open — plan.)*

## Follow-ups (tracked)

- **SPEC-014 render function must be extracted as the shared pure renderer** (FR-6) before
  this editor can mount it — sequencing note for SPEC-014's plan; not a new issue (same epic).
- **`minspec.specEditor.*` settings** (FR-1 revert, FR-3 useByDefault) — contributed config;
  lands at implement with the contribution, no separate issue.
- **Marketplace listing note** — a custom editor for specs is a listing capability/keyword;
  non-code, → `harvest316/minspec` issue per DR-023 forward rule if the team wants it surfaced.
