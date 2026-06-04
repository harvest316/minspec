/**
 * T3 — Regression: park-topic dedup (issue harvest316/minspec#24)
 *
 * Bug: parkTopic() runs its create path (gh issue create / parking-lot.md
 * append) unconditionally with no pre-existence lookup and no uniqueness
 * gate, so re-parking a topic whose normalized title matches an already-open
 * issue spawns a second near-identical issue. The file fallback path appends
 * blindly too.
 *
 * Contract:
 *   - Park "foo" twice → second call returns the existing issue URL, no second
 *     `gh issue create`.
 *   - Park "Foo" then "foo" → match via normalization (case/whitespace/punct).
 *   - Park "foo" then "foo bar" → no match, second issue created.
 *   - gh lookup failure → fall through to create (don't block parking).
 *   - File fallback: same dedup on parking-lot.md (no duplicate `## <title>`).
 *
 * All child_process.execFile calls are mocked — the test never hits the
 * network or the live repo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock child_process before importing the module under test.
vi.mock('child_process', () => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], opts: unknown, cb?: Function) => {
      if (typeof opts === 'function') cb = opts as Function;
      if (cb) cb(null, { stdout: '', stderr: '' });
    },
  ),
}));

import { execFile } from 'child_process';
import {
  parkTopic,
  normalizeTitle,
  findExistingIssue,
  type ParkingLotEntry,
} from '../src/lib/parking-lot';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

/**
 * A scripted execFile mock. Maps the (cmd, args) shape of each gh/git call to
 * canned stdout so we can simulate an existing-issue lookup deterministically.
 * `createCalls` records every `gh issue create` invocation so we can assert
 * the dedup gate suppressed the second create.
 */
interface Scenario {
  ghAuth?: { ok: boolean };
  remote?: string;
  /** JSON array string returned by `gh issue list ... --json ...`. */
  issueListJson?: string;
  /** Throw instead of returning a list (transient lookup failure). */
  issueListThrows?: boolean;
  /** URL returned by `gh issue create`. */
  createUrl?: string;
}

function installMock(scenario: Scenario): { createCalls: string[][]; listCalls: string[][] } {
  const createCalls: string[][] = [];
  const listCalls: string[][] = [];

  mockExecFile.mockImplementation(
    (cmd: string, args: string[], opts: unknown, cb?: Function) => {
      if (typeof opts === 'function') cb = opts as Function;
      const done = cb as Function;

      // git remote get-url origin
      if (cmd === 'git' && args[0] === 'remote') {
        return done(null, { stdout: (scenario.remote ?? 'git@github.com:owner/repo.git') + '\n', stderr: '' });
      }

      // gh auth status
      if (cmd === 'gh' && args[0] === 'auth') {
        if (scenario.ghAuth?.ok === false) {
          return done(new Error('not authenticated'), { stdout: '', stderr: '' });
        }
        return done(null, { stdout: 'Logged in', stderr: '' });
      }

      // gh issue list ... (the dedup lookup)
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        listCalls.push(args as string[]);
        if (scenario.issueListThrows) {
          return done(new Error('network error'), { stdout: '', stderr: '' });
        }
        return done(null, { stdout: scenario.issueListJson ?? '[]', stderr: '' });
      }

      // gh issue create ...
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        createCalls.push(args as string[]);
        return done(null, { stdout: (scenario.createUrl ?? 'https://github.com/owner/repo/issues/1') + '\n', stderr: '' });
      }

      return done(null, { stdout: '', stderr: '' });
    },
  );

  return { createCalls, listCalls };
}

function entry(title: string, body = 'some body'): ParkingLotEntry {
  return {
    title,
    body,
    labels: ['idea', 'inbox'],
    sessionScope: 'Current scope',
    createdAt: '2026-06-04T00:00:00.000Z',
  };
}

let tmpDir: string;

