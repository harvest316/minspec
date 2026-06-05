import * as fs from 'fs';
import type { Tier, Phase } from './config';
import { PHASES } from './config';

/** Status of an individual phase */
export type PhaseStatus = 'pending' | 'in-progress' | 'done' | 'skipped';

/**
 * Lifecycle statuses of a spec, in lifecycle order. Single source of truth:
 * `SpecStatus` derives from this tuple, and consumers that must cover every
 * status (e.g. the tree's status lanes, SPEC-015 INV-1) import it so adding a
 * status here forces a decision everywhere it matters.
 */
export const SPEC_STATUSES = ['new', 'specifying', 'implementing', 'done', 'archived'] as const;

/** Lifecycle status of the entire spec */
export type SpecStatus = typeof SPEC_STATUSES[number];

/**
 * Split-layout phase-file kinds. A spec split across sibling files carries one
 * of these in its `type:` frontmatter (one phase per file); a single-file spec
 * carries no `type` at all. Single source of truth: the split-layout branch in
 * `validateSpec` and the closed-set `type` gate both import this, so the closed
 * set of legitimate `type` values lives in exactly one place.
 *
 * NOTE: `type` is a closed-set field but NOT a required one — single-file specs
 * legitimately omit it (their absence IS the single-file signal). Requiring it
 * would mis-flag every single-file spec.
 */
export const SPEC_TYPES = ['requirements', 'design', 'tasks'] as const;

/** A split-layout phase-file kind. */
export type SpecType = typeof SPEC_TYPES[number];

/** A single task item within a phase section */
export interface TaskItem {
  readonly text: string;
  readonly done: boolean;
}

/** Parsed content of a phase section */
export interface PhaseContent {
  readonly status: PhaseStatus;
  readonly body: string;
  readonly tasks: TaskItem[];
}

/** YAML frontmatter for a spec file — Spec Kit compatible with MinSpec extensions */
export interface SpecFrontmatter {
  readonly id: string;
  readonly title: string;
  readonly tier: Tier;
  readonly status: SpecStatus;
  readonly created: string;
  readonly phases: Record<Phase, PhaseStatus>;
  /** Optional epic reference (EPIC-NNN id or slug). Absent = ungrouped. */
  readonly epic?: string;
  /**
   * Owning product slug (e.g. `minspec` / `scroogellm`) from the `product:`
   * frontmatter field. Drives the SPECS-pane product-prefix strip under epic
   * grouping (the H1 title carries a redundant `MinSpec — ` / `ScroogeLLM — `
   * prefix). Absent for single-product repos that omit the field.
   */
  readonly product?: string;
  /**
   * Split-layout phase-file kind: `requirements` | `design` | `tasks`. Present
   * when a spec is split across sibling files (one phase per file) rather than a
   * single file carrying all `## Phase` sections. Drives layout-aware validation
   * (a `design` file legitimately has no in-file `## Plan`). Absent = single-file.
   */
  readonly type?: string;
}

/** Complete parsed spec */
export interface ParsedSpec {
  readonly frontmatter: SpecFrontmatter;
  readonly preamble: string;
  readonly sections: Map<string, string>;
  readonly phaseSections: Partial<Record<Phase, PhaseContent>>;
  readonly raw: string;
}

// --- Parser ---

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const TASK_RE = /^- \[([ xX])\] (.+)$/;
const HEADING_RE = /^## (.+)$/;
const H1_RE = /^# (.+)$/;

/**
 * Extract the first level-1 (`# `) heading text from a markdown body.
 * Used as the human title fallback when frontmatter has no `title:` field —
 * spec files carry their title in the first `# ` heading, not the frontmatter.
 * Returns '' when no level-1 heading exists.
 */
function firstH1Heading(body: string): string {
  for (const line of body.split('\n')) {
    const match = line.match(H1_RE);
    if (match) return match[1].trim();
  }
  return '';
}

