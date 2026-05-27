import { execFile } from 'child_process';
import { promisify } from 'util';
import { isGhAvailable, getRepoFromRemote } from './github';
export { isGhAvailable, getRepoFromRemote };

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────────────

/** WSJF dimension scores (1-10 scale) */
export interface WsjfDimensions {
  readonly businessValue: number;
  readonly timeCriticality: number;
  readonly riskReduction: number;
  readonly jobSize: number;
}

/** Computed WSJF score */
export interface WsjfScore {
  readonly dimensions: WsjfDimensions;
  readonly score: number;
}

/** Issue lifecycle labels — defines the progression */
export type IssueLifecycleLabel =
  | 'inbox'
  | 'triaged'
  | 'agent-ready'
  | 'wip'
  | 'done';

/** Priority labels */
export type PriorityLabel = 'P1' | 'P2' | 'P3';

/** A GitHub issue as returned by gh CLI */
export interface BacklogIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly labels: string[];
  readonly state: 'OPEN' | 'CLOSED';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lifecycleLabel: IssueLifecycleLabel | null;
  readonly priorityLabel: PriorityLabel | null;
  readonly wsjfScore: number | null;
}

// ─── WSJF Scoring ───────────────────────────────────────────────────────────

/** All lifecycle labels in progression order */
export const LIFECYCLE_LABELS: readonly IssueLifecycleLabel[] = [
  'inbox',
  'triaged',
  'agent-ready',
  'wip',
  'done',
] as const;

/** Valid transitions from each lifecycle state */
export const LIFECYCLE_TRANSITIONS: Record<IssueLifecycleLabel, IssueLifecycleLabel[]> = {
  inbox: ['triaged'],
  triaged: ['agent-ready', 'wip'],
  'agent-ready': ['wip'],
  wip: ['done'],
  done: [],
};

/** Priority labels recognized by the system */
export const PRIORITY_LABELS: readonly PriorityLabel[] = ['P1', 'P2', 'P3'] as const;

/**
 * Calculate WSJF score.
 *
 * Formula: wsjf = (businessValue + timeCriticality + riskReduction) / jobSize
 *
 * Higher score = higher priority.
 * jobSize cannot be 0 (clamped to minimum 1).
 */
export function calculateWsjf(dimensions: WsjfDimensions): WsjfScore {
  const safeJobSize = Math.max(1, dimensions.jobSize);
  const numerator = dimensions.businessValue + dimensions.timeCriticality + dimensions.riskReduction;
  const score = Math.round((numerator / safeJobSize) * 100) / 100;

  return { dimensions, score };
}

/**
 * Format a WSJF score as a GitHub issue comment body.
 * Makes the scoring transparent and auditable.
 */
export function formatWsjfComment(wsjf: WsjfScore): string {
  const { dimensions, score } = wsjf;
  return [
    '## WSJF Score',
    '',
    `| Dimension | Score |`,
    `|-----------|-------|`,
    `| Business Value | ${dimensions.businessValue} |`,
    `| Time Criticality | ${dimensions.timeCriticality} |`,
    `| Risk Reduction | ${dimensions.riskReduction} |`,
    `| Job Size | ${dimensions.jobSize} |`,
    '',
    `**WSJF = (${dimensions.businessValue} + ${dimensions.timeCriticality} + ${dimensions.riskReduction}) / ${dimensions.jobSize} = ${score}**`,
    '',
    '---',
    '*Scored by MinSpec WSJF calculator*',
  ].join('\n');
}

// ─── Label Extraction ───────────────────────────────────────────────────────

/**
 * Extract the lifecycle label from an issue's label list.
 * Returns null if none found.
 */
export function extractLifecycleLabel(labels: string[]): IssueLifecycleLabel | null {
  const lifecycleSet = new Set<string>(LIFECYCLE_LABELS);
  for (const label of labels) {
    if (lifecycleSet.has(label)) {
      return label as IssueLifecycleLabel;
    }
  }
  return null;
}

/**
 * Extract the priority label from an issue's label list.
 * Returns null if none found.
 */
export function extractPriorityLabel(labels: string[]): PriorityLabel | null {
  const prioritySet = new Set<string>(PRIORITY_LABELS);
  for (const label of labels) {
    if (prioritySet.has(label)) {
      return label as PriorityLabel;
    }
  }
  return null;
}

/**
 * Extract WSJF score from an issue's labels.
 * Convention: label "wsjf:N.NN" stores the score.
 * Returns null if not found.
 */
export function extractWsjfFromLabels(labels: string[]): number | null {
  for (const label of labels) {
    const match = label.match(/^wsjf:(\d+(?:\.\d+)?)$/);
    if (match) {
      return parseFloat(match[1]);
    }
  }
  return null;
}

// ─── GitHub CLI Integration ─────────────────────────────────────────────────

/** JSON shape returned by `gh issue list --json` */
interface GhIssueJson {
  number: number;
  title: string;
  url: string;
  labels: { name: string }[];
  state: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fetch issues from GitHub using `gh` CLI.
 * Filters to open issues by default.
 */
export async function fetchIssues(
  rootDir: string,
  options?: {
    state?: 'open' | 'closed' | 'all';
    label?: string;
    limit?: number;
  },
): Promise<BacklogIssue[]> {
  const state = options?.state ?? 'open';
  const limit = options?.limit ?? 100;

  const args = [
    'issue', 'list',
    '--state', state,
    '--limit', String(limit),
    '--json', 'number,title,url,labels,state,createdAt,updatedAt',
  ];

  if (options?.label) {
    args.push('--label', options.label);
  }

  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd: rootDir,
      timeout: 15000,
      env: { ...process.env },
    });

    const issues: GhIssueJson[] = JSON.parse(stdout);
    return issues.map(mapGhIssue);
  } catch {
    return [];
  }
}

