import { describe, it, expect } from 'vitest';
import {
  createInitialPhases,
  getCurrentPhase,
  getSpecStatus,
  advancePhase,
  skipPhase,
  goBackToPhase,
  archiveSpec,
} from '../src/lib/lifecycle';
import type { PhaseState } from '../src/lib/lifecycle';
import { PHASES } from '../src/lib/config';

// --- Helpers ---

/** Create a phase state with specific statuses */
function makePhases(overrides: Partial<Record<string, string>> = {}): PhaseState {
  const base = createInitialPhases();
  return { ...base, ...overrides };
}

// =============================================================================
// T0 INVARIANT TESTS — These MUST pass. They encode the state machine contract.
// =============================================================================

describe('T0 Invariants — Lifecycle State Machine', () => {
  it('Invariant 1: Forward transition only advances one phase at a time', () => {
    // Start with specify in-progress
    const phases = makePhases({ specify: 'in-progress' });

    // Advance specify → done, clarify → in-progress
    const result = advancePhase(phases, 'specify');
    expect(result.success).toBe(true);
    expect(result.newPhases.specify).toBe('done');
    expect(result.newPhases.clarify).toBe('in-progress');
    // plan/tasks/implement must still be pending
    expect(result.newPhases.plan).toBe('pending');
    expect(result.newPhases.tasks).toBe('pending');
    expect(result.newPhases.implement).toBe('pending');
  });

  it('Invariant 2: Skip requires a non-empty reason string', () => {
    const phases = makePhases({ specify: 'in-progress', clarify: 'pending' });

    // Empty string fails
    const result1 = skipPhase(phases, 'clarify', '');
    expect(result1.success).toBe(false);
    expect(result1.warning).toContain('non-empty reason');

    // Whitespace-only fails
    const result2 = skipPhase(phases, 'clarify', '   ');
    expect(result2.success).toBe(false);
    expect(result2.warning).toContain('non-empty reason');

    // Valid reason succeeds
    const result3 = skipPhase(phases, 'clarify', 'T1 — trivial change');
    expect(result3.success).toBe(true);
  });

  it('Invariant 3: Going back sets all downstream phases to pending', () => {
    // Spec is at implement phase with everything before done
    const phases = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'done',
      tasks: 'done',
      implement: 'in-progress',
    });

    // Go back to clarify
    const result = goBackToPhase(phases, 'clarify', 'requirements changed');
    expect(result.success).toBe(true);
    expect(result.newPhases.specify).toBe('done'); // upstream preserved
    expect(result.newPhases.clarify).toBe('in-progress'); // target reopened
    expect(result.newPhases.plan).toBe('pending'); // downstream reset
    expect(result.newPhases.tasks).toBe('pending'); // downstream reset
    expect(result.newPhases.implement).toBe('pending'); // downstream reset
  });

  it('Invariant 4: Going back produces a warning about invalidating downstream work', () => {
    const phases = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'done',
      tasks: 'in-progress',
    });

    const result = goBackToPhase(phases, 'specify', 'rethinking approach');
    expect(result.success).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('invalidates downstream');
    expect(result.warning).toContain('clarify');
    expect(result.warning).toContain('plan');
    expect(result.warning).toContain('tasks');
    expect(result.warning).toContain('implement');
  });

  it('Invariant 5: Archive is always allowed regardless of current state', () => {
    // From new (all pending)
    const newPhases = createInitialPhases();
    expect(archiveSpec(newPhases).success).toBe(true);
    expect(archiveSpec(newPhases).newStatus).toBe('archived');

    // From active (mid-workflow)
    const activePhases = makePhases({ specify: 'done', clarify: 'in-progress' });
    expect(archiveSpec(activePhases).success).toBe(true);
    expect(archiveSpec(activePhases).newStatus).toBe('archived');

    // From done (all completed)
    const donePhases = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'done',
      tasks: 'done',
      implement: 'done',
    });
    expect(archiveSpec(donePhases).success).toBe(true);
    expect(archiveSpec(donePhases).newStatus).toBe('archived');

    // With skipped phases
    const skippedPhases = makePhases({
      specify: 'done',
      clarify: 'skipped',
      plan: 'skipped',
      tasks: 'done',
      implement: 'done',
    });
    expect(archiveSpec(skippedPhases).success).toBe(true);
    expect(archiveSpec(skippedPhases).newStatus).toBe('archived');
  });

  it('Invariant 6: A spec with all phases done/skipped has status done', () => {
    // All done
    const allDone = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'done',
      tasks: 'done',
      implement: 'done',
    });
    expect(getSpecStatus(allDone)).toBe('done');

    // Mix of done and skipped
    const mixed = makePhases({
      specify: 'done',
      clarify: 'skipped',
      plan: 'skipped',
      tasks: 'done',
      implement: 'done',
    });
    expect(getSpecStatus(mixed)).toBe('done');

    // All skipped (edge case — still counts as done)
    const allSkipped = makePhases({
      specify: 'skipped',
      clarify: 'skipped',
      plan: 'skipped',
      tasks: 'skipped',
      implement: 'skipped',
    });
    expect(getSpecStatus(allSkipped)).toBe('done');
  });

  it('Invariant 7: A spec with any phase in-progress has status active', () => {
    const phases1 = makePhases({ specify: 'in-progress' });
    expect(getSpecStatus(phases1)).toBe('active');

    const phases2 = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'in-progress',
    });
    expect(getSpecStatus(phases2)).toBe('active');

    const phases3 = makePhases({
      specify: 'done',
      clarify: 'skipped',
      plan: 'done',
      tasks: 'done',
      implement: 'in-progress',
    });
    expect(getSpecStatus(phases3)).toBe('active');
  });

  it('Invariant 8: A freshly created spec has all phases pending and status new', () => {
    const phases = createInitialPhases();

    for (const phase of PHASES) {
      expect(phases[phase]).toBe('pending');
    }
    expect(getSpecStatus(phases)).toBe('new');
  });

  it('Invariant 9: Cannot advance past implement (last phase)', () => {
    const phases = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'done',
      tasks: 'done',
      implement: 'in-progress',
    });

    // Advancing implement marks it done (no next phase to start)
    const result = advancePhase(phases, 'implement');
    expect(result.success).toBe(true);
    expect(result.newPhases.implement).toBe('done');
    expect(result.newStatus).toBe('done');

    // No phase should be in-progress after final advance
    for (const phase of PHASES) {
      expect(result.newPhases[phase]).not.toBe('in-progress');
    }
  });

  it('Invariant 10: Phase order is always specify → clarify → plan → tasks → implement', () => {
    expect(PHASES).toEqual(['specify', 'clarify', 'plan', 'tasks', 'implement']);
    expect(PHASES).toHaveLength(5);
  });
});

