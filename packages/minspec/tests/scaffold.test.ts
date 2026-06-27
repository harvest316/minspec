/**
 * T1 — Contract Tests: Scaffold
 *
 * Tests generateHarnessFiles() and refreshHarnessFiles() from src/lib/scaffold.ts.
 * Uses real filesystem (temp directories) — no mocking.
 *
 * scaffold() is already tested in init.test.ts; these tests cover the
 * uncovered lines in generateHarnessFiles and refreshHarnessFiles.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { generateHarnessFiles, refreshHarnessFiles } from '../src/lib/scaffold';
import { TEMPLATE_NAMES, TEMPLATE_OUTPUT_PATHS } from '../src/lib/template-registry';
import { loadHashes } from '../src/lib/merge-refresh';

describe('generateHarnessFiles()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-scaffold-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates all harness files from templates', () => {
    generateHarnessFiles(tmpDir);

    for (const name of TEMPLATE_NAMES) {
      const relativePath = TEMPLATE_OUTPUT_PATHS[name];
      const fullPath = path.join(tmpDir, relativePath);
      expect(fs.existsSync(fullPath), `expected ${relativePath} to exist`).toBe(true);
      const content = fs.readFileSync(fullPath, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it('creates .minspec/config.json', () => {
    generateHarnessFiles(tmpDir);
    const configPath = path.join(tmpDir, '.minspec', 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('stores section hashes in generated-hashes.json', () => {
    generateHarnessFiles(tmpDir);
    const hashes = loadHashes(tmpDir);

    // There should be hash entries for each template output path
    for (const name of TEMPLATE_NAMES) {
      const relativePath = TEMPLATE_OUTPUT_PATHS[name];
      expect(hashes[relativePath], `expected hashes for ${relativePath}`).toBeDefined();
      // Each file should have at least one section hash
      expect(Object.keys(hashes[relativePath]).length).toBeGreaterThan(0);
    }
  });

  it('does not overwrite existing harness files', () => {
    generateHarnessFiles(tmpDir);

    // Modify one of the generated files
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const customContent = '# Custom content - do not overwrite\n';
    fs.writeFileSync(claudePath, customContent);

    // Re-run generate
    generateHarnessFiles(tmpDir);

    // Custom content should be preserved
    const content = fs.readFileSync(claudePath, 'utf-8');
    expect(content).toBe(customContent);
  });

  it('uses project directory name as projectName in templates', () => {
    generateHarnessFiles(tmpDir);

    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const content = fs.readFileSync(claudePath, 'utf-8');
    const dirName = path.basename(tmpDir);
    expect(content).toContain(dirName);
  });

  it('uses package.json name when available', () => {
    // Create a package.json with a project name
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'my-awesome-project' }),
    );

    generateHarnessFiles(tmpDir);

    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const content = fs.readFileSync(claudePath, 'utf-8');
    expect(content).toContain('my-awesome-project');
  });

  it('is idempotent — second call does not duplicate or corrupt files', () => {
    generateHarnessFiles(tmpDir);
    const firstHashes = loadHashes(tmpDir);

    generateHarnessFiles(tmpDir);
    const secondHashes = loadHashes(tmpDir);

    // Hashes should be identical
    expect(secondHashes).toEqual(firstHashes);
  });
});

describe('refreshHarnessFiles()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-refresh-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates harness files when none exist (same as generate)', () => {
    refreshHarnessFiles(tmpDir);

    for (const name of TEMPLATE_NAMES) {
      const relativePath = TEMPLATE_OUTPUT_PATHS[name];
      const fullPath = path.join(tmpDir, relativePath);
      expect(fs.existsSync(fullPath), `expected ${relativePath} to exist`).toBe(true);
    }
  });

  it('preserves user-modified sections on refresh', () => {
    // First, generate the files
    generateHarnessFiles(tmpDir);

    // Modify a section in CLAUDE.md
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    let content = fs.readFileSync(claudePath, 'utf-8');

    // Replace the "Overview" section body with custom content
    content = content.replace(
      /## Overview\n[\s\S]*?(?=## )/,
      '## Overview\n\nMy custom overview that I wrote myself.\n\n',
    );
    fs.writeFileSync(claudePath, content);

    // Now refresh
    refreshHarnessFiles(tmpDir);

    // User-modified section should be preserved
    const refreshed = fs.readFileSync(claudePath, 'utf-8');
    expect(refreshed).toContain('My custom overview that I wrote myself.');
  });

  it('updates unmodified sections from new template on refresh', () => {
    // Generate files
    generateHarnessFiles(tmpDir);

    // Read original content to compare
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const originalContent = fs.readFileSync(claudePath, 'utf-8');

    // Refresh without modifying anything — should re-render templates
    refreshHarnessFiles(tmpDir);

    const refreshedContent = fs.readFileSync(claudePath, 'utf-8');
    // Content should be structurally the same (unmodified sections get template version)
    expect(refreshedContent.length).toBeGreaterThan(0);
    // The file should still have the same key sections
    expect(refreshedContent).toContain('## Overview');
    expect(refreshedContent).toContain('## Invariants');
  });

  it('stores updated hashes after refresh', () => {
    generateHarnessFiles(tmpDir);
    const hashesBeforeRefresh = loadHashes(tmpDir);

    refreshHarnessFiles(tmpDir);
    const hashesAfterRefresh = loadHashes(tmpDir);

    // All template files should have hash entries
    for (const name of TEMPLATE_NAMES) {
      const relativePath = TEMPLATE_OUTPUT_PATHS[name];
      expect(hashesAfterRefresh[relativePath]).toBeDefined();
    }
  });

  it('handles missing file during refresh (creates fresh copy)', () => {
    // Generate files first
    generateHarnessFiles(tmpDir);

    // Delete one of the generated files
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    fs.unlinkSync(agentsPath);
    expect(fs.existsSync(agentsPath)).toBe(false);

    // Refresh — should recreate the missing file
    refreshHarnessFiles(tmpDir);
    expect(fs.existsSync(agentsPath)).toBe(true);

    const content = fs.readFileSync(agentsPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('Agent Instructions');
  });

  it('preserves user-added sections not in template', () => {
    // Generate files
    generateHarnessFiles(tmpDir);

    // Add a custom section to CLAUDE.md
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    let content = fs.readFileSync(claudePath, 'utf-8');
    content += '\n## My Custom Section\n\nThis is a section I added manually.\n';
    fs.writeFileSync(claudePath, content);

    // Refresh
    refreshHarnessFiles(tmpDir);

    const refreshed = fs.readFileSync(claudePath, 'utf-8');
    expect(refreshed).toContain('## My Custom Section');
    expect(refreshed).toContain('This is a section I added manually.');
  });
});

/**
 * Regression (#206): init must NOT scaffold an empty DESIGN.md stub. A
 * split-layout design doc is a T3+ Plan-phase artifact created when planning
 * starts, not a harness template. The empty stub it used to emit had no
 * frontmatter and would be flagged by the project's own brownfield gap-audit
 * (#205) — and, being a managed template, refresh resurrected it after deletion.
 * Invariant: fresh init has no self-flagged DESIGN.md, and refresh never
 * resurrects it.
 */
describe('#206 — DESIGN.md is not a harness template', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-design-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fresh init does not scaffold DESIGN.md', () => {
    generateHarnessFiles(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'DESIGN.md'))).toBe(false);
  });

  it('refresh does not resurrect a user-deleted DESIGN.md', () => {
    generateHarnessFiles(tmpDir);
    // Even if a DESIGN.md existed and the user removed it, refresh must leave it gone.
    expect(fs.existsSync(path.join(tmpDir, 'DESIGN.md'))).toBe(false);

    refreshHarnessFiles(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'DESIGN.md'))).toBe(false);
  });

  it('DESIGN.md is absent from the recorded harness hashes', () => {
    generateHarnessFiles(tmpDir);
    const hashes = loadHashes(tmpDir);
    expect(hashes['DESIGN.md']).toBeUndefined();
  });
});
