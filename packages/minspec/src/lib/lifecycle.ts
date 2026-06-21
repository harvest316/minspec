/**
 * Spec Lifecycle State Machine — Phase 3.1
 *
 * Pure logic module governing spec phase transitions.
 * No filesystem, no VS Code API — just state transitions and validation.
 *
 * Phase order: specify → clarify → plan → tasks → implement
 * Spec status: new | specifying | implementing | done | archived
 */

import type { Phase } from './config';
import { PHASES } from './config';
import type { PhaseStatus, SpecStatus } from './spec';

// Re-export so consumers can import from either module
export type { PhaseStatus, SpecStatus };

/** Map of phase → status */
export interface PhaseState {
  [phase: string]: PhaseStatus;
}

/** Result of a state transition attempt */
export interface TransitionResult {
  success: boolean;
  newPhases: PhaseState;
  newStatus: SpecStatus;
  warning?: string;
}

// --- Core Functions ---

/**
 * Create initial phase state — all phases pending.
 */
export function createInitialPhases(): PhaseState {
  const phases: PhaseState = {};
  for (const phase of PHASES) {
    phases[phase] = 'pending';
  }
  return phases;
}

/**
 * Determine the current active phase (first non-done, non-skipped phase).
 * Returns null if all phases are done/skipped (spec is complete).
 */
export function getCurrentPhase(phases: PhaseState): Phase | null {
  for (const phase of PHASES) {
    const status = phases[phase];
    if (status === 'in-progress') {
      return phase;
    }
  }
  // If no phase is in-progress, find the first pending phase
  for (const phase of PHASES) {
    const status = phases[phase];
    if (status === 'pending') {
      return phase;
    }
  }
  return null;
}

/**
 * Derive the overall spec status from phase states.
 *
 * Rules:
 * - All phases pending → 'new'
 * - All phases done/skipped → 'done'
 * - Current phase is specify or clarify → 'specifying'
 * - Current phase is plan, tasks, or implement → 'implementing'
 * - (archived is set explicitly, not derived from phases)
 */
export function getSpecStatus(phases: PhaseState): SpecStatus {
  let allPending = true;
  let allComplete = true; // done or skipped

  for (const phase of PHASES) {
    const status = phases[phase];
    if (status !== 'pending') {
      allPending = false;
    }
    if (status === 'pending' || status === 'in-progress') {
      allComplete = false;
    }
  }

  if (allPending) return 'new';
  if (allComplete) return 'done';

  // Determine which sub-status based on current phase
  const current = getCurrentPhase(phases);
  if (current === 'specify' || current === 'clarify') return 'specifying';
  return 'implementing';
}

/**
 * Phase map after approving a spec for implementation (#148). Approval moves a
 * spec out of the *specifying* band into the *implementing* band; this returns the
 * phase map that makes `getSpecStatus` derive `implementing`, so the literal
 * `status:` line and the `phases:` map cannot disagree (the #148 desync, where
 * approval rewrote only the status line and left a stale phases map deriving
 * `specifying`).
 *
 * Transition:
 *  - specifying band (specify, clarify): `pending`/`in-progress` → `done`. A
 *    `skipped` phase is preserved — a deliberate skip is not a completion.
 *  - implementing band (plan → tasks → implement): the first phase that is NOT
 *    already `done`/`skipped` becomes `in-progress` (the new current phase).
 *    Already-done/skipped phases are left untouched.
 *
 * Precondition: callers approve only from the specifying band (status new/
 * specifying), so at least one implementing-band phase is non-done — the result
 * always derives `implementing`. Pure: no fs, no mutation of the input.
 */
export function phasesForApproval(phases: PhaseState): PhaseState {
  const next: PhaseState = { ...phases };
  for (const p of ['specify', 'clarify'] as Phase[]) {
    if (next[p] !== 'skipped') next[p] = 'done';
  }
  for (const p of ['plan', 'tasks', 'implement'] as Phase[]) {
    if (next[p] === 'done' || next[p] === 'skipped') continue;
    next[p] = 'in-progress';
    break;
  }
  return next;
}

/**
 * Get the index of a phase in the ordered PHASES array.
 * Returns -1 if not found.
 */
function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase);
}

/**
 * Advance to the next phase. Marks current phase as 'done' and next as 'in-progress'.
 *
 * Rules:
 * - If currentPhase is 'pending', sets it to 'in-progress' (start phase).
 * - If currentPhase is 'in-progress', marks it 'done' and advances next to 'in-progress'.
 * - Cannot advance past 'implement' (the last phase).
 * - Only advances one phase at a time.
 */
