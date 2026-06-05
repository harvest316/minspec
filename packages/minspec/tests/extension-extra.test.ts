import { describe, it, expect, vi, beforeEach } from 'vitest';

// ===========================================================================
// extension-extra.test.ts
//
// Companion to extension.test.ts. The base test exercises command wiring,
// watchers, drift detection and first-run. This file targets the regions
// that base test leaves uncovered (reported by `vitest --coverage`):
//
//   • lines 379-399 — the `autoClassifyOnCommit` git watcher block
//   • lines 401-407 — the conformance auto-export watcher block
//   • lines 418-434 — exportTraceabilityCommand (success / error / no-root)
//   • lines 447-481 — resolveSpecFrontmatter recursive walk (via injectContext)
//   • lines 550-551 — removeContextCommand early-return when no workspace
//
// It uses its OWN isolated module mocks (Vitest scopes vi.mock per file), so
// it can stub bridge + auto-bootstrap — which the base harness leaves real —
// and drive each branch deterministically.
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const registeredCommands = new Map<string, (...args: any[]) => any>();
let subscriptions: any[] = [];

const mockSpecTreeProvider = { refresh: vi.fn(), epicGrouping: { set: vi.fn(), toggle: vi.fn(() => true) } };
const mockAdrTreeProvider = { refresh: vi.fn(), epicGrouping: { set: vi.fn(), toggle: vi.fn(() => true) } };
const mockBacklogTreeProvider = { refresh: vi.fn(), refreshIfStale: vi.fn(), epicGrouping: { set: vi.fn(), toggle: vi.fn(() => true) } };
const mockStatusBar = { update: vi.fn(), dispose: vi.fn() };
const mockSpecPanel = { show: vi.fn(), refresh: vi.fn(), dispose: vi.fn() };
const mockCodeLensProvider = { refresh: vi.fn() };
const mockSpecFileLensProvider = { refresh: vi.fn() };

// File watcher factory — captures onDid* callbacks so tests can fire them.
const makeWatcher = () => ({
  onDidChange: vi.fn(),
  onDidCreate: vi.fn(),
  onDidDelete: vi.fn(),
  dispose: vi.fn(),
});

// Each createFileSystemWatcher call gets its own fresh watcher; we keep them
// all so a test can reach the git watcher (created last, conditionally).
let createdWatchers: ReturnType<typeof makeWatcher>[] = [];

// Config the activation reads. Tests mutate this object before calling
// activate() to flip autoClassifyOnCommit etc.
let configValues: Record<string, any> = {};

// Conformance watcher disposable returned by the (mocked) bridge helper.
let conformanceWatcherDisposable: { dispose: () => void } | undefined;

// ---------------------------------------------------------------------------
// vscode mock
// ---------------------------------------------------------------------------

vi.mock('vscode', () => ({
  window: {
    createTreeView: vi.fn(() => ({
      dispose: vi.fn(),
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
    })),
    onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
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
      get: vi.fn((key: string, def: any) =>
        Object.prototype.hasOwnProperty.call(configValues, key)
          ? configValues[key]
          : def,
      ),
    })),
    createFileSystemWatcher: vi.fn(() => {
      const w = makeWatcher();
      createdWatchers.push(w);
      return w;
    }),
    openTextDocument: vi.fn(() => Promise.resolve({})),
    onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: any[]) => any) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
  },
  languages: {
    registerCodeLensProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
  extensions: {
    getExtension: vi.fn(() => undefined),
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
    constructor(public label: string, public collapsibleState: number) {}
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file' }),
    parse: (s: string) => ({ toString: () => s }),
  },
  ViewColumn: { Beside: 2 },
  RelativePattern: class {
    constructor(public base: any, public pattern: string) {}
  },
}));

// ---------------------------------------------------------------------------
// Lib / view mocks
// ---------------------------------------------------------------------------

