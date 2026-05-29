import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG, loadConfig } from './config';
import { buildContext, renderTemplate, renderAll } from './template-engine';
import { TEMPLATE_NAMES, TEMPLATE_OUTPUT_PATHS } from './template-registry';
import {
  parseSections,
  buildSectionHashes,
  mergeFile,
  loadHashes,
  saveHashes,
  type GeneratedHashes,
} from './merge-refresh';

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

  saveHashes(rootDir, allHashes);
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

  saveHashes(rootDir, allHashes);
}
