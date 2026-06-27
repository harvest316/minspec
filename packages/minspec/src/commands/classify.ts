import * as vscode from 'vscode';
import { analyzeGitDiff, buildConsequenceInput } from '../lib/git-analyzer';
import { classify, applyFloor, pickDrivingSignal } from '../lib/classifier';
import type { ClassificationSignal } from '../lib/classifier';
import { runConsequenceAnalyzers } from '../lib/consequence-analyzers';
import { loadConfig, applyVSCodeOverrides, TIERS } from '../lib/config';
import type { Tier } from '../lib/config';
import { resolveTargetFolder } from '../lib/resolve-folder';

/** Tier the next-higher one above `tier`, or `tier` itself if already T4. */
function nextTierUp(tier: Tier): Tier {
  const idx = TIERS.indexOf(tier);
  return idx >= 0 && idx < TIERS.length - 1 ? TIERS[idx + 1] : tier;
}

export async function classifyCommand(
  folderArg?: string,
  opts?: { auto?: boolean },
): Promise<void> {
  // `auto` = fired by the git-HEAD watcher on every commit, not by the user.
  // Auto runs surface passively (status bar) and never interrupt; explicit
  // invocation keeps the full interactive toast. The two used to share one code
  // path, so ambient commit-runs fell through to the interactive toast — a
  // buttoned "→ T2" verdict on every commit that approved nothing, pure nag
  // (#216 facet 3, DR-021 Risk 2).
  const auto = opts?.auto === true;

  const workspaceRoot = folderArg ?? (await resolveTargetFolder());
  if (!workspaceRoot) return;

  const baseConfig = loadConfig(workspaceRoot);
  const vscodeConfig = vscode.workspace.getConfiguration('minspec');
  const config = applyVSCodeOverrides(baseConfig, {
    specsDir: vscodeConfig.get('specsDir'),
  });

  // Diff-size signals (DR-022: demoted to ordinary inputs, not the dominant
  // driver). Try staged first, then working tree. `usedStaged` records which
  // view produced them so the consequence input reads the SAME view (FR-7).
  let signals: ClassificationSignal[] = [];
  let usedStaged = true;
  try {
    signals = await analyzeGitDiff(workspaceRoot, { staged: true });
    if (signals.length === 0) {
      usedStaged = false;
      signals = await analyzeGitDiff(workspaceRoot, { staged: false });
    }
  } catch {
    signals = [];
  }

  if (signals.length === 0) {
    return;
  }

  // SPEC-023 FR-7: the consequence axis. Build the pure input from the same git
  // view, run the (pure, offline) analyzers, and APPEND their signals alongside
  // the size signals. `classify()`'s max-over-`tierContribution` is unchanged, so
  // a consequence signal can only ratchet the tier UP (INV-3). IO stays here in
  // the command layer; the analyzers stay pure (INV-1).
  try {
    const consequenceInput = await buildConsequenceInput(workspaceRoot, {
      staged: usedStaged,
    });
    const consequenceSignals = runConsequenceAnalyzers(consequenceInput);
    signals = [...signals, ...consequenceSignals];
  } catch {
    // Consequence axis is best-effort; size signals still classify on their own.
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

  // Headline names WHY the tier landed here — the single signal that drove it
  // (max `tierContribution`; classify() is "highest wins"). This replaces the
  // old "(N% confidence)", an agreement-fraction that read as a broken
  // probability: a high tier with a low % looked like "we're 14% sure" when it
  // actually meant "one signal forced it up". (#216 facet 1, lite version.)
  const driver = pickDrivingSignal(result);
  const driverLabel = driver ? `${driver.name}=${driver.value}` : null;
  const headline = `MinSpec: Current changes → ${predictedTier}${
    driverLabel ? ` · set by ${driverLabel}` : ''
  } · ${phaseList}`;

  // Auto-on-commit is ambient awareness, not a decision. Surface a passive,
  // self-dismissing status-bar line — no action buttons that imply a pending
  // approval there is none of. The interactive toast (below) is reserved for
  // explicit invocation. (#216 facet 3, DR-021 Risk 2.)
  if (auto) {
    vscode.window.setStatusBarMessage(headline, 8000);
    return;
  }

  // DR-021 Decision 2: bump-up affordance. Advisory, never blocking. Tier is a
  // mechanical-scope floor, not a difficulty read, and the classifier
  // systematically under-tiers subtle small fixes (validated, n=120). Offer a
  // one-click "harder than it looks → raise tier" ONLY at the boundary where
  // that miss lives — predicted-T1 — to avoid nag fatigue (DR-021 Risk 2).
  // Dismissible like any MinSpec toast.
  const showBumpUp = predictedTier === 'T1';
  const bumpUpLabel = 'Harder than it looks — raise tier';
  // The old "Override Tier" wrote to a calibration log nothing reads back
  // (DR-021 gutted the feedback loop). Replace it with a live affordance: opt
  // into auto-classify-on-commit so the advice runs itself going forward (#203).
  const AUTO_CLASSIFY = 'Auto-classify from now on';
  const actions = ['Show Details', AUTO_CLASSIFY];
  if (showBumpUp) actions.push(bumpUpLabel);

  // Advisory toast: names the unit (your current diff) and states that nothing
  // is persisted — the result is informational, not a pending action (#203).
  const choice = await vscode.window.showInformationMessage(
    headline,
    {
      detail: `Advisory — reflects your current diff; nothing is saved. Signals: ${signalSummary || 'none'}`,
      modal: false,
    },
    ...actions,
  );

  if (choice === 'Show Details') {
    const channel = vscode.window.createOutputChannel('MinSpec Classification');
    channel.appendLine(`Tier: ${predictedTier}`);
    // "Signal agreement", not "confidence": this is the share of signals at the
    // winning tier, not a probability the tier is right (#216 — honest label).
    channel.appendLine(
      `Signal agreement: ${confidencePct}% (share of signals at the winning tier)`,
    );
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
  } else if (choice === AUTO_CLASSIFY) {
    // Enable the git-HEAD watcher (extension.ts) for this workspace so
    // classification re-runs on every commit. extension.ts watches this setting
    // via onDidChangeConfiguration and starts the watcher immediately — the
    // toggle takes effect now, no window reload (#203).
    await vscode.workspace
      .getConfiguration('minspec')
      .update('autoClassifyOnCommit', true, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(
      'MinSpec: Auto-classify on commit enabled for this workspace.',
    );
  }
}
