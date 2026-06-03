---
id: SPEC-013
type: requirements
status: specifying
tier: T3
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

**Date:** 2026-06-01 · rewritten 2026-06-03 to DR-029
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

- **FR-5 (scaffolds emit the applicable stubs).** The `specify`/`plan` scaffolds and
  the **Create ADR** template MUST emit a stub for each registry entry that
  `appliesTo` the artifact (sized to tier). Cross-cutting stubs are emitted as
  **deferred placeholders** — explicitly "⏳ complete in cross-checks — not yet
  counted" — which are *neither missing nor satisfied* (FR-9). Consequences stubs
  carry the `Positive:` / `Negative:` ± skeleton so a filled stub passes FR-4 (no
  stub/checker drift, R1). Prevention is the primary line; the floor below is the net.

### Detect → offer (Tier-0; never silent, never block)

- **FR-6 (detect + offer-stub, never silent, never block).** The validator
  (`scripts/validate-frontmatter.ts`) detects any artifact under-satisfying a registry
  entry that `appliesTo` it (FR-2/FR-3/FR-4), naming file + section. Surfaced as a
  **visible one-click "add/complete stub" offer** ([DR-026](../../../docs/decisions/DR-026.md))
  — never a silent rewrite, never a bare nag, never auto-on-save. **In Slice 1 the
  offer inserts only the deterministic stub/skeleton (structure).** Section *content*
  is written by the artifact's author — which, in the normal flow, is the **LLM
  authoring the spec** (DR-029: author-flow, not a fill-service). LLM-*drafted* content
  in the offer itself is Slice 2 (EPIC-007). MUST NOT exit non-zero on this rule
  (mirrors the soft `epic:` rule, DR-013 §4) and MUST NOT block edits/commits — only
  DR-012 approval blocks. Epics exempt.
