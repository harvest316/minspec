/**
 * Tests for FrontmatterCompletionProvider — the VS Code adapter layer in
 * frontmatter-completion.ts. Covers all branches in provideCompletionItems
 * (lines 129-163), which are untouched by the pure-core tests.
 *
 * Coverage targets:
 *  - stmt/branch/func >90% for views/frontmatter-completion.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── vi.hoisted: variables referenced inside vi.mock factories ─────────────────
// vi.mock calls are hoisted to the top of the file by Vitest's transform; any
// variables they close over must themselves be hoisted via vi.hoisted() so they
// are initialized before the factory runs.

const { mockListEpics, mockGetWorkspaceFolder, vscodeWorkspace } = vi.hoisted(() => {
  const mockListEpics = vi.fn();
  const mockGetWorkspaceFolder = vi.fn(() => ({ uri: { fsPath: '/fake/workspace' } }));
  const vscodeWorkspace = {
    getWorkspaceFolder: mockGetWorkspaceFolder,
    workspaceFolders: [{ uri: { fsPath: '/fake/workspace' } }] as Array<{ uri: { fsPath: string } }> | undefined,
  };
  return { mockListEpics, mockGetWorkspaceFolder, vscodeWorkspace };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../src/lib/epic-manager', () => ({
  listEpics: mockListEpics,
}));

vi.mock('../src/lib/adr-manager', () => ({
  ADR_STATUS_VALUES: ['proposed', 'accepted', 'deprecated', 'superseded'],
}));

vi.mock('vscode', () => {
  class CompletionItem {
    label: string;
    kind?: number;
    detail?: string;
    sortText?: string;
    constructor(label: string, kind?: number) {
      this.label = label;
      this.kind = kind;
    }
  }

  const CompletionItemKind = { EnumMember: 19 };

  return {
    CompletionItem,
    CompletionItemKind,
    workspace: vscodeWorkspace,
  };
});

// ── Import after mocks are registered ────────────────────────────────────────

import { FrontmatterCompletionProvider } from '../src/views/frontmatter-completion';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SPEC_DOC = '---\nid: SPEC-001\ntype: requirements\nstatus: \ntier: \nepic: \n---\n\n# Spec\n';
const ADR_DOC  = '---\nid: DR-007\ntitle: Something\nstatus: \ndate: 2026-05-29\n---\n\n## Context\n';

/**
 * Build a minimal fake vscode.TextDocument.
 * @param content  Full document text
 * @param fileName File basename or full path used for ADR detection
 */
function makeDocument(content: string, fileName = 'requirements.md') {
  const lines = content.split('\n');
  return {
    fileName: fileName.includes('/') || fileName.includes('\\')
      ? fileName
      : `/workspace/${fileName}`,
    uri: { scheme: 'file', fsPath: `/workspace/${fileName}` },
    getText: () => content,
    lineAt: (lineIndex: number) => ({ text: lines[lineIndex] ?? '' }),
  };
}

