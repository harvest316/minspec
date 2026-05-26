import * as vscode from 'vscode';
import { createAdr } from '../lib/adr-manager';

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

  try {
    const adr = createAdr(
      folder,
      title.trim(),
      decisionsDir ? { decisionsDir } : undefined,
    );

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

  try {
    const adr = createAdr(
      folder,
      title.trim(),
      decisionsDir ? { decisionsDir } : undefined,
    );

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
