/**
 * machinery-paths.ts — the ONE canonical "machinery" path set (#1758).
 *
 * "A gate cannot certify a change to itself" (#596): every path here is code that
 * DECIDES whether some other change is allowed — directly, or by generating the thing
 * that decides — so it cannot certify itself. Three separate consumers each needed this
 * set and each grew its own copy:
 *
 *   1. `.github/workflows/ai-review.yml` — the `grep -qE` guard that forces
 *      SELF_EDIT_KIND=machinery, overriding the combined verdict to `changes` so a
 *      machinery PR never earns a SHA-bound `ai-review:pass` witness.
 *   2. `scripts/dispatch-issue.sh` (`MACHINERY_PATH_RE`) — the constitution invariant-2
 *      INDEPENDENT SECOND WITNESS: dispatch declines to arm native auto-merge on a
 *      machinery PR, independently of anything ai-review does, so a regression/outage/
 *      permission gap in (1) alone cannot let a machinery PR merge unwitnessed.
 *   3. `scripts/auto-merge-gate.ts` (`BOUNDARY_DIR_PREFIXES` + the single-file check
 *      below) — imports this module directly, so for this TypeScript consumer the
 *      "shared definition" is enforced by the import graph, not just a test.
 *
 * A shell regex embedded in a YAML step and a bash variable cannot literally `import`
 * this module — there is no cross-language import for either. Both instead carry a
 * HAND-COPIED rendering of `buildMachineryRegexSource()`'s output, and
 * `packages/minspec/tests/machinery-paths.test.ts` pins each copy to that output
 * character-for-character: any hand-edit that drifts from this module fails that test,
 * rather than depending on someone remembering to update three files in lock-step (the
 * exact failure mode #1758 diagnosed — a reconciliation commit, 01369b6b, updated (1)
 * and shipped a test that only read (1), leaving (2) narrower and the second witness
 * inert for two paths).
 *
 * MEMBERSHIP TEST for anything added here: does this code decide whether some other
 * change is allowed — directly, or by generating the thing that decides? If yes it
 * belongs in one of the two sets below.
 */

/**
 * Directory prefixes that are machinery wherever they occur (deny-by-default:
 * matched by prefix on the POSIX-normalized, repo-relative path).
 *
 *   .github/    — review/merge workflows and their scripts (ai-review.yml,
 *                 .github/scripts/ai-review-guard.js, …).
 *   scripts/    — dispatch, review, remediation, the issue lease, role prompts.
 *   .githooks/  — pre-commit (protected-branch #1041, RCDD DR-003), pre-push
 *                 (workflow-file protection #1120), commit-msg. This repo runs
 *                 `core.hooksPath=.githooks`.
 *   .circleci/, .buildkite/, .husky/ — this repo does not use these providers today,
 *                 but `scripts/auto-merge-gate.ts`'s CI/build boundary detector (#422)
 *                 already treats them as machinery-class (arbitrary code at CI/commit
 *                 time); folding them in here closes that gap rather than leaving it
 *                 as a standing three-way disagreement. Zero-cost while unused: no
 *                 path under these prefixes exists in this repo, so they never match.
 */
export const MACHINERY_DIR_PREFIXES: readonly string[] = [
  '.github/',
  'scripts/',
  '.githooks/',
  '.circleci/',
  '.buildkite/',
  '.husky/',
];

/**
 * Individual files that are machinery despite not living under a machinery directory —
 * both under `packages/minspec/src/lib/`, both GENERATORS of machinery rather than
 * machinery themselves:
 *
 *   template-registry.ts    — generates the `.minspec/hooks/pre-commit` gate every
 *                              MinSpec-initialised project runs. Blast radius strictly
 *                              larger than `.githooks/` (this repo only).
 *   ci-review-templates.ts  — holds the verbatim ai-review workflow, review-decide.sh
 *                              and ai-review-guard.js shipped to every consuming repo.
 *                              Largest blast radius of anything in this set: a PR
 *                              touching only this file changes the review gate for
 *                              every downstream project.
 */
export const MACHINERY_SINGLE_FILES: readonly string[] = [
  'packages/minspec/src/lib/template-registry.ts',
  'packages/minspec/src/lib/ci-review-templates.ts',
];

/** Escape a literal string for embedding in a regex alternative. */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The shared stem directory `MACHINERY_SINGLE_FILES` entries must live under, so the
 * regex can group them as `dir/(stemA|stemB)\.ts$` — the same construction
 * ai-review.yml originally used, kept so `buildMachineryRegexSource()`'s output is a
 * minimal, readable diff from what the two hand-copies already carried.
 */
const SINGLE_FILE_DIR = 'packages/minspec/src/lib/';

function singleFileStem(f: string): string {
  if (!f.startsWith(SINGLE_FILE_DIR) || !f.endsWith('.ts')) {
    throw new Error(
      `machinery-paths: ${f} does not fit the shared-stem "${SINGLE_FILE_DIR}<stem>.ts" pattern ` +
        `buildMachineryRegexSource() assumes — add a differently-shaped alternative if this is intentional.`,
    );
  }
  return f.slice(SINGLE_FILE_DIR.length, -'.ts'.length);
}

/**
 * Build the POSIX-ERE pattern SOURCE that `.github/workflows/ai-review.yml`'s
 * `grep -qE` guard and `scripts/dispatch-issue.sh`'s `MACHINERY_PATH_RE` must both
 * carry, character for character. Each directory prefix is independently `^`-anchored
 * (rather than grouped under one outer `^(...)`), matching dispatch's original
 * convention and keeping every alternative individually greppable/testable.
 */
export function buildMachineryRegexSource(): string {
  const dirAlts = MACHINERY_DIR_PREFIXES.map((p) => `^${escapeForRegex(p)}`);
  const stems = MACHINERY_SINGLE_FILES.map((f) => escapeForRegex(singleFileStem(f)));
  const fileAlt = `^${escapeForRegex(SINGLE_FILE_DIR)}(${stems.join('|')})\\.ts$`;
  return [...dirAlts, fileAlt].join('|');
}

/**
 * Is `rawPath` machinery per the canonical set above? Pure, dependency-free predicate —
 * `scripts/auto-merge-gate.ts` imports this directly (real, import-graph-enforced
 * sharing for its consumer); the bash/YAML consumers are instead pinned by
 * `packages/minspec/tests/machinery-paths.test.ts` against `buildMachineryRegexSource()`.
 */
export function isMachineryPath(rawPath: string): boolean {
  const p = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const prefix of MACHINERY_DIR_PREFIXES) {
    if (p === prefix.slice(0, -1) || p.startsWith(prefix)) return true;
  }
  return MACHINERY_SINGLE_FILES.includes(p);
}
