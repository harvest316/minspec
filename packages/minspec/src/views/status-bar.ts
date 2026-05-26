/**
 * MinSpec Status Bar — Phase 4.3
 *
 * Shows tier | active phase | progress in the VS Code status bar.
 * Click opens the active spec panel (via minspec.status command).
 *
 * Format (from design.md):
 *   $(shield) MinSpec: T2 | Specify -> Plan -> Tasks | 2/5 done
 *
 * Updates on spec transitions, task completions, and spec file changes.
 */

import * as vscode from 'vscode';
import type { SpecFrontmatter, PhaseStatus } from '../lib/spec';
import type { Phase } from '../lib/config';
import { PHASES } from '../lib/config';

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
export function formatPhasePipeline(phases: Record<Phase, PhaseStatus>): string {
  return PHASES.map(p => capitalize(p)).join(' -> ');
}

/**
 * Compute progress string from phases map.
 * Counts done + skipped phases out of total.
 * Returns format like "2/5 done".
 */
export function computeProgress(phases: Record<Phase, PhaseStatus>): string {
  let completed = 0;
  for (const phase of PHASES) {
    const status = phases[phase];
    if (status === 'done' || status === 'skipped') {
      completed++;
    }
  }
  return `${completed}/${PHASES.length} done`;
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
  const progress = computeProgress(spec.phases);
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
    this.statusBarItem.show();
  }

  /** Clean up resources */
  dispose(): void {
    this.statusBarItem.dispose();
  }
}
