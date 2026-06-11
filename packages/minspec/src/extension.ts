import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { initCommand, initRefreshCommand } from './commands/init';
import { classifyCommand } from './commands/classify';
import { statusCommand } from './commands/status';
import { declareScopeCommand } from './commands/session';
import { parkCommand } from './commands/park';
import { generateExampleCommand } from './commands/example';
import { migrateLayoutCommand } from './commands/migrate';
import { createAdrCommand, regenerateDrIndexCommand, acceptAdrCommand, setAdrStatusCommand } from './commands/adr';
import { createEpicCommand, regenerateEpicIndexCommand, acceptEpicCommand } from './commands/epic';
import { backfillEpicsCommand } from './commands/backfill-epics';
import { regenerateDrIndex } from './lib/adr-manager';
import { scoreWsjfCommand, triageIssueCommand } from './commands/backlog';
import { approveSpecCommand, revokeApprovalCommand } from './commands/approve';
import { validateSpecCommand } from './commands/validate';
import { SpecTreeProvider } from './views/spec-tree-provider';
import { AdrTreeProvider } from './views/adr-tree-provider';
import { FrontmatterCompletionProvider } from './views/frontmatter-completion';
import { BacklogTreeProvider } from './views/backlog-view';
import { MinSpecStatusBar, fromFrontmatter } from './views/status-bar';
import { SpecPanel } from './views/spec-panel';
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
import { maybeShowNudge, recordInstallTimestamp, exportTraceability, setupConformanceWatcher } from './lib/bridge';
import { runBootstrap, isWatchedGitPath, type BootstrapVsCode } from './lib/auto-bootstrap';
import { findActiveSpec, trackActiveSpecEditor } from './lib/active-spec';
import { parseSpec } from './lib/spec';
import { loadConfig, resolveAndValidate } from './lib/config';
import { trackActiveAdrEditor } from './lib/active-adr';
import { resolveTargetFolderNonInteractive } from './lib/resolve-folder';

