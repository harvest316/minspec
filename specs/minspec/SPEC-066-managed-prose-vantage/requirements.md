---
id: SPEC-066
type: requirements
status: specifying
tier: T3
product: minspec
epic: EPIC-002  # Signpost Integrity — a shipped file asserting a false fact is a false signpost
aspects: [managed-files, harness, portability, downstream, gate, prose, tier-0]
relates_to: [DR-090, DR-011, DR-037, DR-051, SPEC-033, SPEC-043]
# Declared during Specify, deliberately BEFORE any approval mints a hash (SPEC-051's
# lesson: declaring after approval stales the signature the human just gave).
# This spec CREATES the vantage gate and its pure helper — it owns those two files.
implements: [packages/minspec/src/lib/prose-vantage.ts, packages/minspec/tests/managed-prose-vantage.test.ts]
# `affects:` = modified but owned elsewhere. The registry, the portability suite, the
# generated embed, and the seven managed files whose prose is repaired.
affects: [packages/minspec/src/lib/template-registry.ts, packages/minspec/src/lib/ci-review-templates.ts, packages/minspec/tests/managed-region-templates.test.ts, scripts/hooks/canonical.py, scripts/lib/agent-context.sh, scripts/roles/reviewer.md, scripts/roles/security.md, scripts/roles/architect.md, scripts/roles/skeptic.md, .github/workflows/docs-lane.yml]
phases:
  specify: done
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---

# SPEC-066: Managed prose is true in the repo that receives it

## One-Sentence Scope

Make every factual claim in the bytes MinSpec scaffolds into another repo either true
there or explicitly attributed to the minspec repo, enforced by a gate that reads the
shipped bytes and cannot be silenced by an exception list.

## Context

DR-090 records the decision and the measurement; this spec is its materialization. The
short form: managed files are held byte-identical by construction, so a false sentence
inside one **cannot be corrected downstream** — an adopter's fix drifts the file and the
next *Refresh Harness Files* overwrites it. Seven such sentences are shipping today
(DR-090 §Context table), the worst of them asserting *coverage* — a test or gate that the
receiving repo does not have.

Triggered by #1108, itself raised by the skeptic voter on AIClarityAU/sealbox#32 reading
`scripts/hooks/canonical.py:4-7`.

Two prior gates bound the same drift class from other angles and are extended, never
replaced: `managed-script-dependencies` (#1098 — a managed script may only invoke managed
files) and `machinery-comment-localization` (#1486 — one hand-written comment rewrite for
`ai-review.yml`).

## Functional Requirements

**FR-1 — Shipped bytes are the subject.** The gate reads `renderManagedFile(tpl)` for
every entry in `MANAGED_REGION_TEMPLATES` — the bytes an adopter receives, including the
preamble and managed-region markers, and **after** any `localize` rewrite. Reading the
on-disk source instead would pass `ai-review.yml`'s localized block for the wrong reason.

**FR-2 — Prose only, never executable text.** A reference the file *executes* is a runtime
dependency and belongs to #1098's gate; this gate judges only text a human reads:

- hash-comment lines (`commentStyle: 'hash'`),
- `//` and `/* … */` comments (`'slash'`),
- the entire body of a Markdown template (`'html'`),
- **and Python triple-quoted string blocks**, which is where the originating instance
  lives (`canonical.py`'s module docstring is not a `#` comment). A gate that skipped
  docstrings would pass #1108 while claiming to close it.

**FR-3 — Foreign-reference detection.** Within that prose, a token is a *reference* when it
is either a directory-qualified path (`a/b.ext`) or a bare source filename with a code
extension (`.ts .tsx .py .sh .mjs .js .yml .yaml .json`). A reference is *foreign* when the
managed set does not put that file in the adopter's repo (FR-4). Bare `.md` filenames are
NOT references — `README.md` names no MinSpec artifact and would be a pure false positive.

**FR-4 — The universal set is derived, never enumerated.** The set of files an adopter is
known to have = the paths produced by actually scaffolding into an empty temp directory
(`scaffold()` + `generateHarnessFiles()` with every tool detected), walked from disk. An
enumeration here would re-import the exact drift the gate exists to catch (#1098's root
cause). Bare filenames resolve by basename against that same set.

**FR-5 — Placeholders are not claims.** A token containing a placeholder segment
(`NNN`, `${…}`, `<…>`, `X` in `roles/X.md`) refers to no particular file and is skipped.
`docs/decisions/DR-NNN.md` is a template, not an assertion.

**FR-6 — Attribution is the only escape.** A foreign reference passes when its enclosing
prose block — the contiguous run of comment/docstring lines, or the Markdown paragraph —
matches the case-insensitive pattern `minspec(?:'s own)? repo`. There is no allowlist,
no `// vantage-ok` pragma, and no per-template exception table: the cheapest way to make
the gate green is to write the attributing words, which is also the fix.

**FR-7 — `localize` becomes a registry field.** `ManagedRegionTemplate` gains an optional
`localize?: (src: string) => string`, applied when the template's content is built.
`localizeMachineryPathsComment` moves onto its entry unchanged. The portability suite
reads the hook from the registry rather than from its own `CI_STACK` table
(`managed-region-templates.test.ts:317`), removing a second enumeration of the same set.

**FR-8 — Every `localize` keeps #1486's safety properties.** It throws (never silently
no-ops) when its anchor block is absent, and it re-asserts that the upstream string is gone
from its own output. A silent no-op re-ships the false claim, which is the failure being
fixed.

