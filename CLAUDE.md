# minspec-monorepo — Project Instructions

## Overview

minspec-monorepo project managed with MinSpec SDD methodology.

- **Specs directory:** `specs/`
- **Decisions directory:** `docs/decisions/`

## Invariants

These rules must never be violated. All changes must preserve them.

### INV-1 — `minspec-extension-deployed`: public ADR references gate on visibility

Public-facing surfaces — `sites/**`, `packages/*/README.md`, `packages/*/CHANGELOG.md`, and any VS Code Marketplace / Open VSX listing copy — reference ADR entries (`DR-NNN`) only under these rules:

1. **Repo or ADR private → no public DR references.** If `github.com/harvest316/minspec` is private, or `docs/decisions/` is not publicly readable, do NOT cite `DR-NNN` on any public web page or store listing. A private link 404s for visitors and leaks internal identifiers. Describe the decision in prose instead, no DR id.
2. **Repo and ADR both public → DR references must be clickable.** Every `DR-NNN` mention links to its published ADR: `https://github.com/harvest316/minspec/blob/main/docs/decisions/DR-NNN.md`. No bare unlinked `DR-NNN` text on public surfaces.
3. **Check before deploy/publish.** Before deploying a site or publishing an extension, confirm repo visibility (`gh repo view harvest316/minspec --json isPrivate`) and that every public `DR-NNN` either links (public) or is removed (private).

Rationale: ADR ids are an internal traceability convention; exposing them publicly only helps readers if the target actually resolves. See the Traceability Convention section.

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
| `packages/scroogellm` | `aiclarity.scroogellm` | scroogellm.com | SDD Specify (future) |
| `packages/shared` | `@aiclarity/shared` | — | Shared classifier |
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

ScroogeLLM has not started Specify phase. Future sessions only.

## Traceability Convention

Commits, issues, and DRs form a linked chain:

- **Commits** reference issue: `feat(#N): description` or `fix(#N): description`
- **DRs** reference triggering issue: `Triggered by: #N` in body
- **Issues** reference DR if one exists: link in issue body
- **Sub-issues** reference parent DR: `See DR-NNN for design rationale`

Purpose: Issues = what needs doing. DRs = why we chose this approach. Commits = what changed. Don't consolidate — link.

## Agent Dispatch (Tier-Gated HITL)

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
| ScroogeLLM extension / proxy | `harvest316/minspec` (same monorepo) |
| Shared infra / cross-project | `harvest316/mmo-platform` |
