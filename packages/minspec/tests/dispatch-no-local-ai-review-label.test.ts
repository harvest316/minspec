/**
 * T3 — regression: local `dispatch-issue.sh` must never mutate the `ai-review:*`
 * PR label itself (#600).
 *
 * Root cause (#600, historical): before #1355, `dispatch-issue.sh` ran entirely
 * under the OPERATOR's ambient `gh` credential (a human PAT) — it minted no
 * GitHub App token, unlike `.github/workflows/ai-review.yml`, which is the only
 * caller that authenticates as the allowlisted reviewer bot
 * (`AI_REVIEW_BOT_LOGINS`). A human-applied `ai-review:pass` is unauthorized
 * self-approval and is guaranteed-reverted by the provenance guard
 * (`.github/scripts/ai-review-guard.js::decideProvenanceRevert`, #397) — dead
 * work that raced the CI bot's real label and produced a confusing
 * pass→revert→re-pass churn on every dispatched PR (confirmed on #583/#587/
 * #589/#590). The missing gate: nothing previously stopped local dispatch from
 * writing to a merge-gating label under an identity that can never satisfy its
 * own provenance check.
 *
 * This gate makes that bad state un-committable: it scans
 * `scripts/dispatch-issue.sh` for any `gh pr edit`/`gh pr create` call that
 * adds or removes the `ai-review:pass` / `ai-review:changes` labels, and fails
 * if one exists. Labelling stays CI-only; local dispatch may post an advisory
 * comment/review, never the label. This part of the fix is independent of
 * `gh` identity — see the second describe block below.
 *
 * Update (#1355, landed 2026-08-07, well before #1802 was filed): the paragraph
 * above used to also claim dispatch-issue.sh "mints no GitHub App token" as
 * the CURRENT state. That went stale the day #1355 shipped `scripts/lib/gh-bot.sh`
 * and wired `gh_bot_init` into this very script (line 32) — every `gh` write in
 * the file, including the advisory-review call site added here, now carries a
 * bot-attributed token. #1802 re-discovered the pre-#1355 framing from a stale
 * `grep -c GH_TOKEN scripts/dispatch-issue.sh` reading (the literal string lives
 * in gh-bot.sh, not here, because the mechanism is a shell-function wrapper, not
 * an inline export) and, separately, found a real gap this file did not yet
 * cover: a failure of BOTH the `gh pr review` and its `gh pr comment` fallback
 * was swallowed by a bare `2>/dev/null || ... || true` chain with no trace.
 * The second describe block below covers that fix.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { useShellTimeout } from './helpers/shell-timeout';

// #1285: the second describe block spawns real bash + stub-gh children per
// assertion — enforced by shell-timeout-coverage.test.ts.
useShellTimeout();

function findScriptsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'scripts');
    if (fs.existsSync(candidate) && fs.existsSync(path.join(dir, '.git'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate the repo-root scripts/ directory from ' + __dirname);
}

const scriptPath = path.join(findScriptsDir(), 'dispatch-issue.sh');
const content = fs.readFileSync(scriptPath, 'utf-8');

// Strip full-line comments so documentation mentioning the historical/forbidden
// pattern (this very fix's own explanatory comment) can't trip the gate.
const code = content
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

describe('dispatch-issue.sh — never locally mutates the ai-review:* PR label (#600)', () => {
  it('contains no `gh pr edit ... --add-label "ai-review:pass|ai-review:changes"`', () => {
    const addLabelRe = /gh pr (?:edit|create)\b[^\n]*--add-label\s+"ai-review:(pass|changes)"/g;
    const matches = [...code.matchAll(addLabelRe)].map((m) => m[0]);
    expect(matches, `found local ai-review:* label mutation(s): ${matches.join(' | ')}`).toEqual([]);
  });

  it('contains no `gh pr edit ... --remove-label "ai-review:pass|ai-review:changes"`', () => {
    const removeLabelRe = /gh pr (?:edit|create)\b[^\n]*--remove-label\s+"ai-review:(pass|changes)"/g;
    const matches = [...code.matchAll(removeLabelRe)].map((m) => m[0]);
    expect(matches, `found local ai-review:* label mutation(s): ${matches.join(' | ')}`).toEqual([]);
  });

  it('still posts the advisory review (approve/request-changes with comment fallback)', () => {
    // The fix must not silently drop the advisory signal entirely — only the
    // label mutation is removed. Since #1802 the two review verbs are passed
    // as an argument to the shared `post_advisory_review` helper rather than
    // appearing inline next to `gh pr review` itself (see the second describe
    // block below for that helper's own behavioural tests), so match the call
    // sites and the underlying gh commands separately.
    expect(code).toMatch(/post_advisory_review\s+--approve\b/);
    expect(code).toMatch(/post_advisory_review\s+--request-changes\b/);
    expect(code).toMatch(/gh pr review\b/);
    expect(code).toMatch(/gh pr comment\b/);
  });
});

// ── #1802: advisory review is bot-attributed, and a total post failure is loud ──
//
// The block under test is delimited in dispatch-issue.sh by
// `# >>> post-advisory-review` / `# <<< post-advisory-review` — the same
// lift-it-out-and-execute-it-verbatim convention as
// ai-review-verdict-label-coherence.test.ts, so this exercises the shipped
// `post_advisory_review` function itself, not a re-implementation of it.
const BEGIN = '# >>> post-advisory-review';
const END = '# <<< post-advisory-review';

function postAdvisoryReviewBlock(): string {
  const b = content.indexOf(BEGIN);
  const e = content.indexOf(END);
  if (b < 0 || e < b) {
    throw new Error(
      `${BEGIN} / ${END} markers missing from ${scriptPath} — the post_advisory_review ` +
        `function this test guards was moved or deleted, so its behaviour is unverified.`,
    );
  }
  return content.slice(content.indexOf('\n', b) + 1, e);
}

/** A `gh` stub that logs every invocation and fails `pr review` / `pr comment`
 *  independently, controlled by marker files in $GH_STUB_STATE. */
