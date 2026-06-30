import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ───────────────────────────────────────────────────────────

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    activeTextEditor: undefined,
    // tabGroups intentionally absent — exercises the optional-chaining guard in
    // activeMarkdownPreviewLabel (no preview → previewAgreesWith returns true).
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/ws' } }],
    getConfiguration: () => ({ get: () => undefined }),
  },
  commands: { executeCommand: vi.fn() },
}));

// Each resolveNode lookup hits one list* per kind; mock them so the routing
// logic is exercised without touching the filesystem (mirrors listEpics).
vi.mock('../src/lib/epic-manager', () => ({
  listEpics: vi.fn(() => []),
}));
vi.mock('../src/views/spec-tree-provider', () => ({
  listSpecs: vi.fn(() => []),
}));
vi.mock('../src/lib/adr-manager', () => ({
  listAdrs: vi.fn(() => []),
}));
vi.mock('../src/lib/approval', () => ({
  getApprovalStatus: vi.fn(() => 'unapproved'),
}));

// ─── Imports ───────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import {
  approveActiveCommand,
  classifyApprovablePath,
  classifyNode,
  APPROVE_COMMAND,
} from '../src/commands/approve-active';
import { listEpics } from '../src/lib/epic-manager';
import type { EpicSummary } from '../src/lib/epic-manager';
import { listSpecs } from '../src/views/spec-tree-provider';
import { listAdrs } from '../src/lib/adr-manager';
import { getApprovalStatus } from '../src/lib/approval';
import { recordApprovableView, resetRecentApprovables } from '../src/lib/recent-approvables';

// ─── Helpers ───────────────────────────────────────────────────────────────

const executeCommand = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
const showQuickPick = vscode.window.showQuickPick as ReturnType<typeof vi.fn>;
const listEpicsMock = listEpics as ReturnType<typeof vi.fn>;
const listSpecsMock = listSpecs as ReturnType<typeof vi.fn>;
const listAdrsMock = listAdrs as ReturnType<typeof vi.fn>;
const getApprovalStatusMock = getApprovalStatus as ReturnType<typeof vi.fn>;

/** Point the active editor at a file path (or clear it). */
function setActiveFile(fsPath: string | undefined): void {
  (vscode.window as { activeTextEditor: unknown }).activeTextEditor =
    fsPath === undefined ? undefined : { document: { uri: { fsPath } } };
}

function epic(id: string, filePath: string): EpicSummary {
  return {
    id,
    slug: id.toLowerCase(),
    title: id,
    status: 'proposed',
    order: 1,
    filePath,
  } as EpicSummary;
}

function spec(id: string, filePath: string): { id: string; title: string; status: string; filePath: string } {
  return { id, title: id, status: 'specifying', filePath };
}

function adr(id: string, filePath: string, status = 'proposed'): { id: string; title: string; status: string; filePath: string } {
  return { id, title: id, status, filePath };
}

beforeEach(() => {
  vi.clearAllMocks();
  setActiveFile(undefined);
  listEpicsMock.mockReturnValue([]);
  listSpecsMock.mockReturnValue([]);
  listAdrsMock.mockReturnValue([]);
  getApprovalStatusMock.mockReturnValue('unapproved');
  showQuickPick.mockResolvedValue(undefined);
  resetRecentApprovables();
});

// ─── classifyApprovablePath (pure) ───────────────────────────────────────────

