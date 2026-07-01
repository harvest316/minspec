import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { scaffold, generateHarnessFiles, refreshHarnessFiles } from '../lib/scaffold';
import { TEMPLATE_NAMES, TEMPLATE_OUTPUT_PATHS } from '../lib/template-registry';
import { resolveTargetFolder } from '../lib/resolve-folder';
import { evaluateConstitution } from '../lib/constitution-nudge';
import { getRepoFromRemote } from '../lib/github';
import {
  type CommandRunner,
  RULESET_DOCS_URL,
  DEFAULT_REQUIRED_CHECK_CONTEXTS,
  createRequiredChecksRuleset,
  defaultCommandRunner,
  hasRequiredChecksRuleset,
  isGhReady,
  resolveCheckContexts,
} from '../lib/ruleset-advisor';

/**
 * SPEC-025 FR-6: soft, NON-MODAL advisory when the constitution has no
 * human-authored rules yet. Advisory only — never modal, never blocks, and a
 * failure here must not affect the init result (best-effort).
 */
function surfaceConstitutionNudge(folder: string): void {
  try {
    const nudge = evaluateConstitution(folder);
    if (nudge.empty) {
      vscode.window.showInformationMessage(nudge.message);
    }
  } catch {
    // best-effort — the nudge is advisory; never let it break init.
  }
}

// ---------------------------------------------------------------------------
// Post-init "what to commit" hint + offer (#222)
// ---------------------------------------------------------------------------

/** Dedicated commit message for the scaffolded SDD structure. */
export const SCAFFOLD_COMMIT_MESSAGE = 'chore: scaffold MinSpec SDD structure';

/** Toast action label that triggers the dedicated scaffold commit. */
const COMMIT_ACTION = 'Commit them';

/**
 * Top-level paths MinSpec init is responsible for scaffolding. These are
 * pathspecs (relative to the project root) that `git add` can stage directly.
 * Directories are staged whole; git honors .gitignore for directory adds, so
 * the ephemeral `.minspec/session.json` / `calibration.json` are never staged.
 *
 * The harness output paths come from the template registry (CLAUDE.md,
 * AGENTS.md, .cursorrules, DESIGN.md, .minspec/constitution.md), plus the
 * `.minspec/` dir itself, `.gitignore` (init appends the ephemeral entries),
 * and the Spec Kit slash-command shim dirs (created only when a matching AI
 * tool is detected).
 */
const SCAFFOLD_PATHSPECS: readonly string[] = [
  '.minspec',
  '.gitignore',
  '.claude/commands',
  '.cursor/rules',
  // Harness files rendered at the project root.
  ...TEMPLATE_NAMES.map((name) => TEMPLATE_OUTPUT_PATHS[name]),
];

/**
 * Of the paths MinSpec scaffolds, the subset that actually exists on disk in
 * `folder`. Pure (no git, no toast) so it is unit-testable and so we never ask
 * git to stage a pathspec that isn't there.
 */
