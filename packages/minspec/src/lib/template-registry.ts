/**
 * Template registry — Handlebars template strings bundled as constants.
 * This avoids esbuild file-loader complexity for .hbs files.
 */

import {
  parseSections,
  buildSectionHashes,
  hashSection,
  type GeneratedHashes,
  type SectionHashes,
} from './merge-refresh';
import {
  SPEC_KIT_COMMANDS,
  buildClaudeShim,
  buildCursorShim,
  slashCommandName,
} from './slash-commands';
import type { DetectedTools } from './tool-detector';
import {
  SESSION_TITLE_SH,
  SESSION_TITLE_PY,
  SESSION_TITLE_SH_SHEBANG,
  SESSION_TITLE_PY_SHEBANG,
} from './hook-templates';
import {
  AI_REVIEW_WORKFLOW,
  READY_TO_MERGE_WORKFLOW,
  AI_REVIEW_RETRY_WORKFLOW,
  DOCS_LANE_WORKFLOW,
  REVIEW_BRANCH_SH,
  REVIEW_DECIDE_SH,
  AGENT_CONTEXT_SH,
  ROLE_REVIEWER_MD,
  ROLE_SECURITY_MD,
  ROLE_ARCHITECT_MD,
  ROLE_SKEPTIC_MD,
  AI_REVIEW_GUARD_JS,
  APPROVAL_PROVENANCE_PY,
  CANONICAL_PY,
  REVIEW_SCRIPT_SHEBANG,
  PY_SCRIPT_SHEBANG,
} from './ci-review-templates';

/**
 * Template names that can be rendered.
 *
 * NOTE — `DESIGN.md` is intentionally absent (#206). It is NOT a harness
 * template: a split-layout `design.md` is a T3+ **Plan-phase** artifact, created
 * when planning starts, not at init. Scaffolding an empty `DESIGN.md` stub at
 * init produced a doc the project's own gap-audit (#205) would flag, and — being
 * a managed template — refresh resurrected it after deletion. Never re-add it
 * here; both `generateHarnessFiles` and `refreshHarnessFiles` loop over
 * `TEMPLATE_NAMES`, so membership is exactly "scaffolded + refresh-managed".
 */
export type TemplateName = 'CLAUDE.md' | 'AGENTS.md' | '.cursorrules' | 'constitution.md' | 'labels.md';

/** All template names in generation order */
export const TEMPLATE_NAMES: readonly TemplateName[] = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  'constitution.md',
  'labels.md',
] as const;

/** Output file paths relative to project root (constitution goes inside .minspec/) */
export const TEMPLATE_OUTPUT_PATHS: Record<TemplateName, string> = {
  'CLAUDE.md': 'CLAUDE.md',
  'AGENTS.md': 'AGENTS.md',
  '.cursorrules': '.cursorrules',
  'constitution.md': '.minspec/constitution.md',
  'labels.md': '.minspec/labels.md',
};

const LABELS_MD_TEMPLATE = `# Issue label vocabulary — {{projectName}}

The labels MinSpec's triage step classifies against. **This file is documentation and a
copy-paste script — MinSpec never creates, edits, or reads a label on any forge.** Core
functionality works offline and makes no network call without your explicit consent, so
applying these is always a command *you* run.

Triage reads an issue's **type label** as one of its inputs. A type it is told to
recognise but that does not exist as a label is an input that is always absent — the
classification then rests on body text alone. That is the gap this file closes.

## Type — what kind of work is this?

Exactly one per issue.

| Label | Meaning | Auto-buildable? |
|---|---|---|
| \`bug\` | Something is broken | ✅ |
| \`feat\` | New capability | ✅ |
| \`chore\` | Maintenance, no behaviour change | ✅ |
| \`refactor\` | Structure changes, behaviour does not | ✅ |
| \`test\` | Test coverage or harness | ✅ |
| \`ci\` | Build or CI pipeline | ✅ |
| \`docs\` | Developer-facing documentation | ✅ |
| \`idea\` | Not yet a decision | ❌ human-only |
| \`decide\` | Asks for a product or architecture decision | ❌ human-only |
| \`copy\` | User-facing wording | ❌ human-only |
| \`marketing\` | Marketing content | ❌ human-only |
| \`positioning\` | Product positioning, public claims | ❌ human-only |
| \`legal\` | Legal, licensing, compliance | ❌ human-only |
| \`monetization\` / \`billing\` | Pricing, billing, revenue | ❌ human-only |

> **These names are not stylistic.** They are the exact tokens the triage step classifies
> against, so a rename here silently removes a classification input rather than tidying a
> label. In particular it is \`docs\`, **not** GitHub's default \`documentation\` — shipping the
> latter recreated the very "declared type with no label" gap this file exists to close, and
> a test that hardcoded the wrong name passed green while it did.

**Human-only is about AUTHORSHIP, not difficulty.** It says who may *write* the work, never
who may permit it — so no approval, keystroke, or configuration value lifts it. A trivial
one-word copy change is still human-only; a large mechanical refactor is not.

## Priority

\`P1\` (now) · \`P2\` (next) · \`P3\` (someday). Absent means untriaged.

## Lifecycle

\`inbox\` (awaiting triage) · \`needs-review\` (a human must look before work starts) ·
\`needs-info\` (cannot be sized yet) · \`agent-ready\` (cleared to build).

**\`agent-ready\` is the gate's OUTPUT, never its input.** Do not pre-apply it — from an
issue template, an automation, or by hand. A label that anyone can set is not a permission,
and treating it as one is how unreviewed work gets built.

## Create them

Run once, in the repo:

\`\`\`bash
gh label create bug --color d73a4a --description "Something is broken" --force
gh label create feat --color a2eeef --description "New capability" --force
gh label create chore --color cfd3d7 --description "Maintenance, no behaviour change" --force
gh label create refactor --color cfd3d7 --description "Structure changes, behaviour does not" --force
gh label create test --color cfd3d7 --description "Test coverage or harness" --force
gh label create ci --color cfd3d7 --description "Build or CI pipeline" --force
gh label create docs --color 0075ca --description "Developer-facing documentation" --force
gh label create idea --color d4c5f9 --description "Not yet a decision" --force
gh label create decide --color b60205 --description "Human-only: asks for a product or architecture decision" --force
gh label create copy --color b60205 --description "Human-only: user-facing wording" --force
gh label create marketing --color b60205 --description "Human-only: marketing content" --force
gh label create positioning --color b60205 --description "Human-only: positioning, public claims" --force
gh label create legal --color b60205 --description "Human-only: legal, licensing, compliance" --force
gh label create monetization --color b60205 --description "Human-only: pricing, billing, revenue" --force
gh label create billing --color b60205 --description "Human-only: billing (sibling of monetization)" --force
gh label create P1 --color b60205 --description "Now" --force
gh label create P2 --color fbca04 --description "Next" --force
gh label create P3 --color 0e8a16 --description "Someday" --force
gh label create inbox --color ededed --description "Awaiting triage" --force
gh label create needs-review --color fbca04 --description "A human must look before work starts" --force
gh label create needs-info --color fbca04 --description "Cannot be sized yet" --force
gh label create agent-ready --color 0e8a16 --description "Cleared to build — the gate's output, never its input" --force
\`\`\`

\`--force\` updates a label that already exists rather than failing, so the block is safe to
re-run after editing a description.

## Changing this file

Edit it freely. Refresh preserves sections you add and updates the ones above; a section
MinSpec does not know about is kept as-is at the end.
`;

