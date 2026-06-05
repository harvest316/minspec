---
epic: EPIC-005  # Auto Structure Repair
id: SPEC-005
type: requirements
tier: T3
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: specifying
product: minspec
---

# MinSpec — Auto-Structure-Repair (Requirements)

**Date:** 2026-05-30
**Status:** Specifying (SDD Specify phase)
**Decision:** [DR-006 addendum](../../../docs/decisions/DR-006.md)
**Triggered by:** session request — "auto-fix the SDD structure whenever needed"

---

## Context

The detect-and-offer auto-bootstrap system (DR-006, `src/lib/auto-bootstrap.ts`)
already offers `init` / `refresh` / `classify` on activation. Two gaps make it
fall short of "whenever needed":

- **A — shallow detection:** `isMinspecInitialized()` checks only that `.minspec/`
  exists. A partial structure (dir present, `config.json`/`constitution.md`
  missing) reports initialized → no repair offered.
- **B — activation-only:** detection fires once at startup; mid-session breakage
  is never re-detected.

## Requirements

- **FR-1 (integrity detection).** Detection MUST treat the structure as
  incomplete when any *required artifact* is missing, not merely when `.minspec/`
  is absent. Required set: `.minspec/`, `.minspec/config.json`,
  `.minspec/constitution.md`, and the required harness output files.
- **FR-2 (reactive trigger).** A debounced watcher on `.minspec/**` and required
  harness paths MUST re-run detection on delete/change and surface the existing
  offer toast when a required artifact goes missing mid-session.
- **FR-3 (offer, never silent).** Repair is offered via the existing toast
  (`[Fix] / [Not now] / [Don't ask again]`); it MUST NOT auto-write without a
  user action. No new silent-apply setting.
- **FR-4 (idempotent repair).** Accepting the offer runs `minspec.init`, which
  writes only absent files (existing `scaffold()` / `generateHarnessFiles()`
  semantics). MUST NOT overwrite or merge existing user files.
- **FR-5 (consent reuse).** Honors existing per-check `preferences.json`
  dismissals and the `minspec.autoBootstrap.enabled` master toggle. No new
  consent surface.
