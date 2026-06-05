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
  /**
   * True when the epic doc is still a stub — its `## Goal` or `## Artifacts`
   * section is empty or holds only the template placeholder (#85). Advisory:
   * drives a `(stub)` explorer decoration / soft warning, never a hard block.
   * Optional so hand-built summaries (tests, lightweight callers) need not set
   * it; `listEpics`/`createEpic` always populate it. Absent/false ⇒ not a stub.
   */
  readonly isStub?: boolean;
}

/** Sentinel group label for artifacts with no/unresolved epic reference. */
export const NO_EPIC = '(no epic)';

/** All valid epic statuses, in lifecycle order. For UI pickers. */
export const EPIC_STATUS_VALUES: readonly EpicStatus[] = ['proposed', 'active', 'done', 'abandoned'];

// ─── Constants ──────────────────────────────────────────────────────────────

const EPIC_FILE_RE = /^EPIC-(\d+).*\.md$/;
const EPIC_ID_RE = /^EPIC-(\d+)/;
const EPIC_STATUSES = new Set<string>(EPIC_STATUS_VALUES);

/**
 * Strip the `EPIC-NNN` id prefix and the `.md` extension from a filename,
 * leaving just the descriptive slug (e.g. `EPIC-012-user-auth-flow.md` →
 * `user-auth-flow`). Returns '' when the filename carries only the id.
 */
const EPIC_FILE_DESCRIPTOR_RE = /^EPIC-\d+[-_]?(.*?)(?:\.md)?$/;

/** Humanize a hyphen/underscore slug into Title Case words (`user-auth` → `User Auth`). */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

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
      // Tier-0 stub check from the epic body (#85): empty/placeholder sections.
      const isStub = detectEpicStub(content).stub;

      if (!fmMatch) {
        // No frontmatter — derive a sensible slug + title from the filename.
        // `EPIC-012-user-auth-flow.md` → slug `user-auth-flow`, title `User Auth Flow`.
        // `EPIC-013.md` (id only)      → slug `epic-013`,       title `EPIC-013`.
        const descriptor = entry.match(EPIC_FILE_DESCRIPTOR_RE)?.[1] ?? '';
        const slug = slugify(descriptor) || idFromFile.toLowerCase();
        const title = humanizeSlug(descriptor) || idFromFile;
        results.push({
          id: idFromFile,
          slug,
          title,
          status: 'proposed',
          order: 999,
          filePath,
          isStub,
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
        isStub,
      });
    } catch {
      // Skip unreadable files
    }
  }

  results.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  return results;
}

/**
 * Lowercased set of every valid epic reference (ids + slugs) in the registry.
 * For soft validation (`validateSpec` FR-9) — membership = "resolves".
 */
export function epicRefSet(rootDir: string, vscodeOverrides?: { epicsDir?: string }): Set<string> {
  const set = new Set<string>();
  for (const e of listEpics(rootDir, vscodeOverrides)) {
    set.add(e.id.toLowerCase());
    set.add(e.slug.toLowerCase());
  }
  return set;
}

// ─── Ref parsing / formatting ─────────────────────────────────────────────────

/**
 * Extract the machine ref from an `epic:` frontmatter value, dropping any inline
 * YAML comment. The line may carry a human-facing title comment
 * (`epic: EPIC-001  # Telemetry & Privacy`); the resolvable ref is everything
 * before the first `#`. Refs (EPIC-NNN ids and kebab slugs) never contain `#`,
 * so a first-hash split is safe. Returns undefined for absent/empty.
 */
export function epicRefValue(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const hash = raw.indexOf('#');
  const ref = (hash === -1 ? raw : raw.slice(0, hash)).trim();
  return ref === '' ? undefined : ref;
}

/**
 * Format an `epic:` frontmatter value, appending the epic title as an inline
 * YAML comment when known. The comment is cosmetic — the registry remains the
 * authoritative source of the title; `epicRefValue` strips it back off on read.
 */