/** Parse YAML frontmatter — lightweight, no dependency */
/**
 * Strip a YAML inline comment from a scalar value. A `#` begins a comment only
 * when preceded by whitespace (YAML spec); a `#` glued to preceding text is part
 * of the value. A quoted scalar has NO inline comment stripped (its `#` is
 * literal), but its surrounding quotes ARE removed so the inner value is returned
 * — otherwise a quoted closed-enum value (`status: "done"`) carries its quotes
 * into the STATUSES_SET/TIERS_SET membership check, which fails, silently coercing
 * to the default ('new'/'T2') AND making `validateSpec` (which re-strips the raw
 * line) emit a spurious `frontmatter.*.unknown` (#153.1). An empty quoted scalar
 * (`""` / `''`) returns `''`, so it coerces to the default like any empty value —
 * NOT a spurious enum member.
 *
 * Without this, `status: implementing  # note` parsed as the whole string, which
 * failed the SpecStatus enum check and silently became 'new' — a false status.
 *
 * Exported so `validateSpec` can re-strip the RAW frontmatter line with identical
 * semantics when asserting a present `status`/`tier` is a recognized enum member
 * (#115 follow-up gate): the parsed value is lossy after coercion, so the validator
 * must re-read the raw line, and it must match exactly what the parser accepted.
 */
export function stripInlineComment(value: string): string {
  const v = value.trim();
  // A matched quoted scalar: strip the surrounding quotes (need ≥2 chars so a lone
  // quote isn't treated as a matched pair). Inner `#` is literal — no comment strip.
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1);
  }
  const m = v.match(/\s#/);
  return m && m.index !== undefined ? v.slice(0, m.index).trim() : v;
}

const PHASE_STATUSES = ['pending', 'in-progress', 'done', 'skipped'] as const;

/** Strip any inline comment, then validate against PhaseStatus (default pending). */
function phaseStatusOf(raw: unknown): PhaseStatus {
  if (typeof raw !== 'string') return 'pending';
  const v = stripInlineComment(raw);
  return (PHASE_STATUSES as readonly string[]).includes(v) ? (v as PhaseStatus) : 'pending';
}

function parseFrontmatterYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let nested: Record<string, string> | null = null;

  for (const line of yaml.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Nested key (indented under a parent)
    if (/^\s{2,}\w/.test(line) && currentKey) {
      const stripped = trimmed.trim();
      const match = stripped.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
      if (match) {
        if (!nested) nested = {};
        nested[match[1]] = match[2].trim();
      }
      continue;
    }

    // Flush previous nested block
    if (nested && currentKey) {
      result[currentKey] = nested;
      nested = null;
    }

    // Top-level key
    const match = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (match) {
      currentKey = match[1];
      const value = match[2].trim();
      if (value === '') {
        // Start of a nested block
        nested = {};
      } else {
        result[currentKey] = value;
        currentKey = null;
      }
    }
  }

  // Flush final nested block
  if (nested && currentKey) {
    result[currentKey] = nested;
  }

  return result;
}

/** Parse task items from markdown body */
function parseTasks(body: string): TaskItem[] {
  const tasks: TaskItem[] = [];
  for (const line of body.split('\n')) {
    const match = line.trim().match(TASK_RE);
    if (match) {
      tasks.push({ text: match[2], done: match[1] !== ' ' });
    }
  }
  return tasks;
}

/** Determine phase status from frontmatter phases map, falling back to body content */
function resolvePhaseStatus(phase: Phase, fmPhases: Record<string, string> | undefined, body: string): PhaseStatus {
  if (fmPhases && fmPhases[phase]) {
    const raw = stripInlineComment(fmPhases[phase]);
    if (['pending', 'in-progress', 'done', 'skipped'].includes(raw)) {
      return raw as PhaseStatus;
    }
  }
  // Infer from content
  const tasks = parseTasks(body);
  if (tasks.length === 0 && body.trim() === '') return 'pending';
  if (tasks.length > 0 && tasks.every(t => t.done)) return 'done';
  if (tasks.some(t => t.done) || body.trim().length > 0) return 'in-progress';
  return 'pending';
}

