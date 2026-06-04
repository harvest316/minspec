/**
 * Focused coverage for commands/park.ts — targets the branches left uncovered
 * by commands.test.ts (lines 185, 190-193, 210):
 *
 *   commentOnExisting():
 *     1. method=file dedup hit, filePath set   → openTextDocument + showTextDocument (line 182-185)
 *     2. method=file dedup hit, no filePath    → early return without opening anything (line 185 branch)
 *     3. getRepoFromRemote returns null        → showErrorMessage (lines 190-193)
 *     4. commentOnIssue returns false          → showErrorMessage (line 210)
 *
 * All other parkCommand paths (happy path, cancel, force, dedup-open, dedup-force)
 * are already covered in commands.test.ts. This file ONLY adds the missing branches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ─────────────────────────────────────────────────────────────

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
    workspaceFolders: [{ uri: { fsPath: '/tmp/park-cmd-ws' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
    openTextDocument: vi.fn(() => Promise.resolve({ __mock: 'doc' })),
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
}));

// ─── Mock lib deps ────────────────────────────────────────────────────────────

vi.mock('../src/lib/session', () => ({
  loadSession: vi.fn(() => null),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('../src/lib/parking-lot', () => ({
  createParkingLotEntry: vi.fn(
    (title: string, body: string, sessionScope: string, labels: string[]) => ({
      title,
      body,
      labels,
      sessionScope,
      createdAt: '2026-06-04T00:00:00.000Z',
    }),
  ),
  parkTopic: vi.fn(),
  commentOnIssue: vi.fn(),
  getRepoFromRemote: vi.fn(() => Promise.resolve('owner/repo')),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { parkCommand } from '../src/commands/park';
import { parkTopic, commentOnIssue, getRepoFromRemote } from '../src/lib/parking-lot';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Wire up the three showInputBox calls: title, body, labels. */
function setupInputs(title = 'My topic', body = 'details', labels = 'idea,inbox'): void {
  vi.mocked(vscode.window.showInputBox)
    .mockResolvedValueOnce(title)
    .mockResolvedValueOnce(body)
    .mockResolvedValueOnce(labels);
}

// =============================================================================

