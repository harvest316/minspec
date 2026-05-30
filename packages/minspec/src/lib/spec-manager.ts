import * as fs from 'fs';
import * as path from 'path';
import type { Tier, Phase, SpecsLayout } from './config';
import { loadConfig, PHASES, resolveAndValidate, DEFAULT_CONFIG } from './config';
import type { SpecFrontmatter, ParsedSpec } from './spec';
import { writeSpec, readSpecFile, writeSpecFile } from './spec';
import type { PhaseState, SpecStatus, TransitionResult } from './lifecycle';
import {
  createInitialPhases,
  getCurrentPhase,
  getSpecStatus,
  advancePhase,
  skipPhase,
  goBackToPhase,
  archiveSpec as archiveSpecLifecycle,
} from './lifecycle';
import {
  isSpecKitDirEntry,
  readSpecKitDir,
  writeSpecKitDir,
  specKitDirName,
} from './spec-layout';

/** Summary of a spec for listing/display */
export interface SpecSummary {
  readonly id: string;
  readonly title: string;
  readonly tier: Tier;
  readonly status: SpecStatus;
  readonly currentPhase: Phase | null;
  /** Path users open: flat file path, or spec.md inside spec-kit directory. */
  readonly filePath: string;
  /** Required phases completed (done or skipped) for this spec's tier (DR-012). */
  readonly phasesDone: number;
  /** Total required phases for this spec's tier (DR-012). */
  readonly phasesTotal: number;
  /** Optional epic reference (EPIC-NNN id or slug). Absent = ungrouped. */
  readonly epic?: string;
}

/** Full spec detail including content and phase states */
export interface SpecDetail {
  readonly summary: SpecSummary;
  readonly content: string;
  readonly phases: PhaseState;
}

// --- Slug generation ---

/**
 * Convert a title to a URL-friendly slug.
 * Lowercase, non-alphanumeric → hyphens, collapsed, trimmed, max 50 chars.
 */
export function slugify(title: string): string {
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (slug.length > 50) {
    slug = slug.slice(0, 50).replace(/-$/, '');
  }

  return slug;
}

// --- ID generation ---

const SPEC_ID_RE = /^SPEC-(\d+)/;
const FLAT_DIR_NUM_RE = /^(\d{3,})-/;
const SPEC_FILE_RE = /^SPEC-\d{3,}.*\.md$/;

/**
 * Scan specs directory and return the next sequential SPEC ID.
 * Scans both flat files (`SPEC-NNN-…`) and spec-kit dirs (`NNN-…`)
 * so IDs stay unique across layouts.
 */
