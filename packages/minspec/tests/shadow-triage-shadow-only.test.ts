/**
 * T0 — the GLM shadow verdict reaches NOTHING (#1338).
 *
 * The instrument's whole licence to exist is that it changes no outcome. That claim
 * is asserted here as BEHAVIOUR, by driving the REAL `scripts/triage-inbox.sh` with
 * stub `claude` / `gh` binaries where the shadow half emits the exact OPPOSITE
 * verdict from the live half:
 *
 *   live   → needs-review · architect · T3 · human_only: yes   (a human gate)
 *   shadow → agent-ready  · dev       · T1 · human_only: no    ("build it now")
 *
 * If the shadow output could reach anything, the label applied to the issue would be
 * `agent-ready` — the single most consequential thing in this pipeline, since it is
 * what authorises an unattended build. The test asserts the applied label still
 * follows the LIVE agent, and that `agent-ready` appears in no gh call at all.
 *
 * Why not grep the script for its own text: this repo has repeatedly been bitten by
 * source-text assertions that pass while the thing they describe is inert (the
 * pattern `specify_scope_stray` in dispatch-issue.sh exists to avoid). A guard that
 * says "shadow-only" in a comment and leaks anyway would sail through a grep.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GH_BOT_STUB_ENV } from './helpers/gh-bot-env';

// These specs drive real bash → claude/gh stub → triage-decide.sh → jq chains. Under
// container scheduling contention a single invocation can queue past the 5s default
// even though nothing hung (#1099). Raised per-file, not globally.
vi.setConfig({ testTimeout: 30_000 });
afterAll(() => {
  vi.resetConfig();
});

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'scripts')) && fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate the repo root from ' + __dirname);
}

const repoRoot = findRepoRoot();
const scriptsDir = path.join(repoRoot, 'scripts');
const TRIAGE_INBOX = path.join(scriptsDir, 'triage-inbox.sh');
const SHADOW = path.join(scriptsDir, 'shadow-triage.sh');

const verdict = (decision: string, role: string, tier: string, humanOnly: string) =>
  [
    'TRIAGE_VERDICT_BEGIN',
    `decision: ${decision}`,
    `role: ${role}`,
    `tier: ${tier}`,
    `human_only: ${humanOnly}`,
    'rationale: fixture',
    'TRIAGE_VERDICT_END',
  ].join('\n');

/** The live agent holds the issue for a human. */
const LIVE_VERDICT = verdict('needs-review', 'architect', 'T3', 'yes');
/** The shadow model says the opposite: build it unattended, right now. */
const SHADOW_VERDICT = verdict('agent-ready', 'dev', 'T1', 'no');

interface Harness {
  dir: string;
  binDir: string;
  ghLog: string;
  claudeCalls: string;
  curlCalls: string;
  shadowLog: string;
  env: Record<string, string>;
}

/**
 * A hermetic sandbox: stub `claude`, `curl` and `gh` on PATH ahead of the real ones, a
 * temp JSONL path, and an environment built from scratch so the operator's real
 * ANTHROPIC_* variables cannot influence the run.
 *
 * `curl` is stubbed because the shadow half is a direct HTTPS request, not a `claude`
 * subprocess. Without the stub these cases would reach api.z.ai for real — a network
 * call the constitution's offline invariant forbids, and one that would fail on the
 * fixture key and silently turn every assertion below into a vacuous pass against a
 * shadow step that never ran.
 */
