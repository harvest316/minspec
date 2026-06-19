/**
 * Review-signal renderer (#180) — the PR-side of just-enough-human.
 *
 * When the dev-time auto-build loop (DR-033 / #172, run via `/loop`) produces a
 * PR, the human reviewer should skim a VERIFIED signal block instead of
 * reconstructing it from the diff. This module renders that block.
 *
 * Three signals (DR-033 names #180 as the auto-merge backstop):
 *   1. Root-cause ↔ change       — the stated root cause maps to the diff.
 *   2. Regression distinguishes  — a named test that fails on the PRE-FIX (base)
 *      code and passes on head (the red→green "negative proof").
 *   3. Gate green                — test / lint / build / validate status.
 *
 * INVARIANTS (do not break):
 *   - DETERMINISTIC. Pure function of its inputs. No clock, no randomness, no
 *     I/O, no network, no LLM. Same input → byte-identical output.
 *   - HONEST RENDERING. A signal shows ✅ only when its evidence is present;
 *     otherwise ⚠️ (partial / unproven) or ❌ (absent / failed), and the line
 *     states what is missing. A signal block that lies is worse than none.
 *   - NO FALSE GREEN. Signal 2 renders ✅ ONLY when the regression was proven
 *     red on base AND green on head. A test that is merely NAMED — not run
 *     against base — renders ⚠️ UNVERIFIED, never ✅.
 *
 * Tier-0: lives in @aiclarity/shared, no `vscode`, no network. The /loop
 * dispatch consumes it (via `scripts/render-review-signals.mjs`) when it
 * assembles a PR body / comment.
 */

/** Pass / fail / unknown status for a single gate check. */
export type GateStatus = 'pass' | 'fail' | 'unknown';

/** Status of each gate the project runs before a PR is mergeable. */
export interface GateResults {
  test: GateStatus;
  lint: GateStatus;
  build: GateStatus;
  validate: GateStatus;
}

/**
 * Inputs for a single built change. Everything the renderer needs to decide
 * each signal's truth. No field is inferred from the environment — the caller
 * (the /loop dispatch) supplies measured facts.
 */
export interface ReviewSignalsInput {
  /** The stated root cause (RCDD `Root cause:` sentence), as prose. */
  rootCause: string;

  /** Every file the diff touches (e.g. `git diff --name-only base...head`). */
  changedFiles: string[];

  /**
   * The file(s) the stated root cause points at — the change that should fix
   * the cause. Signal 1 is green only when these are non-empty AND every one of
   * them appears in `changedFiles` (the claim matches the diff).
   */
  rootCauseFiles: string[];

  /**
   * Fully-qualified name of the regression test that distinguishes the fix
   * (e.g. `spec-validator.test.ts > rejects missing epic ref`). Absent → there
   * is no negative proof at all (Signal 2 = ❌).
   */
  regressionTest?: string;

  /**
   * TRUE iff the named regression was actually RUN against the BASE (pre-fix)
   * commit and observed to FAIL — the "red" half of red→green. This is the
   * strongest form of Signal 2. When false/absent, Signal 2 can be at most
   * ⚠️ UNVERIFIED, never ✅. Model this as a typed input because a pure
   * renderer cannot itself execute tests against base.
   */
  regressionProvenBaseRed?: boolean;

  /**
   * TRUE iff the named regression was run against HEAD and observed to PASS —
   * the "green" half. Both halves are required for a ✅ on Signal 2.
   */
  regressionProvenHeadGreen?: boolean;

  /** Gate/check results. Absent → gate not run / not supplied (Signal 3 = ❌). */
  gate?: GateResults;
}

/** Per-signal verdict — drives the icon and whether the block is fully green. */
type Verdict = 'green' | 'warn' | 'fail';

const ICON: Record<Verdict, string> = {
  green: '✅',
  warn: '⚠️',
  fail: '❌',
};

/** Format a list of file paths as inline-code, comma-separated. */
function fmtFiles(files: string[]): string {
  return files.map((f) => '`' + f + '`').join(', ');
}

