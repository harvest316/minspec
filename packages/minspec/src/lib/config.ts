import * as fs from 'fs';
import * as path from 'path';

/** Complexity tiers — T1 simplest, T4 most complex */
export type Tier = 'T1' | 'T2' | 'T3' | 'T4';

/** SDD lifecycle phases */
export type Phase = 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement';

/** All phases in order */
export const PHASES: readonly Phase[] = ['specify', 'clarify', 'plan', 'tasks', 'implement'] as const;

/** All tiers in order */
export const TIERS: readonly Tier[] = ['T1', 'T2', 'T3', 'T4'] as const;

/** Which phases each tier requires */
export interface TierPhaseMapping {
  readonly requiredPhases: Phase[];
  readonly optionalPhases: Phase[];
}

/** Scoring thresholds for classification */
export interface TierThresholds {
  /** Max score for T1 (inclusive). Above this = T2+ */
  readonly t1Max: number;
  /** Max score for T2 (inclusive). Above this = T3+ */
  readonly t2Max: number;
  /** Max score for T3 (inclusive). Above this = T4 */
  readonly t3Max: number;
}

/**
 * Spec storage layout.
 * - `flat`: one file per spec: `specs/SPEC-NNN-slug.md`
 * - `spec-kit`: one directory per spec: `specs/NNN-slug/{spec,plan,tasks}.md`
 */
export type SpecsLayout = 'flat' | 'spec-kit';

/** Full config shape persisted in .minspec/config.json */
export interface MinspecConfig {
  readonly version: '1';
  readonly specsDir: string;
  readonly decisionsDir: string;
  readonly epicsDir: string;
  readonly specsLayout: SpecsLayout;
  readonly thresholds: TierThresholds;
  readonly phaseMappings: Record<Tier, TierPhaseMapping>;
}

/**
 * Default config — matches FR-2 mapping table from requirements.md:
 * T1: specify only, T2: specify+plan, T3: all except clarify optional,
 * T4: all required
 */
export const DEFAULT_CONFIG: MinspecConfig = {
  version: '1',
  specsDir: 'specs',
  decisionsDir: 'docs/decisions',
  epicsDir: 'docs/epics',
  specsLayout: 'flat',
  thresholds: {
    t1Max: 3,
    t2Max: 7,
    t3Max: 14,
  },
  phaseMappings: {
    T1: { requiredPhases: ['specify'], optionalPhases: [] },
    T2: { requiredPhases: ['specify', 'plan'], optionalPhases: ['clarify'] },
    T3: { requiredPhases: ['specify', 'plan', 'tasks', 'implement'], optionalPhases: ['clarify'] },
    T4: { requiredPhases: ['specify', 'clarify', 'plan', 'tasks', 'implement'], optionalPhases: [] },
  },
};

/** Deep merge user config over defaults. User values win. */
function deepMerge<T extends Record<string, unknown>>(defaults: T, overrides: Partial<T>): T {
  const result = { ...defaults };
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const val = overrides[key];
    if (val !== undefined && val !== null) {
      if (typeof val === 'object' && !Array.isArray(val) && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>) as T[keyof T];
      } else {
        result[key] = val as T[keyof T];
      }
    }
  }
  return result;
}

/**
 * Load config from .minspec/config.json, merged with defaults.
 * Missing keys get default values. Invalid JSON = pure defaults.
 */
export function loadConfig(rootDir: string): MinspecConfig {
  const configPath = path.join(rootDir, '.minspec', 'config.json');
  if (!fs.existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const userConfig = JSON.parse(raw) as Partial<MinspecConfig>;
    return deepMerge(DEFAULT_CONFIG, userConfig);
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Resolve a subdirectory relative to rootDir and validate it does not escape
 * the workspace root. Prevents path traversal attacks via malicious config
 * values like "../../etc".
 *
 * @throws Error if the resolved path is outside rootDir.
 */
export function resolveAndValidate(rootDir: string, subDir: string): string {
  const resolved = path.resolve(rootDir, subDir);
  const root = path.resolve(rootDir);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path "${subDir}" escapes workspace root`);
  }
  return resolved;
}

/**
 * Merge VS Code settings over a loaded config.
 * Called from extension code that has access to vscode module.
 */
export function applyVSCodeOverrides(
  config: MinspecConfig,
  overrides: {
    specsDir?: string;
    decisionsDir?: string;
    epicsDir?: string;
    specsLayout?: SpecsLayout;
    t1Max?: number;
    t2Max?: number;
    t3Max?: number;
  },
): MinspecConfig {
  return {
    ...config,
    specsDir: overrides.specsDir ?? config.specsDir,
    decisionsDir: overrides.decisionsDir ?? config.decisionsDir,
    epicsDir: overrides.epicsDir ?? config.epicsDir,
    specsLayout: overrides.specsLayout ?? config.specsLayout,
    thresholds: {
      t1Max: overrides.t1Max ?? config.thresholds.t1Max,
      t2Max: overrides.t2Max ?? config.thresholds.t2Max,
      t3Max: overrides.t3Max ?? config.thresholds.t3Max,
    },
  };
}