describe('classifyApprovablePath', () => {
  it('classifies decision files (DR-NNN.md) as adr', () => {
    expect(classifyApprovablePath('/ws/docs/decisions/DR-007.md')).toBe('adr');
    expect(classifyApprovablePath('/ws/docs/decisions/DR-042-some-title.md')).toBe('adr');
  });

  it('classifies epic files (EPIC-NNN.md) as epic', () => {
    expect(classifyApprovablePath('/ws/docs/epics/EPIC-001.md')).toBe('epic');
    expect(classifyApprovablePath('/ws/docs/epics/EPIC-012-user-auth.md')).toBe('epic');
  });

  it('classifies canonical spec files (requirements.md / spec.md) as spec', () => {
    expect(classifyApprovablePath('/ws/specs/minspec/SPEC-001/requirements.md')).toBe('spec');
    expect(classifyApprovablePath('/ws/specs/minspec/SPEC-001/spec.md')).toBe('spec');
  });

  it('returns undefined for non-approvable paths', () => {
    expect(classifyApprovablePath('/ws/README.md')).toBeUndefined();
    expect(classifyApprovablePath('/ws/specs/minspec/SPEC-001/plan.md')).toBeUndefined();
    expect(classifyApprovablePath('/ws/src/extension.ts')).toBeUndefined();
    expect(classifyApprovablePath(undefined)).toBeUndefined();
  });
});

// ─── classifyNode ────────────────────────────────────────────────────────────

describe('classifyNode', () => {
  it('classifies a node by the artifact it carries', () => {
    expect(classifyNode({ spec: { id: 'SPEC-1' } })).toBe('spec');
    expect(classifyNode({ adr: { id: 'DR-1' } })).toBe('adr');
    expect(classifyNode({ epic: { id: 'EPIC-1' } })).toBe('epic');
  });

  it('returns undefined for non-artifact values', () => {
    expect(classifyNode(undefined)).toBeUndefined();
    expect(classifyNode({})).toBeUndefined();
    expect(classifyNode('string')).toBeUndefined();
    expect(classifyNode({ other: 1 })).toBeUndefined();
  });
});

// ─── approveActiveCommand — routing by active editor ──────────────────────────

describe('approveActiveCommand — editor routing', () => {
  it('dispatches a focused, resolvable spec DIRECTLY as a node (#363 symmetry)', async () => {
    const filePath = '/tmp/ws/specs/minspec/SPEC-001/requirements.md';
    const s = spec('SPEC-001', filePath);
    listSpecsMock.mockReturnValue([s]);
    setActiveFile(filePath);
    await approveActiveCommand();
    // No QuickPick fall-through — the resolved node goes straight to approveSpec.
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec, { spec: s });
  });

  it('dispatches a focused, resolvable decision DIRECTLY as a node', async () => {
    const filePath = '/tmp/ws/docs/decisions/DR-007.md';
    const a = adr('DR-007', filePath);
    listAdrsMock.mockReturnValue([a]);
    setActiveFile(filePath);
    await approveActiveCommand();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.adr, { adr: a });
  });

  it('forwards undefined for an unresolvable focused spec (command re-resolves)', async () => {
    listSpecsMock.mockReturnValue([]); // no match
    setActiveFile('/tmp/ws/specs/minspec/SPEC-001/requirements.md');
    await approveActiveCommand();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec, undefined);
  });

  it('routes an open epic file to acceptEpic with the resolved epic node', async () => {
    const filePath = '/tmp/ws/docs/epics/EPIC-001.md';
    listEpicsMock.mockReturnValue([epic('EPIC-001', filePath)]);
    setActiveFile(filePath);
    await approveActiveCommand();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(
      APPROVE_COMMAND.epic,
      { epic: epic('EPIC-001', filePath) },
    );
  });

  it('errors (no dispatch) when an open epic file matches no known epic', async () => {
    listEpicsMock.mockReturnValue([]); // no match
    setActiveFile('/tmp/ws/docs/epics/EPIC-999.md');
    await approveActiveCommand();
    expect(executeCommand).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledOnce();
  });
});

// ─── approveActiveCommand — routing by explorer tree node ─────────────────────

