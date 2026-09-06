/**
 * Build provenance (#1439) — detect a running build older than the checkout.
 *
 * These drive `detectBuildSkew` itself, via its injectable `sha` seam. An earlier revision
 * asserted raw `git merge-base` / `rev-list` output instead and claimed to pin the
 * stale-vs-unknown distinction — it pinned nothing: under vitest the esbuild define is
 * absent, so `buildSha()` is `'dev'` and the function short-circuited to `not-applicable`
 * before any git call. Those assertions would have passed unchanged if the function returned
 * `current` for a genuinely stale build. Caught by ai-review on #1477; the seam exists so the
 * load-bearing branches are actually reachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectBuildSkew, skewMessage, buildSha } from '../src/lib/build-provenance';

let repo: string;
let sideSha: string;
const git = (args: string[], cwd = repo) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const shaAt = (rev: string) => git(['rev-parse', rev]);

/** A throwaway repo with three linear commits plus a divergent branch. */
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-prov-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  fs.mkdirSync(path.join(repo, '.minspec'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.minspec', 'constitution.md'), '# c\n');
  for (const n of ['one', 'two', 'three']) {
    fs.writeFileSync(path.join(repo, `${n}.txt`), n);
    git(['add', '-A']);
    git(['commit', '-qm', n]);
  }
  // A commit that exists in the clone but is NOT an ancestor of HEAD.
  git(['checkout', '-q', '-b', 'side', 'HEAD~1']);
  fs.writeFileSync(path.join(repo, 'side.txt'), 'side');
  git(['add', '-A']);
  git(['commit', '-qm', 'side']);
  sideSha = shaAt('HEAD');
  git(['checkout', '-q', 'main']);
});

afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('detectBuildSkew — the verdict, not just the git plumbing', () => {
  it('STALE: a build two commits back reports stale with the right distance', () => {
    const v = detectBuildSkew(repo, true, shaAt('HEAD~2'));
    expect(v.kind).toBe('stale');
    if (v.kind === 'stale') expect(v.behind).toBe(2);
  });

  it('STALE: one commit back pluralises as "1 commit"', () => {
    const v = detectBuildSkew(repo, true, shaAt('HEAD~1'));
    expect(v.kind).toBe('stale');
    if (v.kind === 'stale') {
      expect(v.behind).toBe(1);
      expect(skewMessage(v)).toContain('1 commit behind');
      expect(skewMessage(v)).not.toContain('1 commits');
    }
  });

  it('CURRENT: a build from HEAD is not stale', () => {
    expect(detectBuildSkew(repo, true, shaAt('HEAD')).kind).toBe('current');
  });

  it('UNKNOWN: a divergent-branch commit is NOT reported as stale', () => {
    // Present in the clone, but not behind HEAD. Reporting "you are behind" here would be
    // the unearned confidence this module exists to remove.
    const v = detectBuildSkew(repo, true, sideSha);
    expect(v.kind).toBe('unknown');
  });

  it('UNKNOWN: a commit this clone has never seen', () => {
    const v = detectBuildSkew(repo, true, '0000000000000000000000000000000000000000');
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') expect(v.reason).toContain('not in this clone');
  });
});

describe('detectBuildSkew — scope', () => {
  it('says nothing for a dev build, compiled from the working tree by definition', () => {
    expect(detectBuildSkew(repo, true, 'dev').kind).toBe('not-applicable');
  });

  it('says nothing outside a MinSpec checkout, even with a real stale SHA', () => {
    // A normal user's installed build legitimately differs from any repo they open.
    const v = detectBuildSkew(repo, false, shaAt('HEAD~2'));
    expect(v.kind).toBe('not-applicable');
  });

  it('says nothing when the folder is not a git checkout', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-nogit-'));
    try {
      expect(detectBuildSkew(plain, true, shaAt('HEAD~2')).kind).toBe('not-applicable');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('defaults to the injected stamp, which is `dev` under vitest', () => {
    // Pins the seam's default rather than leaving it implicit.
    expect(buildSha()).toBe('dev');
    expect(detectBuildSkew(repo, true).kind).toBe('not-applicable');
  });
});

describe('skewMessage', () => {
  const msg = (behind: number) => skewMessage({ kind: 'stale', sha: 'abcdef1234567890', behind });

  it('names the consequence — a gate that is not running — not merely the fact', () => {
    expect(msg(5)).toContain('NOT running');
    expect(msg(5)).toContain('Rebuild');
  });

  it('reports the short sha and the distance', () => {
    expect(msg(5)).toContain('abcdef1');
    expect(msg(5)).toContain('5 commits');
  });

  it('scopes the claim to the extension, not all gates (#1544)', () => {
    // Only code compiled into the bundle goes stale with the build — repo-side gates
    // (git hooks, spec-gate, CI) read the working tree directly and are unaffected. An
    // unscoped "any gate added since is NOT running here" is false for those and teaches
    // the reader to discount the warning, including the one case it is right about.
    expect(msg(5)).toContain('extension');
    expect(msg(5).toLowerCase()).not.toMatch(/\bany gate\b/);
  });
});
