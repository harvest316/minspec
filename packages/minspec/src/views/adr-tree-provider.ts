import * as vscode from 'vscode';
import { listAdrs } from '../lib/adr-manager';
import type { AdrSummary, AdrStatus } from '../lib/adr-manager';

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

    this.contextValue = 'adrNode';
    this.tooltip = `${adr.id}: ${adr.title}\nStatus: ${adr.status}\nDate: ${adr.date}`;
  }
}

// ─── TreeDataProvider ───────────────────────────────────────────────────────

/** Function signature for listing ADRs — allows dependency injection in tests */
export type ListAdrsFn = (rootDir: string, vscodeOverrides?: { decisionsDir?: string }) => AdrSummary[];

export class AdrTreeProvider implements vscode.TreeDataProvider<AdrGroupNode | AdrNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AdrGroupNode | AdrNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _listAdrs: ListAdrsFn;

  constructor(
    private workspaceRoot: string,
    listAdrsFn?: ListAdrsFn,
  ) {
    this._listAdrs = listAdrsFn ?? listAdrs;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: AdrGroupNode | AdrNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AdrGroupNode | AdrNode): (AdrGroupNode | AdrNode)[] {
    if (!this.workspaceRoot) {
      return [];
    }

    if (!element) {
      return this.getStatusGroups();
    }

    if (element instanceof AdrGroupNode) {
      return element.adrs.map(adr => new AdrNode(adr));
    }

    return [];
  }

  private getStatusGroups(): AdrGroupNode[] {
    const decisionsDir = vscode.workspace
      .getConfiguration('minspec')
      .get<string>('decisionsDir');

    const allAdrs = this._listAdrs(
      this.workspaceRoot,
      decisionsDir ? { decisionsDir } : undefined,
    );

    return STATUS_GROUPS.map(group => {
      const groupAdrs = allAdrs.filter(a => group.statuses.includes(a.status));
      return new AdrGroupNode(group, groupAdrs);
    });
  }
}