vi.mock('../src/commands/init', () => ({ initCommand: vi.fn(), initRefreshCommand: vi.fn() }));
vi.mock('../src/commands/classify', () => ({ classifyCommand: vi.fn() }));
vi.mock('../src/commands/status', () => ({ statusCommand: vi.fn(() => vi.fn()) }));
vi.mock('../src/commands/session', () => ({ declareScopeCommand: vi.fn() }));
vi.mock('../src/commands/park', () => ({ parkCommand: vi.fn() }));
vi.mock('../src/commands/example', () => ({ generateExampleCommand: vi.fn() }));
vi.mock('../src/commands/migrate', () => ({ migrateLayoutCommand: vi.fn() }));
vi.mock('../src/commands/adr', () => ({
  createAdrCommand: vi.fn(),
  regenerateDrIndexCommand: vi.fn(),
  acceptAdrCommand: vi.fn(),
  setAdrStatusCommand: vi.fn(),
}));
vi.mock('../src/commands/epic', () => ({
  createEpicCommand: vi.fn(),
  regenerateEpicIndexCommand: vi.fn(),
  acceptEpicCommand: vi.fn(),
}));
vi.mock('../src/commands/backfill-epics', () => ({ backfillEpicsCommand: vi.fn() }));
vi.mock('../src/lib/adr-manager', () => ({ regenerateDrIndex: vi.fn() }));
vi.mock('../src/commands/backlog', () => ({ scoreWsjfCommand: vi.fn(), triageIssueCommand: vi.fn() }));
vi.mock('../src/commands/approve', () => ({ approveSpecCommand: vi.fn(), revokeApprovalCommand: vi.fn() }));
vi.mock('../src/commands/validate', () => ({ validateSpecCommand: vi.fn() }));
vi.mock('../src/views/spec-tree-provider', () => ({
  SpecTreeProvider: vi.fn(function () { return mockSpecTreeProvider; }),
}));
vi.mock('../src/views/adr-tree-provider', () => ({
  AdrTreeProvider: vi.fn(function () { return mockAdrTreeProvider; }),
}));
vi.mock('../src/views/backlog-view', () => ({
  BacklogTreeProvider: vi.fn(function () { return mockBacklogTreeProvider; }),
}));
vi.mock('../src/views/frontmatter-completion', () => ({
  FrontmatterCompletionProvider: vi.fn(function () { return {}; }),
}));
// Partial mock: keep real pure helpers (fromFrontmatter) so injectContext can
// derive currentPhase the same way the status bar does.
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
// Partial mock: stub loaders, forward real exports.
vi.mock('../src/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/config')>()),
  loadConfig: vi.fn(() => ({ specsDir: 'specs' })),
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
  parkTopic: vi.fn(() => Promise.resolve({ method: 'file', filePath: '/tmp/test' })),
  createParkingLotEntry: vi.fn(() => ({})),
}));
vi.mock('../src/lib/active-spec', () => ({
  findActiveSpec: vi.fn(() => Promise.resolve(null)),
  trackActiveSpecEditor: vi.fn(),
}));
vi.mock('../src/lib/active-adr', () => ({
  trackActiveAdrEditor: vi.fn(),
}));
vi.mock('../src/lib/resolve-folder', () => ({
  resolveTargetFolderNonInteractive: vi.fn(() => '/tmp/test-workspace'),
}));
// Bridge is fully stubbed so the conformance/nudge/export sites are driveable.
vi.mock('../src/lib/bridge', () => ({
  maybeShowNudge: vi.fn(() => Promise.resolve(false)),
  recordInstallTimestamp: vi.fn(),
  exportTraceability: vi.fn(() => ({ filePath: '/tmp/test-workspace/.minspec/traceability-export.json', specCount: 3 })),
  setupConformanceWatcher: vi.fn(() => conformanceWatcherDisposable),
}));
// Auto-bootstrap stubbed: runBootstrap is a no-op promise; isWatchedGitPath
// uses the real predicate so the git-watcher filter is exercised honestly.
vi.mock('../src/lib/auto-bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auto-bootstrap')>()),
  runBootstrap: vi.fn(() => Promise.resolve()),
}));
// Partial mock: stub parseSpec, forward real exports.
vi.mock('../src/lib/spec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/spec')>()),
  parseSpec: vi.fn(() => ({ frontmatter: { id: 'SPEC-000' } })),
}));
vi.mock('fs');
vi.mock('path', async () => {
  const actual = await vi.importActual('path');
  return actual;
});

