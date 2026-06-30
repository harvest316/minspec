/**
 * Pure HTML generation and task toggle logic for the Active Spec Panel.
 * No vscode API dependency — safe for unit testing.
 */

import * as crypto from 'crypto';
import type { ParsedSpec, TaskItem } from '../lib/spec';
import type { Phase, Tier } from '../lib/config';
import { PHASES } from '../lib/config';
import type { ClassificationSignal } from '../lib/classifier';
import type { TrustChartModel } from '@aiclarity/shared';
import { renderTrustChart } from '@aiclarity/shared';

/** Classification result summary for display */
export interface ClassificationSummary {
  readonly tier: Tier;
  readonly confidence: number;
  readonly signals: ClassificationSignal[];
}

/**
 * Toggle a task's done state in a parsed spec.
 * Returns the updated ParsedSpec, or null if the task was not found.
 */
export function toggleTask(spec: ParsedSpec, phase: Phase, taskIndex: number, done: boolean): ParsedSpec | null {
  const phaseContent = spec.phaseSections[phase];
  if (!phaseContent) return null;
  if (taskIndex < 0 || taskIndex >= phaseContent.tasks.length) return null;

  // Rebuild the body with the toggled task
  const lines = phaseContent.body.split('\n');
  const taskRe = /^(\s*- \[)([ xX])(\] .+)$/;
  let taskCounter = 0;
  let found = false;

  const newLines = lines.map(line => {
    const match = line.match(taskRe);
    if (match) {
      const currentIndex = taskCounter;
      taskCounter++;
      if (currentIndex === taskIndex) {
        found = true;
        const checkChar = done ? 'x' : ' ';
        return `${match[1]}${checkChar}${match[3]}`;
      }
    }
    return line;
  });

  if (!found) return null;

  const newBody = newLines.join('\n');

  // Rebuild the sections map with the updated body
  const capitalized = phase.charAt(0).toUpperCase() + phase.slice(1);
  const newSections = new Map(spec.sections);
  newSections.set(capitalized, newBody);

  // Rebuild phaseSections
  const newTasks: TaskItem[] = phaseContent.tasks.map((t, i) =>
    i === taskIndex ? { text: t.text, done } : t,
  );
  const newPhaseSections = {
    ...spec.phaseSections,
    [phase]: {
      ...phaseContent,
      body: newBody,
      tasks: newTasks,
    },
  };

  return {
    ...spec,
    sections: newSections,
    phaseSections: newPhaseSections,
  };
}

/**
 * Generate the HTML for the spec panel webview.
 * Pure function — no vscode API dependency.
 *
 * @param trustModel  Optional SPEC-017 chart model. When provided, renders a
 *                    static inline-SVG trust chart section after the
 *                    classification section. No nonce required — SVG is static
 *                    (no <script>); CSP `style-src 'unsafe-inline'` covers any
 *                    <style> inside the SVG (SPEC-017 §Chart CSP-corrected note).
 */
