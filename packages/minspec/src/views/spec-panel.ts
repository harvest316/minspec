import * as vscode from 'vscode';
import * as fs from 'fs';
import { readSpecFile, writeSpec } from '../lib/spec';
import type { Phase } from '../lib/config';
import { getHtml, getErrorHtml, toggleTask } from './spec-panel-html';
import type { ClassificationSummary } from './spec-panel-html';

export type { ClassificationSummary } from './spec-panel-html';
export { getHtml, getErrorHtml, toggleTask } from './spec-panel-html';

/**
 * Manages the Active Spec Panel webview.
 * Shows a vertical phase stepper, inline task checklist, and classification breakdown.
 */
export class SpecPanel {
  private panel: vscode.WebviewPanel | undefined;
  private specFilePath: string | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Show or reveal the spec panel for a given spec file.
   */
  show(specFilePath: string, classification?: ClassificationSummary): void {
    this.specFilePath = specFilePath;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'minspecPanel',
        'MinSpec: Active Spec',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
      });

      this.panel.webview.onDidReceiveMessage(
        (message) => this.handleMessage(message),
        undefined,
        this.disposables,
      );
    }

    this.refresh(classification);
  }

  /**
   * Refresh the panel content from the current spec file.
   */
  refresh(classification?: ClassificationSummary): void {
    if (!this.panel || !this.specFilePath) return;

    try {
      const spec = readSpecFile(this.specFilePath);
      this.panel.title = `MinSpec: ${spec.frontmatter.title || spec.frontmatter.id}`;
      this.panel.webview.html = getHtml(spec, classification);
    } catch (err) {
      this.panel.webview.html = getErrorHtml(
        `Failed to read spec: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Dispose the panel and clean up.
   */
  dispose(): void {
    this.panel?.dispose();
  }

  /**
   * Handle messages from the webview (task toggle).
   */
  private handleMessage(message: { command: string; phase: Phase; taskIndex: number; done: boolean }): void {
    if (message.command !== 'toggleTask') return;
    if (!this.specFilePath) return;

    const { phase, taskIndex, done } = message;

    try {
      const spec = readSpecFile(this.specFilePath);
      const updatedSpec = toggleTask(spec, phase, taskIndex, done);
      if (updatedSpec) {
        fs.writeFileSync(this.specFilePath, writeSpec(updatedSpec), 'utf-8');
        // The file watcher will pick up this change and refresh tree view.
        // Refresh our own panel to reflect the change immediately.
        this.refresh();
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `MinSpec: Failed to toggle task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
