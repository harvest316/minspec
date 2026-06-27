import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock vscode ---
vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    collapsibleState: number;
    description?: string;
    iconPath?: unknown;
    command?: unknown;
    contextValue?: string;
    tooltip?: string;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    event = vi.fn();
    fire = vi.fn();
  },
  ThemeIcon: class {
    id: string;
    constructor(id: string) { this.id = id; }
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file' }),
    parse: (s: string) => ({ toString: () => s }),
  },
  Range: class {
    constructor(
      public startLine: number,
      public startChar: number,
      public endLine: number,
      public endChar: number,
    ) {}
  },
  Selection: class {
    constructor(
      public startLine: number,
      public startChar: number,
      public endLine?: number,
      public endChar?: number,
    ) {
      if (endLine === undefined) this.endLine = startLine;
      if (endChar === undefined) this.endChar = startChar;
    }
    get start() { return { line: this.startLine, character: this.startChar }; }
    get end() { return { line: this.endLine ?? this.startLine, character: this.endChar ?? this.startChar }; }
  },
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showTextDocument: vi.fn(),
    activeTextEditor: undefined as unknown,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/test' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn((_key: string, def: unknown) => def) })),
    openTextDocument: vi.fn(),
  },
  ViewColumn: { Beside: 2 },
  TextEditorRevealType: { InCenter: 2 },
  CancellationToken: {},
  CodeLens: class {
    constructor(public range: unknown, public command?: unknown) {}
  },
}));

// --- Mock lib dependencies ---
const mockLoadTraceability = vi.fn(() => ({}));
const mockSaveTraceability = vi.fn();
const mockAddFileMapping = vi.fn((d: unknown) => d);
const mockAddTestMapping = vi.fn((d: unknown) => d);
const mockFindRequirementsForFile = vi.fn(() => [] as unknown[]);
const mockFindCodeForRequirement = vi.fn(() => ({ files: [], tests: [] }));
const mockListTracedSpecs = vi.fn(() => [] as string[]);
const mockListRequirements = vi.fn(() => [] as string[]);
const mockParseLocationString = vi.fn((s: string) => ({ relativePath: s, startLine: 1, endLine: 1 }));
const mockFormatLocationString = vi.fn((p: string, s: number, e: number) => `${p}:${s}-${e}`);

vi.mock('../src/lib/traceability', () => ({
  loadTraceability: (...args: unknown[]) => mockLoadTraceability(...args),
  saveTraceability: (...args: unknown[]) => mockSaveTraceability(...args),
  addFileMapping: (...args: unknown[]) => mockAddFileMapping(...args),
  addTestMapping: (...args: unknown[]) => mockAddTestMapping(...args),
  findRequirementsForFile: (...args: unknown[]) => mockFindRequirementsForFile(...args),
  findCodeForRequirement: (...args: unknown[]) => mockFindCodeForRequirement(...args),
  listTracedSpecs: (...args: unknown[]) => mockListTracedSpecs(...args),
  listRequirements: (...args: unknown[]) => mockListRequirements(...args),
  parseLocationString: (...args: unknown[]) => mockParseLocationString(...args),
  formatLocationString: (...args: unknown[]) => mockFormatLocationString(...args),
}));

vi.mock('../src/lib/config', async (importOriginal) => ({
  ...(await importOriginal()),
  loadConfig: vi.fn(() => ({ specsDir: 'specs' })),
  resolveAndValidate: vi.fn((root: string, sub: string) => `${root}/${sub}`),
}));

vi.mock('fs', () => ({
  readdirSync: vi.fn(() => []),
  writeFileSync: vi.fn(),
}));

import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  MinSpecCodeLensProvider,
  MinSpecSpecFileLensProvider,
  goToSpecCommand,
  goToCodeCommand,
  linkToSpecCommand,
} from '../src/views/codelens-provider';

// --- Helpers ---

function makeDocument(
  fsPath: string,
  lineCount = 10,
  text = '',
  lineTexts: string[] = [],
): vscode.TextDocument {
  return {
    uri: { fsPath, scheme: 'file' },
    lineCount,
    getText: () => text,
    lineAt: (i: number) => ({ text: lineTexts[i] ?? '' }),
  } as unknown as vscode.TextDocument;
}

const token = {} as vscode.CancellationToken;

// =============================================================================
// MinSpecCodeLensProvider
// =============================================================================

