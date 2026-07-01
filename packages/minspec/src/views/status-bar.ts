/**
 * MinSpec Status Bar — Phase 4.3
 *
 * Shows tier | active phase | progress in the VS Code status bar.
 * Click opens the active spec panel (via minspec.status command).
 *
 * Format (from design.md):
 *   $(shield) MinSpec: T2 | Specify -> Plan -> Tasks | · 50%
 *
 * Updates on spec transitions, task completions, and spec file changes.
 */

import * as vscode from 'vscode';
import type { NextTask } from '@aiclarity/shared';
import type { SpecFrontmatter, PhaseStatus } from '../lib/spec';
import type { Phase, Tier } from '../lib/config';
import { PHASES, DEFAULT_CONFIG } from '../lib/config';

/** Lightweight summary passed to the status bar for display */
export interface StatusBarSpec {
  readonly id: string;
  readonly title: string;
  readonly tier: string;
  readonly currentPhase: Phase | null;
  readonly phases: Record<Phase, PhaseStatus>;
}

/**
 * Build a StatusBarSpec from a SpecFrontmatter.
 * Determines the current phase from the phases map.
 */
export function fromFrontmatter(fm: SpecFrontmatter): StatusBarSpec {
  let currentPhase: Phase | null = null;
  // First check for in-progress
  for (const phase of PHASES) {
    if (fm.phases[phase] === 'in-progress') {
      currentPhase = phase;
      break;
    }
  }
  // If none in-progress, find first pending
  if (!currentPhase) {
    for (const phase of PHASES) {
      if (fm.phases[phase] === 'pending') {
        currentPhase = phase;
        break;
      }
    }
  }

  return {
    id: fm.id,
    title: fm.title,
    tier: fm.tier,
    currentPhase,
    phases: fm.phases,
  };
}

/** Capitalize first letter of a phase name for display */
function capitalize(phase: string): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

/**
 * Build the phase pipeline display string.
 * Shows phases joined by arrows, with the current phase highlighted.
 * Example: "Specify -> Plan -> Tasks"
 */
export function formatPhasePipeline(_phases: Record<Phase, PhaseStatus>): string {
  return PHASES.map(p => capitalize(p)).join(' -> ');
}

/**
 * Compute a tier-aware completion percentage from a phases map (#38).
 *
 * When `tier` is given, the denominator is the phases that tier *requires*
 * (DR-362 `phaseProgress` logic, replicated locally) — so a T1 spec reads 100%
 * once `specify` is done, while a T4 needs all five phases. This is what the
 * status bar passes. When `tier` is omitted, the denominator is the full
 * five-phase pipeline (the legacy whole-pipeline semantics, preserved for
 * non-tier callers). Done + skipped count as completed. Returns the progress
 * token "· N%" — no redundant " done" suffix (#97).
 */
export function computeProgress(
  phases: Record<Phase, PhaseStatus>,
  tier?: string,
): string {
  const required: readonly Phase[] =
    tier === undefined
      ? PHASES
      : DEFAULT_CONFIG.phaseMappings[tier as Tier]?.requiredPhases ?? ['specify'];
  let completed = 0;
  for (const phase of required) {
    const status = phases[phase];
    if (status === 'done' || status === 'skipped') {
      completed++;
    }
  }
  const pct = required.length === 0 ? 0 : Math.round((completed / required.length) * 100);
  return `· ${pct}%`;
}

/**
 * Format the full status bar text.
 * Returns null-spec text when no spec is active,
 * or the full "tier | phase | progress" format otherwise.
 */
export function formatStatusBarText(spec: StatusBarSpec | null): string {
  if (!spec) {
    return '$(shield) MinSpec: No active spec';
  }

  const phaseName = spec.currentPhase ? capitalize(spec.currentPhase) : 'Done';
  const progress = computeProgress(spec.phases, spec.tier);
  return `$(shield) MinSpec: ${spec.tier} | ${phaseName} | ${progress}`;
}

/**
 * Format the tooltip text.
 * Shows spec ID and title for quick identification.
 */
export function formatTooltip(spec: StatusBarSpec | null): string {
  if (!spec) {
    return 'No active spec. Click to select one.';
  }
  return `${spec.id}: ${spec.title}`;
}

export class MinSpecStatusBar {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBarItem.command = 'minspec.status';
  }

  /**
   * Update the status bar display.
   * Pass null to show "No active spec".
   */
  update(spec: StatusBarSpec | null): void {
    this.statusBarItem.text = formatStatusBarText(spec);
    this.statusBarItem.tooltip = formatTooltip(spec);
    this.statusBarItem.accessibilityInformation = {
      label: spec
        ? `MinSpec: ${spec.id}, tier ${spec.tier}, phase ${spec.currentPhase ?? 'done'}, ${computeProgress(spec.phases, spec.tier)}`
        : 'MinSpec: No active spec',
    };
    this.statusBarItem.show();
  }

  /** Clean up resources */
  dispose(): void {
    this.statusBarItem.dispose();
  }
}

// ─── Next-Task signpost status bar (SPEC-012 / DR-019) ──────────────────────

/**
 * Format the next-task status bar text. A dedicated, workspace-wide signpost
 * item (distinct from the per-spec progress item above): it shows the single
 * next HUMAN review imperative, or a clear ✓ when the queue is empty.
 *   null → '$(check) MinSpec: clear'
 *   task → '$(arrow-right) MinSpec: <imperative>'   e.g. "Approve SPEC-001"
 */
export function formatNextTaskText(task: NextTask | null): string {
  if (!task) return '$(check) MinSpec: clear';
  return `$(arrow-right) MinSpec: ${task.imperative}`;
}

/**
 * The workspace-wide next-task signpost. Clicking it (or the `minspec.nextTask`
 * chord) reveals the target artifact and shows the imperative. The displayed
 * `NextTask` is cached by the caller and only recomputed on debounced file
 * events — `update()` itself never rebuilds the graph (keep it cheap).
 */
export class MinSpecNextTaskStatusBar {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99, // just left of the per-spec progress item (priority 100)
    );
    this.statusBarItem.command = 'minspec.nextTask';
  }

  /** Update the signpost. Pass null to show the "clear" state. */
  update(task: NextTask | null): void {
    const text = formatNextTaskText(task);
    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = task
      ? task.evidence.explanation
      : 'No pending review tasks.';
    this.statusBarItem.accessibilityInformation = {
      label: task ? `MinSpec next task: ${task.imperative}` : 'MinSpec: no pending review tasks',
    };
    this.statusBarItem.show();
  }

  /** Clean up resources */
  dispose(): void {
    this.statusBarItem.dispose();
  }
}