export function formatEpicRef(ref: string, title?: string): string {
  return title && title.trim() !== '' ? `${ref}  # ${title.trim()}` : ref;
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve an epic reference (id like "EPIC-001" OR slug like "telemetry") to its
 * summary. Case-insensitive. Tolerates an inline title comment on the ref.
 * Returns null if absent or unresolved — callers treat null as "ungrouped"
 * (never throw; FR-9 warning is surfaced separately).
 */
export function resolveEpic(ref: string | undefined, epics: EpicSummary[]): EpicSummary | null {
  const needle = epicRefValue(ref)?.toLowerCase();
  if (!needle) return null;
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
 *
 * EVERY registered epic gets a bucket — including those with zero members.
 * A registered `proposed`/`active` epic that nothing references yet (e.g.
 * minted by epic-backfill, DR-016) must still surface in the explorer so it can
 * be reviewed/approved (#67); pruning it here made it invisible everywhere. The
 * only sentinel that is conditionally present is NO_EPIC, which is added solely
 * when one or more items fail to resolve — an unregistered/orphan key with no
 * members produces no bucket because it never seeds one.
 */
export function groupByEpic<T>(
  items: T[],
  refOf: (item: T) => string | undefined,
  epics: EpicSummary[],
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  // Seed in epic order so iteration is deterministic. Member-less registered
  // epics are KEPT (see #67) — do not prune empty buckets.
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

  if (noEpic.length > 0) buckets.set(NO_EPIC, noEpic);
  return buckets;
}

// ─── Frontmatter mutation ─────────────────────────────────────────────────────

/**
 * Insert or replace the `epic:` line in an existing artifact's frontmatter
 * block (spec or ADR). Top-level placement (prepended, before any nested block
 * like `phases:`). Mirrors `setAdrStatus`. When `title` is given it is written
 * as an inline comment after the ref (`epic: EPIC-001  # Title`). Returns the
 * written ref (without the comment).
 * @throws if the file has no frontmatter block.
 */
export function setArtifactEpic(filePath: string, ref: string, title?: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(FRONTMATTER_RE);
  if (!fmMatch) {
    throw new Error(`No frontmatter block in ${filePath}`);
  }
  const yaml = fmMatch[1];
  const value = formatEpicRef(ref, title);
  const epicLineRe = /^([ \t]*)epic[ \t]*:[ \t]*.*$/m;
  // `$1` keeps the captured indent; `value` (which may carry an untrusted epic
  // title comment) is escaped so a literal `$` in it is inserted verbatim (#152).
  const newYaml = epicLineRe.test(yaml)
    ? yaml.replace(epicLineRe, `$1epic: ${escapeReplacement(value)}`)
    : `epic: ${value}\n${yaml}`;
  // Replacer FUNCTION so a `$` anywhere in the rewritten block is literal (#152).
  const block = `---\n${newYaml}\n---`;
  const updated = content.replace(FRONTMATTER_RE, () => block);
  fs.writeFileSync(filePath, updated, 'utf-8');
  return ref;
}

/** Read the current `epic:` ref from an artifact's frontmatter, or null. Any
 * inline title comment is stripped — only the resolvable ref is returned. */
export function readArtifactEpic(filePath: string): string | null {
  try {
    const m = fs.readFileSync(filePath, 'utf-8').match(FRONTMATTER_RE);
    if (!m) return null;
    const line = m[1].match(/^[ \t]*epic[ \t]*:[ \t]*(.+)$/m);
    return line ? (epicRefValue(line[1]) ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite the `status:` line in an epic file's frontmatter. Adds the line if
 * absent. Returns the new status. Throws on invalid status or no frontmatter.
 */
export function setEpicStatus(filePath: string, status: EpicStatus): EpicStatus {
  if (!EPIC_STATUSES.has(status)) {
    throw new Error(`Invalid epic status: ${status}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(FRONTMATTER_RE);
  if (!fmMatch) {
    throw new Error(`No frontmatter block in ${filePath}`);
  }
  const yaml = fmMatch[1];
  const statusLineRe = /^([ \t]*)status[ \t]*:[ \t]*.*$/m;
  // `$1` keeps the captured indent; status is escaped for consistency (#152).
  const newYaml = statusLineRe.test(yaml)
    ? yaml.replace(statusLineRe, `$1status: ${escapeReplacement(status)}`)
    : `${yaml}\nstatus: ${status}`;
  // Replacer FUNCTION so a `$` anywhere in the rewritten block is literal (#152).
  const block = `---\n${newYaml}\n---`;
  fs.writeFileSync(filePath, content.replace(FRONTMATTER_RE, () => block), 'utf-8');
  return status;
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

/**
 * The template placeholder comment for an unfilled `## Goal` section. Exported so
 * stub detection (#85) can recognize an epic body left at its birth state — the
 * Goal is "filled" exactly when its body is neither empty nor this comment.
 */
export const GOAL_PLACEHOLDER =
  '<!-- What body of work does this epic group? What does "done" look like? -->';

/** Build the `## Artifacts` placeholder comment for a given id/slug. */
function artifactsPlaceholder(id: string, slug: string): string {
  return [
    `<!-- Specs/ADRs reference this epic via \`epic: ${id}\` (or \`epic: ${slug}\`) frontmatter.`,
    `     Issues via the GitHub label \`epic:${slug}\`. -->`,
  ].join('\n');
}

/**
 * Generate a new epic markdown file from template.
 *
 * When `goal` is a non-empty string it becomes the `## Goal` body verbatim
 * (so a backfill proposal's rationale survives — #79). Otherwise the section is
 * seeded with the template placeholder comment for the author to fill in.
 */
export function generateEpicContent(
  id: string,
  title: string,
  slug: string,
  order: number,
  goal?: string,
): string {
  const goalBody = goal && goal.trim() !== '' ? goal.trim() : GOAL_PLACEHOLDER;
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
    goalBody,
    '',
    '## Artifacts',
    '',
    artifactsPlaceholder(id, slug),
    '',
  ].join('\n');
}

/**
 * Create a new epic file with an auto-generated sequential id. The `order`
 * defaults to the new epic's number so freshly-created epics sort last. When
 * `goal` is given it is written into the `## Goal` section (backfill threads the
 * proposal rationale here — #79); otherwise the placeholder comment is used.
 * Returns the created summary.
 */
export function createEpic(
  rootDir: string,
  title: string,
  slug?: string,
  vscodeOverrides?: { epicsDir?: string },
  goal?: string,
): EpicSummary {
  const epicsDir = resolveEpicsDir(rootDir, vscodeOverrides);
  fs.mkdirSync(epicsDir, { recursive: true });

  const num = nextEpicNumber(epicsDir);
  const id = formatEpicId(num);
  const resolvedSlug = slug && slug.trim() !== '' ? slugify(slug) : slugify(title);
  const fileName = `${id}-${resolvedSlug}.md`;
  const filePath = path.join(epicsDir, fileName);

  const content = generateEpicContent(id, title, resolvedSlug, num, goal);
  fs.writeFileSync(filePath, content, 'utf-8');
  return {
    id, slug: resolvedSlug, title, status: 'proposed', order: num, filePath,
    isStub: detectEpicStub(content).stub,
  };
}

// ─── Stub detection (#85) ─────────────────────────────────────────────────────

/** A section of an epic body the stub check inspects. */
export type EpicStubReason = 'goal' | 'artifacts';

/** Result of the Tier-0 stub check on an epic body. */
export interface EpicStubResult {
  /** True when at least one inspected section is empty/placeholder-only. */
  readonly stub: boolean;
  /** Which sections are unfilled (`goal` and/or `artifacts`), in section order. */
  readonly reasons: EpicStubReason[];
}

/**
 * Extract the raw body of a `## <heading>` section: everything between that
 * heading and the next `## ` (or EOF). Returns null when the heading is absent.
 * Heading match is case-insensitive and tolerant of trailing whitespace.
 */
function extractSection(body: string, heading: string): string | null {
  const startRe = new RegExp(`^##[ \\t]+${escapeRegex(heading)}[ \\t]*$`, 'mi');
  const m = startRe.exec(body);
  if (!m) return null;
  const after = body.slice(m.index + m[0].length);
  const nextHeading = after.search(/^##[ \t]/m);
  return nextHeading === -1 ? after : after.slice(0, nextHeading);
}

/**
 * Whether a section body counts as "unfilled" — empty/whitespace-only, or it
 * consists solely of HTML comment(s) (the template placeholder). Any real prose
 * outside a comment makes it filled. Tier 0, purely structural — no AI.
 */
function isSectionUnfilled(sectionBody: string | null): boolean {
  if (sectionBody === null) return true;              // section missing entirely
  const stripped = sectionBody.replace(/<!--[\s\S]*?-->/g, '').trim();
  return stripped === '';                              // only comments/whitespace left
}

/**
 * Tier-0 soft check (#85): is this epic body still a stub — i.e. its `## Goal`
 * or `## Artifacts` section empty or holding only the template placeholder?
 *
 * Advisory only (the caller surfaces a WARNING / `(stub)` decoration; it never
 * blocks — only DR-012 approval blocks). Accepts the full epic file content.
 */
export function detectEpicStub(body: string): EpicStubResult {
  const reasons: EpicStubReason[] = [];
  if (isSectionUnfilled(extractSection(body, 'Goal'))) reasons.push('goal');
  if (isSectionUnfilled(extractSection(body, 'Artifacts'))) reasons.push('artifacts');
  return { stub: reasons.length > 0, reasons };
}

// ─── Index ────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape a string for safe use as the *replacement* argument of
 * `String.prototype.replace`. Doubles every `$` so a literal `$1`/`$&`/`` $` ``/
 * `$'`/`$$` in untrusted text (a field value or epic title) is inserted verbatim
 * instead of being interpreted as a replacement pattern (#152).
 */
function escapeReplacement(s: string): string {
  return s.replace(/\$/g, '$$$$');
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
    // Replacer FUNCTION so a `$` in any epic title inside `wrapped` is inserted
    // literally, never read as a replacement pattern (#152).
    return existing.replace(markerRe, () => wrapped);
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