// =============================================================================
// T2 FEATURE TESTS — Happy path + primary failure scenarios
// =============================================================================

describe('advancePhase()', () => {
  it('starts first phase from pending', () => {
    const phases = createInitialPhases();
    const result = advancePhase(phases, 'specify');
    expect(result.success).toBe(true);
    expect(result.newPhases.specify).toBe('in-progress');
    expect(result.newStatus).toBe('active');
  });

  it('completes a phase and starts the next', () => {
    const phases = makePhases({ specify: 'in-progress' });
    const result = advancePhase(phases, 'specify');
    expect(result.success).toBe(true);
    expect(result.newPhases.specify).toBe('done');
    expect(result.newPhases.clarify).toBe('in-progress');
  });

  it('fails to advance an already-done phase', () => {
    const phases = makePhases({ specify: 'done', clarify: 'in-progress' });
    const result = advancePhase(phases, 'specify');
    expect(result.success).toBe(false);
    expect(result.warning).toContain('already done');
  });

  it('fails to advance an already-skipped phase', () => {
    const phases = makePhases({ specify: 'done', clarify: 'skipped', plan: 'in-progress' });
    const result = advancePhase(phases, 'clarify');
    expect(result.success).toBe(false);
    expect(result.warning).toContain('already skipped');
  });

  it('does not modify original phase state (immutability)', () => {
    const phases = makePhases({ specify: 'in-progress' });
    const original = { ...phases };
    advancePhase(phases, 'specify');
    expect(phases).toEqual(original);
  });

  it('advances through a full lifecycle', () => {
    let phases = createInitialPhases();

    // Start → specify
    let result = advancePhase(phases, 'specify');
    expect(result.success).toBe(true);
    phases = result.newPhases;

    // specify done → clarify starts
    result = advancePhase(phases, 'specify');
    expect(result.success).toBe(true);
    phases = result.newPhases;
    expect(phases.specify).toBe('done');
    expect(phases.clarify).toBe('in-progress');

    // clarify done → plan starts
    result = advancePhase(phases, 'clarify');
    phases = result.newPhases;
    expect(phases.plan).toBe('in-progress');

    // plan done → tasks starts
    result = advancePhase(phases, 'plan');
    phases = result.newPhases;
    expect(phases.tasks).toBe('in-progress');

    // tasks done → implement starts
    result = advancePhase(phases, 'tasks');
    phases = result.newPhases;
    expect(phases.implement).toBe('in-progress');

    // implement done → all done
    result = advancePhase(phases, 'implement');
    phases = result.newPhases;
    expect(phases.implement).toBe('done');
    expect(result.newStatus).toBe('done');
  });
});

