import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  classify,
  overrideClassification,
  applyFloor,
  loadCalibration,
  saveCalibration,
  recordOverride,
  type ClassificationSignal,
  type CalibrationData,
} from '../src/lib/classifier';
import { DEFAULT_CONFIG, TIERS, type Tier, type MinspecConfig } from '../src/lib/config';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a signal with sensible defaults */
function makeSignal(
  overrides: Partial<ClassificationSignal> & { name: string; tierContribution: ClassificationSignal['tierContribution'] },
): ClassificationSignal {
  return {
    value: 1,
    weight: 1,
    ...overrides,
  };
}

// ─── T0 Tests: Core Classification Invariants ────────────────────────────────

describe('classify() — T0 invariant tests', () => {
  it('returns T1 with 0 confidence when given no signals', () => {
    const result = classify([], DEFAULT_CONFIG);
    expect(result.tier).toBe('T1');
    expect(result.confidence).toBe(0);
    expect(result.signals).toEqual([]);
    expect(result.suggestedPhases).toContain('specify');
  });

  it('classifies all-T1 signals as T1', () => {
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'files_changed', tierContribution: 'T1' }),
      makeSignal({ name: 'lines_changed', tierContribution: 'T1' }),
    ];
    const result = classify(signals, DEFAULT_CONFIG);
    expect(result.tier).toBe('T1');
    expect(result.confidence).toBe(1); // all signals at winning tier
  });

  it('classifies all-T3 signals as T3', () => {
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'schema_change', tierContribution: 'T3' }),
      makeSignal({ name: 'cross_directory', tierContribution: 'T3' }),
      makeSignal({ name: 'new_exports', tierContribution: 'T3' }),
    ];
    const result = classify(signals, DEFAULT_CONFIG);
    expect(result.tier).toBe('T3');
    expect(result.confidence).toBe(1);
  });

  it('highest-tier signal wins in mixed set', () => {
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'files_changed', tierContribution: 'T1' }),
      makeSignal({ name: 'lines_changed', tierContribution: 'T1' }),
      makeSignal({ name: 'schema_change', tierContribution: 'T3' }),
    ];
    const result = classify(signals, DEFAULT_CONFIG);
    expect(result.tier).toBe('T3');
    // Only 1 of 3 signals is T3
    expect(result.confidence).toBeCloseTo(1 / 3, 5);
  });

  it('single T4 signal among many T1 signals → T4', () => {
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'files_changed', tierContribution: 'T1' }),
      makeSignal({ name: 'lines_changed', tierContribution: 'T1' }),
      makeSignal({ name: 'file_types', tierContribution: 'T1' }),
      makeSignal({ name: 'removed_exports', tierContribution: 'T4' }),
    ];
    const result = classify(signals, DEFAULT_CONFIG);
    expect(result.tier).toBe('T4');
    expect(result.confidence).toBe(0.25);
  });

  it('user override always wins (invariant #5)', () => {
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'schema_change', tierContribution: 'T3' }),
    ];
    const original = classify(signals, DEFAULT_CONFIG);
    expect(original.tier).toBe('T3');

    const overridden = overrideClassification(original, 'T1', DEFAULT_CONFIG);
    expect(overridden.tier).toBe('T1');
    expect(overridden.overriddenBy).toBe('user');
    expect(overridden.signals).toEqual(original.signals);
  });

  it('phase selection matches config phaseMappings for each tier', () => {
    for (const tier of ['T1', 'T2', 'T3', 'T4'] as const) {
      const signals: ClassificationSignal[] = [
        makeSignal({ name: 'test_signal', tierContribution: tier }),
      ];
      const result = classify(signals, DEFAULT_CONFIG);
      const mapping = DEFAULT_CONFIG.phaseMappings[tier];
      const expectedPhases = [...mapping.requiredPhases, ...mapping.optionalPhases];
      expect(result.suggestedPhases).toEqual(expectedPhases);
    }
  });
});

// ─── T2 Tests: Feature Behavior ──────────────────────────────────────────────