const CLAUDE_MD_TEMPLATE = `# {{projectName}} — Project Instructions

## Overview

{{projectName}} project managed with MinSpec SDD methodology.

- **Specs directory:** \`{{specsDir}}/\`
- **Decisions directory:** \`{{decisionsDir}}/\`

## Invariants

These rules must never be violated. All changes must preserve them.

{{#if invariants}}
> Summarized from \`.minspec/constitution.md\` — each line is the invariant's lead sentence. See the constitution for the full text, rationale, and SPEC/DR references; edit invariants there, not here.

{{#each invariants}}
{{incremented @index}}. {{firstSentence this}}
{{/each}}
{{else}}
<!-- Add project invariants here -->
{{/if}}

## SDD Methodology

This project uses Specification-Driven Development. Tasks are classified by **mechanical scope** (blast radius — files, lines, boundaries touched), not by how hard they are to reason about. The predicted tier is an upward-only floor: it never lowers ceremony on its own, and you can always raise it.

| Tier | Ceremony | Phases Required |
|------|----------|-----------------|
| T1 | One-sentence spec | specify |
| T2 | Spec + plan | specify, plan |
| T3 | Full spec cycle | specify, plan, tasks, implement |
| T4 | Complete ceremony | all phases |

## Naming waves, phases, and batches

Never refer to a group of work by a bare number.

- **Name what you coin.** A wave, batch, or group you invent gets a descriptive name ("the mechanical-bugfix wave"), never "Wave 1".
- **Gloss what is predefined.** When an identifier is fixed and numeric (\`Phase 2\`, \`Slice 3\`, \`T3\`), append a short reminder of what it covers the first time it appears in any response, doc, issue, PR, or commit — e.g. "Phase 2 (Public-ready — polish)".

A bare number makes the reader stop and look it up; a two-word gloss costs nothing.

## Human action items — mark them, then repeat them

Anything waiting on the human — a decision, a credential, a manual step, a merge — is invisible unless it is marked. One marker, two places.

- **Inline, the moment it arises.** Prefix the line with ➡️ mid-turn, where the need appears; never hold it back for the end.
- **Again at the end of every turn.** Close the response with a \`**Your turn**\` block repeating every still-pending item, one ➡️ line each. Nothing pending → omit the block; an empty one teaches the reader to skip it.
- **The heading carries no ➡️.** Only action items do, so the number of arrows equals the number of things waiting on the human — countable at a glance, with no off-by-one from the title.
- **Reserve ➡️ for this.** Never decorate ordinary prose with it, so scanning for ➡️ never returns a false hit.
- **Cite a pull request by number, not by URL.** Write \`#1231 short title\`. A bare
  \`https://\` link always opens a browser, which throws the reader out of the editor
  they are working in; a number is resolved in place by the editor's own pull-request
  integration. Say the state you already observed alongside it, so the reader can
  decide without opening anything at all.
- **Give each item a reply key.** One or two characters, restated on the line every turn so the human never scrolls back to find one: \`m\` merge · \`c\` close · \`d\` diff/details · \`r\` re-review · \`s\` skip.
- **Every choice carries a recommendation and its cost.** When an item asks the human to *decide*, name the option you recommend and, in the same breath, the primary downside or risk of the option you are recommending. A menu with no recommendation hands the analysis back to the human; a recommendation with no stated cost is advocacy, not advice. Mark it \`(rec)\` on the option and follow with one clause naming what it costs. This applies wherever a decision is put to a human — the \`**Your turn**\` block **and** the body of any issue, PR, or DR that asks them to choose.

The same block lists every pull request this session opened that is still unmerged — its number, the gate state already observed this turn, and its keys:

\`\`\`
**Your turn**
➡️ #1231 dispatch env scrub — ai-review:pass · needs-review — \`m\` merge · \`c\` close · \`d\` diff
➡️ Name the new hook — \`a\` agent-context **(rec)**, matches the existing \`agent-\` prefix but reads oddly for session-scoped state · \`b\` session-context
\`\`\`

Report the state you already observed; re-reading it from the git host is ordinary tool use, never a requirement, and MinSpec itself makes no network call.

## File Locations

| Artifact | Location |
|---|---|
| Specs | \`{{specsDir}}/\` |
| Decisions | \`{{decisionsDir}}/\` |
| Constitution | \`.minspec/constitution.md\` |
| Config | \`.minspec/config.json\` |

## Commands

MinSpec is a **VS Code extension**, not a CLI — run everything from the Command Palette (\`Ctrl/Cmd+Shift+P\`), typing "MinSpec:".

| Command Palette | Purpose |
|---|---|
| *MinSpec: Initialize SDD Structure* | Scaffold \`.minspec/\` + harness files. Also offered automatically when you open an un-initialized project. |
| *MinSpec: Refresh Harness Files* | Re-merge harness templates, preserving your edits. |
| *MinSpec: Classify Task Complexity* | Classify the current change into a tier (T1–T4). |
| *MinSpec: Show SDD Status* | Show the current phase and spec status. |
| *MinSpec: Create Architecture Decision Record* | Create a new \`DR-NNN\` in \`{{decisionsDir}}/\`. |

## Session Scope Protocol

State the scope before writing any code. A session with no declared scope has no boundary, so nothing can be *off* it — drift is only visible against a line someone drew first.

\`\`\`
Session scope: [one sentence]
Area:          [subsystem, package, or spec id]
Type:          bug / feat / explore / plan
\`\`\`

Write it yourself when the request already implies it, and say it back in one line so the human can correct a wrong reading cheaply. Ask — "What's the one-sentence scope for this session?" — only when you genuinely cannot infer one. One sentence is the point: a scope that needs a paragraph is two sessions. Declaring costs a line and changes nothing else; it is a line to measure against, not ceremony, and it never raises the tier of a one-line fix.

### Triage rules

**1. Topic drift → capture it, don't act on it.** When something surfaces that the declared scope does not cover — an unrelated bug, a passing idea, a "while you're in there" — record it and carry on with the declared scope. Do not start work on it, and do not litigate whether it is worth recording: recording costs a line, and whether it deserves work is a decision for later, by a human, with the backlog in view.

Record it wherever this project already tracks work: an issue tracker, a backlog file, or a stub under \`{{specsDir}}/\`. The requirement is durability, not a particular tool — MinSpec mandates none of these and makes no network call of its own, so a project with no tracker and no network still satisfies this with a file. Say where it landed. If you cannot put it there — no access, no network, or this project's convention is that a human files items — then write the item out in full in the \`**Your turn**\` block instead, ready to paste. What you must never do is leave it in chat scrollback, where it is gone the moment the session ends.

Capture the diagnosis with it, not just the symptom. Parking is not skipping: whatever you have already worked out about the cause is the expensive part, free to write down now and costly to re-derive cold later.

**2. Scope-expansion triggers.** Some phrasings almost always smuggle in new scope. When an in-scope request contains one, confirm before implementing:

| Trigger phrase | What it usually hides |
|---|---|
| "integrate with X" | Integration is not detection — you inherit X's API, versions, and failure modes for as long as the code lives |
| "also support X" / "include X too" | A second case is a second code path, a second test set, a second thing that can break |
| "expand to X" / "extend to X" | The current design was sized for the original case; X may not fit inside it |
| "and X" tacked onto an already-agreed scope | The scope was agreed before X was in it, so X was never sized at all |
| "make it work with X", where X was not previously named | A new dependency and a new compatibility surface |

Default action: confirm, or capture X as a separate work item. Never expand silently. Expansion is also a re-classification — the tier was predicted from the blast radius of the original change, so a wider change earns a higher tier, and the tier is a floor you may raise, never lower.

**3. Detection is not integration.** Reading a signal — a file exists, a config key is set, a tool is installed — is bounded, offline, and reversible. Acting on that signal — new commands, exports, writing into another tool's data, two-way sync — is a new feature surface with its own compatibility matrix and its own maintenance cost. They are separate work items, and the second one gets its own spec at its own tier.

### When not to park

- **The human says "do this instead."** That is a scope change, not drift. Restate the new scope in one sentence and work under it.
- **The tangent blocks the declared scope.** Fix it inline, then commit it on its own, so the fix can be reviewed and reverted apart from the in-scope work.
- **The session was declared exploratory** (\`explore\`, \`plan\`, or whatever this project calls the same thing). Those sessions are deliberately wide; parking every branch defeats them.

## Evidence Discipline — status claims

Before you write **"implemented / done / built / works / shipped"** about a feature into any
artifact — a spec, a decision record, a README, a code comment, a task list, a message to the
human — check the **authoritative** signal, not a proxy for it.

| Signal | What it settles |
|---|---|
| The feature's **code** — you read the implementation and can cite \`path/to/file:line\` | ✅ the only thing that confirms a feature exists |
| The owning spec's **\`status\`** before \`done\` — \`new\`, \`specifying\`, \`planning\`, \`implementing\` | ✅ enough to withhold the claim: the lifecycle itself says the work is unfinished |
| The owning spec's **\`status: done\`** | ❌ proves the phases were ticked, not that the code exists |
| A file, spec, or directory **exists** | ❌ not evidence |
| A commit subject, branch name, or change title **mentions** the feature | ❌ not evidence |
| A tracking item is **closed** (in whatever tracker you use) | ❌ not evidence |
| Another document **says** it is done | ❌ not evidence — prose can be wrong |

Read that table in one direction only: **status can withhold a claim, never confirm one.**
\`status: implementing\` means implementation *started* — reading it as "implemented" is the
exact error this section exists to prevent. And when the code and the status disagree, the
code is the fact: the status is a defect to fix, not a source to cite.

**Artifact-existence is not feature-existence.** A spec describing a feature proves someone
described it. A task marked complete proves someone marked it. Neither proves a line of code
exists. The two get conflated because they usually correlate — which is exactly why the
exceptions slip through unchallenged.

If you have not verified, write the honest state instead: "specified, not built", "planned,
not started", "partially built — the read path works, the write path is a stub".

**Why it is worth the friction.** A false "implemented" is self-concealing. Broken code fails
loudly and gets fixed; a wrong status is a signpost pointing the wrong way, and it fails
silently for as long as anyone believes it. Every reader after you — human or agent — plans on
top of it, skips the work it claims is finished, and builds against behaviour that does not
exist. The cost compounds with the delay. Specs are only worth keeping if they can be trusted
without re-verifying them, and one confident falsehood is enough to make a reader re-verify
all of them.

### The same bar for claims about behaviour

Everything above covers one question — *is this built?* It does not cover the other one —
*how does this behave?* Claims like "the validator rejects that input", "editing this field
invalidates the approval", "this is the only place that handles it", "there are N specs in
this state" are assertions about the system, and a plausible inference from a true adjacent
premise does not license them. The premise can be perfectly true and the conclusion still
wrong; that is what makes this class of error easy to commit and hard to notice.

Cite the code (\`file:line\`) or the computed value — the actual output of the search or command
you ran. Documentation about the code is not a citation for the code, because prose drifts
from the implementation it describes and nothing forces it back.

The generalization of *artifact-existence is not feature-existence* is **plausible inference
is not observation**. Both accept a proxy for the authoritative signal: one accepts "the
artifact exists" for "the feature exists", the other accepts "this follows from what I already
know" for "I checked".

### Mark what you did not check

When a claim is inferred rather than verified, say so in the same sentence — "I believe X
(unverified)" — so a reader knows which claims to spot-check. An unmarked declarative reads as
verified. That is what makes an unmarked guess more expensive than an admitted one: it removes
the reader's only chance to catch it.

### Make checking cheap

The pull toward guessing is strongest when verifying is slow. When the same question keeps
recurring — how many specs sit in a given status, whether a check actually runs, what a field
defaults to — turn answering it into one command you can re-run, and run it rather than
recalling the last answer. Where this project already has somewhere automated checks live, a
claim that can be checked mechanically belongs there too: this section is prose, and prose is
a rule someone has to remember. A check is one they cannot forget.

## Traceability Convention

Commits, work items, and decision records form a linked chain. Each answers a different question, so none of them substitutes for another:

| Artifact | Answers |
|---|---|
| Work item — a spec in \`{{specsDir}}/\`, or an issue if you use a tracker | What needs doing |
| Decision record in \`{{decisionsDir}}/\` | Why we chose this approach |
| Commit | What changed |

Link them in both directions, using whatever id this project already tracks work by — a spec id (\`SPEC-012\`), an issue number (\`#42\`), a ticket key. The notation is yours; the direction of the links is the convention.

- **Commits name the work item they serve** — in whatever commit convention this project follows, e.g. \`feat(SPEC-012): description\` or \`fix(#42): description\`. What matters is that whoever lands on a commit can find the request behind it.
- **Decision records name what triggered them** — a \`Triggered by:\` line in the body carrying that id.
- **Work items name the decision record** when one exists.
- **Sub-items point at the parent decision record**, so someone reading only the sub-item still finds the rationale.

Don't consolidate — link. Fold three questions into one artifact and two of them stop being answerable: a commit log tells you what changed but never why that approach won, and a decision record read alone can't tell you whether the work it implies ever happened.

### Decision records materialize their follow-ups

Give every decision record a follow-ups section — \`## Follow-ups (tracked)\` is the shape MinSpec expects. Each actionable consequence the decision raises links a spec in \`{{specsDir}}/\` or a tracked work item. When you write the decision record, open the items for any follow-up no spec already covers — especially non-code work (docs, copy, ops, a rename, a change somewhere the SDD flow doesn't reach) that nothing else will pick up on its own.

A consequence stated only in prose is a leak. It reads as recorded and feels handled, but nothing will surface it again: no list contains it, no phase is blocked by it, and it dies with the document that mentioned it. \`None\` is a valid, explicit answer — write it rather than dropping the section, so a reader can tell "nothing to do here" from "nobody looked".

The same discipline applies to commit messages: a commit body that defers work ("held back", "separate PR", "follow-up", "out of scope") should cite the item that now carries it, or say plainly that nothing was deferred. Where MinSpec's commit-message hook is installed, that is checked at commit time instead of left to memory.

### Ids without a tracker

Nothing above requires an issue tracker. In a project that has none, the spec id in \`{{specsDir}}/\` is the work-item id and follow-ups link specs — where these rules say "issue", read "spec". MinSpec itself makes no network call and assumes no particular host. What must survive either way is the direction of the links: every change points at the reason for it, and every decision points at the work it creates.

## Decision Register

Every architectural decision gets a file: \`{{decisionsDir}}/DR-NNN.md\`, listed in \`{{decisionsDir}}/INDEX.md\`.

A decision that lives only in a chat thread, a commit message, or a review comment is gone the moment that thread scrolls away, and the next person to touch the code — human or agent — re-litigates it and usually lands somewhere else. The register is the standing answer to "why is it done this way?", written once and findable later.

**What earns a DR:** a choice that would be expensive to reverse, or one where the obvious-looking alternative was rejected for a reason not visible in the code. Everything else is just a commit.

### Numbering is computed, never chosen

- Use *MinSpec: Create Architecture Decision Record*. It reads \`{{decisionsDir}}/\`, takes the highest existing \`DR-NNN\` plus one, zero-pads it (\`DR-007\`, not \`DR-7\`), and writes the standard template with \`status: proposed\`.
- Numbers are never reused and gaps are never backfilled. A deprecated or superseded DR keeps its number, so a reference written long ago still resolves.
- The count covers \`{{decisionsDir}}/\` and nothing else. MinSpec resolves that directory inside this project and refuses a path that escapes it, so a register kept elsewhere is not somewhere the command can read or write. That is a fact about the tool, not a ruling on how your wider organisation logs decisions — keep whatever register you keep, and treat the two as separate sequences.

The number is the decision's permanent name: every commit, spec, issue, and comment that cites the decision cites the number. Hand-picking one breaks that in two ways, both painful to undo later. A **duplicate** makes a single reference resolve to two documents, with nothing to say which one the citing commit meant. An **out-of-range** number carried in from somewhere else — \`DR-212\` in a register that has reached \`DR-009\` — opens a permanent hole that every later reader has to investigate before concluding no history is missing. Neither is a style preference: renumber to the next local number and update every reference as soon as you spot it, because the longer the wrong number circulates, the more references there are to chase.

### Status is what makes a DR binding

| Status | Means |
|---|---|
| \`proposed\` | Written, not yet binding. Open for argument. |
| \`accepted\` | Binding. Code and specs must match it. |
| \`deprecated\` | No longer applies; nothing replaced it. |
| \`superseded\` | Replaced by a later DR — name it in \`superseded_by:\`, so a reader landing on the old file is pointed at the current one. |

Set status with *MinSpec: Accept Decision* or *MinSpec: Set Decision Status…* rather than hand-editing the frontmatter. The commands write the status **and** rewrite \`INDEX.md\`; a hand edit does the first only, which is exactly how the two drift apart. (*Accept Decision* also commits the flipped file and the regenerated index together while \`minspec.commitOnApprove\` is on, which is the default; *Set Decision Status…* leaves the change for you to commit.) Creating a DR does not touch the index at all — run *MinSpec: Regenerate Decision Register INDEX* after adding one.

A DR whose frontmatter says \`accepted\` while the index still calls it \`proposed\` makes the register lie about what is currently binding. That is worse than having no register, because a register gets trusted: nobody opens the file to double-check the summary.

## Pre-Commit Checks

MinSpec scaffolds git hooks into \`.minspec/hooks/\` and points this repo's local
\`core.hooksPath\` at that directory. That wiring is the point: the gates then run on
**every** commit — terminal, another editor, a build script, an AI agent — not only on
commits made through the Command Palette. A gate that fires in one editor is not a gate,
it is a suggestion, and the commits that most need checking are the ones made by whatever
tool skipped the UI.

Two notes about clones, because an inert gate is worse than no gate — it looks like a pass:

- The hooks are ordinary tracked files. **Commit them**, or a fresh clone gets none of this.
- \`core.hooksPath\` is *local* git config and does **not** survive cloning. Run
  *MinSpec: Refresh Harness Files* after a clone, or whenever a gate you expect never
  fires, to re-assert it.

| Gate | Hook | Refuses |
|---|---|---|
| Protected-branch guard | \`pre-commit\` | An authored commit on the default branch |
| Author identity gate (opt-in) | \`pre-commit\` | A \`user.email\` not in a configured allowlist |
| Secret scan | \`pre-commit\` | Staged changes containing a detected secret |
| Spec frontmatter | \`pre-commit\` | A staged spec missing \`id: SPEC-NNN\` |
| Deferred-work gate | \`commit-msg\` | A message that defers work without saying where it went |
| Root-cause gate | \`commit-msg\` | A \`fix:\` commit whose body has no \`Root cause:\` line |

### Protected-branch guard

Refuses a commit authored directly on the default branch when the repo has a remote. Where
that branch is protected, the commit can never be pushed — and the refusal would otherwise
arrive at \`git push\`, after the work is already sealed into branch history, where
recovering it needs branch surgery. Refusing at commit time costs one command; refusing at
push time costs a rescue.

It is deliberately narrow, because a gate that over-blocks gets switched off, and a
switched-off gate is worth nothing. It stays silent during a merge, cherry-pick, revert or
rebase, on a detached HEAD, in a repo with no remote (nothing to push to, so nothing to
protect), and whenever the default branch cannot be determined — unknown fails open.

It cannot know whether your default branch is *actually* protected; offline, the existence
of a remote is the only witness available. **If committing straight to the default branch
is correct for this project, turn the guard off permanently** rather than reaching for the
one-shot bypass every time:

| Want | Do |
|---|---|
| Allow this one commit | \`MINSPEC_ALLOW_MAIN=1 git commit ...\` |
| Allow always | \`git config minspec.allowCommitOnDefaultBranch true\` |
| Change the fallback branch names | \`git config minspec.protectedBranches "main trunk"\` |

That last row is a **fallback only**. The guard first asks git for the remote's default
branch by reading \`refs/remotes/<remote>/HEAD\` — a local ref, so no network call. When that
ref is populated, exactly that one branch is guarded and the name list is ignored. The list
applies only when the ref is missing, and defaults to \`main master trunk\`.

### Author identity gate

GitHub links a commit to an account by matching the commit's **author email** against the
verified emails on that account. An email that isn't verified anywhere can never be linked —
GitHub instead renders **"ghost mentioned this"** for every cross-reference the commit makes
(a PR, an issue comment, a closing keyword). That looks like a display bug; it is actually an
unnoticed identity misconfiguration, and nothing else in the harness would catch it — a wrong
\`user.email\` still produces a perfectly valid commit.

**Off by default.** This gate has no built-in list, because this template scaffolds into
projects whose author emails MinSpec cannot know in advance — asserting one unconditionally
would be exactly the blast-radius violation the harness must never commit. It activates only
once you configure an allowlist:

| Want | Do |
|---|---|
| Restrict commits to known-linked addresses | \`git config minspec.allowedCommitEmails "you@example.com bot@example.com"\` (space-separated) |
| Allow this one commit anyway | \`EMAIL_GATE_OFF=1 git commit ...\` |

\`git config\` is repository-local, so setting the allowlist once covers every worktree of the
repository — not just the checkout you set it from. If you see "ghost" attributions in your
own issue timelines, the fix for the *history* already made is to add the unlinked address as
a verified email on the GitHub account: GitHub re-links past commits automatically, with no
history rewrite required.

### Secret scan

If \`gitleaks\` is on PATH, it scans the staged changes locally and blocks on a finding,
printing the finding with the matched value redacted so you can act on it without the
secret being echoed. A committed credential is not undone by a later commit — it lives in
history and must be rotated, so this is one of the few places where blocking beats warning.

\`gitleaks\` is optional. When it is absent the hook prints a one-line advisory and continues,
because a missing optional tool must never wedge a commit. Read that advisory as what it
is: the gate is currently **not** protecting you. Install \`gitleaks\` rather than learning to
scroll past it.

### Spec frontmatter

Every staged spec markdown must carry an \`id: SPEC-NNN\` frontmatter line. The id is what
every other artifact points at — commits, decision records, task lists. A spec with no id
cannot be referenced, so the links that make the trail navigable silently fail to form.
Catching that at commit time is the difference between fixing one file and repairing a
month of dangling references.

The check runs through the best validator actually present: a Node validator if one is
already installed, else the bundled \`python3\` script, else a pure-shell fallback. Each tier
is used only if it can run and falls through otherwise, so a missing runtime degrades the
check instead of bricking the commit. Know the limit of the lower tiers: the \`python3\` and
shell tiers match paths under \`specs/\` literally, so if \`{{specsDir}}/\` differs from that,
only the Node tier sees your specs and a clean commit is not evidence the frontmatter is
valid.

### Deferred-work gate

A commit message that defers work — "follow-up", "out of scope", "held back", "separate
PR", "deferred" — must say where the deferred work went. Any of a tracked reference
(\`#123\`), a \`Follow-ups: none\` line, or a note that nothing was deferred satisfies it. The
check reads only the message text, so it needs no tracker and no network; \`Follow-ups: none\`
is a complete answer for a project that keeps no issues at all.

Work named in prose and nowhere else is lost the moment the commit scrolls out of view. The
gate costs one line and turns a vanishing intention into either a tracked item or an
explicit decision not to track it. It ignores the verbose diff below the scissors line, so
a \`git commit -v\` diff that happens to contain those words cannot trip it.

### Root-cause gate

A Conventional-Commit \`fix:\` subject must carry a \`Root cause:\` line in the body.

This is the cheapest available enforcement of *diagnose before you fix*. Writing the cause
as a sentence is what exposes a fix aimed at a symptom, and the sentence has to name a
**mechanism**: what produced the bad state, and which check should have rejected it. "The
field was missing" restates the symptom. "Nothing set the field on create, and the validator
only checks references that exist" is a cause. If you cannot write both halves, you have not
finished diagnosing.

A corollary worth internalising: if the fix is a pure data or config edit, you have almost
certainly not found the root cause. Bad state that "shouldn't be possible" means a check is
missing or one-sided. Patch the data to unblock, then add the check that makes the state
un-committable. Nothing enforces that second half — it is the habit the gate is trying to
buy.

### Bypassing

\`MINSPEC_GATE_OFF=1 git commit ...\` disables every gate above — both hooks honour it — for
a single commit, and each refusal also prints its own narrower escape. Use a bypass when the
gate is wrong about *this* commit, not to defer work the gate correctly identified.

The hooks fail open on their own internal errors, so a bug in the tooling never blocks a
legitimate commit. The price is that silence does not prove a check ran. If a gate has never
fired, confirm it is wired — \`git config --local core.hooksPath\` should print
\`.minspec/hooks\` — before concluding you are clean.

`;