describe('skipPhase()', () => {
  it('skips a pending phase and starts the next', () => {
    const phases = makePhases({ specify: 'done', clarify: 'pending' });
    const result = skipPhase(phases, 'clarify', 'T1 — trivial');
    expect(result.success).toBe(true);
    expect(result.newPhases.clarify).toBe('skipped');
    expect(result.newPhases.plan).toBe('in-progress');
  });

  it('skips an in-progress phase and starts the next', () => {
    const phases = makePhases({ specify: 'done', clarify: 'in-progress' });
    const result = skipPhase(phases, 'clarify', 'Not needed for this spec');
    expect(result.success).toBe(true);
    expect(result.newPhases.clarify).toBe('skipped');
    expect(result.newPhases.plan).toBe('in-progress');
  });

  it('cannot skip a phase that is already done', () => {
    const phases = makePhases({ specify: 'done', clarify: 'in-progress' });
    const result = skipPhase(phases, 'specify', 'oops');
    expect(result.success).toBe(false);
    expect(result.warning).toContain('already done');
  });

  it('cannot skip a phase that is already skipped', () => {
    const phases = makePhases({ specify: 'done', clarify: 'skipped', plan: 'in-progress' });
    const result = skipPhase(phases, 'clarify', 'trying again');
    expect(result.success).toBe(false);
    expect(result.warning).toContain('already skipped');
  });

  it('skipping the last phase completes the spec', () => {
    const phases = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'done',
      tasks: 'done',
      implement: 'pending',
    });
    const result = skipPhase(phases, 'implement', 'no code needed');
    expect(result.success).toBe(true);
    expect(result.newStatus).toBe('done');
  });

  it('does not modify original phase state (immutability)', () => {
    const phases = makePhases({ specify: 'done', clarify: 'pending' });
    const original = { ...phases };
    skipPhase(phases, 'clarify', 'reason');
    expect(phases).toEqual(original);
  });
});