**FR-9 — The seven known instances are repaired now.** Option 1 of #1108 applied to the
measured corpus (see AC-4). Attribution is the default repair; `localize` is used only
where the upstream wording would be noise in an adopter's repo.

**FR-10 — The rule ships to the reviewers.** `scripts/roles/skeptic.md` and
`scripts/roles/architect.md` — themselves managed — state the vantage rule, so the standard
travels to every repo whose PRs those voters review and the residual (FR-11) has a human
backstop.

**FR-11 — The residual is documented, not hidden.** A claim carrying no path token
("INV-2 asserts …") is undetectable by this gate. The gate's own header states that limit;
no artifact may describe this spec as closing the class. An LLM prose-claim voter is out of
scope (see Out of scope).

## Invariants

**INV-1 — Fail closed and visibly.** The gate is an ordinary vitest suite in the `test`
required check. It fails on any unattributed foreign reference; it never warns-and-passes.
(Constitution invariant 2 — no silent gate.)

**INV-2 — Never vacuous.** The suite asserts, before any pass/fail assertion, that the
extractor actually yields references from the known instances — specifically ≥1 reference
from `canonical.py`'s module docstring and ≥1 from a role Markdown template. A regex that
silently matches nothing would otherwise render every assertion green
(`f-test-can-pass`: exit-code assertions go green without the feature).

**INV-3 — Positive control.** The suite feeds a synthetic template containing an
unattributed foreign reference through the same code path and asserts it is REJECTED, and
the same text with the attributing clause and asserts it PASSES. Both directions, or the
gate is only proven in the direction that already holds.

**INV-4 — Tier 0.** Pure filesystem + string work: no network, no `vscode` import in the
helper module, so it runs in CI, in a hook, and offline (constitution invariant 1).

**INV-5 — The gate reads what ships.** If `renderManagedFile` changes shape, the gate
follows it; the suite never re-implements rendering. (`f-fixt-can-enco`: a fixture that
encodes an assumption goes green while the real path is unguarded.)

**INV-6 — No exception register may be added later.** Adding one is a decision that
reverses DR-090 §3 and requires a superseding DR, not a code review.

## Contract

```ts
// packages/minspec/src/lib/prose-vantage.ts — pure, tier-0, no vscode import.

/** Which text in a managed file is prose (FR-2), keyed by the registry's own field. */
export type CommentStyle = 'hash' | 'slash' | 'html';

export interface ProseRef {
  /** The reference exactly as written. */
  readonly token: string;
  /** 1-based line within the SHIPPED bytes (FR-1), for an actionable failure message. */
  readonly line: number;
  /** Resolved repo-relative path for a qualified token; the bare name otherwise. */
  readonly resolved: string;
  /** True when the enclosing prose block carries an upstream attribution (FR-6). */
  readonly attributed: boolean;
}

/** Every path-shaped token in the file's PROSE (FR-2/FR-3/FR-5). Never throws. */
export function extractProseRefs(shipped: string, style: CommentStyle): ProseRef[];

/**
 * The subset that names a file the adopter does not get and does not attribute it
 * (FR-3/FR-4/FR-6) — i.e. the gate's failures. `universal` is the DERIVED set from
 * FR-4; passing an enumeration is a caller bug the gate cannot detect, which is why
 * the suite builds it by scaffolding.
 */
export function unattributedForeignRefs(
  shipped: string,
  style: CommentStyle,
  universal: ReadonlySet<string>,
): ProseRef[];
```

```ts
// packages/minspec/src/lib/template-registry.ts — FR-7 addition (shape only).
export interface ManagedRegionTemplate {
  // … existing fields unchanged …
  /**
   * Comment-only rewrite applied on the way out, for a block whose upstream wording
   * must not ship (DR-090 §4). MUST throw rather than no-op when its anchor is gone.
   */
  readonly localize?: (src: string) => string;
}
```

## File Allowlist

Creates: `packages/minspec/src/lib/prose-vantage.ts`,
`packages/minspec/tests/managed-prose-vantage.test.ts`.

