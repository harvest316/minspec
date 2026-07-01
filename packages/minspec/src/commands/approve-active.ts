import * as vscode from 'vscode';
import * as path from 'path';
import { listEpics, type EpicSummary } from '../lib/epic-manager';
import { listAdrs, type AdrSummary } from '../lib/adr-manager';
import { listSpecs, type SpecSummary } from '../views/spec-tree-provider';
import { classifyApprovablePath, type ApprovableKind } from '../lib/approvable';
import { recentApprovables } from '../lib/recent-approvables';
import { getApprovalStatus } from '../lib/approval';

/**
 * Unified, context-aware Approve/Accept (Alt+A) — issues #303, #377.
 *
 * Three approve/accept commands already exist, one per approvable kind:
 *   - spec (requirements.md / spec.md) → `minspec.approveSpec`
 *   - decision (docs/decisions/DR-NNN.md) → `minspec.acceptAdr`
 *   - epic (docs/epics/EPIC-NNN.md) → `minspec.acceptEpic`
 *
 * The user shouldn't have to pick the right one. `minspec.approveActive`
 * resolves WHICH approvable is active and dispatches to the matching existing
 * command. It never re-implements any approve/accept logic — it only routes.
 *
 * Resolution order:
 *   1. A passed explorer tree node — the user selected that exact artifact.
 *   2. The focused TEXT editor on an approvable file — resolve it to a concrete
 *      artifact node and dispatch directly. Symmetric across all three kinds, so
 *      a focused spec is approved in one keystroke exactly like a focused
 *      decision (the old asymmetry: spec fell through to a QuickPick, #377).
 *   3. A markdown PREVIEW (or any non-approvable focus) — a webview exposes no
 *      source URI, so the artifact behind it can't be read from the tab. Offer a
 *      most-recently-viewed picker across ALL approvable kinds (reverse-time);
 *      the just-previewed artifact is at the front (#377). This also makes Alt+A
 *      work in preview at all, paired with the `minspec.markdownPreviewActive`
 *      keybinding context set in extension.ts.
 *   4. Nothing viewed yet → `minspec.approveSpec`, whose QuickPick is the
 *      pending-approvables backstop (#303).
 *
 * This mirrors the signpost model: "the next approvable" is one concept; Alt+A
 * approves whatever it currently is.
 */

/** Re-exported so callers/tests have one import site for the classification. */
export { classifyApprovablePath, type ApprovableKind } from '../lib/approvable';

/** Command id each approvable kind dispatches to. */
export const APPROVE_COMMAND: Record<ApprovableKind, string> = {
  spec: 'minspec.approveSpec',
  adr: 'minspec.acceptAdr',
  epic: 'minspec.acceptEpic',
};

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

function decisionsDirOverride(): { decisionsDir: string } | undefined {
  const decisionsDir = vscode.workspace.getConfiguration('minspec').get<string>('decisionsDir');
  return decisionsDir ? { decisionsDir } : undefined;
}

function epicsDirOverride(): { epicsDir: string } | undefined {
  const epicsDir = vscode.workspace.getConfiguration('minspec').get<string>('epicsDir');
  return epicsDir ? { epicsDir } : undefined;
}

/** A tree node shaped exactly as each per-kind command's pick* step-1 expects. */
type ArtifactNode =
  | { readonly spec: SpecSummary }
  | { readonly adr: AdrSummary }
  | { readonly epic: EpicSummary };

/**
 * Resolve an approvable file path to the concrete artifact node its target
 * command consumes, or undefined when the path matches no known artifact.
 *
 * Building the node here (rather than forwarding `undefined` and letting the
 * target command re-resolve from the editor) is what makes the focused-editor
 * path act DIRECTLY for every kind — the target command's pick* step-1 honours a
 * passed node and skips its QuickPick. Match is by exact resolved path; specs
 * collapse multiple files to a canonical representative (requirements.md), so a
 * focused requirements.md / single spec.md matches, which is the common case.
 */
function resolveNode(kind: ApprovableKind, fsPath: string): ArtifactNode | undefined {
  const root = getWorkspaceRoot();
  if (!root) return undefined;
  const target = path.resolve(fsPath);

  if (kind === 'spec') {
    const spec = listSpecs(root).find((s) => path.resolve(s.filePath) === target);
    return spec ? { spec } : undefined;
  }
  if (kind === 'adr') {
    const adr = listAdrs(root, decisionsDirOverride()).find(
      (a) => path.resolve(a.filePath) === target,
    );
    return adr ? { adr } : undefined;
  }
  const epic = listEpics(root, epicsDirOverride()).find(
    (e) => path.resolve(e.filePath) === target,
  );
  return epic ? { epic } : undefined;
}

/**
 * The active tab's label if it is a markdown preview webview, else undefined.
 * Used as a defense-in-depth guard before auto-approving a lone recent artifact:
 * a webview exposes no source URI, but its label names the file, so a mismatch
 * tells us the preview is showing something OTHER than that artifact.
 */
function activeMarkdownPreviewLabel(): string | undefined {
  const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab as
    | { label?: string; input?: { viewType?: string } }
    | undefined;
  const viewType = tab?.input?.viewType;
  if (typeof viewType === 'string' && /markdown.*preview/i.test(viewType)) return tab?.label;
  return undefined;
}

/**
 * May we auto-approve `fsPath` as the lone recent without showing a picker?
 * Yes unless a markdown preview is active whose label clearly names a different
 * file — then the preview is showing something else and silently approving the
 * recent would approve the wrong artifact. (Same-basename collisions are an
 * accepted residual, as in active-spec/active-adr.)
 */
