/**
 * #1208 — the drain's dispatch fan-out.
 *
 * WHY THIS EXISTS: dispatch was a strictly serial walk, so backlog burn-down was
 * bounded by wall-clock rather than by quota. Widening it is only safe because
 * SPEC-044/DR-067 already built the concurrency invariants (per-item flock,
 * claim-unique worktree paths, PR-per-head CAS, D12 sequential gate) that the
 * serial loop simply never exercised.
 *
 * The risk the tests below guard is NOT "does bash spawn jobs" — it is that
 * widening the fan-out silently weakens the autocompact circuit-breaker. That
 * breaker has now caught a real systemic outage twice (#912, and again post-fix
 * per #1203), so its rule is tested directly rather than inferred from a live run.
 *
 * Serially the rule was "N CONSECUTIVE thrashed dispatches". Under fan-out
 * "consecutive" is ill-defined, so it becomes "the last N COMPLETIONS were all
 * thrash", ordered by completion. For width 1 the two are identical — that
 * equivalence is asserted below, because it is what makes the default path's
 * meaning provably unchanged.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'scripts')) && fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repo root not found from ' + __dirname);
}
const DRAIN = path.join(findRepoRoot(), 'scripts', 'drain-inbox.sh');

function sh(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', [DRAIN, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

describe('#1208 dispatch fan-out — width validation', () => {
  it('defaults to 1, so parallelism is opt-in and never inherited', () => {
    expect(sh(['--concurrency'])).toBe('1');
  });

  it('honours an explicit width', () => {
    expect(sh(['--concurrency'], { MINSPEC_DRAIN_CONCURRENCY: '4' })).toBe('4');
  });

  it('caps the width rather than trusting an absurd value', () => {
    expect(sh(['--concurrency'], { MINSPEC_DRAIN_CONCURRENCY: '99' })).toBe('8');
  });

  it.each(['abc', '0', '-2', '2.5', ''])(
    'fails SAFE to 1 on malformed width %j (a silently-ignored knob would be a gate that lies)',
    (bad) => {
      expect(sh(['--concurrency'], { MINSPEC_DRAIN_CONCURRENCY: bad })).toBe('1');
    },
  );
});

describe('#1208 autocompact breaker — survives the widening', () => {
  const decide = (halt: string, csv: string) => sh(['--breaker-decide', halt, csv]);

  it('halts when the last N completions all thrashed', () => {
    expect(decide('3', '1,1,1')).toBe('halt');
    expect(decide('3', '0,0,1,1,1')).toBe('halt');
  });

  it('does not halt when a clean completion breaks the run', () => {
    expect(decide('3', '1,0,1,1')).toBe('continue');
    expect(decide('3', '1,1,0')).toBe('continue');
  });

  it('does not halt before N completions exist', () => {
    expect(decide('3', '1,1')).toBe('continue');
    expect(decide('3', '')).toBe('continue');
  });

  it('is disabled by halt=0 (the documented kill-switch)', () => {
    expect(decide('0', '1,1,1,1,1')).toBe('continue');
  });

  it('is EQUIVALENT to the old consecutive rule at width 1', () => {
    // Reference implementation of the pre-#1208 serial semantics.
    const consecutive = (halt: number, outcomes: number[]) => {
      let run = 0;
      for (const o of outcomes) {
        run = o === 1 ? run + 1 : 0;
        if (run >= halt) return 'halt';
      }
      return 'continue';
    };
    const cases = ['1,1,1', '1,0,1,1', '0,1,1,1', '1,1', '1,0,1,0,1', '1,1,0,1,1,1', '0,0,0'];
    for (const csv of cases) {
      const outcomes = csv.split(',').filter(Boolean).map(Number);
      // Serial replay: the breaker is consulted after every completion and stops
      // at the first halt, exactly as the loop does.
      let seen: number[] = [];
      let rolling = 'continue';
      for (const o of outcomes) {
        seen.push(o);
        if (decide('3', seen.join(',')) === 'halt') { rolling = 'halt'; break; }
      }
      expect(rolling, `rolling-window disagreed with consecutive on [${csv}]`)
        .toBe(consecutive(3, outcomes));
    }
  });
});

describe('#1208 fan-out drives the REAL loop', () => {
  // These drive `drain-inbox.sh --once` itself with a stubbed `gh` and a stubbed
  // dispatcher, rather than re-implementing the launch/reap shape in the test. A
  // test that replays its own idea of the algorithm proves only that the test is
  // self-consistent - it would stay green while the shipped loop was broken.
  interface Harness { dir: string; bin: string; log: (w: string) => string; flight: string; quota: string }

  function makeHarness(issues: number[], dispatchBody: string): Harness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-conc-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(dir, 'root'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash
for a in "$@"; do [[ "$a" == "inbox" ]] && exit 0; done
if [[ "$1" == "issue" && "$2" == "list" ]]; then printf '${issues.join('\\n')}\\n'; exit 0; fi
exit 0
`);
    fs.writeFileSync(path.join(bin, 'dispatch.sh'), dispatchBody.replace(/__DIR__/g, dir));
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    fs.chmodSync(path.join(bin, 'dispatch.sh'), 0o755);
    const quota = path.join(dir, 'quota.json');
    // A FRESH, well-under-the-bar reading — never a missing file. The gate now fails
    // CLOSED on an absent/stale reading (#1775), so a missing file would defer every
    // cycle before dispatch even starts, and every test below would see zero dispatches.
    fs.writeFileSync(quota, JSON.stringify({
      used_percentage: 1,
      resets_at: Math.floor(Date.now() / 1000) + 3600,
      observed_at: Math.floor(Date.now() / 1000),
    }));
    return { dir, bin, log: (w) => path.join(dir, `log.${w}`), flight: path.join(dir, 'flight'), quota };
  }

  // MINSPEC_QUOTA_FILE must be isolated too, and pointed at the FRESH reading makeHarness
  // just wrote. The quota gate reads it before dispatching, so without this the suite
  // reads the machine's REAL ~/.claude/quota.json and its result depends on how much of
  // the human's 5h window happens to be spent: above the bar the drain correctly defers
  // and dispatches nothing, and the test fails with `expected +0 to be 1`. Caught exactly
  // that way at 95% used. Pointing at a file that does not exist would ALSO defer now
  // (#1775: a missing or stale reading fails CLOSED, never open), so these tests need a
  // real, current, low-usage reading to get the deterministic admit they need.
  // MINSPEC_DRAIN_LOCK must be isolated alongside MINSPEC_DRAIN_LOG. The drain is a
  // singleton keyed on that lock (drain-inbox.sh:110), so without the override these
  // tests contend with any real drain running on the machine — including the live
  // --auto one. The loser exits 0 at the singleton check BEFORE creating its log, and
  // the test then fails as `ENOENT: log.N`, which reads like a launch-loop bug rather
  // than a lock collision. Overriding LOG but not LOCK made the suite pass or fail
  // depending on whether another drain happened to be alive.
  /** Run one real `--once` cycle at the given width and wait for the disowned loop. */
  function runCycle(h: Harness, width: string): { elapsedMs: number; log: string } {
    const t0 = Date.now();
    const out = execFileSync('bash', ['-c', `
      pid=$(PATH="${h.bin}:$PATH" \
        MINSPEC_DRAIN_DISPATCH="${path.join(h.bin, 'dispatch.sh')}" \
        MINSPEC_DRAIN_CONCURRENCY="${width}" \
        MINSPEC_DRAIN_RUN_DIR="" \
        MINSPEC_DRAIN_REMEDIATE_PRS=0 \
        MINSPEC_DRAIN_PRIMARY_ROOT="${path.join(h.dir, 'root')}" \
        MINSPEC_DRAIN_LOG="${h.log(width)}" \
        MINSPEC_DRAIN_LOCK="${path.join(h.dir, 'lock')}" \
        MINSPEC_QUOTA_FILE="${h.quota}" \
        bash "${DRAIN}" --once 2>&1 | grep -oP 'PID \\K[0-9]+')
      while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done
    `], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    void out;
    return { elapsedMs: Date.now() - t0, log: fs.readFileSync(h.log(width), 'utf-8') };
  }

  /** Peak simultaneous dispatches, reconstructed from timestamps the stub recorded. */
  function peakInFlight(h: Harness): number {
    if (!fs.existsSync(h.flight)) return 0;
    const ev = fs.readFileSync(h.flight, 'utf-8').trim().split('\n').filter(Boolean)
      .map((l) => l.split(' '))
      .filter((p) => p.length === 3)
      .map((p) => ({ t: Number(p[2]), d: p[0] === 'start' ? 1 : -1 }))
      .sort((a, b) => a.t - b.t);
    let cur = 0, mx = 0;
    for (const e of ev) { cur += e.d; mx = Math.max(mx, cur); }
    return mx;
  }

  const TIMED_STUB = `#!/usr/bin/env bash
echo "start $1 $(date +%s%N)" >> "__DIR__/flight"
sleep 0.5
echo "end $1 $(date +%s%N)" >> "__DIR__/flight"
echo "dispatched $1"
`;

  it('width 1 dispatches strictly one at a time (default behaviour unchanged)', () => {
    const h = makeHarness([901, 902, 903], TIMED_STUB);
    const { log } = runCycle(h, '1');
    expect(peakInFlight(h)).toBe(1);
    expect(log).toContain('concurrency=1');
    expect(log).toContain('cycle done');
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 60000);

  it('width 4 genuinely overlaps four real dispatches', () => {
    const h = makeHarness([901, 902, 903, 904], TIMED_STUB);
    const { log } = runCycle(h, '4');
    expect(peakInFlight(h)).toBe(4);
    expect(log).toContain('in flight: 4/4');
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 60000);

  it('a quota signal pauses the cycle at width 1 without dispatching the rest', () => {
    const h = makeHarness([901, 902, 903], `#!/usr/bin/env bash
echo "RAN $1"
[[ "$1" == "901" ]] && echo "Claude usage limit reached. Your limit will reset at 3pm."
`);
    const { log } = runCycle(h, '1');
    expect(log).toContain('usage-limit signal');
    expect(log).not.toContain('dispatching #903');
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 60000);

  it('a quota signal DRAINS in-flight work before pausing, never orphans it', () => {
    // An abandoned build would hold its SPEC-044 claim until the TTL lapsed and
    // leave its worktree behind, so the parallel path must stop LAUNCHING, not kill.
    const h = makeHarness([901, 902, 903, 904], `#!/usr/bin/env bash
echo "RAN $1"
sleep 0.3
[[ "$1" == "901" ]] && echo "Claude usage limit reached. Your limit will reset at 3pm."
`);
    const { log } = runCycle(h, '2');
    expect(log).toMatch(/usage-limit signal.*draining \d+ in-flight/);
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 60000);
});
