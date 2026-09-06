/**
 * T3 — the docs-only CI early exit skips only what markdown provably cannot affect (#1728).
 *
 * The tempting version of this change is `paths-ignore` on ci.yml. That BRICKS every
 * docs PR: lint/test/build are REQUIRED checks, and a workflow that never triggers
 * never reports, so the required checks sit pending forever. ci.yml's own merge_group
 * comment records the same trap from the other direction.
 *
 * The second trap is subtler and is what these tests pin. In THIS repo the docs corpus
 * includes `specs/`, so a "docs-only" PR is precisely the kind that changes specs — and
 * `Validate frontmatter` is the spec validator. Skipping lint wholesale would disable
 * spec validation on spec changes: a required check that cannot fail on the lane it
 * most needs to guard (#811's defect class).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');
const CI_PATH = path.join(root, '.github', 'workflows', 'ci.yml');
const ci = fs.readFileSync(CI_PATH, 'utf-8');

/** The text of one `- name: X` step, up to the next step or job. */
function step(name: string): string {
  const i = ci.indexOf(`      - name: ${name}\n`);
  if (i < 0) throw new Error(`step "${name}" not found in ci.yml — the anchor moved.`);
  const rest = ci.slice(i + 1);
  const nxt = rest.search(/\n {6}- (name|uses):|\n {2}[a-z][\w-]*:\n/);
  return rest.slice(0, nxt < 0 ? undefined : nxt);
}
/** The text of one job block. */
function job(name: string): string {
  const i = ci.indexOf(`\n  ${name}:\n`);
  if (i < 0) throw new Error(`job "${name}" not found in ci.yml`);
  const rest = ci.slice(i + 1);
  const nxt = rest.search(/\n {2}[a-z][\w-]*:\n {4}(runs-on|needs|if):/);
  return rest.slice(0, nxt < 0 ? undefined : nxt);
}
const skipsOnDocs = (text: string) => /if:\s*needs\.paths\.outputs\.docs_only\s*!=\s*'true'/.test(text);


describe('#1728 — docs-only CI early exit', () => {
  it('the classifier job exists and single-sources the shared corpus', () => {
    const run = job('paths');
    // Sources SPEC-039's one bash definition rather than restating the regex, so it
    // has no copy that can drift from docs-lane.yml's.
    expect(run).toContain('scripts/lib/docs-corpus.sh');
    expect(run).toContain('DOCS_CORPUS_RE');
  });

  it('FAIL-SAFE: docs_only defaults to false, and only positive evidence sets it true', () => {
    const run = job('paths');
    expect(run).toMatch(/docs_only=false/);
    // The only assignment to true is guarded by "nothing outside the corpus".
    const trueAssignments = run.match(/docs_only=true/g) ?? [];
    expect(trueAssignments).toHaveLength(1);
    expect(run).toContain('outside');
  });

  it('the required jobs still RUN and still report — never paths-ignore', () => {
    // A required check that never reports leaves the PR pending forever.
    expect(ci).not.toMatch(/paths-ignore:/);
    expect(ci.slice(0, ci.indexOf('jobs:'))).not.toMatch(/^\s+paths:\s*$/m);
    for (const j of ['lint', 'test', 'build']) expect(() => job(j)).not.toThrow();
  });

  it('skips only what markdown provably cannot affect', () => {
    expect(skipsOnDocs(step('Lint'))).toBe(true);
    expect(skipsOnDocs(step('Typecheck'))).toBe(true);
    expect(skipsOnDocs(step('Check import cycles'))).toBe(true);
    expect(skipsOnDocs(step('Build MinSpec'))).toBe(true);
  });

  it('NEVER skips the spec validator — docs PRs are the ones that change specs', () => {
    // The load-bearing assertion. The docs corpus includes `specs/`, so gating this
    // would disable validation on exactly the lane it exists to guard.
    expect(skipsOnDocs(step('Validate frontmatter'))).toBe(false);
  });

  it('NEVER skips the test suite — many suites parse specs and docs', () => {
    expect(skipsOnDocs(job('test'))).toBe(false);
  });

  it('the three required jobs depend on the classifier', () => {
    for (const j of ['lint', 'test', 'build']) expect(job(j)).toMatch(/needs:.*paths/);
  });
});
