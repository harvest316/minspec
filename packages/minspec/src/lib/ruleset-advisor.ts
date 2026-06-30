/**
 * Ruleset advisor (#356).
 *
 * After `MinSpec: Initialize`, advise the user about a GitHub branch *ruleset*
 * that requires CI status checks (`lint`, `test`) on the repo's default branch.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * TIER-0 NETWORK BOUNDARY (load-bearing)
 * ──────────────────────────────────────────────────────────────────────────
 * MinSpec core "makes zero network calls in its core path." Every function in
 * this module that touches the network does so ONLY by shelling out to the
 * *user's own* authenticated `gh` CLI, and ONLY behind explicit user opt-in
 * wired up by the caller (see init.ts). MinSpec opens no socket itself — the
 * same posture by which it already shells `git`. The ONLY always-on path is the
 * zero-network docs link ({@link RULESET_DOCS_URL}). The two `gh api` network
 * actions — the rulesets READ ({@link hasRequiredChecksRuleset}) and the create
 * POST ({@link createRequiredChecksRuleset}) — BOTH sit behind a SINGLE explicit
 * "Set up" consent prompt the caller shows first; neither runs until the user
 * opts in. (Detecting `gh` readiness via {@link isGhReady} shells the user's
 * `gh` to *probe* the local CLI, the same way MinSpec probes `git`; the consent
 * gate guards the network read of the user's *repository*.) The exact Tier-0
 * interpretation is to be ratified by a DR (#356).
 *
 * Purity / testability: the detection/creation functions never import
 * `child_process` at a call site — all process execution is funnelled through
 * an injected {@link CommandRunner}, so tests mock the runner and NEVER hit the
 * real network or create a real ruleset. The single sanctioned spawn point is
 * {@link defaultCommandRunner}, wired in only behind the opt-in advisory.
 */

import { execFile } from 'child_process';

/** GitHub docs page on creating rulesets — the always-available, zero-network fallback. */
export const RULESET_DOCS_URL =
  'https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository';

/** Status-check contexts the created ruleset requires on the default branch. */
export const REQUIRED_CHECK_CONTEXTS: readonly string[] = ['lint', 'test'];

/** Default ruleset name MinSpec proposes. */
export const RULESET_NAME = 'MinSpec required status checks';

/** Result of running a command via the injected runner. */
export interface CommandResult {
  /** Process exit code (0 = success). */
  code: number;
  /** Captured stdout (UTF-8). */
  stdout: string;
  /** Captured stderr (UTF-8). */
  stderr: string;
}

/**
 * Injected command runner. Implementations execute `cmd` with `args` (writing
 * `stdin`, when given, to the process's standard input) and resolve with the
 * captured result. A runner MUST NOT throw on a non-zero exit — it reports the
 * exit code in {@link CommandResult.code}. It MAY reject only when the binary
 * cannot be spawned at all (e.g. `gh` not on PATH); callers here treat a
 * rejection the same as "unavailable".
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  stdin?: string,
) => Promise<CommandResult>;

/**
 * Default {@link CommandRunner} — shells out via `child_process.execFile`.
 *
 * Kept here (a `lib/` module, allowlisted for `child_process` under the Tier-0
 * invariant) and NOT at the call sites: the detection/creation functions above
 * are pure and take an injected runner, so they never import `child_process`
 * directly. This factory is the single sanctioned process-spawn point and is
 * only ever wired in behind the explicit, opt-in post-init advisory.
 *
 * Captures stdout/stderr and the exit code WITHOUT throwing on a non-zero exit
 * (so callers branch on the code), optionally writes `stdin` to the process,
 * and rejects ONLY when the binary cannot be spawned at all (so callers treat
 * a missing `gh` as "unavailable").
 */
export function defaultCommandRunner(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout: 15000, env: { ...process.env }, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        // Default encoding → string stdout/stderr.
        const out = stdout ?? '';
        const errOut = stderr ?? '';
        if (err) {
          // A real exit-code failure carries a numeric `code`; a spawn failure
          // (binary missing) does not — reject only the latter.
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          if (typeof code === 'number') {
            resolve({ code, stdout: out, stderr: errOut });
            return;
          }
          reject(err);
          return;
        }
        resolve({ code: 0, stdout: out, stderr: errOut });
      },
    );
    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin);
    }
  });
}

