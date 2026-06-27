import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock vscode ───────────────────────────────────────────────────────────

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    withProgress: vi.fn((_opts: unknown, task: () => unknown) => task()),
    showTextDocument: vi.fn(),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/test-workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
    openTextDocument: vi.fn(() => Promise.resolve({})),
    getWorkspaceFolder: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  env: {
    openExternal: vi.fn(),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file' }),
    parse: (s: string) => ({ toString: () => s }),
  },
  ProgressLocation: { Notification: 15 },
  TreeItem: class {
    constructor(
      public label: string,
      public collapsibleState: number,
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    event = vi.fn();
    fire = vi.fn();
  },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
}));

// ─── Mock lib modules ──────────────────────────────────────────────────────

vi.mock('../src/lib/scaffold', () => ({
  scaffold: vi.fn(),
  generateHarnessFiles: vi.fn(),
  refreshHarnessFiles: vi.fn(),
}));

vi.mock('../src/lib/adr-manager', () => ({
  createAdr: vi.fn(),
  findSimilarAdrs: vi.fn(() => []),
  listAdrs: vi.fn(() => []),
  setAdrStatus: vi.fn(),
  adrHasFrontmatter: vi.fn(() => true),
  regenerateDrIndex: vi.fn(),
  ADR_STATUS_VALUES: ['proposed', 'accepted', 'deprecated', 'superseded'],
}));

vi.mock('../src/lib/active-spec', () => ({
  findActiveSpec: vi.fn(),
  summarizeActiveSpec: vi.fn(),
}));

vi.mock('../src/lib/config', async (importOriginal) => ({
  ...(await importOriginal()),
  loadConfig: vi.fn(() => ({ specsDir: 'specs', decisionsDir: 'docs/decisions' })),
  applyVSCodeOverrides: vi.fn(
    (config: Record<string, unknown>) => config,
  ),
  resolveAndValidate: vi.fn((root: string, sub: string) => `${root}/${sub}`),
}));

vi.mock('../src/lib/session', () => ({
  loadSession: vi.fn(),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
  createSession: vi.fn(
    (scope: string, project: string, type: string) => ({
      scope,
      project,
      type,
      startedAt: '2026-05-27T00:00:00.000Z',
      specIds: [],
      fileAllowlist: [],
    }),
  ),
}));

vi.mock('../src/lib/parking-lot', () => ({
  createParkingLotEntry: vi.fn(
    (title: string, body: string, sessionScope: string, labels: string[]) => ({
      title,
      body,
      labels,
      sessionScope,
      createdAt: '2026-05-27T00:00:00.000Z',
    }),
  ),
  parkTopic: vi.fn(),
  commentOnIssue: vi.fn(),
  getRepoFromRemote: vi.fn(() => Promise.resolve('owner/repo')),
}));

