import * as vscode from 'vscode';
import {
  proposeHeuristic,
  proposeAI,
  isClaudeAvailable,
  applyBackfill,
  renderProposalMarkdown,
  type BackfillProposal,
} from '../lib/epic-backfill';
import { resolveTargetFolder } from '../lib/resolve-folder';

/** Options threaded in from an upstream caller (e.g. the auto-bootstrap offer). */
export interface BackfillOptions {
  /**
   * AI consent already obtained upstream. The bootstrap offer's toast promises
   * "AI-enhanced if Claude Code is installed", so clicking it IS consent — the
   * command must not re-ask (harvest316/minspec#213).
   */
  readonly aiConsent?: boolean;
}

/**
 * Persisted "always use the AI pass for backfill" opt-in. Written GLOBALLY: it's
 * a personal cost/privacy/quota preference, not project policy, so it follows the
 * user across every project (#213). Reads merge global+workspace as usual.
 */
function alwaysUseAi(): boolean {
  return vscode.workspace
    .getConfiguration('minspec')
    .get<boolean>('autoBackfillUseAi', false);
}
async function enableAlwaysUseAi(): Promise<void> {
  await vscode.workspace
    .getConfiguration('minspec')
    .update('autoBackfillUseAi', true, vscode.ConfigurationTarget.Global);
}

/**
 * Per-item review: a keyboard QuickPick of every proposed epic + mapping, all
 * pre-checked. Uncheck to drop; Enter applies the rest (harvest316/minspec#213).
 * Returns the filtered proposal, or `undefined` if the picker was dismissed (the
 * caller then keeps the un-tweaked proposal). No markdown round-trip parsing —
 * the proposal object is the source of truth.
 */
async function tweakProposal(
  proposal: BackfillProposal,
): Promise<BackfillProposal | undefined> {
  type Item = vscode.QuickPickItem & { ref?: { kind: 'epic' | 'mapping'; i: number } };
  const items: Item[] = [];

  items.push({ label: 'Epics', kind: vscode.QuickPickItemKind.Separator });
  proposal.epics.forEach((e, i) =>
    items.push({
      label: e.title,
      description: `${e.slug}${e.id ? ' · existing' : ' · new'}`,
      detail: e.rationale,
      picked: true,
      ref: { kind: 'epic', i },
    }),
  );

  items.push({ label: 'Mappings', kind: vscode.QuickPickItemKind.Separator });
  proposal.mappings.forEach((m, i) =>
    items.push({
      label: m.artifactId,
      description: `→ ${m.epicSlug} · ${(m.confidence * 100).toFixed(0)}%`,
      detail: m.rationale,
      picked: true,
      ref: { kind: 'mapping', i },
    }),
  );

  const sel = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Backfill — uncheck anything to drop',
    placeHolder: 'Space toggles · Enter confirms · Esc keeps the original proposal',
  });
  if (!sel) return undefined; // dismissed → caller keeps the prior proposal

  const keptEpicIdx = new Set(
    sel.filter((s) => s.ref?.kind === 'epic').map((s) => s.ref!.i),
  );
  const keptEpics = proposal.epics.filter((_, i) => keptEpicIdx.has(i));
  const keptSlugs = new Set(keptEpics.map((e) => e.slug));

  const keptMapIdx = new Set(
    sel.filter((s) => s.ref?.kind === 'mapping').map((s) => s.ref!.i),
  );
  // A mapping can't apply without its epic: dropping an epic drops its mappings
  // (applyBackfill would otherwise silently skip them — confusing).
  const keptMappings = proposal.mappings.filter(
    (m, i) => keptMapIdx.has(i) && keptSlugs.has(m.epicSlug),
  );

  return { epics: keptEpics, mappings: keptMappings, source: proposal.source };
}

