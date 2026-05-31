import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, applyVSCodeOverrides, resolveAndValidate } from './config';
import { slugify } from './spec-manager';
import { epicRefValue } from './epic-manager';
export { slugify };

// ─── Types ──────────────────────────────────────────────────────────────────

/** ADR status lifecycle */
export type AdrStatus = 'proposed' | 'accepted' | 'deprecated' | 'superseded';

/** Parsed ADR frontmatter */
export interface AdrFrontmatter {
  readonly id: string;
  readonly title: string;
  readonly status: AdrStatus;
  readonly date: string;
  /** Optional epic reference (EPIC-NNN id or slug). Absent = ungrouped. */
  readonly epic?: string;
}

/** Summary for listing/display */
export interface AdrSummary {
  readonly id: string;
  readonly title: string;
  readonly status: AdrStatus;
  readonly date: string;
  readonly filePath: string;
  /** Optional epic reference (EPIC-NNN id or slug). Absent = ungrouped. */
  readonly epic?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ADR_FILE_RE = /^DR-(\d+).*\.md$/;
const ADR_ID_RE = /^DR-(\d+)/;

const ADR_STATUSES = new Set<string>(['proposed', 'accepted', 'deprecated', 'superseded']);

// ─── Frontmatter Parser ─────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/**
 * Parse YAML frontmatter from an ADR file. Lightweight, no dependency.
 */
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

// ─── Decisions Directory ────────────────────────────────────────────────────

/**
 * Resolve the decisions directory path. Reads from .minspec/config.json
 * and optionally from VS Code settings overrides.
 */
export function resolveDecisionsDir(
  rootDir: string,
  vscodeOverrides?: { decisionsDir?: string },
): string {
  let config = loadConfig(rootDir);
  if (vscodeOverrides) {
    config = applyVSCodeOverrides(config, vscodeOverrides);
  }
  return resolveAndValidate(rootDir, config.decisionsDir);
}

// ─── Sequential ID with Collision Detection ─────────────────────────────────

/**
 * Scan the decisions directory and return the next sequential DR number.
 * Handles gaps — always returns max+1, never reuses numbers.
 */
export function nextAdrNumber(decisionsDir: string): number {
  let maxNum = 0;

  if (fs.existsSync(decisionsDir)) {
    const entries = fs.readdirSync(decisionsDir);
    for (const entry of entries) {
      const match = entry.match(ADR_ID_RE);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
  }

  return maxNum + 1;
}

/**
 * Format an ADR ID with zero-padded number: DR-001, DR-042, DR-123.
 */
export function formatAdrId(num: number): string {
  return `DR-${String(num).padStart(3, '0')}`;
}

// ─── ADR Template ───────────────────────────────────────────────────────────

/**
 * Generate a new ADR markdown file content from template.
 */
export function generateAdrContent(id: string, title: string, date: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    'status: proposed',
    `date: ${date}`,
    '---',
    '',
    `# ${id}: ${title}`,
    '',
    '## Context',
    '',
    '<!-- What is the issue that we\'re seeing that is motivating this decision? -->',
    '',
    '## Decision',
    '',
    '<!-- What is the change that we\'re proposing? -->',
    '',
    '## Consequences',
    '',
    '<!-- What becomes easier or harder because of this change? -->',
    '',
  ].join('\n');
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Create a new ADR file with auto-generated sequential ID.
 * Returns the summary and file path of the created ADR.
 */
export function createAdr(rootDir: string, title: string, vscodeOverrides?: { decisionsDir?: string }): AdrSummary {
  const decisionsDir = resolveDecisionsDir(rootDir, vscodeOverrides);
  fs.mkdirSync(decisionsDir, { recursive: true });

  const num = nextAdrNumber(decisionsDir);
  const id = formatAdrId(num);
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(title);
  const fileName = `${id}-${slug}.md`;
  const filePath = path.join(decisionsDir, fileName);

  const content = generateAdrContent(id, title, date);
  fs.writeFileSync(filePath, content, 'utf-8');

  return { id, title, status: 'proposed', date, filePath };
}

/** All valid ADR statuses, in lifecycle order. For UI pickers. */
export const ADR_STATUS_VALUES: readonly AdrStatus[] = [
  'proposed',
  'accepted',
  'deprecated',
  'superseded',
];

/**
 * Rewrite the `status:` line in an ADR's frontmatter in place.
 * Adds the line if frontmatter exists but has no status field.
 * Returns the updated status. Throws if the file has no frontmatter block.
 */
export function setAdrStatus(filePath: string, status: AdrStatus): AdrStatus {
  if (!ADR_STATUSES.has(status)) {
    throw new Error(`Invalid ADR status: ${status}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(FRONTMATTER_RE);
  if (!fmMatch) {
    throw new Error(`No frontmatter block in ${filePath}`);
  }

  const yaml = fmMatch[1];
  const statusLineRe = /^([ \t]*)status[ \t]*:[ \t]*.*$/m;
  let newYaml: string;
  if (statusLineRe.test(yaml)) {
    newYaml = yaml.replace(statusLineRe, `$1status: ${status}`);
  } else {
    newYaml = `${yaml}\nstatus: ${status}`;
  }

  const updated = content.replace(FRONTMATTER_RE, `---\n${newYaml}\n---`);
  fs.writeFileSync(filePath, updated, 'utf-8');
  return status;
}

// ─── Detailed Index ─────────────────────────────────────────────────────────

const INDEX_MARKER_START = '<!-- minspec:dr-index:start -->';
const INDEX_MARKER_END = '<!-- minspec:dr-index:end -->';
const DEFAULT_WORD_MIN = 40;
const DEFAULT_WORD_MAX = 80;

export interface DrIndexOptions {
  readonly wordMin?: number;
  readonly wordMax?: number;
}

export interface DrIndexResult {
  readonly filePath: string;
  readonly count: number;
}

/**
 * Extract a named H2 section's body from a markdown document.
 * Returns the lines between `## <header>` and the next `## ` header
 * (or end of file), with surrounding blank lines trimmed.
 */
function extractH2Section(body: string, header: string): string {
  const lines = body.split('\n');
  const headerRe = new RegExp(`^##\\s+${header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`, 'i');
  const anyH2Re = /^##\s+/;
  let inSection = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (inSection) {
      if (anyH2Re.test(line)) break;
      collected.push(line);
    } else if (headerRe.test(line)) {
      inSection = true;
    }
  }
  return collected.join('\n').trim();
}

/**
 * Extract the Context section body from an ADR markdown body
 * (the portion after frontmatter). Falls back to Decision section,
 * then to the first non-empty paragraph after the H1.
 */
export function extractContextBody(adrBody: string): string {
  const ctx = extractH2Section(adrBody, 'Context');
  if (ctx) return ctx;

  const dec = extractH2Section(adrBody, 'Decision');
  if (dec) return dec;

  return adrBody.replace(/^#\s+[^\n]+\n+/, '');
}

/**
 * Condense ADR body content to a word-budgeted summary. Strips HTML comments,
 * code fences, and markdown link syntax. Takes the first usable paragraph,
 * pulling additional paragraphs until reaching wordMin, capped at wordMax.
 * No AI dependency — pure offline text processing (Tier 0, invariant 1+2).
 */
export function summarizeContext(
  body: string,
  options: DrIndexOptions = {},
): string {
  const wordMin = options.wordMin ?? DEFAULT_WORD_MIN;
  const wordMax = options.wordMax ?? DEFAULT_WORD_MAX;

  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(p => p.length > 0 && !/^[#>\-*]/.test(p));

  if (paragraphs.length === 0) return '';

  const collected: string[] = [];
  let wordCount = 0;
  for (const para of paragraphs) {
    collected.push(para);
    wordCount += para.split(/\s+/).length;
    if (wordCount >= wordMin) break;
  }

  let combined = collected.join(' ');
  const words = combined.split(/\s+/);
  if (words.length > wordMax) {
    combined = words.slice(0, wordMax).join(' ').replace(/[,;:]$/, '') + '…';
  }
  return combined;
}

/**
 * Read an ADR file and produce a single index entry block.
 * Format:
 *   ## [DR-NNN — Title](DR-NNN-file.md)
 *
 *   *Status: accepted · Date: YYYY-MM-DD*
 *
 *   Summary paragraph (40–80 words).
 */
export function renderDrEntry(
  summary: AdrSummary,
  options: DrIndexOptions = {},
): string {
  let body = '';
  try {
    const content = fs.readFileSync(summary.filePath, 'utf-8');
    const fmMatch = content.match(FRONTMATTER_RE);
    body = fmMatch ? content.slice(fmMatch[0].length) : content;
  } catch {
    body = '';
  }

  const contextBody = extractContextBody(body);
  const summaryText = summarizeContext(contextBody, options) || '_No summary available._';
  const fileName = path.basename(summary.filePath);
  const metaParts: string[] = [];
  if (summary.status) metaParts.push(`Status: ${summary.status}`);
  if (summary.date) metaParts.push(`Date: ${summary.date}`);
  const meta = metaParts.length > 0 ? `*${metaParts.join(' · ')}*` : '';

  return [
    `## [${summary.id} — ${summary.title}](${fileName})`,
    '',
    meta,
    meta ? '' : null,
    summaryText,
  ].filter(line => line !== null).join('\n');
}

/**
 * Build the auto-generated portion of the DR INDEX (between markers).
 */
export function buildDrIndexContent(
  rootDir: string,
  vscodeOverrides?: { decisionsDir?: string },
  options: DrIndexOptions = {},
): { content: string; count: number } {
  const adrs = listAdrs(rootDir, vscodeOverrides);
  if (adrs.length === 0) {
    return { content: '# Decision Register\n\n_No decisions recorded yet._\n', count: 0 };
  }

  const header = '# Decision Register\n\n_Architecture decisions for this project. One entry per accepted/proposed DR._\n';
  const entries = adrs.map(a => renderDrEntry(a, options)).join('\n\n');
  return {
    content: `${header}\n${entries}\n`,
    count: adrs.length,
  };
}

/**
 * Merge new auto content into existing INDEX.md, preserving user-authored
 * content outside the auto-managed markers (invariant 6).
 *
 * Merge rules:
 *  - If markers exist: replace content between them.
 *  - If markers absent and file is empty/missing/legacy-table-only: full replace.
 *  - Otherwise: prepend markered block; preserve existing user content below.
 */
export function mergeDrIndex(existing: string | null, autoContent: string): string {
  const wrapped = `${INDEX_MARKER_START}\n${autoContent.trimEnd()}\n${INDEX_MARKER_END}\n`;

  if (existing === null || existing.trim() === '') {
    return wrapped;
  }

  const markerRe = new RegExp(
    `${escapeRegex(INDEX_MARKER_START)}[\\s\\S]*?${escapeRegex(INDEX_MARKER_END)}\\n?`,
  );
  if (markerRe.test(existing)) {
    return existing.replace(markerRe, wrapped);
  }

  // Legacy detection: an INDEX.md that is just `# Decision Register` + a single
  // markdown table is fully managed — safe to replace entirely.
  const isLegacyTable =
    /^#\s+Decision Register\s*\n+\|/.test(existing) &&
    existing.split('\n').filter(l => l.trim() !== '').length <= 30;

  if (isLegacyTable) return wrapped;

  return `${wrapped}\n${existing.trimStart()}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regenerate <decisionsDir>/INDEX.md with a detailed entry per DR.
 * Preserves user content outside auto-managed markers.
 */
export function regenerateDrIndex(
  rootDir: string,
  vscodeOverrides?: { decisionsDir?: string },
  options: DrIndexOptions = {},
): DrIndexResult {
  const decisionsDir = resolveDecisionsDir(rootDir, vscodeOverrides);
  fs.mkdirSync(decisionsDir, { recursive: true });

  const indexPath = path.join(decisionsDir, 'INDEX.md');
  const { content, count } = buildDrIndexContent(rootDir, vscodeOverrides, options);

  const existing = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : null;
  const merged = mergeDrIndex(existing, content);
  fs.writeFileSync(indexPath, merged, 'utf-8');

  return { filePath: indexPath, count };
}

// ─── Dedup / Similarity ───────────────────────────────────────────────────

/** A possible-duplicate ADR, scored by title similarity to a candidate. */
export interface AdrSimilarity {
  readonly adr: AdrSummary;
  /** Jaccard overlap of slug tokens, 0..1. */
  readonly score: number;
}

/**
 * Default similarity threshold above which two titles are "near-duplicates".
 * Tuned low (0.3): the gate only warns — a false positive costs one extra
 * click ("Create anyway"), while a false negative silently mints a duplicate
 * decision, which is the thing we are trying to prevent.
 */
export const ADR_SIMILARITY_THRESHOLD = 0.3;

/** Tokenize a title into a set of slug words, dropping trivial stopwords. */
function titleTokens(title: string): Set<string> {
  const STOP = new Set(['the', 'a', 'an', 'for', 'to', 'of', 'and', 'or', 'use', 'with', 'in', 'on']);
  return new Set(
    slugify(title)
      .split('-')
      .filter(t => t.length > 0 && !STOP.has(t)),
  );
}

/** Jaccard similarity (|A∩B| / |A∪B|) of two token sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Find existing ADRs whose title is a near-duplicate of `title`.
 * Used as a dedup gate before creating a new record so the same decision
 * is not minted twice under different numbers. Superseded/deprecated records
 * are excluded — they describe choices no longer in force, so re-deciding
 * the same topic is expected and not a duplicate.
 *
 * Returns matches at or above `threshold`, sorted by score descending.
 */
export function findSimilarAdrs(
  rootDir: string,
  title: string,
  vscodeOverrides?: { decisionsDir?: string },
  threshold: number = ADR_SIMILARITY_THRESHOLD,
): AdrSimilarity[] {
  const candidate = titleTokens(title);
  if (candidate.size === 0) return [];

  return listAdrs(rootDir, vscodeOverrides)
    .filter(adr => adr.status !== 'superseded' && adr.status !== 'deprecated')
    .map(adr => ({ adr, score: jaccard(candidate, titleTokens(adr.title)) }))
    .filter(m => m.score >= threshold)
    .sort((x, y) => y.score - x.score);
}

/**
 * List all ADR files in the decisions directory.
 * Returns summaries sorted by ID.
 */
export function listAdrs(rootDir: string, vscodeOverrides?: { decisionsDir?: string }): AdrSummary[] {
  const decisionsDir = resolveDecisionsDir(rootDir, vscodeOverrides);
  if (!fs.existsSync(decisionsDir)) return [];

  const entries = fs.readdirSync(decisionsDir)
    .filter(e => ADR_FILE_RE.test(e))
    .sort();

  const results: AdrSummary[] = [];

  for (const entry of entries) {
    const filePath = path.join(decisionsDir, entry);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const fmMatch = content.match(FRONTMATTER_RE);
      if (!fmMatch) {
        // File has no frontmatter — derive from filename
        const idMatch = entry.match(ADR_ID_RE);
        if (idMatch) {
          results.push({
            id: `DR-${idMatch[1]}`,
            title: entry.replace(ADR_FILE_RE, '').replace(/^-|-$/g, '').replace(/-/g, ' ') || entry,
            status: 'proposed',
            date: '',
            filePath,
          });
        }
        continue;
      }

      const fm = parseFrontmatterYaml(fmMatch[1]);
      results.push({
        id: (fm.id as string) ?? entry.match(ADR_ID_RE)?.[0] ?? entry,
        title: (fm.title as string) ?? '',
        status: ADR_STATUSES.has(fm.status) ? fm.status as AdrStatus : 'proposed',
        date: (fm.date as string) ?? '',
        filePath,
        epic: epicRefValue(fm.epic as string),
      });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}
