/**
 * T1 — the autonomy banner (DR-086 surfacing).
 *
 * The banner exists so the stop list ARRIVES rather than being recalled. That
 * only works if it is derived from the resolver: a hand-maintained copy would
 * drift from STOP_CLASSES silently and read as authoritative while being wrong —
 * a false signpost, which in a never-wrong product is the worst defect.
 *
 * These assert derivation, not wording.
 */
import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { STOP_CLASSES } from '../../../scripts/lib/autonomy';

// Every test here spawns `npx tsx`, which can queue well past vitest's 5s default
// under container contention — the flake tracked as #1099, which also wipes the
// coverage report when it fires. Same 30s budget every other subprocess suite uses.
//
// Deliberately at MODULE level, not inside beforeAll: vi.setConfig() in a hook is
// inert, so a suite can carry the line and still run on the 5s default.
vi.setConfig({ testTimeout: 30_000 });

const REPO = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO, 'scripts', 'autonomy-status.ts');
const HOOK = path.join(REPO, 'scripts', 'hooks', 'session-start.sh');
const UNIT = path.join(REPO, 'scripts', 'hooks', 'session-autonomy.sh');

function run(env: Record<string, string> = {}): string {
  return execFileSync('npx', ['tsx', SCRIPT, REPO], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

describe('autonomy-status — reflects the resolver', () => {
  it('reports ask from the CONFIG path, with no override defined at all', () => {
    // Own fixture .minspec/config.json with no `autonomy` key — this pins the
    // resolver's no-key-present path itself, not this repo's live config value
    // (which is governance state that changes independently of this suite, e.g.
    // #1799 setting it to `act`). Passed as the script's `repoRoot` arg instead
    // of REPO so the CONFIG path under test is the fixture's, not the repo's own.
    //
    // MINSPEC_AUTONOMY:'' is not "unset" — readAutonomy returns early on any
    // DEFINED override, so an empty string exercised the override branch and the
    // config-file default was never reached. Only deleting the key tests it.
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-status-nokey-'));
    fs.mkdirSync(path.join(fixture, '.minspec'));
    try {
      fs.writeFileSync(path.join(fixture, '.minspec', 'config.json'), JSON.stringify({}));
      const env = { ...process.env };
      delete env.MINSPEC_AUTONOMY;
      const out = execFileSync('npx', ['tsx', SCRIPT, fixture], { encoding: 'utf-8', env });
      expect(out).toMatch(/Autonomy: ask/);
      expect(out).toMatch(/human/i);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('an empty override is a defined value, and still resolves to ask', () => {
    expect(run({ MINSPEC_AUTONOMY: '' })).toMatch(/Autonomy: ask/);
  });

  it('reports act when the setting resolves to act', () => {
    const out = run({ MINSPEC_AUTONOMY: 'act' });
    expect(out).toMatch(/Autonomy: act/);
  });

  it('a non-token value reports ask — the banner cannot claim more autonomy than the resolver grants', () => {
    for (const v of ['ACT', 'true', 'yes', 'auto']) {
      expect(run({ MINSPEC_AUTONOMY: v })).toMatch(/Autonomy: ask/);
    }
  });
});

describe('autonomy-status — the list is DERIVED, not restated', () => {
  it.each(STOP_CLASSES.map((s) => s.id))('prints %s in both modes', (id) => {
    expect(run({ MINSPEC_AUTONOMY: '' })).toContain(id);
    expect(run({ MINSPEC_AUTONOMY: 'act' })).toContain(id);
  });

  it('prints EXACTLY the classes the module defines — no extras, none missing', () => {
    // This is the anti-drift assertion. A hardcoded copy passes the per-id tests
    // above while silently disagreeing the moment STOP_CLASSES changes; comparing
    // the full set is what actually catches that.
    const out = run({ MINSPEC_AUTONOMY: 'act' });
    const printed = out
      .split('\n')
      .flatMap((l) => l.split('·'))
      .map((s) => s.trim())
      .filter((s) => /^[a-z-]+$/.test(s) && s.includes('-'));
    const expected = STOP_CLASSES.map((s) => s.id);
    for (const id of expected) expect(printed).toContain(id);
    // Nothing printed in the class position that is not a real class.
    for (const p of printed) expect(expected).toContain(p);
  });

  it('does not hardcode the count in prose (a number goes stale silently)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf-8');
    expect(src).not.toMatch(/\bsix\b|\b6 (classes|stop)/i);
  });
});

describe('session-start hook wiring', () => {
  const hook = fs.readFileSync(HOOK, 'utf-8');

  it('the unit invokes the printer', () => {
    expect(fs.readFileSync(UNIT, 'utf-8')).toContain('autonomy-status.ts');
  });

  it('is non-fatal — a broken printer must never wedge a session start', () => {
    expect(fs.readFileSync(UNIT, 'utf-8')).toMatch(/\|\| true/);
    expect(hook).toMatch(/\|\| true/);
  });

  it('derives its root from the script location, so it is right in every worktree', () => {
    expect(fs.readFileSync(UNIT, 'utf-8')).toContain('BASH_SOURCE');
    // A hardcoded path or an undefined REPO_ROOT would silently no-op — the
    // banner would simply stop appearing, which looks identical to "autonomy is
    // off" rather than to a broken hook.
    expect(hook).toContain('BASH_SOURCE');
  });

  it('the extracted unit actually emits the banner when EXECUTED', () => {
    // Executed, not grepped: a source-text assertion passes just as happily
    // against dead wiring. But it runs session-autonomy.sh, NOT session-start.sh
    // — the full hook writes $GIT_DIR/.claude-last-branch, can launch the
    // tooling radar (which files GitHub issues) and the inbox drain (which can
    // dispatch agents). A unit test must not have outward-facing side effects.
    const out = execFileSync('bash', [UNIT], { encoding: 'utf-8', cwd: REPO });
    expect(out).toMatch(/Autonomy: (ask|act)/);
  });

  it('session-start delegates to that unit, so the executed path is the wired one', () => {
    // The one remaining source-text check, and it is narrow: the risky half
    // (does the printer work?) is proven by execution above.
    expect(hook).toContain('session-autonomy.sh');
  });
});
