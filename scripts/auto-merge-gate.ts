#!/usr/bin/env -S npx tsx
/**
 * auto-merge-gate.ts — SPEC-024 IO/exec layer (FR-2 prover + FR-6/FR-7 wiring).
 *
 * The dispatch (`dispatch-issue.sh`, #172) shells out to this AFTER a PR's checks
 * are green. It does the IMPURE work the pure gate (`decideAutoMerge`) cannot:
 *
 *   1. FR-2 red→green PROVER — the SOLE authority for `regressionProvenBaseRed`.
 *      Runs the named regression test against BASE (must FAIL) and HEAD (must
 *      PASS) in an isolated worktree. Any of {test not found, green on base, red
 *      on head, non-deterministic} ⇒ NOT proven. Its result OVERWRITES any
 *      agent-supplied proof flag before it reaches `decideAutoMerge` (INV-3).
 *   2. Builds the `AutoMergeInput`: consequence signals via `runConsequenceAnalyzers`
 *      over the diff, hollow findings via `scanTestSource` over changed tests, and
 *      the #180 review-signal prose (from the merged signals file).
 *   3. Calls the PURE `decideAutoMerge`.
 *   4. FR-7 audit — appends the decision to `.minspec/auto-merge-audit.log`.
 *   5. Prints the decision JSON (+ the prover-authoritative #180 block) to stdout;
 *      the shell branches on `eligible` (merge vs hold).
 *
 * Run via tsx (the repo's TS-script runner, same as `npm run validate`):
 *   npx tsx scripts/auto-merge-gate.ts \
 *     --worktree <path> --base <sha> --mode <consequence-hybrid|pr-gate> \
 *     --pr <number> --signals-file <path-to-merged-signals.json>
 *
 * STDOUT is ONLY the decision JSON. All diagnostics go to STDERR. Any internal
 * error prints a fail-safe HOLD decision (never an accidental eligible=true).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  decideAutoMerge,
  LOW_BLAST_DOCS_TEST,
  type AutoMergeInput,
  type AutoMergeDecision,
  type AutoMergeMode,
  type ProverResult,
} from '../packages/minspec/src/lib/auto-merge';
import {
  runConsequenceAnalyzers,
  type ChangedFile,
  type ChangeStatus,
} from '../packages/minspec/src/lib/consequence-analyzers';
import { scanTestSource, type TestFinding } from '../packages/minspec/src/lib/test-scanner';
import type { ClassificationSignal } from '../packages/minspec/src/lib/classifier';
import { renderReviewSignals } from '../packages/shared/src/review-signals';
import type { ReviewSignalsInput } from '../packages/shared/src/review-signals';
import {
  MACHINERY_DIR_PREFIXES,
  MACHINERY_SINGLE_FILES,
} from '../packages/minspec/src/lib/machinery-paths';

// ─── Arg parsing ─────────────────────────────────────────────────────────────

interface Args {
  worktree: string;
  base: string;
  mode: AutoMergeMode;
  pr: string;
  signalsFile?: string;
}

/**
 * MAJOR 3 + MAJOR 4 — deny-by-default mode resolution (the kill-switch).
 *
 * Auto-merge is OPT-IN and HARD to turn on: the mode is `consequence-hybrid`
 * ONLY when the caller passes EXACTLY that token (whitespace-trimmed). ANY other
 * value — absent (the DEFAULT), empty, misspelled, differently-cased, or garbage
 * — resolves to `pr-gate` (HOLD). There is NO fail-open path: an unrecognized
 * mode string can never enable auto-merge. This mirrors the POSITIVE, exact shell
 * guard in dispatch-issue.sh (`[[ "$MODE" == "consequence-hybrid" ]]`), so the
 * two gates agree byte-for-byte on what "on" means.
 */
export function resolveMode(raw: string | undefined): AutoMergeMode {
  return String(raw ?? '').trim() === 'consequence-hybrid' ? 'consequence-hybrid' : 'pr-gate';
}

export function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const val = argv[i + 1];
    if (!key?.startsWith('--')) continue;
    out[key.slice(2)] = val ?? '';
  }
  return {
    worktree: path.resolve(out.worktree || process.cwd()),
    base: out.base || 'origin/main',
    // Deny-by-default: unknown/absent ⇒ pr-gate (HOLD). Opt-in only.
    mode: resolveMode(out.mode),
    pr: out.pr || '',
    signalsFile: out['signals-file'],
  };
}

function log(msg: string): void {
  process.stderr.write(`auto-merge-gate: ${msg}\n`);
}

