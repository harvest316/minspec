/**
 * `.githooks/pre-commit` — lockfile-sync gate (#1600, root-caused from #1589).
 *
 * The gap this closes: adding a workspace package changes what `npm ci` must
 * resolve, but nothing asserted that package.json and package-lock.json still
 * agree. #1589 added `packages/broker` without regenerating the lock. CI installs
 * with `npm ci`, which refuses an out-of-sync lock and exits BEFORE any job body
 * runs — so `DR id uniqueness`, `MinSpec SDD validation`, `lint` and `test` all
 * reported red without executing. The red was the ABSENCE of a result, not a
 * finding, which is the most misleading shape a failure can take: it names four
 * healthy subsystems and sends triage everywhere except the lockfile.
 *
 * These tests run the REAL `.githooks/pre-commit` (core.hooksPath points straight
 * at it). Asserting on the hook's source text would pass against a gate that
 * never runs — the standing lesson from the secret-gate suite.
 *
 * The lockfile fixture is hand-written rather than produced by `npm install`, so
 * the suite is deterministic and needs no registry. Both directions are pinned:
 * an in-sync fixture must PASS, or a gate that always fires would look like it
 * works.
 *
 * The last case is the #1040 lesson as a standing control: a per-gate bypass must
 * scope to ITS OWN gate and never fall through as a whole-hook `exit 0` — that is
 * constitution invariant 2 (no silent gate).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { useShellTimeout } from './helpers/shell-timeout';

useShellTimeout();

const REAL_HOOKS_DIR = path.resolve(__dirname, '../../../.githooks');

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-lock-gate-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (rel: string, body: string) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

/** A workspace root whose lock knows about exactly one member: packages/alpha. */
function initWorkspaceRepo(): void {
  const git = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
  // No remote, so the protected-branch guard correctly stays out of the way and
  // these assertions are about the lockfile gate alone.
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@minspec.test']);
  git(['config', 'user.name', 'MinSpec Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', REAL_HOOKS_DIR]);

  write('package.json', JSON.stringify({
    name: 'root', version: '1.0.0', private: true, workspaces: ['packages/*'],
  }) + '\n');
  write('packages/alpha/package.json', JSON.stringify({
    name: '@t/alpha', version: '0.0.1', private: true,
  }) + '\n');
  write('package-lock.json', JSON.stringify({
    name: 'root',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'root', version: '1.0.0', workspaces: ['packages/*'] },
      'node_modules/@t/alpha': { resolved: 'packages/alpha', link: true },
      'packages/alpha': { name: '@t/alpha', version: '0.0.1' },
    },
  }, null, 2) + '\n');
}

/** Add a workspace member the lock does not know about — the #1589 shape. */
function addUnlockedWorkspace(): void {
  write('packages/beta/package.json', JSON.stringify({
    name: '@t/beta', version: '0.0.1', private: true,
  }) + '\n');
}

const stage = (...files: string[]) =>
  execFileSync('git', ['add', ...files], { cwd: tmp, stdio: 'pipe' });

function commit(env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync('git', ['commit', '-m', 'test'], {
    cwd: tmp,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: `${r.stderr ?? ''}${r.stdout ?? ''}` };
}

/**
 * A PATH that provides every tool the hook needs EXCEPT the named one.
 *
 * Subtracting PATH entries cannot work here: `git` and `npm` share /usr/bin and
 * /bin on this machine, so dropping npm's directories also removes git and the
 * commit never runs. Worse, that layout differs per machine, so such a test
 * passes on one host and fails on another for reasons unrelated to the gate.
 * Instead, farm symlinks for every executable on PATH into one directory and
 * omit just the target — deterministic, and independent of how the host lays
 * out its binaries.
 */
function pathProvidingAllBut(...omit: string[]): string {
  const dir = path.join(tmp, `.shim-${omit.join('-')}`);
  fs.mkdirSync(dir, { recursive: true });
  const skip = new Set(omit);
  for (const src of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!src) continue;
    let names: string[];
    try {
      names = fs.readdirSync(src);
    } catch {
      continue;
    }
    for (const name of names) {
      if (skip.has(name)) continue;
      const link = path.join(dir, name);
      if (fs.existsSync(link)) continue; // first PATH entry wins, as a shell would
      try {
        fs.symlinkSync(path.join(src, name), link);
      } catch {
        /* unreadable entry — skip */
      }
    }
  }
  return dir;
}

