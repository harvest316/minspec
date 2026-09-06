/**
 * SPEC-044 Slice 2 — T0: the pure creator-shepherd decision seam (`--decide`).
 *
 * Covers FR-4 (the shepherd loop is BOUNDED — by wall clock and by attempt cap),
 * INV-5 (no credentialed step is ever elected without holding the claim — D3), and
 * the D4 reuse contract (the action token comes from remediate-pr.sh's classify_pr;
 * this seam only decides what to DO with it, and fails closed on anything unknown).
 *
 * The seam is pure: no gh, no git, no claude — so every ordering rule below is
 * asserted deterministically rather than observed in a live loop.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const SCRIPT = path.resolve(__dirname, '../../../scripts/lib/shepherd-pr.sh');
const DISPATCH = path.resolve(__dirname, '../../../scripts/dispatch-issue.sh');

interface DecideArgs {
  action: string;
  merged?: 'yes' | 'no';
  holds?: 'yes' | 'no';
  attempts?: number;
  maxAttempts?: number;
  elapsed?: number;
  maxSecs?: number;
  checksPending?: 'yes' | 'no';
  automergeArmed?: 'yes' | 'no';
}

/** Run `--decide`; returns the single action token. */
function decide({
  action,
  merged = 'no',
  holds = 'yes',
  attempts = 0,
  maxAttempts = 2,
  elapsed = 0,
  maxSecs = 3600,
  // Default to "something async is still in flight" so the pre-existing cases keep
  // exercising the polling path; the human-gate cases opt out explicitly.
  checksPending = 'yes',
  automergeArmed = 'no',
}: DecideArgs): string {
  return execFileSync(
    'bash',
    [
      SCRIPT,
      '--decide',
      action,
      merged,
      holds,
      String(attempts),
      String(maxAttempts),
      String(elapsed),
      String(maxSecs),
      checksPending,
      automergeArmed,
    ],
    { encoding: 'utf-8' },
  ).trim();
}

/**
 * Every action token classify_pr can emit, plus an unknown one. retry-unknown and
 * skip-unhandled-state are #1803's two new tokens (an UNKNOWN or unrecognised
 * mergeStateStatus) — included here so the priority gates below (merged, stand-down,
 * the wall-clock ceiling) are proven to apply to them too, not just the pre-existing
 * vocabulary.
 */
const ALL_ACTIONS = [
  'skip-not-automation',
  'skip-conflict',
  'agent-remediate-checks',
  'agent-remediate-review',
  'rebase-only',
  'skip-clean',
  'retry-unknown',
  'skip-unhandled-state',
  'some-token-from-the-future',
];

describe('shepherd --decide: INV-5/D3 a reclaimed owner never elects a credentialed op', () => {
  it('stands down for EVERY action token when the claim is no longer held', () => {
    for (const action of ALL_ACTIONS) {
      expect(decide({ action, holds: 'no' }), `action=${action}`).toBe('stand-down');
    }
  });

  it('stand-down outranks the wall-clock ceiling and the attempt cap', () => {
    // Losing the claim is not a "we ran out of budget" outcome — it must be reported
    // as stand-down so the caller never mistakes it for an exhausted shepherd.
    expect(decide({ action: 'agent-remediate-checks', holds: 'no', elapsed: 99_999, maxSecs: 10 })).toBe(
      'stand-down',
    );
    expect(decide({ action: 'agent-remediate-checks', holds: 'no', attempts: 99, maxAttempts: 2 })).toBe(
      'stand-down',
    );
  });

  it('never emits a do-* (credentialed) token without the claim', () => {
    for (const action of ALL_ACTIONS) {
      expect(decide({ action, holds: 'no' })).not.toMatch(/^do-/);
    }
  });
});

describe('shepherd --decide: merged is terminal and reported honestly', () => {
  it('reports stop-merged even if the claim has since moved', () => {
    // A merged PR is a read-only observation; reporting stand-down here would be a
    // false signpost (the work DID land).
    expect(decide({ action: 'skip-clean', merged: 'yes', holds: 'no' })).toBe('stop-merged');
  });

  it('merged outranks every action token, cap and ceiling', () => {
    for (const action of ALL_ACTIONS) {
      expect(decide({ action, merged: 'yes', elapsed: 99_999, maxSecs: 10, attempts: 99 })).toBe('stop-merged');
    }
  });
});

