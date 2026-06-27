import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG, loadConfig } from './config';
import { buildContext, renderTemplate, renderAll } from './template-engine';
import {
  TEMPLATE_NAMES,
  TEMPLATE_OUTPUT_PATHS,
  MANAGED_REGION_TEMPLATES,
  MINSPEC_HOOKS_DIR,
  managedRegionStartMarker,
  managedRegionEndMarker,
  renderManagedBlock,
  renderManagedFile,
  computeTemplateBaseline,
  type ManagedRegionTemplate,
} from './template-registry';
import { execFileSync } from 'child_process';
import {
  parseSections,
  buildSectionHashes,
  mergeFile,
  loadHashes,
  saveHashes,
  saveTemplateBaseline,
  splitManagedRegion,
  spliceManagedRegion,
  type GeneratedHashes,
} from './merge-refresh';
import { generateSlashCommandShims } from './slash-commands';
import { writeEpicIndex } from './epic-manager';
import { assembleContext } from './constitution-context';
import { seedProvider, integrateProposal, CONSTITUTION_SECTION_SCHEMA } from './constitution-proposer';

/** Output path of the constitution, relative to project root. */
const CONSTITUTION_REL_PATH = TEMPLATE_OUTPUT_PATHS['constitution.md'];

/**
 * SPEC-025 FR-4/FR-5: seed the constitution with deterministic DRAFT entries so
 * it is never empty (INV-4). Reads the current constitution, runs the offline
 * seed provider over the assembled context manifest, integrates additively
 * (never overwriting human content, idempotent), writes the result back, and
 * re-hashes the file so later refresh-merge treats the seeded DRAFT sections as
 * template-origin (preserving INV-2 on subsequent human edits).
 *
 * Mutates `allHashes` in place for the constitution's relative path and returns
 * it. Best-effort: callers wrap in try/catch so a proposer failure never breaks
 * init (mirrors writeEpicIndex).
 */
function seedConstitution(rootDir: string, allHashes: GeneratedHashes): GeneratedHashes {
  const fullPath = path.join(rootDir, CONSTITUTION_REL_PATH);
  if (!fs.existsSync(fullPath)) return allHashes;

  const existing = fs.readFileSync(fullPath, 'utf-8');
  const manifest = assembleContext(rootDir);
  const proposal = seedProvider.propose(manifest, CONSTITUTION_SECTION_SCHEMA);
  // seedProvider is synchronous (FR-5); integrate expects a resolved Proposal.
  if (proposal instanceof Promise) return allHashes;

  const { merged } = integrateProposal(existing, proposal);
  if (merged === existing) return allHashes;

  fs.writeFileSync(fullPath, merged);
  const sections = parseSections(merged);
  return { ...allHashes, [CONSTITUTION_REL_PATH]: buildSectionHashes(sections) };
}

export { DEFAULT_CONFIG };

export const MINSPEC_GITIGNORE_MARKER = '# MinSpec ephemeral data';
export const MINSPEC_GITIGNORE_ENTRIES = [
  '.minspec/session.json',
  '.minspec/calibration.json',
];

/**
 * Creates the .minspec/ directory structure in rootDir.
 * Idempotent — never overwrites existing config.json.
 */
export function scaffold(rootDir: string): void {
  const minspecDir = path.join(rootDir, '.minspec');
  fs.mkdirSync(minspecDir, { recursive: true });

  const configPath = path.join(minspecDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }

  // Pre-create the epic registry directory + empty marker-bounded INDEX so the
  // explorer epic-grouping has a home from day one (DR-013 / SPEC-007 FR-10).
  // Idempotent — writeEpicIndex only rewrites content inside its own markers.
  try {
    writeEpicIndex(rootDir);
  } catch {
    // best-effort — epics are optional; a failure here must not break init.
  }
}

/**
 * Ensure MinSpec ephemeral files (session.json, calibration.json) are
 * present in the project's .gitignore.
 *
 * Idempotent: skips any entry already listed (exact match, ignoring leading
 * whitespace). Creates .gitignore if missing. Preserves existing content.
 */
