---
id: EPIC-003
slug: sdd-core
title: SDD Core Methodology
status: active
order: 1
---

# EPIC-003: SDD Core Methodology

## Goal

The foundational Specification-Driven Development engine of the MinSpec
extension: the tier classifier (T1–T4), the phase model (specify → clarify →
plan → tasks → implement), frontmatter contracts, and the validation/approval
gates that make a spec safe to implement against.

**Done** = a project can run the full SDD cycle end-to-end inside the editor —
classify a task, author each required phase for its tier, validate frontmatter,
and approve a complete spec for implementation — with the methodology rules
enforced by the extension rather than by convention.

## Artifacts

Specs/ADRs reference this epic via `epic: EPIC-003` (or `epic: sdd-core`)
frontmatter. Issues via the GitHub label `epic:sdd-core`.

- `specs/minspec/{requirements,design,tasks}.md` — core SDD spec
- [SPEC-013 Risk-Section Policy Enforcement](../../specs/minspec/SPEC-013-risk-section-policy/requirements.md)
  — templates + soft validator rule for the mandatory Risks & Mitigations section
- DR-001, DR-002, DR-003 — foundational methodology decisions
- [DR-020](../decisions/DR-020.md) — Risks & Mitigations required on every spec +
  DR (depth proportional to tier); implemented by SPEC-013
