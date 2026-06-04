import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ────────────────────────────────────────────────────────────

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showInputBox: vi.fn(),
    showTextDocument: vi.fn(),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/ws' } }],
    openTextDocument: vi.fn(),
    getWorkspaceFolder: vi.fn(),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file' }),
  },
}));

// ─── Mock lib deps ───────────────────────────────────────────────────────────

vi.mock('../src/lib/epic-manager', () => ({
  createEpic: vi.fn(),
  writeEpicIndex: vi.fn(),
  setEpicStatus: vi.fn(),
}));

vi.mock('../src/lib/resolve-folder', () => ({
  resolveTargetFolder: vi.fn(),
  folderForFile: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import {
  acceptEpicCommand,
  createEpicCommand,
  regenerateEpicIndexCommand,
} from '../src/commands/epic';
import {
  createEpic,
  writeEpicIndex,
  setEpicStatus,
} from '../src/lib/epic-manager';
import { resolveTargetFolder, folderForFile } from '../src/lib/resolve-folder';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Grab the options object passed to the Nth showInputBox call (0-indexed). */
function inputBoxOptions(callIndex = 0): { validateInput?: (v: string) => string | null } {
  const calls = (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mock.calls;
  return calls[callIndex][0] as { validateInput?: (v: string) => string | null };
}

// =============================================================================
// acceptEpicCommand
// =============================================================================

describe('acceptEpicCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "No epic selected" error when called with no node', async () => {
    await acceptEpicCommand(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: No epic selected.',
    );
    expect(setEpicStatus).not.toHaveBeenCalled();
  });

  it('shows "No epic selected" error when node has no epic', async () => {
    await acceptEpicCommand({});

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: No epic selected.',
    );
    expect(setEpicStatus).not.toHaveBeenCalled();
  });

  it('shows "No epic selected" error when epic has no filePath', async () => {
    await acceptEpicCommand({ epic: { id: 'EPIC-001', slug: 'auth', title: 'Auth', status: 'proposed', order: 1 } as never });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: No epic selected.',
    );
    expect(setEpicStatus).not.toHaveBeenCalled();
  });

  it('shows "already active" info message when epic.status is already active', async () => {
    const node = {
      epic: {
        id: 'EPIC-001',
        slug: 'auth',
        title: 'Auth Revamp',
        status: 'active' as const,
        order: 1,
        filePath: '/tmp/ws/docs/epics/EPIC-001.md',
      },
    };

    await acceptEpicCommand(node);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: EPIC-001 already active.',
    );
    expect(setEpicStatus).not.toHaveBeenCalled();
  });

  it('success path: calls setEpicStatus, writeEpicIndex when folder resolves, shows info', async () => {
    const node = {
      epic: {
        id: 'EPIC-002',
        slug: 'telemetry',
        title: 'Telemetry',
        status: 'proposed' as const,
        order: 2,
        filePath: '/tmp/ws/docs/epics/EPIC-002.md',
      },
    };
    vi.mocked(folderForFile).mockReturnValue('/tmp/ws');

    await acceptEpicCommand(node);

    expect(setEpicStatus).toHaveBeenCalledWith('/tmp/ws/docs/epics/EPIC-002.md', 'active');
    expect(folderForFile).toHaveBeenCalledWith('/tmp/ws/docs/epics/EPIC-002.md');
    expect(writeEpicIndex).toHaveBeenCalledWith('/tmp/ws');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: EPIC-002 → active',
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('success path: does not call writeEpicIndex when folderForFile returns undefined', async () => {
    const node = {
      epic: {
        id: 'EPIC-003',
        slug: 'search',
        title: 'Search',
        status: 'proposed' as const,
        order: 3,
        filePath: '/tmp/ws/docs/epics/EPIC-003.md',
      },
    };
    vi.mocked(folderForFile).mockReturnValue(undefined);

    await acceptEpicCommand(node);

    expect(setEpicStatus).toHaveBeenCalledWith('/tmp/ws/docs/epics/EPIC-003.md', 'active');
    expect(writeEpicIndex).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: EPIC-003 → active',
    );
  });

  it('success path: swallows writeEpicIndex throws (best-effort index regen)', async () => {
    const node = {
      epic: {
        id: 'EPIC-004',
        slug: 'payments',
        title: 'Payments',
        status: 'proposed' as const,
        order: 4,
        filePath: '/tmp/ws/docs/epics/EPIC-004.md',
      },
    };
    vi.mocked(folderForFile).mockReturnValue('/tmp/ws');
    vi.mocked(writeEpicIndex).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await acceptEpicCommand(node);

    // Still shows success despite writeEpicIndex throwing
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: EPIC-004 → active',
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows "Failed to accept epic" error when setEpicStatus throws', async () => {
    const node = {
      epic: {
        id: 'EPIC-005',
        slug: 'auth',
        title: 'Auth',
        status: 'proposed' as const,
        order: 5,
        filePath: '/tmp/ws/docs/epics/EPIC-005.md',
      },
    };
    vi.mocked(setEpicStatus).mockImplementationOnce(() => {
      throw new Error('permission denied');
    });

    await acceptEpicCommand(node);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to accept epic — permission denied',
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('handles non-Error thrown by setEpicStatus', async () => {
    const node = {
      epic: {
        id: 'EPIC-006',
        slug: 'auth',
        title: 'Auth',
        status: 'proposed' as const,
        order: 6,
        filePath: '/tmp/ws/docs/epics/EPIC-006.md',
      },
    };
    vi.mocked(setEpicStatus).mockImplementationOnce(() => {
      throw 'string error'; // eslint-disable-line no-throw-literal
    });

    await acceptEpicCommand(node);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to accept epic — string error',
    );
  });
});

// =============================================================================
// createEpicCommand
// =============================================================================

describe('createEpicCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early with no-op when resolveTargetFolder returns undefined', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue(undefined);

    await createEpicCommand();

    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(createEpic).not.toHaveBeenCalled();
  });

  it('returns early with no-op when title input is cancelled (undefined)', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined); // title cancelled

    await createEpicCommand();

    expect(createEpic).not.toHaveBeenCalled();
  });

  it('title validateInput: returns error for empty string', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined); // cancel after check

    await createEpicCommand();

    // Grab the title options from the first showInputBox call
    const opts = inputBoxOptions(0);
    expect(opts.validateInput!('')).toBe('Title is required');
  });

  it('title validateInput: returns error for whitespace-only string', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

    await createEpicCommand();

    const opts = inputBoxOptions(0);
    expect(opts.validateInput!('   ')).toBe('Title is required');
  });

  it('title validateInput: returns error when title exceeds 120 characters', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

    await createEpicCommand();

    const opts = inputBoxOptions(0);
    const longTitle = 'a'.repeat(121);
    expect(opts.validateInput!(longTitle)).toBe('Title must be 120 characters or fewer');
  });

  it('title validateInput: returns null for a valid title', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

    await createEpicCommand();

    const opts = inputBoxOptions(0);
    expect(opts.validateInput!('Telemetry & RUM')).toBeNull();
  });

  it('title validateInput: accepts title of exactly 120 characters', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

    await createEpicCommand();

    const opts = inputBoxOptions(0);
    const exactTitle = 'a'.repeat(120);
    expect(opts.validateInput!(exactTitle)).toBeNull();
  });

  it('slug validateInput: returns error for invalid slug format', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    // Let title pass, then cancel on slug
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('Valid Title') // title
      .mockResolvedValueOnce(undefined);    // slug cancelled

    await createEpicCommand();

    const slugOpts = inputBoxOptions(1);
    expect(slugOpts.validateInput!('Invalid Slug!')).toBe(
      'Slug must be lowercase alphanumeric with hyphens (e.g. auth-revamp)',
    );
  });

  it('slug validateInput: returns error for slug starting with hyphen', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('Valid Title')
      .mockResolvedValueOnce(undefined);

    await createEpicCommand();

    const slugOpts = inputBoxOptions(1);
    expect(slugOpts.validateInput!('-bad')).toBe(
      'Slug must be lowercase alphanumeric with hyphens (e.g. auth-revamp)',
    );
  });

  it('slug validateInput: returns null for valid slug', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('Valid Title')
      .mockResolvedValueOnce(undefined);

    await createEpicCommand();

    const slugOpts = inputBoxOptions(1);
    expect(slugOpts.validateInput!('auth-revamp')).toBeNull();
  });

  it('slug validateInput: returns null for empty string (blank = derive from title)', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('Valid Title')
      .mockResolvedValueOnce(undefined);

    await createEpicCommand();

    const slugOpts = inputBoxOptions(1);
    expect(slugOpts.validateInput!('')).toBeNull();
  });

  it('success path: creates epic, opens doc, shows info "Created"', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('Telemetry & RUM')  // title
      .mockResolvedValueOnce('telemetry');         // slug
    const mockEpic = {
      id: 'EPIC-001',
      slug: 'telemetry',
      title: 'Telemetry & RUM',
      status: 'proposed' as const,
      order: 1,
      filePath: '/tmp/ws/docs/epics/EPIC-001.md',
    };
    vi.mocked(createEpic).mockReturnValue(mockEpic);
    const mockDoc = { uri: { fsPath: '/tmp/ws/docs/epics/EPIC-001.md' } };
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
      mockDoc as unknown as vscode.TextDocument,
    );

    await createEpicCommand();

    expect(createEpic).toHaveBeenCalledWith('/tmp/ws', 'Telemetry & RUM', 'telemetry');
    expect(writeEpicIndex).toHaveBeenCalledWith('/tmp/ws');
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
      '/tmp/ws/docs/epics/EPIC-001.md',
    );
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Created EPIC-001 — Telemetry & RUM',
    );
  });

  it('success path: passes undefined slug when slug input is blank (derived from title)', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('Auth Revamp')  // title
      .mockResolvedValueOnce('');             // blank slug → derive
    const mockEpic = {
      id: 'EPIC-002',
      slug: 'auth-revamp',
      title: 'Auth Revamp',
      status: 'proposed' as const,
      order: 2,
      filePath: '/tmp/ws/docs/epics/EPIC-002.md',
    };
    vi.mocked(createEpic).mockReturnValue(mockEpic);
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
      {} as vscode.TextDocument,
    );

    await createEpicCommand();

    // Blank slug trimmed = '' || undefined → undefined passed to createEpic
    expect(createEpic).toHaveBeenCalledWith('/tmp/ws', 'Auth Revamp', undefined);
  });

  it('success path: passes undefined slug when slug input is cancelled (undefined)', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('Auth Revamp')  // title
      .mockResolvedValueOnce(undefined);      // slug cancelled → treat as blank
    const mockEpic = {
      id: 'EPIC-002',
      slug: 'auth-revamp',
      title: 'Auth Revamp',
      status: 'proposed' as const,
      order: 2,
      filePath: '/tmp/ws/docs/epics/EPIC-002.md',
    };
    vi.mocked(createEpic).mockReturnValue(mockEpic);
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
      {} as vscode.TextDocument,
    );

    await createEpicCommand();

    expect(createEpic).toHaveBeenCalledWith('/tmp/ws', 'Auth Revamp', undefined);
  });

  it('success path: swallows writeEpicIndex throws (best-effort index regen)', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('Search')
      .mockResolvedValueOnce('search');
    const mockEpic = {
      id: 'EPIC-003',
      slug: 'search',
      title: 'Search',
      status: 'proposed' as const,
      order: 3,
      filePath: '/tmp/ws/docs/epics/EPIC-003.md',
    };
    vi.mocked(createEpic).mockReturnValue(mockEpic);
    vi.mocked(writeEpicIndex).mockImplementationOnce(() => {
      throw new Error('index error');
    });
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
      {} as vscode.TextDocument,
    );

    await createEpicCommand();

    // Should still open the file and show info even though writeEpicIndex threw
    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Created EPIC-003 — Search',
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows "Failed to create epic" error when createEpic throws', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('Bad Epic')
      .mockResolvedValueOnce('bad-epic');
    vi.mocked(createEpic).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await createEpicCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to create epic — disk full',
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('shows "Failed to create epic" error for non-Error throws', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('Bad Epic')
      .mockResolvedValueOnce('bad-epic');
    vi.mocked(createEpic).mockImplementationOnce(() => {
      throw 'string error'; // eslint-disable-line no-throw-literal
    });

    await createEpicCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to create epic — string error',
    );
  });
});