describe('shepherd --decide: FR-4 the loop is bounded', () => {
  it('stops at the wall-clock ceiling rather than electing more work', () => {
    expect(decide({ action: 'agent-remediate-checks', elapsed: 3600, maxSecs: 3600 })).toBe('stop-timeout');
    expect(decide({ action: 'rebase-only', elapsed: 3601, maxSecs: 3600 })).toBe('stop-timeout');
    // skip-clean would otherwise poll forever — the ceiling is what ends it.
    expect(decide({ action: 'skip-clean', elapsed: 3600, maxSecs: 3600 })).toBe('stop-timeout');
  });

  it('keeps working strictly BELOW the ceiling', () => {
    expect(decide({ action: 'agent-remediate-checks', elapsed: 3599, maxSecs: 3600 })).toBe('do-fix');
  });

  it('caps repeated fix attempts instead of looping', () => {
    expect(decide({ action: 'agent-remediate-checks', attempts: 0, maxAttempts: 2 })).toBe('do-fix');
    expect(decide({ action: 'agent-remediate-checks', attempts: 1, maxAttempts: 2 })).toBe('do-fix');
    expect(decide({ action: 'agent-remediate-checks', attempts: 2, maxAttempts: 2 })).toBe('stop-capped');
    expect(decide({ action: 'agent-remediate-review', attempts: 5, maxAttempts: 2 })).toBe('stop-capped');
  });

  it('the cap applies only to agent work — a rebase is mechanical and uncapped', () => {
    expect(decide({ action: 'rebase-only', attempts: 99, maxAttempts: 2 })).toBe('do-rebase');
  });
});

describe('shepherd --decide: action routing (D4 — classify_pr is the one source of truth)', () => {
  it('routes each classify_pr token to its shepherd action', () => {
    expect(decide({ action: 'agent-remediate-checks' })).toBe('do-fix');
    expect(decide({ action: 'agent-remediate-review' })).toBe('do-fix');
    expect(decide({ action: 'rebase-only' })).toBe('do-rebase');
  });

  it('surfaces conflicts, never auto-resolves them', () => {
    expect(decide({ action: 'skip-conflict' })).toBe('stop-conflict');
    // ...and does so regardless of remaining budget — more time never buys a merge.
    expect(decide({ action: 'skip-conflict', attempts: 0, elapsed: 0 })).toBe('stop-conflict');
  });

  it('refuses to drive a non-automation (human) PR', () => {
    expect(decide({ action: 'skip-not-automation' })).toBe('stop-not-automation');
  });

  it('waits — never claims success — while green but unmerged', () => {
    // "Nothing fixable" is not "merged". Declaring done here would be the classic
    // false signpost this project treats as the worst defect.
    expect(decide({ action: 'skip-clean', checksPending: 'yes' })).toBe('wait');
  });
});

describe('shepherd --decide: polling only while something async can still change', () => {
  // Regression for the blocking review finding on PR #975: with the shepherd running
  // before the merge actor, a clean PR polled the full hour and then emitted a
  // "reached its ceiling" hand-off on a PR that nothing was wrong with — which the
  // auto-merge gate then merged anyway. Polling must be tied to an async actor.
  it('keeps polling while checks are still running', () => {
    expect(decide({ action: 'skip-clean', checksPending: 'yes', automergeArmed: 'no' })).toBe('wait');
  });

  it('keeps polling while auto-merge is armed — GitHub will merge without us', () => {
    expect(decide({ action: 'skip-clean', checksPending: 'no', automergeArmed: 'yes' })).toBe('wait');
  });

  it('stops promptly when the only remaining gate is a HUMAN', () => {
    // No polling can move a human; burning the ceiling here wastes an hour of blocked
    // dispatch and then lies about why it stopped.
    expect(decide({ action: 'skip-clean', checksPending: 'no', automergeArmed: 'no' })).toBe(
      'stop-awaiting-human',
    );
  });

  it('never reports awaiting-human as a timeout or a hand-off', () => {
    const t = decide({ action: 'skip-clean', checksPending: 'no', automergeArmed: 'no' });
    expect(t).not.toBe('stop-timeout');
    expect(t).not.toBe('stop-capped');
  });

  it('a real failure still outranks the awaiting-human shortcut', () => {
    // A red check must be fixed, not shrugged off as "waiting for a human".
    expect(decide({ action: 'agent-remediate-checks', checksPending: 'no', automergeArmed: 'no' })).toBe(
      'do-fix',
    );
    expect(decide({ action: 'skip-conflict', checksPending: 'no', automergeArmed: 'no' })).toBe(
      'stop-conflict',
    );
  });

  it('fails closed on an unknown token instead of guessing', () => {
    expect(decide({ action: 'some-token-from-the-future' })).toBe('stop-not-automation');
    expect(decide({ action: '' })).toBe('stop-not-automation');
  });
});

