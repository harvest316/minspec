/**
 * approve-action.test.ts
 *
 * Covers the post-selection action paths in approve.ts — the paths left
 * uncovered by approve-command.test.ts which cancels the quick-pick before
 * any action runs.
 *
 * FILE ALLOWLIST: only this file is created/modified.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ───────────────────────────────────────────────────────────

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showTextDocument: vi.fn(),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/ws' } }],
    openTextDocument: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
}));

vi.mock('../src/views/spec-tree-provider', () => ({
  listSpecs: vi.fn(),
}));

vi.mock('../src/lib/approval', () => ({
  approveSpec: vi.fn(),
  revokeApproval: vi.fn(() => true),
  getApprovalStatus: vi.fn(() => 'unapproved'),
  gitConfigEmail: vi.fn(() => 'tester@example.com'),
}));

// Mock the libs called inside the action body
vi.mock('../src/lib/spec', () => ({
  readSpecFile: vi.fn(),
  setSpecStatus: vi.fn(),
}));

vi.mock('../src/lib/config', async (importOriginal) => ({
  ...(await importOriginal()),
  loadConfig: vi.fn(() => ({})),
}));

vi.mock('../src/lib/spec-validator', () => ({
  validateSpec: vi.fn(),
}));

vi.mock('../src/lib/epic-manager', () => ({
  epicRefSet: vi.fn(() => new Set<string>()),
}));

// ─── Imports ───────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { approveSpecCommand, revokeApprovalCommand } from '../src/commands/approve';
import { listSpecs } from '../src/views/spec-tree-provider';
import {
  approveSpec,
  revokeApproval,
  getApprovalStatus,
} from '../src/lib/approval';
import type { ApprovalStatus } from '../src/lib/approval';
import type { SpecSummary } from '../src/views/spec-tree-provider';
import { readSpecFile, setSpecStatus } from '../src/lib/spec';
import { validateSpec } from '../src/lib/spec-validator';

// ─── Helpers ───────────────────────────────────────────────────────────────

function summary(
  id: string,
  title: string,
  status: string = 'specifying',
): SpecSummary {
  return {
    id,
    title,
    tier: 'T2',
    status,
    currentPhase: 'specify',
    filePath: `/tmp/ws/specs/minspec/${id}/spec.md`,
    phasesDone: 0,
    phasesTotal: 4,
  } as unknown as SpecSummary;
}

/** Build a minimal ParsedSpec-like object for readSpecFile mocks. */
function parsedSpec(status: string = 'specifying') {
  return {
    frontmatter: { id: 'SPEC-001', status, tier: 'T2' },
    preamble: '',
    sections: {},
    phaseSections: {},
    raw: '',
  };
}

/** Build a complete ValidationResult (no violations). */
function completeResult() {
  return { complete: true, violations: [] };
}

/** Build a ValidationResult with blocking errors. */
function incompleteResult(messages: string[]) {
  return {
    complete: false,
    violations: messages.map((m) => ({
      message: m,
      severity: 'error',
      fixHint: `fix: ${m}`,
    })),
  };
}

/** Build a ValidationResult that is complete but has warnings. */
function completeWithWarnings(warnings: string[]) {
  return {
    complete: true,
    violations: warnings.map((m) => ({ message: m, severity: 'warning', fixHint: '' })),
  };
}

/** Make the quick-pick resolve by returning the first item in the list. */
function pickFirst() {
  vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(
    async (items: unknown) => (items as unknown[])[0],
  );
}

