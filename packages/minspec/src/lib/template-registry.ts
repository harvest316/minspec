/**
 * Template registry — Handlebars template strings bundled as constants.
 * This avoids esbuild file-loader complexity for .hbs files.
 */

/** Template names that can be rendered */
export type TemplateName = 'CLAUDE.md' | 'AGENTS.md' | '.cursorrules' | 'DESIGN.md' | 'constitution.md';

/** All template names in generation order */
export const TEMPLATE_NAMES: readonly TemplateName[] = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  'DESIGN.md',
  'constitution.md',
] as const;

/** Output file paths relative to project root (constitution goes inside .minspec/) */
export const TEMPLATE_OUTPUT_PATHS: Record<TemplateName, string> = {
  'CLAUDE.md': 'CLAUDE.md',
  'AGENTS.md': 'AGENTS.md',
  '.cursorrules': '.cursorrules',
  'DESIGN.md': 'DESIGN.md',
  'constitution.md': '.minspec/constitution.md',
};

const CLAUDE_MD_TEMPLATE = `# {{projectName}} — Project Instructions

## Overview

{{projectName}} project managed with MinSpec SDD methodology.

- **Specs directory:** \`{{specsDir}}/\`
- **Decisions directory:** \`{{decisionsDir}}/\`

## Invariants

These rules must never be violated. All changes must preserve them.

{{#if invariants}}
{{#each invariants}}
{{incremented @index}}. {{this}}
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

{{#each invariants}}
- {{this}}
{{/each}}
{{/if}}

## Task Classification Guide

Before starting work, classify the task by its **mechanical scope** (blast radius), not by how hard it is to think through:

- **T1 (Contained):** Single file, one-line fix, typo, config change. One sentence of spec is enough.
- **T2 (Standard):** A few files, contained feature, no cross-boundary changes. Needs spec + plan.
- **T3 (Wide):** Many files, new APIs, schema/dependency changes. Full spec cycle.
- **T4 (Architectural):** Cross-project impact, new services, breaking changes. Complete ceremony required.

The classifier sees scope, not difficulty. A subtle one-line fix and a trivial one are the same size — so the predicted tier is a **floor**: raise it when a change is harder than its footprint, never lower it below the prediction.

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
{{#each invariants}}
- {{this}}
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

## Coding Standards

- Follow existing patterns in the codebase
- Keep changes focused and atomic
- Document decisions that are hard to reverse
`;

const DESIGN_MD_TEMPLATE = `# {{projectName}} — Design Document

## Architecture Overview

<!-- Describe the high-level architecture here -->

## Key Components

<!-- List and describe the main modules/components -->

## Data Flow

<!-- Describe how data flows through the system -->

## Technology Stack

<!-- List key technologies and why they were chosen -->

## Constraints

{{#if constraints}}
{{#each constraints}}
- {{this}}
{{/each}}
{{else}}
<!-- Add technical/business constraints here -->
{{/if}}

## Open Questions

<!-- Track unresolved design questions here -->
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
`;

/** Registry of all templates keyed by name */
export const TEMPLATES: Record<TemplateName, string> = {
  'CLAUDE.md': CLAUDE_MD_TEMPLATE,
  'AGENTS.md': AGENTS_MD_TEMPLATE,
  '.cursorrules': CURSORRULES_TEMPLATE,
  'DESIGN.md': DESIGN_MD_TEMPLATE,
  'constitution.md': CONSTITUTION_MD_TEMPLATE,
};