// ─── git helpers ─────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Try a git command; return undefined instead of throwing (e.g. missing blob). */
function gitTry(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

// ─── FR-2 red→green prover ───────────────────────────────────────────────────

export interface VitestRun {
  numTotal: number;
  numPassed: number;
  numFailed: number;
  exitCode: number;
  files: string[]; // absolute paths of test files that ran
}

/** HEAD green = the named test EXECUTED and every assertion passed. */
export function headGreenVerdict(r: VitestRun): boolean {
  return r.numTotal >= 1 && r.numFailed === 0 && r.numPassed >= 1;
}

/**
 * BLOCKER 2 — BASE 'red' means the named test EXECUTED and FAILED an assertion:
 * `numPassed === 0 && numFailed >= 1`.
 *
 * The OLD predicate ALSO counted `numTotal === 0 && exitCode !== 0` as red. But
 * that state is a test that FAILED TO LOAD (e.g. it imports a symbol that exists
 * only on head, so the file cannot resolve on base) or ANY broken base env — i.e.
 * INCONCLUSIVE, not a genuine assertion-red. Counting it red produced a FALSE
 * proof of red→green (the prover is the SOLE authority for INV-3). Inconclusive
 * on base ⇒ NOT red ⇒ NOT proven ⇒ hold.
 */
export function baseRedVerdict(r: VitestRun): boolean {
  return r.numPassed === 0 && r.numFailed >= 1;
}

/**
 * #513 — a run where NOTHING executed (`numFailed === 0 && numPassed === 0`)
 * means the named test was NOT SELECTED, not that it failed. Two shapes fold in:
 *
 *   - `numTotal === 0` — no test file / no test collected at all; and
 *   - vitest's SKIPPED-reporting for a `-t` pattern that matched a FILE but no
 *     test inside it: `numTotal: 1, numPassed: 0, numFailed: 0, numPending: 1`.
 *
 * The OLD not-found guard checked only `numTotal === 0`, so the skipped shape
 * slipped past it, then `headGreenVerdict` (needs a pass) read the 0-passed run as
 * a FALSE "RED on head" — the exact #513 defect that made the prover inert on the
 * common nested-`describe` case (a mis-joined `-t` pattern selects nothing). A
 * selection miss is INCONCLUSIVE / not-found, never a genuine red (which is
 * `numFailed >= 1`).
 */
export function testNotSelected(r: VitestRun): boolean {
  return r.numFailed === 0 && r.numPassed === 0;
}

/**
 * #513 — build the vitest `-t` pattern from the test-name portion of a doc-format
 * regression id (`file > describe > … > it`, split on the FIRST ` > `).
 *
 * vitest matches `-t` as a REGEX (`new RegExp(pattern)`, no flags) against each
 * test's full name — which vitest builds by joining the ancestor `describe` titles
 * and the `it` title with a single SPACE (`getTaskFullName`), NOT ` > `. So we:
 *   1. normalize any internal ` > ` separators in the name portion to a single
 *      space, so the pattern matches that space-join; and
 *   2. regex-escape the result so title metacharacters (`.`, `(`, `)`, `+`, `[`,
 *      …) match LITERALLY instead of acting as regex operators (e.g. an unescaped
 *      `(v1.2)` becomes a capture group and matches nothing against the literal
 *      `(v1.2)` in the name).
 * Without this the pattern matches NOTHING → vitest reports the test skipped →
 * false "RED on head" → `regression-unproven`, which made auto-merge inert on
 * every nested-`describe` regression (the common case). `#` is intentionally NOT
 * escaped — it is a literal in JS regex, and vitest compiles without the `u` flag.
 */
export function toVitestNamePattern(testNamePortion: string): string {
  const spaceJoined = testNamePortion.split(' > ').join(' ');
  return spaceJoined.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Run vitest filtered to a single named regression test in `dir`, via the JSON
 * reporter (robust, structured — never scrape human output). Captures the run
 * even on non-zero exit (a failing test is the expected "red" state).
 */
function runNamedTest(dir: string, testFile: string, testName: string): VitestRun {
  const outFile = path.join(os.tmpdir(), `minspec-prover-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const vitestArgs = [
    'vitest',
    'run',
    testFile,
    // #513: `-t` is a REGEX matched against vitest's SPACE-joined full name —
    // normalize ` > ` → space and regex-escape, else nested-`describe` tests
    // match nothing and read as a false red.
    '-t',
    toVitestNamePattern(testName),
    '--reporter=json',
    `--outputFile=${outFile}`,
    '--no-color',
  ];
  let exitCode = 0;
  try {
    execFileSync('npx', vitestArgs, { cwd: dir, encoding: 'utf8', stdio: 'ignore', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    exitCode = typeof (e as { status?: number }).status === 'number' ? (e as { status: number }).status : 1;
  }

  let numTotal = 0;
  let numPassed = 0;
  let numFailed = 0;
  const files: string[] = [];
  try {
    const raw = fs.readFileSync(outFile, 'utf8');
    const json = JSON.parse(raw) as {
      numTotalTests?: number;
      numPassedTests?: number;
      numFailedTests?: number;
      testResults?: Array<{ name?: string }>;
    };
    numTotal = json.numTotalTests ?? 0;
    numPassed = json.numPassedTests ?? 0;
    numFailed = json.numFailedTests ?? 0;
    for (const r of json.testResults ?? []) {
      if (r.name) files.push(r.name);
    }
  } catch {
    // No/!parseable JSON — leave zeros; exitCode drives the collection-error path.
  } finally {
    try {
      fs.rmSync(outFile, { force: true });
    } catch {
      /* ignore */
    }
  }
  return { numTotal, numPassed, numFailed, exitCode, files };
}

/**
 * Injectable seams so the prover's DECISION LOGIC is testable deterministically
 * (the four BLOCKER-2 scenarios) without spawning real vitest / git worktrees —
 * a flaky safety test on the highest-consequence code is itself a liability.
 * Defaults do the real IO.
 */
export interface ProverDeps {
  runNamedTest?: (dir: string, testFile: string, testName: string) => VitestRun;
  /**
   * Prepare the isolated base worktree: add it, share deps, overlay the head
   * test file(s). MUST THROW on ANY failure — a half-prepared base is NOT a
   * trustworthy red (BLOCKER 2). Never swallow-and-continue.
   */
  prepareBase?: (worktree: string, base: string, baseDir: string, overlayFiles: string[]) => void;
  removeBase?: (worktree: string, baseDir: string) => void;
}

/**
 * Default base-prep. THROWS on any failure (BLOCKER 2): worktree add, the
 * node_modules symlink (without deps a "red" would be a load error, not an
 * assertion failure), and each test-file overlay (without it the base runs the
 * OLD test or none) — every step must succeed or the base is not trustworthy.
 */
function defaultPrepareBase(worktree: string, base: string, baseDir: string, overlayFiles: string[]): void {
  git(worktree, ['worktree', 'add', '--detach', baseDir, base]);

  const headNodeModules = path.join(worktree, 'node_modules');
  if (fs.existsSync(headNodeModules)) {
    fs.symlinkSync(headNodeModules, path.join(baseDir, 'node_modules'), 'dir');
  }

  for (const abs of overlayFiles) {
    const rel = path.relative(worktree, abs);
    const dest = path.join(baseDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
}

function defaultRemoveBase(worktree: string, baseDir: string): void {
  try {
    git(worktree, ['worktree', 'remove', '--force', baseDir]);
  } catch {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Prove the named regression is a genuine red→green: it must EXECUTE-AND-FAIL on
 * BASE (the new/modified test run against the PRE-FIX source) and PASS on HEAD.
 * Runs each side TWICE and requires a consistent verdict (flaky ⇒ NOT proven).
 *
 * Fail-safe (BLOCKER 2):
 *  - base 'red' requires a real assertion failure (`baseRedVerdict`), NOT a
 *    load/collection error (import of a head-only symbol on base is INCONCLUSIVE);
 *  - ANY base-prep failure ABORTS to NOT-proven — never run a half-prepared base.
 */
export function proveRegression(
  worktree: string,
  base: string,
  regressionTest?: string,
  deps: ProverDeps = {},
): ProverResult {
  const run = deps.runNamedTest ?? runNamedTest;
  const prepareBase = deps.prepareBase ?? defaultPrepareBase;
  const removeBase = deps.removeBase ?? defaultRemoveBase;

  const notProven = (note: string): ProverResult => ({
    regressionProvenBaseRed: false,
    regressionGreenOnHead: false,
    note,
  });

  if (!regressionTest || regressionTest.trim() === '') {
    return notProven('no regression test named — nothing to prove');
  }
  // "<file> > <test name>" (renderReviewSignals convention). Fall back to the
  // whole string as a name filter when there is no ' > ' separator.
  const sepIdx = regressionTest.indexOf(' > ');
  const testFile = sepIdx >= 0 ? regressionTest.slice(0, sepIdx).trim() : '';
  const testName = sepIdx >= 0 ? regressionTest.slice(sepIdx + 3).trim() : regressionTest.trim();

  // ── HEAD: run twice; establishes the test EXISTS and is green on head. ──
  const head1 = run(worktree, testFile, testName);
  // #513 FAIL-SAFE: a SELECTION MISS (nothing ran — `numFailed === 0 &&
  // numPassed === 0`, whether 0-collected OR vitest's skipped-reporting for a
  // `-t` that matched the file but no test) is NOT a red. Surface it distinctly
  // as not-found / inconclusive so a mis-named regression test is fixed, never
  // silently read by `headGreenVerdict` as a false "RED on head" (the defect that
  // made the prover inert on nested-`describe` tests).
  if (testNotSelected(head1)) {
    return notProven(
      `regression test not selectable on head — matched no test (check the name; not found or mis-named): ${regressionTest}`,
    );
  }
  const head2 = run(worktree, testFile, testName);
  const head1Green = headGreenVerdict(head1);
  const head2Green = headGreenVerdict(head2);
  if (head1Green !== head2Green) {
    return notProven('non-deterministic on head (flaky) — treated as NOT proven');
  }
  if (!head1Green) {
    return notProven('named regression is RED on head — not a passing fix');
  }

  // Resolve the actual test file path(s) that ran on head, to overlay onto base
  // (so the new test runs against OLD source — the RCDD red→green technique).
  const overlayFiles = head1.files.filter((f) => f.startsWith(worktree + path.sep) || f.startsWith(worktree));

  // ── BASE: isolated worktree, overlay the head test file(s), run twice. ──
  const baseDir = path.join(os.tmpdir(), `minspec-prover-base-${process.pid}-${Date.now()}`);
  try {
    // FAIL-SAFE (BLOCKER 2): any base-prep failure ⇒ NOT proven. A half-prepared
    // base (missing deps / un-overlaid test) yields a load-error "red" that is a
    // FALSE proof — abort rather than run it.
    try {
      prepareBase(worktree, base, baseDir, overlayFiles);
    } catch (e) {
      return notProven(`base preparation failed: ${(e as Error).message} — base not trustworthy, NOT proven`);
    }

    const base1 = run(baseDir, testFile, testName);
    const base2 = run(baseDir, testFile, testName);
    const base1Red = baseRedVerdict(base1);
    const base2Red = baseRedVerdict(base2);
    if (base1Red !== base2Red) {
      return notProven('non-deterministic on base (flaky) — treated as NOT proven');
    }
    if (!base1Red) {
      // The test either PASSES on base (not a regression) or was INCONCLUSIVE
      // (failed to load / collected 0 tests). Neither proves red ⇒ NOT proven.
      return notProven('named regression did not EXECUTE-AND-FAIL on base (passed or inconclusive) — not proven');
    }

    return {
      regressionProvenBaseRed: true,
      regressionGreenOnHead: true,
      note: `proven red→green: '${regressionTest}' fails on base (${base}), passes on head`,
    };
  } catch (e) {
    return notProven(`prover error: ${(e as Error).message}`);
  } finally {
    // Always attempt cleanup — prepareBase may have added the worktree before a
    // later step threw. removeBase is idempotent / best-effort.
    try {
      removeBase(worktree, baseDir);
    } catch {
      /* ignore */
    }
  }
}

// ─── Consequence signals over the diff (FR-5 input) ──────────────────────────

function mapStatus(code: string): ChangeStatus {
  const c = code[0];
  if (c === 'A') return 'added';
  if (c === 'D') return 'deleted';
  if (c === 'R') return 'renamed';
  return 'modified';
}

export function buildChangedFiles(worktree: string, base: string): ChangedFile[] {
  // MAJOR 5 — the diff enumeration is load-bearing: a SWALLOWED git failure
  // (the old `?? ''`) yields ZERO changed files → empty consequence signals →
  // blast=low → auto-merge on an INFRA failure. So a failing diff command
  // THROWS, and main()'s catch turns the throw into a fail-safe HOLD. NOTE: an
  // empty string from a SUCCESSFUL git call is a legitimately empty diff and is
  // fine — only `undefined` (the command itself failing) forces the hold.
  const nameStatus = gitTry(worktree, ['diff', '--name-status', `${base}...HEAD`]);
  if (nameStatus === undefined) {
    throw new Error(
      `git diff --name-status against '${base}' failed — cannot enumerate changed files (fail-safe HOLD)`,
    );
  }
  const numstatRaw = gitTry(worktree, ['diff', '--numstat', `${base}...HEAD`]);
  if (numstatRaw === undefined) {
    throw new Error(
      `git diff --numstat against '${base}' failed — cannot measure the diff (fail-safe HOLD)`,
    );
  }

  // path → { insertions, deletions }
  const numstat = new Map<string, { insertions: number; deletions: number }>();
  for (const line of numstatRaw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const ins = parts[0] === '-' ? 0 : Number(parts[0]) || 0;
    const del = parts[1] === '-' ? 0 : Number(parts[1]) || 0;
    const p = parts[parts.length - 1];
    numstat.set(p, { insertions: ins, deletions: del });
  }

  const files: ChangedFile[] = [];
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0];
    const status = mapStatus(code);
    // For renames, git prints "R100\told\tnew"; the current path is the last.
    const oldPath = parts.length >= 3 ? parts[1] : parts[1];
    const curPath = parts[parts.length - 1];
    if (!curPath) continue;

    const abs = path.join(worktree, curPath);
    let content: string | undefined;
    if (status !== 'deleted') {
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        content = undefined;
      }
    }
    // oldContent: the pre-change blob from base (undefined for added files).
    let oldContent: string | undefined;
    if (status !== 'added') {
      const blobPath = status === 'renamed' && parts.length >= 3 ? oldPath : curPath;
      oldContent = gitTry(worktree, ['show', `${base}:${blobPath}`]);
    }

    const stat = numstat.get(curPath) ?? { insertions: 0, deletions: 0 };
    files.push({
      path: curPath,
      insertions: stat.insertions,
      deletions: stat.deletions,
      status,
      content,
      oldContent,
    });
  }
  return files;
}

