import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module before any imports that use it
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
    constructor(id: string) {
      this.id = id;
    }
  },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
}));

import type { SpecSummary } from '../src/views/spec-tree-provider';
import { SpecTreeProvider, SpecGroupNode, SpecNode, listSpecs } from '../src/views/spec-tree-provider';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Test fixtures ---

function makeSpec(overrides: Partial<SpecSummary> = {}): SpecSummary {
  return {
    id: 'SPEC-001',
    title: 'Rate limiting',
    tier: 'T2',
    status: 'new',
    currentPhase: 'specify',
    filePath: '/tmp/specs/SPEC-001.md',
    ...overrides,
  };
}

const ACTIVE_SPECS: SpecSummary[] = [
  makeSpec({ id: 'SPEC-001', title: 'Rate limiting', status: 'new', tier: 'T1', currentPhase: 'specify' }),
  makeSpec({ id: 'SPEC-002', title: 'Auth flow', status: 'specifying', tier: 'T3', currentPhase: 'clarify' }),
  makeSpec({ id: 'SPEC-003', title: 'Dashboard', status: 'implementing', tier: 'T4', currentPhase: 'implement' }),
];

const DONE_SPECS: SpecSummary[] = [
  makeSpec({ id: 'SPEC-010', title: 'Login page', status: 'done', tier: 'T2', currentPhase: null }),
];

const ARCHIVED_SPECS: SpecSummary[] = [
  makeSpec({ id: 'SPEC-020', title: 'Old feature', status: 'archived', tier: 'T1', currentPhase: null }),
];

const ALL_SPECS = [...ACTIVE_SPECS, ...DONE_SPECS, ...ARCHIVED_SPECS];

// --- listSpecs tests (filesystem) ---

describe('listSpecs()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-tree-test-'));
  });

  function writeSpecFile(dir: string, filename: string, content: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
  }

  function writeMinspecConfig(rootDir: string, specsDir = 'specs'): void {
    const configDir = path.join(rootDir, '.minspec');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ version: '1', specsDir }),
    );
  }

  it('returns empty array when specs dir does not exist', () => {
    const result = listSpecs(tmpDir);
    expect(result).toEqual([]);
  });

  it('returns parsed specs from the specs directory', () => {
    writeMinspecConfig(tmpDir);
    const specsDir = path.join(tmpDir, 'specs');
    writeSpecFile(specsDir, 'SPEC-001.md', `---
id: SPEC-001
title: Rate limiting
tier: T1
status: new
created: 2026-05-26
phases:
  specify: pending
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---

## Specify

Add rate limiting.
`);

    const result = listSpecs(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('SPEC-001');
    expect(result[0].title).toBe('Rate limiting');
    expect(result[0].tier).toBe('T1');
    expect(result[0].status).toBe('new');
    expect(result[0].currentPhase).toBe('specify');
    expect(result[0].filePath).toBe(path.join(specsDir, 'SPEC-001.md'));
  });

  it('skips files without an id', () => {
    writeMinspecConfig(tmpDir);
    const specsDir = path.join(tmpDir, 'specs');
    writeSpecFile(specsDir, 'random.md', '# Just a readme\n\nNo frontmatter spec.');

    const result = listSpecs(tmpDir);
    expect(result).toHaveLength(0);
  });

  it('skips non-markdown files', () => {
    writeMinspecConfig(tmpDir);
    const specsDir = path.join(tmpDir, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'notes.txt'), 'not a spec');
    writeSpecFile(specsDir, 'SPEC-001.md', `---
id: SPEC-001
title: Real spec
tier: T2
status: new
created: 2026-05-26
phases:
  specify: pending
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---
`);

    const result = listSpecs(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('SPEC-001');
  });

  it('sorts specs by id', () => {
    writeMinspecConfig(tmpDir);
    const specsDir = path.join(tmpDir, 'specs');
    writeSpecFile(specsDir, 'SPEC-003.md', `---
id: SPEC-003
title: Third
tier: T1
status: new
created: 2026-05-26
phases:
  specify: pending
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---
`);
    writeSpecFile(specsDir, 'SPEC-001.md', `---
id: SPEC-001
title: First
tier: T1
status: new
created: 2026-05-26
phases:
  specify: pending
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---
`);

    const result = listSpecs(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('SPEC-001');
    expect(result[1].id).toBe('SPEC-003');
  });

  it('derives current phase correctly for in-progress spec', () => {
    writeMinspecConfig(tmpDir);
    const specsDir = path.join(tmpDir, 'specs');
    writeSpecFile(specsDir, 'SPEC-001.md', `---
id: SPEC-001
title: In progress
tier: T2
status: implementing
created: 2026-05-26
phases:
  specify: done
  clarify: skipped
  plan: done
  tasks: done
  implement: in-progress
---
`);

    const result = listSpecs(tmpDir);
    expect(result[0].currentPhase).toBe('implement');
  });

  it('returns null currentPhase when all phases done', () => {
    writeMinspecConfig(tmpDir);
    const specsDir = path.join(tmpDir, 'specs');
    writeSpecFile(specsDir, 'SPEC-001.md', `---
id: SPEC-001
title: Complete
tier: T2
status: done
created: 2026-05-26
phases:
  specify: done
  clarify: done
  plan: done
  tasks: done
  implement: done
---
`);

    const result = listSpecs(tmpDir);
    expect(result[0].currentPhase).toBeNull();
  });
});

// --- SpecTreeProvider tests (injected mock listSpecs) ---

