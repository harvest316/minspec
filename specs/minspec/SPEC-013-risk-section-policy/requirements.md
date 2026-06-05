---
id: SPEC-013
type: requirements
# 🔒 Once approved, hash-locked: approved bytes recorded in .minspec/approvals.json[SPEC-013].specHash. ANY edit voids approval (hash → stale) — re-run "MinSpec: Approve Spec". DR-012.
status: specifying
tier: T4
product: minspec
epic: EPIC-003  # SDD Core Methodology
depends_on: [DR-029, DR-020, DR-026, DR-028, DR-030, DR-022]  # DR-029 keystone; DR-020(+addendum) policy; DR-026 offer-not-silent; DR-028 cross-cutting; DR-030 untrusted-input; DR-022 future re-scope
relates_to: [SPEC-010, SPEC-006, SPEC-015]
---

# MinSpec — Self-Audit Section Enforcement — Deterministic Floor (Slice 1)

> **Slice 1 of [DR-029](../../../docs/decisions/DR-029.md) (§8).** This spec owns the
> **Tier-0 deterministic floor** + the self-audit section family + the two-zone doc +
> the cross-checks lifecycle. It makes **no trust claim** (the "skim instead of read"
> affordance is withheld until the validation study, [#127](https://github.com/harvest316/minspec/issues/127)).
> The Tier-1 **reality-check agent + round-table** (Slices 2-3) live in a separate
> EPIC-007 spec — never in this Tier-0 core. Slice 1 is pure file-system: **no AI, no
> network** (Invariant #1).

**Date:** 2026-06-01 · rewritten 2026-06-03 to DR-029 · amended 2026-06-05 (stub-free Zone B, structural + canonically-ordered zones, lifecycle-gated floor; #132 resolved)
**Decision:** [DR-029](../../../docs/decisions/DR-029.md) keystone · [DR-020](../../../docs/decisions/DR-020.md)+addendum (policy) · [DR-026](../../../docs/decisions/DR-026.md) (offer-never-silent) · [DR-028](../../../docs/decisions/DR-028.md) (cross-cutting) · [DR-030](../../../docs/decisions/DR-030.md) (untrusted input). Re-scopes to [DR-022](../../../docs/decisions/DR-022.md) (screen-gated) on its acceptance, gated on #91 per [DR-024](../../../docs/decisions/DR-024.md).
**Epic:** [EPIC-003 SDD Core Methodology](../../../docs/epics/EPIC-003-sdd-core.md)

---

## Context

Per DR-029, the LLM authors a **self-audit appendix** (Risks, Consequences,
Assumptions, …) to cross-check its own work; the human verifies a **signal**, not the
content. This spec is the deterministic machinery that makes that signal *earnable*:
a single section predicate, the tier-scaled section family, per-FR disposition
coverage, the two-zone document, the cross-checks lifecycle, and the freshness +
coverage checks — all Tier-0 (no AI).

It deliberately does **not** redefine policy (DR-020 + addendum own the taxonomy) and
does **not** include any LLM (that is Slice 2+, EPIC-007). It also makes **no
skim-safe claim** — Slice 1 ships the mechanism; the claim waits for evidence
(DR-029 §6).

## Requirements

### Registry + predicate

- **FR-1 (section registry).** Enforcement is driven by one explicit registry of
  required sections, each entry `{ heading, appliesTo (kind + minTier), shape,
  crossCutting }`. v1:

  | Section | Applies to | minTier | Shape | Cross-cutting |
  |---|---|---|---|---|
  | Risks & Mitigations | specs + DRs | T1 | per-FR disposition (FR-3), tier-proportional depth | yes |
  | Out-of-Scope (machine cross-check) | specs | T2 | set-difference vs FR ids | no |
  | Assumptions | specs | T2 | ≥1 one-line assumption | yes |
  | Test-thought | specs | T2 | one-line: how the change is verified | yes |
  | Consequences | specs + DRs | T3 (specs) / all (DRs) | minimal ± shape (FR-4) | yes |
  | Failure-Modes / Edge-Cases | specs | T3 | ≥1 enumerated mode | yes |
  | Test / Verification Strategy | specs | T3 | per-FR test tier + assertion sketch | yes |
  | Alternatives Considered | specs + DRs | T3 | ≥1 named alternative + why-not | yes |
  | Dependencies & Blast-Radius | specs | T4 | declared file list (codegraph reverse-deps = Tier-1, EPIC-007) | yes |
  | Rollback / Reversibility | specs | T4 | undo mechanism + ADR-filter answer | yes |
  | Costly to Refactor | specs + DRs | T2 | ranked seam list, FR/decision-referenced ("Low — <reason>" valid) | yes |

  **Costly to Refactor is a first-class Zone-A citizen (resolves #132).** Every other
  family member renders in the Zone-B skim appendix; **Costly to Refactor renders in
  Zone A** (read-first), placed **after Requirements** (specs) / **after Decision** (DRs)
  so the reader has the FR terms before the seam index — read the expensive-to-reverse
  20% closely, skim the rest. It is the standard seam-first read aid, auto-aided by
  deterministic seam-candidate detection (contracts, cross-package, new deps,
  data-model/API changes) + LLM ranking. (Position settled after-Requirements over
  #132's top-of-doc, precisely because the seams reference FR-ids.)

  Adding/removing a section is a registry edit, not new mechanism. **Tier scales
  *breadth* (which entries emit) + human attention — never LLM depth** (DR-029 §1).
  The T2 cheap floor (Assumptions, Test-thought) blunts size≠difficulty (DR-029 R6).
  Epics are exempt (DR-020).

- **FR-2 (one section-agnostic predicate).** A single deterministic
  `hasSection(artifact, heading)` decides satisfaction: a `##`/`###` heading matching
  «heading» (case-insensitive) with ≥1 non-empty content line beneath. The **sole**
  source of truth, parameterised by heading, shared by the validator (FR-6) and the
  template self-check — stub and check can never disagree (INV-single-predicate).

- **FR-3 (per-FR disposition — the anti-gaming keeper).** Risks coverage is **not a
  count**: every `FR-N` carries an explicit disposition — a risk row, **or** a
  written "no distinct risk — covered by FR-M", **or** "happy-path only, accepted".
  Each FR must be *paired* with a reason (harder to fake than N floating risks; a wall
  of identical escapes is visible at a glance). The DR-020 written-escape is preserved
  **per FR**, so coverage never becomes a tooling block. Parse contract: see FR-12.

- **FR-4 (per-entry satisfaction shape).** Risks: tier-proportional forms from DR-020
  (table T3/T4; bullets T2; one line incl. "None material" T1), via FR-3 dispositions.
  Consequences: **minimal ± shape** — ≥1 positive **and** ≥1 negative, detected via a
  configurable polarity-cue set (`Positive`/`Negative`, `Pros`/`Cons`,
  `Benefits`/`Drawbacks`, `+`/`−`); an explicit one-sided "Negative: none" satisfies a
  side (the written judgement is the value). All checks are **structural** (presence +
  shape), never quality (no oracle for "good" content — R4; SPEC-012 FR-15).

### Templates (prevent first)

- **FR-5 (scaffolds emit Zone A only — no Zone-B stubs).** The `specify`/`plan`
  scaffolds and the **Create ADR** template emit **Zone A** (scope, Context,
  Requirements/FRs, **Costly to Refactor**, Acceptance, Out-of-Scope, Open Questions,
  Invariants) **+ the `<!-- minspec:core-end -->` divider** — and **nothing in Zone B.**
  Empty Zone-B stubs are abolished: a human never fills a stub for a section that exists
  only for the LLM to cross-check its own work, so a pre-emitted empty stub is pure
  approval-time warning-noise (the flood — FR-13 lifecycle-gate; the very pain this spec
  removes). The Zone-B family is authored later, **whole**, by the LLM — at the
  cross-checks phase for T3/T4 (FR-13), or **inline while the LLM writes the spec** for
  T1/T2 (no second gate). The `⏳ deferred placeholder` third state is **removed**:
  before authoring, a Zone-B section is simply **absent**, and absence before
  core-signoff is the expected lifecycle state (INV-no-premature-demand), never a
  missing-section finding. When Zone B *is* authored the LLM emits canonical headings +
  content together in one pass; MinSpec never leaves an empty stub as a resting state.
  Prevention now = emit the right Zone A in canonical order; the floor (FR-9) is the net
  once Zone B is due.

### Detect → offer (Tier-0; never silent, never block)

- **FR-6 (detect + offer, lifecycle-gated, never silent, never block).** The validator
  (`scripts/validate-frontmatter.ts`) detects any artifact under-satisfying a registry
  entry that `appliesTo` it (FR-2/FR-3/FR-4), naming file + section. Surfaced as a
  **visible one-click offer** ([DR-026](../../../docs/decisions/DR-026.md)) — never a
  silent rewrite, never a bare nag, never auto-on-save. **The floor is lifecycle-gated
  (FR-13, INV-no-premature-demand): a Zone-B section is never demanded before
  core-signoff** — pre-signoff absence is the expected state, not a finding, which is
  what kills the approval-time flood. *After* core-signoff (T3/T4), an absent /
  under-satisfied Zone-B section surfaces a finding whose remedy is **"author the
  cross-checks"** (the LLM writes the family whole) — **not "insert an empty stub."**
  Section *content* is always written by the artifact's author — the **LLM authoring the
  spec** (DR-029: author-flow, not a fill-service); MinSpec stays Tier-0 — it gates the
  lifecycle and validates, it does not generate text (LLM-*drafted* offer content is
  Slice 2, EPIC-007). MUST NOT exit non-zero on this rule (mirrors the soft `epic:` rule,
  DR-013 §4) and MUST NOT block edits/commits — only DR-012 approval blocks. Epics exempt.
- **FR-7 (the offer is actionable).** Each finding gives id/path, section, a one-line
  remedy, and the one-click action where the surface supports it (CLI stdout v1;
  Problems-panel later, [#118](https://github.com/harvest316/minspec/issues/118)).

### Two-zone document + cross-checks lifecycle

- **FR-8 (two-zone layout — structural + canonically ordered).** A spec splits at the
  `<!-- minspec:core-end -->` divider, **actually placed in the file** (today it lives
  only as prose — zero docs render it; the inconsistent section order this fixes is the
  symptom). The order is **canonical**, not ad-hoc:
  **Zone A "read this"** = scope → Context → Requirements/FRs → **Costly to Refactor**
  (read-first seams, FR-1) → Acceptance Criteria → Out-of-Scope → Open Questions →
  Invariants; **then the divider; then Zone B self-audit appendix** (the family, fixed
  order). Zone B renders two sub-zones by verification status: **B1 "skim"** (passed the
  floor) and **B2 "please read"** (pulled to top, eyes-on) — a section is B2 when no
  deterministic check can vouch for it (Assumptions, Alternatives, Rollback are
  *structurally* always B2), it tripped specificity (FR-9 L1), or it is stale (FR-10).
  (The `deferred placeholder` B2 trigger is gone with stubs — FR-5.) Degrade pushes
  *more* into B2 (read more, the safe direction). **Slice-1 appendix heading =
  `## Appendix — Self-Audit · read what you want`** — no skim/verified claim (FR-13).
- **FR-9 (deterministic floor — Tier-0 layers).** All pure file-system, no AI:
  - **L0 per-FR disposition coverage** (FR-3) — names naked FRs.
  - **L1 specificity** — a self-audit line referencing no concrete anchor (FR-id /
    allowlist file / invariant / DR) is **flagged to B2** (never silently dropped —
    that would breach offer-never-silent).
  - **L2 consistency** — **id-based** (not lexical): out-of-scope items absent from the
    FR-set; no FR both in/out; all Open Questions resolved before cross-checks complete.
  - **L3 freshness** — FR-10.
  - **L4 tautology-aware stub** — a Test cell is green only if the referenced test is
    non-stub **and** non-tautological; this check is **owned by SPEC-006** (extended
    for assertion-free tests) and consumed here.
- **FR-10 (freshness — DR-012 pattern).** A completed cross-cutting section is bound to
  a hash of the FR-set — **FR ids *and* each FR's body bytes** (DR-029 amends DR-028's
  ids-only rule to close substance-rot). Editing/adding/removing an FR after the
  section was written marks it **stale**, surfacing a *named* offer; cosmetic-reword
  false-positives are the accepted safe direction (an FR-ref present in the section
  clears its cell on revisit).
- **FR-11 (coverage — consumes SPEC-010).** Each `FR-N` should be *referenced* in the
  applicable cross-cutting section; uncovered FRs are named. The FR→section coverage
  edge is **owned by SPEC-010's DAG**, amended under
  [#121](https://github.com/harvest316/minspec/issues/121) (approved spec — amended +
  re-reviewed, not silently edited). This spec **consumes** the predicate; FR-9/FR-10
  ship independently of #121.
- **FR-12 (parse contract).** The deterministic layers require a stated grammar:
  FR ids (`FR-N`), the disposition block shape (FR-3), the polarity cues (FR-4), and
  the `<!-- minspec:core-end -->` delimiter. `spec-validator.ts` today parses **none**
  of these — this is new Tier-0 parser work, contract defined here before
  implementation (CDD contracts-first).
- **FR-13 (cross-checks lifecycle — two approvals, T3/T4).**
  `specify (LLM writes Zone A) → core-signoff (human pre-approves; freezes FRs via
  coreHash) → cross-checks (LLM authors the **whole** Zone-B family, floor runs) →
  final-approve (human skims Zone B; DR-012 specHash, the sole blocking gate) → done`.
  **Zone B does not exist before core-signoff** and is never demanded there
  (INV-no-premature-demand) — pre-approval the human reads only Zone A, which is the
  point of the split. Core-signoff **void-then-offers** the cross-checks (never
  auto-on-save); editing an FR after signoff voids it and waits for explicit re-signoff.
  **T1/T2 have no core-signoff, no cross-checks phase, no second approval** — their small
  Zone-B family (T1: one Risks line; T2: + Assumptions + Test-thought) is authored
  **inline by the LLM while it writes the spec**, never stubbed, skimmed at the single
  approval. The new `cross-checks` phase must propagate to SPEC-015 lanes + the
  classifier + the signpost (DR-029 §Methodology #5).

### Scope boundary

- **FR-14 (policy + LLM live elsewhere).** This spec MUST NOT encode section
  depth/applicability policy beyond the registry + predicate (Risks taxonomy = DR-020;
  Consequences = DR-020 addendum), and MUST NOT contain any LLM/network (reality-check,
  round-table, LLM-drafted content, and the trust claim are EPIC-007 / Slices 2-3 /
  #127). Slice 1 stays Tier-0.

## Costly to Refactor

*The expensive-to-reverse commitments — read these closely; everything else is cheap
to change on live. Ranked most→least costly. (Auto-detectable seam candidates:
contracts, cross-package boundaries, new deps, data-model / public-API changes.)*

1. **Single `hasSection` predicate** (FR-2, INV-single-predicate) — one source of
   truth shared by validator + templates. Two implementations = permanent drift,
   costly to re-unify. *Check: one function, consumed everywhere.*
2. **Tier-0 no-AI/network boundary** (FR-14, INV-Tier-0) — a leak breaks invariant #1
   (the air-gap positioning) and is very costly to extract. *Check: no claude/http/fetch
   in Slice 1.*
3. **Per-FR disposition shape + parse contract** (FR-3, FR-12) — the data-model the
   coverage layer keys off; changing the grammar = re-parse + migrate every existing
   spec. *Check: grammar fixed before specs adopt it.*
4. **Two-zone delimiter `<!-- minspec:core-end -->` + canonical section order +
   `coreHash`** (FR-8, FR-13) — a structural contract every doc adopts; moving the
   divider or reordering Zone A = re-delimit + rehash all. *Check: Zone A/B boundary +
   section order settled.*
5. **Freshness binds FR-body bytes** (FR-10) — changes staleness behaviour for every
   spec. *Check: you accept "cosmetic FR reword voids the section".*

## Invariants (must hold)

- **INV — Tier-0 (T0).** Slice 1 is pure file-system: no AI, no network in
  `packages/minspec` / `packages/shared` (Invariant #1; DR-004).
- **INV — Advisory, offer-never-silent (T0).** Detects + offers a one-click fix (after
  core-signoff the remedy is "author the cross-checks," not an empty stub); never
  silently writes the author's artifact, never auto-on-save, never blocks (FR-6, DR-026).
  Only DR-012 blocks. Section *content* is written by the artifact's author (the LLM
  authoring the spec) — never fabricated by the enforcement tool into another author's
  artifact.
- **INV — Never demand Zone B before pre-approval (T0).** The floor (FR-6/FR-9) raises a
  missing-Zone-B finding **only after core-signoff** (T3/T4) or, for T1/T2, as part of
  the single authoring pass — never as a pre-signoff missing-section warning. A
  pre-signoff spec with an empty Zone B is **clean, not flooded**. Detection without an
  authoring flow is the approval-time flood this spec exists to remove (FR-5, FR-13):
  shipping FR-6 detection without FR-13 lifecycle-gating is a regression, not a partial
  win.
- **INV — Single predicate (T0).** Exactly one `hasSection` (FR-2), parameterised by
  heading, used by validator and template self-check for every entry; no second
  implementation (no heading/checker drift).
- **INV — Never latch on presence (T0).** A cross-cutting section never reads
  "complete" on presence alone — FR-9 (disposition) + FR-10 (freshness) + FR-11
  (coverage) gate it (DR-028/DR-029).

## Acceptance Criteria

*Definition-of-done — each item traces a concrete FR/invariant. Checked = built +
its T0/T1 test green (see Test / Verification Strategy below).*

- [ ] **One registry drives enforcement** — sections emit from the single FR-1 table
  (`{ heading, appliesTo, minTier, shape, crossCutting }`); adding/removing a section
  is a table edit with no new code path. *(FR-1)*
- [ ] **Exactly one `hasSection` predicate** — validator (FR-6) and template self-check
  call the same function, parameterised by heading; no second implementation exists.
  *(FR-2, INV-single-predicate)*
- [ ] **Per-FR disposition coverage (L0)** — every `FR-N` in the spec is paired with a
  risk row, a "covered by FR-M" escape, or a "happy-path only, accepted" escape; a
  naked FR is named by the validator. *(FR-3, FR-9 L0)*
- [ ] **Consequences ± shape enforced** — a Consequences section satisfies only with ≥1
  positive AND ≥1 negative (or an explicit one-sided "Negative: none"), detected via the
  polarity-cue set. *(FR-4)*
- [ ] **Scaffolds emit Zone A only (no Zone-B stubs)** — `specify`/`plan`/Create-ADR
  templates emit Zone A + the `<!-- minspec:core-end -->` divider and **zero** Zone-B
  stubs; Zone B is authored whole by the LLM at cross-checks (T3/T4) or inline (T1/T2).
  *(FR-5)*
- [ ] **Detect → offer, never silent / never block** — the validator names file+section
  on under-satisfaction (after core-signoff for Zone B), surfaces a one-click "author the
  cross-checks" offer, exits zero, and never rewrites the author's content. *(FR-6, FR-7,
  INV-advisory)*
- [ ] **Two-zone split renders in canonical order** — a spec places the
  `<!-- minspec:core-end -->` divider and emits Zone A (… → Costly to Refactor →
  Acceptance → Out-of-Scope → Open Questions → Invariants) then the Zone-B appendix, with
  B1 (skim) / B2 (please read) by verification status; Assumptions/Alternatives/Rollback
  structurally B2. *(FR-8)*
- [ ] **No premature Zone-B demand** — the floor raises no missing-Zone-B finding before
  core-signoff (T3/T4) and none outside the single authoring pass (T1/T2); a pre-signoff
  spec with an empty Zone B is clean, not flooded. *(FR-13, INV-no-premature-demand)*
- [ ] **Deterministic floor L0-L3 runs with no AI/network** — disposition (L0),
  specificity→B2 (L1), id-based consistency (L2), freshness (L3) all execute in
  `packages/minspec`/`packages/shared` with no `claude`/`http`/`fetch`. *(FR-9, INV-Tier-0)*
- [ ] **Freshness binds FR-body bytes** — editing an FR's body after a cross-cutting
  section is written marks that section stale and surfaces a named offer. *(FR-10)*
- [ ] **Parse contract implemented** — `spec-validator.ts` parses `FR-N` ids, the
  disposition block, the polarity cues, and the `<!-- minspec:core-end -->` delimiter
  (none parsed today). *(FR-12)*
- [ ] **Cross-checks lifecycle gated to T3/T4** — `specify → core-signoff → cross-checks
  → final-approve → done` exists for T3/T4 only; T1/T2 keep one Risks line, no second
  approval; the new phase propagates to SPEC-015 lanes + classifier + signpost. *(FR-13)*
- [ ] **No policy/LLM leak** — the spec encodes registry+predicate only (taxonomy stays
  DR-020 / addendum); no reality-check, round-table, LLM-drafted content, or skim claim
  ships in Slice 1. *(FR-14, INV-Tier-0)*

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|---|---|---|
| R1 | **Heading/predicate drift** — an LLM-authored Zone-B heading the predicate rejects (case/format). | Low · Med | FR-2 single predicate + INV-single-predicate; the LLM authors against the canonical heading list (FR-8); T0 test asserts each canonical heading passes `hasSection`. Surface shrank when Zone-B stubs were abolished (FR-5). |
| R2 | **Backfill warning-flood** — enabling FR-6 over existing DRs/specs floods warnings. | High · Med | RD-1 backfill-before-enable (the ~22 of 28 DRs whose Consequences are prose, not ±, need restructuring; DR-007/DR-010 lack Consequences entirely); advisory-only meanwhile. |
| R3 | **Predicate too loose** — empty heading passes. | Med · Med | FR-2 requires ≥1 non-empty line; FR-3 disposition per FR. |
| R4 | **Vacuity passes Tier-0** — specific-but-vacuous line clears the floor. | High · High | Floor catches omission, not vacuity (stated, DR-029 R1). Caught only by the Slice-2 reality-check; no skim claim until the study (FR-13/#127), so vacuity never earns a skim licence. Residual. |
| R5 | **Ceremony creep at T2** — the cheap floor grows into a T2 wall. | Med · Med | T2 entries are one-line, skim-not-read (consideration, not ceremony); Invariant #4 + ceremony tests in CI. |
| R6 | **Freshness false-positives** — cosmetic FR reword voids a section. | Med · Med | FR-10 binds FR-body bytes deliberately (closes substance-rot); FR-ref present clears the cell. Accepted safe direction. |
| R7 | **Floor depends on unbuilt specs** — SPEC-010 DAG (#121) + SPEC-006 stub scanner are `specifying`. | High · High | FR-9 L4 + FR-11 are explicitly *consumed* dependencies; sequence SPEC-006 + SPEC-010 before those layers are trusted; FR-9 L0-L3 + FR-10 ship independently. |
| R8 | **"Consequences" name collision** with the DR-022 reach axis. | Med · Low | Out-of-scope separates them; this enforces a doc-section heading, never a risk-screen signal. |

## Assumptions

- The registry (FR-1) is small enough that section policy lives in data, not code — adding
  a section is a table row, never a new mechanism (the whole premise of FR-1).
- DR-020 + its addendum remain the **sole** owners of Risks/Consequences taxonomy; this
  spec assumes it never has to encode depth policy (FR-14).
- SPEC-006 (hollow-test scanner, FR-9 L4) and SPEC-010 (coverage DAG, #121, FR-11) are
  available *before* their consuming layers are trusted; FR-9 L0-L3 + FR-10 are assumed
  independent of both and ship first (per Open questions).
- An FR-id reference inside a cross-cutting section is a reliable proxy for "this section
  considered that FR" — the basis of both the freshness clear (FR-10) and coverage (FR-11).

## Test-thought

Verified by scaffolding a spec at each tier (T1-T4) and asserting (a) the scaffold emits
**Zone A + the `<!-- minspec:core-end -->` divider and zero Zone-B stubs** (FR-5), and the
canonical Zone-B headings the LLM authors against all pass `hasSection` (FR-2/FR-8, no
heading/checker drift), (b) a pre-signoff spec with an empty Zone B raises **no**
missing-section finding while a post-signoff one does (FR-13, INV-no-premature-demand),
(c) a spec with a naked `FR-N` is flagged by L0 (FR-3/FR-9), (d) a Consequences section
missing a polarity side fails FR-4, and (e) the validator exits **zero** on every
under-satisfaction (FR-6, INV-advisory). No-AI/network is verified by a grep-gate over
`packages/minspec` / `packages/shared` (INV-Tier-0). Full per-FR matrix in Test /
Verification Strategy below.

## Coverage Map

*Each mechanism/concern this spec introduces, mapped to the FR(s) that own it — the
inverse of the per-FR disposition, used to confirm no concern is orphaned.*

| Mechanism / concern | Owning FR(s) |
|---|---|
| Section registry (data-driven policy) | FR-1 |
| Single `hasSection` predicate | FR-2 |
| Per-FR disposition (anti-gaming) | FR-3 |
| Per-entry satisfaction shape (Risks forms, Consequences ±) | FR-4 |
| Scaffold emits Zone A only (no Zone-B stubs) | FR-5 |
| Detect → offer (never silent / never block) | FR-6, FR-7 |
| Two-zone document (structural divider + canonical order) + B1/B2 sub-zones | FR-8 |
| Stub-free Zone B (no deferred placeholders) | FR-5 |
| Lifecycle-gated floor (no premature Zone-B demand) | FR-13, INV-no-premature-demand |
| Deterministic floor L0-L4 | FR-9 (+ FR-10 = L3) |
| Freshness (FR-body-byte binding) | FR-10 |
| FR→section coverage (consumes SPEC-010) | FR-11 |
| Parse contract / grammar | FR-12 |
| Cross-checks lifecycle (T3/T4, two approvals) | FR-13 |
| Policy + LLM scope boundary | FR-14 |
| Costly-to-Refactor as first-class Zone-A citizen (#132 resolved) | FR-1 |

## Consequences

**Positive:**

- One registry + one predicate (FR-1/FR-2) means section policy evolves by editing a
  table, not shipping code — the cost of the next cross-check section approaches zero.
- The per-FR disposition (FR-3) makes Risks coverage *un-gameable by count* — a wall of
  identical escapes is visible at a glance, which a floating risk-count never was.
- Slice 1 ships a real mechanism with **no AI and no trust claim** (FR-14, FR-13), so the
  air-gap invariant (#1) and the never-wrong positioning are preserved while evidence is
  gathered (#127).
- Killing Zone-B stubs (FR-5) + lifecycle-gating the floor (FR-13/INV-no-premature-demand)
  removes the approval-time missing-section flood **at its mechanism**: nothing demands a
  section the human was never going to fill, and the LLM authors Zone B *before*
  final-approve — so the second approval is a skim of filled sections, not a wall of warnings.

**Negative:**

- Backfill is mandatory before FR-6 enables (RD-1): Risks onto every DR/spec lacking it
  *and* restructuring the ~22 of 28 DRs whose Consequences are prose (only ~6 already use
  ± polarity cues) into ± shape — real one-time toil (R2).
- The canonical zone order + structural divider (FR-8) must be back-filled across the 13
  existing specs + 30 DRs (several still carry Out-of-Scope / Open-Questions *after* Zone B,
  the inconsistency that surfaced this amendment) — tracked as a re-layout chore on SPEC-005
  auto-structure-repair + RD-1, not hand-edited.
- Freshness binding FR-body bytes (FR-10) means a cosmetic FR reword voids the section —
  an accepted false-positive we deliberately chose over substance-rot (R6).
- The floor's strongest layers (L4 hollow-test, FR-11 coverage) are **debt** until SPEC-006
  and SPEC-010 (#121) land — Slice 1 ships with L0-L3 + FR-10 only (R7).

## Failure-Modes / Edge-Cases

1. **Heading present, body empty** — a `## Risks & Mitigations` with no content line: FR-2
   requires ≥1 non-empty line, so it reads *unsatisfied*, not *satisfied* (R3).
2. **Specific-but-vacuous line** — a line citing a real FR but saying nothing true clears
   the Tier-0 floor (L1 only checks anchor presence). Accepted residual: caught only by
   the Slice-2 reality-check, and no skim licence is granted until #127 (R4).
3. **Zone B absent before core-signoff read as "missing"** — pre-signoff a Zone-B section
   simply is not present; the floor must treat that absence as the **expected lifecycle
   state** (INV-no-premature-demand, FR-13), not a missing-section finding. Mis-gating it
   reintroduces the approval-time flood (FR-5). *After* core-signoff, absence *is* a
   finding ("author the cross-checks").
4. **One-sided Consequences** — only `Positive:` filled: fails FR-4 unless the author
   writes the explicit `Negative: none` judgement (the written judgement is the value).
5. **FR renumbered/removed after sign-off** — the FR-set hash changes (FR-10); every
   bound cross-cutting section goes stale and re-offers, never silently passes.
6. **Out-of-scope item that is actually an FR** — L2 id-based consistency flags any
   out-of-scope entry that appears in the FR-set, and any FR listed both in and out (FR-9 L2).

## Test / Verification Strategy

*Per-FR test tier (T0 invariant / T1 contract / T2 feature / T3 regression / T4 coverage)
+ one-line assertion sketch. T0 = highest priority (invariants).*

| FR | Tier | Assertion sketch |
|---|---|---|
| FR-1 | T1 | Registry parses to N entries with required keys; unknown key rejected. |
| FR-2 | T0 | `hasSection` accepts `##`/`###` heading + ≥1 content line; empty body → false; one impl only. |
| FR-3 | T0 | Spec with a naked `FR-N` (no row/escape) → L0 names it; every FR paired → passes. |
| FR-4 | T0 | Consequences with only `Positive:` → fail; `Negative: none` added → pass; polarity cues table-driven. |
| FR-5 | T2 | Scaffold each tier → emits Zone A + `core-end` divider, **zero** Zone-B stubs; the canonical Zone-B headings the LLM authors against all pass `hasSection`. |
| FR-6 | T0 | Under-satisfied artifact → validator names file+section AND `exit 0` (never non-zero, never rewrite). |
| FR-7 | T2 | Each finding yields id/path + section + one-line remedy (+ action where surface supports). |
| FR-8 | T2 | Spec places `<!-- minspec:core-end -->`; Zone A in canonical order (Costly-to-Refactor after Requirements); Assumptions/Alternatives/Rollback land in B2. |
| FR-9 | T0 | L0-L2 each fire on a crafted fixture; L1 flags an anchor-free line to B2 (never drops it). |
| FR-10 | T0 | Edit an FR body after section written → section marked stale; FR-ref present clears the cell. |
| FR-11 | T4 | Consumes SPEC-010 predicate; uncovered FR named — gated on #121, ships after. |
| FR-12 | T1 | Parser extracts `FR-N`, disposition block, polarity cues, delimiter from a fixture spec. |
| FR-13 | T2 | T3/T4 walks `specify→core-signoff→cross-checks→final-approve`; empty Zone B is clean pre-signoff, flagged post-signoff; T1/T2 skip the phase (Zone B inline). |
| FR-14 | T0 | Grep-gate: no `claude`/`http`/`fetch` and no DR-020-depth policy in `packages/minspec`/`packages/shared`. |

## Alternatives Considered

- **One checker per section (no registry).** Rejected — N hand-written checkers drift from
  N template stubs (exactly R1); the single-registry + single-`hasSection` design (FR-1/FR-2)
  exists to make that drift impossible.
- **Count-based Risks coverage** (≥N risks per spec). Rejected by FR-3 — a count is trivially
  gamed by padding; per-FR disposition forces a *reason per FR*, far harder to fake.
- **Hard-block on missing sections** (non-zero exit / refuse commit). Rejected — violates
  INV-advisory + DR-026 (offer-never-silent); only DR-012 approval blocks (FR-6).
- **Freshness on FR-ids only** (DR-028's original rule). Rejected by FR-10 — ids-only misses
  substance-rot (FR body changes, id stays); DR-029 amends it to bind FR-body bytes, accepting
  the cosmetic-reword false-positive (R6) as the safe direction.
- **Ship the skim/trust claim in Slice 1.** Rejected — DR-029 §6 withholds it until the
  validation study (#127); Slice 1's appendix is labelled "read what you want" (FR-13), no claim.

## Dependencies & Blast-Radius

*Declared dependencies + what breaks downstream if each is changed.*

- **`scripts/validate-frontmatter.ts` / `spec-validator.ts`** (FR-6, FR-12) — gains the new
  parser + detect/offer path. Today it parses **none** of the grammar (FR-12); a regression
  here silences the whole floor. Highest blast-radius file.
- **`hasSection` predicate** (FR-2) — consumed by validator *and* every template self-check;
  a signature/semantics change ripples to all callers + every emitted stub (INV-single-predicate).
- **`specify`/`plan` scaffolds + Create-ADR template** (FR-5) — every new spec/DR inherits
  their Zone-A layout + canonical heading order (no Zone-B stubs); a canonical Zone-B heading
  that fails `hasSection` reintroduces R1 drift across all future docs.
- **SPEC-010 coverage DAG (#121)** (FR-11) — amended, not silently edited; FR-11 is dead until
  it lands. **SPEC-006 hollow-test scanner** (FR-9 L4) — same: L4 stays unbuilt until SPEC-006.
- **SPEC-015 lanes + classifier + signpost** (FR-13) — the new `cross-checks` phase must
  propagate to all three (DR-029 §Methodology #5); a miss strands T3/T4 specs mid-lifecycle.
- **`<!-- minspec:core-end -->` delimiter + `coreHash`** (FR-8, FR-13) — a structural contract
  every doc adopts; moving it forces re-delimit + rehash of every existing spec.

## Rollback / Reversibility

- **Undo mechanism.** Slice 1 is advisory-only and exits zero (FR-6, INV-advisory): disabling
  it is a config/flag flip on the validator's detect-offer path — no doc rewrite to revert,
  nothing blocks in the meantime. The Zone-A scaffold + `core-end` divider (FR-5) is inert
  text; reverting it is a template edit (and there are no Zone-B stubs to remove). The
  genuinely hard-to-reverse pieces are catalogued in **Costly to Refactor**
  (the `hasSection` predicate, the Tier-0 boundary, the parse grammar, the `core-end` delimiter).
- **ADR-filter (undo in <1 day?).** **No** — the registry + predicate + parse contract + two-zone
  delimiter are foundational seams adopted across every spec/DR (Costly items 1, 3, 4); they are
  *not* reversible in <1 day, which is why this work is governed by DR-029 (keystone) rather than
  done ad-hoc. The advisory *surfacing* is reversible in minutes; the *contracts* are not.

## Out of scope

- **The policies themselves** (Risks taxonomy = DR-020; Consequences = DR-020 addendum).
- **All LLM / Tier-1** — reality-check agent, round-table, LLM-drafted content, the
  Zod verdict contract, untrusted-input handling: **EPIC-007 spec (Slices 2-3)**,
  isolation per DR-030.
- **The trust ("skim-safe") claim + its activation** — DR-029 §6; #127 (activate), #128 (telemetry).
- **The DR-022 consequence/*reach* risk axis** — gated on #91 per DR-024; a risk-screen signal, not a doc section.
- **Semantic quality of content** — no oracle for "good" risks/consequences (FR-4).
- **Hard-blocking enforcement** — only DR-012 blocks.

## Resolved design decisions

- **RD-1 — backfill before enabling.** Two-part: (a) Risks onto any DR/spec lacking it; (b) restructure the ~22 of 28 existing DRs' prose Consequences → ± shape (DR-007/DR-010 had none → added fresh). Lands before/with FR-6 (avoids R2). **Executed 2026-06-04** — all 30 DRs + 13 specs now carry the cross-check family (commits 128eeff specs, f08b06a DRs); FR-6 enablement is the remaining gate.
- **RD-2 — CLI stdout v1.** Problems-panel parked #118.
- **RD-3 — Consequences policy home = DR-020 addendum.**
- **RD-4 — Consequences shape = minimal ±.**
- **RD-5 — detect → offer, never silent; remedy is "author the cross-checks," not an empty stub; LLM-drafted offer content deferred to Slice 2.**
- **RD-6 — cross-cutting complete-last + never latch on presence** (FR-9/10/11, DR-028/029).
- **RD-7 — no trust claim in Slice 1** (DR-029 §6); appendix label = "Self-Audit · read what you want".
- **RD-8 — Zone B is stub-free + lifecycle-gated (decided 2026-06-05).** No Zone-B stubs at
  scaffold time; Zone B authored whole by the LLM after core-signoff (T3/T4) or inline
  (T1/T2). The floor never demands Zone B before pre-approval (INV-no-premature-demand) —
  the fix for the approval-time missing-section flood. The two zones become **structural**
  (the `<!-- minspec:core-end -->` divider is actually placed) and **canonically ordered**
  (FR-8). **Costly to Refactor is a first-class Zone-A citizen** (resolves #132), placed
  after Requirements (not top-of-doc, since seams reference FR-ids). Amends DR-029's
  two-zone model — see DR-029 addendum.

## Open questions

- **None blocking.** Sequenced dependencies (not blockers): SPEC-006 hollow-test
  extension (FR-9 L4) and SPEC-010 coverage edge (#121, FR-11) ship before those two
  layers are trusted; the rest of the floor (FR-2/3/4/9 L0-L2/10) is independent.

## Follow-ups (tracked)

*Every forward-looking / deferred item this spec surfaces, with its tracking ref
(DR-023). Cross-repo / non-code consequences get an issue ref or an explicit
"→ file issue". Items below this spec's own scope (Slice 1, Tier-0) are EPIC-007 /
Slice 2-3 work and tracked on their own spec.*

- **Activate the skim/trust ("skim-safe") claim** once the validation study returns —
  Slice 1 ships the mechanism with *no* claim (FR-13/FR-14, R4, RD-7). Tracked:
  [#127](https://github.com/harvest316/minspec/issues/127).
- **Skim-claim telemetry** to gather the evidence #127 depends on (Out of scope) —
  tracked: [#128](https://github.com/harvest316/minspec/issues/128).
- **Problems-panel surface for the offer** — FR-7/RD-2 ship CLI stdout in v1; the
  one-click action in the editor Problems panel is later. Tracked:
  [#118](https://github.com/harvest316/minspec/issues/118).
- **Amend SPEC-010's coverage DAG** to own the FR→section coverage edge that FR-11
  consumes (approved spec — amended + re-reviewed, not silently edited; R7,
  Dependencies). Tracked: [#121](https://github.com/harvest316/minspec/issues/121).
  FR-9 L0-L3 + FR-10 ship independently of it.
- **DR-022 reach-axis re-scope gate** — this spec re-scopes to DR-022 on its
  acceptance (frontmatter, Out of scope, R8); the reach/consequence risk-screen axis
  is gated on [#91](https://github.com/harvest316/minspec/issues/91) per DR-024. Not a
  doc-section concern of this spec.
- **Costly-to-Refactor as a first-class Zone-A citizen** — resolves
  [#132](https://github.com/harvest316/minspec/issues/132) (placed after Requirements,
  not top-of-doc, since seams reference FR-ids). FR-1, Coverage Map, RD-8. Close #132 on
  this spec's approval.
- **Re-layout the 13 existing specs + 30 DRs to the canonical zone order + structural
  divider (FR-8)** — they predate the split (several carry Out-of-Scope / Open-Questions
  *after* Zone B, the symptom that surfaced this amendment). Mechanical re-ordering tracked
  on **SPEC-005 auto-structure-repair** + RD-1 backfill, not hand-edited here. → file issue
  if SPEC-005's scope doesn't already cover doc re-layout.
- **Web/README copy for the stub-free, pre-approve → LLM-writes → skim flow** — a
  positioning change (cross-repo, non-code; a prose-only leak otherwise). Tracked:
  [#165](https://github.com/harvest316/minspec/issues/165); Paul reviews copy before
  publishing.
- **Reality-check agent + round-table + LLM-drafted offer content + Zod verdict
  contract + untrusted-input handling** — Tier-1, explicitly out of this Tier-0 core
  (FR-14, Out of scope, isolation per DR-030). Tracked on the **EPIC-007 spec
  (Slices 2-3)**; → file issue if no EPIC-007 spec id exists yet to carry Slice 2-3.
- **RD-1 backfill before FR-6 enables** — Risks onto every DR/spec lacking it *and*
  restructure the ~22 of 28 DRs whose Consequences are prose (DR-007/DR-010 lack
  Consequences entirely) into ± shape (RD-1, R2, Consequences→Negative). One-time
  migration prerequisite to enabling the FR-6 floor. → file issue (cross-cutting
  backfill chore, no owning SPEC) if not already tracked alongside #121.
- **Sequence SPEC-006 (hollow-test scanner, FR-9 L4) + SPEC-010 (coverage DAG, #121,
  FR-11) before their consuming layers are trusted** — both `specifying`; L4 + FR-11
  are debt until they land (Open questions, R7, Assumptions, Dependencies). Tracked
  via SPEC-006, SPEC-010, and [#121](https://github.com/harvest316/minspec/issues/121).
- **Propagate the new `cross-checks` phase to SPEC-015 lanes + the classifier + the
  signpost** (FR-13, DR-029 §Methodology #5, Dependencies) — a miss strands T3/T4
  specs mid-lifecycle. Tracked via **SPEC-015** (lanes) + the classifier/signpost work
  it governs.