// ─── BLOCKER 1: manifest / public-surface boundary detection (defense-in-depth) ─

/**
 * Manifest / non-code boundary files whose change the public-API analyzer does
 * NOT signal — it skips non-code files (analyzer root cause is #414). A change to
 * any of these is a supply-chain / public-API-surface event (dep add/bump,
 * `exports`/`main`/`bin` edit, lockfile churn, workspace layout) and MUST be
 * treated as high-blast. Matched by BASENAME so it catches every workspace
 * package's manifest, not just the repo root.
 */
const MANIFEST_BASENAMES: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'lerna.json',
]);

/**
 * If ANY changed file is a manifest/boundary file, return the high-blast
 * `manifest_changed` consequence signal to INJECT into the analyzer output
 * (recognized-high in `classifyBlast` ⇒ blast=high ⇒ hold). Returns `undefined`
 * when no manifest changed. Defense-in-depth for the #414 analyzer blind spot;
 * the gate does not rely on the analyzer to cover this class.
 */
export function detectManifestChange(
  changedFiles: ReadonlyArray<ChangedFile>,
): ClassificationSignal | undefined {
  const matched = changedFiles
    .map((f) => f.path)
    .filter((p) => MANIFEST_BASENAMES.has(path.basename(p)));
  if (matched.length === 0) return undefined;
  return {
    name: 'manifest_changed',
    value: true,
    weight: 0,
    tierContribution: 'T4',
    axis: 'consequence',
    degraded: false,
    explain:
      `manifest/boundary file(s) changed (${matched.join(', ')}) — supply-chain / public-API ` +
      `surface the public-API analyzer does not signal (#414); gate-injected high-blast ` +
      `(defense-in-depth, BLOCKER 1)`,
  };
}

