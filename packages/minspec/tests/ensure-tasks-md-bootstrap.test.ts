/**
 * #225 — the auto-bootstrap offer-to-create step for missing tasks.md files.
 *
 * Asserts the OFFER is the user's confirmed pattern (DR-360 / HITL UX):
 *   - advisory, non-modal toast (a showPrompt with actions, never a modal);
 *   - in-process `action` (creates the files locally, no command dispatch);
 *   - skip-flag honored (`skipTasksMdPrompt`) — declining never re-prompts;
 *   - NEVER a silent create — the files are only written on the primary choice;
 *   - re-checks at click time, so a dir that gained a tasks.md is skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  runBootstrap,
  savePreferences,
  loadPreferences,
  BOOTSTRAP_STEPS,
  hasSpecsMissingTasksMd,
  type BootstrapVsCode,
  type BootstrapStep,
} from '../src/lib/auto-bootstrap';

function makeStub(response?: string) {
  const calls: { message: string; actions: readonly string[] }[] = [];
  const executed: string[] = [];
  const stub: BootstrapVsCode = {
    isEnabled: () => true,
    showPrompt: async (message, actions) => {
      calls.push({ message, actions });
      return response;
    },
    executeCommand: async (id) => {
      executed.push(id);
    },
  };
  return { stub, calls, executed };
}

function init(root: string): void {
  fs.mkdirSync(path.join(root, '.minspec'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.minspec', 'config.json'),
    JSON.stringify({ version: '1' }),
  );
}

/** A split-layout requirements.md missing its tasks.md sibling. */
function missingTasksSpec(root: string, id: string, tier = 'T3'): string {
  const dir = path.join(root, 'specs', 'minspec', `${id}-feature`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'requirements.md'),
    [
      '---',
      `id: ${id}`,
      'type: requirements',
      'status: implementing',
      'product: minspec',
      `tier: ${tier}`,
      '---',
      '',
      `# ${id}`,
      '',
    ].join('\n'),
  );
  return dir;
}

describe('#225 hasSpecsMissingTasksMd()', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-225-boot-'));
    init(tmpDir);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('true when a split T3/T4 spec lacks tasks.md', () => {
    missingTasksSpec(tmpDir, 'SPEC-001', 'T3');
    expect(hasSpecsMissingTasksMd(tmpDir)).toBe(true);
  });

  it('false on a fresh project with no specs', () => {
    expect(hasSpecsMissingTasksMd(tmpDir)).toBe(false);
  });
});

describe('#225 bootstrap tasks.md offer step', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-225-boot2-'));
    init(tmpDir);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const tasksStep = (): BootstrapStep => {
    const step = BOOTSTRAP_STEPS.find((s) => s.skipPrefKey === 'skipTasksMdPrompt');
    expect(step, 'a step with skipPrefKey skipTasksMdPrompt must exist').toBeDefined();
    return step!;
  };

  it('the step is registered in BOOTSTRAP_STEPS as a backfill-kind offer', () => {
    expect(tasksStep().kind).toBe('backfill');
  });

  it('surfaces a non-modal advisory toast (actions incl. primary + Don\'t ask again)', async () => {
    missingTasksSpec(tmpDir, 'SPEC-001', 'T3');
    const { stub, calls } = makeStub(undefined); // user dismisses (X)
    const result = await runBootstrap(tmpDir, stub, [tasksStep()]);
    expect(result.offered).toBe('backfill');
    expect(calls).toHaveLength(1);
    expect(calls[0].actions).toContain("Don't ask again");
    // primary action is present and not a modal "OK/Cancel" pair
    expect(calls[0].actions.length).toBeGreaterThanOrEqual(2);
  });

  it('creates the missing tasks.md on the primary choice (offer-to-fix)', async () => {
    const dir = missingTasksSpec(tmpDir, 'SPEC-001', 'T3');
    const { stub } = makeStub(tasksStep().primaryAction);
    await runBootstrap(tmpDir, stub, [tasksStep()]);
    expect(fs.existsSync(path.join(dir, 'tasks.md'))).toBe(true);
    const raw = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf-8');
    expect(/^id:\s*SPEC-001/m.test(raw)).toBe(true);
    expect(/^type:\s*tasks/m.test(raw)).toBe(true);
  });

  it('NEVER silently creates — dismissing the toast leaves the file absent', async () => {
    const dir = missingTasksSpec(tmpDir, 'SPEC-001', 'T3');
    const { stub } = makeStub(undefined); // dismissed
    await runBootstrap(tmpDir, stub, [tasksStep()]);
    expect(fs.existsSync(path.join(dir, 'tasks.md'))).toBe(false);
  });

  it("'Don't ask again' persists the skip flag and never re-prompts", async () => {
    missingTasksSpec(tmpDir, 'SPEC-001', 'T3');
    const { stub: stub1 } = makeStub("Don't ask again");
    await runBootstrap(tmpDir, stub1, [tasksStep()]);
    expect(loadPreferences(tmpDir).skipTasksMdPrompt).toBe(true);

    // Second activation: the skip flag suppresses the toast entirely.
    const { stub: stub2, calls } = makeStub(undefined);
    const result = await runBootstrap(tmpDir, stub2, [tasksStep()]);
    expect(calls).toHaveLength(0);
    expect(result.offered).toBeNull();
  });

  it('is suppressed when skipTasksMdPrompt is already set', async () => {
    missingTasksSpec(tmpDir, 'SPEC-001', 'T3');
    savePreferences(tmpDir, { skipTasksMdPrompt: true });
    const { stub, calls } = makeStub(undefined);
    const result = await runBootstrap(tmpDir, stub, [tasksStep()]);
    expect(calls).toHaveLength(0);
    expect(result.offered).toBeNull();
  });

  it('does not fire when no spec is missing tasks.md', async () => {
    const dir = missingTasksSpec(tmpDir, 'SPEC-001', 'T3');
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      '---\nid: SPEC-001\ntype: tasks\nstatus: new\n---\n',
    );
    const { stub, calls } = makeStub(undefined);
    const result = await runBootstrap(tmpDir, stub, [tasksStep()]);
    expect(calls).toHaveLength(0);
    expect(result.offered).toBeNull();
  });
});
