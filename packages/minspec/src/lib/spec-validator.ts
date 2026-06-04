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

/**
 * Strong keyword signals per aspect — each unambiguous enough that ONE is enough to
 * detect the aspect. Word-boundary matched, case-insensitive. The `api` and `data`
 * aspects ALSO carry an ambiguous keyword set (below) handled by a stricter rule;
 * their entries here are the strong sets only.
 */
const ASPECT_KEYWORDS: Record<Aspect, string[]> = {
  ux: ['ui', 'ux', 'screen', 'page', 'component', 'button', 'modal', 'dialog',
    'layout', 'wireframe', 'frontend', 'css', 'view', 'form', 'menu', 'icon'],
  // See `API_AMBIGUOUS_KEYWORDS` below — the api aspect has a stricter rule and
  // its keyword set is split into strong/weak; this entry is the strong set.
  api: ['endpoint', 'api', 'payload', 'graphql', 'webhook', 'rpc', 'restful', 'openapi'],
  // See `DATA_AMBIGUOUS_KEYWORDS` below — `table`/`query`/`index` are polysemous and
  // moved to the ambiguous set (#153.4); this entry is the strong, unambiguous set.
  data: ['schema', 'migration', 'database', 'column', 'entity', 'sql'],
  architecture: ['architecture', 'subsystem', 'service', 'integration',
    'cross-cutting', 'topology', 'pipeline', 'queue', 'broker'],
};

/**
 * Ambiguous api keywords (#108). `request`, `response`, `route`, `http` are common
 * English words; bare `rest` (now dropped — `restful` / `rest api` carry the real
 * signal) collided with "the rest". A single ambiguous keyword is NOT enough to flag
 * the api aspect.
 *
 * `request` and `response` are the SOFTEST of these — both are everyday UX/interaction
 * prose ("the user's request", "in response to a click") — so even *together* they are
 * not a reliable API signal (#153.4: that pair tripped `aspect.api.no-schema` on UX
 * prose with no API). The corroboration rule therefore requires the soft pair to be
 * backed by a STRUCTURAL ambiguous keyword (`route`/`http`) or a strong keyword:
 * request+response alone no longer fires; request+route / response+http still do, as
 * does request+response+a-strong-word.
 */
const API_AMBIGUOUS_KEYWORDS = ['request', 'response', 'route', 'http'] as const;
/** The STRUCTURAL ambiguous api keywords — concrete enough to corroborate the soft pair. */
const API_STRUCTURAL_AMBIGUOUS = ['route', 'http'] as const;

/**
 * Ambiguous data keywords (#153.4, the data sibling of #108). `table` (markdown
 * table / HTML table), `query` ("query the user"), and `index` ("index.md",
 * "index into the list") are individually polysemous, so one alone must not flag the
 * data aspect: it needs a strong data keyword OR ≥2 ambiguous corroborating.
 */
const DATA_AMBIGUOUS_KEYWORDS = ['table', 'query', 'index'] as const;

