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
  /** Owning product slug (`minspec` / `scroogellm`); drives the SPECS-pane prefix strip. */
  readonly product?: string;
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
/** Match an `id: SPEC-NNN` / `product: slug` frontmatter line (value may carry an inline `# comment`). */
const FM_ID_LINE_RE = /^id:\s*(SPEC-\d+)/m;
const FM_PRODUCT_LINE_RE = /^product:\s*([^\s#]+)/m;

/** One discovered spec id and the product that owns it (if known). */
interface DiscoveredSpec {
  readonly num: number;
  /** Owning product slug, or null when no product signal exists. */
  readonly product: string | null;
}

/**
 * Walk a specs tree and collect every SPEC id with its owning product.
 *
 * Three id sources, so ids stay unique across every layout the repo uses:
 *   1. flat files            `specs/SPEC-NNN-….md`
 *   2. spec-kit dirs         `specs/NNN-…/`
 *   3. nested product specs  `specs/<product>/<feature>/{requirements,spec,…}.md`
 *
 * Product attribution (the #57 scoping signal) prefers the authoritative
 * `product:` frontmatter; when absent it falls back to the first path segment
 * under `specsDir` (`specs/<product>/…`). Top-level flat/spec-kit entries that
 * carry neither signal are recorded with `product: null` (global-only).
 */
function collectSpecs(specsDir: string): DiscoveredSpec[] {
  const found: DiscoveredSpec[] = [];
  if (!fs.existsSync(specsDir)) return found;

  // Read `product:` from a markdown file's frontmatter, falling back to the
  // top-level path segment under specsDir. Cheap: only the head is inspected.
  const productOf = (filePath: string): string | null => {
    let fmProduct: string | null = null;
    try {
      const head = fs.readFileSync(filePath, 'utf-8').slice(0, 2048);
      const m = head.match(FM_PRODUCT_LINE_RE);
      if (m) fmProduct = m[1].trim();
    } catch {
      /* unreadable → fall through to path-based attribution */
    }
    if (fmProduct) return fmProduct;
    const rel = path.relative(specsDir, filePath);
    const segs = rel.split(path.sep);
    // Only a *nested* file (under a product subdir) gets path attribution;
    // a file sitting directly in specsDir has no product segment.
    return segs.length > 1 ? segs[0] : null;
  };

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // A spec-kit dir (`NNN-…`) contributes its number directly, attributed
        // by its own (or its parent's) path segment. Still recurse so a nested
        // spec.md inside is also seen and de-duplicated by number.
        const dirMatch = entry.name.match(FLAT_DIR_NUM_RE);
        if (dirMatch) {
          const rel = path.relative(specsDir, full).split(path.sep);
          found.push({
            num: parseInt(dirMatch[1], 10),
            product: rel.length > 1 ? rel[0] : null,
          });
        }
        walk(full);
        continue;
      }

      if (!entry.isFile()) continue;

      // Flat file: id (and product range) come from the filename.
      const flatMatch = entry.name.match(SPEC_ID_RE);
      if (flatMatch) {
        found.push({ num: parseInt(flatMatch[1], 10), product: productOf(full) });
        continue;
      }

      // Nested product spec files (requirements.md / design.md / tasks.md /
      // spec.md / …): the id lives in `id:` frontmatter, not the filename.
      if (entry.name.endsWith('.md')) {
        try {
          const head = fs.readFileSync(full, 'utf-8').slice(0, 2048);
          const idMatch = head.match(FM_ID_LINE_RE);
          if (idMatch) {
            const numMatch = idMatch[1].match(SPEC_ID_RE);
            if (numMatch) {
              found.push({ num: parseInt(numMatch[1], 10), product: productOf(full) });
            }
          }
        } catch {
          /* ignore unreadable file */
        }
      }
    }
  };

  walk(specsDir);
  return found;
}

/**
 * Scan a specs tree and return the next sequential SPEC ID.
 *
 * When `product` is given, the max is scoped to specs owned by that product
 * (via `product:` frontmatter or the `specs/<product>/…` subpath) so each
 * product keeps its own SPEC-NNN range — a higher-numbered sibling product no
 * longer pushes the next id out of block (#57). A product with no specs yet
 * starts a fresh range at SPEC-001.
 *
 * When `product` is omitted the original global-counter contract holds: the max
 * is taken across every discovered id regardless of owner.
 */
export function nextSpecId(specsDir: string, product?: string): string {
  const specs = collectSpecs(specsDir);

  const relevant = product
    ? specs.filter((s) => s.product === product)
    : specs;

  let maxNum = 0;
  for (const s of relevant) {
    if (s.num > maxNum) maxNum = s.num;
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
    product: parsed.frontmatter.product,
  };
}

// --- CRUD operations ---

/**
 * Create a new spec with auto-generated ID and optional tier.
 * Storage layout (flat file vs. spec-kit directory) follows config.specsLayout.
 *
 * `product` scopes the generated id to that product's own SPEC-NNN range (#57):
 * the id continues the product's block instead of the global max, and the spec
 * self-attributes via a `product:` frontmatter field so the next scan sees it.
 * Omit it for single-product repos to keep the global-counter behavior.
 */
export function createSpec(
  rootDir: string,
  title: string,
  tier: Tier = 'T2',
  product?: string,
): SpecSummary {
  const config = loadConfig(rootDir);
  const specsDir = resolveAndValidate(rootDir, config.specsDir);
  fs.mkdirSync(specsDir, { recursive: true });

  const id = nextSpecId(specsDir, product);
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
    ...(product ? { product } : {}),
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
    ...(product ? { product } : {}),
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
