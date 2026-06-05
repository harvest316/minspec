---
id: SPEC-011
type: requirements
tier: T3
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: implementing  # built: epic-backfill.ts (478 lines, both engines) + 40 tests pass (epic-backfill.test.ts 16 + epic-backfill-extra.test.ts 24); command minspec.backfillEpics wired
product: minspec
epic: EPIC-001  # Explorer Epic Grouping
---

# MinSpec — AI-assisted Epic Backfill (Requirements)

**Date:** 2026-05-31
**Status:** Implementing
**Decision:** [DR-016](../../../docs/decisions/DR-016.md)
**Triggered by:** session request — "offer to backfill epics during onboarding, intelligently guessing the epics list then the mappings, via `claude -p`."

---

## Context

DR-013 shipped registered epics; existing artifacts carry no `epic:` ref.
Backfill proposes an epic taxonomy + artifact→epic mapping and offers to apply
it. Two engines: a Tier-0 heuristic (air-gapped) and a Tier-1 `claude -p` AI pass
(opt-in). HITL review before any write. DR-004 already permits the `claude -p`
delegation as Tier 1 — no invariant change.

## Requirements

- **FR-1 (proposal contract).** Both engines return one `BackfillProposal`:
  candidate epics (`slug`, `title`, optional existing `id`, `rationale`) +
  mappings (`artifactId`, `kind: 'spec'|'adr'`, `filePath`, `epicSlug`,
  `confidence`, `rationale`). `source: 'heuristic'|'ai'`.
- **FR-2 (heuristic engine, Tier 0).** Pure file-system. Cluster specs/ADRs by:
  spec-kit subdir name, shared title/tag token overlap (reuse the
  `findSimilarAdrs` Jaccard tokenizer), and existing `epic:` refs. No `claude`,
  no network. Always available.
- **FR-3 (AI engine, Tier 1).** Shell `claude -p` (via `execFile`, mirroring the
  `gh` pattern) with an artifact digest + strict JSON-only schema instruction.
  Parse + validate into `BackfillProposal`. MUST check `claude` availability
  first (mirror `isGhAvailable`).
- **FR-4 (graceful degradation).** `claude` absent / non-JSON output / timeout /
  non-zero exit → fall back to the heuristic proposal. NEVER throw to the user;
  NEVER block.
- **FR-5 (HITL review).** Apply nothing without explicit user approval. Surface
  the proposal (epics + mappings + rationale) for review; a modal confirm gates
  `applyBackfill`.
- **FR-6 (apply).** On approval: create new EPIC-NNN files (via `createEpic`),
  insert `epic:` frontmatter into each mapped artifact, regenerate the epic
  INDEX. Idempotent. Artifacts already carrying an `epic:` are skipped unless the
  user opts to override.
- **FR-7 (frontmatter insert).** A generic `setArtifactEpic(filePath, ref)` adds
  or replaces the `epic:` line inside an existing frontmatter block without
  disturbing other content (mirror `setAdrStatus`). Throws only on a file with no
  frontmatter block.
- **FR-8 (onboarding offer).** `auto-bootstrap` gains `hasUnbackfilledEpics()` +
  an offer step. The offer surfaces during the existing detect-and-offer flow;
  the `claude -p` call runs ONLY on explicit action. First-run stays Tier 0.
- **FR-9 (command).** `minspec.backfillEpics`: build heuristic proposal; if
  `claude` available, offer the AI-enhanced pass; review; apply; refresh panels.

## Costly to Refactor (Zone A)

Seams that are expensive to change after artifacts have been backfilled — ranked.

1. **`BackfillProposal` shape (FR-1).** The single contract both engines return and
   the review/apply path consumes. Both `epic-backfill.ts` engines, the review
   surface (FR-5), and `applyBackfill` (FR-6) bind to its fields (`slug`, `id`,
   `mappings[].confidence`, `source`). Changing a field name or the `kind:
   'spec'|'adr'` union ripples through every consumer.
2. **`epic:` frontmatter line format written by `setArtifactEpic` (FR-7).** Once
   backfill stamps `epic: EPIC-NNN` into live specs/ADRs, the on-disk shape is what
   the validator and explorer read. Reformatting it later (e.g. list vs scalar)
   means a migration over every already-mapped artifact, not a code edit.
3. **EPIC-NNN id allocation in `applyBackfill` / `createEpic` (FR-6).** Numbers are
   permanent once written into frontmatter and the epic INDEX. A change to the
   allocation scheme (gaps, slugs-as-ids) strands existing `epic:` refs.
4. **Heuristic clustering signals (FR-2).** Reusing the `findSimilarAdrs` Jaccard
   tokenizer fixes the Tier-0 grouping semantics; swapping the similarity basis
   re-partitions taxonomies users have already accepted, silently invalidating
   prior groupings. Lower cost than 1-3 (proposal-time only, pre-apply) but still
   re-trains user expectations.

## Invariants (must hold)