const AGENTS_MD_TEMPLATE = `# {{projectName}} — Agent Instructions

## For AI Coding Assistants

This project uses MinSpec SDD (Specification-Driven Development). Before implementing any change:

1. **Check scope** — How far does this change reach (files, lines, boundaries)? That sets the tier — not how hard the change feels.
2. **Read the spec** — Check \`{{specsDir}}/\` for existing specs related to your task.
3. **Follow the tier** — Don't over-specify small-scope tasks. Don't under-specify wide-scope ones. The predicted tier is a floor: raise it (never lower it) if a small change is subtler than its footprint.

## Specs Directory

All specifications live in \`{{specsDir}}/\`. Each spec file uses Spec Kit-compatible markdown with YAML frontmatter.

## Decision Records

Architecture decisions are documented in \`{{decisionsDir}}/\`. Check existing decisions before proposing conflicting approaches.

## Constitution

Project invariants, principles, and constraints are in \`.minspec/constitution.md\`. These rules must never be violated.

{{#if invariants}}
### Key Invariants

> Summarized from \`.minspec/constitution.md\` — lead sentences only; the full text and rationale live there.

{{#each invariants}}
- {{firstSentence this}}
{{/each}}
{{/if}}

## Task Classification Guide

Before starting work, classify the task by its **mechanical scope** (blast radius), not by how hard it is to think through:

- **T1 (Contained):** Single file, one-line fix, typo, config change. One sentence of spec is enough.
- **T2 (Standard):** A few files, contained feature, no cross-boundary changes. Needs spec + plan.
- **T3 (Wide):** Many files, new APIs, schema/dependency changes. Full spec cycle.
- **T4 (Architectural):** Cross-project impact, new services, breaking changes. Complete ceremony required.

The classifier sees scope, not difficulty. A subtle one-line fix and a trivial one are the same size — so the predicted tier is a **floor**: raise it when a change is harder than its footprint, never lower it below the prediction.

## Naming waves, phases, and batches

Never refer to a group of work by a bare number.

- **Name what you coin.** A wave, batch, or group you invent gets a descriptive name ("the mechanical-bugfix wave"), never "Wave 1".
- **Gloss what is predefined.** When an identifier is fixed and numeric (\`Phase 2\`, \`Slice 3\`, \`T3\`), append a short reminder of what it covers the first time it appears in any response, doc, issue, PR, or commit — e.g. "Phase 2 (Public-ready — polish)".

A bare number makes the reader stop and look it up; a two-word gloss costs nothing.

## Human action items — mark them, then repeat them

Anything waiting on the human — a decision, a credential, a manual step, a merge — is invisible unless it is marked. One marker, two places.

- **Inline, the moment it arises.** Prefix the line with ➡️ mid-turn, where the need appears; never hold it back for the end.
- **Again at the end of every turn.** Close the response with a \`**Your turn**\` block repeating every still-pending item, one ➡️ line each. Nothing pending → omit the block; an empty one teaches the reader to skip it.
- **The heading carries no ➡️.** Only action items do, so the number of arrows equals the number of things waiting on the human — countable at a glance, with no off-by-one from the title.
- **Reserve ➡️ for this.** Never decorate ordinary prose with it, so scanning for ➡️ never returns a false hit.
- **Cite a pull request by number, not by URL.** Write \`#1231 short title\`. A bare
  \`https://\` link always opens a browser, which throws the reader out of the editor
  they are working in; a number is resolved in place by the editor's own pull-request
  integration. Say the state you already observed alongside it, so the reader can
  decide without opening anything at all.
- **Give each item a reply key.** One or two characters, restated on the line every turn so the human never scrolls back to find one: \`m\` merge · \`c\` close · \`d\` diff/details · \`r\` re-review · \`s\` skip.
- **Every choice carries a recommendation and its cost.** When an item asks the human to *decide*, name the option you recommend and, in the same breath, the primary downside or risk of the option you are recommending. A menu with no recommendation hands the analysis back to the human; a recommendation with no stated cost is advocacy, not advice. Mark it \`(rec)\` on the option and follow with one clause naming what it costs. This applies wherever a decision is put to a human — the \`**Your turn**\` block **and** the body of any issue, PR, or DR that asks them to choose.

The same block lists every pull request this session opened that is still unmerged — its number, the gate state already observed this turn, and its keys:

\`\`\`
**Your turn**
➡️ #1231 dispatch env scrub — ai-review:pass · needs-review — \`m\` merge · \`c\` close · \`d\` diff
➡️ Name the new hook — \`a\` agent-context **(rec)**, matches the existing \`agent-\` prefix but reads oddly for session-scoped state · \`b\` session-context
\`\`\`

Report the state you already observed; re-reading it from the git host is ordinary tool use, never a requirement, and MinSpec itself makes no network call.

## Rules

1. Never skip the spec phase, even for T1.
2. User override always wins — if the human says "just do it," do it. The predicted tier only ratchets up, never auto-down.
3. Ceremony must be proportional to scope — don't over-engineer small-scope tasks.
`;

const CURSORRULES_TEMPLATE = `# {{projectName}} — Cursor Rules

## Project Context

This project uses MinSpec SDD methodology. Specs in \`{{specsDir}}/\`, decisions in \`{{decisionsDir}}/\`.

## Invariants

{{#if invariants}}
> Summarized from \`.minspec/constitution.md\` — lead sentences only; the full text and rationale live there.

{{#each invariants}}
- {{firstSentence this}}
{{/each}}
{{else}}
<!-- Add project invariants here -->
{{/if}}

## Principles

{{#if principles}}
{{#each principles}}
- {{this}}
{{/each}}
{{else}}
- Ceremony proportional to scope (blast radius), not to perceived difficulty
- User override always wins
- Specs are living documents
{{/if}}

## Before Making Changes

1. Check if a spec exists for the area you're modifying
2. Classify the change by mechanical scope (T1-T4) — how far it reaches, not how hard it feels
3. Follow the appropriate ceremony level (the predicted tier is a floor — raise it, never lower it)
4. Never violate the invariants listed above

## Naming waves, phases, and batches

Never refer to a group of work by a bare number.

- **Name what you coin.** A wave, batch, or group you invent gets a descriptive name ("the mechanical-bugfix wave"), never "Wave 1".
- **Gloss what is predefined.** When an identifier is fixed and numeric (\`Phase 2\`, \`Slice 3\`, \`T3\`), append a short reminder of what it covers the first time it appears in any response, doc, issue, PR, or commit — e.g. "Phase 2 (Public-ready — polish)".

A bare number makes the reader stop and look it up; a two-word gloss costs nothing.

## Human action items — mark them, then repeat them

Anything waiting on the human — a decision, a credential, a manual step, a merge — is invisible unless it is marked. One marker, two places.

- **Inline, the moment it arises.** Prefix the line with ➡️ mid-turn, where the need appears; never hold it back for the end.
- **Again at the end of every turn.** Close the response with a \`**Your turn**\` block repeating every still-pending item, one ➡️ line each. Nothing pending → omit the block; an empty one teaches the reader to skip it.
- **The heading carries no ➡️.** Only action items do, so the number of arrows equals the number of things waiting on the human — countable at a glance, with no off-by-one from the title.
- **Reserve ➡️ for this.** Never decorate ordinary prose with it, so scanning for ➡️ never returns a false hit.
- **Cite a pull request by number, not by URL.** Write \`#1231 short title\`. A bare
  \`https://\` link always opens a browser, which throws the reader out of the editor
  they are working in; a number is resolved in place by the editor's own pull-request
  integration. Say the state you already observed alongside it, so the reader can
  decide without opening anything at all.
- **Give each item a reply key.** One or two characters, restated on the line every turn so the human never scrolls back to find one: \`m\` merge · \`c\` close · \`d\` diff/details · \`r\` re-review · \`s\` skip.
- **Every choice carries a recommendation and its cost.** When an item asks the human to *decide*, name the option you recommend and, in the same breath, the primary downside or risk of the option you are recommending. A menu with no recommendation hands the analysis back to the human; a recommendation with no stated cost is advocacy, not advice. Mark it \`(rec)\` on the option and follow with one clause naming what it costs. This applies wherever a decision is put to a human — the \`**Your turn**\` block **and** the body of any issue, PR, or DR that asks them to choose.

The same block lists every pull request this session opened that is still unmerged — its number, the gate state already observed this turn, and its keys:

\`\`\`
**Your turn**
➡️ #1231 dispatch env scrub — ai-review:pass · needs-review — \`m\` merge · \`c\` close · \`d\` diff
➡️ Name the new hook — \`a\` agent-context **(rec)**, matches the existing \`agent-\` prefix but reads oddly for session-scoped state · \`b\` session-context
\`\`\`

Report the state you already observed; re-reading it from the git host is ordinary tool use, never a requirement, and MinSpec itself makes no network call.

## Coding Standards

- Follow existing patterns in the codebase
- Keep changes focused and atomic
- Document decisions that are hard to reverse
`;