// #1803 round 2 (PR #1813 review): classify_pr grew two new tokens — retry-unknown
// and skip-unhandled-state — for an UNKNOWN or otherwise unrecognised mergeStateStatus.
// The blocking review finding was that shepherd_decide had NO arm for either, so both
// fell through the `*)` default to stop-not-automation. Concretely: the creator-
// shepherd polls its own freshly-pushed PR, GitHub returns UNKNOWN (a routine cold
// read — the exact case #1803's fix targets), classify_pr returns retry-unknown, and
// the OLD shepherd_decide reported stop-not-automation — abandoning a PR that IS an
// automation branch with a false "outside automation scope" message. Each token now
// gets its own arm, proven distinct from every pre-existing one below.
describe('shepherd --decide: the two new #1803 classify_pr tokens get their OWN arms (#1813 round 2)', () => {
  it('retry-unknown does NOT get abandoned as not-automation (the exact blocking finding)', () => {
    expect(decide({ action: 'retry-unknown' })).not.toBe('stop-not-automation');
  });

  it('retry-unknown keeps polling — the merge state just has not resolved yet', () => {
    expect(decide({ action: 'retry-unknown' })).toBe('wait-unknown');
  });

  it('retry-unknown is a WAIT, not an escape from the FR-4 wall-clock ceiling', () => {
    expect(decide({ action: 'retry-unknown', elapsed: 3600, maxSecs: 3600 })).toBe('stop-timeout');
  });

  it('retry-unknown still stands down when the claim is lost (INV-5/D3)', () => {
    expect(decide({ action: 'retry-unknown', holds: 'no' })).toBe('stand-down');
  });

  it('skip-unhandled-state does NOT return stop-not-automation (this IS an automation branch)', () => {
    expect(decide({ action: 'skip-unhandled-state' })).not.toBe('stop-not-automation');
  });

  it('skip-unhandled-state does NOT collapse into the skip-clean wait/awaiting-human path either', () => {
    // Folding it into skip-clean's branch would silently re-introduce, one layer up,
    // the exact "unrecognised state treated as fine" bug #1803 fixed in classify_pr —
    // the reviewers' core objection to shipping the producer without this consumer.
    const t = decide({ action: 'skip-unhandled-state', checksPending: 'no', automergeArmed: 'no' });
    expect(t).not.toBe('stop-awaiting-human');
    expect(t).not.toBe('wait');
  });

  it('skip-unhandled-state gets its own honestly-named terminal token', () => {
    expect(decide({ action: 'skip-unhandled-state' })).toBe('stop-unhandled-state');
  });

  it('skip-unhandled-state still stands down when the claim is lost (INV-5/D3)', () => {
    expect(decide({ action: 'skip-unhandled-state', holds: 'no' })).toBe('stand-down');
  });

  it('a genuinely future/unrecognised token still falls closed to stop-not-automation (no regression)', () => {
    // Only the two tokens #1803 actually introduced get their own arm — the true
    // catch-all must still guard anything neither of us has seen yet.
    expect(decide({ action: 'some-token-from-the-future' })).toBe('stop-not-automation');
  });
});

