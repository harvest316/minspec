import { describe, it, expect } from 'vitest';
import {
  createInitialPhases,
  getCurrentPhase,
  getSpecStatus,
  deriveStatus,
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

  it('Invariant 7: A spec with any phase in-progress has specifying/implementing status', () => {
    const phases1 = makePhases({ specify: 'in-progress' });
    expect(getSpecStatus(phases1)).toBe('specifying');

    const phases2 = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'in-progress',
    });
    expect(getSpecStatus(phases2)).toBe('implementing');

    const phases3 = makePhases({
      specify: 'done',
      clarify: 'skipped',
      plan: 'done',
      tasks: 'done',
      implement: 'in-progress',
    });
    expect(getSpecStatus(phases3)).toBe('implementing');
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
    expect(result.newStatus).toBe('specifying');
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

  it('returns specifying/implementing when phases are in progress', () => {
    // specify done, next is clarify (pending) → specifying
    expect(getSpecStatus(makePhases({ specify: 'done' }))).toBe('specifying');
    // specify skipped, next is clarify (pending) → specifying
    expect(getSpecStatus(makePhases({ specify: 'skipped' }))).toBe('specifying');
    // specify in-progress → specifying
    expect(getSpecStatus(makePhases({ specify: 'in-progress' }))).toBe('specifying');
    // specify+clarify done, plan pending → implementing
    expect(getSpecStatus(makePhases({ specify: 'done', clarify: 'done' }))).toBe('implementing');
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

// =============================================================================
// UNKNOWN PHASE BRANCHES — cover the idx === -1 guard clauses
// =============================================================================

describe('skipPhase() — unknown phase', () => {
  it('fails with warning for an unknown phase name', () => {
    const phases = makePhases({ specify: 'in-progress' });
    const result = skipPhase(phases, 'invalid' as any, 'some reason');
    expect(result.success).toBe(false);
    expect(result.warning).toContain('Unknown phase');
    expect(result.warning).toContain('invalid');
    // Phase state should be unchanged
    expect(result.newPhases).toEqual(phases);
  });
});

describe('goBackToPhase() — unknown phase', () => {
  it('fails with warning for an unknown phase name', () => {
    const phases = makePhases({
      specify: 'done',
      clarify: 'done',
      plan: 'in-progress',
    });
    const result = goBackToPhase(phases, 'nonexistent' as any, 'reason');
    expect(result.success).toBe(false);
    expect(result.warning).toContain('Unknown phase');
    expect(result.warning).toContain('nonexistent');
    // Phase state should be unchanged
    expect(result.newPhases).toEqual(phases);
  });
});

// =============================================================================
// SPEC-022 / DR-034 — deriveStatus (FR-4). T0 invariants INV-1, INV-6.
//
// AC-10 discipline: the pre-change code had only `getSpecStatus(phases)` — a
// phases-ONLY derivation with NO approval input. It returned 'implementing'/'done'
// purely from phases, regardless of approval. `deriveStatus` did not exist, so
// every assertion below (that an unapproved spec derives to 'specifying', that
// implementing/done REQUIRE an approved verdict) fails against the old code by
// construction.
// =============================================================================

describe('SPEC-022 deriveStatus — INV-1 (approval gates implementing/done)', () => {
  // A phase shape that, when approved, would derive to 'implementing'
  // (specify done, plan in-progress).
  const inImpl = makePhases({ specify: 'done', clarify: 'skipped', plan: 'in-progress' });
  // All phases complete → would derive to 'done' when approved.
  const allDone = makePhases({
    specify: 'done', clarify: 'done', plan: 'done', tasks: 'done', implement: 'done',
  });

  it('returns specifying for an UNAPPROVED spec regardless of phases (INV-1)', () => {
    expect(deriveStatus(inImpl, 'unapproved', undefined)).toBe('specifying');
    expect(deriveStatus(allDone, 'unapproved', undefined)).toBe('specifying');
  });

  it('returns specifying for a STALE approval (INV-1)', () => {
    expect(deriveStatus(inImpl, 'stale', undefined)).toBe('specifying');
    expect(deriveStatus(allDone, 'stale', undefined)).toBe('specifying');
  });

  it('returns implementing only when approved AND mid-implementation', () => {
    expect(deriveStatus(inImpl, 'approved', undefined)).toBe('implementing');
  });

  it('returns done only when approved AND all required phases complete', () => {
    expect(deriveStatus(allDone, 'approved', undefined)).toBe('done');
  });

  it('returns new when all phases pending, regardless of approval verdict', () => {
    const fresh = createInitialPhases();
    expect(deriveStatus(fresh, 'unapproved', undefined)).toBe('new');
    expect(deriveStatus(fresh, 'approved', undefined)).toBe('new');
  });
});

describe('SPEC-022 deriveStatus — INV-6 (terminal is a human act, never inferred)', () => {
  it('returns archived ONLY when explicitTerminal is set, never from phases', () => {
    const allDone = makePhases({
      specify: 'done', clarify: 'done', plan: 'done', tasks: 'done', implement: 'done',
    });
    // explicitTerminal set → archived even though phases would derive 'done'.
    expect(deriveStatus(allDone, 'approved', 'archived')).toBe('archived');
    // No phases configuration ever yields 'archived' without the explicit act.
    for (const verdict of ['approved', 'stale', 'unapproved'] as const) {
      expect(deriveStatus(allDone, verdict, undefined)).not.toBe('archived');
      expect(deriveStatus(createInitialPhases(), verdict, undefined)).not.toBe('archived');
    }
  });

  it('explicitTerminal overrides every other rule (even all-pending)', () => {
    expect(deriveStatus(createInitialPhases(), 'unapproved', 'archived')).toBe('archived');
  });

  // SPEC-017 Slice 5 — `superseded` is the second explicit terminal. Same INV-6
  // honesty contract as `archived`: derived ONLY from the explicit human act,
  // never inferred from phases.
  it('returns superseded ONLY when explicitTerminal==="superseded", never from phases', () => {
    const allDone = makePhases({
      specify: 'done', clarify: 'done', plan: 'done', tasks: 'done', implement: 'done',
    });
    // explicit terminal set → superseded even though phases would derive 'done'.
    expect(deriveStatus(allDone, 'approved', 'superseded')).toBe('superseded');
    // No phases configuration ever yields 'superseded' without the explicit act —
    // not from all-done, not from all-pending, regardless of approval verdict.
    for (const verdict of ['approved', 'stale', 'unapproved'] as const) {
      expect(deriveStatus(allDone, verdict, undefined)).not.toBe('superseded');
      expect(deriveStatus(createInitialPhases(), verdict, undefined)).not.toBe('superseded');
    }
  });

  it('superseded explicit terminal overrides every other rule (even all-pending + unapproved)', () => {
    // Precedes the approval/staleness check: a superseded spec whose approval is
    // now stale (supersession voids it) still derives `superseded`, not `specifying`.
    expect(deriveStatus(createInitialPhases(), 'unapproved', 'superseded')).toBe('superseded');
    expect(deriveStatus(createInitialPhases(), 'stale', 'superseded')).toBe('superseded');
  });
});

describe('SPEC-022 getSpecStatus — preview-only shim (regression)', () => {
  // The transition helpers keep a phases-only preview. getSpecStatus must still
  // behave as before (modeling "approved") so advancePhase's newStatus previews
  // don't silently change.
  it('still derives implementing/done from phases alone (preview semantics)', () => {
    const inImpl = makePhases({ specify: 'done', clarify: 'skipped', plan: 'in-progress' });
    expect(getSpecStatus(inImpl)).toBe('implementing');
    const allDone = makePhases({
      specify: 'done', clarify: 'done', plan: 'done', tasks: 'done', implement: 'done',
    });
    expect(getSpecStatus(allDone)).toBe('done');
    expect(getSpecStatus(createInitialPhases())).toBe('new');
  });

  // getSpecStatus and the approval-aware deriveStatus agree on new / done /
  // mid-implementation (plan+ in-progress). They DELIBERATELY diverge while the
  // current phase is specify/clarify: the legacy preview shows 'specifying' from
  // the current-phase signal, whereas deriveStatus(...,'approved',...) shows
  // 'implementing' (it discriminates specifying↔implementing by APPROVAL, not by
  // phase — INV-1). That divergence is exactly why deriveStatus, not getSpecStatus,
  // is the authoritative status; getSpecStatus stays a phases-only TRANSITION
  // preview. This test pins both the agreement AND the intended divergence.
  it('agrees with deriveStatus on new/done/mid-impl; diverges (by design) in the specify/clarify range', () => {
    // Agreement cases.
    expect(getSpecStatus(createInitialPhases())).toBe(
      deriveStatus(createInitialPhases(), 'approved', undefined),
    ); // both 'new'
    const midImpl = makePhases({ specify: 'done', clarify: 'skipped', plan: 'in-progress' });
    expect(getSpecStatus(midImpl)).toBe(deriveStatus(midImpl, 'approved', undefined)); // both 'implementing'
    const allDone = makePhases({
      specify: 'done', clarify: 'done', plan: 'done', tasks: 'done', implement: 'done',
    });
    expect(getSpecStatus(allDone)).toBe(deriveStatus(allDone, 'approved', undefined)); // both 'done'

    // Intended divergence: specify in-progress.
    const earlyPhase = makePhases({ specify: 'in-progress' });
    expect(getSpecStatus(earlyPhase)).toBe('specifying'); // legacy preview (current-phase signal)
    expect(deriveStatus(earlyPhase, 'approved', undefined)).toBe('implementing'); // approval-driven
  });
});
