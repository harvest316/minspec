import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mock state — mutated by the mocks, inspected by tests
// ---------------------------------------------------------------------------

/** Every command registered via commands.registerCommand */
const registeredCommands = new Map<string, (...args: any[]) => any>();

/** Collected subscriptions pushed by activate() */
let subscriptions: any[] = [];

// Mock instances returned by view constructors
const mockSpecTreeProvider = { refresh: vi.fn() };
const mockAdrTreeProvider = { refresh: vi.fn() };
const mockBacklogTreeProvider = { refresh: vi.fn(), refreshIfStale: vi.fn() };
const mockStatusBar = { update: vi.fn(), dispose: vi.fn() };
const mockSpecPanel = { show: vi.fn(), refresh: vi.fn(), dispose: vi.fn() };
const mockCodeLensProvider = { refresh: vi.fn() };
const mockSpecFileLensProvider = { refresh: vi.fn() };

// File watcher mocks — capture the callbacks passed to onDid* so we can fire them
const makeWatcher = () => ({
  onDidChange: vi.fn(),
  onDidCreate: vi.fn(),
  onDidDelete: vi.fn(),
  dispose: vi.fn(),
});

let specWatcher = makeWatcher();
let adrWatcher = makeWatcher();
let traceWatcher = makeWatcher();
let watcherCallIndex = 0;

// #123: capture the RelativePattern base passed to each createFileSystemWatcher
// call so tests can assert watchers target the resolved folder, not always [0].
let watcherPatternBases: any[] = [];

// Track tree data providers registered
const registeredTreeProviders = new Map<string, any>();

// Track tree views created (id -> { provider, visibilityHandler })
interface MockTreeView {
  provider: any;
  visibilityHandler?: (e: { visible: boolean }) => void;
  dispose: () => void;
}
const createdTreeViews = new Map<string, MockTreeView>();

// Track the onDidChangeWindowState handler
let windowStateHandler: ((state: { focused: boolean }) => void) | undefined;

// Track CodeLens registrations
const codeLensRegistrations: { selector: any; provider: any }[] = [];

// Track onDidSaveTextDocument
let onSaveHandler: ((doc: any) => void) | undefined;

// ---------------------------------------------------------------------------
// vscode mock
// ---------------------------------------------------------------------------

vi.mock('vscode', () => ({
  window: {
    registerTreeDataProvider: vi.fn((id: string, provider: any) => {
      registeredTreeProviders.set(id, provider);
      return { dispose: vi.fn() };
    }),
    createTreeView: vi.fn((id: string, options: { treeDataProvider: any }) => {
      registeredTreeProviders.set(id, options.treeDataProvider);
      const view: MockTreeView = {
        provider: options.treeDataProvider,
        dispose: vi.fn(),
        onDidChangeVisibility: vi.fn((handler: (e: { visible: boolean }) => void) => {
          view.visibilityHandler = handler;
          return { dispose: vi.fn() };
        }),
      } as any;
      createdTreeViews.set(id, view);
      return view;
    }),
    onDidChangeWindowState: vi.fn((handler: (state: { focused: boolean }) => void) => {
      windowStateHandler = handler;
      return { dispose: vi.fn() };
    }),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    showInputBox: vi.fn(),
    showTextDocument: vi.fn(),
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/test-workspace' } }],
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, def: any) => def),
    })),
    createFileSystemWatcher: vi.fn((pattern?: { base?: unknown }) => {
      watcherPatternBases.push(pattern?.base);
      // Return different watchers in order of creation
      const watchers = [specWatcher, adrWatcher, traceWatcher];
      const w = watchers[watcherCallIndex] ?? makeWatcher();
      watcherCallIndex++;
      return w;
    }),
    openTextDocument: vi.fn(() => Promise.resolve({})),
    onDidSaveTextDocument: vi.fn((handler: (doc: any) => void) => {
      onSaveHandler = handler;
      return { dispose: vi.fn() };
    }),
  },
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: any[]) => any) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
  },
  languages: {
    registerCodeLensProvider: vi.fn((selector: any, provider: any) => {
      codeLensRegistrations.push({ selector, provider });
      return { dispose: vi.fn() };
    }),
    registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
  extensions: {
    getExtension: vi.fn(() => ({ id: 'mock' })),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    event = vi.fn();
    fire = vi.fn();
  },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  TreeItem: class {
    constructor(
      public label: string,
      public collapsibleState: number,
    ) {}
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file' }),
    parse: (s: string) => ({ toString: () => s }),
  },
  ViewColumn: { Beside: 2 },
  RelativePattern: class {
    constructor(
      public base: any,
      public pattern: string,
    ) {}
  },
}));

// ---------------------------------------------------------------------------
// Lib / view mocks
// ---------------------------------------------------------------------------

