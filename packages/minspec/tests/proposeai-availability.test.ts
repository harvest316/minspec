/**
 * T3 regression (#141) — proposeAI() must probe `isClaudeAvailable()` BEFORE
 * dispatching `claude -p`, mirroring the isGhAvailable gate (SPEC-011 FR-3 /
 * Risk R1 / Failure-Mode 1).
 *
 * The defect: proposeAI relied solely on a try/catch around `claude -p` — no
 * availability probe — so the spec's asserted precondition-check mechanism did
 * not exist in code. These tests distinguish the guard from the old behaviour:
 * when the probe fails, `-p` is never dispatched (old code would have).
 *
 * child_process.execFile is mocked, so nothing shells a real binary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock child_process before importing the module under test.
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import { proposeAI, isClaudeAvailable } from '../src/lib/epic-backfill';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

/** Invoke the promisify-style callback, tolerating the (cmd,args,cb) form. */
function invoke(opts: unknown, cb: unknown, err: Error | null, stdout: string): void {
  const callback = (typeof opts === 'function' ? opts : cb) as (e: Error | null, r?: unknown) => void;
  if (err) callback(err);
  else callback(null, { stdout, stderr: '' });
}

/** True for the availability probe call (`claude --version`). */
function isVersion(args: unknown): boolean {
  return Array.isArray(args) && args.includes('--version');
}
/** True for the AI dispatch call (`claude -p <prompt>`). */
function isDispatch(args: unknown): boolean {
  return Array.isArray(args) && args.includes('-p');
}

function writeConfig(root: string): void {
  const dir = path.join(root, '.minspec');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: '1' }));
}

function writeSpec(root: string, id: string, title: string): void {
  const dir = path.join(root, 'specs', 'a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), [
    '---', `id: ${id}`, `title: ${title}`, 'tier: T2', 'status: new',
    'created: 2026-05-31', 'phases:', '  specify: done', '---', '',
    `# ${title}`, '', 'Some prose about the feature.', '',
  ].join('\n'));
}

describe('proposeAI() — availability-first guard (#141)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-proposeai-'));
    writeConfig(tmp);
    writeSpec(tmp, 'SPEC-001', 'A thing');
    mockExecFile.mockReset();
  });

  it('T3 regression: probe failure short-circuits — `claude -p` is NEVER dispatched', async () => {
    // Availability probe fails (binary absent). The old code, lacking the probe,
    // would proceed straight to `claude -p`; the fixed code must not.
    mockExecFile.mockImplementation((_cmd: string, args: string[], opts: unknown, cb: unknown) => {
      if (isVersion(args)) return invoke(opts, cb, new Error('claude: command not found'), '');
      return invoke(opts, cb, null, '{}');
    });

    const result = await proposeAI(tmp);

    expect(result).toBeNull();
    const dispatched = mockExecFile.mock.calls.some((c: unknown[]) => isDispatch(c[1]));
    expect(dispatched).toBe(false); // the distinguishing assertion
    expect(mockExecFile.mock.calls.some((c: unknown[]) => isVersion(c[1]))).toBe(true);
  });

  it('T3: probe succeeds → availability is checked BEFORE dispatch (order)', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], opts: unknown, cb: unknown) => {
      if (isVersion(args)) return invoke(opts, cb, null, 'claude 1.0.0\n');
      return invoke(opts, cb, null, '{}'); // dispatch returns (empty) JSON
    });

    await proposeAI(tmp);

    const versionIdx = mockExecFile.mock.calls.findIndex((c: unknown[]) => isVersion(c[1]));
    const dispatchIdx = mockExecFile.mock.calls.findIndex((c: unknown[]) => isDispatch(c[1]));
    expect(versionIdx).toBeGreaterThanOrEqual(0);
    expect(dispatchIdx).toBeGreaterThanOrEqual(0);
    expect(versionIdx).toBeLessThan(dispatchIdx); // probe first, then dispatch
  });

  it('T1: isClaudeAvailable reflects the probe result', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], opts: unknown, cb: unknown) =>
      invoke(opts, cb, null, 'claude 1.0.0\n'),
    );
    await expect(isClaudeAvailable()).resolves.toBe(true);

    mockExecFile.mockImplementation((_cmd: string, args: string[], opts: unknown, cb: unknown) =>
      invoke(opts, cb, new Error('not found'), ''),
    );
    await expect(isClaudeAvailable()).resolves.toBe(false);
  });
});