// ─── #422: CI / build-config boundary detection (same class as BLOCKER 1) ──────

/**
 * Directory prefixes whose contents run arbitrary code at CI/build time (or
 * define the pipeline that does) — or, for `.githooks/`/`.husky/`, at commit/push
 * time via the local git-hooks mechanism. Matched by path-prefix on the
 * POSIX-normalized path so both repo-root (`.github/workflows/…`) and any nested
 * occurrence are caught (deny-by-default). A workflow change is the exact exploit
 * that motivated #422: a `run: curl … | sh` step trips NO sensitive term, so
 * absent this signal a workflow-only PR classifies low-blast and could reach
 * `main` under auto-merge. Git-hook dirs are the same class of blind spot: this
 * repo runs `core.hooksPath=.githooks` (`.githooks/commit-msg` is the RCDD gate),
 * so a poisoned hook script is arbitrary shell that also trips no sensitive term.
 *
 * `.github/` and `scripts/` are the FULL prefixes, sourced from
 * {@link MACHINERY_DIR_PREFIXES} (packages/minspec/src/lib/machinery-paths.ts) rather
 * than the narrower `.github/workflows/` + `.github/actions/` + `scripts/roles/` this
 * set used to carry (#1758). This module, ai-review.yml's self-edit guard, and
 * dispatch-issue.sh's `MACHINERY_PATH_RE` are three independent checks over
 * conceptually the same "does this decide whether some other change is allowed"
 * question; the narrower subdirectories here meant a PR touching, say,
 * `.github/scripts/ai-review-guard.js` or `scripts/dispatch-issue.sh` itself could
 * classify low-blast in THIS gate even though the other two already treat it as
 * self-certifying machinery — a real (if narrower) instance of the same
 * single-witness gap #1758 fixed for dispatch. `scripts/roles/*.md` (#490, agent
 * governance prompts) is still covered — `scripts/` is a strict superset of
 * `scripts/roles/`. Importing the shared array (rather than hand-copying it again)
 * means THIS consumer's agreement with the other two is enforced by the import graph,
 * not just by a test.
 */
const BOUNDARY_DIR_PREFIXES: readonly string[] = [...MACHINERY_DIR_PREFIXES];

/**
 * Individual files that are boundary despite not living under a boundary directory —
 * sourced from {@link MACHINERY_SINGLE_FILES} for the same reason as the dir prefixes
 * above (#1758): both GENERATE machinery (the shipped CI-review stack, the scaffolded
 * pre-commit gate) with a blast radius that reaches every downstream MinSpec-initialised
 * repo, not just this one.
 */
const BOUNDARY_SINGLE_FILES: ReadonlySet<string> = new Set(MACHINERY_SINGLE_FILES);

/**
 * Root CI-provider configs matched by basename (not tied to a directory prefix).
 */
const BOUNDARY_ROOT_BASENAMES: ReadonlySet<string> = new Set([
  '.gitlab-ci.yml',
  '.travis.yml',
  'azure-pipelines.yml',
  'Jenkinsfile',
  // #490 review: CODEOWNERS is a GOVERNANCE / access-control surface (it routes
  // required reviewers), not documentation — the same class as the CI/workflow
  // boundary files above. A CODEOWNERS-only diff must classify HIGH so a change
  // weakening review requirements can never auto-merge unseen. (basename match ⇒
  // caught at repo root, `.github/`, or `docs/`.)
  'CODEOWNERS',
  // #490 review (2nd): the harness AGENT-GOVERNANCE / policy files. These are
  // `.md` (so the docs-extension check would certify them low) but they define
  // agent behaviour + invariants + "MUST NOT" rules — a change weakening them is
  // governance, not documentation, and must classify HIGH (same class as
  // scripts/roles/ above). basename match ⇒ caught wherever they live.
  'constitution.md', // .minspec/constitution.md — the SDD invariants
  'CLAUDE.md', // agent instructions / standing rules
  'AGENTS.md', // agent instructions (Spec Kit / harness mirror)
  '.cursorrules', // agent instructions (Cursor mirror)
]);