function makeHarness(opts: { key?: string; disabled?: boolean; private?: boolean } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-triage-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);

  const ghLog = path.join(dir, 'gh-calls.log');
  const claudeCalls = path.join(dir, 'claude-calls.log');
  const curlCalls = path.join(dir, 'curl-calls.log');
  const shadowLog = path.join(dir, 'shadow-triage.jsonl');

  fs.writeFileSync(path.join(dir, 'live-verdict.txt'), LIVE_VERDICT);
  fs.writeFileSync(path.join(dir, 'shadow-verdict.txt'), SHADOW_VERDICT);

  // Only the LIVE agent is a `claude` process now. The stub still branches on
  // ANTHROPIC_BASE_URL so that a regression which reintroduced a shadow `claude` call
  // would be VISIBLE here as a 'shadow' line rather than passing unnoticed.
  fs.writeFileSync(
    path.join(binDir, 'claude'),
    `#!/usr/bin/env bash
if [[ "\${ANTHROPIC_BASE_URL:-}" == *z.ai* || "\${ANTHROPIC_BASE_URL:-}" == *shadow* ]]; then
  echo "shadow" >> "${claudeCalls}"
  cat "${path.join(dir, 'shadow-verdict.txt')}"
else
  echo "live" >> "${claudeCalls}"
  cat "${path.join(dir, 'live-verdict.txt')}"
fi
exit 0
`,
    { mode: 0o755 },
  );

  // The shadow transport. Speaks enough of curl's contract for the runner to work:
  // reads the header config from STDIN, honours `--output FILE`, and writes the HTTP
  // status to stdout (which is how `shadow_http` reports it). It records the URL it
  // was asked for so a test can assert the request was actually issued.
  fs.writeFileSync(
    path.join(binDir, 'curl'),
    `#!/usr/bin/env bash
out=""; url=""
while [[ $# -gt 0 ]]; do
  case "\$1" in
    --output) out="\$2"; shift 2 ;;
    --max-time|--write-out|--data-binary|--request) shift 2 ;;
    --disable|--silent|--show-error) shift ;;
    --config) shift 2 ;;
    *) url="\$1"; shift ;;
  esac
done
cat > /dev/null   # drain the config on stdin; never echoed, it holds the key
echo "\$url" >> "${curlCalls}"
if [[ "\$url" == */v1/models ]]; then
  printf '{"data":[{"id":"glm-5.2","created_at":"2026-06-17T00:00:00Z"}]}' > "\${out:-/dev/stdout}"
else
  jq -c -n --rawfile t "${path.join(dir, 'shadow-verdict.txt')}" \\
    '{content:[{type:"text",text:\$t}],stop_reason:"end_turn"}' > "\${out:-/dev/stdout}"
fi
printf '200'
exit 0
`,
    { mode: 0o755 },
  );

  const visibility = opts.private
    ? '{"visibility":"PRIVATE","isPrivate":true}'
    : '{"visibility":"PUBLIC","isPrivate":false}';

  // Every argument is logged on its own line with newlines escaped, so a multi-line
  // `--body` cannot be mistaken for separate arguments when asserting.
  fs.writeFileSync(
    path.join(binDir, 'gh'),
    `#!/usr/bin/env bash
{ printf '=== %s %s\\n' "\${1:-}" "\${2:-}"; for a in "\$@"; do printf 'ARG %s\\n' "\${a//$'\\n'/\\\\n}"; done; } >> "${ghLog}"
if [[ "\${1:-}" == "issue" && "\${2:-}" == "view" ]]; then
  echo '{"body":"Some issue body.","title":"A fixture issue","labels":[{"name":"inbox"}]}'
elif [[ "\${1:-}" == "repo" && "\${2:-}" == "view" ]]; then
  echo '${visibility}'
fi
exit 0
`,
    { mode: 0o755 },
  );

  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: process.env.HOME ?? '/tmp',
    MINSPEC_SHADOW_TRIAGE_LOG: shadowLog,
    // Pin the model so these cases stay HERMETIC. The shipped default is the
    // `latest` sentinel, which resolves via GET /v1/models — a network call these
    // tests must never make, and which would (correctly) skip the run when it fails,
    // so no row would land and every assertion here would fail for the wrong reason.
    // An explicit id short-circuits resolution entirely; the resolver itself is
    // covered by fixtures in shadow-triage-isolation.test.ts.
    MINSPEC_SHADOW_TRIAGE_MODEL: 'glm-5.2',
    // triage-inbox.sh takes a bot identity before it writes (#1355). This env is
    // hermetic by design, so it must supply the token source too — same reason it
    // supplies a stubbed `gh` on PATH. Without it the script aborts before writing.
    ...GH_BOT_STUB_ENV,
  };
  if (opts.key) env.MINSPEC_SHADOW_TRIAGE_KEY = opts.key;
  if (opts.disabled) env.MINSPEC_SHADOW_TRIAGE = '0';

  return { dir, binDir, ghLog, claudeCalls, curlCalls, shadowLog, env };
}