describe('MinSpecCodeLensProvider', () => {
  let provider: MinSpecCodeLensProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new MinSpecCodeLensProvider('/tmp/test');
  });

  it('constructs with a workspace root', () => {
    expect(provider).toBeDefined();
  });

  it('refresh() fires the event emitter', () => {
    provider.refresh();
    // The EventEmitter mock exposes fire as vi.fn()
    expect((provider as unknown as { _onDidChangeCodeLenses: { fire: ReturnType<typeof vi.fn> } })._onDidChangeCodeLenses.fire).toHaveBeenCalled();
  });

  it('returns empty when workspace root is empty', () => {
    const emptyProvider = new MinSpecCodeLensProvider('');
    const doc = makeDocument('/tmp/test/src/foo.ts');
    expect(emptyProvider.provideCodeLenses(doc, token)).toEqual([]);
  });

  it('returns empty when codelens is disabled via config', () => {
    const mockGet = vi.fn((_key: string, _def: unknown) => false);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: mockGet } as unknown as vscode.WorkspaceConfiguration);

    const doc = makeDocument('/tmp/test/src/foo.ts');
    expect(provider.provideCodeLenses(doc, token)).toEqual([]);
  });

  it('returns empty for files in .minspec/ directory', () => {
    const doc = makeDocument('/tmp/test/.minspec/traceability.json');
    expect(provider.provideCodeLenses(doc, token)).toEqual([]);
  });

  it('returns empty for files in node_modules/ directory', () => {
    const doc = makeDocument('/tmp/test/node_modules/lodash/index.js');
    expect(provider.provideCodeLenses(doc, token)).toEqual([]);
  });

  it('returns empty for files in specs/ directory', () => {
    const doc = makeDocument('/tmp/test/specs/SPEC-001.md');
    expect(provider.provideCodeLenses(doc, token)).toEqual([]);
  });

  it('returns empty when no traceability mappings exist', () => {
    const mockGet = vi.fn((_key: string, def: unknown) => def);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: mockGet } as unknown as vscode.WorkspaceConfiguration);
    mockFindRequirementsForFile.mockReturnValue([]);
    const doc = makeDocument('/tmp/test/src/foo.ts');
    expect(provider.provideCodeLenses(doc, token)).toEqual([]);
  });

  it('returns CodeLens items for traceability mappings', () => {
    const mockGet = vi.fn((_key: string, def: unknown) => def);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: mockGet } as unknown as vscode.WorkspaceConfiguration);
    mockFindRequirementsForFile.mockReturnValue([
      { specId: 'SPEC-001', requirementKey: 'rate-limit', location: 'src/foo.ts:3-5' },
    ]);
    mockParseLocationString.mockReturnValue({ relativePath: 'src/foo.ts', startLine: 3, endLine: 5 });

    const doc = makeDocument('/tmp/test/src/foo.ts', 20);
    const lenses = provider.provideCodeLenses(doc, token);

    expect(lenses).toHaveLength(1);
    expect(lenses[0].command).toBeDefined();
    expect((lenses[0].command as { title: string }).title).toContain('SPEC-001');
    expect((lenses[0].command as { title: string }).title).toContain('rate-limit');
    expect((lenses[0].command as { command: string }).command).toBe('minspec.goToSpec');
  });

  it('skips mappings where startLine exceeds document lineCount', () => {
    const mockGet = vi.fn((_key: string, def: unknown) => def);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: mockGet } as unknown as vscode.WorkspaceConfiguration);
    mockFindRequirementsForFile.mockReturnValue([
      { specId: 'SPEC-001', requirementKey: 'rate-limit', location: 'src/foo.ts:100-105' },
    ]);
    mockParseLocationString.mockReturnValue({ relativePath: 'src/foo.ts', startLine: 100, endLine: 105 });

    const doc = makeDocument('/tmp/test/src/foo.ts', 10);
    const lenses = provider.provideCodeLenses(doc, token);

    expect(lenses).toHaveLength(0);
  });

  it('clamps negative line numbers to 0', () => {
    const mockGet = vi.fn((_key: string, def: unknown) => def);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: mockGet } as unknown as vscode.WorkspaceConfiguration);
    mockFindRequirementsForFile.mockReturnValue([
      { specId: 'SPEC-001', requirementKey: 'init', location: 'src/foo.ts:0-0' },
    ]);
    mockParseLocationString.mockReturnValue({ relativePath: 'src/foo.ts', startLine: 0, endLine: 0 });

    const doc = makeDocument('/tmp/test/src/foo.ts', 10);
    const lenses = provider.provideCodeLenses(doc, token);

    expect(lenses).toHaveLength(1);
    // Line should be clamped to 0 (Math.max(0, 0 - 1) = 0)
    expect((lenses[0].range as { startLine: number }).startLine).toBe(0);
  });

  it('returns multiple CodeLens items for multiple mappings', () => {
    const mockGet = vi.fn((_key: string, def: unknown) => def);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: mockGet } as unknown as vscode.WorkspaceConfiguration);
    mockFindRequirementsForFile.mockReturnValue([
      { specId: 'SPEC-001', requirementKey: 'rate-limit', location: 'src/foo.ts:3-5' },
      { specId: 'SPEC-002', requirementKey: 'auth-check', location: 'src/foo.ts:10-15' },
    ]);
    mockParseLocationString
      .mockReturnValueOnce({ relativePath: 'src/foo.ts', startLine: 3, endLine: 5 })
      .mockReturnValueOnce({ relativePath: 'src/foo.ts', startLine: 10, endLine: 15 });

    const doc = makeDocument('/tmp/test/src/foo.ts', 20);
    const lenses = provider.provideCodeLenses(doc, token);

    expect(lenses).toHaveLength(2);
  });
});

