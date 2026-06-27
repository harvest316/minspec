/**
 * T0 — Invariant Tests
 *
 * Tests that the six MinSpec invariants from CLAUDE.md are upheld:
 *   1. No AI dependency — no imports of AI/LLM libraries
 *   2. No backend — no fetch/http/axios/got calls
 *   3. No lock-in — spec files round-trip in Spec Kit-compatible format
 *   4. Ceremony proportional to complexity — T1 minimal, T4 maximal
 *   5. User override always wins — classifier overrides persist in calibration
 *   6. Harness file regeneration preserves user edits — merge-refresh semantics
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Modules under test
import { parseSpec, writeSpec } from '../src/lib/spec';
import { classify, overrideClassification, recordOverride, loadCalibration } from '../src/lib/classifier';
import type { ClassificationSignal } from '../src/lib/classifier';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { mergeFile, parseSections, hashSection, buildSectionHashes } from '../src/lib/merge-refresh';

// ─── Invariant 1: No AI Dependency ─────────────────────────────────────────

describe('Invariant 1: No AI dependency', () => {
  const srcRoot = path.resolve(__dirname, '..', 'src');

  function getAllTsFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test' || entry.name === '__benchmarks__') continue;
        results.push(...getAllTsFiles(fullPath));
      } else if (entry.name.endsWith('.ts')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const AI_IMPORT_PATTERNS = [
    /import\s.*from\s+['"]openai['"]/,
    /import\s.*from\s+['"]@anthropic-ai/,
    /import\s.*from\s+['"]anthropic['"]/,
    /import\s.*from\s+['"]@google-ai/,
    /import\s.*from\s+['"]@azure\/openai['"]/,
    /import\s.*from\s+['"]langchain/,
    /import\s.*from\s+['"]llamaindex/,
    /import\s.*from\s+['"]@huggingface/,
    /require\s*\(\s*['"]openai['"]\s*\)/,
    /require\s*\(\s*['"]@anthropic-ai/,
    /require\s*\(\s*['"]langchain/,
  ];

  it('no source file imports AI/LLM libraries', () => {
    const files = getAllTsFiles(srcRoot);
    expect(files.length).toBeGreaterThan(0);

    const violations: { file: string; line: string }[] = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        for (const pattern of AI_IMPORT_PATTERNS) {
          if (pattern.test(line)) {
            violations.push({
              file: path.relative(srcRoot, filePath),
              line: line.trim(),
            });
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ─── Invariant 2: No Backend ────────────────────────────────────────────────

describe('Invariant 2: No backend — no network calls', () => {
  const srcRoot = path.resolve(__dirname, '..', 'src');

  function getAllTsFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip src/test/ — E2E tests are not production code
        if (entry.name === 'test' || entry.name === '__benchmarks__') continue;
        results.push(...getAllTsFiles(fullPath));
      } else if (entry.name.endsWith('.ts')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  // Files allowed to use child_process. All are Tier-1 local-tool delegation
  // (DR-004): the extension shells a locally-installed binary that owns its own
  // networking — the extension process makes zero outbound connections.
  //   - github / parking-lot / backlog / git-analyzer → `gh` + `git` CLI
  //   - epic-backfill → `claude -p` for AI epic proposal (DR-016, opt-in,
  //     degrades to a pure heuristic when `claude` is absent)
  const CHILD_PROCESS_ALLOWLIST = new Set([
    'lib/github.ts',
    'lib/parking-lot.ts',
    'lib/backlog.ts',
    'lib/git-analyzer.ts',
    'lib/epic-backfill.ts',
    // SPEC-022 / DR-034: approval capture of `git config user.email` for the FR-2
    // attributed record. Local, headless, no network — Tier-0 (the "no network
    // calls" invariant above still passes; this is git, not a backend). See
    // approval.ts gitConfigEmail.
    'lib/approval.ts',
    // DR-037 / #247: scaffold points the project's git `core.hooksPath` at
    // .minspec/hooks (via `git config --local core.hooksPath`) so the
    // editor-independent SDD hooks run on every commit. Local git config write —
    // no network, Tier-0. See scaffold.ts ensureHooksPath.
    'lib/scaffold.ts',
  ]);

  // Files allowed to *name* HTTP clients as detection data (not call them). They
  // make zero network calls; the bare-token patterns below (e.g. /\baxios\b/)
  // would false-positive on a data list. Real no-network coverage for these
  // files lives in constitution-invariants.test.ts (forbids fetch(/https/net/exec).
  //   - lib/constitution-context.ts → NETWORK_DEP_NAMES, used to detect a
  //     project's runtime HTTP clients for the constitution proposer (SPEC-025).
  const NETWORK_NAME_DATA_ALLOWLIST = new Set([
    'lib/constitution-context.ts',
  ]);

  const NETWORK_PATTERNS = [
    { pattern: /\bfetch\s*\(/, name: 'fetch()' },
    { pattern: /\baxios\b/, name: 'axios' },
    { pattern: /\bgot\s*\(/, name: 'got()' },
    { pattern: /\bhttp\.request\b/, name: 'http.request' },
    { pattern: /\bhttps\.request\b/, name: 'https.request' },
    { pattern: /\bhttp\.get\b/, name: 'http.get' },
    { pattern: /\bhttps\.get\b/, name: 'https.get' },
    { pattern: /import\s.*from\s+['"]node-fetch['"]/, name: 'node-fetch import' },
    { pattern: /import\s.*from\s+['"]axios['"]/, name: 'axios import' },
    { pattern: /import\s.*from\s+['"]got['"]/, name: 'got import' },
    { pattern: /import\s.*from\s+['"]undici['"]/, name: 'undici import' },
    { pattern: /require\s*\(\s*['"]node-fetch['"]\s*\)/, name: 'node-fetch require' },
    { pattern: /require\s*\(\s*['"]axios['"]\s*\)/, name: 'axios require' },
  ];

  it('no source file makes direct network calls (fetch, http, axios, got)', () => {
    const files = getAllTsFiles(srcRoot);
    expect(files.length).toBeGreaterThan(0);

    const violations: { file: string; call: string; line: string }[] = [];

    for (const filePath of files) {
      const relPath = path.relative(srcRoot, filePath);
      // Skip files that only *name* HTTP clients as data (see allowlist above).
      if (NETWORK_NAME_DATA_ALLOWLIST.has(relPath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        for (const { pattern, name } of NETWORK_PATTERNS) {
          if (pattern.test(line)) {
            violations.push({
              file: relPath,
              call: name,
              line: line.trim(),
            });
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('only allowlisted files use child_process (for gh CLI)', () => {
    const files = getAllTsFiles(srcRoot);
    const violations: string[] = [];

    for (const filePath of files) {
      const relPath = path.relative(srcRoot, filePath);
      const content = fs.readFileSync(filePath, 'utf-8');

      if (/import\s.*from\s+['"]child_process['"]/.test(content) ||
          /require\s*\(\s*['"]child_process['"]\s*\)/.test(content)) {
        if (!CHILD_PROCESS_ALLOWLIST.has(relPath)) {
          violations.push(relPath);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ─── Invariant 3: No Lock-in — Spec Kit Compatible ─────────────────────────

describe('Invariant 3: No lock-in — Spec Kit compatible format', () => {
  it('spec round-trips without proprietary required fields', () => {
    // Create a spec with MinSpec extensions
    const specContent = `---
id: SPEC-001
title: Add rate limiting
tier: T3
status: implementing
created: 2026-05-26
phases:
  specify: done
  clarify: skipped
  plan: done
  tasks: in-progress
  implement: pending
---

## Specify

Rate limiting at 100 req/min per IP.

## Plan

Use express-rate-limit middleware.

## Custom Section

User added content that should survive round-trips.
`;
    const parsed = parseSpec(specContent);
    const written = writeSpec(parsed);
    const reparsed = parseSpec(written);

    // Core Spec Kit fields preserved
    expect(reparsed.frontmatter.id).toBe('SPEC-001');
    expect(reparsed.frontmatter.title).toBe('Add rate limiting');

    // User content preserved
    expect(reparsed.sections.get('Custom Section')).toContain('User added content');
  });

  it('Spec Kit file (no MinSpec extensions) is readable with graceful defaults', () => {
    const specKitFile = `---
id: SK-100
title: Basic feature
---

## Requirements

Something important.
`;
    const parsed = parseSpec(specKitFile);

    // Required Spec Kit fields work
    expect(parsed.frontmatter.id).toBe('SK-100');
    expect(parsed.frontmatter.title).toBe('Basic feature');

    // MinSpec extensions get safe defaults — not errors
    expect(parsed.frontmatter.tier).toBe('T2');
    expect(parsed.frontmatter.status).toBe('new');
    expect(parsed.frontmatter.phases.specify).toBe('pending');
  });

  it('written spec has standard YAML frontmatter and ## markdown headings (not proprietary DSL)', () => {
    const parsed = parseSpec(`---
id: SPEC-042
title: Test feature
tier: T1
status: new
created: 2026-05-26
phases:
  specify: pending
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---

## Specify

Details here.
`);
    const written = writeSpec(parsed);

    // YAML frontmatter delimiters
    expect(written.startsWith('---\n')).toBe(true);
    expect(written).toMatch(/\n---\n/);

    // Standard markdown headings, not proprietary
    expect(written).toContain('## Specify');

    // Frontmatter uses plain key: value (parseable by any YAML parser)
    expect(written).toContain('id: SPEC-042');
    expect(written).toContain('title: Test feature');
  });

  it('MinSpec output has no proprietary required frontmatter keys beyond id and title', () => {
    // A Spec Kit consumer should ignore unknown keys. Verify our output
    // only REQUIRES id and title for valid parsing by other tools.
    const parsed = parseSpec(`---
id: SPEC-001
title: Test
tier: T2
status: new
created: 2026-01-01
phases:
  specify: pending
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---
`);
    const written = writeSpec(parsed);

    // Extract frontmatter
    const fmMatch = written.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();

    // Must have id and title (Spec Kit required fields)
    expect(fmMatch![1]).toContain('id: SPEC-001');
    expect(fmMatch![1]).toContain('title: Test');
  });
});

// ─── Invariant 4: Ceremony Proportional to Complexity ───────────────────────

describe('Invariant 4: Ceremony proportional to complexity', () => {
  function makeSignal(tier: 'T1' | 'T2' | 'T3' | 'T4'): ClassificationSignal {
    return { name: `signal_${tier}`, value: 1, weight: 1, tierContribution: tier };
  }

  it('T1 classification produces minimal phases (specify only)', () => {
    const result = classify([makeSignal('T1')], DEFAULT_CONFIG);
    expect(result.tier).toBe('T1');
    // T1 requires only 'specify'
    const required = DEFAULT_CONFIG.phaseMappings.T1.requiredPhases;
    expect(required).toEqual(['specify']);
    expect(result.suggestedPhases).toEqual(['specify']);
  });

  it('T2 adds plan to specify', () => {
    const result = classify([makeSignal('T2')], DEFAULT_CONFIG);
    expect(result.tier).toBe('T2');
    const mapping = DEFAULT_CONFIG.phaseMappings.T2;
    expect(mapping.requiredPhases).toContain('specify');
    expect(mapping.requiredPhases).toContain('plan');
    // Optional: clarify
    expect(result.suggestedPhases).toContain('specify');
    expect(result.suggestedPhases).toContain('plan');
  });

  it('T3 requires specify, plan, tasks, implement with optional clarify', () => {
    const result = classify([makeSignal('T3')], DEFAULT_CONFIG);
    expect(result.tier).toBe('T3');
    const mapping = DEFAULT_CONFIG.phaseMappings.T3;
    expect(mapping.requiredPhases).toEqual(['specify', 'plan', 'tasks', 'implement']);
    expect(mapping.optionalPhases).toEqual(['clarify']);
  });

  it('T4 produces all phases (maximum ceremony)', () => {
    const result = classify([makeSignal('T4')], DEFAULT_CONFIG);
    expect(result.tier).toBe('T4');
    const mapping = DEFAULT_CONFIG.phaseMappings.T4;
    expect(mapping.requiredPhases).toEqual(['specify', 'clarify', 'plan', 'tasks', 'implement']);
    expect(mapping.optionalPhases).toEqual([]);
    // All 5 phases required
    expect(result.suggestedPhases).toHaveLength(5);
  });

  it('T1 required phases < T4 required phases (strict ordering)', () => {
    const t1Count = DEFAULT_CONFIG.phaseMappings.T1.requiredPhases.length;
    const t2Count = DEFAULT_CONFIG.phaseMappings.T2.requiredPhases.length;
    const t3Count = DEFAULT_CONFIG.phaseMappings.T3.requiredPhases.length;
    const t4Count = DEFAULT_CONFIG.phaseMappings.T4.requiredPhases.length;

    expect(t1Count).toBeLessThan(t2Count);
    expect(t2Count).toBeLessThan(t3Count);
    expect(t3Count).toBeLessThanOrEqual(t4Count);
  });
});

// ─── Invariant 5: User Override Always Wins ─────────────────────────────────

describe('Invariant 5: User override always wins', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-inv5-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSignal(tier: 'T1' | 'T2' | 'T3' | 'T4'): ClassificationSignal {
    return { name: `signal_${tier}`, value: 1, weight: 1, tierContribution: tier };
  }

  it('classifier result can be overridden to any tier', () => {
    const original = classify([makeSignal('T3')], DEFAULT_CONFIG);
    expect(original.tier).toBe('T3');

    // Override to T1
    const overridden = overrideClassification(original, 'T1', DEFAULT_CONFIG);
    expect(overridden.tier).toBe('T1');
    expect(overridden.overriddenBy).toBe('user');
  });

  it('override updates suggested phases to match new tier', () => {
    const original = classify([makeSignal('T1')], DEFAULT_CONFIG);
    const overridden = overrideClassification(original, 'T4', DEFAULT_CONFIG);

    // Phases should match T4, not T1
    const t4Phases = [
      ...DEFAULT_CONFIG.phaseMappings.T4.requiredPhases,
      ...DEFAULT_CONFIG.phaseMappings.T4.optionalPhases,
    ];
    expect(overridden.suggestedPhases).toEqual(t4Phases);
  });

  it('override persists in calibration data', () => {
    const calibration = recordOverride(tmpDir, 'T3', 'T1', ['signal_T3']);

    expect(calibration.overrides).toHaveLength(1);
    expect(calibration.overrides[0].originalTier).toBe('T3');
    expect(calibration.overrides[0].overriddenTier).toBe('T1');
    expect(calibration.overrides[0].signals).toEqual(['signal_T3']);

    // Reload from disk — should persist
    const reloaded = loadCalibration(tmpDir);
    expect(reloaded.overrides).toHaveLength(1);
    expect(reloaded.overrides[0].overriddenTier).toBe('T1');
  });

  it('multiple overrides accumulate and persist', () => {
    recordOverride(tmpDir, 'T3', 'T1', ['a']);
    recordOverride(tmpDir, 'T2', 'T4', ['b']);
    recordOverride(tmpDir, 'T4', 'T2', ['c']);

    const loaded = loadCalibration(tmpDir);
    expect(loaded.overrides).toHaveLength(3);
  });
});

// ─── Invariant 6: Harness Regeneration Preserves User Edits ────────────────

describe('Invariant 6: Harness file regeneration preserves user edits', () => {
  it('merge-refresh preserves user-modified sections', () => {
    const original = `## Setup

Generated setup instructions.

## Usage

Generated usage guide.

## FAQ

Generated FAQ.
`;
    const originalSections = parseSections(original);
    const originalHashes = buildSectionHashes(originalSections);

    // User edits the Usage section
    const userEdited = `## Setup

Generated setup instructions.

## Usage

My custom usage notes that I spent time writing.

## FAQ

Generated FAQ.
`;

    // New template has updated Setup and FAQ but same structure
    const newTemplate = `## Setup

Updated setup instructions v2.

## Usage

New generated usage guide v2.

## FAQ

Updated FAQ v2.
`;

    const result = mergeFile(userEdited, newTemplate, originalHashes);

    // User-modified section (Usage) should be PRESERVED
    expect(result.merged).toContain('My custom usage notes that I spent time writing');

    // Unmodified sections (Setup, FAQ) should be UPDATED from template
    expect(result.merged).toContain('Updated setup instructions v2');
    expect(result.merged).toContain('Updated FAQ v2');

    // New template content for Usage should NOT appear (user edit wins)
    expect(result.merged).not.toContain('New generated usage guide v2');
  });

  it('merge-refresh adds new sections from template', () => {
    const existing = `## Setup

Existing setup.
`;
    const generated = `## Setup

Existing setup.

## New Section

Brand new content.
`;
    const hashes = buildSectionHashes(parseSections(existing));
    const result = mergeFile(existing, generated, hashes);

    expect(result.merged).toContain('## New Section');
    expect(result.merged).toContain('Brand new content');
  });

  it('merge-refresh preserves user-added sections not in template', () => {
    const existing = `## Setup

Setup content.

## My Custom Notes

These are my personal notes.
`;
    const generated = `## Setup

Updated setup.
`;
    const hashes = buildSectionHashes(parseSections(existing));

    // Simulate the user-edited existing where Setup was NOT modified
    // (hash matches), so Setup gets updated, but My Custom Notes stays
    const result = mergeFile(existing, generated, hashes);

    expect(result.merged).toContain('## My Custom Notes');
    expect(result.merged).toContain('These are my personal notes');
  });

  it('section hashing is deterministic', () => {
    const content = 'Same content for hashing';
    const hash1 = hashSection(content);
    const hash2 = hashSection(content);
    expect(hash1).toBe(hash2);
    // Different content produces different hash
    expect(hashSection('Different content')).not.toBe(hash1);
  });
});
