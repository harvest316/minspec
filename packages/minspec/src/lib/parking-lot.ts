import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

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
}

/**
 * Check if the `gh` CLI is available and authenticated.
 */
export async function isGhAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status'], {
      timeout: 5000,
      env: { ...process.env },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the GitHub repo (owner/name) from the git remote in rootDir.
 * Returns null if no remote found or not a GitHub repo.
 */
export async function getRepoFromRemote(rootDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: rootDir,
      timeout: 5000,
    });
    const url = stdout.trim();
    // Handle SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (sshMatch) return sshMatch[1];
    // Handle HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+\/[^/.]+)/);
    if (httpsMatch) return httpsMatch[1];
    return null;
  } catch {
    return null;
  }
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
      const url = await createGitHubIssue(entry, repo);
      if (url) {
        return { method: 'github', url };
      }
    }
  }

  // Fallback to local file
  const filePath = appendToParkingLotFile(rootDir, entry);
  return { method: 'file', filePath };
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
