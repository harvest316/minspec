import * as fs from 'fs';
import * as path from 'path';
import type { Tier, Phase } from './config';
import type { SpecStatus } from './spec';

/** Context about the currently active spec, injected into AI tool config files */
export interface ActiveSpecContext {
  readonly specId: string;
  readonly title: string;
  readonly tier: Tier;
  readonly currentPhase: Phase | null;
  readonly status: SpecStatus;
  readonly fileAllowlist?: string[];
}

/** Marker comments for the injected block */
const BLOCK_START = '<!-- minspec:active-spec:start -->';
const BLOCK_END = '<!-- minspec:active-spec:end -->';

/**
 * Build the markdown block to inject between markers.
 * Contains spec metadata useful for AI tool context.
 */
export function buildContextBlock(context: ActiveSpecContext): string {
  const lines: string[] = [];
  lines.push(BLOCK_START);
  lines.push('');
  lines.push('## Active Spec');
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| ID | ${context.specId} |`);
  lines.push(`| Title | ${context.title} |`);
  lines.push(`| Tier | ${context.tier} |`);
  lines.push(`| Status | ${context.status} |`);
  if (context.currentPhase) {
    lines.push(`| Current Phase | ${context.currentPhase} |`);
  }
  lines.push('');
  if (context.fileAllowlist && context.fileAllowlist.length > 0) {
    lines.push('**File allowlist:**');
    for (const f of context.fileAllowlist) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }
  lines.push(BLOCK_END);
  return lines.join('\n');
}

/**
 * Inject or update the active-spec block in a file's content.
 * If a block already exists between markers, it is replaced.
 * If no block exists, it is appended at the end.
 * User content outside the markers is never touched.
 */
export function injectContext(fileContent: string, context: ActiveSpecContext): string {
  const block = buildContextBlock(context);
  const startIdx = fileContent.indexOf(BLOCK_START);
  const endIdx = fileContent.indexOf(BLOCK_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing block
    const before = fileContent.slice(0, startIdx);
    const after = fileContent.slice(endIdx + BLOCK_END.length);
    return before + block + after;
  }

  // Append to end — ensure there's a blank line separator
  const trimmed = fileContent.trimEnd();
  if (trimmed.length === 0) {
    return block + '\n';
  }
  return trimmed + '\n\n' + block + '\n';
}

/**
 * Remove the active-spec block from file content.
 * Returns the content without the block (and surrounding blank lines cleaned up).
 */
export function removeContext(fileContent: string): string {
  const startIdx = fileContent.indexOf(BLOCK_START);
  const endIdx = fileContent.indexOf(BLOCK_END);

  if (startIdx === -1 || endIdx === -1) {
    return fileContent;
  }

  const before = fileContent.slice(0, startIdx);
  const after = fileContent.slice(endIdx + BLOCK_END.length);

  // Clean up extra blank lines at the join point
  const cleanBefore = before.replace(/\n{2,}$/, '\n');
  const cleanAfter = after.replace(/^\n{2,}/, '\n');

  const result = cleanBefore + cleanAfter;
  return result.trim().length === 0 ? '' : result;
}

/**
 * Inject context into a specific file on disk.
 * Creates the file if it does not exist.
 */
export function injectContextToFile(filePath: string, context: ActiveSpecContext): void {
  let existing = '';
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf-8');
  }
  const updated = injectContext(existing, context);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, updated, 'utf-8');
}

/**
 * Remove context from a specific file on disk.
 * No-op if the file doesn't exist.
 */
export function removeContextFromFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const existing = fs.readFileSync(filePath, 'utf-8');
  const updated = removeContext(existing);
  if (updated.trim().length === 0) {
    // Don't delete the file — just leave it empty-ish with a newline
    // Actually, if we created nothing, we shouldn't delete user's file
    fs.writeFileSync(filePath, updated || '', 'utf-8');
  } else {
    fs.writeFileSync(filePath, updated, 'utf-8');
  }
}
