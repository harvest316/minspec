/**
 * T2/T1 — ruleset advisor (#356, reworked per DR-050 Amendment 2026-07-01).
 *
 * New posture: the read-only config PROBE runs AUTONOMOUSLY on init (no consent
 * toast); only the MUTATING create is consent-gated behind an explicit "Create
 * ruleset" click. Covers the contract cases from the issue:
 *   1. gh absent            → docs link, NO read/create network.
 *   2. gh present + exists   → SILENT (no toast at all), NO create.
 *   3. gh present + none     → exactly ONE create-offer toast.
 *   4. create success        → success toast (create only on explicit click).
 *   5. create 403            → docs-link fallback.
 *   6. configurable checks   → the created payload honours the configured set.
 *
 * The auto-probe (`gh api .../rulesets` GET of the repo's OWN settings) fires
 * WITHOUT any consent toast once `gh` is ready and the repo resolves — the same
 * class as MinSpec shelling `git fetch`. The create POST fires ONLY on the
 * explicit "Create ruleset" click. "Not now"/"Learn more"/dismiss → NO POST.
 *
 * The command runner is ALWAYS mocked — these tests NEVER hit the real network
 * and NEVER create a real ruleset. They also assert the Tier-0 boundary: when
 * `gh` is unavailable, ZERO `gh` subcommands beyond the availability probe run;
 * and no MUTATING POST ever fires without the explicit create click.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode (only what the advisory touches) ────────────────────────────

/** Value returned by the mocked `vscode.workspace.getConfiguration().get()`. */
let mockConfigValue: unknown = undefined;

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  env: { openExternal: vi.fn() },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  workspace: {
    getConfiguration: () => ({ get: () => mockConfigValue }),
  },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import {
  type CommandResult,
  type CommandRunner,
  RULESET_DOCS_URL,
  DEFAULT_REQUIRED_CHECK_CONTEXTS,
  RULESET_NAME,
  createRulesetPayload,
  createRequiredChecksRuleset,
  hasRequiredChecksRuleset,
  isGhReady,
  resolveCheckContexts,
  detectCodeChecks,
  resolveTieredRequiredChecks,
  AI_REVIEW_CHECK,
  READY_TO_MERGE_CHECK,
  listRequiredCheckContexts,
  probeReviewerConfigured,
  REVIEWER_SECRETS,
  updateRulesetRequiredChecks,
} from '../src/lib/ruleset-advisor';
import { offerRulesetAdvisory, resolveRequiredChecks } from '../src/commands/init';
import { MANAGED_REGION_TEMPLATES } from '../src/lib/template-registry';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// ─── Test runner factory ─────────────────────────────────────────────────────

/**
 * A scriptable {@link CommandRunner}. Each entry maps a `gh`-args signature to a
 * canned result (or a thrown spawn error). Records every invocation so tests can
 * assert exactly which subcommands ran.
 */
type Reply = CommandResult | { throws: string };

function ok(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: '' };
}
function fail(code: number, stderr: string): CommandResult {
  return { code, stdout: '', stderr };
}

function makeRunner(
  match: (cmd: string, args: string[]) => Reply | undefined,
): { run: CommandRunner; calls: Array<{ cmd: string; args: string[]; stdin?: string }> } {
  const calls: Array<{ cmd: string; args: string[]; stdin?: string }> = [];
  const run: CommandRunner = async (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin });
    const reply = match(cmd, args);
    if (reply === undefined) {
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    }
    if ('throws' in reply) throw new Error(reply.throws);
    return reply;
  };
  return { run, calls };
}

/** First arg after `api` for `gh api <path>` calls (else undefined). */
function apiPath(args: string[]): string | undefined {
  const i = args.indexOf('api');
  return i >= 0 ? args[i + 1] : undefined;
}

/** True if this call is a `gh api repos/...` invocation (read or write). */
function isRepoApiCall(args: string[]): boolean {
  return apiPath(args)?.startsWith('repos/') ?? false;
}

const showInfo = vscode.window.showInformationMessage as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigValue = undefined;
});

// =============================================================================
// Pure library: detection
// =============================================================================

describe('isGhReady()', () => {
  it('false when gh binary cannot spawn (rejection)', async () => {
    const { run, calls } = makeRunner((_c, a) =>
      a[0] === '--version' ? { throws: 'ENOENT' } : ok(''),
    );
    expect(await isGhReady(run)).toBe(false);
    // Must short-circuit: never probe auth once --version fails.
    expect(calls).toHaveLength(1);
  });

  it('false when gh is installed but not authenticated', async () => {
    const { run } = makeRunner((_c, a) => {
      if (a[0] === '--version') return ok('gh version 2.50.0');
      if (a[0] === 'auth') return fail(1, 'not logged in');
      return undefined;
    });
    expect(await isGhReady(run)).toBe(false);
  });

  it('true when gh is installed AND authenticated', async () => {
    const { run } = makeRunner((_c, a) => {
      if (a[0] === '--version') return ok('gh version 2.50.0');
      if (a[0] === 'auth') return ok('Logged in to github.com');
      return undefined;
    });
    expect(await isGhReady(run)).toBe(true);
  });
});

// =============================================================================
// Pure library: ruleset detection
// =============================================================================

describe('hasRequiredChecksRuleset()', () => {
  it('true when a branch ruleset targets the default branch with required status checks', async () => {
    const { run } = makeRunner((_c, args) => {
      const p = apiPath(args);
      if (p === 'repos/o/r/rulesets') {
        return ok(JSON.stringify([{ id: 5, target: 'branch', enforcement: 'active' }]));
      }
      if (p === 'repos/o/r/rulesets/5') {
        return ok(
          JSON.stringify({
            conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
            rules: [
              {
                type: 'required_status_checks',
                // Requires exactly the injected wanted set (['lint','test']) → the
                // symmetric check finds nothing missing → SILENT (fully configured).
                parameters: { required_status_checks: [{ context: 'lint' }, { context: 'test' }] },
              },
            ],
          }),
        );
      }
      return undefined;
    });
    expect(await hasRequiredChecksRuleset('o', 'r', run)).toBe(true);
  });

  it('false when the only ruleset has no required-status-checks rule', async () => {
    const { run } = makeRunner((_c, args) => {
      const p = apiPath(args);
      if (p === 'repos/o/r/rulesets') {
        return ok(JSON.stringify([{ id: 5, target: 'branch', enforcement: 'active' }]));
      }
      if (p === 'repos/o/r/rulesets/5') {
        return ok(
          JSON.stringify({
            conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
            rules: [{ type: 'pull_request' }],
          }),
        );
      }
      return undefined;
    });
    expect(await hasRequiredChecksRuleset('o', 'r', run)).toBe(false);
  });

  it('false (offer) on an empty ruleset list', async () => {
    const { run } = makeRunner((_c, args) =>
      apiPath(args) === 'repos/o/r/rulesets' ? ok('[]') : undefined,
    );
    expect(await hasRequiredChecksRuleset('o', 'r', run)).toBe(false);
  });

  it('false (offer) when the list read fails', async () => {
    const { run } = makeRunner(() => fail(1, 'boom'));
    expect(await hasRequiredChecksRuleset('o', 'r', run)).toBe(false);
  });

  it('ignores disabled rulesets', async () => {
    const { run } = makeRunner((_c, args) => {
      const p = apiPath(args);
      if (p === 'repos/o/r/rulesets') {
        return ok(JSON.stringify([{ id: 9, target: 'branch', enforcement: 'disabled' }]));
      }
      return undefined; // detail must never be fetched for a disabled ruleset
    });
    expect(await hasRequiredChecksRuleset('o', 'r', run)).toBe(false);
  });
});

