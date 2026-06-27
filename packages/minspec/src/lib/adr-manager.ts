import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
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

/**
 * Strip the `DR-NNN` id prefix and the `.md` extension from a filename, leaving
 * just the descriptive slug (`DR-031-gate-soundness.md` → `gate-soundness`).
 * Returns '' when the filename carries only the id.
 */
const ADR_FILE_DESCRIPTOR_RE = /^DR-\d+[-_]?(.*?)(?:\.md)?$/;

/** Humanize a hyphen/underscore slug into Title Case words (`gate-soundness` → `Gate Soundness`). */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

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

// ─── DR Sequence Validation (issue #41) ──────────────────────────────────────

/** Kind of local-sequence anomaly a DR file can exhibit. */
export type DrSequenceWarningKind = 'gap' | 'duplicate' | 'padding';

/**
 * A non-fatal warning about the local DR-NNN numbering sequence.
 * `validateDrSequence` only ever WARNS — it never throws or fails a build.
 */
export interface DrSequenceWarning {
  readonly kind: DrSequenceWarningKind;
  /** The DR number this warning concerns. */
  readonly number: number;
  /**
   * The DR file name(s) implicated. Empty for `gap` (no file exists for a
   * missing number); one entry for `padding`; two-plus for `duplicate`.
   */
  readonly files: readonly string[];
  /** Human-readable, single-line explanation with a suggested action. */
  readonly message: string;
}

/** The minimum digit width an id must use to count as correctly padded. */
const ADR_MIN_PAD_WIDTH = 3;

/**
 * Scan the decisions directory and report local DR-NNN sequence anomalies.
 *
 * Pure, offline, Tier-0 (DR-004): only reads file names — no frontmatter, no
 * network, no AI. Catches the DR-362 class of error (a global-register number
 * minted into a project-local register) after the fact, which `nextAdrNumber`
 * — correct by construction — cannot.
 *
 * Reuses `ADR_FILE_RE` so it sees exactly the files `listAdrs` treats as DRs.
 *
 * Warning kinds:
 *  - `gap`       — a number in `1..max` with no DR file (e.g. DR-010 → DR-362
 *                  leaves 11..361 as gaps).
 *  - `duplicate` — two or more files sharing one DR number.
 *  - `padding`   — an id not zero-padded to at least 3 digits (e.g. `DR-1`).
 *
 * A clean, contiguous, properly-padded run (and the empty/single/non-DR-only
 * cases) returns `[]`.
 *
 * Determinism: warnings are sorted by `number`, then by kind in a fixed order
 * (gap, duplicate, padding) so identical inputs yield identical output.
 *
 * @param decisionsDir Absolute path to the resolved decisions directory.
 */
