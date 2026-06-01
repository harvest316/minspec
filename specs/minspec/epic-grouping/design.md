---
id: SPEC-008
type: design
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: done
product: minspec
epic: EPIC-001  # Explorer Epic Grouping
---

# MinSpec — Registered Epics & Grouping (Design / Plan)

**Date:** 2026-05-30
**Status:** Plan phase
**Requirements:** [requirements.md](requirements.md)
**Decision:** [DR-013](../../../docs/decisions/DR-013.md)

---

## Architecture

One new core module (`epic-manager.ts`) is the single source of truth. Frontmatter
type changes are additive (`epic?: string`). The three explorer panels gain a
top-level grouping layer driven by a per-panel toggle. No new dependency, no
network beyond the backlog's existing `gh issue list`.

### Module: `lib/epic-manager.ts` (new — the contract)

```ts
export type EpicStatus = 'proposed' | 'active' | 'done' | 'abandoned';

export interface EpicFrontmatter {
  readonly id: string;        // EPIC-NNN
  readonly slug: string;      // kebab handle (issue label suffix)
  readonly title: string;
  readonly status: EpicStatus;
  readonly order: number;
}

export interface EpicSummary extends EpicFrontmatter {
  readonly filePath: string;
}

/** Parse all docs/epics/EPIC-*.md into summaries, sorted by order then id. */
export function listEpics(rootDir: string): EpicSummary[];

/** Resolve an id ("EPIC-001") OR slug ("telemetry") to its summary, else null. */
export function resolveEpic(ref: string | undefined, epics: EpicSummary[]): EpicSummary | null;

/** max(EPIC-NNN)+1, zero-padded to 3 (EPIC-001). */
export function nextEpicId(rootDir: string): string;

/** Write a new EPIC-NNN.md from template; returns its path. */
export function createEpic(rootDir: string, title: string, slug?: string): string;

/** Regenerate docs/epics/INDEX.md inside minspec:epic-index markers (DR-011). */
export function writeEpicIndex(rootDir: string): void;

/** Bucket artifacts by resolved epic. Unresolved/absent → NO_EPIC sentinel. */
export const NO_EPIC = '(no epic)';
export function groupByEpic<T>(items: T[], refOf: (t: T) => string | undefined, epics: EpicSummary[]): Map<string, T[]>;
```

`epics/` directory location resolves from config (add `epicsDir`, default
`docs/epics`) mirroring `decisionsDir`. Reuse the lightweight YAML parser pattern
already in `adr-manager.ts`; `order` coerced via `Number()`, default `999`.

### Frontmatter changes (additive, backward compatible)

- `lib/spec.ts` — `SpecFrontmatter` gains `readonly epic?: string`; parser reads
  the `epic:` line. `SpecSummary` (spec-manager) carries it through.
- `lib/adr-manager.ts` — `AdrFrontmatter` + `AdrSummary` gain `readonly epic?: string`;
  both `parseFrontmatterYaml` consumers populate it.

Absent field → `undefined` → ungrouped. No migration.

### Explorer grouping (per panel)

Toggle = workspace-state key `minspec.<panel>.groupByEpic`, default `true`,
flipped by a command `minspec.<panel>.toggleEpicGrouping` (titlebar nav icon).

When **on**: top level = `EpicGroupNode[]` (one per epic with members, sorted by
order→id) + a trailing `NO_EPIC` group when non-empty. Children = the panel's
existing leaf nodes (SpecNode / AdrNode / issue node), flat under the epic (no
status sub-nesting — keeps depth at 2). Epic node `description` = `done/total`
badge (terminal per kind: spec `done`, ADR `accepted|done`, issue closed).

When **off**: exact current behavior (status groups), unchanged.

`backlog-view.ts` resolves an issue's epic from its `epic:<slug>` label via a new
`extractEpicSlug(labels)` helper (mirrors `extractWsjfFromLabels`), matched to a
registry slug.

### Create Epic command

`commands/create-epic.ts` → prompts title (+ optional slug, default `slugify(title)`),
calls `createEpic` + `writeEpicIndex`, opens the file. Registered in package.json
`contributes.commands` as **MinSpec: Create Epic**, wired in `extension.ts`.
Mirrors the existing Create ADR command end-to-end.

### Completion + scaffold + validation

- `frontmatter-completion.ts` — offer `epic:` key in spec/ADR frontmatter; value
  completion lists `EPIC-NNN` ids + slugs from `listEpics`.
- `scaffold.ts` — `minspec init` creates `docs/epics/` + empty marker INDEX.
- Validation (spec-validator / adr) — `epic:` ref not resolving = **warning**
  diagnostic, never a block (FR-9).

## Test plan

- **T0 (invariants):** absent `epic` → ungrouped, no error; unknown ref →
  `resolveEpic` null + warning not throw; grouping toggle off → byte-identical to
  current tree; INDEX writes only inside markers.
- **T1 (contract):** `epic-manager` public fns — `listEpics` sort, `resolveEpic`
  id+slug, `nextEpicId` padding, `groupByEpic` NO_EPIC bucketing.
- **T2 (feature):** spec/adr providers produce epic groups with correct badges;
  backlog label resolution.

## Implementation order (dependency-gated)

1. `epic-manager.ts` + config `epicsDir` + T1 tests — **the contract; lands first.**
2. Frontmatter `epic?` on spec + adr (+ summaries) — parallel after (1).
3. Three panels grouping + toggles — parallel after (2), each its own file.
4. Create Epic command + package.json + extension wiring.
5. Completion + scaffold + validation warning.
6. Tests T0/T2 + `npm run build/lint/test`.

## Out of scope (per requirements)

Milestones, bidirectional sync, weighted roll-up, merged work-item tree,
epic auto-assignment.
