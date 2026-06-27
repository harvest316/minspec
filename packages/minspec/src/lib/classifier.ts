import * as fs from 'fs';
import * as path from 'path';
import type { Tier, Phase, MinspecConfig } from './config';

// ─── Shared Types ────────────────────────────────────────────────────────────

/**
 * A single signal produced by an analyzer (git-diff, consequence, etc.).
 *
 * The optional `axis`/`degraded`/`explain` fields (SPEC-023 FR-6) are **additive**:
 * legacy diff-size producers omit them and stay valid. `classify()` reads only
 * `tierContribution` (max-over-signals), so these fields are descriptive metadata
 * surfaced to the user, never inputs to the ranking.
 */
export interface ClassificationSignal {
  readonly name: string;
  readonly value: number | boolean;
  readonly weight: number;
  readonly tierContribution: Tier;
  /**
   * Which axis produced this signal. Diff-size ('scope') vs blast-radius
   * ('consequence'). Absent on legacy size signals (treated as 'scope').
   */
  readonly axis?: 'scope' | 'consequence';
  /**
   * True when the analyzer could not get its ideal data source and fell back to
   * a coarser read. INV-4: degrade is visible, never a silently-wrong tier.
   */
  readonly degraded?: boolean;
  /** Human-readable rationale, e.g. "call graph unavailable; using size signals". */
  readonly explain?: string;
}

/** Result of classifying a set of signals into a tier */
export interface ClassificationResult {
  readonly tier: Tier;
  readonly confidence: number; // 0-1
  readonly signals: ClassificationSignal[];
  readonly suggestedPhases: Phase[];
  readonly overriddenBy?: 'user';
}

/**
 * Persistent override log stored in .minspec/calibration.json.
 *
 * This is an *event log* of the human override path (invariant #5: user override
 * wins), NOT a difficulty-calibration store. DR-021 removed the weight-tuning
 * machinery (`recalculateWeights`/`applyCalibration` + `weightAdjustments`): it
 * fed a difficulty prediction that `classify()` never read, and SWE-bench
 * validation (n=120, κ=0.80) proved difficulty is orthogonal to the mechanical
 * scope this classifier measures. The override log is retained so a future
 * opt-in difficulty layer (DR-021 Decision 5, AI-consented Tier-1+) has raw
 * signal — but nothing in the Tier-0 core consumes it.
 */
export interface CalibrationData {
  overrides: CalibrationOverride[];
}

/** A single user override event */
export interface CalibrationOverride {
  readonly timestamp: string;
  readonly originalTier: Tier;
  readonly overriddenTier: Tier;
  readonly signals: string[]; // signal names present at time of override
}

// ─── Tier Utilities ──────────────────────────────────────────────────────────

const TIER_INDEX: Record<Tier, number> = { T1: 0, T2: 1, T3: 2, T4: 3 };

/** Compare two tiers. Returns positive if a > b, negative if a < b, 0 if equal. */
function compareTiers(a: Tier, b: Tier): number {
  return TIER_INDEX[a] - TIER_INDEX[b];
}

/**
 * Apply the predicted tier as an upward-only ceremony FLOOR (DR-021 Decision 1).
 *
 * The classifier's predicted tier is a 100%-precise lower bound on ceremony
 * (`pred ≥ T2 → true ≥ T2` was 31/31 in SWE-bench validation, n=120). So the
 * effective tier is the MAXIMUM of the predicted floor and a user-set tier:
 * ceremony ratchets UP, never auto-down. A human can always raise the tier
 * (invariant #5); the tool itself never silently lowers below its own
 * prediction.
 *
 * Pure function — no side effects.
 *
 * @param predicted The classifier's predicted tier (the floor).
 * @param userTier  A user-requested tier, or undefined when none is set.
 * @returns max(predicted, userTier) — never below `predicted`.
 */
export function applyFloor(predicted: Tier, userTier?: Tier): Tier {
  if (userTier === undefined) return predicted;
  return compareTiers(userTier, predicted) > 0 ? userTier : predicted;
}

// ─── Core Classification ─────────────────────────────────────────────────────

/**
 * Classify a set of signals into a tier.
 *
 * Algorithm (from design.md):
 * 1. Find the HIGHEST tier among all signals (max tierContribution).
 * 2. Confidence = count of signals at winning tier / total signals.
 * 3. Look up suggestedPhases from config.phaseMappings.
 *
 * Pure function — no side effects.
 */