function runTriage(h: Harness, issue = '4242'): { stdout: string; stderr: string; status: number } {
  // spawnSync, not execFileSync: the success path must still yield stderr, because
  // the "an inert instrument is visible as inert" assertion reads a note printed on
  // a run that exits 0.
  const r = spawnSync('bash', [TRIAGE_INBOX, issue], {
    encoding: 'utf-8',
    env: h.env,
    cwd: h.dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

/** The value passed to a given gh flag, e.g. addedLabels(h) → the --add-label operand. */
function flagValues(h: Harness, flag: string): string[] {
  const args = ghArgs(h);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]);
  return out;
}

/**
 * Assert the LIVE gate's verdict is what got applied — by content, never as an exact
 * label string.
 *
 * The full label set belongs to `triage-inbox.sh` and legitimately grows: #1291 added
 * `hold:*` after this file landed, and because neither PR's CI ever ran against a base
 * carrying the other's change, both merged green and main went red. An exact-equality
 * assertion here is a hand-maintained mirror of another module's policy with nothing
 * binding the two, so it breaks on correct behaviour.
 *
 * What these tests are actually about is WHOSE verdict was applied, so pin the role and
 * the review state — the two fields the shadow would have changed — and let the rest of
 * the policy move. Exactly one `--add-label` is still required: the shadow must not add
 * a second one.
 *
 * `hold:*` is pinned too, unlike the rest of the growing label set (#1526): it is one of
 * the five fields the shadow verdict is compared on (`label, role, hold, tier,
 * human_only`), and the whole point of this suite is that the shadow's `hold: none` must
 * not displace the live `hold: human`. Without this, a change to the operand that
 * authorises or withholds a human gate could land with no test noticing.
 */
function expectLiveVerdictApplied(h: Harness): void {
  const applied = flagValues(h, '--add-label');
  expect(applied).toHaveLength(1);
  expect(applied[0]).toContain('role:architect');
  expect(applied[0]).toContain('needs-review');
  expect(applied[0]).toContain('hold:human');
}

const ghArgs = (h: Harness): string[] =>
  fs.existsSync(h.ghLog)
    ? fs
        .readFileSync(h.ghLog, 'utf-8')
        .split('\n')
        .filter((l) => l.startsWith('ARG '))
        .map((l) => l.slice(4))
    : [];

const readRows = (h: Harness): any[] =>
  fs.existsSync(h.shadowLog)
    ? fs
        .readFileSync(h.shadowLog, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

describe('shadow-triage — a contradicting shadow verdict changes NO outcome (#1338)', () => {
  it('the applied label follows the LIVE agent even though the shadow said agent-ready', () => {
    const h = makeHarness({ key: 'zai-test-key' });
    runTriage(h);

    // The live verdict (T3 + human_only) resolves to needs-review / architect.
    expectLiveVerdictApplied(h);

    // …and the shadow's "agent-ready · dev · T1" reached nothing. This is the
    // load-bearing assertion: `agent-ready` is what authorises an unattended build.
    //
    // Asserted on --add-label ONLY. `agent-ready` legitimately appears in the
    // --remove-label clear list (triage-inbox.sh supersedes the labels this verdict
    // replaces), so a blanket search of every gh argument would fail against correct
    // behaviour — the question is what was APPLIED, not what was mentioned.
    for (const applied of flagValues(h, '--add-label')) {
      expect(applied).not.toMatch(/agent-ready/);
      expect(applied).not.toMatch(/role:dev/);
    }
  });

  it('the verdict RECORD carries the live gate decision, not the shadow one', () => {
    // The record is what dispatch-ready-check.sh reads. A shadow value here would be
    // worse than a wrong label: the label is a stamp, the record is the authority.
    const h = makeHarness({ key: 'zai-test-key' });
    runTriage(h);
    const body = ghArgs(h).find((a) => a.includes('MINSPEC_VERDICT_BEGIN'));
    expect(body, 'no verdict record was posted').toBeTruthy();
    expect(body).toContain('decision: needs-review');
    expect(body).toContain('hold: human');
    expect(body).toContain('tier: T3');
    expect(body).not.toContain('decision: agent-ready');
    expect(body).not.toContain('hold: none');
  });

  it('BOTH agents actually ran — the test is not green merely because the shadow was skipped', () => {
    // Without this, every assertion above would pass just as well against a shadow
    // step that never executed, which is the vacuous-pass shape this repo watches for.
    //
    // The two halves are now observed on DIFFERENT channels, because they use
    // different transports: the live agent is a `claude` process, the shadow is one
    // HTTPS request. Both witnesses are required.
    const h = makeHarness({ key: 'zai-test-key' });
    runTriage(h);
    const claude = fs.readFileSync(h.claudeCalls, 'utf-8').split('\n').filter(Boolean);
    expect(claude).toContain('live');

    const requests = fs.readFileSync(h.curlCalls, 'utf-8').split('\n').filter(Boolean);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/\/v1\/messages$/);

    // …and the shadow half consumed NO Anthropic quota, which is half the point of
    // the transport swap (#1234): it never became a `claude` process at all.
    expect(claude).not.toContain('shadow');
  });

  it('the disagreement is RECORDED — both verdicts, per-field, through the same gate', () => {
    const h = makeHarness({ key: 'zai-test-key' });
    runTriage(h);
    const rows = readRows(h);
    expect(rows).toHaveLength(1);
    const r = rows[0];

    expect(r.schema).toBe('minspec-shadow-triage/1');
    expect(r.issue).toBe(4242);
    expect(r.model).toBe('glm-5.2'); // recorded on every row — an unpinned figure means nothing
    expect(r.conformant).toBe(true);
    expect(typeof r.latencyMs).toBe('number');
    expect(r.error).toBeNull();

    // Both sides normalised by the SAME gate binary: no second parser to drift.
    expect(r.live).toEqual({ label: 'needs-review', role: 'architect', hold: 'human', tier: 'T3', human_only: 'yes' });
    expect(r.shadow).toEqual({ label: 'agent-ready', role: 'dev', hold: 'none', tier: 'T1', human_only: 'no' });

    expect(r.agree).toEqual({
      label: false,
      role: false,
      hold: false,
      tier: false,
      human_only: false,
      all: false,
    });
  });

  it('`record` writes NOTHING to stdout — there is no channel for a verdict to escape by', () => {
    // The structural half of "shadow-only". Even if a future caller wrapped this in
    // `$(...)`, it would capture the empty string; the only egress is the log file.
    const h = makeHarness({ key: 'zai-test-key' });
    const prompt = path.join(h.dir, 'prompt.txt');
    const live = path.join(h.dir, 'live-fields.txt');
    fs.writeFileSync(prompt, 'classify this');
    fs.writeFileSync(live, 'label=needs-review\nrole=architect\nhold=human\ntier=T3\nhuman_only=yes\n');

    const stdout = execFileSync(
      'bash',
      [SHADOW, 'record', '--issue', '7', '--repo', 'AIClarityAU/minspec', '--prompt-file', prompt, '--live-fields', live],
      { encoding: 'utf-8', env: h.env, cwd: h.dir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(stdout).toBe('');
    // …and it did run: the row landed.
    expect(readRows(h)).toHaveLength(1);
  });
});

describe('shadow-triage — inert without a key, and real triage is untouched (#1338)', () => {
  it('no key → the shadow model is never called, no log is written, triage still succeeds', () => {
    const h = makeHarness(); // no MINSPEC_SHADOW_TRIAGE_KEY
    const res = runTriage(h);

    expect(res.status).toBe(0);
    expect(fs.existsSync(h.shadowLog)).toBe(false);

    const calls = fs.readFileSync(h.claudeCalls, 'utf-8').split('\n').filter(Boolean);
    expect(calls).toEqual(['live']); // exactly one agent ran
    // The load-bearing witness since the transport swap: the shadow half is an HTTPS
    // request, so "no claude subprocess" no longer proves it was skipped. NO REQUEST
    // WAS ISSUED is what proves it.
    expect(fs.existsSync(h.curlCalls)).toBe(false);
    expectLiveVerdictApplied(h);
  });

  it('no key → a one-line note, not silence (an inert instrument must be visible as inert)', () => {
    // "Skipped silently" would leave the operator unable to tell "not configured"
    // from "ran and agreed" — the same reason a report distinguishes n=0 from a pass.
    const h = makeHarness();
    expect(runTriage(h).stderr).toMatch(/shadow-triage: no z\.ai key configured/);
  });

  it('MINSPEC_SHADOW_TRIAGE=0 hard-disables it even when a key is present', () => {
    const h = makeHarness({ key: 'zai-test-key', disabled: true });
    runTriage(h);
    expect(fs.readFileSync(h.claudeCalls, 'utf-8').split('\n').filter(Boolean)).toEqual(['live']);
    // No request left the machine, which is what "hard-disabled" has to mean for an
    // instrument whose only side effect is now an outbound HTTPS call.
    expect(fs.existsSync(h.curlCalls)).toBe(false);
    expect(fs.existsSync(h.shadowLog)).toBe(false);
  });

  it('triage produces the identical gh calls with and without the harness configured', () => {
    // The sharpest form of "real triage is unaffected": the pipeline's entire
    // observable output is byte-identical whether or not the instrument ran.
    const withKey = makeHarness({ key: 'zai-test-key' });
    const without = makeHarness();
    runTriage(withKey);
    runTriage(without);

    // Verdict records embed a UTC timestamp, so compare everything except that line.
    const strip = (s: string[]) => s.map((a) => a.replace(/verdictAt: [^\\]*/g, 'verdictAt: <t>'));
    // `gh repo view` is the visibility pre-check and only happens on the shadow path;
    // it is a READ, mutating nothing, so it is excluded from the mutation comparison.
    const mutations = (h: Harness) =>
      strip(
        fs
          .readFileSync(h.ghLog, 'utf-8')
          .split('=== ')
          .filter((b) => !b.startsWith('repo view'))
          .flatMap((b) => b.split('\n').filter((l) => l.startsWith('ARG ')).map((l) => l.slice(4))),
      );

    expect(mutations(withKey)).toEqual(mutations(without));
  });
});

describe('shadow-triage — public repos only (jurisdiction, scrooge DR-021 §5)', () => {
  /** Run the pure visibility predicate; true iff the repo is confirmed public. */
  const isPublic = (json: string): boolean => {
    try {
      execFileSync('bash', [SHADOW, '--repo-public'], {
        input: json,
        encoding: 'utf-8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
      });
      return true;
    } catch {
      return false;
    }
  };

  it('a genuinely public repo IS public (the predicate is not simply always false)', () => {
    expect(isPublic('{"visibility":"PUBLIC","isPrivate":false}')).toBe(true);
  });

  it('a private repo is skipped: no shadow call, no row', () => {
    // A private repo's issue bodies must never leave for a third-party endpoint.
    const h = makeHarness({ key: 'zai-test-key', private: true });
    runTriage(h);
    expect(fs.readFileSync(h.claudeCalls, 'utf-8').split('\n').filter(Boolean)).toEqual(['live']);
    // The jurisdiction constraint is about BYTES LEAVING, so this is the assertion
    // that actually states it: not one request was issued.
    expect(fs.existsSync(h.curlCalls)).toBe(false);
    expect(fs.existsSync(h.shadowLog)).toBe(false);
  });

  it.each([
    ['a private repo', '{"visibility":"PRIVATE","isPrivate":true}'],
    ['an internal repo', '{"visibility":"INTERNAL","isPrivate":false}'],
    ['a missing isPrivate witness', '{"visibility":"PUBLIC"}'],
    ['a missing visibility witness', '{"isPrivate":false}'],
    ['disagreeing witnesses', '{"visibility":"PUBLIC","isPrivate":true}'],
    ['malformed JSON', 'not json at all'],
    ['an empty response (gh failed)', ''],
    ['a JSON array rather than an object', '[]'],
  ])('%s is NOT public', (_label, json) => {
    // Fails closed on every form of doubt. For a jurisdiction constraint,
    // "I could not tell" and "it is private" have to land in the same place.
    expect(isPublic(json)).toBe(false);
  });
});

describe('shadow-triage — verdict-block schema conformance (#1338 metric 2)', () => {
  const conformant = (text: string): boolean => {
    try {
      execFileSync('bash', [SHADOW, '--block-conformant'], {
        input: text,
        encoding: 'utf-8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
      });
      return true;
    } catch {
      return false;
    }
  };

  it('a complete verdict block is conformant', () => {
    expect(conformant(SHADOW_VERDICT)).toBe(true);
  });

  it('surrounding model prose does not break conformance', () => {
    expect(conformant(`Here is my analysis.\n\n${SHADOW_VERDICT}\n\nHope that helps!`)).toBe(true);
  });

  it('no block at all is NOT conformant', () => {
    expect(conformant('the model rambled and emitted no verdict block')).toBe(false);
  });

  it('an unterminated block is NOT conformant', () => {
    expect(conformant('TRIAGE_VERDICT_BEGIN\ndecision: agent-ready\nrole: dev\ntier: T1\nhuman_only: no')).toBe(false);
  });

  it.each(['decision', 'role', 'tier', 'human_only'])('a block missing %s is NOT conformant', (field) => {
    const partial = SHADOW_VERDICT.split('\n')
      .filter((l) => !l.startsWith(`${field}:`))
      .join('\n');
    expect(conformant(partial)).toBe(false);
  });

  it('a missing `rationale` is still conformant — the gate discards it', () => {
    // Requiring prose the gate never reads would inflate the malformed rate with a
    // defect that has no consequence, and the 2% rollback trigger reads that rate.
    const noRationale = SHADOW_VERDICT.split('\n')
      .filter((l) => !l.startsWith('rationale:'))
      .join('\n');
    expect(conformant(noRationale)).toBe(true);
  });
});
