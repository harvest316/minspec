import * as fs from 'fs';
import type { Tier, Phase } from './config';
import { PHASES } from './config';

/** Status of an individual phase */
export type PhaseStatus = 'pending' | 'in-progress' | 'done' | 'skipped';

/** Lifecycle status of the entire spec */
export type SpecStatus = 'new' | 'specifying' | 'implementing' | 'done' | 'archived';

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
    const raw = fmPhases[phase];
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
    tier: (TIERS_SET.has(fmParsed.tier as string) ? fmParsed.tier : 'T2') as Tier,
    status: (STATUSES_SET.has(fmParsed.status as string) ? fmParsed.status : 'new') as SpecStatus,
    created: (fmParsed.created as string) ?? new Date().toISOString().slice(0, 10),
    epic: (fmParsed.epic as string) || undefined,
    phases: {
      specify: (fmPhases.specify as PhaseStatus) ?? 'pending',
      clarify: (fmPhases.clarify as PhaseStatus) ?? 'pending',
      plan: (fmPhases.plan as PhaseStatus) ?? 'pending',
      tasks: (fmPhases.tasks as PhaseStatus) ?? 'pending',
      implement: (fmPhases.implement as PhaseStatus) ?? 'pending',
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
const STATUSES_SET = new Set(['new', 'specifying', 'implementing', 'done', 'archived']);

// --- Writer ---

/** Serialize frontmatter to YAML string */
function serializeFrontmatter(fm: SpecFrontmatter): string {
  const lines: string[] = [];
  lines.push(`id: ${fm.id}`);
  lines.push(`title: ${fm.title}`);
  lines.push(`tier: ${fm.tier}`);
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