const CONSTITUTION_MD_TEMPLATE = `# {{projectName}} — Constitution

## Invariants

Rules that must never be violated. All changes must preserve them.

{{#if invariants}}
{{#each invariants}}
{{incremented @index}}. {{this}}
{{/each}}
{{else}}
<!-- Add invariants here. Example: -->
<!-- 1. No breaking changes to public API without deprecation cycle -->
<!-- 2. All user data stays local — no network calls without consent -->
{{/if}}

## Principles

Guidelines that should be followed. Can be bent in exceptional circumstances with justification.

{{#if principles}}
{{#each principles}}
{{incremented @index}}. {{this}}
{{/each}}
{{else}}
<!-- Add principles here. Example: -->
<!-- 1. Ceremony proportional to scope (blast radius), not perceived difficulty -->
<!-- 2. User override always wins -->
<!-- 3. Specs are living documents, not bureaucracy -->
{{/if}}

## Constraints

Technical or business constraints that bound the solution space.

{{#if constraints}}
{{#each constraints}}
{{incremented @index}}. {{this}}
{{/each}}
{{else}}
<!-- Add constraints here. Example: -->
<!-- 1. Must run offline — zero network dependency -->
<!-- 2. VS Code extension size < 5MB -->
<!-- 3. Node.js 18+ runtime only -->
{{/if}}

## Goals

What this project is trying to achieve. The outcomes work should ladder up to.

<!-- Add goals here. Example: -->
<!-- 1. Ship a frictionless SDD experience for solo developers -->
<!-- 2. Keep ceremony proportional to scope -->
`;

/** Registry of all templates keyed by name */
export const TEMPLATES: Record<TemplateName, string> = {
  'labels.md': LABELS_MD_TEMPLATE,
  'CLAUDE.md': CLAUDE_MD_TEMPLATE,
  'AGENTS.md': AGENTS_MD_TEMPLATE,
  '.cursorrules': CURSORRULES_TEMPLATE,
  'constitution.md': CONSTITUTION_MD_TEMPLATE,
};

/**
 * Compute the raw-template baseline: the SHA-256 of each *unrendered* template
 * section (`{{placeholders}}` intact), keyed by output path → heading.
 *
 * This is the canonical "which template version are we at" signal. Because it
 * hashes the raw template — never the rendered output — it is independent of any
 * project context: re-rendering with a different project name, specs dir, or
 * invariant list never perturbs it. `hasHarnessDrift` compares this (the current
 * bundled template) against the stored baseline (the template at last generate)
 * to decide whether the bundled template has genuinely moved upstream (#117).
 */
export function computeTemplateBaseline(): GeneratedHashes {
  const baseline: Record<string, SectionHashes> = {};
  for (const name of TEMPLATE_NAMES) {
    baseline[TEMPLATE_OUTPUT_PATHS[name]] = buildSectionHashes(
      parseSections(TEMPLATES[name]),
    );
  }
  // #241: managed-region templates (slash-command shims, CI workflow, git hooks)
  // also belong in the drift baseline so an upstream change to ANY of them — e.g.
  // a `/specify` shim guidance edit — fires the "templates updated, refresh?" prompt
  // exactly like a Markdown-template change. Each is keyed by its output path with a
  // single synthetic section (the marker `name`) hashing the raw managed block, the
  // same project-independent "which version are we at" signal used for the Markdown
  // templates. `hasHarnessDrift` iterates the baseline's recorded paths, so these are
  // compared like-for-like with no extra wiring.
  for (const tpl of MANAGED_REGION_TEMPLATES) {
    baseline[tpl.outputPath] = { [tpl.name]: hashSection(renderManagedBlock(tpl)) };
  }
  return baseline;
}

// ---------------------------------------------------------------------------
// Managed-region templates (#249, DR-037)
//
// A second class of scaffolded file that the Markdown section-merge engine
// (`mergeFile` / `parseSections` in merge-refresh.ts) cannot manage: its merge
// unit is the `## ` heading, so it can only carry Markdown. Non-Markdown harness
// artifacts — YAML workflows, shell scripts, JS/TS configs — have no `## `
// sections to merge and would be corrupted by section reassembly.
//
// Instead of treating these as opaque whole files, MinSpec wraps its owned
// content in comment-delimited MARKERS whose comment syntax matches the target
// file type — the same `minspec:` marker convention already used for the DR-index
// (`<!-- minspec:dr-index:start -->`), generalized to any file type:
//
//   # >>> minspec:managed:<name> >>>     (YAML / shell — `#` comments)
//   # <<< minspec:managed:<name> <<<
//   <!-- >>> minspec:managed:<name> >>> -->   (Markdown / HTML / XML)
//   <!-- <<< minspec:managed:<name> <<< -->
//   // >>> minspec:managed:<name> >>>    (JS / TS / C-family)
//   // <<< minspec:managed:<name> <<<
//
// Contract:
//   - Scaffold (init): write the file with the MinSpec-owned content wrapped in
//     the managed block. A fully-MinSpec-owned file (the CI workflow) = one
//     managed block spanning the file; the user adds custom content OUTSIDE the
//     markers.
//   - Refresh: parse the markers; OVERWRITE only the content BETWEEN them with the
//     current template; PRESERVE everything outside verbatim. User edits outside
//     the region survive; MinSpec's region stays current — the key improvement over
//     the old preserve-on-any-edit whole-file rule, which let one stray edit freeze
//     MinSpec out of its own region forever.
//   - Missing/corrupted markers (user deleted them): NEVER a silent clobber. If
//     the file exists but has no recognizable markers → SKIP + warn; if the file
//     is absent → re-scaffold it with markers.
//
// No content baseline file is needed — the markers ARE the boundary between
// MinSpec-owned and user-owned content. This mechanism is the reusable foundation
// for the hook-script scaffolds (#246/#247) and the python validator (#244).
// ---------------------------------------------------------------------------

/**
 * Comment syntax used to delimit a managed region, chosen to match the target
 * file type so the markers are valid comments in that language.
 *  - `hash`  → `#` line comments (YAML, shell, Python, TOML, .gitignore)
 *  - `html`  → `<!-- -->` block comments (Markdown, HTML, XML)
 *  - `slash` → `//` line comments (JS, TS, JSON-with-comments, C-family)
 */
export type CommentStyle = 'hash' | 'html' | 'slash';

/** Shared marker token — reuses the `minspec:` convention (cf. dr-index markers). */
const MANAGED_MARKER_PREFIX = 'minspec:managed:';

/**
 * Build the start marker line for a managed region of the given name + comment
 * style. Exported so the parser and tests derive markers from one source of truth
 * (never hand-typed, so the scaffold and refresh halves can never drift).
 */
export function managedRegionStartMarker(name: string, style: CommentStyle): string {
  const token = `>>> ${MANAGED_MARKER_PREFIX}${name} >>>`;
  switch (style) {
    case 'hash':
      return `# ${token}`;
    case 'slash':
      return `// ${token}`;
    case 'html':
      return `<!-- ${token} -->`;
  }
}

/** Build the end marker line for a managed region. See {@link managedRegionStartMarker}. */
export function managedRegionEndMarker(name: string, style: CommentStyle): string {
  const token = `<<< ${MANAGED_MARKER_PREFIX}${name} <<<`;
  switch (style) {
    case 'hash':
      return `# ${token}`;
    case 'slash':
      return `// ${token}`;
    case 'html':
      return `<!-- ${token} -->`;
  }
}

/** A scaffolded file with a comment-delimited MinSpec-managed region. */
export interface ManagedRegionTemplate {
  /** Stable identifier (used in markers, messages, tests). */
  readonly name: string;
  /** Output path relative to project root. */
  readonly outputPath: string;
  /** Comment syntax for the markers (must be valid in the target file type). */
  readonly commentStyle: CommentStyle;
  /**
   * The MinSpec-owned region body (between the markers). Managed-region templates
   * are NOT Handlebars-rendered — the content is project-independent and pinned so
   * the region stays byte-stable across projects.
   */
  readonly content: string;
  /**
   * When true, the scaffolded file is made executable (mode 0o755). Required for
   * the git hook scripts (`pre-commit`, `commit-msg`, `validate.py`) — git only
   * runs a hook file that carries the execute bit. Omitted/false for data files
   * (the CI workflow YAML).
   */
  readonly executable?: boolean;
  /**
   * A fixed line written ONCE, BEFORE the managed region's start marker — used for a
   * script shebang (`#!/usr/bin/env sh`), which a hook MUST carry on line 1 for git
   * to run it, OR for a slash-command shim's YAML frontmatter block (`---\n…\n---`),
   * which the AI tool reads on line 1. The preamble lives OUTSIDE the marked region on
   * purpose: a marker line cannot be line 1 (it would shadow the shebang/frontmatter),
   * and keeping it outside means a refresh preserves it as surrounding content via
   * `spliceManagedRegion`. It is (re)written only when the whole file is scaffolded or
   * re-scaffolded (`renderManagedFile`), never duplicated on an in-place region refresh.
   */
  readonly preamble?: string;
  /**
   * Optional gate: the template is scaffolded/refreshed ONLY when this predicate
   * returns true for the project's detected AI tools. Used by the slash-command
   * shims, which exist only for tools the project actually uses (a `.claude/commands/`
   * shim only when `CLAUDE.md` is present, the Cursor `.mdc` only when `.cursorrules`
   * is present). Omitted ⇒ always active (the CI workflow + git hooks, which are
   * tool-independent), preserving the existing unconditional behaviour.
   */
  readonly condition?: (tools: DetectedTools) => boolean;
}

/**
 * Wrap a managed-region template's content in its start/end markers, producing the
 * full block written to disk at scaffold time and used to overwrite the region on
 * refresh. The block is a self-contained unit: start marker, content, end marker,
 * each on its own line, newline-terminated. This is the SINGLE place the on-disk
 * managed-block shape is defined — scaffold and refresh both call it, so they can
 * never disagree about the bytes.
 */
export function renderManagedBlock(tpl: ManagedRegionTemplate): string {
  const start = managedRegionStartMarker(tpl.name, tpl.commentStyle);
  const end = managedRegionEndMarker(tpl.name, tpl.commentStyle);
  // Normalize: exactly one trailing newline on the content body so the end marker
  // always sits on its own line regardless of how the template literal was written.
  const body = tpl.content.replace(/\n+$/, '') + '\n';
  return `${start}\n${body}${end}\n`;
}

/**
 * Render the FULL on-disk file for a managed-region template at scaffold (or
 * re-scaffold) time: the optional `preamble` line (a script shebang) first, then a
 * blank line, then the managed block ({@link renderManagedBlock}).
 *
 * This is what the scaffold and the deleted-file re-scaffold paths write. An
 * IN-PLACE refresh does NOT use this — it splices `renderManagedBlock` into the
 * preserved surroundings (which already include the shebang), so the shebang is never
 * duplicated. With no preamble this is byte-identical to `renderManagedBlock` (the CI
 * workflow), keeping the existing behaviour unchanged.
 */
export function renderManagedFile(tpl: ManagedRegionTemplate): string {
  const block = renderManagedBlock(tpl);
  if (!tpl.preamble) return block;
  return `${tpl.preamble}\n\n${block}`;
}

/**
 * GitHub Actions workflow: the authoritative post-push MinSpec validation gate
 * (DR-037, #249). Runs the validator on every push / PR so that contributors
 * without the local git hooks — or any local bypass — are still caught before
 * merge. Local hook = fast fail; CI = never-merge guarantee.
 *
 * FAIL-CLOSED (DR-066 "No silent gate", #811). `MinSpec SDD validation` is a
 * REQUIRED status check (ruleset-advisor DEFAULT_REQUIRED_CHECK_CONTEXTS), so it
 * must have a reachable red path and must NEVER conclude success without actually
 * validating. The step runs the highest-fidelity validator that is genuinely
 * present, letting its exit code gate the job:
 *   1. `npm run validate` — the full Node validator, when the repo defines it
 *      (minspec's own tree, and any JS repo that wires it up);
 *   2. `python3 .minspec/hooks/validate.py` — the portable DR-037 validator,
 *      scaffolded into every MinSpec-inited repo (stock python3, no install);
 *   3. `@aiclarity/minspec-validator` — the published portable validator, once it
 *      exists and is resolvable (`--no-install` NEVER network-fetches, so an
 *      unclaimed scope can't be dependency-confusion-hijacked into CI).
 * If NONE is present the job FAILS — the one thing a required check may never do
 * is pass without validating. There is deliberately no branch that exits 0
 * without a validator having run (that was the #811 always-green bug).
 *
 * Pinned to a literal YAML string (no Handlebars): it is project-independent and
 * must remain byte-stable so the refreshed region matches exactly. The job
 * \`name: MinSpec SDD validation\` is the required-check CONTEXT — do not rename it
 * or branch protection strands every PR on a context that no longer reports.
 */