function previewAgreesWith(fsPath: string): boolean {
  const label = activeMarkdownPreviewLabel();
  if (label === undefined || label.length === 0) return true;
  return label.includes(path.basename(fsPath));
}

/**
 * Is this resolved artifact still PENDING (worth offering for approval)? Mirrors
 * each per-kind command's own picker filter so the cross-kind MRU list excludes
 * what those pickers would: an already-approved spec, an already-accepted
 * decision, an epic that is no longer `proposed`. (The per-kind filters are
 * bypassed here because we dispatch a resolved node, so we re-apply them.)
 */
function isPending(kind: ApprovableKind, node: ArtifactNode, root: string): boolean {
  if (kind === 'spec') {
    const s = (node as { spec: SpecSummary }).spec;
    return getApprovalStatus(root, s.filePath) !== 'approved'; // unapproved | stale
  }
  if (kind === 'adr') {
    return (node as { adr: AdrSummary }).adr.status !== 'accepted';
  }
  return (node as { epic: EpicSummary }).epic.status === 'proposed';
}

/** Human label + sublabel for a resolved artifact node, for the MRU picker. */
function describeNode(kind: ApprovableKind, node: ArtifactNode, root: string): { label: string; description: string } {
  if (kind === 'spec') {
    const s = (node as { spec: SpecSummary }).spec;
    return { label: `${s.id}: ${s.title}`, description: `Spec · ${s.tier} · ${getApprovalStatus(root, s.filePath)}` };
  }
  if (kind === 'adr') {
    const a = (node as { adr: AdrSummary }).adr;
    return { label: `${a.id}: ${a.title}`, description: `Decision · ${a.status}` };
  }
  const e = (node as { epic: EpicSummary }).epic;
  return { label: `${e.id}: ${e.title}`, description: `Epic · ${e.status}` };
}

type RecentTarget = { kind: ApprovableKind; node: ArtifactNode };

/**
 * Choose from the most-recently-viewed approvables, reverse-chronological.
 * Already-approved/accepted artifacts and entries that no longer resolve to a
 * known artifact (deleted/renamed since viewed) are dropped.
 *
 * Outcome tells the caller how to route:
 *   - `none`      — nothing pending to offer → fall back to the #303 spec backstop.
 *   - `picked`    — `target` chosen (auto, or via the QuickPick) → dispatch it.
 *   - `dismissed` — a picker was shown and the user cancelled → do nothing.
 *
 * With exactly one pending artifact we auto-approve it (no picker), UNLESS a
 * markdown preview is showing a different file — then we still show the picker so
 * we never silently approve something other than what's on screen (never-wrong).
 */
async function pickRecentApprovable(): Promise<{ outcome: 'none' | 'picked' | 'dismissed'; target?: RecentTarget }> {
  const root = getWorkspaceRoot();
  if (!root) return { outcome: 'none' };

  // `target` is a nested property (not spread) so it never collides with
  // QuickPickItem's own `kind` (QuickPickItemKind).
  type Item = vscode.QuickPickItem & { target: RecentTarget; fsPath: string };
  const items: Item[] = recentApprovables()
    .map((r): Item | undefined => {
      const node = resolveNode(r.kind, r.fsPath);
      if (!node || !isPending(r.kind, node, root)) return undefined;
      return { ...describeNode(r.kind, node, root), target: { kind: r.kind, node }, fsPath: r.fsPath };
    })
    .filter((x): x is Item => x !== undefined);

  if (items.length === 0) return { outcome: 'none' };

  if (items.length === 1 && previewAgreesWith(items[0].fsPath)) {
    return { outcome: 'picked', target: items[0].target };
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Approve / accept — most recently viewed first',
    ignoreFocusOut: true,
  });
  return picked ? { outcome: 'picked', target: picked.target } : { outcome: 'dismissed' };
}

/** Dispatch to the existing approve/accept command for `kind`, forwarding the node. */
async function dispatch(kind: ApprovableKind, node: unknown): Promise<void> {
  await vscode.commands.executeCommand(APPROVE_COMMAND[kind], node);
}

/**
 * Command: approve/accept whatever approvable is active (Alt+A). See the
 * module header for the full resolution order.
 */
export async function approveActiveCommand(node?: unknown): Promise<void> {
  // 1. Explicit tree node — the user picked that exact artifact.
  const fromNode = classifyNode(node);
  if (fromNode) {
    await dispatch(fromNode, node);
    return;
  }

  // 2. A focused text editor on an approvable file — act on it directly.
  const editorPath = activeEditorPath();
  const fromEditor = classifyApprovablePath(editorPath);
  if (fromEditor && editorPath) {
    const resolved = resolveNode(fromEditor, editorPath);
    if (resolved) {
      await dispatch(fromEditor, resolved);
    } else {
      // The file looks like an approvable but matches no known artifact (e.g.
      // outside the configured specs/decisions/epics dir). Surface it rather
      // than silently routing elsewhere.
      vscode.window.showErrorMessage(
        `MinSpec: The active editor looks like a ${fromEditor}, but it could not be matched to a known ${fromEditor}.`,
      );
    }
    return;
  }

  // 3. Markdown preview, or a non-approvable focus — the previewed source URI is
  //    unrecoverable, so offer the most-recently-viewed approvables. A lone
  //    pending artifact is approved directly; otherwise a picker is shown and,
  //    once shown, owns the interaction (a dismissal cancels — no surprise backstop).
  const recent = await pickRecentApprovable();
  if (recent.outcome === 'picked' && recent.target) {
    await dispatch(recent.target.kind, recent.target.node);
    return;
  }
  if (recent.outcome === 'dismissed') return;

  // 4. Nothing pending in the view history → the spec approval QuickPick (#303).
  await vscode.commands.executeCommand(APPROVE_COMMAND.spec);
}
