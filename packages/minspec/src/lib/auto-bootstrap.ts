/**
 * Auto-bootstrap — detection + offer system for first-class onboarding.
 *
 * Runs on extension activation. Surfaces toasts in priority order, one at a
 * time, asking the user whether to:
 *   1. Initialize `.minspec/` (if missing)
 *   2. Refresh harness files (if templates have drifted from last merge)
 *   3. Classify current uncommitted diff (if there are git changes + no cache)
 *
 * Also implements an optional post-commit auto-classify watcher (gated on the
 * `minspec.autoClassifyOnCommit` setting, default false).
 *
 * Tier 0 invariants honored:
 *   - No network calls
 *   - No AI calls
 *   - Pure local file system + VS Code API
 *
 * Persistence:
 *   - Per-prompt "Don't ask again" choices write to
 *     `.minspec/preferences.json`
 *   - Master toggle: `minspec.autoBootstrap.enabled` setting (default: true)
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadTemplateBaseline } from './merge-refresh';
import { computeTemplateBaseline } from './template-registry';
import { collectArtifacts } from './epic-backfill';
import { listEpics } from './epic-manager';

// ---------------------------------------------------------------------------
// Preferences (persisted in .minspec/preferences.json)
// ---------------------------------------------------------------------------

export interface BootstrapPreferences {
  readonly skipInitPrompt?: boolean;
  readonly skipRefreshPrompt?: boolean;
  readonly skipClassifyPrompt?: boolean;
  readonly skipBackfillPrompt?: boolean;
  /**
   * Per-prompt opt-out for the DESIGN.md-stub-removal offer (#315). Distinct
   * from `skipBackfillPrompt` (epic backfill) even though both are `kind:
   * 'backfill'` — declining one must never suppress the other.
   */
  readonly skipDesignStubPrompt?: boolean;
}

const PREFS_FILENAME = 'preferences.json';

/** Resolve the absolute path to `.minspec/preferences.json` */
export function preferencesPath(rootDir: string): string {
  return path.join(rootDir, '.minspec', PREFS_FILENAME);
}

/**
 * Load preferences from `.minspec/preferences.json`. Returns empty object if
 * file does not exist or is invalid JSON.
 */
