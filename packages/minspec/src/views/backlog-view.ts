import * as vscode from 'vscode';
import {
  fetchIssues,
  sortBacklog,
  isGhAvailable,
} from '../lib/backlog';
import type { BacklogIssue, IssueLifecycleLabel } from '../lib/backlog';

// ─── Lifecycle grouping ─────────────────────────────────────────────────────

interface LifecycleGroup {
  readonly label: string;
  readonly lifecycleLabel: IssueLifecycleLabel | null;
  readonly defaultExpanded: boolean;
}

const LIFECYCLE_GROUPS: LifecycleGroup[] = [
  { label: 'Inbox', lifecycleLabel: 'inbox', defaultExpanded: true },
  { label: 'Triaged', lifecycleLabel: 'triaged', defaultExpanded: true },
  { label: 'Agent-Ready', lifecycleLabel: 'agent-ready', defaultExpanded: true },
  { label: 'Work in Progress', lifecycleLabel: 'wip', defaultExpanded: true },
  { label: 'Unlabeled', lifecycleLabel: null, defaultExpanded: false },
];

// ─── Tree node classes ──────────────────────────────────────────────────────

export class BacklogGroupNode extends vscode.TreeItem {
  public readonly issues: BacklogIssue[];

  constructor(group: LifecycleGroup, issues: BacklogIssue[]) {
    const collapsibleState = group.defaultExpanded
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    super(group.label, collapsibleState);

    this.issues = issues;
    this.description = `(${issues.length})`;
    this.contextValue = 'backlogGroup';
  }
}

/**
 * Map lifecycle/priority to a ThemeIcon id.
 */
function issueIcon(issue: BacklogIssue): string {
  if (issue.lifecycleLabel === 'wip') return 'sync';
  if (issue.lifecycleLabel === 'agent-ready') return 'robot';
  if (issue.priorityLabel === 'P1') return 'flame';
  if (issue.priorityLabel === 'P2') return 'arrow-up';
  if (issue.priorityLabel === 'P3') return 'arrow-down';
  if (issue.lifecycleLabel === 'triaged') return 'checklist';
  if (issue.lifecycleLabel === 'inbox') return 'inbox';
  return 'issue-opened';
}

export class BacklogIssueNode extends vscode.TreeItem {
  constructor(public readonly issue: BacklogIssue) {
    super(`#${issue.number}: ${issue.title}`, vscode.TreeItemCollapsibleState.None);

    // Build description from priority + WSJF
    const parts: string[] = [];
    if (issue.priorityLabel) parts.push(issue.priorityLabel);
    if (issue.wsjfScore !== null) parts.push(`WSJF:${issue.wsjfScore}`);
    this.description = parts.join(' · ') || undefined;

    this.iconPath = new vscode.ThemeIcon(issueIcon(issue));

    // Click opens the issue URL in the browser
    this.command = {
      command: 'vscode.open',
      title: 'Open Issue',
      arguments: [vscode.Uri.parse(issue.url)],
    };

    this.contextValue = 'backlogIssueNode';

    // Build tooltip
    const tooltipParts = [
      `#${issue.number}: ${issue.title}`,
      `State: ${issue.state}`,
    ];
    if (issue.lifecycleLabel) tooltipParts.push(`Lifecycle: ${issue.lifecycleLabel}`);
    if (issue.priorityLabel) tooltipParts.push(`Priority: ${issue.priorityLabel}`);
    if (issue.wsjfScore !== null) tooltipParts.push(`WSJF: ${issue.wsjfScore}`);
    if (issue.labels.length > 0) tooltipParts.push(`Labels: ${issue.labels.join(', ')}`);
    this.tooltip = tooltipParts.join('\n');
  }
}

// ─── Message node for empty/error states ────────────────────────────────────

class MessageNode extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'backlogMessage';
  }
}

// ─── TreeDataProvider ───────────────────────────────────────────────────────

export class BacklogTreeProvider implements vscode.TreeDataProvider<BacklogGroupNode | BacklogIssueNode | MessageNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BacklogGroupNode | BacklogIssueNode | MessageNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedIssues: BacklogIssue[] = [];
  private lastError: string | null = null;
  private loading = false;

  constructor(private workspaceRoot: string) {}

  refresh(): void {
    this.cachedIssues = [];
    this.lastError = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: BacklogGroupNode | BacklogIssueNode | MessageNode): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: BacklogGroupNode | BacklogIssueNode | MessageNode,
  ): Promise<(BacklogGroupNode | BacklogIssueNode | MessageNode)[]> {
    if (!this.workspaceRoot) {
      return [new MessageNode('No workspace folder open')];
    }

    if (!element) {
      return this.getRootNodes();
    }

    if (element instanceof BacklogGroupNode) {
      return element.issues.map(issue => new BacklogIssueNode(issue));
    }

    return [];
  }

  private async getRootNodes(): Promise<(BacklogGroupNode | MessageNode)[]> {
    // Return cached data if available
    if (this.cachedIssues.length > 0) {
      return this.buildGroups(this.cachedIssues);
    }

    if (this.lastError) {
      return [new MessageNode(this.lastError)];
    }

    // Prevent concurrent fetches
    if (this.loading) {
      return [new MessageNode('Loading issues...')];
    }

    // Check gh availability
    const ghAvail = await isGhAvailable();
    if (!ghAvail) {
      this.lastError = 'GitHub CLI (gh) not available or not authenticated';
      return [new MessageNode(this.lastError)];
    }

    // Fetch issues
    this.loading = true;
    try {
      const issues = await fetchIssues(this.workspaceRoot, { state: 'open' });
      this.cachedIssues = sortBacklog(issues);
      this.loading = false;

      if (this.cachedIssues.length === 0) {
        return [new MessageNode('No open issues found')];
      }

      return this.buildGroups(this.cachedIssues);
    } catch {
      this.loading = false;
      this.lastError = 'Failed to fetch issues from GitHub';
      return [new MessageNode(this.lastError)];
    }
  }

  private buildGroups(issues: BacklogIssue[]): BacklogGroupNode[] {
    return LIFECYCLE_GROUPS.map(group => {
      const groupIssues = issues.filter(issue => {
        if (group.lifecycleLabel === null) {
          // "Unlabeled" group: issues with no lifecycle label
          return issue.lifecycleLabel === null;
        }
        return issue.lifecycleLabel === group.lifecycleLabel;
      });
      return new BacklogGroupNode(group, groupIssues);
    }).filter(group => group.issues.length > 0);
  }
}