describe('shepherd wiring: the loop is bounded by CODE, not by a token', () => {
  const code = fs.readFileSync(DISPATCH, 'utf-8');

  /** The body of shepherd_own_pr, from its definition to the next top-level `}`. */
  function shepherdBody(): string {
    const start = code.indexOf('shepherd_own_pr() {');
    expect(start, 'shepherd_own_pr must exist in dispatch-issue.sh').toBeGreaterThan(-1);
    const end = code.indexOf('\n}', start);
    return code.slice(start, end);
  }

  it('polls under a wall-clock condition rather than `while true`', () => {
    const body = shepherdBody();
    // A `while true` here would make the ceiling depend entirely on --decide returning
    // the right token — the failure mode this project gates against rather than trusts.
    expect(body).not.toMatch(/while true; do/);
    expect(body).toMatch(/while \(\( \$\(date -u \+%s\) <= loop_deadline \)\); do/);
  });

  it('hands off visibly when the ceiling is reached, never stops silently', () => {
    // A quiet return would read as "shepherded successfully" — a false signpost.
    expect(shepherdBody()).toMatch(/shepherd_hand_off .*ceiling/);
  });

  it('re-verifies the claim before electing any credentialed step (D3/INV-5)', () => {
    expect(shepherdBody()).toMatch(/lease_verify_holds "\$ISSUE"/);
  });

  it('never mutates ai-review:* labels — CI owns them (#600)', () => {
    const body = shepherdBody();
    expect(body).not.toMatch(/--add-label "ai-review:/);
    expect(body).not.toMatch(/--remove-label "ai-review:/);
  });

  it('shares ONE attempt budget with the drain rather than opening a second', () => {
    // Same marker the drain counts, so creator + drain attempts add up to one cap.
    expect(code).toMatch(/SHEPHERD_ATTEMPT_MARKER="<!-- minspec-auto-remediation -->"/);
  });

  it('bounds the BUILD phase by the absolute claim lifetime (FR-12)', () => {
    expect(code).toMatch(/BUILD_DEADLINE=\$\(\( \$\(date -u \+%s\) \+ LEASE_ABS_MAX_SECS \)\)/);
    expect(code).toMatch(/BUILD_TIMEOUT_ARGS=\(timeout --kill-after=30s "\$\{BUILD_REMAINING\}s"\)/);
  });

  it('tears the renew ticker down in the same EXIT trap that releases the claim (D10)', () => {
    expect(code).toMatch(/trap 'lease_stop_renew_ticker; lease_release_all[^']*' EXIT/);
  });

  it('runs the shepherd AFTER the in-process merge actor, never before it', () => {
    // Regression for the blocking finding on PR #975. Placed before `gh pr merge`,
    // a clean PR polls the whole ceiling, hands off as "no further automated
    // attempts", and is then merged by the very gate it gave up on.
    const mergeActor = code.indexOf('gh pr merge "$PR_NUM"');
    const shepherdCall = code.indexOf('shepherd_own_pr ||');
    expect(mergeActor, 'the SPEC-024 merge actor must exist').toBeGreaterThan(-1);
    expect(shepherdCall, 'the shepherd must be invoked').toBeGreaterThan(-1);
    expect(shepherdCall).toBeGreaterThan(mergeActor);
  });

  it('kills a build that ignores SIGTERM, so the FR-12 ceiling really bounds it', () => {
    expect(code).toMatch(/timeout --kill-after=30s/);
  });

  // #1813 round 2: BOTH consumers of classify_pr's vocabulary need an arm for the two
  // #1803 tokens — shepherd_decide (asserted above) AND dispatch-issue.sh's own case
  // statement, which turns a decide token into actual behaviour. Without an explicit
  // arm here, `stop-unhandled-state` would silently fall through to `sleep` and keep
  // polling for the full hour ceiling instead of stopping as its name promises — a
  // decide-token name that lies about what the caller actually does with it.
  it('handles wait-unknown and stop-unhandled-state explicitly, not via silent fallthrough', () => {
    const body = shepherdBody();
    expect(body).toMatch(/wait-unknown\)/);
    expect(body).toMatch(/stop-unhandled-state\)/);
  });

  it('stop-unhandled-state actually stops (returns) rather than looping under its own name', () => {
    const body = shepherdBody();
    const start = body.indexOf('stop-unhandled-state)');
    expect(start, 'stop-unhandled-state arm must exist').toBeGreaterThan(-1);
    const nextArmOrEnd = body.indexOf(';;', start);
    const arm = body.slice(start, nextArmOrEnd === -1 ? undefined : nextArmOrEnd);
    expect(arm).toMatch(/return 0/);
  });

  // Regression + gate for the second review round on PR #975. `automerge_armed` read
  // `.autoMergeRequest` from a `gh pr view --json` list that never requested it, so jq
  // returned null forever: the wait-while-armed branch was dead code, and a PR GitHub
  // would auto-merge got `stop-awaiting-human` instead. A missing --json field fails
  // SILENTLY (null, not an error), so the class needs a gate, not just the one fix.
  describe('every root field read from $pr_json is actually fetched', () => {
    const body = (() => {
      const start = code.indexOf('shepherd_own_pr() {');
      return code.slice(start, code.indexOf('\n}', start));
    })();

    /**
     * The field list on the `pr_json` fetch specifically — NOT merely the first
     * `--json` in the function, which belongs to the `gh pr list --json number`
     * lookup above it and would make this gate vacuously pass.
     */
    const fetched = (body.match(/pr_json=\$\(gh pr view[\s\S]*?--json ([A-Za-z,]+)/)?.[1] ?? '')
      .split(',')
      .filter(Boolean);

    /** Root-level fields read by every jq program applied to $pr_json. */
    const rootsRead = (() => {
      const roots = new Set<string>();
      for (const m of body.matchAll(/jq -r '([\s\S]*?)'\s*<<<"\$pr_json"/g)) {
        // A root access either starts the program or follows an opening bracket;
        // nested reads (`| (.status`, `]?.name`) are deliberately not matched.
        for (const f of m[1].matchAll(/(?:^|\[\s*)\.([A-Za-z][A-Za-z0-9_]*)/gm)) {
          roots.add(f[1]);
        }
      }
      return [...roots];
    })();

    it('is wired to the real fetch and real reads, not an empty set', () => {
      // Without this, an extraction bug would make every case below pass trivially.
      expect(fetched).toContain('state');
      expect(fetched.length).toBeGreaterThan(1);
      expect(rootsRead.length).toBeGreaterThan(1);
    });

    it('fetches autoMergeRequest — the field whose absence killed the armed branch', () => {
      expect(fetched).toContain('autoMergeRequest');
      expect(rootsRead).toContain('autoMergeRequest');
    });

    it.each(rootsRead)('root field .%s is in the --json fetch list', (field) => {
      expect(fetched).toContain(field);
    });
  });
});

describe('lease renew ticker: starts a live process and reaps it (D10 smoke)', () => {
  it('sets a live pid on start, and clears + kills it on stop', () => {
    const LEASE = path.resolve(__dirname, '../../../scripts/lib/issue-lease.sh');
    const script = `
      set -uo pipefail
      export MINSPEC_LEASE_REPO=owner/repo
      source ${JSON.stringify(LEASE)}
      LEASE_RENEW_SECS=1
      lease_renew() { :; }          # stub: the ticker must not touch the network here
      lease_start_renew_ticker 123
      [[ -n "$_LEASE_TICKER_PID" ]] || { echo NO_PID; exit 1; }
      pid=$_LEASE_TICKER_PID
      kill -0 "$pid" 2>/dev/null || { echo NOT_ALIVE; exit 1; }
      lease_start_renew_ticker 123  # idempotent: must not spawn a second ticker
      [[ "$_LEASE_TICKER_PID" == "$pid" ]] || { echo SPAWNED_TWICE; exit 1; }
      lease_stop_renew_ticker
      [[ -z "$_LEASE_TICKER_PID" ]] || { echo PID_NOT_CLEARED; exit 1; }
      sleep 0.4
      if kill -0 "$pid" 2>/dev/null; then echo STILL_ALIVE; exit 1; fi
      echo OK
    `;
    const out = execFileSync('bash', ['-c', script], {
      encoding: 'utf-8',
      cwd: path.resolve(__dirname, '../../..'),
    }).trim();
    expect(out).toBe('OK');
  });
});
