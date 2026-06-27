import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveTargetFolder } from '../lib/resolve-folder';
import { assembleContext } from '../lib/constitution-context';
import { buildGenerationPrompt } from '../lib/constitution-prompt';
import {
  CONSTITUTION_SECTION_SCHEMA,
  seedProvider,
  integrateProposal,
  type IntegrateResult,
} from '../lib/constitution-proposer';
import { compactConstitution } from '../lib/constitution-compaction';

/**
 * SPEC-025 FR-2/FR-3 (manual path): assemble the deterministic context manifest +
 * the prepared generation prompt and open it in an untitled editor for the user
 * to run in their own assistant. MinSpec never calls the model itself (INV-1);
 * the prompt is handed off. The future Tier-1 agent-execute provider implements
 * the same ConstitutionProvider seam — no rework here.
 */
export async function constitutionShowPromptCommand(): Promise<void> {
  const folder = await resolveTargetFolder();
  if (!folder) return;

  const manifest = assembleContext(folder);
  const prompt = buildGenerationPrompt(manifest, CONSTITUTION_SECTION_SCHEMA);

  const doc = await vscode.workspace.openTextDocument({
    content: prompt,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: false });

  vscode.window.showInformationMessage(
    'MinSpec: Constitution generation prompt ready — run it in your assistant, then ' +
      'paste the DRAFT entries into .minspec/constitution.md for review.',
  );
}

/**
 * The deterministic, offline core of the Propose command (#320) — pure aside from
 * the injected `readFile`/`writeFile` so it is unit-testable without vscode or a
 * real filesystem. Builds the {@link assembleContext} manifest, runs the
 * deterministic {@link seedProvider} (NO LLM / network — INV-1 Tier-0), and
 * {@link integrateProposal}s the candidates into `.minspec/constitution.md`
 * (DRAFT-marked, additive, never overwriting human / non-DRAFT content — INV-2).
 *
 * Reuses the SPEC-025 proposer functions unmodified. Only WRITES when the merge
 * actually changed the document, so a no-op (already-seeded / fully-human)
 * constitution is left byte-identical (idempotent).
 */
export interface ProposeOutcome {
  readonly result: IntegrateResult;
  /** True when the merge produced new bytes and the file was (re)written. */
  readonly wrote: boolean;
}

export function proposeConstitutionDraft(
  folder: string,
  io: {
    readFile: (p: string) => string;
    writeFile: (p: string, content: string) => void;
  },
): ProposeOutcome {
  const constitutionPath = path.join(folder, '.minspec', 'constitution.md');
  const existing = io.readFile(constitutionPath);

  const manifest = assembleContext(folder);
  const proposal = seedProvider.propose(manifest, CONSTITUTION_SECTION_SCHEMA);
  // seedProvider is synchronous (the deterministic seam); the LLM provider would
  // be async, but the seed path is offline so this is always a plain Proposal.
  const result = proposal instanceof Promise
    ? (() => {
        throw new Error('seedProvider must be synchronous (Tier-0 offline)');
      })()
    : proposal;

  const integrated = integrateProposal(existing, result);
  const wrote = integrated.merged !== existing;
  if (wrote) io.writeFile(constitutionPath, integrated.merged);

  return { result: integrated, wrote };
}

/**
 * #320: write a deterministic DRAFT proposal into `.minspec/constitution.md` —
 * the missing on-switch so a fresh project's Invariants/Principles/Constraints
 * stop being empty placeholders forever. Runs the offline {@link seedProvider}
 * over the repo's context manifest and {@link integrateProposal}s the candidates
 * (DRAFT-marked, additive, never overwriting human content — INV-2). Opens the
 * file for review with a NON-MODAL toast summarizing what was added and pointing
 * at the next step (review/edit, then *MinSpec: Compact Constitution*).
 *
 * Deterministic + offline (INV-1 Tier-0): the seed path needs no LLM or network.
 * The LLM-tailored provider stays the future agent-execute seam.
 */
export async function constitutionProposeCommand(folderArg?: string): Promise<void> {
  const folder = folderArg ?? (await resolveTargetFolder());
  if (!folder) return;

  let outcome: ProposeOutcome;
  try {
    outcome = proposeConstitutionDraft(folder, {
      readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''),
      writeFile: (p, content) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      },
    });
  } catch (err) {
    vscode.window.showErrorMessage(
      `MinSpec: Could not propose a constitution draft — ${
        err instanceof Error ? err.message : String(err)
      }.`,
    );
    return;
  }

  const constitutionPath = path.join(folder, '.minspec', 'constitution.md');
  const { result } = outcome;

  if (result.added.length === 0) {
    vscode.window.showInformationMessage(
      'MinSpec: Nothing to propose — the constitution already holds these DRAFT ' +
        'entries or human-authored rules. Edit .minspec/constitution.md to refine them.',
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument(constitutionPath);
  await vscode.window.showTextDocument(doc, { preview: false });

  const n = result.added.length;
  vscode.window.showInformationMessage(
    `MinSpec: Proposed ${n} DRAFT constitution entr${n === 1 ? 'y' : 'ies'} ` +
      '(marked DRAFT, your existing content untouched). Review and edit them, then ' +
      'run “MinSpec: Compact Constitution” to finalize.',
  );
}

/**
 * SPEC-025 FR-8: compact the constitution — strip DRAFT markers + provenance and
 * tighten — never silently. Reads constitution.md, computes the compaction, and
 * requires an explicit modal confirm showing the strip counts before writing.
 */
export async function constitutionCompactCommand(): Promise<void> {
  const folder = await resolveTargetFolder();
  if (!folder) return;

  const constitutionPath = path.join(folder, '.minspec', 'constitution.md');
  if (!fs.existsSync(constitutionPath)) {
    vscode.window.showWarningMessage(
      'MinSpec: No constitution found at .minspec/constitution.md to compact.',
    );
    return;
  }

  const content = fs.readFileSync(constitutionPath, 'utf-8');
  const result = compactConstitution(content);

  if (result.unchanged) {
    vscode.window.showInformationMessage(
      'MinSpec: Constitution has no DRAFT markers or provenance to compact — nothing to do.',
    );
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    'MinSpec: Compact the constitution?',
    {
      modal: true,
      detail:
        `This strips ${result.strippedDraftMarkers} DRAFT marker(s) and ` +
        `${result.strippedProvenance} provenance line(s), preserving the rule text. ` +
        'Review the result before committing.',
    },
    'Compact',
  );
  if (confirm !== 'Compact') return;

  fs.writeFileSync(constitutionPath, result.compacted);

  const doc = await vscode.workspace.openTextDocument(constitutionPath);
  await vscode.window.showTextDocument(doc, { preview: false });

  vscode.window.showInformationMessage(
    `MinSpec: Compacted constitution — stripped ${result.strippedDraftMarkers} DRAFT ` +
      `marker(s) and ${result.strippedProvenance} provenance line(s).`,
  );
}