/**
 * Repo-local GOVERNANCE files matched by exact repo-relative path.
 *
 * Deliberately separate from {@link BOUNDARY_SINGLE_FILES} (#1758), which is
 * derived from `MACHINERY_SINGLE_FILES` — files that GENERATE machinery whose
 * blast radius reaches every downstream MinSpec-initialised repo. This set is the
 * opposite scope: settings that govern THIS repo only and ship to nobody. Folding
 * `.minspec/config.json` into the machinery list would overstate its reach and
 * change what the ai-review self-edit gate treats as machinery, so the two stay
 * distinct and `isBoundaryPath` checks both.
 *
 * `.minspec/config.json` carries the autonomy setting (DR-086). Flipping
 * `autonomy: ask -> act` widens what every agent in this repo may do without
 * asking, and item 6 of that DR's own stop list is "anything that would edit
 * this list, or the autonomy setting itself".
 *
 * WHAT THIS IS: a SECOND, INDEPENDENT WITNESS — not a closed hole.
 *
 * A setting-only diff is ALREADY ineligible without this rule. `classifyBlast`
 * is deny-by-default since #490 (absence of an affirmative low signal means
 * high), and `.minspec/config.json` is neither docs nor test, so it can never
 * earn `low_blast_docs_test_only` from {@link detectLowBlastDocsTest}. The
 * counterfactual is asserted, not assumed, in
 * packages/minspec/tests/autonomy-setting-boundary.test.ts ("is a SECOND
 * witness: the diff is already held without it, and still held with it").
 *
 * An earlier version of this comment claimed the setting "could auto-merge with
 * nobody reading it", citing only `isBoundaryPath(...) === false`. That proxy
 * shows the detector returned false; it does not show auto-merge was reachable.
 * The claim was wrong and is recorded here so it is not re-derived.
 *
 * It earns its place because the hold otherwise rests on a SINGLE producer
 * (constitution invariant 2), and one widening of the docs/test classifier would
 * remove it silently. {@link detectLowBlastDocsTest} excludes `isBoundaryPath`
 * files, so this rule is exactly the hook that keeps the setting out of any
 * future low-blast certification.
 *
 * EXACT paths, not a `.minspec/` prefix and not a `config.json` basename: the
 * prefix would sweep 61 approval sidecars and classify every routine approval
 * HIGH, and the basename would match any `config.json` anywhere in the tree. A
 * gate that fires constantly gets routed around, and one people route around is
 * worse than none, because it still reads as protection.
 */
const BOUNDARY_GOVERNANCE_PATHS: ReadonlySet<string> = new Set(['.minspec/config.json']);

/**
 * Package-manager / build-tool config matched by basename. `tsconfig*.json`
 * (paths / emit / strictness) is matched via prefix+suffix rather than an exact
 * set, since project references add arbitrarily-named variants
 * (`tsconfig.build.json`, `tsconfig.base.json`, …).
 */
const BOUNDARY_CONFIG_BASENAMES: ReadonlySet<string> = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml']);

/**
 * Is `rawPath` a CI/build-config BOUNDARY file (#422)? Non-code, high-consequence
 * config the public-API analyzer does not signal:
 *
 *   - anything under a {@link BOUNDARY_DIR_PREFIXES} directory (CI pipelines,
 *     plus `.githooks/`/`.husky/` — git hooks run arbitrary shell on commit/push);
 *   - one of the {@link BOUNDARY_SINGLE_FILES} machinery generators;
 *   - a root CI-provider config by basename ({@link BOUNDARY_ROOT_BASENAMES});
 *   - package-manager config: `.npmrc`, `.yarnrc`, `.yarnrc.yml` (registry / auth
 *     / scripts → supply-chain surface);
 *   - TypeScript compiler config: `tsconfig*.json` (build & type-safety boundary).
 *
 * Deny-by-default (#422): match HIGH on any doubt for CI/build config — erring
 * high costs a 30s human skim; erring low costs arbitrary CI code (or a silent
 * build/registry pivot) on `main`. Does NOT rely on SENSITIVE_TERMS (`curl` trips
 * nothing) — same reasoning applies to a poisoned git-hook script.
 */
export function isBoundaryPath(rawPath: string): boolean {
  const p = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const prefix of BOUNDARY_DIR_PREFIXES) {
    if (p === prefix.slice(0, -1) || p.startsWith(prefix) || p.includes('/' + prefix)) return true;
  }
  if (BOUNDARY_SINGLE_FILES.has(p)) return true;
  if (BOUNDARY_GOVERNANCE_PATHS.has(p)) return true;
  const base = path.basename(p);
  if (BOUNDARY_ROOT_BASENAMES.has(base)) return true;
  if (BOUNDARY_CONFIG_BASENAMES.has(base)) return true;
  if (/^tsconfig.*\.json$/.test(base)) return true;
  return false;
}

/**
 * If ANY changed file is a CI/build-config boundary file (#422), return the
 * high-blast `manifest_changed` consequence signal to INJECT into the analyzer
 * output (recognized-high in `classifyBlast` ⇒ blast=high ⇒ hold). Returns
 * `undefined` when none matched. Sibling to `detectManifestChange`: same
 * defense-in-depth for a class the public-API analyzer does not cover — here
 * CI/build config rather than supply-chain manifests. Reuses the `manifest_changed`
 * signal name so no new name has to be classified in `auto-merge.ts`.
 */
export function detectBoundaryChange(
  changedFiles: ReadonlyArray<ChangedFile>,
): ClassificationSignal | undefined {
  const matched = changedFiles.map((f) => f.path).filter((p) => isBoundaryPath(p));
  if (matched.length === 0) return undefined;
  return {
    name: 'manifest_changed',
    value: true,
    weight: 0,
    tierContribution: 'T4',
    axis: 'consequence',
    degraded: false,
    explain:
      `CI/build-config boundary file(s) changed (${matched.join(', ')}) — arbitrary-CI / ` +
      `package-manager / compiler config the public-API analyzer does not signal; ` +
      `gate-injected high-blast (deny-by-default, #422). A workflow can run code (e.g. ` +
      `\`curl … | sh\`) that trips no sensitive term.`,
  };
}