export function getHtml(spec: ParsedSpec, classification?: ClassificationSummary, trustModel?: TrustChartModel): string {
  const { frontmatter, phaseSections } = spec;

  const phaseStepsHtml = PHASES.map(phase => {
    const status = frontmatter.phases[phase];
    const content = phaseSections[phase];
    const isActive = status === 'in-progress';
    const icon = getPhaseIcon(status);
    const label = phase.charAt(0).toUpperCase() + phase.slice(1);
    const statusLabel = getStatusLabel(status);
    const statusClass = `phase-status-${status.replace('-', '')}`;

    let tasksHtml = '';
    if (content && content.tasks.length > 0) {
      const doneCount = content.tasks.filter(t => t.done).length;
      const taskItems = content.tasks.map((task, idx) => {
        const checked = task.done ? 'checked' : '';
        return `<li class="task-item">
          <label>
            <input type="checkbox" ${checked} data-phase="${phase}" data-index="${idx}" aria-label="${escapeHtml(task.text)}" />
            <span class="${task.done ? 'task-done' : ''}">${escapeHtml(task.text)}</span>
          </label>
        </li>`;
      }).join('\n');

      tasksHtml = `<ul class="task-list" role="list" aria-label="${label} phase tasks, ${doneCount} of ${content.tasks.length} complete">${taskItems}</ul>`;
    }

    // Show body preview for non-task content (only for active/done phases with content)
    let bodyPreviewHtml = '';
    if (content && content.body.trim() && content.tasks.length === 0 && (isActive || status === 'done')) {
      const preview = content.body.trim().split('\n').slice(0, 3).join('\n');
      bodyPreviewHtml = `<div class="phase-body-preview">${escapeHtml(preview)}</div>`;
    }

    return `<div class="phase-step ${isActive ? 'active' : ''} ${statusClass}" role="region" aria-label="${label} phase, ${statusLabel}">
      <div class="phase-header">
        <span class="phase-icon" aria-hidden="true">${icon}</span>
        <span class="phase-label">${label}</span>
        <span class="phase-status ${statusClass}" aria-label="status: ${statusLabel}">${statusLabel}</span>
      </div>
      ${tasksHtml}
      ${bodyPreviewHtml}
    </div>`;
  }).join('\n');

  const classificationHtml = classification
    ? getClassificationHtml(classification)
    : '';

  // SPEC-017 Slice 6: static inline SVG chart — NO nonce needed (no <script>).
  // CSP `style-src 'unsafe-inline'` already covers the <style> inside the SVG.
  const chartHtml = trustModel ? getTrustChartHtml(trustModel) : '';

  const nonce = crypto.randomBytes(16).toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>MinSpec: Active Spec</title>
  <style>${getStyles()}</style>
</head>
<body>
  <div class="container" role="main">
    <header class="spec-header" role="banner">
      <h1 class="spec-title">${escapeHtml(frontmatter.title || frontmatter.id)}</h1>
      <div class="spec-meta" aria-label="Spec metadata">
        <span class="tier-badge tier-${frontmatter.tier.toLowerCase()}" aria-label="Tier ${frontmatter.tier}">${frontmatter.tier}</span>
        <span class="status-badge" aria-label="Status ${frontmatter.status}">${frontmatter.status}</span>
        <span class="spec-id">${escapeHtml(frontmatter.id)}</span>
      </div>
    </header>

    <section class="phase-stepper" aria-label="Spec phases" aria-live="polite">
      <h2>Phases</h2>
      ${phaseStepsHtml}
    </section>

    ${classificationHtml}
    ${chartHtml}
  </div>
  <script nonce="${nonce}">${getScript()}</script>
</body>
</html>`;
}

/**
 * Generate HTML for an error state.
 */
export function getErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    body {
      font-family: var(--vscode-font-family, sans-serif);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
      padding: 20px;
    }
    .error { color: var(--vscode-errorForeground, #f44); }
  </style>
</head>
<body>
  <p class="error" role="alert">${escapeHtml(message)}</p>
</body>
</html>`;
}

// --- HTML Helpers ---

function getPhaseIcon(status: string): string {
  switch (status) {
    case 'done': return '&#x2714;'; // checkmark
    case 'in-progress': return '&#x25C9;'; // filled circle
    case 'skipped': return '&#x2298;'; // circle with slash
    case 'pending':
    default: return '&#x25CB;'; // empty circle
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case 'done': return 'done';
    case 'in-progress': return 'active';
    case 'skipped': return 'skipped';
    case 'pending':
    default: return 'pending';
  }
}

function getClassificationHtml(classification: ClassificationSummary): string {
  const confidencePercent = Math.round(classification.confidence * 100);
  const signalsHtml = classification.signals.map(signal => {
    const value = typeof signal.value === 'boolean'
      ? (signal.value ? 'true' : 'false')
      : String(signal.value);
    return `<tr>
      <td class="signal-name">${escapeHtml(signal.name)}</td>
      <td class="signal-value">${value}</td>
      <td class="signal-tier">${signal.tierContribution}</td>
    </tr>`;
  }).join('\n');

  return `<section class="classification" aria-label="Classification results">
    <h2>Classification</h2>
    <div class="classification-summary">
      <span class="tier-badge tier-${classification.tier.toLowerCase()}" aria-label="Classified as tier ${classification.tier}">${classification.tier}</span>
      <span class="confidence" aria-label="${confidencePercent} percent confidence">${confidencePercent}% confidence</span>
    </div>
    <table class="signals-table" aria-label="Classification signals">
      <thead>
        <tr>
          <th scope="col">Signal</th>
          <th scope="col">Value</th>
          <th scope="col">Tier</th>
        </tr>
      </thead>
      <tbody>
        ${signalsHtml}
      </tbody>
    </table>
  </section>`;
}

/**
 * Wrap the inline-SVG chart in a styled section element.
 * The chart is static SVG — no <script>, no nonce.
 * SPEC-017 Slice 6, FR-10.
 */
