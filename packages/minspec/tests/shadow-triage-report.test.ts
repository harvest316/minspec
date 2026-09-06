/**
 * T0/T1 — the shadow-triage aggregation, over synthetic rows (#1338).
 *
 * `aggregate` is the function the pilot's go/no-go decision is read off, so it is a
 * pure function of parsed rows and is pinned here against constructed inputs rather
 * than against whatever the log happens to contain. The two rollback triggers
 * (#1338: agreement below 90%, or malformed blocks above 2%) are exercised AT their
 * boundaries, because an off-by-one on a threshold is how a failing pilot gets
 * promoted.
 *
 * The denominators are the subtle part and each has its own specs below:
 *   errored rows   are excluded from BOTH metrics — a z.ai outage is a fact about the
 *                  pilot's plumbing, not about GLM's fitness, and folding it into the
 *                  malformed rate would let an outage read as a model defect.
 *   malformed %    is over RESPONDED rows (conformance is a property of a response).
 *   agreement %    is over CONFORMANT rows (you cannot agree with a verdict that was
 *                  never emitted; counting an absent verdict as disagreement would
 *                  double-count the defect the malformed metric already reports).
 */

import { describe, it, expect } from 'vitest';
import {
  aggregate,
  parseRows,
  formatReport,
  AGREEMENT_MIN_PCT,
  MALFORMED_MAX_PCT,
  type ShadowRow,
} from '../../../scripts/shadow-triage-report';

const LIVE = { label: 'agent-ready', role: 'dev', hold: 'none', tier: 'T1', human_only: 'no' };

/** A row that agrees on every field unless told otherwise. */
function row(over: Partial<ShadowRow> = {}, agreeOver: Partial<ShadowRow['agree']> = {}): ShadowRow {
  return {
    schema: 'minspec-shadow-triage/1',
    issue: 1,
    repo: 'AIClarityAU/minspec',
    at: '2026-08-07T00:00:00Z',
    model: 'glm-5.2',
    baseUrl: 'https://api.z.ai/api/anthropic',
    conformant: true,
    latencyMs: 1000,
    error: null,
    live: { ...LIVE },
    shadow: { ...LIVE },
    agree: { label: true, role: true, hold: true, tier: true, human_only: true, all: true, ...agreeOver },
    ...over,
  };
}

/** n rows that agree, plus m that disagree on tier+label. */
const mix = (agreeing: number, disagreeing: number): ShadowRow[] => [
  ...Array.from({ length: agreeing }, () => row()),
  ...Array.from({ length: disagreeing }, () =>
    row({ shadow: { ...LIVE, label: 'needs-review', tier: 'T3' } }, { label: false, tier: false, all: false }),
  ),
];

describe('aggregate — the headline metric (#1338: exact tier and type agreement)', () => {
  it('total agreement is 100% and both triggers PASS', () => {
    const r = aggregate(mix(10, 0));
    expect(r.n).toBe(10);
    expect(r.tierTypeAgreementPct).toBe(100);
    expect(r.malformedPct).toBe(0);
    expect(r.overall).toBe('PASS');
  });

  it('total disagreement is 0% and the agreement trigger FAILS', () => {
    const r = aggregate(mix(0, 10));
    expect(r.tierTypeAgreementPct).toBe(0);
    expect(r.triggers.agreement.verdict).toBe('FAIL');
    expect(r.overall).toBe('FAIL');
  });

  it('requires BOTH tier and type — agreeing on tier alone does not count', () => {
    // The metric #1338 names is the conjunction. A model that always says T1 would
    // score well on tier alone while classifying everything wrongly.
    const rows = [row({ shadow: { ...LIVE, label: 'needs-review' } }, { label: false, all: false })];
    const r = aggregate(rows);
    expect(r.agreementPct.tier).toBe(100);
    expect(r.tierTypeAgreementPct).toBe(0);
  });

  it('reports every field separately, so a systematic single-field drift is visible', () => {
    const rows = [
      row(),
      row({ shadow: { ...LIVE, role: 'architect' } }, { role: false, all: false }),
      row({ shadow: { ...LIVE, role: 'architect' } }, { role: false, all: false }),
      row({ shadow: { ...LIVE, role: 'architect' } }, { role: false, all: false }),
    ];
    const r = aggregate(rows);
    expect(r.agreementPct.role).toBe(25);
    expect(r.agreementPct.label).toBe(100);
    expect(r.tierTypeAgreementPct).toBe(100);
  });
});

