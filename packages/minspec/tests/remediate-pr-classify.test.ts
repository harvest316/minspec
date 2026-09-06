/**
 * T1/T2 — remediate-pr.sh classifier seam (drain PR-remediation sweep).
 *
 * The drain now sweeps open PRs and auto-remediates FIXABLE problems (ai-review:
 * changes, failing CI checks, behind-base) while SURFACING conflicts. The whole
 * decision lives in one pure CLI seam (`--classify`, no gh/git/claude) so it is
 * unit-testable in isolation — same convention as dispatch-ready-check.test.ts and
 * drain-continuous.test.ts. These assert the safety-critical properties:
 *   • only automation branches (agent/*, fix/*, feat/*) are ever touched, and
 *   • merge conflicts are NEVER auto-remediated (surfaced for a human), and
 *   • priority: real check failures before a re-review; behind-base last, and
 *   • SPEC-044 FR-6/INV-4 — the drain is an ORPHAN-FALLBACK: a PR whose work item is
 *     held by a live claim belongs to the session shepherding it, and is left alone.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const SCRIPT = path.resolve(__dirname, '../../../scripts/remediate-pr.sh');
const LIB = path.resolve(__dirname, '../../../scripts/lib/agent-egress.sh');

// classify_pr(branch, mergeable, mergeState, labelsCsv, failingNonReview, aiReviewBad,
//             [liveNonselfClaim])
// The 7th is OPTIONAL (SPEC-044 D5). Omitting it exercises the creator-shepherd's
// unchanged 6-argument contract; passing it exercises the drain's owner gate.
function classify(
  branch: string,
  mergeable: string,
  mergeState: string,
  labelsCsv: string,
  failingNonReview: 'yes' | 'no',
  aiReviewBad: 'yes' | 'no',
  liveNonselfClaim?: 'yes' | 'no',
): string {
  const args = [SCRIPT, '--classify', branch, mergeable, mergeState, labelsCsv, failingNonReview, aiReviewBad];
  if (liveNonselfClaim !== undefined) args.push(liveNonselfClaim);
  return execFileSync('bash', args, { encoding: 'utf-8' }).trim();
}

describe('remediate-pr.sh --classify: scope gate (only automation branches)', () => {
  it('skips a non-automation branch even when it has a fixable problem', () => {
    expect(classify('main', 'MERGEABLE', 'BLOCKED', 'ai-review:changes', 'no', 'yes')).toBe('skip-not-automation');
    expect(classify('my-feature', 'MERGEABLE', 'UNSTABLE', '', 'yes', 'no')).toBe('skip-not-automation');
    expect(classify('dependabot/npm/x', 'MERGEABLE', 'BEHIND', '', 'no', 'no')).toBe('skip-not-automation');
  });

  it.each(['agent/issue-1', 'fix/489-x', 'feat/thing'])('accepts automation branch %s', (branch) => {
    expect(classify(branch, 'MERGEABLE', 'BLOCKED', 'ai-review:changes', 'no', 'no')).toBe('agent-remediate-review');
  });
});

describe('remediate-pr.sh --classify: conflicts are surfaced, never auto-fixed', () => {
  it('CONFLICTING → skip-conflict (even with a review/label problem alongside)', () => {
    expect(classify('fix/x', 'CONFLICTING', 'DIRTY', 'ai-review:changes', 'yes', 'yes')).toBe('skip-conflict');
  });
  it('mergeStateStatus DIRTY → skip-conflict', () => {
    expect(classify('fix/x', 'UNKNOWN', 'DIRTY', '', 'no', 'no')).toBe('skip-conflict');
  });
});

describe('remediate-pr.sh --classify: problem priority', () => {
  it('failing non-review checks beat a re-review (fix the code first)', () => {
    expect(classify('feat/y', 'MERGEABLE', 'UNSTABLE', 'ai-review:changes', 'yes', 'yes')).toBe('agent-remediate-checks');
  });

  it('ai-review:changes via LABEL routes to review remediation', () => {
    expect(classify('fix/x', 'MERGEABLE', 'BLOCKED', 'ai-review:changes', 'no', 'no')).toBe('agent-remediate-review');
  });

  it('ai-review red CHECK (no label) routes to review remediation', () => {
    expect(classify('fix/x', 'MERGEABLE', 'BLOCKED', '', 'no', 'yes')).toBe('agent-remediate-review');
  });

  it('behind base only → rebase-only (mechanical, no agent)', () => {
    expect(classify('feat/y', 'MERGEABLE', 'BEHIND', '', 'no', 'no')).toBe('rebase-only');
  });

  it('clean automation PR → skip-clean', () => {
    expect(classify('fix/x', 'MERGEABLE', 'CLEAN', '', 'no', 'no')).toBe('skip-clean');
  });
});

// #1803: classify_pr's terminal fallthrough used to assert `skip-clean` — a POSITIVE
// health claim — for ANY mergeStateStatus it didn't recognise, not just the genuinely
// clean one. GitHub computes mergeStateStatus LAZILY, so a cold `gh pr view` routinely
// returns UNKNOWN; with no arm for it, that fell through the same "everything else is
// fine" default as BLOCKED/UNSTABLE/HAS_HOOKS/garbage. Constitution invariant 2
// forbids exactly this: an unreadable or unrecognised witness must fail closed and
// VISIBLY, never pass quietly as healthy. The fix makes CLEAN the only value that
// still returns skip-clean, gives UNKNOWN its own non-terminal `retry-unknown` (the
// call site re-polls once before trusting it — never a network call from --classify
// itself), and turns the terminal default into an honest, explicitly-named
// `skip-unhandled-state` rather than a silent health claim.
describe('remediate-pr.sh --classify: an UNKNOWN merge state never asserts health (#1803)', () => {
  it('reproduces the exact filed repro: UNKNOWN must NOT return skip-clean', () => {
    expect(classify('agent/issue-1511', 'MERGEABLE', 'UNKNOWN', '', 'no', 'no')).not.toBe('skip-clean');
  });

  it('UNKNOWN with no other fixable problem → retry-unknown (non-terminal, not a health claim)', () => {
    expect(classify('agent/issue-1511', 'MERGEABLE', 'UNKNOWN', '', 'no', 'no')).toBe('retry-unknown');
  });

  it('BEHIND is unaffected by the UNKNOWN fix (no regression)', () => {
    expect(classify('agent/issue-1511', 'MERGEABLE', 'BEHIND', '', 'no', 'no')).toBe('rebase-only');
  });

  it('a genuinely clean PR still returns skip-clean (no regression)', () => {
    expect(classify('fix/x', 'MERGEABLE', 'CLEAN', '', 'no', 'no')).toBe('skip-clean');
  });

  it('real check failures still outrank an UNKNOWN merge state (fix the code first)', () => {
    expect(classify('fix/x', 'MERGEABLE', 'UNKNOWN', '', 'yes', 'no')).toBe('agent-remediate-checks');
  });

  it('a pending re-review still outranks an UNKNOWN merge state', () => {
    expect(classify('fix/x', 'MERGEABLE', 'UNKNOWN', 'ai-review:changes', 'no', 'no')).toBe('agent-remediate-review');
  });

  it('an unrecognised/garbage merge state does not return skip-clean either', () => {
    const result = classify('fix/x', 'MERGEABLE', 'SOME_FUTURE_GITHUB_VALUE', '', 'no', 'no');
    expect(result).not.toBe('skip-clean');
    expect(result).toBe('skip-unhandled-state');
  });

  it('BLOCKED with no fixable problem is the SAME fallthrough bug, not a special case — also not skip-clean', () => {
    // This is the exact input the pre-fix suite asserted skip-clean for (see the
    // "clean automation PR" test above, before this fix). BLOCKED means the merge is
    // blocked — it was never actually clean; it only ever reached skip-clean by
    // falling through the same unguarded default this issue fixes for UNKNOWN.
    expect(classify('fix/x', 'MERGEABLE', 'BLOCKED', 'needs-human-review', 'no', 'no')).toBe('skip-unhandled-state');
  });
});

describe('remediate-pr.sh --classify: input hygiene', () => {
  it('tolerates an empty labels_csv without erroring', () => {
    // Regression: `${4:?}` used to reject an empty label CSV (colon errors on empty
    // too), aborting the seam. Count-check the args instead.
    expect(classify('fix/x', 'MERGEABLE', 'CLEAN', '', 'no', 'no')).toBe('skip-clean');
  });

  it('requires 6 or 7 args (usage error otherwise)', () => {
    // 7th = SPEC-044 live_nonself_claim, optional so the creator's 6-arg call stands.
    let code = 0;
    try {
      execFileSync('bash', [SCRIPT, '--classify', 'fix/x', 'MERGEABLE'], { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      code = e.status ?? 1;
    }
    expect(code).toBe(2);
  });
});

describe('remediate-pr.sh: shared egress guard is reused (no security-control drift)', () => {
  it('sources the shared lib rather than re-implementing the scan', () => {
    const src = fs.readFileSync(SCRIPT, 'utf-8');
    expect(src).toContain('source "${SCRIPT_DIR}/lib/agent-egress.sh"');
    expect(src).toContain('agent_egress_scan');
  });

  it('the shared egress lib exists and defines agent_egress_scan', () => {
    expect(fs.existsSync(LIB)).toBe(true);
    expect(fs.readFileSync(LIB, 'utf-8')).toContain('agent_egress_scan()');
  });

  it('dispatch-issue.sh ALSO sources the shared lib — the no-drift invariant is real, both publish channels share one scan', () => {
    // The claim is "no drift between dispatch-issue.sh and remediate-pr.sh": it
    // only holds if BOTH source the lib. Extraction landed on main via #747;
    // this asserts the second consumer (#750) shares it, so a future patch to the
    // scan touches one file, not two.
    const dispatch = fs.readFileSync(path.resolve(__dirname, '../../../scripts/dispatch-issue.sh'), 'utf-8');
    expect(dispatch).toContain('source "${SCRIPT_DIR}/lib/agent-egress.sh"');
    expect(dispatch).toContain('agent_egress_scan');
    // And neither re-implements the scan body (no inline git-log-p orchestration).
    const remediate = fs.readFileSync(SCRIPT, 'utf-8');
    expect(remediate).not.toMatch(/git .*log -p .*origin\/main/);
    expect(dispatch).not.toMatch(/local -a targets=\(\)/); // the old inline guard's array
  });
});

describe('remediate-pr.sh --classify: SPEC-044 owner gate (drain = orphan-fallback)', () => {
  // FR-6/INV-4. The drain is no longer the primary fixer: the session that opened a PR
  // shepherds it with the warm worktree and a fresh context budget (DR-067 D4). A
  // second remediator would duplicate the build and race the push — which is the #912
  // outage this whole spec exists to end.
  const FIXABLE: Array<[string, Parameters<typeof classify>]> = [
    ['failing checks', ['agent/issue-1', 'MERGEABLE', 'UNSTABLE', '', 'yes', 'no', 'yes']],
    ['review changes', ['agent/issue-1', 'MERGEABLE', 'BLOCKED', 'ai-review:changes', 'no', 'no', 'yes']],
    ['behind base', ['agent/issue-1', 'MERGEABLE', 'BEHIND', '', 'no', 'no', 'yes']],
    ['conflicting', ['agent/issue-1', 'CONFLICTING', 'DIRTY', '', 'no', 'no', 'yes']],
    ['clean', ['agent/issue-1', 'MERGEABLE', 'CLEAN', '', 'no', 'no', 'yes']],
  ];

  it.each(FIXABLE)('a live claim outranks every other state (%s)', (_label, args) => {
    expect(classify(...args)).toBe('skip-live-owned');
  });

  it('claims ownership BEFORE interpreting PR state — even a red PR is not ours', () => {
    // Ordering matters: if the gate sat after the check/review arms, the drain would
    // start remediating a live-owned PR the moment it went red — exactly the race.
    expect(classify('agent/issue-1', 'MERGEABLE', 'UNSTABLE', 'ai-review:changes', 'yes', 'yes', 'yes')).toBe(
      'skip-live-owned',
    );
  });

  it('but scope still wins — a human branch is skipped as such, not as live-owned', () => {
    expect(classify('main', 'MERGEABLE', 'UNSTABLE', '', 'yes', 'no', 'yes')).toBe('skip-not-automation');
  });

  it('adopts the PR normally once no live claim holds it (the ORPHAN case)', () => {
    expect(classify('agent/issue-1', 'MERGEABLE', 'UNSTABLE', '', 'yes', 'no', 'no')).toBe(
      'agent-remediate-checks',
    );
    expect(classify('agent/issue-1', 'MERGEABLE', 'BLOCKED', 'ai-review:changes', 'no', 'no', 'no')).toBe(
      'agent-remediate-review',
    );
    expect(classify('agent/issue-1', 'MERGEABLE', 'BEHIND', '', 'no', 'no', 'no')).toBe('rebase-only');
  });

  it('defaults to "no" when omitted — the creator-shepherd contract is unchanged', () => {
    // The creator IS the owner; skip-live-owned must never fire on its own PR, or the
    // shepherd would stand down from the work it just built.
    expect(classify('agent/issue-1', 'MERGEABLE', 'UNSTABLE', '', 'yes', 'no')).toBe('agent-remediate-checks');
    expect(classify('agent/issue-1', 'CONFLICTING', 'DIRTY', '', 'no', 'no')).toBe('skip-conflict');
  });

  it('rejects a malformed arity rather than guessing', () => {
    expect(() =>
      execFileSync('bash', [SCRIPT, '--classify', 'agent/issue-1', 'MERGEABLE'], { encoding: 'utf-8' }),
    ).toThrow();
  });
});

describe('remediate-pr.sh: the drain honours the owner gate without extra wiring', () => {
  const code = fs.readFileSync(SCRIPT, 'utf-8');

  it('derives the work item from the branch and asks issue-lease reclaim?', () => {
    expect(code).toMatch(/BRANCH" =~ issue-\(\[0-9\]\+\)/);
    expect(code).toMatch(/issue-lease\.sh' 'reclaim\?'|issue-lease\.sh" 'reclaim\?'/);
  });

  it('fails CLOSED: any nonzero reclaim? means hands off', () => {
    // reclaim? exits nonzero for BOTH "a live claim exists" and "could not enumerate".
    // Treating only the former as owned would let a network blip race a live owner.
    expect(code).toMatch(/if ! MINSPEC_LEASE_REPO="\$REPO" bash .*'reclaim\?' "\$ITEM"[^\n]*\n\s*LIVE_NONSELF_CLAIM=yes/);
  });

  it('takes no side effect on a live-owned PR — no label, comment, or attempt', () => {
    const arm = code.slice(code.indexOf('  skip-live-owned)'), code.indexOf('  skip-conflict)'));
    expect(arm).not.toMatch(/gh pr edit|gh pr comment|--add-label/);
    expect(arm).toMatch(/exit 0/);
  });
});