/** Drive getApprovalStatus per spec id (path-keyed now: recover id from filePath). */
function setStatuses(map: Record<string, ApprovalStatus>): void {
  vi.mocked(getApprovalStatus).mockImplementation((_root: string, filePath: string) => {
    const m = filePath.match(/\/(SPEC-\d+)\//);
    return map[m ? m[1] : ''] ?? 'unapproved';
  });
}

// ─── approveSpecCommand action paths ──────────────────────────────────────

describe('approveSpecCommand — action paths (post-selection)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSpecs).mockReturnValue([summary('SPEC-001', 'First')]);
    vi.mocked(getApprovalStatus).mockReturnValue('unapproved');
  });

  // ── no specs in workspace ────────────────────────────────────────────────

  it('shows "No specs found" and returns when listSpecs returns empty array', async () => {
    vi.mocked(listSpecs).mockReturnValue([]);

    await approveSpecCommand(undefined);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: No specs found.',
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(approveSpec).not.toHaveBeenCalled();
  });

  it('revoke also shows "No specs found" when listSpecs is empty', async () => {
    vi.mocked(listSpecs).mockReturnValue([]);

    await revokeApprovalCommand(undefined);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: No specs found.',
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(revokeApproval).not.toHaveBeenCalled();
  });

  // ── readSpecFile error ───────────────────────────────────────────────────

  it('shows an error and returns when readSpecFile throws', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockImplementationOnce(() => {
      throw new Error('file not found');
    });

    await approveSpecCommand(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Cannot read SPEC-001'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('file not found'),
    );
    expect(approveSpec).not.toHaveBeenCalled();
  });

  it('includes non-Error throw message in the error', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'plain string error';
    });

    await approveSpecCommand(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('plain string error'),
    );
  });

  // ── validation: incomplete spec ──────────────────────────────────────────

  it('refuses approval and shows modal error when spec is not complete', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec() as never);
    vi.mocked(validateSpec).mockReturnValueOnce(
      incompleteResult(['Missing plan section', 'Missing tasks section']) as never,
    );
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce(undefined as never);

    await approveSpecCommand(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('SPEC-001 is not complete'),
      expect.objectContaining({ modal: true }),
      'Open Spec',
    );
    expect(approveSpec).not.toHaveBeenCalled();
  });

  it('opens the spec document when user picks "Open Spec" from the error modal', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec() as never);
    vi.mocked(validateSpec).mockReturnValueOnce(
      incompleteResult(['Missing plan section']) as never,
    );
    const fakeDoc = { uri: { fsPath: '/tmp/ws/specs/minspec/SPEC-001/spec.md' } };
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(fakeDoc as never);
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce('Open Spec' as never);

    await approveSpecCommand(undefined);

    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(fakeDoc);
    expect(approveSpec).not.toHaveBeenCalled();
  });

  // ── no confirmation modal (#104: selecting + picking IS the explicit act) ──

  it('approves a complete spec directly, with no confirmation modal', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec() as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);

    await approveSpecCommand(undefined);

    // No modal at all — approval proceeds on the explicit pick.
    expect(approveSpec).toHaveBeenCalled();
    const modalCalls = vi
      .mocked(vscode.window.showWarningMessage)
      .mock.calls.filter((c) => (c[1] as { modal?: boolean } | undefined)?.modal);
    expect(modalCalls).toHaveLength(0);
  });

  it('surfaces warnings as a non-modal advisory after approving (never an approve-anyway gate)', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec() as never);
    vi.mocked(validateSpec).mockReturnValueOnce(
      completeWithWarnings(['Optional section missing']) as never,
    );

    await approveSpecCommand(undefined);

    // Approval still happened — warnings do not block.
    expect(approveSpec).toHaveBeenCalled();
    // The advisory is a non-modal warning toast carrying the warning text.
    const call = vi.mocked(vscode.window.showWarningMessage).mock.calls[0];
    expect(call[0]).toContain('Optional section missing');
    expect((call[1] as { modal?: boolean } | undefined)?.modal).toBeFalsy();
  });

  // ── successful approval ──────────────────────────────────────────────────

  it('calls approveSpec with correct (root, filePath, tier, email) args on confirm', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec() as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Approve' as never);

    await approveSpecCommand(undefined);

    // SPEC-022: path-keyed + attributed. The id is gone from the signature; the
    // captured git email is the new last arg.
    expect(approveSpec).toHaveBeenCalledWith(
      '/tmp/ws',
      '/tmp/ws/specs/minspec/SPEC-001/spec.md',
      'T2',
      'tester@example.com',
    );
  });

  it('advances status to implementing when spec was pre-impl (status=specifying)', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec('specifying') as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Approve' as never);

    await approveSpecCommand(undefined);

    expect(setSpecStatus).toHaveBeenCalledWith(
      '/tmp/ws/specs/minspec/SPEC-001/spec.md',
      'implementing',
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('status → implementing'),
    );
  });

  it('advances status to implementing when spec was pre-impl (status=new)', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec('new') as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Approve' as never);

    await approveSpecCommand(undefined);

    expect(setSpecStatus).toHaveBeenCalledWith(
      '/tmp/ws/specs/minspec/SPEC-001/spec.md',
      'implementing',
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('status → implementing'),
    );
  });

  it('does NOT flip status when spec is already implementing', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec('implementing') as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Approve' as never);

    await approveSpecCommand(undefined);

    expect(setSpecStatus).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.not.stringContaining('status → implementing'),
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Approved SPEC-001 for implementation.'),
    );
  });

  it('does NOT flip status when spec is done', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec('done') as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Approve' as never);

    await approveSpecCommand(undefined);

    expect(setSpecStatus).not.toHaveBeenCalled();
  });

  it('shows success info message and refreshes the tree after approval', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec('specifying') as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Approve' as never);

    await approveSpecCommand(undefined);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('✓ Approved SPEC-001'),
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('minspec.refreshTree');
  });

  it('shows error when approveSpec throws (catch path)', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec() as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Approve' as never);
    vi.mocked(approveSpec).mockImplementationOnce(() => {
      throw new Error('disk write failed');
    });

    await approveSpecCommand(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to approve'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('disk write failed'),
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('shows error with stringified message when catch value is not an Error', async () => {
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec() as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Approve' as never);
    vi.mocked(approveSpec).mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 42;
    });

    await approveSpecCommand(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('42'),
    );
  });

  // ── tree-node bypass (approve) ───────────────────────────────────────────

  it('uses the tree-node spec directly and skips the picker', async () => {
    const node = { spec: summary('SPEC-003', 'Third') };
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec('new') as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Approve' as never);

    await approveSpecCommand(node);

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(approveSpec).toHaveBeenCalledWith(
      '/tmp/ws',
      '/tmp/ws/specs/minspec/SPEC-003/spec.md',
      'T2',
      'tester@example.com',
    );
  });

  // ── no workspace ────────────────────────────────────────────────────────

  it('shows error and returns immediately when no workspace folder is open', async () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;

    await approveSpecCommand(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No workspace folder open'),
    );
    expect(listSpecs).not.toHaveBeenCalled();

    // Restore for subsequent tests
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: '/tmp/ws' } },
    ];
  });

  // ── stale spec re-approval ───────────────────────────────────────────────

  it('approves a stale spec (already had approval but was edited since)', async () => {
    vi.mocked(listSpecs).mockReturnValue([summary('SPEC-002', 'Stale One')]);
    setStatuses({ 'SPEC-002': 'stale' });
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec('implementing') as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Approve' as never);

    await approveSpecCommand(undefined);

    expect(approveSpec).toHaveBeenCalledWith(
      '/tmp/ws',
      '/tmp/ws/specs/minspec/SPEC-002/spec.md',
      'T2',
      'tester@example.com',
    );
    // Already implementing — no status flip
    expect(setSpecStatus).not.toHaveBeenCalled();
  });

  // ── first-approve revoke tip (#104: show once, not every approve) ──────────

  it('shows the editing-revokes tip once, then records it so it does not repeat', async () => {
    const store: Record<string, unknown> = {};
    const memento = {
      get: (k: string, d?: unknown) => (k in store ? store[k] : d),
      update: (k: string, v: unknown) => {
        store[k] = v;
        return Promise.resolve();
      },
    } as unknown as import('vscode').Memento;

    const tip = /editing an approved spec automatically revokes/i;

    // First approval — tip shown.
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec('new') as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);
    await approveSpecCommand(undefined, memento);
    expect(
      vi.mocked(vscode.window.showInformationMessage).mock.calls.some((c) =>
        tip.test(String(c[0])),
      ),
    ).toBe(true);

    // Second approval — flag set, tip suppressed.
    vi.mocked(vscode.window.showInformationMessage).mockClear();
    pickFirst();
    vi.mocked(readSpecFile).mockReturnValueOnce(parsedSpec('new') as never);
    vi.mocked(validateSpec).mockReturnValueOnce(completeResult() as never);
    await approveSpecCommand(undefined, memento);
    expect(
      vi.mocked(vscode.window.showInformationMessage).mock.calls.some((c) =>
        tip.test(String(c[0])),
      ),
    ).toBe(false);
  });
});

