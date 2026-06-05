import type { SimpleGit } from 'simple-git';
import { simpleGit } from 'simple-git';
import * as path from 'path';

import type { Tier } from './config';
import type { ClassificationSignal } from './classifier';
export type { ClassificationSignal };

/** Options for the git analyzer */
export interface GitAnalyzerOptions {
  /** Whether to analyze staged changes (--cached) or working tree */
  staged?: boolean;
  /** Inject a SimpleGit instance for testing */
  git?: SimpleGit;
}

/** Parsed diff file entry from simple-git */
interface DiffFile {
  file: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

/**
 * Determine tier contribution based on file count.
 * 1-2 = T1, 3-5 = T2, 6-15 = T3, 16+ = T4
 */
function fileCountTier(count: number): Tier {
  if (count <= 2) return 'T1';
  if (count <= 5) return 'T2';
  if (count <= 15) return 'T3';
  return 'T4';
}

/**
 * Determine tier contribution based on total line count.
 * 1-20 = T1, 21-100 = T2, 101-500 = T3, 501+ = T4
 */
function lineCountTier(lines: number): Tier {
  if (lines <= 20) return 'T1';
  if (lines <= 100) return 'T2';
  if (lines <= 500) return 'T3';
  return 'T4';
}

/**
 * Determine tier contribution based on file type diversity.
 * All same extension = T1, 2 types = T2, 3+ = T3
 */
function fileTypeTier(extensions: Set<string>): Tier {
  const count = extensions.size;
  if (count <= 1) return 'T1';
  if (count === 2) return 'T2';
  return 'T3';
}

/**
 * Determine tier contribution based on cross-directory changes.
 * Same dir = T1, 2 dirs = T2, 3+ = T3
 */
function crossDirectoryTier(directories: Set<string>): Tier {
  const count = directories.size;
  if (count <= 1) return 'T1';
  if (count === 2) return 'T2';
  return 'T3';
}

/**
 * Determine tier contribution for new files.
 * 0 new = T1, 1-2 = T2, 3+ = T3
 */
function newFilesTier(newFileCount: number): Tier {
  if (newFileCount === 0) return 'T1';
  if (newFileCount <= 2) return 'T2';
  return 'T3';
}

/**
 * Check if a repo exists and is a git repository.
 * Returns true if the path is inside a git working tree.
 */
async function isGitRepo(git: SimpleGit): Promise<boolean> {
  try {
    const result = await git.revparse(['--is-inside-work-tree']);
    return result.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Extract file extension from a file path.
 * Returns the extension without the dot, or empty string for no extension.
 */
function getExtension(filePath: string): string {
  const ext = path.extname(filePath);
  return ext ? ext.slice(1).toLowerCase() : '';
}

/**
 * Extract the directory portion of a file path.
 * Root-level files get '.' as their directory.
 */
function getDirectory(filePath: string): string {
  const dir = path.dirname(filePath);
  return dir || '.';
}

/**
 * Analyze the current git diff and produce classification signals.
 *
 * Works on staged changes (--cached) by default, falling back to working tree changes.
 * Returns empty signals array if not in a git repo or no changes detected.
 *
 * @param repoPath - Absolute path to the repository root
 * @param options - Configuration options (staged vs working tree, injected git instance)
 * @returns Array of classification signals for the tier classification engine
 */
export async function analyzeGitDiff(
  repoPath: string,
  options: GitAnalyzerOptions = {},
): Promise<ClassificationSignal[]> {
  const { staged = true, git: injectedGit } = options;

  const git = injectedGit ?? simpleGit(repoPath);

  // Check this is actually a git repo
  if (!(await isGitRepo(git))) {
    return [];
  }

  // Get diff summary — staged or working tree
  const diffArgs = staged ? ['--cached'] : [];
  let diffSummary;
  try {
    diffSummary = await git.diffSummary(diffArgs);
  } catch {
    return [];
  }

  const files = diffSummary.files as DiffFile[];

  // No changes = no signals
  if (files.length === 0) {
    return [];
  }

  // Compute raw metrics
  const fileCount = files.length;
  const totalLines = files.reduce((sum, f) => sum + f.insertions + f.deletions, 0);

  const extensions = new Set<string>();
  const directories = new Set<string>();
  let newFileCount = 0;
  let hasPackageJsonChange = false;
  let hasNewDependencies = false;

  for (const file of files) {
    const ext = getExtension(file.file);
    if (ext) extensions.add(ext);
    directories.add(getDirectory(file.file));

    // Detect package.json changes
    if (path.basename(file.file) === 'package.json') {
      hasPackageJsonChange = true;
    }
  }

  // Detect new files via git status (diff summary doesn't distinguish new vs modified)
  try {
    const statusResult = await git.status();
    const stagedNew = statusResult.created ?? [];
    const untrackedFiles = staged ? [] : (statusResult.not_added ?? []);
    newFileCount = staged ? stagedNew.length : stagedNew.length + untrackedFiles.length;
  } catch {
    // If status fails, fall back to no new files
    newFileCount = 0;
  }

  // Check if package.json changes include new dependencies.
  // Pathspec must cover BOTH a repo-root `package.json` and nested ones:
  // git's `**/package.json` glob matches nested files only, never the root file,
  // so the bare `package.json` pathspec is required to catch root dependency edits.
  if (hasPackageJsonChange) {
    try {
      const diffOutput = await git.diff([
        ...(staged ? ['--cached'] : []),
        '--',
        'package.json',
        '**/package.json',
      ]);
      // Look for lines adding dependencies/devDependencies entries
      const addedLines = diffOutput
        .split('\n')
        .filter(line => line.startsWith('+') && !line.startsWith('+++'));
      hasNewDependencies = addedLines.some(line =>
        /^\+\s*"[^"]+"\s*:\s*"[^"]*"/.test(line) &&
        (diffOutput.includes('"dependencies"') || diffOutput.includes('"devDependencies"')),
      );
    } catch {
      // If diff parsing fails, just use the boolean change signal
      hasNewDependencies = false;
    }
  }

  // Build signals array
  const signals: ClassificationSignal[] = [];

  // File count signal
  signals.push({
    name: 'files_changed',
    value: fileCount,
    weight: 0.3,
    tierContribution: fileCountTier(fileCount),
  });

  // Line count signal
  signals.push({
    name: 'lines_changed',
    value: totalLines,
    weight: 0.25,
    tierContribution: lineCountTier(totalLines),
  });

  // File types diversity signal
  signals.push({
    name: 'file_types',
    value: extensions.size,
    weight: 0.15,
    tierContribution: fileTypeTier(extensions),
  });

  // Cross-directory signal
  signals.push({
    name: 'cross_directory',
    value: directories.size,
    weight: 0.15,
    tierContribution: crossDirectoryTier(directories),
  });

  // New files signal
  signals.push({
    name: 'new_files',
    value: newFileCount,
    weight: 0.1,
    tierContribution: newFilesTier(newFileCount),
  });

  // Dependency changes signal (only emitted when package.json is changed)
  if (hasPackageJsonChange) {
    signals.push({
      name: 'dependency_change',
      value: hasNewDependencies,
      weight: 0.2,
      tierContribution: hasNewDependencies ? 'T3' : 'T2',
    });
  }

  return signals;
}
