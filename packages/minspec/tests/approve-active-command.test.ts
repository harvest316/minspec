import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ───────────────────────────────────────────────────────────

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    activeTextEditor: undefined,
    tabGroups: { activeTabGroup: { activeTab: undefined } },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/ws' } }],
    getConfiguration: () => ({ get: () => undefined }),
  },
  commands: { executeCommand: vi.fn() },
}));

// The list functions are the source of truth for "does this path map to a known
// artifact?" — mock them so routing is exercised without touching the filesystem.
vi.mock('../src/lib/epic-manager', () => ({ listEpics: vi.fn(() => []) }));
vi.mock('../src/lib/adr-manager', () => ({ listAdrs: vi.fn(() => []) }));
vi.mock('../src/views/spec-tree-provider', () => ({ listSpecs: vi.fn(() => []) }));
vi.mock('../src/lib/recent-approvables', () => ({ recentApprovables: vi.fn(() => []) }));
// Approval status drives the spec pending-filter; default everything to unapproved.
vi.mock('../src/lib/approval', () => ({ getApprovalStatus: vi.fn(() => 'unapproved') }));

// ─── Imports ───────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import {
  approveActiveCommand,
  classifyApprovablePath,
  classifyNode,
  APPROVE_COMMAND,
} from '../src/commands/approve-active';
import { listEpics, type EpicSummary } from '../src/lib/epic-manager';
import { listAdrs, type AdrSummary } from '../src/lib/adr-manager';
import { listSpecs } from '../src/views/spec-tree-provider';
import type { SpecSummary } from '../src/views/spec-tree-provider';
import { recentApprovables } from '../src/lib/recent-approvables';
import { getApprovalStatus } from '../src/lib/approval';

// ─── Helpers ───────────────────────────────────────────────────────────────

const executeCommand = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
const showQuickPick = vscode.window.showQuickPick as ReturnType<typeof vi.fn>;
const listEpicsMock = listEpics as ReturnType<typeof vi.fn>;
const listAdrsMock = listAdrs as ReturnType<typeof vi.fn>;
const listSpecsMock = listSpecs as ReturnType<typeof vi.fn>;
const recentApprovablesMock = recentApprovables as ReturnType<typeof vi.fn>;
const getApprovalStatusMock = getApprovalStatus as ReturnType<typeof vi.fn>;

/** Point the active editor at a file path (or clear it). */
function setActiveFile(fsPath: string | undefined): void {
  (vscode.window as { activeTextEditor: unknown }).activeTextEditor =
    fsPath === undefined ? undefined : { document: { uri: { fsPath } } };
}

/** Set (or clear) the active markdown-preview tab the picker guard inspects. */
function setPreviewTab(label: string | undefined): void {
  (vscode.window as { tabGroups: { activeTabGroup: { activeTab: unknown } } }).tabGroups.activeTabGroup.activeTab =
    label === undefined ? undefined : { label, input: { viewType: 'mainThreadWebview-markdown.preview' } };
}

function epic(id: string, filePath: string): EpicSummary {
  return { id, slug: id.toLowerCase(), title: id, status: 'proposed', order: 1, filePath } as EpicSummary;
}
function adr(id: string, filePath: string): AdrSummary {
  return { id, title: id, status: 'proposed', date: '', filePath } as AdrSummary;
}
function spec(id: string, filePath: string): SpecSummary {
  return { id, title: id, tier: 'T2', status: 'specifying', filePath } as SpecSummary;
}

beforeEach(() => {
  vi.clearAllMocks();
  setActiveFile(undefined);
  listEpicsMock.mockReturnValue([]);
  listAdrsMock.mockReturnValue([]);
  listSpecsMock.mockReturnValue([]);
  recentApprovablesMock.mockReturnValue([]);
  getApprovalStatusMock.mockReturnValue('unapproved');
  setPreviewTab(undefined);
});

// ─── classifyApprovablePath (pure, re-exported from lib/approvable) ────────────

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

// ─── editor routing — focused approvable approved DIRECTLY (all 3 kinds) ───────

describe('approveActiveCommand — editor routing (direct, resolved node)', () => {
  it('routes an open spec file to approveSpec with the resolved spec node', async () => {
    const filePath = '/tmp/ws/specs/minspec/SPEC-001/requirements.md';
    listSpecsMock.mockReturnValue([spec('SPEC-001', filePath)]);
    setActiveFile(filePath);
    await approveActiveCommand();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec, {
      spec: spec('SPEC-001', filePath),
    });
  });

  it('routes an open decision file to acceptAdr with the resolved adr node', async () => {
    const filePath = '/tmp/ws/docs/decisions/DR-007.md';
    listAdrsMock.mockReturnValue([adr('DR-007', filePath)]);
    setActiveFile(filePath);
    await approveActiveCommand();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.adr, {
      adr: adr('DR-007', filePath),
    });
  });

  it('routes an open epic file to acceptEpic with the resolved epic node', async () => {
    const filePath = '/tmp/ws/docs/epics/EPIC-001.md';
    listEpicsMock.mockReturnValue([epic('EPIC-001', filePath)]);
    setActiveFile(filePath);
    await approveActiveCommand();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.epic, {
      epic: epic('EPIC-001', filePath),
    });
  });

  it('errors (no dispatch) when an open approvable file matches no known artifact', async () => {
    listEpicsMock.mockReturnValue([]); // no match
    setActiveFile('/tmp/ws/docs/epics/EPIC-999.md');
    await approveActiveCommand();
    expect(executeCommand).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledOnce();
  });
});

