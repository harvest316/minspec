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
import type { ApprovalStatus } from './approval';

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

/** True when every phase is `pending` (the spec has not been started). */
function allPending(phases: PhaseState): boolean {
  for (const phase of PHASES) {
    if (phases[phase] !== 'pending') return false;
  }
  return true;
}

/** True when every phase is complete (`done` or `skipped`). */
function allRequiredDone(phases: PhaseState): boolean {
  for (const phase of PHASES) {
    const status = phases[phase];
    if (status === 'pending' || status === 'in-progress') return false;
  }
  return true;
}

/**
 * The explicit-terminal class (SPEC-022 / DR-034 FR-4, INV-6): a terminal status
 * that is a HUMAN ACT, never inferred from phases. `archived` is the v1 terminal;
 * `superseded` (SPEC-017 / #162) joins it now that SpecStatus carries it. Both
 * slot into the same `if (explicitTerminal) return explicitTerminal;` seam below,
 * before any phase/approval check (INV-6 — never inferred). `undefined` means
 * "no explicit terminal — derive from {phases, approval}".
 */
export type ExplicitTerminal = 'archived' | 'superseded' | undefined;

/**
 * Derive the overall spec status — the SINGLE source of truth (SPEC-022 FR-4).
 * Encodes the FR-4 rules table exactly:
 *
 *   | explicitTerminal set (archived) | that terminal (human act, INV-6)        |
 *   | all phases pending              | new                                     |
 *   | not approved                    | specifying (unapproved cannot pass, INV-1) |
 *   | approved + all required done    | done (v1: implement-phase signal, #116) |
 *   | approved + implement in progress| implementing                           |
 *
 * The gate and validator read THIS, never the literal `status:` line — so
 * `implementing`/`done` is structurally impossible without a current approval
 * record (the enforced #112 fix). `getSpecStatus` below is a preview-only shim.
 */
export function deriveStatus(
  phases: PhaseState,
  approvalState: ApprovalStatus,
  explicitTerminal: ExplicitTerminal,
): SpecStatus {
  if (explicitTerminal) return explicitTerminal; // INV-6 — human act, never inferred
  if (allPending(phases)) return 'new';
  if (approvalState !== 'approved') return 'specifying'; // INV-1 — unapproved cannot pass
  if (allRequiredDone(phases)) return 'done'; // v1: see #116 deferral (implement-phase signal)
  return 'implementing';
}

/**
 * Phases-only status derivation — PREVIEW-ONLY (SPEC-022). Used by the pure
 * transition helpers (`advancePhase`/`skipPhase`/`goBackToPhase`) for their
 * `newStatus` preview field: they model a *transition*, not the authoritative
 * spec status, and have no approval verdict to hand. The gate and validator use
 * the approval-aware `deriveStatus` instead.
 *
 * Rules (unchanged from the legacy behaviour, modeled as "approved" so the
 * implementing/done previews still render):
 * - All phases pending → 'new'
 * - All phases done/skipped → 'done'
 * - Current phase is specify or clarify → 'specifying'
 * - Current phase is plan, tasks, or implement → 'implementing'
 * - (archived is set explicitly, not derived from phases)
 */
export function getSpecStatus(phases: PhaseState): SpecStatus {
  if (allPending(phases)) return 'new';
  if (allRequiredDone(phases)) return 'done';
  const current = getCurrentPhase(phases);
  if (current === 'specify' || current === 'clarify') return 'specifying';
  return 'implementing';
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
