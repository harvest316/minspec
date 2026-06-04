import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, applyVSCodeOverrides, resolveAndValidate } from '../lib/config';
import { resolveTargetFolder } from '../lib/resolve-folder';

/**
 * Generate an example spec file demonstrating all four tiers.
 * The example is instructive — showing proper frontmatter, phases, and tasks format.
 */
export async function generateExampleCommand(): Promise<void> {
  // User-invoked write command → interactive resolver. Multi-root safe: targets
  // the active editor's folder (or prompts), not a blind `workspaceFolders?.[0]`
  // (harvest316/minspec#123, #153). It surfaces the "no folder open" error and
  // returns undefined on no-folder / cancelled pick.
  const folder = await resolveTargetFolder();
  if (!folder) return;

  const config = loadConfig(folder);
  const vscodeConfig = vscode.workspace.getConfiguration('minspec');
  const finalConfig = applyVSCodeOverrides(config, {
    specsDir: vscodeConfig.get('specsDir'),
  });

  const specsDir = resolveAndValidate(folder, finalConfig.specsDir);
  const examplePath = path.join(specsDir, 'SPEC-EXAMPLE.md');

  if (fs.existsSync(examplePath)) {
    const overwrite = await vscode.window.showWarningMessage(
      'MinSpec: Example spec already exists. Overwrite it?',
      'Overwrite',
      'Cancel',
    );
    if (overwrite !== 'Overwrite') return;
  }

  fs.mkdirSync(specsDir, { recursive: true });
  // Stamp `created` at CALL time. Building the content here (not as a
  // module-level const) keeps the date current for every invocation instead of
  // freezing it to extension-activation time (harvest316/minspec#153).
  fs.writeFileSync(examplePath, buildExampleSpecContent());

  const doc = await vscode.workspace.openTextDocument(examplePath);
  await vscode.window.showTextDocument(doc, { preview: false });

  vscode.window.showInformationMessage(
    'MinSpec: Generated example spec. Read through it to learn the tier system.',
  );
}

/**
 * Build the example spec body. A function (not a module-level const) so the
 * `created:` date is evaluated when the command runs — each generated example
 * stamps the current date rather than the extension-activation date
 * (harvest316/minspec#153).
 */