export function ensureGitignoreEntries(rootDir: string): void {
  const gitignorePath = path.join(rootDir, '.gitignore');
  const existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf-8')
    : '';

  const existingLines = new Set(
    existing.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
  );

  const missing = MINSPEC_GITIGNORE_ENTRIES.filter((entry) => !existingLines.has(entry));
  if (missing.length === 0) {
    return;
  }

  const hasMarker = existing.includes(MINSPEC_GITIGNORE_MARKER);
  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const block =
    (hasMarker ? '' : MINSPEC_GITIGNORE_MARKER + '\n') + missing.join('\n') + '\n';
  const separator = existing.length > 0 && !existing.endsWith('\n\n') ? '\n' : '';

  fs.writeFileSync(gitignorePath, existing + prefix + separator + block);
}

/**
 * Warning emitted when a managed-region refresh cannot safely update a file
 * because its MinSpec markers are missing or corrupted. Surfaced (not thrown) so a
 * single un-restorable file never aborts the whole refresh, and never triggers a
 * silent whole-file overwrite (never-wrong).
 */
export interface ManagedRegionWarning {
  /** The output path (relative to project root) that was left untouched. */
  readonly outputPath: string;
  /** Human-readable, actionable message. */
  readonly message: string;
}

/**
 * The skip+warn message for a file whose managed markers are gone. Single source
 * so the message is identical wherever it is produced (tests match on it).
 */
function missingMarkersMessage(outputPath: string): string {
  return (
    `MinSpec-managed markers missing in ${outputPath}; left untouched — ` +
    'restore the markers or delete the file to re-scaffold.'
  );
}

/**
 * Scaffold managed-region templates (#249, DR-037) at first init.
 *
 * Managed-region templates (YAML workflows, scripts) cannot go through the
 * Markdown section-merge engine, so MinSpec wraps its owned content in
 * comment-delimited markers (`renderManagedBlock`) and writes the block verbatim —
 * but only if the output path is absent (idempotent: an existing file, MinSpec- or
 * user-authored, is never overwritten here). The markers written now ARE the
 * boundary Refresh later uses to update only MinSpec's region. The user is expected
 * to add any custom content OUTSIDE the markers.
 */
function generateManagedRegionTemplates(rootDir: string): void {
  for (const tpl of MANAGED_REGION_TEMPLATES) {
    const fullPath = path.join(rootDir, tpl.outputPath);
    if (!fs.existsSync(fullPath)) {
      writeManagedFile(fullPath, tpl);
    }
  }
}

/**
 * Write the full on-disk file for a managed-region template (shebang preamble +
 * marked block) and, for executable templates (the git hooks), set the execute bit
 * so git will actually run the hook. Single place both scaffold and the deleted-file
 * re-scaffold path go through, so the bytes and the mode never diverge.
 */
function writeManagedFile(fullPath: string, tpl: ManagedRegionTemplate): void {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, renderManagedFile(tpl));
  if (tpl.executable) {
    try {
      fs.chmodSync(fullPath, 0o755);
    } catch {
      // chmod can fail on filesystems without POSIX modes (e.g. some Windows
      // mounts). Git on those platforms ignores the bit anyway — best-effort.
    }
  }
}

/**
 * Point the project's git `core.hooksPath` at `.minspec/hooks` so the scaffolded
 * editor-independent hooks (DR-037, #247) run on EVERY commit — terminal, another
 * editor, or an AI agent — not just the VS Code command path.
 *
 * Idempotent: reads the current value first and only writes when it differs (a no-op
 * when already configured). Best-effort and fail-quiet — a repo without git, or a git
 * error, must never break init/refresh; the GitHub Actions backstop (DR-037) still
 * gates such repos on push.
 */
