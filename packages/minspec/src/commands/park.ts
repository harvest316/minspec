import * as vscode from 'vscode';
import { loadSession } from '../lib/session';
import { createParkingLotEntry, parkTopic } from '../lib/parking-lot';

/**
 * Park a topic — creates a GitHub issue or appends to local parking-lot.md.
 * Auto-fills session scope from active session if available.
 */
export async function parkCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    vscode.window.showErrorMessage('MinSpec: No workspace folder open.');
    return;
  }

  // Step 1: Title
  const title = await vscode.window.showInputBox({
    prompt: 'Title for the parked topic',
    placeHolder: 'e.g., Consider caching strategy for spec lookups',
    ignoreFocusOut: true,
  });
  if (!title) return; // Cancelled

  // Step 2: Body/context
  const body = await vscode.window.showInputBox({
    prompt: 'Additional context (optional)',
    placeHolder: 'Why this came up, relevant details...',
    ignoreFocusOut: true,
  });
  // body can be empty, that's fine

  // Step 3: Labels
  const labelInput = await vscode.window.showInputBox({
    prompt: 'Labels (comma-separated, defaults to "idea,inbox")',
    placeHolder: 'idea,inbox',
    value: 'idea,inbox',
    ignoreFocusOut: true,
  });
  const labels = labelInput
    ? labelInput.split(',').map(l => l.trim()).filter(l => l.length > 0)
    : ['idea', 'inbox'];

  // Auto-fill session scope
  const session = loadSession(folder);
  const sessionScope = session
    ? `${session.scope} (${session.project}, ${session.type})`
    : 'No active session';

  const entry = createParkingLotEntry(title, body || '', sessionScope, labels);

  // Show progress while attempting GitHub issue creation
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'MinSpec: Parking topic...',
      cancellable: false,
    },
    async () => parkTopic(folder, entry),
  );

  if (result.deduped) {
    // A matching open issue / parking-lot entry already existed — reused it
    // instead of creating a duplicate (issue #24).
    const target = result.method === 'github' ? result.url : result.filePath;
    vscode.window.showInformationMessage(
      `MinSpec: Topic already parked — reused existing ${target}`,
    );
  } else if (result.method === 'github') {
    vscode.window.showInformationMessage(
      `MinSpec: Created GitHub issue — ${result.url}`,
    );
  } else {
    vscode.window.showInformationMessage(
      `MinSpec: Saved to ${result.filePath}`,
    );
  }
}