// ─── Hollow/stub findings over changed test files (INV-4 input) ──────────────

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function buildHollowFindings(changedFiles: ChangedFile[]): TestFinding[] {
  const findings: TestFinding[] = [];
  for (const f of changedFiles) {
    if (f.status === 'deleted') continue;
    if (!TEST_FILE_RE.test(f.path)) continue;
    if (f.content === undefined) continue;
    findings.push(...scanTestSource(f.path, f.content));
  }
  return findings;
}

// ─── #490 / DR-058 affirmative low-blast: docs/test-only ─────────────────────
//
// The blast classifier is deny-by-default over signal NAMES: an EMPTY consequence
// set is `high` (unmeasured), never `low`. To make a change ELIGIBLE, an analyzer
// must POSITIVELY certify its class is low-consequence. This one does so for the
// v1 catalog: a diff whose every changed path is documentation and/or a test file
// ships no product source, so it cannot change runtime behaviour. It grades the
// CHANGE CLASS, never diff size (a 500-line docs PR is low-blast; a 3-line auth
// edit is not — SPEC-004). The docs/test basename+extension sets are kept DISJOINT
// from the manifest/boundary high sets — notably CODEOWNERS is governance, NOT docs
// (BOUNDARY_ROOT_BASENAMES), after the #490 review caught it certifying low here.
// And even if a future overlap slipped in, `classifyBlast` checks high before low,
// so a high signal always wins over an affirmative-low one.
//
// #1001 adds the third disjoint exclusion, on a different axis from the first two:
// boundary/governance asks WHO OWNS the file; OUTWARD_DOC_PATTERN asks WHAT PUBLISHING
// IT DOES. "Docs" is only a valid proxy for "low-consequence" while the prose stays
// INSIDE the repo — see that constant for the full inverted-proxy rationale.

/** Documentation / prose files (extension or well-known basename). */
const DOCS_EXT_RE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const DOCS_BASENAMES: ReadonlySet<string> = new Set([
  'LICENSE',
  'LICENCE',
  'NOTICE',
  'CHANGELOG',
  'AUTHORS',
  'CONTRIBUTING',
  // NB: CODEOWNERS is deliberately NOT here — it is governance/access-control, not
  // documentation, so it lives in BOUNDARY_ROOT_BASENAMES (high-blast). See the
  // #490 review finding: certifying it "docs" let a required-reviewer change
  // auto-merge unseen.
]);

function isDocsPath(p: string): boolean {
  if (DOCS_EXT_RE.test(p)) return true;
  const base = path.basename(p).replace(/\.(md|txt)$/i, '');
  return DOCS_BASENAMES.has(base);
}

function isTestPath(p: string): boolean {
  return TEST_FILE_RE.test(p);
}

/**
 * OUTWARD_DOC_PATTERN (#1001) — docs that FACE THE USER, excluded from the affirmative
 * low-blast catalog above.
 *
 * THE INVERTED PROXY (the root cause this closes): {@link DOCS_EXT_RE} uses "is this a
 * docs file?" as a proxy for "is this low-consequence?". For INWARD prose — a
 * `specs/**\/requirements.md`, a `docs/decisions/DR-NNN.md` — the proxy holds: nobody
 * outside the repo ever reads it, so a wrong word costs a follow-up commit. For OUTWARD
 * prose the proxy is **inverted**: a `.md` that ships inside the published `.vsix`,
 * renders on the Marketplace/GitHub landing page, states a public product claim, or
 * deploys to minspec.dev has HIGHER consequence than most code, because a wrong word is
 * published to users and cannot be un-said by a revert. Absent this constant, marketing /
 * positioning / legal / README copy — the one content class the maintainer designates
 * human-only — was the ONLY class carrying an affirmative low-blast certification
 * pushing it toward auto-merge (worked example: #645, a `.md`-only diff that re-states
 * the product's public network-posture claim).
 *
 * MERGE-SIDE TWIN of `scripts/dispatch-issue.sh`'s `PUBLISH_PATH_RE` (#981): both grade
 * CONSEQUENCE ("what does landing this DO?"), not ownership ("who wrote it?"). The two
 * catalogues are deliberately separate for now and are converged by #1003 — hence a
 * plain ERE string constant rather than an inline literal, so #1003 can promote it into
 * a shared module (and so `docs-lane.yml` can run the SAME characters through `grep -E`;
 * a lock-step test pins them byte-identical).
 *
 * Arms, each verified against what this repo actually publishes:
 *   `^sites/`                       every deployed site file. `deploy-sites.yml`
 *                                   (`on: push → main → paths: sites/**`) runs
 *                                   `wrangler pages deploy` against the PUBLIC
 *                                   Cloudflare Pages project, so merging IS publishing.
 *                                   Anchored at the string start ON PURPOSE: a nested
 *                                   `packages/minspec/src/sites/` is source, not the
 *                                   deployed site, and must stay low-blast.
 *   `README|CHANGELOG|LICEN[CS]E|`  the landing-page + legal basenames, at ANY depth
 *   `NOTICE|THIRD-PARTY-NOTICES`    (`packages/*\/README.md` renders on the Marketplace
 *                                   listing exactly like the root one does). The
 *                                   `([.-][^/]*)?$` tail admits `LICENSE`,
 *                                   `LICENSE-CONTENT`, `THIRD-PARTY-NOTICES.md`
 *                                   and `README.md` while REFUSING `READMEs.md` — the
 *                                   separator is required, so a near-miss basename is
 *                                   not over-blocked.
 *   `^packages/<pkg>/<file>.<doc>`  a doc at a package root. `vsce ls` is authoritative
 *                                   here: `packages/minspec/package.json` has no
 *                                   `files:` allowlist, so vsce ships every path
 *                                   `.vscodeignore` does not exclude — and
 *                                   `.vscodeignore` excludes only `src/`, `tests/`,
 *                                   `test-fixtures/`, `node_modules/`, tsconfigs and
 *                                   maps. Any package-root doc therefore lands INSIDE
 *                                   the published `.vsix`.
 *   `^packages/<pkg>/media/`        likewise shipped — and `media/walkthrough/*.md` is
 *                                   the VS Code Getting Started walkthrough, rendered
 *                                   to every user on install. It is user-facing product
 *                                   copy that happens to be markdown.
 *
 * Case-insensitive at both enforcers (`RegExp` `i` / `grep -qiE`): GitHub, npm and vsce
 * all resolve these basenames case-insensitively, so `readme.md` publishes just the same.
 *
 * A literal dot is written `[.]`, never `\.`: a backslash in a TS string literal has to be
 * doubled, which would make these characters differ from `docs-lane.yml`'s `outward=` and
 * turn the byte-identity lock-step into an escaping puzzle. `[.]` means the same thing in
 * both dialects and needs no escaping in either.
 */