function ensureHooksPath(rootDir: string): void {
  try {
    let current = '';
    try {
      current = execFileSync('git', ['config', '--local', 'core.hooksPath'], {
        cwd: rootDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Unset → git exits non-zero; treat as empty and set it below.
      current = '';
    }
    if (current !== MINSPEC_HOOKS_DIR) {
      execFileSync('git', ['config', '--local', 'core.hooksPath', MINSPEC_HOOKS_DIR], {
        cwd: rootDir,
        stdio: 'ignore',
      });
    }
  } catch {
    // No git repo / git not on PATH / config write failed — non-fatal.
  }
}

/**
 * Reconcile managed-region templates on Refresh (#249, DR-037).
 *
 * For each managed-region template, by parsing its markers — never a whole-file
 * compare:
 *   - file missing             → re-scaffold it with markers (a deleted managed file)
 *   - markers present          → OVERWRITE only the content between the markers with
 *                                the current template; PRESERVE everything outside
 *                                verbatim (user edits outside the region survive,
 *                                and MinSpec's region is always brought current)
 *   - file exists, NO markers  → SKIP + warn; never a silent whole-file overwrite
 *
 * No content baseline is consulted — the markers ARE the boundary between
 * MinSpec-owned and user-owned content, which is the key improvement over the old
 * preserve-on-any-edit whole-file rule: a stray edit outside the region no longer
 * freezes MinSpec out of its own region.
 *
 * Returns the warnings for any files left untouched (missing markers) so the
 * vscode-aware caller can surface them. The file is NEVER modified on a warning.
 */
function refreshManagedRegionTemplates(rootDir: string): ManagedRegionWarning[] {
  const warnings: ManagedRegionWarning[] = [];

  for (const tpl of MANAGED_REGION_TEMPLATES) {
    const fullPath = path.join(rootDir, tpl.outputPath);

    if (!fs.existsSync(fullPath)) {
      // Re-scaffold a deleted managed file, shebang + markers and all.
      writeManagedFile(fullPath, tpl);
      continue;
    }

    const onDisk = fs.readFileSync(fullPath, 'utf-8');
    const startMarker = managedRegionStartMarker(tpl.name, tpl.commentStyle);
    const endMarker = managedRegionEndMarker(tpl.name, tpl.commentStyle);
    const split = splitManagedRegion(onDisk, startMarker, endMarker);

    if (!split) {
      // Markers missing/corrupted — cannot identify MinSpec's region. NEVER
      // clobber the whole file; skip and warn so the user can restore the markers.
      warnings.push({ outputPath: tpl.outputPath, message: missingMarkersMessage(tpl.outputPath) });
      continue;
    }

    // Overwrite ONLY the managed region with the current template; preserve the
    // user's surrounding content verbatim.
    const updated = spliceManagedRegion(split, renderManagedBlock(tpl));
    if (updated !== onDisk) {
      fs.writeFileSync(fullPath, updated);
    }
  }

  return warnings;
}

/**
 * Generate all harness files from templates.
 * Only writes files that do not already exist (first-time init).
 * Stores initial section hashes for future merge-on-refresh.
 */
export function generateHarnessFiles(rootDir: string): void {
  // Ensure .minspec/ exists
  scaffold(rootDir);
  ensureGitignoreEntries(rootDir);

  const config = loadConfig(rootDir);
  const context = buildContext(rootDir, config);
  const rendered = renderAll(context);
  let allHashes: GeneratedHashes = loadHashes(rootDir);

  for (const name of TEMPLATE_NAMES) {
    const relativePath = TEMPLATE_OUTPUT_PATHS[name];
    const fullPath = path.join(rootDir, relativePath);
    const content = rendered.get(name)!;

    // Only write if file doesn't exist (first-time generation)
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);

      // Store initial section hashes
      const sections = parseSections(content);
      allHashes = { ...allHashes, [relativePath]: buildSectionHashes(sections) };
    }
  }

  // SPEC-025 FR-4/FR-5: seed the freshly written constitution so first-init is
  // never empty. Best-effort — a proposer failure must never break init.
  try {
    allHashes = seedConstitution(rootDir, allHashes);
  } catch {
    // best-effort — the constitution stays as the template scaffold on failure.
  }

  saveHashes(rootDir, allHashes);

  // Record the raw-template baseline so drift detection compares like-for-like
  // (raw template now vs raw template at generation), never raw vs the rendered/
  // user-merged content in generated-hashes.json — the cause of #117's perpetual
  // false-positive drift toast.
  saveTemplateBaseline(rootDir, computeTemplateBaseline());

  // Scaffold managed-region templates (#249) — non-Markdown harness artifacts (the
  // CI workflow) the section-merge engine cannot carry — wrapping MinSpec's content
  // in comment-delimited markers. No content baseline is recorded: the markers
  // themselves are the boundary Refresh uses to update only MinSpec's region.
  generateManagedRegionTemplates(rootDir);

  // Point git at the scaffolded editor-independent hooks so terminal / other-editor
  // / AI-agent commits run the SDD gates too (DR-037, #247). Idempotent + fail-quiet.
  ensureHooksPath(rootDir);

  // Generate Spec Kit slash-command shims for any detected AI tool.
  // Tools are re-detected after template generation so freshly written
  // CLAUDE.md / AGENTS.md / .cursorrules trigger shim creation.
  generateSlashCommandShims(rootDir);
}