describe('aggregate — the 90% agreement rollback boundary', () => {
  it(`exactly ${AGREEMENT_MIN_PCT}% PASSES (the trigger is "below 90%", not "at or below")`, () => {
    const r = aggregate(mix(90, 10));
    expect(r.tierTypeAgreementPct).toBe(90);
    expect(r.triggers.agreement.verdict).toBe('PASS');
  });

  it('one sample below the boundary FAILS', () => {
    const r = aggregate(mix(89, 11));
    expect(r.tierTypeAgreementPct).toBe(89);
    expect(r.triggers.agreement.verdict).toBe('FAIL');
    expect(r.overall).toBe('FAIL');
  });

  it('one sample above the boundary PASSES', () => {
    const r = aggregate(mix(91, 9));
    expect(r.triggers.agreement.verdict).toBe('PASS');
  });
});

describe('aggregate — the 2% malformed rollback boundary', () => {
  const withMalformed = (ok: number, bad: number): ShadowRow[] => [
    ...Array.from({ length: ok }, () => row()),
    ...Array.from({ length: bad }, () =>
      row({ conformant: false, shadow: {} }, { label: false, role: false, hold: false, tier: false, human_only: false, all: false }),
    ),
  ];

  it(`exactly ${MALFORMED_MAX_PCT}% PASSES (the trigger is "above 2%")`, () => {
    const r = aggregate(withMalformed(98, 2));
    expect(r.malformedPct).toBe(2);
    expect(r.triggers.malformed.verdict).toBe('PASS');
  });

  it('one sample over the boundary FAILS', () => {
    const r = aggregate(withMalformed(97, 3));
    expect(r.malformedPct).toBe(3);
    expect(r.triggers.malformed.verdict).toBe('FAIL');
    expect(r.overall).toBe('FAIL');
  });

  it('malformed rows are EXCLUDED from the agreement denominator, not scored as disagreement', () => {
    // 98 conformant rows all agree; 2 malformed. Agreement is 100% of what could be
    // compared, and the malformed metric carries the other defect on its own. Scoring
    // them as disagreement would report the same failure twice and understate a model
    // that classifies well but formats badly — two different remedies.
    const r = aggregate(withMalformed(98, 2));
    expect(r.conformant).toBe(98);
    expect(r.tierTypeAgreementPct).toBe(100);
    expect(r.triggers.agreement.verdict).toBe('PASS');
    expect(r.triggers.malformed.verdict).toBe('PASS');
    expect(r.overall).toBe('PASS');
  });

  it('a tripped malformed trigger fails OVERALL even when agreement is perfect', () => {
    const r = aggregate(withMalformed(50, 50));
    expect(r.tierTypeAgreementPct).toBe(100);
    expect(r.overall).toBe('FAIL');
  });
});

describe('aggregate — endpoint errors are not model defects', () => {
  const errored = (n: number): ShadowRow[] =>
    Array.from({ length: n }, () =>
      row({ error: 'timeout', conformant: false, shadow: {} }, {
        label: false, role: false, hold: false, tier: false, human_only: false, all: false,
      }),
    );

  it('an errored row counts in n but in neither denominator', () => {
    const r = aggregate([...mix(10, 0), ...errored(5)]);
    expect(r.n).toBe(15);
    expect(r.errored).toBe(5);
    expect(r.responded).toBe(10);
    expect(r.conformant).toBe(10);
    // A five-sample z.ai outage must not read as a 33% malformed rate.
    expect(r.malformedPct).toBe(0);
    expect(r.tierTypeAgreementPct).toBe(100);
    expect(r.overall).toBe('PASS');
  });

  it('a log of nothing but errors is INSUFFICIENT, never PASS and never FAIL', () => {
    const r = aggregate(errored(20));
    expect(r.n).toBe(20);
    expect(r.malformedPct).toBeNull();
    expect(r.tierTypeAgreementPct).toBeNull();
    expect(r.overall).toBe('INSUFFICIENT');
  });
});

describe('aggregate — "no data" is its own answer, not a pass', () => {
  it('an empty log is INSUFFICIENT', () => {
    // Printing PASS here would announce the pilot cleared a bar it was never measured
    // against — the exact false-signpost class this repo treats as the worst defect.
    const r = aggregate([]);
    expect(r.n).toBe(0);
    expect(r.tierTypeAgreementPct).toBeNull();
    expect(r.malformedPct).toBeNull();
    expect(r.overall).toBe('INSUFFICIENT');
    expect(r.triggers.agreement.verdict).toBe('INSUFFICIENT');
    expect(r.triggers.malformed.verdict).toBe('INSUFFICIENT');
  });

  it('a real FAIL still dominates an INSUFFICIENT sibling', () => {
    // One tripped trigger is a rollback regardless of whether the other could be read.
    const rows = [...mix(0, 10)];
    const r = aggregate(rows);
    expect(r.triggers.agreement.verdict).toBe('FAIL');
    expect(r.overall).toBe('FAIL');
  });
});