/** An `npm` that records that it ran, so "was it invoked?" is checkable. */
function stubNpmRecording(marker: string): string {
  const dir = path.join(tmp, '.stub-bin');
  fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, 'npm');
  fs.writeFileSync(stub, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
  fs.chmodSync(stub, 0o755);
  return `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
}


/** An `npm` that fails with chosen output, to drive the gate's two skip branches. */
function stubNpmFailing(output: string): string {
  const dir = path.join(tmp, '.stub-npm-fail');
  fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, 'npm');
  fs.writeFileSync(stub, `#!/bin/sh\ncat <<'MINSPEC_STUB_EOF' >&2\n${output}\nMINSPEC_STUB_EOF\nexit 1\n`);
  fs.chmodSync(stub, 0o755);
  return `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
}

/** A failing `gitleaks`, to prove one gate's bypass does not disable another. */
function stubFailingGitleaks(): string {
  const dir = path.join(tmp, '.stub-bin2');
  fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, 'gitleaks');
  fs.writeFileSync(stub, `#!/bin/sh\necho 'RuleID: generic-api-key'\nexit 1\n`);
  fs.chmodSync(stub, 0o755);
  return `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
}

describe('.githooks/pre-commit lockfile-sync gate (#1600)', () => {
  it('BLOCKS a commit adding a workspace package the lock does not know', () => {
    initWorkspaceRepo();
    addUnlockedWorkspace();
    stage('package.json', 'package-lock.json', 'packages');

    const r = commit();

    expect(r.code).not.toBe(0);
    expect(r.out).toContain('lockfile gate');
    // Nothing was committed.
    expect(() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, stdio: 'pipe' })).toThrow();
  });

  it("shows npm's actual finding, not just a refusal (#1538)", () => {
    initWorkspaceRepo();
    addUnlockedWorkspace();
    stage('package.json', 'package-lock.json', 'packages');

    const r = commit();

    // The package that is actually missing must be named — a block with no
    // evidence just sends people to the bypass.
    expect(r.out).toContain('@t/beta');
    expect(r.out).toMatch(/npm install --package-lock-only/);
  });

  it('ALLOWS a commit when the lock IS in sync (the gate must not always fire)', () => {
    initWorkspaceRepo();
    stage('package.json', 'package-lock.json', 'packages');

    const r = commit();

    expect(r.out).not.toContain('✖ lockfile gate');
    expect(r.code).toBe(0);
  });

  it('does not invoke npm at all when the commit touches no manifest', () => {
    initWorkspaceRepo();
    // Land the manifests first so the working tree is clean and in sync.
    stage('package.json', 'package-lock.json', 'packages');
    commit();

    const marker = path.join(tmp, 'npm-was-called');
    write('docs/note.md', 'a docs-only change\n');
    stage('docs/note.md');
    const r = commit({ PATH: stubNpmRecording(marker) });

    expect(r.code).toBe(0);
    // Scoping is the whole reason an ordinary docs commit pays nothing.
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('WARNS and continues when npm is absent — an optional tool must not wedge a commit', () => {
    initWorkspaceRepo();
    addUnlockedWorkspace();
    stage('package.json', 'package-lock.json', 'packages');

    const r = commit({ PATH: pathProvidingAllBut('npm', 'npx') });

    expect(r.out).toContain('npm not installed');
    expect(r.code).toBe(0);
  });

  it('LOCK_GATE_OFF scopes to its own gate and does not disable the secret gate (#1040, invariant 2)', () => {
    initWorkspaceRepo();
    addUnlockedWorkspace();
    stage('package.json', 'package-lock.json', 'packages');

    const r = commit({ LOCK_GATE_OFF: '1', PATH: stubFailingGitleaks() });

    // The lockfile gate is off...
    expect(r.out).not.toContain('✖ lockfile gate');
    // ...but the unrelated secret gate still fires.
    expect(r.out).toContain('secret gate');
    expect(r.code).not.toBe(0);
  });

  it('stays QUIET when npm merely cannot resolve offline (cold cache is common and self-correcting)', () => {
    initWorkspaceRepo();
    addUnlockedWorkspace();
    stage('package.json', 'package-lock.json', 'packages');

    const r = commit({ PATH: stubNpmFailing('npm error code ENOTCACHED\nnpm error request to https://registry.npmjs.org/x failed') });

    expect(r.out).toContain('cache cannot answer offline');
    expect(r.out).not.toContain('LOCKFILE GATE DID NOT RUN');
    expect(r.code).toBe(0);
  });

  it('is LOUD when npm fails in a way the gate does not recognise (#1749)', () => {
    initWorkspaceRepo();
    addUnlockedWorkspace();
    stage('package.json', 'package-lock.json', 'packages');

    const r = commit({ PATH: stubNpmFailing('npm error code EUNKNOWN\nnpm error something nobody has seen before') });

    // A single warning line scrolls past; an unrun gate must be impossible to miss.
    expect(r.out).toContain('LOCKFILE GATE DID NOT RUN');
    expect(r.out).toContain('Your lock was NOT checked');
    // Still fails OPEN — loud, but it must not wedge the commit.
    expect(r.code).toBe(0);
  });

  it("CONTRACT: npm still emits the sync-error wording the gate matches (#1749)", () => {
    // The gate decides drift-vs-other by matching npm's prose. If an npm upgrade
    // reworded it, the drift branch would stop matching and every drifted commit
    // would fall into the loud branch — the gate silently disarmed. Pin it here so
    // that shows up as one honest test failure naming the cause.
    initWorkspaceRepo();
    addUnlockedWorkspace();

    const r = spawnSync('npm', ['ci', '--dry-run', '--offline', '--ignore-scripts'], {
      cwd: tmp,
      encoding: 'utf8',
    });
    const out = `${r.stderr ?? ''}${r.stdout ?? ''}`;

    expect(r.status, `npm should reject a drifted lock; got ${r.status}`).not.toBe(0);
    expect(
      out,
      'npm reworded its lock-sync error — update the grep in .githooks/pre-commit to match',
    ).toContain('can only install packages when your package.json and package-lock.json');
  });
});
