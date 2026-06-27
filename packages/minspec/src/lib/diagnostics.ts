/**
 * diagnostics.ts — on-save/on-change dangling-reference diagnostics (#316).
 *
 * Surfaces the #161 dangling-reference checker as live VS Code squiggles while
 * authoring a spec or DR, instead of waiting for the pre-commit hook or CI. The
 * pre-commit trigger was widened in the same change (.githooks/pre-commit) so
 * commits are gated locally; this module adds the editor-time feedback loop.
 *
 * Tier-0 (DR-004): deterministic + offline. It REUSES the existing pure
 * checkers unmodified — `checkReferences` (reference-checker.ts) — and adds no
 * LLM/network. The mapping core (`violationsToDiagnostics`) is a pure function
 * over text + violations so it is unit-testable without `vscode`; only the thin
 * registration/wiring layer touches the `vscode` API.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  checkReferences,
  type ReferenceRegistry,
  type ReferenceViolation,
} from './reference-checker';
import { parseSpec } from './spec';

/** Source label so diagnostics are attributable to MinSpec in the Problems panel. */
const DIAGNOSTIC_SOURCE = 'MinSpec';

/**
 * A located diagnostic — a violation message anchored to a 0-based line/column
 * span. Pure data (no `vscode` types) so `violationsToDiagnostics` stays testable
 * in plain Node. The wiring layer converts these to `vscode.Diagnostic`.
 */
export interface LocatedDiagnostic {
  /** 0-based line index of the offending reference. */
  line: number;
  /** 0-based start column. */
  startCol: number;
  /** 0-based end column (exclusive). */
  endCol: number;
  /** Human-readable diagnostic message (from the checker). */
  message: string;
}

/**
 * Find the offending token for a violation (the ref id, e.g. `DR-355`, or the
 * file path, e.g. `src/foo.ts`) in the source text and return its first
 * location. Returns the first line if the token cannot be located (defensive —
 * the checker derives violations from the same text, so a hit is expected).
 *
 * Pure: text in, location out. No `vscode`.
 */
function locateToken(text: string, token: string): { line: number; startCol: number; endCol: number } {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].indexOf(token);
    if (col !== -1) {
      return { line: i, startCol: col, endCol: col + token.length };
    }
  }
  return { line: 0, startCol: 0, endCol: token.length };
}

/**
 * Map reference-check violations to located diagnostics over the source text.
 *
 * PURE — the unit-tested core. For each violation it locates the offending token
 * (artifact id or file path) so the squiggle lands on the actual reference, not
 * the whole line.
 */
export function violationsToDiagnostics(
  text: string,
  violations: ReferenceViolation[],
): LocatedDiagnostic[] {
  return violations.map((v) => {
    const token = v.ref.id ?? v.ref.path ?? '';
    const loc = token
      ? locateToken(text, token)
      : { line: 0, startCol: 0, endCol: 0 };
    return { ...loc, message: v.message };
  });
}

/**
 * Build the reference registry for a workspace by scanning specs/, the decisions
 * dir, and docs/epics/ — mirroring validate-frontmatter.ts' buildReferenceRegistry
 * (the extension has no shared registry builder; this is the editor-side twin).
 * Deterministic, offline. `fileExists` is supplied per-document by the caller so
 * relative `path#Lnn` citations resolve against the artifact's own directory.
 */
function buildRegistry(workspaceRoot: string, decisionsDir: string): Omit<ReferenceRegistry, 'fileExists'> {
  const specs = new Set<string>();
  const decisions = new Set<string>();
  const epics = new Set<string>();

  const walk = (dir: string): string[] => {
    let out: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out = out.concat(walk(full));
      else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
    }
    return out;
  };

  const idFromFrontmatter = (file: string): string | undefined => {
    try {
      const parsed = parseSpec(fs.readFileSync(file, 'utf-8'));
      return parsed.frontmatter['id'];
    } catch {
      return undefined;
    }
  };

  const specsRoot = path.join(workspaceRoot, 'specs');
  for (const file of walk(specsRoot)) {
    const id = idFromFrontmatter(file);
    if (id && /^SPEC-\d+$/.test(id)) specs.add(id);
    // Directory names also define a spec (split-layout dirs).
    for (const seg of path.relative(workspaceRoot, file).split(path.sep)) {
      const m = seg.match(/^(SPEC-\d+)/);
      if (m) specs.add(m[1]);
    }
  }

  for (const file of walk(decisionsDir)) {
    const m = path.basename(file).match(/^(DR-\d+)/);
    if (m) decisions.add(m[1]);
  }

  const epicsRoot = path.join(workspaceRoot, 'docs', 'epics');
  for (const file of walk(epicsRoot)) {
    const id = idFromFrontmatter(file);
    if (id && /^EPIC-\d+$/.test(id)) epics.add(id);
    const m = path.basename(file).match(/^(EPIC-\d+)/);
    if (m) epics.add(m[1]);
  }

  return { specs, decisions, epics };
}

