/**
 * #1284 / #1758 — T0: the machinery path set, checked against ALL THREE definitions.
 *
 * "A gate cannot certify a change to itself" (#596). Which paths count as machinery was an
 * inline regex in the workflow with no test, and it enumerated two directories that
 * happened to hold the machinery when it was written. `.githooks/` was not among them, so
 * PR #1273 — which changed `.githooks/pre-push`, the gate deciding whether a push is
 * permitted — was classified "Not a machinery PR — no extra human gate", received a
 * SHA-bound pass witness, and merged without the human gate (#1284).
 *
 * #1758: `.github/workflows/ai-review.yml`, `scripts/dispatch-issue.sh`
 * (`MACHINERY_PATH_RE`), and `scripts/auto-merge-gate.ts` (`BOUNDARY_DIR_PREFIXES`) each
 * carried their OWN copy of this set, and no two agreed — a reconciliation commit
 * (01369b6b) updated ai-review.yml's regex and this file's test, but never touched
 * dispatch-issue.sh, leaving its copy narrower. For a PR touching only
 * `packages/minspec/src/lib/template-registry.ts`, ai-review correctly held it while
 * dispatch's copy — the constitution invariant-2 INDEPENDENT SECOND WITNESS to that hold —
 * did not, so the hold rested on exactly the single producer invariant 2 forbids.
 *
 * The fix: `packages/minspec/src/lib/machinery-paths.ts` is now the one CANONICAL
 * definition (dir prefixes + single files). `scripts/auto-merge-gate.ts` imports it
 * directly — real, import-graph-enforced sharing. `.github/workflows/ai-review.yml` and
 * `scripts/dispatch-issue.sh` are bash/YAML and cannot import a TS module, so each instead
 * carries a HAND-COPY of `buildMachineryRegexSource()`'s output. This suite is what makes
 * that copy load-bearing: it PARSES THE PATTERN OUT OF ai-review.yml, PARSES
 * MACHINERY_PATH_RE OUT OF dispatch-issue.sh, and calls `isBoundaryPath` from
 * auto-merge-gate.ts DIRECTLY (no parsing needed — same language) — then asserts all three
 * classify an identical path table identically, and that the two hand-copies are
 * character-for-character equal to the canonical module's generated source. Divergence in
 * ANY of the three now fails this suite; it does not depend on anyone remembering to keep
 * three files in lock-step.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AI_REVIEW_WORKFLOW } from '../src/lib/ci-review-templates';
import { isBoundaryPath } from '../../../scripts/auto-merge-gate';
import {
  MACHINERY_DIR_PREFIXES,
  MACHINERY_SINGLE_FILES,
  buildMachineryRegexSource,
  isMachineryPath,
} from '../src/lib/machinery-paths';

const WORKFLOW = path.resolve(__dirname, '../../../.github/workflows/ai-review.yml');
const DISPATCH = path.resolve(__dirname, '../../../scripts/dispatch-issue.sh');

/**
 * Pull the machinery pattern out of the `grep -qE '<pattern>'` line that decides
 * SELF_EDIT_KIND=machinery. Fails loudly rather than silently matching nothing if the
 * workflow is restructured — a test that quietly stops finding its subject is worse than
 * one that breaks.
 */
function machineryPattern(src: string, what: string): string {
  const lines = src.split('\n');
  const idx = lines.findIndex((l) => /SELF_EDIT_KIND=machinery/.test(l));
  expect(idx, `no SELF_EDIT_KIND=machinery line in ${what}`).toBeGreaterThan(-1);

  // The `elif ... grep -qE '<pattern>'` guard sits just above the assignment.
  const guard = lines
    .slice(Math.max(0, idx - 6), idx)
    .reverse()
    .find((l) => /grep -qE/.test(l));
  expect(guard, `no grep -qE guard above SELF_EDIT_KIND=machinery in ${what}`).toBeTruthy();

  const m = /grep -qE\s+'([^']+)'/.exec(guard as string);
  expect(m, `could not extract the pattern from: ${guard}`).toBeTruthy();
  // The RAW pattern string. Never round-trip through RegExp.source for comparison — JS
  // normalises `/` to `\/` there, so a raw-vs-source compare fails on formatting rather
  // than on drift.
  return (m as RegExpExecArray)[1];
}

/**
 * Pull `MACHINERY_PATH_RE='<pattern>'` out of dispatch-issue.sh — the invariant-2
 * independent second witness this suite exists to keep honest. Same fail-loud shape as
 * `machineryPattern` above: a restructured script must break this extraction, never
 * silently stop finding its subject.
 */
function dispatchMachineryPattern(src: string): string {
  const m = /^MACHINERY_PATH_RE='([^']+)'/m.exec(src);
  expect(m, 'MACHINERY_PATH_RE not found in scripts/dispatch-issue.sh').toBeTruthy();
  return (m as RegExpExecArray)[1];
}