describe('SpecTreeProvider', () => {
  let provider: SpecTreeProvider;
  let mockListSpecs: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockListSpecs = vi.fn().mockReturnValue(ALL_SPECS);
    provider = new SpecTreeProvider('/fake/workspace', mockListSpecs);
  });

  describe('getChildren(undefined) — root level', () => {
    it('returns 3 group nodes', () => {
      const groups = provider.getChildren(undefined);
      expect(groups).toHaveLength(3);
    });

    it('returns groups in order: Active, Done, Archived', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      expect(groups[0].label).toBe('Active');
      expect(groups[1].label).toBe('Done');
      expect(groups[2].label).toBe('Archived');
    });

    it('Active group is expanded by default', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      // Expanded = 2
      expect(groups[0].collapsibleState).toBe(2);
    });

    it('Done and Archived groups are collapsed by default', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      // Collapsed = 1
      expect(groups[1].collapsibleState).toBe(1);
      expect(groups[2].collapsibleState).toBe(1);
    });

    it('shows spec count in group description', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      expect(groups[0].description).toBe('(3)'); // 3 active specs
      expect(groups[1].description).toBe('(1)'); // 1 done spec
      expect(groups[2].description).toBe('(1)'); // 1 archived spec
    });

    it('shows (0) when group is empty', () => {
      mockListSpecs.mockReturnValue([]);
      provider = new SpecTreeProvider('/fake/workspace', mockListSpecs);

      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      expect(groups[0].description).toBe('(0)');
      expect(groups[1].description).toBe('(0)');
      expect(groups[2].description).toBe('(0)');
    });
  });

  describe('getChildren(groupNode) — spec list', () => {
    it('returns specs belonging to the Active group', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      const activeGroup = groups[0];
      const specs = provider.getChildren(activeGroup) as SpecNode[];

      expect(specs).toHaveLength(3);
      expect(specs[0].label).toBe('SPEC-001: Rate limiting');
      expect(specs[1].label).toBe('SPEC-002: Auth flow');
      expect(specs[2].label).toBe('SPEC-003: Dashboard');
    });

    it('returns specs belonging to the Done group', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      const doneGroup = groups[1];
      const specs = provider.getChildren(doneGroup) as SpecNode[];

      expect(specs).toHaveLength(1);
      expect(specs[0].label).toBe('SPEC-010: Login page');
    });

    it('returns specs belonging to the Archived group', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      const archivedGroup = groups[2];
      const specs = provider.getChildren(archivedGroup) as SpecNode[];

      expect(specs).toHaveLength(1);
      expect(specs[0].label).toBe('SPEC-020: Old feature');
    });

    it('returns empty array for group with no specs', () => {
      mockListSpecs.mockReturnValue([]);
      provider = new SpecTreeProvider('/fake/workspace', mockListSpecs);

      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      const specs = provider.getChildren(groups[0]) as SpecNode[];
      expect(specs).toHaveLength(0);
    });
  });

  describe('SpecNode details', () => {
    it('has correct label format (ID: title)', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      const specs = provider.getChildren(groups[0]) as SpecNode[];
      expect(specs[0].label).toBe('SPEC-001: Rate limiting');
    });

    it('has correct description (tier + phase)', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      const specs = provider.getChildren(groups[0]) as SpecNode[];
      expect(specs[0].description).toBe('T1 \u00b7 specify');
      expect(specs[1].description).toBe('T3 \u00b7 clarify');
      expect(specs[2].description).toBe('T4 \u00b7 implement');
    });

    it('shows "complete" when no current phase', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      const doneSpecs = provider.getChildren(groups[1]) as SpecNode[];
      expect(doneSpecs[0].description).toBe('T2 \u00b7 complete');
    });

    it('has ThemeIcon based on status', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      const specs = provider.getChildren(groups[0]) as SpecNode[];

      // new -> circle-outline
      expect((specs[0].iconPath as { id: string }).id).toBe('circle-outline');
      // specifying -> sync
      expect((specs[1].iconPath as { id: string }).id).toBe('sync');
      // implementing -> sync
      expect((specs[2].iconPath as { id: string }).id).toBe('sync');

      // done -> check
      const doneSpecs = provider.getChildren(groups[1]) as SpecNode[];
      expect((doneSpecs[0].iconPath as { id: string }).id).toBe('check');

      // archived -> archive
      const archivedSpecs = provider.getChildren(groups[2]) as SpecNode[];
      expect((archivedSpecs[0].iconPath as { id: string }).id).toBe('archive');
    });

    it('has vscode.open command on click', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      const specs = provider.getChildren(groups[0]) as SpecNode[];
      expect(specs[0].command).toBeDefined();
      expect(specs[0].command!.command).toBe('vscode.open');
    });

    it('has contextValue of specNode', () => {
      const groups = provider.getChildren(undefined) as SpecGroupNode[];
      const specs = provider.getChildren(groups[0]) as SpecNode[];
      expect(specs[0].contextValue).toBe('specNode');
    });
  });

  describe('getChildren(specNode) — leaf level', () => {
    it('returns empty array for spec nodes (they are leaves)', () => {
      const node = new SpecNode(ACTIVE_SPECS[0]);
      const children = provider.getChildren(node);
      expect(children).toHaveLength(0);
    });
  });

  describe('getTreeItem()', () => {
    it('returns the element itself', () => {
      const node = new SpecNode(ACTIVE_SPECS[0]);
      expect(provider.getTreeItem(node)).toBe(node);
    });
  });

  describe('refresh()', () => {
    it('does not throw', () => {
      expect(() => provider.refresh()).not.toThrow();
    });
  });

  describe('empty workspace', () => {
    it('returns empty array when workspaceRoot is empty', () => {
      const emptyProvider = new SpecTreeProvider('', mockListSpecs);
      const groups = emptyProvider.getChildren(undefined);
      expect(groups).toHaveLength(0);
    });
  });
});