/**
 * Parse a spec markdown file into structured data.
 * Handles Spec Kit format (YAML frontmatter + ## sections).
 */
export function parseSpec(content: string): ParsedSpec {
  const raw = content;

  // Extract frontmatter
  const fmMatch = content.match(FRONTMATTER_RE);
  const fmRaw = fmMatch ? fmMatch[1] : '';
  const bodyAfterFm = fmMatch ? content.slice(fmMatch[0].length) : content;

  const fmParsed = parseFrontmatterYaml(fmRaw);
  const fmPhases = (fmParsed.phases as Record<string, string>) ?? {};

  // Build frontmatter with defaults
  const frontmatter: SpecFrontmatter = {
    id: (fmParsed.id as string) ?? '',
    // Title comes from frontmatter when present; otherwise fall back to the
    // first level-1 `# ` heading in the body (the human title for spec files).
    title: (fmParsed.title as string) ?? firstH1Heading(bodyAfterFm),
    // Closed-enum fields strip inline comments before the membership check, so a
    // commented value (e.g. `status: implementing  # note`) isn't silently
    // coerced to the default. epic/title keep their raw form (epic carries its
    // human title in a `#` comment by design — see updateSpecFrontmatter).
    tier: (() => { const t = stripInlineComment(String(fmParsed.tier ?? '')); return (TIERS_SET.has(t) ? t : 'T2') as Tier; })(),
    status: (() => { const s = stripInlineComment(String(fmParsed.status ?? '')); return (STATUSES_SET.has(s) ? s : 'new') as SpecStatus; })(),
    created: (fmParsed.created as string) ?? new Date().toISOString().slice(0, 10),
    epic: (fmParsed.epic as string) || undefined,
    product: (fmParsed.product as string) || undefined,
    type: (fmParsed.type as string) || undefined,
    phases: {
      specify: phaseStatusOf(fmPhases.specify),
      clarify: phaseStatusOf(fmPhases.clarify),
      plan: phaseStatusOf(fmPhases.plan),
      tasks: phaseStatusOf(fmPhases.tasks),
      implement: phaseStatusOf(fmPhases.implement),
    },
  };

  // Split body into sections by ## headings
  const sections = new Map<string, string>();
  const phaseSections: Partial<Record<Phase, PhaseContent>> = {};
  let preamble = '';

  const lines = bodyAfterFm.split('\n');
  let currentHeading: string | null = null;
  let currentBody: string[] = [];

  const flushSection = () => {
    if (currentHeading === null) {
      preamble = currentBody.join('\n').trim();
    } else {
      const body = currentBody.join('\n').trimEnd();
      sections.set(currentHeading, body);

      // Check if heading matches a phase name
      const phaseKey = currentHeading.toLowerCase() as Phase;
      if (PHASES.includes(phaseKey)) {
        phaseSections[phaseKey] = {
          status: resolvePhaseStatus(phaseKey, fmPhases, body),
          body,
          tasks: parseTasks(body),
        };
      }
    }
    currentBody = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      flushSection();
      currentHeading = headingMatch[1];
    } else {
      currentBody.push(line);
    }
  }
  flushSection();

  return { frontmatter, preamble, sections, phaseSections, raw };
}

const TIERS_SET = new Set(['T1', 'T2', 'T3', 'T4']);
const STATUSES_SET = new Set<string>(SPEC_STATUSES);

// --- Writer ---

