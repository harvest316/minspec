/**
 * Spec Lifecycle State Machine — Phase 3.1
 *
 * Pure logic module governing spec phase transitions.
 * No filesystem, no VS Code API — just state transitions and validation.
 *
 * Phase order: specify → clarify → plan → tasks → implement
 * Spec status: new | active | done | archived
 */

import type { Phase } from './config';
import { PHASES } from './config';

// --- Types ---

/** Status of an individual phase within the lifecycle */
export type PhaseStatus = 'pending' | 'in-progress' | 'done' | 'skipped';

/** Overall status of the spec (derived from phase states) */
export type SpecStatus = 'new' | 'active' | 'done' | 'archived';

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
 * - Any phase in-progress → 'active'
 * - All phases done/skipped (none pending or in-progress) → 'done'
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
  return 'active';
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
