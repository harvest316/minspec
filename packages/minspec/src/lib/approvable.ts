import * as path from 'path';

/**
 * Pure classification of "which approvable is this file?" — shared by the
 * unified Approve/Accept command (commands/approve-active.ts) and the
 * most-recently-viewed tracker (lib/recent-approvables.ts).
 *
 * Extracted into its own vscode-free module so both can depend on it without an
 * import cycle (approve-active ⇄ recent-approvables) and so the rules are
 * unit-testable in isolation. approve-active re-exports the symbols below to
 * keep its public surface (and existing test imports) stable.
 */

/** The kind of approvable an artifact path resolves to, or undefined. */
export type ApprovableKind = 'spec' | 'adr' | 'epic';

// Approvable artifacts are identified purely from the filename / containing
// folder — the same conventions the per-kind commands already rely on:
//   - decisions are DR-NNN(.*).md (adr-manager ADR_FILE_RE / active-adr).
//   - epics are EPIC-NNN(.*).md (epic-manager EPIC_FILE_RE).
//   - specs are the canonical requirements.md / spec.md inside a spec folder
//     (spec-tree-provider's CANONICAL_SPEC_NAMES preference order).
const ADR_FILE_RE = /^DR-\d+.*\.md$/i;
const EPIC_FILE_RE = /^EPIC-\d+.*\.md$/i;
const SPEC_FILE_NAMES = new Set(['requirements.md', 'spec.md']);

/**
 * Classify an artifact path into its approvable kind, or undefined when the
 * path is not an approvable artifact. Pure — no filesystem, no vscode state —
 * so the routing decision is unit-testable in isolation.
 *
 * Order matters only in that the three patterns are mutually exclusive: a
 * filename matches at most one of DR-*, EPIC-*, or the canonical spec names.
 */
export function classifyApprovablePath(fsPath: string | undefined): ApprovableKind | undefined {
  if (!fsPath) return undefined;
  const base = path.basename(fsPath);
  if (ADR_FILE_RE.test(base)) return 'adr';
  if (EPIC_FILE_RE.test(base)) return 'epic';
  if (SPEC_FILE_NAMES.has(base.toLowerCase())) return 'spec';
  return undefined;
}
