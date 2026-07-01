/**
 * `minspec.nextTask` — the signpost command (SPEC-012 / DR-019).
 *
 * Computes the single next HUMAN review task by feeding the real workspace
 * through the Tier-0 resolver (`resolveNextTask` from `@aiclarity/shared`),
 * reveals the target artifact, and surfaces the imperative as a NON-MODAL toast
 * over the visible artifact (HITL UX rule). When the queue is clear it says so
 * cheerfully; it NEVER crashes the thread — a missing workspace, an empty repo,
 * or a graph-build failure all degrade to the friendly "clear" message
 * (INV-DEGRADE).
 */

import * as vscode from 'vscode';
import { resolveNextTask, type NextTask } from '@aiclarity/shared';
import { buildArtifactGraph, artifactFileIndex } from '../lib/artifact-graph';

const CLEAR_MESSAGE = "MinSpec: nothing to review — you're clear. ✓";

/**
 * Compute the next task for a workspace, or null. Pure-ish wrapper: degrades a
 * build/resolve failure to `null` (treated as "clear") rather than throwing, so
 * every caller (command + status bar) shares one fail-safe path.
 */
export function computeNextTask(workspaceRoot: string): NextTask | null {
  try {
    return resolveNextTask(buildArtifactGraph(workspaceRoot));
  } catch {
    return null;
  }
}

/**
 * Build the `minspec.nextTask` handler bound to a workspace root.
 */
export function nextTaskCommand(workspaceRoot: string): () => Promise<void> {
  return async (): Promise<void> => {
    if (!workspaceRoot) {
      vscode.window.showInformationMessage('MinSpec: No workspace folder open.');
      return;
    }

    let task: NextTask | null;
    try {
      task = resolveNextTask(buildArtifactGraph(workspaceRoot));
    } catch {
      // Degrade: a malformed/partial workspace must never crash the signpost.
      vscode.window.showInformationMessage(CLEAR_MESSAGE);
      return;
    }

    if (task === null) {
      vscode.window.showInformationMessage(CLEAR_MESSAGE);
      return;
    }

    // Reveal the target artifact so the toast lands over the thing to act on.
    // A corruption node may point at a dangling id with no file — skip the open
    // in that case (still show the imperative; never throw).
    let filePath: string | undefined;
    try {
      filePath = artifactFileIndex(workspaceRoot).get(task.targetId);
    } catch {
      filePath = undefined;
    }
    if (filePath) {
      try {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        // Opening failed — still surface the imperative below.
      }
    }

    vscode.window.showInformationMessage(`MinSpec: ${task.imperative}`);
  };
}
