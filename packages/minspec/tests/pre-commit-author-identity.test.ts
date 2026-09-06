/**
 * #1114 — pre-commit author identity gate.
 *
 * GitHub links a commit to an account by matching the commit's AUTHOR EMAIL against
 * that account's verified addresses. An 87-commit run authored under an email that was
 * never verified anywhere rendered every cross-reference those commits made as "ghost
 * mentioned this" in issue timelines — a cosmetic-looking symptom of an identity
 * misconfiguration nothing in the harness checked for (a container session's ambient
 * `user.email` shadowing the account's real one).
 *
 * The fix is an OPT-IN gate: when a project configures `minspec.allowedCommitEmails`,
 * the hook refuses a commit whose `user.email` is not in that list. Unconfigured (the
 * default for every project this template scaffolds into), the gate is a total no-op —
 * asserting an identity the harness cannot know in advance would itself violate the
 * blast-radius invariant (constitution invariant 3).
 *
 * These tests drive a REAL `git commit` against a REAL temp repository with the actual
 * rendered hook installed — a source-text assertion on the template string would pass
 * against a hook that never runs, which is exactly the vacuous-green class the sibling
 * protected-branch-guard suite (pre-commit-protected-branch.test.ts) was written to avoid.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

import { MANAGED_REGION_TEMPLATES, MINSPEC_HOOKS_DIR, renderManagedFile } from '../src/lib/template-registry';
import { useShellTimeout } from './helpers/shell-timeout';

// #1285: spawns real child processes per assertion — 5s default is a load metric,
// not a hang signal. Enforced by shell-timeout-coverage.test.ts.
useShellTimeout();

const PRE_COMMIT = `${MINSPEC_HOOKS_DIR}/pre-commit`;
const template = () => MANAGED_REGION_TEMPLATES.find((t) => t.outputPath === PRE_COMMIT)!;

/** Env with ambient MinSpec bypasses stripped — a test opts into a bypass explicitly. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = { ...process.env };
  delete base.MINSPEC_GATE_OFF;
  delete base.EMAIL_GATE_OFF;
  return { ...base, ...extra };
}

function git(dir: string, args: string[], env?: NodeJS.ProcessEnv): void {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: env ?? cleanEnv() });
}

interface Repo {
  dir: string;
  /** Stage a change and attempt a commit as `authorEmail`. Returns exit code + stderr. */
  commit(message: string, authorEmail: string, env?: Record<string, string>): { code: number; stderr: string };
  cleanup(): void;
}

/**
 * A temp repo with the rendered pre-commit hook installed and NO remote at all, so the
 * unrelated protected-branch guard (Stage 0) can never fire here — nothing to push to
 * means nothing can be push-protected — and this suite exercises the identity gate
 * (Stage 1) in isolation.
 */
function makeRepo(): Repo {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-identity-gate-')));

  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.email', 'seed@example.com']);
  git(dir, ['config', 'user.name', 'Seed']);
  git(dir, ['config', 'commit.gpgsign', 'false']);

  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, ['add', 'seed.txt']);
  git(dir, ['commit', '-q', '-m', 'seed', '--no-verify']);

  const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, renderManagedFile(template()));
  fs.chmodSync(hookPath, 0o755);

  let n = 0;
  return {
    dir,
    commit(message, authorEmail, extraEnv = {}) {
      const file = `change-${++n}.txt`;
      fs.writeFileSync(path.join(dir, file), `${message}\n`);
      const env = cleanEnv({ ...extraEnv });
      git(dir, ['config', 'user.email', authorEmail], env);
      git(dir, ['add', file], env);
      try {
        execFileSync('git', ['commit', '-m', message], { cwd: dir, stdio: 'pipe', env });
        return { code: 0, stderr: '' };
      } catch (e: unknown) {
        const err = e as { status?: number; stderr?: Buffer };
        return { code: err.status ?? 1, stderr: String(err.stderr ?? '') };
      }
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function withRepo(fn: (r: Repo) => void): void {
  const repo = makeRepo();
  try {
    fn(repo);
  } finally {
    repo.cleanup();
  }
}

describe('pre-commit author identity gate — off by default', () => {
  it('ALLOWS any author email when minspec.allowedCommitEmails is unconfigured', () => {
    withRepo((repo) => {
      const r = repo.commit('unconfigured project', 'whoever@example.invalid');
      expect(r.code).toBe(0);
    });
  });
});

describe('pre-commit author identity gate — enforces a configured allowlist', () => {
  it('ALLOWS a commit whose user.email is in the allowlist', () => {
    withRepo((repo) => {
      git(repo.dir, ['config', 'minspec.allowedCommitEmails', 'linked@example.com']);
      const r = repo.commit('linked identity', 'linked@example.com');
      expect(r.code).toBe(0);
    });
  });

  it('BLOCKS a commit whose user.email is NOT in the allowlist', () => {
    withRepo((repo) => {
      git(repo.dir, ['config', 'minspec.allowedCommitEmails', 'linked@example.com']);
      const r = repo.commit('unlinked identity', 'ambient@example.com');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/ghost/i);
      expect(r.stderr).toContain('ambient@example.com');
      expect(r.stderr).toContain('git config user.email');
    });
  });

  it('leaves the commit UNMADE — the branch tip must not move on refusal', () => {
    withRepo((repo) => {
      git(repo.dir, ['config', 'minspec.allowedCommitEmails', 'linked@example.com']);
      const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim();
      repo.commit('unlinked identity', 'ambient@example.com');
      const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim();
      expect(after).toBe(before);
    });
  });

  it('honours a SPACE-SEPARATED allowlist of more than one address', () => {
    withRepo((repo) => {
      git(repo.dir, ['config', 'minspec.allowedCommitEmails', 'first@example.com second@example.com']);
      expect(repo.commit('second of two', 'second@example.com').code).toBe(0);
      expect(repo.commit('unrelated third', 'third@example.com').code).not.toBe(0);
    });
  });

  it('names the offending email and the full configured allowlist in the refusal', () => {
    withRepo((repo) => {
      git(repo.dir, ['config', 'minspec.allowedCommitEmails', 'a@example.com b@example.com']);
      const r = repo.commit('bad identity', 'c@example.com');
      expect(r.stderr).toContain('c@example.com');
      expect(r.stderr).toContain('a@example.com');
      expect(r.stderr).toContain('b@example.com');
    });
  });
});

describe('pre-commit author identity gate — documented escape hatch', () => {
  it('honours EMAIL_GATE_OFF=1 even against a configured, mismatched allowlist', () => {
    withRepo((repo) => {
      git(repo.dir, ['config', 'minspec.allowedCommitEmails', 'linked@example.com']);
      const r = repo.commit('bypassed', 'ambient@example.com', { EMAIL_GATE_OFF: '1' });
      expect(r.code).toBe(0);
    });
  });

  it('the existing whole-gate MINSPEC_GATE_OFF=1 bypass also covers this gate', () => {
    withRepo((repo) => {
      git(repo.dir, ['config', 'minspec.allowedCommitEmails', 'linked@example.com']);
      const r = repo.commit('bypassed via whole gate', 'ambient@example.com', { MINSPEC_GATE_OFF: '1' });
      expect(r.code).toBe(0);
    });
  });
});
