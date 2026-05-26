# MinSpec Monorepo — Claude Instructions

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

Topic drift → GitHub issue, do not act.

## Invariants

These rules must never be violated. All changes must preserve them.

### MinSpec (from specs/minspec/requirements.md)

1. **No AI dependency** — works with zero AI tools installed. No AI calls in core path.
2. **No backend** — zero network calls, no accounts, no telemetry, all local.
3. **No lock-in** — spec files are Spec Kit-compatible markdown. No proprietary format.
4. **Ceremony proportional to complexity** — T1 task never requires >1 sentence of spec.
5. **User override always wins** — classifier suggests, human decides. No forced classification.
6. **Harness file regeneration preserves user edits** — regenerate = merge, not overwrite.

### ScroogeLLM (from market research + design intent)

7. **All LLM calls through proxy** — no direct API access bypasses middleware chain.
8. **Savings auditable** — raw vs actual cost logged per request, inspectable by user.
9. **PII anonymization deterministic** — same input → same fake name, stable across session.
10. **User API keys in OS keychain only** — never stored in plaintext, never transmitted.
11. **Proxy binds localhost by default** — no remote exposure without explicit user opt-in.
12. **Free tier optimizations always active** — downgrades don't disable free optimizations.

## SDD Phases (current state)

MinSpec is at **Implement** phase. Work from `specs/minspec/tasks.md`.

ScroogeLLM has not started Specify phase. Future sessions only.

## File Locations

| Artifact | Location |
|---|---|
| Specs | `specs/<product>/*.md` |
| Decisions | `docs/decisions/DR-NNN.md` |
| Domain docs | `docs/domain/*.md` |
| Research | `docs/research/` |
| Contracts | `packages/shared/src/contracts/` |
| Hooks | `scripts/hooks/` |

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
npm run validate      # frontmatter validation
```

## Pre-Commit Checks

1. No secrets (API keys, tokens, high-entropy strings)
2. `specs/**/*.md` must have `id: SPEC-NNN` frontmatter
3. `docs/domain/*.md` must have `type: domain` frontmatter

## Decision Register

All architectural decisions → `docs/decisions/DR-NNN.md`. See `docs/decisions/INDEX.md`.

## Repo Mapping (DR-360 Parking Lot)

| Topic | GitHub repo |
|---|---|
| MinSpec extension / SDD tool | `harvest316/minspec` |
| ScroogeLLM extension / proxy | `harvest316/minspec` (same monorepo) |
| Shared infra / cross-project | `harvest316/mmo-platform` |