export function validateDrSequence(decisionsDir: string): DrSequenceWarning[] {
  if (!fs.existsSync(decisionsDir)) return [];

  // Map DR number → list of file names that claim it (preserves duplicates).
  const byNumber = new Map<number, string[]>();
  const warnings: DrSequenceWarning[] = [];

  for (const entry of fs.readdirSync(decisionsDir).sort()) {
    const match = entry.match(ADR_FILE_RE);
    if (!match) continue; // non-DR file (INDEX.md, README.md, notes…) — ignore.

    const digits = match[1];
    const num = parseInt(digits, 10);
    if (!Number.isFinite(num)) continue;

    const existing = byNumber.get(num);
    if (existing) existing.push(entry);
    else byNumber.set(num, [entry]);

    // Padding: a number whose printed-as-written digit run is shorter than the
    // minimum width. `DR-1` → width 1; `DR-001`/`DR-100`/`DR-1234` are fine.
    if (digits.length < ADR_MIN_PAD_WIDTH) {
      warnings.push({
        kind: 'padding',
        number: num,
        files: [entry],
        message:
          `${entry}: id "DR-${digits}" is not zero-padded to ${ADR_MIN_PAD_WIDTH} digits — ` +
          `rename to "${formatAdrId(num)}".`,
      });
    }
  }

  if (byNumber.size === 0) return [];

  // Duplicates: any number claimed by two or more files.
  for (const [num, files] of byNumber) {
    if (files.length > 1) {
      warnings.push({
        kind: 'duplicate',
        number: num,
        files: [...files],
        message:
          `DR-${String(num).padStart(ADR_MIN_PAD_WIDTH, '0')} is used by ${files.length} files ` +
          `(${files.join(', ')}) — give each a distinct number.`,
      });
    }
  }

  // Gaps: every number in 1..max with no DR file. `max` is the highest number
  // present (including any out-of-sequence jump), so a DR-010 → DR-362 leak
  // surfaces 11..361 as gaps, flagging the leaked number itself.
  const max = Math.max(...byNumber.keys());
  for (let n = 1; n < max; n++) {
    if (!byNumber.has(n)) {
      warnings.push({
        kind: 'gap',
        number: n,
        files: [],
        message:
          `${formatAdrId(n)} is missing — the sequence jumps over it. ` +
          `Renumber the out-of-sequence DR to close the gap.`,
      });
    }
  }

  // Deterministic order: by number, then gap < duplicate < padding.
  const kindOrder: Record<DrSequenceWarningKind, number> = {
    gap: 0,
    duplicate: 1,
    padding: 2,
  };
  warnings.sort((a, b) =>
    a.number !== b.number ? a.number - b.number : kindOrder[a.kind] - kindOrder[b.kind],
  );

  return warnings;
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
    '## Costly to Refactor',
    '',
    '<!-- After the Decision is stable: the expensive-to-reverse commitments (contracts, cross-package boundaries, data-model/API changes), ranked, each with a one-line "why costly" + what to check. "Low — <reason>" is valid if nothing here is hard to undo. -->',
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

/** True if the ADR file already has a leading YAML frontmatter block. */
export function adrHasFrontmatter(filePath: string): boolean {
  try {
    return FRONTMATTER_RE.test(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return false;
  }
}

/**
 * Derive a clean title for a frontmatter-less ADR. Prefers a Markdown H1
 * (`# DR-001 — Two backends` → `Two backends`, stripping any `DR-NNN —/-`
 * id prefix); falls back to the humanized filename descriptor, then the id.
 */
function deriveAdrTitle(content: string, fileName: string, id: string): string {
  const h1 = content.match(/^#\s+(.+?)\s*$/m);
  if (h1) {
    const stripped = h1[1].replace(/^DR-\d+\s*[—–-]\s*/, '').trim();
    if (stripped) return stripped;
  }
  const descriptor = fileName.match(ADR_FILE_DESCRIPTOR_RE)?.[1] ?? '';
  return humanizeSlug(descriptor) || id;
}

/**
 * Derive a date for a frontmatter-less ADR. Prefers an ISO date annotated on a
 * prose `**Status:** Accepted (2026-06-09)` line; falls back to the first ISO
 * date anywhere in the doc; finally today (matching `createAdr`).
 */
function deriveAdrDate(content: string): string {
  const onStatus = content.match(/\*\*\s*status\s*\*\*\s*:?[^\n(]*\((\d{4}-\d{2}-\d{2})\)/i);
  if (onStatus) return onStatus[1];
  const anyIso = content.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (anyIso) return anyIso[1];
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build a synthesized YAML frontmatter body (no `---` fences) for a
 * frontmatter-less pre-MinSpec ADR, inferring id/title/date from the filename
 * and existing Markdown content. `status` is the value being set.
 */
function synthesizeAdrFrontmatter(filePath: string, content: string, status: AdrStatus): string {
  const fileName = path.basename(filePath);
  const id = fileName.match(ADR_ID_RE)?.[0] ?? fileName.replace(/\.md$/, '');
  const title = deriveAdrTitle(content, fileName, id);
  const date = deriveAdrDate(content);
  return [`id: ${id}`, `title: ${title}`, `status: ${status}`, `date: ${date}`].join('\n');
}

/**
 * Rewrite the `status:` line in an ADR's frontmatter in place.
 * Adds the line if frontmatter exists but has no status field.
 *
 * Pre-MinSpec DRs have no frontmatter at all, yet `listAdrs` deliberately
 * surfaces them into the picker (with a synthetic `proposed` status). To keep
 * the read and write paths symmetric (#201), synthesize and prepend a
 * frontmatter block from the filename + body rather than throwing.
 * Returns the updated status.
 */
export function setAdrStatus(filePath: string, status: AdrStatus): AdrStatus {
  if (!ADR_STATUSES.has(status)) {
    throw new Error(`Invalid ADR status: ${status}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(FRONTMATTER_RE);
  if (!fmMatch) {
    // No frontmatter — synthesize one and prepend it, preserving the body
    // verbatim (only collapsing leading blank lines before the heading).
    const block = `---\n${synthesizeAdrFrontmatter(filePath, content, status)}\n---`;
    fs.writeFileSync(filePath, `${block}\n\n${content.replace(/^\s*\n+/, '')}`, 'utf-8');
    return status;
  }

  const yaml = fmMatch[1];
  const statusLineRe = /^([ \t]*)status[ \t]*:[ \t]*.*$/m;
  let newYaml: string;
  if (statusLineRe.test(yaml)) {
    // `$1` keeps the captured indent; the value is escaped so a literal `$`
    // in it is never read as a replacement pattern (#152).
    newYaml = yaml.replace(statusLineRe, `$1status: ${escapeReplacement(status)}`);
  } else {
    newYaml = `${yaml}\nstatus: ${status}`;
  }

  // Replacer FUNCTION — its return value is inserted literally, so a `$` in any
  // frontmatter field can never be interpreted as a replacement pattern (#152).
  const block = `---\n${newYaml}\n---`;
  const updated = content.replace(FRONTMATTER_RE, () => block);
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
 * The fallback rendered when a DR has no extractable summary text. Treated as a
 * non-curated value so a later real summary (auto or hand-written) replaces it.
 */
const NO_SUMMARY_PLACEHOLDER = '_No summary available._';

/**
 * Short, stable fingerprint of an auto-derived summary. Embedded in a hidden
 * per-entry marker so a later regen can tell a HUMAN-EDITED summary apart from
 * the machine-derived one it last wrote (issue #191): if the visible summary
 * still hashes to the recorded value, it is still auto and safe to refresh;
 * if it differs, a human curated it and it must be preserved.
 */
function summaryFingerprint(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 12);
}

/**
 * Per-entry summary markers. The OPEN marker carries the fingerprint of the
 * auto-derived summary that was last written between the markers, so curation
 * is detectable across regenerations without a second source of truth.
 */
function summaryOpenMarker(id: string, autoHash: string): string {
  return `<!-- dr-summary:${id} auto=${autoHash} -->`;
}
function summaryCloseMarker(id: string): string {
  return `<!-- /dr-summary:${id} -->`;
}

interface ExistingSummary {
  /** The visible summary text currently between the per-entry markers. */
  readonly text: string;
  /** Fingerprint of the auto summary recorded when this block was last written. */
  readonly autoHash: string;
}

/**
 * Pull the existing per-entry summary block for `id` out of a prior INDEX.md.
 * Returns the visible text plus the recorded auto-fingerprint, or null when the
 * entry (or its markers) is absent — e.g. a legacy INDEX from before #191.
 */
export function extractExistingSummary(existingIndex: string, id: string): ExistingSummary | null {
  const re = new RegExp(
    `${escapeRegex(`<!-- dr-summary:${id} auto=`)}([0-9a-f]+)${escapeRegex(' -->')}\\n([\\s\\S]*?)\\n${escapeRegex(summaryCloseMarker(id))}`,
  );
  const m = existingIndex.match(re);
  if (!m) return null;
  return { autoHash: m[1], text: m[2].trim() };
}

/**
 * Read an ADR file and produce a single index entry block.
 * Format:
 *   ## [DR-NNN — Title](DR-NNN-file.md)
 *
 *   *Status: accepted · Date: YYYY-MM-DD*
 *
 *   <!-- dr-summary:DR-NNN auto=<hash> -->
 *   Summary paragraph (40–80 words, auto OR human-curated).
 *   <!-- /dr-summary:DR-NNN -->
 *
 * Idempotence + curation (issue #191): the auto summary is derived from the DR
 * body, but if the prior INDEX held a HAND-EDITED summary for this DR (visible
 * text whose hash differs from the recorded auto fingerprint), that curated
 * text is preserved instead of being clobbered. The open marker re-records the
 * SAME fingerprint in that case, so the entry stays flagged as curated on every
 * future regen — regeneration never destroys curation.
 */
export function renderDrEntry(
  summary: AdrSummary,
  options: DrIndexOptions = {},
  existingIndex?: string,
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
  const autoText = summarizeContext(contextBody, options) || NO_SUMMARY_PLACEHOLDER;
  const autoHash = summaryFingerprint(autoText);

  // Decide whether to keep a curated summary from the prior INDEX. A prior
  // entry is "curated" when its visible text no longer hashes to the auto
  // fingerprint it was written with (and isn't the empty/placeholder fallback).
  let summaryText = autoText;
  let recordedHash = autoHash;
  if (existingIndex) {
    const prior = extractExistingSummary(existingIndex, summary.id);
    if (
      prior &&
      prior.text !== '' &&
      prior.text !== NO_SUMMARY_PLACEHOLDER &&
      summaryFingerprint(prior.text) !== prior.autoHash
    ) {
      // Human-edited — preserve the curated text and keep the original auto
      // fingerprint so this entry remains detectably curated on later regens.
      summaryText = prior.text;
      recordedHash = prior.autoHash;
    }
  }

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
    summaryOpenMarker(summary.id, recordedHash),
    summaryText,
    summaryCloseMarker(summary.id),
  ].filter(line => line !== null).join('\n');
}

/**
 * Build the auto-generated portion of the DR INDEX (between markers).
 *
 * `existingIndex` (the prior INDEX.md content) is threaded through so each
 * entry can preserve a human-curated summary rather than clobber it (#191).
 */
export function buildDrIndexContent(
  rootDir: string,
  vscodeOverrides?: { decisionsDir?: string },
  options: DrIndexOptions = {},
  existingIndex?: string,
): { content: string; count: number } {
  const adrs = listAdrs(rootDir, vscodeOverrides);
  if (adrs.length === 0) {
    return { content: '# Decision Register\n\n_No decisions recorded yet._\n', count: 0 };
  }

  const header = '# Decision Register\n\n_Architecture decisions for this project. One entry per accepted/proposed DR._\n';
  const entries = adrs.map(a => renderDrEntry(a, options, existingIndex)).join('\n\n');
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
    // Replacer FUNCTION so a `$` in any DR title inside `wrapped` is inserted
    // literally, never read as a replacement pattern (#152).
    return existing.replace(markerRe, () => wrapped);
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
 * Escape a string for safe use as the *replacement* argument of
 * `String.prototype.replace`. Doubles every `$` so a literal `$1`/`$&`/`` $` ``/
 * `$'`/`$$` in untrusted text (a field value or DR/epic title) is inserted
 * verbatim instead of being interpreted as a replacement pattern (#152).
 */
function escapeReplacement(s: string): string {
  return s.replace(/\$/g, '$$$$');
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
  const existing = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : null;

  // Thread the prior INDEX through so per-entry curated summaries survive (#191).
  const { content, count } = buildDrIndexContent(
    rootDir,
    vscodeOverrides,
    options,
    existing ?? undefined,
  );

  const merged = mergeDrIndex(existing, content);
  fs.writeFileSync(indexPath, merged, 'utf-8');

  return { filePath: indexPath, count };
}

// ─── INDEX Status-Drift Validation (issue #220) ───────────────────────────────

/** Kind of INDEX↔frontmatter status drift a DR can exhibit. */
export type DrIndexStatusDriftKind = 'mismatch' | 'missing-entry' | 'orphan-entry';

/**
 * One INDEX.md / DR-frontmatter status inconsistency.
 *
 *  - `mismatch`      — the INDEX `*Status: X*` line disagrees with the DR file's
 *                      frontmatter `status:` (the eb27e05 drift in #220).
 *  - `missing-entry` — a DR file exists but has no entry in the INDEX block.
 *  - `orphan-entry`  — the INDEX has an entry for a DR with no source file.
 */
export interface DrIndexStatusDrift {
  readonly kind: DrIndexStatusDriftKind;
  readonly id: string;
  /** The DR frontmatter status (absent for `orphan-entry`). */
  readonly fileStatus?: string;
  /** The status the INDEX claims (absent for `missing-entry`). */
  readonly indexStatus?: string;
  /** Human-readable, single-line explanation with a suggested action. */
  readonly message: string;
}

/** The status the INDEX entry for `id` claims, or null when there is no entry. */
function indexStatusFor(indexContent: string, id: string): string | null {
  // Match the entry heading `## [DR-NNN — …]` then the first `*Status: X …*`
  // line beneath it, before the next entry heading. Mirrors renderDrEntry's
  // emitted format (`*Status: accepted · Date: …*`).
  const headingRe = new RegExp(`^##\\s+\\[${escapeRegex(id)}\\b[^\\n]*$`, 'm');
  const headingMatch = headingRe.exec(indexContent);
  if (!headingMatch) return null;
  const after = indexContent.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = after.search(/^##\s+\[DR-\d+/m);
  const block = nextHeading === -1 ? after : after.slice(0, nextHeading);
  const statusMatch = block.match(/\*\s*Status:\s*([A-Za-z]+)/);
  return statusMatch ? statusMatch[1].toLowerCase() : null;
}

/**
 * Validate that the generated DR INDEX block agrees with each DR file's
 * frontmatter `status:` — the un-committable gate for the drift in #220, where
 * a direct/agent/sed edit to a DR's status bypasses every regeneration path and
 * leaves the derived INDEX stale.
 *
 * Pure, offline, Tier-0 (DR-004): reads the DR files + INDEX.md only — no
 * extension, no network, no AI. Symmetric (validator-asymmetry class): it flags
 * a value MISMATCH, a DR with no INDEX entry, AND an INDEX entry with no DR — so
 * drift cannot hide in either direction.
 *
 * A repo with no DR files, or no INDEX.md, returns `[]` (nothing to drift).
 * Pre-MinSpec DRs without frontmatter use the synthetic `proposed` status
 * `listAdrs` already assigns them, so they validate consistently.
 *
 * Determinism: drifts are sorted by id then by kind in a fixed order.
 *
 * @param decisionsDir Absolute path to the resolved decisions directory.
 */
export function validateDrIndexStatus(decisionsDir: string): DrIndexStatusDrift[] {
  if (!fs.existsSync(decisionsDir)) return [];
  const indexPath = path.join(decisionsDir, 'INDEX.md');
  if (!fs.existsSync(indexPath)) return [];

  const indexContent = fs.readFileSync(indexPath, 'utf-8');
  const drifts: DrIndexStatusDrift[] = [];
  const seen = new Set<string>();

  // rootDir for listAdrs is the parent of decisionsDir only when decisionsDir is
  // the configured location; to stay decoupled from config we read the files
  // directly here, matching listAdrs' frontmatter handling.
  for (const entry of fs.readdirSync(decisionsDir).sort()) {
    const match = entry.match(ADR_FILE_RE);
    if (!match) continue;
    const id = `DR-${match[1]}`;
    seen.add(id);

    let fileStatus = 'proposed';
    try {
      const content = fs.readFileSync(path.join(decisionsDir, entry), 'utf-8');
      const fmMatch = content.match(FRONTMATTER_RE);
      if (fmMatch) {
        const fm = parseFrontmatterYaml(fmMatch[1]);
        if (fm.status && ADR_STATUSES.has(fm.status)) fileStatus = fm.status;
      }
    } catch {
      continue; // unreadable — skip, mirrors listAdrs
    }

    const idxStatus = indexStatusFor(indexContent, id);
    if (idxStatus === null) {
      drifts.push({
        kind: 'missing-entry',
        id,
        fileStatus,
        message:
          `${id} (status: ${fileStatus}) has no entry in INDEX.md — ` +
          `regenerate the DR INDEX (MinSpec: Regenerate DR INDEX).`,
      });
    } else if (idxStatus !== fileStatus) {
      drifts.push({
        kind: 'mismatch',
        id,
        fileStatus,
        indexStatus: idxStatus,
        message:
          `${id}: INDEX.md says "Status: ${idxStatus}" but ${entry} frontmatter says ` +
          `"status: ${fileStatus}" — regenerate the DR INDEX so it matches the source.`,
      });
    }
  }

  // Orphans: an INDEX entry whose DR file is gone.
  const entryRe = /^##\s+\[(DR-\d+)\b/gm;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(indexContent)) !== null) {
    const id = m[1];
    if (!seen.has(id)) {
      drifts.push({
        kind: 'orphan-entry',
        id,
        message:
          `${id} has an INDEX.md entry but no DR file in ${path.basename(decisionsDir)}/ — ` +
          `regenerate the DR INDEX to drop the stale entry.`,
      });
    }
  }

  const kindOrder: Record<DrIndexStatusDriftKind, number> = {
    mismatch: 0,
    'missing-entry': 1,
    'orphan-entry': 2,
  };
  drifts.sort((a, b) =>
    a.id !== b.id ? a.id.localeCompare(b.id) : kindOrder[a.kind] - kindOrder[b.kind],
  );

  return drifts;
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
        // File has no frontmatter — derive a clean, humanized title from the
        // filename: strip the `DR-NNN-` prefix and `.md`, then Title Case.
        // `DR-031-gate-soundness.md` → `Gate Soundness`; `DR-031.md` → `DR-031`.
        const idMatch = entry.match(ADR_ID_RE);
        if (idMatch) {
          const id = `DR-${idMatch[1]}`;
          const descriptor = entry.match(ADR_FILE_DESCRIPTOR_RE)?.[1] ?? '';
          results.push({
            id,
            title: humanizeSlug(descriptor) || id,
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