// =============================================================================
// Pure library: payload
// =============================================================================

/** Extract the required-check contexts from a built payload. */
function payloadContexts(payload: Record<string, unknown>): string[] {
  const rules = (payload as {
    rules: Array<{ type: string; parameters: { required_status_checks: Array<{ context: string }> } }>;
  }).rules;
  const rule = rules.find((r) => r.type === 'required_status_checks');
  return rule!.parameters.required_status_checks.map((c) => c.context);
}

describe('createRulesetPayload()', () => {
  it('requires MinSpec SDD validation on the default branch and OMITS ready-to-merge by default', () => {
    const payload = createRulesetPayload() as {
      name: string;
      target: string;
      enforcement: string;
      conditions: { ref_name: { include: string[] } };
    } & Record<string, unknown>;

    expect(payload.name).toBe(RULESET_NAME);
    expect(payload.target).toBe('branch');
    expect(payload.enforcement).toBe('active');
    expect(payload.conditions.ref_name.include).toContain('~DEFAULT_BRANCH');

    const contexts = payloadContexts(payload);
    expect(contexts).toEqual([...DEFAULT_REQUIRED_CHECK_CONTEXTS]);
    // The default MUST match the check context MinSpec's own scaffolded CI
    // reports (`validate` job's `name:` in minspec-validate.yml) — anything
    // else deadlocks every PR on a repo that only has the scaffolded CI (#559).
    expect(contexts).toEqual(['MinSpec SDD validation']);
    // ready-to-merge would block every merge until the reviewer auto-labels —
    // it must NOT be a default required check.
    expect(contexts).not.toContain('ready-to-merge');
  });

  it('CONFIGURABLE: honours a caller-supplied check set (e.g. adds build + ready-to-merge)', () => {
    const payload = createRulesetPayload(['lint', 'test', 'build', 'ready-to-merge']);
    const contexts = payloadContexts(payload);
    expect(contexts).toEqual(['lint', 'test', 'build', 'ready-to-merge']);
    // Opt-in only: it appears because the caller asked for it, not by default.
    expect(contexts).toContain('ready-to-merge');
  });

  it('falls back to the default when given an empty check set', () => {
    const contexts = payloadContexts(createRulesetPayload([]));
    expect(contexts).toEqual([...DEFAULT_REQUIRED_CHECK_CONTEXTS]);
  });
});

describe('DEFAULT_REQUIRED_CHECK_CONTEXTS matches the scaffolded CI (#559 regression)', () => {
  it('equals the job `name:` MinSpec\'s own minspec-validate.yml template reports', () => {
    // Root cause of #559: the default was a hardcoded ['lint', 'test'] guess
    // that was never reconciled with the check context the extension's own
    // scaffolded CI actually reports, so the advisor could write a
    // self-deadlocking ruleset. This test ties the default directly to the
    // scaffolded workflow's job name so the two can never drift apart again
    // undetected.
    const workflowTemplate = MANAGED_REGION_TEMPLATES.find(
      (t) => t.outputPath === '.github/workflows/minspec-validate.yml',
    );
    expect(workflowTemplate).toBeDefined();

    const match = workflowTemplate!.content.match(/\n\s*validate:\s*\n\s*name:\s*(.+)/);
    expect(match).not.toBeNull();
    const scaffoldedJobName = match![1].trim();

    expect([...DEFAULT_REQUIRED_CHECK_CONTEXTS]).toEqual([scaffoldedJobName]);
  });
});

describe('resolveCheckContexts()', () => {
  it('returns the default when undefined / not an array', () => {
    expect(resolveCheckContexts(undefined)).toEqual([...DEFAULT_REQUIRED_CHECK_CONTEXTS]);
    expect(resolveCheckContexts('lint' as unknown as string[])).toEqual([
      ...DEFAULT_REQUIRED_CHECK_CONTEXTS,
    ]);
  });

  it('trims, drops blanks, and de-duplicates a configured set', () => {
    expect(resolveCheckContexts([' lint ', 'test', 'test', '', 'build'])).toEqual([
      'lint',
      'test',
      'build',
    ]);
  });

  it('falls back to the default when everything is blank', () => {
    expect(resolveCheckContexts(['', '   '])).toEqual([...DEFAULT_REQUIRED_CHECK_CONTEXTS]);
  });
});

describe('resolveRequiredChecks() (reads minspec.ruleset.requiredChecks)', () => {
  it('returns the default when the setting is unset', () => {
    mockConfigValue = undefined;
    expect(resolveRequiredChecks()).toEqual([...DEFAULT_REQUIRED_CHECK_CONTEXTS]);
  });

  it('returns the configured set (opt-in ready-to-merge) when set', () => {
    mockConfigValue = ['lint', 'test', 'ready-to-merge'];
    expect(resolveRequiredChecks()).toEqual(['lint', 'test', 'ready-to-merge']);
  });

  it('falls back to the default when the setting is malformed', () => {
    mockConfigValue = 'not-an-array';
    expect(resolveRequiredChecks()).toEqual([...DEFAULT_REQUIRED_CHECK_CONTEXTS]);
  });
});

// =============================================================================
// Pure library: tiered required-check resolution (#564)
// =============================================================================

describe('detectCodeChecks() (#564 Tier-B producibility)', () => {
  it('none producible when the scripts map is missing / empty', () => {
    expect(detectCodeChecks(undefined)).toEqual({ lint: false, test: false, build: false });
    expect(detectCodeChecks(null)).toEqual({ lint: false, test: false, build: false });
    expect(detectCodeChecks({})).toEqual({ lint: false, test: false, build: false });
  });

  it('counts only non-blank string scripts (a blank/non-string script is not producible)', () => {
    expect(
      detectCodeChecks({
        test: 'vitest run',
        lint: '   ',
        build: 42 as unknown as string,
      }),
    ).toEqual({ lint: false, test: true, build: false });
  });
});

