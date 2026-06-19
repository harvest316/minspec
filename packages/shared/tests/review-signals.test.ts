/**
 * T0/T2 — Review-signal renderer (#180)
 *
 * Auto-built PRs (DR-033 /loop) must self-report THREE review signals as a
 * VERIFIED, structured markdown block the human reviewer skims instead of
 * reconstructing:
 *   1. Root-cause ↔ change   — stated root cause maps to the diff.
 *   2. Regression distinguishes — a named test that fails on the PRE-FIX (base)
 *      code and passes on head (red→green "negative proof").
 *   3. Gate green             — test / lint / build / validate status.
 *
 * Invariants under test:
 *   - Deterministic: same input → identical output (no clock / randomness / I/O).
 *   - Honest rendering: ✅ ONLY when a signal's evidence is present; otherwise
 *     ⚠️ / ❌ stating what is missing.
 *   - NO FALSE GREEN: a regression whose red→green base proof was NOT supplied
 *     renders ⚠️ UNVERIFIED, never ✅. A missing gate renders ❌.
 */

import { describe, it, expect } from 'vitest';
import {
  renderReviewSignals,
  type ReviewSignalsInput,
} from '@aiclarity/shared';

// A fully-green input: every signal has its evidence.
const allGreen: ReviewSignalsInput = {
  rootCause: 'Validator flagged dangling epic refs but never missing ones.',
  changedFiles: ['packages/minspec/src/lib/spec-validator.ts'],
  rootCauseFiles: ['packages/minspec/src/lib/spec-validator.ts'],
  regressionTest: 'spec-validator.test.ts > rejects missing epic ref',
  regressionProvenBaseRed: true,
  regressionProvenHeadGreen: true,
  gate: {
    test: 'pass',
    lint: 'pass',
    build: 'pass',
    validate: 'pass',
  },
};