// ─── revokeApprovalCommand action paths ───────────────────────────────────

describe('revokeApprovalCommand — action paths (post-selection)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSpecs).mockReturnValue([summary('SPEC-001', 'First')]);
    setStatuses({ 'SPEC-001': 'approved' });
  });

  it('calls revokeApproval with correct (root, id) args and shows success message', async () => {
    pickFirst();
    vi.mocked(revokeApproval).mockReturnValueOnce(true);

    await revokeApprovalCommand(undefined);

    expect(revokeApproval).toHaveBeenCalledWith('/tmp/ws', '/tmp/ws/specs/minspec/SPEC-001/spec.md');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Revoked approval for SPEC-001'),
    );
  });

  it('shows "was not approved" message when revokeApproval returns false', async () => {
    pickFirst();
    vi.mocked(revokeApproval).mockReturnValueOnce(false);

    await revokeApprovalCommand(undefined);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('SPEC-001 was not approved'),
    );
  });

  it('refreshes the tree after revoke', async () => {
    pickFirst();
    vi.mocked(revokeApproval).mockReturnValueOnce(true);

    await revokeApprovalCommand(undefined);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('minspec.refreshTree');
  });

  it('shows error and returns immediately when no workspace folder is open', async () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;

    await revokeApprovalCommand(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No workspace folder open'),
    );
    expect(revokeApproval).not.toHaveBeenCalled();

    // Restore for subsequent tests
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: '/tmp/ws' } },
    ];
  });

  it('uses the tree-node spec directly and skips the picker', async () => {
    const node = { spec: summary('SPEC-004', 'Fourth') };
    vi.mocked(revokeApproval).mockReturnValueOnce(true);

    await revokeApprovalCommand(node);

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(revokeApproval).toHaveBeenCalledWith('/tmp/ws', '/tmp/ws/specs/minspec/SPEC-004/spec.md');
  });

  it('shows "was not approved" path even via tree node when revokeApproval returns false', async () => {
    const node = { spec: summary('SPEC-004', 'Fourth') };
    vi.mocked(revokeApproval).mockReturnValueOnce(false);

    await revokeApprovalCommand(node);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('SPEC-004 was not approved'),
    );
  });

  it('revoking a stale spec also succeeds', async () => {
    vi.mocked(listSpecs).mockReturnValue([summary('SPEC-005', 'Stale')]);
    setStatuses({ 'SPEC-005': 'stale' });
    pickFirst();
    vi.mocked(revokeApproval).mockReturnValueOnce(true);

    await revokeApprovalCommand(undefined);

    expect(revokeApproval).toHaveBeenCalledWith('/tmp/ws', '/tmp/ws/specs/minspec/SPEC-005/spec.md');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Revoked approval for SPEC-005'),
    );
  });
});
