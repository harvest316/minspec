/**
 * Template registry — Handlebars template strings bundled as constants.
 * This avoids esbuild file-loader complexity for .hbs files.
 */

import {
  parseSections,
  buildSectionHashes,
  type GeneratedHashes,
  type SectionHashes,
} from './merge-refresh';

/**
 * Template names that can be rendered.
 *
 * NOTE — `DESIGN.md` is intentionally absent (#206). It is NOT a harness
 * template: a split-layout `design.md` is a T3+ **Plan-phase** artifact, created
 * when planning starts, not at init. Scaffolding an empty `DESIGN.md` stub at
 * init produced a doc the project's own gap-audit (#205) would flag, and — being
 * a managed template — refresh resurrected it after deletion. Never re-add it
 * here; both `generateHarnessFiles` and `refreshHarnessFiles` loop over
 * `TEMPLATE_NAMES`, so membership is exactly "scaffolded + refresh-managed".
 */
export type TemplateName = 'CLAUDE.md' | 'AGENTS.md' | '.cursorrules' | 'constitution.md';

/** All template names in generation order */
export const TEMPLATE_NAMES: readonly TemplateName[] = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  'constitution.md',
] as const;

/** Output file paths relative to project root (constitution goes inside .minspec/) */
export const TEMPLATE_OUTPUT_PATHS: Record<TemplateName, string> = {
  'CLAUDE.md': 'CLAUDE.md',
  'AGENTS.md': 'AGENTS.md',
  '.cursorrules': '.cursorrules',
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

## Goals

What this project is trying to achieve. The outcomes work should ladder up to.

<!-- Add goals here. Example: -->
<!-- 1. Ship a frictionless SDD experience for solo developers -->
<!-- 2. Keep ceremony proportional to scope -->
`;

/** Registry of all templates keyed by name */
export const TEMPLATES: Record<TemplateName, string> = {
  'CLAUDE.md': CLAUDE_MD_TEMPLATE,
  'AGENTS.md': AGENTS_MD_TEMPLATE,
  '.cursorrules': CURSORRULES_TEMPLATE,
  'constitution.md': CONSTITUTION_MD_TEMPLATE,
};

/**
 * Compute the raw-template baseline: the SHA-256 of each *unrendered* template
 * section (`{{placeholders}}` intact), keyed by output path → heading.
 *
 * This is the canonical "which template version are we at" signal. Because it
 * hashes the raw template — never the rendered output — it is independent of any
 * project context: re-rendering with a different project name, specs dir, or
 * invariant list never perturbs it. `hasHarnessDrift` compares this (the current
 * bundled template) against the stored baseline (the template at last generate)
 * to decide whether the bundled template has genuinely moved upstream (#117).
 */
export function computeTemplateBaseline(): GeneratedHashes {
  const baseline: Record<string, SectionHashes> = {};
  for (const name of TEMPLATE_NAMES) {
    baseline[TEMPLATE_OUTPUT_PATHS[name]] = buildSectionHashes(
      parseSections(TEMPLATES[name]),
    );
  }
  return baseline;
}

// ---------------------------------------------------------------------------
// Managed-region templates (#249, DR-037)
//
// A second class of scaffolded file that the Markdown section-merge engine
// (`mergeFile` / `parseSections` in merge-refresh.ts) cannot manage: its merge
// unit is the `## ` heading, so it can only carry Markdown. Non-Markdown harness
// artifacts — YAML workflows, shell scripts, JS/TS configs — have no `## `
// sections to merge and would be corrupted by section reassembly.
//
// Instead of treating these as opaque whole files, MinSpec wraps its owned
// content in comment-delimited MARKERS whose comment syntax matches the target
// file type — the same `minspec:` marker convention already used for the DR-index
// (`<!-- minspec:dr-index:start -->`), generalized to any file type:
//
//   # >>> minspec:managed:<name> >>>     (YAML / shell — `#` comments)
//   # <<< minspec:managed:<name> <<<
//   <!-- >>> minspec:managed:<name> >>> -->   (Markdown / HTML / XML)
//   <!-- <<< minspec:managed:<name> <<< -->
//   // >>> minspec:managed:<name> >>>    (JS / TS / C-family)
//   // <<< minspec:managed:<name> <<<
//
// Contract:
//   - Scaffold (init): write the file with the MinSpec-owned content wrapped in
//     the managed block. A fully-MinSpec-owned file (the CI workflow) = one
//     managed block spanning the file; the user adds custom content OUTSIDE the
//     markers.
//   - Refresh: parse the markers; OVERWRITE only the content BETWEEN them with the
//     current template; PRESERVE everything outside verbatim. User edits outside
//     the region survive; MinSpec's region stays current — the key improvement over
//     the old preserve-on-any-edit whole-file rule, which let one stray edit freeze
//     MinSpec out of its own region forever.
//   - Missing/corrupted markers (user deleted them): NEVER a silent clobber. If
//     the file exists but has no recognizable markers → SKIP + warn; if the file
//     is absent → re-scaffold it with markers.
//
// No content baseline file is needed — the markers ARE the boundary between
// MinSpec-owned and user-owned content. This mechanism is the reusable foundation
// for the hook-script scaffolds (#246/#247) and the python validator (#244).
// ---------------------------------------------------------------------------

/**
 * Comment syntax used to delimit a managed region, chosen to match the target
 * file type so the markers are valid comments in that language.
 *  - `hash`  → `#` line comments (YAML, shell, Python, TOML, .gitignore)
 *  - `html`  → `<!-- -->` block comments (Markdown, HTML, XML)
 *  - `slash` → `//` line comments (JS, TS, JSON-with-comments, C-family)
 */
export type CommentStyle = 'hash' | 'html' | 'slash';

/** Shared marker token — reuses the `minspec:` convention (cf. dr-index markers). */
const MANAGED_MARKER_PREFIX = 'minspec:managed:';

/**
 * Build the start marker line for a managed region of the given name + comment
 * style. Exported so the parser and tests derive markers from one source of truth
 * (never hand-typed, so the scaffold and refresh halves can never drift).
 */
export function managedRegionStartMarker(name: string, style: CommentStyle): string {
  const token = `>>> ${MANAGED_MARKER_PREFIX}${name} >>>`;
  switch (style) {
    case 'hash':
      return `# ${token}`;
    case 'slash':
      return `// ${token}`;
    case 'html':
      return `<!-- ${token} -->`;
  }
}

/** Build the end marker line for a managed region. See {@link managedRegionStartMarker}. */
export function managedRegionEndMarker(name: string, style: CommentStyle): string {
  const token = `<<< ${MANAGED_MARKER_PREFIX}${name} <<<`;
  switch (style) {
    case 'hash':
      return `# ${token}`;
    case 'slash':
      return `// ${token}`;
    case 'html':
      return `<!-- ${token} -->`;
  }
}

/** A scaffolded file with a comment-delimited MinSpec-managed region. */
export interface ManagedRegionTemplate {
  /** Stable identifier (used in markers, messages, tests). */
  readonly name: string;
  /** Output path relative to project root. */
  readonly outputPath: string;
  /** Comment syntax for the markers (must be valid in the target file type). */
  readonly commentStyle: CommentStyle;
  /**
   * The MinSpec-owned region body (between the markers). Managed-region templates
   * are NOT Handlebars-rendered — the content is project-independent and pinned so
   * the region stays byte-stable across projects.
   */
  readonly content: string;
  /**
   * When true, the scaffolded file is made executable (mode 0o755). Required for
   * the git hook scripts (`pre-commit`, `commit-msg`, `validate.py`) — git only
   * runs a hook file that carries the execute bit. Omitted/false for data files
   * (the CI workflow YAML).
   */
  readonly executable?: boolean;
  /**
   * A fixed line written ONCE, BEFORE the managed region's start marker — used for a
   * script shebang (`#!/usr/bin/env sh`), which a hook MUST carry on line 1 for git
   * to run it. The shebang lives OUTSIDE the marked region on purpose: a marker line
   * cannot be line 1 (it would shadow the shebang), and keeping it outside means a
   * refresh preserves it as surrounding content via `spliceManagedRegion`. It is
   * (re)written only when the whole file is scaffolded or re-scaffolded
   * (`renderManagedFile`), never duplicated on an in-place region refresh.
   */
  readonly preamble?: string;
}

/**
 * Wrap a managed-region template's content in its start/end markers, producing the
 * full block written to disk at scaffold time and used to overwrite the region on
 * refresh. The block is a self-contained unit: start marker, content, end marker,
 * each on its own line, newline-terminated. This is the SINGLE place the on-disk
 * managed-block shape is defined — scaffold and refresh both call it, so they can
 * never disagree about the bytes.
 */
export function renderManagedBlock(tpl: ManagedRegionTemplate): string {
  const start = managedRegionStartMarker(tpl.name, tpl.commentStyle);
  const end = managedRegionEndMarker(tpl.name, tpl.commentStyle);
  // Normalize: exactly one trailing newline on the content body so the end marker
  // always sits on its own line regardless of how the template literal was written.
  const body = tpl.content.replace(/\n+$/, '') + '\n';
  return `${start}\n${body}${end}\n`;
}

/**
 * Render the FULL on-disk file for a managed-region template at scaffold (or
 * re-scaffold) time: the optional `preamble` line (a script shebang) first, then a
 * blank line, then the managed block ({@link renderManagedBlock}).
 *
 * This is what the scaffold and the deleted-file re-scaffold paths write. An
 * IN-PLACE refresh does NOT use this — it splices `renderManagedBlock` into the
 * preserved surroundings (which already include the shebang), so the shebang is never
 * duplicated. With no preamble this is byte-identical to `renderManagedBlock` (the CI
 * workflow), keeping the existing behaviour unchanged.
 */
export function renderManagedFile(tpl: ManagedRegionTemplate): string {
  const block = renderManagedBlock(tpl);
  if (!tpl.preamble) return block;
  return `${tpl.preamble}\n\n${block}`;
}

/**
 * GitHub Actions workflow: the authoritative post-push MinSpec validation gate
 * (DR-037, #249). Runs the Node-tier validator on every push / PR so that
 * contributors without the local git hooks — or any local bypass — are still
 * caught before merge. Local hook = fast fail; CI = never-merge guarantee.
 *
 * Pinned to a literal YAML string (no Handlebars): it is project-independent and
 * must remain byte-stable so the refreshed region matches exactly.
 */
const MINSPEC_VALIDATE_WORKFLOW = `name: MinSpec Validate

on:
  push:
  pull_request:

jobs:
  validate:
    name: MinSpec SDD validation
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Run MinSpec validation
        run: npx --yes @aiclarity/minspec-validator`;

/**
 * Relative path under the project root where the editor-independent git hooks are
 * scaffolded (DR-037). `core.hooksPath` is pointed here so terminal / other-editor
 * / AI-agent commits run the same SDD gates as the VS Code command path — not just
 * the Command-Palette flow. Exported so `scaffold.ts` and the tests share one value.
 */
export const MINSPEC_HOOKS_DIR = '.minspec/hooks';

// ---------------------------------------------------------------------------
// DR-037 editor-independent gate harness (#244 / #246 / #247)
//
// Three cooperating scaffolded files, all managed-region templates so Refresh keeps
// them current while preserving any user edits OUTSIDE the markers:
//
//   .minspec/hooks/pre-commit  — shell. Two gates: (1) gitleaks secret scan (#244,
//       graceful-degrade to a warning when gitleaks is not installed), then (2) the
//       DR-037 detection chain (Node → python3 validate.py → shell grep) running the
//       spec-id frontmatter + ref-egress checks over the STAGED tree.
//   .minspec/hooks/commit-msg  — shell. The RCDD root-cause gate (DR-003): a
//       Conventional-Commit `fix:` subject must carry a `Root cause:` body line.
//       Pattern-matchable, so the shell tier owns it directly (never-wrong).
//   .minspec/hooks/validate.py — python3. The mid-tier of the detection chain
//       (#246): a language-agnostic frontmatter/spec-id validator mirroring the Node
//       validator's core FATAL checks (spec `id: SPEC-NNN`, `docs/domain` `type:`),
//       used when Node is not guaranteed in the commit environment.
//
// All three carry `#`-comment markers (shell + python both use `#`). They are pinned
// literal strings — project-independent, byte-stable so a refreshed region matches
// exactly — and marked `executable` so git will run them.
// ---------------------------------------------------------------------------

/**
 * Shell `pre-commit` hook (DR-037 / #247, #244). Two stages over the staged tree:
 *
 *  1. Secret scan (#244): if `gitleaks` is on PATH, run it on the staged changes and
 *     BLOCK on a finding. If gitleaks is absent, emit a one-line advisory and
 *     CONTINUE — graceful degradation, never a hard fail for a missing optional tool.
 *  2. SDD validation (DR-037 detection chain): run the highest-fidelity validator
 *     that is ACTUALLY available — every tier is opportunistic and falls through if
 *     it cannot run, so an unreachable tier never bricks a commit (never-wrong):
 *       - Node — `npx --no-install @aiclarity/minspec-validator` ONLY if already
 *         resolvable (the `--no-install` probe never network-fetches, so the
 *         not-yet-published package can never E404-block a commit, #246 follow-up);
 *       - python — `python3 validate.py` ONLY if python3 + the script are present;
 *       - shell — the always-present `minspec_shell_gate`: the two pattern-matchable
 *         gates (spec `id:` frontmatter present; no MinSpec-internal ref leaking out
 *         per DR-032).
 *
 * Bypass (rare, explicit): MINSPEC_GATE_OFF=1 git commit ...
 * Fail-open on hook-internal errors so a tooling bug never blocks a commit wrongly.
 */
const PRE_COMMIT_HOOK = `# MinSpec pre-commit gate (DR-037) — editor-independent SDD + secret gates.
# Runs on EVERY commit (terminal, other editor, AI agent), not just the VS Code path.
# Bypass: MINSPEC_GATE_OFF=1 git commit ...
set -u

[ "\${MINSPEC_GATE_OFF:-0}" = "1" ] && exit 0

hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# ── Stage 1: secret scan (#244, gitleaks) ────────────────────────────────────
# gitleaks is the recommended static, offline, read-only scanner. It is OPTIONAL:
# if it is not installed we warn and continue (graceful degradation) rather than
# block — a missing optional tool must never wedge a commit.
if command -v gitleaks >/dev/null 2>&1; then
  if ! gitleaks protect --staged --redact --no-banner >/dev/null 2>&1; then
    echo "✗ MinSpec gate: gitleaks found a potential secret in the staged changes." >&2
    echo "  Review the finding above; remove the secret or add a gitleaks allowlist entry." >&2
    echo "  Bypass (rare): MINSPEC_GATE_OFF=1 git commit ..." >&2
    exit 1
  fi
else
  echo "⚠ MinSpec gate: gitleaks not installed — secret scan SKIPPED." >&2
  echo "  Install gitleaks (https://github.com/gitleaks/gitleaks) to gate committed secrets." >&2
fi

# ── Stage 2: SDD validation (DR-037 detection chain) ─────────────────────────
# Highest-fidelity validator AVAILABLE wins, but every tier is OPPORTUNISTIC: a
# tier is used only when it can actually run, otherwise the chain falls through to
# the next. This is the never-wrong rule — a tier that cannot be reached (the npm
# validator not yet published/installed, python3 absent) must NEVER brick a commit;
# it degrades to the always-present shell gate below. Tiers:
#   Node   — only if @aiclarity/minspec-validator is ALREADY resolvable
#            (\`npx --no-install\`, never a network fetch that could E404-block).
#   python — only if python3 is on PATH and validate.py exists.
#   shell  — always present; the two pattern-matchable gates, inline below.

# minspec_shell_gate: the always-correct baseline. (1) every staged specs/**/ md
# file must carry an \`id: SPEC-NNN\` frontmatter line; (2) flag any staged non-hook
# file leaking a MinSpec-internal marker (DR-032 egress). Returns non-zero on a
# fatal (1) violation; the (2) leak is a warning only.
minspec_shell_gate() {
  gate_fail=0
  staged=$(git diff --cached --name-only --diff-filter=ACM)
  for f in $staged; do
    case "$f" in
      specs/*.md)
        # Frontmatter is the block between the first two \`---\` fences.
        if ! git show ":$f" 2>/dev/null | awk '
          /^---[[:space:]]*$/ { fence++; next }
          fence==1 && /^id:[[:space:]]*SPEC-[0-9]+/ { found=1 }
          END { exit(found?0:1) }'; then
          echo "✗ MinSpec gate: $f missing \\\`id: SPEC-NNN\\\` frontmatter." >&2
          gate_fail=1
        fi
        ;;
    esac
  done
  for f in $staged; do
    case "$f" in
      .minspec/hooks/*) continue ;;
    esac
    if git show ":$f" 2>/dev/null | grep -q 'minspec:managed:'; then
      echo "⚠ MinSpec gate: $f contains a \\\`minspec:managed:\\\` marker outside the hooks dir (possible internal-ref leak, DR-032)." >&2
    fi
  done
  if [ "$gate_fail" -ne 0 ]; then
    echo "" >&2
    echo "  Fix the errors above before committing." >&2
    echo "  Bypass (rare): MINSPEC_GATE_OFF=1 git commit ..." >&2
    return 1
  fi
  return 0
}

# Node tier — ONLY when the validator is already resolvable (no network fetch).
if command -v npx >/dev/null 2>&1 \\
   && npx --no-install @aiclarity/minspec-validator --version >/dev/null 2>&1; then
  npx --no-install @aiclarity/minspec-validator --pre-commit
  exit $?
fi

# Python tier — ONLY when python3 + validate.py are present.
if command -v python3 >/dev/null 2>&1 && [ -f "$hook_dir/validate.py" ]; then
  python3 "$hook_dir/validate.py" --pre-commit
  exit $?
fi

# Shell tier — always present.
minspec_shell_gate
exit $?`;

/**
 * Shell `commit-msg` hook (DR-037 / #247) — the RCDD root-cause gate (DR-003).
 *
 * A Conventional-Commit \`fix:\` subject MUST carry a \`Root cause:\` body line
 * (RCDD Phase 2 precedes Phase 3). Pattern-matchable, so the shell tier owns it
 * directly — actor-agnostic (reads the COMPOSED message from $1, catching -m,
 * heredoc, editor, or agent commits alike). Mirrors the monorepo's own gate.
 *
 * Bypass: MINSPEC_GATE_OFF=1 git commit ...   Fail-open on a missing message file.
 */
const COMMIT_MSG_HOOK = `# MinSpec commit-msg gate (DR-037 / DR-003) — RCDD root-cause requirement.
# A \\\`fix:\\\` commit must document its diagnosis. Bypass: MINSPEC_GATE_OFF=1 git commit ...
set -u

[ "\${MINSPEC_GATE_OFF:-0}" = "1" ] && exit 0

msg_file="\${1:-}"
[ -n "$msg_file" ] && [ -r "$msg_file" ] || exit 0   # fail open

# Subject = first non-comment, non-empty line.
subject=$(grep -v '^#' "$msg_file" | grep -m1 . 2>/dev/null || true)

# Only Conventional-Commit fix subjects are gated: fix:  fix(scope):  fix!:
echo "$subject" | grep -Eq '^fix(\\([^)]*\\))?!?:' || exit 0

# Require a \`Root cause:\` marker (case-insensitive, space or hyphen) in the body.
if grep -v '^#' "$msg_file" | grep -Eiq 'root[ -]cause:'; then
  exit 0
fi

echo "✗ MinSpec RCDD gate (DR-003): fix commit missing root cause." >&2
echo "" >&2
echo "  A \\\`fix\\\` commit must document the diagnosis. Add a body line:" >&2
echo "" >&2
echo "      Root cause: <one sentence>" >&2
echo "" >&2
echo "  RCDD Phase 2 (diagnose) precedes Phase 3 (fix)." >&2
echo "  Bypass (rare): MINSPEC_GATE_OFF=1 git commit ..." >&2
exit 1`;

/**
 * Python `validate.py` mid-tier validator (DR-037 / #246).
 *
 * The detection chain's middle tier, run when Node is not guaranteed in the commit
 * environment. It is a language-agnostic re-implementation of the Node validator's
 * core FATAL checks (CDD language-agnostic, #245):
 *
 *   - every spec markdown under \`specs/\` must carry \`id: SPEC-NNN\` frontmatter
 *   - every markdown under \`docs/domain/\` must carry \`type: domain\` frontmatter
 *
 * Frontmatter is parsed with the SAME lightweight \`key: value\` split the Node
 * \`validate-frontmatter.ts\` uses (first \`---\` … \`---\` block, split on the first
 * colon, trim) — no PyYAML dependency, so it runs on a stock python3. Scopes to the
 * STAGED tree (\`git diff --cached\`) when invoked as a pre-commit hook, else scans
 * the whole repo. Tier-0: deterministic, offline, no network, no third-party deps.
 *
 * Exit non-zero on any FATAL violation; 0 when clean. Mirrors the Node validator's
 * exit semantics so the chain behaves identically whichever tier runs.
 */
const VALIDATE_PY = `"""MinSpec mid-tier validator (DR-037 / #246).

Language-agnostic twin of the Node validate-frontmatter core FATAL checks:
  - specs/**/*.md must have \`id: SPEC-NNN\` frontmatter
  - docs/domain/*.md must have \`type: domain\` frontmatter

Frontmatter parsing mirrors the Node validator exactly (first --- ... --- block,
split each line on the first colon, trim) — no PyYAML, so it runs on a stock
python3. Deterministic + offline (Tier-0, DR-004)."""

import os
import re
import subprocess
import sys

FM_RE = re.compile(r"^---\\n(.*?)\\n---", re.DOTALL)
SPEC_ID_RE = re.compile(r"^SPEC-\\d+$")


def repo_root():
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except Exception:
        return os.getcwd()


def parse_frontmatter(content):
    """Mirror the Node parseFrontmatter: first --- ... --- block, key:value split."""
    m = FM_RE.match(content)
    if not m:
        return {}
    fm = {}
    for line in m.group(1).split("\\n"):
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        key = key.strip()
        if key:
            fm[key] = rest.strip()
    return fm


def staged_files(root):
    """Staged added/copied/modified files (pre-commit scope). [] on any git error."""
    try:
        out = subprocess.run(
            ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
            cwd=root, capture_output=True, text=True, check=True,
        )
        return [f for f in out.stdout.splitlines() if f.strip()]
    except Exception:
        return []


def staged_content(root, rel):
    """Content of the staged blob (what is ACTUALLY being committed)."""
    try:
        out = subprocess.run(
            ["git", "show", ":" + rel],
            cwd=root, capture_output=True, text=True, check=True,
        )
        return out.stdout
    except Exception:
        return None


def all_md(root, rel_dir):
    base = os.path.join(root, rel_dir)
    found = []
    for dirpath, _dirs, files in os.walk(base):
        for name in files:
            if name.endswith(".md"):
                found.append(os.path.relpath(os.path.join(dirpath, name), root))
    return found


def main():
    pre_commit = "--pre-commit" in sys.argv[1:]
    root = repo_root()

    if pre_commit:
        targets = staged_files(root)
        reader = lambda rel: staged_content(root, rel)
    else:
        targets = all_md(root, "specs") + all_md(root, os.path.join("docs", "domain"))
        def reader(rel):
            try:
                with open(os.path.join(root, rel), "r", encoding="utf-8") as fh:
                    return fh.read()
            except Exception:
                return None

    errors = 0

    for rel in targets:
        norm = rel.replace(os.sep, "/")
        is_spec = norm.startswith("specs/") and norm.endswith(".md")
        is_domain = norm.startswith("docs/domain/") and norm.endswith(".md")
        if not (is_spec or is_domain):
            continue

        content = reader(rel)
        if content is None:
            continue
        fm = parse_frontmatter(content)

        if is_spec:
            spec_id = fm.get("id", "")
            # Strip an inline comment (\`id: SPEC-001  # note\`) before matching.
            spec_id = spec_id.split("#", 1)[0].strip()
            if not SPEC_ID_RE.match(spec_id):
                sys.stderr.write(
                    "FAIL " + norm + ": missing or invalid \`id: SPEC-NNN\` frontmatter\\n"
                )
                errors += 1

        if is_domain:
            if fm.get("type", "").split("#", 1)[0].strip() != "domain":
                sys.stderr.write(
                    "FAIL " + norm + ": missing \`type: domain\` frontmatter\\n"
                )
                errors += 1

    if errors:
        sys.stderr.write(
            "\\n" + str(errors) + " validation error(s). Fix before committing.\\n"
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())`;

/** All managed-region templates in scaffold order. */
export const MANAGED_REGION_TEMPLATES: readonly ManagedRegionTemplate[] = [
  {
    name: 'validate-workflow',
    outputPath: '.github/workflows/minspec-validate.yml',
    commentStyle: 'hash',
    content: MINSPEC_VALIDATE_WORKFLOW,
  },
  {
    name: 'pre-commit-hook',
    outputPath: `${MINSPEC_HOOKS_DIR}/pre-commit`,
    commentStyle: 'hash',
    content: PRE_COMMIT_HOOK,
    executable: true,
    preamble: '#!/usr/bin/env sh',
  },
  {
    name: 'commit-msg-hook',
    outputPath: `${MINSPEC_HOOKS_DIR}/commit-msg`,
    commentStyle: 'hash',
    content: COMMIT_MSG_HOOK,
    executable: true,
    preamble: '#!/usr/bin/env sh',
  },
  {
    name: 'validate-py',
    outputPath: `${MINSPEC_HOOKS_DIR}/validate.py`,
    commentStyle: 'hash',
    content: VALIDATE_PY,
    executable: true,
    preamble: '#!/usr/bin/env python3',
  },
] as const;
