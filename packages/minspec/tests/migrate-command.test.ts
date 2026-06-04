import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ───────────────────────────────────────────────────────────

const mockConfigUpdate = vi.fn();

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      update: mockConfigUpdate,
    })),
  },
  ConfigurationTarget: {
    Workspace: 1,
  },
}));

// ─── Mock lib dep ──────────────────────────────────────────────────────────

vi.mock('../src/lib/spec-manager', () => ({
  migrateLayout: vi.fn(),
}));

// ─── Imports ───────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { migrateLayoutCommand } from '../src/commands/migrate';
import { migrateLayout } from '../src/lib/spec-manager';

// =============================================================================
// Tests
// =============================================================================

describe('migrateLayoutCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the config mock so update() is fresh for each test
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      update: mockConfigUpdate,
    } as unknown as vscode.WorkspaceConfiguration);
  });

  // ─── Branch 1: no workspaceRoot ───────────────────────────────────────────

  it('shows error and returns early when workspaceRoot is empty', async () => {
    await migrateLayoutCommand('');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: No workspace folder open.',
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(migrateLayout).not.toHaveBeenCalled();
  });

  // ─── Branch 2: user cancels quick-pick ────────────────────────────────────

  it('returns silently when the user dismisses the layout quick-pick', async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

    await migrateLayoutCommand('/tmp/ws');

    expect(vscode.window.showQuickPick).toHaveBeenCalled();
    expect(migrateLayout).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  // ─── Branch 3: success:false WITH warning ─────────────────────────────────

  it('shows error containing the warning when migration fails with a warning', async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'flat',
      description: 'specs/SPEC-NNN-slug.md (one file per spec)',
    } as unknown as vscode.QuickPickItem);
    vi.mocked(migrateLayout).mockReturnValueOnce({
      success: false,
      migrated: 0,
      target: 'flat',
      warning: 'conflicting files detected',
    });

    await migrateLayoutCommand('/tmp/ws');

    expect(migrateLayout).toHaveBeenCalledWith('/tmp/ws', 'flat');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Migration failed — conflicting files detected',
    );
    expect(mockConfigUpdate).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  // ─── Branch 4: success:false WITHOUT warning ──────────────────────────────

  it('shows error without a dash-warning when migration fails and warning is absent', async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'spec-kit',
      description: 'specs/NNN-slug/{spec,plan,tasks}.md — strict Spec Kit compat',
    } as unknown as vscode.QuickPickItem);
    vi.mocked(migrateLayout).mockReturnValueOnce({
      success: false,
      migrated: 0,
      target: 'spec-kit',
    });

    await migrateLayoutCommand('/tmp/ws');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Migration failed',
    );
    expect(mockConfigUpdate).not.toHaveBeenCalled();
  });

  // ─── Branch 5: success with migrated === 1 (singular "spec") ─────────────

  it('updates config and shows singular "spec" message when exactly 1 spec migrated', async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'flat',
      description: 'specs/SPEC-NNN-slug.md (one file per spec)',
    } as unknown as vscode.QuickPickItem);
    vi.mocked(migrateLayout).mockReturnValueOnce({
      success: true,
      migrated: 1,
      target: 'flat',
    });

    await migrateLayoutCommand('/tmp/ws');

    expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('minspec');
    expect(mockConfigUpdate).toHaveBeenCalledWith(
      'specsLayout',
      'flat',
      vscode.ConfigurationTarget.Workspace,
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Migrated 1 spec to flat layout.',
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  // ─── Branch 6: success with migrated !== 1 (plural "specs") ──────────────

  it('updates config and shows plural "specs" message when more than 1 spec migrated', async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'spec-kit',
      description: 'specs/NNN-slug/{spec,plan,tasks}.md — strict Spec Kit compat',
    } as unknown as vscode.QuickPickItem);
    vi.mocked(migrateLayout).mockReturnValueOnce({
      success: true,
      migrated: 5,
      target: 'spec-kit',
    });

    await migrateLayoutCommand('/tmp/ws');

    expect(mockConfigUpdate).toHaveBeenCalledWith(
      'specsLayout',
      'spec-kit',
      vscode.ConfigurationTarget.Workspace,
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Migrated 5 specs to spec-kit layout.',
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('uses plural "specs" when 0 specs were migrated (already on target layout)', async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'flat',
      description: 'specs/SPEC-NNN-slug.md (one file per spec)',
    } as unknown as vscode.QuickPickItem);
    vi.mocked(migrateLayout).mockReturnValueOnce({
      success: true,
      migrated: 0,
      target: 'flat',
    });

    await migrateLayoutCommand('/tmp/ws');

    expect(mockConfigUpdate).toHaveBeenCalledWith(
      'specsLayout',
      'flat',
      vscode.ConfigurationTarget.Workspace,
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Migrated 0 specs to flat layout.',
    );
  });
});
