import * as vscode from 'vscode';
import {
  loadSession,
  saveSession,
  clearSession,
  createSession,
  type SessionType,
} from '../lib/session';

const SESSION_TYPES: SessionType[] = ['bug', 'feat', 'explore', 'plan'];

/**
 * Prompt the user to declare a session scope.
 * Called on first spec command if no active session, or via explicit command.
 */
export async function declareScopeCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }

  // Check for existing session
  const existing = loadSession(folder);
  if (existing) {
    const action = await vscode.window.showQuickPick(
      ['Keep current session', 'Start new session', 'End session'],
      { placeHolder: `Active session: "${existing.scope}" — What do you want to do?` },
    );
    if (!action || action === 'Keep current session') {
      return;
    }
    if (action === 'End session') {
      clearSession(folder);
      vscode.window.showInformationMessage('MinSpec: Session ended.');
      return;
    }
    // Fall through to create new session
  }

  // Step 1: Scope
  const scope = await vscode.window.showInputBox({
    prompt: 'Session scope (one sentence describing what you are working on)',
    placeHolder: 'e.g., Implement user authentication flow',
    ignoreFocusOut: true,
  });
  if (!scope) return; // Cancelled

  // Step 2: Project name
  const project = await vscode.window.showInputBox({
    prompt: 'Project name',
    placeHolder: 'e.g., minspec',
    ignoreFocusOut: true,
  });
  if (!project) return; // Cancelled

  // Step 3: Session type
  const sessionType = await vscode.window.showQuickPick(SESSION_TYPES, {
    placeHolder: 'Session type',
  });
  if (!sessionType) return; // Cancelled

  const session = createSession(scope, project, sessionType as SessionType);
  saveSession(folder, session);

  vscode.window.showInformationMessage(
    `MinSpec: Session started — "${scope}" (${sessionType})`,
  );
}

/**
 * Ensure a session is active. If not, prompt the user to declare scope.
 * Returns true if a session is active after the check.
 * Used by other commands as a gate.
 */
export async function ensureSession(folder: string): Promise<boolean> {
  const existing = loadSession(folder);
  if (existing) return true;

  const shouldDeclare = await vscode.window.showInformationMessage(
    'MinSpec: No active session. Declare scope before proceeding?',
    'Declare Scope',
    'Skip',
  );

  if (shouldDeclare === 'Declare Scope') {
    await declareScopeCommand();
    return loadSession(folder) !== null;
  }

  return false;
}