describe('aggregate — the model id travels with the numbers', () => {
  it('collects the distinct models present', () => {
    expect(aggregate(mix(3, 0)).models).toEqual(['glm-5.2']);
  });

  it('a log mixing models reports BOTH, so a moving target is visible', () => {
    // #1338's core objection: an agreement figure against an unpinned endpoint is a
    // figure about nothing. If the log mixes ids, the reader has to know.
    const r = aggregate([row(), row({ model: 'glm-4.7' })]);
    expect(r.models).toEqual(['glm-4.7', 'glm-5.2']);
    expect(formatReport(r)).toMatch(/more than one model/);
  });

  it('median latency is reported over all rows', () => {
    const r = aggregate([row({ latencyMs: 100 }), row({ latencyMs: 300 }), row({ latencyMs: 200 })]);
    expect(r.medianLatencyMs).toBe(200);
  });
});

describe('parseRows — a log line that cannot be read is counted, never silently dropped', () => {
  it('parses well-formed JSONL', () => {
    const text = [JSON.stringify(row()), JSON.stringify(row({ issue: 2 }))].join('\n');
    const { rows, unparseable } = parseRows(text);
    expect(rows).toHaveLength(2);
    expect(unparseable).toBe(0);
  });

  it('blank lines are not rows and are not errors', () => {
    const { rows, unparseable } = parseRows(`\n${JSON.stringify(row())}\n\n`);
    expect(rows).toHaveLength(1);
    expect(unparseable).toBe(0);
  });

  it('a truncated line (an interrupted append) is counted as unparseable', () => {
    // A report that quietly ignored half its input would understate n and overstate
    // confidence — the number of samples is itself part of the evidence.
    const { rows, unparseable } = parseRows(`${JSON.stringify(row())}\n{"schema":"minspec-sha`);
    expect(rows).toHaveLength(1);
    expect(unparseable).toBe(1);
  });

  it('a JSON value that is not a row is counted as unparseable', () => {
    const { rows, unparseable } = parseRows('"just a string"\n[]\n{"no":"issue number"}');
    expect(rows).toHaveLength(0);
    expect(unparseable).toBe(3);
  });

  it('the report surfaces the unparseable count rather than burying it', () => {
    expect(formatReport(aggregate([row()]), 2)).toMatch(/unparseable rows 2/);
  });
});

describe('formatReport — the human-facing summary states the triggers explicitly', () => {
  it('names both triggers, their thresholds and their verdicts', () => {
    const out = formatReport(aggregate(mix(89, 11)));
    expect(out).toMatch(/tier\+type agreement/);
    expect(out).toMatch(new RegExp(`need >= ${AGREEMENT_MIN_PCT}%`));
    expect(out).toMatch(/malformed blocks/);
    expect(out).toMatch(new RegExp(`need <= ${MALFORMED_MAX_PCT}%`));
    expect(out).toMatch(/OVERALL: FAIL/);
  });

  it('an empty log says INSUFFICIENT in words, not a bare 0%', () => {
    const out = formatReport(aggregate([]));
    expect(out).toMatch(/OVERALL: INSUFFICIENT/);
    expect(out).toMatch(/this is not a pass/i);
  });

  it('shows progress against the pilot target while n is short of it', () => {
    expect(formatReport(aggregate(mix(10, 0)))).toMatch(/pilot target: 50/);
  });
});

/**
 * T0 — a pooled figure over MIXED MODELS cannot report PASS (#1338, #1389 review).
 *
 * The default model is the `latest` sentinel, resolved per run, so a z.ai release
 * mid-pilot puts two models in one log. #1338 asked for a pin precisely to stop that.
 * The pin was dropped on the stated grounds that "the report groups by model, so a
 * version change splits the sample" — a claim that was FALSE when written: aggregate()
 * pooled every row and formatReport only printed a warning beside the verdict.
 *
 * These cases exist so that justification is now backed by behaviour rather than by a
 * comment. The warning was never the fix: a reader acts on the automated trigger, and
 * a trigger computed over blended targets is a verdict about nothing.
 */