/** Signal 1 — does the stated root cause map onto the diff? */
function rootCauseSignal(input: ReviewSignalsInput): {
  verdict: Verdict;
  detail: string;
} {
  const cause = input.rootCause?.trim() ?? '';
  if (cause === '') {
    return { verdict: 'fail', detail: 'no root cause stated.' };
  }

  const rcFiles = input.rootCauseFiles ?? [];
  if (rcFiles.length === 0) {
    return {
      verdict: 'warn',
      detail:
        'root cause stated, but no changed file is attributed to it — cannot confirm the diff addresses the cause.',
    };
  }

  // Every root-cause file must appear in the diff for a clean green.
  const changed = new Set(input.changedFiles ?? []);
  const missing = rcFiles.filter((f) => !changed.has(f));
  if (missing.length > 0) {
    return {
      verdict: 'warn',
      detail:
        'root cause names file(s) not present in the diff: ' +
        fmtFiles(missing) +
        ' — claim and change disagree.',
    };
  }

  return {
    verdict: 'green',
    detail:
      'stated cause maps to changed file(s): ' + fmtFiles(rcFiles) + '.',
  };
}

/** Signal 2 — is there a regression that PROVABLY fails on the pre-fix code? */
function regressionSignal(input: ReviewSignalsInput): {
  verdict: Verdict;
  detail: string;
} {
  const test = input.regressionTest?.trim();
  if (!test) {
    return {
      verdict: 'fail',
      detail:
        'no regression test named — nothing distinguishes fixed from broken.',
    };
  }

  const baseRed = input.regressionProvenBaseRed === true;
  const headGreen = input.regressionProvenHeadGreen === true;

  if (baseRed && headGreen) {
    return {
      verdict: 'green',
      detail:
        '`' +
        test +
        '` proven red→green: fails on base (pre-fix), passes on head.',
    };
  }

  // Named but not fully proven → honest UNVERIFIED, never a checkmark.
  const why: string[] = [];
  if (!baseRed) {
    why.push('not proven to FAIL on base (pre-fix) code');
  }
  if (!headGreen) {
    why.push('not proven to PASS on head');
  }
  return {
    verdict: 'warn',
    detail:
      '`' +
      test +
      '` named but UNVERIFIED — ' +
      why.join('; ') +
      '. Run it against base to prove red→green.',
  };
}

/** Signal 3 — is the gate (test/lint/build/validate) green? */
function gateSignal(input: ReviewSignalsInput): {
  verdict: Verdict;
  detail: string;
} {
  const gate = input.gate;
  if (!gate) {
    return {
      verdict: 'fail',
      detail: 'gate results not supplied — status unknown.',
    };
  }

  const checks: Array<[string, GateStatus]> = [
    ['test', gate.test],
    ['lint', gate.lint],
    ['build', gate.build],
    ['validate', gate.validate],
  ];

  const failed = checks.filter(([, s]) => s === 'fail').map(([n]) => n);
  if (failed.length > 0) {
    return {
      verdict: 'fail',
      detail: 'failing: ' + failed.join(', ') + '.',
    };
  }

  const unknown = checks.filter(([, s]) => s !== 'pass').map(([n]) => n);
  if (unknown.length > 0) {
    return {
      verdict: 'warn',
      detail: 'not reported: ' + unknown.join(', ') + ' (status unknown).',
    };
  }

  return {
    verdict: 'green',
    detail: 'test · lint · build · validate all pass.',
  };
}

/**
 * Render the honest 3-signal review block as markdown, suitable for a PR body
 * or PR comment.
 *
 * Deterministic and pure — given the same `input`, the returned string is
 * byte-identical. Never emits a ✅ for a signal whose evidence is absent.
 */
export function renderReviewSignals(input: ReviewSignalsInput): string {
  const rc = rootCauseSignal(input);
  const reg = regressionSignal(input);
  const gate = gateSignal(input);

  const allGreen =
    rc.verdict === 'green' &&
    reg.verdict === 'green' &&
    gate.verdict === 'green';

  const lines: string[] = [];
  lines.push('## Review signals (auto-built · #180)');
  lines.push('');
  lines.push(
    allGreen
      ? '> All three signals verified — a ~30s read should confirm.'
      : '> One or more signals are unverified or failed — read before merging.',
  );
  lines.push('');
  lines.push(
    ICON[rc.verdict] + ' **1. Root-cause ↔ change** — ' + rc.detail,
  );
  lines.push(
    ICON[reg.verdict] + ' **2. Regression distinguishes** — ' + reg.detail,
  );
  lines.push(ICON[gate.verdict] + ' **3. Gate green** — ' + gate.detail);
  lines.push('');
  lines.push(
    '<sub>Rendered by `@aiclarity/shared` `renderReviewSignals` — ' +
      'a green check requires present evidence; a warn/fail marker names what ' +
      'is missing. A signal block that lies is worse than none.</sub>',
  );

  return lines.join('\n');
}
