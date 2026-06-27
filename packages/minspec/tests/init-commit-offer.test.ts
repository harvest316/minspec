/**
 * T2 — Feature Tests: post-init "what to commit" hint + offer (#222)
 *
 * After MinSpec init scaffolds .minspec/ + harness files, the user is left with
 * a pile of unstaged new files and no guidance. This feature adds a NON-MODAL
 * toast that summarizes the scaffolded files and OFFERS to commit them in one
 * dedicated commit.
 *
 * Behavior under test:
 *   - The offer appears (a non-modal info toast with a commit action), when the
 *     folder is a git repo and scaffolded paths exist.
 *   - Accept  → exactly ONE dedicated commit is made of only the scaffolded paths.
 *   - Decline → no commit (no-op).
 *   - Not a git repo → no offer at all.
 *
 * The git surface is injected (ScaffoldCommitter) so the test never shells out
 * to a real repository; the toast is the mocked vscode.window API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mock vscode (non-modal info/warn toasts) ────────────────────────────────

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

// ─── Mock the constitution nudge (keep happy-path toast count deterministic) ──

vi.mock('../src/lib/constitution-nudge', () => ({
  evaluateConstitution: vi.fn(() => ({ empty: false, message: 'm', fixHint: 'f' })),
}));

import * as vscode from 'vscode';
import {
  initCommand,
  offerScaffoldCommit,
  collectScaffoldPaths,
  SCAFFOLD_COMMIT_MESSAGE,
  type ScaffoldCommitter,
} from '../src/commands/init';

/** A spying committer stub that records add()/commit() calls. */
function makeCommitterStub(isRepo = true) {
  const added: string[][] = [];
  const commits: string[] = [];
  const committer: ScaffoldCommitter = {
    isRepo: vi.fn(async () => isRepo),
    add: vi.fn(async (paths: readonly string[]) => {
      added.push([...paths]);
    }),
    commit: vi.fn(async (message: string) => {
      commits.push(message);
    }),
  };
  return { committer, added, commits };
}

describe('post-init commit offer (#222)', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-commit-offer-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Make `tmpDir` look like a git repo with some scaffolded files present. */
  function seedScaffold(): void {
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.minspec', 'config.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# CLAUDE');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n');
  }

  describe('collectScaffoldPaths()', () => {
    it('returns only the scaffolded paths that exist on disk', () => {
      seedScaffold();
      const paths = collectScaffoldPaths(tmpDir);
      expect(paths).toContain('.minspec');
      expect(paths).toContain('CLAUDE.md');
      expect(paths).toContain('.gitignore');
      // Absent harness files must NOT be listed.
      expect(paths).not.toContain('DESIGN.md');
      expect(paths).not.toContain('.cursor/rules');
    });

    it('returns an empty list when nothing has been scaffolded', () => {
      expect(collectScaffoldPaths(tmpDir)).toEqual([]);
    });
  });

  describe('offerScaffoldCommit() — the offer appears', () => {
    it('shows a NON-MODAL info toast with a commit action', async () => {
      seedScaffold();
      const { committer } = makeCommitterStub(true);
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);

      await offerScaffoldCommit(tmpDir, { makeCommitter: async () => committer });

      expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
      const call = vi.mocked(vscode.window.showInformationMessage).mock.calls[0];
      const message = call[0] as string;
      // Summarizes scaffolded files + offers a commit.
      expect(message).toMatch(/scaffolded/i);
      expect(message).toContain('CLAUDE.md');
      // The action is a plain string label (a keyboard-navigable toast button),
      // never a modal options object.
      const action = call[1];
      expect(typeof action).toBe('string');
      const opts = call.find((a) => a && typeof a === 'object') as
        | { modal?: boolean }
        | undefined;
      expect(opts?.modal).not.toBe(true);
    });
  });

  describe('offerScaffoldCommit() — accept', () => {
    it('makes exactly ONE dedicated commit of only the scaffolded files', async () => {
      seedScaffold();
      const { committer, added, commits } = makeCommitterStub(true);
      // User clicks the commit action (first action label passed to the toast).
      vi.mocked(vscode.window.showInformationMessage).mockImplementation(
        async (_msg: string, ...actions: string[]) => actions[0],
      );

      await offerScaffoldCommit(tmpDir, { makeCommitter: async () => committer });

      // Exactly one commit, with the dedicated message.
      expect(commits).toEqual([SCAFFOLD_COMMIT_MESSAGE]);
      expect(committer.commit).toHaveBeenCalledTimes(1);
      // Staged exactly the scaffolded paths — and ONLY those.
      expect(added).toHaveLength(1);
      const staged = added[0];
      expect(staged).toEqual(collectScaffoldPaths(tmpDir));
      expect(staged).toContain('.minspec');
      expect(staged).toContain('CLAUDE.md');
      expect(staged).toContain('.gitignore');
    });
  });

  describe('offerScaffoldCommit() — decline', () => {
    it('makes NO commit when the user dismisses the toast', async () => {
      seedScaffold();
      const { committer, added, commits } = makeCommitterStub(true);
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);

      await offerScaffoldCommit(tmpDir, { makeCommitter: async () => committer });

      expect(commits).toEqual([]);
      expect(added).toEqual([]);
      expect(committer.add).not.toHaveBeenCalled();
      expect(committer.commit).not.toHaveBeenCalled();
    });
  });

  describe('offerScaffoldCommit() — not a git repo', () => {
    it('makes no offer at all when .git is absent', async () => {
      // Scaffolded files but NO .git directory.
      fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# CLAUDE');
      const makeCommitter = vi.fn();

      await offerScaffoldCommit(tmpDir, { makeCommitter });

      expect(makeCommitter).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('makes no offer when the committer reports it is not a repo', async () => {
      seedScaffold();
      const { committer, commits } = makeCommitterStub(false);

      await offerScaffoldCommit(tmpDir, { makeCommitter: async () => committer });

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
      expect(commits).toEqual([]);
    });
  });

  describe('offerScaffoldCommit() — best-effort', () => {
    it('surfaces a warning (not an error) and never throws when commit fails', async () => {
      seedScaffold();
      const committer: ScaffoldCommitter = {
        isRepo: vi.fn(async () => true),
        add: vi.fn(async () => undefined),
        commit: vi.fn(async () => {
          throw new Error('nothing to commit');
        }),
      };
      vi.mocked(vscode.window.showInformationMessage).mockImplementation(
        async (_msg: string, ...actions: string[]) => actions[0],
      );

      await expect(
        offerScaffoldCommit(tmpDir, { makeCommitter: async () => committer }),
      ).resolves.toBeUndefined();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });
  });

  describe('initCommand() integration — offer is reachable via init', () => {
    it('fires the commit offer after a real init in a git repo', async () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      const { committer, commits } = makeCommitterStub(true);
      vi.mocked(vscode.window.showInformationMessage).mockImplementation(
        async (_msg: string, ...actions: string[]) => (actions.length ? actions[0] : undefined),
      );

      await initCommand(tmpDir, { makeCommitter: async () => committer });

      // The real scaffold ran, so .minspec/ + harness files exist…
      expect(fs.existsSync(path.join(tmpDir, '.minspec'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(true);
      // …and the offer was accepted → exactly one dedicated commit.
      expect(commits).toEqual([SCAFFOLD_COMMIT_MESSAGE]);
    });
  });
});