/** Resolve the decisions dir from .minspec/config.json (default docs/decisions). */
function resolveDecisionsDir(workspaceRoot: string): string {
  let rel = 'docs/decisions';
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(workspaceRoot, '.minspec', 'config.json'), 'utf-8'),
    ) as { decisionsDir?: string };
    if (typeof cfg.decisionsDir === 'string' && cfg.decisionsDir.trim()) {
      rel = cfg.decisionsDir.trim();
    }
  } catch {
    // Missing/malformed config — default location.
  }
  return path.join(workspaceRoot, rel);
}

/** Is this a MinSpec artifact whose refs should be checked? (specs + decisions). */
function isCheckableArtifact(fsPath: string, workspaceRoot: string, decisionsDir: string): boolean {
  if (!fsPath.endsWith('.md')) return false;
  const norm = (p: string) => p.replace(/\\/g, '/');
  const file = norm(fsPath);
  const specsRoot = norm(path.join(workspaceRoot, 'specs')) + '/';
  const decRoot = norm(decisionsDir) + '/';
  return file.startsWith(specsRoot) || file.startsWith(decRoot);
}

/**
 * Compute the dangling-reference diagnostics for one document's text. Builds a
 * fresh registry each call (corpus is small; matches the validator's full-scan
 * approach) and resolves `file` citations relative to the document's directory
 * first, then the workspace root — mirroring validate-frontmatter.ts.
 */
function diagnoseDocument(
  text: string,
  docFsPath: string,
  workspaceRoot: string,
  decisionsDir: string,
): LocatedDiagnostic[] {
  const base = buildRegistry(workspaceRoot, decisionsDir);
  const artifactDir = path.dirname(docFsPath);
  const registry: ReferenceRegistry = {
    ...base,
    fileExists: (relPath) =>
      fs.existsSync(path.join(artifactDir, relPath)) ||
      fs.existsSync(path.join(workspaceRoot, relPath)),
  };
  return violationsToDiagnostics(text, checkReferences(text, registry));
}

/**
 * Register on-save/on-change dangling-reference diagnostics. Minimal footprint:
 * one DiagnosticCollection + two document listeners, all pushed onto the
 * extension's subscriptions. No-op when there is no workspace root.
 */
export function registerReferenceDiagnostics(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
): void {
  if (!workspaceRoot) return;

  const collection = vscode.languages.createDiagnosticCollection('minspec.references');
  context.subscriptions.push(collection);

  const decisionsDir = resolveDecisionsDir(workspaceRoot);

  const refresh = (doc: vscode.TextDocument): void => {
    if (doc.uri.scheme !== 'file') return;
    if (!isCheckableArtifact(doc.uri.fsPath, workspaceRoot, decisionsDir)) {
      collection.delete(doc.uri);
      return;
    }
    const located = diagnoseDocument(
      doc.getText(),
      doc.uri.fsPath,
      workspaceRoot,
      decisionsDir,
    );
    const diagnostics = located.map((d) => {
      const diag = new vscode.Diagnostic(
        new vscode.Range(d.line, d.startCol, d.line, d.endCol),
        d.message,
        vscode.DiagnosticSeverity.Warning,
      );
      diag.source = DIAGNOSTIC_SOURCE;
      return diag;
    });
    collection.set(doc.uri, diagnostics);
  };

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
  );

  // Seed diagnostics for any already-open artifact at activation.
  for (const doc of vscode.workspace.textDocuments) {
    refresh(doc);
  }
}