export function activate(context: vscode.ExtensionContext): void {
  trackActiveSpecEditor(context);
  trackActiveAdrEditor(context);
  // Activation-time root: the folder containing the active editor (multi-root
  // safe), else the first folder, else ''. Non-interactive — never prompts at
  // startup. All file watchers below derive their base from this single value
  // so the watcher and its consumers always point at the same folder (#123).
  const workspaceRoot = resolveTargetFolderNonInteractive();

  // Active spec panel
  const specPanel = new SpecPanel();

  // Sidebar tree views
  const specTreeProvider = new SpecTreeProvider(workspaceRoot);
  const adrTreeProvider = new AdrTreeProvider(workspaceRoot);
  const backlogTreeProvider = new BacklogTreeProvider(workspaceRoot);

  const specTreeView = vscode.window.createTreeView('minspecStatus', {
    treeDataProvider: specTreeProvider,
  });
  const adrTreeView = vscode.window.createTreeView('minspecAdrs', {
    treeDataProvider: adrTreeProvider,
  });
  const backlogTreeView = vscode.window.createTreeView('minspecBacklog', {
    treeDataProvider: backlogTreeProvider,
  });
  context.subscriptions.push(specTreeView, adrTreeView, backlogTreeView);

  // ─── Epic grouping toggle (DR-013 / SPEC-007 FR-7) ──────────────────────────
  // Each panel persists its "group by epic" state in workspaceState (default on)
  // and exposes a context key so the titlebar icon reflects on/off.
  // Specs/Decisions default to epic grouping on; the Backlog defaults OFF until
  // issues carry epic:<slug> labels (no label backfill yet — harvest316/minspec#68),
  // so its titlebar toggle is also hidden in package.json.
  const EPIC_TOGGLES = [
    { key: 'minspec.specExplorer.groupByEpic', ctx: 'minspec.specExplorer.groupByEpic', provider: specTreeProvider, def: true },
    { key: 'minspec.adrExplorer.groupByEpic', ctx: 'minspec.adrExplorer.groupByEpic', provider: adrTreeProvider, def: true },
    { key: 'minspec.backlog.groupByEpic', ctx: 'minspec.backlog.groupByEpic', provider: backlogTreeProvider, def: false },
  ];
  for (const t of EPIC_TOGGLES) {
    const enabled = context.workspaceState.get<boolean>(t.key, t.def);
    t.provider.epicGrouping?.set(enabled);
    void vscode.commands.executeCommand('setContext', t.ctx, enabled);
  }
  const toggleEpicGrouping = async (t: typeof EPIC_TOGGLES[number]): Promise<void> => {
    const next = t.provider.epicGrouping?.toggle() ?? true;
    await context.workspaceState.update(t.key, next);
    await vscode.commands.executeCommand('setContext', t.ctx, next);
    t.provider.refresh();
  };

  // Async refresh triggers: when a pane becomes visible, refetch its data.
  // File watchers below catch in-VSCode edits; these hooks catch external
  // changes (CLI edits, git checkout, GitHub issue updates).
  context.subscriptions.push(
    specTreeView.onDidChangeVisibility(e => {
      if (e.visible) specTreeProvider.refresh();
    }),
    adrTreeView.onDidChangeVisibility(e => {
      if (e.visible) adrTreeProvider.refresh();
    }),
    backlogTreeView.onDidChangeVisibility(e => {
      if (e.visible) backlogTreeProvider.refreshIfStale();
    }),
    // When VS Code window regains focus, refresh all three. Backlog uses the
    // stale-only variant so we don't hammer `gh` on every alt-tab.
    vscode.window.onDidChangeWindowState(state => {
      if (!state.focused) return;
      specTreeProvider.refresh();
      adrTreeProvider.refresh();
      backlogTreeProvider.refreshIfStale();
    }),
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
    vscode.languages.registerCompletionItemProvider(
      { scheme: 'file', language: 'markdown' },
      new FrontmatterCompletionProvider(),
      ':', ' ', // trigger after "key:" and after the space
    ),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('minspec.init', initCommand),
    vscode.commands.registerCommand('minspec.initRefresh', initRefreshCommand),
    vscode.commands.registerCommand('minspec.classify', classifyCommand),
    vscode.commands.registerCommand('minspec.status', statusCommand(workspaceRoot)),
    vscode.commands.registerCommand('minspec.refreshTree', () => {
      specTreeProvider.refresh();
      adrTreeProvider.refresh();
    }),
    vscode.commands.registerCommand('minspec.createAdr', createAdrCommand),
    vscode.commands.registerCommand('minspec.regenerateDrIndex', regenerateDrIndexCommand),
    vscode.commands.registerCommand('minspec.createEpic', async () => {
      await createEpicCommand();
      specTreeProvider.refresh();
      adrTreeProvider.refresh();
      backlogTreeProvider.refresh();
    }),
    vscode.commands.registerCommand('minspec.regenerateEpicIndex', regenerateEpicIndexCommand),
    vscode.commands.registerCommand('minspec.acceptEpic', async (node) => {
      await acceptEpicCommand(node);
      specTreeProvider.refresh();
      adrTreeProvider.refresh();
      backlogTreeProvider.refresh();
    }),
    vscode.commands.registerCommand('minspec.backfillEpics', async (folderArg?: string) => {
      await backfillEpicsCommand(folderArg);
      specTreeProvider.refresh();
      adrTreeProvider.refresh();
      backlogTreeProvider.refresh();
    }),
    vscode.commands.registerCommand('minspec.specExplorer.toggleEpicGrouping', () => toggleEpicGrouping(EPIC_TOGGLES[0])),
    vscode.commands.registerCommand('minspec.adrExplorer.toggleEpicGrouping', () => toggleEpicGrouping(EPIC_TOGGLES[1])),
    vscode.commands.registerCommand('minspec.backlog.toggleEpicGrouping', () => toggleEpicGrouping(EPIC_TOGGLES[2])),
    vscode.commands.registerCommand('minspec.acceptAdr', async (node) => {
      await acceptAdrCommand(node);
      adrTreeProvider.refresh();
    }),
    vscode.commands.registerCommand('minspec.setAdrStatus', async (node) => {
      await setAdrStatusCommand(node);
      adrTreeProvider.refresh();
    }),
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
    vscode.commands.registerCommand('minspec.park', () => parkCommand()),
    vscode.commands.registerCommand('minspec.parkForce', () => parkCommand({ force: true })),
    vscode.commands.registerCommand('minspec.injectContext', () => injectContextCommand(workspaceRoot)),
    vscode.commands.registerCommand('minspec.removeContext', () => removeContextCommand(workspaceRoot)),
    vscode.commands.registerCommand('minspec.generateExample', generateExampleCommand),
    vscode.commands.registerCommand('minspec.migrateLayout', () => migrateLayoutCommand(workspaceRoot)),
    vscode.commands.registerCommand('minspec.exportTraceability', () => exportTraceabilityCommand(workspaceRoot)),
    // approve/revoke already fire `minspec.refreshTree` internally — no extra
    // refresh here (it only added to the redundant burst; issue #154).
    vscode.commands.registerCommand('minspec.approveSpec', async (node) => {
      await approveSpecCommand(node);
    }),
    vscode.commands.registerCommand('minspec.revokeApproval', async (node) => {
      await revokeApprovalCommand(node);
    }),
    vscode.commands.registerCommand('minspec.validateSpec', (node) => validateSpecCommand(node)),
    vscode.commands.registerCommand('minspec.showSpecPanel', async (specFilePath?: string) => {
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
        return;
      }
      if (!specFilePath) {
        specFilePath = (await findActiveSpec(workspaceRoot)) ?? undefined;
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
      workspaceRoot,
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
        const { parseSpec: parse } = await import('./lib/spec.js');
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
      workspaceRoot,
      `${decisionsDir}/**/*.md`,
    ),
  );

  // Regenerate INDEX.md when a DR file changes (frontmatter edit, add, delete).
  // Guard against self-trigger: regenerateDrIndex writes INDEX.md, which is a
  // *.md under decisionsDir and would re-fire the watcher → infinite loop.
  // Debounce coalesces bursts (e.g. multi-file save) into one regenerate.
  let adrIndexTimer: ReturnType<typeof setTimeout> | undefined;
  const onAdrsChanged = (uri?: vscode.Uri) => {
    adrTreeProvider.refresh();
    if (uri && path.basename(uri.fsPath).toLowerCase() === 'index.md') return;
    if (!workspaceRoot) return;
    if (adrIndexTimer) clearTimeout(adrIndexTimer);
    adrIndexTimer = setTimeout(() => {
      try {
        regenerateDrIndex(workspaceRoot, decisionsDir ? { decisionsDir } : undefined);
      } catch {
        // Non-fatal: tree already refreshed; index regen is best-effort.
      }
    }, 300);
  };

  adrWatcher.onDidChange(onAdrsChanged);
  adrWatcher.onDidCreate(onAdrsChanged);
  adrWatcher.onDidDelete(onAdrsChanged);

  context.subscriptions.push(adrWatcher);

  // Watch traceability.json — refresh CodeLens on changes
  const traceabilityWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      workspaceRoot,
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

  // Watch approvals.json — refresh spec tree so approval badges stay current
  // when the gate hook, CLI, or another window changes approval state.
  const approvalsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      workspaceRoot,
      '.minspec/approvals.json',
    ),
  );
  const onApprovalsChanged = () => specTreeProvider.refresh();
  approvalsWatcher.onDidChange(onApprovalsChanged);
  approvalsWatcher.onDidCreate(onApprovalsChanged);
  approvalsWatcher.onDidDelete(onApprovalsChanged);
  context.subscriptions.push(approvalsWatcher);

  // Drift detection: monitor file saves
  if (workspaceRoot) {
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        handleFileSaveDriftCheck(doc, workspaceRoot);
      }),
    );
  }

  // First-run experience: legacy welcome toast (kept for users who already
  // had .minspec installed before auto-bootstrap shipped — its workspaceState
  // flag prevents the new richer system from double-prompting them on the
  // very first activation after upgrade).
  // Auto-bootstrap: detect+offer (init / harness drift / unclassified diff /
  // epic backfill) for EVERY workspace folder, so non-first folders in a
  // multi-root workspace get their own offers (harvest316/minspec#123). Each
  // offered command is invoked WITH its folder, so it targets the right one.
  const bootstrapVsCode: BootstrapVsCode = {
    isEnabled: () =>
      vscode.workspace
        .getConfiguration('minspec')
        .get<boolean>('autoBootstrap.enabled', true) !== false,
    showPrompt: (message, actions) =>
      Promise.resolve(
        vscode.window.showInformationMessage(message, ...actions),
      ).then(choice => (typeof choice === 'string' ? choice : undefined)),
    executeCommand: (commandId, folder) => {
      const result = vscode.commands.executeCommand(commandId, folder);
      return result instanceof Promise ? result.then(() => undefined) : undefined;
    },
    enableAutoClassify: () =>
      Promise.resolve(
        vscode.workspace
          .getConfiguration('minspec')
          .update(
            'autoClassifyOnCommit',
            true,
            vscode.ConfigurationTarget.Workspace,
          ),
      ).then(() => undefined),
  };
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    void runBootstrap(folder.uri.fsPath, bootstrapVsCode);
  }

  if (workspaceRoot) {
    // Auto-classify on commit — watch .git/HEAD + refs/heads/* if opted in.
    const autoClassifyEnabled = vscode.workspace
      .getConfiguration('minspec')
      .get<boolean>('autoClassifyOnCommit', false);
    if (autoClassifyEnabled) {
      const gitWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          workspaceRoot,
          '.git/{HEAD,refs/heads/**}',
        ),
      );
      const triggerClassify = (uri: vscode.Uri) => {
        if (!isWatchedGitPath(uri.fsPath)) return;
        vscode.commands.executeCommand('minspec.classify');
      };
      gitWatcher.onDidChange(triggerClassify);
      gitWatcher.onDidCreate(triggerClassify);
      context.subscriptions.push(gitWatcher);
    }
  }

  // ScroogeLLM bridge: conformance auto-export watcher (Phase 10)
  if (workspaceRoot) {
    const conformanceWatcher = setupConformanceWatcher(workspaceRoot);
    if (conformanceWatcher) {
      context.subscriptions.push(conformanceWatcher);
    }
  }

  // ScroogeLLM bridge: record install timestamp on first activation, then
  // attempt the nudge (gated on 24h install age + 7d cooldown).
  recordInstallTimestamp(context);
  void maybeShowNudge(context);
}

