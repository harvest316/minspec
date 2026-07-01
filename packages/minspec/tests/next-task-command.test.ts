/**
 * Command + status-bar unit tests for the signpost wiring.
 *
 *  - nextTaskCommand: null task → "clear" toast, no document open; non-null →
 *    open target + imperative toast; build/resolve throw → "clear" toast, NO
 *    showErrorMessage, no rethrow (INV-DEGRADE at the command boundary).
 *  - formatNextTaskText: clear vs. imperative rendering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── mocks ───────────────────────────────────────────────────────────────────

const mockStatusBarItem = {
  text: '',
  tooltip: '',
  command: '',
  accessibilityInformation: undefined as unknown,
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showTextDocument: vi.fn(() => Promise.resolve({})),
    createStatusBarItem: vi.fn(() => mockStatusBarItem),
  },
  workspace: {
    openTextDocument: vi.fn(() => Promise.resolve({})),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
}));

vi.mock('../src/lib/artifact-graph', () => ({
  buildArtifactGraph: vi.fn(() => ({ epics: [], specs: [], adrs: [] })),
  artifactFileIndex: vi.fn(() => new Map<string, string>()),
}));

vi.mock('@aiclarity/shared', () => ({
  resolveNextTask: vi.fn(),
}));

import * as vscode from 'vscode';
import { resolveNextTask, type NextTask } from '@aiclarity/shared';
import { buildArtifactGraph, artifactFileIndex } from '../src/lib/artifact-graph';
import { nextTaskCommand } from '../src/commands/next-task';
import { formatNextTaskText } from '../src/views/status-bar';

const ROOT = '/tmp/ws';

function task(overrides: Partial<NextTask> = {}): NextTask {
  return {
    kind: 'spec-approve',
    targetId: 'SPEC-001',
    imperative: 'Approve SPEC-001',
    severityClass: 'pending',
    evidence: {
      severityClass: 'pending',
      rule: 'pending.spec-approve',
      explanation: 'SPEC-001 is unapproved',
      refs: ['SPEC-001'],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (buildArtifactGraph as ReturnType<typeof vi.fn>).mockReturnValue({ epics: [], specs: [], adrs: [] });
  (artifactFileIndex as ReturnType<typeof vi.fn>).mockReturnValue(new Map<string, string>());
});

describe('nextTaskCommand', () => {
  it('no workspace → "No workspace folder open." info, no resolve', async () => {
    await nextTaskCommand('')();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('MinSpec: No workspace folder open.');
    expect(resolveNextTask).not.toHaveBeenCalled();
  });

  it('null task → clear toast, no document opened', async () => {
    (resolveNextTask as ReturnType<typeof vi.fn>).mockReturnValue(null);
    await nextTaskCommand(ROOT)();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "MinSpec: nothing to review — you're clear. ✓",
    );
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('non-null task → opens target file + shows imperative toast', async () => {
    (resolveNextTask as ReturnType<typeof vi.fn>).mockReturnValue(task());
    (artifactFileIndex as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([['SPEC-001', '/tmp/ws/specs/SPEC-001.md']]),
    );
    await nextTaskCommand(ROOT)();
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith('/tmp/ws/specs/SPEC-001.md');
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('MinSpec: Approve SPEC-001');
  });

  it('target id with no resolvable file → shows imperative, skips open, no throw', async () => {
    (resolveNextTask as ReturnType<typeof vi.fn>).mockReturnValue(task({ targetId: 'SPEC-999' }));
    (artifactFileIndex as ReturnType<typeof vi.fn>).mockReturnValue(new Map<string, string>());
    await expect(nextTaskCommand(ROOT)()).resolves.toBeUndefined();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('MinSpec: Approve SPEC-001');
  });

  it('graph build throws → clear toast, NO error message, no rethrow', async () => {
    (buildArtifactGraph as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(nextTaskCommand(ROOT)()).resolves.toBeUndefined();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "MinSpec: nothing to review — you're clear. ✓",
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });
});

describe('formatNextTaskText', () => {
  it('null → clear', () => {
    expect(formatNextTaskText(null)).toBe('$(check) MinSpec: clear');
  });
  it('task → arrow + imperative', () => {
    expect(formatNextTaskText(task())).toBe('$(arrow-right) MinSpec: Approve SPEC-001');
  });
});