function buildExampleSpecContent(): string {
  return `---
id: SPEC-EXAMPLE
title: Example Spec — How to Write Specs for Each Tier
tier: T2
status: new
created: ${new Date().toISOString().slice(0, 10)}
phases:
  specify: done
  clarify: skipped
  plan: done
  tasks: pending
  implement: pending
---

# Example Spec — How to Write Specs for Each Tier

This is a learning resource, not a real spec. It demonstrates the structure
and conventions for each complexity tier. Delete it when you're ready, or
keep it as a reference.

## Specify

Every spec starts with the **Specify** phase. Write what you're building and why.

**Good specify sections answer:**
- What is the user-visible outcome?
- What problem does this solve?
- What are the constraints?

### T1 Example (Trivial)

For T1 tasks, one sentence is enough:

> Fix the off-by-one error in the pagination component that skips page 2.

That's it. T1 only requires the Specify phase. Document intent, then do the work.

### T2 Example (Small)

For T2, write a short paragraph:

> Add a "copy to clipboard" button to the code block component. When clicked,
> copies the code content to the system clipboard and shows a brief "Copied!"
> confirmation tooltip. Use the existing IconButton component.

### T3/T4 Example (Medium/Large)

For larger tasks, be thorough but not exhaustive:

> Implement real-time collaboration for document editing. Multiple users should
> see each other's cursors and edits within 200ms. Conflicts are resolved with
> operational transformation. The feature must work with our existing WebSocket
> infrastructure and degrade gracefully when offline.

## Acceptance Criteria

Still in Zone A — right after Requirements — list what *done* looks like. This is
the part reviewers read first, so make every line independently verifiable.

The feature is **done** when all of these hold. Each item is one line: a **bold
short outcome name**, an em-dash, a plain-language outcome a reader can observe,
and a parenthetical trace to the requirement (\`FR\`/\`INV\`) it satisfies.

- [ ] **Live cursors** — two users editing the same document each see the other's
  caret move within 200ms, in a distinct colour. (FR-1)
- [ ] **Conflict-free merge** — simultaneous edits to the same line converge to the
  same final text on every client, no lost keystrokes. (FR-2)
- [ ] **Graceful offline** — a user who loses connection keeps editing locally and
  their queued edits replay on reconnect, never silently dropped. (FR-3, INV-no-data-loss)

Keep this tier-scaled: a T1/T2 spec might have just one or two boxes; don't pad it
out. The checkbox list is also what MinSpec reads to know the spec defines *done*.

## Clarify

The **Clarify** phase is required for T4, optional for T2/T3, and skipped for T1.

Use this phase to identify and resolve unknowns *before* coding:

- [ ] Does the WebSocket server support the message throughput we need?
- [ ] What happens to unsaved edits when a user loses connection?
- [ ] Are there legal requirements for audit logging of shared documents?
- [x] Confirmed: OT library supports our document schema (checked v2.3 docs)

Each question should be answerable. Vague concerns ("is this a good idea?") belong
in a discussion, not in Clarify.

## Plan

The **Plan** phase is required for T2+. Describe your technical approach.

### T2 Plan Example

> Use the existing \`IconButton\` component with a clipboard icon. On click,
> call \`navigator.clipboard.writeText()\`. Show tooltip via the \`Tooltip\`
> component with a 2-second auto-dismiss. No new dependencies needed.

### T3/T4 Plan Example

> **Architecture:** Client-side OT engine syncs with server via existing
> WebSocket connection. Server broadcasts operations to all connected clients
> for the same document.
>
> **Key decisions:**
> - Use \`ot.js\` library (MIT, well-maintained, 2KB gzipped)
> - Cursor positions sent as separate lightweight messages
> - Offline queue with replay on reconnect
>
> **What we're NOT building:**
> - User presence indicators (future spec)
> - Conflict resolution UI (OT handles this automatically)

## Tasks

The **Tasks** phase is required for T3+. Break the plan into concrete steps.

Good tasks are:
- **Small enough to complete in one session**
- **Ordered by dependency** (build foundations first)
- **Checkable** (you know when each one is done)

### Example task list

- [ ] Add \`ot.js\` dependency and TypeScript types
- [ ] Create \`OTClient\` class with transform/apply methods
- [ ] Wire \`OTClient\` to WebSocket message handler
- [ ] Add cursor position broadcast (send on selection change)
- [ ] Render remote cursors with colored carets
- [ ] Handle offline: queue operations, replay on reconnect
- [ ] Add integration test: two clients editing simultaneously
- [ ] Update component docs with collaboration API

### Task conventions

Mark tasks done as you complete them:

- [x] This task is complete
- [ ] This task is still pending

MinSpec tracks progress from these checkboxes. The sidebar and status bar
update automatically as you check items off.

## Implement

The **Implement** phase is required for T3+. Track implementation notes here.

This section is yours — use it for:
- Links to relevant PRs or commits
- Implementation decisions made during coding
- Gotchas discovered along the way
- Test results or performance measurements

### Example

> Started implementation 2025-01-15.
>
> **Decision:** Used \`Map<string, OTClient>\` instead of a single global
> instance — each document gets its own OT state. This simplifies cleanup
> when documents are closed.
>
> **Gotcha:** \`navigator.clipboard.writeText()\` requires secure context
> (HTTPS or localhost). Added fallback using \`document.execCommand('copy')\`
> for HTTP development servers.

---

*This example spec was generated by MinSpec. Delete this file or keep it
as a reference — it won't interfere with your real specs.*
`;
}
