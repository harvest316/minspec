/**
 * T2 — Gate hook behavior (DR-012 / DR-031).
 * Shells out to scripts/hooks/spec-gate.sh with crafted PreToolUse envelopes
 * against a temp workspace, asserting allow/deny decisions.
 *
 * Hermetic by construction (DR-031 D4): every test `git init`s its OWN temp
 * workspace and writes its OWN `.minspec/approvals.json` there. The gate
 * resolves approvals from the canonical checkout via `git rev-parse
 * --git-common-dir`; because the temp dir IS its own git common dir, resolution
 * lands inside the temp workspace and can never reach the real repo's live
 * specs or shared `.minspec/`. This removes the ambient-state race (#146) — and
 * does so WITHOUT a config/env approvals-path override (which would reintroduce
 * an agent-settable bypass). env is pinned (gateEnv) and cwd is pinned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { hashContent } from '../src/lib/approval';

const HOOK = path.resolve(__dirname, '../../../scripts/hooks/spec-gate.sh');

let ws: string;

// Pin the child's environment to a minimal, deterministic set. We deliberately
// do NOT spread the whole ambient `process.env`: the gate reads env-driven
// signals (MINSPEC_GATE_OFF, PATH to bash/python3/git), so inheriting the
// parent's full env would let any stray/sibling-set variable leak into the gate
// and make this subprocess-shelling suite order-sensitive (#146). Only
// PATH/HOME/LANG are forwarded so bash + python3 + git resolve; per-test `env`
// overrides win on top. GIT_* are scrubbed (not forwarded) so a test runner
// launched from inside a git checkout cannot leak GIT_DIR/GIT_WORK_TREE into the
// hermetic temp repo.
function gateEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    ...env,
  };
}

// Initialise `dir` as a standalone git repo so the gate's canonical-store
// resolution (`git rev-parse --git-common-dir`) points back at `dir` itself
// (its own `.git`'s parent), never at the real repo. A commit is made so the
// repo can spawn linked worktrees (used by the canonical-resolution test).
function gitInit(dir: string): void {
  const opts = { cwd: dir, env: gateEnv({}), stdio: 'ignore' as const };
  execFileSync('git', ['init', '-q'], opts);
  execFileSync('git', ['config', 'user.email', 'gate-test@example.com'], opts);
  execFileSync('git', ['config', 'user.name', 'gate-test'], opts);
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], opts);
  // Mirror the real repo: approvals.json is per-machine local state, gitignored,
  // so `git worktree add` never copies it into a linked worktree. This is the
  // exact condition the canonical-resolution test must reproduce.
  fs.writeFileSync(path.join(dir, '.gitignore'), '.minspec/approvals.json\n');
  execFileSync('git', ['add', '-A'], opts);
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], opts);
}

function runGate(
  envelope: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
  childCwd: string = ws,
): { decision: string | null; raw: string } {
  // cwd is pinned to the per-test temp workspace both on the child process and
  // in the envelope, so the gate's `os.getcwd()` fallback can never reach the
  // real repo root, and its git-common-dir resolution stays inside the temp.
  const out = execFileSync('bash', [HOOK], {
    input: JSON.stringify(envelope),
    cwd: childCwd,
    env: gateEnv(env),
    encoding: 'utf-8',
  });
  const raw = out.trim();
  if (!raw) return { decision: null, raw };
  try {
    return { decision: JSON.parse(raw).hookSpecificOutput.permissionDecision, raw };
  } catch {
    return { decision: null, raw };
  }
}

function editEnvelope(relPath: string, cwd: string = ws): Record<string, unknown> {
  return { tool_name: 'Edit', cwd, tool_input: { file_path: relPath, old_string: 'a', new_string: 'b' } };
}

function writeSpecIn(root: string, id: string, tier: string, status: string): string {
  const p = path.join(root, 'specs', `${id}-x.md`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    `---\nid: ${id}\ntitle: X\ntier: ${tier}\nstatus: ${status}\ncreated: 2026-05-30\n---\n# ${id}\nbody\n`,
  );
  return p;
}

function writeSpec(id: string, tier: string, status: string): string {
  return writeSpecIn(ws, id, tier, status);
}

function approveIn(root: string, id: string, specPath: string, tier: string): void {
  const dir = path.join(root, '.minspec');
  fs.mkdirSync(dir, { recursive: true });
  const hash = hashContent(fs.readFileSync(specPath));
  const store = { [id]: { specHash: hash, approvedAt: '2026-05-30T00:00:00Z', tier } };
  fs.writeFileSync(path.join(dir, 'approvals.json'), JSON.stringify(store));
}

function approve(id: string, specPath: string, tier: string): void {
  approveIn(ws, id, specPath, tier);
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-gate-'));
  fs.mkdirSync(path.join(ws, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  // Make the workspace its OWN canonical git checkout so the gate resolves
  // approvals from here (hermetic), not from the real repo (DR-031 D4).
  gitInit(ws);
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

describe('spec-gate.sh', () => {
  it('allows edits to spec files always', () => {
    writeSpec('SPEC-001', 'T4', 'implementing'); // unapproved
    expect(runGate(editEnvelope('specs/SPEC-001-x.md')).decision).toBe('allow');
  });

  it('allows edits to markdown and docs', () => {
    writeSpec('SPEC-001', 'T4', 'implementing');
    expect(runGate(editEnvelope('docs/notes.md')).decision).toBe('allow');
    expect(runGate(editEnvelope('README.md')).decision).toBe('allow');
  });

  it('allows source edits when no T3/T4 implementing spec exists', () => {
    writeSpec('SPEC-001', 'T2', 'implementing'); // T2 not gated
    writeSpec('SPEC-002', 'T4', 'specifying'); // not implementing
    expect(runGate(editEnvelope('src/app.ts')).decision).toBe('allow');
  });

  it('DENIES source edits when a T3/T4 implementing spec is unapproved', () => {
    writeSpec('SPEC-007', 'T3', 'implementing');
    const r = runGate(editEnvelope('src/app.ts'));
    expect(r.decision).toBe('deny');
    expect(r.raw).toContain('SPEC-007');
  });

  it('allows source edits once the spec is approved (hash matches)', () => {
    const sp = writeSpec('SPEC-007', 'T3', 'implementing');
    approve('SPEC-007', sp, 'T3');
    expect(runGate(editEnvelope('src/app.ts')).decision).toBe('allow');
  });

  it('DENIES again (stale) when the spec is edited after approval', () => {
    const sp = writeSpec('SPEC-007', 'T3', 'implementing');
    approve('SPEC-007', sp, 'T3');
    fs.appendFileSync(sp, '\nedited after approval\n');
    const r = runGate(editEnvelope('src/app.ts'));
    expect(r.decision).toBe('deny');
    expect(r.raw).toContain('stale');
  });

  it('kill-switch MINSPEC_GATE_OFF=1 disables the gate', () => {
    writeSpec('SPEC-007', 'T3', 'implementing');
    const r = runGate(editEnvelope('src/app.ts'), { MINSPEC_GATE_OFF: '1' });
    expect(r.decision).toBeNull(); // empty output = allow
    expect(r.raw).toBe('');
  });

  it('kill-switch bypass is audited to canonical .minspec/gate-bypass.log', () => {
    writeSpec('SPEC-007', 'T3', 'implementing');
    runGate(editEnvelope('src/app.ts'), { MINSPEC_GATE_OFF: '1' });
    const log = path.join(ws, '.minspec', 'gate-bypass.log');
    expect(fs.existsSync(log)).toBe(true);
    const body = fs.readFileSync(log, 'utf-8');
    expect(body).toContain('tool=Edit');
    expect(body).toContain('src/app.ts');
    expect(body).toContain(`cwd=${ws}`);
  });

  it('ignores non-edit tools', () => {
    writeSpec('SPEC-007', 'T3', 'implementing');
    const r = runGate({ tool_name: 'Read', cwd: ws, tool_input: { file_path: 'src/app.ts' } });
    expect(r.decision).toBeNull();
  });

  it('resolves approvals from the canonical (parent) checkout for a linked worktree', () => {
    // Approve a gated spec in the CANONICAL checkout (ws) only — the worktree
    // never gets its own approvals.json (it is gitignored / not seeded).
    const sp = writeSpec('SPEC-007', 'T3', 'implementing');
    approve('SPEC-007', sp, 'T3');
    // Commit the spec so `git worktree add` materialises it in the worktree.
    const gitOpts = { cwd: ws, env: gateEnv({}), stdio: 'ignore' as const };
    execFileSync('git', ['add', '-A'], gitOpts);
    execFileSync('git', ['commit', '-q', '-m', 'add approved spec'], gitOpts);

    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-gate-wt-'));
    fs.rmSync(wt, { recursive: true, force: true }); // git worktree add needs a non-existing path
    execFileSync('git', ['worktree', 'add', '-q', wt, 'HEAD'], gitOpts);
    try {
      // The worktree has the spec (committed) but NO local approvals.json.
      expect(fs.existsSync(path.join(wt, '.minspec', 'approvals.json'))).toBe(false);
      expect(fs.existsSync(path.join(wt, 'specs', 'SPEC-007-x.md'))).toBe(true);
      // Editing source inside the worktree must resolve the canonical approval
      // (from ws) and ALLOW — the worktree-dispatch HITL soundness guarantee.
      const r = runGate(editEnvelope('src/app.ts', wt), {}, wt);
      expect(r.decision).toBe('allow');
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ws, env: gateEnv({}), stdio: 'ignore' });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});
