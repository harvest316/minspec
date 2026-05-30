import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, applyVSCodeOverrides, resolveAndValidate } from './config';
import { slugify } from './spec-manager';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Epic lifecycle status */
export type EpicStatus = 'proposed' | 'active' | 'done' | 'abandoned';

/** Parsed epic frontmatter (docs/epics/EPIC-NNN.md) */
export interface EpicFrontmatter {
  readonly id: string;        // EPIC-NNN
  readonly slug: string;      // kebab handle; suffix of the GitHub `epic:<slug>` label
  readonly title: string;
  readonly status: EpicStatus;
  readonly order: number;     // explorer sort key; lower = higher
}

/** Summary for listing/display */
export interface EpicSummary extends EpicFrontmatter {
  readonly filePath: string;
}

/** Sentinel group label for artifacts with no/unresolved epic reference. */
export const NO_EPIC = '(no epic)';

/** All valid epic statuses, in lifecycle order. For UI pickers. */
export const EPIC_STATUS_VALUES: readonly EpicStatus[] = ['proposed', 'active', 'done', 'abandoned'];

// ─── Constants ──────────────────────────────────────────────────────────────

const EPIC_FILE_RE = /^EPIC-(\d+).*\.md$/;
const EPIC_ID_RE = /^EPIC-(\d+)/;
const EPIC_STATUSES = new Set<string>(EPIC_STATUS_VALUES);

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

const INDEX_MARKER_START = '<!-- minspec:epic-index:start -->';
const INDEX_MARKER_END = '<!-- minspec:epic-index:end -->';

// ─── Frontmatter Parser ─────────────────────────────────────────────────────

/** Parse YAML frontmatter from an epic file. Lightweight, no dependency. */
function parseFrontmatterYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }
  return result;
}

// ─── Epics Directory ────────────────────────────────────────────────────────

/** Resolve the epics directory path from config (+ optional VS Code overrides). */
export function resolveEpicsDir(
  rootDir: string,
  vscodeOverrides?: { epicsDir?: string },
): string {
  let config = loadConfig(rootDir);
  if (vscodeOverrides) {
    config = applyVSCodeOverrides(config, vscodeOverrides);
  }
  return resolveAndValidate(rootDir, config.epicsDir);
}

// ─── Listing ────────────────────────────────────────────────────────────────

/**
 * List all epics in the epics directory.
 * Returns summaries sorted by `order` ascending, then `id` for ties.
 */
export function listEpics(rootDir: string, vscodeOverrides?: { epicsDir?: string }): EpicSummary[] {
  const epicsDir = resolveEpicsDir(rootDir, vscodeOverrides);
  if (!fs.existsSync(epicsDir)) return [];

  const entries = fs.readdirSync(epicsDir).filter(e => EPIC_FILE_RE.test(e));
  const results: EpicSummary[] = [];

  for (const entry of entries) {
    const filePath = path.join(epicsDir, entry);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const fmMatch = content.match(FRONTMATTER_RE);
      const idFromFile = entry.match(EPIC_ID_RE)?.[0] ?? entry;

      if (!fmMatch) {
        // No frontmatter — derive minimal summary from the filename.
        results.push({
          id: idFromFile,
          slug: slugify(entry.replace(EPIC_FILE_RE, '$1')) || idFromFile.toLowerCase(),
          title: entry.replace(EPIC_FILE_RE, '').replace(/^-|-$/g, '').replace(/-/g, ' ') || entry,
          status: 'proposed',
          order: 999,
          filePath,
        });
        continue;
      }

      const fm = parseFrontmatterYaml(fmMatch[1]);
      const id = fm.id ?? idFromFile;
      const parsedOrder = Number(fm.order);
      results.push({
        id,
        slug: fm.slug ?? slugify(fm.title ?? id),
        title: fm.title ?? '',
        status: EPIC_STATUSES.has(fm.status) ? (fm.status as EpicStatus) : 'proposed',
        order: Number.isFinite(parsedOrder) ? parsedOrder : 999,
        filePath,
      });
    } catch {
      // Skip unreadable files
    }
  }

  results.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  return results;
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve an epic reference (id like "EPIC-001" OR slug like "telemetry") to its
 * summary. Case-insensitive. Returns null if absent or unresolved — callers
 * treat null as "ungrouped" (never throw; FR-9 warning is surfaced separately).
 */
export function resolveEpic(ref: string | undefined, epics: EpicSummary[]): EpicSummary | null {
  if (!ref) return null;
  const needle = ref.trim().toLowerCase();
  if (needle === '') return null;
  for (const epic of epics) {
    if (epic.id.toLowerCase() === needle || epic.slug.toLowerCase() === needle) {
      return epic;
    }
  }
  return null;
}

/**
 * Bucket artifacts by their resolved epic id. Items whose ref is absent or does
 * not resolve land in the NO_EPIC bucket. The returned Map iterates epics in
 * `epics` order (i.e. order→id), with NO_EPIC last when present.
 */