const MINSPEC_VALIDATE_WORKFLOW = `name: MinSpec Validate

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  validate:
    name: MinSpec SDD validation
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Run MinSpec validation (fail-closed — DR-066)
        run: |
          # A required check must have a reachable red path and must NEVER conclude
          # success without validating (DR-066 "No silent gate", clause 2 / #811).
          # Run the highest-fidelity validator that is actually present and let its
          # exit code gate the job. Do NOT add a branch that exits 0 without a
          # validator having run — that was the #811 always-green bug.
          if [ -f package.json ] && node -e "process.exit((require('./package.json').scripts||{}).validate?0:1)" 2>/dev/null; then
            echo "MinSpec SDD validation: running 'npm run validate' (Node validator)."
            npm ci
            npm run validate
          elif [ -f .minspec/hooks/validate.py ] && command -v python3 >/dev/null 2>&1; then
            echo "MinSpec SDD validation: running 'python3 .minspec/hooks/validate.py' (portable validator)."
            python3 .minspec/hooks/validate.py
          elif npx --no-install @aiclarity/minspec-validator --version >/dev/null 2>&1; then
            echo "MinSpec SDD validation: running '@aiclarity/minspec-validator'."
            npx --no-install @aiclarity/minspec-validator
          else
            echo "MinSpec SDD validation: no validator found." >&2
            echo "Looked for an npm 'validate' script, .minspec/hooks/validate.py, or @aiclarity/minspec-validator." >&2
            echo "A required check must fail closed (DR-066); it may never pass without validating." >&2
            exit 1
          fi`;

/**
 * Relative path under the project root where the editor-independent git hooks are
 * scaffolded (DR-037). `core.hooksPath` is pointed here so terminal / other-editor
 * / AI-agent commits run the same SDD gates as the VS Code command path — not just
 * the Command-Palette flow. Exported so `scaffold.ts` and the tests share one value.
 */
export const MINSPEC_HOOKS_DIR = '.minspec/hooks';

// ---------------------------------------------------------------------------
// DR-037 editor-independent gate harness (#244 / #246 / #247)
//
// Three cooperating scaffolded files, all managed-region templates so Refresh keeps
// them current while preserving any user edits OUTSIDE the markers:
//
//   .minspec/hooks/pre-commit  — shell. Two gates: (1) gitleaks secret scan (#244,
//       graceful-degrade to a warning when gitleaks is not installed), then (2) the
//       DR-037 detection chain (Node → python3 validate.py → shell grep) running the
//       spec-id frontmatter + ref-egress checks over the STAGED tree.
//   .minspec/hooks/commit-msg  — shell. The RCDD root-cause gate (DR-003): a
//       Conventional-Commit `fix:` subject must carry a `Root cause:` body line.
//       Pattern-matchable, so the shell tier owns it directly (never-wrong).
//   .minspec/hooks/validate.py — python3. The mid-tier of the detection chain
//       (#246): a language-agnostic frontmatter/spec-id validator mirroring the Node
//       validator's core FATAL checks (spec `id: SPEC-NNN`, `docs/domain` `type:`),
//       used when Node is not guaranteed in the commit environment.
//
// All three carry `#`-comment markers (shell + python both use `#`). They are pinned
// literal strings — project-independent, byte-stable so a refreshed region matches
// exactly — and marked `executable` so git will run them.
// ---------------------------------------------------------------------------

/**
 * Shell `pre-commit` hook (DR-037 / #247, #244). Four stages over the staged tree:
 *
 *  0. Protected-branch guard: refuse an authored commit on the default branch,
 *     which is push-protected and so can never receive a direct commit — the
 *     rejection would otherwise surface only at `git push`, after the work is
 *     already in branch history. Reads origin/HEAD (a local ref) so it stays
 *     offline; fires only for authored commits, and fails OPEN on anything it
 *     cannot determine. Opt out with MINSPEC_ALLOW_MAIN=1 or
 *     `git config minspec.allowCommitOnDefaultBranch true`.
 *
 *  1. Author identity gate (#1114, opt-in): refuse a commit whose `user.email`
 *     is not in a configured allowlist. GitHub links a commit to an account by
 *     matching the author email against that account's verified addresses; an
 *     unrecognized email can never be linked, and every cross-reference the
 *     commit makes then renders as "ghost mentioned this" in issue timelines —
 *     a display symptom of an identity misconfiguration nothing else catches.
 *     OFF by default (empty allowlist): this template scaffolds into projects
 *     whose author emails MinSpec cannot know in advance, so asserting one
 *     unconditionally would violate the harness's own blast-radius invariant.
 *     Opt in with `git config minspec.allowedCommitEmails "a@x.com b@x.com"`.
 *     Bypass (rare): EMAIL_GATE_OFF=1 git commit ...
 *
 *  2. Secret scan (#244): if `gitleaks` is on PATH, run it on the staged changes and
 *     BLOCK on a finding. If gitleaks is absent, emit a one-line advisory and
 *     CONTINUE — graceful degradation, never a hard fail for a missing optional tool.
 *  3. SDD validation (DR-037 detection chain): run the highest-fidelity validator
 *     that is ACTUALLY available — every tier is opportunistic and falls through if
 *     it cannot run, so an unreachable tier never bricks a commit (never-wrong):
 *       - Node — `npx --no-install @aiclarity/minspec-validator` ONLY if already
 *         resolvable (the `--no-install` probe never network-fetches, so the
 *         not-yet-published package can never E404-block a commit, #246 follow-up);
 *       - python — `python3 validate.py` ONLY if python3 + the script are present;
 *       - shell — the always-present `minspec_shell_gate`: the two pattern-matchable
 *         gates (spec `id:` frontmatter present; no MinSpec-internal ref leaking out
 *         per DR-032).
 *
 * Bypass (rare, explicit): MINSPEC_GATE_OFF=1 git commit ...
 * Fail-open on hook-internal errors so a tooling bug never blocks a commit wrongly.
 */
const PRE_COMMIT_HOOK = `# MinSpec pre-commit gate (DR-037) — editor-independent SDD + secret gates.
# Runs on EVERY commit (terminal, other editor, AI agent), not just the VS Code path.
# Bypass: MINSPEC_GATE_OFF=1 git commit ...
set -u

[ "\${MINSPEC_GATE_OFF:-0}" = "1" ] && exit 0

hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# ── Stage 0: protected-branch guard ──────────────────────────────────────────
# A commit authored on the default branch usually cannot be PUSHED: projects
# using this harness gate that branch on pull-request-only status checks, so the
# rejection lands at \`git push\` — long after the work is sealed into branch
# history, where recovering it needs branch surgery. Refusing here costs one
# command; refusing at push time costs a rescue.
#
# Offline by construction: the default branch is read from
# refs/remotes/origin/HEAD, a LOCAL ref written by \`git clone\` / \`git remote
# set-head\`. No network call, no forge API — the guard works air-gapped.
#
# Deliberately narrow, because a gate that over-blocks gets switched off and a
# switched-off gate is worth nothing. It fires ONLY for an authored commit on
# the branch git itself reports as origin's default, and never for an
# in-progress merge / cherry-pick / revert / rebase (those are how a branch
# legitimately lands), never on a detached HEAD, and never when the default
# branch cannot be determined — unknown fails OPEN, per the never-wrong rule.
# Does this repo have ANY remote? (#1545)
#
# The question the guard actually needs is "could a branch here be push-protected",
# and the honest witness for that is "a remote exists" — not "a remote named origin
# exists". Those were the same test until a repo turned up whose only remote was
# named after the project, at which point the guard concluded there was nothing to
# push to and passed silently on a protected branch.
minspec_has_remote() {
  [ -n "$(git remote 2>/dev/null)" ]
}

# The name of THE remote, or empty when there isn't an unambiguous one.
#
# origin wins whenever it exists, so every conventional repo behaves exactly as
# before. Otherwise a SOLE remote is unambiguous by construction, whatever it is
# called. Several remotes with no origin resolves to empty — we do not guess, and
# the caller must not read that emptiness as "no remote": see minspec_has_remote.
minspec_remote_name() {
  if git config --get remote.origin.url >/dev/null 2>&1; then
    echo origin
    return 0
  fi
  minspec_rn_all=$(git remote 2>/dev/null)
  if [ "$(printf '%s\\n' "$minspec_rn_all" | grep -c .)" = "1" ]; then
    printf '%s\\n' "$minspec_rn_all" | head -1
  fi
}

minspec_branch_guard() {
  if [ "\${MINSPEC_ALLOW_MAIN:-0}" = "1" ]; then return 0; fi
  if [ "$(git config --get minspec.allowCommitOnDefaultBranch 2>/dev/null)" = "true" ]; then return 0; fi

  guard_git_dir=$(git rev-parse --git-dir 2>/dev/null) || return 0
  if [ -z "\${guard_git_dir:-}" ]; then return 0; fi

  for guard_marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
    if [ -e "$guard_git_dir/$guard_marker" ]; then return 0; fi
  done
  if [ -d "$guard_git_dir/rebase-merge" ]; then return 0; fi
  if [ -d "$guard_git_dir/rebase-apply" ]; then return 0; fi

  # Detached HEAD reports no branch name — nothing to strand work on.
  guard_current=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || return 0
  if [ -z "\${guard_current:-}" ]; then return 0; fi

  guard_remote=$(minspec_remote_name)
  if [ -n "\${guard_remote:-}" ]; then
    guard_default=$(git symbolic-ref --quiet --short "refs/remotes/$guard_remote/HEAD" 2>/dev/null | sed "s|^$guard_remote/||")
  fi

  # origin/HEAD is the precise answer but is NOT always populated — it was absent
  # in both repos this guard was written for, which made the guard silently inert
  # exactly where it was needed. \`git remote set-head origin <branch>\` repairs
  # it, but the gate must not depend on someone having done that.
  #
  # Fall back to conventional protected names. Still not a hardcoded "main": only
  # these names are treated as protected, any other branch is untouched, and the
  # list is configurable per project via minspec.protectedBranches.
  #
  # Gated on ANY remote existing, not on one named \`origin\` (#1545). A repo with
  # no remote has nothing to push to, so no branch in it can be push-protected and
  # committing on \`main\` is entirely correct — scratch repos, fixtures and
  # local-only projects must never be blocked.
  #
  # The distinction matters and used to be lost: this read \`remote.origin.url\`, so
  # a repo whose remote carried any other name took the same path as a repo with no
  # remote at all and the guard went SILENTLY INERT on a protected branch. Failing
  # to resolve a remote is not evidence that none exists, and a merge-gating check
  # must fail closed on a missing witness rather than pass (constitution invariant
  # 2). Note this deliberately uses minspec_has_remote, NOT minspec_remote_name:
  # several remotes with no \`origin\` cannot be resolved, but the branch is still
  # push-protected and must still be guarded.
  if [ -z "\${guard_default:-}" ] && minspec_has_remote; then
    guard_candidates=$(git config --get minspec.protectedBranches 2>/dev/null || true)
    if [ -z "\${guard_candidates:-}" ]; then guard_candidates="main master trunk"; fi
    for guard_name in $guard_candidates; do
      if [ "$guard_current" = "$guard_name" ]; then
        guard_default="$guard_name"
        break
      fi
    done
  fi

  if [ -z "\${guard_default:-}" ]; then return 0; fi

  if [ "$guard_current" != "$guard_default" ]; then return 0; fi

  echo "✗ MinSpec gate: refusing to commit on '$guard_current' — this project's default branch." >&2
  echo "  It is push-protected (pull-request-only checks), so this commit could not be" >&2
  echo "  pushed and would strand the work in local history." >&2
  echo "" >&2
  echo "  Move the staged work onto a branch and commit there:" >&2
  echo "      git switch -c <branch-name>" >&2
  echo "      git commit ..." >&2
  echo "" >&2
  echo "  Already committed on $guard_current? Keep the work, then rewind the branch:" >&2
  echo "      git branch <branch-name>" >&2
  echo "      git reset --hard \${guard_remote:-origin}/$guard_default" >&2
  echo "" >&2
  echo "  Allow once:      MINSPEC_ALLOW_MAIN=1 git commit ..." >&2
  echo "  Allow in future: git config minspec.allowCommitOnDefaultBranch true" >&2
  return 1
}

if ! minspec_branch_guard; then
  exit 1
fi

# ── Stage 1: author identity gate (opt-in, #1114) ────────────────────────────
# GitHub links a commit to an account by matching the AUTHOR EMAIL against the
# verified addresses on that account. A \`user.email\` that isn't one of them
# can never be linked — GitHub instead renders "ghost mentioned this" for every
# cross-reference that commit makes, which reads as a display quirk but is
# really an unnoticed identity misconfiguration (a container session's ambient
# email shadowing the real one is the case this was written for).
#
# OFF by default: this template scaffolds into projects whose author emails
# MinSpec cannot know in advance, so asserting an identity here without an
# explicit opt-in would be the exact blast-radius violation the harness must
# not commit (constitution invariant 3). Configure it per project with:
#     git config minspec.allowedCommitEmails "you@example.com bot@example.com"
# (space-separated; git config is repository-local, so one \`git config\` call
# covers every worktree of the repository, not just this checkout.)
#
# Bypass (rare): EMAIL_GATE_OFF=1 git commit ...
if [ "\${EMAIL_GATE_OFF:-0}" != "1" ]; then
  minspec_allowed_emails=$(git config --get minspec.allowedCommitEmails 2>/dev/null || true)
  if [ -n "\${minspec_allowed_emails:-}" ]; then
    minspec_current_email=$(git config --get user.email 2>/dev/null || true)
    minspec_email_ok=0
    for minspec_allowed in $minspec_allowed_emails; do
      if [ "\${minspec_current_email:-}" = "$minspec_allowed" ]; then
        minspec_email_ok=1
        break
      fi
    done
    if [ "$minspec_email_ok" -ne 1 ]; then
      echo "✗ MinSpec gate: git config user.email '\${minspec_current_email:-<unset>}' is not in the configured allowlist." >&2
      echo "  An email GitHub cannot link to an account renders every commit and" >&2
      echo "  cross-reference it makes as 'ghost' in issue timelines." >&2
      echo "  Allowed: $minspec_allowed_emails" >&2
      echo "" >&2
      echo "  Fix:  git config user.email <one of the allowed addresses above>" >&2
      echo "  Bypass (rare): EMAIL_GATE_OFF=1 git commit ..." >&2
      exit 1
    fi
  fi
fi

# ── Stage 2: secret scan (#244, gitleaks) ────────────────────────────────────
# gitleaks is the recommended static, offline, read-only scanner. It is OPTIONAL:
# if it is not installed we warn and continue (graceful degradation) rather than
# block — a missing optional tool must never wedge a commit.
if command -v gitleaks >/dev/null 2>&1; then
  # CAPTURE, never discard (#1538). The refusal below tells the user to "review the
  # finding above", so the finding has to actually BE above — this previously sent
  # both streams to /dev/null and then pointed at what it had just thrown away,
  # leaving the one path a user must act on with nothing to act on.
  # -v is what makes the output a FINDING rather than a tally: without it gitleaks
  # prints only "leaks found: 1", which names neither the file nor the rule and so
  # cannot be reviewed. --redact stays on, so the matched VALUE is masked while the
  # rule id, file and line come through. Showing the finding diagnoses, it does not
  # disclose.
  if ! minspec_leak_out="$(gitleaks protect --staged --redact --no-banner -v 2>&1)"; then
    if [ -n "$minspec_leak_out" ]; then
      printf '%s\n' "$minspec_leak_out" >&2
    fi
    echo "✗ MinSpec gate: gitleaks found a potential secret in the staged changes." >&2
    echo "  Review the finding above; remove the secret or add a gitleaks allowlist entry." >&2
    echo "  Bypass (rare): MINSPEC_GATE_OFF=1 git commit ..." >&2
    exit 1
  fi
else
  echo "⚠ MinSpec gate: gitleaks not installed — secret scan SKIPPED." >&2
  echo "  Install gitleaks (https://github.com/gitleaks/gitleaks) to gate committed secrets." >&2
fi

# ── Stage 3: SDD validation (DR-037 detection chain) ─────────────────────────
# Highest-fidelity validator AVAILABLE wins, but every tier is OPPORTUNISTIC: a
# tier is used only when it can actually run, otherwise the chain falls through to
# the next. This is the never-wrong rule — a tier that cannot be reached (the npm
# validator not yet published/installed, python3 absent) must NEVER brick a commit;
# it degrades to the always-present shell gate below. Tiers:
#   Node   — only if @aiclarity/minspec-validator is ALREADY resolvable
#            (\`npx --no-install\`, never a network fetch that could E404-block).
#   python — only if python3 is on PATH and validate.py exists.
#   shell  — always present; the two pattern-matchable gates, inline below.

# minspec_shell_gate: the always-correct baseline. (1) every staged specs/**/ md
# file must carry an \`id: SPEC-NNN\` frontmatter line; (2) flag any staged non-hook
# file leaking a MinSpec-internal marker (DR-032 egress). Returns non-zero on a
# fatal (1) violation; the (2) leak is a warning only.
minspec_shell_gate() {
  gate_fail=0
  staged=$(git diff --cached --name-only --diff-filter=ACM)
  for f in $staged; do
    case "$f" in
      specs/*.md)
        # Frontmatter is the block between the first two \`---\` fences.
        if ! git show ":$f" 2>/dev/null | awk '
          /^---[[:space:]]*$/ { fence++; next }
          fence==1 && /^id:[[:space:]]*SPEC-[0-9]+/ { found=1 }
          END { exit(found?0:1) }'; then
          echo "✗ MinSpec gate: $f missing \\\`id: SPEC-NNN\\\` frontmatter." >&2
          gate_fail=1
        fi
        ;;
      docs/decisions/DR-*.md)
        # Decision records are approvables too, and were ungated until now: a DR
        # created by the MinSpec command carried frontmatter, one written by hand
        # carried none, and nothing noticed. Observed in a real project where
        # DR-001 (command-created) had it and DR-002/DR-003 (hand-written) had no
        # frontmatter at all — so the register held three records of which only
        # one was machine-readable.
        #
        # Same asymmetry the spec gate above already closes, one artifact class
        # over: the tooling validated what it created and never asserted the
        # class as a whole.
        #
        # The path is literal, matching the \\\`specs/\\\` case above — this hook is a
        # managed region rendered without template context, so a project that has
        # relocated its decisions directory is not covered. That is a known limit
        # of both gates, not a new one.
        if ! git show ":$f" 2>/dev/null | awk '
          /^---[[:space:]]*$/ { fence++; next }
          fence==1 && /^id:[[:space:]]*DR-[0-9]+/ { found=1 }
          END { exit(found?0:1) }'; then
          echo "✗ MinSpec gate: $f missing \\\`id: DR-NNN\\\` frontmatter." >&2
          gate_fail=1
        fi
        ;;
    esac
  done
  for f in $staged; do
    case "$f" in
      .minspec/hooks/*) continue ;;
    esac
    if git show ":$f" 2>/dev/null | grep -q 'minspec:managed:'; then
      echo "⚠ MinSpec gate: $f contains a \\\`minspec:managed:\\\` marker outside the hooks dir (possible internal-ref leak, DR-032)." >&2
    fi
  done
  if [ "$gate_fail" -ne 0 ]; then
    echo "" >&2
    echo "  Fix the errors above before committing." >&2
    echo "  Bypass (rare): MINSPEC_GATE_OFF=1 git commit ..." >&2
    return 1
  fi
  return 0
}

# Node tier — ONLY when the validator is already resolvable (no network fetch).
if command -v npx >/dev/null 2>&1 \\
   && npx --no-install @aiclarity/minspec-validator --version >/dev/null 2>&1; then
  npx --no-install @aiclarity/minspec-validator --pre-commit
  exit $?
fi

# Python tier — ONLY when python3 + validate.py are present.
if command -v python3 >/dev/null 2>&1 && [ -f "$hook_dir/validate.py" ]; then
  python3 "$hook_dir/validate.py" --pre-commit
  exit $?
fi

# Shell tier — always present.
minspec_shell_gate
exit $?`;

