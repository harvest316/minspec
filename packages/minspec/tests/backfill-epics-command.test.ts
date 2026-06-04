import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ───────────────────────────────────────────────────────────

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showTextDocument: vi.fn(),
    withProgress: vi.fn((_opts: unknown, task: () => unknown) => task()),
  },
  workspace: {
    openTextDocument: vi.fn(() => Promise.resolve({})),
  },
  ProgressLocation: { Notification: 15 },
}));

// ─── Mock lib deps ─────────────────────────────────────────────────────────

vi.mock('../src/lib/epic-backfill', () => ({
  proposeHeuristic: vi.fn(),
  proposeAI: vi.fn(),
  isClaudeAvailable: vi.fn(),
  applyBackfill: vi.fn(),
  renderProposalMarkdown: vi.fn(() => '# Proposal'),
}));

vi.mock('../src/lib/resolve-folder', () => ({
  resolveTargetFolder: vi.fn(),
}));

// ─── Imports ───────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { backfillEpicsCommand } from '../src/commands/backfill-epics';
import {
  proposeHeuristic,
  proposeAI,
  isClaudeAvailable,
  applyBackfill,
  renderProposalMarkdown,
  type BackfillProposal,
} from '../src/lib/epic-backfill';
import { resolveTargetFolder } from '../src/lib/resolve-folder';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeProposal(epicCount: number, mappingCount: number): BackfillProposal {
  const epics = Array.from({ length: epicCount }, (_, i) => ({
    slug: `epic-${i}`,
    title: `Epic ${i}`,
    rationale: 'auto',
  }));
  const mappings = Array.from({ length: mappingCount }, (_, i) => ({
    artifactId: `SPEC-00${i}`,
    kind: 'spec' as const,
    filePath: `/tmp/specs/SPEC-00${i}.md`,
    epicSlug: `epic-0`,
    confidence: 0.9,
    rationale: 'auto',
  }));
  return { epics, mappings, source: 'heuristic' } as BackfillProposal;
}

const FOLDER = '/tmp/test-workspace';
const HEURISTIC_PROPOSAL = makeProposal(2, 3);

// =============================================================================
// Tests
// =============================================================================