beforeEach(() => {
  mockExecFile.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-dedup-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── normalizeTitle ───────────────────────────────────────────────────────

describe('normalizeTitle()', () => {
  it('lowercases, collapses whitespace, strips punctuation', () => {
    expect(normalizeTitle('Add OAuth support')).toBe('add oauth support');
    expect(normalizeTitle('add oauth support')).toBe('add oauth support');
    expect(normalizeTitle('  Add   OAuth   support! ')).toBe('add oauth support');
    expect(normalizeTitle('Add OAuth, support.')).toBe('add oauth support');
  });

  it('distinguishes genuinely different titles', () => {
    expect(normalizeTitle('foo')).not.toBe(normalizeTitle('foo bar'));
  });
});

// ─── findExistingIssue (the dedup gate) ───────────────────────────────────

describe('findExistingIssue()', () => {
  it('returns the URL of an open issue with a matching normalized title', async () => {
    installMock({
      issueListJson: JSON.stringify([
        { number: 7, title: 'Add OAuth support', url: 'https://github.com/owner/repo/issues/7' },
      ]),
    });

    const url = await findExistingIssue(entry('add  oauth  support!'), 'owner/repo');
    expect(url).toBe('https://github.com/owner/repo/issues/7');
  });

  it('returns null when no open issue matches after normalization', async () => {
    installMock({
      issueListJson: JSON.stringify([
        { number: 7, title: 'Add OAuth support', url: 'https://github.com/owner/repo/issues/7' },
      ]),
    });

    const url = await findExistingIssue(entry('foo bar'), 'owner/repo');
    expect(url).toBeNull();
  });

  it('returns null (fall through to create) when the lookup itself fails', async () => {
    installMock({ issueListThrows: true });

    const url = await findExistingIssue(entry('foo'), 'owner/repo');
    expect(url).toBeNull();
  });
});

// ─── parkTopic — GitHub path dedup ────────────────────────────────────────

describe('parkTopic() — GitHub dedup', () => {
  it('park "foo" twice → second returns existing URL, no second create', async () => {
    // First park: list returns empty, so an issue gets created.
    const first = installMock({ issueListJson: '[]', createUrl: 'https://github.com/owner/repo/issues/10' });
    const r1 = await parkTopic(tmpDir, entry('foo'));
    expect(r1.method).toBe('github');
    expect(r1.url).toBe('https://github.com/owner/repo/issues/10');
    expect(first.createCalls.length).toBe(1);

    // Second park: list now returns the existing issue → dedup gate fires.
    const second = installMock({
      issueListJson: JSON.stringify([
        { number: 10, title: 'foo', url: 'https://github.com/owner/repo/issues/10' },
      ]),
    });
    const r2 = await parkTopic(tmpDir, entry('foo'));
    expect(r2.method).toBe('github');
    expect(r2.url).toBe('https://github.com/owner/repo/issues/10');
    expect(r2.deduped).toBe(true);
    // The gate must have prevented a second `gh issue create`.
    expect(second.createCalls.length).toBe(0);
  });

  it('park "Foo" then "foo" → matched via normalization, no second create', async () => {
    const second = installMock({
      issueListJson: JSON.stringify([
        { number: 11, title: 'Foo', url: 'https://github.com/owner/repo/issues/11' },
      ]),
    });
    const r = await parkTopic(tmpDir, entry('foo'));
    expect(r.method).toBe('github');
    expect(r.url).toBe('https://github.com/owner/repo/issues/11');
    expect(r.deduped).toBe(true);
    expect(second.createCalls.length).toBe(0);
  });

  it('park "foo" then "foo bar" → no match, second issue created', async () => {
    const m = installMock({
      issueListJson: JSON.stringify([
        { number: 12, title: 'foo', url: 'https://github.com/owner/repo/issues/12' },
      ]),
      createUrl: 'https://github.com/owner/repo/issues/13',
    });
    const r = await parkTopic(tmpDir, entry('foo bar'));
    expect(r.method).toBe('github');
    expect(r.url).toBe('https://github.com/owner/repo/issues/13');
    expect(r.deduped).toBeFalsy();
    expect(m.createCalls.length).toBe(1);
  });

  it('lookup failure does NOT block parking — issue still created', async () => {
    const m = installMock({ issueListThrows: true, createUrl: 'https://github.com/owner/repo/issues/14' });
    const r = await parkTopic(tmpDir, entry('foo'));
    expect(r.method).toBe('github');
    expect(r.url).toBe('https://github.com/owner/repo/issues/14');
    expect(m.createCalls.length).toBe(1);
  });
});

// ─── parkTopic — file fallback dedup ──────────────────────────────────────

describe('parkTopic() — file fallback dedup', () => {
  it('park "foo" twice into parking-lot.md → only one `## foo` block', async () => {
    // gh unavailable → file fallback for both parks.
    installMock({ ghAuth: { ok: false } });

    const r1 = await parkTopic(tmpDir, entry('foo'));
    expect(r1.method).toBe('file');

    const r2 = await parkTopic(tmpDir, entry('Foo'));
    expect(r2.method).toBe('file');
    expect(r2.deduped).toBe(true);

    const content = fs.readFileSync(
      path.join(tmpDir, '.minspec', 'parking-lot.md'),
      'utf-8',
    );
    const headingCount = (content.match(/^## /gm) || []).length;
    expect(headingCount).toBe(1);
  });

  it('park "foo" then "foo bar" into parking-lot.md → two blocks', async () => {
    installMock({ ghAuth: { ok: false } });

    await parkTopic(tmpDir, entry('foo'));
    await parkTopic(tmpDir, entry('foo bar'));

    const content = fs.readFileSync(
      path.join(tmpDir, '.minspec', 'parking-lot.md'),
      'utf-8',
    );
    const headingCount = (content.match(/^## /gm) || []).length;
    expect(headingCount).toBe(2);
  });
});
