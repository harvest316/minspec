/**
 * Ruleset advisor (#356, reworked per DR-050 Amendment 2026-07-01).
 *
 * After `MinSpec: Initialize`, advise the user about a GitHub branch *ruleset*
 * that requires CI status checks (default `lint`, `test`) on the repo's default
 * branch.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * TIER-0 NETWORK BOUNDARY (load-bearing)
 * ──────────────────────────────────────────────────────────────────────────
 * MinSpec core "makes zero network calls in its core path." Every function in
 * this module that touches the network does so ONLY by shelling out to the
 * *user's own* authenticated `gh` CLI. MinSpec opens no socket itself — the same
 * posture by which it already shells `git`.
 *
 * Two distinct classes of network action live here, gated differently per
 * DR-050 (Amendment 2026-07-01):
 *
 *   - READ-ONLY CONFIG PROBE (autonomous) — {@link isGhReady} (probe the *local*
 *     `gh`) and {@link hasRequiredChecksRuleset} (a `gh api .../rulesets` GET of
 *     the repo's OWN settings). These egress NO user artifacts, spec content, or
 *     telemetry — they read the repo's own configuration, the same class as
 *     MinSpec shelling `git fetch`. They run AUTONOMOUSLY on init once `gh` is
 *     ready and the repo resolves; NO prior consent toast is required.
 *
 *   - MUTATING / EGRESSING ACTION (consent-gated) — {@link
 *     createRequiredChecksRuleset} (the `gh api -X POST .../rulesets` that WRITES
 *     a ruleset to the repo). This mutates the user's repository, so it fires
 *     ONLY on the user's explicit "Create ruleset" click — that click IS the
 *     consent for the mutation. Nothing writes autonomously.
 *
 * The ONLY toast shown is the single "create one?" offer — and only when the
 * autonomous probe finds NO qualifying ruleset. If one already exists the whole
 * flow is silent. The always-available fallback ({@link RULESET_DOCS_URL}) makes
 * zero network calls.
 *
 * Every MUTATING network action is consent-gated; the read-only probe is
 * autonomous. This is ratified by DR-050 (Amendment 2026-07-01).
 *
 * Purity / testability: the detection/creation functions never import
 * `child_process` at a call site — all process execution is funnelled through
 * an injected {@link CommandRunner}, so tests mock the runner and NEVER hit the
 * real network or create a real ruleset. The single sanctioned spawn point is
 * {@link defaultCommandRunner}, wired in only behind the post-init advisory.
 */

import { execFile } from 'child_process';

/** GitHub docs page on creating rulesets — the always-available, zero-network fallback. */
export const RULESET_DOCS_URL =
  'https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository';

/**
 * DEFAULT status-check contexts the created ruleset requires on the default
 * branch when the user has not overridden them.
 *
 * Deliberately `lint` + `test` only — the two checks the standard MinSpec CI
 * already reports on every repo. `ready-to-merge` is intentionally EXCLUDED: it
 * is asserted by MinSpec's reviewer only after it auto-labels a PR, so making it
 * a *required* status check at init time would block EVERY merge on a fresh repo
 * (no reviewer wired yet, no reviewer on a solo repo). Users who want it opt in
 * via the `minspec.ruleset.requiredChecks` setting (read at create time in
 * init.ts) — see {@link resolveRequiredChecks} there.
 */
export const DEFAULT_REQUIRED_CHECK_CONTEXTS: readonly string[] = ['lint', 'test'];

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
 * only ever wired in behind the post-init advisory (autonomous read-only probe;
 * consent-gated create).
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
 * This runs the user's own local `gh` (`gh --version`, then `gh auth status`) to
 * PROBE the local CLI's readiness — a read-only capability probe in the same
 * class as MinSpec shelling `git`. It egresses no user data and needs no consent
 * toast; it runs autonomously as the first step of the post-init advisory.
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
 * READ-ONLY CONFIG PROBE — a `gh api .../rulesets` GET of the repo's OWN
 * settings. It egresses no user artifacts, spec content, or telemetry (the same
 * class as `git fetch`), so per DR-050 (Amendment 2026-07-01) the caller runs it
 * AUTONOMOUSLY on init — no prior consent toast. Only the subsequent CREATE
 * (which mutates the repo) is consent-gated.
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
 * Normalise a caller-supplied list of check contexts down to a clean,
 * de-duplicated, non-empty `string[]`, falling back to
 * {@link DEFAULT_REQUIRED_CHECK_CONTEXTS} when the input is absent, not an
 * array, or empty-after-trimming. Pure — the single place that decides which
 * contexts end up in the payload, so the fallback is honoured whether the
 * config setting is unset, malformed, or blank.
 */
export function resolveCheckContexts(checks?: readonly string[]): string[] {
  if (!Array.isArray(checks)) return [...DEFAULT_REQUIRED_CHECK_CONTEXTS];
  const cleaned = Array.from(
    new Set(
      checks
        .filter((c): c is string => typeof c === 'string')
        .map((c) => c.trim())
        .filter((c) => c.length > 0),
    ),
  );
  return cleaned.length > 0 ? cleaned : [...DEFAULT_REQUIRED_CHECK_CONTEXTS];
}

/**
 * Build the POST body for a ruleset that requires the given status `checks`
 * (default {@link DEFAULT_REQUIRED_CHECK_CONTEXTS} — `lint` + `test`) on the
 * repo's default branch.
 *
 * The check set is configurable so a user can add e.g. `build` or the opt-in
 * `ready-to-merge` via the `minspec.ruleset.requiredChecks` setting without a
 * code change; the caller (init.ts) reads that setting and threads it through
 * here. `ready-to-merge` stays OUT of the default because it would block every
 * merge on a fresh repo until MinSpec's reviewer is wired and labelling (#350).
 *
 * Targets the default branch via the `~DEFAULT_BRANCH` ref sentinel, so the
 * payload is repo-agnostic (no need to resolve the branch name first).
 */
export function createRulesetPayload(checks?: readonly string[]): Record<string, unknown> {
  const contexts = resolveCheckContexts(checks);
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
          required_status_checks: contexts.map((context) => ({
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
 * shell-interpolate it. `checks` selects which status-check contexts the ruleset
 * requires (default {@link DEFAULT_REQUIRED_CHECK_CONTEXTS}).
 *
 * MUTATING network action — the caller MUST only invoke this on the user's
 * explicit "Create ruleset" click (that click IS the consent for the mutation;
 * see DR-050 Amendment 2026-07-01). On a 403 (token lacks repo-admin) we report
 * `forbidden: true` so the caller can fall back to the docs link rather than
 * surfacing a raw error.
 */
export async function createRequiredChecksRuleset(
  owner: string,
  repo: string,
  run: CommandRunner,
  checks?: readonly string[],
): Promise<CreateRulesetOutcome> {
  const body = JSON.stringify(createRulesetPayload(checks));
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
