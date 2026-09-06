/**
 * T1/T2 — drain self-heals staleness (#773) + native auto-merge wiring (DR-061).
 *
 * The drain runs from the SHARED primary checkout, which goes stale as main advances
 * (auto-merge makes it advance faster). The OLD behaviour self-TERMINATED on staleness
 * (rc 43 → loop exit), so the drain died and auto-fix/dispatch never ran. #773 replaces
 * that with a self-synced run dir. These tests assert the safety-critical properties:
 *   • the run dir tracks origin/main even when the primary checkout is BEHIND (the
 *     functional self-heal — proved end-to-end against a real temp repo), and
 *   • the terminal "die on stale" path is gone, and
 *   • RULE #8: no git op mutates the primary checkout's HEAD/working tree, and
 *   • native auto-merge is gated by explicit project policy (deny-by-default).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { useShellTimeout } from './helpers/shell-timeout';

// #1285: spawns real child processes per assertion — 5s default is a load metric,
// not a hang signal. Enforced by shell-timeout-coverage.test.ts.
useShellTimeout();

const DRAIN = path.resolve(__dirname, '../../../scripts/drain-inbox.sh');
const DISPATCH = path.resolve(__dirname, '../../../scripts/dispatch-issue.sh');
const DRAIN_SRC = fs.readFileSync(DRAIN, 'utf-8');
const DISPATCH_SRC = fs.readFileSync(DISPATCH, 'utf-8');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

describe('drain-inbox.sh: run dir self-heals past a STALE primary (#773 functional)', () => {
  it('--refresh-run-dir syncs the run dir to origin/main even when the primary is behind', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-selfheal-'));
    try {
      const origin = path.join(root, 'origin.git');
      const primary = path.join(root, 'primary');
      const runDir = path.join(root, 'run');
      fs.mkdirSync(origin);
      git(origin, 'init', '--bare', '-b', 'main');

      // "primary" = the drain's checkout. Commit C1, push to origin/main.
      git(root, 'clone', origin, primary);
      fs.writeFileSync(path.join(primary, 'a.txt'), 'c1');
      git(primary, 'add', '.'); git(primary, 'commit', '-m', 'c1'); git(primary, 'push', 'origin', 'main');
      const c1 = git(primary, 'rev-parse', 'HEAD');

      // A SECOND clone advances origin/main to C2 — now `primary` is BEHIND (stale),
      // exactly the condition that used to kill the drain loop.
      const other = path.join(root, 'other');
      git(root, 'clone', origin, other);
      fs.writeFileSync(path.join(other, 'b.txt'), 'c2');
      git(other, 'add', '.'); git(other, 'commit', '-m', 'c2'); git(other, 'push', 'origin', 'main');
      const c2 = git(other, 'rev-parse', 'HEAD');
      expect(c2).not.toBe(c1);

      // Copy the drain script into the primary's scripts/ so SCRIPT_DIR (and thus
      // PRIMARY_ROOT) resolve to this temp checkout, not the real repo.
      fs.mkdirSync(path.join(primary, 'scripts'), { recursive: true });
      fs.copyFileSync(DRAIN, path.join(primary, 'scripts', 'drain-inbox.sh'));
      // drain-inbox.sh sources scripts/lib/gh-bot.sh at load (#1352) — copy it too,
      // or the script dies at line 1 and the case fails for an unrelated reason.
      fs.cpSync(path.join(path.dirname(DRAIN), 'lib'), path.join(primary, 'scripts', 'lib'), { recursive: true });

      const out = execFileSync('bash', [path.join(primary, 'scripts', 'drain-inbox.sh'), '--refresh-run-dir'], {
        encoding: 'utf-8',
        env: { ...process.env, MINSPEC_DRAIN_RUN_DIR: runDir },
      }).trim();

      // The run dir is synced to origin/main (C2) — the self-heal.
      expect(out).toContain(c2);
      expect(git(runDir, 'rev-parse', 'HEAD')).toBe(c2);
      // RULE #8: the primary checkout's HEAD is UNTOUCHED — still at the stale C1.
      expect(git(primary, 'rev-parse', 'HEAD')).toBe(c1);
    } finally {
      // Best-effort cleanup (worktree registration + dirs).
      try { execFileSync('git', ['-C', path.join(root, 'primary'), 'worktree', 'remove', path.join(root, 'run'), '--force'], { stdio: 'ignore' }); } catch { /* ignore */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('MINSPEC_DRAIN_SELF_REFRESH=0 opts out (runs in place, no run dir)', () => {
    const out = execFileSync('bash', [DRAIN, '--refresh-run-dir'], {
      encoding: 'utf-8',
      env: { ...process.env, MINSPEC_DRAIN_SELF_REFRESH: '0', MINSPEC_DRAIN_RUN_DIR: path.join(os.tmpdir(), 'nope-should-not-exist') },
    }).trim();
    expect(out).toBe('in-place');
  });
});