// =============================================================================
// MinSpecSpecFileLensProvider
// =============================================================================

describe('MinSpecSpecFileLensProvider', () => {
  let provider: MinSpecSpecFileLensProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new MinSpecSpecFileLensProvider('/tmp/test');

    // Default: codelens enabled, specsDir = 'specs'
    const mockGet = vi.fn((key: string, def: unknown) => {
      if (key === 'codelens.enabled') return true;
      if (key === 'specsDir') return 'specs';
      return def;
    });
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: mockGet } as unknown as vscode.WorkspaceConfiguration);
  });

  it('constructs and has refresh()', () => {
    expect(provider).toBeDefined();
    provider.refresh();
    expect((provider as unknown as { _onDidChangeCodeLenses: { fire: ReturnType<typeof vi.fn> } })._onDidChangeCodeLenses.fire).toHaveBeenCalled();
  });

  it('returns empty when workspace root is empty', () => {
    const emptyProvider = new MinSpecSpecFileLensProvider('');
    const doc = makeDocument('/tmp/test/specs/SPEC-001.md');
    expect(emptyProvider.provideCodeLenses(doc, token)).toEqual([]);
  });

  it('returns empty when codelens is disabled', () => {
    const mockGet = vi.fn((_key: string, _def: unknown) => false);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: mockGet } as unknown as vscode.WorkspaceConfiguration);

    const doc = makeDocument('/tmp/test/specs/SPEC-001.md');
    expect(provider.provideCodeLenses(doc, token)).toEqual([]);
  });

  it('returns empty for non-spec files', () => {
    const doc = makeDocument('/tmp/test/src/foo.ts');
    expect(provider.provideCodeLenses(doc, token)).toEqual([]);
  });

  it('returns empty for non-markdown spec files', () => {
    const doc = makeDocument('/tmp/test/specs/SPEC-001.json');
    expect(provider.provideCodeLenses(doc, token)).toEqual([]);
  });

  it('returns empty when no spec ID found in frontmatter', () => {
    const doc = makeDocument('/tmp/test/specs/SPEC-001.md', 10, 'title: No ID here\n---');
    expect(provider.provideCodeLenses(doc, token)).toEqual([]);
  });

  it('returns empty when spec ID has no traceability data', () => {
    mockLoadTraceability.mockReturnValue({});
    const doc = makeDocument('/tmp/test/specs/SPEC-001.md', 10, 'id: SPEC-001\ntitle: Test');
    expect(provider.provideCodeLenses(doc, token)).toEqual([]);
  });

  it('returns CodeLens for requirements with code mappings', () => {
    mockLoadTraceability.mockReturnValue({
      'SPEC-001': {
        requirements: {
          'rate-limit': { files: ['src/rate-limit.ts:3-5'], tests: [] },
        },
      },
    });

    const lineTexts = [
      '---',
      'id: SPEC-001',
      'title: Rate Limiting',
      '---',
      '',
      '## Requirements',
      '',
      '### rate-limit',
      'Rate limit to 100 req/s',
    ];

    const doc = makeDocument('/tmp/test/specs/SPEC-001.md', lineTexts.length, lineTexts.join('\n'), lineTexts);
    const lenses = provider.provideCodeLenses(doc, token);

    expect(lenses).toHaveLength(1);
    expect((lenses[0].command as { title: string }).title).toContain('1 code location');
    expect((lenses[0].command as { command: string }).command).toBe('minspec.goToCode');
  });

  it('shows plural label for multiple code locations', () => {
    mockLoadTraceability.mockReturnValue({
      'SPEC-001': {
        requirements: {
          'rate-limit': { files: ['src/a.ts:3-5', 'src/b.ts:1-2'], tests: ['tests/a.test.ts:10-20'] },
        },
      },
    });

    const lineTexts = ['id: SPEC-001', '', 'rate-limit'];
    const doc = makeDocument('/tmp/test/specs/SPEC-001.md', lineTexts.length, lineTexts.join('\n'), lineTexts);
    const lenses = provider.provideCodeLenses(doc, token);

    expect(lenses).toHaveLength(1);
    expect((lenses[0].command as { title: string }).title).toContain('3 code locations');
  });

  it('skips requirements with no file or test mappings', () => {
    mockLoadTraceability.mockReturnValue({
      'SPEC-001': {
        requirements: {
          'empty-req': { files: [], tests: [] },
        },
      },
    });

    const lineTexts = ['id: SPEC-001', '', 'empty-req'];
    const doc = makeDocument('/tmp/test/specs/SPEC-001.md', lineTexts.length, lineTexts.join('\n'), lineTexts);
    const lenses = provider.provideCodeLenses(doc, token);

    expect(lenses).toHaveLength(0);
  });

  it('skips requirements whose key is not found in the document', () => {
    mockLoadTraceability.mockReturnValue({
      'SPEC-001': {
        requirements: {
          'not-in-doc': { files: ['src/a.ts:1-5'], tests: [] },
        },
      },
    });

    const lineTexts = ['id: SPEC-001', '', 'something else'];
    const doc = makeDocument('/tmp/test/specs/SPEC-001.md', lineTexts.length, lineTexts.join('\n'), lineTexts);
    const lenses = provider.provideCodeLenses(doc, token);

    expect(lenses).toHaveLength(0);
  });
});