function machineryRegex(): RegExp {
  return new RegExp(machineryPattern(fs.readFileSync(WORKFLOW, 'utf8'), 'ai-review.yml'));
}

describe('#1284 machinery path classification (ai-review.yml)', () => {
  const re = machineryRegex();

  const machinery = [
    '.github/workflows/ai-review.yml',
    '.github/scripts/ai-review-guard.js',
    'scripts/dispatch-issue.sh',
    'scripts/lib/issue-lease.sh',
    // #1284: each of these is a gate — it decides whether some other change is allowed.
    '.githooks/pre-push', // workflow-file protection (#1120)
    '.githooks/pre-commit', // protected-branch (#1041) + RCDD root-cause gate (DR-003)
    '.githooks/commit-msg',
    // Generates .minspec/hooks/pre-commit for every MinSpec-initialised project, so its
    // blast radius exceeds .githooks/ — it decides by generating the thing that decides.
    'packages/minspec/src/lib/template-registry.ts',
    // Holds the verbatim ai-review workflow + review-decide.sh + ai-review-guard.js shipped
    // downstream: the LARGEST blast radius here. Omitted in #1284's first pass — the same
    // inconsistency that PR set out to fix — and caught by the architect voter. #1758: this
    // exact path is what dispatch-issue.sh's MACHINERY_PATH_RE omitted, leaving the
    // invariant-2 second witness inert for it.
    'packages/minspec/src/lib/ci-review-templates.ts',
    // #1758: unused by this repo today, but folded into the canonical set so all three
    // definitions genuinely agree rather than disagreeing on an untested corner.
    '.circleci/config.yml',
    '.buildkite/pipeline.yml',
    '.husky/pre-commit',
  ];

  const notMachinery = [
    'packages/minspec/src/lib/classifier.ts',
    'packages/minspec/tests/approval.test.ts',
    'docs/decisions/DR-077.md',
    'specs/minspec/SPEC-045-github-native-approval/requirements.md',
    'README.md',
    // Guards against an over-broad pattern: these merely CONTAIN a machinery name.
    'packages/minspec/src/lib/scripts-helper.ts',
    'docs/github/workflows-notes.md',
  ];

  for (const p of machinery) {
    it(`classifies ${p} as machinery`, () => {
      expect(re.test(p)).toBe(true);
    });
  }

  for (const p of notMachinery) {
    it(`does NOT classify ${p} as machinery`, () => {
      expect(re.test(p)).toBe(false);
    });
  }

  it('anchors at the start of the path, so a nested lookalike is not machinery', () => {
    // `vendor/.github/workflows/x.yml` is not this repo's review machinery.
    expect(re.test('vendor/.github/workflows/x.yml')).toBe(false);
    expect(re.test('docs/scripts/example.sh')).toBe(false);
  });

  it('the SHIPPED template carries the same pattern as the plaintext workflow', () => {
    // Both the reviewer and skeptic voters flagged this on #1299: reading only the
    // plaintext workflow leaves template↔workflow drift uncovered, and the shipped copy is
    // the one every consuming repo actually runs. `npm run validate` enforces that the
    // generated file is not STALE (#678); this asserts the classifier inside it agrees, so
    // a downstream repo can never be running a narrower machinery set than this one.
    // NOTE (#1486): this checks the EMBEDDED blob. What a consuming repo receives is that
    // blob with the machinery-path COMMENT rewritten from MinSpec's vantage to its own —
    // executable content untouched. machinery-comment-localization.test.ts asserts the
    // pattern survives that rewrite character-for-character, so the chain here still holds
    // end to end: workflow == blob == scaffolded copy, as far as the classifier goes.
    // Import the module rather than regex-parsing its source: the blob is stored as many
    // concatenated base64 chunks, so a source-level regex captures only the first one and
    // would fail for reasons unrelated to drift.
    const shipped = machineryPattern(AI_REVIEW_WORKFLOW, 'the shipped ci-review template');

    // Same source of truth, so the two patterns must be character-identical.
    expect(shipped).toBe(machineryPattern(fs.readFileSync(WORKFLOW, 'utf8'), 'ai-review.yml'));
  });

  it('matches template-registry.ts EXACTLY, not its directory or neighbours', () => {
    // The single-file entry is end-anchored on purpose: it admits one generator, not the
    // whole lib/ tree. Without the `$` this would swallow every sibling module.
    expect(re.test('packages/minspec/src/lib/template-registry.ts')).toBe(true);
    expect(re.test('packages/minspec/src/lib/classifier.ts')).toBe(false);
    expect(re.test('packages/minspec/src/lib/template-registry.test.ts')).toBe(false);
    expect(re.test('packages/minspec/src/lib/template-registry.ts.bak')).toBe(false);
  });
});

