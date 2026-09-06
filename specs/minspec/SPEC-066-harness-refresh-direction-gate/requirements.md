---
id: SPEC-066
type: requirements
status: specifying
tier: T4
product: minspec
epic: EPIC-006  # Trust, Consent & Supply Chain — "marker-bounded updates that never surprise-write"
aspects: [data, tier-0, fail-closed, harness-refresh, supply-chain]
relates_to: [DR-090, DR-089, DR-073, DR-011, DR-003, SPEC-043, SPEC-058, SPEC-060, SPEC-063]
# Declared during Specify, deliberately BEFORE approval mints the hash (the SPEC-051
# lesson: declaring after approval forces a post-approval edit that stales the signature).
# `implements:` = created and owned here. The epoch/digest constants, the provenance
# record's read/write path and the verdict function are all new code with no prior owner.
implements: [packages/minspec/src/lib/harness-provenance.ts, packages/minspec/tests/harness-provenance.test.ts, packages/minspec/tests/harness-refresh-direction.test.ts]
# `affects:` = modified but owned elsewhere. Each of these gains a call into the new
# module or a new gate rule; none of them changes ownership.
affects: [packages/minspec/src/lib/scaffold.ts, packages/minspec/src/lib/merge-refresh.ts, packages/minspec/src/lib/auto-bootstrap.ts, packages/minspec/src/commands/init.ts, scripts/validate-frontmatter.ts, .github/workflows/ci.yml]
phases:
  specify: done
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---

# SPEC-066: The harness refresh direction gate

## One-Sentence Scope

Give *MinSpec: Refresh Harness Files* an ordered, content-derived template identity that
travels with the consuming repo, so a refresh run from a bundle whose templates are behind
that repo holds the write and says so, instead of silently reverting the repo to older
content.

## Context

Read DR-090 for the decision and the rejected alternatives; this file specifies what must
be built and how it will be judged. The one-paragraph version:

