import * as vscode from 'vscode';
import { listSpecs, type SpecSummary } from '../views/spec-tree-provider';
import { readSpecFile, advanceSpecToImplementing } from '../lib/spec';
import { loadConfig } from '../lib/config';
import { validateSpec } from '../lib/spec-validator';
import { epicRefSet } from '../lib/epic-manager';
import {
  approveSpec as recordApproval,
  revokeApproval as removeApproval,
  getApprovalStatus,
  type ApprovalStatus,
} from '../lib/approval';
import { resolveActiveSpecId } from '../lib/active-spec';

/** A tree node carrying a SpecSummary (from the spec tree context menu). */
interface SpecNodeLike {
  readonly spec?: SpecSummary;
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}


interface PickOptions {
  /** Keep a spec in the list only when its approval status passes this. */
  include: (status: ApprovalStatus) => boolean;
  /** Shown when specs exist but none survive the `include` filter. */
  emptyMessage: string;
}

/**
 * Resolve which spec to act on: from a tree node, else a quick-pick.
 *
 * The quick-pick is filtered by approval status so each command only offers
 * specs the action makes sense for — Approve hides already-approved specs,
 * Revoke hides unapproved ones. A tree-node invocation bypasses the filter: the
 * user picked that exact spec from the tree, so honour it.
 */
async function pickSpec(
  rootDir: string,
  node: SpecNodeLike | undefined,
  placeholder: string,
  opts: PickOptions,
): Promise<SpecSummary | undefined> {
  if (node?.spec) return node.spec;

  const specs = listSpecs(rootDir);
  if (specs.length === 0) {
    vscode.window.showInformationMessage('MinSpec: No specs found.');
    return undefined;
  }
  const openId = resolveActiveSpecId();
  const items = specs
    .map((s) => ({ spec: s, status: getApprovalStatus(rootDir, s.id, s.filePath) }))
    .filter((x) => opts.include(x.status))
    .map(({ spec, status }) => ({
      label: `${spec.id}: ${spec.title}`,
      description: `${spec.tier} · ${status}${spec.id === openId ? ' · open' : ''}`,
      spec,
    }));
  if (items.length === 0) {
    vscode.window.showInformationMessage(opts.emptyMessage);
    return undefined;
  }
  // Float the currently-open spec to the top so it is the default selection
  // (showQuickPick highlights the first item; Enter picks it).
  const openIdx = items.findIndex((i) => i.spec.id === openId);
  if (openIdx > 0) items.unshift(items.splice(openIdx, 1)[0]);

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: placeholder,
    ignoreFocusOut: true,
  });
  return picked?.spec;
}

/**
 * Command: Approve a spec for implementation.
 * Runs the completeness validator first — refuses approval if it has errors.
 */
export async function approveSpecCommand(node?: SpecNodeLike): Promise<void> {
  const rootDir = getWorkspaceRoot();
  if (!rootDir) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }

  const spec = await pickSpec(rootDir, node, 'Select a spec to approve for implementation', {
    // Already-approved specs have nothing to do here; stale ones (edited since
    // approval) still need re-approval, so keep them.
    include: (status) => status !== 'approved',
    emptyMessage: 'MinSpec: No specs awaiting approval — all are already approved.',
  });
  if (!spec) return;

  let parsed;
  try {
    parsed = readSpecFile(spec.filePath);
  } catch (err) {
    vscode.window.showErrorMessage(
      `MinSpec: Cannot read ${spec.id} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const config = loadConfig(rootDir);
  const result = validateSpec(parsed, config, epicRefSet(rootDir));
  const errors = result.violations.filter((v) => v.severity === 'error');
  const warnings = result.violations.filter((v) => v.severity === 'warning');

  if (!result.complete) {
    // Refuse. Surface the blocking violations and offer to open the spec.
    const summary = errors.map((e) => `• ${e.message}`).join('\n');
    const choice = await vscode.window.showErrorMessage(
      `MinSpec: ${spec.id} is not complete — approval refused.\n\n${summary}`,
      { modal: true, detail: errors.map((e) => `${e.message}\n   ↳ ${e.fixHint}`).join('\n\n') },
      'Open Spec',
    );
    if (choice === 'Open Spec') {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(spec.filePath));
      await vscode.window.showTextDocument(doc);
    }
    return;
  }

  // Complete (possibly with warnings) — confirm, noting any warnings.
  let confirmDetail = `Approving binds ${spec.id} to its current content. Editing the spec afterward will revoke approval automatically.`;
  if (warnings.length > 0) {
    confirmDetail += `\n\nNon-blocking warnings:\n${warnings.map((w) => `• ${w.message}`).join('\n')}`;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Approve ${spec.id} (${spec.tier}) for implementation?`,
    { modal: true, detail: confirmDetail },
    'Approve',
  );
  if (confirm !== 'Approve') return;

  try {
    // Flip the lifecycle status to `implementing` BEFORE recording the hash.
    // Approval binds the spec's bytes; the status write changes them, so it must
    // happen first — otherwise the hash is recorded over pre-flip bytes and the
    // just-approved spec is instantly stale (flip-then-hash; DR-003 RCDD). Guard:
    // only advance from a pre-implementation status — never downgrade done/archived
    // or re-flip an already-implementing spec being re-approved after an edit.
    // advanceSpecToImplementing also advances the `phases:` map (when present) so
    // the status line and the phases-derived status cannot diverge (#148).
    const wasPreImpl =
      parsed.frontmatter.status === 'new' || parsed.frontmatter.status === 'specifying';
    if (wasPreImpl) {
      advanceSpecToImplementing(spec.filePath);
    }
    recordApproval(rootDir, spec.id, spec.filePath, spec.tier);
    vscode.window.showInformationMessage(
      wasPreImpl
        ? `MinSpec: ✓ Approved ${spec.id} for implementation (status → implementing).`
        : `MinSpec: ✓ Approved ${spec.id} for implementation.`,
    );
    await vscode.commands.executeCommand('minspec.refreshTree');
  } catch (err) {
    vscode.window.showErrorMessage(
      `MinSpec: Failed to approve — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Command: Revoke a spec's approval. */
export async function revokeApprovalCommand(node?: SpecNodeLike): Promise<void> {
  const rootDir = getWorkspaceRoot();
  if (!rootDir) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }

  const spec = await pickSpec(rootDir, node, 'Select a spec to revoke approval', {
    // Only specs with an approval record (approved or stale) can be revoked.
    include: (status) => status !== 'unapproved',
    emptyMessage: 'MinSpec: No approved specs to revoke.',
  });
  if (!spec) return;

  const removed = removeApproval(rootDir, spec.id);
  vscode.window.showInformationMessage(
    removed
      ? `MinSpec: Revoked approval for ${spec.id}.`
      : `MinSpec: ${spec.id} was not approved.`,
  );
  await vscode.commands.executeCommand('minspec.refreshTree');
}