// =============================================================================
// goToSpecCommand
// =============================================================================

describe('goToSpecCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows error when workspace root is empty', async () => {
    await goToSpecCommand('');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('MinSpec: No workspace folder open.');
  });

  it('prompts for spec when no specId provided and shows info when no specs exist', async () => {
    mockListTracedSpecs.mockReturnValue([]);
    await goToSpecCommand('/tmp/test');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('MinSpec: No traceability mappings found.');
  });

  it('returns early when user cancels spec quick pick', async () => {
    mockListTracedSpecs.mockReturnValue(['SPEC-001']);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);
    await goToSpecCommand('/tmp/test');
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('shows error when spec file not found', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    await goToSpecCommand('/tmp/test', 'SPEC-999');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('MinSpec: Spec file for SPEC-999 not found.');
  });

  it('opens spec document when specId provided and file found', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['SPEC-001.md'] as unknown as ReturnType<typeof fs.readdirSync>);
    const mockDoc = { getText: () => '', lineCount: 5 };
    const mockEditor = { revealRange: vi.fn(), selection: null };
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as unknown as vscode.TextDocument);
    vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as unknown as vscode.TextEditor);

    await goToSpecCommand('/tmp/test', 'SPEC-001');

    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc);
  });

  it('scrolls to requirement key when provided', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['SPEC-001.md'] as unknown as ReturnType<typeof fs.readdirSync>);
    const mockDoc = {
      getText: () => 'line0\nline1\nrate-limit\nline3',
      lineCount: 4,
    };
    const mockEditor = { revealRange: vi.fn(), selection: null };
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as unknown as vscode.TextDocument);
    vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as unknown as vscode.TextEditor);

    await goToSpecCommand('/tmp/test', 'SPEC-001', 'rate-limit');

    expect(mockEditor.revealRange).toHaveBeenCalled();
    expect(mockEditor.selection).not.toBeNull();
  });
});

// =============================================================================
// goToCodeCommand
// =============================================================================

