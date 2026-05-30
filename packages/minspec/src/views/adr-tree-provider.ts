import * as vscode from 'vscode';
import { listAdrs } from '../lib/adr-manager';
import type { AdrSummary, AdrStatus } from '../lib/adr-manager';
import { EpicGroupingState, EpicGroupNode, buildEpicGroups } from './epic-grouping';
import type { ListEpicsFn } from './epic-grouping';

// ─── Status grouping ────────────────────────────────────────────────────────

interface StatusGroup {
  readonly label: string;
  readonly statuses: AdrStatus[];
  readonly defaultExpanded: boolean;
}

const STATUS_GROUPS: StatusGroup[] = [
  { label: 'Proposed', statuses: ['proposed'], defaultExpanded: true },
  { label: 'Accepted', statuses: ['accepted'], defaultExpanded: true },
  { label: 'Deprecated / Superseded', statuses: ['deprecated', 'superseded'], defaultExpanded: false },
];

// ─── Tree node classes ──────────────────────────────────────────────────────

export class AdrGroupNode extends vscode.TreeItem {
  public readonly adrs: AdrSummary[];

  constructor(group: StatusGroup, adrs: AdrSummary[]) {
    const collapsibleState = group.defaultExpanded
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    super(group.label, collapsibleState);

    this.adrs = adrs;
    this.description = `(${adrs.length})`;
    this.contextValue = 'adrGroup';
    this.accessibilityInformation = {
      label: `${group.label} decisions group, ${adrs.length} items`,
      role: 'treeitem',
    };
  }
}

/**
 * Map an ADR status to a ThemeIcon id.
 */
function statusIcon(status: AdrStatus): string {
  switch (status) {
    case 'proposed': return 'question';
    case 'accepted': return 'check';
    case 'deprecated': return 'warning';
    case 'superseded': return 'arrow-swap';
    default: return 'circle-outline';
  }
}

export class AdrNode extends vscode.TreeItem {
  constructor(public readonly adr: AdrSummary) {
    super(`${adr.id}: ${adr.title}`, vscode.TreeItemCollapsibleState.None);

    this.description = adr.date;
    this.iconPath = new vscode.ThemeIcon(statusIcon(adr.status));

    // Click opens the ADR file
    this.command = {
      command: 'vscode.open',
      title: 'Open ADR',
      arguments: [vscode.Uri.file(adr.filePath)],
    };

    // Status-suffixed contextValue gates menus: inline ✓ Accept shows only on
    // proposed ADRs (`adrNode.proposed`); Set Status shows on all (`adrNode.*`).
    this.contextValue = `adrNode.${adr.status}`;
    this.tooltip = `${adr.id}: ${adr.title}\nStatus: ${adr.status}\nDate: ${adr.date}`;
    this.accessibilityInformation = {
      label: `${adr.id}: ${adr.title}, status ${adr.status}, date ${adr.date}`,
      role: 'treeitem',
    };
  }
}

// ─── TreeDataProvider ───────────────────────────────────────────────────────

/** Function signature for listing ADRs — allows dependency injection in tests */
export type ListAdrsFn = (rootDir: string, vscodeOverrides?: { decisionsDir?: string }) => AdrSummary[];

export type AdrTreeNode = AdrGroupNode | EpicGroupNode<AdrSummary> | AdrNode;

export class AdrTreeProvider implements vscode.TreeDataProvider<AdrTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AdrTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _listAdrs: ListAdrsFn;
  private readonly _listEpics?: ListEpicsFn;
  /** Per-panel "group by epic" toggle (FR-7), default on. */
  public readonly epicGrouping = new EpicGroupingState(true);

  constructor(
    private workspaceRoot: string,
    listAdrsFn?: ListAdrsFn,
    listEpicsFn?: ListEpicsFn,
  ) {
    this._listAdrs = listAdrsFn ?? listAdrs;
    this._listEpics = listEpicsFn;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: AdrTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AdrTreeNode): AdrTreeNode[] {
    if (!this.workspaceRoot) {
      return [];
    }

    if (!element) {
      const allAdrs = this.listAll();
      const epicGroups = this.epicGrouping.enabled ? this.getEpicGroups(allAdrs) : null;
      return epicGroups ?? this.getStatusGroups(allAdrs);
    }

    if (element instanceof AdrGroupNode) {
      return element.adrs.map(adr => new AdrNode(adr));
    }

    if (element instanceof EpicGroupNode) {
      return element.members.map(adr => new AdrNode(adr));
    }

    return [];
  }

  private listAll(): AdrSummary[] {
    const decisionsDir = vscode.workspace
      .getConfiguration('minspec')
      .get<string>('decisionsDir');
    return this._listAdrs(
      this.workspaceRoot,
      decisionsDir ? { decisionsDir } : undefined,
    );
  }

  private getStatusGroups(allAdrs: AdrSummary[]): AdrGroupNode[] {
    return STATUS_GROUPS.map(group => {
      const groupAdrs = allAdrs.filter(a => group.statuses.includes(a.status));
      return new AdrGroupNode(group, groupAdrs);
    });
  }

  private getEpicGroups(allAdrs: AdrSummary[]): EpicGroupNode<AdrSummary>[] | null {
    return buildEpicGroups(
      this.workspaceRoot,
      allAdrs,
      a => a.epic,
      a => a.status === 'accepted',
      this._listEpics,
    );
  }
}