// ─── tree-node routing — forward the node as-is ───────────────────────────────

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

// ─── preview / non-approvable focus — most-recently-viewed picker (#NNN) ───────

describe('approveActiveCommand — most-recently-viewed picker', () => {
  it('offers multiple recently-viewed approvables and dispatches the chosen one', async () => {
    const drPath = '/tmp/ws/docs/decisions/DR-046.md';
    const specPath = '/tmp/ws/specs/minspec/SPEC-019/requirements.md';
    // Most-recent first: a DR previewed last, a spec before it.
    recentApprovablesMock.mockReturnValue([
      { fsPath: drPath, kind: 'adr' },
      { fsPath: specPath, kind: 'spec' },
    ]);
    listAdrsMock.mockReturnValue([adr('DR-046', drPath)]);
    listSpecsMock.mockReturnValue([spec('SPEC-019', specPath)]);
    setActiveFile(undefined); // markdown preview: no text editor

    // The picker hands back the first (most-recent) item.
    showQuickPick.mockImplementation(async (items: { target: unknown }[]) => items[0]);

    await approveActiveCommand();

    expect(showQuickPick).toHaveBeenCalledOnce();
    const offered = showQuickPick.mock.calls[0][0] as { label: string }[];
    expect(offered.map((i) => i.label)).toEqual(['DR-046: DR-046', 'SPEC-019: SPEC-019']);
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.adr, {
      adr: adr('DR-046', drPath),
    });
  });

  it('auto-approves the lone pending recent without showing a picker', async () => {
    const drPath = '/tmp/ws/docs/decisions/DR-046.md';
    recentApprovablesMock.mockReturnValue([{ fsPath: drPath, kind: 'adr' }]);
    listAdrsMock.mockReturnValue([adr('DR-046', drPath)]);
    setActiveFile(undefined);
    await approveActiveCommand();
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.adr, {
      adr: adr('DR-046', drPath),
    });
  });

  it('does NOT auto-approve a lone recent when a preview shows a different file', async () => {
    const drPath = '/tmp/ws/docs/decisions/DR-046.md';
    recentApprovablesMock.mockReturnValue([{ fsPath: drPath, kind: 'adr' }]);
    listAdrsMock.mockReturnValue([adr('DR-046', drPath)]);
    setActiveFile(undefined);
    setPreviewTab('Preview README.md'); // on screen ≠ the lone recent
    showQuickPick.mockResolvedValue(undefined); // user dismisses
    await approveActiveCommand();
    expect(showQuickPick).toHaveBeenCalledOnce(); // picker shown, not auto-approved
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('excludes already-approved specs and already-accepted decisions from the list', async () => {
    const specPath = '/tmp/ws/specs/minspec/SPEC-019/requirements.md';
    const drPath = '/tmp/ws/docs/decisions/DR-046.md';
    recentApprovablesMock.mockReturnValue([
      { fsPath: specPath, kind: 'spec' },
      { fsPath: drPath, kind: 'adr' },
    ]);
    listSpecsMock.mockReturnValue([spec('SPEC-019', specPath)]);
    listAdrsMock.mockReturnValue([{ ...adr('DR-046', drPath), status: 'accepted' }]);
    getApprovalStatusMock.mockReturnValue('approved'); // spec already approved
    setActiveFile(undefined);
    await approveActiveCommand();
    // Both filtered out → nothing pending → #303 spec backstop, no MRU picker.
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec);
  });

  it('drops recents that no longer resolve to a known artifact', async () => {
    recentApprovablesMock.mockReturnValue([
      { fsPath: '/tmp/ws/docs/decisions/DR-404.md', kind: 'adr' }, // deleted since viewed
    ]);
    listAdrsMock.mockReturnValue([]); // no match → dropped → empty → fallback
    setActiveFile(undefined);
    await approveActiveCommand();
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec);
  });

  it('dispatches nothing when the user dismisses the picker', async () => {
    const drPath = '/tmp/ws/docs/decisions/DR-046.md';
    const specPath = '/tmp/ws/specs/minspec/SPEC-019/requirements.md';
    recentApprovablesMock.mockReturnValue([
      { fsPath: drPath, kind: 'adr' },
      { fsPath: specPath, kind: 'spec' },
    ]);
    listAdrsMock.mockReturnValue([adr('DR-046', drPath)]);
    listSpecsMock.mockReturnValue([spec('SPEC-019', specPath)]);
    setActiveFile(undefined);
    showQuickPick.mockResolvedValue(undefined); // dismissed
    await approveActiveCommand();
    expect(executeCommand).not.toHaveBeenCalled();
  });
});

// ─── fallback — no view history → the spec pending picker (#303) ───────────────

describe('approveActiveCommand — fallback', () => {
  it('falls back to approveSpec when focus is non-approvable and no recents', async () => {
    setActiveFile('/tmp/ws/README.md'); // not approvable
    await approveActiveCommand();
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec);
  });

  it('falls back when no editor, no node, and no recents', async () => {
    setActiveFile(undefined);
    await approveActiveCommand(undefined);
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec);
  });
});
