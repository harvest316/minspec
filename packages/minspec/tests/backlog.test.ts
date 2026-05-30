/**
 * T1 — Contract Tests: Backlog
 *
 * Tests public exports from src/lib/backlog.ts:
 *   - calculateWsjf, formatWsjfComment
 *   - LIFECYCLE_TRANSITIONS, LIFECYCLE_LABELS, PRIORITY_LABELS
 *   - extractLifecycleLabel, extractPriorityLabel, extractWsjfFromLabels
 *   - sortBacklog
 *
 * Note: async functions that shell out to `gh` CLI (fetchIssues, applyWsjfToIssue,
 * transitionIssue, setPriority, isGhAvailable, getRepoFromRemote) are NOT tested
 * here because they require external tooling. They are integration concerns.
 */

import { describe, it, expect } from 'vitest';

import {
  calculateWsjf,
  formatWsjfComment,
  LIFECYCLE_TRANSITIONS,
  LIFECYCLE_LABELS,
  PRIORITY_LABELS,
  extractLifecycleLabel,
  extractPriorityLabel,
  extractWsjfFromLabels,
  extractEpicSlug,
  sortBacklog,
  type WsjfDimensions,
  type BacklogIssue,
  type IssueLifecycleLabel,
} from '../src/lib/backlog';

// ─── WSJF Scoring ───────────────────────────────────────────────────────

describe('calculateWsjf()', () => {
  it('calculates correct WSJF score', () => {
    const dims: WsjfDimensions = {
      businessValue: 8,
      timeCriticality: 5,
      riskReduction: 3,
      jobSize: 4,
    };
    const result = calculateWsjf(dims);
    // (8 + 5 + 3) / 4 = 4.0
    expect(result.score).toBe(4);
    expect(result.dimensions).toEqual(dims);
  });

  it('clamps jobSize to minimum 1 (prevents division by zero)', () => {
    const dims: WsjfDimensions = {
      businessValue: 10,
      timeCriticality: 5,
      riskReduction: 5,
      jobSize: 0,
    };
    const result = calculateWsjf(dims);
    // (10 + 5 + 5) / 1 = 20
    expect(result.score).toBe(20);
  });

  it('handles negative jobSize by clamping to 1', () => {
    const dims: WsjfDimensions = {
      businessValue: 6,
      timeCriticality: 3,
      riskReduction: 1,
      jobSize: -5,
    };
    const result = calculateWsjf(dims);
    expect(result.score).toBe(10); // (6+3+1)/1
  });

  it('rounds to 2 decimal places', () => {
    const dims: WsjfDimensions = {
      businessValue: 7,
      timeCriticality: 3,
      riskReduction: 2,
      jobSize: 3,
    };
    const result = calculateWsjf(dims);
    // (7 + 3 + 2) / 3 = 4.0
    expect(result.score).toBe(4);

    // Another case that produces a fraction
    const dims2: WsjfDimensions = {
      businessValue: 10,
      timeCriticality: 10,
      riskReduction: 10,
      jobSize: 7,
    };
    const result2 = calculateWsjf(dims2);
    // 30 / 7 = 4.285714... → rounded to 4.29
    expect(result2.score).toBe(4.29);
  });

  it('preserves dimensions in result', () => {
    const dims: WsjfDimensions = {
      businessValue: 1,
      timeCriticality: 2,
      riskReduction: 3,
      jobSize: 4,
    };
    const result = calculateWsjf(dims);
    expect(result.dimensions).toEqual(dims);
  });
});

describe('extractEpicSlug()', () => {
  it('extracts the slug from an epic:<slug> label', () => {
    expect(extractEpicSlug(['inbox', 'epic:telemetry', 'P1'])).toBe('telemetry');
  });
  it('returns null when no epic label is present', () => {
    expect(extractEpicSlug(['inbox', 'wsjf:3.2'])).toBeNull();
    expect(extractEpicSlug([])).toBeNull();
  });
  it('handles slugs with hyphens', () => {
    expect(extractEpicSlug(['epic:auth-revamp'])).toBe('auth-revamp');
  });
});

