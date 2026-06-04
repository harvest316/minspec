import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ─────────────────────────────────────────────────────────────

const mockChannel = {
  appendLine: vi.fn(),
  show: vi.fn(),
};

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
    createOutputChannel: vi.fn(() => mockChannel),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/ws' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
  },
}));

// ─── Mock lib dependencies ────────────────────────────────────────────────────

vi.mock('../src/lib/resolve-folder', () => ({
  resolveTargetFolder: vi.fn(),
}));

vi.mock('../src/lib/git-analyzer', () => ({
  analyzeGitDiff: vi.fn(),
}));

vi.mock('../src/lib/classifier', () => ({
  classify: vi.fn(),
  applyCalibration: vi.fn(),
  loadCalibration: vi.fn(),
  recordOverride: vi.fn(),
}));

vi.mock('../src/lib/config', () => ({
  loadConfig: vi.fn(),
  applyVSCodeOverrides: vi.fn((config: unknown) => config),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { classifyCommand } from '../src/commands/classify';
import { resolveTargetFolder } from '../src/lib/resolve-folder';
import { analyzeGitDiff } from '../src/lib/git-analyzer';
import { classify, applyCalibration, loadCalibration, recordOverride } from '../src/lib/classifier';
import { loadConfig, applyVSCodeOverrides } from '../src/lib/config';
import type { ClassificationSignal, ClassificationResult } from '../src/lib/classifier';
import type { MinspecConfig } from '../src/lib/config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WS = '/tmp/ws';

const FAKE_CONFIG = {
  specsDir: 'specs',
  decisionsDir: 'docs/decisions',
  phaseMappings: {
    T1: { requiredPhases: ['specify'], optionalPhases: [] },
    T2: { requiredPhases: ['specify', 'plan'], optionalPhases: [] },
    T3: { requiredPhases: ['specify', 'plan', 'tasks'], optionalPhases: ['implement'] },
    T4: { requiredPhases: ['specify', 'plan', 'tasks', 'implement'], optionalPhases: [] },
  },
} as unknown as MinspecConfig;

const FAKE_CALIBRATION = { overrides: [], weightAdjustments: {} };

function makeSignal(
  name: string,
  value: number,
  tier: 'T1' | 'T2' | 'T3' | 'T4' = 'T2',
  weight = 1,
): ClassificationSignal {
  return { name, value, weight, tierContribution: tier };
}

function makeResult(
  tier: 'T1' | 'T2' | 'T3' | 'T4',
  signals: ClassificationSignal[] = [],
  confidence = 0.8,
  phases: string[] = ['specify', 'plan'],
): ClassificationResult {
  return {
    tier,
    confidence,
    signals,
    suggestedPhases: phases as ClassificationResult['suggestedPhases'],
  };
}

// =============================================================================

describe('classifyCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Sensible defaults — most tests override what they need
    vi.mocked(resolveTargetFolder).mockResolvedValue(WS);
    vi.mocked(loadConfig).mockReturnValue(FAKE_CONFIG);
    vi.mocked(applyVSCodeOverrides).mockImplementation((cfg: unknown) => cfg as MinspecConfig);
    vi.mocked(loadCalibration).mockReturnValue(FAKE_CALIBRATION);
    vi.mocked(applyCalibration).mockImplementation((sigs) => sigs);
    vi.mocked(analyzeGitDiff).mockResolvedValue([]);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);
    mockChannel.appendLine.mockClear();
    mockChannel.show.mockClear();
  });

  // ── Line 8-9: resolveTargetFolder returns undefined (no workspace) ─────────

  it('returns early without showing anything when resolveTargetFolder returns undefined', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue(undefined);

    await classifyCommand();

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(analyzeGitDiff).not.toHaveBeenCalled();
  });

  // ── folderArg provided: skips resolveTargetFolder entirely ────────────────

  it('uses folderArg directly, skipping resolveTargetFolder', async () => {
    vi.mocked(analyzeGitDiff).mockResolvedValue([]);

    await classifyCommand('/direct/path');

    expect(resolveTargetFolder).not.toHaveBeenCalled();
    expect(loadConfig).toHaveBeenCalledWith('/direct/path');
  });

  // ── Lines 19-21: staged signals empty → fallback to unstaged ──────────────

  it('falls back to unstaged diff when staged diff returns no signals', async () => {
    const unstagedSignals = [makeSignal('fileCount', 3, 'T2')];
    vi.mocked(analyzeGitDiff)
      .mockResolvedValueOnce([])           // staged → empty
      .mockResolvedValueOnce(unstagedSignals); // unstaged → has signals
    vi.mocked(classify).mockReturnValue(makeResult('T2', unstagedSignals));

    await classifyCommand(WS);

    expect(analyzeGitDiff).toHaveBeenNthCalledWith(1, WS, { staged: true });
    expect(analyzeGitDiff).toHaveBeenNthCalledWith(2, WS, { staged: false });
    expect(classify).toHaveBeenCalled();
  });

  it('uses staged signals directly and does not call unstaged when staged is non-empty', async () => {
    const stagedSignals = [makeSignal('fileCount', 2, 'T1')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(stagedSignals);
    vi.mocked(classify).mockReturnValue(makeResult('T1', stagedSignals));

    await classifyCommand(WS);

    expect(analyzeGitDiff).toHaveBeenCalledTimes(1);
    expect(analyzeGitDiff).toHaveBeenCalledWith(WS, { staged: true });
  });

  // ── Lines 23-25: analyzeGitDiff throws → treat as empty signals ───────────

  it('treats signals as empty and shows "no changes" when analyzeGitDiff throws', async () => {
    vi.mocked(analyzeGitDiff).mockRejectedValue(new Error('git not found'));

    await classifyCommand(WS);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: No changes detected. Stage or modify files to classify.',
    );
    expect(classify).not.toHaveBeenCalled();
  });

  // ── Lines 27-32: no signals (both staged and unstaged empty) ─────────────

  it('shows "no changes detected" message and returns early when both staged and unstaged are empty', async () => {
    vi.mocked(analyzeGitDiff).mockResolvedValue([]);

    await classifyCommand(WS);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: No changes detected. Stage or modify files to classify.',
    );
    expect(classify).not.toHaveBeenCalled();
  });

  // ── Lines 34-50: happy path — shows classification result ─────────────────

  it('calls classify with calibrated signals and shows the tier/confidence/phases message', async () => {
    const signals = [makeSignal('fileCount', 4, 'T2', 1)];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(applyCalibration).mockReturnValue(signals);
    const result = makeResult('T2', signals, 0.75, ['specify', 'plan']);
    vi.mocked(classify).mockReturnValue(result);

    await classifyCommand(WS);

    expect(loadCalibration).toHaveBeenCalledWith(WS);
    expect(applyCalibration).toHaveBeenCalledWith(signals, FAKE_CALIBRATION);
    expect(classify).toHaveBeenCalledWith(signals, FAKE_CONFIG);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: T2 (75% confidence) · specify → plan',
      { detail: expect.stringContaining('fileCount=4'), modal: false },
      'Show Details',
      'Override Tier',
    );
  });

  it('caps signal summary at 4 signals in the detail string', async () => {
    const signals = [
      makeSignal('a', 1, 'T3'),
      makeSignal('b', 2, 'T3'),
      makeSignal('c', 3, 'T3'),
      makeSignal('d', 4, 'T3'),
      makeSignal('e', 5, 'T3'), // 5th — must NOT appear
    ];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(applyCalibration).mockReturnValue(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T3', signals, 1, ['specify', 'plan', 'tasks']));

    await classifyCommand(WS);

    const call = vi.mocked(vscode.window.showInformationMessage).mock.calls[0];
    const detail = (call[1] as { detail: string }).detail;
    expect(detail).toContain('a=1');
    expect(detail).toContain('d=4');
    expect(detail).not.toContain('e=5');
  });

  it('shows "none" in detail when there are no signals in the result', async () => {
    // signals array still non-empty to pass line 27 check, but classify returns empty signals
    const rawSignals = [makeSignal('x', 1, 'T1')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(rawSignals);
    vi.mocked(applyCalibration).mockReturnValue(rawSignals);
    vi.mocked(classify).mockReturnValue(makeResult('T1', [], 0, ['specify']));

    await classifyCommand(WS);

    const call = vi.mocked(vscode.window.showInformationMessage).mock.calls[0];
    const detail = (call[1] as { detail: string }).detail;
    expect(detail).toBe('Signals: none');
  });

  it('rounds confidence to nearest integer percent', async () => {
    const signals = [makeSignal('s', 1, 'T1')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(applyCalibration).mockReturnValue(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T1', signals, 0.334, ['specify']));

    await classifyCommand(WS);

    const firstArg = vi.mocked(vscode.window.showInformationMessage).mock.calls[0][0] as string;
    expect(firstArg).toContain('(33% confidence)');
  });

  // ── Lines 52-62: "Show Details" branch ───────────────────────────────────

  it('opens an output channel with full signal details when user picks "Show Details"', async () => {
    const signals = [
      makeSignal('fileCount', 5, 'T2', 2),
      makeSignal('lineCount', 120, 'T3', 3),
    ];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(applyCalibration).mockReturnValue(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T3', signals, 0.5, ['specify', 'plan', 'tasks']));
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      'Show Details' as unknown as undefined,
    );

    await classifyCommand(WS);

    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('MinSpec Classification');
    expect(mockChannel.appendLine).toHaveBeenCalledWith('Tier: T3');
    expect(mockChannel.appendLine).toHaveBeenCalledWith('Confidence: 50%');
    expect(mockChannel.appendLine).toHaveBeenCalledWith('Suggested phases: specify → plan → tasks');
    expect(mockChannel.appendLine).toHaveBeenCalledWith('Signals:');
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      '  fileCount (T2, weight 2): 5',
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      '  lineCount (T3, weight 3): 120',
    );
    expect(mockChannel.show).toHaveBeenCalled();
  });

  // ── Lines 63-84: "Override Tier" branch ──────────────────────────────────

  it('shows tier quick-pick when user picks "Override Tier"', async () => {
    const signals = [makeSignal('fileCount', 3, 'T2')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(applyCalibration).mockReturnValue(signals);
    const result = makeResult('T2', signals);
    vi.mocked(classify).mockReturnValue(result);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      'Override Tier' as unknown as undefined,
    );
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await classifyCommand(WS);

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ label: 'T1 — Trivial', value: 'T1' }),
        expect.objectContaining({ label: 'T2 — Standard', value: 'T2' }),
        expect.objectContaining({ label: 'T3 — Complex', value: 'T3' }),
        expect.objectContaining({ label: 'T4 — Architectural', value: 'T4' }),
      ]),
      expect.objectContaining({ placeHolder: 'Override T2?' }),
    );
  });

  it('does nothing further when user cancels the tier quick-pick', async () => {
    const signals = [makeSignal('fileCount', 3, 'T2')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(applyCalibration).mockReturnValue(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T2', signals));
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      'Override Tier' as unknown as undefined,
    );
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await classifyCommand(WS);

    expect(recordOverride).not.toHaveBeenCalled();
  });

  it('calls recordOverride and shows confirmation when user confirms an override', async () => {
    const signals = [
      makeSignal('fileCount', 3, 'T2'),
      makeSignal('lineCount', 50, 'T2'),
    ];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(applyCalibration).mockReturnValue(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T2', signals));
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      'Override Tier' as unknown as undefined,
    );
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
      { label: 'T4 — Architectural', value: 'T4' } as unknown as vscode.QuickPickItem,
    );

    await classifyCommand(WS);

    expect(recordOverride).toHaveBeenCalledWith(
      WS,
      'T2',
      'T4',
      ['fileCount', 'lineCount'],
    );
    expect(vscode.window.showInformationMessage).toHaveBeenLastCalledWith(
      'MinSpec: Overridden to T4. Calibration saved.',
    );
  });

  it('records override with signal names from classify result', async () => {
    const signals = [
      makeSignal('specFiles', 1, 'T3'),
      makeSignal('testFiles', 0, 'T1'),
      makeSignal('configFiles', 2, 'T2'),
    ];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(applyCalibration).mockReturnValue(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T3', signals));
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      'Override Tier' as unknown as undefined,
    );
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
      { label: 'T1 — Trivial', value: 'T1' } as unknown as vscode.QuickPickItem,
    );

    await classifyCommand(WS);

    expect(recordOverride).toHaveBeenCalledWith(
      WS,
      'T3',
      'T1',
      ['specFiles', 'testFiles', 'configFiles'],
    );
  });

  // ── "Show Details" and "Override Tier" branches don't fire when dismissed ──

  it('does not open output channel or quick-pick when user dismisses the result message', async () => {
    const signals = [makeSignal('fileCount', 2, 'T1')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(applyCalibration).mockReturnValue(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T1', signals));
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);

    await classifyCommand(WS);

    expect(vscode.window.createOutputChannel).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(recordOverride).not.toHaveBeenCalled();
  });

  // ── applyVSCodeOverrides receives the specsDir from workspace config ───────

  it('passes specsDir from VS Code workspace config to applyVSCodeOverrides', async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string) => (key === 'specsDir' ? 'custom/specs' : undefined)),
    } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(analyzeGitDiff).mockResolvedValue([]);

    await classifyCommand(WS);

    expect(applyVSCodeOverrides).toHaveBeenCalledWith(
      expect.anything(),
      { specsDir: 'custom/specs' },
    );
  });
});