vi.mock('../src/lib/backlog', () => ({
  calculateWsjf: vi.fn(() => ({ dimensions: {}, score: 7.5 })),
  applyWsjfToIssue: vi.fn(),
  fetchIssues: vi.fn(),
  isGhAvailable: vi.fn(),
  transitionIssue: vi.fn(),
  setPriority: vi.fn(),
  LIFECYCLE_TRANSITIONS: {
    inbox: ['triaged'],
    triaged: ['agent-ready', 'wip'],
    'agent-ready': ['wip'],
    wip: ['done'],
    done: [],
  },
  PRIORITY_LABELS: ['P1', 'P2', 'P3'],
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// ─── Imports ───────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { classifyCommand } from '../src/commands/classify';
import { statusCommand } from '../src/commands/status';
import { initCommand, initRefreshCommand } from '../src/commands/init';
import {
  createAdrCommand,
  promptAdrOnT4Classification,
  acceptAdrCommand,
  setAdrStatusCommand,
} from '../src/commands/adr';
import { generateExampleCommand } from '../src/commands/example';
import { declareScopeCommand, ensureSession } from '../src/commands/session';
import { parkCommand } from '../src/commands/park';
import { commentOnIssue, getRepoFromRemote } from '../src/lib/parking-lot';
import { scoreWsjfCommand, triageIssueCommand } from '../src/commands/backlog';
import { scaffold, generateHarnessFiles, refreshHarnessFiles } from '../src/lib/scaffold';
import {
  createAdr,
  findSimilarAdrs,
  listAdrs,
  setAdrStatus,
} from '../src/lib/adr-manager';
import { findActiveSpec, summarizeActiveSpec } from '../src/lib/active-spec';
import { loadSession, saveSession, clearSession } from '../src/lib/session';
import { parkTopic } from '../src/lib/parking-lot';
import {
  isGhAvailable,
  fetchIssues,
  applyWsjfToIssue,
  transitionIssue,
  setPriority,
} from '../src/lib/backlog';
import * as fs from 'fs';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Set workspace to have no folders */
function setNoWorkspace(): void {
  (vscode.workspace as { workspaceFolders: undefined }).workspaceFolders =
    undefined;
}

/** Restore workspace folders to default */
function setWorkspace(fsPath = '/tmp/test-workspace'): void {
  (
    vscode.workspace as {
      workspaceFolders: { uri: { fsPath: string } }[];
    }
  ).workspaceFolders = [{ uri: { fsPath } }];
}

// =============================================================================
// Tests
// =============================================================================

describe('commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setWorkspace();
    // Reset getConfiguration to return empty get by default
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration);
    // folderForFile() resolves via getWorkspaceFolder — map a file to the
    // folder that contains it (falls back to the first folder).
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation(
      ((uri: { fsPath?: string }) => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return undefined;
        const p = uri?.fsPath ?? '';
        return (
          folders.find(
            (f) => p === f.uri.fsPath || p.startsWith(f.uri.fsPath + '/'),
          ) ?? folders[0]
        );
      }) as unknown as typeof vscode.workspace.getWorkspaceFolder,
    );
  });

  // ─── classifyCommand ──────────────────────────────────────────────────────

  describe('classifyCommand()', () => {
    it('returns early without toast when git diff is empty', async () => {
      await classifyCommand();
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  // ─── statusCommand ────────────────────────────────────────────────────────

  describe('statusCommand()', () => {
    // T3 regression: the status-bar click used to call a hardcoded stub that
    // always said "No active spec", disagreeing with the status bar (which used
    // the real findActiveSpec). The command must now consult real state.
    it('shows initialize prompt only when there is genuinely no active spec', async () => {
      vi.mocked(findActiveSpec).mockResolvedValueOnce(null);

      await statusCommand('/tmp/test-workspace')();

      expect(findActiveSpec).toHaveBeenCalledWith('/tmp/test-workspace');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: No active spec. Run "MinSpec: Initialize SDD Structure" to get started.',
      );
      expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });

    it('opens the active spec and shows its real tier|phase|progress', async () => {
      vi.mocked(findActiveSpec).mockResolvedValueOnce(
        '/tmp/test-workspace/specs/SPEC-004.md',
      );
      vi.mocked(summarizeActiveSpec).mockReturnValueOnce({
        id: 'SPEC-004',
        title: 'Classifier Validation Harness',
        tier: 'T3',
        phase: 'Implement',
        progress: '3/5 done',
      });
      const mockDoc = {};
      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
        mockDoc as vscode.TextDocument,
      );

      await statusCommand('/tmp/test-workspace')();

      // It must open the SAME spec the status bar resolved — no "No active spec" lie.
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
        '/tmp/test-workspace/specs/SPEC-004.md',
      );
      expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc, {
        preview: false,
      });
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: SPEC-004 — T3 | Implement | 3/5 done',
      );
      // It must NOT show the no-active-spec message when a spec exists.
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
        'MinSpec: No active spec. Run "MinSpec: Initialize SDD Structure" to get started.',
      );
    });

    it('shows initialize prompt when no workspace is open (does not call findActiveSpec)', async () => {
      await statusCommand('')();
      expect(findActiveSpec).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: No active spec. Run "MinSpec: Initialize SDD Structure" to get started.',
      );
    });
  });

  // ─── initCommand ──────────────────────────────────────────────────────────

  describe('initCommand()', () => {
    it('shows error when no workspace folder is open', async () => {
      setNoWorkspace();
      await initCommand();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: No workspace folder open.',
      );
      expect(scaffold).not.toHaveBeenCalled();
    });

    it('scaffolds and generates harness files on happy path', async () => {
      await initCommand();
      expect(scaffold).toHaveBeenCalledWith('/tmp/test-workspace');
      expect(generateHarnessFiles).toHaveBeenCalledWith(
        '/tmp/test-workspace',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: Initialized .minspec/ and generated harness files.',
      );
    });
  });

  // ─── initRefreshCommand ───────────────────────────────────────────────────

  describe('initRefreshCommand()', () => {
    it('shows error when no workspace folder is open', async () => {
      setNoWorkspace();
      await initRefreshCommand();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: No workspace folder open.',
      );
      expect(refreshHarnessFiles).not.toHaveBeenCalled();
    });

    it('refreshes harness files on happy path', async () => {
      await initRefreshCommand();
      expect(refreshHarnessFiles).toHaveBeenCalledWith(
        '/tmp/test-workspace',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: Refreshed harness files (user edits preserved).',
      );
    });
  });

  // ─── createAdrCommand ─────────────────────────────────────────────────────

  describe('createAdrCommand()', () => {
    it('shows error when no workspace folder is open', async () => {
      setNoWorkspace();
      await createAdrCommand();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: No workspace folder open.',
      );
    });

    it('returns early when user cancels title input', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
      await createAdrCommand();
      expect(createAdr).not.toHaveBeenCalled();
    });

    it('creates ADR and opens file on happy path', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(
        'Use PostgreSQL for persistence',
      );
      vi.mocked(createAdr).mockReturnValueOnce({
        id: 'DR-001',
        title: 'Use PostgreSQL for persistence',
        status: 'proposed',
        date: '2026-05-27',
        filePath: '/tmp/test-workspace/docs/decisions/DR-001.md',
      });
      const mockDoc = {};
      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
        mockDoc as vscode.TextDocument,
      );

      await createAdrCommand();

      expect(createAdr).toHaveBeenCalledWith(
        '/tmp/test-workspace',
        'Use PostgreSQL for persistence',
        undefined,
      );
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
        '/tmp/test-workspace/docs/decisions/DR-001.md',
      );
      expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: Created DR-001 — Use PostgreSQL for persistence',
      );
    });

    it('dedup gate: creates anyway when user confirms despite a near-duplicate', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(
        'Use PostgreSQL for storage',
      );
      vi.mocked(findSimilarAdrs).mockReturnValueOnce([
        {
          adr: {
            id: 'DR-001',
            title: 'Use PostgreSQL for persistence',
            status: 'proposed',
            date: '2026-05-27',
            filePath: '/tmp/test-workspace/docs/decisions/DR-001.md',
          },
          score: 0.5,
        },
      ]);
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
        'Create anyway' as never,
      );
      vi.mocked(createAdr).mockReturnValueOnce({
        id: 'DR-002',
        title: 'Use PostgreSQL for storage',
        status: 'proposed',
        date: '2026-05-29',
        filePath: '/tmp/test-workspace/docs/decisions/DR-002.md',
      });
      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
        {} as vscode.TextDocument,
      );

      await createAdrCommand();

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      expect(createAdr).toHaveBeenCalledWith(
        '/tmp/test-workspace',
        'Use PostgreSQL for storage',
        undefined,
      );
    });

    it('dedup gate: opens the existing ADR and does not create when user chooses Open existing', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(
        'Use PostgreSQL for storage',
      );
      vi.mocked(findSimilarAdrs).mockReturnValueOnce([
        {
          adr: {
            id: 'DR-001',
            title: 'Use PostgreSQL for persistence',
            status: 'proposed',
            date: '2026-05-27',
            filePath: '/tmp/test-workspace/docs/decisions/DR-001.md',
          },
          score: 0.5,
        },
      ]);
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
        'Open existing' as never,
      );
      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
        {} as vscode.TextDocument,
      );

      await createAdrCommand();

      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
        '/tmp/test-workspace/docs/decisions/DR-001.md',
      );
      expect(createAdr).not.toHaveBeenCalled();
    });

    it('dedup gate: cancels (no create) when the warning is dismissed', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(
        'Use PostgreSQL for storage',
      );
      vi.mocked(findSimilarAdrs).mockReturnValueOnce([
        {
          adr: {
            id: 'DR-001',
            title: 'Use PostgreSQL for persistence',
            status: 'proposed',
            date: '2026-05-27',
            filePath: '/tmp/test-workspace/docs/decisions/DR-001.md',
          },
          score: 0.5,
        },
      ]);
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
        undefined as never,
      );

      await createAdrCommand();

      expect(createAdr).not.toHaveBeenCalled();
    });

    it('passes decisionsDir when configured', async () => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string) =>
          key === 'decisionsDir' ? 'custom/decisions' : undefined,
        ),
      } as unknown as vscode.WorkspaceConfiguration);
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('My ADR');
      vi.mocked(createAdr).mockReturnValueOnce({
        id: 'DR-002',
        title: 'My ADR',
        status: 'proposed',
        date: '2026-05-27',
        filePath: '/tmp/test-workspace/custom/decisions/DR-002.md',
      });

      await createAdrCommand();

      expect(createAdr).toHaveBeenCalledWith(
        '/tmp/test-workspace',
        'My ADR',
        { decisionsDir: 'custom/decisions' },
      );
    });

    it('shows error message when createAdr throws', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(
        'Broken ADR',
      );
      vi.mocked(createAdr).mockImplementationOnce(() => {
        throw new Error('disk full');
      });

      await createAdrCommand();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: Failed to create ADR — disk full',
      );
    });

    it('handles non-Error throw', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(
        'Broken ADR',
      );
      vi.mocked(createAdr).mockImplementationOnce(() => {
        throw 'string error'; // eslint-disable-line no-throw-literal
      });

      await createAdrCommand();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: Failed to create ADR — string error',
      );
    });
  });

  // ─── acceptAdrCommand / setAdrStatusCommand ───────────────────────────────

  describe('acceptAdrCommand()', () => {
    const DR8 = '/tmp/test-workspace/docs/decisions/DR-008.md';

    /** Point the active editor at a given file (command-palette context). */
    function setActiveEditor(fsPath: string | undefined): void {
      (vscode.window as { activeTextEditor: unknown }).activeTextEditor =
        fsPath === undefined
          ? undefined
          : { document: { uri: { fsPath } } };
    }

    afterEach(() => setActiveEditor(undefined));

    // T3 regression: invoking "Accept Decision" from the command palette (no
    // tree node) with a DR file open used to fail with "No decision selected"
    // because the command only read its target from an AdrNode argument. It
    // must now fall back to the ADR open in the active editor.
    it('palette invocation (no node) resolves the ADR from the active editor', async () => {
      setActiveEditor(DR8);
      vi.mocked(listAdrs).mockReturnValueOnce([
        {
          id: 'DR-008',
          title: 'Dispatch security',
          status: 'proposed',
          date: '2026-05-20',
          filePath: DR8,
        },
      ]);

      await acceptAdrCommand(undefined);

      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(setAdrStatus).toHaveBeenCalledWith(DR8, 'accepted');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: DR-008 → accepted',
      );
    });

    // No node, nothing open, empty register → backstop reports the empty
    // register instead of dead-ending with "No decision selected" (#110 fix
    // made open-detection load-bearing; this restores the spec-style backstop).
    it('reports an empty register (no dead-end) when no node and no ADR file is open', async () => {
      setActiveEditor(undefined);
      await acceptAdrCommand(undefined);
      expect(setAdrStatus).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: No decisions found.',
      );
    });

    // Active file is not a known decision → fall back to a quick-pick of all
    // decisions rather than erroring, so the user is never stranded.
    it('falls back to a pick when the active file is not a known decision', async () => {
      setActiveEditor('/tmp/test-workspace/README.md');
      vi.mocked(listAdrs).mockReturnValue([
        {
          id: 'DR-008',
          title: 'Dispatch security',
          status: 'proposed',
          date: '2026-05-20',
          filePath: DR8,
        },
      ]);
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
        label: 'DR-008: Dispatch security',
        description: 'proposed',
        adr: { filePath: DR8, status: 'proposed', id: 'DR-008' },
      } as never);

      await acceptAdrCommand(undefined);

      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      expect(setAdrStatus).toHaveBeenCalledWith(DR8, 'accepted');
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      vi.mocked(listAdrs).mockReturnValue([]); // restore default for later tests
    });

    it('still works from a tree node argument', async () => {
      const node = {
        adr: {
          id: 'DR-008',
          title: 'Dispatch security',
          status: 'proposed' as const,
          date: '2026-05-20',
          filePath: DR8,
        },
      };
      await acceptAdrCommand(node as never);
      expect(setAdrStatus).toHaveBeenCalledWith(DR8, 'accepted');
      // Tree node carries its own state — no editor fallback needed.
      expect(listAdrs).not.toHaveBeenCalled();
    });

    it('no-ops with a message when the ADR is already accepted', async () => {
      setActiveEditor(DR8);
      vi.mocked(listAdrs).mockReturnValueOnce([
        {
          id: 'DR-008',
          title: 'Dispatch security',
          status: 'accepted',
          date: '2026-05-20',
          filePath: DR8,
        },
      ]);
      await acceptAdrCommand(undefined);
      expect(setAdrStatus).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: DR-008 already accepted.',
      );
    });

    it('setAdrStatusCommand also falls back to the active editor', async () => {
      setActiveEditor(DR8);
      vi.mocked(listAdrs).mockReturnValueOnce([
        {
          id: 'DR-008',
          title: 'Dispatch security',
          status: 'proposed',
          date: '2026-05-20',
          filePath: DR8,
        },
      ]);
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
        value: 'deprecated',
      } as never);

      await setAdrStatusCommand(undefined);

      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(setAdrStatus).toHaveBeenCalledWith(DR8, 'deprecated');
    });
  });

  // ─── promptAdrOnT4Classification ──────────────────────────────────────────

  describe('promptAdrOnT4Classification()', () => {
    it('returns false when user skips', async () => {
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
        'Skip' as unknown as undefined,
      );

      const result = await promptAdrOnT4Classification();
      expect(result).toBe(false);
    });

    it('returns false when no workspace and user chose Create ADR', async () => {
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
        'Create ADR' as unknown as undefined,
      );
      setNoWorkspace();

      const result = await promptAdrOnT4Classification();
      expect(result).toBe(false);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: No workspace folder open.',
      );
    });

    it('returns false when user cancels title input', async () => {
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
        'Create ADR' as unknown as undefined,
      );
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

      const result = await promptAdrOnT4Classification();
      expect(result).toBe(false);
    });

    it('pre-fills title from taskTitle when provided', async () => {
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
        'Create ADR' as unknown as undefined,
      );
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

      await promptAdrOnT4Classification('Refactor auth module');

      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({
          value: 'Decision for: Refactor auth module',
        }),
      );
    });

    it('creates ADR and returns true on happy path', async () => {
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
        'Create ADR' as unknown as undefined,
      );
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(
        'Decision for: Auth flow',
      );
      vi.mocked(createAdr).mockReturnValueOnce({
        id: 'DR-003',
        title: 'Decision for: Auth flow',
        status: 'proposed',
        date: '2026-05-27',
        filePath: '/tmp/test-workspace/docs/decisions/DR-003.md',
      });

      const result = await promptAdrOnT4Classification('Auth flow');
      expect(result).toBe(true);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: Created DR-003 — Decision for: Auth flow',
      );
    });

    it('returns false and shows error when createAdr throws', async () => {
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
        'Create ADR' as unknown as undefined,
      );
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('Boom');
      vi.mocked(createAdr).mockImplementationOnce(() => {
        throw new Error('fail');
      });

      const result = await promptAdrOnT4Classification();
      expect(result).toBe(false);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: Failed to create ADR.',
      );
    });
  });

  // ─── generateExampleCommand ───────────────────────────────────────────────

  describe('generateExampleCommand()', () => {
    it('shows error when no workspace folder is open', async () => {
      setNoWorkspace();
      await generateExampleCommand();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: No workspace folder open.',
      );
    });

    it('creates example spec and opens file on happy path', async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);
      const mockDoc = {};
      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
        mockDoc as vscode.TextDocument,
      );

      await generateExampleCommand();

      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
      expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
        mockDoc,
        { preview: false },
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: Generated example spec. Read through it to learn the tier system.',
      );
    });

    it('writes an example with a demonstrated Acceptance Criteria section', async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);
      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
        {} as vscode.TextDocument,
      );

      await generateExampleCommand();

      const written = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1] as string;
      expect(written).toBeTypeOf('string');
      expect(written).toContain('## Acceptance Criteria');
      // at least one checkbox demonstrating the format
      expect(written).toMatch(/- \[[ xX]\]/);
      // canonical format markers: bold short name + (FR/INV trace)
      expect(written).toMatch(/- \[ \] \*\*[^*]+\*\* —/);
      expect(written).toMatch(/\((FR|INV)[^)]*\)/);
    });

    it('prompts to overwrite when example already exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
        'Cancel' as unknown as undefined,
      );

      await generateExampleCommand();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'MinSpec: Example spec already exists. Overwrite it?',
        'Overwrite',
        'Cancel',
      );
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('overwrites when user confirms', async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
        'Overwrite' as unknown as undefined,
      );
      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
        {} as vscode.TextDocument,
      );

      await generateExampleCommand();

      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: Generated example spec. Read through it to learn the tier system.',
      );
    });

    // ── #153 bug 1: multi-root — write to the ACTIVE folder, not folders[0] ──
    // Point the active editor at a given file (command-palette context).
    function setActiveEditor(fsPath: string | undefined): void {
      (vscode.window as { activeTextEditor: unknown }).activeTextEditor =
        fsPath === undefined ? undefined : { document: { uri: { fsPath } } };
    }

    it('targets the resolved folder (active editor) in a multi-root workspace, not folders[0]', async () => {
      // Two roots; the open file lives in the SECOND one. The legacy
      // `workspaceFolders?.[0]` would wrongly target folder #1.
      (
        vscode.workspace as {
          workspaceFolders: { uri: { fsPath: string } }[];
        }
      ).workspaceFolders = [
        { uri: { fsPath: '/tmp/proj-a' } },
        { uri: { fsPath: '/tmp/proj-b' } },
      ];
      setActiveEditor('/tmp/proj-b/src/index.ts');
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);
      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
        {} as vscode.TextDocument,
      );

      await generateExampleCommand();

      // resolveAndValidate mock returns `${root}/${sub}`, so the written path
      // encodes the resolved root. It must be proj-b, never proj-a.
      const writtenPath = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[0] as string;
      expect(writtenPath).toContain('/tmp/proj-b/');
      expect(writtenPath).not.toContain('/tmp/proj-a/');

      setActiveEditor(undefined);
    });

    // ── #153 bug 2: `created:` must reflect CALL time, not module-load time ──
    it('stamps the example with the call-time date, not the module-load date', async () => {
      // A fixed, far-future date that cannot equal the real module-load date.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2099-12-31T08:00:00.000Z'));
      try {
        vi.mocked(fs.existsSync).mockReturnValueOnce(false);
        vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
          {} as vscode.TextDocument,
        );

        await generateExampleCommand();

        const written = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1] as string;
        expect(written).toContain('created: 2099-12-31');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ─── declareScopeCommand ──────────────────────────────────────────────────

  describe('declareScopeCommand()', () => {
    it('shows error when no workspace folder is open', async () => {
      setNoWorkspace();
      await declareScopeCommand();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: No workspace folder open.',
      );
    });

    it('offers to keep/start/end when session exists', async () => {
      vi.mocked(loadSession).mockReturnValueOnce({
        scope: 'Implement auth',
        project: 'minspec',
        type: 'feat',
        startedAt: '2026-05-27T00:00:00.000Z',
        specIds: [],
        fileAllowlist: [],
      });
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(
        'Keep current session' as unknown as vscode.QuickPickItem,
      );

      await declareScopeCommand();

      expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
        ['Keep current session', 'Start new session', 'End session'],
        expect.objectContaining({
          placeHolder: expect.stringContaining('Implement auth'),
        }),
      );
    });

    it('clears session when user picks End session', async () => {
      vi.mocked(loadSession).mockReturnValueOnce({
        scope: 'Implement auth',
        project: 'minspec',
        type: 'feat',
        startedAt: '2026-05-27T00:00:00.000Z',
        specIds: [],
        fileAllowlist: [],
      });
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(
        'End session' as unknown as vscode.QuickPickItem,
      );

      await declareScopeCommand();

      expect(clearSession).toHaveBeenCalledWith('/tmp/test-workspace');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: Session ended.',
      );
    });

    it('returns early when user cancels quick pick for existing session', async () => {
      vi.mocked(loadSession).mockReturnValueOnce({
        scope: 'Implement auth',
        project: 'minspec',
        type: 'feat',
        startedAt: '2026-05-27T00:00:00.000Z',
        specIds: [],
        fileAllowlist: [],
      });
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

      await declareScopeCommand();

      expect(saveSession).not.toHaveBeenCalled();
      expect(clearSession).not.toHaveBeenCalled();
    });

    it('returns early when user cancels scope input', async () => {
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

      await declareScopeCommand();

      expect(saveSession).not.toHaveBeenCalled();
    });

    it('returns early when user cancels project input', async () => {
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('Build feature X') // scope
        .mockResolvedValueOnce(undefined);         // project cancelled

      await declareScopeCommand();

      expect(saveSession).not.toHaveBeenCalled();
    });

    it('returns early when user cancels session type', async () => {
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('Build feature X')
        .mockResolvedValueOnce('minspec');
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

      await declareScopeCommand();

      expect(saveSession).not.toHaveBeenCalled();
    });

    it('creates and saves session on happy path', async () => {
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('Build feature X')
        .mockResolvedValueOnce('minspec');
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(
        'feat' as unknown as vscode.QuickPickItem,
      );

      await declareScopeCommand();

      expect(saveSession).toHaveBeenCalledWith(
        '/tmp/test-workspace',
        expect.objectContaining({
          scope: 'Build feature X',
          project: 'minspec',
          type: 'feat',
        }),
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: Session started — "Build feature X" (feat)',
      );
    });

    it('falls through to new session when user picks Start new session', async () => {
      vi.mocked(loadSession).mockReturnValueOnce({
        scope: 'Old session',
        project: 'old',
        type: 'bug',
        startedAt: '2026-05-27T00:00:00.000Z',
        specIds: [],
        fileAllowlist: [],
      });
      // First quickpick: Start new session
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(
        'Start new session' as unknown as vscode.QuickPickItem,
      );
      // Then collects scope/project/type
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('New scope')
        .mockResolvedValueOnce('newproject');
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(
        'explore' as unknown as vscode.QuickPickItem,
      );

      await declareScopeCommand();

      expect(saveSession).toHaveBeenCalledWith(
        '/tmp/test-workspace',
        expect.objectContaining({
          scope: 'New scope',
          project: 'newproject',
          type: 'explore',
        }),
      );
    });
  });

  // ─── ensureSession ────────────────────────────────────────────────────────

  describe('ensureSession()', () => {
    it('returns true when session already exists', async () => {
      vi.mocked(loadSession).mockReturnValueOnce({
        scope: 'test',
        project: 'p',
        type: 'feat',
        startedAt: '2026-05-27T00:00:00.000Z',
        specIds: [],
        fileAllowlist: [],
      });

      const result = await ensureSession('/tmp/test-workspace');
      expect(result).toBe(true);
    });

    it('returns false when user skips declaring scope', async () => {
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
        'Skip' as unknown as undefined,
      );

      const result = await ensureSession('/tmp/test-workspace');
      expect(result).toBe(false);
    });

    it('returns false when user cancels the prompt', async () => {
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
        undefined,
      );

      const result = await ensureSession('/tmp/test-workspace');
      expect(result).toBe(false);
    });

    it('invokes declareScopeCommand and checks session after', async () => {
      vi.mocked(loadSession)
        .mockReturnValueOnce(null)  // ensureSession initial check
        .mockReturnValueOnce(null)  // declareScopeCommand checks for existing session
        .mockReturnValueOnce(null); // ensureSession final check after declareScopeCommand
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
        'Declare Scope' as unknown as undefined,
      );
      // declareScopeCommand will run — user cancels scope input
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

      const result = await ensureSession('/tmp/test-workspace');
      // loadSession called again after declareScopeCommand, returns null
      expect(result).toBe(false);
    });
  });

  // ─── parkCommand ──────────────────────────────────────────────────────────

  describe('parkCommand()', () => {
    it('shows error when no workspace folder is open', async () => {
      setNoWorkspace();
      await parkCommand();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: No workspace folder open.',
      );
    });

    it('returns early when user cancels title input', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

      await parkCommand();

      expect(parkTopic).not.toHaveBeenCalled();
    });

    it('parks to GitHub on happy path', async () => {
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('Consider caching')  // title
        .mockResolvedValueOnce('Perf concern')       // body
        .mockResolvedValueOnce('idea,inbox');         // labels
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(parkTopic).mockResolvedValueOnce({
        method: 'github',
        url: 'https://github.com/harvest316/minspec/issues/42',
      });

      await parkCommand();

      expect(parkTopic).toHaveBeenCalledWith(
        '/tmp/test-workspace',
        expect.objectContaining({
          title: 'Consider caching',
          body: 'Perf concern',
          labels: ['idea', 'inbox'],
        }),
        { force: false },
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: Created GitHub issue — https://github.com/harvest316/minspec/issues/42',
      );
    });

    it('parks to local file when GitHub is unavailable', async () => {
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('Local idea')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('idea,inbox');
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(parkTopic).mockResolvedValueOnce({
        method: 'file',
        filePath: '/tmp/test-workspace/.minspec/parking-lot.md',
      });

      await parkCommand();

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: Saved to /tmp/test-workspace/.minspec/parking-lot.md',
      );
    });

    it('includes session scope when session is active', async () => {
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('Topic')
        .mockResolvedValueOnce('Details')
        .mockResolvedValueOnce('bug,inbox');
      vi.mocked(loadSession).mockReturnValueOnce({
        scope: 'Fix auth',
        project: 'minspec',
        type: 'bug',
        startedAt: '2026-05-27T00:00:00.000Z',
        specIds: [],
        fileAllowlist: [],
      });
      vi.mocked(parkTopic).mockResolvedValueOnce({
        method: 'file',
        filePath: '/tmp/test-workspace/.minspec/parking-lot.md',
      });

      await parkCommand();

      // createParkingLotEntry is called with session scope string
      const { createParkingLotEntry } = await import(
        '../src/lib/parking-lot'
      );
      expect(createParkingLotEntry).toHaveBeenCalledWith(
        'Topic',
        'Details',
        'Fix auth (minspec, bug)',
        ['bug', 'inbox'],
      );
    });

    it('uses default labels when label input is empty', async () => {
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('Topic')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce(''); // empty label input
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(parkTopic).mockResolvedValueOnce({
        method: 'file',
        filePath: '/tmp/test-workspace/.minspec/parking-lot.md',
      });

      await parkCommand();

      const { createParkingLotEntry } = await import(
        '../src/lib/parking-lot'
      );
      expect(createParkingLotEntry).toHaveBeenCalledWith(
        'Topic',
        '',
        'No active session',
        ['idea', 'inbox'],
      );
    });

    // ─── #136: force command bypasses the dedup gate ────────────────────────

    it('force command parks with { force: true } and never offers a choice', async () => {
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('Dup topic')  // title
        .mockResolvedValueOnce('')            // body
        .mockResolvedValueOnce('idea,inbox'); // labels
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(parkTopic).mockResolvedValueOnce({
        method: 'github',
        url: 'https://github.com/owner/repo/issues/99',
      });

      await parkCommand({ force: true });

      // force:true threaded through to parkTopic.
      expect(parkTopic).toHaveBeenCalledWith(
        '/tmp/test-workspace',
        expect.objectContaining({ title: 'Dup topic' }),
        { force: true },
      );
      // No dedup hit possible when forcing → no quick-pick.
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: Created GitHub issue — https://github.com/owner/repo/issues/99',
      );
    });

    // ─── #136: dedup-hit choice UX (open / comment / force) ─────────────────

    it('dedup hit, choice = open existing → opens the issue in the browser', async () => {
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('Existing topic')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('idea,inbox');
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(parkTopic).mockResolvedValueOnce({
        method: 'github',
        url: 'https://github.com/owner/repo/issues/7',
        deduped: true,
      });
      // User picks "open existing".
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
        action: 'open',
      } as never);

      await parkCommand();

      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      expect(vscode.env.openExternal).toHaveBeenCalledWith(
        expect.objectContaining({
          toString: expect.any(Function),
        }),
      );
      // open path must NOT force-create a second issue.
      expect(parkTopic).toHaveBeenCalledTimes(1);
      expect(commentOnIssue).not.toHaveBeenCalled();
    });

    it('dedup hit, choice = comment → comments on the existing issue', async () => {
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('Existing topic')
        .mockResolvedValueOnce('extra note')
        .mockResolvedValueOnce('idea,inbox');
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(parkTopic).mockResolvedValueOnce({
        method: 'github',
        url: 'https://github.com/owner/repo/issues/7',
        deduped: true,
      });
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
        action: 'comment',
      } as never);
      vi.mocked(commentOnIssue).mockResolvedValueOnce(true);

      await parkCommand();

      expect(commentOnIssue).toHaveBeenCalledWith(
        'https://github.com/owner/repo/issues/7',
        expect.any(String),
        'owner/repo',
      );
      // comment path does not force a new issue.
      expect(parkTopic).toHaveBeenCalledTimes(1);
    });

    it('dedup hit, choice = force → re-parks with { force: true } and creates new', async () => {
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('Existing topic')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('idea,inbox');
      vi.mocked(loadSession).mockReturnValue(null);
      vi.mocked(parkTopic)
        // First park: dedup hit.
        .mockResolvedValueOnce({
          method: 'github',
          url: 'https://github.com/owner/repo/issues/7',
          deduped: true,
        })
        // Second park (forced): brand-new issue.
        .mockResolvedValueOnce({
          method: 'github',
          url: 'https://github.com/owner/repo/issues/8',
        });
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
        action: 'force',
      } as never);

      await parkCommand();

      // Two parkTopic calls: the initial one, then the forced re-park.
      expect(parkTopic).toHaveBeenCalledTimes(2);
      expect(parkTopic).toHaveBeenLastCalledWith(
        '/tmp/test-workspace',
        expect.objectContaining({ title: 'Existing topic' }),
        { force: true },
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: Created GitHub issue — https://github.com/owner/repo/issues/8',
      );
    });

    it('dedup hit, choice cancelled → no open, no comment, no force', async () => {
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('Existing topic')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('idea,inbox');
      vi.mocked(loadSession).mockReturnValueOnce(null);
      vi.mocked(parkTopic).mockResolvedValueOnce({
        method: 'github',
        url: 'https://github.com/owner/repo/issues/7',
        deduped: true,
      });
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(
        undefined as never,
      );

      await parkCommand();

      expect(vscode.env.openExternal).not.toHaveBeenCalled();
      expect(commentOnIssue).not.toHaveBeenCalled();
      expect(parkTopic).toHaveBeenCalledTimes(1);
    });
  });

  // ─── scoreWsjfCommand ─────────────────────────────────────────────────────

  describe('scoreWsjfCommand()', () => {
    it('shows error when no workspace folder is open', async () => {
      setNoWorkspace();
      await scoreWsjfCommand();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: No workspace folder open.',
      );
    });

    it('shows error when gh CLI is not available', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(false);
      await scoreWsjfCommand();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: GitHub CLI (gh) is not available or not authenticated. Install and run `gh auth login`.',
      );
    });

    it('shows info when no open issues found', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([]);
      await scoreWsjfCommand();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: No open issues found.',
      );
    });

    it('returns early when user cancels issue selection', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([
        {
          number: 1,
          title: 'Test issue',
          url: 'https://github.com/test/1',
          labels: [],
          state: 'OPEN',
          createdAt: '2026-05-27',
          updatedAt: '2026-05-27',
          lifecycleLabel: null,
          priorityLabel: null,
          wsjfScore: null,
        },
      ]);
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

      await scoreWsjfCommand();
      expect(applyWsjfToIssue).not.toHaveBeenCalled();
    });

    it('scores and applies WSJF on happy path', async () => {
      const testIssue = {
        number: 5,
        title: 'Add caching',
        url: 'https://github.com/test/5',
        labels: ['feat'],
        state: 'OPEN' as const,
        createdAt: '2026-05-27',
        updatedAt: '2026-05-27',
        lifecycleLabel: null,
        priorityLabel: null,
        wsjfScore: null,
      };

      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([testIssue]);

      // Select issue
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({
          label: '#5: Add caching',
          description: 'feat',
        } as vscode.QuickPickItem)
        // Business Value
        .mockResolvedValueOnce({ label: '8' } as vscode.QuickPickItem)
        // Time Criticality
        .mockResolvedValueOnce({ label: '5' } as vscode.QuickPickItem)
        // Risk Reduction
        .mockResolvedValueOnce({ label: '3' } as vscode.QuickPickItem)
        // Job Size
        .mockResolvedValueOnce({ label: '4' } as vscode.QuickPickItem);

      // Confirm apply
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
        'Apply' as unknown as undefined,
      );
      vi.mocked(applyWsjfToIssue).mockResolvedValueOnce(true);

      await scoreWsjfCommand();

      expect(applyWsjfToIssue).toHaveBeenCalledWith(
        '/tmp/test-workspace',
        5,
        expect.objectContaining({ score: 7.5 }),
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('WSJF score 7.5 applied to #5'),
      );
    });

    it('returns early when user cancels a WSJF dimension input', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([
        {
          number: 1,
          title: 'Test',
          url: '',
          labels: [],
          state: 'OPEN',
          createdAt: '2026-05-27',
          updatedAt: '2026-05-27',
          lifecycleLabel: null,
          priorityLabel: null,
          wsjfScore: null,
        },
      ]);
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({
          label: '#1: Test',
        } as vscode.QuickPickItem)
        // Business Value selected
        .mockResolvedValueOnce({ label: '5' } as vscode.QuickPickItem)
        // Time Criticality cancelled
        .mockResolvedValueOnce(undefined);

      await scoreWsjfCommand();
      expect(applyWsjfToIssue).not.toHaveBeenCalled();
    });

    it('returns early when user cancels confirm', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([
        {
          number: 1,
          title: 'Test',
          url: '',
          labels: [],
          state: 'OPEN',
          createdAt: '2026-05-27',
          updatedAt: '2026-05-27',
          lifecycleLabel: null,
          priorityLabel: null,
          wsjfScore: null,
        },
      ]);
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: '#1: Test' } as vscode.QuickPickItem)
        .mockResolvedValueOnce({ label: '5' } as vscode.QuickPickItem)
        .mockResolvedValueOnce({ label: '5' } as vscode.QuickPickItem)
        .mockResolvedValueOnce({ label: '5' } as vscode.QuickPickItem)
        .mockResolvedValueOnce({ label: '5' } as vscode.QuickPickItem);

      // Cancel confirm
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
        'Cancel' as unknown as undefined,
      );

      await scoreWsjfCommand();
      expect(applyWsjfToIssue).not.toHaveBeenCalled();
    });

    it('shows error when applyWsjfToIssue fails', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([
        {
          number: 7,
          title: 'Failing',
          url: '',
          labels: [],
          state: 'OPEN',
          createdAt: '2026-05-27',
          updatedAt: '2026-05-27',
          lifecycleLabel: null,
          priorityLabel: null,
          wsjfScore: null,
        },
      ]);
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({
          label: '#7: Failing',
        } as vscode.QuickPickItem)
        .mockResolvedValueOnce({ label: '5' } as vscode.QuickPickItem)
        .mockResolvedValueOnce({ label: '5' } as vscode.QuickPickItem)
        .mockResolvedValueOnce({ label: '5' } as vscode.QuickPickItem)
        .mockResolvedValueOnce({ label: '5' } as vscode.QuickPickItem);

      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
        'Apply' as unknown as undefined,
      );
      vi.mocked(applyWsjfToIssue).mockResolvedValueOnce(false);

      await scoreWsjfCommand();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: Failed to apply WSJF score to #7. Check gh CLI authentication.',
      );
    });
  });

  // ─── triageIssueCommand ───────────────────────────────────────────────────

  describe('triageIssueCommand()', () => {
    it('shows error when no workspace folder is open', async () => {
      setNoWorkspace();
      await triageIssueCommand();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: No workspace folder open.',
      );
    });

    it('shows error when gh CLI is not available', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(false);
      await triageIssueCommand();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'MinSpec: GitHub CLI (gh) is not available or not authenticated.',
      );
    });

    it('shows info when no inbox issues to triage', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      // Return issues that are NOT inbox/null lifecycle — they should be filtered out
      vi.mocked(fetchIssues).mockResolvedValueOnce([
        {
          number: 1,
          title: 'Already triaged',
          url: '',
          labels: ['triaged'],
          state: 'OPEN',
          createdAt: '2026-05-27',
          updatedAt: '2026-05-27',
          lifecycleLabel: 'triaged',
          priorityLabel: null,
          wsjfScore: null,
        },
      ]);

      await triageIssueCommand();

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: No inbox issues to triage.',
      );
    });

    it('returns early when user cancels issue selection', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([
        {
          number: 10,
          title: 'Inbox issue',
          url: '',
          labels: ['inbox'],
          state: 'OPEN',
          createdAt: '2026-05-27',
          updatedAt: '2026-05-27',
          lifecycleLabel: 'inbox',
          priorityLabel: null,
          wsjfScore: null,
        },
      ]);
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

      await triageIssueCommand();
      expect(transitionIssue).not.toHaveBeenCalled();
    });

    it('triages issue on happy path with priority and lifecycle transition', async () => {
      const inboxIssue = {
        number: 10,
        title: 'Inbox issue',
        url: '',
        labels: ['inbox'],
        state: 'OPEN' as const,
        createdAt: '2026-05-27',
        updatedAt: '2026-05-27',
        lifecycleLabel: 'inbox' as const,
        priorityLabel: null,
        wsjfScore: null,
      };

      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([inboxIssue]);

      vi.mocked(vscode.window.showQuickPick)
        // Select issue
        .mockResolvedValueOnce({
          label: '#10: Inbox issue',
          description: 'inbox',
          detail: expect.any(String),
        } as unknown as vscode.QuickPickItem)
        // Select priority
        .mockResolvedValueOnce({
          label: 'P2',
          description: 'Important — do soon',
        } as vscode.QuickPickItem)
        // Select lifecycle transition
        .mockResolvedValueOnce({
          label: 'triaged',
          description: 'Awaiting prioritization/assignment',
        } as vscode.QuickPickItem);

      vi.mocked(setPriority).mockResolvedValueOnce(true);
      vi.mocked(transitionIssue).mockResolvedValueOnce(true);

      await triageIssueCommand();

      expect(setPriority).toHaveBeenCalledWith(
        '/tmp/test-workspace',
        10,
        null,
        'P2',
      );
      expect(transitionIssue).toHaveBeenCalledWith(
        '/tmp/test-workspace',
        10,
        'inbox',
        'triaged',
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: #10 triaged — Priority: P2, Lifecycle: triaged',
      );
    });

    it('skips priority when user selects Skip', async () => {
      const inboxIssue = {
        number: 11,
        title: 'Low priority',
        url: '',
        labels: ['inbox'],
        state: 'OPEN' as const,
        createdAt: '2026-05-27',
        updatedAt: '2026-05-27',
        lifecycleLabel: 'inbox' as const,
        priorityLabel: null,
        wsjfScore: null,
      };

      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([inboxIssue]);

      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({
          label: '#11: Low priority',
        } as vscode.QuickPickItem)
        .mockResolvedValueOnce({
          label: 'Skip',
          description: 'No priority label',
        } as vscode.QuickPickItem)
        .mockResolvedValueOnce({
          label: 'triaged',
        } as vscode.QuickPickItem);

      vi.mocked(transitionIssue).mockResolvedValueOnce(true);

      await triageIssueCommand();

      expect(setPriority).not.toHaveBeenCalled();
      expect(transitionIssue).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: #11 triaged — Lifecycle: triaged',
      );
    });

    it('returns early when user cancels priority pick', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([
        {
          number: 10,
          title: 'Inbox',
          url: '',
          labels: [],
          state: 'OPEN',
          createdAt: '2026-05-27',
          updatedAt: '2026-05-27',
          lifecycleLabel: 'inbox',
          priorityLabel: null,
          wsjfScore: null,
        },
      ]);

      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({
          label: '#10: Inbox',
        } as vscode.QuickPickItem)
        // Cancel priority
        .mockResolvedValueOnce(undefined);

      await triageIssueCommand();
      expect(transitionIssue).not.toHaveBeenCalled();
    });

    it('returns early when user cancels lifecycle pick', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([
        {
          number: 10,
          title: 'Inbox',
          url: '',
          labels: [],
          state: 'OPEN',
          createdAt: '2026-05-27',
          updatedAt: '2026-05-27',
          lifecycleLabel: 'inbox',
          priorityLabel: null,
          wsjfScore: null,
        },
      ]);

      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({
          label: '#10: Inbox',
        } as vscode.QuickPickItem)
        .mockResolvedValueOnce({
          label: 'P1',
        } as vscode.QuickPickItem)
        // Cancel lifecycle
        .mockResolvedValueOnce(undefined);

      await triageIssueCommand();
      expect(transitionIssue).not.toHaveBeenCalled();
    });

    it('includes issues with null lifecycleLabel as triageable', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([
        {
          number: 20,
          title: 'Unlabeled',
          url: '',
          labels: [],
          state: 'OPEN',
          createdAt: '2026-05-27',
          updatedAt: '2026-05-27',
          lifecycleLabel: null,
          priorityLabel: null,
          wsjfScore: null,
        },
      ]);

      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({
          label: '#20: Unlabeled',
        } as vscode.QuickPickItem)
        .mockResolvedValueOnce({
          label: 'P3',
        } as vscode.QuickPickItem)
        .mockResolvedValueOnce({
          label: 'triaged',
        } as vscode.QuickPickItem);

      vi.mocked(setPriority).mockResolvedValueOnce(true);
      vi.mocked(transitionIssue).mockResolvedValueOnce(true);

      await triageIssueCommand();

      // Null lifecycle → should transition from null to triaged
      expect(transitionIssue).toHaveBeenCalledWith(
        '/tmp/test-workspace',
        20,
        null,
        'triaged',
      );
    });

    it('reports FAILED outcomes in the triage message', async () => {
      vi.mocked(isGhAvailable).mockResolvedValueOnce(true);
      vi.mocked(fetchIssues).mockResolvedValueOnce([
        {
          number: 30,
          title: 'Tricky',
          url: '',
          labels: ['inbox'],
          state: 'OPEN',
          createdAt: '2026-05-27',
          updatedAt: '2026-05-27',
          lifecycleLabel: 'inbox',
          priorityLabel: null,
          wsjfScore: null,
        },
      ]);

      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({
          label: '#30: Tricky',
        } as vscode.QuickPickItem)
        .mockResolvedValueOnce({
          label: 'P1',
        } as vscode.QuickPickItem)
        .mockResolvedValueOnce({
          label: 'triaged',
        } as vscode.QuickPickItem);

      vi.mocked(setPriority).mockResolvedValueOnce(false);
      vi.mocked(transitionIssue).mockResolvedValueOnce(false);

      await triageIssueCommand();

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'MinSpec: #30 triaged — Priority: FAILED, Lifecycle: FAILED',
      );
    });
  });
});
