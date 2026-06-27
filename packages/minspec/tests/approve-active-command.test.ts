import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ───────────────────────────────────────────────────────────

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/ws' } }],
    getConfiguration: () => ({ get: () => undefined }),
  },
  commands: { executeCommand: vi.fn() },
}));

// listEpics is only needed for the editor→epic matching path; mock it so the
// routing logic is exercised without touching the filesystem.
vi.mock('../src/lib/epic-manager', () => ({
  listEpics: vi.fn(() => []),
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

// ─── Helpers ───────────────────────────────────────────────────────────────

const executeCommand = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
const listEpicsMock = listEpics as ReturnType<typeof vi.fn>;

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

beforeEach(() => {
  vi.clearAllMocks();
  setActiveFile(undefined);
  listEpicsMock.mockReturnValue([]);
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
  it('routes an open spec file to approveSpec', async () => {
    setActiveFile('/tmp/ws/specs/minspec/SPEC-001/requirements.md');
    await approveActiveCommand();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec, undefined);
  });

  it('routes an open decision file to acceptAdr', async () => {
    setActiveFile('/tmp/ws/docs/decisions/DR-007.md');
    await approveActiveCommand();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.adr, undefined);
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

// ─── approveActiveCommand — QuickPick fallback ────────────────────────────────

describe('approveActiveCommand — fallback', () => {
  it('falls back to approveSpec (its pending picker) when nothing approvable is in focus', async () => {
    setActiveFile('/tmp/ws/README.md'); // not approvable
    await approveActiveCommand();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec);
  });

  it('falls back when no editor and no node', async () => {
    setActiveFile(undefined);
    await approveActiveCommand(undefined);
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(APPROVE_COMMAND.spec);
  });
});
