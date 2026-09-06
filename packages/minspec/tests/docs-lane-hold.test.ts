/**
 * T0/T3 — #1847: the docs-lane must not arm auto-merge on a PR a human has HELD,
 * nor on a governance status transition.
 *
 * Root cause (pre-fix): `.github/workflows/docs-lane.yml` gated arming on the docs
 * corpus and the outward-facing denylist alone, and never read the PR's labels. A
 * `hold:*` label — documented as "no approval lifts it" (DR-072 §3) — was enforced on
 * the ISSUE-dispatch side and nowhere on the MERGE side. Measured on #1741:
 * `hold:human` at 22:09:26, this lane armed auto-merge at 22:09:34. Eight seconds.
 * Only an unrelated `ai-review:changes` stopped a DR ratification landing with no
 * human act (#1816).
 *
 * The second gate exists because the first only fires when somebody REMEMBERED to
 * apply a label. Every human-act artefact here is markdown, so a DR acceptance is
 * docs-only BY CONSTRUCTION and reads as "inward" to the outward denylist — the lane
 * with the weakest gate is the one every ratification travels down (DR-029, DR-086 §2).
 *
 * These tests run the workflow's ACTUAL `run:` block under bash against a stubbed
 * `gh`, rather than asserting on its source text — a source-text assertion goes green
 * whenever the prose survives, including when the logic around it has been inverted.
 * What the stub does NOT cover is the `-q` jq expressions (it emits the shaped output
 * directly); those are pinned by the workflow running for real.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'scripts')) && fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate the repo root from ' + __dirname);
}

const root = findRepoRoot();
const docsLanePath = path.join(root, '.github', 'workflows', 'docs-lane.yml');

/** The workflow's real shell body, as GitHub Actions would run it. */
let laneScript: string;

/**
 * Pull the `run: |` block out textually rather than via a YAML parser: `js-yaml` is only
 * a transitive dependency here, so importing it would make this test vanish on an
 * unrelated dependency bump — the failure mode being that the gate stops being tested
 * while the suite stays green.
 */
function extractRunBlock(yamlText: string): string {
  const lines = yamlText.split('\n');
  const start = lines.findIndex((l) => /^\s*run:\s*\|\s*$/.test(l));
  if (start === -1) throw new Error('docs-lane.yml has no `run: |` block');
  const indent = (lines[start + 1].match(/^\s*/) ?? [''])[0].length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && (line.match(/^\s*/) ?? [''])[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

beforeAll(() => {
  laneScript = extractRunBlock(fs.readFileSync(docsLanePath, 'utf8'));
  // Guard the EXTRACTOR only: if it silently grabbed the wrong region, every
  // behavioural assertion below would pass vacuously against an empty script.
  // Deliberately does NOT assert the fix is present — that would turn "the gate was
  // removed" into 14 SKIPPED tests instead of 14 failures, and a skip is a much
  // weaker signal than a red in a suite nobody reads line by line.
  expect(laneScript, 'extracted block must be the arming step').toContain('--auto');
  expect(laneScript, 'extractor must capture the whole step').toContain('outward=');
});

interface Fixture {
  /** `filename \t base64(patch)` rows the stub returns for `pulls/N/files`. */
  files: Array<{ filename: string; patch?: string }>;
  labels: string[];
  /** ISO timestamp when auto-merge is already armed; '' when not. */
  armed?: string;
  /** Make `gh pr merge --disable-auto` fail, to prove the failure is not swallowed. */
  disarmFails?: boolean;
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
  /** Every `gh` invocation, one per line, as the stub saw it. */
  calls: string[];
}

function runLane(fx: Fixture): Result {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-lane-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);

  const rows = fx.files
    .map((f) => `${f.filename}\t${Buffer.from(f.patch ?? '').toString('base64')}`)
    .join('\n');
  fs.writeFileSync(path.join(dir, 'files.tsv'), rows + (rows ? '\n' : ''));
  fs.writeFileSync(path.join(dir, 'labels.txt'), fx.labels.join('\n') + (fx.labels.length ? '\n' : ''));
  fs.writeFileSync(path.join(dir, 'armed.txt'), fx.armed ?? '');

  // A `gh` that records every call and serves the fixture. Nothing reaches the network.
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FIXDIR/calls.log"
case "$*" in
  *"/files"*)              cat "$FIXDIR/files.tsv" ;;
  *".labels[].name"*)      cat "$FIXDIR/labels.txt" ;;
  *autoMergeRequest*)      cat "$FIXDIR/armed.txt" ;;
  *"merge --disable-auto"*|*"--disable-auto"*) ${fx.disarmFails ? 'exit 1' : 'exit 0'} ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FIXDIR: dir,
    GH_TOKEN: 'stub',
    PR: '1741',
    REPO: 'AIClarityAU/minspec',
  };

  let status = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync('bash', ['-c', laneScript], { env, encoding: 'utf8', stdio: 'pipe' });
  } catch (e: any) {
    status = e.status ?? 1;
    stdout = e.stdout?.toString() ?? '';
    stderr = e.stderr?.toString() ?? '';
  }
  const logPath = path.join(dir, 'calls.log');
  const calls = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    : [];
  return { status, stdout, stderr, calls };
}

const armed = (r: Result) => r.calls.some((c) => c.includes('--auto') && !c.includes('--disable-auto'));
const disarmed = (r: Result) => r.calls.some((c) => c.includes('--disable-auto'));

const DR_TYPO_PATCH = '@@ -1,3 +1,3 @@\n-a speling mistake\n+a spelling mistake\n';
const DR_STATUS_PATCH = '@@ -1,5 +1,5 @@\n-status: proposed\n+status: accepted\n';

