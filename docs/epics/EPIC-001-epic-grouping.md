---
id: EPIC-001
slug: epic-grouping
title: Explorer Epic Grouping
status: active
order: 7
---

# EPIC-001: Explorer Epic Grouping

## Goal

Give MinSpec a grouping dimension above the individual artifact, so a body of
work spanning multiple specs, ADRs, and issues is visible as one unit in the
explorer. "Done" = registered epics (`docs/epics/EPIC-NNN.md`) referenced by
specs/ADRs (`epic:` frontmatter) and issues (`epic:<slug>` label), with a
top-level epic grouping layer in all three explorer panels behind a per-panel
toggle, plus a Create Epic command, completion, scaffold, and soft validation.

## Artifacts

- **Decision:** [DR-013](../decisions/DR-013.md) — registered epics design.
- **Specs:** [SPEC-007 requirements](../../specs/minspec/SPEC-007-epic-grouping/requirements.md),
  [SPEC-008 design](../../specs/minspec/SPEC-007-epic-grouping/design.md),
  [SPEC-009 tasks](../../specs/minspec/SPEC-007-epic-grouping/tasks.md).
- **Issues:** label `epic:epic-grouping` (none open — shipped in one session).
