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
const mockBacklogTreeProvider = { refresh: vi.fn() };
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

// Track tree data providers registered
const registeredTreeProviders = new Map<string, any>();

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
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    showInputBox: vi.fn(),
    showTextDocument: vi.fn(),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/test-workspace' } }],
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, def: any) => def),
    })),
    createFileSystemWatcher: vi.fn(() => {
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
vi.mock('../src/commands/status', () => ({
  statusCommand: vi.fn(),
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
}));
vi.mock('../src/commands/backlog', () => ({
  scoreWsjfCommand: vi.fn(),
  triageIssueCommand: vi.fn(),
}));
vi.mock('../src/views/spec-tree-provider', () => ({
  SpecTreeProvider: vi.fn(() => mockSpecTreeProvider),
}));
vi.mock('../src/views/adr-tree-provider', () => ({
  AdrTreeProvider: vi.fn(() => mockAdrTreeProvider),
}));
vi.mock('../src/views/backlog-view', () => ({
  BacklogTreeProvider: vi.fn(() => mockBacklogTreeProvider),
}));
vi.mock('../src/views/status-bar', () => ({
  MinSpecStatusBar: vi.fn(() => mockStatusBar),
}));
vi.mock('../src/views/spec-panel', () => ({
  SpecPanel: vi.fn(() => mockSpecPanel),
}));
vi.mock('../src/views/codelens-provider', () => ({
  MinSpecCodeLensProvider: vi.fn(() => mockCodeLensProvider),
  MinSpecSpecFileLensProvider: vi.fn(() => mockSpecFileLensProvider),
  goToSpecCommand: vi.fn(),
  goToCodeCommand: vi.fn(),
  linkToSpecCommand: vi.fn(),
}));
vi.mock('../src/lib/config', () => ({
  loadConfig: vi.fn(() => ({ specsDir: 'specs' })),
  applyVSCodeOverrides: vi.fn((c: any) => c),
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
vi.mock('../src/lib/spec', () => ({
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
import { scoreWsjfCommand, triageIssueCommand } from '../src/commands/backlog';
import {
  goToSpecCommand,
  goToCodeCommand,
  linkToSpecCommand,
} from '../src/views/codelens-provider';
import { detectTools, getToolFilePath } from '../src/lib/tool-detector';
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
  codeLensRegistrations.length = 0;
  onSaveHandler = undefined;

  // Reset watcher instances so each test gets fresh ones
  specWatcher = makeWatcher();
  adrWatcher = makeWatcher();
  traceWatcher = makeWatcher();
  watcherCallIndex = 0;

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

  it('constructs SpecPanel with context extensionUri', () => {
    const ctx = makeMockContext();
    activate(ctx);

    expect(SpecPanel).toHaveBeenCalledWith({ fsPath: '/tmp/ext' });
  });

  // -------------------------------------------------------------------------
  // File system watchers
  // -------------------------------------------------------------------------

  it('creates three file system watchers', () => {
    activate(makeMockContext());

    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(3);
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
    onChangeHandler();

    expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();
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

  it('shows first-run prompt when .minspec/ does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    activate(makeMockContext());

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Welcome to MinSpec! Would you like to initialize SDD for this project?',
      'Initialize',
      'Not Now',
    );
  });

  it('does not show first-run prompt when .minspec/ exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    activate(makeMockContext());

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does not show first-run prompt when user has already seen it', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const ctx = makeMockContext();
    (ctx.workspaceState.get as ReturnType<typeof vi.fn>).mockReturnValue(true);

    activate(ctx);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('sets workspaceState flag when showing first-run prompt', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const ctx = makeMockContext();
    activate(ctx);

    expect(ctx.workspaceState.update).toHaveBeenCalledWith(
      'minspec.firstRun',
      true,
    );
  });

  it('executes minspec.init when user clicks Initialize', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Initialize' as any,
    );

    activate(makeMockContext());

    // Allow the .then() microtask to resolve
    await vi.waitFor(() => {
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'minspec.init',
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
  it('prompts for spec ID and title, then injects into detected tools', async () => {
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('SPEC-005')
      .mockResolvedValueOnce('Auth Feature');

    vi.mocked(detectTools as any).mockReturnValue({
      claude: true,
      cursor: false,
      cline: false,
      agents: true,
      windsurf: false,
    });
    vi.mocked(getToolFilePath as any)
      .mockReturnValueOnce('/tmp/test-workspace/CLAUDE.md')
      .mockReturnValueOnce('/tmp/test-workspace/AGENTS.md');

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(2);
    expect(injectContextToFile).toHaveBeenCalledTimes(2);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Injected active spec context into 2 file(s).',
    );
  });

  it('aborts when user cancels spec ID input', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    expect(injectContextToFile).not.toHaveBeenCalled();
  });

  it('aborts when user cancels title input', async () => {
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('SPEC-005')
      .mockResolvedValueOnce(undefined);

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    expect(injectContextToFile).not.toHaveBeenCalled();
  });

  it('shows info when no AI tool config files detected', async () => {
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('SPEC-005')
      .mockResolvedValueOnce('Auth Feature');

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
