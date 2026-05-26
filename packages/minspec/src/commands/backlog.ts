import * as vscode from 'vscode';
import {
  calculateWsjf,
  applyWsjfToIssue,
  fetchIssues,
  isGhAvailable,
  transitionIssue,
  setPriority,
  LIFECYCLE_TRANSITIONS,
  PRIORITY_LABELS,
} from '../lib/backlog';
import type {
  WsjfDimensions,
  BacklogIssue,
  IssueLifecycleLabel,
  PriorityLabel,
} from '../lib/backlog';

// ─── WSJF Scoring Command ──────────────────────────────────────────────────

/**
 * Prompt the user through WSJF scoring for a GitHub issue.
 * Uses VS Code QuickPick/InputBox for each dimension (1-10 scale).
 */
export async function scoreWsjfCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }

  // Check gh is available
  const ghAvail = await isGhAvailable();
  if (!ghAvail) {
    vscode.window.showErrorMessage(
      'MinSpec: GitHub CLI (gh) is not available or not authenticated. Install and run `gh auth login`.',
    );
    return;
  }

  // Fetch open issues for selection
  const issues = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'MinSpec: Fetching issues...',
      cancellable: false,
    },
    () => fetchIssues(folder, { state: 'open' }),
  );

  if (issues.length === 0) {
    vscode.window.showInformationMessage('MinSpec: No open issues found.');
    return;
  }

  // Pick an issue
  const issueItems: vscode.QuickPickItem[] = issues.map(issue => ({
    label: `#${issue.number}: ${issue.title}`,
    description: issue.labels.join(', ') || undefined,
    detail: issue.wsjfScore !== null ? `Current WSJF: ${issue.wsjfScore}` : undefined,
  }));

  const selectedItem = await vscode.window.showQuickPick(issueItems, {
    placeHolder: 'Select an issue to score',
    ignoreFocusOut: true,
  });

  if (!selectedItem) return;

  const selectedIssue = issues.find(
    i => selectedItem.label === `#${i.number}: ${i.title}`,
  );
  if (!selectedIssue) return;

  // Collect WSJF dimensions via QuickPick (1-10 scale)
  const scaleOptions = Array.from({ length: 10 }, (_, i) => ({
    label: String(i + 1),
    description: i === 0 ? 'Lowest' : i === 9 ? 'Highest' : undefined,
  }));

  const businessValue = await vscode.window.showQuickPick(scaleOptions, {
    placeHolder: `Business Value (1-10) for #${selectedIssue.number}`,
    ignoreFocusOut: true,
  });
  if (!businessValue) return;

  const timeCriticality = await vscode.window.showQuickPick(scaleOptions, {
    placeHolder: `Time Criticality (1-10) for #${selectedIssue.number}`,
    ignoreFocusOut: true,
  });
  if (!timeCriticality) return;

  const riskReduction = await vscode.window.showQuickPick(scaleOptions, {
    placeHolder: `Risk Reduction / Opportunity Enablement (1-10) for #${selectedIssue.number}`,
    ignoreFocusOut: true,
  });
  if (!riskReduction) return;

  const jobSize = await vscode.window.showQuickPick(scaleOptions, {
    placeHolder: `Job Size (1-10, smaller = higher priority) for #${selectedIssue.number}`,
    ignoreFocusOut: true,
  });
  if (!jobSize) return;

  const dimensions: WsjfDimensions = {
    businessValue: parseInt(businessValue.label, 10),
    timeCriticality: parseInt(timeCriticality.label, 10),
    riskReduction: parseInt(riskReduction.label, 10),
    jobSize: parseInt(jobSize.label, 10),
  };

  const wsjf = calculateWsjf(dimensions);

  // Confirm before applying
  const confirm = await vscode.window.showInformationMessage(
    `WSJF Score: ${wsjf.score} (BV:${dimensions.businessValue} TC:${dimensions.timeCriticality} RR:${dimensions.riskReduction} / Size:${dimensions.jobSize}). Apply to #${selectedIssue.number}?`,
    'Apply',
    'Cancel',
  );

  if (confirm !== 'Apply') return;

  const success = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'MinSpec: Applying WSJF score...',
      cancellable: false,
    },
    () => applyWsjfToIssue(folder, selectedIssue.number, wsjf),
  );

  if (success) {
    vscode.window.showInformationMessage(
      `MinSpec: WSJF score ${wsjf.score} applied to #${selectedIssue.number}.`,
    );
  } else {
    vscode.window.showErrorMessage(
      `MinSpec: Failed to apply WSJF score to #${selectedIssue.number}. Check gh CLI authentication.`,
    );
  }
}