describe('classify() — T2 feature tests', () => {
  it('confidence = 1 when all signals agree on tier', () => {
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'a', tierContribution: 'T2' }),
      makeSignal({ name: 'b', tierContribution: 'T2' }),
      makeSignal({ name: 'c', tierContribution: 'T2' }),
    ];
    const result = classify(signals, DEFAULT_CONFIG);
    expect(result.confidence).toBe(1);
  });

  it('confidence < 0.5 when minority signal dictates tier', () => {
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'a', tierContribution: 'T1' }),
      makeSignal({ name: 'b', tierContribution: 'T1' }),
      makeSignal({ name: 'c', tierContribution: 'T1' }),
      makeSignal({ name: 'd', tierContribution: 'T3' }),
    ];
    const result = classify(signals, DEFAULT_CONFIG);
    expect(result.tier).toBe('T3');
    expect(result.confidence).toBe(0.25);
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('returns a copy of signals, not the original array', () => {
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'a', tierContribution: 'T1' }),
    ];
    const result = classify(signals, DEFAULT_CONFIG);
    expect(result.signals).toEqual(signals);
    expect(result.signals).not.toBe(signals);
  });

  it('works with boolean signal values', () => {
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'dependency_change', tierContribution: 'T2', value: true }),
      makeSignal({ name: 'new_files', tierContribution: 'T1', value: false }),
    ];
    const result = classify(signals, DEFAULT_CONFIG);
    expect(result.tier).toBe('T2');
  });

  it('respects custom config phaseMappings', () => {
    const customConfig: MinspecConfig = {
      ...DEFAULT_CONFIG,
      phaseMappings: {
        ...DEFAULT_CONFIG.phaseMappings,
        T1: { requiredPhases: ['specify', 'plan'], optionalPhases: ['clarify'] },
      },
    };
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'a', tierContribution: 'T1' }),
    ];
    const result = classify(signals, customConfig);
    expect(result.suggestedPhases).toEqual(['specify', 'plan', 'clarify']);
  });
});

describe('overrideClassification()', () => {
  it('preserves confidence from original result', () => {
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'a', tierContribution: 'T1' }),
      makeSignal({ name: 'b', tierContribution: 'T3' }),
    ];
    const original = classify(signals, DEFAULT_CONFIG);
    const overridden = overrideClassification(original, 'T2', DEFAULT_CONFIG);
    expect(overridden.confidence).toBe(original.confidence);
  });

  it('updates suggestedPhases to match new tier', () => {
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'a', tierContribution: 'T1' }),
    ];
    const original = classify(signals, DEFAULT_CONFIG);
    expect(original.suggestedPhases).toEqual(['specify']);

    const overridden = overrideClassification(original, 'T4', DEFAULT_CONFIG);
    const t4Mapping = DEFAULT_CONFIG.phaseMappings.T4;
    expect(overridden.suggestedPhases).toEqual([
      ...t4Mapping.requiredPhases,
      ...t4Mapping.optionalPhases,
    ]);
  });

  it('can override to same tier (no-op on tier, still marks overriddenBy)', () => {
    const signals: ClassificationSignal[] = [
      makeSignal({ name: 'a', tierContribution: 'T2' }),
    ];
    const original = classify(signals, DEFAULT_CONFIG);
    const overridden = overrideClassification(original, 'T2', DEFAULT_CONFIG);
    expect(overridden.tier).toBe('T2');
    expect(overridden.overriddenBy).toBe('user');
  });
});

// ─── T0 Tests: Upward-only ceremony floor (DR-021 Decision 1) ────────────────

describe('applyFloor() — predicted tier is an upward-only ceremony floor', () => {
  it('returns the predicted tier unchanged when no user tier is set', () => {
    for (const tier of TIERS) {
      expect(applyFloor(tier)).toBe(tier);
    }
  });

  it('NEVER lowers below the predicted tier — floor wins over a lower user tier', () => {
    // Predicted T3, user asks for T1 → effective stays T3 (no auto-down).
    expect(applyFloor('T3', 'T1')).toBe('T3');
    expect(applyFloor('T3', 'T2')).toBe('T3');
    expect(applyFloor('T2', 'T1')).toBe('T2');
    expect(applyFloor('T4', 'T1')).toBe('T4');
  });

  it('ratchets UP when the user tier is higher than the prediction', () => {
    expect(applyFloor('T1', 'T2')).toBe('T2');
    expect(applyFloor('T1', 'T4')).toBe('T4');
    expect(applyFloor('T2', 'T3')).toBe('T3');
  });

  it('is the maximum of predicted and user tier for every pair', () => {
    for (const predicted of TIERS) {
      for (const user of TIERS) {
        const expected: Tier =
          TIERS.indexOf(user) > TIERS.indexOf(predicted) ? user : predicted;
        expect(applyFloor(predicted, user)).toBe(expected);
      }
    }
  });

  it('equal predicted and user tier returns that tier', () => {
    for (const tier of TIERS) {
      expect(applyFloor(tier, tier)).toBe(tier);
    }
  });
});

// ─── Override Log Persistence Tests ──────────────────────────────────────────