describe('goBackToPhase()', () => {
  it('reopens a completed phase', () => {
    const phases = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'in-progress',
    });
    const result = goBackToPhase(phases, 'specify', 'scope changed');
    expect(result.success).toBe(true);
    expect(result.newPhases.specify).toBe('in-progress');
  });

  it('resets downstream phases to pending', () => {
    const phases = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'done',
      tasks: 'done',
      implement: 'in-progress',
    });
    const result = goBackToPhase(phases, 'plan', 'design flaw found');
    expect(result.success).toBe(true);
    expect(result.newPhases.specify).toBe('done');
    expect(result.newPhases.clarify).toBe('done');
    expect(result.newPhases.plan).toBe('in-progress');
    expect(result.newPhases.tasks).toBe('pending');
    expect(result.newPhases.implement).toBe('pending');
  });

  it('fails without a reason', () => {
    const phases = makePhases({ specify: 'done', clarify: 'in-progress' });
    const result = goBackToPhase(phases, 'specify', '');
    expect(result.success).toBe(false);
    expect(result.warning).toContain('non-empty reason');
  });

  it('going back to the last phase resets nothing downstream', () => {
    const phases = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'done',
      tasks: 'done',
      implement: 'done',
    });
    const result = goBackToPhase(phases, 'implement', 'found a bug');
    expect(result.success).toBe(true);
    expect(result.newPhases.implement).toBe('in-progress');
    // Warning should still mention downstream (even if empty list)
    expect(result.warning).toBeDefined();
  });

  it('going back to first phase resets everything downstream', () => {
    const phases = makePhases({
      specify: 'done',
      clarify: 'skipped',
      plan: 'done',
      tasks: 'done',
      implement: 'done',
    });
    const result = goBackToPhase(phases, 'specify', 'starting over');
    expect(result.success).toBe(true);
    expect(result.newPhases.specify).toBe('in-progress');
    expect(result.newPhases.clarify).toBe('pending');
    expect(result.newPhases.plan).toBe('pending');
    expect(result.newPhases.tasks).toBe('pending');
    expect(result.newPhases.implement).toBe('pending');
  });

  it('does not modify original phase state (immutability)', () => {
    const phases = makePhases({ specify: 'done', clarify: 'in-progress' });
    const original = { ...phases };
    goBackToPhase(phases, 'specify', 'reason');
    expect(phases).toEqual(original);
  });
});

describe('archiveSpec()', () => {
  it('preserves phase states in the result', () => {
    const phases = makePhases({
      specify: 'done',
      clarify: 'skipped',
      plan: 'in-progress',
    });
    const result = archiveSpec(phases);
    expect(result.success).toBe(true);
    expect(result.newStatus).toBe('archived');
    expect(result.newPhases.specify).toBe('done');
    expect(result.newPhases.clarify).toBe('skipped');
    expect(result.newPhases.plan).toBe('in-progress');
  });
});

describe('getCurrentPhase()', () => {
  it('returns the in-progress phase', () => {
    const phases = makePhases({ specify: 'done', clarify: 'in-progress' });
    expect(getCurrentPhase(phases)).toBe('clarify');
  });

  it('returns the first pending phase when none is in-progress', () => {
    const phases = makePhases({ specify: 'done', clarify: 'skipped' });
    expect(getCurrentPhase(phases)).toBe('plan');
  });

  it('returns null when all phases are complete', () => {
    const phases = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'done',
      tasks: 'done',
      implement: 'done',
    });
    expect(getCurrentPhase(phases)).toBeNull();
  });

  it('returns null when all phases are skipped', () => {
    const phases = makePhases({
      specify: 'skipped',
      clarify: 'skipped',
      plan: 'skipped',
      tasks: 'skipped',
      implement: 'skipped',
    });
    expect(getCurrentPhase(phases)).toBeNull();
  });

  it('returns first pending phase for a fresh spec', () => {
    const phases = createInitialPhases();
    expect(getCurrentPhase(phases)).toBe('specify');
  });
});

describe('getSpecStatus()', () => {
  it('returns new when all pending', () => {
    expect(getSpecStatus(createInitialPhases())).toBe('new');
  });

  it('returns active when any phase has progressed but not all complete', () => {
    expect(getSpecStatus(makePhases({ specify: 'done' }))).toBe('active');
    expect(getSpecStatus(makePhases({ specify: 'skipped' }))).toBe('active');
    expect(getSpecStatus(makePhases({ specify: 'in-progress' }))).toBe('active');
  });

  it('returns done when all phases are done or skipped', () => {
    expect(getSpecStatus(makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'done',
      tasks: 'done',
      implement: 'done',
    }))).toBe('done');
  });
});