// ─── Quick Triage Command ───────────────────────────────────────────────────

/**
 * Quick-triage an inbox issue: set priority and transition lifecycle label.
 */
export async function triageIssueCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }

  const ghAvail = await isGhAvailable();
  if (!ghAvail) {
    vscode.window.showErrorMessage(
      'MinSpec: GitHub CLI (gh) is not available or not authenticated.',
    );
    return;
  }

  // Fetch inbox issues
  const allIssues = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'MinSpec: Fetching inbox issues...',
      cancellable: false,
    },
    () => fetchIssues(folder, { state: 'open' }),
  );

  // Filter to inbox or unlabeled (no lifecycle label)
  const triageableIssues = allIssues.filter(
    i => i.lifecycleLabel === 'inbox' || i.lifecycleLabel === null,
  );

  if (triageableIssues.length === 0) {
    vscode.window.showInformationMessage('MinSpec: No inbox issues to triage.');
    return;
  }

  // Pick an issue
  const issueItems: vscode.QuickPickItem[] = triageableIssues.map(issue => ({
    label: `#${issue.number}: ${issue.title}`,
    description: issue.labels.join(', ') || 'no labels',
    detail: `Created: ${new Date(issue.createdAt).toLocaleDateString()}`,
  }));

  const selectedItem = await vscode.window.showQuickPick(issueItems, {
    placeHolder: 'Select an inbox issue to triage',
    ignoreFocusOut: true,
  });

  if (!selectedItem) return;

  const selectedIssue = triageableIssues.find(
    i => selectedItem.label === `#${i.number}: ${i.title}`,
  );
  if (!selectedIssue) return;

  // Step 1: Set priority
  const priorityItems: vscode.QuickPickItem[] = [
    { label: 'P1', description: 'Critical — do immediately' },
    { label: 'P2', description: 'Important — do soon' },
    { label: 'P3', description: 'Nice to have — do when time permits' },
    { label: 'Skip', description: 'No priority label' },
  ];

  const priorityChoice = await vscode.window.showQuickPick(priorityItems, {
    placeHolder: `Priority for #${selectedIssue.number}`,
    ignoreFocusOut: true,
  });

  if (!priorityChoice) return;

  // Step 2: Set lifecycle target
  const currentLabel = selectedIssue.lifecycleLabel;
  const validTransitions = currentLabel
    ? LIFECYCLE_TRANSITIONS[currentLabel]
    : ['triaged' as IssueLifecycleLabel]; // unlabeled → triaged

  const lifecycleItems: vscode.QuickPickItem[] = validTransitions.map(label => ({
    label,
    description: label === 'triaged' ? 'Awaiting prioritization/assignment' :
                 label === 'agent-ready' ? 'Ready for agent dispatch' :
                 label === 'wip' ? 'Work in progress' : undefined,
  }));

  // Default to 'triaged' for inbox items
  const lifecycleChoice = await vscode.window.showQuickPick(lifecycleItems, {
    placeHolder: `Transition #${selectedIssue.number} to`,
    ignoreFocusOut: true,
  });

  if (!lifecycleChoice) return;

  // Apply changes
  const results = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `MinSpec: Triaging #${selectedIssue.number}...`,
      cancellable: false,
    },
    async () => {
      const outcomes: string[] = [];

      // Set priority if selected
      if (priorityChoice.label !== 'Skip') {
        const priSuccess = await setPriority(
          folder,
          selectedIssue.number,
          selectedIssue.priorityLabel,
          priorityChoice.label as PriorityLabel,
        );
        outcomes.push(priSuccess
          ? `Priority: ${priorityChoice.label}`
          : 'Priority: FAILED',
        );
      }

      // Transition lifecycle
      const transSuccess = await transitionIssue(
        folder,
        selectedIssue.number,
        currentLabel,
        lifecycleChoice.label as IssueLifecycleLabel,
      );
      outcomes.push(transSuccess
        ? `Lifecycle: ${lifecycleChoice.label}`
        : 'Lifecycle: FAILED',
      );

      return outcomes;
    },
  );

  vscode.window.showInformationMessage(
    `MinSpec: #${selectedIssue.number} triaged — ${results.join(', ')}`,
  );
}
