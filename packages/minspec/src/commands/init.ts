import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { scaffold, generateHarnessFiles, refreshHarnessFiles } from '../lib/scaffold';
import { TEMPLATE_NAMES, TEMPLATE_OUTPUT_PATHS } from '../lib/template-registry';
import { resolveTargetFolder } from '../lib/resolve-folder';
import { evaluateConstitution } from '../lib/constitution-nudge';

/**
 * SPEC-025 FR-6: soft, NON-MODAL advisory when the constitution has no
 * human-authored rules yet. Advisory only — never modal, never blocks, and a
 * failure here must not affect the init result (best-effort).
 */
function surfaceConstitutionNudge(folder: string): void {
  try {
    const nudge = evaluateConstitution(folder);
    if (nudge.empty) {
      vscode.window.showInformationMessage(nudge.message);
    }
  } catch {
    // best-effort — the nudge is advisory; never let it break init.
  }
}

// ---------------------------------------------------------------------------
// Post-init "what to commit" hint + offer (#222)
// ---------------------------------------------------------------------------

/** Dedicated commit message for the scaffolded SDD structure. */
export const SCAFFOLD_COMMIT_MESSAGE = 'chore: scaffold MinSpec SDD structure';

/** Toast action label that triggers the dedicated scaffold commit. */
const COMMIT_ACTION = 'Commit them';

/**
 * Top-level paths MinSpec init is responsible for scaffolding. These are
 * pathspecs (relative to the project root) that `git add` can stage directly.
 * Directories are staged whole; git honors .gitignore for directory adds, so
 * the ephemeral `.minspec/session.json` / `calibration.json` are never staged.
 *
 * The harness output paths come from the template registry (CLAUDE.md,
 * AGENTS.md, .cursorrules, DESIGN.md, .minspec/constitution.md), plus the
 * `.minspec/` dir itself, `.gitignore` (init appends the ephemeral entries),
 * and the Spec Kit slash-command shim dirs (created only when a matching AI
 * tool is detected).
 */
const SCAFFOLD_PATHSPECS: readonly string[] = [
  '.minspec',
  '.gitignore',
  '.claude/commands',
  '.cursor/rules',
  // Harness files rendered at the project root.
  ...TEMPLATE_NAMES.map((name) => TEMPLATE_OUTPUT_PATHS[name]),
];

/**
 * Of the paths MinSpec scaffolds, the subset that actually exists on disk in
 * `folder`. Pure (no git, no toast) so it is unit-testable and so we never ask
 * git to stage a pathspec that isn't there.
 */