// ---------------------------------------------------------------------------
// SUT + mocked-import handles
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as fs from 'fs';
import { activate } from '../src/extension';
import {
  setupConformanceWatcher,
  exportTraceability,
  recordInstallTimestamp,
  maybeShowNudge,
} from '../src/lib/bridge';
import { detectTools, getToolFilePath } from '../src/lib/tool-detector';
import { injectContextToFile, removeContextFromFile } from '../src/lib/context-injector';
import { parseSpec } from '../src/lib/spec';
import { loadConfig, resolveAndValidate } from '../src/lib/config';
import { createEpicCommand, acceptEpicCommand, regenerateEpicIndexCommand } from '../src/commands/epic';
import { backfillEpicsCommand } from '../src/commands/backfill-epics';
import { acceptAdrCommand, setAdrStatusCommand, regenerateDrIndexCommand } from '../src/commands/adr';
import { approveSpecCommand, revokeApprovalCommand } from '../src/commands/approve';
import { validateSpecCommand } from '../src/commands/validate';
import { migrateLayoutCommand } from '../src/commands/migrate';
import { parkCommand } from '../src/commands/park';
import { regenerateDrIndex } from '../src/lib/adr-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockContext(overrides: Partial<Record<string, any>> = {}) {
  return {
    extensionUri: { fsPath: '/tmp/ext' },
    subscriptions,
    globalState: { get: vi.fn(() => undefined), update: vi.fn() },
    workspaceState: { get: vi.fn((_k: string, def: any) => def), update: vi.fn() },
    ...overrides,
  } as unknown as vscode.ExtensionContext;
}

function invokeCommand(id: string, ...args: any[]): any {
  const handler = registeredCommands.get(id);
  if (!handler) throw new Error(`Command "${id}" was never registered`);
  return handler(...args);
}

beforeEach(() => {
  vi.clearAllMocks();
  registeredCommands.clear();
  subscriptions = [];
  createdWatchers = [];
  configValues = {};
  conformanceWatcherDisposable = undefined;

  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readdirSync as any).mockReturnValue([]);
});

// ===========================================================================
// Auto-classify-on-commit git watcher (lines 379-399)
// ===========================================================================

describe('auto-classify git watcher', () => {
  it('does NOT create a git watcher when autoClassifyOnCommit is disabled (default)', () => {
    configValues = {}; // autoClassifyOnCommit defaults to false
    activate(makeMockContext());

    // 4 standard watchers (specs, adrs, traceability, approvals), no git watcher.
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(4);
  });

  it('creates a git watcher and fires classify only for watched git paths when enabled', () => {
    configValues = { autoClassifyOnCommit: true };
    activate(makeMockContext());

    // The git watcher is the 5th (index 4) created.
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(5);
    const gitWatcher = createdWatchers[4];
    expect(gitWatcher.onDidChange).toHaveBeenCalled();
    expect(gitWatcher.onDidCreate).toHaveBeenCalled();

    const trigger = gitWatcher.onDidChange.mock.calls[0][0] as (u: any) => void;

    // A non-watched path (e.g. .git/config) must be ignored.
    trigger({ fsPath: '/tmp/test-workspace/.git/config' });
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('minspec.classify');

    // A watched path (.git/HEAD) triggers the classify command.
    trigger({ fsPath: '/tmp/test-workspace/.git/HEAD' });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('minspec.classify');

    // A refs/heads/* path also triggers (covers the onDidCreate handler too).
    const triggerCreate = gitWatcher.onDidCreate.mock.calls[0][0] as (u: any) => void;
    vi.mocked(vscode.commands.executeCommand).mockClear();
    triggerCreate({ fsPath: '/tmp/test-workspace/.git/refs/heads/main' });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('minspec.classify');
  });
});

// ===========================================================================
// Conformance auto-export watcher (lines 401-407)
// ===========================================================================