describe('goToCodeCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows error when workspace root is empty', async () => {
    await goToCodeCommand('');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('MinSpec: No workspace folder open.');
  });

  it('prompts for spec when no specId provided and shows info when no specs', async () => {
    mockListTracedSpecs.mockReturnValue([]);
    await goToCodeCommand('/tmp/test');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('MinSpec: No traceability mappings found.');
  });

  it('returns early when user cancels spec quick pick', async () => {
    mockListTracedSpecs.mockReturnValue(['SPEC-001']);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);
    await goToCodeCommand('/tmp/test');
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('prompts for requirement when no requirementKey and shows info when empty', async () => {
    mockListRequirements.mockReturnValue([]);
    await goToCodeCommand('/tmp/test', 'SPEC-001');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('MinSpec: No requirements mapped for SPEC-001.');
  });

  it('returns early when user cancels requirement quick pick', async () => {
    mockListRequirements.mockReturnValue(['rate-limit']);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);
    await goToCodeCommand('/tmp/test', 'SPEC-001');
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('shows info when no code locations mapped for requirement', async () => {
    mockFindCodeForRequirement.mockReturnValue({ files: [], tests: [] });
    await goToCodeCommand('/tmp/test', 'SPEC-001', 'rate-limit');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: No code locations mapped for SPEC-001 > rate-limit.',
    );
  });

  it('navigates directly for a single code location', async () => {
    mockFindCodeForRequirement.mockReturnValue({ files: ['src/foo.ts:3-5'], tests: [] });
    mockParseLocationString.mockReturnValue({ relativePath: 'src/foo.ts', startLine: 3, endLine: 5 });

    const mockDoc = {};
    const mockEditor = { revealRange: vi.fn(), selection: null };
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as unknown as vscode.TextDocument);
    vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as unknown as vscode.TextEditor);

    await goToCodeCommand('/tmp/test', 'SPEC-001', 'rate-limit');

    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc);
    expect(mockEditor.revealRange).toHaveBeenCalled();
  });

  it('shows quick pick for multiple code locations', async () => {
    mockFindCodeForRequirement.mockReturnValue({
      files: ['src/a.ts:1-5'],
      tests: ['tests/a.test.ts:10-20'],
    });

    const picked = { label: 'src/a.ts:1-5', rawLocation: 'src/a.ts:1-5' };
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(picked as unknown as string);
    mockParseLocationString.mockReturnValue({ relativePath: 'src/a.ts', startLine: 1, endLine: 5 });

    const mockDoc = {};
    const mockEditor = { revealRange: vi.fn(), selection: null };
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as unknown as vscode.TextDocument);
    vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as unknown as vscode.TextEditor);

    await goToCodeCommand('/tmp/test', 'SPEC-001', 'rate-limit');

    expect(vscode.window.showQuickPick).toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
  });

  it('returns early when user cancels location quick pick', async () => {
    mockFindCodeForRequirement.mockReturnValue({
      files: ['src/a.ts:1-5'],
      tests: ['tests/a.test.ts:10-20'],
    });
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await goToCodeCommand('/tmp/test', 'SPEC-001', 'rate-limit');

    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('shows error when file cannot be opened', async () => {
    mockFindCodeForRequirement.mockReturnValue({ files: ['missing.ts:1-5'], tests: [] });
    mockParseLocationString.mockReturnValue({ relativePath: 'missing.ts', startLine: 1, endLine: 5 });
    vi.mocked(vscode.workspace.openTextDocument).mockRejectedValue(new Error('not found'));

    await goToCodeCommand('/tmp/test', 'SPEC-001', 'rate-limit');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('MinSpec: Could not open file: missing.ts');
  });
});

// =============================================================================
// linkToSpecCommand
// =============================================================================

