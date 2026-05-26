import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mock item — returned by createStatusBarItem
const mockStatusBarItem = {
  text: '',
  tooltip: '',
  command: '',
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
};

// Mock vscode module before any imports that use it
vi.mock('vscode', () => ({
  window: {
    createStatusBarItem: vi.fn(() => mockStatusBarItem),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
}));

import * as vscode from 'vscode';
import {
  MinSpecStatusBar,
  formatStatusBarText,
  formatTooltip,
  computeProgress,
  fromFrontmatter,
} from '../src/views/status-bar';
import type { StatusBarSpec } from '../src/views/status-bar';
import type { SpecFrontmatter } from '../src/lib/spec';

// --- Helpers ---

function makeSpec(overrides: Partial<StatusBarSpec> = {}): StatusBarSpec {
  return {
    id: 'SPEC-001',
    title: 'Add rate limiting',
    tier: 'T2',
    currentPhase: 'plan',
    phases: {
      specify: 'done',
      clarify: 'skipped',
      plan: 'in-progress',
      tasks: 'pending',
      implement: 'pending',
    },
    ...overrides,
  };
}

// =============================================================================
// T0 INVARIANT TESTS — Status bar contract
// =============================================================================

describe('T0 Invariants — Status Bar', () => {
  it('Invariant: null spec always shows "No active spec"', () => {
    const text = formatStatusBarText(null);
    expect(text).toBe('$(shield) MinSpec: No active spec');
  });

  it('Invariant: non-null spec always includes tier, phase, and progress', () => {
    const spec = makeSpec();
    const text = formatStatusBarText(spec);
    expect(text).toContain('T2');
    expect(text).toContain('Plan');
    expect(text).toMatch(/\d+\/\d+ done/);
  });

  it('Invariant: progress denominator always equals total phase count (5)', () => {
    const spec = makeSpec();
    const progress = computeProgress(spec.phases);
    expect(progress).toMatch(/^\d+\/5 done$/);
  });

  it('Invariant: dispose cleans up the status bar item', () => {
    vi.clearAllMocks();
    // Reset mock item state
    mockStatusBarItem.text = '';
    mockStatusBarItem.tooltip = '';
    mockStatusBarItem.command = '';

    const bar = new MinSpecStatusBar();
    bar.dispose();
    expect(mockStatusBarItem.dispose).toHaveBeenCalled();
  });
});

// =============================================================================
// T2 FEATURE TESTS — Formatting and behavior
// =============================================================================

describe('formatStatusBarText()', () => {
  it('shows "No active spec" when null', () => {
    expect(formatStatusBarText(null)).toBe('$(shield) MinSpec: No active spec');
  });

  it('formats with tier, current phase, and progress', () => {
    const spec = makeSpec({
      tier: 'T3',
      currentPhase: 'tasks',
      phases: {
        specify: 'done',
        clarify: 'done',
        plan: 'done',
        tasks: 'in-progress',
        implement: 'pending',
      },
    });
    expect(formatStatusBarText(spec)).toBe('$(shield) MinSpec: T3 | Tasks | 3/5 done');
  });

  it('shows "Done" when no current phase (all complete)', () => {
    const spec = makeSpec({
      currentPhase: null,
      phases: {
        specify: 'done',
        clarify: 'done',
        plan: 'done',
        tasks: 'done',
        implement: 'done',
      },
    });
    expect(formatStatusBarText(spec)).toBe('$(shield) MinSpec: T2 | Done | 5/5 done');
  });

  it('shows T1 with Specify phase', () => {
    const spec = makeSpec({
      tier: 'T1',
      currentPhase: 'specify',
      phases: {
        specify: 'in-progress',
        clarify: 'pending',
        plan: 'pending',
        tasks: 'pending',
        implement: 'pending',
      },
    });
    expect(formatStatusBarText(spec)).toBe('$(shield) MinSpec: T1 | Specify | 0/5 done');
  });

  it('counts skipped phases as completed in progress', () => {
    const spec = makeSpec({
      tier: 'T2',
      currentPhase: 'plan',
      phases: {
        specify: 'done',
        clarify: 'skipped',
        plan: 'in-progress',
        tasks: 'pending',
        implement: 'pending',
      },
    });
    expect(formatStatusBarText(spec)).toBe('$(shield) MinSpec: T2 | Plan | 2/5 done');
  });
});

describe('formatTooltip()', () => {
  it('shows spec ID and title', () => {
    const spec = makeSpec({ id: 'SPEC-042', title: 'Fix login redirect' });
    expect(formatTooltip(spec)).toBe('SPEC-042: Fix login redirect');
  });

  it('shows helpful text when null', () => {
    expect(formatTooltip(null)).toBe('No active spec. Click to select one.');
  });
});

describe('computeProgress()', () => {
  it('returns 0/5 when all pending', () => {
    const phases = {
      specify: 'pending' as const,
      clarify: 'pending' as const,
      plan: 'pending' as const,
      tasks: 'pending' as const,
      implement: 'pending' as const,
    };
    expect(computeProgress(phases)).toBe('0/5 done');
  });

  it('returns 5/5 when all done', () => {
    const phases = {
      specify: 'done' as const,
      clarify: 'done' as const,
      plan: 'done' as const,
      tasks: 'done' as const,
      implement: 'done' as const,
    };
    expect(computeProgress(phases)).toBe('5/5 done');
  });

  it('counts mix of done and skipped', () => {
    const phases = {
      specify: 'done' as const,
      clarify: 'skipped' as const,
      plan: 'done' as const,
      tasks: 'in-progress' as const,
      implement: 'pending' as const,
    };
    expect(computeProgress(phases)).toBe('3/5 done');
  });

  it('in-progress does not count as completed', () => {
    const phases = {
      specify: 'in-progress' as const,
      clarify: 'pending' as const,
      plan: 'pending' as const,
      tasks: 'pending' as const,
      implement: 'pending' as const,
    };
    expect(computeProgress(phases)).toBe('0/5 done');
  });
});

describe('fromFrontmatter()', () => {
  it('derives current phase from in-progress phase', () => {
    const fm: SpecFrontmatter = {
      id: 'SPEC-001',
      title: 'Test',
      tier: 'T2',
      status: 'implementing',
      created: '2026-05-26',
      phases: {
        specify: 'done',
        clarify: 'done',
        plan: 'done',
        tasks: 'done',
        implement: 'in-progress',
      },
    };
    const result = fromFrontmatter(fm);
    expect(result.currentPhase).toBe('implement');
    expect(result.id).toBe('SPEC-001');
    expect(result.tier).toBe('T2');
  });

  it('falls back to first pending when no in-progress', () => {
    const fm: SpecFrontmatter = {
      id: 'SPEC-002',
      title: 'Test 2',
      tier: 'T3',
      status: 'new',
      created: '2026-05-26',
      phases: {
        specify: 'done',
        clarify: 'skipped',
        plan: 'pending',
        tasks: 'pending',
        implement: 'pending',
      },
    };
    const result = fromFrontmatter(fm);
    expect(result.currentPhase).toBe('plan');
  });

  it('returns null currentPhase when all phases complete', () => {
    const fm: SpecFrontmatter = {
      id: 'SPEC-003',
      title: 'Done spec',
      tier: 'T1',
      status: 'done',
      created: '2026-05-26',
      phases: {
        specify: 'done',
        clarify: 'skipped',
        plan: 'skipped',
        tasks: 'done',
        implement: 'done',
      },
    };
    const result = fromFrontmatter(fm);
    expect(result.currentPhase).toBeNull();
  });
});

describe('MinSpecStatusBar class', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock item state between tests
    mockStatusBarItem.text = '';
    mockStatusBarItem.tooltip = '';
    mockStatusBarItem.command = '';
  });

  it('creates a status bar item on construction', () => {
    new MinSpecStatusBar();
    expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(1, 100); // Left=1, priority=100
  });

  it('sets command to minspec.status', () => {
    new MinSpecStatusBar();
    expect(mockStatusBarItem.command).toBe('minspec.status');
  });

  it('update(null) shows "No active spec" and calls show()', () => {
    const bar = new MinSpecStatusBar();
    bar.update(null);

    expect(mockStatusBarItem.text).toBe('$(shield) MinSpec: No active spec');
    expect(mockStatusBarItem.tooltip).toBe('No active spec. Click to select one.');
    expect(mockStatusBarItem.show).toHaveBeenCalled();
  });

  it('update(spec) shows formatted text and tooltip', () => {
    const bar = new MinSpecStatusBar();

    const spec = makeSpec({
      id: 'SPEC-007',
      title: 'Add caching layer',
      tier: 'T3',
      currentPhase: 'implement',
      phases: {
        specify: 'done',
        clarify: 'done',
        plan: 'done',
        tasks: 'done',
        implement: 'in-progress',
      },
    });
    bar.update(spec);

    expect(mockStatusBarItem.text).toBe('$(shield) MinSpec: T3 | Implement | 4/5 done');
    expect(mockStatusBarItem.tooltip).toBe('SPEC-007: Add caching layer');
    expect(mockStatusBarItem.show).toHaveBeenCalled();
  });

  it('dispose calls dispose on the underlying item', () => {
    const bar = new MinSpecStatusBar();
    bar.dispose();
    expect(mockStatusBarItem.dispose).toHaveBeenCalled();
  });
});
