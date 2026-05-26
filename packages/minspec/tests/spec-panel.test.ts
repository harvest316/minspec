import { describe, it, expect } from 'vitest';
import { getHtml, getErrorHtml, toggleTask } from '../src/views/spec-panel-html';
import type { ClassificationSummary } from '../src/views/spec-panel-html';
import { parseSpec, writeSpec } from '../src/lib/spec';
import type { ParsedSpec } from '../src/lib/spec';

// --- Test fixtures ---

const FULL_SPEC = `---
id: SPEC-001
title: Add rate limiting to /api/health
tier: T1
status: implementing
created: 2026-05-26
phases:
  specify: done
  clarify: skipped
  plan: done
  tasks: in-progress
  implement: pending
---

## Specify

Health endpoint needs rate limiting at 100 req/min per IP.

## Tasks

- [x] Add express-rate-limit middleware to health route
- [ ] Add 429 response test
- [ ] Update API docs
`;

const MINIMAL_SPEC = `---
id: SPEC-099
title: Fix typo
tier: T1
status: new
created: 2026-05-26
phases:
  specify: pending
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---
`;

const ALL_DONE_SPEC = `---
id: SPEC-050
title: Completed feature
tier: T2
status: done
created: 2026-05-26
phases:
  specify: done
  clarify: skipped
  plan: done
  tasks: done
  implement: done
---

## Specify

Everything is done.

## Tasks

- [x] First task
- [x] Second task
`;

// --- getHtml tests ---

describe('getHtml()', () => {
  it('renders all five phases', () => {
    const spec = parseSpec(FULL_SPEC);
    const html = getHtml(spec);

    expect(html).toContain('Specify');
    expect(html).toContain('Clarify');
    expect(html).toContain('Plan');
    expect(html).toContain('Tasks');
    expect(html).toContain('Implement');
  });

  it('renders spec title and id', () => {
    const spec = parseSpec(FULL_SPEC);
    const html = getHtml(spec);

    expect(html).toContain('Add rate limiting to /api/health');
    expect(html).toContain('SPEC-001');
  });

  it('renders tier badge', () => {
    const spec = parseSpec(FULL_SPEC);
    const html = getHtml(spec);

    expect(html).toContain('tier-t1');
    expect(html).toContain('T1');
  });

  it('renders phase status indicators', () => {
    const spec = parseSpec(FULL_SPEC);
    const html = getHtml(spec);

    // done phases show checkmark
    expect(html).toContain('phase-status-done');
    // active phase has active class
    expect(html).toContain('phase-status-inprogress');
    // skipped phases
    expect(html).toContain('phase-status-skipped');
    // pending phases
    expect(html).toContain('phase-status-pending');
  });

  it('renders task checkboxes', () => {
    const spec = parseSpec(FULL_SPEC);
    const html = getHtml(spec);

    // Task checkboxes with data attributes
    expect(html).toContain('data-phase="tasks"');
    expect(html).toContain('data-index="0"');
    expect(html).toContain('data-index="1"');
    expect(html).toContain('data-index="2"');

    // Done task has checked attribute
    expect(html).toContain('checked');
    // Task text rendered
    expect(html).toContain('Add express-rate-limit middleware to health route');
    expect(html).toContain('Add 429 response test');
    expect(html).toContain('Update API docs');
  });

  it('marks done tasks with strikethrough class', () => {
    const spec = parseSpec(FULL_SPEC);
    const html = getHtml(spec);

    // The done task text should have the task-done class
    expect(html).toContain('task-done');
  });

  it('renders classification section when provided', () => {
    const spec = parseSpec(FULL_SPEC);
    const classification: ClassificationSummary = {
      tier: 'T2',
      confidence: 0.75,
      signals: [
        { name: 'files_changed', value: 5, weight: 0.3, tierContribution: 'T2' },
        { name: 'lines_changed', value: 87, weight: 0.25, tierContribution: 'T1' },
        { name: 'new_files', value: 2, weight: 0.1, tierContribution: 'T2' },
      ],
    };

    const html = getHtml(spec, classification);

    expect(html).toContain('Classification');
    expect(html).toContain('75%');
    expect(html).toContain('confidence');
    expect(html).toContain('files_changed');
    expect(html).toContain('lines_changed');
    expect(html).toContain('new_files');
  });

  it('does not render classification section when not provided', () => {
    const spec = parseSpec(FULL_SPEC);
    const html = getHtml(spec);

    expect(html).not.toContain('<h2>Classification</h2>');
    expect(html).not.toContain('class="classification"');
    expect(html).not.toContain('<table class="signals-table">');
  });

  it('renders minimal spec without errors', () => {
    const spec = parseSpec(MINIMAL_SPEC);
    const html = getHtml(spec);

    expect(html).toContain('Fix typo');
    expect(html).toContain('SPEC-099');
    // No task checkboxes for a spec with no task sections
    expect(html).not.toContain('data-phase=');
  });

  it('renders completed spec correctly', () => {
    const spec = parseSpec(ALL_DONE_SPEC);
    const html = getHtml(spec);

    expect(html).toContain('Completed feature');
    // All task checkboxes should have the checked attribute
    const checkedInputCount = (html.match(/type="checkbox" checked/g) || []).length;
    expect(checkedInputCount).toBe(2);
  });

  it('renders valid HTML document', () => {
    const spec = parseSpec(FULL_SPEC);
    const html = getHtml(spec);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<head>');
    expect(html).toContain('<body>');
  });

  it('includes VS Code CSS variables for theming', () => {
    const spec = parseSpec(FULL_SPEC);
    const html = getHtml(spec);

    expect(html).toContain('--vscode-editor-background');
    expect(html).toContain('--vscode-foreground');
    expect(html).toContain('--vscode-font-family');
  });

  it('includes webview script for task toggle messaging', () => {
    const spec = parseSpec(FULL_SPEC);
    const html = getHtml(spec);

    expect(html).toContain('acquireVsCodeApi');
    expect(html).toContain('toggleTask');
    expect(html).toContain('postMessage');
  });

  it('escapes HTML in title', () => {
    const spec = parseSpec(`---
id: SPEC-XSS
title: Fix <script>alert("xss")</script> issue
tier: T1
status: new
created: 2026-05-26
phases:
  specify: pending
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---
`);
    const html = getHtml(spec);

    // Should not contain raw script tag
    expect(html).not.toContain('<script>alert');
    // Should contain escaped version
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders boolean signal values correctly', () => {
    const spec = parseSpec(FULL_SPEC);
    const classification: ClassificationSummary = {
      tier: 'T3',
      confidence: 0.6,
      signals: [
        { name: 'dependency_change', value: true, weight: 0.2, tierContribution: 'T3' },
      ],
    };
    const html = getHtml(spec, classification);

    expect(html).toContain('dependency_change');
    expect(html).toContain('true');
  });
});