/** Compile a case-insensitive word-boundary regex for a keyword. */
function wordBoundaryRe(kw: string): RegExp {
  return new RegExp(`\\b${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
}

/**
 * The api aspect's detection rule, separated from the generic any-keyword rule
 * because its keywords are individually ambiguous (#108, #153.4). Fires when there is
 * at least one strong keyword, OR the phrase "rest api", OR ≥2 distinct ambiguous
 * keywords WHERE at least one is structural (`route`/`http`) — the soft `request` +
 * `response` pair alone is not enough. One ambiguous keyword alone never fires.
 */
function detectsApi(rawLower: string): boolean {
  if (ASPECT_KEYWORDS.api.some((kw) => wordBoundaryRe(kw).test(rawLower))) return true;
  if (/\brest\s+api\b/i.test(rawLower)) return true; // "REST API" as a phrase
  const ambiguousHits = API_AMBIGUOUS_KEYWORDS.filter((kw) => wordBoundaryRe(kw).test(rawLower)).length;
  if (ambiguousHits < 2) return false;
  // ≥2 ambiguous, but the soft request+response pair needs a structural anchor.
  return API_STRUCTURAL_AMBIGUOUS.some((kw) => wordBoundaryRe(kw).test(rawLower));
}

/**
 * The data aspect's detection rule (#153.4). Fires when there is at least one strong
 * data keyword, OR ≥2 distinct ambiguous (`table`/`query`/`index`) keywords. One
 * ambiguous keyword alone never fires.
 */
function detectsData(rawLower: string): boolean {
  if (ASPECT_KEYWORDS.data.some((kw) => wordBoundaryRe(kw).test(rawLower))) return true;
  const ambiguousHits = DATA_AMBIGUOUS_KEYWORDS.filter((kw) => wordBoundaryRe(kw).test(rawLower)).length;
  return ambiguousHits >= 2;
}

function detectAspects(rawLower: string): Aspect[] {
  const found: Aspect[] = [];
  for (const aspect of ASPECTS) {
    let hit: boolean;
    if (aspect === 'api') hit = detectsApi(rawLower);
    else if (aspect === 'data') hit = detectsData(rawLower);
    else hit = ASPECT_KEYWORDS[aspect].some((kw) => wordBoundaryRe(kw).test(rawLower));
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
const MARKDOWN_TABLE_RE = /^\s*\|.+\|\s*\n\s*\|[\s:|-]+\|\s*$/m;
const hasMarkdownTable = (s: string) => MARKDOWN_TABLE_RE.test(s);
/**
 * A genuine box-drawing / flow glyph: unicode box-drawing + arrows. The bare `|`
 * is deliberately NOT here — a markdown table row starts with `|`, and counting it
 * as box-drawing made a plain table read as an ascii box (#153.1).
 */
const BOX_GLYPH_RE = /[┌┐└┘├┤┬┴┼─│▼▲►◄▶◀→←↓↑]/;
/** An ASCII `+---` / `---+` frame corner — the other legitimate box style. */
const PLUS_FRAME_RE = /\+[-=]{2,}|[-=]{2,}\+/;
/** A markdown table separator row, e.g. `|---|:--:|`. The unambiguous table marker. */
const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/;
/** A pipe-delimited row (table data OR an ascii-box interior `| label |` line). */
const isPipeRow = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith('|') && (t.match(/\|/g)?.length ?? 0) >= 2;
};

/**
 * Line indices belonging to a MARKDOWN TABLE: a contiguous run of pipe-rows that
 * contains a separator row (`|---|---|`). The separator is what distinguishes a
 * data table from the `| label |` interior of a `+---` ascii box, which has no
 * separator row. Used to exclude true table rows from the box-line count (#153.1).
 */
function markdownTableLineSet(lines: string[]): Set<number> {
  const out = new Set<number>();
  let run: number[] = [];
  let hasSeparator = false;
  const flush = () => {
    if (hasSeparator) for (const i of run) out.add(i);
    run = [];
    hasSeparator = false;
  };
  for (let i = 0; i < lines.length; i++) {
    if (isPipeRow(lines[i])) {
      run.push(i);
      if (TABLE_SEPARATOR_RE.test(lines[i])) hasSeparator = true;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * Crude ascii-box mockup / diagram: 3+ lines carrying a real box-drawing glyph, a
 * `+---` frame, or a pipe-delimited box-interior line — EXCLUDING rows that belong to
 * a markdown table (a `|`-table with a `|---|` separator row is data, not a wireframe
 * or component diagram, #153.1). A genuine ascii box (unicode box chars, `+--+`
 * framing, or a flow diagram with arrows) still counts: its interior `| label |` lines
 * are kept because the block has no table separator.
 */
const hasAsciiBox = (s: string) => {
  const lines = s.split('\n');
  const tableLines = markdownTableLineSet(lines);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (tableLines.has(i)) continue;
    if (BOX_GLYPH_RE.test(lines[i]) || PLUS_FRAME_RE.test(lines[i]) || isPipeRow(lines[i])) count++;
  }
  return count >= 3;
};
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

/** A markdown checkbox list item: `- [ ]` / `- [x]`. */
const CHECKBOX_RE = /- \[[ xX]\]/;

function hasAcceptanceCriteria(spec: ParsedSpec): boolean {
  const raw = spec.raw;
  if (hasSection(raw, ['acceptance criteria', 'acceptance', 'success criteria'])) return true;
  // A checkbox list inside the requirements/specify content counts as acceptance
  // criteria. The parser maps a heading to `phaseSections` only when its text is a
  // literal Phase name (`specify`), so a `type: requirements` spec — whose checklist
  // lives under `## Requirements`, mapping to NO phase — never populated
  // `phaseSections.specify`; the fallback could not fire and a real checklist was
  // FALSELY flagged (#153.2). Scan both the Specify phase section AND the
  // `## Requirements` section (the requirements artifact's primary heading).
  const specify = spec.phaseSections.specify?.body ?? '';
  const requirements = spec.sections.get('Requirements') ?? '';
  return CHECKBOX_RE.test(specify) || CHECKBOX_RE.test(requirements);
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
//   - tier    primary specs (requirements artifacts: single-file OR type:requirements)
//             carry it; split-layout design/tasks files omit it. The parser silently
//             coerces an absent tier → 'T2', so a primary spec missing tier shows a
//             FALSE ceremony level with no signal (#103). → required-when-primary
//             (requiredWhen), NOT a flat `required` — secondary files stay silent.
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
  /**
   * Type-conditional required-ness (#103). When present it OVERRIDES `required`:
   * the field is required only when this predicate, given the spec's `type`
   * frontmatter (lowercased; `''` for a single-file spec with no `type`), returns
   * true. Lets `tier` be required for *primary* specs (requirements artifacts)
   * while staying optional for split-layout `design`/`tasks` files that omit it.
   */
  readonly requiredWhen?: (specType: string) => boolean;
}

/**
 * A *primary* spec is the requirements artifact: a single-file spec (no `type`)
 * or the split-layout `requirements` file. Split-layout `design`/`tasks` files are
 * *secondary* and legitimately omit fields the requirements artifact carries (#103,
 * mirrors the `isSplitLayout` branch). `specType` is the lowercased `type`, `''`
 * when absent.
 */
const isPrimarySpec = (specType: string): boolean => specType === '' || specType === 'requirements';

const CLOSED_SET_FIELDS: readonly ClosedSetField[] = [
  // `id` — identity, presence-only (values not enumerable). Required: 21/21 real
  // specs carry it; the parser silently defaults a missing one to '' (a spec with
  // no id is an integrity hole the SPECS pane can't key on). The CI gate in
  // scripts/validate-frontmatter.ts also blocks it; this is the in-extension warning.
  { key: 'id', required: true },
  { key: 'status', valid: SPEC_STATUS_SET, validList: SPEC_STATUSES, coercesTo: 'new', required: true },
  // tier: required only for a PRIMARY spec (requirements artifact). A missing tier
  // is silently coerced to 'T2' by the parser → wrong completeness requirements and
  // a false ceremony level in the SPECS pane (#103). Secondary split design/tasks
  // files legitimately omit it, so `requiredWhen` gates on the spec's `type`.
  { key: 'tier', valid: TIER_SET, validList: TIERS, coercesTo: 'T2', required: false, requiredWhen: isPrimarySpec },
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
function checkClosedSetField(
  raw: string,
  field: ClosedSetField,
  specType: string,
  out: ValidationViolation[],
): void {
  const value = rawFrontmatterField(raw, field.key);
  // requiredWhen (type-conditional, #103) overrides the static `required` flag.
  const required = field.requiredWhen ? field.requiredWhen(specType) : field.required;
  if (value === undefined) {
    if (required) {
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

// ─── Dangling park-reference lint (#40) ──────────────────────────────────────
//
// SPEC-005 said "Corrupt-file repair parked as a separate issue" with no link, and
// the issue never existed — parked work silently lost. This lints prose that CLAIMS
// something is parked/tracked/filed *as a (separate) issue* but carries no `#NNN` or
// issue URL nearby. Pure-local Tier 0 (DR-004): it does NOT verify the linked issue
// exists (that is a network/`gh` check, Tier 1, explicitly out of scope — issue #40).
//
// Precision matters more than recall here: the corpus is full of legitimate
// park-adjacent prose ("tracked as OQ-1", "tracked separately if the team wants",
// "Park as issue" UI labels, "parking-lot action") that must NOT flood. So the
// trigger requires an explicit park/track/file VERB + "as (a|an|separate|new|its own)
// … issue|ticket" CLAIM, not a bare mention of parking.

/** A claim that something is parked/tracked/filed AS a (separate) issue/ticket. */
const PARK_CLAIM_RE =
  /\b(?:park(?:ed)?|track(?:ed)?|fil(?:ed)?|mov(?:ed)?|split\s+out)\b[^.\n]{0,40}?\bas\b[^.\n]{0,30}?\b(?:separate|new|its\s+own|a|an)\b[^.\n]{0,15}?\b(?:issue|ticket)\b/i;

/** An issue link: a `#NNN` ref or a `…/issues/NNN` URL. */
const ISSUE_LINK_RE = /#\d+|\/issues\/\d+/i;

/**
 * Detect dangling park claims. For each line carrying a park claim, the issue link
 * may sit on the same line OR the immediately adjacent line (markdown links are
 * commonly wrapped onto the next line). A claim with no link in that window is
 * dangling. Returns true when at least one dangling claim exists.
 */
function hasDanglingParkRef(raw: string): boolean {
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!PARK_CLAIM_RE.test(lines[i])) continue;
    const window = `${lines[i - 1] ?? ''}\n${lines[i]}\n${lines[i + 1] ?? ''}`;
    if (!ISSUE_LINK_RE.test(window)) return true;
  }
  return false;
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
  //
  //     The spec's `type` (lowercased; `''` for a single-file spec) drives the
  //     type-conditional `requiredWhen` rules — e.g. tier is required only for a
  //     primary spec (#103), so the gate needs the type. It also drives the
  //     split-layout phase/acceptance checks below, so it is computed once here.
  const specType = (spec.frontmatter.type ?? '').toLowerCase();
  for (const field of CLOSED_SET_FIELDS) {
    checkClosedSetField(raw, field, specType, violations);
  }

  // Split-layout (#93): a spec whose phases are split across sibling files
  // (`type: requirements | design | tasks`, one phase per file) does NOT carry
  // every `## Phase` section in one file — a `design` file legitimately has no
  // `## Plan`. The in-file phase-section + acceptance-criteria checks below assume
  // a single-file spec, so they are skipped for split-layout phase files (the
  // sibling files carry those). Cross-file coverage (do all required phase files
  // exist for the tier?) is a separate, deferred concern.
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
      fixHint: 'Add an "## Acceptance Criteria" section defining done: a checkbox list where each item is a plain-language outcome tracing to its FR/INV (e.g. "- [ ] **Honest degradation** — incoherent state surfaces \'state unclear\'. (FR-6)"). See the "MinSpec: Generate Example Spec" output for the canonical format. A checkbox list under the Specify section (single-file specs) or the Requirements section (requirements specs) also satisfies this.',
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

  // 4. Dangling park reference (#40). A "parked/tracked/filed as a separate issue"
  //    claim with no adjacent `#NNN` / issue URL silently loses parked work (SPEC-005).
  //    WARN only — Tier 0, link-existence is a deferred network concern (DR-004).
  if (hasDanglingParkRef(raw)) {
    violations.push({
      rule: 'park-ref.dangling',
      severity: 'warning',
      message: 'A "parked/tracked as a separate issue" claim has no linked issue.',
      fixHint: 'Add the issue link inline (e.g. `(#NNN)` or a `.../issues/NNN` URL). A park claim with no link silently loses the parked work — file the issue (e.g. `gh issue create`) and link it.',
    });
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

// ─── Split-layout cross-file coverage (#111) ─────────────────────────────────
//
// The #93 fix made validateSpec SKIP the in-file `## Phase` section + acceptance
// + aspect checks for a split-layout phase file (`type: requirements|design|tasks`)
// — correct, because a `design` file has no `## Plan` by design (the file IS its
// phase, Model A). But that skip is per-FILE; nothing then asserts the directory's
// SET of sibling files covers the tier's required phases. So a T3 spec dir holding
// only requirements.md (no design.md / tasks.md) validated clean — the gate that
// should reject a missing sibling phase FILE never existed (the asymmetry: per-file
// "this file is fine" was checked, dir-level "are all required phase files here?"
// was not). This closes that half.
//
// Severity is WARNING, never error — mirroring the #137/#103 frontmatter gates and
// for the same reason: incremental authoring is legitimate. A spec mid-Specify
// legitimately has only requirements.md; blocking its approval would punish normal
// in-progress work (and would newly fail ~10 real, hand-authored T3/T4 spec dirs
// that carry only requirements.md). We surface the missing-coverage gap so it can't
// pass *silently*, without converting "in progress" into a hard block. The in-file
// `section.*.empty` error still applies to SINGLE-FILE specs (unchanged).

/** Split-layout `type` → the SDD phase that file embodies (Model A, #93/#111). */
const SPLIT_TYPE_PHASE: Record<string, Phase> = {
  requirements: 'specify',
  design: 'plan',
  tasks: 'tasks',
};

/**
 * The required phases that map to a DEDICATED split-layout file, in tier order.
 * Only specify/plan/tasks have their own sibling file (requirements/design/tasks).
 * `clarify` lives inside requirements.md and `implement` inside tasks.md (see
 * spec-layout PHASE_FILE_MAP), so they are NOT separately-required FILES — a dir
 * is not "missing a clarify file". This keeps the coverage check to the three
 * real artifacts and avoids demanding files the layout never produces.
 */
function requiredSplitPhases(tier: Tier, config: MinspecConfig): Phase[] {
  const required = config.phaseMappings[tier]?.requiredPhases ?? [];
  const fileBacked = new Set<Phase>(Object.values(SPLIT_TYPE_PHASE));
  return required.filter((p) => fileBacked.has(p));
}

/** One sibling file in a split-layout spec directory, reduced to what coverage needs. */
export interface SplitLayoutFile {
  /** The file's `type:` frontmatter, lowercased (`requirements` | `design` | `tasks`). */
  readonly type: string;
  /** The file's `tier:` frontmatter, used to pick the tier when present. */
  readonly tier?: Tier;
}

export interface SplitLayoutCoverageResult {
  /** true when the file set is NOT a split layout at all (no `type:` files seen). */
  readonly notSplitLayout: boolean;
  /** Coverage violations (always warning severity). Empty when fully covered. */
  readonly violations: ValidationViolation[];
}

/**
 * Validate that a split-layout spec DIRECTORY's set of sibling files covers the
 * tier's required, file-backed phases (#111). Pure: takes the already-parsed
 * sibling files (their `type` + `tier`), no filesystem. Callers (the validate
 * command, the CI frontmatter script) assemble the set per directory and pass it.
 *
 * - Returns `notSplitLayout: true` (and no violations) when NONE of the files carry
 *   a split `type:` — a directory of single-file specs is not this check's concern;
 *   each is validated in-file by validateSpec as before.
 * - Otherwise, for each required file-backed phase whose `type` is absent from the
 *   set, emits a WARNING `split-coverage.<type>.missing`. Warning (never error) so a
 *   mid-authoring dir (only requirements.md) is surfaced but not blocked.
 *
 * The tier is taken from the requirements file's `tier:` when present (the primary
 * artifact carries it, #103), else the first file that declares one, else falls
 * back to the supplied `fallbackTier`. A dir with no declared tier anywhere uses
 * the fallback so coverage still runs rather than silently skipping.
 */
export function validateSplitLayoutCoverage(
  files: readonly SplitLayoutFile[],
  config: MinspecConfig,
  fallbackTier: Tier = 'T2',
): SplitLayoutCoverageResult {
  const splitFiles = files.filter((f) => SPLIT_LAYOUT_TYPES.has(f.type));
  if (splitFiles.length === 0) {
    return { notSplitLayout: true, violations: [] };
  }

  // Tier: prefer the requirements (primary) file's tier, then any file's tier, then
  // the fallback. A split dir's authoritative ceremony level lives on requirements.
  const requirementsFile = splitFiles.find((f) => f.type === 'requirements');
  const tier: Tier =
    requirementsFile?.tier ??
    splitFiles.find((f) => f.tier)?.tier ??
    fallbackTier;

  const presentTypes = new Set(splitFiles.map((f) => f.type));
  const violations: ValidationViolation[] = [];

  for (const phase of requiredSplitPhases(tier, config)) {
    // The split `type` whose file embodies this phase (specify→requirements, …).
    const type = (Object.keys(SPLIT_TYPE_PHASE) as string[]).find(
      (t) => SPLIT_TYPE_PHASE[t] === phase,
    );
    if (!type || presentTypes.has(type)) continue;
    violations.push({
      rule: `split-coverage.${type}.missing`,
      severity: 'warning',
      message: `Split-layout spec is missing its ${type}.md — ${tier} requires the ${cap(phase)} phase, which lives in ${type}.md.`,
      fixHint: `Add a sibling "${type}.md" (\`type: ${type}\`) carrying the ${cap(phase)} phase. ${tier} requires ${requiredSplitPhases(tier, config).map((p) => cap(p)).join(' → ')}. A split spec missing a required phase file is incomplete — the phase isn't covered by any sibling.`,
    });
  }

  return { notSplitLayout: false, violations };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