describe('renderReviewSignals — honest 3-signal block', () => {
  it('renders three ✅ when all signals have evidence', () => {
    const out = renderReviewSignals(allGreen);

    // Exactly three checkmarks — one per signal, none missing, none extra.
    expect(out.match(/✅/g)?.length).toBe(3);
    expect(out).not.toContain('⚠️');
    expect(out).not.toContain('❌');

    // Each signal is present and named.
    expect(out).toContain('Root-cause ↔ change');
    expect(out).toContain('Regression distinguishes');
    expect(out).toContain('Gate green');

    // The proven regression test is named with its red→green proof.
    expect(out).toContain('spec-validator.test.ts > rejects missing epic ref');
    expect(out).toMatch(/red.?→.?green|red→green/);
  });

  it('is deterministic — identical output for identical input', () => {
    expect(renderReviewSignals(allGreen)).toBe(renderReviewSignals(allGreen));
  });

  it('renders ⚠️ UNVERIFIED (NOT ✅) when the regression base-red proof is absent', () => {
    const input: ReviewSignalsInput = {
      ...allGreen,
      regressionProvenBaseRed: false,
    };
    const out = renderReviewSignals(input);

    // The regression line must be UNVERIFIED, not a green checkmark.
    expect(out).toContain('⚠️');
    expect(out).toContain('UNVERIFIED');

    // CRITICAL no-false-green: there must NOT be a ✅ on the regression line.
    const regLine = out
      .split('\n')
      .find((l) => l.includes('Regression distinguishes'));
    expect(regLine).toBeDefined();
    expect(regLine).not.toContain('✅');
    expect(regLine).toContain('⚠️');

    // The other two signals stay green → only 2 ✅ overall.
    expect(out.match(/✅/g)?.length).toBe(2);
  });

  it('renders ⚠️ UNVERIFIED when a regression test is NAMED but never run against base', () => {
    const input: ReviewSignalsInput = {
      ...allGreen,
      regressionProvenBaseRed: false,
      regressionProvenHeadGreen: false,
    };
    const out = renderReviewSignals(input);
    const regLine = out
      .split('\n')
      .find((l) => l.includes('Regression distinguishes'));
    // Still names the test, but does not claim proof.
    expect(regLine).toContain('spec-validator.test.ts > rejects missing epic ref');
    expect(regLine).toContain('⚠️');
    expect(regLine).not.toContain('✅');
  });

  it('renders ❌ when there is no regression test at all', () => {
    const input: ReviewSignalsInput = {
      ...allGreen,
      regressionTest: undefined,
      regressionProvenBaseRed: false,
      regressionProvenHeadGreen: false,
    };
    const out = renderReviewSignals(input);
    const regLine = out
      .split('\n')
      .find((l) => l.includes('Regression distinguishes'));
    expect(regLine).toContain('❌');
    expect(regLine).not.toContain('✅');
    expect(out).toMatch(/no regression test/i);
  });

  it('renders ❌ when the gate is missing / not supplied', () => {
    const input: ReviewSignalsInput = {
      ...allGreen,
      gate: undefined,
    };
    const out = renderReviewSignals(input);
    const gateLine = out
      .split('\n')
      .find((l) => l.includes('Gate green'));
    expect(gateLine).toContain('❌');
    expect(gateLine).not.toContain('✅');
  });

  it('renders ❌ on the gate line when any gate check failed', () => {
    const input: ReviewSignalsInput = {
      ...allGreen,
      gate: { test: 'fail', lint: 'pass', build: 'pass', validate: 'pass' },
    };
    const out = renderReviewSignals(input);
    const gateLine = out
      .split('\n')
      .find((l) => l.includes('Gate green'));
    expect(gateLine).toContain('❌');
    expect(gateLine).not.toContain('✅');
    // The failing check is named.
    expect(out).toMatch(/test/);
  });

  it('renders ⚠️ on the gate line when checks are unknown (partially supplied)', () => {
    const input: ReviewSignalsInput = {
      ...allGreen,
      gate: { test: 'pass', lint: 'unknown', build: 'pass', validate: 'unknown' },
    };
    const out = renderReviewSignals(input);
    const gateLine = out
      .split('\n')
      .find((l) => l.includes('Gate green'));
    expect(gateLine).toContain('⚠️');
    expect(gateLine).not.toContain('✅');
    expect(gateLine).not.toContain('❌');
  });

  it('renders ⚠️ on root-cause when no changed files map to the cause', () => {
    const input: ReviewSignalsInput = {
      ...allGreen,
      rootCauseFiles: [],
    };
    const out = renderReviewSignals(input);
    const rcLine = out
      .split('\n')
      .find((l) => l.includes('Root-cause ↔ change'));
    expect(rcLine).toContain('⚠️');
    expect(rcLine).not.toContain('✅');
  });

  it('renders ❌ on root-cause when the stated cause is empty', () => {
    const input: ReviewSignalsInput = {
      ...allGreen,
      rootCause: '   ',
    };
    const out = renderReviewSignals(input);
    const rcLine = out
      .split('\n')
      .find((l) => l.includes('Root-cause ↔ change'));
    expect(rcLine).toContain('❌');
    expect(rcLine).not.toContain('✅');
    expect(out).toMatch(/no root cause/i);
  });

  it('flags root-cause files that are not in the diff (claim vs reality drift)', () => {
    const input: ReviewSignalsInput = {
      ...allGreen,
      changedFiles: ['packages/minspec/src/lib/spec-validator.ts'],
      // claims a file the diff does not contain
      rootCauseFiles: [
        'packages/minspec/src/lib/spec-validator.ts',
        'packages/minspec/src/lib/ghost.ts',
      ],
    };
    const out = renderReviewSignals(input);
    const rcLine = out
      .split('\n')
      .find((l) => l.includes('Root-cause ↔ change'));
    // Some root-cause files map, but one does not → not a clean ✅.
    expect(rcLine).toContain('⚠️');
    expect(rcLine).not.toContain('✅');
    expect(out).toContain('ghost.ts');
  });

  it('opens with a header and three signal lines (stable structure)', () => {
    const out = renderReviewSignals(allGreen);
    expect(out).toMatch(/##.*[Rr]eview [Ss]ignals/);
    // Three numbered / bulleted signal lines.
    const lines = out.split('\n').filter((l) => /✅|⚠️|❌/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});
