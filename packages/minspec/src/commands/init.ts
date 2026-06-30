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
  REQUIRED_CHECK_CONTEXTS,
  createRequiredChecksRuleset,
  defaultCommandRunner,
  hasRequiredChecksRuleset,
  isGhReady,
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

/** Toast action: open the GitHub rulesets docs page. */
const RULESET_DOCS_ACTION = 'View GitHub docs';
/** Toast action: create the required-status-checks ruleset via the user's gh. */
const RULESET_CREATE_ACTION = 'Create ruleset';
/**
 * Consent-prompt action: proceed past the gate — run the `gh api` READ (and, if
 * no qualifying ruleset exists, OFFER to create one). The SINGLE gate that all
 * `gh api` network actions (read + create) sit behind.
 */
const RULESET_CONSENT_ACTION = 'Set up';
/** Consent-prompt action: decline — make ZERO `gh api` calls. */
const RULESET_DECLINE_ACTION = 'Not now';
/** Consent-prompt action: open the docs instead of touching the network. */
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
 * NON-BLOCKING post-init advisory (#356): nudge the user toward a branch
 * ruleset that requires CI status checks on the default branch.
 *
 * Network discipline (Tier-0 boundary): the ONLY always-on path is the
 * zero-network docs link. EVERY `gh api` network action — BOTH the *read*
 * (listing existing rulesets) AND the *create* (POST) — sits behind a SINGLE
 * explicit consent gate ("Set up"), in addition to `gh` availability. We never
 * probe a user's repo over the network until they have opted in:
 *   - not a git repo → return (zero process, zero toast).
 *   - `gh` missing/unauthed → info toast linking the docs. Zero `gh api`. Done.
 *   - `gh` ready + no GitHub remote → docs link. Zero `gh api`. Done.
 *   - `gh` ready + repo resolves → ONE consent prompt BEFORE any `gh api` read:
 *       - "Set up"    → run the READ; if a qualifying ruleset already exists,
 *         brief "already configured" toast; else OFFER to create → on "Create
 *         ruleset" POST via gh (success → toast; 403/error → docs link).
 *       - "Not now"   → ZERO `gh api` calls. Return.
 *       - "Learn more"/dismiss → open the docs (zero further network).
 *
 * Note `isGhReady` itself shells the user's own `gh` (`gh --version`, then
 * `gh auth status`) to *detect* readiness — the same local capability probe by
 * which MinSpec already shells `git`. The consent gate guards the network READ
 * of the user's *repository* (`gh api repos/{owner}/{repo}/rulesets`), which is
 * the action the user is consenting to.
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
          `(${REQUIRED_CHECK_CONTEXTS.join(', ')}) status checks. ` +
          'Install/authenticate the `gh` CLI to let MinSpec offer to create one, or see the GitHub docs.',
        openExternal,
      );
      return;
    }

    const repo = await resolveRepo(folder);
    if (!repo) {
      // gh is ready but we cannot identify the GitHub repo (no github.com
      // remote). Nothing to read or create against → docs link only.
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

    // CONSENT GATE — the single explicit opt-in that BOTH the `gh api` READ and
    // the create POST sit behind. Until the user clicks "Set up", MinSpec makes
    // ZERO `gh api` calls against their repository.
    const consent = await vscode.window.showInformationMessage(
      'MinSpec can check / set up a GitHub branch ruleset requiring CI ' +
        `(${REQUIRED_CHECK_CONTEXTS.join(' + ')}) status checks on ${repo}'s default ` +
        'branch (uses your `gh` CLI).',
      RULESET_CONSENT_ACTION,
      RULESET_DECLINE_ACTION,
      RULESET_LEARN_MORE_ACTION,
    );
    if (consent !== RULESET_CONSENT_ACTION) {
      // "Not now", "Learn more", or dismissed → NO `gh api` read/create. The
      // only side effect is opening the docs when the user asked to learn more.
      if (consent === RULESET_LEARN_MORE_ACTION) openExternal(RULESET_DOCS_URL);
      return;
    }

    // READ (network) — only reached past the explicit "Set up" consent above. A
    // qualifying ruleset already protects the default branch → brief
    // confirmation, no offer.
    if (await hasRequiredChecksRuleset(owner, name, run)) {
      vscode.window.showInformationMessage(
        `MinSpec: your default branch already has a ruleset requiring status checks (${repo}).`,
      );
      return;
    }

    // None found → OFFER (the same consent already covers the create; this is
    // the final go/no-go for the POST).
    const choice = await vscode.window.showInformationMessage(
      `MinSpec: ${repo} has no ruleset requiring CI status checks on its default branch. ` +
        `Create one requiring ${REQUIRED_CHECK_CONTEXTS.join(' + ')}?`,
      RULESET_CREATE_ACTION,
      RULESET_DOCS_ACTION,
    );

    if (choice === RULESET_CREATE_ACTION) {
      // CREATE (network) — only reached on explicit "Create ruleset".
      const outcome = await createRequiredChecksRuleset(owner, name, run);
      if (outcome.created) {
        vscode.window.showInformationMessage(
          `MinSpec: created a ruleset requiring ${REQUIRED_CHECK_CONTEXTS.join(' + ')} on ${repo}'s default branch.`,
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

    // Dismissed or chose "View GitHub docs" → link the docs (zero further network).
    if (choice === RULESET_DOCS_ACTION) openExternal(RULESET_DOCS_URL);
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
  // Post-init branch-ruleset advisory (#356). NON-BLOCKING; the only always-on
  // path is a zero-network docs link — every `gh api` network action (the read
  // AND the create) sits behind a single explicit "Set up" consent gate.
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
