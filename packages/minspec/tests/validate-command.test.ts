import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ──────────────────────────────────────────────────────────────

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/ws' } }],
  },
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
  },
}));

// ─── Mock lib deps ────────────────────────────────────────────────────────────

vi.mock('../src/views/spec-tree-provider', () => ({
  listSpecs: vi.fn(),
}));

vi.mock('../src/lib/spec', () => ({
  readSpecFile: vi.fn(),
}));

vi.mock('../src/lib/config', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../src/lib/spec-validator', () => ({
  validateSpec: vi.fn(),
}));

vi.mock('../src/lib/epic-manager', () => ({
  epicRefSet: vi.fn(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { validateSpecCommand } from '../src/commands/validate';
import { listSpecs } from '../src/views/spec-tree-provider';
import { readSpecFile } from '../src/lib/spec';
import { loadConfig } from '../src/lib/config';
import { validateSpec } from '../src/lib/spec-validator';
import { epicRefSet } from '../src/lib/epic-manager';
import type { SpecSummary } from '../src/views/spec-tree-provider';
import type { ValidationResult, ValidationViolation } from '../src/lib/spec-validator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSpec(id: string, title = 'Some Title'): SpecSummary {
  return {
    id,
    title,
    tier: 'T2',
    status: 'specifying',
    currentPhase: 'specify',
    filePath: `/tmp/ws/specs/minspec/${id}/spec.md`,
    phasesDone: 0,
    phasesTotal: 2,
  } as unknown as SpecSummary;
}

function makeResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    specId: 'SPEC-001',
    tier: 'T2',
    complete: true,
    violations: [],
    detectedAspects: [],
    declaredAspects: [],
    effectiveAspects: [],
    ...overrides,
  } as unknown as ValidationResult;
}

function makeViolation(
  severity: 'error' | 'warning',
  message: string,
  fixHint: string,
): ValidationViolation {
  return {
    rule: `test.${severity}`,
    severity,
    message,
    fixHint,
  } as unknown as ValidationViolation;
}

// =============================================================================

describe('validateSpecCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sensible defaults — override per-test as needed.
    vi.mocked(loadConfig).mockReturnValue({} as ReturnType<typeof loadConfig>);
    vi.mocked(epicRefSet).mockReturnValue(new Set<string>());
    vi.mocked(readSpecFile).mockReturnValue({} as ReturnType<typeof readSpecFile>);
    vi.mocked(validateSpec).mockReturnValue(makeResult());
  });

  // ── (1) No workspace folder ─────────────────────────────────────────────────

  it('shows error and returns early when there is no workspace folder', async () => {
    // Temporarily override workspaceFolders to undefined.
    const ws = vscode.workspace as { workspaceFolders: unknown };
    const saved = ws.workspaceFolders;
    ws.workspaceFolders = undefined;

    await validateSpecCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: No workspace folder open.',
    );
    expect(listSpecs).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();

    ws.workspaceFolders = saved;
  });

  // ── (2) node.spec provided → skips quick-pick ───────────────────────────────

  it('skips quick-pick when a tree-node spec is provided', async () => {
    const spec = makeSpec('SPEC-001');
    vi.mocked(validateSpec).mockReturnValue(makeResult({ specId: 'SPEC-001', complete: true, violations: [] }));

    await validateSpecCommand({ spec });

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(listSpecs).not.toHaveBeenCalled();
    expect(readSpecFile).toHaveBeenCalledWith(spec.filePath);
  });

  // ── (3) No node, listSpecs returns [] → "No specs found" ───────────────────

  it('shows "No specs found" when listSpecs returns an empty array', async () => {
    vi.mocked(listSpecs).mockReturnValue([]);

    await validateSpecCommand();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: No specs found.',
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  // ── (4) Quick-pick cancelled → no-op ───────────────────────────────────────

  it('returns without reading the spec when quick-pick is cancelled', async () => {
    vi.mocked(listSpecs).mockReturnValue([makeSpec('SPEC-001'), makeSpec('SPEC-002')]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

    await validateSpecCommand();

    expect(readSpecFile).not.toHaveBeenCalled();
    expect(validateSpec).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  // ── (5) Quick-pick selection used ──────────────────────────────────────────

  it('uses the spec from the quick-pick selection', async () => {
    const specs = [makeSpec('SPEC-001', 'Alpha'), makeSpec('SPEC-002', 'Beta')];
    vi.mocked(listSpecs).mockReturnValue(specs);
    // Return the second item as selected.
    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(
      async (items: unknown) => (items as { label: string; spec: SpecSummary }[])[1],
    );
    vi.mocked(validateSpec).mockReturnValue(makeResult({ specId: 'SPEC-002', complete: true, violations: [] }));

    await validateSpecCommand();

    expect(readSpecFile).toHaveBeenCalledWith(specs[1].filePath);
    // The quick-pick items should be properly labelled.
    const calls = vi.mocked(vscode.window.showQuickPick).mock.calls;
    const items = calls[0][0] as { label: string; description: string; spec: SpecSummary }[];
    expect(items).toHaveLength(2);
    expect(items[0].label).toBe('SPEC-001: Alpha');
    expect(items[0].description).toBe('T2');
    expect(items[0].spec).toBe(specs[0]);
    expect(items[1].spec).toBe(specs[1]);
  });

  // ── (6) readSpecFile / validateSpec throws ──────────────────────────────────

  it('shows "Cannot read" error when readSpecFile throws', async () => {
    const spec = makeSpec('SPEC-003');
    vi.mocked(readSpecFile).mockImplementation(() => {
      throw new Error('file not found');
    });

    await validateSpecCommand({ spec });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Cannot read SPEC-003 — file not found',
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('shows "Cannot read" error when validateSpec throws', async () => {
    const spec = makeSpec('SPEC-004');
    vi.mocked(validateSpec).mockImplementation(() => {
      throw new Error('parse failure');
    });

    await validateSpecCommand({ spec });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Cannot read SPEC-004 — parse failure',
    );
  });

  it('handles non-Error throws in the "Cannot read" path', async () => {
    const spec = makeSpec('SPEC-005');
    vi.mocked(readSpecFile).mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'raw string error';
    });

    await validateSpecCommand({ spec });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'MinSpec: Cannot read SPEC-005 — raw string error',
    );
  });

  // ── (7) No violations, effectiveAspects non-empty ──────────────────────────

  it('shows complete message with aspects when violations=[] and aspects are present', async () => {
    const spec = makeSpec('SPEC-006');
    vi.mocked(validateSpec).mockReturnValue(
      makeResult({
        specId: 'SPEC-006',
        complete: true,
        violations: [],
        effectiveAspects: ['ux', 'api'],
      }),
    );

    await validateSpecCommand({ spec });

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: ✓ SPEC-006 is complete (aspects: ux, api).',
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  // ── (8) No violations, no aspects ──────────────────────────────────────────

  it('shows complete message without aspect list when effectiveAspects is empty', async () => {
    const spec = makeSpec('SPEC-007');
    vi.mocked(validateSpec).mockReturnValue(
      makeResult({
        specId: 'SPEC-007',
        complete: true,
        violations: [],
        effectiveAspects: [],
      }),
    );

    await validateSpecCommand({ spec });

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'MinSpec: ✓ SPEC-007 is complete.',
    );
  });

  // ── (9a) Violations present: complete=true, warnings only ──────────────────

  it('shows "complete, N warning(s)" header when complete=true with warnings', async () => {
    const spec = makeSpec('SPEC-008');
    const warnViolation = makeViolation('warning', 'Missing epic ref', 'Add epic: EPIC-001');
    vi.mocked(validateSpec).mockReturnValue(
      makeResult({
        specId: 'SPEC-008',
        complete: true,
        violations: [warnViolation],
        effectiveAspects: [],
      }),
    );

    await validateSpecCommand({ spec });

    const calls = vi.mocked(vscode.window.showInformationMessage).mock.calls;
    expect(calls).toHaveLength(1);
    const [header, options, ] = calls[0] as [string, { modal: boolean; detail: string }];
    expect(header).toBe('SPEC-008: complete, 1 warning(s)');
    expect(options.modal).toBe(true);
    expect(options.detail).toContain('⚠ Missing epic ref');
    expect(options.detail).toContain('Add epic: EPIC-001');
  });

  // ── (9b) Violations present: complete=false, blockers ──────────────────────

  it('shows "incomplete — N blocker(s)" header when complete=false with errors', async () => {
    const spec = makeSpec('SPEC-009');
    const errorViolation = makeViolation('error', 'Section specify is empty', 'Add a Specify section');
    const warnViolation = makeViolation('warning', 'Dangling park ref', 'File the issue');
    vi.mocked(validateSpec).mockReturnValue(
      makeResult({
        specId: 'SPEC-009',
        complete: false,
        violations: [errorViolation, warnViolation],
        effectiveAspects: [],
      }),
    );

    await validateSpecCommand({ spec });

    const calls = vi.mocked(vscode.window.showInformationMessage).mock.calls;
    expect(calls).toHaveLength(1);
    const [header, options] = calls[0] as [string, { modal: boolean; detail: string }];
    expect(header).toBe('SPEC-009: incomplete — 1 blocker(s), 1 warning(s)');
    expect(options.modal).toBe(true);
    // Error line must use ✗ symbol
    expect(options.detail).toContain('✗ Section specify is empty');
    expect(options.detail).toContain('↳ Add a Specify section');
    // Warning line must use ⚠ symbol
    expect(options.detail).toContain('⚠ Dangling park ref');
    expect(options.detail).toContain('↳ File the issue');
  });

  // ── (9c) Multiple violations: fixHint separator check ──────────────────────

  it('separates violation lines with double newline in the modal detail', async () => {
    const spec = makeSpec('SPEC-010');
    const v1 = makeViolation('error', 'Error one', 'Fix one');
    const v2 = makeViolation('warning', 'Warning two', 'Fix two');
    vi.mocked(validateSpec).mockReturnValue(
      makeResult({
        specId: 'SPEC-010',
        complete: false,
        violations: [v1, v2],
        effectiveAspects: [],
      }),
    );

    await validateSpecCommand({ spec });

    const [, options] = vi.mocked(vscode.window.showInformationMessage).mock.calls[0] as [
      string,
      { modal: boolean; detail: string },
    ];
    // Lines are joined with '\n\n'; each block is "✗/⚠ message\n   ↳ fixHint"
    const [block1, block2] = options.detail.split('\n\n');
    expect(block1).toContain('✗ Error one');
    expect(block1).toContain('↳ Fix one');
    expect(block2).toContain('⚠ Warning two');
    expect(block2).toContain('↳ Fix two');
  });

  // ── (9d) Only errors, no warnings ──────────────────────────────────────────

  it('reports 0 warning(s) in header when there are only error violations', async () => {
    const spec = makeSpec('SPEC-011');
    const errorViolation = makeViolation('error', 'Blocking issue', 'Must fix');
    vi.mocked(validateSpec).mockReturnValue(
      makeResult({
        specId: 'SPEC-011',
        complete: false,
        violations: [errorViolation],
        effectiveAspects: [],
      }),
    );

    await validateSpecCommand({ spec });

    const [header] = vi.mocked(vscode.window.showInformationMessage).mock.calls[0] as [string];
    expect(header).toBe('SPEC-011: incomplete — 1 blocker(s), 0 warning(s)');
  });

  // ── Verify lib calls receive correct args ───────────────────────────────────

  it('passes rootDir, config, and epicRefSet to validateSpec', async () => {
    const spec = makeSpec('SPEC-012');
    const fakeConfig = { version: '1' } as ReturnType<typeof loadConfig>;
    const fakeEpics = new Set(['epic-001']);
    const fakeParsed = { frontmatter: { id: 'SPEC-012' } } as ReturnType<typeof readSpecFile>;

    vi.mocked(loadConfig).mockReturnValue(fakeConfig);
    vi.mocked(epicRefSet).mockReturnValue(fakeEpics);
    vi.mocked(readSpecFile).mockReturnValue(fakeParsed);
    vi.mocked(validateSpec).mockReturnValue(makeResult({ complete: true, violations: [] }));

    await validateSpecCommand({ spec });

    expect(loadConfig).toHaveBeenCalledWith('/tmp/ws');
    expect(epicRefSet).toHaveBeenCalledWith('/tmp/ws');
    expect(readSpecFile).toHaveBeenCalledWith(spec.filePath);
    expect(validateSpec).toHaveBeenCalledWith(fakeParsed, fakeConfig, fakeEpics);
  });
});