/** Serialize frontmatter to YAML string */
function serializeFrontmatter(fm: SpecFrontmatter): string {
  const lines: string[] = [];
  lines.push(`id: ${fm.id}`);
  lines.push(`title: ${fm.title}`);
  lines.push(`tier: ${fm.tier}`);
  // Reminder: approval (DR-012) binds a sha256 of this whole file. Any edit
  // voids it (→ stale); re-run "MinSpec: Approve Spec" to re-bind. The parser
  // skips full-line `#` comments (see parseFrontmatterYaml), so this is inert.
  lines.push('# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012');
  lines.push(`status: ${fm.status}`);
  lines.push(`created: ${fm.created}`);
  if (fm.epic) lines.push(`epic: ${fm.epic}`);
  lines.push('phases:');
  for (const phase of PHASES) {
    lines.push(`  ${phase}: ${fm.phases[phase]}`);
  }
  return lines.join('\n');
}

/**
 * Write a spec to markdown string.
 * Preserves user content in sections not managed by frontmatter.
 */
export function writeSpec(spec: ParsedSpec): string {
  const parts: string[] = [];

  // Frontmatter
  parts.push('---');
  parts.push(serializeFrontmatter(spec.frontmatter));
  parts.push('---');
  parts.push('');

  // Preamble (title, description, etc.)
  if (spec.preamble) {
    parts.push(spec.preamble);
    parts.push('');
  }

  // Sections in order — phases first (in PHASES order), then others
  const writtenSections = new Set<string>();

  for (const phase of PHASES) {
    const capitalized = phase.charAt(0).toUpperCase() + phase.slice(1);
    const body = spec.sections.get(capitalized);
    if (body !== undefined) {
      parts.push(`## ${capitalized}`);
      parts.push(body);
      parts.push('');
      writtenSections.add(capitalized);
    }
  }

  // Non-phase sections in original order
  for (const [heading, body] of spec.sections) {
    if (!writtenSections.has(heading)) {
      parts.push(`## ${heading}`);
      parts.push(body);
      parts.push('');
      writtenSections.add(heading);
    }
  }

  return parts.join('\n').trimEnd() + '\n';
}

/**
 * Update frontmatter on an existing spec, preserving all user content.
 * Returns new markdown string.
 */
export function updateSpecFrontmatter(content: string, updates: Partial<SpecFrontmatter>): string {
  const spec = parseSpec(content);
  const newFm: SpecFrontmatter = {
    ...spec.frontmatter,
    ...updates,
    phases: updates.phases
      ? { ...spec.frontmatter.phases, ...updates.phases }
      : spec.frontmatter.phases,
  };
  return writeSpec({ ...spec, frontmatter: newFm });
}

/** Read and parse a spec file from disk */
export function readSpecFile(filePath: string): ParsedSpec {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseSpec(content);
}

/** Write a parsed spec back to disk */
export function writeSpecFile(filePath: string, spec: ParsedSpec): void {
  fs.writeFileSync(filePath, writeSpec(spec), 'utf-8');
}

/**
 * Surgically rewrite the `status:` line in a spec's frontmatter in place,
 * adding it if absent. Returns the new status. Throws on invalid status or no
 * frontmatter block.
 *
 * Deliberately a line-level rewrite (mirrors `setEpicStatus`/`setAdrStatus`),
 * NOT a `writeSpec()` re-serialize: the latter would drop full-line `#` comments
 * (e.g. the DR-012 hash-lock reminder) and reorder fields. The symmetric
 * present-value writer specs previously lacked — its absence is why approval
 * could not keep the lifecycle signpost in sync (DR-003 RCDD; #137).
 */
export function setSpecStatus(filePath: string, status: SpecStatus): SpecStatus {
  if (!(SPEC_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Invalid spec status: ${status}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(FRONTMATTER_RE);
  if (!fmMatch) {
    throw new Error(`No frontmatter block in ${filePath}`);
  }
  const yaml = fmMatch[1];
  const statusLineRe = /^([ \t]*)status[ \t]*:[ \t]*.*$/m;
  const newYaml = statusLineRe.test(yaml)
    ? yaml.replace(statusLineRe, `$1status: ${status}`)
    : `${yaml}\nstatus: ${status}`;
  fs.writeFileSync(filePath, content.replace(FRONTMATTER_RE, `---\n${newYaml}\n---\n`), 'utf-8');
  return status;
}
