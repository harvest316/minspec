import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG, loadConfig } from './config';
import { buildContext, renderTemplate, renderAll } from './template-engine';
import {
  TEMPLATE_NAMES,
  TEMPLATE_OUTPUT_PATHS,
  WHOLE_FILE_TEMPLATES,
  WHOLE_FILE_BASELINE_HEADING,
  computeTemplateBaseline,
  computeWholeFileBaseline,
} from './template-registry';
import {
  parseSections,
  buildSectionHashes,
  hashSection,
  mergeFile,
  loadHashes,
  saveHashes,
  saveTemplateBaseline,
  loadWholeFileBaseline,
  saveWholeFileBaseline,
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
 * Scaffold whole-file templates (#249, DR-037) at first init.
 *
 * Whole-file templates (YAML workflows, scripts) cannot go through the Markdown
 * section-merge engine, so they are written verbatim and only if absent — exactly
 * like the Markdown first-time path. The content baseline recorded by the caller
 * (`computeWholeFileBaseline`) is what later lets Refresh tell a user-edited file
 * from an untouched one. Idempotent: an existing file is never overwritten here.
 */
function generateWholeFileTemplates(rootDir: string): void {
  for (const tpl of WHOLE_FILE_TEMPLATES) {
    const fullPath = path.join(rootDir, tpl.outputPath);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, tpl.content);
    }
  }
}

/**
 * Reconcile whole-file templates on Refresh (#249, DR-037).
 *
 * For each whole-file template, with no Markdown section merge:
 *   - file missing      → write it (re-scaffold a deleted managed file)
 *   - file == baseline  → CLEAN (user never touched it) → overwrite with the
 *                         current bundled content, carrying upstream updates forward
 *   - file != baseline  → DRIFT (user edited it) → SKIP, preserving their copy
 *
 * The baseline is the content hash recorded at the last generate/refresh
 * (`.minspec/whole-file-baseline.json`). When no baseline exists yet for a path
 * (project predating this mechanism) we treat any existing file as user content
 * and preserve it — never clobbering an unverified file (mirrors the
 * conservative #117 no-baseline stance).
 */
function refreshWholeFileTemplates(rootDir: string): void {
  const baseline = loadWholeFileBaseline(rootDir);
  for (const tpl of WHOLE_FILE_TEMPLATES) {
    const fullPath = path.join(rootDir, tpl.outputPath);

    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, tpl.content);
      continue;
    }

    const recorded = baseline[tpl.outputPath]?.[WHOLE_FILE_BASELINE_HEADING];
    if (!recorded) {
      // No like-for-like reference — cannot prove the file is untouched, so
      // preserve it rather than risk clobbering user edits.
      continue;
    }

    const onDisk = fs.readFileSync(fullPath, 'utf-8');
    if (hashSection(onDisk) === recorded) {
      // CLEAN: unmodified since scaffold → carry the current template forward.
      if (onDisk !== tpl.content) {
        fs.writeFileSync(fullPath, tpl.content);
      }
    }
    // DRIFT: hashes differ → user edited it → leave untouched.
  }
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

  // Scaffold whole-file templates (#249) — non-Markdown harness artifacts (the
  // CI workflow) the section-merge engine cannot carry — and record their content
  // baseline so refresh can preserve-on-edit / update-on-clean.
  generateWholeFileTemplates(rootDir);
  saveWholeFileBaseline(rootDir, computeWholeFileBaseline());

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
 */
export function refreshHarnessFiles(rootDir: string): void {
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

  // Reconcile whole-file templates (#249): re-scaffold if deleted, update if the
  // user never touched it, preserve if they edited it. Then re-record the content
  // baseline so a later refresh measures drift from the now-current template.
  refreshWholeFileTemplates(rootDir);
  saveWholeFileBaseline(rootDir, computeWholeFileBaseline());

  // Refresh Spec Kit slash-command shims. Per-command Claude/Cursor files
  // are only created if missing (user edits preserved); the AGENTS.md
  // marker section is regenerated in place.
  generateSlashCommandShims(rootDir);
}
