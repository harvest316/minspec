import * as vscode from 'vscode';
import { initCommand, initRefreshCommand } from './commands/init';
import { classifyCommand } from './commands/classify';
import { statusCommand } from './commands/status';
import { SpecTreeProvider } from './views/spec-tree-provider';
import { MinSpecStatusBar } from './views/status-bar';

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  // Sidebar tree view
  const specTreeProvider = new SpecTreeProvider(workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('minspecStatus', specTreeProvider),
  );

  // Status bar
  const statusBar = new MinSpecStatusBar();
  statusBar.update(null);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('minspec.init', initCommand),
    vscode.commands.registerCommand('minspec.initRefresh', initRefreshCommand),
    vscode.commands.registerCommand('minspec.classify', classifyCommand),
    vscode.commands.registerCommand('minspec.status', statusCommand),
    vscode.commands.registerCommand('minspec.refreshTree', () => specTreeProvider.refresh()),
    statusBar,
  );

  // Watch spec files — refresh tree + status bar on changes
  const specsDir = vscode.workspace.getConfiguration('minspec').get<string>('specsDir', 'specs');
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.workspace.workspaceFolders?.[0] ?? '',
      `${specsDir}/**/*.md`,
    ),
  );

  const onSpecsChanged = () => {
    specTreeProvider.refresh();
  };

  watcher.onDidChange(onSpecsChanged);
  watcher.onDidCreate(onSpecsChanged);
  watcher.onDidDelete(onSpecsChanged);

  context.subscriptions.push(watcher);
}

export function deactivate(): void {}
