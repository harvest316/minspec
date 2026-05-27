import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { initCommand, initRefreshCommand } from './commands/init';
import { classifyCommand } from './commands/classify';
import { statusCommand } from './commands/status';
import { declareScopeCommand } from './commands/session';
import { parkCommand } from './commands/park';
import { generateExampleCommand } from './commands/example';
import { createAdrCommand } from './commands/adr';
import { scoreWsjfCommand, triageIssueCommand } from './commands/backlog';
import { SpecTreeProvider } from './views/spec-tree-provider';
import { AdrTreeProvider } from './views/adr-tree-provider';
import { BacklogTreeProvider } from './views/backlog-view';
import { MinSpecStatusBar, fromFrontmatter } from './views/status-bar';
import { SpecPanel } from './views/spec-panel';
import { loadConfig, applyVSCodeOverrides } from './lib/config';
import { loadSession, saveSession, addToScope, isFileInScope } from './lib/session';
import { detectTools, getToolFilePath, type DetectedTools } from './lib/tool-detector';
import { injectContextToFile, removeContextFromFile, type ActiveSpecContext } from './lib/context-injector';
import { parkTopic, createParkingLotEntry } from './lib/parking-lot';
import {
  MinSpecCodeLensProvider,
  MinSpecSpecFileLensProvider,
  goToSpecCommand,
  goToCodeCommand,
  linkToSpecCommand,
} from './views/codelens-provider';

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  // Active spec panel
  const specPanel = new SpecPanel(context.extensionUri);

  // Sidebar tree views
  const specTreeProvider = new SpecTreeProvider(workspaceRoot);
  const adrTreeProvider = new AdrTreeProvider(workspaceRoot);
  const backlogTreeProvider = new BacklogTreeProvider(workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('minspecStatus', specTreeProvider),
    vscode.window.registerTreeDataProvider('minspecAdrs', adrTreeProvider),
    vscode.window.registerTreeDataProvider('minspecBacklog', backlogTreeProvider),
  );

  // Status bar
  const statusBar = new MinSpecStatusBar();
  statusBar.update(null);

  // CodeLens providers (Phase 7)
  const codeLensProvider = new MinSpecCodeLensProvider(workspaceRoot);
  const specFileLensProvider = new MinSpecSpecFileLensProvider(workspaceRoot);

  const sourceSelector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'typescriptreact' },
    { scheme: 'file', language: 'javascript' },
    { scheme: 'file', language: 'javascriptreact' },
    { scheme: 'file', language: 'python' },
    { scheme: 'file', language: 'go' },
    { scheme: 'file', language: 'rust' },
    { scheme: 'file', language: 'java' },
    { scheme: 'file', language: 'csharp' },
    { scheme: 'file', language: 'c' },
    { scheme: 'file', language: 'cpp' },
    { scheme: 'file', language: 'ruby' },
    { scheme: 'file', language: 'swift' },
    { scheme: 'file', language: 'kotlin' },
    { scheme: 'file', language: 'vue' },
    { scheme: 'file', language: 'svelte' },
  ];
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(sourceSelector, codeLensProvider),
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file', language: 'markdown' },
      specFileLensProvider,
    ),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('minspec.init', initCommand),
    vscode.commands.registerCommand('minspec.initRefresh', initRefreshCommand),
    vscode.commands.registerCommand('minspec.classify', classifyCommand),
    vscode.commands.registerCommand('minspec.status', statusCommand),
    vscode.commands.registerCommand('minspec.refreshTree', () => {
      specTreeProvider.refresh();
      adrTreeProvider.refresh();
    }),
    vscode.commands.registerCommand('minspec.createAdr', createAdrCommand),
    vscode.commands.registerCommand('minspec.scoreWsjf', scoreWsjfCommand),
    vscode.commands.registerCommand('minspec.triageIssue', triageIssueCommand),
    vscode.commands.registerCommand('minspec.refreshBacklog', () => backlogTreeProvider.refresh()),
    vscode.commands.registerCommand('minspec.goToSpec', (specId?: string, reqKey?: string) =>
      goToSpecCommand(workspaceRoot, specId, reqKey)),
    vscode.commands.registerCommand('minspec.goToCode', (specId?: string, reqKey?: string) =>
      goToCodeCommand(workspaceRoot, specId, reqKey)),
    vscode.commands.registerCommand('minspec.linkToSpec', () =>
      linkToSpecCommand(workspaceRoot)),
    vscode.commands.registerCommand('minspec.declareScope', declareScopeCommand),
    vscode.commands.registerCommand('minspec.park', parkCommand),
    vscode.commands.registerCommand('minspec.injectContext', () => injectContextCommand(workspaceRoot)),
    vscode.commands.registerCommand('minspec.removeContext', () => removeContextCommand(workspaceRoot)),
    vscode.commands.registerCommand('minspec.generateExample', generateExampleCommand),
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

  const onSpecsChanged = async () => {
    specTreeProvider.refresh();
    specPanel.refresh();
    const activeSpecPath = await findActiveSpec(workspaceRoot);
    if (activeSpecPath) {
      try {
        const content = fs.readFileSync(activeSpecPath, 'utf-8');
        const { parseSpec: parse } = await import('./lib/spec');
        const parsed = parse(content);
        statusBar.update(fromFrontmatter(parsed.frontmatter));
      } catch {
        statusBar.update(null);
      }
    } else {
      statusBar.update(null);
    }
  };

  watcher.onDidChange(onSpecsChanged);
  watcher.onDidCreate(onSpecsChanged);
  watcher.onDidDelete(onSpecsChanged);

  context.subscriptions.push(watcher);

  // Watch decisions directory — refresh ADR tree on changes
  const decisionsDir = vscode.workspace.getConfiguration('minspec').get<string>('decisionsDir', 'docs/decisions');
  const adrWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.workspace.workspaceFolders?.[0] ?? '',
      `${decisionsDir}/**/*.md`,
    ),
  );

  const onAdrsChanged = () => {
    adrTreeProvider.refresh();
  };

  adrWatcher.onDidChange(onAdrsChanged);
  adrWatcher.onDidCreate(onAdrsChanged);
  adrWatcher.onDidDelete(onAdrsChanged);

  context.subscriptions.push(adrWatcher);

  // Watch traceability.json — refresh CodeLens on changes
  const traceabilityWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.workspace.workspaceFolders?.[0] ?? '',
      '.minspec/traceability.json',
    ),
  );

  const onTraceabilityChanged = () => {
    codeLensProvider.refresh();
    specFileLensProvider.refresh();
  };

  traceabilityWatcher.onDidChange(onTraceabilityChanged);
  traceabilityWatcher.onDidCreate(onTraceabilityChanged);
  traceabilityWatcher.onDidDelete(onTraceabilityChanged);

  context.subscriptions.push(traceabilityWatcher);

  // Drift detection: monitor file saves
  if (workspaceRoot) {
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        handleFileSaveDriftCheck(doc, workspaceRoot);
      }),
    );
  }

  // First-run experience: prompt to initialize if .minspec/ doesn't exist
  if (workspaceRoot) {
    const minspecDir = path.join(workspaceRoot, '.minspec');
    const hasMinspec = fs.existsSync(minspecDir);
    const hasSeenFirstRun = context.workspaceState.get<boolean>('minspec.firstRun', false);

    if (!hasMinspec && !hasSeenFirstRun) {
      context.workspaceState.update('minspec.firstRun', true);
      vscode.window
        .showInformationMessage(
          'Welcome to MinSpec! Would you like to initialize SDD for this project?',
          'Initialize',
          'Not Now',
        )
        .then(choice => {
          if (choice === 'Initialize') {
            vscode.commands.executeCommand('minspec.init');
          }
        });
    }
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
