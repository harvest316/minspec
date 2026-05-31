/**
 * Spec Completeness Validator — DR-012
 *
 * Pure logic. No filesystem, no VS Code API. Given a parsed spec + config,
 * returns tier-aware completeness violations. Used by:
 *  - the approve gate (refuses approval when !complete)
 *  - the spec panel (surfaces violations)
 *
 * Philosophy: ceremony ∝ complexity. T1/T2 produce warnings at most;
 * T3/T4 produce errors that block approval.
 */

import type { ParsedSpec } from './spec';
import type { Tier, MinspecConfig, Phase } from './config';
import { epicRefValue } from './epic-manager';

/** A cross-cutting concern a spec may touch, each requiring a specific artifact. */
export type Aspect = 'ux' | 'api' | 'data' | 'architecture';

export const ASPECTS: readonly Aspect[] = ['ux', 'api', 'data', 'architecture'] as const;

export type Severity = 'error' | 'warning';

export interface ValidationViolation {
  /** Stable rule id, e.g. 'section.plan.empty' or 'aspect.ux.no-mockup' */
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
  readonly fixHint: string;
}

export interface ValidationResult {
  readonly specId: string;
  readonly tier: Tier;
  /** true when there are zero error-severity violations */
  readonly complete: boolean;
  readonly violations: ValidationViolation[];
  /** aspects inferred from body keywords */
  readonly detectedAspects: Aspect[];
  /** aspects declared explicitly in frontmatter `aspects:` */
  readonly declaredAspects: Aspect[];
  /** union actually enforced */
  readonly effectiveAspects: Aspect[];
}

// ─── Aspect detection ────────────────────────────────────────────────────────

/** Keyword signals per aspect. Word-boundary matched, case-insensitive. */
const ASPECT_KEYWORDS: Record<Aspect, string[]> = {
  ux: ['ui', 'ux', 'screen', 'page', 'component', 'button', 'modal', 'dialog',
    'layout', 'wireframe', 'frontend', 'css', 'view', 'form', 'menu', 'icon'],
  api: ['endpoint', 'api', 'payload', 'request', 'response', 'route', 'http',
    'rest', 'graphql', 'webhook', 'rpc'],
  data: ['schema', 'table', 'migration', 'database', 'column', 'entity',
    'index', 'query', 'sql'],
  architecture: ['architecture', 'subsystem', 'service', 'integration',
    'cross-cutting', 'topology', 'pipeline', 'queue', 'broker'],
};