export function groupByEpic<T>(
  items: T[],
  refOf: (item: T) => string | undefined,
  epics: EpicSummary[],
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  // Seed in epic order so iteration is deterministic; prune empties at the end.
  for (const epic of epics) buckets.set(epic.id, []);

  const noEpic: T[] = [];
  for (const item of items) {
    const resolved = resolveEpic(refOf(item), epics);
    if (resolved) {
      buckets.get(resolved.id)!.push(item);
    } else {
      noEpic.push(item);
    }
  }

  // Drop epics with no members to avoid empty groups in the tree.
  for (const [id, members] of [...buckets]) {
    if (members.length === 0) buckets.delete(id);
  }
  if (noEpic.length > 0) buckets.set(NO_EPIC, noEpic);
  return buckets;
}

// ─── Numbering & Creation ─────────────────────────────────────────────────────

/** Next sequential epic number: max(existing EPIC-NNN) + 1. */
export function nextEpicNumber(epicsDir: string): number {
  let maxNum = 0;
  if (fs.existsSync(epicsDir)) {
    for (const entry of fs.readdirSync(epicsDir)) {
      const match = entry.match(EPIC_ID_RE);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
  }
  return maxNum + 1;
}

/** Format an epic id with zero-padded number: EPIC-001, EPIC-042. */
export function formatEpicId(num: number): string {
  return `EPIC-${String(num).padStart(3, '0')}`;
}

/** The next epic id as a string (convenience over nextEpicNumber + format). */
export function nextEpicId(rootDir: string, vscodeOverrides?: { epicsDir?: string }): string {
  return formatEpicId(nextEpicNumber(resolveEpicsDir(rootDir, vscodeOverrides)));
}

/** Generate a new epic markdown file from template. */
export function generateEpicContent(id: string, title: string, slug: string, order: number): string {
  return [
    '---',
    `id: ${id}`,
    `slug: ${slug}`,
    `title: ${title}`,
    'status: proposed',
    `order: ${order}`,
    '---',
    '',
    `# ${id}: ${title}`,
    '',
    '## Goal',
    '',
    '<!-- What body of work does this epic group? What does "done" look like? -->',
    '',
    '## Artifacts',
    '',
    `<!-- Specs/ADRs reference this epic via \`epic: ${id}\` (or \`epic: ${slug}\`) frontmatter.`,
    `     Issues via the GitHub label \`epic:${slug}\`. -->`,
    '',
  ].join('\n');
}

/**
 * Create a new epic file with an auto-generated sequential id. The `order`
 * defaults to the new epic's number so freshly-created epics sort last.
 * Returns the created summary.
 */
export function createEpic(
  rootDir: string,
  title: string,
  slug?: string,
  vscodeOverrides?: { epicsDir?: string },
): EpicSummary {
  const epicsDir = resolveEpicsDir(rootDir, vscodeOverrides);
  fs.mkdirSync(epicsDir, { recursive: true });

  const num = nextEpicNumber(epicsDir);
  const id = formatEpicId(num);
  const resolvedSlug = slug && slug.trim() !== '' ? slugify(slug) : slugify(title);
  const fileName = `${id}-${resolvedSlug}.md`;
  const filePath = path.join(epicsDir, fileName);

  fs.writeFileSync(filePath, generateEpicContent(id, title, resolvedSlug, num), 'utf-8');
  return { id, slug: resolvedSlug, title, status: 'proposed', order: num, filePath };
}

// ─── Index ────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the auto-generated portion of the epic INDEX (between markers). */
export function buildEpicIndexContent(epics: EpicSummary[]): string {
  const header = '# Epic Register\n\n_Bodies of work grouping specs, decisions, and issues. One entry per epic._\n';
  if (epics.length === 0) {
    return `${header}\n_No epics defined yet._\n`;
  }
  const entries = epics.map(e => {
    const fileName = path.basename(e.filePath);
    return [
      `## [${e.id} — ${e.title}](${fileName})`,
      '',
      `*Status: ${e.status} · slug: \`${e.slug}\` · order: ${e.order}*`,
    ].join('\n');
  }).join('\n\n');
  return `${header}\n${entries}\n`;
}

/**
 * Merge auto content into an existing INDEX.md, preserving user content outside
 * the markers (invariant #6 / DR-011).
 */
export function mergeEpicIndex(existing: string | null, autoContent: string): string {
  const wrapped = `${INDEX_MARKER_START}\n${autoContent.trimEnd()}\n${INDEX_MARKER_END}\n`;
  if (existing === null || existing.trim() === '') return wrapped;

  const markerRe = new RegExp(
    `${escapeRegex(INDEX_MARKER_START)}[\\s\\S]*?${escapeRegex(INDEX_MARKER_END)}\\n?`,
  );
  if (markerRe.test(existing)) {
    return existing.replace(markerRe, wrapped);
  }
  return `${wrapped}\n${existing.trimStart()}`;
}

/** Regenerate <epicsDir>/INDEX.md, preserving user content outside markers. */
export function writeEpicIndex(rootDir: string, vscodeOverrides?: { epicsDir?: string }): { filePath: string; count: number } {
  const epicsDir = resolveEpicsDir(rootDir, vscodeOverrides);
  fs.mkdirSync(epicsDir, { recursive: true });

  const epics = listEpics(rootDir, vscodeOverrides);
  const indexPath = path.join(epicsDir, 'INDEX.md');
  const existing = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : null;
  fs.writeFileSync(indexPath, mergeEpicIndex(existing, buildEpicIndexContent(epics)), 'utf-8');
  return { filePath: indexPath, count: epics.length };
}