describe('formatWsjfComment()', () => {
  it('produces markdown table with all dimensions', () => {
    const wsjf = calculateWsjf({
      businessValue: 8,
      timeCriticality: 5,
      riskReduction: 3,
      jobSize: 4,
    });
    const comment = formatWsjfComment(wsjf);

    expect(comment).toContain('## WSJF Score');
    expect(comment).toContain('Business Value');
    expect(comment).toContain('Time Criticality');
    expect(comment).toContain('Risk Reduction');
    expect(comment).toContain('Job Size');
    expect(comment).toContain('8');
    expect(comment).toContain('5');
    expect(comment).toContain('3');
    expect(comment).toContain('4');
    expect(comment).toContain('WSJF =');
  });

  it('includes the formula in the output', () => {
    const wsjf = calculateWsjf({
      businessValue: 8,
      timeCriticality: 5,
      riskReduction: 3,
      jobSize: 4,
    });
    const comment = formatWsjfComment(wsjf);
    expect(comment).toContain('(8 + 5 + 3) / 4 = 4');
  });
});

// ─── Lifecycle Constants ────────────────────────────────────────────────

describe('LIFECYCLE_TRANSITIONS', () => {
  it('defines valid transitions for all lifecycle labels', () => {
    for (const label of LIFECYCLE_LABELS) {
      expect(LIFECYCLE_TRANSITIONS[label]).toBeDefined();
      expect(Array.isArray(LIFECYCLE_TRANSITIONS[label])).toBe(true);
    }
  });

  it('inbox can only go to triaged', () => {
    expect(LIFECYCLE_TRANSITIONS.inbox).toEqual(['triaged']);
  });

  it('triaged can go to agent-ready or wip', () => {
    expect(LIFECYCLE_TRANSITIONS.triaged).toEqual(['agent-ready', 'wip']);
  });

  it('agent-ready can go to wip', () => {
    expect(LIFECYCLE_TRANSITIONS['agent-ready']).toEqual(['wip']);
  });

  it('wip can go to done', () => {
    expect(LIFECYCLE_TRANSITIONS.wip).toEqual(['done']);
  });

  it('done has no transitions (terminal state)', () => {
    expect(LIFECYCLE_TRANSITIONS.done).toEqual([]);
  });

  it('all transitions are valid lifecycle labels', () => {
    const validLabels = new Set<string>(LIFECYCLE_LABELS);
    for (const [, targets] of Object.entries(LIFECYCLE_TRANSITIONS)) {
      for (const target of targets) {
        expect(validLabels.has(target)).toBe(true);
      }
    }
  });

  it('no transition goes backwards to inbox', () => {
    for (const [, targets] of Object.entries(LIFECYCLE_TRANSITIONS)) {
      expect(targets).not.toContain('inbox');
    }
  });
});

describe('LIFECYCLE_LABELS', () => {
  it('has 5 labels in correct order', () => {
    expect(LIFECYCLE_LABELS).toEqual(['inbox', 'triaged', 'agent-ready', 'wip', 'done']);
  });
});

describe('PRIORITY_LABELS', () => {
  it('has P1, P2, P3', () => {
    expect(PRIORITY_LABELS).toEqual(['P1', 'P2', 'P3']);
  });
});

// ─── Label Extraction ───────────────────────────────────────────────────

describe('extractLifecycleLabel()', () => {
  it('extracts lifecycle label from label list', () => {
    expect(extractLifecycleLabel(['bug', 'inbox', 'P1'])).toBe('inbox');
    expect(extractLifecycleLabel(['feat', 'wip'])).toBe('wip');
    expect(extractLifecycleLabel(['done'])).toBe('done');
  });

  it('returns null when no lifecycle label found', () => {
    expect(extractLifecycleLabel(['bug', 'P1', 'enhancement'])).toBeNull();
  });

  it('returns first lifecycle label if multiple (edge case)', () => {
    const result = extractLifecycleLabel(['inbox', 'wip']);
    // Returns first found
    expect(result).toBe('inbox');
  });

  it('handles empty label list', () => {
    expect(extractLifecycleLabel([])).toBeNull();
  });
});

describe('extractPriorityLabel()', () => {
  it('extracts priority label from label list', () => {
    expect(extractPriorityLabel(['bug', 'P1', 'inbox'])).toBe('P1');
    expect(extractPriorityLabel(['P2', 'feat'])).toBe('P2');
    expect(extractPriorityLabel(['P3'])).toBe('P3');
  });

  it('returns null when no priority label found', () => {
    expect(extractPriorityLabel(['bug', 'inbox'])).toBeNull();
  });

  it('handles empty label list', () => {
    expect(extractPriorityLabel([])).toBeNull();
  });
});

