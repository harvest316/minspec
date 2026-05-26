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

  // Build lookup maps
  const existingMap = new Map<string, string>();
  for (const s of existingSections) {
    existingMap.set(s.heading, s.body);
  }

  const generatedMap = new Map<string, string>();
  for (const s of generatedSections) {
    generatedMap.set(s.heading, s.body);
  }

  // Track which existing headings have been processed
  const processed = new Set<string>();
  const mergedSections: Section[] = [];
  const newHashes: Record<string, string> = {};

  // Process sections in the order they appear in the new template
  for (const genSection of generatedSections) {
    const heading = genSection.heading;
    processed.add(heading);

    if (existingMap.has(heading)) {
      // Section exists in both files
      const existingBody = existingMap.get(heading)!;
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

  // Preserve sections in user file that are not in the template
  for (const existSection of existingSections) {
    if (!processed.has(existSection.heading)) {
      mergedSections.push(existSection);
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
