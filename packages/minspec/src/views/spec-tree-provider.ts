import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../lib/config';
import { parseSpec } from '../lib/spec';
import type { SpecFrontmatter, SpecStatus } from '../lib/spec';
import type { Phase } from '../lib/config';
import type { SpecSummary } from '../lib/spec-manager';
export type { SpecSummary };

/**
 * Scan the specs directory and return summaries for all spec files.
 * Reads .minspec/config.json to determine the specsDir.
 */
export function listSpecs(rootDir: string): SpecSummary[] {
  const config = loadConfig(rootDir);
  const specsDir = path.join(rootDir, config.specsDir);

  if (!fs.existsSync(specsDir)) {
    return [];
  }

  const files = fs.readdirSync(specsDir).filter(f => f.endsWith('.md'));
  const summaries: SpecSummary[] = [];

  for (const file of files) {
    const filePath = path.join(specsDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseSpec(content);
      const fm = parsed.frontmatter;

      // Only include files that look like specs (have an id)
      if (!fm.id) continue;

      summaries.push({
        id: fm.id,
        title: fm.title,
        tier: fm.tier,
        status: fm.status,
        currentPhase: deriveCurrentPhase(fm),
        filePath,
      });
    } catch {
      // Skip unparseable files
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

export class SpecNode extends vscode.TreeItem {
  constructor(public readonly spec: SpecSummary) {
    super(`${spec.id}: ${spec.title}`, vscode.TreeItemCollapsibleState.None);

    // Description: tier + current phase
    const phaseLabel = spec.currentPhase ?? 'complete';
    this.description = `${spec.tier} \u00b7 ${phaseLabel}`;

    // Icon based on status
    this.iconPath = new vscode.ThemeIcon(statusIcon(spec.status));

    // Click opens the spec file
    this.command = {
      command: 'vscode.open',
      title: 'Open Spec',
      arguments: [vscode.Uri.file(spec.filePath)],
    };

    // Context value for context menu contributions
    this.contextValue = 'specNode';

    // Tooltip with more detail
    this.tooltip = `${spec.id}: ${spec.title}\nTier: ${spec.tier}\nStatus: ${spec.status}\nPhase: ${phaseLabel}`;

    this.accessibilityInformation = {
      label: `${spec.id}: ${spec.title}, tier ${spec.tier}, status ${spec.status}, phase ${phaseLabel}`,
      role: 'treeitem',
    };
  }
}

// --- TreeDataProvider ---

/** Function signature for listing specs — allows dependency injection in tests */
export type ListSpecsFn = (rootDir: string) => SpecSummary[];

export class SpecTreeProvider implements vscode.TreeDataProvider<SpecGroupNode | SpecNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SpecGroupNode | SpecNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _listSpecs: ListSpecsFn;

  constructor(private workspaceRoot: string, listSpecsFn?: ListSpecsFn) {
    this._listSpecs = listSpecsFn ?? listSpecs;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SpecGroupNode | SpecNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SpecGroupNode | SpecNode): (SpecGroupNode | SpecNode)[] {
    if (!this.workspaceRoot) {
      return [];
    }

    if (!element) {
      // Root level: return status groups
      return this.getStatusGroups();
    }

    if (element instanceof SpecGroupNode) {
      // Group level: return spec nodes
      return element.specs.map(spec => new SpecNode(spec));
    }

    // Spec nodes are leaves
    return [];
  }

  private getStatusGroups(): SpecGroupNode[] {
    const allSpecs = this._listSpecs(this.workspaceRoot);

    return STATUS_GROUPS.map(group => {
      const groupSpecs = allSpecs.filter(s => group.statuses.includes(s.status));
      return new SpecGroupNode(group, groupSpecs);
    });
  }
}
