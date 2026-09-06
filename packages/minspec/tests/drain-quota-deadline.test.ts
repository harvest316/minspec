/**
 * T0 — the 5-hour quota gate is a DEADLINE, not a flag.
 *
 * The drain must not admit a unit of work into a window too small to finish it,
 * and must resume when the window resets without anybody delivering a signal.
 *
 * Why a deadline and not a paused/unpaused flag: a flag needs someone to clear
 * it, which needs a resume signal, which is read on the very channel the pause
 * is meant to gate — so it is evaluated after the condition it describes has
 * already flipped. An epoch needs nobody: every consumer compares `now` against
 * resets_at locally, at the moment it matters.
 *
 * The load-bearing invariants, in priority order:
 *   INV-A  a missing / stale / unparseable reading FAILS CLOSED (defers) — an
 *          unknown budget must never read as permission to spend it (#1775;
 *          constitution invariant 2). This inverted the ORIGINAL INV-A, which
 *          read "FAILS OPEN (never wedges work)" — that was the bug: run_loop
 *          already treats a 42 defer as a pause, not a wedge, so failing open
 *          bought nothing but a silently-overspent quota.
 *   INV-B  a defer is AUDIBLE — it always names why, and a fail-closed defer
 *          also names the quota file, so a chronically-missing reading is
 *          diagnosable from one log line (no silent throttle)
 *   INV-C  the gate needs no network: no gh, no curl, no claude
 *   INV-D  the sleep is derived from resets_at, never a fixed guess, never negative
 *   INV-E  BOOTSTRAP is bounded, not fail-open reborn: a machine that has NEVER
 *          produced a reading gets a small, EXPLICIT, ONE-TIME allowance
 *          (QUOTA_BOOTSTRAP_ADMITS, default 3) to admit blind, because the only
 *          reactive producer on a headless/VS Code machine (quota_publish_wall)
 *          fires from INSIDE a dispatch this gate would otherwise prevent from
 *          ever running — plain fail-closed here is a permanent deadlock, not
 *          caution (#1775 review, BLOCKING). The instant a REAL reading is ever
 *          observed, the allowance is pinned exhausted forever (graduation),
 *          even if that reading later goes missing or stale again — "signal
 *          lost" must still fail closed exactly like INV-A. Most of the INV-A/B
 *          tests below pin MINSPEC_QUOTA_BOOTSTRAP_ADMITS=0 specifically so they
 *          keep testing the pure fail-closed invariant in isolation from this
 *          carve-out; the "bootstrap allowance" describe block below tests INV-E
 *          on its own, at the real default.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const DRAIN = path.resolve(__dirname, '../../../scripts/drain-inbox.sh');
const nowSec = () => Math.floor(Date.now() / 1000);

let tmpDir: string;
let quotaFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-gate-'));
  quotaFile = path.join(tmpDir, 'quota.json');
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [DRAIN, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, MINSPEC_QUOTA_FILE: quotaFile, ...env },
    });
    return { code: 0, out: out.trim() };
  } catch (e: any) {
    return { code: e.status ?? 1, out: (((e.stdout ?? '') as string) + ((e.stderr ?? '') as string)).trim() };
  }
}

function write(q: Partial<{ used_percentage: number; resets_at: number; observed_at: number }>) {
  fs.writeFileSync(quotaFile, JSON.stringify({ observed_at: nowSec(), ...q }));
}

describe('drain-inbox.sh --quota-gate — INV-A/INV-B: unknown state fails CLOSED, audibly', () => {
  // These four pin MINSPEC_QUOTA_BOOTSTRAP_ADMITS=0 to disable the INV-E carve-out
  // (see the top doc comment) and test the pure fail-closed invariant in isolation.
  // Without the override, a FRESH tmpDir has never produced a reading, so these
  // would legitimately bootstrap-admit instead of defer — that behaviour has its
  // own describe block below ("the bootstrap allowance") rather than being folded
  // in here, so this block keeps testing exactly one thing.
  const noBootstrap = { MINSPEC_QUOTA_BOOTSTRAP_ADMITS: '0' };

  it('no file at all → DEFER (exit 42), says why, and names the quota file', () => {
    const r = run(['--quota-gate'], noBootstrap);
    expect(r.code).toBe(42);
    expect(r.out).toMatch(/^defer:/);
    expect(r.out).toMatch(/no-reading/);
    expect(r.out).toContain(quotaFile);
  });

  it('an unreadable file (permission denied) → DEFER, same as missing', () => {
    write({ used_percentage: 1, resets_at: nowSec() + 3600 });
    fs.chmodSync(quotaFile, 0o000);
    let readable = true;
    try { fs.accessSync(quotaFile, fs.constants.R_OK); } catch { readable = false; }
    try {
      // Root (common in containers) ignores file permissions, so chmod cannot make
      // the file unreadable to this process there — skip rather than assert nothing.
      if (!readable) {
        const r = run(['--quota-gate'], noBootstrap);
        expect(r.code).toBe(42);
        expect(r.out).toMatch(/^defer:/);
        expect(r.out).toMatch(/no-reading/);
      }
    } finally {
      fs.chmodSync(quotaFile, 0o644);
    }
  });

  it('unparseable garbage → DEFER, not a crash and not a silent admit', () => {
    fs.writeFileSync(quotaFile, 'not json at all {{{');
    const r = run(['--quota-gate'], noBootstrap);
    expect(r.code).toBe(42);
    expect(r.out).toMatch(/^defer:/);
    expect(r.out).toMatch(/no-reading/);
  });

  it('a reading with fields missing → DEFER', () => {
    fs.writeFileSync(quotaFile, JSON.stringify({ observed_at: nowSec() }));
    expect(run(['--quota-gate'], noBootstrap).code).toBe(42);
  });

  it('STALE reading → DEFER even though the percentage is way over the bar (the staleness, not the level, is what deferred it — see the control below)', () => {
    // 99% used, but observed hours ago: nobody has looked since, so it proves nothing.
    write({ used_percentage: 99, resets_at: nowSec() + 3600, observed_at: nowSec() - 86400 });
    const r = run(['--quota-gate']);
    expect(r.code).toBe(42);
    expect(r.out).toMatch(/^defer:/);
    expect(r.out).toMatch(/stale/);
    expect(r.out).toContain(quotaFile);
  });

  it('CONTROL: a fresh reading well under the bar still ADMITS — the gate is not simply denying everything', () => {
    write({ used_percentage: 5, resets_at: nowSec() + 3600 });
    const r = run(['--quota-gate']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^open:/);
  });

  it('resets_at already in the past → open (the window reset itself)', () => {
    write({ used_percentage: 99, resets_at: nowSec() - 60 });
    const r = run(['--quota-gate']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/window-reset/);
  });
});

describe('drain-inbox.sh --quota-gate — the actual admission decision', () => {
  it('plenty of window left → open', () => {
    write({ used_percentage: 12, resets_at: nowSec() + 3600 });
    const r = run(['--quota-gate']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^open:/);
  });

  it('over the bar with the window still running → DEFER (exit 42)', () => {
    write({ used_percentage: 95, resets_at: nowSec() + 3600 });
    const r = run(['--quota-gate']);
    expect(r.code).toBe(42);
    expect(r.out).toMatch(/^defer:/);
  });

  it('exactly at the bar defers; one under it does not (boundary is not off by one)', () => {
    write({ used_percentage: 90, resets_at: nowSec() + 3600 });
    expect(run(['--quota-gate'], { MINSPEC_QUOTA_ADMIT_PCT: '90' }).code).toBe(42);
    write({ used_percentage: 89, resets_at: nowSec() + 3600 });
    expect(run(['--quota-gate'], { MINSPEC_QUOTA_ADMIT_PCT: '90' }).code).toBe(0);
  });

  it('the bar is tunable, so a caller can be more or less cautious than the default', () => {
    write({ used_percentage: 50, resets_at: nowSec() + 3600 });
    expect(run(['--quota-gate'], { MINSPEC_QUOTA_ADMIT_PCT: '40' }).code).toBe(42);
    expect(run(['--quota-gate'], { MINSPEC_QUOTA_ADMIT_PCT: '99' }).code).toBe(0);
  });

  it('a fractional percentage is handled, not treated as garbage', () => {
    write({ used_percentage: 95.7, resets_at: nowSec() + 3600 });
    expect(run(['--quota-gate']).code).toBe(42);
  });
});

describe('drain-inbox.sh --quota-sleep — INV-D: sleep to the deadline, never a guess', () => {
  it('sleeps the distance to resets_at, not the fixed fallback', () => {
    write({ used_percentage: 95, resets_at: nowSec() + 600 });
    const secs = Number(run(['--quota-sleep']).out);
    // ~600s plus a small settling margin — emphatically not the 1800s fallback.
    expect(secs).toBeGreaterThanOrEqual(600);
    expect(secs).toBeLessThan(900);
  });

  it('with NO reading, falls back to the fixed backoff rather than sleeping 0 and spinning', () => {
    const secs = Number(run(['--quota-sleep'], { MINSPEC_DRAIN_QUOTA_BACKOFF: '1800' }).out);
    expect(secs).toBe(1800);
  });

  it('a reset already in the past never yields a negative or zero sleep', () => {
    write({ used_percentage: 99, resets_at: nowSec() - 5000 });
    const secs = Number(run(['--quota-sleep']).out);
    expect(secs).toBeGreaterThan(0);
  });

  it('is clamped so a corrupt far-future epoch cannot park the drain for a week', () => {
    write({ used_percentage: 99, resets_at: nowSec() + 999999999 });
    const secs = Number(run(['--quota-sleep']).out);
    expect(secs).toBeLessThanOrEqual(6 * 3600);
  });

  it('always prints a bare integer — it is fed straight to sleep', () => {
    write({ used_percentage: 95, resets_at: nowSec() + 600 });
    expect(run(['--quota-sleep']).out).toMatch(/^\d+$/);
    expect(run(['--quota-sleep'], { MINSPEC_QUOTA_FILE: '/nonexistent/x.json' }).out).toMatch(/^\d+$/);
  });
});

describe('drain-inbox.sh --quota-gate — INV-C: decides offline', () => {
  it('still decides correctly with gh, curl and claude sabotaged on PATH', () => {
    // Not a source-text assertion: a grep for "no gh call" passes vacuously if the
    // call is spelled differently. This puts poisoned binaries EARLIER on PATH, so
    // any network reach-out fails loudly and the verdict would change.
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    for (const tool of ['gh', 'curl', 'claude', 'wget']) {
      const p = path.join(binDir, tool);
      fs.writeFileSync(p, '#!/bin/sh\necho "NETWORK CALL: ' + tool + '" >&2\nexit 99\n');
      fs.chmodSync(p, 0o755);
    }
    write({ used_percentage: 95, resets_at: nowSec() + 3600 });
    const r = run(['--quota-gate'], { PATH: `${binDir}:${process.env.PATH}` });
    expect(r.code).toBe(42);
    expect(r.out).not.toMatch(/NETWORK CALL/);
  });
});

describe('drain-inbox.sh --quota-publish-wall — the reactive producer', () => {
  // The statusline publisher only runs when a statusline RENDERS, which VS Code and
  // headless sessions never do — so on this machine it never fires and the gate sits
  // inert. The wall message is the one reading that is always available, because it
  // arrives exactly when the window is exhausted. It carries a clock time and a zone
  // but no date, so the rollover has to be inferred.
  const at = (text: string, env: Record<string, string> = {}) => {
    try {
      const out = execFileSync('bash', [DRAIN, '--quota-publish-wall'], {
        input: text, encoding: 'utf-8',
        env: { ...process.env, MINSPEC_QUOTA_FILE: quotaFile, ...env },
      });
      return { code: 0, out: out.trim() };
    } catch (e: any) {
      return { code: e.status ?? 1, out: (((e.stdout ?? '') as string) + ((e.stderr ?? '') as string)).trim() };
    }
  };
  const read = () => JSON.parse(fs.readFileSync(quotaFile, 'utf-8'));

  it('extracts the reset from the real wall message and publishes a FUTURE epoch', () => {
    const r = at("You've hit your session limit · resets 10:10pm (Australia/Sydney)");
    expect(r.code).toBe(0);
    const q = read();
    expect(q.resets_at).toBeGreaterThan(nowSec());
    // At the wall the window is by definition spent; the gate must then defer.
    expect(q.used_percentage).toBeGreaterThanOrEqual(100);
  });

  it('rolls over to tomorrow when the named time has already passed today', () => {
    // 00:01 is in the past for all but one minute of the day, so a naive parse would
    // publish an epoch behind `now` and the gate would read it as window-reset.
    const r = at("You've hit your session limit · resets 12:01am (Australia/Sydney)");
    expect(r.code).toBe(0);
    expect(read().resets_at).toBeGreaterThan(nowSec());
  });

  it('honours the timezone in the message rather than the machine zone', () => {
    at("You've hit your session limit · resets 10:10pm (Australia/Sydney)");
    const sydney = read().resets_at;
    fs.rmSync(quotaFile, { force: true });
    at("You've hit your session limit · resets 10:10pm (America/New_York)");
    expect(read().resets_at).not.toBe(sydney);
  });

  it('ignores text that is not a wall message, and writes nothing', () => {
    const r = at('build failed: TypeError at foo.ts:12');
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(quotaFile)).toBe(false);
  });

  it('never publishes a reset further out than one day (a bad parse cannot park the drain)', () => {
    at("You've hit your session limit · resets 11:59pm (Australia/Sydney)");
    expect(read().resets_at - nowSec()).toBeLessThanOrEqual(86400 + 60);
  });

  it('the published file is immediately readable by the gate, which defers on it', () => {
    at("You've hit your session limit · resets 11:59pm (Australia/Sydney)");
    expect(run(['--quota-gate']).code).toBe(42);
  });
});

describe('drain-inbox.sh --quota-health — an inert gate must not be silent', () => {
  // With the bootstrap allowance EXHAUSTED (or disabled — pinned here so this test
  // is about the true fail-closed end state, not INV-E's bootstrap window; see the
  // "bootstrap allowance" describe block below for that), a missing reading HOLDS
  // the gate shut (fails closed, #1775) rather than admitting blind, but that hold
  // is still uninformed — it isn't weighing a real usage number. A blind-and-holding
  // gate and a healthy one still look identical from the outside; this is the seam
  // that tells them apart.
  it('says INERT when there is no reading and bootstrap is exhausted, naming that it fails CLOSED', () => {
    const r = run(['--quota-health'], { MINSPEC_QUOTA_FILE: '/nonexistent/x.json', MINSPEC_QUOTA_BOOTSTRAP_ADMITS: '0' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^inert:/);
    expect(r.out).toMatch(/failing closed/i);
  });

  it('says INERT when the reading is stale rather than reporting a stale number as live', () => {
    write({ used_percentage: 50, resets_at: nowSec() + 3600, observed_at: nowSec() - 86400 });
    expect(run(['--quota-health']).out).toMatch(/^inert:/);
  });

  it('says LIVE with the actual numbers when a fresh reading exists', () => {
    write({ used_percentage: 42, resets_at: nowSec() + 3600 });
    const r = run(['--quota-health']);
    expect(r.out).toMatch(/^live:/);
    expect(r.out).toContain('42%');
  });

  it('reports but never gates — exit 0 in every state', () => {
    expect(run(['--quota-health'], { MINSPEC_QUOTA_FILE: '/nonexistent/x.json' }).code).toBe(0);
    write({ used_percentage: 99, resets_at: nowSec() + 3600 });
    expect(run(['--quota-health']).code).toBe(0);
  });
});

describe('drain-inbox.sh --quota-gate — INV-E: the bootstrap allowance (a machine that has NEVER seen a reading)', () => {
  // This is the #1775-review BLOCKING finding: plain fail-closed on "no reading"
  // deadlocks a fresh machine forever, because the only producer that could break
  // the tie on a headless/VS Code box (quota_publish_wall) fires from INSIDE a
  // dispatch this gate would otherwise prevent from ever running. See quota_gate's
  // doc comment ("WORST CASE while blind") for the exact bound this allowance puts
  // on that blind spot.

  it('a fresh environment that has NEVER had a reading ADMITS via the bounded bootstrap allowance — the drain can reach a first dispatch', () => {
    const r = run(['--quota-gate']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^open:bootstrap 1\/3/);
    expect(r.out).toContain(quotaFile);
  });

  it('grants exactly QUOTA_BOOTSTRAP_ADMITS admits, counting up, then refuses outright and names what to install', () => {
    expect(run(['--quota-gate']).out).toMatch(/^open:bootstrap 1\/3/);
    expect(run(['--quota-gate']).out).toMatch(/^open:bootstrap 2\/3/);
    expect(run(['--quota-gate']).out).toMatch(/^open:bootstrap 3\/3/);
    const r = run(['--quota-gate']);
    expect(r.code).toBe(42);
    expect(r.out).toMatch(/^defer:no-reading/);
    expect(r.out).toMatch(/bootstrap allowance is exhausted/);
    expect(r.out).toMatch(/quota-publish-wall/); // names what to install, not just "install something"
  });

  it('the allowance is tunable, and 0 disables it entirely — pure fail-closed, the state before this fix', () => {
    const r = run(['--quota-gate'], { MINSPEC_QUOTA_BOOTSTRAP_ADMITS: '0' });
    expect(r.code).toBe(42);
    expect(r.out).toMatch(/^defer:no-reading/);
  });

  it('once a REAL reading has ever existed, the bootstrap allowance is retired FOREVER — it does not re-open when the reading is later lost', () => {
    // Consume exactly ONE of the three admits.
    expect(run(['--quota-gate']).out).toMatch(/^open:bootstrap 1\/3/);
    // A real reading now appears — e.g. another session's statusline render, or
    // this bootstrap dispatch's own eventual usage-limit hit via quota_publish_wall
    // — with plenty of window left.
    write({ used_percentage: 5, resets_at: nowSec() + 3600 });
    expect(run(['--quota-gate']).out).toMatch(/^open:5% of the 5h window used/);
    // The reading disappears again — #1775's actual "signal lost" scenario.
    fs.rmSync(quotaFile, { force: true });
    // TWO of the three bootstrap admits were never consumed. A naive "count
    // successes, not attempts" design would let them be spent now — graduation
    // must block that: this is exactly the state #1775 requires to fail closed.
    const r = run(['--quota-gate']);
    expect(r.code).toBe(42);
    expect(r.out).toMatch(/^defer:no-reading/);
    expect(r.out).toMatch(/bootstrap allowance is exhausted/);
  });

  it('a STALE reading still DEFERS even on a machine that has never bootstrapped — staleness is a REAL reading, not the "never had one" state', () => {
    // 99% used, but observed a day ago: _quota_read SUCCEEDS (this graduates the
    // allowance) before staleness is even checked, so bootstrap never applies here.
    write({ used_percentage: 99, resets_at: nowSec() + 3600, observed_at: nowSec() - 86400 });
    const r = run(['--quota-gate']);
    expect(r.code).toBe(42);
    expect(r.out).toMatch(/^defer:stale/);
    expect(r.out).not.toMatch(/bootstrap/);
  });

  it('CONTROL: a fresh reading well under the bar still ADMITS normally, not via bootstrap', () => {
    write({ used_percentage: 5, resets_at: nowSec() + 3600 });
    const r = run(['--quota-gate']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^open:5% of the 5h window used/);
    expect(r.out).not.toMatch(/bootstrap/);
  });

  it('a bootstrap sidecar that cannot be written REFUSES to admit, rather than granting an admit it cannot remember granting', () => {
    // The directory itself does not exist, so "<quotaFile>.bootstrap" can never be
    // created either — an unbounded free pass would be worse than no allowance at
    // all, because it could never self-exhaust.
    const r = run(['--quota-gate'], { MINSPEC_QUOTA_FILE: '/nonexistent/nowhere/quota.json' });
    expect(r.code).toBe(42);
    expect(r.out).toMatch(/^defer:no-reading/);
  });

  it('quota-health names the bootstrap counter and says NOT YET failing closed while admits remain', () => {
    const r = run(['--quota-health']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^inert:/);
    expect(r.out).toMatch(/0\/3/);
    expect(r.out).toMatch(/NOT YET FAILING CLOSED/i);
  });

  it('quota-health switches to failing-closed once the allowance is actually exhausted', () => {
    run(['--quota-gate']); run(['--quota-gate']); run(['--quota-gate']); // consume all 3
    const r = run(['--quota-health']);
    expect(r.out).toMatch(/BLIND and HOLDING \(failing closed\)/i);
  });
});

describe('drain-inbox.sh --quota-gate — the WEEKLY ceiling, which the 5h reading cannot see', () => {
  // Only some producers can see the 7d window, so the fields are optional and their
  // absence must never invalidate an otherwise-good 5h reading.
  const write7 = (q: Record<string, number>) =>
    fs.writeFileSync(quotaFile, JSON.stringify({ observed_at: nowSec(), ...q }));

  it('admits when both windows have room (real observed state: 5h 30%, 7d 61%)', () => {
    write7({ used_percentage: 30, resets_at: nowSec() + 11640,
             seven_day_percentage: 61, seven_day_resets_at: nowSec() + 313800 });
    expect(run(['--quota-gate']).code).toBe(0);
  });

  it('defers on the WEEKLY ceiling even when the 5h window is nearly empty', () => {
    write7({ used_percentage: 10, resets_at: nowSec() + 11640,
             seven_day_percentage: 97, seven_day_resets_at: nowSec() + 313800 });
    const r = run(['--quota-gate']);
    expect(r.code).toBe(42);
    expect(r.out).toMatch(/WEEKLY/);
  });

  it('defers to the WEEKLY reset distance, not the 5h one', () => {
    write7({ used_percentage: 10, resets_at: nowSec() + 600,
             seven_day_percentage: 97, seven_day_resets_at: nowSec() + 313800 });
    expect(Number(run(['--quota-gate']).out.replace(/^defer:(\d+).*/s, '$1'))).toBeGreaterThan(100000);
  });

  it('a missing weekly reading leaves 5h behaviour completely unchanged', () => {
    write({ used_percentage: 10, resets_at: nowSec() + 3600 });
    expect(run(['--quota-gate']).code).toBe(0);
    expect(run(['--quota-health']).out).toMatch(/no weekly reading/);
    write({ used_percentage: 95, resets_at: nowSec() + 3600 });
    expect(run(['--quota-gate']).code).toBe(42);
  });

  it('the weekly bar is separately tunable and defaults looser than the 5h bar', () => {
    // A 5h window reopens in hours; a weekly one can be days out, so blocking on it
    // is far more expensive and the default bar is deliberately higher.
    write7({ used_percentage: 10, resets_at: nowSec() + 3600,
             seven_day_percentage: 92, seven_day_resets_at: nowSec() + 313800 });
    expect(run(['--quota-gate']).code).toBe(0);                                    // 92 < 95 default
    expect(run(['--quota-gate'], { MINSPEC_QUOTA_ADMIT_PCT_7D: '90' }).code).toBe(42);
  });

  it('a weekly ceiling with no usable reset still defers, bounded by the clamp', () => {
    write7({ used_percentage: 10, resets_at: nowSec() + 3600,
             seven_day_percentage: 99, seven_day_resets_at: nowSec() - 10 });
    const r = run(['--quota-gate']);
    expect(r.code).toBe(42);
    expect(r.out).toMatch(/no usable reset time/);
  });

  it('reports the weekly level in health when it is known', () => {
    write7({ used_percentage: 30, resets_at: nowSec() + 3600,
             seven_day_percentage: 61, seven_day_resets_at: nowSec() + 313800 });
    expect(run(['--quota-health']).out).toMatch(/7d window 61%/);
  });
});