- **FR-6 (silent marker-bounded refresh — DR-011 Layer 2).** Once the project is
  initialized, the refresh path MAY re-sync MinSpec's own `minspec:*` marker
  sections **without a toast**, because the merge only ever rewrites content
  between markers (invariant #6). Any change that would alter content OUTSIDE a
  marker, and the initial missing-structure offer, still prompt. Gated by
  `minspec.autoBootstrap.enabled`.

## Costly to Refactor (Zone A)

Seams where a wrong early choice is expensive to unwind, ranked:

1. **The "required artifact" set definition (FR-1).** Whatever list drives
   `isMinspecInitialized()` (or its replacement) becomes the de-facto contract
   for "complete." Adding a file later means every already-initialized project
   suddenly reports incomplete and gets a repair toast — a retroactive false
   alarm. This is exactly the unresolved Open question (`TEMPLATE_OUTPUT_PATHS`
   vs curated subset); pin it before coding.
2. **The watcher glob + debounce contract (FR-2).** The `.minspec/**` + harness
   path watcher and its debounce/dedupe-vs-activation behavior are wired into
   extension activation. Getting the dedupe wrong (toast both at startup *and*
   on the first watcher event) trains users to dismiss, then `[Don't ask again]`
   (FR-5) silently kills the feature — hard to walk back once dismissals persist
   in `preferences.json`.
3. **The marker-boundary predicate (FR-6, invariant #6).** The rule that decides
   "change is fully inside `minspec:*` markers → silent" vs "touches outside →
   prompt" guards the non-destructive invariant. If it ever mis-classifies an
   outside-marker change as inside, FR-6 silently rewrites user content — the one
   thing FR-3/FR-4 promise never happens. This predicate is the blast core.

## Invariants (must hold)

- **INV — Tier 0 (DR-004):** detection + repair are pure file-system; no AI, no
  network.
- **INV #5 (user override wins):** every offer dismissible; master toggle exits.
- **INV (non-destructive):** repair never overwrites or deletes user content.

## Acceptance Criteria (Zone A)

Definition-of-done; each item traces an FR/invariant in this spec:

- [ ] With `.minspec/` present but `config.json` OR `constitution.md` OR a
      required harness file absent, detection reports *incomplete* and the offer
      toast appears (FR-1 — fixes Context gap **A**, the `isMinspecInitialized()`
      shallow check).
- [ ] Deleting a required artifact mid-session re-surfaces the offer toast
      without a window reload, via the debounced `.minspec/**` watcher (FR-2 —
      fixes Context gap **B**).
- [ ] No repair is ever written without a user action on
      `[Fix] / [Not now] / [Don't ask again]`; no new silent-apply setting exists
      (FR-3).
- [ ] Accepting `[Fix]` runs `minspec.init` and writes only absent files; a
      hand-edited existing `config.json`/`constitution.md` is byte-identical
      afterward (FR-4 + INV non-destructive).
- [ ] A prior `[Don't ask again]` dismissal in `preferences.json`, and
      `minspec.autoBootstrap.enabled = false`, each suppress the offer (FR-5 +
      INV #5).
- [ ] A `minspec:*` marker-bounded refresh re-syncs silently; a change touching
      content outside any marker still prompts (FR-6 + invariant #6).
- [ ] Detection and repair perform zero AI/network calls — verifiable by code
      path, pure `fs` only (INV Tier 0 / DR-004).

## Assumptions

- `scaffold()` / `generateHarnessFiles()` already have write-only-if-absent
  semantics, so FR-4 idempotency is a reuse, not new code.
- The existing offer toast (`[Fix] / [Not now] / [Don't ask again]`) and the
  `minspec.autoBootstrap.enabled` toggle from DR-006 are present and re-usable;
  FR-3/FR-5 add no new consent surface.
- `minspec:*` marker sections are well-formed (paired open/close markers) in any
  file FR-6 touches; malformed markers fall under Out-of-scope corrupt-artifact
  repair (#39), not here.

## Test-thought

Verified by driving the file system, not mocks: delete each required artifact
(`config.json`, `constitution.md`, a harness output) and assert the offer
surfaces at activation (FR-1) and on mid-session delete via the watcher (FR-2);
then accept `[Fix]` and assert a pre-edited user file is byte-unchanged (FR-4 +
non-destructive INV).

## Consequences

**Positive:**
- Closes the two named gaps from Context — partial-structure false-"initialized"
  (A, FR-1) and activation-only detection (B, FR-2) — so "whenever needed"
  becomes true.
- FR-6 removes nagging for pure marker re-syncs while preserving the prompt for
  any outside-marker change, keeping invariant #6 intact.

**Negative:**
- A new always-on `.minspec/**` watcher adds a small steady-state cost and a
  debounce/dedupe burden (Open question) that activation-only code avoided.
- Broadening "initialized" (FR-1) means projects scaffolded by an older MinSpec
  with a smaller file set may now report incomplete and get a one-time repair
  toast.

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|---|---|---|
| R1 | **Marker mis-classification silently rewrites user content.** FR-6's inside-vs-outside-marker predicate tags an outside-marker change as *inside* → silent overwrite, breaking invariant #6 and FR-3's never-silent promise. | Low · High | The marker-boundary predicate is the named blast core (Costly #3); silent path is taken only when provably inside paired `minspec:*` markers, else prompt (FR-3); T0 test asserting an outside-marker edit always prompts. |
| R2 | **Watcher toast-storm trains dismissal.** FR-2's watcher races activation-time detection → double toast for one missing file → user hits `[Don't ask again]` (FR-5), which persists in `preferences.json` and kills the feature. | Med · Med | Debounce + dedupe-vs-activation (Costly #2 / the named Open question); collapse the activation check and the first watcher event into a single offer. |
| R3 | **Retroactive false-incomplete.** Broadening "initialized" (FR-1) makes projects scaffolded by an older MinSpec report incomplete and surface a one-time repair toast. | Med · Low | Pin the required-artifact set before coding (Costly #1); idempotent repair (FR-4) writes only absent files, so accepting is non-destructive (INV non-destructive). |
| R4 | **Stale dismissal masks real breakage.** A prior `[Don't ask again]` (FR-5) suppresses a later, genuinely-missing-artifact offer. | Med · Low | By design (consent reuse, INV #5) — the user re-enables via the `minspec.autoBootstrap.enabled` master toggle; consent is never auto-overridden. Accepted residual. |
| R5 | **Tier-0 leak.** A future repair convenience reaches for AI/network, breaking the air-gap. | Low · High | INV Tier-0 (DR-004); repair is pure `fs` reuse of `scaffold()`/`generateHarnessFiles()`; no `http`/`https`/`fetch` import (testable by code path). |

## Failure-Modes / Edge-Cases

1. **Toast storm / double-fire (FR-2).** Watcher event races the activation-time
   detection → two toasts for one missing file. Debounce + dedupe-vs-activation
   must collapse them (named Open question).
2. **Marker mis-classification (FR-6).** Predicate wrongly tags an
   outside-marker change as inside → silent rewrite of user content, violating
   invariant #6 and FR-3. The Costly-to-Refactor blast core.
3. **`[Don't ask again]` then real breakage (FR-5).** A prior dismissal in
   `preferences.json` suppresses a later genuinely-missing-artifact offer; by
   design (consent reuse) the user must re-enable, no auto-override.
4. **Bulk delete of `.minspec/` (FR-1/FR-2).** Whole dir removed mid-session →
   should degrade to the same "missing-structure offer" as a fresh project, not
   error.

## Test / Verification Strategy

| FR | Tier | Assertion sketch |
|---|---|---|
| FR-1 | T0 | Invariant: with `.minspec/` present but a required artifact absent, detection returns *incomplete* (one case per artifact in the required set). |
| FR-2 | T2 | Delete a required file mid-session → watcher fires (after debounce) → offer toast surfaces; no window reload needed. |
| FR-3 | T0 | Invariant: no fs write occurs on detection or on `[Not now]`/`[Don't ask again]`; write happens only after `[Fix]`. |
| FR-4 | T0 | Invariant: pre-seed a hand-edited `config.json`; run repair; assert byte-identical + only absent files created. |
| FR-5 | T2 | With dismissal recorded in `preferences.json` OR `autoBootstrap.enabled=false`, offer is suppressed. |
| FR-6 | T0 | Invariant: marker-bounded diff → silent; outside-marker diff → prompt (table the predicate against both). |

## Alternatives Considered

- **Periodic polling instead of an fs watcher (FR-2).** Rejected — wastes cycles,
  adds latency between breakage and offer, and still needs the same dedupe; a
  debounced watcher is event-driven and cheaper.
- **Auto-apply repair silently when artifacts are missing (vs FR-3 offer).**
  Rejected — violates INV #5 (user override wins) and the non-destructive intent;
  the product's "offer, never silent" stance is the whole point.
- **Deep-validate artifact *contents* (parse `config.json`, lint constitution).**
  Rejected for this spec — that is corrupt-artifact repair, explicitly parked as
  [#39](https://github.com/harvest316/minspec/issues/39); scope here is
  additive/missing-only.

## Dependencies & Blast-Radius

- **`src/lib/auto-bootstrap.ts`** (DR-006) — `isMinspecInitialized()` is replaced
  by the FR-1 integrity check; the offer toast and `autoBootstrap.enabled` gate
  are reused. Changing the integrity check changes when *every* project sees the
  offer.
- **`scaffold()` / `generateHarnessFiles()`** — FR-4 depends on their
  write-only-if-absent semantics; if they ever start overwriting, the
  non-destructive invariant breaks here.
- **`TEMPLATE_OUTPUT_PATHS`** — source of the "required harness files" list
  (Open question); editing it silently re-scopes FR-1 detection across all
  projects.
- **`.minspec/preferences.json` + `minspec.autoBootstrap.enabled`** — FR-5
  consent; shape changes break dismissal honoring.

## Rollback / Reversibility

Reversible. The feature is gated by `minspec.autoBootstrap.enabled` (FR-5), so it
can be disabled per-user with no code change. Code-wise, the new watcher (FR-2)
and the FR-1 integrity broadening are additive to `auto-bootstrap.ts`; reverting
restores the activation-only shallow `isMinspecInitialized()` check. No schema or
on-disk migration is introduced (FR-4 only writes absent files), so there is
nothing to un-migrate. **ADR-filter:** undoable in well under a day → no new DR
beyond the existing DR-006 addendum / DR-011 reference.

## Follow-ups (tracked)

- Resolve the required-harness-files source — `TEMPLATE_OUTPUT_PATHS` vs curated
  subset (Open question, drives FR-1 + Costly-to-Refactor item 1). Tracked at
  [harvest316/minspec#139](https://github.com/harvest316/minspec/issues/139)
  (distinct from #39, which is corrupt-artifact repair, not the missing-set
  definition). Pin before leaving Specify.
- Watcher debounce interval + dedupe-vs-activation decision (Open question,
  drives FR-2 + Failure-Mode 1 toast-storm). Tracked at
  [harvest316/minspec#140](https://github.com/harvest316/minspec/issues/140);
  pin before implement.
- Dangling "parked as a separate issue" reference lint already tracked at
  [#40](https://github.com/harvest316/minspec/issues/40).

## Coverage Map

| Mechanism / concern | FR |
|---|---|
| Integrity detection (partial structure ⇒ incomplete) | FR-1 |
| Mid-session reactive re-detection (watcher) | FR-2 |
| Offer-only, no silent write | FR-3 |
| Idempotent / non-destructive repair | FR-4 |
| Consent + master-toggle reuse | FR-5 |
| Marker-bounded silent refresh (invariant #6) | FR-6 |
| Tier-0 purity (no AI/network) | INV Tier 0 / DR-004 |

## Out of scope

- Repairing *corrupt* artifacts (invalid `config.json`, malformed constitution).
  Additive/missing-only. Corrupt-file repair parked as
  [harvest316/minspec#39](https://github.com/harvest316/minspec/issues/39).
  (A lint to catch future dangling "parked as a separate issue" references with
  no link is tracked as
  [#40](https://github.com/harvest316/minspec/issues/40).)
- Any change to the consent model or new silent-apply behavior.

## Open questions

- Exact "required harness files" list — derive from `TEMPLATE_OUTPUT_PATHS` vs a
  curated subset (some harness files may be optional).
- Watcher debounce interval + dedupe against the activation-time run.
