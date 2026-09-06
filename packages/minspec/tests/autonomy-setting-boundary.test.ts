/**
 * T0 — the autonomy SETTING cannot be flipped unseen.
 *
 * DR-086 §2.6 makes "anything that would edit this list, or the autonomy setting
 * itself" an always-stop class. That was prose with nothing behind it for the
 * setting: `.minspec/` is not in the machinery regexes and `config.json` matched
 * no basename rule, so a PR flipping `autonomy: ask -> act` classified low-blast
 * and could auto-merge with nobody reading it.
 *
 * The self-amending shape is the one a bounded grant must never have, so this is
 * asserted rather than remembered.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isBoundaryPath, detectBoundaryChange } from '../../../scripts/auto-merge-gate';
import type { ChangedFile } from '../../../scripts/auto-merge-gate';
import type { ClassificationSignal } from '../src/lib/auto-merge';
import { decideAutoMerge } from '../src/lib/auto-merge';

const cf = (path: string): ChangedFile => ({ insertions: 1, deletions: 0, status: 'modified', path });

describe('the autonomy setting is a boundary file', () => {
  it('.minspec/config.json is a boundary path', () => {
    expect(isBoundaryPath('.minspec/config.json')).toBe(true);
  });

  it('a config-only diff injects the high-blast signal, so it cannot auto-merge', () => {
    const sig = detectBoundaryChange([{ path: '.minspec/config.json', status: 'modified' } as never]);
    expect(sig).toBeDefined();
    expect(sig!.tierContribution).toBe('T4');
    expect(sig!.explain).toContain('.minspec/config.json');
  });

  it('matches regardless of path spelling', () => {
    for (const p of ['./.minspec/config.json', '.minspec\\config.json']) {
      expect(isBoundaryPath(p)).toBe(true);
    }
  });
});

describe('the rule is PRECISE — a boundary that fires constantly gets routed around', () => {
  it('does not sweep the approval sidecars', () => {
    // A `.minspec/` prefix rule would classify every routine approval HIGH.
    // There are 61 of these; friction that large is how a gate gets disabled.
    expect(isBoundaryPath('.minspec/approvals/specs/minspec/SPEC-062/approval.json')).toBe(false);
    expect(isBoundaryPath('.minspec/classifications/foo.json')).toBe(false);
  });

  it('does not match config.json anywhere else in the tree', () => {
    // A `config.json` BASENAME rule would match all of these.
    for (const p of ['src/config.json', 'packages/minspec/config.json', 'config.json']) {
      expect(isBoundaryPath(p)).toBe(false);
    }
  });
});

describe('the setting on disk', () => {
  const cfgPath = path.resolve(__dirname, '../../../.minspec/config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;

  it('is one of the two tokens the resolver recognises, never a typo that silently means ask', () => {
    // A misspelled value resolves to `ask` by design, which is safe but silent —
    // the repo would believe it had set something it had not.
    if ('autonomy' in cfg) expect(['ask', 'act']).toContain(cfg.autonomy);
  });
});

describe('the control REACHES the population it protects (DR-088 standard)', () => {
  // Asserting that detectBoundaryChange returns a signal proves the detector
  // works, NOT that anything acts on it. A compensating control that is recorded
  // as protection while not reaching what it protects is worse than no control,
  // because it stops anyone looking. So this drives the real decision.
  it('a config-only diff is INELIGIBLE for auto-merge, end-to-end through the pure gate', () => {
    const changed: ChangedFile[] = [cf('.minspec/config.json')];
    const boundarySignal = detectBoundaryChange(changed);
    expect(boundarySignal).toBeDefined();
    const consequenceSignals: ClassificationSignal[] = boundarySignal ? [boundarySignal] : [];

    const d = decideAutoMerge({
      reviewSignals: {
        rootCause: 'flip the autonomy setting',
        changedFiles: ['.minspec/config.json'],
        rootCauseFiles: ['.minspec/config.json'],
        regressionTest: 'x.test.ts > y',
        gate: { test: 'pass', lint: 'pass', build: 'pass', validate: 'pass' },
      },
      hollowFindings: [],
      consequenceSignals,
      mode: 'consequence-hybrid',
      proverResult: { regressionProvenBaseRed: true, regressionGreenOnHead: true, note: 'proven' },
    });

    expect(d.blast).toBe('high');
    expect(d.eligible).toBe(false);
    expect(d.failed).toContain('high-blast');
  });

  it('is a SECOND witness: the diff is already held without it, and still held with it', () => {
    // The counterfactual, run honestly — and it refutes the framing I started
    // with. WITHOUT the boundary signal the diff is ALREADY high-blast, because
    // #490 made absence of an affirmative low signal mean high (deny-by-default),
    // and `.minspec/config.json` is neither docs nor test so it can never earn
    // `low_blast_docs_test_only`. So this rule does NOT close a reachable hole
    // today; claiming it did would be recording a control that changes no
    // outcome.
    //
    // It earns its place as an INDEPENDENT second witness instead (constitution
    // invariant 2: no load-bearing gate hinging on a single producer). Today the
    // hold rests solely on deny-by-default; one widening of the docs/test
    // classifier would remove it silently. Note where the two meet:
    // detectLowBlastDocsTest itself excludes `isBoundaryPath` files, so this rule
    // is precisely the hook that keeps the setting out of any future low-blast
    // certification.
    const withoutRule = decideAutoMerge({
      reviewSignals: {
        rootCause: 'flip the autonomy setting',
        changedFiles: ['.minspec/config.json'],
        rootCauseFiles: ['.minspec/config.json'],
        regressionTest: 'x.test.ts > y',
        gate: { test: 'pass', lint: 'pass', build: 'pass', validate: 'pass' },
      },
      hollowFindings: [],
      consequenceSignals: [],
      mode: 'consequence-hybrid',
      proverResult: { regressionProvenBaseRed: true, regressionGreenOnHead: true, note: 'proven' },
    });
    expect(withoutRule.eligible).toBe(false);
  });
});