/** Run the runner, normalising a spawn rejection into a non-zero result. */
async function runSafe(
  run: CommandRunner,
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<CommandResult> {
  try {
    return await run(cmd, args, stdin);
  } catch (err) {
    return { code: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Detect whether the `gh` CLI is BOTH installed AND authenticated.
 *
 * `gh --version` proves the binary exists; `gh auth status` proves there is a
 * usable token. Both must pass — an installed-but-unauthed `gh` cannot read or
 * write rulesets, so for our purposes it is "unavailable" and we fall back to
 * the zero-network docs link.
 *
 * This itself runs the user's `gh` (which may probe github.com for auth), so it
 * too is gated by the caller behind the post-init advisory — it is never on a
 * core path that runs unconditionally.
 */
export async function isGhReady(run: CommandRunner): Promise<boolean> {
  const version = await runSafe(run, 'gh', ['--version']);
  if (version.code !== 0) return false;
  const auth = await runSafe(run, 'gh', ['auth', 'status']);
  return auth.code === 0;
}

/**
 * Read the repo's rulesets and report whether one already enforces required
 * status checks on the DEFAULT branch.
 *
 * Strategy: `gh api repos/{owner}/{repo}/rulesets` lists rulesets but does not
 * inline their rules, so for each `active` ruleset whose `target` is `branch`
 * we fetch its detail (`.../rulesets/{id}`) and check that it BOTH
 *   (a) targets the default branch — its `conditions.ref_name.include` contains
 *       the `~DEFAULT_BRANCH` sentinel (or an explicit `refs/heads/...` entry,
 *       which we accept as "targets a branch"), AND
 *   (b) has a `required_status_checks` rule.
 *
 * Returns `false` (offer to create) on ANY read/parse failure or non-zero exit
 * — we never want a flaky read to suppress the advisory, and a wrong "already
 * configured" is the worse error (it would silently leave the repo unprotected).
 *
 * Network read of the user's repository — the caller MUST only invoke this after
 * explicit user consent ("Set up"); it is never reached on a path the user has
 * not opted into.
 *
 * @returns whether a qualifying ruleset already exists.
 */
export async function hasRequiredChecksRuleset(
  owner: string,
  repo: string,
  run: CommandRunner,
): Promise<boolean> {
  const list = await runSafe(run, 'gh', [
    'api',
    `repos/${owner}/${repo}/rulesets`,
  ]);
  if (list.code !== 0) return false;

  let rulesets: Array<{ id?: number; target?: string; enforcement?: string }>;
  try {
    const parsed = JSON.parse(list.stdout);
    if (!Array.isArray(parsed)) return false;
    rulesets = parsed;
  } catch {
    return false;
  }

  for (const rs of rulesets) {
    if (rs.target !== 'branch') continue;
    if (rs.enforcement === 'disabled') continue;
    if (typeof rs.id !== 'number') continue;

    const detail = await runSafe(run, 'gh', [
      'api',
      `repos/${owner}/${repo}/rulesets/${rs.id}`,
    ]);
    if (detail.code !== 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(detail.stdout);
    } catch {
      continue;
    }
    if (rulesetGuardsDefaultBranchChecks(parsed)) return true;
  }

  return false;
}

/** Shape of the bits of a ruleset detail we inspect. */
interface RulesetDetail {
  conditions?: {
    ref_name?: {
      include?: unknown;
    };
  };
  rules?: Array<{ type?: string }>;
}

/**
 * Does this ruleset detail BOTH target a branch (default-branch sentinel or any
 * `refs/heads/*` include) AND carry a `required_status_checks` rule? Pure;
 * tolerant of partial / unexpected JSON.
 */
function rulesetGuardsDefaultBranchChecks(detail: unknown): boolean {
  if (typeof detail !== 'object' || detail === null) return false;
  const d = detail as RulesetDetail;

  const include = d.conditions?.ref_name?.include;
  if (!Array.isArray(include)) return false;
  const targetsBranch = include.some(
    (ref) =>
      ref === '~DEFAULT_BRANCH' ||
      ref === '~ALL' ||
      (typeof ref === 'string' && ref.startsWith('refs/heads/')),
  );
  if (!targetsBranch) return false;

  const rules = d.rules;
  if (!Array.isArray(rules)) return false;
  return rules.some((r) => r?.type === 'required_status_checks');
}

/**
 * Build the POST body for a ruleset that requires the `lint` and `test` status
 * checks on the repo's default branch.
 *
 * Intentionally does NOT require the `ready-to-merge` check by default. That
 * check is asserted by MinSpec's reviewer only after it auto-labels a PR with
 * `ai-review:pass`; making it a *required* status check at init time would
 * block EVERY merge until that reviewer pipeline is wired and labelling — a
 * footgun for a repo that just ran init. So we ship the two checks every repo
 * already has from the standard CI (lint + test) and leave `ready-to-merge` to
 * be added deliberately once the reviewer is live (#350).
 *
 * Targets the default branch via the `~DEFAULT_BRANCH` ref sentinel, so the
 * payload is repo-agnostic (no need to resolve the branch name first).
 */
export function createRulesetPayload(): Record<string, unknown> {
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: {
        include: ['~DEFAULT_BRANCH'],
        exclude: [],
      },
    },
    rules: [
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: REQUIRED_CHECK_CONTEXTS.map((context) => ({
            context,
            // No integration_id pin — match the check by context name from any
            // app/runner (the standard GitHub Actions CI reports these).
          })),
        },
      },
    ],
  };
}

/** Outcome of an attempt to create the ruleset via `gh`. */
export interface CreateRulesetOutcome {
  /** Whether the POST succeeded (HTTP 2xx / exit 0). */
  created: boolean;
  /** True when the failure was an authorization problem (403 / missing admin scope). */
  forbidden: boolean;
  /** Captured stderr for diagnostics (empty on success). */
  detail: string;
}

/**
 * Create the ruleset by POSTing {@link createRulesetPayload} through the user's
 * `gh`. The JSON body is streamed to `gh api --input -` over stdin so we never
 * shell-interpolate it.
 *
 * Network write — caller MUST only invoke this after explicit user consent. On
 * a 403 (token lacks repo-admin) we report `forbidden: true` so the caller can
 * fall back to the docs link rather than surfacing a raw error.
 */
export async function createRequiredChecksRuleset(
  owner: string,
  repo: string,
  run: CommandRunner,
): Promise<CreateRulesetOutcome> {
  const body = JSON.stringify(createRulesetPayload());
  // Stream the JSON body over stdin (`--input -`) so it is never
  // shell-interpolated into the argv.
  const result = await runSafe(
    run,
    'gh',
    ['api', '-X', 'POST', `repos/${owner}/${repo}/rulesets`, '--input', '-'],
    body,
  );

  if (result.code === 0) {
    return { created: true, forbidden: false, detail: '' };
  }

  const haystack = `${result.stdout}\n${result.stderr}`;
  const forbidden =
    /\b403\b/.test(haystack) ||
    /forbidden/i.test(haystack) ||
    /must have admin/i.test(haystack) ||
    /resource not accessible/i.test(haystack);

  return { created: false, forbidden, detail: result.stderr || result.stdout };
}
