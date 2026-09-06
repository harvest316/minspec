---
id: SPEC-066
type: requirements
# 🔒 Once approved, hash-locked: the approved bytes are recorded in the per-file sidecar
# .minspec/approvals/specs/minspec/SPEC-066-approval-record-deterministic-witness/requirements.md.json
# (.specHash). `status`/`phases` are tool-written lifecycle mirrors (canonical.ts:60-83 strips
# exactly those two from the hash); never hand-write either. Every OTHER frontmatter field —
# including `implements:`/`affects:` below — IS hashed, so adding one after approval voids the
# signature (SPEC-051's recorded trap). They are therefore declared NOW, before any approval.
status: specifying
tier: T4
product: minspec
epic: EPIC-006  # Trust, Consent & Supply Chain — same epic as DR-081, the accepted decision this contracts
aspects: [ai-review, approval, ci, gate-integrity, fail-closed, cost, never-wrong, tier-0]
relates_to: [DR-081, DR-047, DR-033, DR-034, DR-063, DR-076, SPEC-031, SPEC-050, SPEC-022, SPEC-054, SPEC-065]
# NEW files this spec creates and therefore OWNS (SPEC-038). `.github/workflows/ai-review.yml`
# is owned by SPEC-031 (`implements:` at SPEC-031 requirements.md:11) — this spec MODIFIES it,
# so it belongs under `affects:`, never here. One owner per file.
implements: [.github/workflows/approval-integrity.yml, .github/scripts/approval-record-pr.js, .github/scripts/approval-record-pr.test.js]
# Modified but owned (or unowned) elsewhere. approval-provenance.py exists today as an ADVISORY
# fact emitter (see FR-4); this spec gives it a gate mode. ai-review.yml → SPEC-031 implements:.
# ready-to-merge.yml, ai-review-guard.js, ci.yml, approval-provenance.py carry no declared owner
# in the corpus — this spec edits them without claiming them.
affects: [.github/workflows/ai-review.yml, .github/workflows/ready-to-merge.yml, .github/workflows/ci.yml, .github/scripts/ai-review-guard.js, scripts/approval-provenance.py]
phases:
  specify: in-progress
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---

# MinSpec — An approval-record PR is settled by a deterministic witness, not by a four-voter LLM panel (Requirements)

