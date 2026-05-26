import * as vscode from 'vscode';
import { scaffold, generateHarnessFiles, refreshHarnessFiles } from '../lib/scaffold';

export async function initCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }
  scaffold(folder);
  generateHarnessFiles(folder);
  vscode.window.showInformationMessage(
    'MinSpec: Initialized .minspec/ and generated harness files.',
  );
}

export async function initRefreshCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }
  refreshHarnessFiles(folder);
  vscode.window.showInformationMessage(
    'MinSpec: Refreshed harness files (user edits preserved).',
  );
}