describe('shadow-triage report — mixed models cannot PASS', () => {
  const perfect = (model: string, n: number) =>
    Array.from({ length: n }, () => row({ model }));

  it('a single-model log that clears both thresholds still PASSES', () => {
    // The control. Without this, a fix that broke PASS entirely would look correct.
    const r = aggregate(perfect('glm-5.2', 20));
    expect(r.models).toEqual(['glm-5.2']);
    expect(r.triggers.agreement.verdict).toBe('PASS');
    expect(r.triggers.malformed.verdict).toBe('PASS');
    expect(r.overall).toBe('PASS');
  });

  it('the SAME rows split across two models are held at INSUFFICIENT', () => {
    // Every row agrees perfectly, so both thresholds still pass individually — the
    // only thing that changed is that the sample spans two targets.
    const r = aggregate([...perfect('glm-5.2', 10), ...perfect('glm-5.3', 10)]);
    expect(r.models).toEqual(['glm-5.2', 'glm-5.3']);
    expect(r.triggers.agreement.verdict).toBe('PASS');
    expect(r.triggers.malformed.verdict).toBe('PASS');
    expect(r.overall).toBe('INSUFFICIENT'); // ← the guard
  });

  it('FAIL still dominates a mixed sample — a tripped threshold is real information', () => {
    // Withholding PASS is about the comparison being meaningless; a breach is not
    // made meaningless by the mix, so downgrading FAIL to INSUFFICIENT would hide it.
    const bad = Array.from({ length: 10 }, () =>
      row({ model: 'glm-5.3' }, { tier: false, all: false }),
    );
    const r = aggregate([...perfect('glm-5.2', 10), ...bad]);
    expect(r.overall).toBe('FAIL');
  });

  // ── The printed explanation must match the printed verdict (#1737) ─────────
  // The warning used to claim "the overall verdict is held at INSUFFICIENT" on EVERY
  // mixed log, including ones printing OVERALL: FAIL six lines below it. A reader
  // trusting the sentence concludes "keep collecting"; the verdict is a rollback
  // signal. Opposite actions, and the reassuring one is the false one.

  it('a mixed log that was genuinely HELD says so', () => {
    const r = aggregate([...perfect('glm-5.2', 10), ...perfect('glm-5.3', 10)]);
    expect(r.mixedModelHold).toBe(true);
    expect(r.overall).toBe('INSUFFICIENT');
    expect(formatReport(r)).toContain('held at INSUFFICIENT');
  });

  it('a mixed log that FAILED does NOT claim it was held', () => {
    // The regression under test: mixed + FAIL must not print the hold sentence.
    const bad = Array.from({ length: 10 }, () =>
      row({ model: 'glm-5.3' }, { tier: false, all: false }),
    );
    const r = aggregate([...perfect('glm-5.2', 10), ...bad]);
    expect(r.overall).toBe('FAIL');
    expect(r.mixedModelHold).toBe(false);

    const out = formatReport(r);
    expect(out).not.toContain('held at INSUFFICIENT');
    // …but it must still warn that the pooled figures span two targets, or the fix
    // would have removed the warning instead of correcting it.
    expect(out).toContain('mix targets');
    expect(out).toContain('per-model split');
  });

  it('the hold flag is derived from the decision, not re-inferred from the model count', () => {
    // Single-model logs can never be "held" by this rule, whatever their verdict.
    expect(aggregate(perfect('glm-5.2', 20)).mixedModelHold).toBe(false);
    const bad = Array.from({ length: 10 }, () =>
      row({ model: 'glm-5.2' }, { tier: false, all: false }),
    );
    expect(aggregate(bad).mixedModelHold).toBe(false);
  });

  it('byModel splits the sample so each target can be read on its own', () => {
    const mixed = [
      ...perfect('glm-5.2', 8),
      ...Array.from({ length: 4 }, () => row({ model: 'glm-5.3' }, { tier: false, all: false })),
    ];
    const r = aggregate(mixed);
    const by = Object.fromEntries(r.byModel.map((m) => [m.model, m]));
    expect(by['glm-5.2'].n).toBe(8);
    expect(by['glm-5.2'].tierTypeAgreementPct).toBe(100);
    expect(by['glm-5.3'].n).toBe(4);
    expect(by['glm-5.3'].tierTypeAgreementPct).toBe(0);
  });

  it('the per-model split is PRINTED, not merely computed', () => {
    // A breakdown that exists only in the object would leave the human reading the
    // pooled number — the failure this whole guard is about.
    const out = formatReport(aggregate([...perfect('glm-5.2', 5), ...perfect('glm-5.3', 5)]));
    expect(out).toMatch(/per model:/);
    expect(out).toMatch(/glm-5\.2/);
    expect(out).toMatch(/glm-5\.3/);
    expect(out).toMatch(/INSUFFICIENT/);
  });
});