vi.mock('../src/commands/init', () => ({
  initCommand: vi.fn(),
  initRefreshCommand: vi.fn(),
}));
vi.mock('../src/commands/classify', () => ({
  classifyCommand: vi.fn(),
}));
// statusCommand is now a factory: statusCommand(workspaceRoot) => handler.
// Return a stable spy handler so registerCommand gets a real function.
const { statusHandlerSpy } = vi.hoisted(() => ({ statusHandlerSpy: vi.fn() }));
vi.mock('../src/commands/status', () => ({
  statusCommand: vi.fn(() => statusHandlerSpy),
}));
vi.mock('../src/commands/session', () => ({
  declareScopeCommand: vi.fn(),
}));
vi.mock('../src/commands/park', () => ({
  parkCommand: vi.fn(),
}));
vi.mock('../src/commands/example', () => ({
  generateExampleCommand: vi.fn(),
}));
vi.mock('../src/commands/adr', () => ({
  createAdrCommand: vi.fn(),
  regenerateDrIndexCommand: vi.fn(),
}));
vi.mock('../src/lib/adr-manager', () => ({
  regenerateDrIndex: vi.fn(),
}));
vi.mock('../src/commands/backlog', () => ({
  scoreWsjfCommand: vi.fn(),
  triageIssueCommand: vi.fn(),
}));
vi.mock('../src/views/spec-tree-provider', () => ({
  SpecTreeProvider: vi.fn(function () { return mockSpecTreeProvider; }),
}));
vi.mock('../src/views/adr-tree-provider', () => ({
  AdrTreeProvider: vi.fn(function () { return mockAdrTreeProvider; }),
}));
vi.mock('../src/views/backlog-view', () => ({
  BacklogTreeProvider: vi.fn(function () { return mockBacklogTreeProvider; }),
}));
// Partial mock: stub the status-bar class but forward the real pure helpers
// (fromFrontmatter, computeProgress, …) so injectContextCommand can derive the
// current phase from frontmatter the same way the bar does (#149).
vi.mock('../src/views/status-bar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/views/status-bar')>()),
  MinSpecStatusBar: vi.fn(function () { return mockStatusBar; }),
}));
vi.mock('../src/views/spec-panel', () => ({
  SpecPanel: vi.fn(function () { return mockSpecPanel; }),
}));
vi.mock('../src/views/codelens-provider', () => ({
  MinSpecCodeLensProvider: vi.fn(function () { return mockCodeLensProvider; }),
  MinSpecSpecFileLensProvider: vi.fn(function () { return mockSpecFileLensProvider; }),
  goToSpecCommand: vi.fn(),
  goToCodeCommand: vi.fn(),
  linkToSpecCommand: vi.fn(),
}));
// Partial mock: stub the config loaders but forward real exports (TIERS,
// DEFAULT_CONFIG, …) so spec-validator (via approve) resolves them (#115).
vi.mock('../src/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/config')>()),
  loadConfig: vi.fn(() => ({ specsDir: 'specs' })),
  applyVSCodeOverrides: vi.fn((c: any) => c),
  resolveAndValidate: vi.fn((root: string, sub: string) => `${root}/${sub}`),
}));
vi.mock('../src/lib/session', () => ({
  loadSession: vi.fn(() => null),
  saveSession: vi.fn(),
  addToScope: vi.fn((session: any) => session),
  isFileInScope: vi.fn(() => true),
}));
vi.mock('../src/lib/tool-detector', () => ({
  detectTools: vi.fn(() => ({})),
  getToolFilePath: vi.fn(() => ''),
}));
vi.mock('../src/lib/context-injector', () => ({
  injectContextToFile: vi.fn(),
  removeContextFromFile: vi.fn(),
}));
vi.mock('../src/lib/parking-lot', () => ({
  parkTopic: vi.fn(() =>
    Promise.resolve({ method: 'file', filePath: '/tmp/test' }),
  ),
  createParkingLotEntry: vi.fn(() => ({})),
}));
// Partial mock: stub parseSpec but forward all real exports (SPEC_STATUSES,
// stripInlineComment, …) so downstream importers (spec-validator → approve)
// still resolve them. A full replacement would drop those exports (#115).
vi.mock('../src/lib/spec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/spec')>()),
  parseSpec: vi.fn(() => ({
    frontmatter: { status: 'new' },
  })),
}));
vi.mock('fs');
vi.mock('path', async () => {
  const actual = await vi.importActual('path');
  return actual;
});

// ---------------------------------------------------------------------------
// Import SUT after mocks are wired
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as fs from 'fs';
import { activate, deactivate } from '../src/extension';
import { initCommand, initRefreshCommand } from '../src/commands/init';
import { classifyCommand } from '../src/commands/classify';
import { statusCommand } from '../src/commands/status';
import { declareScopeCommand } from '../src/commands/session';
import { parkCommand } from '../src/commands/park';
import { generateExampleCommand } from '../src/commands/example';
import { createAdrCommand } from '../src/commands/adr';
import { regenerateDrIndex } from '../src/lib/adr-manager';
import { scoreWsjfCommand, triageIssueCommand } from '../src/commands/backlog';
import {
  goToSpecCommand,
  goToCodeCommand,
  linkToSpecCommand,
} from '../src/views/codelens-provider';
import { detectTools, getToolFilePath } from '../src/lib/tool-detector';
import { parseSpec } from '../src/lib/spec';
import {
  injectContextToFile,
  removeContextFromFile,
} from '../src/lib/context-injector';
import { loadSession, saveSession, addToScope, isFileInScope } from '../src/lib/session';
import { createParkingLotEntry, parkTopic } from '../src/lib/parking-lot';
import { MinSpecStatusBar } from '../src/views/status-bar';
import { SpecPanel } from '../src/views/spec-panel';
import { SpecTreeProvider } from '../src/views/spec-tree-provider';
import { AdrTreeProvider } from '../src/views/adr-tree-provider';
import { BacklogTreeProvider } from '../src/views/backlog-view';
import {
  MinSpecCodeLensProvider,
  MinSpecSpecFileLensProvider,
} from '../src/views/codelens-provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockContext(overrides: Partial<Record<string, any>> = {}) {
  return {
    extensionUri: { fsPath: '/tmp/ext' },
    subscriptions: subscriptions,
    globalState: {
      get: vi.fn(() => false),
      update: vi.fn(),
    },
    workspaceState: {
      get: vi.fn(() => false),
      update: vi.fn(),
    },
    ...overrides,
  } as unknown as vscode.ExtensionContext;
}