export function loadPreferences(rootDir: string): BootstrapPreferences {
  const filePath = preferencesPath(rootDir);
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as BootstrapPreferences;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Merge new preferences with existing ones and persist to disk.
 * Creates `.minspec/` if it does not exist.
 */
export function savePreferences(
  rootDir: string,
  update: BootstrapPreferences,
): void {
  const minspecDir = path.join(rootDir, '.minspec');
  fs.mkdirSync(minspecDir, { recursive: true });
  const current = loadPreferences(rootDir);
  const merged = { ...current, ...update };
  fs.writeFileSync(
    preferencesPath(rootDir),
    JSON.stringify(merged, null, 2) + '\n',
  );
}

// ---------------------------------------------------------------------------
// Detection — pure file-system checks (no vscode dependency)
// ---------------------------------------------------------------------------

/** Whether `.minspec/` exists in the workspace */
export function isMinspecInitialized(rootDir: string): boolean {
  return fs.existsSync(path.join(rootDir, '.minspec'));
}

/**
 * Detect whether the bundled harness templates have genuinely moved upstream
 * since the project's harness files were last generated/refreshed.
 *
 * Compares the hash of each *raw, unrendered* template section now against the
 * raw-template baseline recorded at the last generate/refresh
 * (`.minspec/template-baseline.json`). Both sides are raw template — a true
 * like-for-like comparison — so the result is independent of:
 *   - rendering context (project name, specs dir, invariant list); and
 *   - the user's own edits to the generated files.
 *
 * This replaces the previous comparison of the raw template against
 * `generated-hashes.json` (rendered + user-merged hashes), which could never
 * match for any section containing a `{{placeholder}}` and therefore reported
 * drift on essentially every activation forever (#117).
 *
 * Returns false (no drift) when:
 *   - `.minspec/` is missing (uninitialized);
 *   - no baseline has been recorded yet — a project generated before baseline
 *     tracking. We have no like-for-like reference, so we stay silent rather
 *     than re-introduce a false positive; the baseline is written on the next
 *     init/refresh, restoring detection; or
 *   - a harness file is absent on disk (that is "uninitialized", not drift).
 */
export function hasHarnessDrift(rootDir: string): boolean {
  if (!isMinspecInitialized(rootDir)) return false;

  const baseline = loadTemplateBaseline(rootDir);
  if (Object.keys(baseline).length === 0) return false;

  const current = computeTemplateBaseline();

  // Iterate every output path the CURRENT baseline knows about — both the Markdown
  // harness templates AND the managed-region templates (CI workflow, git hooks, and
  // the #241 slash-command shims), which `computeTemplateBaseline` now records. This
  // is what lets a slash-shim guidance edit fire the "templates updated, refresh?"
  // prompt: drift is no longer scoped to `TEMPLATE_NAMES`. Each side is still raw
  // template hash, so the comparison stays like-for-like (#117) and independent of
  // both rendering context and the user's own edits to the generated files.
  for (const relPath of Object.keys(current)) {
    if (!fs.existsSync(path.join(rootDir, relPath))) continue;

    const recordedHashes = baseline[relPath];
    const currentHashes = current[relPath];
    if (!recordedHashes || !currentHashes) continue;

    for (const heading of Object.keys(currentHashes)) {
      const recorded = recordedHashes[heading];
      const now = currentHashes[heading];
      // Drift = the raw template body for this section changed since the
      // baseline was recorded (the bundled template genuinely moved upstream).
      if (recorded && now && recorded !== now) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Detect whether the workspace has uncommitted changes (staged or unstaged)
 * with no recent classification cached in `.minspec/classifications/`.
 *
 * Uses the existence of `.git/index` + recent mtime as a cheap proxy for
 * "is this a git repo with changes" — we don't want to shell out to `git
 * status` on every activation. The classification cache directory is created
 * if missing.
 *
 * Returns true when:
 *   - The workspace looks like a git repo
 *   - No file in `.minspec/classifications/` has a newer mtime than the
 *     `.git/index` (i.e. the latest classification predates the latest stage
 *     activity)
 */
export function hasUnclassifiedChanges(rootDir: string): boolean {
  const gitDir = path.join(rootDir, '.git');
  const gitIndex = path.join(gitDir, 'index');
  if (!fs.existsSync(gitIndex)) return false;

  // Ensure the classifications dir exists so the user can collect results
  const classificationsDir = path.join(rootDir, '.minspec', 'classifications');
  try {
    fs.mkdirSync(classificationsDir, { recursive: true });
  } catch {
    // If we can't create it, skip the prompt rather than spamming
    return false;
  }

  let indexMtime: number;
  try {
    indexMtime = fs.statSync(gitIndex).mtimeMs;
  } catch {
    return false;
  }

  // Cross-platform "recent commit" check: are there any unstaged changes?
  // We can't run `git status` safely without simple-git overhead in the
  // activation hot path, but we can detect "the working tree has been
  // touched since the last commit" by comparing .git/index mtime vs
  // .git/HEAD mtime. If index is newer, staged changes exist. We also
  // check whether any tracked source file has a newer mtime than HEAD.
  const headPath = path.join(gitDir, 'HEAD');
  let headMtime = 0;
  try {
    headMtime = fs.statSync(headPath).mtimeMs;
  } catch {
    // If HEAD is missing we still proceed conservatively
  }

  const hasActivity = indexMtime > headMtime + 1000; // 1s tolerance
  if (!hasActivity) return false;

  // Check whether classifications dir holds a result newer than gitIndex
  let entries: string[];
  try {
    entries = fs.readdirSync(classificationsDir);
  } catch {
    return false;
  }

  for (const name of entries) {
    try {
      const stat = fs.statSync(path.join(classificationsDir, name));
      if (stat.isFile() && stat.mtimeMs >= indexMtime) {
        return false; // a classification newer than current index exists
      }
    } catch {
      // ignore
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// VS Code-facing orchestrator
// ---------------------------------------------------------------------------

/**
 * Minimal VS Code surface used by the bootstrap. Defined as an interface so
 * tests can supply a lightweight stub without `vi.mock('vscode')`.
 */
export interface BootstrapVsCode {
  /** True if the master `minspec.autoBootstrap.enabled` setting is on */
  isEnabled(): boolean;
  /** Show an info toast with the given actions. Returns the chosen label. */
  showPrompt(
    message: string,
    actions: readonly string[],
  ): Promise<string | undefined>;
  /** Execute a VS Code command id. `arg` carries step-specific extra args (e.g. AI consent). */
  executeCommand(commandId: string, folder?: string, arg?: unknown): Promise<void> | void;
  /**
   * Enable auto-classify-on-commit for the folder (the "Always" affordance).
   * Optional so existing test stubs need not implement it; absent → the
   * "Always" action falls back to a one-shot run.
   */
  enableAutoClassify?(folder: string): Promise<void> | void;
}

/** Identifiers used by the per-prompt skip flags */
export type PromptKind = 'init' | 'refresh' | 'classify' | 'backfill';

/**
 * Detector: a project with specs/ADRs that aren't well-grouped by epic — backfill
 * (DR-016) would help. Pure file-system (the offer is Tier 0; the AI pass only
 * runs on explicit action). Two triggers:
 *   1. specs/ADRs exist but the epic registry is empty (the "opened a project
 *      with specs but no epics" case — offer to establish the taxonomy), or
 *   2. a registry exists but ≥3 artifacts are still untagged (mid-life gap).
 * Quiet on a fresh `minspec init` (no specs yet → nothing to group), where epic
 * grouping is simply on by default.
 */
export function hasUnbackfilledEpics(rootDir: string): boolean {
  let artifacts;
  try {
    artifacts = collectArtifacts(rootDir);
  } catch {
    return false;
  }
  if (artifacts.length === 0) return false; // fresh project — nothing to group yet
  if (listEpics(rootDir).length === 0) return true; // specs but no epics → offer
  return artifacts.filter(a => !a.epic).length >= 3; // registry exists, gaps remain
}

// ---------------------------------------------------------------------------
// Pristine DESIGN.md stub detection (#315 — backfill for #206)
// ---------------------------------------------------------------------------

/**
 * Detect a *pristine, placeholder-only* `DESIGN.md` at the project root.
 *
 * Background: #206 (PR #311) stopped *scaffolding* the empty DESIGN.md harness
 * stub, but projects initialized before #206 still carry the committed stub on
 * disk. This detector recognizes that stub so the bootstrap can offer to remove
 * it — converging existing projects to the #206 state.
 *
 * The match is **structural**, not text-equality against the removed
 * `DESIGN_MD_TEMPLATE` const (which #206 deleted). A file is "pristine" iff,
 * after removing a frontmatter block (if any), every non-blank body line is one
 * of:
 *   - a markdown ATX heading (`#`, `##`, `###`, …); or
 *   - an HTML comment placeholder (a line wholly inside a `<!-- … -->` block).
 *
 * ANY other non-blank line — a sentence, a list item, a code fence, a table —
 * is real prose/content and makes the file NOT pristine (left untouched). A
 * frontmatter block with any non-blank key is likewise treated as real content
 * (the scaffold stub had none), so a DESIGN.md someone gave real frontmatter is
 * preserved. The body must also contain at least one heading AND at least one
 * comment placeholder, so an empty or near-empty file is not mistaken for the
 * scaffold stub.
 *
 * Returns false when DESIGN.md is absent, unreadable, or has any real content.
 * Deterministic, offline, no AI (Tier 0 / DR-004).
 */
export function isPristineDesignStub(rootDir: string): boolean {
  const filePath = path.join(rootDir, 'DESIGN.md');
  let raw: string;
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }

  let body = raw;

  // Strip a leading YAML frontmatter block. Any non-blank line inside it counts
  // as real content (the scaffold stub had no frontmatter).
  const fmMatch = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fmMatch) {
    const fmInner = fmMatch[1] ?? '';
    if (fmInner.split(/\r?\n/).some((l) => l.trim() !== '')) {
      return false; // meaningful frontmatter → real content
    }
    body = raw.slice(fmMatch[0].length);
  }

  const lines = body.split(/\r?\n/);
  let inComment = false;
  let sawHeading = false;
  let sawComment = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (inComment) {
      sawComment = true;
      if (line.includes('-->')) {
        // Reject trailing prose after the comment close on the same line.
        const after = line.slice(line.indexOf('-->') + 3).trim();
        if (after !== '') return false;
        inComment = false;
      }
      continue;
    }

    if (line === '') continue;

    // Single-line comment: <!-- … -->
    if (line.startsWith('<!--') && line.includes('-->')) {
      const after = line.slice(line.indexOf('-->') + 3).trim();
      if (after !== '') return false;
      sawComment = true;
      continue;
    }

    // Opening of a multi-line comment with no close on this line.
    if (line.startsWith('<!--')) {
      sawComment = true;
      inComment = true;
      continue;
    }

    // ATX heading: one or more '#', a space, then text.
    if (/^#{1,6}\s+\S/.test(line)) {
      sawHeading = true;
      continue;
    }

    // Anything else is real content.
    return false;
  }

  // An unterminated comment block, or a file lacking either a heading or a
  // placeholder, is not the recognizable scaffold stub.
  if (inComment) return false;
  return sawHeading && sawComment;
}

/** A single bootstrap step the orchestrator may surface */
export interface BootstrapStep {
  readonly kind: PromptKind;
  readonly shouldRun: (rootDir: string, prefs: BootstrapPreferences) => boolean;
  readonly message: string;
  readonly primaryAction: string;
  readonly commandId: string;
  readonly skipPrefKey: keyof BootstrapPreferences;
  /**
   * Optional in-process action run on the primary choice INSTEAD of dispatching
   * a VS Code command. Used by the DESIGN.md-stub step (#315) whose effect — a
   * local file removal — has no command of its own and must stay entirely in
   * this module. When set, `commandId` is ignored for the primary action.
   */
  readonly action?: (rootDir: string) => void | Promise<void>;
  /**
   * Optional "Always" affordance — when set, this label is offered first and,
   * if chosen, calls `enableAutoClassify` so the step runs itself in future,
   * then runs the command once now. Only the classify step uses it.
   */
  readonly alwaysAction?: string;
  /**
   * Optional extra argument forwarded to the command after the folder. The
   * backfill step uses it to pass AI consent ({ aiConsent: true }) — the offer's
   * toast already promised the AI pass, so the command must not re-ask (#213).
   */
  readonly commandArg?: unknown;
}

const DONT_ASK = "Don't ask again";

/** All steps, in the order they are surfaced. Exported for testability. */
export const BOOTSTRAP_STEPS: readonly BootstrapStep[] = [
  {
    kind: 'init',
    shouldRun: (rootDir, prefs) =>
      !prefs.skipInitPrompt && !isMinspecInitialized(rootDir),
    message:
      "MinSpec: This project isn't initialized. Run setup now?",
    primaryAction: 'Initialize',
    commandId: 'minspec.init',
    skipPrefKey: 'skipInitPrompt',
  },
  {
    kind: 'refresh',
    shouldRun: (rootDir, prefs) =>
      !prefs.skipRefreshPrompt &&
      isMinspecInitialized(rootDir) &&
      hasHarnessDrift(rootDir),
    message:
      'MinSpec: Harness templates updated since last refresh. Refresh now?',
    primaryAction: 'Refresh',
    commandId: 'minspec.initRefresh',
    skipPrefKey: 'skipRefreshPrompt',
  },
  {
    kind: 'classify',
    shouldRun: (rootDir, prefs) =>
      !prefs.skipClassifyPrompt &&
      isMinspecInitialized(rootDir) &&
      hasUnclassifiedChanges(rootDir),
    message:
      'MinSpec: You have uncommitted changes. Classify complexity now?',
    primaryAction: 'Classify',
    commandId: 'minspec.classify',
    skipPrefKey: 'skipClassifyPrompt',
    alwaysAction: 'Always',
  },
  {
    kind: 'backfill',
    shouldRun: (rootDir, prefs) =>
      !prefs.skipBackfillPrompt &&
      isMinspecInitialized(rootDir) &&
      hasUnbackfilledEpics(rootDir),
    message:
      'MinSpec: Several specs/decisions have no epic. Backfill epics now? (AI-enhanced if Claude Code is installed.)',
    primaryAction: 'Backfill',
    commandId: 'minspec.backfillEpics',
    skipPrefKey: 'skipBackfillPrompt',
    commandArg: { aiConsent: true },
  },
  {
    // #315 backfill: existing projects keep the empty DESIGN.md stub that #206
    // stopped scaffolding. Offer to remove a *pristine* (placeholder-only) stub.
    // Shares `kind: 'backfill'` with epic backfill but uses its own skip flag so
    // the two offers never cross-suppress. NEVER deletes silently — only on the
    // user's explicit primary choice, and only when the file is recognizably the
    // scaffold stub (real content is left untouched).
    kind: 'backfill',
    shouldRun: (rootDir, prefs) =>
      !prefs.skipDesignStubPrompt &&
      isMinspecInitialized(rootDir) &&
      isPristineDesignStub(rootDir),
    message:
      'MinSpec: This DESIGN.md is an empty placeholder stub (no longer scaffolded). Remove it?',
    primaryAction: 'Remove',
    commandId: '',
    skipPrefKey: 'skipDesignStubPrompt',
    action: (rootDir) => {
      // Re-check immediately before deleting: the file may have gained content
      // between detection and the user's click. Never delete real content.
      if (!isPristineDesignStub(rootDir)) return;
      fs.rmSync(path.join(rootDir, 'DESIGN.md'), { force: true });
    },
  },
] as const;

/**
 * Run the bootstrap detect+offer flow once.
 *
 * Behavior:
 *   - If master setting disabled → no-op
 *   - Steps are evaluated in order; the first eligible one is offered
 *   - "Always" (when offered) → enables auto-run for the step, then runs once
 *   - "Primary" → runs the associated command once
 *   - "Don't ask again" → writes the corresponding skip flag to preferences
 *   - Dismissing the toast (the X) → no-op (eligible again next activation).
 *     There is no explicit "Not Now": the toast's close button already does
 *     exactly that, so a dedicated button was redundant.
 *
 * Returns a result object describing what (if anything) was offered, so tests
 * can assert behavior without inspecting vscode mocks.
 */
export interface BootstrapResult {
  readonly enabled: boolean;
  readonly offered: PromptKind | null;
  readonly choice: string | null;
}

export async function runBootstrap(
  rootDir: string,
  vscode: BootstrapVsCode,
  steps: readonly BootstrapStep[] = BOOTSTRAP_STEPS,
): Promise<BootstrapResult> {
  if (!vscode.isEnabled()) {
    return { enabled: false, offered: null, choice: null };
  }
  if (!rootDir) {
    return { enabled: true, offered: null, choice: null };
  }

  const prefs = loadPreferences(rootDir);

  for (const step of steps) {
    if (!step.shouldRun(rootDir, prefs)) continue;

    // "Always" first (most prominent / default), then the one-shot primary,
    // then the opt-out. No "Not Now" — the toast's X already dismisses.
    const actions = [
      ...(step.alwaysAction ? [step.alwaysAction] : []),
      step.primaryAction,
      DONT_ASK,
    ];
    const choice = await vscode.showPrompt(step.message, actions);

    if (step.alwaysAction && choice === step.alwaysAction) {
      // Opt into auto-run going forward, then run once now. If the host can't
      // persist the setting, fall back to a plain one-shot run.
      if (vscode.enableAutoClassify) {
        await vscode.enableAutoClassify(rootDir);
      }
      await vscode.executeCommand(step.commandId, rootDir, step.commandArg);
    } else if (choice === step.primaryAction) {
      if (step.action) {
        // In-process effect (e.g. DESIGN.md stub removal, #315) — no command.
        await step.action(rootDir);
      } else {
        // Pass the bootstrapped folder so the command targets THIS folder, not a
        // re-resolved one (matters in a multi-root workspace), plus any step-
        // specific arg (backfill → AI consent).
        await vscode.executeCommand(step.commandId, rootDir, step.commandArg);
      }
    } else if (choice === DONT_ASK) {
      savePreferences(rootDir, { [step.skipPrefKey]: true });
    }

    return {
      enabled: true,
      offered: step.kind,
      choice: choice ?? null,
    };
  }

  return { enabled: true, offered: null, choice: null };
}

// ---------------------------------------------------------------------------
// Auto-classify on commit — file watcher backend
// ---------------------------------------------------------------------------

/**
 * Determine whether a path looks like a git ref/HEAD file we want to watch.
 * Exported for test access.
 */
export function isWatchedGitPath(p: string): boolean {
  const normalized = p.replace(/\\/g, '/');
  return (
    normalized.endsWith('/.git/HEAD') ||
    /\/.git\/refs\/heads\//.test(normalized)
  );
}