describe('resolveTieredRequiredChecks() (#564 no-deadlock tiering)', () => {
  it('always requires MinSpec SDD validation, and nothing the repo cannot produce', () => {
    expect(
      resolveTieredRequiredChecks({
        aiReviewWorkflowScaffolded: false,
        readyToMergeWorkflowScaffolded: false,
      }),
    ).toEqual(['MinSpec SDD validation']);
  });

  it('Tier A: ai-review + ready-to-merge ENTER the set when scaffolded AND reviewer configured', () => {
    const checks = resolveTieredRequiredChecks({
      aiReviewWorkflowScaffolded: true,
      readyToMergeWorkflowScaffolded: true,
      reviewerConfigured: true,
    });
    expect(checks).toContain('MinSpec SDD validation');
    expect(checks).toContain(AI_REVIEW_CHECK);
    expect(checks).toContain(READY_TO_MERGE_CHECK);
  });

  it('Tier A NO-DEADLOCK: scaffolded but reviewer NOT configured → NOT required (invariant #3)', () => {
    // The workflows exist but post no pass until the reviewer secrets/App are set
    // (#564 slice 3). Requiring them now would block every merge on a fresh/solo
    // repo — exactly the DR-050 / #559 deadlock. So they stay OUT.
    const checks = resolveTieredRequiredChecks({
      aiReviewWorkflowScaffolded: true,
      readyToMergeWorkflowScaffolded: true,
      // reviewerConfigured omitted ⇒ defaults false (fail-safe)
    });
    expect(checks).toEqual(['MinSpec SDD validation']);
    expect(checks).not.toContain(AI_REVIEW_CHECK);
    expect(checks).not.toContain(READY_TO_MERGE_CHECK);
  });

  it('Tier A NO-DEADLOCK: reviewer configured but a workflow MISSING → that check stays out', () => {
    // e.g. the user deleted ai-review.yml. Requiring `ai-review` with no workflow
    // to report it = permanent pending. ready-to-merge (present) still enters.
    const checks = resolveTieredRequiredChecks({
      aiReviewWorkflowScaffolded: false,
      readyToMergeWorkflowScaffolded: true,
      reviewerConfigured: true,
    });
    expect(checks).not.toContain(AI_REVIEW_CHECK);
    expect(checks).toContain(READY_TO_MERGE_CHECK);
  });

  it('Tier B: lint/test/build do NOT enter on a repo with no runnable scripts (#559)', () => {
    const checks = resolveTieredRequiredChecks({
      aiReviewWorkflowScaffolded: true,
      readyToMergeWorkflowScaffolded: true,
      reviewerConfigured: true,
      codeChecks: detectCodeChecks(undefined), // no package.json scripts
    });
    expect(checks).not.toContain('lint');
    expect(checks).not.toContain('test');
    expect(checks).not.toContain('build');
  });

  it('Tier B: requires ONLY the code checks the repo can actually run', () => {
    const checks = resolveTieredRequiredChecks({
      aiReviewWorkflowScaffolded: false,
      readyToMergeWorkflowScaffolded: false,
      codeChecks: detectCodeChecks({ test: 'vitest run', build: 'tsc -p .' }), // no lint script
    });
    expect(checks).toContain('test');
    expect(checks).toContain('build');
    expect(checks).not.toContain('lint');
  });

  it('layers user-configured extras, de-duplicates, and keeps MinSpec SDD validation first', () => {
    const checks = resolveTieredRequiredChecks({
      aiReviewWorkflowScaffolded: true,
      readyToMergeWorkflowScaffolded: true,
      reviewerConfigured: true,
      userChecks: ['ready-to-merge', ' custom-gate ', 'MinSpec SDD validation'],
    });
    expect(checks[0]).toBe('MinSpec SDD validation');
    expect(checks.filter((c) => c === READY_TO_MERGE_CHECK)).toHaveLength(1);
    expect(checks.filter((c) => c === 'MinSpec SDD validation')).toHaveLength(1);
    expect(checks).toContain('custom-gate'); // trimmed
  });
});

// =============================================================================
// Pure library: create
// =============================================================================

describe('createRequiredChecksRuleset()', () => {
  it('POSTs the payload over stdin and reports success on exit 0', async () => {
    const { run, calls } = makeRunner((_c, args) =>
      args.includes('POST') ? ok('{"id":1}') : undefined,
    );
    const outcome = await createRequiredChecksRuleset('o', 'r', run);
    // Deep equality kept deliberately: it pins the FULL outcome shape, so a new
    // field cannot be added without someone deciding what success means for it.
    // `planLimited`/`reason` carry the 403 classification (#1567 follow-up) and are
    // necessarily absent on success.
    expect(outcome).toEqual({
      created: true,
      forbidden: false,
      planLimited: false,
      reason: null,
      detail: '',
    });

    const post = calls.find((c) => c.args.includes('POST'))!;
    expect(post.args).toContain('repos/o/r/rulesets');
    expect(post.args).toEqual(expect.arrayContaining(['--input', '-']));
    // Body streamed over stdin, never interpolated into argv.
    expect(post.stdin).toBeDefined();
    expect(JSON.parse(post.stdin!)).toMatchObject({ name: RULESET_NAME });
  });

  it('flags forbidden on a 403 response', async () => {
    const { run } = makeRunner((_c, args) =>
      args.includes('POST') ? fail(1, 'HTTP 403: Must have admin rights') : undefined,
    );
    const outcome = await createRequiredChecksRuleset('o', 'r', run);
    expect(outcome.created).toBe(false);
    expect(outcome.forbidden).toBe(true);
  });

  it('non-403 failure → created:false, forbidden:false', async () => {
    const { run } = makeRunner((_c, args) =>
      args.includes('POST') ? fail(1, 'HTTP 422: validation failed') : undefined,
    );
    const outcome = await createRequiredChecksRuleset('o', 'r', run);
    expect(outcome.created).toBe(false);
    expect(outcome.forbidden).toBe(false);
  });

  it('CONFIGURABLE: threads the caller-supplied check set into the POSTed body', async () => {
    const { run, calls } = makeRunner((_c, args) =>
      args.includes('POST') ? ok('{"id":1}') : undefined,
    );
    await createRequiredChecksRuleset('o', 'r', run, ['lint', 'test', 'ready-to-merge']);
    const post = calls.find((c) => c.args.includes('POST'))!;
    const body = JSON.parse(post.stdin!) as {
      rules: Array<{ type: string; parameters: { required_status_checks: Array<{ context: string }> } }>;
    };
    const rule = body.rules.find((r) => r.type === 'required_status_checks')!;
    expect(rule.parameters.required_status_checks.map((c) => c.context)).toEqual([
      'lint',
      'test',
      'ready-to-merge',
    ]);
  });
});

