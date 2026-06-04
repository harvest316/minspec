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
import { SPEC_STATUSES, SPEC_TYPES, stripInlineComment } from './spec';
import type { Tier, MinspecConfig, Phase } from './config';
import { TIERS } from './config';
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
  // See `API_AMBIGUOUS_KEYWORDS` below — the api aspect has a stricter rule and
  // its keyword set is split into strong/weak; this entry is the strong set.
  api: ['endpoint', 'api', 'payload', 'graphql', 'webhook', 'rpc', 'restful', 'openapi'],
  data: ['schema', 'table', 'migration', 'database', 'column', 'entity',
    'index', 'query', 'sql'],
  architecture: ['architecture', 'subsystem', 'service', 'integration',
    'cross-cutting', 'topology', 'pipeline', 'queue', 'broker'],
};

/**
 * Ambiguous api keywords (#108). `request`, `response`, `route`, `http` are common
 * English words; bare `rest` (now dropped — `restful` / `rest api` carry the real
 * signal) collided with "the rest". A single ambiguous keyword is NOT enough to flag
 * the api aspect: it needs a strong signal (`ASPECT_KEYWORDS.api`) OR ≥2 ambiguous
 * keywords corroborating each other. This fixes SPEC-015 tripping `aspect.api.no-schema`
 * on the prose "…the rest" while keeping genuine API specs (request+response, a route +
 * payload, "REST API") detected.
 */
const API_AMBIGUOUS_KEYWORDS = ['request', 'response', 'route', 'http'] as const;