// =============================================================================
// regenerateEpicIndexCommand
// =============================================================================

describe('regenerateEpicIndexCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early with no-op when resolveTargetFolder returns undefined', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue(undefined);

    await regenerateEpicIndexCommand();

    expect(writeEpicIndex).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('success path: opens index file and shows singular message when count === 1', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(writeEpicIndex).mockReturnValue({
      filePath: '/tmp/ws/docs/epics/INDEX.md',
      count: 1,
    });
    const mockDoc = {};
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
      mockDoc as vscode.TextDocument,
    );

    await regenerateEpicIndexCommand();

    expect(writeEpicIndex).toHaveBeenCalledWith('/tmp/ws');
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
      '/tmp/ws/docs/epics/INDEX.md',
    );
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Regenerated epic INDEX (1 epic).',
    );
  });

  it('success path: shows plural message when count !== 1 (count === 0)', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(writeEpicIndex).mockReturnValue({
      filePath: '/tmp/ws/docs/epics/INDEX.md',
      count: 0,
    });
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
      {} as vscode.TextDocument,
    );

    await regenerateEpicIndexCommand();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Regenerated epic INDEX (0 epics).',
    );
  });

  it('success path: shows plural message when count !== 1 (count === 5)', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(writeEpicIndex).mockReturnValue({
      filePath: '/tmp/ws/docs/epics/INDEX.md',
      count: 5,
    });
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
      {} as vscode.TextDocument,
    );

    await regenerateEpicIndexCommand();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Regenerated epic INDEX (5 epics).',
    );
  });

  it('shows "Failed to regenerate" error when writeEpicIndex throws', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(writeEpicIndex).mockImplementationOnce(() => {
      throw new Error('index write failed');
    });

    await regenerateEpicIndexCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to regenerate epic INDEX — index write failed',
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('shows "Failed to regenerate" error for non-Error throws', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue('/tmp/ws');
    vi.mocked(writeEpicIndex).mockImplementationOnce(() => {
      throw 'string error'; // eslint-disable-line no-throw-literal
    });

    await regenerateEpicIndexCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to regenerate epic INDEX — string error',
    );
  });
});