describe('drain-inbox.sh: the terminal "die on stale" path is gone (#773)', () => {
  it('no longer returns/handles rc 43 (the loop no longer stops on staleness)', () => {
    expect(DRAIN_SRC).not.toMatch(/return 43/);
    expect(DRAIN_SRC).not.toMatch(/^\s*43\)/m); // the run_loop case
  });

  it('run_cycle refreshes the run dir before dispatching', () => {
    expect(DRAIN_SRC).toContain('ensure_fresh_run_dir');
    // Called inside run_cycle (before Step 1 triage).
    const cycle = DRAIN_SRC.slice(DRAIN_SRC.indexOf('run_cycle() {'));
    expect(cycle.slice(0, 400)).toContain('ensure_fresh_run_dir');
  });
});

describe('drain-inbox.sh: RULE #8 — never mutate the primary checkout (#773)', () => {
  it('every git op in ensure_fresh_run_dir targets an explicit dir (-C) or worktree add', () => {
    const fn = DRAIN_SRC.slice(
      DRAIN_SRC.indexOf('ensure_fresh_run_dir() {'),
      DRAIN_SRC.indexOf('\n}', DRAIN_SRC.indexOf('ensure_fresh_run_dir() {')),
    );
    // Collect every actual `git` INVOCATION (skip comments: strip everything from
    // the first `#` on each line, so prose like "on any git error" is ignored).
    const gitCalls = fn
      .split('\n')
      .map((l) => l.replace(/#.*$/, ''))
      .filter((l) => /(^|[\s;&|(])git\s/.test(l))
      .map((l) => l.trim());
    expect(gitCalls.length).toBeGreaterThan(0);
    // Verbs that MUTATE a working tree / HEAD. Any of these MUST be -C-scoped to the
    // run dir — never the primary (and never bare, which uses CWD).
    const MUTATING = ['reset', 'clean', 'checkout', 'switch', 'pull', 'restore', 'merge', 'rebase', 'commit', 'stash'];
    for (const call of gitCalls) {
      const target = call.match(/git\s+-C\s+"?([^"\s]+)"?/)?.[1]; // e.g. $DRAIN_RUN_DIR / $PRIMARY_ROOT
      const verb = call.match(/git\s+(?:-C\s+\S+\s+)?([\w-]+)/)?.[1]; // [\w-]: keep `rev-parse` intact
      // Every op must be -C-scoped or a worktree op (worktree add/remove/prune act on
      // the .git admin, not the primary tree).
      expect(target !== undefined || call.includes('worktree'), `unscoped git op could hit CWD/primary: "${call}"`).toBe(true);
      // A MUTATING verb must target the RUN dir, never the primary.
      if (verb && MUTATING.includes(verb)) {
        expect(target, `mutating '${verb}' is not -C-scoped: "${call}"`).toBeDefined();
        expect(target, `mutating '${verb}' targets the primary checkout: "${call}"`).toContain('DRAIN_RUN_DIR');
        expect(target).not.toContain('PRIMARY_ROOT');
      }
      // The primary may ONLY be touched by read-only/admin verbs.
      if (target && target.includes('PRIMARY_ROOT')) {
        expect(['fetch', 'worktree', 'rev-parse'], `primary touched by mutating verb '${verb}': "${call}"`).toContain(verb);
      }
    }
  });
});

describe('dispatch-issue.sh: native auto-merge is policy-gated (DR-061)', () => {
  it('defines native_automerge_enabled reading env + config, default off', () => {
    expect(DISPATCH_SRC).toContain('native_automerge_enabled()');
    expect(DISPATCH_SRC).toContain('MINSPEC_AUTOMERGE_NATIVE');
    expect(DISPATCH_SRC).toContain('autoMerge.native');
  });

  it('arms `gh pr merge --auto` ONLY behind the policy gate', () => {
    // The --auto marking must sit INSIDE an open `if native_automerge_enabled; then`
    // block. (Block-membership, not char-proximity: the #833 approvable-doc exclusion
    // legitimately adds fail-closed + doc-check branches between the guard and the
    // arm, so a fixed-width window would false-positive while the invariant holds.)
    const idx = DISPATCH_SRC.indexOf('--squash --auto');
    expect(idx).toBeGreaterThan(-1);
    const guardIdx = DISPATCH_SRC.lastIndexOf('if native_automerge_enabled; then', idx);
    expect(guardIdx, 'no native_automerge_enabled guard precedes the --auto arm').toBeGreaterThan(-1);
    // No block-closing `fi` may appear between the guard and the arm (that would put
    // the arm OUTSIDE the policy gate). Nested `if ... then` without a `fi` is fine.
    const between = DISPATCH_SRC.slice(guardIdx, idx);
    expect(between, 'a `fi` closes the policy gate before the --auto arm').not.toMatch(/^\s*fi\s*$/m);
  });
});

// ── Containment guard regression (#773 review, BLOCKING) ──────────────────────
// A run dir that resolves INTO the primary (via symlink or `..`) must NOT be
// reset/removed — else `git -C "$DRAIN_RUN_DIR" reset --hard` would wipe the shared
// primary checkout. Prove the guard refuses and leaves the primary UNTOUCHED.
describe('drain-inbox.sh: containment guard blocks a run dir that resolves into the primary', () => {
  function stalePrimary(root: string): { primary: string; c1: string } {
    const origin = path.join(root, 'origin.git');
    const primary = path.join(root, 'primary');
    fs.mkdirSync(origin);
    git(origin, 'init', '--bare', '-b', 'main');
    git(root, 'clone', origin, primary);
    fs.writeFileSync(path.join(primary, 'a.txt'), 'c1');
    git(primary, 'add', '.'); git(primary, 'commit', '-m', 'c1'); git(primary, 'push', 'origin', 'main');
    // origin advances to c2 → primary is stale (has uncommitted-analogue work to protect).
    const other = path.join(root, 'other');
    git(root, 'clone', origin, other);
    fs.writeFileSync(path.join(other, 'b.txt'), 'c2');
    git(other, 'add', '.'); git(other, 'commit', '-m', 'c2'); git(other, 'push', 'origin', 'main');
    fs.mkdirSync(path.join(primary, 'scripts'), { recursive: true });
    fs.copyFileSync(DRAIN, path.join(primary, 'scripts', 'drain-inbox.sh'));
      // drain-inbox.sh sources scripts/lib/gh-bot.sh at load (#1352) — copy it too,
      // or the script dies at line 1 and the case fails for an unrelated reason.
      fs.cpSync(path.join(path.dirname(DRAIN), 'lib'), path.join(primary, 'scripts', 'lib'), { recursive: true });
    return { primary, c1: git(primary, 'rev-parse', 'HEAD') };
  }

  function runRefresh(scriptCwd: string, runDir: string): { code: number; err: string } {
    // spawnSync captures stderr regardless of exit code — the guard fires but exits 0.
    const r = spawnSync('bash', [path.join(scriptCwd, 'scripts', 'drain-inbox.sh'), '--refresh-run-dir'], {
      encoding: 'utf-8', env: { ...process.env, MINSPEC_DRAIN_RUN_DIR: runDir },
    });
    return { code: r.status ?? 1, err: String(r.stderr ?? '') };
  }

  it('a run dir SYMLINKED to the primary is refused — primary HEAD untouched (no reset)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-guard-'));
    try {
      const { primary, c1 } = stalePrimary(root);
      const evil = path.join(root, 'evil'); // symlink → the primary checkout
      fs.symlinkSync(primary, evil);
      const r = runRefresh(primary, evil);
      // Guard fired (self-refresh disabled), and the PRIMARY was NOT reset to c2.
      expect(r.err).toMatch(/self-refresh disabled|inside the primary|resolves to the primary/i);
      expect(git(primary, 'rev-parse', 'HEAD')).toBe(c1); // <-- the blocking regression
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a run dir with `..` segments resolving into the primary is refused', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-guard2-'));
    try {
      const { primary, c1 } = stalePrimary(root);
      const sneaky = path.join(primary, '..', path.basename(primary)); // == primary, via ..
      const r = runRefresh(primary, sneaky);
      expect(r.err).toMatch(/self-refresh disabled|inside the primary|resolves to the primary/i);
      expect(git(primary, 'rev-parse', 'HEAD')).toBe(c1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Native auto-merge deny-by-default, BEHAVIORAL (#773 review, MINOR) ─────────
// Grep tests can't catch a flipped default; drive native_automerge_enabled via the
// --check-native-automerge seam and assert the invariant behaviorally.
describe('dispatch-issue.sh: native auto-merge deny-by-default (behavioral seam)', () => {
  function check(env: Record<string, string>, scriptDir?: string): { code: number; out: string } {
    const script = scriptDir ? path.join(scriptDir, 'scripts', 'dispatch-issue.sh') : DISPATCH;
    try {
      const out = execFileSync('bash', [script, '--check-native-automerge'], {
        encoding: 'utf-8', env: { ...process.env, MINSPEC_AUTOMERGE_NATIVE: '', MINSPEC_AUTOMERGE_MODE: '', ...env }, stdio: 'pipe',
      });
      return { code: 0, out: out.trim() };
    } catch (e: any) {
      return { code: e.status ?? 1, out: String(e.stdout ?? '').trim() };
    }
  }

  it('env MINSPEC_AUTOMERGE_NATIVE=0 forces OFF even when this repo config has native=true', () => {
    // Catches deletion of the `0|false) return 1` env-override arm.
    expect(check({ MINSPEC_AUTOMERGE_NATIVE: '0' })).toEqual({ code: 1, out: 'off' });
  });

  it('env MINSPEC_AUTOMERGE_NATIVE=1 forces ON', () => {
    expect(check({ MINSPEC_AUTOMERGE_NATIVE: '1' })).toEqual({ code: 0, out: 'on' });
  });

  it('consequence-hybrid mode forces native OFF (mutual exclusion — stricter gate wins)', () => {
    expect(check({ MINSPEC_AUTOMERGE_NATIVE: '1', MINSPEC_AUTOMERGE_MODE: 'consequence-hybrid' })).toEqual({ code: 1, out: 'off' });
  });

  it('a project whose config.json has NO autoMerge.native key defaults OFF', () => {
    // Catches flipping `.autoMerge.native // false` → `// true`. Hermetic: copy the
    // dispatch script + its sourced lib + a config WITHOUT the key.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cfg-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
      fs.mkdirSync(path.join(root, '.minspec'), { recursive: true });
      fs.copyFileSync(DISPATCH, path.join(root, 'scripts', 'dispatch-issue.sh'));
      fs.copyFileSync(path.resolve(__dirname, '../../../scripts/lib/agent-egress.sh'), path.join(root, 'scripts', 'lib', 'agent-egress.sh'));
      // dispatch-issue.sh also sources lib/docs-corpus.sh at startup (#833) — copy it
      // too, or `source` aborts under `set -u` before the --check-native-automerge seam.
      fs.copyFileSync(path.resolve(__dirname, '../../../scripts/lib/docs-corpus.sh'), path.join(root, 'scripts', 'lib', 'docs-corpus.sh'));
      // dispatch-issue.sh sources lib/issue-lease.sh (SPEC-044 claim lease) at startup —
      // copy it too, else the source aborts before the --check-native-automerge seam.
      fs.copyFileSync(path.resolve(__dirname, '../../../scripts/lib/issue-lease.sh'), path.join(root, 'scripts', 'lib', 'issue-lease.sh'));
      // dispatch-issue.sh sources lib/workflow-paths.sh (#1120 workflows-push
      // preflight) at startup — same reason: a missing lib aborts the source before
      // the seam ever runs, and the failure looks like an empty answer, not an error.
      fs.copyFileSync(path.resolve(__dirname, '../../../scripts/lib/workflow-paths.sh'), path.join(root, 'scripts', 'lib', 'workflow-paths.sh'));
      // dispatch-issue.sh sources lib/agent-context.sh (the #912-recurrence
      // setting-sources pin) at startup — same reason again. The source is
      // deliberately NOT guarded by an `[[ -f ]]` test: a missing lib must abort
      // loudly, because silently dropping the flag restores the roster-thrash
      // outage it exists to prevent (no-silent-gate).
      fs.copyFileSync(path.resolve(__dirname, '../../../scripts/lib/agent-context.sh'), path.join(root, 'scripts', 'lib', 'agent-context.sh'));
      // dispatch-issue.sh sources lib/gh-bot.sh (#1355 bot attribution) at startup —
      // same reason once more. Sourcing it is offline and cannot fail; only an actual
      // GitHub WRITE mints, and this seam performs none.
      fs.copyFileSync(path.resolve(__dirname, '../../../scripts/lib/gh-bot.sh'), path.join(root, 'scripts', 'lib', 'gh-bot.sh'));
      // dispatch-issue.sh sources lib/autonomy.sh (#1614 DR-086 gate) at startup —
      // same reason again. Sourcing it spawns nothing; only an arm actually asking
      // `autonomy_may_merge` runs the TypeScript, and this seam asks nothing.
      fs.copyFileSync(path.resolve(__dirname, '../../../scripts/lib/autonomy.sh'), path.join(root, 'scripts', 'lib', 'autonomy.sh'));
      fs.writeFileSync(path.join(root, '.minspec', 'config.json'), JSON.stringify({ version: 1 })); // no autoMerge
      expect(check({}, root)).toEqual({ code: 1, out: 'off' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