Modifies: `packages/minspec/src/lib/template-registry.ts`,
`packages/minspec/tests/managed-region-templates.test.ts`,
`packages/minspec/src/lib/ci-review-templates.ts` (generated — see AC-6),
`scripts/hooks/canonical.py`, `scripts/lib/agent-context.sh`,
`scripts/roles/{reviewer,security,architect,skeptic}.md`,
`.github/workflows/docs-lane.yml`.

Out of allowlist: `.minspec/hooks/*`, the review workflows other than `docs-lane.yml`,
and `scripts/gen-ci-templates.mjs` — none needs to change for this spec.

## Acceptance Criteria

**AC-1** — `managed-prose-vantage.test.ts` fails on `main` before the FR-9 repairs land
(≥7 findings, one per DR-090 table row) and passes after them. Proven by running it against
the pre-repair tree, not asserted.

**AC-2** — The suite's anti-vacuity assertions (INV-2) and both positive controls (INV-3)
are present and independently meaningful: deleting the detection logic must fail INV-3's
reject case, and breaking the extractor must fail INV-2.

**AC-3** — Adding a new managed template whose prose names an unscaffolded sibling fails
the suite with a message naming the template, the line, and the token.

**AC-4** — Each measured instance is repaired and its shipped text is true from a consumer's
vantage:

| File | What must become true |
|---|---|
| `scripts/hooks/canonical.py:4-7` | Node twin, `spec-gate.py` and the corpus-parity test are named as **the minspec repo's**, and the docstring no longer implies a local guard |
| `scripts/roles/reviewer.md:34-40` | vendor-provenance block attributed or localized away |
| `scripts/roles/security.md:34-40` | same |
| `scripts/roles/architect.md:34-40` | same |
| `scripts/roles/skeptic.md:52` | same |
| `scripts/lib/agent-context.sh:61` | "Enforced by …" no longer claims a test the adopter has |
| `.github/workflows/docs-lane.yml:50-52` | byte-identity claim attributed to the minspec repo |

**AC-5** — `localize` is read from the registry by the portability suite; removing an entry's
`localize` makes that suite fail rather than silently comparing raw bytes.

**AC-6** — `node scripts/gen-ci-templates.mjs` is re-run after the source edits and
`npm run validate` (which runs the staleness check) is green, so the embedded copies match.

**AC-7** — `npm test`, `npm run lint`, `npm run validate` all green.

## Tests to Pass

- `packages/minspec/tests/managed-prose-vantage.test.ts` (new — AC-1/2/3/4)
- `packages/minspec/tests/managed-region-templates.test.ts` (AC-5, portability unchanged)
- `packages/minspec/tests/machinery-comment-localization.test.ts` (#1486 still holds after FR-7)
- `packages/minspec/tests/managed-script-dependencies.test.ts` (#1098 unaffected)

## Open Questions

**OQ-1** — Should the attribution pattern be exactly `minspec(?:'s own)? repo`, or a slightly
wider closed set? Wider reads better in prose; wider is also a vocabulary that drifts.
Resolve in Clarify by counting how many of the seven repairs read badly under the narrow
form. *Recommendation: keep the narrow form* — cost: two or three sentences will read a
little stiffly.

**OQ-2** — `scripts/gen-ci-templates.mjs`'s `SOURCES` is a third enumeration of the managed
set (its header says it "Mirrors CI_STACK"). FR-7 removes one duplicate; should this spec
also derive `SOURCES` from the registry? *Recommendation: no* — out of scope here, and the
generator is already gated by the staleness check. Cost: the third enumeration survives, so
a future template can still be added to the registry and forgotten in the generator.

**OQ-3** — Does the gate belong in `npm run validate` (commit/PR-time, alongside the other
managed-file rules) as well as in vitest? *Recommendation: vitest only for now* — cost: the
failure surfaces at PR time rather than at commit time.

## Out of Scope

- **An LLM prose-claim voter.** The residual in FR-11 (claims with no path token) would need
  a judge, not a matcher. That puts a non-deterministic decision on a blocking path and needs
  its own DR (DR-090 §Consequences).
- **Auditing non-managed files.** A false comment in `packages/**` is an ordinary bug; only
  the shipped set has the "cannot be fixed downstream" property.
- **Re-litigating #1098 or #1486.** Both stand.

## Follow-ups (tracked)

- **#1108** — closed by this spec's implementation.
- **DR-090** — the decision this materializes; `proposed`, awaiting *MinSpec: Accept ADR*.
- Nothing is deferred as prose. OQ-2 and OQ-3 are resolved in Clarify inside this spec; if
  either resolves to "yes", it stays in this spec's scope rather than becoming an unfiled
  intention.
