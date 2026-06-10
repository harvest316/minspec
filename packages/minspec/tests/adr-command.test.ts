/**
 * Extra coverage for packages/minspec/src/commands/adr.ts.
 *
 * Targets:
 *  - regenerateDrIndexCommand (lines 225-246) — entirely uncovered
 *  - validateInput callbacks in createAdrCommand and promptAdrOnT4Classification
 *  - applyStatus inner catch (regenerateDrIndex throws inside status write)
 *  - applyStatus no-folder branch (folderForFile returns undefined)
 *  - setAdrStatusCommand same-status no-op branch
 *  - confirmNoDuplicate with 2+ similar ADRs (the "+N more" message suffix)
 *  - resolveAdr palette path when activePath is set but folderForFile is undefined
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── vscode mock ─────────────────────────────────────────────────────────────

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    showTextDocument: vi.fn(),
    activeTextEditor: undefined as
      | undefined
      | { document: { uri: { fsPath: string } } },
    tabGroups: undefined as unknown,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/adr-ws' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
    openTextDocument: vi.fn(() => Promise.resolve({})),
    getWorkspaceFolder: vi.fn(),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file' }),
  },
}));

// ─── lib mocks ────────────────────────────────────────────────────────────────

vi.mock('../src/lib/adr-manager', () => ({
  createAdr: vi.fn(),
  findSimilarAdrs: vi.fn(() => []),
  listAdrs: vi.fn(() => []),
  setAdrStatus: vi.fn(),
  // Default true → existing applyStatus tests (frontmatter files) skip the modal.
  adrHasFrontmatter: vi.fn(() => true),
  regenerateDrIndex: vi.fn(),
  ADR_STATUS_VALUES: ['proposed', 'accepted', 'deprecated', 'superseded'],
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import {
  createAdrCommand,
  regenerateDrIndexCommand,
  acceptAdrCommand,
  setAdrStatusCommand,
  promptAdrOnT4Classification,
} from '../src/commands/adr';
import {
  createAdr,
  findSimilarAdrs,
  listAdrs,
  setAdrStatus,
  adrHasFrontmatter,
  regenerateDrIndex,
} from '../src/lib/adr-manager';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const WS = '/tmp/adr-ws';
const DR1 = `${WS}/docs/decisions/DR-001.md`;

function setWorkspace(fsPath = WS): void {
  (
    vscode.workspace as {
      workspaceFolders: { uri: { fsPath: string } }[];
    }
  ).workspaceFolders = [{ uri: { fsPath } }];
}

function setNoWorkspace(): void {
  (vscode.workspace as { workspaceFolders: undefined }).workspaceFolders =
    undefined;
}

function setActiveEditor(fsPath: string | undefined): void {
  (
    vscode.window as {
      activeTextEditor:
        | undefined
        | { document: { uri: { fsPath: string } } };
    }
  ).activeTextEditor =
    fsPath === undefined ? undefined : { document: { uri: { fsPath } } };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  setWorkspace();
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn(),
  } as unknown as vscode.WorkspaceConfiguration);
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

afterEach(() => {
  setActiveEditor(undefined);
});

// =============================================================================
// regenerateDrIndexCommand
// =============================================================================

describe('regenerateDrIndexCommand()', () => {
  it('returns early with error when no workspace is open', async () => {
    setNoWorkspace();
    await regenerateDrIndexCommand();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: No workspace folder open.',
    );
    expect(regenerateDrIndex).not.toHaveBeenCalled();
  });

  it('happy path: singular — shows "1 decision" (not "1 decisions")', async () => {
    vi.mocked(regenerateDrIndex).mockReturnValueOnce({
      filePath: `${WS}/docs/decisions/INDEX.md`,
      count: 1,
    } as never);
    const mockDoc = {};
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
      mockDoc as vscode.TextDocument,
    );

    await regenerateDrIndexCommand();

    expect(regenerateDrIndex).toHaveBeenCalledWith(WS, undefined);
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
      `${WS}/docs/decisions/INDEX.md`,
    );
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Regenerated DR INDEX (1 decision).',
    );
  });

  it('happy path: plural — shows "N decisions" for count > 1', async () => {
    vi.mocked(regenerateDrIndex).mockReturnValueOnce({
      filePath: `${WS}/docs/decisions/INDEX.md`,
      count: 3,
    } as never);
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
      {} as vscode.TextDocument,
    );

    await regenerateDrIndexCommand();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Regenerated DR INDEX (3 decisions).',
    );
  });

  it('happy path: zero count — shows "0 decisions"', async () => {
    vi.mocked(regenerateDrIndex).mockReturnValueOnce({
      filePath: `${WS}/docs/decisions/INDEX.md`,
      count: 0,
    } as never);
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
      {} as vscode.TextDocument,
    );

    await regenerateDrIndexCommand();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Regenerated DR INDEX (0 decisions).',
    );
  });

  it('passes decisionsDir override when configured', async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string) =>
        key === 'decisionsDir' ? 'custom/drs' : undefined,
      ),
    } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(regenerateDrIndex).mockReturnValueOnce({
      filePath: `${WS}/custom/drs/INDEX.md`,
      count: 2,
    } as never);
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
      {} as vscode.TextDocument,
    );

    await regenerateDrIndexCommand();

    expect(regenerateDrIndex).toHaveBeenCalledWith(WS, {
      decisionsDir: 'custom/drs',
    });
  });

  it('shows error message when regenerateDrIndex throws an Error', async () => {
    vi.mocked(regenerateDrIndex).mockImplementationOnce(() => {
      throw new Error('index write failed');
    });

    await regenerateDrIndexCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to regenerate DR INDEX — index write failed',
    );
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('shows error message when regenerateDrIndex throws a non-Error', async () => {
    vi.mocked(regenerateDrIndex).mockImplementationOnce(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'boom';
    });

    await regenerateDrIndexCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to regenerate DR INDEX — boom',
    );
  });
});

// =============================================================================
// createAdrCommand — validateInput callback (lines 62-70)
// =============================================================================

describe('createAdrCommand() — validateInput callback', () => {
  it('validateInput returns error for empty string', async () => {
    let capturedValidate: ((v: string) => string | null) | undefined;
    vi.mocked(vscode.window.showInputBox).mockImplementationOnce(
      async (opts?: { validateInput?: (v: string) => string | null }) => {
        capturedValidate = opts?.validateInput;
        return undefined; // simulate cancel so the command exits
      },
    );

    await createAdrCommand();

    expect(capturedValidate).toBeDefined();
    expect(capturedValidate!('')).toBe('Title is required');
    expect(capturedValidate!('   ')).toBe('Title is required');
  });

  it('validateInput returns error when title exceeds 120 chars', async () => {
    let capturedValidate: ((v: string) => string | null) | undefined;
    vi.mocked(vscode.window.showInputBox).mockImplementationOnce(
      async (opts?: { validateInput?: (v: string) => string | null }) => {
        capturedValidate = opts?.validateInput;
        return undefined;
      },
    );

    await createAdrCommand();

    const longTitle = 'x'.repeat(121);
    expect(capturedValidate!(longTitle)).toBe(
      'Title must be 120 characters or fewer',
    );
  });

  it('validateInput returns null for valid title (exactly 120 chars)', async () => {
    let capturedValidate: ((v: string) => string | null) | undefined;
    vi.mocked(vscode.window.showInputBox).mockImplementationOnce(
      async (opts?: { validateInput?: (v: string) => string | null }) => {
        capturedValidate = opts?.validateInput;
        return undefined;
      },
    );

    await createAdrCommand();

    const exactTitle = 'x'.repeat(120);
    expect(capturedValidate!(exactTitle)).toBeNull();
  });

  it('validateInput returns null for normal title', async () => {
    let capturedValidate: ((v: string) => string | null) | undefined;
    vi.mocked(vscode.window.showInputBox).mockImplementationOnce(
      async (opts?: { validateInput?: (v: string) => string | null }) => {
        capturedValidate = opts?.validateInput;
        return undefined;
      },
    );

    await createAdrCommand();

    expect(capturedValidate!('Use Redis for caching')).toBeNull();
  });
});

// =============================================================================
// confirmNoDuplicate — "+N more" suffix when 2+ similar ADRs exist
// =============================================================================

describe('confirmNoDuplicate — multiple similar ADRs', () => {
  it('includes "+1 more" suffix when 2 similar ADRs are found', async () => {
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
          filePath: DR1,
        },
        score: 0.9,
      },
      {
        adr: {
          id: 'DR-002',
          title: 'Use PostgreSQL for reads',
          status: 'proposed',
          date: '2026-05-28',
          filePath: `${WS}/docs/decisions/DR-002.md`,
        },
        score: 0.7,
      },
    ]);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      undefined as never,
    );

    await createAdrCommand();

    const warnCalls = vi.mocked(vscode.window.showWarningMessage).mock.calls;
    expect(warnCalls.length).toBe(1);
    const msg = warnCalls[0][0] as string;
    expect(msg).toContain('+1 more');
    expect(createAdr).not.toHaveBeenCalled();
  });

  it('includes "+2 more" suffix when 3 similar ADRs are found', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('PG decision');
    vi.mocked(findSimilarAdrs).mockReturnValueOnce([
      {
        adr: {
          id: 'DR-001',
          title: 'First',
          status: 'proposed',
          date: '2026-05-27',
          filePath: DR1,
        },
        score: 0.9,
      },
      {
        adr: {
          id: 'DR-002',
          title: 'Second',
          status: 'proposed',
          date: '2026-05-27',
          filePath: `${WS}/docs/decisions/DR-002.md`,
        },
        score: 0.8,
      },
      {
        adr: {
          id: 'DR-003',
          title: 'Third',
          status: 'proposed',
          date: '2026-05-27',
          filePath: `${WS}/docs/decisions/DR-003.md`,
        },
        score: 0.7,
      },
    ]);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      undefined as never,
    );

    await createAdrCommand();

    const msg = vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0] as string;
    expect(msg).toContain('+2 more');
  });

  it('no "+N more" suffix when exactly 1 similar ADR', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('PG decision');
    vi.mocked(findSimilarAdrs).mockReturnValueOnce([
      {
        adr: {
          id: 'DR-001',
          title: 'First',
          status: 'proposed',
          date: '2026-05-27',
          filePath: DR1,
        },
        score: 0.9,
      },
    ]);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      undefined as never,
    );

    await createAdrCommand();

    const msg = vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0] as string;
    expect(msg).not.toContain('more');
  });
});

// =============================================================================
// applyStatus — inner try/catch when regenerateDrIndex throws
// =============================================================================

describe('applyStatus — inner regenerateDrIndex failure is swallowed', () => {
  it('status write succeeds and user sees success even when index regen throws', async () => {
    setActiveEditor(DR1);
    vi.mocked(listAdrs).mockReturnValueOnce([
      {
        id: 'DR-001',
        title: 'Use PG',
        status: 'proposed',
        date: '2026-05-27',
        filePath: DR1,
      },
    ]);
    // setAdrStatus succeeds
    vi.mocked(setAdrStatus).mockReturnValueOnce(undefined);
    // regenerateDrIndex (the index regen inside applyStatus) throws
    vi.mocked(regenerateDrIndex).mockImplementationOnce(() => {
      throw new Error('index regen boom');
    });

    await acceptAdrCommand(undefined);

    // status was written
    expect(setAdrStatus).toHaveBeenCalledWith(DR1, 'accepted');
    // success message still shown (inner catch is best-effort)
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: DR-001 → accepted',
    );
    // the index regen error must NOT surface to the user
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });
});

// =============================================================================
// applyStatus — outer error path (setAdrStatus itself throws)
// =============================================================================

describe('applyStatus — setAdrStatus throws', () => {
  it('shows error when setAdrStatus throws an Error', async () => {
    setActiveEditor(DR1);
    vi.mocked(listAdrs).mockReturnValueOnce([
      {
        id: 'DR-001',
        title: 'Use PG',
        status: 'proposed',
        date: '2026-05-27',
        filePath: DR1,
      },
    ]);
    vi.mocked(setAdrStatus).mockImplementationOnce(() => {
      throw new Error('fs write failed');
    });

    await acceptAdrCommand(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to set status — fs write failed',
    );
  });

  it('shows error when setAdrStatus throws a non-Error', async () => {
    setActiveEditor(DR1);
    vi.mocked(listAdrs).mockReturnValueOnce([
      {
        id: 'DR-001',
        title: 'Use PG',
        status: 'proposed',
        date: '2026-05-27',
        filePath: DR1,
      },
    ]);
    vi.mocked(setAdrStatus).mockImplementationOnce(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'raw string error';
    });

    await acceptAdrCommand(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to set status — raw string error',
    );
  });
});

// =============================================================================
// applyStatus — pre-MinSpec DR (no frontmatter) offers to add it first (#201)
// =============================================================================

describe('applyStatus — frontmatter-less DR offer', () => {
  const resolveBare = (): void => {
    setActiveEditor(DR1);
    vi.mocked(listAdrs).mockReturnValueOnce([
      { id: 'DR-001', title: 'Use PG', status: 'proposed', date: '', filePath: DR1 },
    ]);
    vi.mocked(adrHasFrontmatter).mockReturnValueOnce(false);
  };

  it('writes status after the user confirms the modal offer', async () => {
    resolveBare();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      'Add Frontmatter' as never,
    );

    await acceptAdrCommand(undefined);

    const warn = vi.mocked(vscode.window.showWarningMessage).mock.calls[0];
    expect(warn[0]).toContain('predates MinSpec');
    expect(warn[1]).toEqual({ modal: true });
    expect(setAdrStatus).toHaveBeenCalledWith(DR1, 'accepted');
  });

  it('aborts without writing when the user dismisses the modal', async () => {
    resolveBare();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      undefined as never,
    );

    await acceptAdrCommand(undefined);

    expect(setAdrStatus).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('does not prompt when the DR already has frontmatter', async () => {
    setActiveEditor(DR1);
    vi.mocked(listAdrs).mockReturnValueOnce([
      { id: 'DR-001', title: 'Use PG', status: 'proposed', date: '', filePath: DR1 },
    ]);
    // adrHasFrontmatter default (true) — no override.

    await acceptAdrCommand(undefined);

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(setAdrStatus).toHaveBeenCalledWith(DR1, 'accepted');
  });
});

// =============================================================================
// setAdrStatusCommand — same-status no-op
// =============================================================================

describe('setAdrStatusCommand() — same-status no-op', () => {
  it('returns early without calling setAdrStatus when user picks the current status', async () => {
    setActiveEditor(DR1);
    vi.mocked(listAdrs).mockReturnValueOnce([
      {
        id: 'DR-001',
        title: 'Use PG',
        status: 'accepted',
        date: '2026-05-27',
        filePath: DR1,
      },
    ]);
    // Simulate user picking the SAME status that's already set
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: '$(check) Accepted',
      description: 'current',
      value: 'accepted',
    } as never);

    await setAdrStatusCommand(undefined);

    expect(setAdrStatus).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('returns early without calling setAdrStatus when picker is cancelled', async () => {
    setActiveEditor(DR1);
    vi.mocked(listAdrs).mockReturnValueOnce([
      {
        id: 'DR-001',
        title: 'Use PG',
        status: 'proposed',
        date: '2026-05-27',
        filePath: DR1,
      },
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(
      undefined as never,
    );

    await setAdrStatusCommand(undefined);

    expect(setAdrStatus).not.toHaveBeenCalled();
  });
});

// =============================================================================
// T3 REGRESSION (harvest316/minspec#169): palette accept must not dead-end when
// open-decision detection misses (e.g. Ctrl-Shift-V preview, stale editor).
// Before the fix, resolveAdr hard-failed "No decision selected"; now a
// quick-pick of all decisions backstops it.
// =============================================================================

describe('acceptAdrCommand() — backstop quick-pick when no decision resolves from the editor', () => {
  it('offers a pick of unaccepted decisions and accepts the chosen one', async () => {
    // Simulate the failure condition: no live ADR editor and no preview cache
    // hit, so resolveActiveAdrPath() yields nothing (open-decision miss).
    setActiveEditor(undefined);
    const DR21 = `${WS}/docs/decisions/DR-021.md`;
    vi.mocked(listAdrs).mockReturnValueOnce([
      { id: 'DR-021', title: 'Lifecycle floor', status: 'proposed', date: '2026-06-05', filePath: DR21 },
      { id: 'DR-001', title: 'Already accepted', status: 'accepted', date: '2026-05-27', filePath: DR1 },
    ]);
    // User selects the proposed decision from the backstop pick.
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'DR-021: Lifecycle floor',
      description: 'proposed',
      adr: { filePath: DR21, status: 'proposed', id: 'DR-021' },
    } as never);

    await acceptAdrCommand(undefined);

    // The pick was offered (no dead-end) and only the unaccepted decision was a
    // candidate — accept hides already-accepted ones.
    const items = vi.mocked(vscode.window.showQuickPick).mock.calls[0][0] as {
      adr: { id: string };
    }[];
    expect(items.map((i) => i.adr.id)).toEqual(['DR-021']);
    // The chosen decision was accepted; no "No decision selected" error.
    expect(setAdrStatus).toHaveBeenCalledWith(DR21, 'accepted');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('backstop pick can be cancelled without error', async () => {
    setActiveEditor(undefined);
    vi.mocked(listAdrs).mockReturnValueOnce([
      { id: 'DR-021', title: 'Lifecycle floor', status: 'proposed', date: '2026-06-05', filePath: `${WS}/docs/decisions/DR-021.md` },
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined as never);

    await acceptAdrCommand(undefined);

    expect(setAdrStatus).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });
});

// =============================================================================
// pickAdr — active path present but folderForFile returns undefined
// =============================================================================

describe('pickAdr() — activePath with no folder', () => {
  it('falls back to resolveTargetFolder (no-workspace) when activePath is outside any workspace', async () => {
    // Set an active editor with a path that is outside the workspace
    setActiveEditor('/outside/workspace/DR-001.md');
    // getWorkspaceFolder returns undefined — no workspace contains this path
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined);
    // workspaceFolders also null so folderForFile has no fallback
    setNoWorkspace();

    await acceptAdrCommand(undefined);

    // Open-decision detection can't resolve a folder, so the backstop runs and
    // hits resolveTargetFolder's no-workspace guard — never silently dead-ends.
    expect(setAdrStatus).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: No workspace folder open.',
    );
  });

  it('resolves ADR when decisionsDir is configured (line 135 overrides branch)', async () => {
    // Palette path: active editor is an ADR file AND decisionsDir is configured.
    setActiveEditor(DR1);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string) =>
        key === 'decisionsDir' ? 'custom/drs' : undefined,
      ),
    } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(listAdrs).mockReturnValueOnce([
      {
        id: 'DR-001',
        title: 'Use PG',
        status: 'proposed',
        date: '2026-05-27',
        filePath: DR1,
      },
    ]);

    await acceptAdrCommand(undefined);

    // Should have resolved and called setAdrStatus correctly
    expect(setAdrStatus).toHaveBeenCalledWith(DR1, 'accepted');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });
});

// =============================================================================
// setAdrStatusCommand — !resolved early return (line 201)
// =============================================================================

describe('setAdrStatusCommand() — no open ADR, empty register', () => {
  it('shows "No decisions found" (not a dead-end error) when nothing is open and the register is empty', async () => {
    setActiveEditor(undefined);
    // listAdrs default mock returns [] — empty register.

    await setAdrStatusCommand(undefined);

    // Backstop ran (resolveTargetFolder → workspace → listAdrs []), reported the
    // empty register, and never showed a status pick.
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(setAdrStatus).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: No decisions found.',
    );
  });
});

// =============================================================================
// applyStatus — with decisionsDir configured (line 168 overrides branch)
// =============================================================================

describe('applyStatus — decisionsDir configured triggers overrides in regen', () => {
  it('passes decisionsDir to regenerateDrIndex inside applyStatus (line 168)', async () => {
    setActiveEditor(DR1);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string) =>
        key === 'decisionsDir' ? 'custom/drs' : undefined,
      ),
    } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(listAdrs).mockReturnValueOnce([
      {
        id: 'DR-001',
        title: 'Use PG',
        status: 'proposed',
        date: '2026-05-27',
        filePath: DR1,
      },
    ]);
    vi.mocked(regenerateDrIndex).mockReturnValueOnce(undefined as never);

    await acceptAdrCommand(undefined);

    expect(setAdrStatus).toHaveBeenCalledWith(DR1, 'accepted');
    expect(regenerateDrIndex).toHaveBeenCalledWith(
      WS,
      { decisionsDir: 'custom/drs' },
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: DR-001 → accepted',
    );
  });
});

// =============================================================================
// promptAdrOnT4Classification — validateInput callback (lines 274-277)
// =============================================================================

describe('promptAdrOnT4Classification() — validateInput callback', () => {
  it('validateInput returns "Title is required" for empty string', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Create ADR' as unknown as undefined,
    );

    let capturedValidate: ((v: string) => string | null) | undefined;
    vi.mocked(vscode.window.showInputBox).mockImplementationOnce(
      async (opts?: { validateInput?: (v: string) => string | null }) => {
        capturedValidate = opts?.validateInput;
        return undefined; // cancel so command exits after capturing validator
      },
    );

    await promptAdrOnT4Classification('my task');

    expect(capturedValidate).toBeDefined();
    expect(capturedValidate!('')).toBe('Title is required');
    expect(capturedValidate!('   ')).toBe('Title is required');
  });

  it('validateInput returns null for a non-empty title', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Create ADR' as unknown as undefined,
    );

    let capturedValidate: ((v: string) => string | null) | undefined;
    vi.mocked(vscode.window.showInputBox).mockImplementationOnce(
      async (opts?: { validateInput?: (v: string) => string | null }) => {
        capturedValidate = opts?.validateInput;
        return undefined;
      },
    );

    await promptAdrOnT4Classification();

    expect(capturedValidate!('Some valid title')).toBeNull();
  });

  it('dedup gate cancel path returns false', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Create ADR' as unknown as undefined,
    );
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(
      'Auth decision',
    );
    // Trigger dedup hit
    vi.mocked(findSimilarAdrs).mockReturnValueOnce([
      {
        adr: {
          id: 'DR-001',
          title: 'Auth something',
          status: 'proposed',
          date: '2026-05-27',
          filePath: DR1,
        },
        score: 0.9,
      },
    ]);
    // User dismisses warning (cancel)
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      undefined as never,
    );

    const result = await promptAdrOnT4Classification();

    expect(result).toBe(false);
    expect(createAdr).not.toHaveBeenCalled();
  });

  it('dedup gate "Open existing" in T4 path also returns false', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Create ADR' as unknown as undefined,
    );
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(
      'Auth decision',
    );
    vi.mocked(findSimilarAdrs).mockReturnValueOnce([
      {
        adr: {
          id: 'DR-001',
          title: 'Auth something',
          status: 'proposed',
          date: '2026-05-27',
          filePath: DR1,
        },
        score: 0.9,
      },
    ]);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      'Open existing' as never,
    );
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
      {} as vscode.TextDocument,
    );

    const result = await promptAdrOnT4Classification();

    expect(result).toBe(false);
    expect(createAdr).not.toHaveBeenCalled();
  });

  it('value: is empty string (not pre-filled) when no taskTitle', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Create ADR' as unknown as undefined,
    );
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

    await promptAdrOnT4Classification(undefined);

    expect(vscode.window.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({ value: '' }),
    );
  });

  it('passes decisionsDir override when configured (line 286 branch)', async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string) =>
        key === 'decisionsDir' ? 'custom/drs' : undefined,
      ),
    } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Create ADR' as unknown as undefined,
    );
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('My T4 decision');
    vi.mocked(createAdr).mockReturnValueOnce({
      id: 'DR-005',
      title: 'My T4 decision',
      status: 'proposed',
      date: '2026-05-27',
      filePath: `${WS}/custom/drs/DR-005.md`,
    });
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
      {} as vscode.TextDocument,
    );

    const result = await promptAdrOnT4Classification('T4 task');

    expect(result).toBe(true);
    expect(createAdr).toHaveBeenCalledWith(
      WS,
      'My T4 decision',
      { decisionsDir: 'custom/drs' },
    );
  });
});
