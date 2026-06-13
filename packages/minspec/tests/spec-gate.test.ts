/**
 * T2 — Gate hook behavior (DR-012 / DR-031, amended by SPEC-022 / DR-034).
 * Shells out to scripts/hooks/spec-gate.sh with crafted PreToolUse envelopes
 * against a temp workspace, asserting allow/deny decisions.
 *
 * SPEC-022: approvals are now COMMITTED, path-keyed sidecars under
 * `.minspec/approvals/<repo-relative-spec-path>.json`, hashed CANONICALLY, and
 * the gate reads them from cwd FIRST (the common-dir resolution is a fallback).
 * The gate derives status from {phases, approval}, not the literal `status:`.
 *
 * Hermetic by construction (DR-031 D4): every test `git init`s its OWN temp
 * workspace and writes its OWN sidecars there. The gate's cwd + env are pinned
 * (gateEnv / childCwd) so resolution can never reach the real repo's live specs
 * or shared `.minspec/`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { specHash } from '@aiclarity/shared';

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
  // SPEC-022: the approvals/ tree is COMMITTED (no longer gitignored), so a
  // committed sidecar is present in every clone/worktree/CI checkout by
  // construction (FR-1). No .gitignore for it.
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

/**
 * Map a desired DERIVED status to a phases block. The gate now derives status
 * from {phases, approval}; the literal `status:` line is just a mirror.
 *   - implementing → plan in-progress (derives implementing when approved,
 *     specifying when not — exactly the gated case)
 *   - specifying   → specify in-progress (never gated regardless of approval)
 *   - done         → all phases done
 */
function phasesFor(status: string): string {
  if (status === 'specifying') {
    return 'specify: in-progress\n  clarify: pending\n  plan: pending\n  tasks: pending\n  implement: pending';
  }
  if (status === 'done') {
    return 'specify: done\n  clarify: done\n  plan: done\n  tasks: done\n  implement: done';
  }
  // implementing (and any other) → mid-implementation
  return 'specify: done\n  clarify: skipped\n  plan: in-progress\n  tasks: pending\n  implement: pending';
}

function writeSpecIn(root: string, id: string, tier: string, status: string): string {
  const p = path.join(root, 'specs', `${id}-x.md`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    `---\nid: ${id}\ntitle: X\ntier: ${tier}\nstatus: ${status}\ncreated: 2026-05-30\nphases:\n  ${phasesFor(status)}\n---\n# ${id}\nbody\n`,
  );
  return p;
}

function writeSpec(id: string, tier: string, status: string): string {
  return writeSpecIn(ws, id, tier, status);
}

/**
 * Write a COMMITTED, path-keyed, canonically-hashed approval sidecar (FR-1/FR-2/
 * FR-3) under `<root>/.minspec/approvals/<repo-relative-spec-path>.json`.
 * `migrated` defaults false; pass true to exercise the WARN-phase migrated path.
 */
function approveIn(root: string, specPath: string, tier: string, migrated = false): void {
  const specRel = path.relative(root, specPath).split(path.sep).join('/');
  const sidecar = path.join(root, '.minspec', 'approvals', specRel + '.json');
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  const hash = specHash(fs.readFileSync(specPath, 'utf-8'));
  const record = {
    specPath: specRel,
    specHash: hash,
    approvedAt: '2026-05-30T00:00:00.000Z',
    approvedBy: 'gate-test@example.com',
    tier,
    migrated,
  };
  fs.writeFileSync(sidecar, JSON.stringify(record, null, 2) + '\n');
}

function approve(specPath: string, tier: string, migrated = false): void {
  approveIn(ws, specPath, tier, migrated);
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

  it('allows source edits once the spec is approved (canonical hash matches)', () => {
    const sp = writeSpec('SPEC-007', 'T3', 'implementing');
    approve(sp, 'T3');
    expect(runGate(editEnvelope('src/app.ts')).decision).toBe('allow');
  });

  it('a lifecycle-only edit (status flip) keeps approval — canonical hash unchanged', () => {
    const sp = writeSpec('SPEC-007', 'T3', 'implementing');
    approve(sp, 'T3');
    // Edit ONLY the literal status line — canonical hash excludes it, so approval
    // survives and the gate still allows.
    const txt = fs.readFileSync(sp, 'utf-8').replace('status: implementing', 'status: specifying');
    fs.writeFileSync(sp, txt);
    expect(runGate(editEnvelope('src/app.ts')).decision).toBe('allow');
  });

  it('DENIES again (stale) when the spec BODY is edited after approval', () => {
    const sp = writeSpec('SPEC-007', 'T3', 'implementing');
    approve(sp, 'T3');
    fs.appendFileSync(sp, '\nedited after approval\n');
    const r = runGate(editEnvelope('src/app.ts'));
    expect(r.decision).toBe('deny');
    expect(r.raw).toContain('stale');
  });

  it('a migrated:true sidecar ALLOWS in the WARN phase but surfaces a re-approve note', () => {
    const sp = writeSpec('SPEC-007', 'T3', 'implementing');
    approve(sp, 'T3', /* migrated */ true);
    const r = runGate(editEnvelope('src/app.ts'));
    expect(r.decision).toBe('allow');
    expect(r.raw).toContain('migrated');
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

  it('a linked worktree reads its OWN committed sidecar (FR-1 — no common-dir needed)', () => {
    // SPEC-022 FR-1: the approvals/ tree is COMMITTED, so `git worktree add`
    // MATERIALISES the sidecar in the worktree. The gate reads it from the
    // worktree's own cwd — the load-bearing common-dir hop is gone.
    const sp = writeSpec('SPEC-007', 'T3', 'implementing');
    approve(sp, 'T3');
    // Commit the spec AND its committed sidecar so the worktree gets both.
    const gitOpts = { cwd: ws, env: gateEnv({}), stdio: 'ignore' as const };
    execFileSync('git', ['add', '-A'], gitOpts);
    execFileSync('git', ['commit', '-q', '-m', 'add approved spec + sidecar'], gitOpts);

    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-gate-wt-'));
    fs.rmSync(wt, { recursive: true, force: true }); // git worktree add needs a non-existing path
    execFileSync('git', ['worktree', 'add', '-q', wt, 'HEAD'], gitOpts);
    try {
      // The committed sidecar IS present in the worktree (FR-1 by construction).
      const wtSidecar = path.join(wt, '.minspec', 'approvals', 'specs', 'SPEC-007-x.md.json');
      expect(fs.existsSync(wtSidecar)).toBe(true);
      expect(fs.existsSync(path.join(wt, 'specs', 'SPEC-007-x.md'))).toBe(true);
      // Editing source inside the worktree resolves its OWN sidecar and ALLOWs.
      const r = runGate(editEnvelope('src/app.ts', wt), {}, wt);
      expect(r.decision).toBe('allow');
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ws, env: gateEnv({}), stdio: 'ignore' });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});
