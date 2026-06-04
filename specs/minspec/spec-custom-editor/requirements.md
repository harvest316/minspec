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
**Composes:** [SPEC-014](../review-webview/requirements.md) renderer (one render function,
reused — DRY) + [DR-012](../../../docs/decisions/DR-012.md) approval gate.
**Epic:** [EPIC-002 Signpost Integrity](../../../docs/epics/EPIC-002-signpost-integrity.md).
**Serves:** [SPEC-017 Trust Dashboard](../trust-dashboard/requirements.md) FR-7a as the
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
| R5 | **Webview perf vs text editor** on large specs. | Low · Med | Lazy/virtualised render; fall back to text for very large files (threshold at plan). |

## Dependencies

- **`depends_on: SPEC-014`** — reuses its renderer/sanitiser and CSP-nonce pattern (FR-6).
  SPEC-014 is `specifying` (not built); this spec's render layer cannot ship before that
  render function exists, so sequencing: SPEC-014 render → SPEC-018 editor wrapper.
- **`relates_to: SPEC-017`** — provides FR-7a's richest engagement source; the relationship
  is *enrich-only* (INV-Metrics-independent), never a hard dependency in either direction.

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