export function collectScaffoldPaths(folder: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rel of SCAFFOLD_PATHSPECS) {
    if (seen.has(rel)) continue;
    if (fs.existsSync(path.join(folder, rel))) {
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

/**
 * The minimal git surface the commit-offer needs. Defined as an interface so
 * tests can inject a stub instead of shelling out to a real repository.
 */
export interface ScaffoldCommitter {
  /** Whether `folder` is inside a git working tree. */
  isRepo(): Promise<boolean>;
  /** Stage exactly the given pathspecs. */
  add(paths: readonly string[]): Promise<void>;
  /** Create a single commit with `message` (staged content only). */
  commit(message: string): Promise<void>;
}

/** Default committer — wraps simple-git, lazily imported to keep init lean. */
async function defaultCommitter(folder: string): Promise<ScaffoldCommitter> {
  const { simpleGit } = await import('simple-git');
  const git = simpleGit(folder);
  return {
    async isRepo() {
      try {
        return (await git.revparse(['--is-inside-work-tree'])).trim() === 'true';
      } catch {
        return false;
      }
    },
    async add(paths) {
      await git.add([...paths]);
    },
    async commit(message) {
      await git.commit(message);
    },
  };
}

/** Dependencies for {@link offerScaffoldCommit}, injectable for tests. */
export interface OfferScaffoldCommitDeps {
  /** Build the git committer for the folder. */
  makeCommitter?: (folder: string) => Promise<ScaffoldCommitter>;
}

/**
 * After init, surface a NON-MODAL toast that summarizes the scaffolded files
 * and OFFERS to commit them in a single dedicated commit (#222). Accept →
 * stages exactly the scaffolded paths and makes ONE commit. Decline / dismiss
 * → no-op. Keyboard-friendly (a plain notification action) and best-effort:
 * any failure is surfaced as a warning but never breaks the init result.
 *
 * Skips silently when the folder is not a git repository (nothing to commit
 * into) or when no scaffolded paths exist on disk.
 */
export async function offerScaffoldCommit(
  folder: string,
  deps: OfferScaffoldCommitDeps = {},
): Promise<void> {
  // Cheap guard: no `.git` → not a repo → nothing to offer. Avoids shelling out
  // to git at all (and keeps non-repo init flows toast-free).
  if (!fs.existsSync(path.join(folder, '.git'))) return;

  const paths = collectScaffoldPaths(folder);
  if (paths.length === 0) return;

  let committer: ScaffoldCommitter;
  try {
    const make = deps.makeCommitter ?? defaultCommitter;
    committer = await make(folder);
    if (!(await committer.isRepo())) return;
  } catch {
    // If we can't even build/probe the committer, stay silent — the offer is
    // advisory and must never break init.
    return;
  }

  const summary = paths.join(', ');
  const choice = await vscode.window.showInformationMessage(
    `MinSpec scaffolded: ${summary}. Commit them now in a dedicated commit?`,
    COMMIT_ACTION,
  );
  if (choice !== COMMIT_ACTION) return; // decline / dismiss → no-op

  try {
    await committer.add(paths);
    await committer.commit(SCAFFOLD_COMMIT_MESSAGE);
    vscode.window.showInformationMessage(
      `MinSpec: committed the scaffolded SDD structure ("${SCAFFOLD_COMMIT_MESSAGE}").`,
    );
  } catch (err) {
    vscode.window.showWarningMessage(
      `MinSpec: could not commit the scaffolded files — ${describeError(err)}. ` +
        'They remain staged/unstaged for you to commit manually.',
    );
  }
}

// ---------------------------------------------------------------------------
// Post-init branch-ruleset advisory (#356)
// ---------------------------------------------------------------------------

/** Toast action: open the GitHub rulesets docs page (zero-network-path fallback). */
const RULESET_DOCS_ACTION = 'View GitHub docs';
/**
 * Create-offer action: WRITE the ruleset via the user's `gh` (the MUTATING
 * action). This click IS the consent for the mutation (DR-050 Amendment
 * 2026-07-01) — the create fires only when the user picks it.
 */
const RULESET_CREATE_ACTION = 'Create ruleset';
/** Create-offer action: decline — make no `gh api` write. */
const RULESET_DECLINE_ACTION = 'Not now';
/** Create-offer action: open the rulesets docs instead of creating. */
const RULESET_LEARN_MORE_ACTION = 'Learn more';

/**
 * Pattern a resolved `owner/repo` slug MUST match before it is interpolated into
 * a `gh api repos/{owner}/{repo}/...` path. Defense-in-depth: `getRepoFromRemote`
 * already extracts these from a `github.com[:/]<owner>/<repo>` match (so they
 * cannot today contain a slash or path-traversal segment), but asserting the
 * charset locally — right where the value reaches `gh` — keeps the safety
 * property co-located with its use rather than relying on a distant regex.
 */
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * VS Code setting id for the configurable required-status-check contexts the
 * created ruleset enforces. Read at create time; unset → the default
 * ({@link DEFAULT_REQUIRED_CHECK_CONTEXTS}). Users add e.g. `build` or the
 * opt-in `ready-to-merge` here without a code change.
 */
const REQUIRED_CHECKS_SETTING = 'minspec.ruleset.requiredChecks';

/** Dependencies for {@link offerRulesetAdvisory}, injectable for tests. */
export interface RulesetAdvisoryDeps {
  /** Command runner used for all `gh` invocations. */
  run?: CommandRunner;
  /** Resolve `owner/repo` from the folder's git remote. */
  resolveRepo?: (folder: string) => Promise<string | null>;
  /** Open an external URL (defaults to VS Code's opener). */
  openExternal?: (url: string) => void;
  /**
   * Whether `folder` is a git working tree. Defaults to a cheap `.git`
   * existence check — same guard {@link offerScaffoldCommit} uses to stay
   * toast-free (and gh-free) on non-repo init flows.
   */
  isRepo?: (folder: string) => boolean;
  /**
   * The status-check contexts the CREATED ruleset should require. Defaults to
   * reading the `minspec.ruleset.requiredChecks` setting (see
   * {@link resolveRequiredChecks}); falls back to
   * {@link DEFAULT_REQUIRED_CHECK_CONTEXTS} when unset/malformed. Injectable so
   * tests can assert the configured set is honoured without touching VS Code
   * config.
   */
  requiredChecks?: readonly string[];
}

/**
 * Resolve the required-status-check contexts for the created ruleset from the
 * `minspec.ruleset.requiredChecks` setting, falling back to
 * {@link DEFAULT_REQUIRED_CHECK_CONTEXTS} when the setting is unset, not an
 * array, or empty. The final normalisation (dedupe / trim / non-empty fallback)
 * is done by {@link resolveCheckContexts} in the pure lib, so an unset setting
 * and a blank one both land on the default. Best-effort: any config read failure
 * degrades to the default.
 */
export function resolveRequiredChecks(): string[] {
  let configured: unknown;
  try {
    configured = vscode.workspace
      .getConfiguration()
      .get<unknown>(REQUIRED_CHECKS_SETTING);
  } catch {
    configured = undefined;
  }
  return resolveCheckContexts(
    Array.isArray(configured) ? (configured as readonly string[]) : undefined,
  );
}

/** Show an info toast linking the rulesets docs, with a one-click open action. */
async function linkRulesetDocs(
  message: string,
  openExternal: (url: string) => void,
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(message, RULESET_DOCS_ACTION);
  if (choice === RULESET_DOCS_ACTION) openExternal(RULESET_DOCS_URL);
}

/**
 * NON-BLOCKING post-init advisory (#356, reworked per DR-050 Amendment
 * 2026-07-01): nudge the user toward a branch ruleset that requires CI status
 * checks on the default branch — but only surface a toast when there is
 * something for the user to DO.
 *
 * Network discipline (Tier-0 boundary, per DR-050 Amendment 2026-07-01): the
 * READ-ONLY CONFIG PROBE runs AUTONOMOUSLY; only the MUTATING create is
 * consent-gated.
 *   - not a git repo → return (zero process, zero toast).
 *   - `gh` missing/unauthed → info toast linking the docs. Zero `gh api`. Done.
 *   - `gh` ready + no GitHub remote (or a malformed slug) → docs link. Zero
 *     `gh api`. Done.
 *   - `gh` ready + repo resolves → AUTO-PROBE (read-only `gh api .../rulesets`
 *     GET of the repo's OWN settings, no consent toast):
 *       - a qualifying ruleset ALREADY EXISTS → SILENT. No toast at all.
 *       - NONE found → exactly ONE toast offering to create one:
 *         [Create ruleset] [Not now] [Learn more].
 *           - "Create ruleset" → POST via gh (this click IS the consent for the
 *             mutation). success → toast; 403/error → docs link.
 *           - "Not now"/dismiss → nothing.
 *           - "Learn more"     → open the rulesets docs.
 *
 * Why the probe is autonomous: `isGhReady` and `hasRequiredChecksRuleset` are a
 * read-only capability probe + a GET of the repo's OWN configuration — they
 * egress no user artifacts, spec content, or telemetry (the same class as
 * MinSpec shelling `git fetch`). Per DR-050 they need no prior consent toast.
 * Only the CREATE mutates the repo, so it is the one action gated on an explicit
 * click.
 *
 * The created ruleset's required checks come from
 * {@link resolveRequiredChecks} (the `minspec.ruleset.requiredChecks` setting,
 * default {@link DEFAULT_REQUIRED_CHECK_CONTEXTS}); `deps.requiredChecks`
 * overrides it for tests.
 *
 * Best-effort: any failure is swallowed (at worst the docs link), and never
 * affects the init result.
 */
export async function offerRulesetAdvisory(
  folder: string,
  deps: RulesetAdvisoryDeps = {},
): Promise<void> {
  const run = deps.run ?? defaultCommandRunner;
  const resolveRepo = deps.resolveRepo ?? getRepoFromRemote;
  const openExternal = deps.openExternal ?? ((url: string) => vscode.env.openExternal(vscode.Uri.parse(url)));
  const isRepo = deps.isRepo ?? ((f: string) => fs.existsSync(path.join(f, '.git')));

  // Cheap guard: not a git repo → no remote, no ruleset to advise about. Return
  // before probing gh at all (mirrors offerScaffoldCommit) so non-repo init
  // flows stay both toast-free AND zero-process.
  if (!isRepo(folder)) return;

  try {
    // gh unavailable/unauthed → zero-network docs link. Done.
    if (!(await isGhReady(run))) {
      await linkRulesetDocs(
        'MinSpec: protect your default branch with a ruleset that requires CI ' +
          `(${DEFAULT_REQUIRED_CHECK_CONTEXTS.join(', ')}) status checks. ` +
          'Install/authenticate the `gh` CLI to let MinSpec offer to create one, or see the GitHub docs.',
        openExternal,
      );
      return;
    }

    const repo = await resolveRepo(folder);
    if (!repo) {
      // gh is ready but we cannot identify the GitHub repo (no github.com
      // remote). Nothing to probe or create against → docs link only.
      await linkRulesetDocs(
        'MinSpec: to require CI status checks on your default branch, add a ' +
          'GitHub remote, then create a branch ruleset — see the GitHub docs.',
        openExternal,
      );
      return;
    }
    // Defense-in-depth: the resolved slug is about to be interpolated into a
    // `gh api repos/{owner}/{repo}/...` path. Assert its charset here, right
    // where it reaches `gh`, before any network read. A slug that fails this is
    // treated like "no GitHub repo" → docs link, zero `gh api`.
    if (!REPO_SLUG_RE.test(repo)) {
      await linkRulesetDocs(
        'MinSpec: to require CI status checks on your default branch, add a ' +
          'GitHub remote, then create a branch ruleset — see the GitHub docs.',
        openExternal,
      );
      return;
    }
    const [owner, name] = repo.split('/');

    // AUTO-PROBE (read-only config GET) — runs autonomously, NO consent toast.
    // A GET of the repo's OWN rulesets egresses no user data (same class as
    // `git fetch`); per DR-050 Amendment 2026-07-01 no prior opt-in is required.
    // A qualifying ruleset already protects the default branch → SILENT (there
    // is nothing for the user to do, so we show no toast at all).
    if (await hasRequiredChecksRuleset(owner, name, run)) {
      return;
    }

    // None found → exactly ONE toast: offer to create. This is the ONLY toast
    // in the happy path, and it is the consent gate for the MUTATING create.
    const requiredChecks = deps.requiredChecks ?? resolveRequiredChecks();
    const choice = await vscode.window.showInformationMessage(
      `MinSpec: ${repo} has no branch ruleset requiring CI checks ` +
        `(${requiredChecks.join(' + ')}) on its default branch. Create one?`,
      RULESET_CREATE_ACTION,
      RULESET_DECLINE_ACTION,
      RULESET_LEARN_MORE_ACTION,
    );

    if (choice === RULESET_CREATE_ACTION) {
      // CREATE (MUTATING network) — reached ONLY on the explicit "Create
      // ruleset" click; that click IS the consent for the mutation (DR-050).
      const outcome = await createRequiredChecksRuleset(owner, name, run, requiredChecks);
      if (outcome.created) {
        vscode.window.showInformationMessage(
          `MinSpec: created a ruleset requiring ${requiredChecks.join(' + ')} on ${repo}'s default branch.`,
        );
        return;
      }
      // 403 (no admin scope) or any other error → fall back to the docs link.
      const why = outcome.forbidden
        ? 'your gh token lacks repo-admin scope'
        : 'the request failed';
      await linkRulesetDocs(
        `MinSpec: could not create the ruleset (${why}). Create it manually — see the GitHub docs.`,
        openExternal,
      );
      return;
    }

    // "Learn more" → open the rulesets docs. "Not now"/dismiss → nothing (no
    // further network).
    if (choice === RULESET_LEARN_MORE_ACTION) openExternal(RULESET_DOCS_URL);
  } catch {
    // Advisory only — never let a ruleset-advisory failure break init.
  }
}

export async function initCommand(
  folderArg?: string,
  deps?: OfferScaffoldCommitDeps & { ruleset?: RulesetAdvisoryDeps },
): Promise<void> {
  const folder = folderArg ?? (await resolveTargetFolder());
  if (!folder) return;
  // The scaffold + harness writes are a multi-file synchronous sequence. If one
  // write fails partway, the project is left with a partial .minspec/ (and the
  // drift detector then reports false drift). Catch any failure, surface exactly
  // what went wrong, and do NOT report a misleading "Initialized" success (#153).
  try {
    scaffold(folder);
    generateHarnessFiles(folder);
  } catch (err) {
    vscode.window.showErrorMessage(
      `MinSpec: Initialization failed — ${describeError(err)}. ` +
        'The .minspec/ folder may be incomplete; resolve the error and re-run.',
    );
    return;
  }
  vscode.window.showInformationMessage(
    'MinSpec: Initialized .minspec/ and generated harness files.',
  );
  surfaceConstitutionNudge(folder);
  // Post-init "what to commit" hint + offer (#222). Best-effort, non-modal,
  // never blocks the init result.
  await offerScaffoldCommit(folder, deps);
  // Post-init branch-ruleset advisory (#356; reworked per DR-050 Amendment
  // 2026-07-01). NON-BLOCKING; the read-only config PROBE runs autonomously
  // (no consent toast) — a ruleset that already exists is silent — and only the
  // MUTATING create is consent-gated behind an explicit "Create ruleset" click.
  // Failures never affect the init result.
  await offerRulesetAdvisory(folder, deps?.ruleset);
}

export async function initRefreshCommand(folderArg?: string): Promise<void> {
  const folder = folderArg ?? (await resolveTargetFolder());
  if (!folder) return;
  // Same all-or-nothing concern as initCommand: a mid-sequence write failure
  // must surface, not silently leave a partial/inconsistent harness (#153).
  try {
    refreshHarnessFiles(folder);
  } catch (err) {
    vscode.window.showErrorMessage(
      `MinSpec: Harness refresh failed — ${describeError(err)}. ` +
        'Some files may be partially written; resolve the error and re-run.',
    );
    return;
  }
  vscode.window.showInformationMessage(
    'MinSpec: Refreshed harness files (user edits preserved).',
  );
  surfaceConstitutionNudge(folder);
}

/** Extract a human-readable message from an unknown thrown value. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