function detectAspects(rawLower: string): Aspect[] {
  const found: Aspect[] = [];
  for (const aspect of ASPECTS) {
    const hit = ASPECT_KEYWORDS[aspect].some((kw) => {
      const re = new RegExp(`\\b${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
      return re.test(rawLower);
    });
    if (hit) found.push(aspect);
  }
  return found;
}

/** Parse frontmatter `aspects:` — accepts "ux, api" or "[ux, api]" forms. */
function parseDeclaredAspects(raw: string): Aspect[] {
  const m = raw.match(/^aspects:\s*(.+)$/m);
  if (!m) return [];
  const list = m[1]
    .replace(/[[\]]/g, '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return ASPECTS.filter((a) => list.includes(a));
}

// ─── Artifact presence detectors (on raw spec text) ──────────────────────────

const hasImage = (s: string) => /!\[[^\]]*\]\([^)]+\)/.test(s);
const hasFence = (s: string, langs: string[]) =>
  new RegExp('```(' + langs.join('|') + ')\\b', 'i').test(s);
const hasMermaid = (s: string, kind?: string) =>
  new RegExp('```mermaid' + (kind ? `[\\s\\S]*?\\b${kind}\\b` : ''), 'i').test(s);
const hasSection = (s: string, names: string[]) =>
  new RegExp('^##+\\s*(' + names.join('|') + ')\\b', 'im').test(s);
const hasMarkdownTable = (s: string) => /^\s*\|.+\|\s*\n\s*\|[\s:|-]+\|\s*$/m.test(s);
/** crude ascii-box mockup: 3+ lines of box-drawing or +--+ framing */
const hasAsciiBox = (s: string) =>
  (s.match(/^[ \t]*[+|│┌└├─].*$/gm)?.length ?? 0) >= 3;

// ─── Aspect → required artifact rules ────────────────────────────────────────

interface AspectRule {
  readonly aspect: Aspect;
  readonly rule: string;
  readonly satisfied: (raw: string) => boolean;
  readonly message: string;
  readonly fixHint: string;
}

const ASPECT_RULES: AspectRule[] = [
  {
    aspect: 'ux',
    rule: 'aspect.ux.no-mockup',
    satisfied: (s) =>
      hasImage(s) || hasSection(s, ['ux', 'mockup', 'wireframe', 'design']) &&
        (hasImage(s) || hasAsciiBox(s) || hasMermaid(s)) || hasAsciiBox(s) || hasMermaid(s),
    message: 'Spec has a UX surface but no mockup.',
    fixHint: 'Add a "## UX" section with a wireframe — an image (![…](…)), an ASCII layout box, or a ```mermaid``` diagram — before implementation.',
  },
  {
    aspect: 'api',
    rule: 'aspect.api.no-schema',
    satisfied: (s) =>
      hasFence(s, ['json', 'jsonc', 'ts', 'typescript', 'yaml', 'proto', 'graphql']) ||
      /\bopenapi\b/i.test(s) ||
      (hasSection(s, ['api', 'contract', 'schema', 'payload']) && /interface\s+\w+|type\s+\w+\s*=/.test(s)),
    message: 'Spec touches an API but defines no payload/schema.',
    fixHint: 'Add request/response payload shapes — a ```json``` example or a ```ts``` interface/type — under an "## API" section.',
  },
  {
    aspect: 'data',
    rule: 'aspect.data.no-schema',
    satisfied: (s) =>
      hasFence(s, ['sql']) || hasMermaid(s, 'erDiagram') || hasMarkdownTable(s),
    message: 'Spec touches data/storage but defines no schema.',
    fixHint: 'Add the data shape — a ```sql``` DDL block, a ```mermaid erDiagram```, or a markdown table of columns.',
  },
  {
    aspect: 'architecture',
    rule: 'aspect.architecture.no-diagram',
    satisfied: (s) =>
      hasMermaid(s) || /\.(puml|drawio|svg)\b/i.test(s) || hasSection(s, ['diagram', 'architecture']) && hasAsciiBox(s),
    message: 'Architectural spec has no diagram.',
    fixHint: 'Add a ```mermaid``` diagram, a linked .puml/.drawio, or an ASCII component diagram under "## Architecture".',
  },
];

// ─── Tier severity policy ────────────────────────────────────────────────────

const TIER_RANK: Record<Tier, number> = { T1: 1, T2: 2, T3: 3, T4: 4 };

/** Aspect-artifact rules are errors at T3/T4, warnings at T2, ignored at T1. */
function aspectSeverity(tier: Tier): Severity | null {
  if (TIER_RANK[tier] >= 3) return 'error';
  if (TIER_RANK[tier] === 2) return 'warning';
  return null;
}

/** Acceptance criteria required (error) at T3/T4 only. */
function requiresAcceptanceCriteria(tier: Tier): boolean {
  return TIER_RANK[tier] >= 3;
}

function hasAcceptanceCriteria(spec: ParsedSpec): boolean {
  const raw = spec.raw;
  if (hasSection(raw, ['acceptance criteria', 'acceptance', 'success criteria'])) return true;
  // checkbox list inside the specify section counts as acceptance criteria
  const specify = spec.phaseSections.specify?.body ?? '';
  return /- \[[ xX]\]/.test(specify);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function validateSpec(
  spec: ParsedSpec,
  config: MinspecConfig,
  /**
   * Lowercased set of valid epic refs (ids + slugs) from the registry. When
   * supplied, an `epic:` frontmatter ref that is not in the set yields a
   * WARNING (never an error — epics are optional, FR-9). Omit to skip the check
   * (callers without registry access get no false warnings).
   */
  knownEpicRefs?: ReadonlySet<string>,
): ValidationResult {
  const tier = spec.frontmatter.tier;
  const raw = spec.raw;
  const rawLower = raw.toLowerCase();
  const violations: ValidationViolation[] = [];

  // 0. Epic reference resolves (soft — warning only, DR-013 FR-9).
  //    Strip any inline title comment (`epic: EPIC-001  # Title`) before matching.
  const epicRef = epicRefValue(spec.frontmatter.epic);
  if (epicRef && knownEpicRefs && !knownEpicRefs.has(epicRef.toLowerCase())) {
    violations.push({
      rule: 'epic.unresolved',
      severity: 'warning',
      message: `Epic "${epicRef}" does not match any registered epic.`,
      fixHint: 'Create the epic (MinSpec: Create Epic) or fix the ref to an existing EPIC-NNN id or slug. The spec stays grouped under "(no epic)" until then.',
    });
  }

  // 1. Required-phase sections must be present and non-empty.
  const required: Phase[] = config.phaseMappings[tier]?.requiredPhases ?? [];
  for (const phase of required) {
    const content = spec.phaseSections[phase];
    const empty = !content || content.body.trim() === '';
    if (empty) {
      violations.push({
        rule: `section.${phase}.empty`,
        severity: TIER_RANK[tier] >= 3 ? 'error' : 'warning',
        message: `Required "${phase}" section is missing or empty for ${tier}.`,
        fixHint: `Add a "## ${cap(phase)}" section with content. ${tier} requires the ${required.map(cap).join(' → ')} phases.`,
      });
    }
  }

  // 2. Acceptance criteria (T3/T4).
  if (requiresAcceptanceCriteria(tier) && !hasAcceptanceCriteria(spec)) {
    violations.push({
      rule: 'acceptance.missing',
      severity: 'error',
      message: `${tier} spec has no acceptance criteria.`,
      fixHint: 'Add an "## Acceptance Criteria" section, or a checkbox list in the Specify section, defining done.',
    });
  }

  // 3. Aspect-conditional artifacts.
  const declaredAspects = parseDeclaredAspects(raw);
  const detectedAspects = detectAspects(rawLower);
  const effectiveAspects = ASPECTS.filter(
    (a) => declaredAspects.includes(a) || detectedAspects.includes(a),
  );
  const sev = aspectSeverity(tier);
  if (sev) {
    for (const ar of ASPECT_RULES) {
      if (!effectiveAspects.includes(ar.aspect)) continue;
      if (ar.satisfied(raw)) continue;
      // Detected-only (not declared) aspects soften to warning to limit false positives.
      const detectedOnly = !declaredAspects.includes(ar.aspect);
      violations.push({
        rule: ar.rule,
        severity: detectedOnly && sev === 'error' ? 'warning' : sev,
        message: ar.message,
        fixHint: ar.fixHint,
      });
    }
  }

  const complete = !violations.some((v) => v.severity === 'error');

  return {
    specId: spec.frontmatter.id,
    tier,
    complete,
    violations,
    detectedAspects,
    declaredAspects,
    effectiveAspects,
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
