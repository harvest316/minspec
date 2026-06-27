import * as vscode from 'vscode';
import * as path from 'path';
import { listEpics, type EpicSummary } from '../lib/epic-manager';

/**
 * Unified, context-aware Approve/Accept (Alt+A) — issue #303.
 *
 * Three approve/accept commands already exist, one per approvable kind:
 *   - spec (requirements.md / spec.md) → `minspec.approveSpec`
 *   - decision (docs/decisions/DR-NNN.md) → `minspec.acceptAdr`
 *   - epic (docs/epics/EPIC-NNN.md) → `minspec.acceptEpic`
 *
 * The user shouldn't have to pick the right one. `minspec.approveActive`
 * resolves WHICH approvable is active — from a selected explorer tree node or
 * the focused editor — and dispatches to the matching existing command. When
 * nothing approvable is in focus it falls back to `minspec.approveSpec`, whose
 * QuickPick is the pending-approvables picker (issue #303: "reuse approveSpec's
 * picker"). It never re-implements any approve/accept logic — it only routes.
 *
 * This mirrors the signpost model: "the next approvable" is one concept; Alt+A
 * approves whatever it currently is.
 */

/** The kind of approvable an artifact path resolves to, or undefined. */
export type ApprovableKind = 'spec' | 'adr' | 'epic';

/** Command id each approvable kind dispatches to. */
export const APPROVE_COMMAND: Record<ApprovableKind, string> = {
  spec: 'minspec.approveSpec',
  adr: 'minspec.acceptAdr',
  epic: 'minspec.acceptEpic',
};

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

/**
 * Classify an explorer tree node by the artifact it carries. Spec nodes carry
 * `.spec`, decision nodes `.adr`, epic group nodes `.epic` — checked by
 * presence so a node from any of the three trees routes correctly without
 * importing the provider classes (which drags in their heavy import chains).
 */
export function classifyNode(node: unknown): ApprovableKind | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as { spec?: unknown; adr?: unknown; epic?: unknown };
  if (n.spec) return 'spec';
  if (n.adr) return 'adr';
  if (n.epic) return 'epic';
  return undefined;
}

/** The active editor's file path, or undefined when no editor is focused. */
function activeEditorPath(): string | undefined {
  return vscode.window.activeTextEditor?.document?.uri?.fsPath;
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Resolve the epic the active editor points at, so the unified command can hand
 * `acceptEpic` the `{ epic }` node it requires (unlike approveSpec/acceptAdr,
 * acceptEpic resolves its target ONLY from a passed node, not the editor).
 * Returns undefined when the active file is not a known epic.
 */
function activeEpic(): EpicSummary | undefined {
  const fsPath = activeEditorPath();
  if (!fsPath || classifyApprovablePath(fsPath) !== 'epic') return undefined;
  const root = getWorkspaceRoot();
  if (!root) return undefined;
  const epicsDir = vscode.workspace.getConfiguration('minspec').get<string>('epicsDir');
  const target = path.resolve(fsPath);
  return listEpics(root, epicsDir ? { epicsDir } : undefined).find(
    (e) => path.resolve(e.filePath) === target,
  );
}

/**
 * Dispatch to the existing approve/accept command for `kind`.
 *
 * - spec / adr: those commands already resolve their target from the active
 *   editor (and offer a QuickPick backstop), so we forward the node as-is and
 *   let them do the resolution they were built for.
 * - epic: acceptEpic needs a node carrying the epic summary. When invoked from a
 *   tree node we forward it; from the editor we synthesize `{ epic }` from the
 *   active file so the one-command path works without a tree selection.
 */
async function dispatch(kind: ApprovableKind, node: unknown): Promise<void> {
  if (kind === 'epic' && !classifyNode(node)) {
    const epic = activeEpic();
    if (!epic) {
      vscode.window.showErrorMessage(
        'MinSpec: The active editor is an epic, but it could not be matched to a known epic file.',
      );
      return;
    }
    await vscode.commands.executeCommand(APPROVE_COMMAND.epic, { epic });
    return;
  }
  await vscode.commands.executeCommand(APPROVE_COMMAND[kind], node);
}

/**
 * Command: approve/accept whatever approvable is active (Alt+A).
 *
 * Resolution order:
 *   1. A passed explorer tree node — the user selected that exact artifact.
 *   2. The focused editor (preview-aware paths are handled by the per-kind
 *      commands themselves once dispatched).
 *   3. Fallback — nothing approvable in focus → approveSpec, whose QuickPick is
 *      the pending-approvables picker (#303).
 */
export async function approveActiveCommand(node?: unknown): Promise<void> {
  const fromNode = classifyNode(node);
  if (fromNode) {
    await dispatch(fromNode, node);
    return;
  }

  const fromEditor = classifyApprovablePath(activeEditorPath());
  if (fromEditor) {
    await dispatch(fromEditor, undefined);
    return;
  }

  // Nothing approvable in focus → the spec approval QuickPick of pending specs.
  await vscode.commands.executeCommand(APPROVE_COMMAND.spec);
}
