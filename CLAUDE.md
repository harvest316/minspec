# minspec-monorepo — Project Instructions

## Overview

minspec-monorepo project managed with MinSpec SDD methodology.

- **Specs directory:** `specs/`
- **Decisions directory:** `docs/decisions/`

## Invariants

These rules must never be violated. All changes must preserve them.

<!-- Add project invariants here -->

## SDD Methodology

This project uses Specification-Driven Development. Tasks are classified by complexity tier:

| Tier | Ceremony | Phases Required |
|------|----------|-----------------|
| T1 | One-sentence spec | specify |
| T2 | Spec + plan | specify, plan |
| T3 | Full spec cycle | specify, plan, tasks, implement |
| T4 | Complete ceremony | all phases |

## File Locations

| Artifact | Location |
|---|---|
| Specs | `specs/` |
| Decisions | `docs/decisions/` |
| Constitution | `.minspec/constitution.md` |
| Config | `.minspec/config.json` |

## Commands

```bash
# Initialize SDD structure
minspec init

# Refresh harness files (preserves user edits)
minspec init --refresh

# Classify task complexity
minspec classify
```

## Project Overview

Monorepo for two VS Code extensions + extension pack:

| Package | ID | Domain | Status |
|---|---|---|---|
| `packages/minspec` | `aiclarity.minspec` | minspec.dev | SDD Implement phase |
| ↪ split out → **`harvest316/scroogellm`** (private) | `aiclarity.scroogellm` | scroogellm.com | Moved to its own repo per DR-027; SDD Specify there. Code lands there (harvest316/minspec#119), not in `packages/`. |
| `packages/shared` | `@aiclarity/shared` | — | Tier-0 shared: contract types + classifier engine (no vscode/network). See DR-014 |
| `packages/extension-pack` | `aiclarity.minspec-pro` | — | References both |

## Session Scope Protocol

Declare at session start:
```
Session scope: [one sentence]
Project: minspec / scroogellm / shared / infra
Type: bug / feat / explore / plan
```

### Triage Rules

0. **Root cause before fix.** Never rush into fixing an issue. Always identify root cause first — even for off-topic issues that get parked. Park ≠ skip the diagnosis.
1. **Topic drift → GitHub issue, do not act.** File on the relevant repo with `inbox` label, report URL, continue original scope.
2. **Scope-expansion triggers.** When the in-scope request contains any of these verbs, confirm before implementing — they almost always hide new scope:
   - "integrate with X" (≠ "detect X")
   - "also support X" / "include X too"
   - "expand to X" / "extend to X"
   - "and X" tacked on as a follow-up to an already-defined scope
   - "make it work with X" where X is a system not previously named
   Default action: confirm with user OR park as separate issue. Do NOT silently expand.
3. **Detection ≠ integration.** Reading a signal (filesystem existence, extension presence) is small. Acting on it (custom commands, exports, bidirectional sync) is a new feature surface. Treat them as separate work items.

## SDD Phases (current state)

MinSpec is at **Implement** phase. Work from `specs/minspec/tasks.md`.

ScroogeLLM was split into its own **private** repo (`harvest316/scroogellm`, `~/code/scroogellm`) per DR-027 and is in **Specify** there (SPEC-100/101/102). Do ScroogeLLM work in that repo, not here. Public proxy implementation tracked at harvest316/minspec#119. Note: scroogellm keeps its OWN local DR register (independent of this repo's); DR-007/010 were imported there with their original numbers.

## Traceability Convention

Commits, issues, and DRs form a linked chain:

- **Commits** reference issue: `feat(#N): description` or `fix(#N): description`
- **DRs** reference triggering issue: `Triggered by: #N` in body
- **Issues** reference DR if one exists: link in issue body
- **Sub-issues** reference parent DR: `See DR-NNN for design rationale`
- **DRs materialize their follow-ups (DR-023):** every DR carries a `## Follow-ups
  (tracked)` section; each actionable item it surfaces links a `SPEC-NNN` or a
  GitHub issue `#`. Forward rule — when writing a DR, **file the issues for any
  follow-up not covered by a spec** (especially cross-repo / non-code work like
  site/marketplace copy, which never enters the SDD flow). Prose-only consequences
  are a leak. `None` is a valid, explicit answer.

Purpose: Issues = what needs doing. DRs = why we chose this approach. Commits = what changed. Don't consolidate — link. Chain is bidirectional: issue→DR (rationale) and DR→issue/spec (materialization).

## Evidence Discipline — status claims (RCDD / DR-003)

Before writing **"implemented / done / built / works / shipped"** about a feature into
any artifact (spec, DR, README, comment), verify the **authoritative** signals, not
proxies:

- ✅ the feature's **code** — grep/read the actual implementation; cite `file:line`.
- ✅ the owning spec's **`status`** field — `done`/`implementing`, not `specifying`.
- ❌ **NOT** evidence: a file or spec *exists*, a commit *subject* mentions it, an
  issue is *closed*. **Artifact-existence ≠ feature-existence.**

If unverified, write the honest state ("specified, not built" / "planned, #NN"). In a
*never-wrong* product a false "implemented" is the worst defect — it makes the signpost
lie. (Root-caused 2026-06-01: SPEC-002 falsely called SPEC-014's review webview
"implemented" — it was `specifying`, zero code. Deterministic backstop tracked as an
issue, sibling to #47.)

**Sibling rule — root cause ≠ bad-state restatement (RCDD, DR-003 addendum).** Just
as *artifact-existence ≠ feature-existence*, a *description of a bad state* ≠ its *root
cause*. "Frontmatter field is missing" is a symptom; the cause is the mechanism that
produced it **plus** the gate that should have rejected it. A pure data/config fix is a
tell that the gate is missing — fix the gate too (see DR-003 Phase 4 asymmetry check).
Root-caused 2026-06-01: SPEC-004's missing `epic:` was first "fixed" with a data edit
alone; the real defect was `validateSpec` flagging dangling refs but not missing ones.

## Agent Dispatch (Tier-Gated HITL)

The `scripts/` dispatch below is the **dev-time** path for building this monorepo.
Productized, agent dispatch does NOT ship inside MinSpec (Tier 0 / air-gapped) — it
ships as a separate third "Execute" extension (`aiclarity.agent-execute`, Tier 1).
See DR-015 for packaging, DR-004 for the tier model, DR-008 for dispatch security.

Triage agent auto-dispatches T1-T2 issues (`agent-ready`). T3-T4 get `needs-review` — human approves spec/plan before agent starts. Per SDD FR-2: Clarify phase required for T3-T4.

Roles: `scripts/roles/` — triage, dev, architect, security, reviewer.
Dispatch: `scripts/dispatch-issue.sh <N>` — reads `role:X` label, loads role prompt.
Triage: `scripts/triage-inbox.sh [N]` — processes inbox issues.

## Deploy Reference

VS Code extensions do not auto-deploy. Manual steps:

```bash
# Package an extension
cd packages/minspec && npm run package   # produces .vsix

# Publish (when ready — requires vsce token)
cd packages/minspec && npx vsce publish
```

## Test Commands

```bash
npm test              # all packages
npm run lint          # all packages
npm run build         # all packages
npm run validate      # frontmatter validation
```

## Pre-Commit Checks

1. No secrets (API keys, tokens, high-entropy strings)
2. `specs/**/*.md` must have `id: SPEC-NNN` frontmatter
3. **RCDD root-cause gate (DR-003).** `.githooks/commit-msg` rejects any
   `fix:`/`fix(scope):`/`fix!:` commit whose body lacks a `Root cause:` line.
   Installed via `core.hooksPath=.githooks` (set by `npm install` → `prepare`).
   Intentional bypass: `RCDD_GATE_OFF=1 git commit ...`

## Decision Register

All architectural decisions → `docs/decisions/DR-NNN.md`. See `docs/decisions/INDEX.md`.

**This project keeps its OWN local register, sequential from `DR-001`.** It does
NOT share the global `~/code/mmo-platform/docs/decisions.md` register (currently
~DR-360). The global CLAUDE.md rule "next sequential number, all projects" does
**not** apply here — it is overridden by this project-local register.

- Next number = `max(existing DR-NNN in docs/decisions/) + 1`. Use the MinSpec
  ext (**MinSpec: Create ADR**), which computes this correctly and writes the
  standard template. Do not hand-pick a number from the global register.
- A DR created with an out-of-sequence number (e.g. a global-register number
  like `DR-012` in this repo) is a convention error — renumber to the next local
  number and update all references.

## Repo Mapping (Parking Lot)

| Topic | GitHub repo |
|---|---|
| MinSpec extension / SDD tool | `harvest316/minspec` |
| ScroogeLLM extension / proxy | `harvest316/scroogellm` (private; split from monorepo per DR-027) |
| Shared infra / cross-project | `harvest316/mmo-platform` |