export function classify(
  signals: ClassificationSignal[],
  config: MinspecConfig,
): ClassificationResult {
  // Edge case: no signals → T1 with zero confidence
  if (signals.length === 0) {
    const mapping = config.phaseMappings.T1;
    return {
      tier: 'T1',
      confidence: 0,
      signals: [],
      suggestedPhases: [...mapping.requiredPhases, ...mapping.optionalPhases],
    };
  }

  // Find winning tier — highest tierContribution across all signals
  let winningTier: Tier = 'T1';
  for (const signal of signals) {
    if (compareTiers(signal.tierContribution, winningTier) > 0) {
      winningTier = signal.tierContribution;
    }
  }

  // Confidence = signals at winning tier / total signals
  const atWinningTier = signals.filter(
    (s) => s.tierContribution === winningTier,
  ).length;
  const confidence = atWinningTier / signals.length;

  // Phase selection from config
  const mapping = config.phaseMappings[winningTier];
  const suggestedPhases: Phase[] = [
    ...mapping.requiredPhases,
    ...mapping.optionalPhases,
  ];

  return {
    tier: winningTier,
    confidence,
    signals: [...signals],
    suggestedPhases,
  };
}

/**
 * The single signal that DROVE the classified tier — the most informative "why".
 *
 * `classify()` ranks by max `tierContribution` ("highest wins"), so the tier is
 * set by whichever signal(s) sit at the winning tier. Among those, prefer the
 * blast-radius ('consequence') axis as the more meaningful explanation, then the
 * highest weight. Falls back to the whole signal set if none sit exactly at the
 * winning tier (defensive — shouldn't happen for a tier derived from them).
 *
 * Pure. Used to render a grounded headline ("set by importersReached=23") in
 * place of the agreement-fraction `confidence%`, which read as a broken
 * probability — a high tier with a low % looks like "we're 14% sure" when it
 * actually means "one signal forced it up" (#216). Returns undefined only when
 * there are no signals at all.
 */
export function pickDrivingSignal(
  result: ClassificationResult,
): ClassificationSignal | undefined {
  const atTier = result.signals.filter(
    (s) => s.tierContribution === result.tier,
  );
  const pool = atTier.length > 0 ? atTier : result.signals;
  if (pool.length === 0) return undefined;
  return pool.reduce((best, s) => {
    const bestConseq = best.axis === 'consequence' ? 1 : 0;
    const sConseq = s.axis === 'consequence' ? 1 : 0;
    if (sConseq !== bestConseq) return sConseq > bestConseq ? s : best;
    return s.weight > best.weight ? s : best; // ties keep `best` (stable)
  });
}

// ─── User Override ───────────────────────────────────────────────────────────

/**
 * Apply a user override to an existing classification result.
 *
 * Returns a new ClassificationResult with the overridden tier,
 * updated suggestedPhases, and `overriddenBy: 'user'`.
 * Confidence is preserved from the original classification.
 */
export function overrideClassification(
  result: ClassificationResult,
  newTier: Tier,
  config: MinspecConfig,
): ClassificationResult {
  const mapping = config.phaseMappings[newTier];
  const suggestedPhases: Phase[] = [
    ...mapping.requiredPhases,
    ...mapping.optionalPhases,
  ];

  return {
    tier: newTier,
    confidence: result.confidence,
    signals: result.signals,
    suggestedPhases,
    overriddenBy: 'user',
  };
}

// ─── Calibration Persistence ─────────────────────────────────────────────────

const CALIBRATION_FILE = 'calibration.json';

/** Create an empty override-log object */
function emptyCalibration(): CalibrationData {
  return { overrides: [] };
}

/**
 * Load the override log from `.minspec/calibration.json`.
 * Returns an empty log if the file is missing or invalid.
 */
export function loadCalibration(rootDir: string): CalibrationData {
  const filePath = path.join(rootDir, '.minspec', CALIBRATION_FILE);
  if (!fs.existsSync(filePath)) {
    return emptyCalibration();
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CalibrationData;
    // Basic shape validation
    if (!Array.isArray(parsed.overrides)) {
      return emptyCalibration();
    }
    return { overrides: parsed.overrides };
  } catch {
    return emptyCalibration();
  }
}

/**
 * Save the override log to `.minspec/calibration.json`.
 * Creates the `.minspec/` directory if it does not exist.
 */
export function saveCalibration(rootDir: string, data: CalibrationData): void {
  const dir = path.join(rootDir, '.minspec');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, CALIBRATION_FILE);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Record a user override in the override log.
 *
 * This is the human-override path (invariant #5: user override wins) — it
 * appends an audit event so the bump (or any explicit re-tier) is never silent.
 *
 * DR-021 removed the difficulty-calibration that used to run here: the old
 * `recalculateWeights` step adjusted `signal.weight` multipliers that
 * `classify()` never read (it ranks by `tierContribution`, "highest wins"), so
 * the weight tuning could not change a single classification. SWE-bench
 * validation (n=120, κ=0.80) confirmed the axis was wrong — difficulty is
 * orthogonal to mechanical scope — so the machinery was measured-and-rejected,
 * not merely unused. The override is now logged only.
 */
export function recordOverride(
  rootDir: string,
  originalTier: Tier,
  overriddenTier: Tier,
  signalNames: string[],
): CalibrationData {
  const data = loadCalibration(rootDir);

  data.overrides.push({
    timestamp: new Date().toISOString(),
    originalTier,
    overriddenTier,
    signals: [...signalNames],
  });

  saveCalibration(rootDir, data);
  return data;
}