describe('conformance auto-export watcher', () => {
  it('pushes the conformance watcher into subscriptions when one is returned', () => {
    const disposable = { dispose: vi.fn() };
    conformanceWatcherDisposable = disposable;

    activate(makeMockContext());

    expect(setupConformanceWatcher).toHaveBeenCalledWith('/tmp/test-workspace');
    expect(subscriptions).toContain(disposable);
  });

  it('does not push anything when setupConformanceWatcher returns undefined', () => {
    conformanceWatcherDisposable = undefined;

    activate(makeMockContext());

    expect(setupConformanceWatcher).toHaveBeenCalledWith('/tmp/test-workspace');
    // No watcher disposable means no extra (undefined) subscription entry.
    expect(subscriptions).not.toContain(undefined);
  });

  it('records install timestamp and attempts the nudge on activation', () => {
    activate(makeMockContext());
    expect(recordInstallTimestamp).toHaveBeenCalled();
    expect(maybeShowNudge).toHaveBeenCalled();
  });
});

// ===========================================================================
// exportTraceabilityCommand (lines 418-434)
// ===========================================================================

describe('exportTraceability command', () => {
  it('exports and reports the spec count + filename on success', () => {
    vi.mocked(exportTraceability).mockReturnValueOnce({
      filePath: '/tmp/test-workspace/.minspec/traceability-export.json',
      specCount: 7,
    });

    activate(makeMockContext());
    invokeCommand('minspec.exportTraceability');

    expect(exportTraceability).toHaveBeenCalledWith('/tmp/test-workspace');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Exported traceability for 7 spec(s) to traceability-export.json.',
    );
  });

  it('surfaces an error message when exportTraceability throws an Error', () => {
    vi.mocked(exportTraceability).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    activate(makeMockContext());
    invokeCommand('minspec.exportTraceability');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to export traceability — disk full',
    );
  });

  it('surfaces a stringified error when exportTraceability throws a non-Error', () => {
    vi.mocked(exportTraceability).mockImplementationOnce(() => {
      throw 'boom'; // eslint-disable-line no-throw-literal
    });

    activate(makeMockContext());
    invokeCommand('minspec.exportTraceability');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to export traceability — boom',
    );
  });

  it('shows the no-workspace error when workspaceRoot is empty', async () => {
    const { resolveTargetFolderNonInteractive } = await import('../src/lib/resolve-folder');
    vi.mocked(resolveTargetFolderNonInteractive).mockReturnValueOnce('');

    activate(makeMockContext());
    invokeCommand('minspec.exportTraceability');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: No workspace folder open.',
    );
    expect(exportTraceability).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// resolveSpecFrontmatter recursive walk (lines 447-481, via injectContext)
// ===========================================================================

describe('resolveSpecFrontmatter (via injectContext)', () => {
  it('returns null (and errors) when loadConfig throws — config resolution guard', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('SPEC-001');
    vi.mocked(loadConfig).mockImplementationOnce(() => {
      throw new Error('bad config');
    });

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    // Walk bailed at the config try/catch → frontmatter null → not-found error.
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('SPEC-001 not found'),
    );
    expect(injectContextToFile).not.toHaveBeenCalled();
  });

  it('returns null when the specs dir does not exist', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('SPEC-001');
    vi.mocked(resolveAndValidate).mockReturnValueOnce('/tmp/test-workspace/specs');
    // specs dir missing → existsSync false for the specsDir check.
    vi.mocked(fs.existsSync).mockReturnValue(false);

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('SPEC-001 not found'),
    );
  });

  it('recurses into subdirectories and skips unreadable dirs and unparseable files', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('SPEC-042');
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // Directory layout:
    //   specs/                 → [feature/ (dir), bad/ (dir, unreadable), broken.md, SPEC-042.md]
    //   specs/feature/         → [nested.md]  (parseable but wrong id → skipped)
    //   specs/bad/             → readdir throws (covers the inner try/catch)
    vi.mocked(fs.readdirSync as any).mockImplementation((dir: string) => {
      const d = String(dir);
      if (d.endsWith('/specs')) {
        return [
          { name: 'feature', isDirectory: () => true },
          { name: 'bad', isDirectory: () => true },
          { name: 'broken.md', isDirectory: () => false },
          { name: 'SPEC-042.md', isDirectory: () => false },
          { name: 'notes.txt', isDirectory: () => false }, // non-.md → ignored
        ];
      }
      if (d.endsWith('/feature')) {
        return [{ name: 'nested.md', isDirectory: () => false }];
      }
      if (d.endsWith('/bad')) {
        throw new Error('EACCES'); // unreadable dir → continue
      }
      return [];
    });

    vi.mocked(fs.readFileSync as any).mockReturnValue('---\nraw\n---\n');
    vi.mocked(parseSpec as any).mockImplementation((content: string) => {
      void content;
      // Track which file is being parsed via call order isn't reliable, so key
      // off a side channel: readFileSync was just called with the full path.
      const lastRead = vi.mocked(fs.readFileSync).mock.calls.at(-1)?.[0] as string;
      if (String(lastRead).endsWith('broken.md')) {
        throw new Error('unparseable'); // covers the inner parse try/catch
      }
      if (String(lastRead).endsWith('nested.md')) {
        return { frontmatter: { id: 'SPEC-999', title: 'Other', tier: 'T1', status: 'new' } };
      }
      if (String(lastRead).endsWith('SPEC-042.md')) {
        return {
          frontmatter: {
            id: 'SPEC-042',
            title: 'Found It',
            tier: 'T3',
            status: 'implementing',
            phases: { specify: 'done', plan: 'in-progress' },
          },
        };
      }
      return { frontmatter: { id: 'SPEC-x' } };
    });

    vi.mocked(detectTools as any).mockReturnValue({ claude: true });
    vi.mocked(getToolFilePath as any).mockReturnValue('/tmp/test-workspace/CLAUDE.md');

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    // The walk found SPEC-042 despite the dir recursion, unreadable dir, and
    // unparseable sibling — and injected its REAL frontmatter.
    expect(injectContextToFile).toHaveBeenCalledTimes(1);
    const injected = vi.mocked(injectContextToFile).mock.calls[0][1];
    expect(injected.specId).toBe('SPEC-042');
    expect(injected.tier).toBe('T3');
    expect(injected.status).toBe('implementing');
    expect(injected.title).toBe('Found It');
    // first non-done phase is plan (in-progress).
    expect(injected.currentPhase).toBe('plan');
  });

  it('continues past an unreadable directory while walking with no match (covers readdir catch)', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('SPEC-404');
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // No file carries SPEC-404, so the WHOLE tree is walked — including the
    // unreadable `bad/` dir whose readdir throws (exercises the continue path).
    vi.mocked(fs.readdirSync as any).mockImplementation((dir: string) => {
      const d = String(dir);
      if (d.endsWith('/specs')) {
        return [{ name: 'bad', isDirectory: () => true }];
      }
      if (d.endsWith('/bad')) {
        throw new Error('EACCES'); // unreadable dir → continue (line 464)
      }
      return [];
    });
    vi.mocked(fs.readFileSync as any).mockReturnValue('---\nraw\n---\n');
    vi.mocked(parseSpec as any).mockReturnValue({ frontmatter: { id: 'SPEC-OTHER' } });

    vi.mocked(detectTools as any).mockReturnValue({ claude: true });
    vi.mocked(getToolFilePath as any).mockReturnValue('/tmp/test-workspace/CLAUDE.md');

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    // Walk completed with no match → not-found error, nothing injected.
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('SPEC-404 not found'),
    );
    expect(injectContextToFile).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// injectContextCommand no-workspace early return (lines 488-489)