/**
 * Shell `commit-msg` hook (DR-037 / #247) — the RCDD root-cause gate (DR-003).
 *
 * A Conventional-Commit \`fix:\` subject MUST carry a \`Root cause:\` body line
 * (RCDD Phase 2 precedes Phase 3). Pattern-matchable, so the shell tier owns it
 * directly — actor-agnostic (reads the COMPOSED message from $1, catching -m,
 * heredoc, editor, or agent commits alike). Mirrors the monorepo's own gate.
 *
 * Bypass: MINSPEC_GATE_OFF=1 git commit ...   Fail-open on a missing message file.
 */
const COMMIT_MSG_HOOK = `# MinSpec commit-msg gate (DR-037) — RCDD root-cause (DR-003) + follow-up
# materialization (DR-023, blocking-for-commit-prose per DR-059). A \\\`fix:\\\` commit
# must document its diagnosis, and any commit that DEFERS work in prose must cite the
# follow-up. Bypass: MINSPEC_GATE_OFF=1 git commit ...
set -u

[ "\${MINSPEC_GATE_OFF:-0}" = "1" ] && exit 0

msg_file="\${1:-}"
[ -n "$msg_file" ] && [ -r "$msg_file" ] || exit 0   # fail open

# Scan the HUMAN-AUTHORED body only. First drop the \\\`git commit -v\\\` verbose diff
# (everything from the \\\`>8\\\` scissors line down) so diff text that merely contains
# "follow-up"/"out of scope"/"root cause" can never false-trigger a gate (DR-059 §3);
# then drop git comment lines. A message with no scissors line is unaffected.
body=$(sed '/^#.*>8/,$ d' "$msg_file" | grep -v '^#' || true)

# Subject = first non-empty body line.
subject=$(printf '%s\\n' "$body" | grep -m1 . 2>/dev/null || true)

# --- Follow-up materialization gate (DR-023 / DR-059) — runs on EVERY commit ---
# A commit that DEFERS work in prose must cite a tracked issue (#NNN), say
# "Follow-ups: none", or assert nothing was deferred. Prose-only "held back /
# separate PR / follow-up / out of scope" with no ref is a leak (the discipline that
# would have caught the CI-scope deferral). DR-059 records why this blocks where
# DR-040 kept DR-document materialization non-blocking (different surface).
if printf '%s\\n' "$body" | grep -Eiq 'held back|separate (pr|commit|review)|follow-?up|out of scope|deferred|not in this (pr|commit)'; then
  if ! printf '%s\\n' "$body" | grep -Eiq '#[0-9]+|follow-?ups?:? *none|tracked in|no(thing|ne)? *(deferred|follow-?ups?)|nothing (held|deferred)|(handled|done|fixed|addressed) (here|in this (pr|commit|change))'; then
    echo "✗ MinSpec follow-up gate (DR-023/DR-059): this commit defers work but files no follow-up." >&2
    echo "" >&2
    echo "  A commit that says 'held back / separate PR / follow-up / out of scope' must" >&2
    echo "  cite a tracked issue (#NNN), state 'Follow-ups: none', or note 'nothing deferred'." >&2
    echo "  Bypass (rare): MINSPEC_GATE_OFF=1 git commit ..." >&2
    exit 1
  fi
fi

# Only Conventional-Commit fix subjects are gated: fix:  fix(scope):  fix!:
echo "$subject" | grep -Eq '^fix(\\([^)]*\\))?!?:' || exit 0

# Require a \`Root cause:\` marker (case-insensitive, space or hyphen) in the body.
if printf '%s\\n' "$body" | grep -Eiq 'root[ -]cause:'; then
  exit 0
fi

echo "✗ MinSpec RCDD gate (DR-003): fix commit missing root cause." >&2
echo "" >&2
echo "  A \\\`fix\\\` commit must document the diagnosis. Add a body line:" >&2
echo "" >&2
echo "      Root cause: <one sentence>" >&2
echo "" >&2
echo "  RCDD Phase 2 (diagnose) precedes Phase 3 (fix)." >&2
echo "  Bypass (rare): MINSPEC_GATE_OFF=1 git commit ..." >&2
exit 1`;

/**
 * Python `validate.py` mid-tier validator (DR-037 / #246).
 *
 * The detection chain's middle tier, run when Node is not guaranteed in the commit
 * environment. It is a language-agnostic re-implementation of the Node validator's
 * core FATAL checks (CDD language-agnostic, #245):
 *
 *   - every spec markdown under \`specs/\` must carry \`id: SPEC-NNN\` frontmatter
 *   - every markdown under \`docs/domain/\` must carry \`type: domain\` frontmatter
 *
 * Frontmatter is parsed with the SAME lightweight \`key: value\` split the Node
 * \`validate-frontmatter.ts\` uses (first \`---\` … \`---\` block, split on the first
 * colon, trim) — no PyYAML dependency, so it runs on a stock python3. Scopes to the
 * STAGED tree (\`git diff --cached\`) when invoked as a pre-commit hook, else scans
 * the whole repo. Tier-0: deterministic, offline, no network, no third-party deps.
 *
 * Exit non-zero on any FATAL violation; 0 when clean. Mirrors the Node validator's
 * exit semantics so the chain behaves identically whichever tier runs.
 */