/**
 * Invoke the handler registered for a given command id.
 * Throws if the command was never registered.
 */
function invokeCommand(id: string, ...args: any[]): any {
  const handler = registeredCommands.get(id);
  if (!handler) throw new Error(`Command "${id}" was never registered`);
  return handler(...args);
}

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  registeredCommands.clear();
  subscriptions = [];
  registeredTreeProviders.clear();
  createdTreeViews.clear();
  windowStateHandler = undefined;
  codeLensRegistrations.length = 0;
  onSaveHandler = undefined;

  // Reset watcher instances so each test gets fresh ones
  specWatcher = makeWatcher();
  adrWatcher = makeWatcher();
  traceWatcher = makeWatcher();
  watcherCallIndex = 0;
  watcherPatternBases = [];

  // Default: .minspec/ exists (suppress first-run prompt)
  vi.mocked(fs.existsSync).mockReturnValue(true);
});

// =============================================================================
// activate()
// =============================================================================

describe('activate()', () => {
  // -------------------------------------------------------------------------
  // Command registration
  // -------------------------------------------------------------------------

  it('registers all expected commands', () => {
    activate(makeMockContext());

    const expectedCommands = [
      'minspec.init',
      'minspec.initRefresh',
      'minspec.classify',
      'minspec.status',
      'minspec.refreshTree',
      'minspec.createAdr',
      'minspec.scoreWsjf',
      'minspec.triageIssue',
      'minspec.refreshBacklog',
      'minspec.goToSpec',
      'minspec.goToCode',
      'minspec.linkToSpec',
      'minspec.declareScope',
      'minspec.park',
      'minspec.injectContext',
      'minspec.removeContext',
      'minspec.generateExample',
      'minspec.showSpecPanel',
    ];

    for (const cmd of expectedCommands) {
      expect(registeredCommands.has(cmd), `missing command: ${cmd}`).toBe(true);
    }
  });

  it('wires commands to their correct handler functions', () => {
    activate(makeMockContext());

    // Direct delegation commands — invoking should call the imported handler
    invokeCommand('minspec.init');
    expect(initCommand).toHaveBeenCalled();

    invokeCommand('minspec.initRefresh');
    expect(initRefreshCommand).toHaveBeenCalled();

    invokeCommand('minspec.classify');
    expect(classifyCommand).toHaveBeenCalled();

    invokeCommand('minspec.status');
    expect(statusCommand).toHaveBeenCalled();

    invokeCommand('minspec.createAdr');
    expect(createAdrCommand).toHaveBeenCalled();

    invokeCommand('minspec.scoreWsjf');
    expect(scoreWsjfCommand).toHaveBeenCalled();

    invokeCommand('minspec.triageIssue');
    expect(triageIssueCommand).toHaveBeenCalled();

    invokeCommand('minspec.declareScope');
    expect(declareScopeCommand).toHaveBeenCalled();

    invokeCommand('minspec.park');
    expect(parkCommand).toHaveBeenCalled();

    invokeCommand('minspec.generateExample');
    expect(generateExampleCommand).toHaveBeenCalled();
  });

  it('refreshTree command refreshes both spec and ADR tree providers', () => {
    activate(makeMockContext());

    invokeCommand('minspec.refreshTree');

    expect(mockSpecTreeProvider.refresh).toHaveBeenCalled();
    expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();
  });

  it('refreshBacklog command refreshes backlog tree provider', () => {
    activate(makeMockContext());

    invokeCommand('minspec.refreshBacklog');

    expect(mockBacklogTreeProvider.refresh).toHaveBeenCalled();
  });

  it('goToSpec command passes workspaceRoot and args', () => {
    activate(makeMockContext());

    invokeCommand('minspec.goToSpec', 'SPEC-001', 'REQ-A');

    expect(goToSpecCommand).toHaveBeenCalledWith(
      '/tmp/test-workspace',
      'SPEC-001',
      'REQ-A',
    );
  });

  it('goToCode command passes workspaceRoot and args', () => {
    activate(makeMockContext());

    invokeCommand('minspec.goToCode', 'SPEC-002', 'REQ-B');

    expect(goToCodeCommand).toHaveBeenCalledWith(
      '/tmp/test-workspace',
      'SPEC-002',
      'REQ-B',
    );
  });

  it('linkToSpec command passes workspaceRoot', () => {
    activate(makeMockContext());

    invokeCommand('minspec.linkToSpec');

    expect(linkToSpecCommand).toHaveBeenCalledWith('/tmp/test-workspace');
  });

  // -------------------------------------------------------------------------
  // Tree data providers
  // -------------------------------------------------------------------------

  it('registers tree data providers for all three views', () => {
    activate(makeMockContext());

    expect(registeredTreeProviders.has('minspecStatus')).toBe(true);
    expect(registeredTreeProviders.has('minspecAdrs')).toBe(true);
    expect(registeredTreeProviders.has('minspecBacklog')).toBe(true);
  });

  it('constructs tree providers with workspace root', () => {
    activate(makeMockContext());

    expect(SpecTreeProvider).toHaveBeenCalledWith('/tmp/test-workspace');
    expect(AdrTreeProvider).toHaveBeenCalledWith('/tmp/test-workspace');
    expect(BacklogTreeProvider).toHaveBeenCalledWith('/tmp/test-workspace');
  });

  // -------------------------------------------------------------------------
  // Async refresh triggers (visibility + window focus)
  // -------------------------------------------------------------------------

  it('creates a TreeView for each of the three sidebar panes', () => {
    activate(makeMockContext());

    expect(createdTreeViews.has('minspecStatus')).toBe(true);
    expect(createdTreeViews.has('minspecAdrs')).toBe(true);
    expect(createdTreeViews.has('minspecBacklog')).toBe(true);
  });

  it('refreshes spec tree when its pane becomes visible', () => {
    activate(makeMockContext());

    const view = createdTreeViews.get('minspecStatus')!;
    view.visibilityHandler!({ visible: true });
    expect(mockSpecTreeProvider.refresh).toHaveBeenCalled();
  });

  it('refreshes ADR tree when its pane becomes visible', () => {
    activate(makeMockContext());

    const view = createdTreeViews.get('minspecAdrs')!;
    view.visibilityHandler!({ visible: true });
    expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();
  });

  it('refreshes backlog (stale-only) when its pane becomes visible', () => {
    activate(makeMockContext());

    const view = createdTreeViews.get('minspecBacklog')!;
    view.visibilityHandler!({ visible: true });
    expect(mockBacklogTreeProvider.refreshIfStale).toHaveBeenCalled();
    expect(mockBacklogTreeProvider.refresh).not.toHaveBeenCalled();
  });

  it('does not refresh when a pane becomes hidden', () => {
    activate(makeMockContext());

    createdTreeViews.get('minspecStatus')!.visibilityHandler!({ visible: false });
    createdTreeViews.get('minspecAdrs')!.visibilityHandler!({ visible: false });
    createdTreeViews.get('minspecBacklog')!.visibilityHandler!({ visible: false });

    expect(mockSpecTreeProvider.refresh).not.toHaveBeenCalled();
    expect(mockAdrTreeProvider.refresh).not.toHaveBeenCalled();
    expect(mockBacklogTreeProvider.refreshIfStale).not.toHaveBeenCalled();
  });

  it('refreshes all three trees when the window regains focus', () => {
    activate(makeMockContext());

    expect(windowStateHandler).toBeDefined();
    windowStateHandler!({ focused: true });

    expect(mockSpecTreeProvider.refresh).toHaveBeenCalled();
    expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();
    expect(mockBacklogTreeProvider.refreshIfStale).toHaveBeenCalled();
  });

  it('does not refresh when the window loses focus', () => {
    activate(makeMockContext());

    windowStateHandler!({ focused: false });

    expect(mockSpecTreeProvider.refresh).not.toHaveBeenCalled();
    expect(mockAdrTreeProvider.refresh).not.toHaveBeenCalled();
    expect(mockBacklogTreeProvider.refreshIfStale).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // CodeLens providers
  // -------------------------------------------------------------------------

  it('registers two CodeLens providers (source + markdown)', () => {
    activate(makeMockContext());

    expect(codeLensRegistrations).toHaveLength(2);
  });

  it('registers source CodeLens for all supported language selectors', () => {
    activate(makeMockContext());

    const sourceReg = codeLensRegistrations[0];
    const selector = sourceReg.selector as vscode.DocumentSelector;
    expect(Array.isArray(selector)).toBe(true);

    const languages = (selector as any[]).map(
      (s: { language: string }) => s.language,
    );
    expect(languages).toContain('typescript');
    expect(languages).toContain('python');
    expect(languages).toContain('go');
    expect(languages).toContain('rust');
    expect(languages).toContain('java');
  });

  it('registers markdown CodeLens for spec files', () => {
    activate(makeMockContext());

    const markdownReg = codeLensRegistrations[1];
    expect(markdownReg.selector).toEqual({
      scheme: 'file',
      language: 'markdown',
    });
  });

  it('constructs CodeLens providers with workspace root', () => {
    activate(makeMockContext());

    expect(MinSpecCodeLensProvider).toHaveBeenCalledWith('/tmp/test-workspace');
    expect(MinSpecSpecFileLensProvider).toHaveBeenCalledWith(
      '/tmp/test-workspace',
    );
  });

  // -------------------------------------------------------------------------
  // Status bar
  // -------------------------------------------------------------------------

  it('creates and initializes the status bar with null', () => {
    activate(makeMockContext());

    expect(MinSpecStatusBar).toHaveBeenCalled();
    expect(mockStatusBar.update).toHaveBeenCalledWith(null);
  });

  // -------------------------------------------------------------------------
  // SpecPanel
  // -------------------------------------------------------------------------

  it('constructs SpecPanel', () => {
    const ctx = makeMockContext();
    activate(ctx);

    expect(SpecPanel).toHaveBeenCalledWith();
  });

  // -------------------------------------------------------------------------
  // File system watchers
  // -------------------------------------------------------------------------

  it('creates four file system watchers (specs, adrs, traceability, approvals)', () => {
    activate(makeMockContext());

    // DR-012 added the .minspec/approvals.json watcher → 4 (was 3).
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(4);
  });

  it('wires spec watcher callbacks to refresh tree and panel', () => {
    activate(makeMockContext());

    // The spec watcher is the first one created
    expect(specWatcher.onDidChange).toHaveBeenCalled();
    expect(specWatcher.onDidCreate).toHaveBeenCalled();
    expect(specWatcher.onDidDelete).toHaveBeenCalled();

    // Fire the onChange callback
    const onChangeHandler = specWatcher.onDidChange.mock.calls[0][0];
    onChangeHandler();

    expect(mockSpecTreeProvider.refresh).toHaveBeenCalled();
    expect(mockSpecPanel.refresh).toHaveBeenCalled();
  });

  it('wires ADR watcher callbacks to refresh ADR tree', () => {
    activate(makeMockContext());

    expect(adrWatcher.onDidChange).toHaveBeenCalled();
    expect(adrWatcher.onDidCreate).toHaveBeenCalled();
    expect(adrWatcher.onDidDelete).toHaveBeenCalled();

    const onChangeHandler = adrWatcher.onDidChange.mock.calls[0][0];
    onChangeHandler({ fsPath: '/tmp/test-workspace/docs/decisions/DR-007.md' });

    expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();
  });

  it('regenerates INDEX.md when a DR file changes (debounced trigger)', () => {
    vi.useFakeTimers();
    try {
      activate(makeMockContext());
      vi.mocked(regenerateDrIndex).mockClear();

      const onChangeHandler = adrWatcher.onDidChange.mock.calls[0][0];
      onChangeHandler({ fsPath: '/tmp/test-workspace/docs/decisions/DR-007.md' });

      // Debounced — not called synchronously
      expect(regenerateDrIndex).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(regenerateDrIndex).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT regenerate INDEX.md when INDEX.md itself changes (no self-trigger loop)', () => {
    vi.useFakeTimers();
    try {
      activate(makeMockContext());
      vi.mocked(regenerateDrIndex).mockClear();

      const onChangeHandler = adrWatcher.onDidChange.mock.calls[0][0];
      onChangeHandler({ fsPath: '/tmp/test-workspace/docs/decisions/INDEX.md' });

      vi.advanceTimersByTime(300);
      expect(regenerateDrIndex).not.toHaveBeenCalled();
      // Tree still refreshes regardless
      expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a burst of DR changes into a single regenerate', () => {
    vi.useFakeTimers();
    try {
      activate(makeMockContext());
      vi.mocked(regenerateDrIndex).mockClear();

      const onChangeHandler = adrWatcher.onDidChange.mock.calls[0][0];
      onChangeHandler({ fsPath: '/tmp/test-workspace/docs/decisions/DR-001.md' });
      onChangeHandler({ fsPath: '/tmp/test-workspace/docs/decisions/DR-007.md' });
      onChangeHandler({ fsPath: '/tmp/test-workspace/docs/decisions/DR-002.md' });

      vi.advanceTimersByTime(300);
      expect(regenerateDrIndex).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wires traceability watcher callbacks to refresh CodeLens providers', () => {
    activate(makeMockContext());

    expect(traceWatcher.onDidChange).toHaveBeenCalled();
    expect(traceWatcher.onDidCreate).toHaveBeenCalled();
    expect(traceWatcher.onDidDelete).toHaveBeenCalled();

    const onChangeHandler = traceWatcher.onDidChange.mock.calls[0][0];
    onChangeHandler();

    expect(mockCodeLensProvider.refresh).toHaveBeenCalled();
    expect(mockSpecFileLensProvider.refresh).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Drift detection (onDidSaveTextDocument)
  // -------------------------------------------------------------------------

  it('registers onDidSaveTextDocument handler for drift detection', () => {
    activate(makeMockContext());

    expect(vscode.workspace.onDidSaveTextDocument).toHaveBeenCalled();
    expect(onSaveHandler).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // First-run experience
  // -------------------------------------------------------------------------

  it('offers bootstrap setup when a folder is uninitialized', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    activate(makeMockContext());

    // The legacy welcome toast was removed; init is now offered by the
    // per-folder auto-bootstrap loop (harvest316/minspec#123).
    await vi.waitFor(() => {
      // #203: "Not Now" removed — the toast's X dismisses; init has no "Always".
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("isn't initialized"),
        'Initialize',
        "Don't ask again",
      );
    });
  });

  it('does not show first-run prompt when .minspec/ exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    activate(makeMockContext());

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does not show legacy welcome prompt when user has already seen it', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const ctx = makeMockContext();
    (ctx.workspaceState.get as ReturnType<typeof vi.fn>).mockReturnValue(true);

    activate(ctx);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
      'Welcome to MinSpec! Would you like to initialize SDD for this project?',
      'Initialize',
      'Not Now',
    );
  });

  it('runs bootstrap for each workspace folder (multi-root)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const ws = vscode.workspace as { workspaceFolders: unknown };
    const original = ws.workspaceFolders;
    ws.workspaceFolders = [
      { uri: { fsPath: '/tmp/wsA' } },
      { uri: { fsPath: '/tmp/wsB' } },
    ];
    try {
      activate(makeMockContext());
      await vi.waitFor(() => {
        const initOffers = (
          vscode.window.showInformationMessage as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          (c) =>
            typeof c[0] === 'string' && c[0].includes("isn't initialized"),
        );
        expect(initOffers.length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      ws.workspaceFolders = original;
    }
  });

  it('targets the active editor folder (not [0]) for all file watchers in a multi-root workspace (#123)', () => {
    const ws = vscode.workspace as {
      workspaceFolders: unknown;
    };
    const win = vscode.window as { activeTextEditor: unknown };
    const originalFolders = ws.workspaceFolders;
    const originalEditor = win.activeTextEditor;
    ws.workspaceFolders = [
      { uri: { fsPath: '/tmp/wsA' } },
      { uri: { fsPath: '/tmp/wsB' } },
    ];
    // Active editor lives in folder [1] (wsB) — every watcher base must follow.
    win.activeTextEditor = {
      document: { uri: { fsPath: '/tmp/wsB/specs/SPEC-001.md' } },
    };
    // Opt into the auto-classify git watcher so we cover that site too.
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, def: any) =>
        key === 'autoClassifyOnCommit' ? true : def,
      ),
    } as any);
    try {
      activate(makeMockContext());

      // The spec, ADR, traceability, approvals and git watchers are all
      // created; none may silently fall back to folder [0] (/tmp/wsA).
      expect(watcherPatternBases.length).toBeGreaterThanOrEqual(4);
      for (const base of watcherPatternBases) {
        expect(base).toBe('/tmp/wsB');
      }
    } finally {
      ws.workspaceFolders = originalFolders;
      win.activeTextEditor = originalEditor;
    }
  });

  it('runs minspec.init for the folder when the user picks Initialize', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(vscode.window.showInformationMessage).mockImplementation(
      ((msg: unknown) =>
        Promise.resolve(
          typeof msg === 'string' && msg.includes("isn't initialized")
            ? 'Initialize'
            : undefined,
        )) as unknown as typeof vscode.window.showInformationMessage,
    );

    activate(makeMockContext());

    // #123: init is invoked WITH the bootstrapped folder.
    // #213: a 3rd commandArg now flows (undefined for the init step).
    await vi.waitFor(() => {
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'minspec.init',
        '/tmp/test-workspace',
        undefined,
      );
    });
  });

  it('does not execute minspec.init when user clicks Not Now', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Not Now' as any,
    );

    activate(makeMockContext());

    // Allow the .then() microtask to resolve
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      'minspec.init',
    );
  });

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  it('pushes disposables into context.subscriptions', () => {
    activate(makeMockContext());

    // Tree providers (3) + CodeLens (2) + commands (18) + dispose/statusBar (2)
    // + watchers (3) + onDidSaveTextDocument (1) = lots
    expect(subscriptions.length).toBeGreaterThan(10);
  });
});