// =============================================================================
// Wired advisory: offerRulesetAdvisory() (the post-init UX)
// =============================================================================

describe('offerRulesetAdvisory() — autonomous probe + single-consent create (#356; DR-050 Amendment)', () => {
  const resolveRepo = vi.fn(async () => 'o/r');
  const openExternal = vi.fn();
  // Treat the folder as a repo so we exercise the gh path; the .git guard is
  // covered separately below.
  const isRepo = () => true;

  /**
   * Default advisory deps with a scripted runner. `requiredChecks` is injected so
   * the create path never reaches `vscode.workspace` config in these tests unless
   * a case deliberately omits it.
   */
  function deps(run: CommandRunner, requiredChecks: readonly string[] = ['lint', 'test']) {
    return { run, resolveRepo, openExternal, isRepo, requiredChecks };
  }

  beforeEach(() => {
    resolveRepo.mockClear();
    openExternal.mockClear();
  });

  it('CASE 1: gh absent → docs link, and ZERO network beyond the version probe', async () => {
    const { run, calls } = makeRunner((_c, a) =>
      a[0] === '--version' ? { throws: 'ENOENT' } : ok(''),
    );
    // User clicks the docs action.
    showInfo.mockResolvedValueOnce('View GitHub docs');

    await offerRulesetAdvisory('/ws', deps(run));

    // Only `gh --version` ran — no `gh api` read, no POST, no repo resolve.
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['--version']);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(RULESET_DOCS_URL);
  });

  it('CASE 1b: gh absent + user dismisses the toast → no open, still zero network', async () => {
    const { run, calls } = makeRunner((_c, a) =>
      a[0] === '--version' ? { throws: 'ENOENT' } : ok(''),
    );
    showInfo.mockResolvedValueOnce(undefined); // dismissed

    await offerRulesetAdvisory('/ws', deps(run));

    expect(calls).toHaveLength(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('AUTO-PROBE: the read-only rulesets GET fires on init WITHOUT any consent toast', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      const p = apiPath(args);
      if (p === 'repos/o/r/rulesets') {
        return ok(JSON.stringify([{ id: 1, target: 'branch', enforcement: 'active' }]));
      }
      if (p === 'repos/o/r/rulesets/1') {
        return ok(
          JSON.stringify({
            conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
            rules: [
              {
                type: 'required_status_checks',
                // Requires exactly the injected wanted set (['lint','test']) → the
                // symmetric check finds nothing missing → SILENT (fully configured).
                parameters: { required_status_checks: [{ context: 'lint' }, { context: 'test' }] },
              },
            ],
          }),
        );
      }
      return undefined;
    });
    // NO showInfo mock queued — the probe must not depend on a user click.

    await offerRulesetAdvisory('/ws', deps(run));

    // The read-only `gh api .../rulesets` GET ran autonomously (no toast gated it).
    expect(calls.some((c) => apiPath(c.args) === 'repos/o/r/rulesets')).toBe(true);
    // And crucially NO consent prompt preceded it.
    expect(showInfo).not.toHaveBeenCalled();
  });

  it('AUTO-PROBE: the reviewer-secret NAMES GET fires autonomously on init — NO consent toast (DR-050 Amendment 2026-07-16, #796)', async () => {
    // No injected `requiredChecks` → the detection path runs resolveWantedChecks(),
    // which probes the repo's OWN Actions-secret NAMES autonomously. The ruleset is
    // already fully satisfied, so the flow is SILENT — yet the secret probe still
    // fired, proving it is not gated behind any write-consent toast.
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      const p = apiPath(args);
      if (p === 'repos/o/r/actions/secrets') {
        return ok(JSON.stringify(['CLAUDE_CODE_OAUTH_TOKEN', 'MINSPEC_APP_ID', 'MINSPEC_APP_PRIVATE_KEY']));
      }
      if (p === 'repos/o/r/rulesets') {
        return ok(JSON.stringify([{ id: 1, target: 'branch', enforcement: 'active' }]));
      }
      if (p === 'repos/o/r/rulesets/1') {
        return ok(
          JSON.stringify({
            conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
            rules: [
              {
                // Fully satisfied against the resolved wanted set (validation only,
                // no scaffolded workflows in this fixture folder) → SILENT.
                type: 'required_status_checks',
                parameters: { required_status_checks: [{ context: 'MinSpec SDD validation' }] },
              },
            ],
          }),
        );
      }
      return undefined;
    });
    // NO showInfo mock queued — the secret probe must not depend on a user click.

    await offerRulesetAdvisory('/ws', { run, resolveRepo, openExternal, isRepo });

    // The reviewer-secret-NAMES GET ran autonomously, before (indeed without) any toast.
    expect(calls.some((c) => apiPath(c.args) === 'repos/o/r/actions/secrets')).toBe(true);
    expect(showInfo).not.toHaveBeenCalled();
    // Purely a read: no mutation fired.
    expect(calls.some((c) => c.args.includes('POST') || c.args.includes('PUT'))).toBe(false);
  });

  it('CASE 2: gh present + ruleset already exists → SILENT (no toast at all), NO create', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      const p = apiPath(args);
      if (p === 'repos/o/r/rulesets') {
        return ok(JSON.stringify([{ id: 1, target: 'branch', enforcement: 'active' }]));
      }
      if (p === 'repos/o/r/rulesets/1') {
        return ok(
          JSON.stringify({
            conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
            rules: [
              {
                type: 'required_status_checks',
                // Requires exactly the injected wanted set (['lint','test']) → the
                // symmetric check finds nothing missing → SILENT (fully configured).
                parameters: { required_status_checks: [{ context: 'lint' }, { context: 'test' }] },
              },
            ],
          }),
        );
      }
      return undefined;
    });

    await offerRulesetAdvisory('/ws', deps(run));

    // Existing ruleset → nothing for the user to do → ZERO toasts.
    expect(showInfo).not.toHaveBeenCalled();
    // The probe ran but no POST was made.
    expect(calls.some((c) => apiPath(c.args) === 'repos/o/r/rulesets')).toBe(true);
    expect(calls.some((c) => c.args.includes('POST'))).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('CASE (add — the sealbox gap): ruleset missing checks → offers ADD → PUT adds them, preserves existing, no POST', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      const isPut = args.includes('PUT');
      if (apiPath(args) === 'repos/o/r/rulesets') {
        return ok(JSON.stringify([{ id: 9, target: 'branch', enforcement: 'active' }]));
      }
      if (args.includes('repos/o/r/rulesets/9') && !isPut) return ok(rulesetDetail(9, ['MinSpec SDD validation']));
      if (args.includes('repos/o/r/rulesets/9') && isPut) return ok('{}');
      return undefined;
    });
    showInfo.mockResolvedValueOnce('Add checks'); // user accepts the add offer

    // Injected wanted = the full governance set; the existing ruleset has only validation.
    await offerRulesetAdvisory('/ws', deps(run, ['MinSpec SDD validation', 'ai-review', 'ready-to-merge']));

    // Offered ADD (not create) — naming the missing checks — with the consent actions.
    expect(String(showInfo.mock.calls[0][0])).toMatch(/does not require .*ai-review.*ready-to-merge/i);
    expect(showInfo.mock.calls[0].slice(1)).toEqual(['Add checks', 'Not now', 'Learn more']);
    // PUT updated the EXISTING ruleset (no create), adding the missing checks and
    // preserving the one already required.
    const put = calls.find((c) => c.args.includes('PUT'));
    expect(put?.stdin).toContain('MinSpec SDD validation');
    expect(put?.stdin).toContain('ai-review');
    expect(put?.stdin).toContain('ready-to-merge');
    expect(calls.some((c) => c.args.includes('POST'))).toBe(false);
    expect(String(showInfo.mock.calls[1][0])).toMatch(/added/i);
  });

  it('CASE (add, Tier-B only): missing checks are lint/test/build only → copy says "full CI coverage", not "AI-review gate"', async () => {
    const { run } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      const isPut = args.includes('PUT');
      if (apiPath(args) === 'repos/o/r/rulesets') {
        return ok(JSON.stringify([{ id: 9, target: 'branch', enforcement: 'active' }]));
      }
      if (args.includes('repos/o/r/rulesets/9') && !isPut) return ok(rulesetDetail(9, ['MinSpec SDD validation']));
      if (args.includes('repos/o/r/rulesets/9') && isPut) return ok('{}');
      return undefined;
    });
    showInfo.mockResolvedValueOnce('Not now'); // decline; only the offer copy is under test

    // Injected wanted = validation + a Tier-B check; the existing ruleset has
    // only validation, so the missing set is Tier-B-only (no ai-review/ready-to-merge).
    await offerRulesetAdvisory('/ws', deps(run, ['MinSpec SDD validation', 'lint']));

    const message = String(showInfo.mock.calls[0][0]);
    expect(message).toMatch(/does not require lint/i);
    expect(message).toMatch(/without full CI coverage/i);
    expect(message).not.toMatch(/AI-review gate/i);
  });

  it('CASE 3+4: none found → exactly ONE create-offer toast; on Create → POST + success toast', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      const p = apiPath(args);
      if (p === 'repos/o/r/rulesets' && !args.includes('POST')) return ok('[]');
      if (args.includes('POST')) return ok('{"id":7}');
      return undefined;
    });
    // User accepts the sole create offer.
    showInfo.mockResolvedValueOnce('Create ruleset');

    await offerRulesetAdvisory('/ws', deps(run));

    // Exactly ONE offer toast (the create prompt) preceded the create...
    expect(String(showInfo.mock.calls[0][0])).toMatch(/no branch ruleset requiring CI checks/i);
    expect(showInfo.mock.calls[0].slice(1)).toEqual(['Create ruleset', 'Not now', 'Learn more']);
    // ...a POST happened and the success toast fired (2 info toasts total).
    expect(calls.some((c) => c.args.includes('POST'))).toBe(true);
    expect(showInfo).toHaveBeenCalledTimes(2);
    expect(String(showInfo.mock.calls[1][0])).toMatch(/created a ruleset/i);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('CONFIGURABLE: the configured check set is honoured in the created payload', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      if (apiPath(args) === 'repos/o/r/rulesets' && !args.includes('POST')) return ok('[]');
      if (args.includes('POST')) return ok('{"id":7}');
      return undefined;
    });
    showInfo.mockResolvedValueOnce('Create ruleset');

    // Inject an extended check set (build + opt-in ready-to-merge).
    await offerRulesetAdvisory('/ws', deps(run, ['lint', 'test', 'build', 'ready-to-merge']));

    const post = calls.find((c) => c.args.includes('POST'))!;
    const body = JSON.parse(post.stdin!) as {
      rules: Array<{ type: string; parameters: { required_status_checks: Array<{ context: string }> } }>;
    };
    const rule = body.rules.find((r) => r.type === 'required_status_checks')!;
    expect(rule.parameters.required_status_checks.map((c) => c.context)).toEqual([
      'lint',
      'test',
      'build',
      'ready-to-merge',
    ]);
    // The offer toast also names the configured set.
    expect(String(showInfo.mock.calls[0][0])).toMatch(/ready-to-merge/);
  });

  it('CONFIGURABLE: with no injected checks the create resolves the tiered set (validation + config extras)', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      // No reviewer secrets in this fixture → Tier-A stays out (no #559 deadlock).
      if (apiPath(args) === 'repos/o/r/actions/secrets') return ok('[]');
      if (apiPath(args) === 'repos/o/r/rulesets' && !args.includes('POST')) return ok('[]');
      if (args.includes('POST')) return ok('{"id":7}');
      return undefined;
    });
    // The `minspec.ruleset.requiredChecks` setting adds `build` (now ADDITIVE:
    // MinSpec SDD validation is always required; user extras layer on top).
    mockConfigValue = ['build'];
    showInfo.mockResolvedValueOnce('Create ruleset');

    // Omit deps.requiredChecks so resolveWantedChecks() probes + resolves the set.
    await offerRulesetAdvisory('/ws', { run, resolveRepo, openExternal, isRepo });

    const post = calls.find((c) => c.args.includes('POST'))!;
    const body = JSON.parse(post.stdin!) as {
      rules: Array<{ type: string; parameters: { required_status_checks: Array<{ context: string }> } }>;
    };
    const rule = body.rules.find((r) => r.type === 'required_status_checks')!;
    // Validation is non-negotiable + the config extra. Tier-A absent (no secrets,
    // no scaffolded workflows in this fixture folder). Deny-by-default deadlock-safe.
    expect(rule.parameters.required_status_checks.map((c) => c.context)).toEqual([
      'MinSpec SDD validation',
      'build',
    ]);
  });

  it('CASE 3 (declined): none found → offer; "Not now" → no POST, no open', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      if (apiPath(args) === 'repos/o/r/rulesets' && !args.includes('POST')) return ok('[]');
      return undefined;
    });
    showInfo.mockResolvedValueOnce('Not now'); // decline the create offer

    await offerRulesetAdvisory('/ws', deps(run));

    // The probe ran, one offer toast fired, but no POST followed the decline.
    expect(calls.some((c) => apiPath(c.args) === 'repos/o/r/rulesets' && !c.args.includes('POST'))).toBe(true);
    expect(calls.some((c) => c.args.includes('POST'))).toBe(false);
    expect(showInfo).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('CASE (Learn more): none found → offer; "Learn more" → docs link, no POST', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      if (apiPath(args) === 'repos/o/r/rulesets' && !args.includes('POST')) return ok('[]');
      return undefined;
    });
    showInfo.mockResolvedValueOnce('Learn more');

    await offerRulesetAdvisory('/ws', deps(run));

    expect(openExternal).toHaveBeenCalledWith(RULESET_DOCS_URL);
    expect(calls.some((c) => c.args.includes('POST'))).toBe(false);
  });

  it('CASE (dismissed): none found → offer; Escape → no POST, no open', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      if (apiPath(args) === 'repos/o/r/rulesets' && !args.includes('POST')) return ok('[]');
      return undefined;
    });
    showInfo.mockResolvedValueOnce(undefined); // dismissed

    await offerRulesetAdvisory('/ws', deps(run));

    expect(calls.some((c) => c.args.includes('POST'))).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('CASE 5: create returns 403 → docs-link fallback', async () => {
    const { run } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      if (apiPath(args) === 'repos/o/r/rulesets' && !args.includes('POST')) return ok('[]');
      if (args.includes('POST')) return fail(1, 'HTTP 403: Resource not accessible');
      return undefined;
    });
    showInfo
      .mockResolvedValueOnce('Create ruleset') // accept offer
      .mockResolvedValueOnce('View GitHub docs'); // click docs on the fallback toast

    await offerRulesetAdvisory('/ws', deps(run));

    // Fallback message (2nd info call) mentions the admin-scope reason and opens
    // the docs.
    expect(String(showInfo.mock.calls[1][0])).toMatch(/repo-admin scope/i);
    expect(openExternal).toHaveBeenCalledWith(RULESET_DOCS_URL);
  });

  it('gh ready but no GitHub remote → docs link, no probe/create', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      return undefined;
    });
    resolveRepo.mockResolvedValueOnce(null);
    showInfo.mockResolvedValueOnce('View GitHub docs');

    await offerRulesetAdvisory('/ws', deps(run));

    expect(calls.some((c) => isRepoApiCall(c.args))).toBe(false);
    expect(openExternal).toHaveBeenCalledWith(RULESET_DOCS_URL);
  });

  it('DEFENSE-IN-DEPTH: a malformed resolved slug never reaches `gh api`', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      return undefined;
    });
    // A slug that fails the ^owner/repo$ charset assertion (path-traversal-ish).
    resolveRepo.mockResolvedValueOnce('o/../../etc');
    showInfo.mockResolvedValueOnce('View GitHub docs');

    await offerRulesetAdvisory('/ws', deps(run));

    // Treated like "no GitHub repo": docs link, NO `gh api` repos call at all
    // (neither the read-only probe nor a create).
    expect(calls.every((c) => !isRepoApiCall(c.args))).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(RULESET_DOCS_URL);
  });

  it('never throws — a runner explosion is swallowed (best-effort)', async () => {
    const run: CommandRunner = async () => {
      throw new Error('catastrophic');
    };
    await expect(
      offerRulesetAdvisory('/ws', deps(run)),
    ).resolves.toBeUndefined();
  });

  it('non-repo folder → returns before probing gh (zero process, zero toast)', async () => {
    const { run, calls } = makeRunner(() => ok('')); // any call is unexpected
    await offerRulesetAdvisory('/ws', {
      run,
      resolveRepo,
      openExternal,
      isRepo: () => false,
    });
    expect(calls).toHaveLength(0); // gh never spawned
    expect(showInfo).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(resolveRepo).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #564 slices 2/3 · SPEC-033 FR-3 — the full producible check set, symmetric
// (add missing checks to an existing ruleset — the sealbox gap).
// ─────────────────────────────────────────────────────────────────────────────

/** A ruleset detail JSON guarding the default branch with the given required contexts. */
function rulesetDetail(id: number, contexts: string[]): string {
  return JSON.stringify({
    id,
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: contexts.map((context) => ({ context })),
        },
      },
    ],
  });
}

