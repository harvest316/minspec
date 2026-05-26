import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { initCommand, initRefreshCommand } from './commands/init';
import { classifyCommand } from './commands/classify';
import { statusCommand } from './commands/status';
import { declareScopeCommand } from './commands/session';
import { parkCommand } from './commands/park';
import { SpecTreeProvider } from './views/spec-tree-provider';
import { MinSpecStatusBar } from './views/status-bar';
import { SpecPanel } from './views/spec-panel';
import { loadConfig, applyVSCodeOverrides } from './lib/config';
import { loadSession, saveSession, addToScope, isFileInScope } from './lib/session';
import { detectTools, getToolFilePath, type DetectedTools } from './lib/tool-detector';
import { injectContextToFile, removeContextFromFile, type ActiveSpecContext } from './lib/context-injector';
import { parkTopic, createParkingLotEntry } from './lib/parking-lot';

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  // Active spec panel
  const specPanel = new SpecPanel(context.extensionUri);

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
    vscode.commands.registerCommand('minspec.declareScope', declareScopeCommand),
    vscode.commands.registerCommand('minspec.park', parkCommand),
    vscode.commands.registerCommand('minspec.injectContext', () => injectContextCommand(workspaceRoot)),
    vscode.commands.registerCommand('minspec.removeContext', () => removeContextCommand(workspaceRoot)),
    vscode.commands.registerCommand('minspec.showSpecPanel', async (specFilePath?: string) => {
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
        return;
      }
      if (!specFilePath) {
        specFilePath = await findActiveSpec(workspaceRoot);
        if (!specFilePath) {
          vscode.window.showInformationMessage(
            'MinSpec: No spec files found. Run "MinSpec: Initialize SDD Structure" first.',
          );
          return;
        }
      }
      specPanel.show(specFilePath);
    }),
    { dispose: () => specPanel.dispose() },
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
    specPanel.refresh();
  };

  watcher.onDidChange(onSpecsChanged);
  watcher.onDidCreate(onSpecsChanged);
  watcher.onDidDelete(onSpecsChanged);

  context.subscriptions.push(watcher);

  // Drift detection: monitor file saves
  if (workspaceRoot) {
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        handleFileSaveDriftCheck(doc, workspaceRoot);
      }),
    );
  }
}

/**
 * Command: Inject active spec context into detected AI tool config files.
 */
async function injectContextCommand(workspaceRoot: string): Promise<void> {
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }

  const specId = await vscode.window.showInputBox({
    prompt: 'Spec ID to inject (e.g., SPEC-001)',
    placeHolder: 'SPEC-001',
    ignoreFocusOut: true,
  });
  if (!specId) return;

  const title = await vscode.window.showInputBox({
    prompt: 'Spec title',
    placeHolder: 'Feature title',
    ignoreFocusOut: true,
  });
  if (!title) return;

  const activeContext: ActiveSpecContext = {
    specId,
    title,
    tier: 'T2',
    currentPhase: null,
    status: 'new',
  };

  const tools = detectTools(workspaceRoot);
  let injectedCount = 0;

  for (const [key, exists] of Object.entries(tools) as [keyof DetectedTools, boolean][]) {
    if (exists) {
      const filePath = getToolFilePath(workspaceRoot, key);
      injectContextToFile(filePath, activeContext);
      injectedCount++;
    }
  }

  if (injectedCount === 0) {
    vscode.window.showInformationMessage(
      'MinSpec: No AI tool config files detected. Create CLAUDE.md, .cursorrules, etc. first.',
    );
  } else {
    vscode.window.showInformationMessage(
      `MinSpec: Injected active spec context into ${injectedCount} file(s).`,
    );
  }
}

/**
 * Command: Remove active spec context from all AI tool config files.
 */
function removeContextCommand(workspaceRoot: string): void {
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }

  const tools = detectTools(workspaceRoot);
  let removedCount = 0;

  for (const [key, exists] of Object.entries(tools) as [keyof DetectedTools, boolean][]) {
    if (exists) {
      const filePath = getToolFilePath(workspaceRoot, key);
      removeContextFromFile(filePath);
      removedCount++;
    }
  }

  vscode.window.showInformationMessage(
    removedCount > 0
      ? `MinSpec: Removed active spec context from ${removedCount} file(s).`
      : 'MinSpec: No AI tool config files found.',
  );
}

/**
 * Check if a saved file is outside the current session scope and warn about drift.
 */
function handleFileSaveDriftCheck(
  doc: vscode.TextDocument,
  workspaceRoot: string,
): void {
  const session = loadSession(workspaceRoot);
  if (!session) return;

  if (!doc.uri.fsPath.startsWith(workspaceRoot)) return;

  const relativePath = path.relative(workspaceRoot, doc.uri.fsPath).replace(/\\/g, '/');
  if (relativePath.startsWith('.minspec/')) return;
  if (relativePath === 'package-lock.json' || relativePath.startsWith('node_modules/')) return;

  if (!isFileInScope(session, doc.uri.fsPath, workspaceRoot)) {
    showDriftWarning(doc.uri.fsPath, workspaceRoot, relativePath);
  }
}

/**
 * Show a drift warning with three action options.
 */
async function showDriftWarning(
  filePath: string,
  workspaceRoot: string,
  relativePath: string,
): Promise<void> {
  const session = loadSession(workspaceRoot);
  if (!session) return;

  const choice = await vscode.window.showWarningMessage(
    `MinSpec: "${relativePath}" is outside session scope. Potential drift from: "${session.scope}"`,
    'Park as Issue',
    'Add to Scope',
    'Dismiss',
  );

  if (choice === 'Park as Issue') {
    const entry = createParkingLotEntry(
      `Drift: work on ${relativePath}`,
      `File \`${relativePath}\` was modified outside the declared session scope.\n\nSession scope: ${session.scope}`,
      `${session.scope} (${session.project}, ${session.type})`,
      ['idea', 'inbox'],
    );

    const result = await parkTopic(workspaceRoot, entry);
    if (result.method === 'github') {
      vscode.window.showInformationMessage(`MinSpec: Created GitHub issue — ${result.url}`);
    } else {
      vscode.window.showInformationMessage(`MinSpec: Saved to ${result.filePath}`);
    }
  } else if (choice === 'Add to Scope') {
    const updatedSession = addToScope(session, filePath, workspaceRoot);
    saveSession(workspaceRoot, updatedSession);
    vscode.window.showInformationMessage(`MinSpec: Added "${relativePath}" to session scope.`);
  }
}

/**
 * Find the most likely active spec file in the workspace.
 * Prefers specs with implementing/specifying status.
 */
async function findActiveSpec(rootDir: string): Promise<string | null> {
  const config = loadConfig(rootDir);
  const vscodeConfig = vscode.workspace.getConfiguration('minspec');
  const finalConfig = applyVSCodeOverrides(config, {
    specsDir: vscodeConfig.get('specsDir'),
  });

  const specsDir = path.join(rootDir, finalConfig.specsDir);
  if (!fs.existsSync(specsDir)) return null;

  const specFiles: string[] = [];
  const walk = (dir: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.name.endsWith('.md')) {
          specFiles.push(fullPath);
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  };
  walk(specsDir);

  if (specFiles.length === 0) return null;

  const { parseSpec } = await import('./lib/spec');
  for (const filePath of specFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const spec = parseSpec(content);
      if (spec.frontmatter.status === 'implementing' || spec.frontmatter.status === 'specifying') {
        return filePath;
      }
    } catch {
      // Ignore unparseable files
    }
  }

  return specFiles[0];
}

export function deactivate(): void {}