/**
 * Map a raw GH CLI issue to our BacklogIssue type.
 */
function mapGhIssue(raw: GhIssueJson): BacklogIssue {
  const labels = raw.labels.map(l => l.name);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    labels,
    state: raw.state as 'OPEN' | 'CLOSED',
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lifecycleLabel: extractLifecycleLabel(labels),
    priorityLabel: extractPriorityLabel(labels),
    wsjfScore: extractWsjfFromLabels(labels),
  };
}

/**
 * Sort backlog issues by priority:
 * 1. WSJF score (higher first)
 * 2. Priority label (P1 > P2 > P3 > unlabeled)
 * 3. Lifecycle stage (earlier stages first)
 * 4. Created date (oldest first — FIFO within same priority)
 */
export function sortBacklog(issues: BacklogIssue[]): BacklogIssue[] {
  const priorityOrder: Record<string, number> = { P1: 0, P2: 1, P3: 2 };
  const lifecycleOrder: Record<string, number> = {
    inbox: 0,
    triaged: 1,
    'agent-ready': 2,
    wip: 3,
    done: 4,
  };

  return [...issues].sort((a, b) => {
    // WSJF score descending (issues with scores sort before those without)
    const aWsjf = a.wsjfScore ?? -1;
    const bWsjf = b.wsjfScore ?? -1;
    if (aWsjf !== bWsjf) return bWsjf - aWsjf;

    // Priority ascending (P1=0 before P2=1 before P3=2, null last)
    const aPri = a.priorityLabel ? priorityOrder[a.priorityLabel] ?? 99 : 99;
    const bPri = b.priorityLabel ? priorityOrder[b.priorityLabel] ?? 99 : 99;
    if (aPri !== bPri) return aPri - bPri;

    // Lifecycle ascending (inbox first)
    const aLife = a.lifecycleLabel ? lifecycleOrder[a.lifecycleLabel] ?? 99 : 99;
    const bLife = b.lifecycleLabel ? lifecycleOrder[b.lifecycleLabel] ?? 99 : 99;
    if (aLife !== bLife) return aLife - bLife;

    // Created date ascending (oldest first — FIFO)
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Add a WSJF score label to an issue and post a comment with the breakdown.
 * Removes any existing wsjf:* label first.
 */
export async function applyWsjfToIssue(
  rootDir: string,
  issueNumber: number,
  wsjf: WsjfScore,
): Promise<boolean> {
  const newLabel = `wsjf:${wsjf.score}`;

  try {
    // Remove old wsjf labels by editing the issue
    // First, get current labels
    const { stdout: labelStdout } = await execFileAsync('gh', [
      'issue', 'view', String(issueNumber),
      '--json', 'labels',
    ], { cwd: rootDir, timeout: 10000, env: { ...process.env } });

    const { labels: currentLabels }: { labels: { name: string }[] } = JSON.parse(labelStdout);
    const oldWsjfLabels = currentLabels.filter(l => l.name.startsWith('wsjf:')).map(l => l.name);

    // Remove old wsjf labels
    for (const oldLabel of oldWsjfLabels) {
      await execFileAsync('gh', [
        'issue', 'edit', String(issueNumber),
        '--remove-label', oldLabel,
      ], { cwd: rootDir, timeout: 10000, env: { ...process.env } });
    }

    // Add new wsjf label
    await execFileAsync('gh', [
      'issue', 'edit', String(issueNumber),
      '--add-label', newLabel,
    ], { cwd: rootDir, timeout: 10000, env: { ...process.env } });

    // Post comment with score breakdown
    const comment = formatWsjfComment(wsjf);
    await execFileAsync('gh', [
      'issue', 'comment', String(issueNumber),
      '--body', comment,
    ], { cwd: rootDir, timeout: 10000, env: { ...process.env } });

    return true;
  } catch {
    return false;
  }
}

/**
 * Transition an issue to a new lifecycle label.
 * Removes old lifecycle label, adds new one.
 */
export async function transitionIssue(
  rootDir: string,
  issueNumber: number,
  currentLabel: IssueLifecycleLabel | null,
  newLabel: IssueLifecycleLabel,
): Promise<boolean> {
  try {
    const args: string[] = ['issue', 'edit', String(issueNumber)];

    if (currentLabel) {
      args.push('--remove-label', currentLabel);
    }
    args.push('--add-label', newLabel);

    await execFileAsync('gh', args, {
      cwd: rootDir,
      timeout: 10000,
      env: { ...process.env },
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Set priority label on an issue. Removes any existing P1/P2/P3 first.
 */
export async function setPriority(
  rootDir: string,
  issueNumber: number,
  currentPriority: PriorityLabel | null,
  newPriority: PriorityLabel,
): Promise<boolean> {
  try {
    const args: string[] = ['issue', 'edit', String(issueNumber)];

    if (currentPriority) {
      args.push('--remove-label', currentPriority);
    }
    args.push('--add-label', newPriority);

    await execFileAsync('gh', args, {
      cwd: rootDir,
      timeout: 10000,
      env: { ...process.env },
    });

    return true;
  } catch {
    return false;
  }
}
