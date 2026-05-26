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
| Specs | \`{{specsDir}}/\` |
| Decisions | \`{{decisionsDir}}/\` |
| Constitution | \`.minspec/constitution.md\` |
| Config | \`.minspec/config.json\` |

## Commands

\`\`\`bash
# Initialize SDD structure
minspec init

# Refresh harness files (preserves user edits)
minspec init --refresh

# Classify task complexity
minspec classify
\`\`\`
`;

const AGENTS_MD_TEMPLATE = `# {{projectName}} — Agent Instructions

## For AI Coding Assistants

This project uses MinSpec SDD (Specification-Driven Development). Before implementing any change:

1. **Check complexity** — Is this T1 (trivial) or does it need more ceremony?
2. **Read the spec** — Check \`{{specsDir}}/\` for existing specs related to your task.
3. **Follow the tier** — Don't over-specify T1 tasks. Don't under-specify T3/T4 tasks.

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

Before starting work, classify the task:

- **T1 (Trivial):** One-line fix, typo, config change. One sentence of spec is enough.
- **T2 (Small):** Simple feature, clear scope. Needs spec + plan.
- **T3 (Medium):** Multi-file change, some ambiguity. Full spec cycle.
- **T4 (Complex):** Architectural change, cross-cutting concerns. Complete ceremony required.

## Rules

1. Never skip the spec phase, even for T1.
2. User override always wins — if the human says "just do it," do it.
3. Ceremony must be proportional to complexity — don't over-engineer T1 tasks.
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
- Ceremony proportional to complexity
- User override always wins
- Specs are living documents
{{/if}}

## Before Making Changes

1. Check if a spec exists for the area you're modifying
2. Classify the change complexity (T1-T4)
3. Follow the appropriate ceremony level
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
<!-- 1. Ceremony proportional to complexity -->
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