/** Build a minimal fake vscode.Position. */
function makePosition(line: number, character: number) {
  return { line, character };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FrontmatterCompletionProvider.provideCompletionItems()', () => {
  let provider: FrontmatterCompletionProvider;

  beforeEach(() => {
    provider = new FrontmatterCompletionProvider();
    vi.clearAllMocks();
    // Reset to defaults each test
    mockGetWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/fake/workspace' } });
    vscodeWorkspace.workspaceFolders = [{ uri: { fsPath: '/fake/workspace' } }];
  });

  // ── Basic plumbing: returns CompletionItem objects ────────────────────────

  it('returns CompletionItem objects for a known frontmatter field', () => {
    const doc = makeDocument(SPEC_DOC, 'requirements.md');
    // Line 3 in SPEC_DOC is "status: "
    const pos = makePosition(3, 'status: '.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.kind).toBe(19); // CompletionItemKind.EnumMember
      expect(item.detail).toBe('MinSpec frontmatter');
    }
  });

  it('assigns zero-padded sortText to preserve picker order', () => {
    const doc = makeDocument(SPEC_DOC, 'requirements.md');
    // Line 4 is "tier: "
    const pos = makePosition(4, 'tier: '.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    expect(items.map(i => i.sortText)).toEqual(['000', '001', '002', '003']);
    expect(items.map(i => i.label)).toEqual(['T1', 'T2', 'T3', 'T4']);
  });

  // ── Empty result when no completions apply ────────────────────────────────

  it('returns [] when cursor is outside the frontmatter block', () => {
    const doc = makeDocument(SPEC_DOC, 'requirements.md');
    // Line 8 is "# Spec" — past the closing ---
    const pos = makePosition(8, 'status: '.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    expect(items).toEqual([]);
  });

  it('returns [] for an unknown frontmatter field', () => {
    const doc = makeDocument(SPEC_DOC, 'requirements.md');
    // Line 2 is "type: requirements"
    const pos = makePosition(2, 'type: '.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    expect(items).toEqual([]);
  });

  it('returns [] for a document with no frontmatter delimiters', () => {
    const doc = makeDocument('# Just a title\n\nstatus: new\n', 'notes.md');
    const pos = makePosition(2, 'status: '.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    expect(items).toEqual([]);
  });

  // ── File-name extraction via path separators ──────────────────────────────

  it('recognises a DR file by basename (POSIX path)', () => {
    const doc = makeDocument(ADR_DOC, 'DR-007-something.md');
    // Line 3 is "status: "
    const pos = makePosition(3, 'status: '.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    expect(items.map(i => i.label)).toEqual(['proposed', 'accepted', 'deprecated', 'superseded']);
  });

  it('recognises a DR file by basename (Windows backslash path)', () => {
    const content = ADR_DOC;
    const lines = content.split('\n');
    const doc = {
      fileName: 'C:\\workspace\\DR-009-bar.md',
      uri: { scheme: 'file', fsPath: 'C:\\workspace\\DR-009-bar.md' },
      getText: () => content,
      lineAt: (lineIndex: number) => ({ text: lines[lineIndex] ?? '' }),
    };
    const pos = makePosition(3, 'status: '.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    expect(items.map(i => i.label)).toEqual(['proposed', 'accepted', 'deprecated', 'superseded']);
  });

  // ── Epic field — dynamic listEpics call ───────────────────────────────────

  it('calls listEpics and offers ids-then-slugs for epic: line', () => {
    mockListEpics.mockReturnValue([
      { id: 'EPIC-001', slug: 'telemetry', title: 'T', status: 'active', order: 1, filePath: '/f' },
      { id: 'EPIC-002', slug: 'auth',      title: 'A', status: 'active', order: 2, filePath: '/f' },
    ]);

    const doc = makeDocument(SPEC_DOC, 'requirements.md');
    // Line 5 is "epic: "
    const pos = makePosition(5, 'epic: '.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    expect(mockListEpics).toHaveBeenCalledWith('/fake/workspace');
    expect(items.map(i => i.label)).toEqual(['EPIC-001', 'EPIC-002', 'telemetry', 'auth']);
  });

  it('swallows listEpics errors and returns [] for epic: (best-effort)', () => {
    mockListEpics.mockImplementation(() => { throw new Error('FS read failure'); });

    const doc = makeDocument(SPEC_DOC, 'requirements.md');
    const pos = makePosition(5, 'epic: '.length);

    // Must not throw
    const items = provider.provideCompletionItems(doc as any, pos as any);

    expect(items).toEqual([]);
  });

  it('falls back to workspaceFolders[0] when getWorkspaceFolder returns null', () => {
    mockListEpics.mockReturnValue([
      { id: 'EPIC-003', slug: 'onboarding', title: 'O', status: 'proposed', order: 3, filePath: '/f' },
    ]);
    mockGetWorkspaceFolder.mockReturnValueOnce(null);

    const doc = makeDocument(SPEC_DOC, 'requirements.md');
    const pos = makePosition(5, 'epic: '.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    // workspaceFolders[0] fallback → still resolves '/fake/workspace'
    expect(mockListEpics).toHaveBeenCalledWith('/fake/workspace');
    expect(items.map(i => i.label)).toContain('EPIC-003');
  });

  it('skips listEpics when both workspace sources are unavailable', () => {
    mockGetWorkspaceFolder.mockReturnValueOnce(null);
    vscodeWorkspace.workspaceFolders = undefined;

    const doc = makeDocument(SPEC_DOC, 'requirements.md');
    const pos = makePosition(5, 'epic: '.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    expect(mockListEpics).not.toHaveBeenCalled();
    expect(items).toEqual([]);
  });

  it('does NOT call listEpics for a non-epic line', () => {
    const doc = makeDocument(SPEC_DOC, 'requirements.md');
    // Line 4 is "tier: "
    const pos = makePosition(4, 'tier: '.length);

    provider.provideCompletionItems(doc as any, pos as any);

    expect(mockListEpics).not.toHaveBeenCalled();
  });

  // ── Prefix filtering round-trips through the adapter ─────────────────────

  it('prefix-filters status values (only matching values returned)', () => {
    const lines = SPEC_DOC.split('\n');
    lines[3] = 'status: imp'; // cursor after "imp" — matches "implementing"
    const content = lines.join('\n');
    const doc = {
      fileName: '/workspace/requirements.md',
      uri: { scheme: 'file', fsPath: '/workspace/requirements.md' },
      getText: () => content,
      lineAt: (lineIndex: number) => ({ text: lines[lineIndex] ?? '' }),
    };
    const pos = makePosition(3, 'status: imp'.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    expect(items.map(i => i.label)).toEqual(['implementing']);
  });

  it('handles phase keys (e.g. specify:) within the adapter', () => {
    const phaseDoc = '---\nid: SPEC-001\nspecify: \n---\n\n# Body\n';
    const doc = makeDocument(phaseDoc, 'design.md');
    const pos = makePosition(2, 'specify: '.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    expect(items.map(i => i.label)).toEqual(['pending', 'in-progress', 'done', 'skipped']);
  });

  // ── Edge case: empty fileName (covers the ?? '' null-coalesce branch) ──────

  it('handles an empty fileName gracefully (treats as non-DR, non-ADR file)', () => {
    const content = SPEC_DOC;
    const lines = content.split('\n');
    const doc = {
      fileName: '', // empty string → .split().pop() returns undefined → ?? '' applies
      uri: { scheme: 'file', fsPath: '' },
      getText: () => content,
      lineAt: (lineIndex: number) => ({ text: lines[lineIndex] ?? '' }),
    };
    // Line 3 is "status: " — a spec file (no DR-* prefix in empty name)
    const pos = makePosition(3, 'status: '.length);

    const items = provider.provideCompletionItems(doc as any, pos as any);

    // Empty fileName is not a DR file, so spec statuses are offered
    expect(items.map(i => i.label)).toEqual(['new', 'specifying', 'implementing', 'done', 'archived']);
  });
});