describe('linkToSpecCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset active editor
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
  });

  it('shows error when workspace root is empty', async () => {
    await linkToSpecCommand('');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('MinSpec: No workspace folder open.');
  });

  it('shows error when no active editor', async () => {
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
    await linkToSpecCommand('/tmp/test');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('MinSpec: No active editor.');
  });

  it('shows error when no specs directory exists', async () => {
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: { fsPath: '/tmp/test/src/foo.ts' } },
      selection: { start: { line: 5 }, end: { line: 5 } },
    };
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT'); });

    await linkToSpecCommand('/tmp/test');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: No specs directory found. Run "MinSpec: Initialize SDD Structure" first.',
    );
  });

  it('shows error when specs directory is empty', async () => {
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: { fsPath: '/tmp/test/src/foo.ts' } },
      selection: { start: { line: 5 }, end: { line: 5 } },
    };
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    await linkToSpecCommand('/tmp/test');

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('MinSpec: No spec files found.');
  });

  it('returns early when user cancels spec pick', async () => {
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: { fsPath: '/tmp/test/src/foo.ts' } },
      selection: { start: { line: 5 }, end: { line: 5 } },
    };
    vi.mocked(fs.readdirSync).mockReturnValue(['SPEC-001.md'] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await linkToSpecCommand('/tmp/test');

    expect(mockSaveTraceability).not.toHaveBeenCalled();
  });

  it('links code file to spec requirement (happy path, no existing reqs)', async () => {
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: { fsPath: '/tmp/test/src/foo.ts' } },
      selection: { start: { line: 5 }, end: { line: 10 } },
    };
    vi.mocked(fs.readdirSync).mockReturnValue(['SPEC-001.md'] as unknown as ReturnType<typeof fs.readdirSync>);

    // User picks SPEC-001
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ label: 'SPEC-001', description: 'SPEC-001.md' } as unknown as string);

    // No existing requirements
    mockListRequirements.mockReturnValue([]);

    // User types requirement key
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('rate-limit');

    await linkToSpecCommand('/tmp/test');

    expect(mockAddFileMapping).toHaveBeenCalled();
    expect(mockSaveTraceability).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Linked code'),
    );
  });

  it('detects test files by .test. extension', async () => {
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: { fsPath: '/tmp/test/tests/foo.test.ts' } },
      selection: { start: { line: 3 }, end: { line: 3 } },
    };
    vi.mocked(fs.readdirSync).mockReturnValue(['SPEC-001.md'] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ label: 'SPEC-001' } as unknown as string);
    mockListRequirements.mockReturnValue([]);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('rate-limit');

    await linkToSpecCommand('/tmp/test');

    expect(mockAddTestMapping).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Linked test'),
    );
  });

  it('detects test files by tests/ directory prefix', async () => {
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: { fsPath: '/tmp/test/tests/unit/helper.ts' } },
      selection: { start: { line: 0 }, end: { line: 0 } },
    };
    vi.mocked(fs.readdirSync).mockReturnValue(['SPEC-001.md'] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ label: 'SPEC-001' } as unknown as string);
    mockListRequirements.mockReturnValue([]);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('init');

    await linkToSpecCommand('/tmp/test');

    expect(mockAddTestMapping).toHaveBeenCalled();
  });

  it('lets user pick from existing requirements', async () => {
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: { fsPath: '/tmp/test/src/foo.ts' } },
      selection: { start: { line: 0 }, end: { line: 0 } },
    };
    vi.mocked(fs.readdirSync).mockReturnValue(['SPEC-001.md'] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ label: 'SPEC-001' } as unknown as string) // pick spec
      .mockResolvedValueOnce('rate-limit' as unknown as string); // pick existing req

    mockListRequirements.mockReturnValue(['rate-limit', 'auth-check']);

    await linkToSpecCommand('/tmp/test');

    expect(mockAddFileMapping).toHaveBeenCalled();
    expect(mockSaveTraceability).toHaveBeenCalled();
  });

  it('lets user create new requirement when existing reqs available', async () => {
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: { fsPath: '/tmp/test/src/foo.ts' } },
      selection: { start: { line: 0 }, end: { line: 0 } },
    };
    vi.mocked(fs.readdirSync).mockReturnValue(['SPEC-001.md'] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ label: 'SPEC-001' } as unknown as string) // pick spec
      .mockResolvedValueOnce('$(add) Create new requirement key...' as unknown as string); // create new

    mockListRequirements.mockReturnValue(['rate-limit']);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('new-req');

    await linkToSpecCommand('/tmp/test');

    expect(mockAddFileMapping).toHaveBeenCalled();
  });

  it('returns early when user cancels requirement input', async () => {
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: { fsPath: '/tmp/test/src/foo.ts' } },
      selection: { start: { line: 0 }, end: { line: 0 } },
    };
    vi.mocked(fs.readdirSync).mockReturnValue(['SPEC-001.md'] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ label: 'SPEC-001' } as unknown as string);
    mockListRequirements.mockReturnValue([]);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

    await linkToSpecCommand('/tmp/test');

    expect(mockSaveTraceability).not.toHaveBeenCalled();
  });
});