/**
 * Refresh harness files — merge template updates with user edits.
 * Uses section-level hashing to preserve user modifications.
 *
 * For each generated file:
 *   - User-modified sections → preserved
 *   - Unmodified sections → updated from latest template
 *   - New template sections → appended
 *   - User-added sections (not in template) → preserved
 *
 * Returns any managed-region warnings (files left untouched because their MinSpec
 * markers were deleted) so the vscode-aware caller can surface them; an empty array
 * means a fully clean refresh.
 */
export function refreshHarnessFiles(rootDir: string): ManagedRegionWarning[] {
  // Ensure .minspec/ exists
  scaffold(rootDir);

  const config = loadConfig(rootDir);
  const context = buildContext(rootDir, config);
  let allHashes: GeneratedHashes = loadHashes(rootDir);

  for (const name of TEMPLATE_NAMES) {
    const relativePath = TEMPLATE_OUTPUT_PATHS[name];
    const fullPath = path.join(rootDir, relativePath);
    const generated = renderTemplate(name, context);

    if (!fs.existsSync(fullPath)) {
      // File doesn't exist yet — write fresh
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, generated);
      const sections = parseSections(generated);
      allHashes = { ...allHashes, [relativePath]: buildSectionHashes(sections) };
    } else {
      // File exists — merge
      const existing = fs.readFileSync(fullPath, 'utf-8');
      const oldHashes = allHashes[relativePath] ?? {};
      const { merged, newHashes } = mergeFile(existing, generated, oldHashes);
      fs.writeFileSync(fullPath, merged);
      allHashes = { ...allHashes, [relativePath]: newHashes };
    }
  }

  // SPEC-025 FR-4/FR-5: re-seed after merge so a still-empty section gains DRAFT
  // entries on refresh too; additive + idempotent, never overwrites human edits.
  try {
    allHashes = seedConstitution(rootDir, allHashes);
  } catch {
    // best-effort — never break a refresh on a proposer failure.
  }

  saveHashes(rootDir, allHashes);

  // Re-record the raw-template baseline: after a refresh the user's files are in
  // sync with the current bundled template, so drift must read false until the
  // template next moves upstream (#117).
  saveTemplateBaseline(rootDir, computeTemplateBaseline());

  // Reconcile managed-region templates (#249): re-scaffold if deleted, overwrite
  // only the marker-bounded MinSpec region (preserving the user's surrounding
  // content), or skip+warn if the markers were deleted. Collect warnings to return.
  const managedRegionWarnings = refreshManagedRegionTemplates(rootDir);

  // Re-assert git's hooksPath on refresh too (a repo cloned without it, or whose
  // config was reset, regains the gate). Idempotent + fail-quiet (DR-037, #247).
  ensureHooksPath(rootDir);

  // Refresh Spec Kit slash-command shims. Per-command Claude/Cursor files
  // are only created if missing (user edits preserved); the AGENTS.md
  // marker section is regenerated in place.
  generateSlashCommandShims(rootDir);

  return managedRegionWarnings;
}
