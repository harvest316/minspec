/**
 * Merge-on-refresh — section-level merge for harness file regeneration.
 *
 * Strategy:
 *   1. Parse both existing and generated files into sections (## headings)
 *   2. For each section in the new template:
 *      - If section exists in user file AND was modified (hash differs from
 *        last generation) → keep user version
 *      - If section exists in user file AND is unmodified → regenerate from template
 *      - If section is new in template → append
 *   3. Sections in user file not in template → preserve at end
 *   4. Store section hashes in .minspec/generated-hashes.json
 *
 * Pure logic, no vscode dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** Section hash map: heading → SHA-256 hash of section body */
export interface SectionHashes {
  readonly [heading: string]: string;
}

/** Persisted hashes for all generated files */
export interface GeneratedHashes {
  readonly [filePath: string]: SectionHashes;
}

/** A parsed section: heading + body content */
export interface Section {
  readonly heading: string;
  readonly body: string;
}

/** Result of a merge operation */
export interface MergeResult {
  readonly merged: string;
  readonly newHashes: SectionHashes;
}

/**
 * Parse markdown content into sections delimited by `## ` headings.
 * The content before the first heading is stored under the key "__preamble__".
 */
export function parseSections(content: string): Section[] {
  const sections: Section[] = [];
  if (typeof content !== 'string') return sections;
  const lines = content.split('\n');
  let currentHeading = '__preamble__';
  let currentBody: string[] = [];

  const flush = () => {
    sections.push({
      heading: currentHeading,
      body: currentBody.join('\n'),
    });
    currentBody = [];
  };

  for (const line of lines) {
    const match = line.match(/^## (.+)$/);
    if (match) {
      flush();
      currentHeading = match[1];
    } else {
      currentBody.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * SHA-256 hash of section content (trimmed to ignore trailing whitespace).
 * Deterministic — same content always produces the same hash.
 */
export function hashSection(content: string): string {
  return crypto.createHash('sha256').update(content.trim()).digest('hex');
}

/**
 * Rebuild markdown from sections array.
 */
function sectionsToMarkdown(sections: Section[]): string {
  const parts: string[] = [];
  for (const section of sections) {
    if (section.heading === '__preamble__') {
      parts.push(section.body);
    } else {
      parts.push(`## ${section.heading}`);
      parts.push(section.body);
    }
  }
  // Join, normalize trailing whitespace
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * Build a hash map for all sections in the content.
 */
export function buildSectionHashes(sections: Section[]): SectionHashes {
  const hashes: Record<string, string> = {};
  for (const section of sections) {
    hashes[section.heading] = hashSection(section.body);
  }
  return hashes;
}

/**
 * Merge an existing file with a newly generated version, using stored hashes
 * to determine which sections the user has modified.
 *
 * @param existing   - Current file content on disk
 * @param generated  - Freshly rendered template content
 * @param oldHashes  - Section hashes from the last generation (from generated-hashes.json)
 * @returns merged content + new hashes for storage
 */
export function mergeFile(
  existing: string,
  generated: string,
  oldHashes: SectionHashes,
): MergeResult {
  const existingSections = parseSections(existing);
  const generatedSections = parseSections(generated);

  // Index existing sections by heading as an occurrence-ordered queue.
  // A plain Map<string,string> would collapse duplicate-named headings and
  // silently drop one section's body (#153). We retain every occurrence and
  // consume them positionally instead.
  const existingByHeading = new Map<string, Section[]>();
  for (const s of existingSections) {
    const queue = existingByHeading.get(s.heading);
    if (queue) {
      queue.push(s);
    } else {
      existingByHeading.set(s.heading, [s]);
    }
  }
  // Track which existing sections have been consumed (by reference identity)
  // so the preserve pass can append everything left over — including extra
  // duplicate occurrences — verbatim.
  const consumed = new Set<Section>();

  const mergedSections: Section[] = [];
  const newHashes: Record<string, string> = {};

  // Process sections in the order they appear in the new template
  for (const genSection of generatedSections) {
    const heading = genSection.heading;
    const queue = existingByHeading.get(heading);
    const existSection = queue && queue.length > 0 ? queue.shift()! : undefined;

    if (existSection) {
      // Section exists in both files — consume the first unmatched occurrence.
      consumed.add(existSection);
      const existingBody = existSection.body;
      const existingHash = hashSection(existingBody);
      const oldHash = oldHashes[heading];

      if (oldHash && existingHash !== oldHash) {
        // User modified this section → keep user version
        mergedSections.push({ heading, body: existingBody });
        newHashes[heading] = existingHash;
      } else {
        // Section unmodified (or no previous hash → first refresh) → use new template
        mergedSections.push({ heading, body: genSection.body });
        newHashes[heading] = hashSection(genSection.body);
      }
    } else {
      // New section in template → append from template
      mergedSections.push({ heading, body: genSection.body });
      newHashes[heading] = hashSection(genSection.body);
    }
  }

  // Preserve every existing section the template did not consume — in original
  // document order. This covers both user-added sections (heading absent from
  // template) and surplus occurrences of duplicate-named headings, so no user
  // content is ever dropped (#153).
  for (const existSection of existingSections) {
    if (consumed.has(existSection)) continue;
    mergedSections.push(existSection);
    // Only record a tracking hash if this heading has no hash yet, so the
    // first occurrence's hash (used for modified-detection) is not clobbered
    // by a later duplicate.
    if (!(existSection.heading in newHashes)) {
      newHashes[existSection.heading] = hashSection(existSection.body);
    }
  }

  return {
    merged: sectionsToMarkdown(mergedSections),
    newHashes,
  };
}

const HASHES_FILENAME = 'generated-hashes.json';

/**
 * Load persisted section hashes from .minspec/generated-hashes.json.
 * Returns empty object if file doesn't exist or is invalid.
 */
export function loadHashes(rootDir: string): GeneratedHashes {
  const hashesPath = path.join(rootDir, '.minspec', HASHES_FILENAME);
  if (!fs.existsSync(hashesPath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(hashesPath, 'utf-8');
    return JSON.parse(raw) as GeneratedHashes;
  } catch {
    return {};
  }
}

/**
 * Save section hashes to .minspec/generated-hashes.json.
 */
export function saveHashes(rootDir: string, hashes: GeneratedHashes): void {
  const hashesPath = path.join(rootDir, '.minspec', HASHES_FILENAME);
  fs.mkdirSync(path.dirname(hashesPath), { recursive: true });
  fs.writeFileSync(hashesPath, JSON.stringify(hashes, null, 2) + '\n');
}

const TEMPLATE_BASELINE_FILENAME = 'template-baseline.json';

/**
 * Load the raw-template section-hash baseline from
 * `.minspec/template-baseline.json`.
 *
 * This records the hash of each *unrendered* bundled template section (with
 * `{{placeholders}}` intact) as of the last generate/refresh — the like-for-like
 * reference `hasHarnessDrift` compares the current bundled template against. It
 * is deliberately SEPARATE from `generated-hashes.json`, which stores
 * rendered + user-merged content hashes for edit preservation. Comparing the raw
 * template against those rendered/merged hashes is what produced the perpetual
 * false-positive drift toast (#117): a raw `{{projectName}}` never hash-matches
 * the rendered project name.
 *
 * Returns `{}` if the file is missing or invalid.
 */
export function loadTemplateBaseline(rootDir: string): GeneratedHashes {
  const baselinePath = path.join(rootDir, '.minspec', TEMPLATE_BASELINE_FILENAME);
  if (!fs.existsSync(baselinePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(baselinePath, 'utf-8');
    return JSON.parse(raw) as GeneratedHashes;
  } catch {
    return {};
  }
}

/**
 * Persist the raw-template baseline to `.minspec/template-baseline.json`.
 * Written at every generate/refresh so drift detection always has a current
 * like-for-like reference. See {@link loadTemplateBaseline}.
 */
export function saveTemplateBaseline(rootDir: string, baseline: GeneratedHashes): void {
  const baselinePath = path.join(rootDir, '.minspec', TEMPLATE_BASELINE_FILENAME);
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
}

const WHOLE_FILE_BASELINE_FILENAME = 'whole-file-baseline.json';

/**
 * Load the whole-file template content baseline from
 * `.minspec/whole-file-baseline.json`.
 *
 * Records the content hash of each scaffolded *whole-file* template (YAML/scripts
 * — see template-registry.ts `WHOLE_FILE_TEMPLATES`) as of the last
 * generate/refresh. Refresh compares the file on disk against this to decide
 * CLEAN (== baseline → safe to update) vs DRIFT (user-edited → preserve). Kept
 * deliberately SEPARATE from `template-baseline.json` (Markdown section drift) and
 * `generated-hashes.json` (Markdown edit-preservation) so the three concerns
 * never alias each other.
 *
 * Returns `{}` if the file is missing or invalid.
 */
export function loadWholeFileBaseline(rootDir: string): GeneratedHashes {
  const baselinePath = path.join(rootDir, '.minspec', WHOLE_FILE_BASELINE_FILENAME);
  if (!fs.existsSync(baselinePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(baselinePath, 'utf-8');
    return JSON.parse(raw) as GeneratedHashes;
  } catch {
    return {};
  }
}

/**
 * Persist the whole-file template baseline to
 * `.minspec/whole-file-baseline.json`. See {@link loadWholeFileBaseline}.
 */
export function saveWholeFileBaseline(rootDir: string, baseline: GeneratedHashes): void {
  const baselinePath = path.join(rootDir, '.minspec', WHOLE_FILE_BASELINE_FILENAME);
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
}
