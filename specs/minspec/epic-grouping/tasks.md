---
id: SPEC-009
type: tasks
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: done
product: minspec
epic: EPIC-001  # Explorer Epic Grouping
---

# MinSpec — Registered Epics & Grouping (Tasks)

**Date:** 2026-05-30
**Design:** [design.md](design.md)

---

## T1 — Foundation: epic-manager (the contract)

- [x] `lib/config.ts`: add `epicsDir` (default `docs/epics`), mirror `decisionsDir`.
- [x] `lib/epic-manager.ts`: `EpicFrontmatter`/`EpicSummary`/`EpicStatus`,
      `listEpics`, `resolveEpic`, `nextEpicId`, `createEpic`, `writeEpicIndex`,
      `groupByEpic`, `NO_EPIC`. Reuse adr-manager YAML pattern + markers.
- [x] `test/epic-manager.test.ts`: T1 contract tests (sort, id+slug resolve,
      padding, NO_EPIC bucketing).

## T2 — Frontmatter fields (additive)

- [x] `lib/spec.ts`: `SpecFrontmatter.epic?`, parse `epic:` line.
- [x] `lib/spec-manager.ts`: `SpecSummary.epic?` carried through.
- [x] `lib/adr-manager.ts`: `AdrFrontmatter.epic?` + `AdrSummary.epic?` + populate.

## T3 — Explorer grouping (parallel, one file each)

- [x] `views/spec-tree-provider.ts`: epic group layer + toggle + badge.
- [x] `views/adr-tree-provider.ts`: epic group layer + toggle + badge.
- [x] `views/backlog-view.ts`: `extractEpicSlug` + epic group layer + toggle.

## T4 — Create Epic command

- [x] `commands/create-epic.ts`: prompt + createEpic + writeEpicIndex + open.
- [x] `package.json`: command + 3 toggle commands + titlebar menus.
- [x] `extension.ts`: register command + toggle handlers.

## T5 — Completion + scaffold + validation

- [x] `views/frontmatter-completion.ts`: `epic:` key + value completion.
- [x] `lib/scaffold.ts`: create `docs/epics/` + empty INDEX on init.
- [x] validator: unresolved `epic:` ref → warning diagnostic (not block).

## T6 — Verify

- [x] T0 invariant tests (toggle-off identical, unknown ref no-throw, markers-only).
- [x] T2 feature tests (provider groups + badges, label resolution).
- [x] `npm run build && npm run lint && npm test && npm run validate` green.