// =============================================================================
// showSpecPanel command
// =============================================================================

describe('showSpecPanel command', () => {
  it('shows error when no workspace is open', async () => {
    // Override workspaceFolders to simulate no workspace
    const origFolders = vscode.workspace.workspaceFolders;
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      value: undefined,
      configurable: true,
    });

    // Re-activate to get a command with empty workspaceRoot
    registeredCommands.clear();
    subscriptions = [];
    watcherCallIndex = 0;
    specWatcher = makeWatcher();
    adrWatcher = makeWatcher();
    traceWatcher = makeWatcher();

    activate(makeMockContext());
    await invokeCommand('minspec.showSpecPanel');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: No workspace folder open.',
    );

    // Restore
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      value: origFolders,
      configurable: true,
    });
  });

  it('shows spec panel when specFilePath argument is provided', async () => {
    activate(makeMockContext());

    await invokeCommand('minspec.showSpecPanel', '/tmp/test-workspace/specs/SPEC-001.md');

    expect(mockSpecPanel.show).toHaveBeenCalledWith(
      '/tmp/test-workspace/specs/SPEC-001.md',
    );
  });

  it('shows info message when no spec files found and no arg provided', async () => {
    // findActiveSpec returns null when specs dir doesn't exist
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      // .minspec/ exists (suppress first-run), but specs/ does not
      if (String(p).endsWith('.minspec')) return true;
      return false;
    });

    activate(makeMockContext());
    await invokeCommand('minspec.showSpecPanel');

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: No spec files found. Run "MinSpec: Initialize SDD Structure" first.',
    );
  });
});

