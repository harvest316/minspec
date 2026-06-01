import * as vscode from 'vscode';
import * as path from 'path';
import {
  createAdr,
  findSimilarAdrs,
  regenerateDrIndex,
  setAdrStatus,
  listAdrs,
  ADR_STATUS_VALUES,
  type AdrStatus,
} from '../lib/adr-manager';
import type { AdrNode } from '../views/adr-tree-provider';

/**
 * Dedup gate shared by both create paths. If an existing in-force ADR has a
 * near-duplicate title, prompt the user. On "Open existing" the existing file
 * is opened and 'cancel' is returned (no new ADR). Returns 'proceed' only when
 * there is no near-duplicate or the user explicitly chose "Create anyway".
 */
async function confirmNoDuplicate(
  folder: string,
  title: string,
  overrides: { decisionsDir: string } | undefined,
): Promise<'proceed' | 'cancel'> {
  const similar = findSimilarAdrs(folder, title, overrides);
  if (similar.length === 0) return 'proceed';

  const top = similar[0].adr;
  const more = similar.length > 1 ? ` (+${similar.length - 1} more)` : '';
  const OPEN = 'Open existing';
  const CREATE = 'Create anyway';
  const choice = await vscode.window.showWarningMessage(
    `MinSpec: A similar decision already exists — ${top.id}: ${top.title}${more}. Create a new ADR anyway, or open the existing one?`,
    { modal: true },
    OPEN,
    CREATE,
  );
  if (choice === OPEN) {
    const doc = await vscode.workspace.openTextDocument(top.filePath);
    await vscode.window.showTextDocument(doc);
    return 'cancel';
  }
  return choice === CREATE ? 'proceed' : 'cancel';
}

/**
 * Command: Create a new Architecture Decision Record.
 * Prompts for title, creates DR-NNN.md with sequential numbering,
 * and opens the file for editing.
 */
export async function createAdrCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }

  // Prompt for title
  const title = await vscode.window.showInputBox({
    prompt: 'Title for the Architecture Decision Record',
    placeHolder: 'e.g., Use PostgreSQL for persistence',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return 'Title is required';
      }
      if (value.trim().length > 120) {
        return 'Title must be 120 characters or fewer';
      }
      return null;
    },
  });

  if (!title) return; // Cancelled

  const decisionsDir = vscode.workspace
    .getConfiguration('minspec')
    .get<string>('decisionsDir');
  const overrides = decisionsDir ? { decisionsDir } : undefined;

  // Dedup gate: warn if an existing, in-force ADR covers the same decision.
  const gate = await confirmNoDuplicate(folder, title.trim(), overrides);
  if (gate === 'cancel') return;

  try {
    const adr = createAdr(folder, title.trim(), overrides);

    // Open the new file
    const doc = await vscode.workspace.openTextDocument(adr.filePath);
    await vscode.window.showTextDocument(doc);

    vscode.window.showInformationMessage(
      `MinSpec: Created ${adr.id} — ${adr.title}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`MinSpec: Failed to create ADR — ${message}`);
  }
}

const STATUS_LABELS: Record<AdrStatus, string> = {
  proposed: '$(circle-outline) Proposed',
  accepted: '$(check) Accepted',
  deprecated: '$(circle-slash) Deprecated',
  superseded: '$(arrow-swap) Superseded',
};

/**
 * Resolve the target ADR for a status command.
 *
 * Tree-view invocations (inline ✓ / right-click) pass an `AdrNode` carrying the
 * decision. Command-palette invocations pass nothing — so fall back to the ADR
 * file open in the active editor, matched against the known decisions by path.
 * Returns undefined (after surfacing an error) when neither yields a decision.
 */
function resolveAdr(
  node: AdrNode | undefined,
): { filePath: string; status: AdrStatus; id: string } | undefined {
  // 1. Tree node — carries its own state, no filesystem read needed.
  const fromNode = node?.adr;
  if (fromNode?.filePath) {
    return { filePath: fromNode.filePath, status: fromNode.status, id: fromNode.id };
  }

  // 2. Command palette — fall back to the ADR open in the active editor.
  const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (activePath && folder) {
    const decisionsDir = vscode.workspace
      .getConfiguration('minspec')
      .get<string>('decisionsDir');
    const overrides = decisionsDir ? { decisionsDir } : undefined;
    const target = path.resolve(activePath);
    const match = listAdrs(folder, overrides).find(
      a => path.resolve(a.filePath) === target,
    );
    if (match) {
      return { filePath: match.filePath, status: match.status, id: match.id };
    }
  }

  vscode.window.showErrorMessage(
    'MinSpec: No decision selected. Open a decision file or pick one in the Decisions view.',
  );
  return undefined;
}

/** Write the new status, regenerate the index, surface result. */
async function applyStatus(
  filePath: string,
  id: string,
  status: AdrStatus,
): Promise<void> {
  try {
    setAdrStatus(filePath, status);

    // Keep the Decision Register index in sync with the new status.
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) {
      const decisionsDir = vscode.workspace
        .getConfiguration('minspec')
        .get<string>('decisionsDir');
      try {
        regenerateDrIndex(folder, decisionsDir ? { decisionsDir } : undefined);
      } catch {
        // Index regen is best-effort; status write already succeeded.
      }
    }

    vscode.window.showInformationMessage(`MinSpec: ${id} → ${status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`MinSpec: Failed to set status — ${message}`);
  }
}