// ===========================================================================

describe('injectContext command — no workspace', () => {
  it('shows the no-workspace error and injects nothing when workspaceRoot is empty', async () => {
    const { resolveTargetFolderNonInteractive } = await import('../src/lib/resolve-folder');
    vi.mocked(resolveTargetFolderNonInteractive).mockReturnValueOnce('');

    activate(makeMockContext());
    await invokeCommand('minspec.injectContext');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: No workspace folder open.',
    );
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(injectContextToFile).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// onSpecsChanged status-bar refresh path (lines 257-268)
// ===========================================================================

describe('spec watcher onSpecsChanged status-bar update', () => {
  it('reads + parses the active spec and updates the status bar from its frontmatter', async () => {
    const { findActiveSpec } = await import('../src/lib/active-spec');
    const SPEC_PATH = '/tmp/test-workspace/specs/SPEC-001.md';
    vi.mocked(findActiveSpec).mockResolvedValue(SPEC_PATH);
    vi.mocked(fs.readFileSync as any).mockReturnValue('---\nraw\n---\n');
    vi.mocked(parseSpec as any).mockReturnValue({
      frontmatter: {
        id: 'SPEC-001',
        title: 'X',
        tier: 'T2',
        status: 'specifying',
        phases: { specify: 'in-progress', plan: 'pending' },
      },
    });

    activate(makeMockContext());

    // The spec watcher is the first watcher created (index 0).
    const specWatcher = createdWatchers[0];
    const onChange = specWatcher.onDidChange.mock.calls[0][0] as () => Promise<void>;
    mockStatusBar.update.mockClear();

    await onChange();

    expect(mockSpecTreeProvider.refresh).toHaveBeenCalled();
    expect(mockSpecPanel.refresh).toHaveBeenCalled();
    // It updated with a non-null payload derived from the parsed frontmatter.
    expect(mockStatusBar.update).toHaveBeenCalled();
    expect(mockStatusBar.update.mock.calls.at(-1)?.[0]).not.toBeNull();
  });

  it('falls back to status-bar update(null) when reading the active spec throws', async () => {
    const { findActiveSpec } = await import('../src/lib/active-spec');
    vi.mocked(findActiveSpec).mockResolvedValue('/tmp/test-workspace/specs/SPEC-001.md');
    vi.mocked(fs.readFileSync as any).mockImplementation(() => {
      throw new Error('gone');
    });

    activate(makeMockContext());

    const specWatcher = createdWatchers[0];
    const onChange = specWatcher.onDidChange.mock.calls[0][0] as () => Promise<void>;
    mockStatusBar.update.mockClear();

    await onChange();

    expect(mockStatusBar.update).toHaveBeenLastCalledWith(null);
  });

  it('updates status bar with null when there is no active spec', async () => {
    const { findActiveSpec } = await import('../src/lib/active-spec');
    vi.mocked(findActiveSpec).mockResolvedValue(null);

    activate(makeMockContext());

    const specWatcher = createdWatchers[0];
    const onChange = specWatcher.onDidChange.mock.calls[0][0] as () => Promise<void>;
    mockStatusBar.update.mockClear();

    await onChange();

    expect(mockStatusBar.update).toHaveBeenLastCalledWith(null);
  });
});

// ===========================================================================
// removeContextCommand no-workspace early return (lines 550-551)
// ===========================================================================

describe('removeContext command — no workspace', () => {
  it('shows the no-workspace error and removes nothing when workspaceRoot is empty', async () => {
    const { resolveTargetFolderNonInteractive } = await import('../src/lib/resolve-folder');
    vi.mocked(resolveTargetFolderNonInteractive).mockReturnValueOnce('');

    activate(makeMockContext());
    invokeCommand('minspec.removeContext');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: No workspace folder open.',
    );
    expect(removeContextFromFile).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Refresh-wrapping command callbacks (lines 167-223)
//
// The base test asserts these commands are REGISTERED but never invokes most
// of the async refresh-wrapping wrappers (createEpic, acceptEpic, backfill,
// acceptAdr, setAdrStatus, approveSpec, revokeApproval, validateSpec, the
// index regenerators, migrateLayout). Invoking each one covers its body +
// delegation.
// ===========================================================================

describe('refresh-wrapping command callbacks', () => {
  it('createEpic delegates then refreshes all three trees', async () => {
    activate(makeMockContext());
    await invokeCommand('minspec.createEpic');
    expect(createEpicCommand).toHaveBeenCalled();
    expect(mockSpecTreeProvider.refresh).toHaveBeenCalled();
    expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();
    expect(mockBacklogTreeProvider.refresh).toHaveBeenCalled();
  });

  it('acceptEpic delegates with the node then refreshes all three trees', async () => {
    activate(makeMockContext());
    const node = { epic: { slug: 'x' } };
    await invokeCommand('minspec.acceptEpic', node);
    expect(acceptEpicCommand).toHaveBeenCalledWith(node);
    expect(mockSpecTreeProvider.refresh).toHaveBeenCalled();
    expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();
    expect(mockBacklogTreeProvider.refresh).toHaveBeenCalled();
  });

  it('backfillEpics forwards the folder arg then refreshes all three trees', async () => {
    activate(makeMockContext());
    await invokeCommand('minspec.backfillEpics', '/tmp/test-workspace');
    expect(backfillEpicsCommand).toHaveBeenCalledWith('/tmp/test-workspace');
    expect(mockSpecTreeProvider.refresh).toHaveBeenCalled();
    expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();
    expect(mockBacklogTreeProvider.refresh).toHaveBeenCalled();
  });

  it('regenerateEpicIndex / regenerateDrIndex delegate to their commands', () => {
    activate(makeMockContext());
    invokeCommand('minspec.regenerateEpicIndex');
    expect(regenerateEpicIndexCommand).toHaveBeenCalled();
    invokeCommand('minspec.regenerateDrIndex');
    expect(regenerateDrIndexCommand).toHaveBeenCalled();
  });

  it('acceptAdr delegates with the node then refreshes the ADR tree', async () => {
    activate(makeMockContext());
    const node = { adr: { id: 'DR-001' } };
    await invokeCommand('minspec.acceptAdr', node);
    expect(acceptAdrCommand).toHaveBeenCalledWith(node);
    expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();
  });

  it('setAdrStatus delegates with the node then refreshes the ADR tree', async () => {
    activate(makeMockContext());
    const node = { adr: { id: 'DR-002' } };
    await invokeCommand('minspec.setAdrStatus', node);
    expect(setAdrStatusCommand).toHaveBeenCalledWith(node);
    expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();
  });

  // approve/revoke fire `minspec.refreshTree` INSIDE the command, so the wrapper
  // must NOT add its own refresh — doing so only fed the redundant rebuild burst
  // that froze the UI (issue #154). Assert delegation + no wrapper-level refresh.
  it('approveSpec delegates with the node and does not add a redundant refresh', async () => {
    activate(makeMockContext());
    const node = { spec: { id: 'SPEC-001' } };
    await invokeCommand('minspec.approveSpec', node);
    expect(approveSpecCommand).toHaveBeenCalledWith(node);
    expect(mockSpecTreeProvider.refresh).not.toHaveBeenCalled();
  });

  it('revokeApproval delegates with the node and does not add a redundant refresh', async () => {
    activate(makeMockContext());
    const node = { spec: { id: 'SPEC-002' } };
    await invokeCommand('minspec.revokeApproval', node);
    expect(revokeApprovalCommand).toHaveBeenCalledWith(node);
    expect(mockSpecTreeProvider.refresh).not.toHaveBeenCalled();
  });

  it('validateSpec delegates with the node', () => {
    activate(makeMockContext());
    const node = { spec: { id: 'SPEC-003' } };
    invokeCommand('minspec.validateSpec', node);
    expect(validateSpecCommand).toHaveBeenCalledWith(node);
  });

  it('migrateLayout delegates with the workspace root', () => {
    activate(makeMockContext());
    invokeCommand('minspec.migrateLayout');
    expect(migrateLayoutCommand).toHaveBeenCalledWith('/tmp/test-workspace');
  });

  it('park forwards no options; parkForce forwards { force: true }', () => {
    activate(makeMockContext());
    invokeCommand('minspec.park');
    expect(parkCommand).toHaveBeenLastCalledWith();
    invokeCommand('minspec.parkForce');
    expect(parkCommand).toHaveBeenLastCalledWith({ force: true });
  });

  it('the SpecPanel dispose subscription disposes the panel', () => {
    activate(makeMockContext());
    // activate() pushes a plain `{ dispose: () => specPanel.dispose() }`
    // disposable whose `dispose` is a real arrow closure — not a vitest mock
    // (registration disposables use `{ dispose: vi.fn() }`, which carry a
    // `.mock` property). That distinguishes the panel disposable uniquely.
    const panelDisposable = subscriptions.find(
      (s) =>
        s &&
        typeof s === 'object' &&
        Object.keys(s).length === 1 &&
        typeof s.dispose === 'function' &&
        !('mock' in s.dispose),
    );
    expect(panelDisposable).toBeDefined();
    panelDisposable.dispose();
    expect(mockSpecPanel.dispose).toHaveBeenCalled();
  });
});

// ===========================================================================
// Epic-grouping toggles (lines 82-92, 187-189)
// ===========================================================================

describe('epic grouping toggles', () => {
  it('seeds each provider grouping from workspaceState on activation', () => {
    const ctx = makeMockContext();
    activate(ctx);
    // The three providers each get a .set(...) call seeding their default.
    expect(mockSpecTreeProvider.epicGrouping.set).toHaveBeenCalled();
    expect(mockAdrTreeProvider.epicGrouping.set).toHaveBeenCalled();
    expect(mockBacklogTreeProvider.epicGrouping.set).toHaveBeenCalled();
    // Spec/ADR default ON, Backlog default OFF.
    expect(mockSpecTreeProvider.epicGrouping.set).toHaveBeenCalledWith(true);
    expect(mockBacklogTreeProvider.epicGrouping.set).toHaveBeenCalledWith(false);
  });

  it('toggling the spec-explorer grouping flips state, persists, and refreshes', async () => {
    const ctx = makeMockContext();
    activate(ctx);
    await invokeCommand('minspec.specExplorer.toggleEpicGrouping');
    expect(mockSpecTreeProvider.epicGrouping.toggle).toHaveBeenCalled();
    expect(ctx.workspaceState.update).toHaveBeenCalledWith(
      'minspec.specExplorer.groupByEpic',
      true,
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'minspec.specExplorer.groupByEpic',
      true,
    );
    expect(mockSpecTreeProvider.refresh).toHaveBeenCalled();
  });

  it('toggling the ADR and backlog groupings also flips and refreshes', async () => {
    activate(makeMockContext());
    await invokeCommand('minspec.adrExplorer.toggleEpicGrouping');
    expect(mockAdrTreeProvider.epicGrouping.toggle).toHaveBeenCalled();
    expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();

    await invokeCommand('minspec.backlog.toggleEpicGrouping');
    expect(mockBacklogTreeProvider.epicGrouping.toggle).toHaveBeenCalled();
    expect(mockBacklogTreeProvider.refresh).toHaveBeenCalled();
  });
});

// ===========================================================================
// onAdrsChanged guard branches (lines 294, 298)
// ===========================================================================

describe('ADR watcher onAdrsChanged guards', () => {
  it('returns before scheduling a regenerate when workspaceRoot is empty (line 294)', async () => {
    vi.useFakeTimers();
    try {
      const { resolveTargetFolderNonInteractive } = await import('../src/lib/resolve-folder');
      vi.mocked(resolveTargetFolderNonInteractive).mockReturnValueOnce('');

      activate(makeMockContext());

      // adr watcher is the 2nd watcher created (specs=0, adrs=1).
      const adrWatcher = createdWatchers[1];
      const onChange = adrWatcher.onDidChange.mock.calls[0][0] as (u: any) => void;
      vi.mocked(regenerateDrIndex).mockClear();

      // A normal DR change with an empty root → tree refreshes, but the
      // !workspaceRoot guard returns before the debounce is armed.
      onChange({ fsPath: '/docs/decisions/DR-009.md' });
      expect(mockAdrTreeProvider.refresh).toHaveBeenCalled();

      vi.advanceTimersByTime(300);
      expect(regenerateDrIndex).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes undefined options to regenerateDrIndex when decisionsDir is empty (line 298)', () => {
    vi.useFakeTimers();
    try {
      configValues = { decisionsDir: '' };
      activate(makeMockContext());

      const adrWatcher = createdWatchers[1];
      const onChange = adrWatcher.onDidChange.mock.calls[0][0] as (u: any) => void;
      vi.mocked(regenerateDrIndex).mockClear();

      onChange({ fsPath: '/tmp/test-workspace/docs/decisions/DR-009.md' });
      vi.advanceTimersByTime(300);

      // The `decisionsDir ? {decisionsDir} : undefined` ternary takes the
      // undefined branch when decisionsDir is the empty string.
      expect(regenerateDrIndex).toHaveBeenCalledWith('/tmp/test-workspace', undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});
