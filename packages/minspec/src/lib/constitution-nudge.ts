/**
 * constitution-nudge.ts — SPEC-025 FR-6 (empty-constitution nudge, pure half).
 *
 * Reads `.minspec/constitution.md` and decides whether it is empty / all-template
 * (only HTML comments + DRAFT scaffolding, no human-authored rule). Returns a
 * SOFT advisory descriptor (never throws, never blocks). The vscode toast lives
 * in the command layer (init.ts); this is the deterministic, unit-testable half.
 *
 * Note: a constitution holding ONLY MinSpec DRAFT seed entries still counts as
 * "empty" for the nudge — the human has authored nothing yet, so we still signpost
 * "author your constitution". A single human (non-DRAFT) rule flips empty → false.
 *
 * INV-4 Degrade, never block: a missing file returns `empty: true` and never throws.
 *
 * Pure logic, no vscode dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseConstitution } from './constitution';

/** Soft advisory descriptor for the empty-constitution nudge (FR-6). */
export interface ConstitutionNudge {
  readonly empty: boolean;
  readonly message: string;
  readonly fixHint: string;
  /**
   * The offer-to-fix action surfaced on the nudge toast (#320): the label the
   * user clicks and the command it runs. Pure metadata — the toast itself is
   * shown by the (vscode-bearing) command/surface layer, never here (INV-1
   * Tier-0). The command writes a deterministic DRAFT proposal into the empty
   * sections (see `constitutionProposeCommand`).
   */
  readonly fixActionLabel: string;
  readonly fixCommandId: string;
}

const ADVISORY_MESSAGE =
  'MinSpec: your constitution has no human-authored rules yet — consider authoring its Invariants, Principles, Constraints, and Goals.';
const FIX_HINT =
  'Edit .minspec/constitution.md (review/accept any DRAFT entries MinSpec seeded).';
/** Label for the offer-to-fix action on the nudge (#320). */
export const PROPOSE_ACTION_LABEL = 'Propose draft';
/** The command the offer-to-fix action runs (#320). */
export const PROPOSE_COMMAND_ID = 'minspec.constitutionPropose';

/**
 * Is the constitution all-template — only comments and MinSpec DRAFT entries,
 * with no human-authored list item or prose line? Mirrors the constitution
 * parser's list extraction, then discards items that are MinSpec DRAFTs.
 */
export function isAllTemplate(content: string): boolean {
  if (!content || !content.trim()) return true;

  const { invariants, principles, constraints } = parseConstitution(content);
  const allItems = [...invariants, ...principles, ...constraints];

  // A human item is any extracted list item that is NOT a MinSpec DRAFT entry.
  const humanItems = allItems.filter((item) => !item.trimStart().startsWith('DRAFT:'));
  if (humanItems.length > 0) return false;

  // No human list items. Also treat any non-comment, non-DRAFT prose under a
  // section as human content (e.g. a hand-written paragraph rule).
  const hasHumanProse = scanForHumanProse(content);
  return !hasHumanProse;
}

/**
 * Scan section bodies for a human prose line: a non-empty line that is not a
 * heading, not an HTML comment, not a DRAFT list item, and not a provenance
 * blockquote. The constitution template's own descriptive sentences live
 * directly under each `##` heading, so we only treat content under a heading as
 * potential rules and ignore the standard template descriptions.
 */
function scanForHumanProse(content: string): boolean {
  const lines = content.split('\n');
  let inComment = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }
    if (!line) continue;
    if (line.startsWith('#')) continue; // headings (## sections, # title)
    if (line.startsWith('> _proposed because')) continue; // provenance
    // DRAFT list item
    const listItem = line.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
    if (listItem && listItem[1].trimStart().startsWith('DRAFT:')) continue;
    // Standard template description sentences are the ONLY non-list prose we
    // accept as "template". Any list item that is not a DRAFT, or any other
    // prose, is treated as human content by the list check above; here we only
    // need to ignore the known template descriptions, which are full sentences
    // ending in a period and contain no list bullet. We conservatively treat a
    // bulleted/numbered non-DRAFT item as human (already caught above), and
    // ignore plain descriptive paragraphs.
    if (!listItem) continue; // descriptive paragraph — template scaffolding
    // A non-DRAFT list item: human content.
    return true;
  }
  return false;
}

/**
 * Evaluate the constitution and return a soft nudge descriptor (FR-6).
 * Never throws — a missing/unreadable file yields `empty: true`.
 */
export function evaluateConstitution(rootDir: string): ConstitutionNudge {
  const constitutionPath = path.join(rootDir, '.minspec', 'constitution.md');
  let content = '';
  try {
    if (fs.existsSync(constitutionPath)) {
      content = fs.readFileSync(constitutionPath, 'utf-8');
    }
  } catch {
    content = '';
  }

  const empty = isAllTemplate(content);
  return {
    empty,
    message: ADVISORY_MESSAGE,
    fixHint: FIX_HINT,
    fixActionLabel: PROPOSE_ACTION_LABEL,
    fixCommandId: PROPOSE_COMMAND_ID,
  };
}
