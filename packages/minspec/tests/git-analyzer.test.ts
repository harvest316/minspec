import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeGitDiff, type ClassificationSignal } from '../src/lib/git-analyzer';
import type { SimpleGit } from 'simple-git';

/** Helper to create a mock SimpleGit instance */
function createMockGit(overrides: Partial<Record<string, unknown>> = {}): SimpleGit {
  return {
    revparse: vi.fn().mockResolvedValue('true'),
    diffSummary: vi.fn().mockResolvedValue({ files: [], insertions: 0, deletions: 0, changed: 0 }),
    diff: vi.fn().mockResolvedValue(''),
    status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
    ...overrides,
  } as unknown as SimpleGit;
}

/** Find a signal by name in the results */
function findSignal(signals: ClassificationSignal[], name: string): ClassificationSignal | undefined {
  return signals.find(s => s.name === name);
}

describe('analyzeGitDiff()', () => {
  describe('edge cases', () => {
    it('returns empty array when not in a git repo', async () => {
      const git = createMockGit({
        revparse: vi.fn().mockRejectedValue(new Error('not a git repo')),
      });

      const signals = await analyzeGitDiff('/tmp/not-a-repo', { git });
      expect(signals).toEqual([]);
    });

    it('returns empty array when revparse returns non-true value', async () => {
      const git = createMockGit({
        revparse: vi.fn().mockResolvedValue('false'),
      });

      const signals = await analyzeGitDiff('/tmp/not-a-repo', { git });
      expect(signals).toEqual([]);
    });

    it('returns empty array when no changes detected', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({ files: [], insertions: 0, deletions: 0, changed: 0 }),
      });

      const signals = await analyzeGitDiff('/tmp/some-repo', { git });
      expect(signals).toEqual([]);
    });

    it('returns empty array when diffSummary throws', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockRejectedValue(new Error('diff failed')),
      });

      const signals = await analyzeGitDiff('/tmp/some-repo', { git });
      expect(signals).toEqual([]);
    });
  });

  describe('single file change (T1 signals)', () => {
    it('produces T1 signals for a single small file change', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [{ file: 'src/index.ts', insertions: 5, deletions: 2, binary: false }],
          insertions: 5,
          deletions: 2,
          changed: 1,
        }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      const signals = await analyzeGitDiff('/tmp/repo', { git });

      // Should have core signals
      expect(signals.length).toBeGreaterThanOrEqual(4);

      // File count: 1 file = T1
      const filesChanged = findSignal(signals, 'files_changed');
      expect(filesChanged).toBeDefined();
      expect(filesChanged!.value).toBe(1);
      expect(filesChanged!.tierContribution).toBe('T1');

      // Line count: 7 lines = T1
      const linesChanged = findSignal(signals, 'lines_changed');
      expect(linesChanged).toBeDefined();
      expect(linesChanged!.value).toBe(7);
      expect(linesChanged!.tierContribution).toBe('T1');

      // File types: 1 type (ts) = T1
      const fileTypes = findSignal(signals, 'file_types');
      expect(fileTypes).toBeDefined();
      expect(fileTypes!.value).toBe(1);
      expect(fileTypes!.tierContribution).toBe('T1');

      // Cross-directory: 1 dir = T1
      const crossDir = findSignal(signals, 'cross_directory');
      expect(crossDir).toBeDefined();
      expect(crossDir!.value).toBe(1);
      expect(crossDir!.tierContribution).toBe('T1');

      // New files: 0 = T1
      const newFiles = findSignal(signals, 'new_files');
      expect(newFiles).toBeDefined();
      expect(newFiles!.value).toBe(0);
      expect(newFiles!.tierContribution).toBe('T1');
    });
  });

  describe('multi-file, multi-directory change (T3 signals)', () => {
    it('produces higher tier signals for complex changes', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [
            { file: 'src/lib/analyzer.ts', insertions: 80, deletions: 20, binary: false },
            { file: 'src/lib/config.ts', insertions: 10, deletions: 5, binary: false },
            { file: 'tests/analyzer.test.ts', insertions: 60, deletions: 0, binary: false },
            { file: 'src/commands/classify.ts', insertions: 30, deletions: 10, binary: false },
            { file: 'docs/design.md', insertions: 15, deletions: 3, binary: false },
            { file: 'package.json', insertions: 2, deletions: 0, binary: false },
            { file: 'src/types/index.ts', insertions: 20, deletions: 0, binary: false },
          ],
          insertions: 217,
          deletions: 38,
          changed: 7,
        }),
        status: vi.fn().mockResolvedValue({
          created: ['src/lib/analyzer.ts', 'tests/analyzer.test.ts', 'src/types/index.ts'],
          not_added: [],
          staged: [],
        }),
        diff: vi.fn().mockResolvedValue(
          '--- a/package.json\n+++ b/package.json\n@@ -1,5 +1,7 @@\n "dependencies": {\n+    "simple-git": "^3.27.0"\n }\n',
        ),
      });

      const signals = await analyzeGitDiff('/tmp/repo', { git });

      // File count: 7 files = T3
      const filesChanged = findSignal(signals, 'files_changed');
      expect(filesChanged).toBeDefined();
      expect(filesChanged!.value).toBe(7);
      expect(filesChanged!.tierContribution).toBe('T3');

      // Line count: 255 lines = T3
      const linesChanged = findSignal(signals, 'lines_changed');
      expect(linesChanged).toBeDefined();
      expect(linesChanged!.value).toBe(255);
      expect(linesChanged!.tierContribution).toBe('T3');

      // File types: ts, md, json = 3 types = T3
      const fileTypes = findSignal(signals, 'file_types');
      expect(fileTypes).toBeDefined();
      expect(fileTypes!.value).toBe(3);
      expect(fileTypes!.tierContribution).toBe('T3');

      // Cross-directory: src/lib, tests, src/commands, docs, root, src/types = 6 dirs = T3
      const crossDir = findSignal(signals, 'cross_directory');
      expect(crossDir).toBeDefined();
      expect(crossDir!.value).toBeGreaterThanOrEqual(3);
      expect(crossDir!.tierContribution).toBe('T3');

      // New files: 3 = T3
      const newFiles = findSignal(signals, 'new_files');
      expect(newFiles).toBeDefined();
      expect(newFiles!.value).toBe(3);
      expect(newFiles!.tierContribution).toBe('T3');

      // Dependency change present
      const depChange = findSignal(signals, 'dependency_change');
      expect(depChange).toBeDefined();
      expect(depChange!.value).toBe(true);
      expect(depChange!.tierContribution).toBe('T3');
    });
  });

  describe('package.json dependency addition', () => {
    it('emits dependency_change signal when package.json is modified', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [
            { file: 'package.json', insertions: 3, deletions: 1, binary: false },
            { file: 'src/index.ts', insertions: 10, deletions: 2, binary: false },
          ],
          insertions: 13,
          deletions: 3,
          changed: 2,
        }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
        diff: vi.fn().mockResolvedValue(
          '--- a/package.json\n+++ b/package.json\n@@ -3,4 +3,6 @@\n "dependencies": {\n+    "lodash": "^4.17.21"\n }\n',
        ),
      });

      const signals = await analyzeGitDiff('/tmp/repo', { git });

      const depChange = findSignal(signals, 'dependency_change');
      expect(depChange).toBeDefined();
      expect(depChange!.value).toBe(true);
      expect(depChange!.tierContribution).toBe('T3');
    });

    it('emits dependency_change with false when package.json changes do not add deps', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [
            { file: 'package.json', insertions: 1, deletions: 1, binary: false },
          ],
          insertions: 1,
          deletions: 1,
          changed: 1,
        }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
        diff: vi.fn().mockResolvedValue(
          '--- a/package.json\n+++ b/package.json\n@@ -2,3 +2,3 @@\n-  "version": "1.0.0"\n+  "version": "1.0.1"\n',
        ),
      });

      const signals = await analyzeGitDiff('/tmp/repo', { git });

      const depChange = findSignal(signals, 'dependency_change');
      expect(depChange).toBeDefined();
      expect(depChange!.value).toBe(false);
      expect(depChange!.tierContribution).toBe('T2');
    });

    it('does not emit dependency_change signal when no package.json change', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [
            { file: 'src/index.ts', insertions: 5, deletions: 0, binary: false },
          ],
          insertions: 5,
          deletions: 0,
          changed: 1,
        }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      const signals = await analyzeGitDiff('/tmp/repo', { git });

      const depChange = findSignal(signals, 'dependency_change');
      expect(depChange).toBeUndefined();
    });
  });

  describe('staged vs working tree', () => {
    it('uses --cached flag when staged option is true (default)', async () => {
      const diffSummaryMock = vi.fn().mockResolvedValue({
        files: [{ file: 'a.ts', insertions: 1, deletions: 0, binary: false }],
        insertions: 1,
        deletions: 0,
        changed: 1,
      });

      const git = createMockGit({
        diffSummary: diffSummaryMock,
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      await analyzeGitDiff('/tmp/repo', { git, staged: true });

      expect(diffSummaryMock).toHaveBeenCalledWith(['--cached']);
    });

    it('uses no flag when staged option is false', async () => {
      const diffSummaryMock = vi.fn().mockResolvedValue({
        files: [{ file: 'a.ts', insertions: 1, deletions: 0, binary: false }],
        insertions: 1,
        deletions: 0,
        changed: 1,
      });

      const git = createMockGit({
        diffSummary: diffSummaryMock,
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      await analyzeGitDiff('/tmp/repo', { git, staged: false });

      expect(diffSummaryMock).toHaveBeenCalledWith([]);
    });
  });

  describe('tier boundary values', () => {
    it('file count boundary: 2 files = T1, 3 files = T2', async () => {
      // 2 files = T1
      const git2 = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [
            { file: 'a.ts', insertions: 1, deletions: 0, binary: false },
            { file: 'b.ts', insertions: 1, deletions: 0, binary: false },
          ],
          changed: 2,
        }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      const signals2 = await analyzeGitDiff('/tmp/repo', { git: git2 });
      expect(findSignal(signals2, 'files_changed')!.tierContribution).toBe('T1');

      // 3 files = T2
      const git3 = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [
            { file: 'a.ts', insertions: 1, deletions: 0, binary: false },
            { file: 'b.ts', insertions: 1, deletions: 0, binary: false },
            { file: 'c.ts', insertions: 1, deletions: 0, binary: false },
          ],
          changed: 3,
        }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      const signals3 = await analyzeGitDiff('/tmp/repo', { git: git3 });
      expect(findSignal(signals3, 'files_changed')!.tierContribution).toBe('T2');
    });

    it('line count boundary: 20 lines = T1, 21 lines = T2', async () => {
      // 20 lines = T1
      const git20 = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [{ file: 'a.ts', insertions: 15, deletions: 5, binary: false }],
          changed: 1,
        }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      const signals20 = await analyzeGitDiff('/tmp/repo', { git: git20 });
      expect(findSignal(signals20, 'lines_changed')!.tierContribution).toBe('T1');

      // 21 lines = T2
      const git21 = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [{ file: 'a.ts', insertions: 16, deletions: 5, binary: false }],
          changed: 1,
        }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      const signals21 = await analyzeGitDiff('/tmp/repo', { git: git21 });
      expect(findSignal(signals21, 'lines_changed')!.tierContribution).toBe('T2');
    });

    it('file count: 16 files = T4', async () => {
      const files = Array.from({ length: 16 }, (_, i) => ({
        file: `src/file${i}.ts`,
        insertions: 5,
        deletions: 0,
        binary: false,
      }));

      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({ files, changed: 16 }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      const signals = await analyzeGitDiff('/tmp/repo', { git });
      expect(findSignal(signals, 'files_changed')!.tierContribution).toBe('T4');
    });

    it('line count: 501 lines = T4', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [{ file: 'big.ts', insertions: 400, deletions: 101, binary: false }],
          changed: 1,
        }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      const signals = await analyzeGitDiff('/tmp/repo', { git });
      expect(findSignal(signals, 'lines_changed')!.tierContribution).toBe('T4');
    });
  });

  describe('signal weights', () => {
    it('all signals have valid weights between 0 and 1', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [
            { file: 'package.json', insertions: 5, deletions: 2, binary: false },
            { file: 'src/index.ts', insertions: 10, deletions: 3, binary: false },
          ],
          changed: 2,
        }),
        status: vi.fn().mockResolvedValue({ created: ['src/index.ts'], not_added: [], staged: [] }),
        diff: vi.fn().mockResolvedValue(
          '"dependencies": {\n+    "foo": "^1.0.0"\n',
        ),
      });

      const signals = await analyzeGitDiff('/tmp/repo', { git });

      for (const signal of signals) {
        expect(signal.weight).toBeGreaterThan(0);
        expect(signal.weight).toBeLessThanOrEqual(1);
      }
    });

    it('all signals have valid tier contributions', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [{ file: 'a.ts', insertions: 5, deletions: 0, binary: false }],
          changed: 1,
        }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      const signals = await analyzeGitDiff('/tmp/repo', { git });

      const validTiers = ['T1', 'T2', 'T3', 'T4'];
      for (const signal of signals) {
        expect(validTiers).toContain(signal.tierContribution);
      }
    });
  });

  describe('file extension handling', () => {
    it('handles files with no extension', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [
            { file: 'Makefile', insertions: 3, deletions: 0, binary: false },
            { file: 'Dockerfile', insertions: 5, deletions: 2, binary: false },
          ],
          changed: 2,
        }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      const signals = await analyzeGitDiff('/tmp/repo', { git });

      // Files with no extension: extensions set should be empty,
      // file_types should report 0 extensions (handled gracefully)
      const fileTypes = findSignal(signals, 'file_types');
      expect(fileTypes).toBeDefined();
      // No extensions detected = 0 types, which maps to T1 (<=1)
      expect(fileTypes!.value).toBe(0);
      expect(fileTypes!.tierContribution).toBe('T1');
    });

    it('handles mixed extensions correctly', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [
            { file: 'src/app.ts', insertions: 10, deletions: 0, binary: false },
            { file: 'styles/main.css', insertions: 5, deletions: 0, binary: false },
            { file: 'index.html', insertions: 3, deletions: 1, binary: false },
          ],
          changed: 3,
        }),
        status: vi.fn().mockResolvedValue({ created: [], not_added: [], staged: [] }),
      });

      const signals = await analyzeGitDiff('/tmp/repo', { git });

      const fileTypes = findSignal(signals, 'file_types');
      expect(fileTypes).toBeDefined();
      expect(fileTypes!.value).toBe(3); // ts, css, html
      expect(fileTypes!.tierContribution).toBe('T3');
    });
  });

  describe('status call failure graceful handling', () => {
    it('still returns signals when git status fails (new_files defaults to 0)', async () => {
      const git = createMockGit({
        diffSummary: vi.fn().mockResolvedValue({
          files: [{ file: 'a.ts', insertions: 5, deletions: 0, binary: false }],
          changed: 1,
        }),
        status: vi.fn().mockRejectedValue(new Error('status failed')),
      });

      const signals = await analyzeGitDiff('/tmp/repo', { git });

      expect(signals.length).toBeGreaterThan(0);
      const newFiles = findSignal(signals, 'new_files');
      expect(newFiles).toBeDefined();
      expect(newFiles!.value).toBe(0);
      expect(newFiles!.tierContribution).toBe('T1');
    });
  });
});