describe('parkCommand() — commentOnExisting() uncovered branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Line 185: file-fallback dedup, filePath set — opens the file ──────────

  it('dedup hit, choice=comment, method=file with filePath → opens the local file (line 182-185)', async () => {
    setupInputs();

    // parkTopic returns a file-fallback dedup result (method=file, deduped).
    vi.mocked(parkTopic).mockResolvedValueOnce({
      method: 'file',
      filePath: '/tmp/park-cmd-ws/.minspec/parking-lot.md',
      deduped: true,
    });

    // User picks "comment" from the dedup quick-pick.
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      action: 'comment',
    } as never);

    await parkCommand();

    // commentOnExisting should open the file when method !== 'github'.
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
      '/tmp/park-cmd-ws/.minspec/parking-lot.md',
    );
    expect(vscode.window.showTextDocument).toHaveBeenCalled();

    // Must NOT attempt to call commentOnIssue (file-fallback has no issue).
    expect(commentOnIssue).not.toHaveBeenCalled();
    // Must NOT surface an error.
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  // ─── Line 185: file-fallback dedup, NO filePath — silent return ───────────

  it('dedup hit, choice=comment, method=file with NO filePath → returns silently (line 185 else-branch)', async () => {
    setupInputs();

    // ParkResult with method=file but no filePath (edge case: url also missing).
    vi.mocked(parkTopic).mockResolvedValueOnce({
      method: 'file',
      // filePath intentionally omitted
      deduped: true,
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      action: 'comment',
    } as never);

    await parkCommand();

    // Neither open nor comment nor error.
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(commentOnIssue).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  // ─── Lines 190-193: getRepoFromRemote returns null → error message ─────────

  it('dedup hit, choice=comment, getRepoFromRemote=null → shows error (lines 190-193)', async () => {
    setupInputs();

    vi.mocked(parkTopic).mockResolvedValueOnce({
      method: 'github',
      url: 'https://github.com/owner/repo/issues/7',
      deduped: true,
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      action: 'comment',
    } as never);

    // Simulate inability to resolve the remote repo.
    vi.mocked(getRepoFromRemote).mockResolvedValueOnce(null);

    await parkCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Could not determine the GitHub repo to comment on.',
    );
    // Must not attempt to post a comment when repo is unknown.
    expect(commentOnIssue).not.toHaveBeenCalled();
  });

  // ─── Line 210: commentOnIssue returns false → failure error message ────────

  it('dedup hit, choice=comment, commentOnIssue returns false → shows failure error (line 210)', async () => {
    setupInputs('Existing topic', 'extra context', 'idea,inbox');

    vi.mocked(parkTopic).mockResolvedValueOnce({
      method: 'github',
      url: 'https://github.com/owner/repo/issues/55',
      deduped: true,
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      action: 'comment',
    } as never);

    vi.mocked(getRepoFromRemote).mockResolvedValueOnce('owner/repo');
    vi.mocked(commentOnIssue).mockResolvedValueOnce(false);

    await parkCommand();

    expect(commentOnIssue).toHaveBeenCalledWith(
      'https://github.com/owner/repo/issues/55',
      expect.any(String),
      'owner/repo',
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Failed to comment on https://github.com/owner/repo/issues/55.',
    );
    // Must NOT show the success info message.
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  // ─── Open-existing: file-fallback dedup, method=file, has filePath ─────────
  // Covers the else-branch of `case 'open'` (result.filePath exists, not github).

  it('dedup hit, choice=open, method=file with filePath → opens the local file', async () => {
    setupInputs();

    vi.mocked(parkTopic).mockResolvedValueOnce({
      method: 'file',
      filePath: '/tmp/park-cmd-ws/.minspec/parking-lot.md',
      deduped: true,
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      action: 'open',
    } as never);

    const mockDoc = { __mock: 'doc' };
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(
      mockDoc as unknown as vscode.TextDocument,
    );

    await parkCommand();

    // openExternal must NOT be called (it's not a GitHub URL).
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
      '/tmp/park-cmd-ws/.minspec/parking-lot.md',
    );
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc);
  });

  // ─── Line 155 else-if false branch: open, method=file, no filePath ─────────
  // When result is file-method but has no filePath — neither github nor file
  // branch fires; just returns (the `else if` condition is false).

  it('dedup hit, choice=open, method=file NO filePath → no open, no external (line 155 false-branch)', async () => {
    setupInputs();

    vi.mocked(parkTopic).mockResolvedValueOnce({
      method: 'file',
      // filePath intentionally absent
      deduped: true,
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      action: 'open',
    } as never);

    await parkCommand();

    // Neither path fires — no external open, no document open.
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  // ─── Line 201 || false branch: entry.body is empty → fallback string used ──
  // entry.body || '(no additional context)' — the right side fires when body=''

  it('dedup hit, choice=comment, empty body → uses "(no additional context)" fallback (line 201)', async () => {
    // Pass empty body so entry.body='' (falsy) triggers the || right side.
    setupInputs('Topic without body', '', 'idea,inbox');

    vi.mocked(parkTopic).mockResolvedValueOnce({
      method: 'github',
      url: 'https://github.com/owner/repo/issues/77',
      deduped: true,
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      action: 'comment',
    } as never);

    vi.mocked(getRepoFromRemote).mockResolvedValueOnce('owner/repo');
    vi.mocked(commentOnIssue).mockResolvedValueOnce(true);

    await parkCommand();

    // The comment body must contain the fallback string.
    expect(commentOnIssue).toHaveBeenCalledWith(
      'https://github.com/owner/repo/issues/77',
      expect.stringContaining('(no additional context)'),
      'owner/repo',
    );
  });
});
