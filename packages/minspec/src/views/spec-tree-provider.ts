import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, resolveAndValidate } from '../lib/config';
import { parseSpec } from '../lib/spec';
import type { SpecFrontmatter, SpecStatus } from '../lib/spec';
import type { Phase, MinspecConfig } from '../lib/config';
import type { ApprovalStatus } from '../lib/approval';

/**
 * Approval lookup, injected so the provider has no hard runtime dependency on
 * the approval module (keeps unit tests that mock only `vscode` clean, and
 * mirrors the ListSpecsFn injection pattern). extension.ts wires the real one.
 */
export type ApprovalLookupFn = (rootDir: string, specId: string, specFilePath: string) => ApprovalStatus;
import type { SpecSummary } from '../lib/spec-manager';
import { isSpecKitDirEntry, readSpecKitDir } from '../lib/spec-layout';
import { EpicGroupingState, EpicGroupNode, buildEpicGroups } from './epic-grouping';
import type { ListEpicsFn } from './epic-grouping';
export type { SpecSummary };

/**
 * Scan the specs directory and return summaries for all specs.
 * Reads both flat files and spec-kit directories so a project mid-migration
 * stays visible in the sidebar.
 */
export function listSpecs(rootDir: string): SpecSummary[] {
  const config = loadConfig(rootDir);
  const specsDir = resolveAndValidate(rootDir, config.specsDir);

  if (!fs.existsSync(specsDir)) {
    return [];
  }

  const entries = fs.readdirSync(specsDir);
  const summaries: SpecSummary[] = [];

  for (const entry of entries) {
    const fullPath = path.join(specsDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    try {
      let fm: SpecFrontmatter;
      let displayPath: string;

      if (stat.isFile() && entry.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        fm = parseSpec(content).frontmatter;
        displayPath = fullPath;
      } else if (stat.isDirectory() && isSpecKitDirEntry(entry)) {
        const specMd = path.join(fullPath, 'spec.md');
        if (!fs.existsSync(specMd)) continue;
        fm = readSpecKitDir(fullPath).frontmatter;
        displayPath = specMd;
      } else {
        continue;
      }

      if (!fm.id) continue;

      const { done, total } = phaseProgress(fm, config);
      summaries.push({
        id: fm.id,
        title: fm.title,
        tier: fm.tier,
        status: fm.status,
        currentPhase: deriveCurrentPhase(fm),
        filePath: displayPath,
        phasesDone: done,
        phasesTotal: total,
        epic: fm.epic,
      });
    } catch {
      // Skip unparseable entries
    }
  }

  // Sort by ID for stable ordering
  summaries.sort((a, b) => a.id.localeCompare(b.id));
  return summaries;
}

/**
 * Derive the current active phase from frontmatter phase statuses.
 * Returns the first in-progress phase, or first pending phase, or null if all done/skipped.
 */
/**
 * Count completed (done/skipped) required phases for a spec's tier.
 * "Required" comes from config.phaseMappings so progress reflects ceremony:
 * a T1 spec is 100% at specify-done, a T4 needs all five phases.
 */
function phaseProgress(fm: SpecFrontmatter, config: MinspecConfig): { done: number; total: number } {
  const required = config.phaseMappings[fm.tier]?.requiredPhases ?? ['specify'];
  let done = 0;
  for (const phase of required) {
    const st = fm.phases[phase];
    if (st === 'done' || st === 'skipped') done++;
  }
  return { done, total: required.length };
}

function deriveCurrentPhase(fm: SpecFrontmatter): Phase | null {
  const phases: Phase[] = ['specify', 'clarify', 'plan', 'tasks', 'implement'];

  // First check for in-progress
  for (const phase of phases) {
    if (fm.phases[phase] === 'in-progress') return phase;
  }
  // Then check for first pending
  for (const phase of phases) {
    if (fm.phases[phase] === 'pending') return phase;
  }
  return null;
}

// --- Status grouping ---

interface StatusGroup {
  readonly label: string;
  readonly statuses: SpecStatus[];
  readonly defaultExpanded: boolean;
}

const STATUS_GROUPS: StatusGroup[] = [
  { label: 'Active', statuses: ['new', 'specifying', 'implementing'], defaultExpanded: true },
  { label: 'Done', statuses: ['done'], defaultExpanded: false },
  { label: 'Archived', statuses: ['archived'], defaultExpanded: false },
];

// --- Tree node classes ---

export class SpecGroupNode extends vscode.TreeItem {
  public readonly specs: SpecSummary[];

  constructor(group: StatusGroup, specs: SpecSummary[]) {
    const collapsibleState = group.defaultExpanded
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    super(group.label, collapsibleState);

    this.specs = specs;
    this.description = `(${specs.length})`;
    this.contextValue = 'specGroup';
    this.accessibilityInformation = {
      label: `${group.label} specs group, ${specs.length} items`,
      role: 'treeitem',
    };
  }
}

/**
 * Map a spec status to a ThemeIcon id.
 */
function statusIcon(status: SpecStatus): string {
  switch (status) {
    case 'new': return 'circle-outline';
    case 'specifying': return 'sync';
    case 'implementing': return 'sync';
    case 'done': return 'check';
    case 'archived': return 'archive';
    default: return 'circle-outline';
  }
}

/** Render an N/M progress as a compact unicode meter, e.g. \u25b0\u25b0\u25b0\u25b1\u25b1. */
function progressMeter(done: number, total: number): string {
  if (total <= 0) return '';
  const filled = Math.round((done / total) * 5);
  return '\u25b0'.repeat(filled) + '\u25b1'.repeat(5 - filled);
}

export class SpecNode extends vscode.TreeItem {
  constructor(
    public readonly spec: SpecSummary,
    public readonly approval: ApprovalStatus = 'unapproved',
  ) {
    super(`${spec.id}: ${spec.title}`, vscode.TreeItemCollapsibleState.None);

    const phaseLabel = spec.currentPhase ?? 'complete';
    const pct = spec.phasesTotal > 0 ? Math.round((spec.phasesDone / spec.phasesTotal) * 100) : 100;
    const meter = progressMeter(spec.phasesDone, spec.phasesTotal);
    const approvalTag =
      approval === 'approved' ? ' \u2714 approved'
        : approval === 'stale' ? ' \u26a0 stale'
          : '';

    // Description: tier \u00b7 meter pct% \u00b7 phase [\u00b7 approval]
    this.description = `${spec.tier} \u00b7 ${meter} ${pct}% \u00b7 ${phaseLabel}${approvalTag}`;

    this.iconPath = new vscode.ThemeIcon(statusIcon(spec.status));

    this.command = {
      command: 'vscode.open',
      title: 'Open Spec',
      arguments: [vscode.Uri.file(spec.filePath)],
    };

    // Context value drives menu visibility. Suffix encodes approval so the
    // "Revoke" action only shows on approved specs (see package.json when-clauses).
    this.contextValue = approval === 'approved' ? 'specNode.approved' : 'specNode';

    const approvalLine =
      approval === 'approved' ? 'Approval: \u2714 approved (content-bound)'
        : approval === 'stale' ? 'Approval: \u26a0 STALE \u2014 spec edited since approval, re-approve required'
          : 'Approval: \u2014 not approved';
    this.tooltip = `${spec.id}: ${spec.title}\nTier: ${spec.tier}\nStatus: ${spec.status}\nPhase: ${phaseLabel}\nProgress: ${spec.phasesDone}/${spec.phasesTotal} required phases (${pct}%)\n${approvalLine}`;

    this.accessibilityInformation = {
      label: `${spec.id}: ${spec.title}, tier ${spec.tier}, ${pct} percent complete, status ${spec.status}, phase ${phaseLabel}, ${approval}`,
      role: 'treeitem',
    };
  }
}

/**
 * Synthetic roll-up shown at the top of the tree: epic-level progress across
 * all non-archived specs.
 */
export class RollupNode extends vscode.TreeItem {
  constructor(specs: SpecSummary[]) {
    super('Progress', vscode.TreeItemCollapsibleState.None);
    const active = specs.filter((s) => s.status !== 'archived');
    const totalReq = active.reduce((n, s) => n + s.phasesTotal, 0);
    const doneReq = active.reduce((n, s) => n + s.phasesDone, 0);
    const doneSpecs = active.filter((s) => s.status === 'done').length;
    const pct = totalReq > 0 ? Math.round((doneReq / totalReq) * 100) : 0;

    this.description = `${active.length} spec(s) \u00b7 ${progressMeter(doneReq, totalReq)} ${pct}% \u00b7 ${doneSpecs} done`;
    this.iconPath = new vscode.ThemeIcon('graph');
    this.contextValue = 'rollupNode';
    this.tooltip = `Epic progress\n${active.length} active spec(s)\n${doneReq}/${totalReq} required phases complete (${pct}%)\n${doneSpecs} spec(s) fully done`;
    this.accessibilityInformation = {
      label: `Overall progress: ${pct} percent, ${doneSpecs} of ${active.length} specs done`,
      role: 'treeitem',
    };
  }
}

// --- TreeDataProvider ---

/** Function signature for listing specs — allows dependency injection in tests */
export type ListSpecsFn = (rootDir: string) => SpecSummary[];

export type SpecTreeNode = RollupNode | SpecGroupNode | EpicGroupNode<SpecSummary> | SpecNode;

export class SpecTreeProvider implements vscode.TreeDataProvider<SpecTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SpecTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _listSpecs: ListSpecsFn;
  private readonly _approvalOf: ApprovalLookupFn;
  private readonly _listEpics?: ListEpicsFn;
  /** Per-panel "group by epic" toggle (FR-7), default on. */
  public readonly epicGrouping = new EpicGroupingState(true);

  constructor(
    private workspaceRoot: string,
    listSpecsFn?: ListSpecsFn,
    approvalFn?: ApprovalLookupFn,
    listEpicsFn?: ListEpicsFn,
  ) {
    this._listSpecs = listSpecsFn ?? listSpecs;
    this._approvalOf = approvalFn ?? (() => 'unapproved');
    this._listEpics = listEpicsFn;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SpecTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SpecTreeNode): SpecTreeNode[] {
    if (!this.workspaceRoot) {
      return [];
    }

    if (!element) {
      // Root level: roll-up summary, then either epic groups or status groups.
      const allSpecs = this._listSpecs(this.workspaceRoot);
      const root: SpecTreeNode[] = [];
      if (allSpecs.length > 0) root.push(new RollupNode(allSpecs));
      const epicGroups = this.epicGrouping.enabled ? this.getEpicGroups(allSpecs) : null;
      root.push(...(epicGroups ?? this.getStatusGroups(allSpecs)));
      return root;
    }

    if (element instanceof SpecGroupNode) {
      return element.specs.map(spec => this.toSpecNode(spec));
    }

    if (element instanceof EpicGroupNode) {
      return element.members.map(spec => this.toSpecNode(spec));
    }

    // RollupNode and SpecNode are leaves
    return [];
  }

  /** Build a SpecNode tagged with its current approval status. */
  private toSpecNode(spec: SpecSummary): SpecNode {
    let approval: ApprovalStatus = 'unapproved';
    try {
      approval = this._approvalOf(this.workspaceRoot, spec.id, spec.filePath);
    } catch {
      // best-effort — default to unapproved
    }
    return new SpecNode(spec, approval);
  }

  private getStatusGroups(allSpecs: SpecSummary[]): SpecGroupNode[] {
    return STATUS_GROUPS.map(group => {
      const groupSpecs = allSpecs.filter(s => group.statuses.includes(s.status));
      return new SpecGroupNode(group, groupSpecs);
    });
  }

  private getEpicGroups(allSpecs: SpecSummary[]): EpicGroupNode<SpecSummary>[] | null {
    return buildEpicGroups(
      this.workspaceRoot,
      allSpecs,
      s => s.epic,
      s => s.status === 'done',
      this._listEpics,
    );
  }
}