describe('listRequiredCheckContexts — symmetric detection (which checks, not just "a ruleset exists")', () => {
  it('returns the ruleset id + its required contexts', async () => {
    const { run } = makeRunner((_c, args) => {
      const p = apiPath(args);
      if (p === 'repos/o/r/rulesets') return ok(JSON.stringify([{ id: 42, target: 'branch', enforcement: 'active' }]));
      if (p === 'repos/o/r/rulesets/42') return ok(rulesetDetail(42, ['MinSpec SDD validation']));
      return undefined;
    });
    expect(await listRequiredCheckContexts('o', 'r', run)).toEqual({
      rulesetId: 42,
      contexts: ['MinSpec SDD validation'],
    });
  });

  it('null when no branch ruleset guards checks', async () => {
    const { run } = makeRunner((_c, args) =>
      apiPath(args) === 'repos/o/r/rulesets' ? ok('[]') : undefined,
    );
    expect(await listRequiredCheckContexts('o', 'r', run)).toBeNull();
  });

  it('null on a read failure (never suppress provisioning)', async () => {
    const { run } = makeRunner(() => fail(1, 'boom'));
    expect(await listRequiredCheckContexts('o', 'r', run)).toBeNull();
  });
});

describe('probeReviewerConfigured — Tier-A producibility (no #559 deadlock)', () => {
  const secrets = (names: string[]) =>
    makeRunner((_c, args) =>
      apiPath(args) === 'repos/o/r/actions/secrets' ? ok(JSON.stringify(names)) : undefined,
    ).run;

  it('true only when ALL THREE reviewer secrets are set', async () => {
    expect(
      await probeReviewerConfigured(
        'o',
        'r',
        secrets(['CLAUDE_CODE_OAUTH_TOKEN', 'MINSPEC_APP_ID', 'MINSPEC_APP_PRIVATE_KEY']),
      ),
    ).toBe(true);
  });

  // ── #559 DEADLOCK REGRESSION (T3) ──────────────────────────────────────────
  // The earlier probe checked only 2 of the 3 secrets the ai-review.yml guard
  // requires — so a repo with OAUTH + APP_ID but NO APP_PRIVATE_KEY read as
  // "configured", `ai-review` was made a REQUIRED check, yet the workflow's own
  // guard skipped and never posted it → every merge permanently blocked (#559).
  // This case FAILS on the 2-of-3 logic (it returned true) and PASSES on the fix.
  it('false when MINSPEC_APP_PRIVATE_KEY is missing (only OAUTH + APP_ID set) — #559 deadlock regression', async () => {
    expect(
      await probeReviewerConfigured('o', 'r', secrets(['CLAUDE_CODE_OAUTH_TOKEN', 'MINSPEC_APP_ID'])),
    ).toBe(false);
  });

  it('false when the inference token (CLAUDE_CODE_OAUTH_TOKEN) is missing', async () => {
    expect(
      await probeReviewerConfigured('o', 'r', secrets(['MINSPEC_APP_ID', 'MINSPEC_APP_PRIVATE_KEY'])),
    ).toBe(false);
  });

  it('false when the App id (MINSPEC_APP_ID) is missing', async () => {
    expect(
      await probeReviewerConfigured('o', 'r', secrets(['CLAUDE_CODE_OAUTH_TOKEN', 'MINSPEC_APP_PRIVATE_KEY'])),
    ).toBe(false);
  });

  it('the probe set equals the ai-review.yml guard set (REVIEWER_SECRETS is the single source of truth)', async () => {
    // If every REVIEWER_SECRETS name is present the probe is true; dropping any one
    // flips it to false — so the probe can never drift below the workflow's guard.
    expect(await probeReviewerConfigured('o', 'r', secrets([...REVIEWER_SECRETS]))).toBe(true);
    for (const omit of REVIEWER_SECRETS) {
      const partial = REVIEWER_SECRETS.filter((n) => n !== omit);
      expect(await probeReviewerConfigured('o', 'r', secrets([...partial]))).toBe(false);
    }
  });

  it('false (fail-safe) on a read failure', async () => {
    const { run } = makeRunner(() => fail(1, 'nope'));
    expect(await probeReviewerConfigured('o', 'r', run)).toBe(false);
  });
});