describe('#1847 — docs-lane must not arm auto-merge on a held PR', () => {
  it('refuses, and does not arm, when hold:human is present', () => {
    const r = runLane({
      files: [{ filename: 'docs/decisions/DR-050.md', patch: DR_TYPO_PATCH }],
      labels: ['docs-lane', 'hold:human'],
    });
    expect(armed(r), 'must NOT arm auto-merge on a held PR').toBe(false);
    expect(r.status, 'a held PR must fail the lane visibly, not pass quietly').toBe(1);
  });

  it('holds on any hold:* label, not just hold:human', () => {
    const r = runLane({
      files: [{ filename: 'docs/guide.md', patch: DR_TYPO_PATCH }],
      labels: ['docs-lane', 'hold:legal'],
    });
    expect(armed(r)).toBe(false);
    expect(r.status).toBe(1);
  });

  it('revokes an arming a previous run already made (the #1741 sequence)', () => {
    const r = runLane({
      files: [{ filename: 'docs/decisions/DR-050.md', patch: DR_TYPO_PATCH }],
      labels: ['docs-lane', 'hold:human'],
      armed: '2026-09-05T22:09:34Z',
    });
    expect(disarmed(r), 'arming is sticky — refusing to re-arm is not enough').toBe(true);
    expect(r.status).toBe(1);
  });

  it('does not attempt a disarm when auto-merge was never armed', () => {
    const r = runLane({
      files: [{ filename: 'docs/decisions/DR-050.md', patch: DR_TYPO_PATCH }],
      labels: ['docs-lane', 'hold:human'],
      armed: '',
    });
    expect(disarmed(r), '"nothing to disarm" must not be reported as a failure').toBe(false);
  });

  it('surfaces a failed disarm instead of swallowing it (invariant 2 — no silent gate)', () => {
    const r = runLane({
      files: [{ filename: 'docs/decisions/DR-050.md', patch: DR_TYPO_PATCH }],
      labels: ['docs-lane', 'hold:human'],
      armed: '2026-09-05T22:09:34Z',
      disarmFails: true,
    });
    expect(r.stdout + r.stderr).toMatch(/STILL ARMED/);
    expect(r.status).toBe(1);
  });

  it('a label merely containing "hold" does not hold the lane', () => {
    const r = runLane({
      files: [{ filename: 'docs/guide.md', patch: DR_TYPO_PATCH }],
      labels: ['docs-lane', 'household-docs'],
    });
    expect(armed(r), 'hold_pattern is anchored — this must still ride the lane').toBe(true);
    expect(r.status).toBe(0);
  });
});

describe('#1847 — docs-lane must not arm auto-merge on a governance status transition', () => {
  it('refuses when a DR frontmatter status: line changes', () => {
    const r = runLane({
      files: [{ filename: 'docs/decisions/DR-050.md', patch: DR_STATUS_PATCH }],
      labels: ['docs-lane'],
    });
    expect(armed(r), 'DR acceptance is a human act (DR-029, DR-086 §2)').toBe(false);
    expect(r.status).toBe(1);
  });

  it('refuses when a spec frontmatter status: line changes', () => {
    const r = runLane({
      files: [{ filename: 'specs/minspec/SPEC-044-x/requirements.md', patch: DR_STATUS_PATCH }],
      labels: ['docs-lane'],
    });
    expect(armed(r)).toBe(false);
    expect(r.status).toBe(1);
  });

  it('still arms for a governance file whose BODY changed but whose status did not', () => {
    const r = runLane({
      files: [{ filename: 'docs/decisions/DR-050.md', patch: DR_TYPO_PATCH }],
      labels: ['docs-lane'],
    });
    expect(armed(r), 'the inward docs-lane (DR-051/#575) must not regress').toBe(true);
    expect(r.status).toBe(0);
  });

  it('ignores a status: line changed OUTSIDE the governance corpus', () => {
    const r = runLane({
      files: [{ filename: 'docs/guide.md', patch: DR_STATUS_PATCH }],
      labels: ['docs-lane'],
    });
    expect(armed(r), 'the gate is scoped to docs/decisions/** and specs/**').toBe(true);
    expect(r.status).toBe(0);
  });

  it('refuses the whole PR when one of several files carries the transition', () => {
    const r = runLane({
      files: [
        { filename: 'docs/guide.md', patch: DR_TYPO_PATCH },
        { filename: 'docs/decisions/DR-050.md', patch: DR_STATUS_PATCH },
      ],
      labels: ['docs-lane'],
    });
    expect(armed(r)).toBe(false);
    expect(r.status).toBe(1);
  });
});

describe('#1847 — no regression in the pre-existing refusals', () => {
  it('still refuses a non-docs path', () => {
    const r = runLane({
      files: [{ filename: 'packages/minspec/src/lib/foo.ts', patch: DR_TYPO_PATCH }],
      labels: ['docs-lane'],
    });
    expect(armed(r)).toBe(false);
    expect(r.status).toBe(1);
  });

  it('still refuses an outward-facing doc (#1001)', () => {
    const r = runLane({ files: [{ filename: 'README.md', patch: DR_TYPO_PATCH }], labels: ['docs-lane'] });
    expect(armed(r)).toBe(false);
    expect(r.status).toBe(1);
  });

  it('still arms an ordinary inward docs-only PR', () => {
    const r = runLane({
      files: [{ filename: 'docs/epics/EP-1.md', patch: DR_TYPO_PATCH }],
      labels: ['docs-lane'],
    });
    expect(armed(r)).toBe(true);
    expect(r.status).toBe(0);
  });
});