/**
 * Command: Backfill epics (DR-016 / SPEC-011).
 *
 * Builds a Tier-0 heuristic proposal; if `claude` is available, runs the Tier-1
 * AI-enhanced pass (consent inherited from the bootstrap offer, persisted via
 * "Always", or asked once — falls back to heuristic on any failure). Opens the
 * proposal so it stays visible, then a NON-modal toast (Apply / Tweak / Cancel)
 * — the proposal is readable while you decide, and Tweak filters it per-item.
 * Never writes without confirmation (harvest316/minspec#213).
 */
export async function backfillEpicsCommand(
  folderArg?: string,
  opts?: BackfillOptions,
): Promise<void> {
  const folder = folderArg ?? (await resolveTargetFolder());
  if (!folder) return;

  let proposal: BackfillProposal = proposeHeuristic(folder);

  // Tier-1 AI pass. Consent may already be given upstream (the bootstrap offer
  // promised it) or persisted ("Always"); otherwise ask once — with an "Always"
  // affordance so direct Command-Palette runs aren't re-asked every time.
  if (await isClaudeAvailable()) {
    let useAi = opts?.aiConsent === true || alwaysUseAi();
    if (!useAi) {
      const USE_AI = 'AI-enhanced';
      const ALWAYS = 'Always';
      const HEURISTIC = 'Heuristic only';
      const choice = await vscode.window.showInformationMessage(
        'MinSpec: Claude Code detected. Use AI to propose the epic taxonomy? (Runs `claude -p` locally; the extension makes no network calls.)',
        ALWAYS,
        USE_AI,
        HEURISTIC,
      );
      if (choice === undefined) return; // dismissed
      if (choice === ALWAYS) {
        await enableAlwaysUseAi();
        useAi = true;
      } else if (choice === USE_AI) {
        useAi = true;
      }
    }
    if (useAi) {
      const ai = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'MinSpec: asking Claude to propose epics…' },
        () => proposeAI(folder),
      );
      if (ai) {
        proposal = ai;
      } else {
        vscode.window.showWarningMessage('MinSpec: AI pass unavailable — using the heuristic proposal.');
      }
    }
  }

  if (proposal.epics.length === 0 || proposal.mappings.length === 0) {
    vscode.window.showInformationMessage('MinSpec: Nothing to backfill — no confident epic mappings found.');
    return;
  }

  // HITL review: open the proposal so it stays on screen, then a NON-modal toast
  // (a modal would steal focus and hide the proposal behind it — #213). Loop so
  // Tweak re-renders the filtered proposal and returns to the Apply prompt.
  const showProposal = async (p: BackfillProposal): Promise<void> => {
    const doc = await vscode.workspace.openTextDocument({
      content: renderProposalMarkdown(p),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  };
  await showProposal(proposal);

  const APPLY = 'Apply';
  const TWEAK = 'Tweak…';
  const CANCEL = 'Cancel';
  for (;;) {
    const choice = await vscode.window.showInformationMessage(
      `MinSpec: Apply ${proposal.epics.length} epic(s) and tag ${proposal.mappings.length} artifact(s)? Already-tagged artifacts are left untouched.`,
      APPLY,
      TWEAK,
      CANCEL,
    );
    if (choice === APPLY) break;
    if (choice === TWEAK) {
      const tweaked = await tweakProposal(proposal);
      if (tweaked) {
        proposal = tweaked;
        await showProposal(proposal);
      }
      continue; // re-show the Apply prompt (filtered counts, or unchanged on dismiss)
    }
    return; // Cancel or dismissed
  }

  if (proposal.epics.length === 0 || proposal.mappings.length === 0) {
    vscode.window.showInformationMessage('MinSpec: Nothing left to apply after tweaking.');
    return;
  }

  try {
    const res = applyBackfill(folder, proposal);
    vscode.window.showInformationMessage(
      `MinSpec: Backfill done — ${res.epicsCreated} epic(s) created, ${res.artifactsTagged} tagged, ${res.skipped} skipped.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`MinSpec: Backfill failed — ${message}`);
  }
}