describe('updateRulesetRequiredChecks — add missing checks to an existing ruleset', () => {
  function runner(getReply: Reply, putOk = true) {
    return makeRunner((_c, args) => {
      const isPut = args.includes('PUT');
      if (args.includes('repos/o/r/rulesets/42') && !isPut) return getReply;
      if (args.includes('repos/o/r/rulesets/42') && isPut) return putOk ? ok('{}') : fail(403, 'must have admin');
      return undefined;
    });
  }

  it('PUTs the union — adds the missing checks, preserves the existing one', async () => {
    const { run, calls } = runner(ok(rulesetDetail(42, ['MinSpec SDD validation'])));
    const out = await updateRulesetRequiredChecks('o', 'r', run, 42, ['ai-review', 'ready-to-merge']);
    expect(out.updated).toBe(true);
    const put = calls.find((c) => c.args.includes('PUT'));
    expect(put?.stdin).toContain('MinSpec SDD validation'); // preserved
    expect(put?.stdin).toContain('ai-review');
    expect(put?.stdin).toContain('ready-to-merge');
  });

  it('no-op (updated, no PUT) when all wanted checks are already required', async () => {
    const { run, calls } = runner(ok(rulesetDetail(42, ['MinSpec SDD validation', 'ai-review', 'ready-to-merge'])));
    const out = await updateRulesetRequiredChecks('o', 'r', run, 42, ['ai-review', 'ready-to-merge']);
    expect(out.updated).toBe(true);
    expect(calls.some((c) => c.args.includes('PUT'))).toBe(false); // nothing to write
  });

  it('reports forbidden on a 403 PUT', async () => {
    const { run } = runner(ok(rulesetDetail(42, ['MinSpec SDD validation'])), false);
    const out = await updateRulesetRequiredChecks('o', 'r', run, 42, ['ai-review']);
    expect(out.updated).toBe(false);
    expect(out.forbidden).toBe(true);
  });
});