/**
 * Command: Accept a proposed ADR (inline ✓ on hover). Flips status to
 * `accepted` in one click. No-op confirmation if already accepted.
 */
export async function acceptAdrCommand(node?: AdrNode): Promise<void> {
  const resolved = resolveAdr(node);
  if (!resolved) return;
  if (resolved.status === 'accepted') {
    vscode.window.showInformationMessage(`MinSpec: ${resolved.id} already accepted.`);
    return;
  }
  await applyStatus(resolved.filePath, resolved.id, 'accepted');
}

/**
 * Command: Set an ADR's status via a quick pick of all lifecycle states.
 * Right-click → Set Status. Current status marked.
 */
export async function setAdrStatusCommand(node?: AdrNode): Promise<void> {
  const resolved = resolveAdr(node);
  if (!resolved) return;

  const items: (vscode.QuickPickItem & { value: AdrStatus })[] =
    ADR_STATUS_VALUES.map(status => ({
      label: STATUS_LABELS[status],
      description: status === resolved.status ? 'current' : undefined,
      value: status,
    }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Set status for ${resolved.id} (currently ${resolved.status})`,
    ignoreFocusOut: true,
  });
  if (!picked || picked.value === resolved.status) return;

  await applyStatus(resolved.filePath, resolved.id, picked.value);
}

/**
 * Command: Regenerate the Decision Register INDEX.md with a detailed entry
 * (header + clickable title + 40–80 word summary) per DR file. Preserves
 * any user-authored content outside the auto-managed markers.
 */
export async function regenerateDrIndexCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }

  const decisionsDir = vscode.workspace
    .getConfiguration('minspec')
    .get<string>('decisionsDir');

  try {
    const result = regenerateDrIndex(
      folder,
      decisionsDir ? { decisionsDir } : undefined,
    );

    const doc = await vscode.workspace.openTextDocument(result.filePath);
    await vscode.window.showTextDocument(doc);

    vscode.window.showInformationMessage(
      `MinSpec: Regenerated DR INDEX (${result.count} decision${result.count === 1 ? '' : 's'}).`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`MinSpec: Failed to regenerate DR INDEX — ${message}`);
  }
}

/**
 * Auto-prompt for ADR creation after T4 classification.
 * Called from the classification flow when a task is classified as T4.
 * Returns true if the user chose to create an ADR.
 */
export async function promptAdrOnT4Classification(taskTitle?: string): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    'MinSpec: T4 classification detected. Architecture decisions should be recorded. Create an ADR?',
    'Create ADR',
    'Skip',
  );

  if (choice !== 'Create ADR') return false;

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return false;
  }

  // Pre-fill title from task if available
  const title = await vscode.window.showInputBox({
    prompt: 'Title for the Architecture Decision Record',
    placeHolder: 'e.g., Use PostgreSQL for persistence',
    value: taskTitle ? `Decision for: ${taskTitle}` : '',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return 'Title is required';
      }
      return null;
    },
  });

  if (!title) return false;

  const decisionsDir = vscode.workspace
    .getConfiguration('minspec')
    .get<string>('decisionsDir');
  const overrides = decisionsDir ? { decisionsDir } : undefined;

  // Dedup gate: warn if an existing, in-force ADR covers the same decision.
  const gate = await confirmNoDuplicate(folder, title.trim(), overrides);
  if (gate === 'cancel') return false;

  try {
    const adr = createAdr(folder, title.trim(), overrides);

    const doc = await vscode.workspace.openTextDocument(adr.filePath);
    await vscode.window.showTextDocument(doc);

    vscode.window.showInformationMessage(
      `MinSpec: Created ${adr.id} — ${adr.title}`,
    );
    return true;
  } catch {
    vscode.window.showErrorMessage('MinSpec: Failed to create ADR.');
    return false;
  }
}