// --- getErrorHtml tests ---

describe('getErrorHtml()', () => {
  it('renders error message', () => {
    const html = getErrorHtml('File not found');

    expect(html).toContain('File not found');
    expect(html).toContain('error');
  });

  it('escapes HTML in error message', () => {
    const html = getErrorHtml('Bad <tag> & stuff');

    expect(html).not.toContain('<tag>');
    expect(html).toContain('&lt;tag&gt;');
    expect(html).toContain('&amp;');
  });

  it('renders valid HTML document', () => {
    const html = getErrorHtml('test');

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });
});

// --- toggleTask tests ---

describe('toggleTask()', () => {
  it('toggles a pending task to done', () => {
    const spec = parseSpec(FULL_SPEC);
    const result = toggleTask(spec, 'tasks', 1, true);

    expect(result).not.toBeNull();
    expect(result!.phaseSections.tasks!.tasks[1].done).toBe(true);
    expect(result!.phaseSections.tasks!.tasks[1].text).toBe('Add 429 response test');
  });

  it('toggles a done task to pending', () => {
    const spec = parseSpec(FULL_SPEC);
    const result = toggleTask(spec, 'tasks', 0, false);

    expect(result).not.toBeNull();
    expect(result!.phaseSections.tasks!.tasks[0].done).toBe(false);
    expect(result!.phaseSections.tasks!.tasks[0].text).toBe('Add express-rate-limit middleware to health route');
  });

  it('preserves other tasks when toggling one', () => {
    const spec = parseSpec(FULL_SPEC);
    const result = toggleTask(spec, 'tasks', 1, true);

    expect(result).not.toBeNull();
    // Original done task remains done
    expect(result!.phaseSections.tasks!.tasks[0].done).toBe(true);
    // Toggled task is now done
    expect(result!.phaseSections.tasks!.tasks[1].done).toBe(true);
    // Third task remains pending
    expect(result!.phaseSections.tasks!.tasks[2].done).toBe(false);
  });

  it('updates the body markdown to match toggled state', () => {
    const spec = parseSpec(FULL_SPEC);
    const result = toggleTask(spec, 'tasks', 1, true);

    expect(result).not.toBeNull();
    const body = result!.phaseSections.tasks!.body;
    // The second task should now be [x]
    expect(body).toContain('- [x] Add 429 response test');
  });

  it('updates the sections map', () => {
    const spec = parseSpec(FULL_SPEC);
    const result = toggleTask(spec, 'tasks', 1, true);

    expect(result).not.toBeNull();
    const sectionBody = result!.sections.get('Tasks');
    expect(sectionBody).toBeDefined();
    expect(sectionBody).toContain('- [x] Add 429 response test');
  });

  it('returns null for non-existent phase', () => {
    const spec = parseSpec(FULL_SPEC);
    const result = toggleTask(spec, 'clarify', 0, true);

    // Clarify has no content/tasks in this spec (it's skipped)
    expect(result).toBeNull();
  });

  it('returns null for out-of-range task index', () => {
    const spec = parseSpec(FULL_SPEC);
    const result = toggleTask(spec, 'tasks', 99, true);

    expect(result).toBeNull();
  });

  it('returns null for negative task index', () => {
    const spec = parseSpec(FULL_SPEC);
    const result = toggleTask(spec, 'tasks', -1, true);

    expect(result).toBeNull();
  });

  it('preserves frontmatter after toggle', () => {
    const spec = parseSpec(FULL_SPEC);
    const result = toggleTask(spec, 'tasks', 0, false);

    expect(result).not.toBeNull();
    expect(result!.frontmatter).toEqual(spec.frontmatter);
  });

  it('preserves preamble after toggle', () => {
    const spec = parseSpec(FULL_SPEC);
    const result = toggleTask(spec, 'tasks', 0, false);

    expect(result).not.toBeNull();
    expect(result!.preamble).toEqual(spec.preamble);
  });

  it('preserves non-task sections after toggle', () => {
    const spec = parseSpec(FULL_SPEC);
    const result = toggleTask(spec, 'tasks', 0, false);

    expect(result).not.toBeNull();
    expect(result!.sections.get('Specify')).toEqual(spec.sections.get('Specify'));
  });

  it('round-trips through writeSpec and parseSpec', () => {
    const spec = parseSpec(FULL_SPEC);
    const toggled = toggleTask(spec, 'tasks', 1, true);

    expect(toggled).not.toBeNull();
    const markdown = writeSpec(toggled!);
    const reparsed = parseSpec(markdown);

    expect(reparsed.phaseSections.tasks!.tasks[0].done).toBe(true);
    expect(reparsed.phaseSections.tasks!.tasks[1].done).toBe(true);
    expect(reparsed.phaseSections.tasks!.tasks[2].done).toBe(false);
  });

  it('handles toggling with a spec that has tasks in multiple phases', () => {
    const multiPhaseSpec = `---
id: SPEC-MULTI
title: Multi phase tasks
tier: T3
status: implementing
created: 2026-05-26
phases:
  specify: done
  clarify: skipped
  plan: in-progress
  tasks: in-progress
  implement: pending
---

## Plan

- [ ] Design the schema
- [x] Choose the framework

## Tasks

- [ ] Implement feature A
- [ ] Implement feature B
`;
    const spec = parseSpec(multiPhaseSpec);

    // Toggle a plan task
    const result1 = toggleTask(spec, 'plan', 0, true);
    expect(result1).not.toBeNull();
    expect(result1!.phaseSections.plan!.tasks[0].done).toBe(true);
    // Tasks phase should be unchanged
    expect(result1!.phaseSections.tasks!.tasks[0].done).toBe(false);

    // Toggle a tasks task
    const result2 = toggleTask(spec, 'tasks', 1, true);
    expect(result2).not.toBeNull();
    expect(result2!.phaseSections.tasks!.tasks[1].done).toBe(true);
    // Plan phase should be unchanged
    expect(result2!.phaseSections.plan!.tasks[0].done).toBe(false);
  });
});
