#!/usr/bin/env tsx
/**
 * validate-frontmatter.ts
 *
 * Enforces:
 * 1. docs/domain/*.md must have `type: domain` frontmatter
 * 2. specs/**\/*.md must have `id: SPEC-NNN` frontmatter
 * 3. Task checklists (- [ ]) not allowed in docs/domain/ files
 * 4. Acceptance criteria patterns not allowed in docs/domain/ files
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, relative, dirname } from 'path';
import { validateDrSequence } from '../packages/minspec/src/lib/adr-manager';
import {
  validateSplitLayoutCoverage,
  type SplitLayoutFile,
} from '../packages/minspec/src/lib/spec-validator';
import { DEFAULT_CONFIG } from '../packages/minspec/src/lib/config';
import type { Tier } from '../packages/minspec/src/lib/config';

const ROOT = process.cwd();
let errors = 0;
let warnings = 0;

function glob(dir: string, ext: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...glob(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) fm[key.trim()] = rest.join(':').trim();
  }
  return fm;
}

function fail(file: string, message: string): void {
  console.error(`FAIL ${relative(ROOT, file)}: ${message}`);
  errors++;
}

function warn(message: string): void {
  console.warn(`WARN ${message}`);
  warnings++;
}

// Resolve the decisions directory from .minspec/config.json (default
// docs/decisions). Mirrors the script's own lightweight config reads — no
// extension/vscode dependency.
function resolveDecisionsDir(): string {
  const configPath = join(ROOT, '.minspec', 'config.json');
  let rel = 'docs/decisions';
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as { decisionsDir?: string };
      if (typeof cfg.decisionsDir === 'string' && cfg.decisionsDir.trim()) {
        rel = cfg.decisionsDir.trim();
      }
    }
  } catch {
    // Malformed config — fall back to the default location.
  }
  return join(ROOT, rel);
}

// Rule 1 + 3 + 4: docs/domain/*.md
const domainDir = join(ROOT, 'docs', 'domain');
try {
  const domainFiles = glob(domainDir, '.md');
  for (const file of domainFiles) {
    const content = readFileSync(file, 'utf-8');
    const fm = parseFrontmatter(content);

    if (fm['type'] !== 'domain') {
      fail(file, 'missing `type: domain` frontmatter');
    }
    if (/^- \[ \]/m.test(content)) {
      fail(file, 'task checklists (- [ ]) not allowed in domain docs');
    }
    if (/acceptance criteria/i.test(content)) {
      fail(file, 'acceptance criteria not allowed in domain docs');
    }
  }
} catch {
  // docs/domain/ doesn't exist yet — that's fine
}

// Build the registry of valid epic refs (ids + slugs, lowercased) from
// docs/epics/EPIC-*.md. Empty when the repo predates epics — the epic gate
// then skips entirely (graceful degradation: don't demand epics a repo hasn't
// adopted). Mirrors epicRefSet() in the extension.
function loadEpicRefs(): Set<string> {
  const refs = new Set<string>();
  const epicsDir = join(ROOT, 'docs', 'epics');
  try {
    for (const file of glob(epicsDir, '.md')) {
      const fm = parseFrontmatter(readFileSync(file, 'utf-8'));
      if (fm['id']) refs.add(fm['id'].toLowerCase());
      if (fm['slug']) refs.add(fm['slug'].toLowerCase());
    }
  } catch {
    // docs/epics/ doesn't exist — no epics registered.
  }
  return refs;
}

// Extract the machine ref from an `epic:` value, dropping any inline title
// comment (`epic: EPIC-004  # Classifier Validation`). Refs never contain `#`.
function epicRef(raw: string | undefined): string {
  if (!raw) return '';
  const hash = raw.indexOf('#');
  return (hash === -1 ? raw : raw.slice(0, hash)).trim();
}

// Rule 2 + 5: specs/**/*.md must have id: SPEC-NNN, and — once epics are
// registered — a resolvable `epic:` ref. The epic gate is the CI-side backstop
// for the asymmetry that stranded SPEC-004 (DR-003): a *missing* epic was as
// invisible as a *dangling* one. This is a project-policy gate for THIS repo
// (which has adopted epics); the shipped extension keeps epics soft (warning,
// FR-9). See DR-003 "RCDD on the RCDD" addendum.
const specsDir = join(ROOT, 'specs');
const epicRefs = loadEpicRefs();
try {
  const specFiles = glob(specsDir, '.md');
  for (const file of specFiles) {
    const content = readFileSync(file, 'utf-8');
    const fm = parseFrontmatter(content);

    if (!fm['id'] || !/^SPEC-\d+$/.test(fm['id'])) {
      fail(file, 'missing or invalid `id: SPEC-NNN` frontmatter');
    }

    if (epicRefs.size > 0) {
      const ref = epicRef(fm['epic']);
      if (!ref) {
        fail(file, 'missing `epic: EPIC-NNN` frontmatter (epics are registered — every spec must belong to one)');
      } else if (!epicRefs.has(ref.toLowerCase())) {
        fail(file, `epic "${ref}" does not match any registered epic (docs/epics/EPIC-NNN.md)`);
      }
    }
  }
} catch {
  // specs/ doesn't exist yet — fine
}