function getTrustChartHtml(model: TrustChartModel): string {
  const svgContent = renderTrustChart(model);
  return `<section class="trust-chart" aria-label="Trust chart">
    <h2>Trust Metrics</h2>
    ${svgContent}
  </section>`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getStyles(): string {
  return `
    :root {
      --step-line-color: var(--vscode-panel-border, #444);
      --active-color: var(--vscode-focusBorder, #007acc);
      --done-color: var(--vscode-testing-iconPassed, #73c991);
      --skipped-color: var(--vscode-disabledForeground, #888);
      --pending-color: var(--vscode-disabledForeground, #666);
    }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
      padding: 16px;
      margin: 0;
      line-height: 1.5;
    }

    .container {
      max-width: 500px;
      margin: 0 auto;
    }

    h1, h2 {
      font-weight: 600;
      margin: 0 0 8px 0;
    }

    h1 { font-size: 1.3em; }
    h2 {
      font-size: 1em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground, #999);
      margin-top: 20px;
      margin-bottom: 12px;
    }

    .spec-header {
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }

    .spec-title {
      margin-bottom: 6px;
    }

    .spec-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .tier-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 0.85em;
      font-weight: 600;
    }

    .tier-t1 { background: var(--vscode-testing-iconPassed, #73c991); color: #000; }
    .tier-t2 { background: var(--vscode-charts-blue, #3794ff); color: #000; }
    .tier-t3 { background: var(--vscode-charts-orange, #cca700); color: #000; }
    .tier-t4 { background: var(--vscode-charts-red, #f14c4c); color: #fff; }

    .status-badge {
      font-size: 0.85em;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
    }

    .spec-id {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground, #888);
    }

    /* Phase Stepper */
    .phase-stepper {
      position: relative;
    }

    .phase-step {
      position: relative;
      padding: 8px 12px 8px 36px;
      margin-bottom: 2px;
      border-radius: 4px;
    }

    .phase-step:not(:last-child)::before {
      content: '';
      position: absolute;
      left: 18px;
      top: 30px;
      bottom: -6px;
      width: 2px;
      background: var(--step-line-color);
    }

    .phase-step.active {
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
    }

    .phase-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .phase-icon {
      position: absolute;
      left: 10px;
      font-size: 1.2em;
      line-height: 1;
    }

    .phase-status-done .phase-icon { color: var(--done-color); }
    .phase-status-inprogress .phase-icon { color: var(--active-color); }
    .phase-status-skipped .phase-icon { color: var(--skipped-color); }
    .phase-status-pending .phase-icon { color: var(--pending-color); }

    .phase-label {
      font-weight: 500;
      flex: 1;
    }

    .phase-status {
      font-size: 0.8em;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .phase-status-done { color: var(--done-color); }
    .phase-status-inprogress { color: var(--active-color); }
    .phase-status-skipped { color: var(--skipped-color); }
    .phase-status-pending { color: var(--pending-color); }

    /* Task List */
    .task-list {
      list-style: none;
      padding: 4px 0 4px 4px;
      margin: 4px 0 0 0;
    }

    .task-item {
      padding: 3px 0;
    }

    .task-item label {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      cursor: pointer;
    }

    .task-item input[type="checkbox"] {
      margin-top: 2px;
      cursor: pointer;
    }

    .task-done {
      text-decoration: line-through;
      opacity: 0.7;
    }

    /* Body preview */
    .phase-body-preview {
      margin-top: 4px;
      padding: 6px 8px;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground, #999);
      background: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.03));
      border-radius: 3px;
      white-space: pre-wrap;
      overflow: hidden;
      max-height: 60px;
    }

    /* Classification */
    .classification {
      margin-top: 20px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border, #333);
    }

    .classification-summary {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }

    .confidence {
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground, #999);
    }

    .signals-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9em;
    }

    .signals-table th,
    .signals-table td {
      padding: 4px 8px;
      text-align: left;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }

    .signals-table th {
      color: var(--vscode-descriptionForeground, #999);
      font-weight: 500;
      font-size: 0.9em;
      text-transform: uppercase;
    }

    .signal-name {
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .signal-tier {
      font-weight: 600;
    }

    /* Trust chart section (SPEC-017 Slice 6) */
    .trust-chart {
      margin-top: 20px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border, #333);
      overflow-x: auto;
    }
  `;
}

function getScript(): string {
  return `
    (function() {
      const vscode = acquireVsCodeApi();

      document.addEventListener('change', function(e) {
        const target = e.target;
        if (target.tagName === 'INPUT' && target.type === 'checkbox') {
          const phase = target.getAttribute('data-phase');
          const index = parseInt(target.getAttribute('data-index'), 10);
          const done = target.checked;

          vscode.postMessage({
            command: 'toggleTask',
            phase: phase,
            taskIndex: index,
            done: done
          });
        }
      });
    })();
  `;
}
