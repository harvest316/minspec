import * as vscode from 'vscode';
import * as fs from 'fs';
import { readSpecFile, writeSpec } from '../lib/spec';
import type { Phase } from '../lib/config';
import { getHtml, getErrorHtml, toggleTask } from './spec-panel-html';
import type { ClassificationSummary } from './spec-panel-html';
import { listSpecs } from '../lib/spec-manager';
import { computeSpecRework, computeWastedReview } from '../lib/trust-metrics';
import type { TrustChartModel } from '@aiclarity/shared';

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

  constructor() {}

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

      // Build the trust chart model read-only over all specs + ledger (SPEC-017 Slice 6).
      // Degrades gracefully to undefined if rootDir is unavailable — chart simply absent.
      // NEVER writes spec bytes (INV — Non-destructive, FR-11).
      // Wrapped in its own try-catch to ensure any unexpected error here degrades
      // to "no chart" rather than aborting the whole panel render.
      let trustModel: TrustChartModel | undefined;
      try {
        trustModel = this.buildTrustModel();
      } catch {
        trustModel = undefined;
      }

      // Pass trustModel only when available — avoids passing explicit `undefined` to
      // getHtml, which matters for test mocks that assert exact argument count.
      this.panel.webview.html = trustModel
        ? getHtml(spec, classification, trustModel)
        : getHtml(spec, classification);
    } catch (err) {
      this.panel.webview.html = getErrorHtml(
        `Failed to read spec: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Build the TrustChartModel read-only over all specs + the approval ledger.
   * Returns undefined if the workspace root is unavailable (no chart shown).
   *
   * Reads: spec files on disk + `.minspec/approvals/*.json` sidecars.
   * Writes: NOTHING. (INV — Non-destructive, FR-11)
   */
  private buildTrustModel(): TrustChartModel | undefined {
    const rootDir = vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootDir) return undefined;

    let specs: ReturnType<typeof listSpecs>;
    try {
      specs = listSpecs(rootDir);
    } catch {
      return undefined; // unreadable spec tree → no chart, never throw
    }

    // M1: rework % per spec (undefined → null for the model)
    const rework: TrustChartModel['rework'] = specs.map((s) => {
      let pct: number | null = null;
      try {
        const result = computeSpecRework(rootDir, s.filePath);
        pct = result === undefined ? null : result;
      } catch {
        pct = null; // any error → no datapoint
      }
      return { specId: s.id, pct };
    });

    // M2: wasted review for superseded specs
    let wasted: TrustChartModel['wasted'] = [];
    try {
      const bars = computeWastedReview(rootDir, specs);
      wasted = bars.map((b) => {
        // derive specId from specPath (last directory component without extension)
        const parts = b.specPath.replace(/\\/g, '/').split('/');
        const specId = parts.find((p) => /^SPEC-\d/.test(p)) ?? parts[parts.length - 1];
        return { specId, approvedChars: b.approvedChars };
      });
    } catch {
      wasted = []; // degrade gracefully
    }

    return { rework, wasted };
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