describe('backfillEpicsCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sensible defaults — individual tests override as needed
    vi.mocked(resolveTargetFolder).mockResolvedValue(FOLDER);
    vi.mocked(proposeHeuristic).mockReturnValue(HEURISTIC_PROPOSAL);
    vi.mocked(isClaudeAvailable).mockResolvedValue(false);
    vi.mocked(renderProposalMarkdown).mockReturnValue('# Proposal');
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as vscode.TextDocument);
    vi.mocked(vscode.window.showTextDocument).mockResolvedValue(undefined as unknown as vscode.TextEditor);
  });

  // (1a) folderArg provided — uses it directly, does not call resolveTargetFolder
  it('uses folderArg directly when provided', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Apply' as never);
    vi.mocked(applyBackfill).mockReturnValueOnce({ epicsCreated: 1, artifactsTagged: 2, skipped: 0 });

    await backfillEpicsCommand(FOLDER);

    expect(resolveTargetFolder).not.toHaveBeenCalled();
    expect(proposeHeuristic).toHaveBeenCalledWith(FOLDER);
  });

  // (1b) no folderArg, resolveTargetFolder returns undefined → no-op
  it('returns early when resolveTargetFolder returns undefined', async () => {
    vi.mocked(resolveTargetFolder).mockResolvedValue(undefined);

    await backfillEpicsCommand();

    expect(proposeHeuristic).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  // (1c) no folderArg, resolveTargetFolder returns a folder → proceeds
  it('falls back to resolveTargetFolder when no folderArg', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Apply' as never);
    vi.mocked(applyBackfill).mockReturnValueOnce({ epicsCreated: 0, artifactsTagged: 1, skipped: 0 });

    await backfillEpicsCommand();

    expect(resolveTargetFolder).toHaveBeenCalled();
    expect(proposeHeuristic).toHaveBeenCalledWith(FOLDER);
  });

  // (2) isClaudeAvailable false → skips AI prompt, uses heuristic
  it('skips AI choice prompt when claude is not available', async () => {
    vi.mocked(isClaudeAvailable).mockResolvedValue(false);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Apply' as never);
    vi.mocked(applyBackfill).mockReturnValueOnce({ epicsCreated: 2, artifactsTagged: 3, skipped: 0 });

    await backfillEpicsCommand(FOLDER);

    // The first showInformationMessage must be the final confirm, not the AI/heuristic choice.
    const calls = vi.mocked(vscode.window.showInformationMessage).mock.calls;
    const firstMsg = calls[0][0] as string;
    expect(firstMsg).toContain('Apply');
    expect(proposeAI).not.toHaveBeenCalled();
  });

  // (3) isClaudeAvailable true, choice undefined (dismissed) → returns early
  it('returns early when AI/heuristic choice is dismissed (undefined)', async () => {
    vi.mocked(isClaudeAvailable).mockResolvedValue(true);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(undefined);

    await backfillEpicsCommand(FOLDER);

    expect(proposeAI).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  // (4) choice === 'AI-enhanced', proposeAI returns a proposal → uses it
  it('uses AI proposal when choice is AI-enhanced and proposeAI returns a result', async () => {
    const aiProposal = makeProposal(3, 4);
    aiProposal.source; // just accessing to confirm shape
    vi.mocked(isClaudeAvailable).mockResolvedValue(true);
    vi.mocked(proposeAI).mockResolvedValue({ ...aiProposal, source: 'ai' } as BackfillProposal);
    // First call: AI/heuristic choice
    vi.mocked(vscode.window.showInformationMessage)
      .mockResolvedValueOnce('AI-enhanced' as never)
      // Second call: confirm Apply
      .mockResolvedValueOnce('Apply' as never);
    vi.mocked(applyBackfill).mockReturnValueOnce({ epicsCreated: 3, artifactsTagged: 4, skipped: 0 });

    await backfillEpicsCommand(FOLDER);

    expect(proposeAI).toHaveBeenCalledWith(FOLDER);
    expect(renderProposalMarkdown).toHaveBeenCalledWith(expect.objectContaining({ source: 'ai' }));
    expect(applyBackfill).toHaveBeenCalledWith(FOLDER, expect.objectContaining({ source: 'ai' }));
  });

  // (5) choice === 'AI-enhanced', proposeAI returns null → warning, falls back to heuristic
  it('shows warning and falls back to heuristic when proposeAI returns null', async () => {
    vi.mocked(isClaudeAvailable).mockResolvedValue(true);
    vi.mocked(proposeAI).mockResolvedValue(null);
    vi.mocked(vscode.window.showInformationMessage)
      .mockResolvedValueOnce('AI-enhanced' as never)
      .mockResolvedValueOnce('Apply' as never);
    vi.mocked(applyBackfill).mockReturnValueOnce({ epicsCreated: 2, artifactsTagged: 3, skipped: 0 });

    await backfillEpicsCommand(FOLDER);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'MinSpec: AI pass unavailable — using the heuristic proposal.',
    );
    // Falls back to heuristic proposal for final apply
    expect(applyBackfill).toHaveBeenCalledWith(FOLDER, HEURISTIC_PROPOSAL);
  });

  // (5b) choice === 'AI-enhanced', proposeAI returns undefined → warning, falls back to heuristic
  it('shows warning and falls back to heuristic when proposeAI returns undefined', async () => {
    vi.mocked(isClaudeAvailable).mockResolvedValue(true);
    vi.mocked(proposeAI).mockResolvedValue(undefined as unknown as null);
    vi.mocked(vscode.window.showInformationMessage)
      .mockResolvedValueOnce('AI-enhanced' as never)
      .mockResolvedValueOnce('Apply' as never);
    vi.mocked(applyBackfill).mockReturnValueOnce({ epicsCreated: 2, artifactsTagged: 3, skipped: 0 });

    await backfillEpicsCommand(FOLDER);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'MinSpec: AI pass unavailable — using the heuristic proposal.',
    );
    expect(applyBackfill).toHaveBeenCalledWith(FOLDER, HEURISTIC_PROPOSAL);
  });

  // (6) choice === 'Heuristic only' → keeps heuristic
  it('keeps heuristic proposal when choice is Heuristic only', async () => {
    vi.mocked(isClaudeAvailable).mockResolvedValue(true);
    vi.mocked(vscode.window.showInformationMessage)
      .mockResolvedValueOnce('Heuristic only' as never)
      .mockResolvedValueOnce('Apply' as never);
    vi.mocked(applyBackfill).mockReturnValueOnce({ epicsCreated: 2, artifactsTagged: 3, skipped: 0 });

    await backfillEpicsCommand(FOLDER);

    expect(proposeAI).not.toHaveBeenCalled();
    expect(applyBackfill).toHaveBeenCalledWith(FOLDER, HEURISTIC_PROPOSAL);
  });

  // (7a) empty epics → "Nothing to backfill" info, returns
  it('shows Nothing to backfill and returns when proposal has empty epics', async () => {
    vi.mocked(proposeHeuristic).mockReturnValue(makeProposal(0, 3));

    await backfillEpicsCommand(FOLDER);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Nothing to backfill — no confident epic mappings found.',
    );
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  // (7b) empty mappings → "Nothing to backfill" info, returns
  it('shows Nothing to backfill and returns when proposal has empty mappings', async () => {
    vi.mocked(proposeHeuristic).mockReturnValue(makeProposal(2, 0));

    await backfillEpicsCommand(FOLDER);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Nothing to backfill — no confident epic mappings found.',
    );
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  // (7c) both empty → "Nothing to backfill" info, returns
  it('shows Nothing to backfill and returns when both epics and mappings are empty', async () => {
    vi.mocked(proposeHeuristic).mockReturnValue(makeProposal(0, 0));

    await backfillEpicsCommand(FOLDER);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Nothing to backfill — no confident epic mappings found.',
    );
    expect(applyBackfill).not.toHaveBeenCalled();
  });

  // (8) non-empty proposal: opens read-only doc, confirm !== 'Apply' → returns without applying
  it('opens proposal doc and returns without applying when confirm is not Apply', async () => {
    const mockDoc = { uri: { fsPath: '/tmp/proposal.md' } } as unknown as vscode.TextDocument;
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc);
    // confirm is undefined (dismissed)
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(undefined);

    await backfillEpicsCommand(FOLDER);

    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
      content: '# Proposal',
      language: 'markdown',
    });
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc, { preview: true });
    expect(applyBackfill).not.toHaveBeenCalled();
  });

  // (8b) confirm is some other string (not 'Apply') → no apply
  it('returns without applying when confirm is a non-Apply string', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Cancel' as never);

    await backfillEpicsCommand(FOLDER);

    expect(applyBackfill).not.toHaveBeenCalled();
  });

  // (9) confirm === 'Apply', applyBackfill succeeds → success info with epicsCreated/artifactsTagged/skipped
  it('applies backfill and shows success message when user confirms Apply', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Apply' as never);
    vi.mocked(applyBackfill).mockReturnValueOnce({ epicsCreated: 2, artifactsTagged: 5, skipped: 1 });

    await backfillEpicsCommand(FOLDER);

    expect(applyBackfill).toHaveBeenCalledWith(FOLDER, HEURISTIC_PROPOSAL);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: Backfill done — 2 epic(s) created, 5 tagged, 1 skipped.',
    );
  });

  // (10) confirm === 'Apply', applyBackfill throws Error → "Backfill failed" error
  it('shows Backfill failed error message when applyBackfill throws an Error', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Apply' as never);
    vi.mocked(applyBackfill).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await backfillEpicsCommand(FOLDER);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Backfill failed — disk full',
    );
  });

  // (10b) applyBackfill throws a non-Error → shows stringified message
  it('shows Backfill failed error message when applyBackfill throws a non-Error', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Apply' as never);
    vi.mocked(applyBackfill).mockImplementationOnce(() => {
      throw 'something went wrong'; // eslint-disable-line no-throw-literal
    });

    await backfillEpicsCommand(FOLDER);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Backfill failed — something went wrong',
    );
  });

  // withProgress: verifies the progress call wraps proposeAI
  it('calls withProgress with Notification location when invoking AI pass', async () => {
    vi.mocked(isClaudeAvailable).mockResolvedValue(true);
    vi.mocked(proposeAI).mockResolvedValue(makeProposal(1, 1) as BackfillProposal);
    vi.mocked(vscode.window.showInformationMessage)
      .mockResolvedValueOnce('AI-enhanced' as never)
      .mockResolvedValueOnce('Apply' as never);
    vi.mocked(applyBackfill).mockReturnValueOnce({ epicsCreated: 1, artifactsTagged: 1, skipped: 0 });

    await backfillEpicsCommand(FOLDER);

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ location: 15 }),
      expect.any(Function),
    );
  });

  // renderProposalMarkdown is called with the chosen proposal before opening the doc
  it('passes the proposal to renderProposalMarkdown before opening the doc', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(undefined);

    await backfillEpicsCommand(FOLDER);

    expect(renderProposalMarkdown).toHaveBeenCalledWith(HEURISTIC_PROPOSAL);
  });

  // The confirm showInformationMessage includes epics.length and mappings.length
  it('includes epic count and artifact count in the confirm prompt', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(undefined);

    await backfillEpicsCommand(FOLDER);

    const calls = vi.mocked(vscode.window.showInformationMessage).mock.calls;
    const confirmMsg = calls[0][0] as string;
    expect(confirmMsg).toContain(`${HEURISTIC_PROPOSAL.epics.length} epic`);
    expect(confirmMsg).toContain(`${HEURISTIC_PROPOSAL.mappings.length} artifact`);
  });
});
