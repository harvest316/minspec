import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isGhAvailable, getRepoFromRemote } from './github';
export { isGhAvailable, getRepoFromRemote };

const execFileAsync = promisify(execFile);

/** A topic to be parked — either as a GitHub issue or a local file entry */
export interface ParkingLotEntry {
  readonly title: string;
  readonly body: string;
  readonly labels: string[];
  readonly sessionScope: string;
  readonly createdAt: string;
}

/** Result of parking a topic */
export interface ParkResult {
  readonly method: 'github' | 'file';
  readonly url?: string;       // GitHub issue URL when method=github
  readonly filePath?: string;  // Local file path when method=file
  readonly deduped?: boolean;  // true when an existing entry was reused instead of creating a duplicate
}

/**
 * Normalize a topic title for dedup matching: lowercase, strip punctuation,
 * collapse runs of whitespace, trim. Exact-after-normalize comparison only —
 * deliberately NOT fuzzy, to avoid false-positive collapses of distinct topics
 * (issue #24: "foo" and "foo bar" must stay distinct).
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ') // strip punctuation/symbols (keep letters, numbers, whitespace)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Minimal shape of a `gh issue list --json number,title,url` row. */
interface GhIssueListRow {
  number: number;
  title: string;
  url: string;
}

/**
 * Dedup gate (GitHub path). Query OPEN issues whose title matches the entry's
 * after normalization. Returns the existing issue URL on an exact normalized
 * match, else null.
 *
 * On ANY lookup failure (gh missing, network/CLI error, unparseable output)
 * this returns null so the caller falls through to create — parking must never
 * be blocked by a transient lookup failure (issue #24 invariant).
 */
export async function findExistingIssue(entry: ParkingLotEntry, repo: string): Promise<string | null> {
  const target = normalizeTitle(entry.title);
  if (!target) return null;

  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'issue', 'list',
        '--repo', repo,
        '--state', 'open',
        '--search', `${entry.title} in:title`,
        '--json', 'number,title,url',
        '--limit', '20',
      ],
      { timeout: 15000, env: { ...process.env } },
    );

    const trimmed = stdout.trim();
    if (!trimmed) return null;

    const rows = JSON.parse(trimmed) as GhIssueListRow[];
    if (!Array.isArray(rows)) return null;

    const match = rows.find(
      (r) => r && typeof r.title === 'string' && normalizeTitle(r.title) === target,
    );
    return match?.url ?? null;
  } catch {
    // gh search returns a relevance-ranked set, not exact matches — so we still
    // post-filter by normalized title above. Any error → fall through to create.
    return null;
  }
}

/**
 * Dedup gate (file path). Scan an existing parking-lot.md for a `## <title>`
 * heading whose normalized text matches the entry. Returns true if a duplicate
 * heading already exists.
 */
export function fileEntryExists(rootDir: string, entry: ParkingLotEntry): boolean {
  const filePath = path.join(rootDir, '.minspec', 'parking-lot.md');
  if (!fs.existsSync(filePath)) return false;

  const target = normalizeTitle(entry.title);
  if (!target) return false;

  const content = fs.readFileSync(filePath, 'utf-8');
  const headings = content.match(/^##\s+(.+?)\s*$/gm) || [];
  return headings.some((h) => {
    const headingText = h.replace(/^##\s+/, '');
    return normalizeTitle(headingText) === target;
  });
}

/**
 * Create a GitHub issue via the `gh` CLI.
 * Returns the issue URL on success, null on failure.
 */
export async function createGitHubIssue(entry: ParkingLotEntry, repo: string): Promise<string | null> {
  const issueBody = [
    '## Context',
    '',
    entry.body,
    '',
    '## Session parked from',
    '',
    entry.sessionScope,
    '',
    '---',
    `*Parked automatically by MinSpec on ${entry.createdAt}*`,
  ].join('\n');

  try {
    const args: string[] = [
      'issue', 'create',
      '--repo', repo,
      '--title', entry.title,
      '--body', issueBody,
    ];

    if (entry.labels.length > 0) {
      args.push('--label', entry.labels.join(','));
    }

    const { stdout } = await execFileAsync('gh', args, {
      timeout: 15000,
      env: { ...process.env },
    });
    // gh issue create prints the URL of the new issue
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Append an entry to .minspec/parking-lot.md as a fallback
 * when `gh` is unavailable.
 */
export function appendToParkingLotFile(rootDir: string, entry: ParkingLotEntry): string {
  const minspecDir = path.join(rootDir, '.minspec');
  if (!fs.existsSync(minspecDir)) {
    fs.mkdirSync(minspecDir, { recursive: true });
  }

  const filePath = path.join(minspecDir, 'parking-lot.md');
  const existingContent = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : '# Parking Lot\n\nTopics parked during MinSpec sessions for later triage.\n';

  const entryBlock = [
    '',
    `## ${entry.title}`,
    '',
    `**Date:** ${entry.createdAt}`,
    `**Session scope:** ${entry.sessionScope}`,
    `**Labels:** ${entry.labels.join(', ') || 'none'}`,
    '',
    entry.body,
    '',
    '---',
    '',
  ].join('\n');

  fs.writeFileSync(filePath, existingContent + entryBlock, 'utf-8');
  return filePath;
}

/**
 * Park a topic — tries GitHub issue first, falls back to local file.
 */
export async function parkTopic(rootDir: string, entry: ParkingLotEntry): Promise<ParkResult> {
  const ghAvail = await isGhAvailable();

  if (ghAvail) {
    const repo = await getRepoFromRemote(rootDir);
    if (repo) {
      // Dedup gate: reuse an existing open issue with a matching normalized
      // title instead of creating a near-identical duplicate (issue #24).
      const existing = await findExistingIssue(entry, repo);
      if (existing) {
        return { method: 'github', url: existing, deduped: true };
      }

      const url = await createGitHubIssue(entry, repo);
      if (url) {
        return { method: 'github', url };
      }
    }
  }

  // Fallback to local file. Dedup gate: skip re-appending a topic whose heading
  // already exists in parking-lot.md (issue #24).
  const filePath = path.join(rootDir, '.minspec', 'parking-lot.md');
  if (fileEntryExists(rootDir, entry)) {
    return { method: 'file', filePath, deduped: true };
  }
  return { method: 'file', filePath: appendToParkingLotFile(rootDir, entry) };
}

/**
 * Create a ParkingLotEntry with defaults.
 */
export function createParkingLotEntry(
  title: string,
  body: string,
  sessionScope: string,
  labels?: string[],
): ParkingLotEntry {
  return {
    title,
    body,
    labels: labels ?? ['idea', 'inbox'],
    sessionScope,
    createdAt: new Date().toISOString(),
  };
}