describe('approveActiveCommand — tree-node routing', () => {
  it('routes a spec node to approveSpec, forwarding the node', async () => {
    const node = { spec: { id: 'SPEC-002' } };
    await approveActiveCommand(node);
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec, node);
  });

  it('routes a decision node to acceptAdr, forwarding the node', async () => {
    const node = { adr: { id: 'DR-009', filePath: '/x', status: 'proposed' } };
    await approveActiveCommand(node);
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.adr, node);
  });

  it('routes an epic node to acceptEpic, forwarding the node (no editor lookup)', async () => {
    const node = { epic: epic('EPIC-003', '/x/EPIC-003.md') };
    await approveActiveCommand(node);
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.epic, node);
    expect(listEpicsMock).not.toHaveBeenCalled();
  });

  it('prefers the node over the active editor when both are present', async () => {
    setActiveFile('/tmp/ws/docs/decisions/DR-007.md'); // would route adr
    const node = { spec: { id: 'SPEC-005' } };
    await approveActiveCommand(node);
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec, node);
  });
});

// ─── approveActiveCommand — most-recently-viewed (preview) picker ─────────────

describe('approveActiveCommand — recent-approvables (preview) routing', () => {
  it('auto-approves the lone pending recent without a picker (no preview disagreement)', async () => {
    const filePath = '/tmp/ws/specs/minspec/SPEC-009/requirements.md';
    const s = spec('SPEC-009', filePath);
    listSpecsMock.mockReturnValue([s]);
    recordApprovableView(filePath); // user viewed it an instant before previewing
    setActiveFile('/tmp/ws/README.md'); // focus is now non-approvable (≈ a preview)
    await approveActiveCommand();
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec, { spec: s });
  });

  it('shows a reverse-chronological picker across kinds when multiple recents pend', async () => {
    const specPath = '/tmp/ws/specs/minspec/SPEC-010/requirements.md';
    const drPath = '/tmp/ws/docs/decisions/DR-010.md';
    const s = spec('SPEC-010', specPath);
    const a = adr('DR-010', drPath);
    listSpecsMock.mockReturnValue([s]);
    listAdrsMock.mockReturnValue([a]);
    recordApprovableView(specPath); // older
    recordApprovableView(drPath); // newer → front
    setActiveFile(undefined);
    showQuickPick.mockResolvedValue({ label: 'DR-010', description: 'decision · DR-010', recent: { kind: 'adr', node: { adr: a } } });

    await approveActiveCommand();

    const items = showQuickPick.mock.calls[0][0] as Array<{ label: string }>;
    expect(items.map((i) => i.label)).toEqual(['DR-010', 'SPEC-010']); // newest first
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.adr, { adr: a });
  });

  it('does nothing (no fallback) when the recents picker is dismissed', async () => {
    const drPath1 = '/tmp/ws/docs/decisions/DR-011.md';
    const drPath2 = '/tmp/ws/docs/decisions/DR-012.md';
    listAdrsMock.mockReturnValue([adr('DR-011', drPath1), adr('DR-012', drPath2)]);
    recordApprovableView(drPath1);
    recordApprovableView(drPath2);
    setActiveFile(undefined);
    showQuickPick.mockResolvedValue(undefined); // user pressed Esc

    await approveActiveCommand();
    expect(executeCommand).not.toHaveBeenCalled(); // deliberate no-op, not the spec fallback
  });

  it('excludes already-approved recents from the picker (isPending filter)', async () => {
    const specPath = '/tmp/ws/specs/minspec/SPEC-013/requirements.md';
    listSpecsMock.mockReturnValue([spec('SPEC-013', specPath)]);
    getApprovalStatusMock.mockReturnValue('approved'); // no longer pending
    recordApprovableView(specPath);
    setActiveFile(undefined);

    await approveActiveCommand();
    // The only recent is filtered out → nothing to offer → spec fallback (#303).
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec);
  });
});

// ─── approveActiveCommand — QuickPick fallback ────────────────────────────────

describe('approveActiveCommand — fallback', () => {
  it('falls back to approveSpec (its pending picker) when nothing approvable is in focus', async () => {
    setActiveFile('/tmp/ws/README.md'); // not approvable, no recents
    await approveActiveCommand();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec);
  });

  it('falls back when no editor and no node', async () => {
    setActiveFile(undefined);
    await approveActiveCommand(undefined);
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec);
  });
});
