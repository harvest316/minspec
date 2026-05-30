/**
 * ScroogeLLM Bridge — Phase 10
 *
 * Passive bridge between MinSpec and ScroogeLLM:
 * - Detects whether ScroogeLLM extension is installed
 * - Shows a non-intrusive nudge (once per session, respects settings + dismissal)
 * - Exports traceability data in ConformanceContract format
 * - Auto-exports on spec changes when conformance is enabled + ScroogeLLM detected
 *
 * Invariants preserved:
 * - No AI dependency: zero AI calls
 * - No backend: zero network calls (marketplace link opens in VS Code browser)
 * - Bridge is passive: MinSpec works fine without ScroogeLLM
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  loadTraceability,
  parseLocationString,
  type TraceabilityData,
} from './traceability';
import { detectAITools, type DetectedAITools } from './ai-usage-detector';
import type {
  ConformanceContract,
  ConformanceRequirement,
  CodeLocation,
} from '@aiclarity/shared';

const SCROOGELLM_EXTENSION_ID = 'aiclarity.scroogellm';
const NUDGE_DISMISSED_KEY = 'minspec.scroogellmNudge.dismissed';
const NUDGE_LAST_SHOWN_KEY = 'minspec.scroogellmNudge.lastShownAt';
const INSTALL_TIMESTAMP_KEY = 'minspec.installedAt';
const MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=aiclarity.scroogellm';
const EXPORT_FILENAME = 'traceability-export.json';

const INSTALL_DELAY_MS = 24 * 60 * 60 * 1000;       // 1 day
const RESHOW_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- Detection ---

/**
 * Check if ScroogeLLM extension is installed (not necessarily activated).
 */
export function isScroogeLlmInstalled(): boolean {
  return vscode.extensions.getExtension(SCROOGELLM_EXTENSION_ID) !== undefined;
}

// --- Nudge ---

export function recordInstallTimestamp(context: vscode.ExtensionContext, now: number = Date.now()): void {
  const existing = context.globalState.get<number>(INSTALL_TIMESTAMP_KEY);
  if (existing === undefined) {
    void context.globalState.update(INSTALL_TIMESTAMP_KEY, now);
  }
}

export function buildNudgeMessage(detected: DetectedAITools): string {
  const base = 'ScroogeLLM cuts your LLM costs ~25-40% via caching, smart routing, and free-tier fallback — savings scale with your spend.';
  if (detected.tools.length === 0) {
    return base;
  }
  const list = detected.tools.length <= 2
    ? detected.tools.join(' + ')
    : `${detected.tools.slice(0, 2).join(', ')} + ${detected.tools.length - 2} more`;
  return `${base} Works alongside ${list}.`;
}

/**
 * Show a nudge suggesting ScroogeLLM, gated on:
 * 1. ScroogeLLM not installed
 * 2. `minspec.scroogellmNudge.enabled` setting true
 * 3. User has not chosen "Don't Show Again"
 * 4. At least 24h since first install
 * 5. At least 7d since last shown (cooldown)
 *
 * Returns true if shown.
 */
export async function maybeShowNudge(
  context: vscode.ExtensionContext,
  now: number = Date.now(),
): Promise<boolean> {
  if (isScroogeLlmInstalled()) {
    return false;
  }

  const config = vscode.workspace.getConfiguration('minspec');
  if (!config.get<boolean>('scroogellmNudge.enabled', true)) {
    return false;
  }

  if (context.globalState.get<boolean>(NUDGE_DISMISSED_KEY, false)) {
    return false;
  }

  const installedAt = context.globalState.get<number>(INSTALL_TIMESTAMP_KEY);
  if (installedAt !== undefined && now - installedAt < INSTALL_DELAY_MS) {
    return false;
  }

  const lastShownAt = context.globalState.get<number>(NUDGE_LAST_SHOWN_KEY);
  if (lastShownAt !== undefined && now - lastShownAt < RESHOW_COOLDOWN_MS) {
    return false;
  }

  const detected = detectAITools();
  const message = buildNudgeMessage(detected);

  await context.globalState.update(NUDGE_LAST_SHOWN_KEY, now);

  const choice = await vscode.window.showInformationMessage(
    message,
    'Learn More',
    'Not Now',
    "Don't Show Again",
  );

  if (choice === 'Learn More') {
    vscode.env.openExternal(vscode.Uri.parse(MARKETPLACE_URL));
  } else if (choice === "Don't Show Again") {
    await context.globalState.update(NUDGE_DISMISSED_KEY, true);
  }

  return true;
}

// --- Traceability Export ---

/**
 * Convert internal TraceabilityData into an array of ConformanceContract objects
 * (one per spec ID), ready for JSON serialization.
 */
export function buildConformanceContracts(data: TraceabilityData): ConformanceContract[] {
  const contracts: ConformanceContract[] = [];

  for (const [specId, specTrace] of Object.entries(data)) {
    const requirements: ConformanceRequirement[] = [];

    for (const [reqKey, mapping] of Object.entries(specTrace.requirements)) {
      const codeLocations: CodeLocation[] = mapping.files.map(loc => {
        const parsed = parseLocationString(loc);
        return {
          file: parsed.relativePath,
          startLine: parsed.startLine,
          endLine: parsed.endLine,
        };
      });

      const testLocations: CodeLocation[] = mapping.tests.map(loc => {
        const parsed = parseLocationString(loc);
        return {
          file: parsed.relativePath,
          startLine: parsed.startLine,
          endLine: parsed.endLine,
        };
      });

      requirements.push({
        key: reqKey,
        description: '', // Populated from spec content if available
        acceptanceCriteria: [],
        codeLocations,
        testLocations,
      });
    }

    contracts.push({
      version: '1.0',
      specId,
      requirements,
    });
  }

  return contracts;
}

/**
 * Export traceability data to .minspec/traceability-export.json.
 * This is the file ScroogeLLM reads.
 */
export function exportTraceability(workspaceRoot: string): { filePath: string; specCount: number } {
  const data = loadTraceability(workspaceRoot);
  const contracts = buildConformanceContracts(data);

  const exportData = {
    exportedAt: new Date().toISOString(),
    contractVersion: '1.0' as const,
    specs: contracts,
  };

  const dirPath = path.join(workspaceRoot, '.minspec');
  fs.mkdirSync(dirPath, { recursive: true });

  const filePath = path.join(dirPath, EXPORT_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2) + '\n', 'utf-8');

  return { filePath, specCount: contracts.length };
}

// --- Conformance Watcher ---

/**
 * Set up a file watcher that auto-exports traceability when:
 * 1. `minspec.conformance.enabled` is true
 * 2. ScroogeLLM extension is detected
 * 3. A spec file changes
 *
 * Returns a Disposable that cleans up the watcher, or undefined if
 * conditions aren't met.
 */
export function setupConformanceWatcher(workspaceRoot: string): vscode.Disposable | undefined {
  const config = vscode.workspace.getConfiguration('minspec');
  const conformanceEnabled = config.get<boolean>('conformance.enabled', false);

  if (!conformanceEnabled || !isScroogeLlmInstalled()) {
    return undefined;
  }

  const specsDir = config.get<string>('specsDir', 'specs');
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.workspace.workspaceFolders?.[0] ?? '',
      `${specsDir}/**/*.md`,
    ),
  );

  const doExport = () => {
    try {
      exportTraceability(workspaceRoot);
    } catch {
      // Silent failure — conformance export is best-effort
    }
  };

  watcher.onDidChange(doExport);
  watcher.onDidCreate(doExport);
  watcher.onDidDelete(doExport);

  return watcher;
}
