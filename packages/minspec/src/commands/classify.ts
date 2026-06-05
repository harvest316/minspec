import * as vscode from 'vscode';
import { analyzeGitDiff } from '../lib/git-analyzer';
import { classify, applyFloor } from '../lib/classifier';
import { loadConfig, applyVSCodeOverrides, TIERS } from '../lib/config';
import type { Tier } from '../lib/config';
import { resolveTargetFolder } from '../lib/resolve-folder';

/** Tier the next-higher one above `tier`, or `tier` itself if already T4. */
function nextTierUp(tier: Tier): Tier {
  const idx = TIERS.indexOf(tier);
  return idx >= 0 && idx < TIERS.length - 1 ? TIERS[idx + 1] : tier;
}

export async function classifyCommand(folderArg?: string): Promise<void> {
  const workspaceRoot = folderArg ?? (await resolveTargetFolder());
  if (!workspaceRoot) return;

  const baseConfig = loadConfig(workspaceRoot);
  const vscodeConfig = vscode.workspace.getConfiguration('minspec');
  const config = applyVSCodeOverrides(baseConfig, {
    specsDir: vscodeConfig.get('specsDir'),
  });

  let signals: Awaited<ReturnType<typeof analyzeGitDiff>> = [];
  try {
    signals = await analyzeGitDiff(workspaceRoot, { staged: true });
    if (signals.length === 0) {
      signals = await analyzeGitDiff(workspaceRoot, { staged: false });
    }
  } catch {
    signals = [];
  }

  if (signals.length === 0) {
    vscode.window.showInformationMessage(
      'MinSpec: No changes detected. Stage or modify files to classify.',
    );
    return;
  }

  const result = classify(signals, config);

  // DR-021 Decision 1: the predicted tier is an upward-only ceremony FLOOR.
  // With no user-set tier here, the effective tier is the floor itself; the
  // affordances below only ever ratchet it UP, never below `result.tier`.
  const predictedTier = applyFloor(result.tier);

  const confidencePct = Math.round(result.confidence * 100);
  const phaseList = result.suggestedPhases.join(' → ');
  const signalSummary = result.signals
    .slice(0, 4)
    .map((s) => `${s.name}=${s.value}`)
    .join(', ');

  // DR-021 Decision 2: bump-up affordance. Advisory, never blocking. Tier is a
  // mechanical-scope floor, not a difficulty read, and the classifier
  // systematically under-tiers subtle small fixes (validated, n=120). Offer a
  // one-click "harder than it looks → raise tier" ONLY at the boundary where
  // that miss lives — predicted-T1 — to avoid nag fatigue (DR-021 Risk 2).
  // Dismissible like any MinSpec toast.
  const showBumpUp = predictedTier === 'T1';
  const bumpUpLabel = 'Harder than it looks — raise tier';
  const actions = ['Show Details', 'Override Tier'];
  if (showBumpUp) actions.push(bumpUpLabel);

  const choice = await vscode.window.showInformationMessage(
    `MinSpec: ${predictedTier} (${confidencePct}% confidence) · ${phaseList}`,
    { detail: `Signals: ${signalSummary || 'none'}`, modal: false },
    ...actions,
  );

  if (choice === 'Show Details') {
    const channel = vscode.window.createOutputChannel('MinSpec Classification');
    channel.appendLine(`Tier: ${predictedTier}`);
    channel.appendLine(`Confidence: ${confidencePct}%`);
    channel.appendLine(`Suggested phases: ${phaseList}`);
    channel.appendLine('');
    channel.appendLine(
      'Note: tier reflects mechanical scope (blast radius), not how hard the change is.',
    );
    channel.appendLine('');
    channel.appendLine('Signals:');
    for (const s of result.signals) {
      channel.appendLine(`  ${s.name} (${s.tierContribution}, weight ${s.weight}): ${s.value}`);
    }
    channel.show();
  } else if (choice === bumpUpLabel) {
    // One-click ratchet up by a single tier (the floor only ever moves up).
    const raised = nextTierUp(predictedTier);
    const { recordOverride } = await import('../lib/classifier.js');
    recordOverride(
      workspaceRoot,
      predictedTier,
      raised,
      result.signals.map((s) => s.name),
    );
    vscode.window.showInformationMessage(`MinSpec: Raised to ${raised}.`);
  } else if (choice === 'Override Tier') {
    const tiers: Array<{ label: string; value: Tier }> = [
      { label: 'T1 — Trivial', value: 'T1' },
      { label: 'T2 — Standard', value: 'T2' },
      { label: 'T3 — Complex', value: 'T3' },
      { label: 'T4 — Architectural', value: 'T4' },
    ];
    const picked = await vscode.window.showQuickPick(tiers, {
      placeHolder: `Override ${predictedTier}?`,
    });
    if (picked) {
      const { recordOverride } = await import('../lib/classifier.js');
      recordOverride(
        workspaceRoot,
        predictedTier,
        picked.value,
        result.signals.map((s) => s.name),
      );
      vscode.window.showInformationMessage(
        `MinSpec: Overridden to ${picked.value}.`,
      );
    }
  }
}
