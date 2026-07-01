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
} from '../src/lib/ruleset-advisor';
import { offerRulesetAdvisory, resolveRequiredChecks } from '../src/commands/init';

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
            rules: [{ type: 'required_status_checks' }],
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
  it('requires lint + test on the default branch and OMITS ready-to-merge by default', () => {
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
    expect(contexts).toContain('lint');
    expect(contexts).toContain('test');
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
// Pure library: create
// =============================================================================

describe('createRequiredChecksRuleset()', () => {
  it('POSTs the payload over stdin and reports success on exit 0', async () => {
    const { run, calls } = makeRunner((_c, args) =>
      args.includes('POST') ? ok('{"id":1}') : undefined,
    );
    const outcome = await createRequiredChecksRuleset('o', 'r', run);
    expect(outcome).toEqual({ created: true, forbidden: false, detail: '' });

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
            rules: [{ type: 'required_status_checks' }],
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
            rules: [{ type: 'required_status_checks' }],
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

  it('CONFIGURABLE: with no injected checks the create reads the config setting', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      if (apiPath(args) === 'repos/o/r/rulesets' && !args.includes('POST')) return ok('[]');
      if (args.includes('POST')) return ok('{"id":7}');
      return undefined;
    });
    // The `minspec.ruleset.requiredChecks` setting adds `build`.
    mockConfigValue = ['lint', 'test', 'build'];
    showInfo.mockResolvedValueOnce('Create ruleset');

    // Omit deps.requiredChecks so resolveRequiredChecks() reads the config.
    await offerRulesetAdvisory('/ws', { run, resolveRepo, openExternal, isRepo });

    const post = calls.find((c) => c.args.includes('POST'))!;
    const body = JSON.parse(post.stdin!) as {
      rules: Array<{ type: string; parameters: { required_status_checks: Array<{ context: string }> } }>;
    };
    const rule = body.rules.find((r) => r.type === 'required_status_checks')!;
    expect(rule.parameters.required_status_checks.map((c) => c.context)).toEqual([
      'lint',
      'test',
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
