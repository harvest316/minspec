/**
 * T1 — `scripts/push-docs.sh`: a pure/mixed deletion must be representable (#798).
 *
 * The lane builds its branch by COPYING changed docs files into a throwaway
 * worktree off `origin/main`. A deletion has nothing on disk to copy, so before
 * this fix it was silently filtered out of the gathered file set — an all-deletion
 * changeset reported "no changed docs-corpus files found" and nothing was pushed.
 * The fix classifies each docs-corpus path by its `git status --porcelain` code:
 * a worktree deletion (` D`) or staged deletion (`D `) is `git rm`'d in the lane
 * worktree instead of copied. These tests run the REAL script against a real git
 * repo (an `origin` bare repo + a `primary` clone), with `gh` stubbed so no network
 * call happens; they assert the pushed branch actually carries the deletion.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// #1099 — this suite drives real `git` child processes per assertion (setupRepo +
// runPushDocs both shell out). Under container scheduling contention a single `git`
// invocation can queue past the 5s default testTimeout even though nothing hung,
// and which suite trips it is non-deterministic run-to-run (#1099). Raised HERE,
// per-file, not globally — a genuinely hung test elsewhere still fails fast at the
// default. 30s is the value #1099 measured all affected suites passing reliably at.
vi.setConfig({ testTimeout: 30_000 });
afterAll(() => {
  vi.resetConfig();
});

const PUSH_DOCS_SH = path.resolve(__dirname, '../../../scripts/push-docs.sh');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...GIT_ENV } }).trim();
}

/** A fake `gh` on PATH — never touches the network; `pr create` logs its argv. */
function installFakeGh(binDir: string, callsLog: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  repo) echo "test-owner/test-repo" ;;
  pr)
    printf '%s\\n' "$@" >> "${callsLog}"
    echo "https://github.com/test-owner/test-repo/pull/42"
    ;;
  *) echo "fake gh: unsupported subcommand: \${1:-}" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
}

/** Parse a single-line `--flag <value>` out of the logged `gh pr create` argv lines. */
function flagFromGhLog(callsLog: string, flag: string): string {
  const lines = fs.readFileSync(callsLog, 'utf-8').split('\n');
  const i = lines.indexOf(flag);
  if (i === -1 || lines[i + 1] === undefined) throw new Error(`no ${flag} in gh log: ${lines.join('|')}`);
  return lines[i + 1];
}

/**
 * Parse the `--body <value>` out of the logged argv. Unlike the other flags,
 * `--body`'s value is (legitimately) multi-line, and it's always the LAST
 * argument `push-docs.sh` passes — so everything after the `--body` marker
 * line, through the end of the log (minus the trailing newline the fake
 * `gh`'s `printf '%s\n'` adds), is the body value verbatim.
 */
function bodyFromGhLog(callsLog: string): string {
  const raw = fs.readFileSync(callsLog, 'utf-8');
  const marker = '\n--body\n';
  const i = raw.indexOf(marker);
  if (i === -1) throw new Error(`no --body in gh log: ${raw}`);
  return raw.slice(i + marker.length).replace(/\n$/, '');
}

/** Parse the `--head <branch>` value out of the logged `gh pr create` argv lines. */
function branchFromGhLog(callsLog: string): string {
  return flagFromGhLog(callsLog, '--head');
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      // Best-effort: drop any worktree registration before removing the dir.
      execFileSync('git', ['-C', path.join(r, 'primary'), 'worktree', 'prune'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    fs.rmSync(r, { recursive: true, force: true });
  }
});