export const OUTWARD_DOC_PATTERN =
  '^sites/|(^|/)(README|CHANGELOG|LICEN[CS]E|NOTICE|THIRD-PARTY-NOTICES)([.-][^/]*)?$|^packages/[^/]+/[^/]+[.](md|mdx|markdown|txt|rst|adoc)$|^packages/[^/]+/media/';

const OUTWARD_DOC_RE = new RegExp(OUTWARD_DOC_PATTERN, 'i');

/**
 * Normalize a changed path for classification, or `undefined` when it CANNOT be
 * classified — an empty/blank path, an absolute path, or one containing a `..` segment.
 * `undefined` is not "clean"; the caller must treat it as a refusal to certify (#1001
 * fail-closed), so a crafted path can never satisfy the docs catalog while resolving
 * somewhere else entirely. Mirrors `docs-corpus.ts`'s `isDocsCorpusPath` guards.
 */
function normalizeChangedPath(raw: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const p = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (p.length === 0) return undefined;
  if (p.startsWith('/')) return undefined;
  if (p.split('/').includes('..')) return undefined;
  return p;
}

/** Is `p` (already normalized) an outward-facing, user-published doc? See {@link OUTWARD_DOC_PATTERN}. */
export function isOutwardFacingDoc(p: string): boolean {
  const norm = normalizeChangedPath(p);
  if (norm === undefined) return false; // unclassifiable is handled by the caller's fail-closed branch
  return OUTWARD_DOC_RE.test(norm);
}

/**
 * Emit the affirmative low-blast signal iff the diff is non-empty and EVERY changed
 * path is documentation or a test file (no product source). `undefined` otherwise —
 * absence of this signal is what makes an unrecognized/opaque change hold (#490).
 */
export function detectLowBlastDocsTest(
  changedFiles: ReadonlyArray<ChangedFile>,
): ClassificationSignal | undefined {
  if (changedFiles.length === 0) return undefined;
  // A file that is ALSO a boundary/high-blast path (CI config, git hooks, CODEOWNERS,
  // dispatch role prompts, harness governance) can NEVER be certified low — even if
  // it matches a docs extension/basename. Governance is not documentation (#490
  // review): this makes the affirmative-low catalog and the boundary (high) set
  // provably disjoint, so a `.md` policy file can never slip through as "docs."
  const allDocsOrTest = changedFiles.every((f) => {
    // Fail CLOSED on anything this classifier cannot read as a repo-relative path
    // (#1001): "could not tell" must never be conflated with "no match".
    const p = normalizeChangedPath(f.path);
    if (p === undefined) return false;
    // #1001 — outward-facing docs are excluded BEFORE the docs/test test, so the
    // exclusion also covers a non-prose file that ships (e.g. a test parked under
    // `sites/`): what the path PUBLISHES outranks what kind of file it is.
    if (OUTWARD_DOC_RE.test(p)) return false;
    return (isDocsPath(p) || isTestPath(p)) && !isBoundaryPath(p);
  });
  if (!allDocsOrTest) return undefined;
  return {
    name: LOW_BLAST_DOCS_TEST,
    value: true,
    weight: 0,
    tierContribution: 'T1',
    axis: 'consequence',
    degraded: false,
    explain:
      'every changed file is INWARD documentation or a test — no product source ships and ' +
      'nothing is published to users, so the change cannot alter runtime behaviour or a ' +
      'public claim: affirmatively low-blast (DR-058 #490; outward-doc exclusion #1001)',
  };
}

// ─── FR-7 audit ──────────────────────────────────────────────────────────────