// =============================================================================
// injectContext command
// =============================================================================

describe('injectContext command', () => {
  // A full T4/implementing spec on disk. The walk reads its file content via
  // fs.readFileSync; parseSpec (mocked) turns it into frontmatter. The id must
  // match what the user typed so the finder selects this file.
  const T4_SPEC_FILE = '/tmp/test-workspace/specs/SPEC-007-thing.md';
  const T4_FRONTMATTER = {
    id: 'SPEC-007',
    title: 'Real Feature Title',
    tier: 'T4',
    status: 'implementing',
    created: '2026-06-04',
    phases: {
      specify: 'done',
      clarify: 'done',
      plan: 'done',
      tasks: 'done',
      implement: 'in-progress',
    },
  };

  /**
   * Wire fs so the recursive spec walk finds exactly one spec file under
   * specs/, and parseSpec returns the given frontmatter for it.
   */
  function stubSpecOnDisk(frontmatter: Record<string, unknown>): void {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync as any).mockImplementation((dir: string) => {
      if (String(dir).endsWith('/specs')) {
        return [{ name: 'SPEC-007-thing.md', isDirectory: () => false }];
      }
      return [];
    });
    vi.mocked(fs.readFileSync as any).mockReturnValue('---\nraw spec\n---\n');
    vi.mocked(parseSpec as any).mockReturnValue({ frontmatter });
  }

  it('injects the spec REAL tier/status/phase from frontmatter, not fabricated T2/new (#149)', async () => {
    // Regression: the command used to hardcode tier:'T2', status:'new',
    // currentPhase:null and never read the spec — a never-wrong violation.
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('SPEC-007');
    stubSpecOnDisk(T4_FRONTMATTER);

    vi.mocked(detectTools as any).mockReturnValue({ claude: true });
    vi.mocked(getToolFilePath as any).mockReturnValue('/tmp/test-workspace/CLAUDE.md');

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    expect(injectContextToFile).toHaveBeenCalledTimes(1);
    const injected = vi.mocked(injectContextToFile).mock.calls[0][1];
    expect(injected.specId).toBe('SPEC-007');
    expect(injected.tier).toBe('T4');
    expect(injected.status).toBe('implementing');
    // first non-done phase from the phases map
    expect(injected.currentPhase).toBe('implement');
    expect(injected.title).toBe('Real Feature Title');
    // The fabricated defaults must NOT appear.
    expect(injected.tier).not.toBe('T2');
    expect(injected.status).not.toBe('new');
  });

  it('prompts only for spec ID (title comes from frontmatter), then injects into detected tools', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('SPEC-007');
    stubSpecOnDisk(T4_FRONTMATTER);

    vi.mocked(detectTools as any).mockReturnValue({ claude: true, agents: true });
    vi.mocked(getToolFilePath as any)
      .mockReturnValueOnce('/tmp/test-workspace/CLAUDE.md')
      .mockReturnValueOnce('/tmp/test-workspace/AGENTS.md');

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    // Single prompt now — title is no longer asked for.
    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
    expect(injectContextToFile).toHaveBeenCalledTimes(2);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Injected active spec context into 2 file(s).',
    );
  });

  it('errors and injects nothing when the spec cannot be found', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('SPEC-404');
    // No spec files on disk.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync as any).mockReturnValue([]);

    vi.mocked(detectTools as any).mockReturnValue({ claude: true });
    vi.mocked(getToolFilePath as any).mockReturnValue('/tmp/test-workspace/CLAUDE.md');

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    expect(injectContextToFile).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  it('aborts when user cancels spec ID input', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    expect(injectContextToFile).not.toHaveBeenCalled();
  });

  it('shows info when no AI tool config files detected', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('SPEC-007');
    stubSpecOnDisk(T4_FRONTMATTER);

    vi.mocked(detectTools as any).mockReturnValue({
      claude: false,
      cursor: false,
      cline: false,
      agents: false,
      windsurf: false,
    });

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    expect(injectContextToFile).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: No AI tool config files detected. Create CLAUDE.md, .cursorrules, etc. first.',
    );
  });
});