- **INV — DR-004 tiering.** Core stays Tier 0: no network/`http`/`fetch` in the
  extension. AI is Tier-1 delegation to the local `claude` binary only; the
  extension makes zero outbound connections. Heuristic engine + apply are pure
  file-system.
- **INV — graceful degradation (DR-004 Tier 1).** Every Tier-1 path degrades to a
  Tier-0 result when `claude` is absent. The feature is never a hard dependency.
- **INV — HITL (DR-012 ethos).** No frontmatter write without explicit approval.
  No silent mass-rewrite.
- **INV #6 (markers).** Regenerated epic INDEX writes only inside MinSpec markers.
- **INV (ceremony ∝ complexity).** Backfill is opt-in; never runs unprompted.

## Acceptance Criteria (Zone A)

Definition of done — each traces an FR / invariant.

- [ ] Both engines return an identical-shaped `BackfillProposal`; `source` is
  `'heuristic'` or `'ai'` accordingly (FR-1).
- [ ] Heuristic engine runs with `claude` absent and the network unreachable —
  zero outbound connections (FR-2, INV DR-004 tiering).
- [ ] AI engine checks `claude` availability (mirroring `isGhAvailable`) before any
  `execFile` of `claude -p`; absence routes to heuristic, never an error (FR-3,
  FR-4, INV graceful degradation).
- [ ] `claude` non-JSON / timeout / non-zero exit falls back to the heuristic
  proposal and never throws to the user or blocks (FR-4).
- [ ] No `epic:` frontmatter is written until an explicit modal confirm fires (FR-5,
  INV HITL).
- [ ] `applyBackfill` is idempotent: re-running over already-mapped artifacts is a
  no-op unless the user opts to override; artifacts with an existing `epic:` are
  skipped by default (FR-6).
- [ ] `setArtifactEpic` adds/replaces only the `epic:` line, leaves other
  frontmatter untouched, and throws only when no frontmatter block exists (FR-7).