// Rule 7 (non-fatal): split-layout cross-file coverage (#111). For each spec
// DIRECTORY whose sibling files carry split `type:` frontmatter, warn when the
// SET does not cover the tier's required, file-backed phases (a T3 dir with only
// requirements.md is missing design.md + tasks.md). The #93 fix correctly skips
// the in-FILE phase-section check per split file; this is the dir-level backstop
// it deferred. WARNS only — matches the extension's warning severity, so a
// mid-authoring requirements-only dir surfaces but never fails the build.
try {
  const specFiles = glob(specsDir, '.md');
  // Group by containing directory; each dir is one split-layout unit.
  const byDir = new Map<string, SplitLayoutFile[]>();
  for (const file of specFiles) {
    const fm = parseFrontmatter(readFileSync(file, 'utf-8'));
    const type = (fm['type'] ?? '').toLowerCase();
    const dir = dirname(file);
    const list = byDir.get(dir) ?? [];
    // epicRef() strips inline comments from epic; the tier value here may carry one
    // too (e.g. `tier: T4  # rationale`) — take the first whitespace-delimited token.
    const tierToken = (fm['tier'] ?? '').split(/\s+/)[0];
    const tier = /^T[1-4]$/.test(tierToken) ? (tierToken as Tier) : undefined;
    list.push({ type, ...(tier ? { tier } : {}) });
    byDir.set(dir, list);
  }
  for (const [dir, files] of byDir) {
    const result = validateSplitLayoutCoverage(files, DEFAULT_CONFIG);
    for (const v of result.violations) {
      warn(`split-coverage ${relative(ROOT, dir)}: ${v.message}`);
    }
  }
} catch {
  // specs/ unreadable / absent — nothing to validate, stay silent.
}

// Rule 6 (non-fatal): local DR-NNN sequence health (issue #41). WARNS — never
// fails the build — on a gap (a number skipped, e.g. DR-010 → DR-362), a
// duplicate number, or an under-padded id. Would have caught DR-362 (a global-
// register number minted into this project-local register). Tier-0, offline.
try {
  const drWarnings = validateDrSequence(resolveDecisionsDir());
  for (const w of drWarnings) {
    warn(`DR-sequence: ${w.message}`);
  }
} catch {
  // Decisions dir unreadable / absent — nothing to validate, stay silent.
}

if (warnings > 0) {
  console.warn(`\n${warnings} non-fatal warning(s).`);
}

if (errors > 0) {
  console.error(`\n${errors} validation error(s). Fix before committing.`);
  process.exit(1);
} else {
  console.log('Frontmatter validation passed.');
}
