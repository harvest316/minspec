import * as path from 'path';
import { classifyApprovablePath, type ApprovableKind } from './approvable';

// ─── Most-recently-viewed approvables (in-memory, session-scoped) ─────────────
//
// "What has the user looked at lately, and in what order?" — used by the unified
// Approve/Accept command (Alt+A) when the active artifact can't be resolved
// directly. The motivating case is a markdown preview: a webview tab exposes
// only a `viewType` and `label`, never the previewed file's source URI, so the
// artifact behind the preview cannot be recovered from the tab itself.
//
// The trick: Ctrl-Shift-V previews the *active* editor, so that editor was
// active — and recorded here via onDidChangeActiveTextEditor — an instant before
// the swap. The previewed artifact is therefore the FRONT of this list, and a
// reverse-chronological picker floats it to the top (Enter approves it) without
// the command ever having to guess which file the webview is showing.
//
// The list is move-to-front (most recent first) and deduped by resolved path, so
// "reverse timestamp order" needs no clock — re-viewing an artifact promotes it.
// In-memory only: "recently viewed" is a property of this session, not a fact to
// persist. vscode-free so the store is unit-testable without a vscode mock; the
// onDidChangeActiveTextEditor wiring lives in extension.ts.

export interface RecentApprovable {
  readonly fsPath: string;
  readonly kind: ApprovableKind;
}

/** Bound the history so a long session can't grow it without limit. */
const MAX_RECENTS = 50;

let recents: RecentApprovable[] = [];

/**
 * Record that the user viewed `fsPath`. No-op when the path is not an approvable
 * artifact (so focusing source files, plans, READMEs, etc. never pollutes the
 * list). Moves an already-seen artifact to the front rather than duplicating it.
 */
export function recordApprovableView(fsPath: string | undefined): void {
  const kind = classifyApprovablePath(fsPath);
  if (!kind || !fsPath) return;
  const resolved = path.resolve(fsPath);
  recents = recents.filter((r) => path.resolve(r.fsPath) !== resolved);
  recents.unshift({ fsPath, kind });
  if (recents.length > MAX_RECENTS) recents = recents.slice(0, MAX_RECENTS);
}

/** The viewed approvables, most-recent first. A copy — callers can't mutate. */
export function recentApprovables(): RecentApprovable[] {
  return recents.slice();
}

/** Clear the history. For test isolation and extension teardown. */
export function resetRecentApprovables(): void {
  recents = [];
}
