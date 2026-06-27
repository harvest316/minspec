import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ─────────────────────────────────────────────────────────────

const mockChannel = {
  appendLine: vi.fn(),
  show: vi.fn(),
};

// Shared config.update spy so tests can assert the "Auto-classify from now on"
// affordance writes the setting.
const mockConfigUpdate = vi.fn();

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
    createOutputChannel: vi.fn(() => mockChannel),
    setStatusBarMessage: vi.fn(),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/ws' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(), update: vi.fn() })),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
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
  // applyFloor is pure; use the real upward-only-max behaviour so the command's
  // floor logic is exercised, not stubbed out.
  applyFloor: (predicted: string, user?: string) => {
    const order = ['T1', 'T2', 'T3', 'T4'];
    if (user === undefined) return predicted;
    return order.indexOf(user) > order.indexOf(predicted) ? user : predicted;
  },
  // pickDrivingSignal is pure; mirror the real selection (winning-tier signal,
  // consequence axis first, then weight) so the headline assertions exercise the
  // command's wiring. Its own logic is unit-tested in classifier.test.ts.
  pickDrivingSignal: (result: { tier: string; signals: any[] }) => {
    const atTier = result.signals.filter((s) => s.tierContribution === result.tier);
    const pool = atTier.length > 0 ? atTier : result.signals;
    if (pool.length === 0) return undefined;
    return pool.reduce((best, s) => {
      const bestC = best.axis === 'consequence' ? 1 : 0;
      const sC = s.axis === 'consequence' ? 1 : 0;
      if (sC !== bestC) return sC > bestC ? s : best;
      return s.weight > best.weight ? s : best;
    });
  },
  recordOverride: vi.fn(),
}));