const VALIDATE_PY = `"""MinSpec mid-tier validator (DR-037 / #246).

Language-agnostic twin of the Node validate-frontmatter core FATAL checks:
  - specs/**/*.md must have \`id: SPEC-NNN\` frontmatter
  - docs/decisions/DR-*.md must have \`id: DR-NNN\` frontmatter
  - docs/domain/*.md must have \`type: domain\` frontmatter

Frontmatter parsing mirrors the Node validator exactly (first --- ... --- block,
split each line on the first colon, trim) — no PyYAML, so it runs on a stock
python3. Deterministic + offline (Tier-0, DR-004)."""

import os
import re
import subprocess
import sys

FM_RE = re.compile(r"^---\\n(.*?)\\n---", re.DOTALL)
SPEC_ID_RE = re.compile(r"^SPEC-\\d+$")
DR_ID_RE = re.compile(r"^DR-\\d+$")


def repo_root():
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except Exception:
        return os.getcwd()


def parse_frontmatter(content):
    """Mirror the Node parseFrontmatter: first --- ... --- block, key:value split."""
    m = FM_RE.match(content)
    if not m:
        return {}
    fm = {}
    for line in m.group(1).split("\\n"):
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        key = key.strip()
        if key:
            fm[key] = rest.strip()
    return fm


def staged_files(root):
    """Staged added/copied/modified files (pre-commit scope). [] on any git error."""
    try:
        out = subprocess.run(
            ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
            cwd=root, capture_output=True, text=True, check=True,
        )
        return [f for f in out.stdout.splitlines() if f.strip()]
    except Exception:
        return []


def staged_content(root, rel):
    """Content of the staged blob (what is ACTUALLY being committed)."""
    try:
        out = subprocess.run(
            ["git", "show", ":" + rel],
            cwd=root, capture_output=True, text=True, check=True,
        )
        return out.stdout
    except Exception:
        return None


def all_md(root, rel_dir):
    base = os.path.join(root, rel_dir)
    found = []
    for dirpath, _dirs, files in os.walk(base):
        for name in files:
            if name.endswith(".md"):
                found.append(os.path.relpath(os.path.join(dirpath, name), root))
    return found


def main():
    pre_commit = "--pre-commit" in sys.argv[1:]
    root = repo_root()

    if pre_commit:
        targets = staged_files(root)
        reader = lambda rel: staged_content(root, rel)
    else:
        targets = (
            all_md(root, "specs")
            + all_md(root, os.path.join("docs", "decisions"))
            + all_md(root, os.path.join("docs", "domain"))
        )
        def reader(rel):
            try:
                with open(os.path.join(root, rel), "r", encoding="utf-8") as fh:
                    return fh.read()
            except Exception:
                return None

    errors = 0

    for rel in targets:
        norm = rel.replace(os.sep, "/")
        is_spec = norm.startswith("specs/") and norm.endswith(".md")
        is_domain = norm.startswith("docs/domain/") and norm.endswith(".md")
        # A decision record, not the register's INDEX.md (a listing with no id).
        is_dr = (
            norm.startswith("docs/decisions/")
            and norm.endswith(".md")
            and os.path.basename(norm).startswith("DR-")
        )
        if not (is_spec or is_dr or is_domain):
            continue

        content = reader(rel)
        if content is None:
            continue
        fm = parse_frontmatter(content)

        if is_spec:
            spec_id = fm.get("id", "")
            # Strip an inline comment (\`id: SPEC-001  # note\`) before matching.
            spec_id = spec_id.split("#", 1)[0].strip()
            if not SPEC_ID_RE.match(spec_id):
                sys.stderr.write(
                    "FAIL " + norm + ": missing or invalid \`id: SPEC-NNN\` frontmatter\\n"
                )
                errors += 1

        if is_dr:
            dr_id = fm.get("id", "").split("#", 1)[0].strip()
            if not DR_ID_RE.match(dr_id):
                sys.stderr.write(
                    "FAIL " + norm + ": missing or invalid \`id: DR-NNN\` frontmatter\\n"
                )
                errors += 1

        if is_domain:
            if fm.get("type", "").split("#", 1)[0].strip() != "domain":
                sys.stderr.write(
                    "FAIL " + norm + ": missing \`type: domain\` frontmatter\\n"
                )
                errors += 1

    if errors:
        sys.stderr.write(
            "\\n" + str(errors) + " validation error(s). Fix before committing.\\n"
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())`;

// ---------------------------------------------------------------------------
// Spec Kit slash-command shims as managed-region templates (#241)
//
// The `/specify`, `/plan`, … shims MinSpec scaffolds into a project (Claude Code
// `.claude/commands/<cmd>.md`, Cursor `.cursor/rules/spec-kit-commands.mdc`) were
// CREATE-ONLY: init wrote them once, Refresh never updated them, so a guidance
// improvement (e.g. the #104 shift-left content) could never reach existing
// projects. We promote them to managed-region templates so they ride the SAME
// generate/refresh + drift path as every other harness file: refresh overwrites
// the MinSpec-owned region, preserves user content outside the markers, skips+warns
// on deleted markers, and re-scaffolds a deleted file.
//
// Both shim formats are Markdown carrying a YAML frontmatter block the AI tool reads
// on line 1. The frontmatter goes in `preamble` (written outside the region, on line
// 1, surviving refresh as surrounding content) and the body in the managed region with
// `html` comment markers (valid Markdown comments). Each shim is gated on the matching
// tool being detected (`condition`) so we never write a Claude shim into a Cursor-only
// project or vice-versa.
//
// The shim content is built from `slash-commands.ts` (`buildClaudeShim` /
// `buildCursorShim`, themselves derived from `COMMAND_GUIDANCE`), so converting them
// here introduces NO second copy of the guidance — there is one source of truth and a
// guidance edit flows straight into the refreshed region (and the drift baseline).
// ---------------------------------------------------------------------------

/** Output directory (relative to root) for Claude Code slash-command shims. */
export const CLAUDE_COMMANDS_DIR = '.claude/commands';
/** Output path (relative to root) for the single Cursor slash-command rules file. */
export const CURSOR_SLASH_COMMANDS_PATH = '.cursor/rules/spec-kit-commands.mdc';

/**
 * Split a shim document built by `slash-commands.ts` into its leading YAML
 * frontmatter block (`---\n…\n---`, the preamble written on line 1) and the body
 * that follows (the managed-region content). The builders always emit frontmatter
 * first, so a document that does not start with `---` is returned body-only (defensive
 * — never throw, so a builder change can never crash scaffolding).
 */
function splitShimFrontmatter(doc: string): { preamble: string; body: string } {
  const lines = doc.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { preamble: '', body: doc.replace(/^\n+/, '').replace(/\n+$/, '') };
  }
  // Find the closing fence (second `---` on its own line).
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) {
    // Malformed (no closing fence) — treat the whole thing as body, never lose content.
    return { preamble: '', body: doc.replace(/^\n+/, '').replace(/\n+$/, '') };
  }
  const preamble = lines.slice(0, close + 1).join('\n');
  const body = lines
    .slice(close + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  return { preamble, body };
}

/**
 * Stable managed-region marker name for a command's Claude Code shim. Shared by
 * the current (`minspec-<command>.md`) template AND the pre-#534 legacy-path
 * migration cleanup in `scaffold.ts`, so both recognize the exact same
 * MinSpec-owned region regardless of which filename it lives at.
 */
export function claudeShimTemplateName(command: (typeof SPEC_KIT_COMMANDS)[number]): string {
  return `slash-claude-${command}`;
}

/**
 * Pre-#534 bare-name output path for a command's Claude Code shim
 * (`.claude/commands/specify.md`). Superseded by the `minspec-`-prefixed path
 * below; kept only so `scaffold.ts` can detect and clean up the orphaned file
 * left behind when an already-initialized project upgrades.
 */
export function legacyClaudeShimOutputPath(command: (typeof SPEC_KIT_COMMANDS)[number]): string {
  return `${CLAUDE_COMMANDS_DIR}/${command}.md`;
}

/** Build the managed-region template for one Claude Code slash-command shim. */
function buildClaudeShimTemplate(
  command: (typeof SPEC_KIT_COMMANDS)[number],
): ManagedRegionTemplate {
  const { preamble, body } = splitShimFrontmatter(buildClaudeShim(command));
  return {
    name: claudeShimTemplateName(command),
    outputPath: `${CLAUDE_COMMANDS_DIR}/${slashCommandName(command)}.md`,
    commentStyle: 'html',
    content: body,
    preamble,
    condition: (tools) => tools.claude,
  };
}

/** Build the managed-region template for the single Cursor slash-command rules file. */
function buildCursorShimTemplate(): ManagedRegionTemplate {
  const { preamble, body } = splitShimFrontmatter(buildCursorShim());
  return {
    name: 'slash-cursor',
    outputPath: CURSOR_SLASH_COMMANDS_PATH,
    commentStyle: 'html',
    content: body,
    preamble,
    condition: (tools) => tools.cursor,
  };
}

/** The slash-command shim templates (one Claude file per command + one Cursor file). */
export const SLASH_COMMAND_SHIM_TEMPLATES: readonly ManagedRegionTemplate[] = [
  ...SPEC_KIT_COMMANDS.map(buildClaudeShimTemplate),
  buildCursorShimTemplate(),
];

// ---------------------------------------------------------------------------
// The never-wrong required-check CI stack (#564)
//
// `minspec-validate.yml` alone only ever gave a scaffolded repo a ONE-check gate
// (`MinSpec SDD validation`). The never-wrong merge-gate story also needs the
// independent AI reviewer + the label-integrity/merge gate, which until #564
// lived hand-built in the minspec repo only and were never scaffolded — so a
// freshly-inited repo (sealbox, scrooge) could never actually get the `ai-review`
// gate the ruleset-advisor is meant to enforce (scrooge PR #46: nothing ran).
//
// These are added as managed-region templates exactly like `validate-workflow`
// (markers → refresh keeps MinSpec's region current while preserving user edits
// outside it). All are PORTABLE — verified to carry ZERO minspec-repo-hardcoded
// values (owner/repo come from `github.repository*`, identities from repo secrets
// and the `AI_REVIEW_*` repo variables). The full, byte-exact file bodies are
// embedded in `ci-review-templates.ts` (base64 to dodge the template-literal
// escaping hazard of ~90 KB of `${{ … }}` / backtick / regex content); the
// `ci-stack-portability` test decodes each and asserts it equals the repo's own
// working file, so a scaffolded repo gets exactly what minspec itself runs.
//
// Dependency graph (all covered here so a scaffolded repo gets a WORKING stack):
//   ai-review.yml        → review-branch.sh, review-decide.sh, roles/reviewer.md,
//                          roles/security.md, .github/scripts/ai-review-guard.js
//   ready-to-merge.yml   → .github/scripts/ai-review-guard.js
//   ai-review-retry.yml  → re-runs ai-review.yml (by filename)
//   review-branch.sh     → roles/<role>.md, ../.github/scripts/ai-review-guard.js
//
// NOT included (out of #564 slice 1 scope): the human-only secrets + App install
// (slice 3), `render-review-signals.mjs` + the dev-time dispatch harness (no
// consumer in the CI gate; dispatch does not ship in the vsix), and the
// dev/triage/architect roles (dispatch-only, not used by ai-review.yml).
// ---------------------------------------------------------------------------

/**
 * Directory the scaffolded Claude Code hooks live in — under `.claude/`, beside the
 * `.claude/commands/` slash-command shims, because these are Claude-Code-specific
 * harness files. Deliberately NOT `MINSPEC_HOOKS_DIR`: that directory is git's
 * `core.hooksPath` (DR-037), where every file is a git hook by name.
 */
export const CLAUDE_HOOKS_DIR = '.claude/hooks';

/**
 * Claude Code hook stack (#1093, DR-073).
 *
 * `session-title.sh` + `session-title.py` are a `UserPromptSubmit` hook that appends
 * the approvable IDs a session is working on (`SPEC-019 DR-071 #1082`) to the Claude
 * Code session title, so the prompt box, the `/resume` picker, and the terminal tab
 * name the approvables under work. Scaffolding the files is only half the job — the
 * hook does nothing until it is registered in `.claude/settings.json`, which
 * `registerSessionTitleHook` (claude-settings.ts) does additively.
 *
 * Tool-gated on `tools.claude` like the slash-command shims: a project that does not
 * use Claude Code has no use for a Claude Code hook.
 *
 * The bodies are embedded byte-exact in `hook-templates.ts` (base64 — the wrapper is
 * full of `${VAR}` shell expansions a TS template literal would eat as interpolations),
 * generated from THIS repo's own working `.claude/hooks/*`, so a scaffolded project
 * gets exactly the hook minspec itself runs.
 */
const CLAUDE_HOOK_TEMPLATES: readonly ManagedRegionTemplate[] = [
  {
    name: 'session-title-hook-wrapper',
    outputPath: `${CLAUDE_HOOKS_DIR}/session-title.sh`,
    commentStyle: 'hash',
    content: SESSION_TITLE_SH,
    executable: true,
    preamble: SESSION_TITLE_SH_SHEBANG,
    condition: (tools) => tools.claude,
  },
  {
    name: 'session-title-hook',
    outputPath: `${CLAUDE_HOOKS_DIR}/session-title.py`,
    commentStyle: 'hash',
    content: SESSION_TITLE_PY,
    executable: true,
    preamble: SESSION_TITLE_PY_SHEBANG,
    condition: (tools) => tools.claude,
  },
];

// ---------------------------------------------------------------------------
// Vantage localization of the machinery-path comment (#1486)
//
// Everything else in the CI-review stack ships BYTE-IDENTICAL to the file this
// repo itself runs, and that is the point (see the portability note above). One
// comment block cannot: `ai-review.yml`'s MACHINERY_PATHS_RE explainer is written
// from MinSpec's own vantage. It says the pattern below it is "Read by
// packages/minspec/tests/machinery-paths.test.ts" and lists MinSpec's own gate
// files as though they were present wherever the workflow lands. In MinSpec that
// is true; in every consuming repo the test does not exist, so the copied line
// asserts a guarantee that is not there — the exact defect class MinSpec exists to
// prevent. It was caught downstream by AIClarityAU/scroogellm's own skeptic voter,
// and could not be corrected there: the file is parity-held byte-for-byte against
// what MinSpec emits, so a hand-edit drifts it and the next harness refresh
// overwrites it. A synced artifact is only correctable at its source, and the
// source of the SHIPPED copy is here.
//
// Scope discipline — this rewrites COMMENT LINES ONLY. The `grep -qE '<pattern>'`
// line that does the classifying is untouched, so a consuming repo runs the exact
// same machinery test MinSpec does; `machinery-comment-localization.test.ts` pins
// both halves of that (every differing line is a `#` comment, and the extracted
// pattern is character-identical).
//
// MinSpec's own `.github/workflows/ai-review.yml` is NOT scaffolded from this
// template — the CI-review stack is in `SELF_HOSTED_TEMPLATE_NAMES`, so this repo
// authors that file directly and keeps its true, MinSpec-vantage wording.
// ---------------------------------------------------------------------------

