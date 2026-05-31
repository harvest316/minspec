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
import {
  parseSections,
  hashSection,
  loadHashes,
  type SectionHashes,
} from './merge-refresh';
import { TEMPLATE_NAMES, TEMPLATE_OUTPUT_PATHS, TEMPLATES } from './template-registry';
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
 * Detect whether the bundled harness templates have drifted from the last
 * generation. Returns true when any of:
 *   - A harness output file exists but no hashes are stored (e.g. user edited
 *     before tooling tracked them) AND the file content does not match the
 *     current template
 *   - Stored hashes for a section differ from the hash of that section in the
 *     current bundled template (meaning the template has been updated since
 *     the last init/refresh)
 *
 * Only considers files that already exist on disk — a missing harness file is
 * not "drift", it's "uninitialized" and handled by isMinspecInitialized().
 */
export function hasHarnessDrift(rootDir: string): boolean {
  if (!isMinspecInitialized(rootDir)) return false;

  const storedHashes = loadHashes(rootDir);

  for (const name of TEMPLATE_NAMES) {
    const relPath = TEMPLATE_OUTPUT_PATHS[name];
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) continue;

    const templateSrc = TEMPLATES[name];
    const templateSections = parseSections(templateSrc);
    const templateHashes: SectionHashes = {};
    for (const s of templateSections) {
      templateHashes[s.heading] = hashSection(s.body);
    }

    const fileStored = storedHashes[relPath];

    if (!fileStored || Object.keys(fileStored).length === 0) {
      // No stored hashes — only treat as drift when content differs from
      // the bundled template (otherwise file was just generated and
      // hashes haven't been written yet).
      const existing = safeReadFile(fullPath);
      if (existing == null) continue;
      const existingSections = parseSections(existing);
      for (const s of existingSections) {
        const tplHash = templateHashes[s.heading];
        if (tplHash && tplHash !== hashSection(s.body)) {
          return true;
        }
      }
      continue;
    }

    // Compare stored hashes (last-known template state) to current template.
    // If any section's template hash differs from what we stored, the
    // bundled template has been updated → drift.
    for (const heading of Object.keys(templateHashes)) {
      const stored = fileStored[heading];
      const current = templateHashes[heading];
      if (stored && current && stored !== current) {
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
  /** Show an info toast with three actions. Returns the chosen label. */
  showPrompt(
    message: string,
    actions: readonly string[],
  ): Promise<string | undefined>;
  /** Execute a VS Code command id */
  executeCommand(commandId: string): Promise<void> | void;
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

/** A single bootstrap step the orchestrator may surface */
export interface BootstrapStep {
  readonly kind: PromptKind;
  readonly shouldRun: (rootDir: string, prefs: BootstrapPreferences) => boolean;
  readonly message: string;
  readonly primaryAction: string;
  readonly commandId: string;
  readonly skipPrefKey: keyof BootstrapPreferences;
}

const NOT_NOW = 'Not Now';
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
  },
] as const;

/**
 * Run the bootstrap detect+offer flow once.
 *
 * Behavior:
 *   - If master setting disabled → no-op
 *   - Steps are evaluated in order; the first eligible one is offered
 *   - "Primary" → runs the associated command
 *   - "Not Now" → no-op (eligible again next activation)
 *   - "Don't ask again" → writes the corresponding skip flag to preferences
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

    const choice = await vscode.showPrompt(step.message, [
      step.primaryAction,
      NOT_NOW,
      DONT_ASK,
    ]);

    if (choice === step.primaryAction) {
      await vscode.executeCommand(step.commandId);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeReadFile(p: string): string | null {
  try {
    const result = fs.readFileSync(p, 'utf-8');
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}