describe('Override-log persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-classifier-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadCalibration()', () => {
    it('returns an empty override log when no file exists', () => {
      const data = loadCalibration(tmpDir);
      expect(data.overrides).toEqual([]);
    });

    it('returns an empty override log when file is invalid JSON', () => {
      const dir = path.join(tmpDir, '.minspec');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'calibration.json'), 'not json!!');
      const data = loadCalibration(tmpDir);
      expect(data.overrides).toEqual([]);
    });

    it('returns an empty override log when file has wrong shape', () => {
      const dir = path.join(tmpDir, '.minspec');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'calibration.json'),
        JSON.stringify({ overrides: 'not an array' }),
      );
      const data = loadCalibration(tmpDir);
      expect(data.overrides).toEqual([]);
    });

    it('drops any legacy weightAdjustments field (DR-021: difficulty-calibration removed)', () => {
      const dir = path.join(tmpDir, '.minspec');
      fs.mkdirSync(dir, { recursive: true });
      // An old on-disk file may still carry weightAdjustments — it must be dropped,
      // never surfaced back as part of the loaded shape.
      fs.writeFileSync(
        path.join(dir, 'calibration.json'),
        JSON.stringify({
          overrides: [
            {
              timestamp: '2026-01-01T00:00:00Z',
              originalTier: 'T3',
              overriddenTier: 'T1',
              signals: ['files_changed'],
            },
          ],
          weightAdjustments: { files_changed: 0.7 },
        }),
      );
      const data = loadCalibration(tmpDir) as Record<string, unknown>;
      expect((data.overrides as unknown[]).length).toBe(1);
      expect(data.weightAdjustments).toBeUndefined();
    });

    it('loads a valid override log', () => {
      const dir = path.join(tmpDir, '.minspec');
      fs.mkdirSync(dir, { recursive: true });
      const calibration: CalibrationData = {
        overrides: [
          {
            timestamp: '2026-01-01T00:00:00Z',
            originalTier: 'T3',
            overriddenTier: 'T1',
            signals: ['files_changed'],
          },
        ],
      };
      fs.writeFileSync(
        path.join(dir, 'calibration.json'),
        JSON.stringify(calibration),
      );
      const data = loadCalibration(tmpDir);
      expect(data.overrides).toHaveLength(1);
      expect(data.overrides[0].originalTier).toBe('T3');
    });
  });

  describe('saveCalibration()', () => {
    it('creates .minspec directory if missing', () => {
      const data: CalibrationData = { overrides: [] };
      saveCalibration(tmpDir, data);
      expect(fs.existsSync(path.join(tmpDir, '.minspec', 'calibration.json'))).toBe(true);
    });

    it('writes valid JSON', () => {
      const data: CalibrationData = {
        overrides: [
          {
            timestamp: '2026-01-01T00:00:00Z',
            originalTier: 'T2',
            overriddenTier: 'T3',
            signals: ['schema_change'],
          },
        ],
      };
      saveCalibration(tmpDir, data);
      const raw = fs.readFileSync(
        path.join(tmpDir, '.minspec', 'calibration.json'),
        'utf-8',
      );
      const parsed = JSON.parse(raw);
      expect(parsed.overrides).toHaveLength(1);
    });
  });

  describe('recordOverride()', () => {
    it('appends an override event to the log', () => {
      const data = recordOverride(tmpDir, 'T3', 'T1', ['files_changed', 'lines_changed']);
      expect(data.overrides).toHaveLength(1);
      expect(data.overrides[0].originalTier).toBe('T3');
      expect(data.overrides[0].overriddenTier).toBe('T1');
      expect(data.overrides[0].signals).toEqual(['files_changed', 'lines_changed']);
      expect(data.overrides[0].timestamp).toBeTruthy();
    });

    it('accumulates overrides across calls', () => {
      recordOverride(tmpDir, 'T3', 'T1', ['a']);
      recordOverride(tmpDir, 'T2', 'T1', ['b']);
      const data = recordOverride(tmpDir, 'T4', 'T2', ['c']);
      expect(data.overrides).toHaveLength(3);
    });

    it('only logs — never derives weight adjustments (DR-021: difficulty-calibration removed)', () => {
      // Many same-direction overrides used to trigger weight recalculation; DR-021
      // removed that dead machinery. The log must stay a pure event list.
      for (let i = 0; i < 30; i++) {
        recordOverride(tmpDir, 'T3', 'T1', ['overestimated_signal']);
      }
      const data = loadCalibration(tmpDir) as Record<string, unknown>;
      expect((data.overrides as unknown[]).length).toBe(30);
      expect(data.weightAdjustments).toBeUndefined();
    });
  });
});