// =============================================================================
// removeContext command
// =============================================================================

describe('removeContext command', () => {
  it('removes context from all detected tool files', () => {
    vi.mocked(detectTools as any).mockReturnValue({
      claude: true,
      cursor: true,
      cline: false,
      agents: false,
      windsurf: false,
    });
    vi.mocked(getToolFilePath as any)
      .mockReturnValueOnce('/tmp/test-workspace/CLAUDE.md')
      .mockReturnValueOnce('/tmp/test-workspace/.cursorrules');

    activate(makeMockContext());
    invokeCommand('minspec.removeContext');

    expect(removeContextFromFile).toHaveBeenCalledTimes(2);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Removed active spec context from 2 file(s).',
    );
  });

  it('shows message when no AI tool config files found', () => {
    vi.mocked(detectTools as any).mockReturnValue({
      claude: false,
      cursor: false,
      cline: false,
      agents: false,
      windsurf: false,
    });

    activate(makeMockContext());
    invokeCommand('minspec.removeContext');

    expect(removeContextFromFile).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: No AI tool config files found.',
    );
  });
});

// =============================================================================
// handleFileSaveDriftCheck (via onDidSaveTextDocument)
// =============================================================================

describe('drift detection on file save', () => {
  it('does nothing when no session is active', () => {
    vi.mocked(loadSession as any).mockReturnValue(null);

    activate(makeMockContext());
    onSaveHandler!({
      uri: { fsPath: '/tmp/test-workspace/src/foo.ts' },
    });

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('does nothing for files outside the workspace', () => {
    vi.mocked(loadSession as any).mockReturnValue({
      scope: 'Add auth',
      project: 'minspec',
      type: 'feat',
    });

    activate(makeMockContext());
    onSaveHandler!({
      uri: { fsPath: '/other/project/foo.ts' },
    });

    expect(isFileInScope).not.toHaveBeenCalled();
  });

  it('does nothing for .minspec/ internal files', () => {
    vi.mocked(loadSession as any).mockReturnValue({
      scope: 'Add auth',
      project: 'minspec',
      type: 'feat',
    });

    activate(makeMockContext());
    onSaveHandler!({
      uri: { fsPath: '/tmp/test-workspace/.minspec/session.json' },
    });

    expect(isFileInScope).not.toHaveBeenCalled();
  });

  it('does nothing for package-lock.json', () => {
    vi.mocked(loadSession as any).mockReturnValue({
      scope: 'Add auth',
      project: 'minspec',
      type: 'feat',
    });

    activate(makeMockContext());
    onSaveHandler!({
      uri: { fsPath: '/tmp/test-workspace/package-lock.json' },
    });

    expect(isFileInScope).not.toHaveBeenCalled();
  });

  it('does nothing for node_modules files', () => {
    vi.mocked(loadSession as any).mockReturnValue({
      scope: 'Add auth',
      project: 'minspec',
      type: 'feat',
    });

    activate(makeMockContext());
    onSaveHandler!({
      uri: { fsPath: '/tmp/test-workspace/node_modules/foo/index.js' },
    });

    expect(isFileInScope).not.toHaveBeenCalled();
  });

  it('does nothing when file is in scope', () => {
    vi.mocked(loadSession as any).mockReturnValue({
      scope: 'Add auth',
      project: 'minspec',
      type: 'feat',
    });
    vi.mocked(isFileInScope as any).mockReturnValue(true);

    activate(makeMockContext());
    onSaveHandler!({
      uri: { fsPath: '/tmp/test-workspace/src/auth.ts' },
    });

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('shows drift warning when file is not in scope', () => {
    vi.mocked(loadSession as any).mockReturnValue({
      scope: 'Add auth',
      project: 'minspec',
      type: 'feat',
    });
    vi.mocked(isFileInScope as any).mockReturnValue(false);

    activate(makeMockContext());
    onSaveHandler!({
      uri: { fsPath: '/tmp/test-workspace/src/unrelated.ts' },
    });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('src/unrelated.ts'),
      'Park as Issue',
      'Add to Scope',
      'Dismiss',
    );
  });
});

// =============================================================================
// showDriftWarning (actions)
// =============================================================================

describe('drift warning actions', () => {
  beforeEach(() => {
    vi.mocked(loadSession as any).mockReturnValue({
      scope: 'Add auth',
      project: 'minspec',
      type: 'feat',
    });
    vi.mocked(isFileInScope as any).mockReturnValue(false);
  });

  it('parks as issue when user selects "Park as Issue"', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      'Park as Issue' as any,
    );

    activate(makeMockContext());
    onSaveHandler!({
      uri: { fsPath: '/tmp/test-workspace/src/drift.ts' },
    });

    await vi.waitFor(() => {
      expect(createParkingLotEntry).toHaveBeenCalled();
      expect(parkTopic).toHaveBeenCalled();
    });
  });

  it('adds to scope when user selects "Add to Scope"', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      'Add to Scope' as any,
    );

    activate(makeMockContext());
    onSaveHandler!({
      uri: { fsPath: '/tmp/test-workspace/src/drift.ts' },
    });

    await vi.waitFor(() => {
      expect(addToScope).toHaveBeenCalled();
      expect(saveSession).toHaveBeenCalled();
    });
  });

  it('does nothing when user dismisses', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      'Dismiss' as any,
    );

    activate(makeMockContext());
    onSaveHandler!({
      uri: { fsPath: '/tmp/test-workspace/src/drift.ts' },
    });

    // Wait for async to settle
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(createParkingLotEntry).not.toHaveBeenCalled();
    expect(addToScope).not.toHaveBeenCalled();
  });

  it('shows github issue URL when parkTopic returns github method', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      'Park as Issue' as any,
    );
    vi.mocked(parkTopic as any).mockResolvedValueOnce({
      method: 'github',
      url: 'https://github.com/test/repo/issues/42',
    });

    activate(makeMockContext());
    onSaveHandler!({
      uri: { fsPath: '/tmp/test-workspace/src/drift.ts' },
    });

    await vi.waitFor(() => {
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('https://github.com/test/repo/issues/42'),
      );
    });
  });
});

// =============================================================================
// deactivate()
// =============================================================================

describe('deactivate()', () => {
  it('is a callable no-op function', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('returns void', () => {
    const result = deactivate();
    expect(result).toBeUndefined();
  });
});
