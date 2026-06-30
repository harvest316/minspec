/**
 * T2/T1 — ruleset advisor (#356).
 *
 * Covers the contract cases from the issue:
 *   1. gh absent            → docs link, NO read/create network.
 *   2. gh present + exists   → "already configured", NO offer.
 *   3. gh present + none     → offer to create.
 *   4. create success        → success toast.
 *   5. create 403            → docs-link fallback.
 *
 * Plus the consent gate added by the security review: BOTH the `gh api` READ and
 * the create POST sit behind a single explicit "Set up" prompt. "Not now" /
 * "Learn more" / dismiss → ZERO `gh api` calls beyond the gh-readiness probe.
 *
 * The command runner is ALWAYS mocked — these tests NEVER hit the real network
 * and NEVER create a real ruleset. They also assert the Tier-0 boundary: with no
 * consent, ZERO `gh api` subcommands run; when `gh` is unavailable, ZERO `gh`
 * subcommands beyond the availability probe run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode (only what the advisory touches) ────────────────────────────

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  env: { openExternal: vi.fn() },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import {
  type CommandResult,
  type CommandRunner,
  RULESET_DOCS_URL,
  REQUIRED_CHECK_CONTEXTS,
  RULESET_NAME,
  createRulesetPayload,
  createRequiredChecksRuleset,
  hasRequiredChecksRuleset,
  isGhReady,
} from '../src/lib/ruleset-advisor';
import { offerRulesetAdvisory } from '../src/commands/init';

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

describe('createRulesetPayload()', () => {
  it('requires lint + test on the default branch and OMITS ready-to-merge', () => {
    const payload = createRulesetPayload() as {
      name: string;
      target: string;
      enforcement: string;
      conditions: { ref_name: { include: string[] } };
      rules: Array<{ type: string; parameters: { required_status_checks: Array<{ context: string }> } }>;
    };

    expect(payload.name).toBe(RULESET_NAME);
    expect(payload.target).toBe('branch');
    expect(payload.enforcement).toBe('active');
    expect(payload.conditions.ref_name.include).toContain('~DEFAULT_BRANCH');

    const rule = payload.rules.find((r) => r.type === 'required_status_checks');
    expect(rule).toBeDefined();
    const contexts = rule!.parameters.required_status_checks.map((c) => c.context);
    expect(contexts).toEqual([...REQUIRED_CHECK_CONTEXTS]);
    expect(contexts).toContain('lint');
    expect(contexts).toContain('test');
    // ready-to-merge would block every merge until the reviewer auto-labels —
    // it must NOT be a default required check.
    expect(contexts).not.toContain('ready-to-merge');
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
});

// =============================================================================
// Wired advisory: offerRulesetAdvisory() (the post-init UX)
// =============================================================================

describe('offerRulesetAdvisory() — Tier-0 gated post-init advisory (#356)', () => {
  const resolveRepo = vi.fn(async () => 'o/r');
  const openExternal = vi.fn();
  // Treat the folder as a repo so we exercise the gh path; the .git guard is
  // covered separately below.
  const isRepo = () => true;

  /** Default advisory deps with a scripted runner. */
  function deps(run: CommandRunner) {
    return { run, resolveRepo, openExternal, isRepo };
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

  it('CASE 2: gh present + consent + ruleset exists → "already" toast, NO offer, NO create', async () => {
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
    // User consents to the check.
    showInfo.mockResolvedValueOnce('Set up');

    await offerRulesetAdvisory('/ws', deps(run));

    // The first info call IS the consent prompt (3 action buttons).
    expect(String(showInfo.mock.calls[0][0])).toMatch(/can check \/ set up/i);
    expect(showInfo.mock.calls[0].slice(1)).toEqual(['Set up', 'Not now', 'Learn more']);
    // Two info messages total: the consent prompt + the "already configured"
    // confirmation (the latter carries no action buttons → not an offer).
    expect(showInfo).toHaveBeenCalledTimes(2);
    expect(showInfo.mock.calls[1].length).toBe(1);
    expect(String(showInfo.mock.calls[1][0])).toMatch(/already has a ruleset/i);
    // No POST was made.
    expect(calls.some((c) => c.args.includes('POST'))).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('CASE 3+4: gh present + consent + none → offer; on Create → POST + success toast', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      const p = apiPath(args);
      if (p === 'repos/o/r/rulesets' && !args.includes('POST')) return ok('[]');
      if (args.includes('POST')) return ok('{"id":7}');
      return undefined;
    });
    // User consents to the check, then accepts the create offer.
    showInfo.mockResolvedValueOnce('Set up').mockResolvedValueOnce('Create ruleset');

    await offerRulesetAdvisory('/ws', deps(run));

    // First info call is the consent prompt; second is the create offer (both
    // action buttons).
    expect(String(showInfo.mock.calls[0][0])).toMatch(/can check \/ set up/i);
    expect(String(showInfo.mock.calls[1][0])).toMatch(/no ruleset requiring/i);
    expect(showInfo.mock.calls[1].slice(1)).toEqual(['Create ruleset', 'View GitHub docs']);
    // A POST happened (create) and the success toast fired.
    expect(calls.some((c) => c.args.includes('POST'))).toBe(true);
    expect(showInfo).toHaveBeenCalledTimes(3);
    expect(String(showInfo.mock.calls[2][0])).toMatch(/created a ruleset/i);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('CASE 3 (declined): gh present + consent + none → offer; dismiss → no POST, no open', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      if (apiPath(args) === 'repos/o/r/rulesets' && !args.includes('POST')) return ok('[]');
      return undefined;
    });
    showInfo
      .mockResolvedValueOnce('Set up') // consent to the check
      .mockResolvedValueOnce(undefined); // dismiss the create offer

    await offerRulesetAdvisory('/ws', deps(run));

    // The READ ran (consent given) but no POST followed the dismissed offer.
    expect(calls.some((c) => apiPath(c.args) === 'repos/o/r/rulesets' && !c.args.includes('POST'))).toBe(true);
    expect(calls.some((c) => c.args.includes('POST'))).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('CASE 5: consent + create returns 403 → docs-link fallback', async () => {
    const { run } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      if (apiPath(args) === 'repos/o/r/rulesets' && !args.includes('POST')) return ok('[]');
      if (args.includes('POST')) return fail(1, 'HTTP 403: Resource not accessible');
      return undefined;
    });
    showInfo
      .mockResolvedValueOnce('Set up') // consent to the check
      .mockResolvedValueOnce('Create ruleset') // accept offer
      .mockResolvedValueOnce('View GitHub docs'); // click docs on the fallback toast

    await offerRulesetAdvisory('/ws', deps(run));

    // Fallback message (3rd info call) mentions the admin-scope reason and opens
    // the docs.
    expect(String(showInfo.mock.calls[2][0])).toMatch(/repo-admin scope/i);
    expect(openExternal).toHaveBeenCalledWith(RULESET_DOCS_URL);
  });

  it('gh ready but no GitHub remote → docs link, no read/create', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      return undefined;
    });
    resolveRepo.mockResolvedValueOnce(null);
    showInfo.mockResolvedValueOnce('View GitHub docs');

    await offerRulesetAdvisory('/ws', deps(run));

    expect(calls.some((c) => apiPath(c.args)?.startsWith('repos/'))).toBe(false);
    expect(openExternal).toHaveBeenCalledWith(RULESET_DOCS_URL);
  });

  it('CONSENT GATE: gh ready + repo resolves but "Not now" → ZERO gh api read/create', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      // Any `gh api` call here means the gate leaked — fail loudly.
      return undefined;
    });
    showInfo.mockResolvedValueOnce('Not now'); // declines at the consent gate

    await offerRulesetAdvisory('/ws', deps(run));

    // The consent prompt fired exactly once...
    expect(showInfo).toHaveBeenCalledTimes(1);
    expect(String(showInfo.mock.calls[0][0])).toMatch(/can check \/ set up/i);
    expect(showInfo.mock.calls[0].slice(1)).toEqual(['Set up', 'Not now', 'Learn more']);
    // ...and NOT A SINGLE `gh api` repos call ran — only the gh-readiness probe
    // (`gh --version`, `gh auth status`). This is the defect the review caught:
    // the READ must not fire without consent.
    expect(calls.every((c) => !isRepoApiCall(c.args))).toBe(true);
    expect(calls.map((c) => c.args[0])).toEqual(['--version', 'auth']);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('CONSENT GATE: "Learn more" → docs link, still ZERO gh api read/create', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      return undefined;
    });
    showInfo.mockResolvedValueOnce('Learn more');

    await offerRulesetAdvisory('/ws', deps(run));

    expect(openExternal).toHaveBeenCalledWith(RULESET_DOCS_URL);
    expect(calls.every((c) => !isRepoApiCall(c.args))).toBe(true);
  });

  it('CONSENT GATE: dismissed (Escape) → no docs link, ZERO gh api read/create', async () => {
    const { run, calls } = makeRunner((_c, args) => {
      if (args[0] === '--version') return ok('gh 2');
      if (args[0] === 'auth') return ok('ok');
      return undefined;
    });
    showInfo.mockResolvedValueOnce(undefined); // dismissed

    await offerRulesetAdvisory('/ws', deps(run));

    expect(openExternal).not.toHaveBeenCalled();
    expect(calls.every((c) => !isRepoApiCall(c.args))).toBe(true);
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

    // Treated like "no GitHub repo": docs link, NO consent prompt, NO `gh api`,
    // and crucially no consent prompt was even shown for a bad slug.
    expect(calls.every((c) => !isRepoApiCall(c.args))).toBe(true);
    expect(showInfo.mock.calls.every((c) => !/can check \/ set up/i.test(String(c[0])))).toBe(true);
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