- [ ] Regenerated epic INDEX writes only between MinSpec markers (FR-6, INV #6).
- [ ] `hasUnbackfilledEpics()` gates the onboarding offer; the `claude -p` pass runs
  only on explicit action and first-run stays Tier 0 (FR-8, INV ceremony ∝
  complexity).
- [ ] `minspec.backfillEpics` builds the heuristic proposal, offers the AI pass when
  `claude` is present, reviews, applies, and refreshes panels (FR-9).

## Risks & Mitigations

| # | Risk | Likelihood . Impact | Mitigation |
|---|------|---------------------|------------|
| 1 | `claude -p` emits prose-wrapped or truncated JSON; parse fails after the user opted into the AI pass (FR-3) | Med . Med | Strict JSON-only schema instruction + parse/validate into `BackfillProposal`; any failure degrades to the heuristic proposal (FR-4) |
| 2 | `setArtifactEpic` corrupts a frontmatter block while inserting `epic:` on an artifact with unusual YAML (FR-7) | Low . High | Mirror the proven `setAdrStatus` line-replace; throw (not silently rewrite) when no frontmatter block exists; HITL preview before write (FR-5) |
| 3 | Apply double-stamps or skips artifacts on re-run, producing duplicate/missing `epic:` refs (FR-6) | Med . Med | Idempotent apply; skip artifacts already carrying `epic:` unless override chosen |
| 4 | AI proposal invents EPIC slugs that collide with DR-013 registered epics (FR-1, FR-6) | Low . Med | Candidate epics carry optional existing `id`; `createEpic` allocates only genuinely-new EPIC-NNN, reuses matched ids |
| 5 | Onboarding offer fires the `claude -p` call unprompted, breaking the Tier-0 first-run guarantee (FR-8) | Low . High | Offer is detect-only; the AI call runs ONLY on explicit action (INV ceremony ∝ complexity, INV graceful degradation) |

## Consequences

**Positive:**
- Existing specs/ADRs created before DR-013 gain `epic:` refs without manual
  hand-editing, unblocking Explorer epic grouping (Context).
- The Tier-0 heuristic (FR-2) gives every user a usable proposal with no `claude`
  dependency, preserving the air-gapped core (INV DR-004 tiering).

**Negative:**
- A second permanent on-disk surface (`epic:` lines stamped by FR-7) now exists in
  live artifacts — see "Costly to Refactor" #2; reformatting it later is a
  migration, not a code change.
- The AI pass adds a `claude -p` shell-out path (FR-3) that must be kept in lock-step
  with the heuristic engine's `BackfillProposal` shape, doubling the maintenance
  surface for the contract.

## Assumptions

- A locally-installed `claude` binary is invokable via `execFile` the same way `gh`
  is (FR-3 mirrors the `gh`/`isGhAvailable` pattern); when absent, FR-4 covers it.
- DR-013's registered-epic model (EPIC-NNN files + epic INDEX) is the canonical
  target; backfill writes into that model, it does not redefine it.
- Specs/ADRs each have a parseable frontmatter block for `setArtifactEpic` to edit
  (FR-7); a block-less file is an error case, not the norm.

## Test-thought

Verified by the 15 passing tests over `epic-backfill.ts` (both engines): the
heuristic engine produces a valid `BackfillProposal` offline, the AI path falls back
to it on absent/garbage `claude` output, and `setArtifactEpic` round-trips an `epic:`
line without disturbing sibling frontmatter.

## Failure-Modes / Edge-Cases

1. **`claude` present but returns non-JSON / truncated output (FR-3, FR-4).** Parse
   fails → degrade to heuristic proposal; never surface the raw error.
2. **`claude` hangs.** `execFile` timeout → treat as failure, fall back (FR-4).
3. **Artifact already carries `epic:` (FR-6).** Skipped by default; only the explicit
   override path re-stamps it.
4. **Artifact has no frontmatter block (FR-7).** `setArtifactEpic` throws rather than
   inventing a block — the one permitted throw.
5. **AI proposes a slug matching an existing registered epic (FR-1).** Reuse the
   existing `id`; do not allocate a duplicate EPIC-NNN.
6. **User declines at the modal confirm (FR-5).** Zero writes; proposal discarded.

## Test / Verification Strategy

| FR | Tier | Assertion sketch |
|----|------|------------------|
| FR-1 | T1 (contract) | Both engines' output validates against the `BackfillProposal` shape; `source` matches engine |
| FR-2 | T0 (invariant) | Heuristic run with no `claude` + network stubbed unreachable makes zero outbound calls; clusters match Jaccard groupings |
| FR-3 | T2 (feature) | Mock `claude -p` returns valid JSON → parses into a proposal; availability checked first |
| FR-4 | T0 (invariant) | absent/non-JSON/timeout/non-zero `claude` each return the heuristic proposal and never throw |
| FR-5 | T0 (invariant) | No file write occurs unless the modal confirm resolves true |
| FR-6 | T2 (feature) | Re-running apply over a mapped artifact is a no-op; new EPIC-NNN created once; INDEX regenerated |
| FR-7 | T1 (contract) | `setArtifactEpic` replaces/adds only the `epic:` line; throws on a block-less file |
| FR-8 | T2 (feature) | `hasUnbackfilledEpics()` true ⇒ offer shown; AI call fires only on explicit action |
| FR-9 | T2 (feature) | `minspec.backfillEpics` end-to-end: heuristic → optional AI → review → apply → panel refresh |

## Alternatives Considered

- **Multi-model / provider abstraction (rejected).** Supporting OpenAI/etc. behind a
  provider interface — rejected for v1: `claude -p` only keeps the Tier-1 surface
  minimal and matches DR-004's local-binary delegation (see Out of scope).
- **Auto-apply without review (rejected).** Skipping the modal confirm would violate
  INV HITL (DR-012 ethos); a silent mass-rewrite is exactly the failure HITL exists
  to prevent.
- **Editable markdown proposal vs read-only preview + modal (deferred).** Inline
  editing is richer but heavier; v1 ships read-only preview + confirm (OQ-1),
  deferring inline edit.

## Coverage Map

| Mechanism / concern | FR(s) |
|---------------------|-------|
| Unified proposal contract | FR-1 |
| Offline heuristic grouping | FR-2 |
| AI-enhanced pass via `claude -p` | FR-3 |
| Graceful degradation / never-block | FR-4 |
| HITL approval gate | FR-5 |
| Idempotent apply + INDEX regen | FR-6 |
| Safe frontmatter `epic:` insert | FR-7 |
| Onboarding detect-and-offer | FR-8 |
| User-facing command wiring | FR-9 |

## Follow-ups (tracked)

- Inline-editable proposal surface — tracked as OQ-1 (review surface); v1 ships the
  read-only preview + modal confirm chosen there (FR-5), inline edit deferred. Tracked
  in-spec as an open question, not yet a GitHub issue (no cross-repo work surfaced).
- Backfilling issue epic labels / GitHub writes — explicitly out of scope for v1
  (see Out of scope); revisit only if demand surfaces.
- AI prompt-size strategy is tracked as OQ-2 (digest vs full prose for `proposeAI`,
  FR-3); resolve at plan-time, no separate follow-up needed. No other follow-up
  distinct from OQ-1, OQ-2, and the Out-of-scope list.

## Out of scope

- Backfilling **issue** epic labels (GitHub writes) — specs/ADRs only in v1.
  (Issues already self-serve via the `epic:<slug>` label.)
- Re-running AI to *critique* an existing taxonomy.
- Auto-apply without review; bidirectional sync; weighted confidence tuning.
- Multi-model / provider choice — `claude -p` only (the locally-installed binary).

## Open questions

- **OQ-1 — review surface.** Modal summary + confirm (simplest) vs. an editable
  generated markdown proposal the user tweaks before apply. Proposed: generated
  markdown preview opened read-only + modal confirm for v1; inline editing later.
- **OQ-2 — AI prompt size.** Full prose vs. title+first-paragraph digest. Proposed:
  digest (id, kind, title, first non-empty paragraph) to bound token cost.