describe('extractWsjfFromLabels()', () => {
  it('extracts wsjf score from labels', () => {
    expect(extractWsjfFromLabels(['wsjf:4.5', 'bug'])).toBe(4.5);
    expect(extractWsjfFromLabels(['wsjf:10', 'feat'])).toBe(10);
  });

  it('returns null when no wsjf label found', () => {
    expect(extractWsjfFromLabels(['bug', 'P1'])).toBeNull();
  });

  it('handles integer scores', () => {
    expect(extractWsjfFromLabels(['wsjf:7'])).toBe(7);
  });

  it('handles decimal scores', () => {
    expect(extractWsjfFromLabels(['wsjf:3.14'])).toBe(3.14);
  });

  it('handles empty label list', () => {
    expect(extractWsjfFromLabels([])).toBeNull();
  });

  it('ignores labels that look similar but do not match', () => {
    expect(extractWsjfFromLabels(['wsjf:', 'wsjf:abc', 'wsjf-label'])).toBeNull();
  });
});

// ─── Sorting ────────────────────────────────────────────────────────────

describe('sortBacklog()', () => {
  function makeIssue(overrides: Partial<BacklogIssue>): BacklogIssue {
    return {
      number: 1,
      title: 'Test',
      url: 'https://github.com/test/1',
      labels: [],
      state: 'OPEN',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      lifecycleLabel: null,
      priorityLabel: null,
      wsjfScore: null,
      ...overrides,
    };
  }

  it('sorts by WSJF score descending', () => {
    const issues = [
      makeIssue({ number: 1, wsjfScore: 3 }),
      makeIssue({ number: 2, wsjfScore: 10 }),
      makeIssue({ number: 3, wsjfScore: 5 }),
    ];
    const sorted = sortBacklog(issues);
    expect(sorted.map(i => i.number)).toEqual([2, 3, 1]);
  });

  it('issues with WSJF scores sort before those without', () => {
    const issues = [
      makeIssue({ number: 1, wsjfScore: null }),
      makeIssue({ number: 2, wsjfScore: 1 }),
    ];
    const sorted = sortBacklog(issues);
    expect(sorted[0].number).toBe(2);
  });

  it('when WSJF equal, sorts by priority (P1 > P2 > P3)', () => {
    const issues = [
      makeIssue({ number: 1, wsjfScore: 5, priorityLabel: 'P3' }),
      makeIssue({ number: 2, wsjfScore: 5, priorityLabel: 'P1' }),
      makeIssue({ number: 3, wsjfScore: 5, priorityLabel: 'P2' }),
    ];
    const sorted = sortBacklog(issues);
    expect(sorted.map(i => i.number)).toEqual([2, 3, 1]);
  });

  it('when WSJF and priority equal, sorts by lifecycle (earlier stages first)', () => {
    const issues = [
      makeIssue({ number: 1, lifecycleLabel: 'wip' }),
      makeIssue({ number: 2, lifecycleLabel: 'inbox' }),
      makeIssue({ number: 3, lifecycleLabel: 'triaged' }),
    ];
    const sorted = sortBacklog(issues);
    expect(sorted.map(i => i.number)).toEqual([2, 3, 1]);
  });

  it('when all else equal, sorts by created date (FIFO)', () => {
    const issues = [
      makeIssue({ number: 1, createdAt: '2026-01-03T00:00:00Z' }),
      makeIssue({ number: 2, createdAt: '2026-01-01T00:00:00Z' }),
      makeIssue({ number: 3, createdAt: '2026-01-02T00:00:00Z' }),
    ];
    const sorted = sortBacklog(issues);
    expect(sorted.map(i => i.number)).toEqual([2, 3, 1]);
  });

  it('does not mutate the original array', () => {
    const issues = [
      makeIssue({ number: 2, wsjfScore: 1 }),
      makeIssue({ number: 1, wsjfScore: 10 }),
    ];
    const sorted = sortBacklog(issues);
    expect(sorted).not.toBe(issues);
    expect(issues[0].number).toBe(2); // unchanged
  });

  it('handles empty array', () => {
    expect(sortBacklog([])).toEqual([]);
  });

  it('handles single issue', () => {
    const issues = [makeIssue({ number: 1 })];
    expect(sortBacklog(issues)).toHaveLength(1);
  });
});