describe('T3 regression — the weekly ceiling must outrank the 5h window-reset', () => {
  // Found in review of #1676. quota_gate returned open:window-reset as soon as the 5h
  // resets_at passed, BEFORE consulting the weekly ceiling. The two windows are
  // independent: the 5h one turning over does not refill the weekly one. So a fresh
  // reading whose 5h window had reset but whose 7d window was exhausted was admitted,
  // and the drain walked into exactly the wall this feature exists to prevent.
  //
  // Deterministically reachable, not a race: the loop sleeps to the 5h reset, wakes,
  // the poller has refreshed the reading (so it is not stale), 5h resets_at is now in
  // the past -> admitted despite 7d at 99%.
  const write7 = (q: Record<string, number>) =>
    fs.writeFileSync(quotaFile, JSON.stringify({ observed_at: nowSec(), ...q }));

  it('defers on the weekly ceiling even when the 5h window has already reset', () => {
    write7({
      used_percentage: 5, resets_at: nowSec() - 60,          // 5h window turned over
      seven_day_percentage: 99, seven_day_resets_at: nowSec() + 200000, // weekly spent
    });
    const r = run(['--quota-gate']);
    expect(r.code).toBe(42);
    expect(r.out).toMatch(/WEEKLY/);
    expect(r.out).not.toMatch(/window-reset/);
  });

  it('still reports window-reset when the 5h window reset and the weekly has room', () => {
    write7({
      used_percentage: 5, resets_at: nowSec() - 60,
      seven_day_percentage: 20, seven_day_resets_at: nowSec() + 200000,
    });
    const r = run(['--quota-gate']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/window-reset/);
  });

  it('with no weekly reading, a passed 5h reset still admits (behaviour unchanged)', () => {
    write({ used_percentage: 99, resets_at: nowSec() - 60 });
    expect(run(['--quota-gate']).code).toBe(0);
  });

  it('sleeps toward the WEEKLY reset when the weekly ceiling is what is deferring', () => {
    // Non-blocking finding from the same review: quota_sleep_secs read the weekly
    // fields but never used them, so the loop slept on the 5h reset (or the clamp)
    // while the gate reported a days-out weekly deferral. Safe, but the message lied.
    write7({
      used_percentage: 5, resets_at: nowSec() + 120,
      seven_day_percentage: 99, seven_day_resets_at: nowSec() + 200000,
    });
    const secs = Number(run(['--quota-sleep']).out);
    // The weekly reset is ~200000s out, so the answer must be the 6h clamp — NOT the
    // 135s the 5h reset would give. A `> 120` assertion would pass on that 135 and
    // prove nothing, which is how this test first went green while still broken.
    expect(secs).toBe(6 * 3600);
  });
});