/** Compile a case-insensitive word-boundary regex for a keyword. */
function wordBoundaryRe(kw: string): RegExp {
  return new RegExp(`\\b${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
}

/**
 * The api aspect's detection rule, separated from the generic any-keyword rule
 * because its keywords are individually ambiguous (#108). Fires when there is at
 * least one strong keyword, OR the phrase "rest api", OR ≥2 distinct ambiguous
 * keywords. One ambiguous keyword alone never fires.
 */
function detectsApi(rawLower: string): boolean {
  if (ASPECT_KEYWORDS.api.some((kw) => wordBoundaryRe(kw).test(rawLower))) return true;
  if (/\brest\s+api\b/i.test(rawLower)) return true; // "REST API" as a phrase
  const ambiguousHits = API_AMBIGUOUS_KEYWORDS.filter((kw) => wordBoundaryRe(kw).test(rawLower)).length;
  return ambiguousHits >= 2;
}

function detectAspects(rawLower: string): Aspect[] {
  const found: Aspect[] = [];
  for (const aspect of ASPECTS) {
    const hit = aspect === 'api'
      ? detectsApi(rawLower)
      : ASPECT_KEYWORDS[aspect].some((kw) => wordBoundaryRe(kw).test(rawLower));
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
/**
 * A fenced ``` code block containing box-drawing / flow characters — i.e. an
 * ASCII diagram, including *flow* diagrams (arrows, ▼) whose lines start with
 * text labels rather than box-framing chars (so `hasAsciiBox` misses them).
 */
const hasDiagramFence = (s: string) =>
  /```[\s\S]*?[┌┐└┘├┤┬┴┼─│▼▲►◄▶◀→←↓↑][\s\S]*?```/.test(s);

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
      hasMermaid(s) || /\.(puml|drawio|svg)\b/i.test(s) || hasAsciiBox(s) || hasDiagramFence(s),
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

// ─── Closed-enum frontmatter gate (#115) ─────────────────────────────────────

const FRONTMATTER_BLOCK_RE = /^---\n([\s\S]*?)\n---/;

/**
 * Read a top-level scalar frontmatter field's RAW value from a spec's source,
 * comment-stripped with the SAME semantics the parser uses (so a valid value
 * carrying an inline `# comment` is not mistaken for an unknown one).
 *
 * Returns:
 *  - `undefined` when the field is absent or has an empty value (a legitimate
 *    default — not a coercion of a present value, so nothing to flag).
 *  - the stripped string otherwise.
 *
 * Only the top-level frontmatter block is scanned: a `key:` token in the body or
 * a nested (indented) line must never be read as the frontmatter field. This is
 * the lossy raw read the gate needs — post-parse, an unknown value is already
 * coerced to the default and indistinguishable from a genuine one.
 */
function rawFrontmatterField(raw: string, key: string): string | undefined {
  const block = raw.match(FRONTMATTER_BLOCK_RE);
  if (!block) return undefined;
  // Top-level (column-0) key line only — skip indented (nested) and body lines.
  const lineRe = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm');
  const m = block[1].match(lineRe);
  if (!m) return undefined;
  const stripped = stripInlineComment(m[1]);
  return stripped === '' ? undefined : stripped;
}

const SPEC_STATUS_SET = new Set<string>(SPEC_STATUSES);
const TIER_SET = new Set<string>(TIERS);
const SPEC_TYPE_SET = new Set<string>(SPEC_TYPES);

/** Split-layout phase-file kinds (one phase per sibling file) — see SPEC_TYPES. */
const SPLIT_LAYOUT_TYPES = SPEC_TYPE_SET;

// ─── Symmetric frontmatter primitive (#137) ──────────────────────────────────
//
// The recurring DR-003 Phase-4 asymmetry, fixed structurally rather than per
// field. Each frontmatter field belongs to a *class* with two directions that
// MUST both be asserted:
//
//   closed-set: present ⇒ valid (warn on an unrecognized member, #115)
//               required ⇒ present (warn when a genuinely-required field is absent)
//   reference:  present ⇒ resolvable (warn on a dangling ref)
//               required ⇒ present (warn when a required ref is missing — SPEC-004)
//
// Severity is ALWAYS `warning` — never an error. Foreign-but-valid vocabularies
// (Spec Kit's `draft`) and incremental authoring (a half-written spec) must not be
// blocked; we only surface that MinSpec does not recognize / cannot resolve a
// value, or that a value the schema expects is absent.
//
// The derived field schema (CLOSED_SET_FIELDS below) is evidence-based, NOT a
// hardcoded guess. Across the real specs/ corpus (21 files, 2026-06-04):
//   - id      21/21 present  → required (identity; parser silently defaults to '')
//   - status  21/21 present  → required (parser silently coerces absent → 'new')
//   - tier    10/21 present  → NOT required (split-layout files omit it)
//   - type    single-file specs legitimately omit it (absence IS the single-file
//             signal) → closed-set but NOT required
// product has no canonical value-list anywhere in code, so it is intentionally
// not closed-set-validated (inventing a list would risk false warnings on new
// products). depends_on has no resolver passed to validateSpec → not validated
// here. epic keeps its bespoke registry plumbing below (the reference instance).

interface ClosedSetField {
  /** Frontmatter key. */
  readonly key: string;
  /**
   * Recognized members (post inline-comment-strip). Omit for a presence-only
   * field whose values are not enumerable (e.g. `id`): any present value passes
   * the present ⇒ valid direction; only required ⇒ present is meaningful.
   */
  readonly valid?: ReadonlySet<string>;
  /** Members, ordered, for the fix hint. Omit for presence-only fields. */
  readonly validList?: readonly string[];
  /** The parser's silent fallback when the value is unrecognized/absent, if any. */
  readonly coercesTo?: string;
  /** When true, a missing field warns (required ⇒ present). */
  readonly required: boolean;
}

const CLOSED_SET_FIELDS: readonly ClosedSetField[] = [
  // `id` — identity, presence-only (values not enumerable). Required: 21/21 real
  // specs carry it; the parser silently defaults a missing one to '' (a spec with
  // no id is an integrity hole the SPECS pane can't key on). The CI gate in
  // scripts/validate-frontmatter.ts also blocks it; this is the in-extension warning.
  { key: 'id', required: true },
  { key: 'status', valid: SPEC_STATUS_SET, validList: SPEC_STATUSES, coercesTo: 'new', required: true },
  { key: 'tier', valid: TIER_SET, validList: TIERS, coercesTo: 'T2', required: false },
  { key: 'type', valid: SPEC_TYPE_SET, validList: SPEC_TYPES, required: false },
];

/**
 * Symmetric gate for one closed-set frontmatter field. Asserts BOTH directions
 * (present ⇒ valid, required ⇒ present) by re-reading the RAW frontmatter line —
 * the parsed value is lossy after coercion, so the validator must inspect source.
 *
 * - present-but-unrecognized → `frontmatter.<key>.unknown` (was #115's coercion).
 *   Surfaces the silent coercion as a warning so the SPECS pane can't show a lie.
 *   Skipped for presence-only fields (no `valid` set).
 * - required-but-absent → `frontmatter.<key>.missing`. Closes the half of the
 *   #115/DR-003 asymmetry that was never built: nothing asserted a present value
 *   should *exist*. Only fires for `required` fields, so non-required closed-set
 *   fields (tier/type) stay silent when omitted.
 */
function checkClosedSetField(raw: string, field: ClosedSetField, out: ValidationViolation[]): void {
  const value = rawFrontmatterField(raw, field.key);
  if (value === undefined) {
    if (field.required) {
      const oneOf = field.validList ? `, one of: ${field.validList.join(', ')}` : '';
      out.push({
        rule: `frontmatter.${field.key}.missing`,
        severity: 'warning',
        message: `Spec has no ${field.key} — a required field${field.coercesTo ? ` (shown as the default "${field.coercesTo}")` : ''}.`,
        fixHint: `Add a "${field.key}:" line${oneOf}.${field.coercesTo ? ` (An absent value is silently displayed as the default "${field.coercesTo}", so the SPECS pane would otherwise show a false ${field.key}.)` : ''}`,
      });
    }
    return; // not required, or already reported missing → nothing more to assert
  }
  if (!field.valid || field.valid.has(value)) return; // presence-only, or recognized
  out.push({
    rule: `frontmatter.${field.key}.unknown`,
    severity: 'warning',
    message: `Spec ${field.key} "${value}" is not a recognized ${field.key}${field.coercesTo ? ` — it is shown as the default "${field.coercesTo}"` : ''}.`,
    fixHint: `Set "${field.key}:" to one of: ${(field.validList ?? []).join(', ')}.${field.coercesTo ? ` (An unrecognized value is silently displayed as the default, so the SPECS pane would otherwise show a false ${field.key}.)` : ''}`,
  });
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

  // 0. Epic reference (soft — warnings only, DR-013 FR-9). Two failure modes,
  //    both leave the spec stranded under "(no epic)":
  //      a. epic.unresolved — an `epic:` ref matching no registered epic.
  //      b. epic.missing    — no `epic:` at all, in a repo that HAS registered
  //         epics. Gated on a non-empty registry: a pre-epic repo is legitimately
  //         epic-less (graceful degradation), and omitting `knownEpicRefs` skips
  //         the check entirely (callers without registry access stay quiet).
  //    The asymmetry that let SPEC-004 sit orphaned: only (a) was checked, so a
  //    spec that simply never got an `epic:` line slipped past silently.
  //    Strip any inline title comment (`epic: EPIC-001  # Title`) before matching.
  const epicRef = epicRefValue(spec.frontmatter.epic);
  if (epicRef) {
    if (knownEpicRefs && !knownEpicRefs.has(epicRef.toLowerCase())) {
      violations.push({
        rule: 'epic.unresolved',
        severity: 'warning',
        message: `Epic "${epicRef}" does not match any registered epic.`,
        fixHint: 'Create the epic (MinSpec: Create Epic) or fix the ref to an existing EPIC-NNN id or slug. The spec stays grouped under "(no epic)" until then.',
      });
    }
  } else if (knownEpicRefs && knownEpicRefs.size > 0) {
    violations.push({
      rule: 'epic.missing',
      severity: 'warning',
      message: 'Spec has no epic reference but epics are registered.',
      fixHint: 'Add an `epic: EPIC-NNN` frontmatter line (MinSpec: Create Epic, or run epic backfill). The spec stays grouped under "(no epic)" until then.',
    });
  }

  // 0b. Closed-set frontmatter — the symmetric primitive (#137). For each
  //     closed-set field assert BOTH directions: present ⇒ valid (a
  //     present-but-unrecognized value is silently coerced by the parser to a
  //     default and shown as if real — a signpost-lie, #115) AND required ⇒
  //     present (a missing required field, the half of the asymmetry that
  //     stranded SPEC-004's epic — see DR-003 Phase 4). WARN, never block:
  //     foreign-but-valid vocabularies (`draft`) and incremental authoring are
  //     legitimate. Field set is derived from the schema (CLOSED_SET_FIELDS),
  //     not scattered literals.
  for (const field of CLOSED_SET_FIELDS) {
    checkClosedSetField(raw, field, violations);
  }

  // Split-layout (#93): a spec whose phases are split across sibling files
  // (`type: requirements | design | tasks`, one phase per file) does NOT carry
  // every `## Phase` section in one file — a `design` file legitimately has no
  // `## Plan`. The in-file phase-section + acceptance-criteria checks below assume
  // a single-file spec, so they are skipped for split-layout phase files (the
  // sibling files carry those). Cross-file coverage (do all required phase files
  // exist for the tier?) is a separate, deferred concern.
  const specType = (spec.frontmatter.type ?? '').toLowerCase();
  const isSplitLayout = SPLIT_LAYOUT_TYPES.has(specType);

  // 1. Required-phase sections must be present and non-empty (single-file only).
  if (!isSplitLayout) {
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
  }

  // 2. Acceptance criteria (T3/T4). Belongs to the specify/requirements phase, so
  //    in split-layout only the `requirements` file carries it.
  const acceptancePhaseFile = !isSplitLayout || specType === 'requirements';
  if (acceptancePhaseFile && requiresAcceptanceCriteria(tier) && !hasAcceptanceCriteria(spec)) {
    violations.push({
      rule: 'acceptance.missing',
      severity: 'error',
      message: `${tier} spec has no acceptance criteria.`,
      fixHint: 'Add an "## Acceptance Criteria" section defining done: a checkbox list where each item is a plain-language outcome tracing to its FR/INV (e.g. "- [ ] **Honest degradation** — incoherent state surfaces \'state unclear\'. (FR-6)"). See the "MinSpec: Generate Example Spec" output for the canonical format. A checkbox list in the Specify section also satisfies this.',
    });
  }

  // 3. Aspect-conditional artifacts. Mockups / schemas / diagrams are
  //    DESIGN-phase deliverables, so in split-layout they live in the `design`
  //    file: a requirements/tasks file that merely references a UX/API/data
  //    surface must not be flagged for a missing artifact that belongs to its
  //    sibling design file (#93 class). Detection is still reported; only the
  //    artifact-requirement violations are gated to design + single-file.
  const declaredAspects = parseDeclaredAspects(raw);
  const detectedAspects = detectAspects(rawLower);
  const effectiveAspects = ASPECTS.filter(
    (a) => declaredAspects.includes(a) || detectedAspects.includes(a),
  );
  const aspectArtifactFile = !isSplitLayout || specType === 'design';
  const sev = aspectArtifactFile ? aspectSeverity(tier) : null;
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
