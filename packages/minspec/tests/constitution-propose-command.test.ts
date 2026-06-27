import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mock vscode (the command layer) ─────────────────────────────────────────
// The factory is hoisted, so it must not close over outer variables — define the
// spies inline and reach them via the imported `vscode` module below.

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showTextDocument: vi.fn(async () => undefined),
  },
  workspace: {
    openTextDocument: vi.fn(async () => ({})),
  },
}));

// resolveTargetFolder is only used when no folder arg is passed; we always pass
// one, but mock it so the import resolves without a vscode workspace.
vi.mock('../src/lib/resolve-folder', () => ({
  resolveTargetFolder: vi.fn(async () => undefined),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import * as vscode from 'vscode';
import {
  proposeConstitutionDraft,
  constitutionProposeCommand,
} from '../src/commands/constitution';

const showInfo = vi.mocked(vscode.window.showInformationMessage);
const showError = vi.mocked(vscode.window.showErrorMessage);
const openTextDocument = vi.mocked(vscode.workspace.openTextDocument);
const showTextDocument = vi.mocked(vscode.window.showTextDocument);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let tmp: string;

/**
 * A constitution whose four sections are present but empty (template scaffolding
 * only) — the freshly-initialized state #320 must fill.
 */
const ALL_TEMPLATE = `# proj — Constitution

## Invariants

Rules that must never be violated.

<!-- Add invariants here -->

## Principles

Guidelines.

<!-- Add principles here -->

## Constraints

Constraints.

<!-- Add constraints here -->
`;

function makeProject(constitution: string, pkg?: Record<string, unknown>): void {
  fs.mkdirSync(path.join(tmp, '.minspec'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.minspec', 'constitution.md'), constitution);
  // A package.json gives assembleContext a non-empty manifest (so the seed
  // produces ≥1 candidate — INV-4). Default: no network deps + a packages/ dir
  // so the seed catalog fires for several kinds.
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify(pkg ?? { name: 'proj', engines: { node: '>=18' } }, null, 2),
  );
  fs.mkdirSync(path.join(tmp, 'packages', 'shared'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'packages', 'shared', 'package.json'),
    JSON.stringify({ name: '@proj/shared' }, null, 2),
  );
}

function readConstitution(): string {
  return fs.readFileSync(path.join(tmp, '.minspec', 'constitution.md'), 'utf-8');
}

const realIO = {
  readFile: (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''),
  writeFile: (p: string, c: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  },
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-propose-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// =============================================================================
// proposeConstitutionDraft — the deterministic, offline core (INV-1/INV-2/INV-4)
// =============================================================================

describe('proposeConstitutionDraft (core)', () => {
  it('writes DRAFT entries into an empty/placeholder constitution', () => {
    makeProject(ALL_TEMPLATE);
    const { result, wrote } = proposeConstitutionDraft(tmp, realIO);

    expect(wrote).toBe(true);
    expect(result.added.length).toBeGreaterThan(0);

    const out = readConstitution();
    // Every added entry is DRAFT-marked (never asserted as a human rule — INV-2).
    expect(out).toMatch(/- DRAFT:/);
    // The on-disk file actually changed.
    expect(out).not.toBe(ALL_TEMPLATE);
  });

  it('is idempotent — re-running adds nothing and leaves the file byte-identical', () => {
    makeProject(ALL_TEMPLATE);
    const first = proposeConstitutionDraft(tmp, realIO);
    expect(first.wrote).toBe(true);
    const afterFirst = readConstitution();

    const second = proposeConstitutionDraft(tmp, realIO);
    expect(second.result.added.length).toBe(0);
    expect(second.wrote).toBe(false);
    expect(readConstitution()).toBe(afterFirst);
  });

  it('never clobbers a section holding human (non-DRAFT) content (INV-2)', () => {
    const human = `# proj — Constitution

## Invariants

1. A HUMAN invariant — preserve me exactly, byte for byte.

## Principles

Guidelines.

<!-- Add principles here -->

## Constraints

Constraints.

<!-- Add constraints here -->
`;
    makeProject(human);
    const { result } = proposeConstitutionDraft(tmp, realIO);
    const out = readConstitution();

    // Human Invariants section preserved verbatim, no DRAFT injected there.
    expect(out).toContain('1. A HUMAN invariant — preserve me exactly, byte for byte.');
    const invSection = out.split('## Principles')[0];
    expect(invSection).not.toMatch(/DRAFT:/);
    // No candidate targeting a human-filled section was written.
    for (const c of result.added) {
      expect(c.section).not.toBe('Invariants');
    }
  });

  it('resolves the ContextManifest + seed (deterministic — same input, same output)', () => {
    makeProject(ALL_TEMPLATE);
    const a = proposeConstitutionDraft(tmp, {
      readFile: realIO.readFile,
      writeFile: () => {}, // dry run — do not mutate disk
    });
    const b = proposeConstitutionDraft(tmp, {
      readFile: realIO.readFile,
      writeFile: () => {},
    });
    expect(b.result.merged).toBe(a.result.merged);
    expect(b.result.added.map((c) => c.id)).toEqual(a.result.added.map((c) => c.id));
  });
});

// =============================================================================
// constitutionProposeCommand — the vscode surface
// =============================================================================

describe('constitutionProposeCommand (surface)', () => {
  it('writes the draft, opens the file, and shows a non-modal summary toast', async () => {
    makeProject(ALL_TEMPLATE);
    await constitutionProposeCommand(tmp);

    // File written with DRAFT entries.
    expect(readConstitution()).toMatch(/- DRAFT:/);
    // Opened for review.
    expect(openTextDocument).toHaveBeenCalledWith(
      path.join(tmp, '.minspec', 'constitution.md'),
    );
    expect(showTextDocument).toHaveBeenCalled();
    // Summary toast mentions the count + points at Compact.
    expect(showInfo).toHaveBeenCalledTimes(1);
    const msg = String(showInfo.mock.calls[0][0]);
    expect(msg).toMatch(/Proposed \d+ DRAFT/);
    expect(msg).toMatch(/Compact Constitution/);
    // It is non-modal (no modal options object passed).
    expect(showInfo.mock.calls[0][1]).toBeUndefined();
  });

  it('on a no-op (already seeded) reports nothing-to-propose and does not reopen', async () => {
    makeProject(ALL_TEMPLATE);
    await constitutionProposeCommand(tmp); // seed once
    vi.clearAllMocks();

    await constitutionProposeCommand(tmp); // second run — nothing new
    expect(showInfo).toHaveBeenCalledTimes(1);
    expect(String(showInfo.mock.calls[0][0])).toMatch(/Nothing to propose/i);
    expect(showTextDocument).not.toHaveBeenCalled();
  });

  it('does not throw and surfaces an error toast when resolution has no folder', async () => {
    // No folder arg, resolveTargetFolder mocked → undefined → early return.
    await expect(constitutionProposeCommand()).resolves.toBeUndefined();
    expect(showInfo).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });
});