/**
 * Command: Export traceability data for ScroogeLLM conformance checking.
 */
function exportTraceabilityCommand(workspaceRoot: string): void {
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }

  try {
    const result = exportTraceability(workspaceRoot);
    vscode.window.showInformationMessage(
      `MinSpec: Exported traceability for ${result.specCount} spec(s) to ${path.basename(result.filePath)}.`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `MinSpec: Failed to export traceability — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve a spec id to its parsed frontmatter by reading the actual file.
 *
 * Walks the configured specs dir (recursively, so both flat and spec-kit
 * layouts work) and returns the first spec whose frontmatter `id` matches.
 * Returns null when no readable/parseable spec carries that id — the caller
 * MUST treat null as "not found" and refuse to fabricate context (#149).
 *
 * Matches on parsed frontmatter `id`, not the filename prefix, so the injected
 * tier/status/phase always come from the real spec the id denotes.
 */
function resolveSpecFrontmatter(workspaceRoot: string, specId: string) {
  let specsDir: string;
  try {
    const config = loadConfig(workspaceRoot);
    specsDir = resolveAndValidate(workspaceRoot, config.specsDir);
  } catch {
    return null;
  }
  if (!fs.existsSync(specsDir)) return null;

  const stack = [specsDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith('.md')) {
        try {
          const parsed = parseSpec(fs.readFileSync(full, 'utf-8'));
          if (parsed.frontmatter.id === specId) return parsed.frontmatter;
        } catch {
          // Unparseable file — skip; a real match elsewhere still wins.
        }
      }
    }
  }
  return null;
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

  // Read the spec's REAL frontmatter — never fabricate. A never-wrong product
  // must not write a false tier/status into AI tool config (#149). If the spec
  // can't be found/parsed, error out rather than inject a fabricated default.
  const frontmatter = resolveSpecFrontmatter(workspaceRoot, specId);
  if (!frontmatter) {
    vscode.window.showErrorMessage(
      `MinSpec: Spec ${specId} not found (or unparseable) — nothing injected.`,
    );
    return;
  }

  // Derive the current phase the same way the status bar does (first
  // in-progress phase, else first pending) so the injected block agrees with
  // every other surface that reports the active phase.
  const { currentPhase } = fromFrontmatter(frontmatter);

  const activeContext: ActiveSpecContext = {
    specId: frontmatter.id,
    title: frontmatter.title,
    tier: frontmatter.tier,
    currentPhase,
    status: frontmatter.status,
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

export function deactivate(): void {}
