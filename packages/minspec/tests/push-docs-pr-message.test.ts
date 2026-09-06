/**
 * T1 — `scripts/push-docs.sh`: the PR title must be the commit SUBJECT, not the
 * whole message, and a PR-creation failure must not read as "nothing happened"
 * (#1606).
 *
 * Before this fix, `--title "$msg"` passed the ENTIRE commit message (subject
 * + body) as the PR title. This repo's own commit convention — a subject line,
 * a blank line, then an explanatory body, which the RCDD gate in
 * `.githooks/commit-msg` actively requires for `fix:` commits — routinely
 * produces a message past GitHub's 256-character PR title cap
 * ("Title is too long (maximum is 256 characters)"). The branch was already
 * pushed by that point, so the failure stranded it with no PR and no signal
 * that the push half had succeeded (hit landing DR-085, PR #1605 opened by
 * hand).
 *
 * These tests drive the REAL script against a real git repo (an `origin` bare
 * repo + a `primary` clone), with `gh` stubbed so no network call happens.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// See push-docs-sh.test.ts's identical comment (#1099): this suite also drives
// real `git`/`bash` child processes per assertion, so it gets the same raised
// per-file timeout rather than tripping the global default under contention.
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

/**
 * A fake `gh` on PATH — never touches the network. `pr create` logs its full
 * argv, NUL-separated (a `--title`/`--body` value can itself contain
 * newlines, so a newline-per-arg log would be ambiguous to parse back).
 * `failPr: true` makes the `pr create` call fail, to exercise the
 * partial-success path.
 */
function installFakeGh(binDir: string, callsLog: string, opts: { failPr?: boolean } = {}): void {
  fs.mkdirSync(binDir, { recursive: true });
  const failLine = opts.failPr
    ? `echo "fake gh: pr create failed" >&2; exit 1`
    : `echo "https://github.com/test-owner/test-repo/pull/42"`;
  fs.writeFileSync(
    path.join(binDir, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  repo) echo "test-owner/test-repo" ;;
  pr)
    printf '%s\\0' "$@" >> "${callsLog}"
    ${failLine}
    ;;
  *) echo "fake gh: unsupported subcommand: \${1:-}" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
}

/** Parse the NUL-separated argv logged by the fake `gh pr create` call. */
function argvFromGhLog(callsLog: string): string[] {
  const raw = fs.readFileSync(callsLog, 'utf-8');
  const parts = raw.split('\0');
  // A trailing NUL leaves one empty element at the end — drop it.
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function flagValue(argv: string[], flag: string): string {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) {
    throw new Error(`no ${flag} in argv: ${JSON.stringify(argv)}`);
  }
  return argv[i + 1];
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      execFileSync('git', ['-C', path.join(r, 'primary'), 'worktree', 'prune'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    fs.rmSync(r, { recursive: true, force: true });
  }
});

/** Set up `origin.git` (bare) + a `primary` clone, with the given files committed on main. */
function setupRepo(files: Record<string, string>): { root: string; origin: string; primary: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-docs-msg-'));
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

function runPushDocs(
  primary: string,
  root: string,
  args: string[],
  ghOpts: { failPr?: boolean } = {},
): { status: number; stdout: string; stderr: string } {
  const binDir = path.join(root, 'bin');
  const callsLog = path.join(root, 'gh-calls.log');
  fs.writeFileSync(callsLog, '');
  installFakeGh(binDir, callsLog, ghOpts);
  try {
    const stdout = execFileSync('bash', [PUSH_DOCS_SH, ...args], {
      cwd: primary,
      encoding: 'utf-8',
      env: { ...process.env, ...GIT_ENV, PATH: `${binDir}:${process.env.PATH}` },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('push-docs.sh — PR title/body split (#1606)', () => {
  it('a subject + blank line + long body produces a title that is just the subject, with the body carried into --body', () => {
    const { root, primary } = setupRepo({ 'docs/decisions/DR-102.md': 'seed\n' });
    fs.writeFileSync(path.join(primary, 'docs/decisions/DR-102.md'), 'updated\n');

    const longBody = 'x'.repeat(300);
    const msg = `docs(DR-102): wire note\n\nRoot cause: ${longBody}`;
    const result = runPushDocs(primary, root, ['-m', msg]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/push-docs: opened/);

    const argv = argvFromGhLog(path.join(root, 'gh-calls.log'));
    const title = flagValue(argv, '--title');
    const body = flagValue(argv, '--body');

    expect(title).toBe('docs(DR-102): wire note');
    expect(title.length).toBeLessThanOrEqual(256);
    expect(body).toContain(`Root cause: ${longBody}`);
    // The docs-lane boilerplate + file list must still be present in the body.
    expect(body).toContain('docs-lane');
    expect(body).toContain('DR-102.md');
  });

  it('a single-line message over 256 chars is truncated to a title on a word boundary', () => {
    const { root, primary } = setupRepo({ 'docs/decisions/DR-103.md': 'seed\n' });
    fs.writeFileSync(path.join(primary, 'docs/decisions/DR-103.md'), 'updated\n');

    // Words of 9 chars incl. trailing space, well past 256 chars total, no blank-line body.
    const msg = 'docs(DR-103): ' + Array.from({ length: 40 }, (_, i) => `word${i}word`).join(' ');
    expect(msg.length).toBeGreaterThan(256);

    const result = runPushDocs(primary, root, ['-m', msg]);
    expect(result.status).toBe(0);

    const argv = argvFromGhLog(path.join(root, 'gh-calls.log'));
    const title = flagValue(argv, '--title');

    expect(title.length).toBeLessThanOrEqual(256);
    // Truncated on a word boundary: title is a clean prefix of the original
    // message up to some space, never a mid-word cut.
    expect(msg.startsWith(title)).toBe(true);
    expect(msg[title.length]).toBe(' ');
  });
});

describe('push-docs.sh — partial-success reporting on PR-creation failure (#1606)', () => {
  it('reports the pushed branch and a ready-to-run gh pr create command instead of a bare failure', () => {
    const { root, origin, primary } = setupRepo({ 'docs/decisions/DR-104.md': 'seed\n' });
    fs.writeFileSync(path.join(primary, 'docs/decisions/DR-104.md'), 'updated\n');

    const result = runPushDocs(primary, root, ['-m', 'docs(DR-104): wire note'], { failPr: true });

    expect(result.status).not.toBe(0);
    // The branch must actually be on origin — the push half genuinely succeeded.
    const branchMatch = result.stderr.match(/branch:\s+(\S+)/);
    expect(branchMatch).not.toBeNull();
    const branch = branchMatch![1];
    // `origin` is the bare repo itself (not a clone), so the pushed branch is
    // a plain local branch there — not a remote-tracking ref.
    expect(git(origin, 'branch', '--list', branch)).toContain(branch);

    // The failure message must hand back a usable manual command, not just
    // "it failed" — it must name the branch and the gh pr create invocation.
    expect(result.stderr).toMatch(/PR creation FAILED/);
    expect(result.stderr).toMatch(/gh pr create/);
    expect(result.stderr).toContain(branch);
    expect(result.stderr).toContain('docs-lane');
  });
});