export function advancePhase(phases: PhaseState, currentPhase: Phase): TransitionResult {
  const idx = phaseIndex(currentPhase);
  if (idx === -1) {
    return {
      success: false,
      newPhases: { ...phases },
      newStatus: getSpecStatus(phases),
      warning: `Unknown phase: ${currentPhase}`,
    };
  }

  const currentStatus = phases[currentPhase];
  const newPhases = { ...phases };

  if (currentStatus === 'pending') {
    // Start this phase
    newPhases[currentPhase] = 'in-progress';
    return {
      success: true,
      newPhases,
      newStatus: getSpecStatus(newPhases),
    };
  }

  if (currentStatus === 'in-progress') {
    // Complete this phase and start next
    newPhases[currentPhase] = 'done';

    // Find the next pending phase (skip already done/skipped phases)
    const nextIdx = idx + 1;
    if (nextIdx < PHASES.length) {
      const nextPhase = PHASES[nextIdx];
      if (newPhases[nextPhase] === 'pending') {
        newPhases[nextPhase] = 'in-progress';
      }
    }

    return {
      success: true,
      newPhases,
      newStatus: getSpecStatus(newPhases),
    };
  }

  // Phase is already done or skipped — cannot advance from it
  return {
    success: false,
    newPhases: { ...phases },
    newStatus: getSpecStatus(phases),
    warning: `Phase '${currentPhase}' is already ${currentStatus} — cannot advance`,
  };
}

/**
 * Skip a phase, recording a reason.
 *
 * Rules:
 * - Reason must be non-empty.
 * - Phase must be 'pending' or 'in-progress' to be skipped.
 * - Already done/skipped phases cannot be re-skipped.
 */
export function skipPhase(phases: PhaseState, phase: Phase, reason: string): TransitionResult {
  if (!reason || reason.trim() === '') {
    return {
      success: false,
      newPhases: { ...phases },
      newStatus: getSpecStatus(phases),
      warning: 'Skip requires a non-empty reason',
    };
  }

  const idx = phaseIndex(phase);
  if (idx === -1) {
    return {
      success: false,
      newPhases: { ...phases },
      newStatus: getSpecStatus(phases),
      warning: `Unknown phase: ${phase}`,
    };
  }

  const currentStatus = phases[phase];
  if (currentStatus === 'done' || currentStatus === 'skipped') {
    return {
      success: false,
      newPhases: { ...phases },
      newStatus: getSpecStatus(phases),
      warning: `Phase '${phase}' is already ${currentStatus} — cannot skip`,
    };
  }

  const newPhases = { ...phases };
  newPhases[phase] = 'skipped';

  // If there's a next pending phase, start it
  const nextIdx = idx + 1;
  if (nextIdx < PHASES.length) {
    const nextPhase = PHASES[nextIdx];
    if (newPhases[nextPhase] === 'pending') {
      newPhases[nextPhase] = 'in-progress';
    }
  }

  return {
    success: true,
    newPhases,
    newStatus: getSpecStatus(newPhases),
  };
}

/**
 * Go back to a previous phase, reopening it.
 *
 * Rules:
 * - Sets the target phase to 'in-progress'.
 * - All phases AFTER the target are reset to 'pending' (invalidates downstream work).
 * - Always produces a warning about invalidating downstream phases.
 * - Reason must be non-empty.
 */
export function goBackToPhase(phases: PhaseState, targetPhase: Phase, reason: string): TransitionResult {
  if (!reason || reason.trim() === '') {
    return {
      success: false,
      newPhases: { ...phases },
      newStatus: getSpecStatus(phases),
      warning: 'Going back requires a non-empty reason',
    };
  }

  const idx = phaseIndex(targetPhase);
  if (idx === -1) {
    return {
      success: false,
      newPhases: { ...phases },
      newStatus: getSpecStatus(phases),
      warning: `Unknown phase: ${targetPhase}`,
    };
  }

  const newPhases = { ...phases };

  // Set target phase to in-progress
  newPhases[targetPhase] = 'in-progress';

  // Reset all downstream phases to pending
  for (let i = idx + 1; i < PHASES.length; i++) {
    newPhases[PHASES[i]] = 'pending';
  }

  // Build list of invalidated phases for the warning
  const invalidated = PHASES.slice(idx + 1);
  const invalidatedNames = invalidated.length > 0 ? invalidated.join(', ') : 'none';

  return {
    success: true,
    newPhases,
    newStatus: getSpecStatus(newPhases),
    warning: `Reopening '${targetPhase}' invalidates downstream phases: ${invalidatedNames}`,
  };
}

/**
 * Archive the spec from any state.
 *
 * Rules:
 * - Always succeeds regardless of current phase states.
 * - Returns 'archived' as the spec status.
 * - Phase states are preserved (for historical reference).
 */
export function archiveSpec(phases: PhaseState): TransitionResult {
  return {
    success: true,
    newPhases: { ...phases },
    newStatus: 'archived',
  };
}