export function nextSpecId(specsDir: string): string {
  let maxNum = 0;

  if (fs.existsSync(specsDir)) {
    const entries = fs.readdirSync(specsDir);
    for (const entry of entries) {
      const flatMatch = entry.match(SPEC_ID_RE);
      if (flatMatch) {
        const num = parseInt(flatMatch[1], 10);
        if (num > maxNum) maxNum = num;
        continue;
      }
      const dirMatch = entry.match(FLAT_DIR_NUM_RE);
      if (dirMatch) {
        const full = path.join(specsDir, entry);
        try {
          if (fs.statSync(full).isDirectory()) {
            const num = parseInt(dirMatch[1], 10);
            if (num > maxNum) maxNum = num;
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  const nextNum = maxNum + 1;
  return `SPEC-${String(nextNum).padStart(3, '0')}`;
}

// --- Helpers ---

function resolveSpecsDir(rootDir: string): string {
  const config = loadConfig(rootDir);
  return resolveAndValidate(rootDir, config.specsDir);
}

/** Discriminated handle to a spec on disk. */
type SpecEntry =
  | { kind: 'flat'; filePath: string }
  | { kind: 'spec-kit'; dirPath: string; specMdPath: string };

function findSpecEntry(specsDir: string, specId: string): SpecEntry | null {
  if (!fs.existsSync(specsDir)) return null;

  const numMatch = specId.match(SPEC_ID_RE);
  const numericPart = numMatch ? numMatch[1] : null;

  const entries = fs.readdirSync(specsDir);
  for (const entry of entries) {
    const full = path.join(specsDir, entry);

    if (entry.startsWith(specId) && entry.endsWith('.md')) {
      return { kind: 'flat', filePath: full };
    }

    if (numericPart && entry.startsWith(`${numericPart}-`) || entry === numericPart) {
      try {
        if (fs.statSync(full).isDirectory()) {
          return {
            kind: 'spec-kit',
            dirPath: full,
            specMdPath: path.join(full, 'spec.md'),
          };
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function readEntry(entry: SpecEntry): ParsedSpec {
  if (entry.kind === 'flat') return readSpecFile(entry.filePath);
  return readSpecKitDir(entry.dirPath);
}

function writeEntry(entry: SpecEntry, spec: ParsedSpec): void {
  if (entry.kind === 'flat') {
    writeSpecFile(entry.filePath, spec);
    return;
  }
  writeSpecKitDir(entry.dirPath, spec);
}

function entryDisplayPath(entry: SpecEntry): string {
  return entry.kind === 'flat' ? entry.filePath : entry.specMdPath;
}

/**
 * Count completed (done/skipped) required phases for a tier (DR-012).
 * Uses the default phase mapping; the sidebar recomputes with project config
 * for display, this keeps SpecSummary self-contained for non-UI callers.
 */
function phaseProgress(
  phases: Record<Phase, import('./spec').PhaseStatus>,
  tier: Tier,
): { done: number; total: number } {
  const required = DEFAULT_CONFIG.phaseMappings[tier]?.requiredPhases ?? ['specify'];
  let done = 0;
  for (const phase of required) {
    const st = phases[phase];
    if (st === 'done' || st === 'skipped') done++;
  }
  return { done, total: required.length };
}

function buildSummary(parsed: ParsedSpec, filePath: string): SpecSummary {
  const { done, total } = phaseProgress(parsed.frontmatter.phases, parsed.frontmatter.tier);
  return {
    id: parsed.frontmatter.id,
    title: parsed.frontmatter.title,
    tier: parsed.frontmatter.tier,
    status: parsed.frontmatter.status,
    currentPhase: getCurrentPhase(parsed.frontmatter.phases),
    filePath,
    phasesDone: done,
    phasesTotal: total,
    epic: parsed.frontmatter.epic,
  };
}

// --- CRUD operations ---

/**
 * Create a new spec with auto-generated ID and optional tier.
 * Storage layout (flat file vs. spec-kit directory) follows config.specsLayout.
 */
export function createSpec(rootDir: string, title: string, tier: Tier = 'T2'): SpecSummary {
  const config = loadConfig(rootDir);
  const specsDir = resolveAndValidate(rootDir, config.specsDir);
  fs.mkdirSync(specsDir, { recursive: true });

  const id = nextSpecId(specsDir);
  const slug = slugify(title);
  const today = new Date().toISOString().slice(0, 10);
  const initialPhases = createInitialPhases();

  const frontmatter: SpecFrontmatter = {
    id,
    title,
    tier,
    status: 'new',
    created: today,
    phases: initialPhases as Record<Phase, import('./spec').PhaseStatus>,
  };

  const tierMapping = config.phaseMappings[tier];
  const relevantPhases = [...tierMapping.requiredPhases, ...tierMapping.optionalPhases];

  const sections = new Map<string, string>();
  for (const phase of PHASES) {
    if (relevantPhases.includes(phase)) {
      const capitalized = phase.charAt(0).toUpperCase() + phase.slice(1);
      sections.set(capitalized, '\n');
    }
  }

  const spec: ParsedSpec = {
    frontmatter,
    preamble: '',
    sections,
    phaseSections: {},
    raw: '',
  };

  let displayPath: string;
  if (config.specsLayout === 'spec-kit') {
    const dirName = specKitDirName(id, slug);
    const dirPath = path.join(specsDir, dirName);
    writeSpecKitDir(dirPath, spec);
    displayPath = path.join(dirPath, 'spec.md');
  } else {
    const fileName = `${id}-${slug}.md`;
    const filePath = path.join(specsDir, fileName);
    fs.writeFileSync(filePath, writeSpec(spec), 'utf-8');
    displayPath = filePath;
  }

  const progress = phaseProgress(
    initialPhases as Record<Phase, import('./spec').PhaseStatus>,
    tier,
  );
  return {
    id,
    title,
    tier,
    status: 'new',
    currentPhase: getCurrentPhase(initialPhases),
    filePath: displayPath,
    phasesDone: progress.done,
    phasesTotal: progress.total,
  };
}

/**
 * List all specs, optionally filtered by status and/or tier.
 * Returns specs from both flat files and spec-kit directories
 * (so a project mid-migration stays readable).
 */
export function listSpecs(
  rootDir: string,
  filter?: { status?: SpecStatus; tier?: Tier },
): SpecSummary[] {
  const specsDir = resolveSpecsDir(rootDir);
  if (!fs.existsSync(specsDir)) return [];

  const entries = fs.readdirSync(specsDir).sort();
  const results: SpecSummary[] = [];

  for (const entry of entries) {
    const fullPath = path.join(specsDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    try {
      let parsed: ParsedSpec;
      let displayPath: string;

      if (stat.isFile()) {
        if (!SPEC_FILE_RE.test(entry)) continue;
        parsed = readSpecFile(fullPath);
        displayPath = fullPath;
      } else if (stat.isDirectory() && isSpecKitDirEntry(entry)) {
        const specMd = path.join(fullPath, 'spec.md');
        if (!fs.existsSync(specMd)) continue;
        parsed = readSpecKitDir(fullPath);
        displayPath = specMd;
      } else {
        continue;
      }

      if (!parsed.frontmatter.id) continue;

      const summary = buildSummary(parsed, displayPath);
      if (filter?.status && summary.status !== filter.status) continue;
      if (filter?.tier && summary.tier !== filter.tier) continue;
      results.push(summary);
    } catch {
      continue;
    }
  }

  return results;
}

/**
 * Get full details for a single spec by ID.
 */
export function getSpec(rootDir: string, specId: string): SpecDetail | null {
  const specsDir = resolveSpecsDir(rootDir);
  const entry = findSpecEntry(specsDir, specId);
  if (!entry) return null;

  try {
    const parsed = readEntry(entry);
    const displayPath = entryDisplayPath(entry);
    // `content` is the canonical single-file serialization — useful for callers
    // that want a portable text view regardless of underlying layout.
    const content = writeSpec(parsed);
    const summary = buildSummary(parsed, displayPath);

    return {
      summary,
      content,
      phases: parsed.frontmatter.phases,
    };
  } catch {
    return null;
  }
}

/**
 * Transition a spec's phase (advance, skip, or go back).
 */
export function transitionPhase(
  rootDir: string,
  specId: string,
  action: 'advance' | 'skip' | 'back',
  reason?: string,
): TransitionResult {
  const specsDir = resolveSpecsDir(rootDir);
  const entry = findSpecEntry(specsDir, specId);
  if (!entry) {
    return {
      success: false,
      newPhases: createInitialPhases(),
      newStatus: 'new',
      warning: `Spec '${specId}' not found`,
    };
  }

  const parsed = readEntry(entry);
  const phases = parsed.frontmatter.phases;
  const current = getCurrentPhase(phases);

  if (!current) {
    return {
      success: false,
      newPhases: phases,
      newStatus: getSpecStatus(phases),
      warning: 'No active phase to transition',
    };
  }

  let result: TransitionResult;

  switch (action) {
    case 'advance':
      result = advancePhase(phases, current);
      break;
    case 'skip':
      result = skipPhase(phases, current, reason ?? 'Skipped');
      break;
    case 'back':
      result = goBackToPhase(phases, current, reason ?? 'Reopened');
      break;
  }

  if (result.success) {
    const newFm: SpecFrontmatter = {
      ...parsed.frontmatter,
      status: result.newStatus,
      phases: result.newPhases as Record<Phase, import('./spec').PhaseStatus>,
    };
    writeEntry(entry, { ...parsed, frontmatter: newFm });
  }

  return result;
}

/**
 * Archive a spec — preserves completed phases, sets status to archived.
 */
export function archiveSpecById(rootDir: string, specId: string): TransitionResult {
  const specsDir = resolveSpecsDir(rootDir);
  const entry = findSpecEntry(specsDir, specId);
  if (!entry) {
    return {
      success: false,
      newPhases: createInitialPhases(),
      newStatus: 'new',
      warning: `Spec '${specId}' not found`,
    };
  }

  const parsed = readEntry(entry);
  const result = archiveSpecLifecycle(parsed.frontmatter.phases);

  if (result.success) {
    const newFm: SpecFrontmatter = {
      ...parsed.frontmatter,
      status: 'archived',
      phases: result.newPhases as Record<Phase, import('./spec').PhaseStatus>,
    };
    writeEntry(entry, { ...parsed, frontmatter: newFm });
  }

  return result;
}

/**
 * Delete a spec — removes the flat file or the entire spec-kit directory.
 * Requires confirm=true as a safety measure.
 */
export function deleteSpec(rootDir: string, specId: string, confirm: boolean): boolean {
  if (!confirm) return false;

  const specsDir = resolveSpecsDir(rootDir);
  const entry = findSpecEntry(specsDir, specId);
  if (!entry) return false;

  if (entry.kind === 'flat') {
    fs.unlinkSync(entry.filePath);
  } else {
    fs.rmSync(entry.dirPath, { recursive: true, force: true });
  }
  return true;
}

// --- Migration ---

export interface MigrationResult {
  readonly success: boolean;
  readonly migrated: number;
  readonly target: SpecsLayout;
  readonly warning?: string;
}

/**
 * Migrate every spec in `rootDir` to the target storage layout.
 *
 * Safety order: write all new representations first, then delete old.
 * If a spec is already in the target layout it is skipped.
 *
 * Frontmatter and body content are preserved byte-for-byte (round-trip
 * tested in spec-layout.test.ts — see "no data loss" invariant).
 */
export function migrateLayout(rootDir: string, target: SpecsLayout): MigrationResult {
  const specsDir = resolveSpecsDir(rootDir);
  if (!fs.existsSync(specsDir)) {
    return { success: true, migrated: 0, target };
  }

  const summaries = listSpecs(rootDir);
  let migrated = 0;
  const toDelete: SpecEntry[] = [];

  for (const summary of summaries) {
    const entry = findSpecEntry(specsDir, summary.id);
    if (!entry) continue;
    if (entry.kind === target) continue;

    const parsed = readEntry(entry);
    const slug = slugify(parsed.frontmatter.title);

    if (target === 'spec-kit') {
      const dirName = specKitDirName(parsed.frontmatter.id, slug);
      const dirPath = path.join(specsDir, dirName);
      if (fs.existsSync(dirPath)) {
        return {
          success: false,
          migrated,
          target,
          warning: `Target directory already exists: ${dirName}`,
        };
      }
      writeSpecKitDir(dirPath, parsed);
    } else {
      const fileName = `${parsed.frontmatter.id}-${slug}.md`;
      const filePath = path.join(specsDir, fileName);
      if (fs.existsSync(filePath)) {
        return {
          success: false,
          migrated,
          target,
          warning: `Target file already exists: ${fileName}`,
        };
      }
      fs.writeFileSync(filePath, writeSpec(parsed), 'utf-8');
    }

    toDelete.push(entry);
    migrated++;
  }

  // All writes succeeded — now remove old representations.
  for (const entry of toDelete) {
    if (entry.kind === 'flat') {
      fs.unlinkSync(entry.filePath);
    } else {
      fs.rmSync(entry.dirPath, { recursive: true, force: true });
    }
  }

  return { success: true, migrated, target };
}
