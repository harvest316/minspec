/**
 * Build provenance — is the extension you are RUNNING older than the checkout you are
 * editing? (#1439)
 *
 * The failure this exists to make visible, measured 2026-08-12: the installed build was
 * `aiclarity.minspec 0.1.26` from 2026-08-06 02:09. #1317's pre-approval ownership guard
 * landed 2026-08-07 03:02. For five days every approval bypassed a gate that was green on
 * `main`, four specs were approved into a state their own validator rejects, `main` went red
 * repeatedly, and two PRs were written to re-fix an already-fixed bug. Nothing surfaced it.
 *
 * **A version check cannot catch this.** Both the stale build and the rebuilt one are
 * `0.1.26` — the version was never bumped between them. The skew is in the BUILD, not the
 * version, so provenance has to be the commit the bundle was built from.
 *
 * Scope: this only speaks up when the open workspace IS a MinSpec checkout (dogfooding).
 * A normal user's installed build legitimately differs from any repo they open, and warning
 * there would be noise — the constitution's blast-radius rule in spirit.
 *
 * Tier-0: local `git` only, no network, no LLM. Never throws — provenance is a convenience,
 * and an unreadable one must never block activation.
 */
import { execFileSync } from 'child_process';

/**
 * The commit this bundle was built from, injected by esbuild `--define` at package time
 * (see `scripts/build-extension.sh`). Deliberately a bare identifier rather than an import
 * so the bundler can substitute it as a literal.
 *
 * `'dev'` in a non-packaged build (plain `npm run build`, tests, F5 debugging) — those are
 * compiled from the working tree by definition, so there is nothing to compare.
 */
declare const __MINSPEC_BUILD_SHA__: string | undefined;

/** Resolve the injected SHA without exploding when the define was never applied. */
export function buildSha(): string {
  try {
    return typeof __MINSPEC_BUILD_SHA__ === 'string' ? __MINSPEC_BUILD_SHA__ : 'dev';
  } catch {
    return 'dev';
  }
}

/**
 * A short, human-readable identity for the running bundle — for display anywhere,
 * in ANY workspace (#1549).
 *
 * {@link detectBuildSkew} deliberately answers "are you behind?" and can only do so
 * inside a MinSpec checkout, because ancestry needs MinSpec's own git history. That
 * leaves every ADOPTER project unable to answer the weaker but more common question:
 * *which build am I even running?*
 *
 * This is the gap that bit twice in one day. A gate fix shipped, the version string
 * did not change (the extension is installed from a locally-built vsix), and a stale
 * install kept reproducing a bug that was already fixed upstream. Nothing anywhere in
 * the UI could distinguish the two builds, so the contradiction — "the source says
 * fixed, my repo says broken" — cost a full diagnosis cycle before someone thought to
 * compare the installed bundle against the repo by hand.
 *
 * Note the circularity this breaks: harness-drift detection compares the project's
 * scaffolded files against the templates carried by the RUNNING build, so a stale
 * build's templates look perfectly current to it. Staleness is structurally invisible
 * to every other signal MinSpec has; only the build's own identity escapes it.
 *
 * Offline and pure — reads the injected literal, never git, so it is safe on any
 * activation path and in any workspace.
 */
export function buildLabel(): string {
  const sha = buildSha();
  return sha === 'dev' ? 'dev build' : `build ${sha.slice(0, 7)}`;
}

export type SkewVerdict =
  /** Not a MinSpec checkout, not a git repo, or a dev build — nothing to say. */
  | { kind: 'not-applicable'; reason: string }
  /** The running build was made from a commit that IS in this checkout's history. */
  | { kind: 'current'; sha: string }
  /** The running build predates HEAD — gates added since are NOT running. */
  | { kind: 'stale'; sha: string; behind: number }
  /** The build's commit is unknown here (different repo, shallow clone, gc'd). */
  | { kind: 'unknown'; sha: string; reason: string };

function git(rootDir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1 << 20,
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/**
 * Compare the running build's commit against the workspace's HEAD.
 *
 * `stale` requires the build SHA to be a genuine ANCESTOR of HEAD — not merely different.
 * A build from a sibling branch, or from a commit this clone has never seen, is `unknown`,
 * not `stale`: claiming "you are behind" without an ancestry proof would be the same
 * unearned confidence this module exists to prevent.
 */
export function detectBuildSkew(
  rootDir: string,
  isMinspecRepo: boolean,
  /**
   * The build's commit. Defaults to the esbuild-injected stamp; injectable so tests can
   * exercise the stale/current/unknown branches, which are otherwise unreachable — under
   * vitest the define is absent, `buildSha()` is `'dev'`, and the function short-circuits
   * before any git call. Same seam idiom as `approveSpec`'s `now()` parameter.
   */
  sha: string = buildSha(),
): SkewVerdict {
  if (sha === 'dev') {
    return { kind: 'not-applicable', reason: 'development build — compiled from the working tree' };
  }
  if (!isMinspecRepo) {
    return { kind: 'not-applicable', reason: 'workspace is not a MinSpec checkout' };
  }
  const head = git(rootDir, ['rev-parse', 'HEAD']);
  if (head === undefined) {
    return { kind: 'not-applicable', reason: 'not a git checkout' };
  }
  if (head === sha) return { kind: 'current', sha };

  // Does this clone even know the build's commit?
  if (git(rootDir, ['cat-file', '-e', `${sha}^{commit}`]) === undefined) {
    return {
      kind: 'unknown',
      sha,
      reason: 'the build commit is not in this clone (different repo, shallow clone, or pruned)',
    };
  }

  // Ancestor => the checkout has moved on and the build is genuinely behind.
  if (git(rootDir, ['merge-base', '--is-ancestor', sha, 'HEAD']) === undefined) {
    return { kind: 'unknown', sha, reason: 'the build commit is not an ancestor of HEAD' };
  }

  const behind = Number(git(rootDir, ['rev-list', '--count', `${sha}..HEAD`]) ?? '0');
  return Number.isFinite(behind) && behind > 0
    ? { kind: 'stale', sha, behind }
    : { kind: 'current', sha };
}

/**
 * The advisory text. Names the concrete consequence rather than "please update" — the whole
 * point is that the reader cannot otherwise tell a silent gate from a satisfied one.
 *
 * Scoped to what the build stamp actually governs (#1544): only code compiled into the
 * extension bundle goes stale with the build. Most of this repo's gates are repo-side —
 * git hooks, `spec-gate.sh`, CI — and are read off the working tree at invocation time, so
 * they are current the moment a commit lands, no rebuild involved. An unqualified "any gate
 * added since is NOT running here" is false for those, and being MORE alarming than the
 * truth teaches the reader to discount the warning — including the one case it is exactly
 * right about, the extension's pre-approval ownership guard (#1439).
 */
export function skewMessage(v: Extract<SkewVerdict, { kind: 'stale' }>): string {
  return (
    `MinSpec is running a build from ${v.sha.slice(0, 7)}, ${v.behind} commit${v.behind === 1 ? '' : 's'} ` +
    `behind this checkout. Gates that live in the extension — including the pre-approval ` +
    `ownership check — are NOT running the current code here, so an approval or commit may ` +
    `pass a check main would refuse. Repo-side gates (git hooks, spec-gate, CI) are unaffected ` +
    `— they read the working tree directly. Rebuild to re-arm the extension's gates.`
  );
}