// =============================================================================
// ENFORCE (#820): the required-check NAME constants are bound to the code that
// actually PRODUCES those checks — constitution: "don't trust the model to
// follow a rule — enforce it." (Template: reviewer-secrets-enforcement.test.ts.)
//
// The ruleset advisor asks a repo's branch ruleset to REQUIRE these contexts:
//   AI_REVIEW_CHECK      ('ai-review')      — the reviewer's own check-run
//   READY_TO_MERGE_CHECK ('ready-to-merge') — the merge-gate commit status
// If the producer that POSTS one of those contexts is renamed while the constant
// here is left stale (or vice-versa), the ruleset requires a context nothing ever
// posts → every PR is permanently blocked or admin-force-merged (the DEADLOCK→
// BYPASS class). The pre-existing Tier-A assertions (`toContain(AI_REVIEW_CHECK)`
// over a set BUILT from the same constant) are tautological — tied to no producer.
// These add the missing producer-anchored equalities, so a rename fails CI here.
//
// PRODUCERS bound:
//   1. AI_REVIEW_CHECK      ⟷ .github/scripts/ai-review-guard.js — the `.name`
//      field of the EXPORTED pure `decideReviewCheck()` (its private CHECK_NAME).
//   2. READY_TO_MERGE_CHECK ⟷ .github/workflows/ready-to-merge.yml — the
//      `context:` literal on its `createCommitStatus` calls (the SOLE writer of
//      that status).
// CONSUMER also bound: #820 named "A5 remediate-pr.sh" and assumed it absent — it
// is NOT. It lives in `scripts/` (not `.github/scripts/`) and hardcodes the
// `ai-review` check name in its jq `.name` rollup filters, so the same rename
// would silently strand it too; bind it while it exists.
//
// NOTE: ai-review.yml / guard.js also expose an `ai-review/pass` *status* context
// (PASS_STATUS_CONTEXT) — a DIFFERENT concern owned by #822. The ready-to-merge
// assertion excludes any `ai-review/*` context so it cannot be confused by it.
// =============================================================================

/** Walk up from cwd to the worktree root (the dir holding the real workflow). */
function findCheckNameRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.github/workflows/ready-to-merge.yml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate repo root (…/.github/workflows/ready-to-merge.yml)');
}

/**
 * The `ai-review` check name as PRODUCED by ai-review-guard.js. PREFER loading the
 * real module (so the binding tracks the shipped code): `decideReviewCheck()`
 * returns `{ name: CHECK_NAME, … }`, and CHECK_NAME is the private literal the
 * check-run is posted under. Fall back to text-parsing `const CHECK_NAME = '…'`
 * only if `require` cannot load the module for some reason.
 */
function producedAiReviewCheckName(root: string): string {
  const guardPath = path.resolve(root, '.github/scripts/ai-review-guard.js');
  try {
    const req = createRequire(import.meta.url);
    const guard = req(guardPath) as {
      decideReviewCheck: (label: string, isMachineryPr: boolean) => { name: string };
    };
    return guard.decideReviewCheck('ai-review:pass', false).name;
  } catch {
    const src = fs.readFileSync(guardPath, 'utf8');
    const m = src.match(/const\s+CHECK_NAME\s*=\s*['"]([^'"]+)['"]/);
    if (!m) throw new Error('could not load or parse CHECK_NAME from ai-review-guard.js');
    return m[1];
  }
}