- **FR-7 (the offer is actionable).** Each finding gives id/path, section, a one-line
  remedy, and the one-click action where the surface supports it (CLI stdout v1;
  Problems-panel later, [#118](https://github.com/harvest316/minspec/issues/118)).

### Two-zone document + cross-checks lifecycle

- **FR-8 (two-zone layout).** A spec splits at `<!-- minspec:core-end -->`:
  **Zone A "read this"** (scope, Context, Requirements/FRs, Out-of-Scope, Open
  Questions, Invariants) and **Zone B self-audit appendix** (the family). Zone B
  renders two sub-zones by verification status: **B1 "skim"** (passed the floor) and
  **B2 "please read"** (pulled to top, eyes-on) — a section is B2 when no deterministic
  check can vouch for it (Assumptions, Alternatives, Rollback are *structurally*
  always B2), it tripped specificity (FR-9 L1), it is stale (FR-10), or it is a
  deferred placeholder. Degrade pushes *more* into B2 (read more, the safe direction).
  **Slice-1 appendix heading = `## Appendix — Self-Audit · read what you want`** — no
  skim/verified claim (FR-13).
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
- **FR-13 (cross-checks lifecycle — T3/T4 only).**
  `specify → core-signoff (human, freezes FRs via coreHash) → cross-checks (LLM authors
  the family last, floor runs) → final-approve (DR-012 specHash, the sole blocking
  gate) → done`. Core-signoff **void-then-offers** the cross-checks (never auto-on-save);
  editing an FR after signoff voids it and waits for explicit re-signoff. **T1/T2 have
  no core-signoff, no cross-checks phase, no second approval** — T1 keeps its one Risks
  line. New `cross-checks` phase must propagate to SPEC-015 lanes + the classifier +
  the signpost (DR-029 §Methodology #5).

### Scope boundary

- **FR-14 (policy + LLM live elsewhere).** This spec MUST NOT encode section
  depth/applicability policy beyond the registry + predicate (Risks taxonomy = DR-020;
  Consequences = DR-020 addendum), and MUST NOT contain any LLM/network (reality-check,
  round-table, LLM-drafted content, and the trust claim are EPIC-007 / Slices 2-3 /
  #127). Slice 1 stays Tier-0.

## Invariants (must hold)

- **INV — Tier-0 (T0).** Slice 1 is pure file-system: no AI, no network in
  `packages/minspec` / `packages/shared` (Invariant #1; DR-004).
- **INV — Advisory, offer-never-silent (T0).** Detects + offers a one-click *stub*
  fix; never silently writes the author's artifact, never auto-on-save, never blocks
  (FR-6, DR-026). Only DR-012 blocks. Section *content* is written by the artifact's
  author (human or the LLM authoring the spec) — never fabricated by the enforcement
  tool into another author's artifact.
- **INV — Single predicate (T0).** Exactly one `hasSection` (FR-2), parameterised by
  heading, used by validator and template self-check for every entry; no second
  implementation (no stub/checker drift).
- **INV — Never latch on presence (T0).** A cross-cutting section never reads
  "complete" on presence alone — FR-9 (disposition) + FR-10 (freshness) + FR-11
  (coverage) gate it (DR-028/DR-029).

## Risks & Mitigations

| # | Risk | Likelihood · Impact | Mitigation |
|---|---|---|---|
| R1 | **Stub/validator drift** — template emits a heading the predicate rejects. | Med · High | FR-2 single predicate + INV-single-predicate; T0 test scaffolds each tier and asserts the raw stub passes. |
| R2 | **Backfill warning-flood** — enabling FR-6 over existing DRs/specs floods warnings. | High · Med | RD-1 backfill-before-enable (incl. restructuring 25 DRs' Consequences to ±); advisory-only meanwhile. |
| R3 | **Predicate too loose** — empty heading passes. | Med · Med | FR-2 requires ≥1 non-empty line; FR-3 disposition per FR. |
| R4 | **Vacuity passes Tier-0** — specific-but-vacuous line clears the floor. | High · High | Floor catches omission, not vacuity (stated, DR-029 R1). Caught only by the Slice-2 reality-check; no skim claim until the study (FR-13/#127), so vacuity never earns a skim licence. Residual. |
| R5 | **Ceremony creep at T2** — the cheap floor grows into a T2 wall. | Med · Med | T2 entries are one-line, skim-not-read (consideration, not ceremony); Invariant #4 + ceremony tests in CI. |
| R6 | **Freshness false-positives** — cosmetic FR reword voids a section. | Med · Med | FR-10 binds FR-body bytes deliberately (closes substance-rot); FR-ref present clears the cell. Accepted safe direction. |
| R7 | **Floor depends on unbuilt specs** — SPEC-010 DAG (#121) + SPEC-006 stub scanner are `specifying`. | High · High | FR-9 L4 + FR-11 are explicitly *consumed* dependencies; sequence SPEC-006 + SPEC-010 before those layers are trusted; FR-9 L0-L3 + FR-10 ship independently. |
| R8 | **"Consequences" name collision** with the DR-022 reach axis. | Med · Low | Out-of-scope separates them; this enforces a doc-section heading, never a risk-screen signal. |

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

- **RD-1 — backfill before enabling.** Two-part: (a) Risks onto any DR/spec lacking it; (b) restructure the 25 existing DRs' Consequences prose → ± shape. Lands before/with FR-6 (avoids R2).
- **RD-2 — CLI stdout v1.** Problems-panel parked #118.
- **RD-3 — Consequences policy home = DR-020 addendum.**
- **RD-4 — Consequences shape = minimal ±.**
- **RD-5 — detect → offer-stub, never silent; LLM-drafted content deferred to Slice 2.**
- **RD-6 — cross-cutting complete-last + never latch on presence** (FR-9/10/11, DR-028/029).
- **RD-7 — no trust claim in Slice 1** (DR-029 §6); appendix label = "Self-Audit · read what you want".

## Open questions

- **None blocking.** Sequenced dependencies (not blockers): SPEC-006 hollow-test
  extension (FR-9 L4) and SPEC-010 coverage edge (#121, FR-11) ship before those two
  layers are trusted; the rest of the floor (FR-2/3/4/9 L0-L2/10) is independent.