`refreshHarnessFiles` writes the templates baked into the **running bundle**, with no
notion of newer or older. In `AIClarityAU/sealbox` a refresh from a bundle installed
2026-07-27 rewrote three managed files backwards, deleting the *Coverage DISCLOSURE
(no-silent-gate)* block from `ai-review.yml` (#1095). Nothing caught it: the extension
version string was `0.1.24` on both sides of the three merges it was missing, and the only
content fingerprint MinSpec keeps (`.minspec/template-baseline.json`) is machine-local,
untracked (`scaffold.ts:274-275`), and compared with `!==` (`auto-bootstrap.ts:103-121`) —
it can report *differs*, never *older*. The refresh then re-records that baseline from the
stale bundle (`scaffold.ts:1584`), so the reversion is silent afterwards too.

This is **not** the DR-089 problem wearing a new hat. DR-089's manifest answers *whose
bytes are these?* and answers correctly here — the reverted region was MinSpec's own
output, which is precisely why it was overwritten. Direction is a second, independent
question, and nothing in the codebase asks it today.

### What is already true (verified 2026-09-06, not assumed)

- The Markdown merge's "take the template body" branch is `merge-refresh.ts:953-957`; the
  managed-region splice is `scaffold.ts:952-957` ("Overwrite ONLY the managed region with
  the current template"). Neither consults any notion of template age.
- `computeTemplateBaseline()` (`template-registry.ts:793-812`) already walks the full
  corpus — `TEMPLATES` plus `MANAGED_REGION_TEMPLATES` — so the digest this spec needs has
  an existing, tested source of truth and does not need a new corpus walker.
- `__MINSPEC_BUILD_SHA__` exists (`build-provenance.ts:35-41`, injected by
  `scripts/build-extension.sh:19-34`) but is consumed only for dogfood HEAD-ancestry and a
  status label, and SPEC-060 `INV-3` scopes it to the dogfood workspace by construction. It
  is a diagnostic here, never the ordering key.
- Nothing in a consuming repo records which canonical version its managed files came from:
  `generated-hashes.json` carries a *manifest format* version (`hashVersion`,
  `merge-refresh.ts:1094`), `config.json` a *config schema* version (`config.ts:44`), and
  the managed-region markers carry only a region name (`template-registry.ts:871-894`).
- `minspec-ci-parity` — the downstream job whose remedy text recommends the refresh — is
  **not produced by this repo**. Repo-wide grep finds the name only in prose
  (`SPEC-033/requirements.md:28`, `SPEC-063/requirements.md:49`). Correcting its remedy
  text is a cross-repo follow-up, not work this spec can do.

## Requirements

### FR-1 — The bundle carries an ordered template identity

`TEMPLATE_EPOCH` (a monotone integer) and `TEMPLATE_EPOCH_DIGEST` (a digest over the
rendered template corpus) are source constants in the new module, baked into the bundle
like any other template byte. No build-time injection, no network, no git.

### FR-2 — A gate makes the epoch move when the templates move

A validation rule recomputes the corpus digest and **fails** when it disagrees with
`TEMPLATE_EPOCH_DIGEST`, naming the remedy (bump the epoch, re-record the digest). One
implementation, called from both `npm run validate` and CI — never two copies that can
drift (the Rule 12 / Goal G-6 pattern at `validate-frontmatter.ts:522-557`).

### FR-3 — The provenance record is tracked and travels

`.minspec/harness-provenance.json`, holding `templateEpoch` (load-bearing) plus
`writtenBy.version`, `writtenBy.buildSha` and `writtenAt` (diagnostic only). It is **not**
added to `MINSPEC_GITIGNORE_ENTRIES` and is not untracked by
`untrackDeclaredMachineLocalPaths`.

### FR-4 — Four verdicts, two of which hold the write

`ahead` and `level` write as today (still subject to DR-089 authorship). `behind` and
`unknown` write nothing that would change managed content. The verdict is computed once
per refresh and applied at both write paths.

### FR-5 — A refusal is visible, specific and actionable

The refusal names every held path, both epochs, and the action that resolves it (update
the extension for `behind`; a listed, confirmed override for `unknown`). It is never a
silent skip and never a warning followed by the write.

### FR-6 — The override is a human act on a visible list

Offered only by the interactive command, only for `unknown`, and only after listing the
files whose managed content would change. The auto-bootstrap refresh trigger
(`auto-bootstrap.ts:482-497`) reports and stops; it may not take the override.

### FR-7 — A held refresh does not re-stamp the drift baseline

When any path was held, `saveTemplateBaseline` (`scaffold.ts:1584`) does not record the
running bundle's hashes for the held entries, so `hasHarnessDrift` keeps reading true and
the hold stays observable until it is resolved.

### FR-8 — Creation is never a backwards write

Scaffolding a missing file (`scaffold.ts:1549-1552`, `:926-930`) and appending a heading
absent from disk (`merge-refresh.ts:959-963`) are exempt from the direction gate. First
adoption of MinSpec in a new repo is unaffected by every requirement above.

### FR-9 — Tier 0 throughout

No network call, no git invocation, and no filesystem read outside the workspace on any
path in this spec. The gate must produce the same verdict on an air-gapped machine.

## Invariants

- **INV-1 — A refresh never replaces existing MinSpec-owned content with content it cannot
  show is at least as new.** This is the whole spec in one line; every FR serves it.
- **INV-2 — Unknown fails closed.** Absent, unreadable or unrecognised provenance is
  treated exactly as `behind`. (DR-089 §2; the fail-open direction is the one that
  destroyed data.)
- **INV-3 — The direction gate is additive to DR-089's authorship gate, never a
  replacement.** A write must satisfy both. No branch may reach a write by passing the
  direction check alone.
- **INV-4 — The epoch cannot silently fail to move.** A template corpus change with no
  epoch bump fails a required check on at least two independent surfaces (local validate
  and CI), per constitution invariant 2.
- **INV-5 — No network, ever, on this path** (constitution invariant 1, DR-004 Tier 0).
- **INV-6 — Nothing here changes behaviour in a repo without `.minspec/`**
  (constitution invariant 3).

## Acceptance Criteria

- [ ] **A stale bundle cannot revert a repo** — a refresh whose bundle epoch is below the
      repo's recorded epoch leaves every managed file byte-identical, and the sealbox
      scenario (a managed region containing a block the bundle's template lacks) is a
      regression test that fails against today's code. (FR-4, INV-1)
- [ ] **The refusal is legible** — the report names each held path and both epochs, and a
      reader who has never seen this feature can act on it without opening the source.
      (FR-5)
- [ ] **A newer bundle still updates** — `ahead` and `level` refreshes behave exactly as
      today, including every DR-089 authorship preservation case. (FR-4, INV-3)
- [ ] **First adoption is untouched** — scaffolding a repo that has no `.minspec/` and no
      provenance record writes every harness file with no prompt and no hold. (FR-8)
- [ ] **Unknown provenance holds, then resolves once** — a repo with no record holds on
      first refresh, and after one confirmed override carries a record that makes every
      later refresh ordinary. (FR-4, FR-6, INV-2)
- [ ] **Auto-bootstrap cannot override** — the background refresh trigger reports the hold
      and writes nothing, with no confirmation surface reachable from it. (FR-6)
- [ ] **The hold stays visible** — after a held refresh, the drift signal still reads true
      for the held entries. (FR-7)
- [ ] **The epoch gate is real on both surfaces** — editing any template body without
      bumping the epoch fails `npm run validate` **and** fails CI, each proven by a test
      that reddens against an unbumped corpus. (FR-2, INV-4)
- [ ] **Tier 0 holds** — the full gate produces its verdict with no network and no git
      subprocess, proven by a test that would fail if either were invoked. (FR-9, INV-5)

## Open Questions (Clarify)

Each carries a recommendation and the cost of taking it, per the project's decision rule.

- **DQ-1 — Does the epoch gate also block packaging?** Recommend **yes** — the package
  script refuses a bundle whose digest and epoch disagree, because that is the last moment
  before the artifact reaches a consuming repo. *Cost:* a third enforcement site for one
  rule, and DR-077 is this repo's record of how expensive twinned enforcement is to keep
  honest; it must call the same function, not restate it.
- **DQ-2 — Is the `unknown` override persisted (per repo, once) or per invocation?**
  Recommend **persisted**, by writing the provenance record as part of the override.
  *Cost:* the human's one confirmation silences the question forever, including for a
  later reversion they would have wanted to see — so the confirmation text has to carry
  its own weight.
- **DQ-3 — At what granularity does `behind` hold?** Recommend **per write target** — hold
  only the paths whose managed content would actually change, and let byte-identical
  targets proceed silently. *Cost:* a partially-applied refresh is a state neither the
  report nor the drift baseline currently models cleanly.
- **DQ-4 — Does the epoch bump by one, or take the value of something else** (a release
  count, a date-derived integer)? Recommend **plain increment by one**. *Cost:* it carries
  no information beyond order, so a human reading `42` learns nothing about when or why —
  the diagnostic fields in the record exist to cover that.
- **DQ-5 — Does the record's absence in an existing adopter get a migration path** other
  than the override — e.g. a one-time write of the current epoch by any bundle that finds
  a repo whose managed files are byte-identical to its own templates? Recommend **no** for
  the first version. *Cost:* every adopter takes the override once, which is friction on a
  path that used to be one click.

## Out of Scope

- **An opt-in "newer templates exist" check** that reaches the network. Named in DR-090's
  Alternatives; it needs its own consent surface and its own record.
- **Widening SPEC-060** to consumer workspaces. Its `INV-3` scopes it to the dogfood
  workspace deliberately; this spec introduces a separate identity that needs no git,
  precisely so that scope can stand.
- **Correcting the downstream `minspec-ci-parity` remedy text.** That job lives in a
  consuming repo, not here (see Context).
- **Protecting a repo from bundles built before this feature.** An older bundle ignores a
  record it predates; nothing in this spec can change that, and DR-090's Consequences say
  so rather than implying otherwise.

## Risks

| Risk | Mechanism | Mitigation |
|---|---|---|
| Every existing adopter's next refresh holds | `unknown` fails closed by design (INV-2) | One confirmed override per repo, with the changed-file list in front of the human (FR-6); DQ-5 records that no softer migration was taken and why |
| A bundle packaged from an unmerged branch bumps the epoch past main's and is ordered ahead | The epoch is a source constant, so a branch can set it to anything | A duplicate-epoch check at merge, modelled on `.github/workflows/dr-id-collision.yml`; accepted as residual in DR-090 — packaging an unmerged branch is a visible act, not staleness |
| The epoch gate is added but one surface is inert | A hook-only gate is disabled by a `core.hooksPath` gap — the exact shape constitution invariant 2 forbids | Two witnesses, one implementation (FR-2, INV-4), each proven red by its own test (AC) |
| A tracked file in `.minspec/` conflicts on branches | Two branches both refresh and both stamp | The record changes only when the epoch changes — at most once per template release, not once per refresh (DR-090 §3) |
| The direction gate is bolted in front of the authorship gate and quietly weakens it | Two gates over one write path invite an "either/or" refactor | INV-3 states the conjunction explicitly, and the DR-089 preservation cases stay in the acceptance set |