describe('#1758 all three machinery definitions are pinned to the canonical module', () => {
  const canonical = buildMachineryRegexSource();
  const workflowPattern = machineryPattern(fs.readFileSync(WORKFLOW, 'utf8'), 'ai-review.yml');
  const dispatchPattern = dispatchMachineryPattern(fs.readFileSync(DISPATCH, 'utf8'));

  it('ai-review.yml carries the canonical pattern, character for character', () => {
    expect(workflowPattern).toBe(canonical);
  });

  it('dispatch-issue.sh carries the canonical pattern, character for character', () => {
    expect(dispatchPattern).toBe(canonical);
  });

  it('the canonical prefixes/files are non-empty (guards against a vacuously-true suite)', () => {
    expect(MACHINERY_DIR_PREFIXES.length).toBeGreaterThan(0);
    expect(MACHINERY_SINGLE_FILES.length).toBeGreaterThan(0);
  });
});

describe('#1758 all three machinery definitions classify one path table identically', () => {
  // Every path here is machinery by the canonical definition. This is the load-bearing
  // check: ai-review.yml's regex, dispatch-issue.sh's MACHINERY_PATH_RE, and
  // auto-merge-gate.ts's isBoundaryPath must ALL agree it is machinery — a single
  // narrower definition, anywhere, fails this suite instead of shipping unnoticed.
  const machineryTable = [
    '.github/workflows/ai-review.yml',
    '.github/scripts/ai-review-guard.js',
    '.github/workflows/ready-to-merge.yml',
    '.github/ISSUE_TEMPLATE/agent-task.yml',
    'scripts/dispatch-issue.sh',
    'scripts/lib/issue-lease.sh',
    'scripts/roles/dev.md',
    '.githooks/pre-push',
    '.githooks/pre-commit',
    '.githooks/commit-msg',
    '.circleci/config.yml',
    '.buildkite/pipeline.yml',
    '.husky/pre-commit',
    // The two paths that were the live #1758 bug: machinery to ai-review.yml, NOT
    // machinery to dispatch-issue.sh's old MACHINERY_PATH_RE.
    'packages/minspec/src/lib/template-registry.ts',
    'packages/minspec/src/lib/ci-review-templates.ts',
  ];

  // Ordinary, non-machinery code and docs — all three must agree these are NOT machinery,
  // so the reconciliation did not over-widen into flagging everything.
  const notMachineryTable = [
    'packages/minspec/src/lib/classifier.ts',
    'packages/minspec/src/lib/foo.ts',
    'packages/minspec/tests/approval.test.ts',
    'docs/decisions/DR-077.md',
    'README.md',
    'package.json',
  ];

  for (const p of machineryTable) {
    it(`ai-review.yml, dispatch-issue.sh AND auto-merge-gate.ts all classify ${p} as machinery`, () => {
      const workflowPattern = machineryPattern(fs.readFileSync(WORKFLOW, 'utf8'), 'ai-review.yml');
      const dispatchPattern = dispatchMachineryPattern(fs.readFileSync(DISPATCH, 'utf8'));

      expect(new RegExp(workflowPattern).test(p), 'ai-review.yml').toBe(true);
      expect(new RegExp(dispatchPattern).test(p), 'dispatch-issue.sh MACHINERY_PATH_RE').toBe(
        true,
      );
      expect(isMachineryPath(p), 'the canonical machinery-paths.ts module').toBe(true);
      // auto-merge-gate.ts's boundary set is a deliberate SUPERSET (also covers manifests,
      // CODEOWNERS, tsconfig, …) — so for anything genuinely machinery it must be boundary
      // too. A narrower boundary set here for a machinery path is exactly the #1758 hole,
      // just in the third definition instead of the second.
      expect(isBoundaryPath(p), 'auto-merge-gate.ts isBoundaryPath').toBe(true);
    });
  }

  for (const p of notMachineryTable) {
    it(`ai-review.yml and dispatch-issue.sh both classify ${p} as NOT machinery`, () => {
      const workflowPattern = machineryPattern(fs.readFileSync(WORKFLOW, 'utf8'), 'ai-review.yml');
      const dispatchPattern = dispatchMachineryPattern(fs.readFileSync(DISPATCH, 'utf8'));

      expect(new RegExp(workflowPattern).test(p), 'ai-review.yml').toBe(false);
      expect(new RegExp(dispatchPattern).test(p), 'dispatch-issue.sh MACHINERY_PATH_RE').toBe(
        false,
      );
      expect(isMachineryPath(p), 'the canonical machinery-paths.ts module').toBe(false);
    });
  }
});
