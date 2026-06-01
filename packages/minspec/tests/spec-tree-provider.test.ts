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
import { SpecTreeProvider, SpecGroupNode, SpecNode, RollupNode, listSpecs } from '../src/views/spec-tree-provider';
import { EpicGroupNode } from '../src/views/epic-grouping';
import type { EpicSummary } from '../src/lib/epic-manager';
import { approveSpec } from '../src/lib/approval';
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
    phasesDone: 0,
    phasesTotal: 2,
    ...overrides,
  };
}

// Root children = [RollupNode, ...groups]. Helper to get just the groups (DR-012).
function groupsOf(provider: SpecTreeProvider): SpecGroupNode[] {
  return provider
    .getChildren(undefined)
    .filter((n): n is SpecGroupNode => n instanceof SpecGroupNode);
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

  // T3 regression: specs nested under product/feature subfolders were invisible
  // (listSpecs scanned only specsDir top-level + spec-kit dirs) → empty Specs pane.
  function fmSpec(id: string, title: string, status = 'new'): string {
    return `---\nid: ${id}\ntitle: ${title}\ntier: T2\nstatus: ${status}\ncreated: 2026-05-31\nphases:\n  specify: done\n---\n\n# ${title}\n`;
  }

  it('recurses into product/feature subfolders (nested specs)', () => {
    writeMinspecConfig(tmpDir);
    const specsDir = path.join(tmpDir, 'specs');
    writeSpecFile(path.join(specsDir, 'minspec'), 'requirements.md', fmSpec('SPEC-001', 'Core'));
    writeSpecFile(path.join(specsDir, 'minspec', 'epic-grouping'), 'requirements.md', fmSpec('SPEC-007', 'Epics'));
    writeSpecFile(path.join(specsDir, 'scroogellm'), 'design.md', fmSpec('SPEC-100', 'Proxy'));

    const ids = listSpecs(tmpDir).map(s => s.id).sort();
    expect(ids).toEqual(['SPEC-001', 'SPEC-007', 'SPEC-100']);
  });

  it('collapses multiple files sharing one id, preferring requirements.md', () => {
    writeMinspecConfig(tmpDir);
    const dir = path.join(tmpDir, 'specs', 'minspec', 'classifier-validation');
    writeSpecFile(dir, 'requirements.md', fmSpec('SPEC-004', 'Validation'));
    writeSpecFile(dir, 'design.md', fmSpec('SPEC-004', 'Validation'));
    writeSpecFile(dir, 'tasks.md', fmSpec('SPEC-004', 'Validation'));

    const matches = listSpecs(tmpDir).filter(s => s.id === 'SPEC-004');
    expect(matches).toHaveLength(1);
    expect(path.basename(matches[0].filePath)).toBe('requirements.md');
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
    it('returns a rollup node plus 3 group nodes', () => {
      const root = provider.getChildren(undefined);
      expect(root[0]).toBeInstanceOf(RollupNode);
      expect(groupsOf(provider)).toHaveLength(3);
    });

    it('returns groups in order: Active, Done, Archived', () => {
      const groups = groupsOf(provider);
      expect(groups[0].label).toBe('Active');
      expect(groups[1].label).toBe('Done');
      expect(groups[2].label).toBe('Archived');
    });

    it('Active group is expanded by default', () => {
      const groups = groupsOf(provider);
      // Expanded = 2
      expect(groups[0].collapsibleState).toBe(2);
    });

    it('Done and Archived groups are collapsed by default', () => {
      const groups = groupsOf(provider);
      // Collapsed = 1
      expect(groups[1].collapsibleState).toBe(1);
      expect(groups[2].collapsibleState).toBe(1);
    });

    it('shows spec count in group description', () => {
      const groups = groupsOf(provider);
      expect(groups[0].description).toBe('(3)'); // 3 active specs
      expect(groups[1].description).toBe('(1)'); // 1 done spec
      expect(groups[2].description).toBe('(1)'); // 1 archived spec
    });

    it('shows (0) when group is empty', () => {
      mockListSpecs.mockReturnValue([]);
      provider = new SpecTreeProvider('/fake/workspace', mockListSpecs);

      const groups = groupsOf(provider);
      expect(groups[0].description).toBe('(0)');
      expect(groups[1].description).toBe('(0)');
      expect(groups[2].description).toBe('(0)');
    });
  });

  describe('getChildren(groupNode) — spec list', () => {
    it('returns specs belonging to the Active group', () => {
      const groups = groupsOf(provider);
      const activeGroup = groups[0];
      const specs = provider.getChildren(activeGroup) as SpecNode[];

      expect(specs).toHaveLength(3);
      expect(specs[0].label).toBe('SPEC-001: Rate limiting');
      expect(specs[1].label).toBe('SPEC-002: Auth flow');
      expect(specs[2].label).toBe('SPEC-003: Dashboard');
    });

    it('returns specs belonging to the Done group', () => {
      const groups = groupsOf(provider);
      const doneGroup = groups[1];
      const specs = provider.getChildren(doneGroup) as SpecNode[];

      expect(specs).toHaveLength(1);
      expect(specs[0].label).toBe('SPEC-010: Login page');
    });

    it('returns specs belonging to the Archived group', () => {
      const groups = groupsOf(provider);
      const archivedGroup = groups[2];
      const specs = provider.getChildren(archivedGroup) as SpecNode[];

      expect(specs).toHaveLength(1);
      expect(specs[0].label).toBe('SPEC-020: Old feature');
    });

    it('returns empty array for group with no specs', () => {
      mockListSpecs.mockReturnValue([]);
      provider = new SpecTreeProvider('/fake/workspace', mockListSpecs);

      const groups = groupsOf(provider);
      const specs = provider.getChildren(groups[0]) as SpecNode[];
      expect(specs).toHaveLength(0);
    });
  });

  describe('SpecNode details', () => {
    it('has correct label format (ID: title)', () => {
      const groups = groupsOf(provider);
      const specs = provider.getChildren(groups[0]) as SpecNode[];
      expect(specs[0].label).toBe('SPEC-001: Rate limiting');
    });

    it('has description with tier, progress meter, percent and phase (DR-012)', () => {
      const groups = groupsOf(provider);
      const specs = provider.getChildren(groups[0]) as SpecNode[];
      expect(specs[0].description).toMatch(/^T1 \u00b7 [\u25b0\u25b1]+ \d+% \u00b7 specify$/);
      expect(specs[1].description).toMatch(/^T3 \u00b7 [\u25b0\u25b1]+ \d+% \u00b7 clarify$/);
      expect(specs[2].description).toMatch(/^T4 \u00b7 [\u25b0\u25b1]+ \d+% \u00b7 implement$/);
    });

    it('shows "complete" when no current phase', () => {
      const groups = groupsOf(provider);
      const doneSpecs = provider.getChildren(groups[1]) as SpecNode[];
      expect(doneSpecs[0].description).toMatch(/^T2 \u00b7 [\u25b0\u25b1]+ \d+% \u00b7 complete$/);
    });

    it('has ThemeIcon based on status', () => {
      const groups = groupsOf(provider);
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
      const groups = groupsOf(provider);
      const specs = provider.getChildren(groups[0]) as SpecNode[];
      expect(specs[0].command).toBeDefined();
      expect(specs[0].command!.command).toBe('vscode.open');
    });

    it('has contextValue of specNode', () => {
      const groups = groupsOf(provider);
      const specs = provider.getChildren(groups[0]) as SpecNode[];
      expect(specs[0].contextValue).toBe('specNode');
    });

    // Regression: a done/archived spec is past the DR-012 approve gate, so it
    // must NOT expose the approve action (contextValue gates the menu).
    it('done and archived specs get contextValue specNode.terminal', () => {
      expect(new SpecNode(makeSpec({ status: 'done' }), 'unapproved').contextValue).toBe('specNode.terminal');
      expect(new SpecNode(makeSpec({ status: 'archived' }), 'unapproved').contextValue).toBe('specNode.terminal');
      // even an approved-then-done spec is terminal (no approve/revoke)
      expect(new SpecNode(makeSpec({ status: 'done' }), 'approved').contextValue).toBe('specNode.terminal');
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

// --- Approval wiring (DR-012) — T3 regression ---
//
// Bug: extension.ts constructed `new SpecTreeProvider(workspaceRoot)` with NO
// ApprovalLookupFn, so the provider fell back to its `() => 'unapproved'` default
// stub. approvals.json was therefore never read for the tree — no refresh (manual
// button, visibility change, or approvals.json watcher) could ever surface an
// approval badge. An approved spec showed forever as unapproved.
//
// Root cause: the default for `approvalFn` was a stub, NOT the real lookup —
// inconsistent with `listSpecsFn`, which defaults to the real `listSpecs`. These
// tests pin the contract that a default-constructed provider reads real approvals.
describe('SpecTreeProvider — approval wiring (regression)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-approval-wiring-'));
  });

  function writeSpec(id: string): string {
    const specsDir = path.join(tmpDir, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    const p = path.join(specsDir, `${id}.md`);
    fs.writeFileSync(p, `---\nid: ${id}\ntitle: Wired\ntier: T2\nstatus: implementing\n---\n\n# Wired\n`);
    return p;
  }

  function activeNodes(provider: SpecTreeProvider): SpecNode[] {
    return provider.getChildren(groupsOf(provider)[0]) as SpecNode[];
  }

  it('default-constructed provider reflects a real approval from approvals.json', () => {
    const specPath = writeSpec('SPEC-001');
    approveSpec(tmpDir, 'SPEC-001', specPath, 'T2'); // binds current file hash

    // Production path: NO approvalFn injected.
    const spec = makeSpec({ id: 'SPEC-001', status: 'implementing', filePath: specPath });
    const provider = new SpecTreeProvider(tmpDir, () => [spec]);

    const node = activeNodes(provider)[0];
    expect(node.approval).toBe('approved');
    expect(node.contextValue).toBe('specNode.approved');
    // Approval shows on the ALWAYS-VISIBLE left icon (🔒 lock), not buried in the
    // truncatable description. NOT ✔ — a check misreads as "done" on a spec that
    // is only approved-to-build (signpost-lie).
    expect((node.iconPath as { id: string }).id).toBe('lock');
    expect(node.description).toContain('approved'); // plain-text echo, no glyph
    expect(node.description).not.toContain('✔');
  });

  it('default-constructed provider marks approval stale (⚠ icon) after the spec is edited', () => {
    const specPath = writeSpec('SPEC-001');
    approveSpec(tmpDir, 'SPEC-001', specPath, 'T2');
    fs.appendFileSync(specPath, '\nedited after approval\n'); // hash now differs

    const spec = makeSpec({ id: 'SPEC-001', status: 'implementing', filePath: specPath });
    const provider = new SpecTreeProvider(tmpDir, () => [spec]);

    const node = activeNodes(provider)[0];
    expect(node.approval).toBe('stale');
    expect((node.iconPath as { id: string }).id).toBe('warning');
  });

  it('default-constructed provider shows unapproved when no record exists', () => {
    const specPath = writeSpec('SPEC-002'); // never approved
    const spec = makeSpec({ id: 'SPEC-002', status: 'implementing', filePath: specPath });
    const provider = new SpecTreeProvider(tmpDir, () => [spec]);

    expect(activeNodes(provider)[0].approval).toBe('unapproved');
  });
});

// --- Epic grouping (DR-013 / SPEC-007 FR-6/FR-7/FR-10) ---

describe('SpecTreeProvider — epic grouping', () => {
  const EPICS: EpicSummary[] = [
    { id: 'EPIC-001', slug: 'telemetry', title: 'Telemetry', status: 'active', order: 1, filePath: '/e/EPIC-001.md' },
    { id: 'EPIC-002', slug: 'auth', title: 'Auth', status: 'active', order: 2, filePath: '/e/EPIC-002.md' },
  ];
  const SPECS: SpecSummary[] = [
    makeSpec({ id: 'SPEC-001', status: 'done', epic: 'EPIC-001' }),
    makeSpec({ id: 'SPEC-002', status: 'implementing', epic: 'telemetry' }), // by slug
    makeSpec({ id: 'SPEC-003', status: 'new', epic: 'auth' }),
    makeSpec({ id: 'SPEC-004', status: 'new' }),                              // ungrouped
  ];

  function epicGroups(p: SpecTreeProvider): EpicGroupNode<SpecSummary>[] {
    return p.getChildren(undefined).filter((n): n is EpicGroupNode<SpecSummary> => n instanceof EpicGroupNode);
  }

  it('groups specs by epic (id or slug) with NO_EPIC last when grouping on + epics exist', () => {
    const p = new SpecTreeProvider('/ws', () => SPECS, undefined, () => EPICS);
    const groups = epicGroups(p);
    expect(groups.map(g => g.groupLabel)).toEqual([
      'Telemetry (EPIC-001)',
      'Auth (EPIC-002)',
      '(no epic)',
    ]);
  });

  it('badge counts terminal (done) specs over total per epic', () => {
    const p = new SpecTreeProvider('/ws', () => SPECS, undefined, () => EPICS);
    const telemetry = epicGroups(p).find(g => g.groupLabel.startsWith('Telemetry'))!;
    expect(telemetry.description).toBe('1/2'); // SPEC-001 done of {001,002}
    expect(telemetry.members).toHaveLength(2);
  });

  it('children of an epic group are SpecNodes', () => {
    const p = new SpecTreeProvider('/ws', () => SPECS, undefined, () => EPICS);
    const telemetry = epicGroups(p).find(g => g.groupLabel.startsWith('Telemetry'))!;
    const kids = p.getChildren(telemetry);
    expect(kids.every(k => k instanceof SpecNode)).toBe(true);
    expect(kids).toHaveLength(2);
  });

  it('epic header opens the epic file and carries a status-suffixed contextValue', () => {
    const p = new SpecTreeProvider('/ws', () => SPECS, undefined, () => EPICS);
    const telemetry = epicGroups(p).find(g => g.groupLabel.startsWith('Telemetry'))!;
    // command opens EPIC-001's file
    expect(telemetry.command?.command).toBe('vscode.open');
    expect((telemetry.command?.arguments?.[0] as { fsPath: string }).fsPath).toBe('/e/EPIC-001.md');
    // contextValue gates the inline accept tick (EPICS are 'active' here)
    expect(telemetry.contextValue).toBe('epicGroup.active');
  });

  it('a proposed epic gets contextValue epicGroup.proposed (accept tick shows)', () => {
    const proposed: EpicSummary[] = [
      { id: 'EPIC-009', slug: 'new-thing', title: 'New Thing', status: 'proposed', order: 1, filePath: '/e/EPIC-009.md' },
    ];
    const specs: SpecSummary[] = [makeSpec({ id: 'SPEC-050', epic: 'new-thing' })];
    const p = new SpecTreeProvider('/ws', () => specs, undefined, () => proposed);
    const g = epicGroups(p)[0];
    expect(g.contextValue).toBe('epicGroup.proposed');
  });

  it('falls back to status groups when no epics are registered (FR-10)', () => {
    const p = new SpecTreeProvider('/ws', () => SPECS, undefined, () => []);
    const nodes = p.getChildren(undefined);
    expect(nodes.some(n => n instanceof EpicGroupNode)).toBe(false);
    expect(nodes.some(n => n instanceof SpecGroupNode)).toBe(true);
  });

  it('toggling grouping off yields status groups even when epics exist', () => {
    const p = new SpecTreeProvider('/ws', () => SPECS, undefined, () => EPICS);
    p.epicGrouping.set(false);
    const nodes = p.getChildren(undefined);
    expect(nodes.some(n => n instanceof EpicGroupNode)).toBe(false);
    expect(nodes.some(n => n instanceof SpecGroupNode)).toBe(true);
  });
});
