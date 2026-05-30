import * as vscode from 'vscode';
import { listEpics, groupByEpic, NO_EPIC } from '../lib/epic-manager';
import type { EpicSummary } from '../lib/epic-manager';

/**
 * Shared epic-grouping scaffolding for the three explorer panels
 * (specs, ADRs, backlog). DR-013 / SPEC-007 FR-6.
 *
 * Each panel keeps its own leaf node type and renders its own children; this
 * module only provides the common top-level group node, the per-panel toggle
 * state holder, and the done/total badge math.
 */

/** Function shape for listing epics — injectable for tests. */
export type ListEpicsFn = (rootDir: string) => EpicSummary[];

/**
 * Per-panel "group by epic" toggle. Default ON (FR-7). Holds in-memory state;
 * extension.ts wires persistence to workspaceState and a refresh callback.
 */
export class EpicGroupingState {
  private _enabled: boolean;
  constructor(enabled = true) {
    this._enabled = enabled;
  }
  get enabled(): boolean {
    return this._enabled;
  }
  set(on: boolean): void {
    this._enabled = on;
  }
  toggle(): boolean {
    this._enabled = !this._enabled;
    return this._enabled;
  }
}

/**
 * A top-level epic group in any panel. Holds its members (the panel's own leaf
 * payloads) so the provider can map them to leaf nodes in getChildren.
 */
export class EpicGroupNode<T> extends vscode.TreeItem {
  constructor(
    public readonly groupLabel: string,
    public readonly members: T[],
    badge: string,
    isNoEpic: boolean,
  ) {
    super(
      groupLabel,
      isNoEpic
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    this.description = badge;
    this.contextValue = isNoEpic ? 'epicGroup.none' : 'epicGroup';
    this.iconPath = new vscode.ThemeIcon(isNoEpic ? 'circle-slash' : 'milestone');
    this.accessibilityInformation = {
      label: `${groupLabel} epic group, ${badge}`,
      role: 'treeitem',
    };
  }
}

/**
 * Build the epic group nodes for a panel.
 *
 * @param rootDir       workspace root
 * @param items         the panel's leaf payloads (SpecSummary / AdrSummary / BacklogIssue)
 * @param refOf         extract an item's epic ref (frontmatter `epic` or label slug)
 * @param isTerminal    whether an item counts as "done" for the badge
 * @param listEpicsFn   injectable epic lister (defaults to listEpics)
 * @returns one EpicGroupNode per non-empty epic (epic order), NO_EPIC last;
 *          or `null` when no epics are registered — the caller then falls back
 *          to its native grouping (graceful degradation, FR-10). Toggling
 *          grouping on in a repo with no epics must not collapse everything
 *          into a single "(no epic)" bucket.
 */
export function buildEpicGroups<T>(
  rootDir: string,
  items: T[],
  refOf: (item: T) => string | undefined,
  isTerminal: (item: T) => boolean,
  listEpicsFn: ListEpicsFn = listEpics,
): EpicGroupNode<T>[] | null {
  const epics = listEpicsFn(rootDir);
  if (epics.length === 0) return null;
  const buckets = groupByEpic(items, refOf, epics);
  const titleById = new Map(epics.map(e => [e.id, e.title] as const));

  const nodes: EpicGroupNode<T>[] = [];
  for (const [key, members] of buckets) {
    const isNoEpic = key === NO_EPIC;
    const done = members.filter(isTerminal).length;
    const badge = `${done}/${members.length}`;
    const label = isNoEpic
      ? NO_EPIC
      : `${titleById.get(key) ?? key} (${key})`;
    nodes.push(new EpicGroupNode(label, members, badge, isNoEpic));
  }
  return nodes;
}
