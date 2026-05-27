import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, applyVSCodeOverrides } from './config';
import { slugify } from './spec-manager';
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
}

/** Summary for listing/display */
export interface AdrSummary {
  readonly id: string;
  readonly title: string;
  readonly status: AdrStatus;
  readonly date: string;
  readonly filePath: string;
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
  return path.join(rootDir, config.decisionsDir);
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
      });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}
