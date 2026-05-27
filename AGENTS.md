# AGENTS.md — MinSpec Monorepo

Cross-tool agent instructions. Valid for: Claude Code, Cursor, Copilot Workspace, and any agent that reads this file.

## Project Identity

- Repo: `harvest316/MinSpecPro`
- Publisher: `aiclarity`
- Two VS Code extensions in `packages/minspec` and `packages/scroogellm`
- Shared code in `packages/shared`

## Invariants (Non-Negotiable)

Before making ANY change, verify these will still hold:

1. MinSpec makes zero network calls in its core path
2. MinSpec spec files remain Spec Kit-compatible markdown
3. ScroogeLLM never stores API keys in plaintext
4. ScroogeLLM proxy binds localhost by default
5. No new npm dependencies without explicit justification (budget: 0-1 per simple change)

## Task Intake Format

Every agent task issue must include:
```
## Contract
<TypeScript interface the output must satisfy>

## Tests to pass
<file path(s) with invariant + feature tests>

## File allowlist
<explicit list of files agent may modify>

## Invariants
<numbered list from above that this task touches>
```

## Escalation Protocol

If you cannot fully and correctly complete a task — due to complexity, missing context, or uncertainty — output exactly:

```
ESCALATE: <one-line reason>
```

Then stop. Do not produce partial/stub output.

## File Structure Reference

```
specs/minspec/          SDD specs for MinSpec (requirements, design, tasks)
specs/scroogellm/       SDD specs for ScroogeLLM (not yet started)
docs/decisions/         DR-NNN.md decision register
docs/domain/            Bounded context knowledge docs
docs/research/          Market research
packages/minspec/       VS Code extension A
packages/scroogellm/    VS Code extension B
packages/shared/        Planned shared code (scaffold only — classifier currently in packages/minspec/src/lib/)
packages/extension-pack/MinSpec Pro
scripts/hooks/          Claude Code session hooks
```

## Current Work

MinSpec is in SDD Implement phase. Work from `specs/minspec/tasks.md`.

All nine implementation phases (Foundation through Polish & Launch) are complete. Remaining work is post-launch ScroogeLLM bridge integration (Phase 10).

## Testing

```bash
npm test              # all packages via vitest
npm run validate      # frontmatter validation
```

New code must have:
- T0 invariant tests for any change touching the 12 invariants
- T2 feature tests (happy path + primary failure) for new features

## Do Not

- Add network calls to `packages/minspec` core path
- Store secrets in any tracked file
- Modify files outside the task's file allowlist
- Skip tests for invariant-touching changes
- Add task checklists (`- [ ]`) to `docs/domain/` files