vi.mock('../src/lib/config', async (importOriginal) => ({
  ...(await importOriginal()),
  loadConfig: vi.fn(),
  applyVSCodeOverrides: vi.fn((config: unknown) => config),
  TIERS: ['T1', 'T2', 'T3', 'T4'],
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { classifyCommand } from '../src/commands/classify';
import { resolveTargetFolder } from '../src/lib/resolve-folder';
import { analyzeGitDiff } from '../src/lib/git-analyzer';
import { classify, recordOverride } from '../src/lib/classifier';
import { loadConfig, applyVSCodeOverrides } from '../src/lib/config';
import type { ClassificationSignal, ClassificationResult } from '../src/lib/classifier';
import type { MinspecConfig } from '../src/lib/config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WS = '/tmp/ws';

const BUMP_UP_LABEL = 'Harder than it looks — raise tier';

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
    vi.mocked(analyzeGitDiff).mockResolvedValue([]);
    mockConfigUpdate.mockClear();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update: mockConfigUpdate,
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

  it('returns early without toast when analyzeGitDiff throws', async () => {
    vi.mocked(analyzeGitDiff).mockRejectedValue(new Error('git not found'));

    await classifyCommand(WS);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  // ── Lines 27-32: no signals (both staged and unstaged empty) ─────────────

  it('returns early without toast when both staged and unstaged are empty', async () => {
    vi.mocked(analyzeGitDiff).mockResolvedValue([]);

    await classifyCommand(WS);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  // ── Happy path — classifies raw signals (no weight calibration) ───────────

  it('calls classify with the raw signals and shows the tier/driver/phases message', async () => {
    const signals = [makeSignal('fileCount', 4, 'T2', 1)];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    const result = makeResult('T2', signals, 0.75, ['specify', 'plan']);
    vi.mocked(classify).mockReturnValue(result);

    await classifyCommand(WS);

    // DR-021: no applyCalibration step — signals go straight to classify.
    expect(classify).toHaveBeenCalledWith(signals, FAKE_CONFIG);

    // Headline names the DRIVING signal, not a confidence% (#216).
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Current changes → T2 · set by fileCount=4 · specify → plan',
      { detail: expect.stringContaining('fileCount=4'), modal: false },
      'Show Details',
      'Auto-classify from now on',
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
    vi.mocked(classify).mockReturnValue(makeResult('T3', signals, 1, ['specify', 'plan', 'tasks']));

    await classifyCommand(WS);

    const call = vi.mocked(vscode.window.showInformationMessage).mock.calls[0];
    const detail = (call[1] as { detail: string }).detail;
    expect(detail).toContain('a=1');
    expect(detail).toContain('d=4');
    expect(detail).not.toContain('e=5');
  });

  it('shows "none" in detail when there are no signals in the result', async () => {
    // signals array still non-empty to pass the no-changes check, but classify returns empty signals
    const rawSignals = [makeSignal('x', 1, 'T1')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(rawSignals);
    vi.mocked(classify).mockReturnValue(makeResult('T1', [], 0, ['specify']));

    await classifyCommand(WS);

    const call = vi.mocked(vscode.window.showInformationMessage).mock.calls[0];
    const detail = (call[1] as { detail: string }).detail;
    expect(detail).toBe(
      'Advisory — reflects your current diff; nothing is saved. Signals: none',
    );
  });

  it('headline never shows a confidence percentage (#216 — the meaningless token)', async () => {
    const signals = [makeSignal('fileCount', 4, 'T2')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    // A high tier with a LOW agreement fraction — the exact case that read as
    // "we're 14% sure it's T3".
    vi.mocked(classify).mockReturnValue(makeResult('T2', signals, 0.14, ['specify', 'plan']));

    await classifyCommand(WS);

    const headline = vi.mocked(vscode.window.showInformationMessage).mock.calls[0][0] as string;
    expect(headline).not.toContain('%');
    expect(headline).not.toContain('confidence');
    expect(headline).toContain('set by fileCount=4');
  });

  it('rounds signal agreement to nearest integer percent in Show Details', async () => {
    const signals = [makeSignal('s', 1, 'T1')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T1', signals, 0.334, ['specify']));
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      'Show Details' as unknown as undefined,
    );

    await classifyCommand(WS);

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      'Signal agreement: 33% (share of signals at the winning tier)',
    );
  });

  // ── DR-021 Decision 2: bump-up affordance ─────────────────────────────────

  it('offers the bump-up affordance at the boundary (predicted-T1)', async () => {
    const signals = [makeSignal('fileCount', 1, 'T1')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T1', signals, 1, ['specify']));

    await classifyCommand(WS);

    const call = vi.mocked(vscode.window.showInformationMessage).mock.calls[0];
    // The bump-up action is present among the toast buttons.
    expect(call).toContain(BUMP_UP_LABEL);
  });

  it('does NOT offer the bump-up affordance at the top tier (predicted-T4)', async () => {
    const signals = [makeSignal('fileCount', 12, 'T4')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(classify).mockReturnValue(
      makeResult('T4', signals, 1, ['specify', 'plan', 'tasks', 'implement']),
    );

    await classifyCommand(WS);

    const call = vi.mocked(vscode.window.showInformationMessage).mock.calls[0];
    expect(call).not.toContain(BUMP_UP_LABEL);
  });

  it('the bump-up affordance is dismissible — dismissing it records nothing', async () => {
    const signals = [makeSignal('fileCount', 1, 'T1')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T1', signals, 1, ['specify']));
    // User dismisses the toast (returns undefined).
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);

    await classifyCommand(WS);

    expect(recordOverride).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('ratchets UP by one tier and logs the override when bump-up is clicked', async () => {
    const signals = [makeSignal('fileCount', 1, 'T1'), makeSignal('lineCount', 4, 'T1')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T1', signals, 1, ['specify']));
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      BUMP_UP_LABEL as unknown as undefined,
    );

    await classifyCommand(WS);

    // T1 → T2 (one tier up — never down).
    expect(recordOverride).toHaveBeenCalledWith(
      WS,
      'T1',
      'T2',
      ['fileCount', 'lineCount'],
    );
    expect(vscode.window.showInformationMessage).toHaveBeenLastCalledWith(
      'MinSpec: Raised to T2.',
    );
  });

  // ── "Show Details" branch ─────────────────────────────────────────────────

  it('opens an output channel with full signal details when user picks "Show Details"', async () => {
    const signals = [
      makeSignal('fileCount', 5, 'T2', 2),
      makeSignal('lineCount', 120, 'T3', 3),
    ];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T3', signals, 0.5, ['specify', 'plan', 'tasks']));
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      'Show Details' as unknown as undefined,
    );

    await classifyCommand(WS);

    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('MinSpec Classification');
    expect(mockChannel.appendLine).toHaveBeenCalledWith('Tier: T3');
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      'Signal agreement: 50% (share of signals at the winning tier)',
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith('Suggested phases: specify → plan → tasks');
    // DR-021 Decision 3: details state tier = scope, not difficulty.
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      'Note: tier reflects mechanical scope (blast radius), not how hard the change is.',
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith('Signals:');
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      '  fileCount (T2, weight 2): 5',
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      '  lineCount (T3, weight 3): 120',
    );
    expect(mockChannel.show).toHaveBeenCalled();
  });

  // ── "Auto-classify from now on" branch (#203, replaces dead "Override Tier") ──

  it('offers "Auto-classify from now on" instead of the removed "Override Tier"', async () => {
    const signals = [makeSignal('fileCount', 3, 'T2')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T2', signals));

    await classifyCommand(WS);

    const call = vi.mocked(vscode.window.showInformationMessage).mock.calls[0];
    expect(call).toContain('Auto-classify from now on');
    expect(call).not.toContain('Override Tier');
  });

  it('enables autoClassifyOnCommit and confirms when user picks "Auto-classify from now on"', async () => {
    const signals = [makeSignal('fileCount', 3, 'T2')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T2', signals));
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      'Auto-classify from now on' as unknown as undefined,
    );

    await classifyCommand(WS);

    expect(mockConfigUpdate).toHaveBeenCalledWith(
      'autoClassifyOnCommit',
      true,
      vscode.ConfigurationTarget.Workspace,
    );
    expect(vscode.window.showInformationMessage).toHaveBeenLastCalledWith(
      'MinSpec: Auto-classify on commit enabled for this workspace.',
    );
    // The dead override log is never written by this path.
    expect(recordOverride).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  // ── Dismissal does not fire any branch ────────────────────────────────────

  it('does not open output channel, write settings, or log when user dismisses', async () => {
    const signals = [makeSignal('fileCount', 2, 'T1')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T1', signals));
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);

    await classifyCommand(WS);

    expect(vscode.window.createOutputChannel).not.toHaveBeenCalled();
    expect(mockConfigUpdate).not.toHaveBeenCalled();
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

  // ── Auto mode (#216 facet 3): the commit-watcher path must not nag ─────────

  it('auto mode shows a passive status-bar line, no interactive toast', async () => {
    const signals = [makeSignal('fileCount', 4, 'T2')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T2', signals, 0.75, ['specify', 'plan']));

    await classifyCommand(WS, { auto: true });

    expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
      'MinSpec: Current changes → T2 · set by fileCount=4 · specify → plan',
      8000,
    );
    // No interrupting toast, no action buttons.
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('auto-mode status-bar line never shows a confidence percentage (#216)', async () => {
    const signals = [makeSignal('fileCount', 4, 'T2')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T2', signals, 0.14, ['specify', 'plan']));

    await classifyCommand(WS, { auto: true });

    const msg = vi.mocked(vscode.window.setStatusBarMessage).mock.calls[0][0] as string;
    expect(msg).not.toContain('%');
    expect(msg).not.toContain('confidence');
  });

  it('auto mode stays completely silent on a clean tree (no nag after a commit)', async () => {
    vi.mocked(analyzeGitDiff).mockResolvedValue([]); // staged + unstaged empty

    await classifyCommand(WS, { auto: true });

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
  });

  it('explicit (non-auto) mode shows the interactive toast, not the status bar', async () => {
    const signals = [makeSignal('fileCount', 4, 'T2')];
    vi.mocked(analyzeGitDiff).mockResolvedValueOnce(signals);
    vi.mocked(classify).mockReturnValue(makeResult('T2', signals, 0.75, ['specify', 'plan']));

    await classifyCommand(WS); // no opts → interactive

    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
    expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
  });
});