const GH_STUB = `#!/usr/bin/env bash
set -u
S="$GH_STUB_STATE"
printf '%s\\n' "$*" >> "$S/calls.log"

if [ "$1" = "pr" ] && [ "$2" = "review" ]; then
  if [ -f "$S/review_fails" ]; then
    echo "gh: HTTP 422 Unprocessable Entity — Review cannot be requested from pull request author" >&2
    exit 1
  fi
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  if [ -f "$S/comment_fails" ]; then
    echo "gh: HTTP 503 Service Unavailable" >&2
    exit 1
  fi
  exit 0
fi

exit 0
`;

type StubOpts = { reviewFails?: boolean; commentFails?: boolean };
type RunResult = { status: number | null; stdout: string; stderr: string; calls: string[] };

/** Run the extracted `post_advisory_review` function against the stubbed `gh`,
 *  under the SAME `set -euo pipefail` the real script runs under — a non-fatal
 *  claim tested without `-e` would prove nothing about the shipped context. */
function runPostAdvisoryReview(opts: StubOpts, verb: '--approve' | '--request-changes' = '--approve'): RunResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-advisory-review-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), GH_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'calls.log'), '');
    if (opts.reviewFails) fs.writeFileSync(path.join(dir, 'review_fails'), '');
    if (opts.commentFails) fs.writeFileSync(path.join(dir, 'comment_fails'), '');

    const script = [
      'set -euo pipefail',
      'pr_num=4242',
      'REPO=OWNER/REPO',
      postAdvisoryReviewBlock(),
      `post_advisory_review ${verb} "test review body"`,
      'echo "SCRIPT_EXIT_OK"', // only reached if the call above did not abort the shell
    ].join('\n');

    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_STUB_STATE: dir },
    });

    return {
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      calls: fs.readFileSync(path.join(dir, 'calls.log'), 'utf-8').split('\n').filter(Boolean),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('dispatch-issue.sh — advisory review is bot-attributed and fails visibly, never silently (#1802)', () => {
  it('the post-advisory-review call site is reached only after gh_bot_init arms the wrapper (token-scoped, not bare)', () => {
    const sourceIdx = content.indexOf('source "${SCRIPT_DIR}/lib/gh-bot.sh"');
    const initIdx = content.indexOf('gh_bot_init');
    const markerIdx = content.indexOf(BEGIN);

    expect(sourceIdx, 'dispatch-issue.sh must source scripts/lib/gh-bot.sh').toBeGreaterThan(-1);
    expect(initIdx, 'dispatch-issue.sh must call gh_bot_init to arm the `gh` wrapper').toBeGreaterThan(-1);
    expect(markerIdx, 'post-advisory-review block markers are missing').toBeGreaterThan(-1);

    // Ordering proof: by the time execution can ever reach the advisory-review
    // call site, `gh` has already been shadowed by the bot-minting wrapper for
    // the rest of the process (shell functions are process-wide once defined,
    // not lexically scoped) — so no bare/ambient-credential path reaches it.
    expect(sourceIdx).toBeLessThan(markerIdx);
    expect(initIdx).toBeLessThan(markerIdx);

    // And the block itself does not dodge the wrapper (no direct GH_TOKEN
    // manipulation, no `command gh` escape hatch).
    const block = postAdvisoryReviewBlock();
    expect(block).not.toMatch(/GH_TOKEN/);
    expect(block).not.toMatch(/command\s+gh\b/);
  });

  it('still contains the `gh pr comment` fallback', () => {
    expect(postAdvisoryReviewBlock()).toMatch(/gh pr comment\b/);
  });

  it('introduces no `ai-review:*` label mutation in the advisory-review block itself', () => {
    const block = postAdvisoryReviewBlock();
    expect(block).not.toMatch(/--add-label/);
    expect(block).not.toMatch(/--remove-label/);
  });

  it('posts via `gh pr review` when it succeeds, and never calls the comment fallback', () => {
    const r = runPostAdvisoryReview({});
    expect(r.stdout, r.stderr).toContain('SCRIPT_EXIT_OK');
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c.startsWith('pr review'))).toBe(true);
    expect(r.calls.some((c) => c.startsWith('pr comment'))).toBe(false);
    expect(r.stderr).not.toMatch(/could not be posted|NOT posted/);
  });

  it('falls back to `gh pr comment` when `gh pr review` fails (the expected self-authored-PR path), with no warning', () => {
    const r = runPostAdvisoryReview({ reviewFails: true });
    expect(r.stdout, r.stderr).toContain('SCRIPT_EXIT_OK');
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c.startsWith('pr review'))).toBe(true);
    expect(r.calls.some((c) => c.startsWith('pr comment'))).toBe(true);
    // The fallback succeeded, so this is NOT the failure case — no warning.
    expect(r.stderr).not.toMatch(/NOT posted/);
  });

  it('a total failure (both `gh pr review` AND the `gh pr comment` fallback fail) is non-fatal but visibly warned, naming the PR', () => {
    const r = runPostAdvisoryReview({ reviewFails: true, commentFails: true });

    // Non-fatal: the surrounding `set -euo pipefail` script still reaches the
    // line after the call — the old bare `|| true` behaviour, preserved.
    expect(r.stdout, r.stderr).toContain('SCRIPT_EXIT_OK');
    expect(r.status, r.stderr).toBe(0);

    // Visible: unlike the previous `2>/dev/null || ... 2>/dev/null || true`
    // chain, a total failure must not be silent. It must name the PR and show
    // both underlying gh errors, not just declare failure in the abstract.
    expect(r.stderr).toMatch(/NOT posted/);
    expect(r.stderr).toContain('#4242');
    expect(r.stderr).toMatch(/gh pr review/);
    expect(r.stderr).toMatch(/gh pr comment/);
    expect(r.stderr).toContain('Unprocessable Entity');
    expect(r.stderr).toContain('Service Unavailable');
  });
});