/** Set up `origin.git` (bare) + a `primary` clone, with the given files committed on main. */
function setupRepo(files: Record<string, string>): { root: string; origin: string; primary: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-docs-sh-'));
  roots.push(root);
  const origin = path.join(root, 'origin.git');
  const primary = path.join(root, 'primary');
  fs.mkdirSync(origin);
  git(origin, 'init', '--bare', '-b', 'main');
  git(root, 'clone', origin, primary);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(primary, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(primary, 'add', '.');
  git(primary, 'commit', '-m', 'seed');
  git(primary, 'push', 'origin', 'main');
  return { root, origin, primary };
}

function runPushDocs(primary: string, root: string, args: string[]): string {
  const binDir = path.join(root, 'bin');
  const callsLog = path.join(root, 'gh-calls.log');
  fs.writeFileSync(callsLog, '');
  installFakeGh(binDir, callsLog);
  const out = execFileSync('bash', [PUSH_DOCS_SH, ...args], {
    cwd: primary,
    encoding: 'utf-8',
    env: { ...process.env, ...GIT_ENV, PATH: `${binDir}:${process.env.PATH}` },
  });
  return out;
}

describe('push-docs.sh — delete-only lane push (#798)', () => {
  it('a removed doc is git rm-ed in the lane worktree and actually pushed', () => {
    const { root, origin, primary } = setupRepo({ 'docs/decisions/DR-100.md': 'seed\n' });
    const callsLog = path.join(root, 'gh-calls.log');

    // Working-tree deletion, unstaged — porcelain code ` D`.
    fs.rmSync(path.join(primary, 'docs/decisions/DR-100.md'));

    const out = runPushDocs(primary, root, ['-m', 'docs: remove DR-100']);
    expect(out).toMatch(/push-docs: opened https:\/\/github\.com\/test-owner\/test-repo\/pull\/42/);

    const branch = branchFromGhLog(callsLog);
    // The pushed branch carries the deletion: the file is gone at that ref.
    expect(() => git(origin, 'show', `${branch}:docs/decisions/DR-100.md`)).toThrow();
    // ...but main (the branch's base) still has it — proves it's a real deletion,
    // not just an absent file that was never on the branch to begin with.
    expect(git(origin, 'show', 'main:docs/decisions/DR-100.md')).toBe('seed');
  });

  it('a pure-deletion changeset is no longer silently filtered to "no changes"', () => {
    const { root, primary } = setupRepo({ 'docs/decisions/DR-101.md': 'seed\n' });
    fs.rmSync(path.join(primary, 'docs/decisions/DR-101.md'));
    const out = runPushDocs(primary, root, ['-m', 'docs: remove DR-101']);
    expect(out).not.toMatch(/no changed docs-corpus files found/);
    expect(out).toMatch(/push-docs: opened/);
  });
});

describe('push-docs.sh — PR title/body split (#1508)', () => {
  it('a multi-paragraph -m message produces a PR whose title is the subject alone', () => {
    const { root, primary } = setupRepo({ 'docs/decisions/DR-102.md': 'seed\n' });
    const callsLog = path.join(root, 'gh-calls.log');
    fs.writeFileSync(path.join(primary, 'docs/decisions/DR-102.md'), 'updated\n');

    const subject = 'docs(DR-102): wire note';
    const bodyPara1 = 'This paragraph explains the rationale in more detail than fits on one line.';
    const bodyPara2 = 'A second paragraph with further context, so the body is genuinely multi-paragraph.';
    const msg = `${subject}\n\n${bodyPara1}\n\n${bodyPara2}`;

    const out = runPushDocs(primary, root, ['-m', msg]);
    expect(out).toMatch(/push-docs: opened/);

    expect(flagFromGhLog(callsLog, '--title')).toBe(subject);
    const body = bodyFromGhLog(callsLog);
    expect(body).toContain(bodyPara1);
    expect(body).toContain(bodyPara2);
  });

  it('a subject line over 256 chars fails before anything is pushed', () => {
    const { root, origin, primary } = setupRepo({ 'docs/decisions/DR-103.md': 'seed\n' });
    fs.writeFileSync(path.join(primary, 'docs/decisions/DR-103.md'), 'updated\n');

    const longSubject = 'docs(DR-103): ' + 'x'.repeat(250); // > 256 chars total
    const msg = `${longSubject}\n\nsome body text`;

    expect(() => runPushDocs(primary, root, ['-m', msg])).toThrow(/PR title .* exceeds|Command failed/);

    // Nothing was pushed: no docs-lane branch exists on the remote, and the
    // primary checkout registered no leftover worktree.
    const branches = git(origin, 'branch', '--list', 'docs-lane/*');
    expect(branches).toBe('');
    const worktrees = git(primary, 'worktree', 'list');
    expect(worktrees.split('\n')).toHaveLength(1);
  });
});

describe('push-docs.sh — mixed add+delete lane push (#798)', () => {
  it('one file is copied/modified, another is git rm-ed, in the same push', () => {
    const { root, origin, primary } = setupRepo({
      'docs/decisions/DR-100.md': 'seed\n',
      'docs/decisions/DR-101.md': 'seed\n',
    });
    const callsLog = path.join(root, 'gh-calls.log');

    fs.rmSync(path.join(primary, 'docs/decisions/DR-100.md')); // deletion
    fs.writeFileSync(path.join(primary, 'docs/decisions/DR-101.md'), 'updated\n'); // modify

    const out = runPushDocs(primary, root, ['-m', 'docs: update DR-101, remove DR-100']);
    expect(out).toMatch(/push-docs: opened/);

    const branch = branchFromGhLog(callsLog);
    expect(() => git(origin, 'show', `${branch}:docs/decisions/DR-100.md`)).toThrow();
    expect(git(origin, 'show', `${branch}:docs/decisions/DR-101.md`)).toBe('updated');
  });
});