> Contracts **[DR-081](../../../docs/decisions/DR-081.md)** §3–§5 — *accepted 2026-08-07* — which
> already decided that an approval-record PR self-exempts from `ai-review` behind a deterministic
> `approval-integrity` check. Triggered by
> **[#1654](https://github.com/AIClarityAU/minspec/issues/1654)** (the cost half) and
> **[#1029](https://github.com/AIClarityAU/minspec/issues/1029)** (the correctness half);
> materialization issue **[#1376](https://github.com/AIClarityAU/minspec/issues/1376)**. Related:
> [#1653](https://github.com/AIClarityAU/minspec/issues/1653) — why these PRs are hand-created.

## Why this spec exists when DR-081 already decided it

DR-081 §3/§4 made the architectural call and named `#1376` as its materialization. It did not
write a testable contract, and the two hardest parts are exactly the parts a one-paragraph
decision leaves open: **what the exemption predicate is, precisely**, and **what happens to the
merge path once `ai-review` stops posting a pass**. This spec is that contract. It does not
re-open the decision; where it constrains DR-081 further, it says so.

No DR is minted for this work. The dedup search (`docs/decisions/INDEX.md`, plus a grep of DR
titles for review/approval/witness) returns DR-081 as an in-force record covering the same
decision, so per the standing rule this spec updates nothing and mints nothing — it implements
an accepted DR.

## Evidence — what is true today (verified 2026-09-06, cited, not inferred)

Every row below was read at the cited location on 2026-09-06, except the two explicitly
marked as quoted from #1654. Line numbers rot between reading and merging: treat the file
and symbol as the citation and the number as a hint.

| Claim | Evidence |
|---|---|
| `ai-review` runs on `opened`/`synchronize`/`reopened` only | [`ai-review.yml:145-147`](../../../.github/workflows/ai-review.yml#L145) |
| `cancel-in-progress` is keyed on the PR's concurrency group, so only a NEW run supersedes one | [`ai-review.yml:156-158`](../../../.github/workflows/ai-review.yml#L156) |
| the security voter is skipped only when EVERY changed file matches `\.md$` | [`ai-review.yml:422-425`](../../../.github/workflows/ai-review.yml#L422) — a `.json` sidecar is not `.md`, so it takes the code-surface lens |
| architect + skeptic are unconditional under `panel` (the default) | [`ai-review.yml:433-436`](../../../.github/workflows/ai-review.yml#L433), default at [`:299-300`](../../../.github/workflows/ai-review.yml#L299) |
| an approval commit is the sidecar, plus the approvable ONLY when it was pre-implementation | [`approve.ts:323-328`](../../../packages/minspec/src/commands/approve.ts#L323) — `wasPreImpl` guards `advanceSpecToImplementing`; the commit is a literal-pathspec partial commit ([`approve-commit.ts:285`](../../../packages/minspec/src/lib/approve-commit.ts#L285), with `GIT_LITERAL_PATHSPECS=1` at [`:137`](../../../packages/minspec/src/lib/approve-commit.ts#L137)), so nothing pre-staged rides along |
| the sidecar path is `.minspec/approvals/<repo-relative spec path>.json` | [`approval-store.ts:26`](../../../packages/minspec/src/lib/approval-store.ts#L26), [`:79-82`](../../../packages/minspec/src/lib/approval-store.ts#L79) |
| the record's fields are `specPath, specHash, approvedAt, approvedBy, tier, migrated, baselineBlob` (+ reserved `reviewStart`) — **no signature** | [`approval.ts:60-69`](../../../packages/minspec/src/lib/approval.ts#L60) |
| `approvedBy` is `git config user.email`, human-gated only LOCALLY | [`approval.ts:528`](../../../packages/minspec/src/lib/approval.ts#L528) (`assertHumanApprover`) — proves nothing about a pushed branch |
| canonicalization strips exactly `status:` and `phases:` (+ children); every other frontmatter key and the whole body are hashed | [`canonical.ts:60-83`](../../../packages/shared/src/canonical.ts#L60), contract at [`:10-26`](../../../packages/shared/src/canonical.ts#L10) |
| a byte-identical Python twin of the hasher already exists | [`scripts/hooks/canonical.py`](../../../scripts/hooks/canonical.py), parity pinned by [`canonical-parity.test.ts:58-77`](../../../packages/minspec/tests/canonical-parity.test.ts#L58) |
| **a deterministic sidecar-vs-tree checker already exists** — and is ADVISORY ONLY | [`scripts/approval-provenance.py:154-249`](../../../scripts/approval-provenance.py#L154) emits `VERDICT: MATCHES`/`MISMATCH` and distinguishes a legitimate re-approval from a forged hash over a stale predecessor ([`:202-248`](../../../scripts/approval-provenance.py#L202)); `main()` always returns 0 ([`:275-280`](../../../scripts/approval-provenance.py#L275)) and its only consumer injects it as PROMPT TEXT for the LLM voters ([`review-branch.sh:107-116`](../../../scripts/review-branch.sh#L107)) |
| nothing in CI fails on a sidecar/tree hash mismatch | no reference to approval/specHash/sidecar in `minspec-validate.yml`; `spec-gate.py`'s hard verdict ([`:464-470`](../../../scripts/hooks/spec-gate.py#L464)) runs as a local Claude Code hook, never from a workflow |
| `ready-to-merge` goes green **only** on an `ai-review:pass` label with verified provenance AND a SHA-bound head witness | [`ai-review-guard.js:654-667`](../../../.github/scripts/ai-review-guard.js#L654) (`decideStatus`), witness read at [`ready-to-merge.yml:253-316`](../../../.github/workflows/ready-to-merge.yml#L253) |
| approval PRs are a large, recurring share of the merge stream | 60 of the last 400 commits on `origin/main` are `chore(approve):` (`git log -n 400 --grep`, measured 2026-09-06). #1654 reports the PR-side figure as 52 of the last 200 merged PRs — **that figure is quoted from the issue and was not independently re-measured here** |
| merging does not stop an in-flight review | follows from the two `ai-review.yml` citations above. #1654 reports 12 of 40 merged PRs whose run continued past the merge and completed `success` — **quoted from the issue, not re-measured here** |

Two consequences the table makes concrete, and they point the same way:

1. **Cost.** A PR whose entire payload is machine-generated JSON draws four Opus voters,
   including the code-surface security lens, because the exemption predicate tests a file
   extension rather than a code surface.
2. **Correctness.** #1029 recorded three of four diff-scoped voters returning a *false*
   "stale or forged sign-off" block on an approval-only PR: the hash-relevant edit landed in an
   earlier PR and is simply not in this PR's diff. The panel is at once the most expensive and
   the least able instrument for this shape — while the tool that CAN answer it correctly
   (`approval-provenance.py`, which reads the tree rather than the diff) is already written and
   is fed to the panel as suggestion text it may ignore.

## One-Sentence Scope

Settle an approval-record PR with a deterministic, offline `approval-integrity` check that
compares the sidecar's `specHash` against the canonical hash of the approvable in the merged
tree, exempt that PR shape from the LLM voter panel, and keep its merge path green **because a
check passed** — never because a check did not run.

## Out of scope

- The substance review of the approvable itself. A spec, DR or epic still gets a full
  `ai-review` verdict on its own content PR before it can be approved (DR-081 §5, INV-2).
- Changing `AI_REVIEW_COVERAGE` repo-wide. Explicitly rejected in #1654 and reaffirmed here:
  one voter on genuine code PRs is a weaker gate, and the panel has been earning its keep there.
- Who may approve, and the offline approval UX (SPEC-022, SPEC-050, SPEC-061).
- Why approval PRs are hand-created at all (#1653).
- Any change to the canonical hash boundary (DR-034 / `canonical.ts`).

## Functional Requirements

### FR-1 — The exemption predicate is structural and path-based, never title-based

A changed set is an **approval-record changed set** iff it is non-empty and every path is either:

- **(a)** a sidecar: `.minspec/approvals/<rel>.json`; or
- **(b)** the approvable `<rel>` that some changed sidecar in the same set points at — derived
  by stripping the `.minspec/approvals/` prefix and the `.json` suffix, not by pattern-guessing.

Any other path — one extra file, anywhere — disqualifies the PR and it takes the ordinary
`ai-review` path. A commit message, PR title or label MUST NOT participate in the decision: a
title is forgeable, a path set is not (DR-081 §3). The predicate is a pure function of the
changed-file list, unit-testable without GitHub.

### FR-2 — The approvable half must be content-neutral

When an approvable file appears in the changed set under FR-1(b), the PR qualifies only if
`specHash(approvable @ base) == specHash(approvable @ head)` — i.e. the diff is confined to the
lifecycle mirrors canonicalization strips (`status:`, `phases:`), which is exactly what the
approve command writes ([`approve.ts:323-328`](../../../packages/minspec/src/commands/approve.ts#L323)).
Any substantive edit to the approvable, in the same PR as its own approval record, disqualifies
the PR. This is the "nothing rides along" boundary of DR-081 §4, expressed as a hash equality
rather than as a diff inspection.

### FR-3 — `approval-integrity`: a deterministic, offline check

A new check named `approval-integrity` runs on the same PR events as `ai-review` and verifies,
for a changed set satisfying FR-1 and FR-2:

1. every changed sidecar parses as JSON and carries the required record fields
   (`specPath`, `specHash`, `approvedAt`, `approvedBy`, `tier`, `migrated`);
2. `record.specPath` equals the path derived from the sidecar's own location (self-consistency —
   a record must not key a different artifact than the one it is filed under);
3. `record.specHash == specHash(approvable @ head)` — computed from the **tree**, never the diff;
4. the approvable named by every changed sidecar exists at head;
5. `record.approvedBy` is a permitted human approver, re-checked here because
   `assertHumanApprover` runs only on the approver's machine
   ([`approval.ts:528`](../../../packages/minspec/src/lib/approval.ts#L528));
6. `record.baselineBlob`, when it is a 40-hex value, resolves to an object present in the repo.

It makes no LLM call and no network call beyond the GitHub API of the run it posts to. Its
conclusion is `success` when every predicate above holds and `failure` otherwise, and the check
output names **which** predicate failed and on which path.

### FR-4 — One hasher, one provenance reader — no third twin

`approval-integrity` MUST reuse an existing implementation of the canonical hash — the Node twin
([`canonical.ts`](../../../packages/shared/src/canonical.ts)) or the Python twin
([`scripts/hooks/canonical.py`](../../../scripts/hooks/canonical.py)) — and MUST reuse
[`scripts/approval-provenance.py`](../../../scripts/approval-provenance.py) for the
sidecar-vs-tree verdict and its re-approval-versus-forgery distinction. It MUST NOT introduce a
third hashing implementation.

`approval-provenance.py` today is a fact emitter: `main()` always returns 0 and swallows git
errors. Giving it a gate mode (a non-zero exit, or a machine-readable verdict the workflow keys
on) is part of this work and is listed under `affects:`. Its advisory use inside
`review-branch.sh` must keep working unchanged — the addition is a second, stricter caller, not
a rewrite.

### FR-5 — `ai-review` self-exempts, before any voter starts

When a PR satisfies FR-1 and FR-2, `ai-review` runs **zero** voters and posts the `neutral`
conclusion already established for the machinery shape
([`ai-review.yml:138-142`](../../../.github/workflows/ai-review.yml#L138)). The decision is made
from the changed set in the same step that computes `SELF_EDIT`/`SECURITY_REQUIRED`
([`ai-review.yml:354-436`](../../../.github/workflows/ai-review.yml#L354)) — i.e. **before**
`run_voter` is called — so the saving is the whole panel, not a discarded verdict.

An indeterminate changed set (`CHANGED_OK != yes`) is NOT an approval-record PR: it continues to
fall through to the existing `SELF_EDIT_KIND=indeterminate` fail-closed path
([`ai-review.yml:362-364`](../../../.github/workflows/ai-review.yml#L362)).

### FR-6 — The merge path stays green, on the new witness

`ready-to-merge` MUST accept a verified `approval-integrity` = `success` on the **current head
SHA** as the merge witness for an approval-record PR, in place of the `ai-review:pass` label plus
its SHA-bound witness ([`ai-review-guard.js:654-667`](../../../.github/scripts/ai-review-guard.js#L654)).

This requirement is the reason the exemption is not free. Without it, the exemption converts
these PRs from *expensive but mergeable* into *cheap and unmergeable without `--admin`* — the
exact machinery-PR trap SPEC-065 documents, where a `neutral` `ai-review` posts no pass witness
and `ready-to-merge` stays red forever. A change that ships FR-5 without FR-6 is a regression,
not a saving.

### FR-7 — The witness is trusted by identity and SHA, never by name

`approval-integrity` is trusted only when posted by an allowlisted App identity, on the current
head SHA, using the same provenance mechanism `ai-review`'s witnesses use
([`ready-to-merge.yml:253-316`](../../../.github/workflows/ready-to-merge.yml#L253)). A check-run
of that name from any other actor is not a witness.

### FR-8 — Fail closed, and visibly

Every one of: an indeterminate changed set; an unreadable, malformed or missing sidecar; a
missing approvable; a hash mismatch; a disallowed `approvedBy`; an unresolvable `baselineBlob`;
or an internal error of the check itself — yields `failure`, never `neutral`, never a skip, and
never a swallowed `|| true` on a load-bearing write (constitution invariant 2; the gate-signal
rule SPEC-054 encodes). The check's summary states the failing predicate in words a maintainer
can act on without opening the run log.

### FR-9 — A missing producer degrades to expensive, never to unchecked

If `approval-integrity` does not report at all — the workflow is disabled, a permission is
missing, the App token cannot be minted — the PR MUST NOT become exempt. The `ai-review`
exemption in FR-5 is armed only while `approval-integrity` is a required check; when the
producer is absent, an approval PR takes the ordinary voter path and is reviewed as it is today.

This is the invariant-2 "no single producer" clause answered in the cheapest available
direction: the failure mode of losing the new producer is a token bill, not a false green.

### FR-10 — Staged rollout, in this order

1. `approval-integrity` ships **advisory** (not in the required set) and runs on real approval
   PRs alongside the existing panel.
2. Once it has agreed with the panel over an agreed run of consecutive approval PRs (D-5), it is
   added to the branch ruleset's required checks.
3. **Only then** is the FR-5 exemption armed.

Reversing the order would take approval PRs from "red and bypassed" to "green and unchecked",
which DR-081's Consequences section names as strictly worse. Un-requiring the check is the
one-step rollback at any point.

### FR-11 — The panel keeps its say on the approvable itself

Nothing in FR-1..FR-10 changes the review of the spec/DR/epic content PR. DR-047's substance
gate is untouched, and an implementation that satisfies FR-5 by weakening it is wrong (DR-081 §5).

### FR-12 — A closed PR stops costing tokens

When a PR is closed — merged or not — any in-flight `ai-review` run for that PR is cancelled.
Today nothing cancels it: `ai-review` listens only to `opened`/`synchronize`/`reopened`
([`ai-review.yml:145-147`](../../../.github/workflows/ai-review.yml#L145)) and
`cancel-in-progress` fires only when a new run enters the same concurrency group
([`:156-158`](../../../.github/workflows/ai-review.yml#L156)), which a merge does not create.

The scope of this requirement — all PRs, or only the merged-with-a-green-witness subset — is
**D-3**, because cancellation destroys the one retrospective signal a bypass-merged PR currently
produces. FR-12 is written as a requirement because the waste is real and measured; its shape is
a human call.

## Invariants (must not break)

- **INV-1 — no silent gate (constitution invariant 2).** An exempted PR is green because a
  deterministic check PASSED. Absence of a check must never satisfy the required set. Every
  fail-closed direction in FR-8 is load-bearing, and no load-bearing write may be `|| true`.
- **INV-2 — the exemption covers the RECORD, never the APPROVABLE (DR-081 §5).** The load-bearing
  boundary; DR-047 exists because rubber-stamped approvals hid seven live defects.
- **INV-3 — Tier-0 / offline.** `approval-integrity` performs no inference and no third-party
  network call. It is a hash comparison over a git tree.
- **INV-4 — one hash definition.** No third canonicalization twin (FR-4). The Node/Python parity
  test remains the only pinning mechanism.
- **INV-5 — blast radius stops at this repo (constitution invariant 3).** If any part of this
  ships downstream through `ci-review-templates.ts`, it changes the review gate for every
  consuming repo. That is a decision (**D-4**), never a side effect of this change.
- **INV-6 — provenance is identity + SHA, never a name.** FR-7. A forgeable witness is worse than
  no witness.
- **INV-7 — no new exemption reason without its own justification.** DR-081's Consequences warn
  that `neutral` decays into "the check we skip" once it has unexplained members. `ai-review`
  ends this change with exactly two exemption reasons — machinery and approval-record — each
  paired with a named replacement check.

## Acceptance Criteria

- [ ] **Structural predicate.** A sidecar-only changed set and a sidecar + its own approvable are
      both recognised; adding any third path, or a sidecar plus an *unrelated* approvable, is not.
      (FR-1)
- [ ] **Content-neutral only.** An approval PR that also edits a body line of the approvable it
      approves is NOT exempt and takes the full panel. (FR-2)
- [ ] **Hash from the tree.** A sidecar whose `specHash` does not equal the canonical hash of the
      approvable at head fails the check, with the mismatch named in the summary. (FR-3, FR-8)
- [ ] **#1029 does not recur.** An approval PR whose hash-relevant edit landed in an earlier PR
      passes, because the witness reads the merged tree rather than this PR's diff. (FR-3)
- [ ] **Zero voters.** On an exempt PR, no `claude -p` voter process starts — asserted on the run,
      not merely on the absence of a verdict comment. (FR-5)
- [ ] **Still mergeable without `--admin`.** An exempt, integrity-passing approval PR reaches
      `ready-to-merge` green with no admin bypass. (FR-6)
- [ ] **Forged witness rejected.** An `approval-integrity` check-run posted by a non-allowlisted
      actor, or bound to a stale SHA, does not satisfy `ready-to-merge`. (FR-7)
- [ ] **Fail-closed matrix.** Each of: malformed sidecar, missing approvable, mismatched hash,
      disallowed `approvedBy`, indeterminate changed set — produces `failure` with a named reason.
      (FR-8)
- [ ] **Producer absent ⇒ ordinary path.** With `approval-integrity` disabled, an approval PR is
      reviewed by the panel as it is today; it never auto-exempts. (FR-9)
- [ ] **Ordering enforced.** The exemption cannot be armed while the check is advisory. (FR-10)
- [ ] **Substance gate intact.** A content PR for a spec/DR/epic still receives a full panel
      verdict. (FR-11, INV-2)
- [ ] **Closed PR stops spending.** Per D-3's resolved scope, an in-flight review is cancelled
      when its PR closes. (FR-12)
- [ ] **No third hasher.** The corpus contains exactly the two canonicalization twins after this
      change. (FR-4, INV-4)

## Decisions needed (Clarify)

**D-1 — Where does the permitted-approver list live? (FR-3.5)**
- **(a) Repo variable** (e.g. `APPROVAL_APPROVER_EMAILS`), read from the workflow environment.
- **(b) Committed policy in `.minspec/config.json`, read from the BASE checkout** *(rec)*.
  Consistent with how the reviewer already gets its trusted control plane
  ([`ai-review.yml:242-247`](../../../.github/workflows/ai-review.yml#L242)), it is auditable in
  git, and it works offline. **Cost:** the policy file becomes gate surface — editing it must
  itself be gated, and it must be read from base, never head, or an approval PR could widen its
  own approver list in the same commit. That reading rule is easy to state and easy to forget.
- **(c) Any verified committer.** Cheapest; rejected direction — it makes the check verify a hash
  and nothing about who signed.

**D-2 — Does `approval-integrity` run from the trusted base checkout?**
- **(a) Yes** *(rec)*, mirroring `ai-review`'s base-checkout control plane. **Cost:** a PR that
  changes the checker itself is reviewed by the *previous* checker; acceptable, since such a PR
  touches `.github/` and is machinery by
  [`ai-review.yml:404`](../../../.github/workflows/ai-review.yml#L404) and therefore never an
  approval-record PR under FR-1 anyway.
- **(b) Head checkout.** Simpler wiring, and strictly weaker; named only to be rejected.

**D-3 — How wide is the cancel-on-close rule? (FR-12)**
- **(a) Cancel on every PR close, merged or not** *(rec)*. Recovers the whole measured waste in
  one small job. **Cost:** a PR merged by `--admin` while its review was still running currently
  produces a post-hoc verdict on already-merged code, and that verdict is the only review those
  merges get. Cancelling deletes it. The mitigation is that FR-5/FR-6 remove the standing reason
  to bypass in the first place, so the case this costs should be rare after this change — but
  that argument is a prediction, not a measurement.
- **(b) Cancel only when the PR merged with a green witness.** Keeps the retrospective verdict for
  bypass merges. **Cost:** more conditional logic in a gate-adjacent workflow, for a subset.
- **(c) Split it out to its own issue.** Keeps this spec to one shape. **Cost:** the cheapest
  saving in the issue goes back on the shelf, and #1654 stays open behind a spec that answered
  only half of it.

**D-4 — Does the exemption ship downstream via `ci-review-templates.ts`? (INV-5)**
- **(a) This repo only, for now** *(rec)*. Constitution invariant 3 says MinSpec's blast radius is
  the project it is installed in; a review-gate change reaching every consuming repo deserves its
  own decision. **Cost:** two copies of the ai-review workflow drift further apart, and consuming
  repos keep paying the full panel on their approval PRs — the divergence #1758 already recorded
  as a repeat failure mode.
- **(b) Ship both together.** One coherent gate everywhere. **Cost:** every consuming repo must
  also carry `approval-provenance.py`, `canonical.py` and the approver policy, or the exemption
  arrives there without its replacement check — the "green and unchecked" outcome, exported.

**D-5 — How many advisory-agreement runs before the check becomes required? (FR-10)**
- **(a) 5 consecutive approval PRs where the check and the panel agree** *(rec)*. Enough to catch
  a predicate bug on a shape variant (re-approval with no spec edit, multi-sidecar PR).
  **Cost:** at the observed approval cadence that is roughly a week of continued full-panel spend
  before any saving lands.
- **(b) Require it immediately.** Saves that week. **Cost:** a defect in a required check blocks
  approvals repo-wide, which DR-081's "Costly to Refactor" names as the expensive-to-undo moment.

**D-6 — Is T4 the right tier?** Recorded rather than assumed: this spec is filed T4 because it
adds a required merge check and edits three gate workflows, and because D-1..D-5 make a Clarify
phase genuinely necessary rather than ceremonial. A T3 filing would skip Clarify and force those
five decisions to be made inside Plan. **Cost of T4:** one more phase of ceremony on a solo repo,
which DR-076 was written to reduce.

## Alternatives considered and rejected

- **Widen the security exemption from `\.md$` to also admit `.minspec/approvals/**.json`**
  (#1654's "interim, cheaper" option). Rejected as a shipped change: it takes four voters to
  three on the same PR shape FR-5 removes entirely, and it degrades the predicate from a readable
  "every changed file is Markdown" to an enumeration of blessed non-code extensions. The right
  long-term repair of that predicate is a genuine code-surface test (#453 / SPEC-033 D-4), not
  another special case. Recorded here so the option is visibly rejected rather than overlooked.
- **`AI_REVIEW_COVERAGE=single` repo-wide.** Rejected in #1654 and again here: a real saving,
  bought by weakening review on genuine code PRs, which is where the panel earns its keep.
- **Title- or label-based detection** (`chore(approve):`, the `docs-lane` label). Rejected: both
  are author-controlled, so either would let any PR buy the exemption by renaming itself.
- **Keep merging these on `--admin`.** Rejected — DR-081 already rejected it; a bypass used on
  every approval is indistinguishable from no gate.
- **Teach the voters to read the tree.** Rejected: it keeps the four-Opus cost to answer a
  question a sha256 comparison answers exactly, and it leaves a probabilistic judge on a
  deterministic fact.

## Risks & Mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | A second path that can emit a green merge signal is the classic shape of a false green. | FR-8's fail-closed matrix and FR-7's provenance binding are where the test effort concentrates; FR-10 stages the rollout so the check is observed before it is trusted. |
| R2 | The exemption ships before the replacement check is required → "green and unchecked". | FR-9 + FR-10 make the ordering a requirement, and the exemption is armed off the check's required-ness rather than off a hand-flipped flag. |
| R3 | FR-5 lands without FR-6, and approval PRs become unmergeable without `--admin`. | FR-6 is stated as a co-requirement with its failure mode named; the SPEC-065 machinery trap is the worked precedent. |
| R4 | The predicate under-matches (an approval PR shape nobody enumerated) and the saving never materialises. | Falls back to the ordinary panel — expensive, correct. Observable as a flat token bill during FR-10's advisory stage. |
| R5 | The predicate over-matches and something rides along inside an exempted PR. | FR-1's exhaustive path test plus FR-2's hash-equality on the approvable half; the approve command's literal-pathspec partial commit ([`approve-commit.ts:285`](../../../packages/minspec/src/lib/approve-commit.ts#L285)) means the shape is narrow by construction, but the check does not rely on that. |
| R6 | `approval-provenance.py` gains a gate mode and its advisory caller regresses. | FR-4 requires the existing `review-branch.sh` behaviour to be unchanged; the new caller is additive. |
| R7 | D-3(a) removes the only review a bypass-merged PR ever gets. | Stated in D-3 as the recommendation's cost, for a human to weigh; not resolved here. |

## Follow-ups (tracked)

- **[#1376](https://github.com/AIClarityAU/minspec/issues/1376)** — DR-081 §3/§4 materialization.
  This spec is its requirements artifact; the issue is the build ticket, not a second design.
- **[#1029](https://github.com/AIClarityAU/minspec/issues/1029)** — the false "stale or forged
  sign-off" block. Closed by FR-3 reading the tree; listed as an acceptance criterion above.
- **[#1654](https://github.com/AIClarityAU/minspec/issues/1654)** — this spec's originating issue.
- **[#1653](https://github.com/AIClarityAU/minspec/issues/1653)** — why approval PRs are
  hand-created. Not addressed here; it changes who opens the PR, not how it is reviewed.
- **D-4 (downstream shipping)** has no issue yet by design — filing one presumes the answer. If
  Clarify resolves it to (b), that resolution files the issue.
