/**
 * T3 — Regression Tests: init command write-failure surfacing (#153)
 *
 * Bug: initCommand / initRefreshCommand ran multi-file synchronous writes
 * (scaffold + harness generation) with NO error handling. A mid-sequence
 * write failure propagated uncaught — the success message never fired AND
 * nothing surfaced the failure to the user, leaving a misleadingly-partial
 * .minspec/ that the drift detector then reports as false drift.
 *
 * These tests assert that a simulated write failure:
 *   - surfaces an error via vscode.window.showErrorMessage, AND
 *   - does NOT silently complete (no success showInformationMessage).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ───────────────────────────────────────────────────────────

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
}));

// ─── Mock scaffold lib (the multi-file write sequence) ───────────────────────

vi.mock('../src/lib/scaffold', () => ({
  scaffold: vi.fn(),
  generateHarnessFiles: vi.fn(),
  refreshHarnessFiles: vi.fn(),
}));

// ─── Mock folder resolver (avoid touching the real workspace) ────────────────

vi.mock('../src/lib/resolve-folder', () => ({
  resolveTargetFolder: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { initCommand, initRefreshCommand } from '../src/commands/init';
import {
  scaffold,
  generateHarnessFiles,
  refreshHarnessFiles,
} from '../src/lib/scaffold';

// =============================================================================
// Tests
// =============================================================================

describe('initCommand() — write-failure surfacing (#153)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces an error and does NOT show success when a write fails mid-sequence', async () => {
    // Simulate a write failing partway through (e.g. EACCES on one harness file).
    vi.mocked(generateHarnessFiles).mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied, open 'CLAUDE.md'");
    });

    await expect(initCommand('/tmp/ws')).resolves.toBeUndefined();

    // The failure must be surfaced to the user…
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(vscode.window.showErrorMessage).mock.calls[0][0] as string;
    expect(msg).toContain('EACCES');
    // …and the command must NOT silently report success.
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('shows success and no error on the happy path', async () => {
    await initCommand('/tmp/ws');

    expect(scaffold).toHaveBeenCalledWith('/tmp/ws');
    expect(generateHarnessFiles).toHaveBeenCalledWith('/tmp/ws');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });
});

describe('initRefreshCommand() — write-failure surfacing (#153)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces an error and does NOT show success when refresh writes fail', async () => {
    vi.mocked(refreshHarnessFiles).mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    await expect(initRefreshCommand('/tmp/ws')).resolves.toBeUndefined();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(vscode.window.showErrorMessage).mock.calls[0][0] as string;
    expect(msg).toContain('ENOSPC');
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('shows success and no error on the happy path', async () => {
    await initRefreshCommand('/tmp/ws');

    expect(refreshHarnessFiles).toHaveBeenCalledWith('/tmp/ws');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });
});