export function collectScaffoldPaths(folder: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rel of SCAFFOLD_PATHSPECS) {
    if (seen.has(rel)) continue;
    if (fs.existsSync(path.join(folder, rel))) {
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

/**
 * The minimal git surface the commit-offer needs. Defined as an interface so
 * tests can inject a stub instead of shelling out to a real repository.
 */
export interface ScaffoldCommitter {
  /** Whether `folder` is inside a git working tree. */
  isRepo(): Promise<boolean>;
  /** Stage exactly the given pathspecs. */
  add(paths: readonly string[]): Promise<void>;
  /** Create a single commit with `message` (staged content only). */
  commit(message: string): Promise<void>;
}

/** Default committer — wraps simple-git, lazily imported to keep init lean. */
async function defaultCommitter(folder: string): Promise<ScaffoldCommitter> {
  const { simpleGit } = await import('simple-git');
  const git = simpleGit(folder);
  return {
    async isRepo() {
      try {
        return (await git.revparse(['--is-inside-work-tree'])).trim() === 'true';
      } catch {
        return false;
      }
    },
    async add(paths) {
      await git.add([...paths]);
    },
    async commit(message) {
      await git.commit(message);
    },
  };
}

/** Dependencies for {@link offerScaffoldCommit}, injectable for tests. */
export interface OfferScaffoldCommitDeps {
  /** Build the git committer for the folder. */
  makeCommitter?: (folder: string) => Promise<ScaffoldCommitter>;
}

/**
 * After init, surface a NON-MODAL toast that summarizes the scaffolded files
 * and OFFERS to commit them in a single dedicated commit (#222). Accept →
 * stages exactly the scaffolded paths and makes ONE commit. Decline / dismiss
 * → no-op. Keyboard-friendly (a plain notification action) and best-effort:
 * any failure is surfaced as a warning but never breaks the init result.
 *
 * Skips silently when the folder is not a git repository (nothing to commit
 * into) or when no scaffolded paths exist on disk.
 */
export async function offerScaffoldCommit(
  folder: string,
  deps: OfferScaffoldCommitDeps = {},
): Promise<void> {
  // Cheap guard: no `.git` → not a repo → nothing to offer. Avoids shelling out
  // to git at all (and keeps non-repo init flows toast-free).
  if (!fs.existsSync(path.join(folder, '.git'))) return;

  const paths = collectScaffoldPaths(folder);
  if (paths.length === 0) return;

  let committer: ScaffoldCommitter;
  try {
    const make = deps.makeCommitter ?? defaultCommitter;
    committer = await make(folder);
    if (!(await committer.isRepo())) return;
  } catch {
    // If we can't even build/probe the committer, stay silent — the offer is
    // advisory and must never break init.
    return;
  }

  const summary = paths.join(', ');
  const choice = await vscode.window.showInformationMessage(
    `MinSpec scaffolded: ${summary}. Commit them now in a dedicated commit?`,
    COMMIT_ACTION,
  );
  if (choice !== COMMIT_ACTION) return; // decline / dismiss → no-op

  try {
    await committer.add(paths);
    await committer.commit(SCAFFOLD_COMMIT_MESSAGE);
    vscode.window.showInformationMessage(
      `MinSpec: committed the scaffolded SDD structure ("${SCAFFOLD_COMMIT_MESSAGE}").`,
    );
  } catch (err) {
    vscode.window.showWarningMessage(
      `MinSpec: could not commit the scaffolded files — ${describeError(err)}. ` +
        'They remain staged/unstaged for you to commit manually.',
    );
  }
}

export async function initCommand(
  folderArg?: string,
  deps?: OfferScaffoldCommitDeps,
): Promise<void> {
  const folder = folderArg ?? (await resolveTargetFolder());
  if (!folder) return;
  // The scaffold + harness writes are a multi-file synchronous sequence. If one
  // write fails partway, the project is left with a partial .minspec/ (and the
  // drift detector then reports false drift). Catch any failure, surface exactly
  // what went wrong, and do NOT report a misleading "Initialized" success (#153).
  try {
    scaffold(folder);
    generateHarnessFiles(folder);
  } catch (err) {
    vscode.window.showErrorMessage(
      `MinSpec: Initialization failed — ${describeError(err)}. ` +
        'The .minspec/ folder may be incomplete; resolve the error and re-run.',
    );
    return;
  }
  vscode.window.showInformationMessage(
    'MinSpec: Initialized .minspec/ and generated harness files.',
  );
  surfaceConstitutionNudge(folder);
  // Post-init "what to commit" hint + offer (#222). Best-effort, non-modal,
  // never blocks the init result.
  await offerScaffoldCommit(folder, deps);
}

export async function initRefreshCommand(folderArg?: string): Promise<void> {
  const folder = folderArg ?? (await resolveTargetFolder());
  if (!folder) return;
  // Same all-or-nothing concern as initCommand: a mid-sequence write failure
  // must surface, not silently leave a partial/inconsistent harness (#153).
  try {
    refreshHarnessFiles(folder);
  } catch (err) {
    vscode.window.showErrorMessage(
      `MinSpec: Harness refresh failed — ${describeError(err)}. ` +
        'Some files may be partially written; resolve the error and re-run.',
    );
    return;
  }
  vscode.window.showInformationMessage(
    'MinSpec: Refreshed harness files (user edits preserved).',
  );
  surfaceConstitutionNudge(folder);
}

/** Extract a human-readable message from an unknown thrown value. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