/** Every DISTINCT commit-status `context:` string literal a workflow YAML posts. */
function commitStatusContexts(yaml: string): string[] {
  return [...new Set([...yaml.matchAll(/\bcontext:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))];
}

describe('ENFORCE: check-name constants bound to producers (#820)', () => {
  const root = findCheckNameRepoRoot();

  it('AI_REVIEW_CHECK ⟷ ai-review-guard.js decideReviewCheck().name (rename on either side ⇒ RED)', () => {
    // The reviewer posts its check-run under CHECK_NAME via decideReviewCheck();
    // the ruleset requires AI_REVIEW_CHECK. They MUST be the same string, or the
    // required context is never posted → every PR deadlocks.
    expect(producedAiReviewCheckName(root)).toBe(AI_REVIEW_CHECK);
  });

  it('READY_TO_MERGE_CHECK ⟷ ready-to-merge.yml `context:` (the sole writer of that status)', () => {
    const yaml = fs.readFileSync(
      path.join(root, '.github/workflows/ready-to-merge.yml'),
      'utf8',
    );
    const contexts = commitStatusContexts(yaml);
    // Exclude ai-review/* status contexts (#822's concern) so this is SPECIFIC to
    // the ready-to-merge gate. ready-to-merge.yml is the SINGLE writer of its
    // status, so after that exclusion it posts EXACTLY the one gate context —
    // which must equal the constant the ruleset requires.
    const gateContexts = contexts.filter((c) => !c.startsWith('ai-review/'));
    expect(gateContexts).toEqual([READY_TO_MERGE_CHECK]);
  });

  it('CONSUMER: remediate-pr.sh identifies the ai-review check by AI_REVIEW_CHECK', () => {
    // #820 called this "A5 remediate-pr.sh" and assumed it absent; it is not — it
    // lives in scripts/ (not .github/scripts/) and hardcodes the check name in its
    // jq `.name` rollup filters to route the reviewer's own check away from the
    // generic failing-checks path. A producer-side rename would silently strand
    // these filters, so bind them too.
    const remediatePath = path.resolve(root, 'scripts/remediate-pr.sh');
    if (!fs.existsSync(remediatePath)) return; // absent ⇒ only the 2 producers above apply
    const src = fs.readFileSync(remediatePath, 'utf8');
    const nameFilterLiterals = [
      ...src.matchAll(/\(\.name\s*\/\/\s*""\)\s*[=!]=\s*"([^"]+)"/g),
    ].map((m) => m[1]);
    // The script's purpose depends on singling out the reviewer's own check, so it
    // MUST contain at least one such filter; every one must name AI_REVIEW_CHECK.
    expect(nameFilterLiterals.length).toBeGreaterThan(0);
    for (const lit of new Set(nameFilterLiterals)) expect(lit).toBe(AI_REVIEW_CHECK);
  });
});

/**
 * The check-run name GitHub derives from each job in a workflow: the job's
 * explicit `name:` when present, otherwise the job key itself.
 *
 * Deliberately a small hand parser rather than a YAML dep — this test exists to
 * catch a rename, so it reads the same two tokens GitHub reads and nothing more.
 * Top-level job keys sit at 2 spaces under `jobs:`; a job-level `name:` at 4.
 */
function jobCheckRunNames(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) throw new Error('no top-level `jobs:` block found');
  const names: string[] = [];
  let jobKey: string | null = null;
  let explicit: string | null = null;
  const flush = () => {
    if (jobKey) names.push(explicit ?? jobKey);
    jobKey = null;
    explicit = null;
  };
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // dedent to column 0 ⇒ out of `jobs:`
    const key = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (key) {
      flush();
      jobKey = key[1];
      continue;
    }
    const name = line.match(/^ {4}name:\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
    if (name && jobKey && explicit === null) explicit = name[1];
  }
  flush();
  return names;
}

/**
 * The authoritative gate name(s) each workflow is responsible for. Note the two
 * gates publish through DIFFERENT channels and so declare their name in
 * different places: ready-to-merge posts a commit status whose `context:` is a
 * literal in the YAML, while ai-review posts a check-run whose name lives in
 * ai-review-guard.js. Read each from its real producer, never from a copy.
 */
const GATE_WORKFLOWS: ReadonlyArray<{
  file: string;
  gateNames: (yaml: string, root: string) => string[];
}> = [
  { file: 'ready-to-merge.yml', gateNames: (yaml) => commitStatusContexts(yaml) },
  { file: 'ai-review.yml', gateNames: (_yaml, root) => [producedAiReviewCheckName(root)] },
];

describe("INVARIANT: a gate workflow's job check-run never shadows its own gate name", () => {
  const root = findCheckNameRepoRoot();

  // Why this is a T0 and not a style nit: a required context is resolved BY NAME,
  // and GitHub counts every object carrying that name. When a job's implicit
  // "did it exit 0" check-run shares the name of the authoritative gate, the pair
  // fails closed only while BOTH exist. Lose the authoritative one — its posting
  // step is best-effort and permission-dependent, which is the #810 shape — and
  // the always-green job check-run satisfies the required context on its own. The
  // gate then passes with no verdict behind it, silently. Constitution invariant 2
  // requires a missing witness to fail closed, so these names must never collide.
  //
  // Measured on AIClarityAU/memory-fabric PR #13 and on this repo's PR #1799:
  // `ready-to-merge` appeared as BOTH a failing commit status and a passing job
  // check-run on the same head. Green for ai-review.yml (job key `runner`) and RED
  // for ready-to-merge.yml until that job was given a distinct `name:` — that
  // asymmetry is what proves this test is not vacuous.
  for (const { file, gateNames } of GATE_WORKFLOWS) {
    it(`${file}: no job check-run name collides with the gate it publishes`, () => {
      const yaml = fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8');
      const jobNames = jobCheckRunNames(yaml);
      const gates = gateNames(yaml, root);

      // Guard against a vacuous pass: if either side parses empty, the collision
      // check below would hold for the wrong reason.
      expect(jobNames.length).toBeGreaterThan(0);
      expect(gates.length).toBeGreaterThan(0);

      expect(jobNames.filter((n) => gates.includes(n))).toEqual([]);
    });
  }

  it('the ready-to-merge gate context is still posted by that workflow (rename did not move it)', () => {
    // The companion assertion. Making the names distinct must NOT be achieved by
    // renaming the status — that is the required branch-protection context, and
    // renaming it deadlocks `main` in every adopter repo that requires it.
    const yaml = fs.readFileSync(
      path.join(root, '.github/workflows/ready-to-merge.yml'),
      'utf8',
    );
    expect(commitStatusContexts(yaml)).toContain(READY_TO_MERGE_CHECK);
  });
});