/** Opening marker of the machinery-path comment block in `ai-review.yml`. */
const MACHINERY_COMMENT_MARKER = '# MACHINERY_PATHS_RE';

/**
 * The claim that is true in MinSpec's repo and false in every other — the sentence
 * this localization exists to remove. Also the tripwire: if the upstream block stops
 * containing it, the block has been rewritten and the replacement below must be
 * re-read against it rather than applied blind.
 */
const MINSPEC_ONLY_TEST_PATH = 'packages/minspec/tests/machinery-paths.test.ts';

/**
 * The consuming-repo wording, unindented (the caller re-applies the source block's
 * own indentation, since the block sits inside a `run: |` scalar).
 *
 * Three things it must do, none of which the upstream text does: say nothing that is
 * false in a repo other than MinSpec, separate the alternations that exist anywhere
 * from the ones inherited from MinSpec and inert here, and state plainly that no
 * local test guards the pattern so the line is never read as covered.
 */
const LOCALIZED_MACHINERY_COMMENT: readonly string[] = [
  '# MACHINERY_PATHS_RE — the machinery path set (MinSpec #1284). Gate-ness is a property',
  '# of what the code DOES, not which directory it lives in: every entry here is code that',
  '# decides whether some other change is allowed, so it cannot certify itself.',
  '#',
  '# UNIVERSAL — present in any repo that scaffolds this stack:',
  '#   .github/   — the review workflows and their scripts',
  '#   scripts/   — dispatch, review, remediation, the lease',
  '#',
  "# INHERITED FROM MINSPEC — the remaining alternations name files in MinSpec's own",
  '# repo. Unless this repo happens to have files at those exact paths they never match,',
  '# and they are carried only so the pattern stays identical to the one MinSpec ships:',
  "#   .githooks/             — MinSpec's own pre-commit / pre-push / commit-msg gates",
  '#   template-registry.ts   — generates the .minspec/hooks/pre-commit gate',
  '#   ci-review-templates.ts — holds the verbatim copies of this workflow and its',
  '#                            scripts that MinSpec ships downstream',
  '#',
  '# ALSO CARRIED, NOT MINSPEC-SPECIFIC — generic CI-provider / git-hook directories that',
  '# may or may not exist here; kept so this pattern cannot silently narrow relative to',
  '# the one MinSpec ships:',
  '#   .circleci/  — CircleCI pipeline config',
  '#   .buildkite/ — Buildkite pipeline config',
  '#   .husky/     — husky-managed git hooks (same arbitrary-shell-on-commit surface as .githooks/)',
  '#',
  '# MEMBERSHIP TEST for anything added here: does this code decide whether some other',
  '# change is allowed — directly, or by generating the thing that decides? If yes it',
  '# cannot certify itself, and it belongs in this set.',
  '#',
  "# NO LOCAL TEST GUARDS THIS PATTERN. MinSpec's own repo has a test that parses the",
  '# line below out and executes it against a path table, but that test is not part of',
  '# the scaffolded stack, so here the line is unverified — change it and nothing in',
  '# this repo will tell you it stopped classifying correctly.',
];

/**
 * Rewrite the machinery-path comment block for a repo that is NOT MinSpec.
 *
 * Fails closed and loudly rather than degrading: a silent no-op would re-ship the
 * false coverage claim to every consuming repo, which is the failure being fixed.
 * The throw is reachable only by restructuring `ai-review.yml`'s comment block, and
 * `machinery-comment-localization.test.ts` runs this against the real workflow on
 * every PR, so the restructure is caught before it can reach an adopter.
 *
 * Exported for that test.
 */
export function localizeMachineryPathsComment(workflow: string): string {
  const fixHint =
    'Re-read that block against LOCALIZED_MACHINERY_COMMENT in template-registry.ts ' +
    'and update the replacement before shipping the workflow downstream (#1486).';
  const lines = workflow.split('\n');

  const start = lines.findIndex((l) => l.trimStart().startsWith(MACHINERY_COMMENT_MARKER));
  if (start === -1) {
    throw new Error(
      `template-registry: cannot localize ai-review.yml — no "${MACHINERY_COMMENT_MARKER}" ` +
        `line found. ${fixHint}`,
    );
  }

  // The block runs from the marker to the first non-comment line (the `elif … grep -qE`
  // guard), which is left exactly as it is.
  let end = start;
  while (end < lines.length && lines[end].trimStart().startsWith('#')) end++;

  if (!lines.slice(start, end).some((l) => l.includes(MINSPEC_ONLY_TEST_PATH))) {
    throw new Error(
      `template-registry: cannot localize ai-review.yml — the ${MACHINERY_COMMENT_MARKER} ` +
        `block no longer mentions ${MINSPEC_ONLY_TEST_PATH}. ${fixHint}`,
    );
  }

  const marker = lines[start];
  const indent = marker.slice(0, marker.length - marker.trimStart().length);
  const localized = [
    ...lines.slice(0, start),
    ...LOCALIZED_MACHINERY_COMMENT.map((l) => `${indent}${l}`),
    ...lines.slice(end),
  ].join('\n');

  // Belt-and-braces: the point of the exercise is that this string leaves the repo.
  if (localized.includes(MINSPEC_ONLY_TEST_PATH)) {
    throw new Error(
      `template-registry: ai-review.yml still references ${MINSPEC_ONLY_TEST_PATH} after ` +
        `localization — the claim appears outside the ${MACHINERY_COMMENT_MARKER} block. ${fixHint}`,
    );
  }

  return localized;
}

/** The three GitHub Actions workflows of the AI-review required-check stack (#564). */
const CI_REVIEW_STACK_TEMPLATES: readonly ManagedRegionTemplate[] = [
  {
    name: 'ai-review-workflow',
    outputPath: '.github/workflows/ai-review.yml',
    commentStyle: 'hash',
    // Comment-only rewrite — see the vantage-localization note above.
    content: localizeMachineryPathsComment(AI_REVIEW_WORKFLOW),
  },
  {
    name: 'ready-to-merge-workflow',
    outputPath: '.github/workflows/ready-to-merge.yml',
    commentStyle: 'hash',
    content: READY_TO_MERGE_WORKFLOW,
  },
  {
    name: 'ai-review-retry-workflow',
    outputPath: '.github/workflows/ai-review-retry.yml',
    commentStyle: 'hash',
    content: AI_REVIEW_RETRY_WORKFLOW,
  },
  {
    // The docs-lane (DR-051 Option 2, #575): a docs-only PR that opts in auto-merges
    // once the required checks pass. Shipped so an initialized repo GETS the lane
    // instead of hand-maintaining it — the corpus it enforces is generated from this
    // repo's own docs-lane.yml (one of the four lock-step SPEC-039 INV-2 enforcers),
    // so a downstream copy can never drift from the canonical corpus.
    name: 'docs-lane-workflow',
    outputPath: '.github/workflows/docs-lane.yml',
    commentStyle: 'hash',
    content: DOCS_LANE_WORKFLOW,
  },
  {
    name: 'review-branch-script',
    outputPath: 'scripts/review-branch.sh',
    commentStyle: 'hash',
    content: REVIEW_BRANCH_SH,
    executable: true,
    preamble: REVIEW_SCRIPT_SHEBANG,
  },
  {
    name: 'review-decide-script',
    outputPath: 'scripts/review-decide.sh',
    commentStyle: 'hash',
    content: REVIEW_DECIDE_SH,
    executable: true,
    preamble: REVIEW_SCRIPT_SHEBANG,
  },
  {
    // SOURCED by review-branch.sh at startup (the #912-recurrence setting-sources
    // pin). Unlike approval-provenance.py below, the caller does NOT guard on this
    // file existing — the source is deliberately unguarded, because silently
    // dropping the flag restores the roster-thrash outage it prevents. A consuming
    // repo that got the caller alone would therefore fail LOUDLY rather than
    // degrade, which is correct, but it still must be scaffolded alongside.
    name: 'agent-context-lib',
    outputPath: 'scripts/lib/agent-context.sh',
    commentStyle: 'hash',
    content: AGENT_CONTEXT_SH,
    executable: false,
    preamble: REVIEW_SCRIPT_SHEBANG,
  },
  {
    // Callee of review-branch.sh. It MUST be scaffolded alongside its caller: the
    // caller guards on the file existing and degrades to an empty provenance block,
    // so a repo that got the caller alone ran a permanently inert #1017 fix with no
    // signal that anything was missing (AIClarityAU/sealbox#32). The
    // `managed-script-dependencies` test now fails if a managed script references a
    // path that is not itself a managed template.
    name: 'approval-provenance-script',
    outputPath: 'scripts/approval-provenance.py',
    commentStyle: 'hash',
    content: APPROVAL_PROVENANCE_PY,
    executable: true,
    preamble: PY_SCRIPT_SHEBANG,
  },
  {
    // Imported by approval-provenance.py at load time — second level of the same
    // chain, and the reason the gate below runs the scaffolded set instead of only
    // reading it. stdlib-only, so the chain terminates here.
    name: 'canonical-hasher-python',
    outputPath: 'scripts/hooks/canonical.py',
    commentStyle: 'hash',
    content: CANONICAL_PY,
    executable: true,
    preamble: PY_SCRIPT_SHEBANG,
  },
  {
    name: 'review-role-reviewer',
    outputPath: 'scripts/roles/reviewer.md',
    commentStyle: 'html',
    content: ROLE_REVIEWER_MD,
  },
  {
    name: 'review-role-security',
    outputPath: 'scripts/roles/security.md',
    commentStyle: 'html',
    content: ROLE_SECURITY_MD,
  },
  {
    name: 'review-role-architect',
    outputPath: 'scripts/roles/architect.md',
    commentStyle: 'html',
    content: ROLE_ARCHITECT_MD,
  },
  {
    name: 'review-role-skeptic',
    outputPath: 'scripts/roles/skeptic.md',
    commentStyle: 'html',
    content: ROLE_SKEPTIC_MD,
  },
  {
    name: 'ai-review-guard',
    outputPath: '.github/scripts/ai-review-guard.js',
    commentStyle: 'slash',
    content: AI_REVIEW_GUARD_JS,
  },
] as const;

/**
 * Names of the managed-region templates whose canonical source is minspec's OWN
 * on-disk working file (the #564 CI-review stack, the #1093 Claude Code hooks), not
 * a scaffolded output.
 *
 * `checkManagedRegionMarkers` (scaffold.ts, #760) asserts every on-disk managed
 * template carries its markers — but minspec's own repo never marker-wraps these
 * particular files (see the `ci-stack-portability` suite in
 * managed-region-templates.test.ts, which asserts `tpl.content` equals these
 * files' raw bytes) and gates their freshness a different way instead
 * (`checkCiReviewTemplatesFresh` in scripts/validate-frontmatter.ts, #678). Used
 * to exclude them from the marker-presence gate IN THIS REPO ONLY — derived from
 * the template lists themselves so the exclusion can never drift from the
 * templates it names. A project that scaffolds FROM these templates (every
 * project other than minspec itself) has no such exclusion.
 */
export const SELF_HOSTED_TEMPLATE_NAMES: readonly string[] = [
  ...CI_REVIEW_STACK_TEMPLATES,
  ...CLAUDE_HOOK_TEMPLATES,
].map((t) => t.name);

/**
 * All managed-region templates in scaffold order.
 *
 * The tool-independent gate harness (CI workflow + git hooks, DR-037) stays FIRST so
 * the existing `MANAGED_REGION_TEMPLATES[0]` references in tests remain stable; the
 * AI-review required-check stack (#564) is appended after the DR-037 harness, then
 * the tool-gated Claude Code hooks (#1093) and slash-command shims (#241) last.
 */
export const MANAGED_REGION_TEMPLATES: readonly ManagedRegionTemplate[] = [
  {
    name: 'validate-workflow',
    outputPath: '.github/workflows/minspec-validate.yml',
    commentStyle: 'hash',
    content: MINSPEC_VALIDATE_WORKFLOW,
  },
  {
    name: 'pre-commit-hook',
    outputPath: `${MINSPEC_HOOKS_DIR}/pre-commit`,
    commentStyle: 'hash',
    content: PRE_COMMIT_HOOK,
    executable: true,
    preamble: '#!/usr/bin/env sh',
  },
  {
    name: 'commit-msg-hook',
    outputPath: `${MINSPEC_HOOKS_DIR}/commit-msg`,
    commentStyle: 'hash',
    content: COMMIT_MSG_HOOK,
    executable: true,
    preamble: '#!/usr/bin/env sh',
  },
  {
    name: 'validate-py',
    outputPath: `${MINSPEC_HOOKS_DIR}/validate.py`,
    commentStyle: 'hash',
    content: VALIDATE_PY,
    executable: true,
    preamble: '#!/usr/bin/env python3',
  },
  ...CI_REVIEW_STACK_TEMPLATES,
  ...CLAUDE_HOOK_TEMPLATES,
  ...SLASH_COMMAND_SHIM_TEMPLATES,
] as const;