function auditPath(worktree: string): string {
  // Resolve the MAIN repo root (shared by every linked worktree) so the audit
  // trail persists after an ephemeral agent worktree is removed.
  let mainRoot = worktree;
  const commonDir = gitTry(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
  if (commonDir) {
    const resolved = path.isAbsolute(commonDir) ? commonDir : path.resolve(worktree, commonDir);
    // commonDir points at "<mainRoot>/.git" (or a bare git dir); its parent is the root.
    mainRoot = path.basename(resolved) === '.git' ? path.dirname(resolved) : worktree;
  }
  return path.join(mainRoot, '.minspec', 'auto-merge-audit.log');
}

/**
 * Append one audit record. Returns `true` iff the line actually persisted, so an
 * ELIGIBLE decision can fail-safe to HOLD when its record could not be written
 * (#491 — see {@link applyAuditFailsafe}). A failure still logs (best-effort
 * visibility) but is no longer silently swallowed into a proceeding merge.
 */
export function appendAudit(
  worktree: string,
  record: Record<string, unknown>,
): boolean {
  try {
    const file = auditPath(worktree);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (e) {
    log(`could not write audit log: ${(e as Error).message}`);
    return false;
  }
}

/**
 * #491 — FR-7 fail-safe. An ELIGIBLE decision whose audit record did NOT persist
 * must not stay eligible: a wrong auto-merge that left no audit trail is the worst
 * case — untraceable exactly when it matters most — so a failed audit downgrades
 * the decision to a HOLD. A non-eligible decision is already a hold; its audit is
 * best-effort and needs no downgrade. Pure, so the fail-safe is unit-tested
 * without driving `main()`/fs (the file's deliberate no-flaky-e2e discipline).
 */
export function applyAuditFailsafe(
  decision: AutoMergeDecision,
  audited: boolean,
): AutoMergeDecision {
  if (decision.eligible && !audited) {
    return {
      eligible: false,
      blast: decision.blast,
      reason: `audit-write-failed — fail-safe hold (FR-7 #491): an eligible decision could not be recorded; ${decision.reason}`,
      failed: [...decision.failed, 'audit-write-failed'],
    };
  }
  return decision;
}

// ─── Load the #180 merged review-signal prose ────────────────────────────────

function loadReviewSignals(signalsFile: string | undefined): ReviewSignalsInput {
  const fallback: ReviewSignalsInput = { rootCause: '', changedFiles: [], rootCauseFiles: [] };
  if (!signalsFile) return fallback;
  try {
    const raw = fs.readFileSync(signalsFile, 'utf8');
    const parsed = JSON.parse(raw) as ReviewSignalsInput;
    return { ...fallback, ...parsed };
  } catch (e) {
    log(`could not read signals file '${signalsFile}': ${(e as Error).message}`);
    return fallback;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // Fail-safe default emitted on ANY unexpected error: HOLD, never eligible.
  const emit = (decision: {
    eligible: boolean;
    blast: 'low' | 'high';
    reason: string;
    failed: string[];
    block: string;
  }): void => {
    process.stdout.write(JSON.stringify(decision) + '\n');
  };

  try {
    const reviewSignals = loadReviewSignals(args.signalsFile);

    // 1. FR-2 prover — the SOLE authority for the red→green proof (INV-3).
    const prover = proveRegression(args.worktree, args.base, reviewSignals.regressionTest);
    log(`prover: ${prover.note}`);

    // 2. Consequence signals + hollow findings from the real diff.
    const changedFiles = buildChangedFiles(args.worktree, args.base);
    const consequenceSignals: ClassificationSignal[] = runConsequenceAnalyzers({
      changedFiles,
      refIndex: null, // v1 — no reference index (SPEC-023 Clarification 2)
    });
    // BLOCKER 1 (#414 defense-in-depth): the public-API analyzer skips non-code
    // files, so a manifest change (package.json / lockfile / workspace manifest)
    // emits NO signal and would classify low-blast → merge unseen. Inject a
    // high-blast `manifest_changed` signal so any such change holds for a human.
    const manifestSignal = detectManifestChange(changedFiles);
    if (manifestSignal) consequenceSignals.push(manifestSignal);
    // #422 (same class as BLOCKER 1): CI/build-config boundary files
    // (.github/workflows/*, .npmrc, .yarnrc*, tsconfig*.json, common CI-provider
    // configs) are also non-code, high-consequence, and NOT signalled by the
    // public-API analyzer. Inject a high-blast manifest_changed signal so any such
    // change holds for a human. Without this a workflow whose only sink is
    // `run: curl … | sh` (curl trips NO sensitive term) could reach main under
    // auto-merge.
    const boundarySignal = detectBoundaryChange(changedFiles);
    if (boundarySignal) consequenceSignals.push(boundarySignal);
    // #490 / DR-058: affirmative low-blast certification for a docs/test-only diff.
    // Without a positive low signal, an empty/opaque consequence set now classifies
    // HIGH (unmeasured → hold); this is the only way a change becomes low-blast.
    const lowBlastSignal = detectLowBlastDocsTest(changedFiles);
    if (lowBlastSignal) consequenceSignals.push(lowBlastSignal);
    const hollowFindings = buildHollowFindings(changedFiles);

    // 3. Pure decision. The prover result is passed separately and OVERRIDES any
    //    self-reported proof flags inside the gate (INV-3).
    const input: AutoMergeInput = {
      reviewSignals,
      hollowFindings,
      consequenceSignals,
      mode: args.mode,
      proverResult: prover,
      // #489 — the REAL git diff is the authority for Signal-1's changedFiles,
      // never the agent's self-reported `reviewSignals.changedFiles`.
      changedFilePaths: changedFiles.map((f) => f.path),
    };
    const rawDecision = decideAutoMerge(input);

    // 4. FR-7 audit — and the #491 fail-safe: an ELIGIBLE decision whose audit
    //    line did not persist downgrades to HOLD (a merge that cannot be recorded
    //    must not proceed untraced). `appendAudit` now REPORTS whether it wrote.
    const audited = appendAudit(args.worktree, {
      ts: new Date().toISOString(),
      pr: args.pr || null,
      base: args.base,
      mode: args.mode,
      eligible: rawDecision.eligible,
      blast: rawDecision.blast,
      failed: rawDecision.failed,
      reason: rawDecision.reason,
      prover: { baseRed: prover.regressionProvenBaseRed, greenOnHead: prover.regressionGreenOnHead, note: prover.note },
      consequenceSignals: consequenceSignals.map((s) => s.name),
      hollowFindings: hollowFindings.length,
    });
    const decision = applyAuditFailsafe(rawDecision, audited);
    if (decision !== rawDecision) {
      log(`FR-7 audit append FAILED on an eligible decision — emitting fail-safe HOLD (#491): ${decision.reason}`);
    }

    // 5. Render the prover-authoritative #180 block for the FR-8 fallback comment.
    const block = renderReviewSignals({
      ...reviewSignals,
      regressionProvenBaseRed: prover.regressionProvenBaseRed,
      regressionProvenHeadGreen: prover.regressionGreenOnHead,
    });

    emit({ ...decision, block });
  } catch (e) {
    log(`FATAL: ${(e as Error).message} — emitting fail-safe HOLD`);
    appendAudit(args.worktree, {
      ts: new Date().toISOString(),
      pr: args.pr || null,
      eligible: false,
      blast: 'high',
      failed: ['gate-error'],
      reason: `gate error: ${(e as Error).message}`,
    });
    emit({
      eligible: false,
      blast: 'high',
      reason: `gate error — fail-safe hold: ${(e as Error).message}`,
      failed: ['gate-error'],
      block: '',
    });
  }
}

// Run main() ONLY when invoked directly as a script (dispatch shells out via
// `npx tsx …/auto-merge-gate.ts`). Guarded so importing this module for tests
// does NOT execute the CLI. Belt-and-suspenders: never run under vitest.
const invokedDirectly = /auto-merge-gate\.[cm]?[jt]s$/.test(process.argv[1] ?? '');
if (invokedDirectly && !process.env.VITEST) {
  main();
}
