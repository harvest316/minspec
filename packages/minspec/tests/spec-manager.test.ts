import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createSpec,
  listSpecs,
  getSpec,
  transitionPhase,
  archiveSpecById,
  deleteSpec,
  slugify,
  nextSpecId,
  migrateLayout,
} from '../src/lib/spec-manager';
import { parseSpec } from '../src/lib/spec';
import type { MinspecConfig, SpecsLayout } from '../src/lib/config';
import { DEFAULT_CONFIG } from '../src/lib/config';

/** Create a temporary project directory with .minspec/config.json */
function makeTmpProject(layout: SpecsLayout = 'flat'): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-manager-test-'));
  const minspecDir = path.join(tmpDir, '.minspec');
  fs.mkdirSync(minspecDir, { recursive: true });
  const config: MinspecConfig = { ...DEFAULT_CONFIG, specsLayout: layout };
  fs.writeFileSync(
    path.join(minspecDir, 'config.json'),
    JSON.stringify(config, null, 2),
  );
  return tmpDir;
}

/** Write a raw spec file into the specs directory */
function writeRawSpec(rootDir: string, fileName: string, content: string): string {
  const specsDir = path.join(rootDir, DEFAULT_CONFIG.specsDir);
  fs.mkdirSync(specsDir, { recursive: true });
  const filePath = path.join(specsDir, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('slugify()', () => {
  it('converts title to lowercase hyphenated slug', () => {
    expect(slugify('Add Rate Limiting')).toBe('add-rate-limiting');
  });

  it('replaces non-alphanumeric characters with hyphens', () => {
    expect(slugify('Fix login/redirect (bug #42)')).toBe('fix-login-redirect-bug-42');
  });

  it('collapses multiple hyphens', () => {
    expect(slugify('Too   many    spaces')).toBe('too-many-spaces');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--leading and trailing--')).toBe('leading-and-trailing');
  });

  it('truncates to 50 chars max', () => {
    const longTitle = 'This is a very long title that should definitely be truncated to fifty chars';
    const slug = slugify(longTitle);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug).not.toMatch(/-$/);
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('handles all-special-char string', () => {
    expect(slugify('!!!@@@###')).toBe('');
  });
});

describe('nextSpecId()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-id-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns SPEC-001 for empty directory', () => {
    expect(nextSpecId(tmpDir)).toBe('SPEC-001');
  });

  it('returns SPEC-001 for non-existent directory', () => {
    expect(nextSpecId(path.join(tmpDir, 'nonexistent'))).toBe('SPEC-001');
  });

  it('returns next sequential ID', () => {
    fs.writeFileSync(path.join(tmpDir, 'SPEC-001-something.md'), '');
    fs.writeFileSync(path.join(tmpDir, 'SPEC-003-another.md'), '');
    expect(nextSpecId(tmpDir)).toBe('SPEC-004');
  });

  it('ignores non-spec files', () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '');
    fs.writeFileSync(path.join(tmpDir, 'SPEC-002-thing.md'), '');
    expect(nextSpecId(tmpDir)).toBe('SPEC-003');
  });
});

/**
 * T3 regression for #57 — `nextSpecId()` naive global max+1 breaks per-product
 * ranges. Two products share one specs/ tree (real nested layout:
 * specs/<product>/<feature>/requirements.md). A new spec for product A must draw
 * from A's own block, NOT from the global max — otherwise a higher-numbered
 * product-B id pushes the next A id out of A's block (the in-tree symptom:
 * agent-execute SPEC-016 landed between minspec SPEC-015 and SPEC-017).
 */
describe('nextSpecId() per-product scoping (#57)', () => {
  let specsDir: string;

  /** Write a nested spec at specs/<product>/<feature>/requirements.md. */
  function writeNestedSpec(product: string, feature: string, id: string): void {
    const dir = path.join(specsDir, product, feature);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'requirements.md'),
      `---\nid: ${id}\ntitle: ${feature}\ntier: T2\nstatus: new\ncreated: 2026-01-01\nproduct: ${product}\nphases:\n  specify: pending\n  clarify: pending\n  plan: pending\n  tasks: pending\n  implement: pending\n---\n\n# ${feature}\n`,
      'utf-8',
    );
  }

  beforeEach(() => {
    specsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-id-product-test-'));
  });

  afterEach(() => {
    fs.rmSync(specsDir, { recursive: true, force: true });
  });

  it('scopes the next id to the target product, not the global max', () => {
    // minspec owns 015 + 017; agent-execute owns the interleaved 016.
    writeNestedSpec('minspec', 'status-lanes', 'SPEC-015');
    writeNestedSpec('agent-execute', 'reality-check', 'SPEC-016');
    writeNestedSpec('minspec', 'trust-dashboard', 'SPEC-017');

    // Bug: global max+1 → SPEC-018 regardless of product.
    // Fixed: next minspec id continues minspec's own block (max minspec = 017).
    expect(nextSpecId(specsDir, 'minspec')).toBe('SPEC-018');
    // And agent-execute draws from ITS block (max agent-execute = 016),
    // NOT from the global max — independent ranges.
    expect(nextSpecId(specsDir, 'agent-execute')).toBe('SPEC-017');
  });

  it('gives each product an independent range (no interleave collision)', () => {
    // Product A in the low block, product B already pushed into a high block.
    writeNestedSpec('minspec', 'a-one', 'SPEC-001');
    writeNestedSpec('minspec', 'a-two', 'SPEC-002');
    writeNestedSpec('scroogellm', 'b-one', 'SPEC-100');
    writeNestedSpec('scroogellm', 'b-two', 'SPEC-101');

    // minspec's next stays in minspec's block — unaffected by scrooge's 1xx ids.
    expect(nextSpecId(specsDir, 'minspec')).toBe('SPEC-003');
    // scrooge continues its own 1xx block.
    expect(nextSpecId(specsDir, 'scroogellm')).toBe('SPEC-102');
  });

  it('returns the product block start when the product has no specs yet', () => {
    writeNestedSpec('minspec', 'a-one', 'SPEC-009');
    // A brand-new product shares the tree but owns nothing yet → SPEC-001.
    expect(nextSpecId(specsDir, 'agent-execute')).toBe('SPEC-001');
  });

  it('falls back to global max when no product is given (back-compat)', () => {
    writeNestedSpec('minspec', 'a-one', 'SPEC-005');
    writeNestedSpec('scroogellm', 'b-one', 'SPEC-100');
    // Unscoped call keeps the original global-counter contract.
    expect(nextSpecId(specsDir)).toBe('SPEC-101');
  });
});

describe('createSpec()', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = makeTmpProject();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('creates a spec file with auto-generated ID', () => {
    const summary = createSpec(rootDir, 'Add rate limiting');
    expect(summary.id).toBe('SPEC-001');
    expect(summary.title).toBe('Add rate limiting');
    expect(summary.tier).toBe('T2');
    expect(summary.status).toBe('new');
    expect(fs.existsSync(summary.filePath)).toBe(true);
  });

  it('creates file with correct slug in name', () => {
    const summary = createSpec(rootDir, 'Fix Login Redirect Bug');
    expect(path.basename(summary.filePath)).toBe('SPEC-001-fix-login-redirect-bug.md');
  });

  it('respects tier parameter', () => {
    const summary = createSpec(rootDir, 'Complex migration', 'T4');
    expect(summary.tier).toBe('T4');

    const content = fs.readFileSync(summary.filePath, 'utf-8');
    const parsed = parseSpec(content);
    expect(parsed.frontmatter.tier).toBe('T4');
  });

  it('generates sequential IDs', () => {
    const s1 = createSpec(rootDir, 'First spec');
    const s2 = createSpec(rootDir, 'Second spec');
    const s3 = createSpec(rootDir, 'Third spec');
    expect(s1.id).toBe('SPEC-001');
    expect(s2.id).toBe('SPEC-002');
    expect(s3.id).toBe('SPEC-003');
  });

  it('continues numbering from existing specs', () => {
    writeRawSpec(rootDir, 'SPEC-005-existing.md', `---
id: SPEC-005
title: Existing spec
tier: T1
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

    const summary = createSpec(rootDir, 'New spec');
    expect(summary.id).toBe('SPEC-006');
  });

  it('creates specs directory if it does not exist', () => {
    const specsDir = path.join(rootDir, DEFAULT_CONFIG.specsDir);
    expect(fs.existsSync(specsDir)).toBe(false);

    createSpec(rootDir, 'First spec');
    expect(fs.existsSync(specsDir)).toBe(true);
  });

  it('file content has valid frontmatter and phase sections', () => {
    const summary = createSpec(rootDir, 'Test spec', 'T1');
    const content = fs.readFileSync(summary.filePath, 'utf-8');
    const parsed = parseSpec(content);

    expect(parsed.frontmatter.id).toBe('SPEC-001');
    expect(parsed.frontmatter.title).toBe('Test spec');
    expect(parsed.frontmatter.tier).toBe('T1');
    expect(parsed.frontmatter.status).toBe('new');
    expect(parsed.frontmatter.phases.specify).toBe('pending');
    expect(parsed.frontmatter.phases.implement).toBe('pending');

    // T1 only requires specify
    expect(parsed.sections.has('Specify')).toBe(true);
  });

  it('T4 spec includes all phase sections', () => {
    const summary = createSpec(rootDir, 'Complex task', 'T4');
    const content = fs.readFileSync(summary.filePath, 'utf-8');
    const parsed = parseSpec(content);

    expect(parsed.sections.has('Specify')).toBe(true);
    expect(parsed.sections.has('Clarify')).toBe(true);
    expect(parsed.sections.has('Plan')).toBe(true);
    expect(parsed.sections.has('Tasks')).toBe(true);
    expect(parsed.sections.has('Implement')).toBe(true);
  });
});

describe('listSpecs()', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = makeTmpProject();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns empty array when no specs exist', () => {
    expect(listSpecs(rootDir)).toEqual([]);
  });

  it('lists all specs', () => {
    createSpec(rootDir, 'First');
    createSpec(rootDir, 'Second');
    createSpec(rootDir, 'Third');

    const specs = listSpecs(rootDir);
    expect(specs).toHaveLength(3);
    expect(specs[0].id).toBe('SPEC-001');
    expect(specs[1].id).toBe('SPEC-002');
    expect(specs[2].id).toBe('SPEC-003');
  });

  it('filters by status', () => {
    createSpec(rootDir, 'New spec');

    const s2 = createSpec(rootDir, 'Active spec');
    transitionPhase(rootDir, s2.id, 'advance');

    const newSpecs = listSpecs(rootDir, { status: 'new' });
    expect(newSpecs).toHaveLength(1);
    expect(newSpecs[0].id).toBe('SPEC-001');

    const specifyingSpecs = listSpecs(rootDir, { status: 'specifying' });
    expect(specifyingSpecs).toHaveLength(1);
    expect(specifyingSpecs[0].id).toBe('SPEC-002');
  });

  it('filters by tier', () => {
    createSpec(rootDir, 'Simple fix', 'T1');
    createSpec(rootDir, 'Medium task', 'T2');
    createSpec(rootDir, 'Complex task', 'T3');

    const t1Specs = listSpecs(rootDir, { tier: 'T1' });
    expect(t1Specs).toHaveLength(1);
    expect(t1Specs[0].title).toBe('Simple fix');
  });

  it('filters by status and tier combined', () => {
    createSpec(rootDir, 'T1 new', 'T1');
    createSpec(rootDir, 'T2 new', 'T2');

    const results = listSpecs(rootDir, { status: 'new', tier: 'T1' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('T1 new');
  });

  it('ignores non-spec files in specs directory', () => {
    createSpec(rootDir, 'Real spec');

    const specsDir = path.join(rootDir, DEFAULT_CONFIG.specsDir);
    fs.writeFileSync(path.join(specsDir, 'README.md'), '# Readme\n');

    const specs = listSpecs(rootDir);
    expect(specs).toHaveLength(1);
  });
});

describe('getSpec()', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = makeTmpProject();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns null for non-existent spec', () => {
    expect(getSpec(rootDir, 'SPEC-999')).toBeNull();
  });

  it('returns full detail for existing spec', () => {
    createSpec(rootDir, 'Test spec', 'T2');

    const detail = getSpec(rootDir, 'SPEC-001');
    expect(detail).not.toBeNull();
    expect(detail!.summary.id).toBe('SPEC-001');
    expect(detail!.summary.title).toBe('Test spec');
    expect(detail!.summary.tier).toBe('T2');
    expect(detail!.content).toContain('id: SPEC-001');
    // Phases is a record, all pending
    expect(detail!.phases.specify).toBe('pending');
    expect(detail!.phases.clarify).toBe('pending');
    expect(detail!.phases.plan).toBe('pending');
    expect(detail!.phases.tasks).toBe('pending');
    expect(detail!.phases.implement).toBe('pending');
  });
});

describe('transitionPhase()', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = makeTmpProject();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns failure for non-existent spec', () => {
    const result = transitionPhase(rootDir, 'SPEC-999', 'advance');
    expect(result.success).toBe(false);
    expect(result.warning).toContain('not found');
  });

  it('advances from first pending phase', () => {
    createSpec(rootDir, 'Test spec');

    // Advance: specify pending → in-progress (start)
    const result = transitionPhase(rootDir, 'SPEC-001', 'advance');
    expect(result.success).toBe(true);

    // Verify persisted — specify should now be in-progress
    const detail = getSpec(rootDir, 'SPEC-001');
    expect(detail).not.toBeNull();
    expect(detail!.phases.specify).toBe('in-progress');
  });

  it('completes a phase on second advance', () => {
    createSpec(rootDir, 'Test spec');

    // First advance: specify pending → in-progress
    transitionPhase(rootDir, 'SPEC-001', 'advance');
    // Second advance: specify in-progress → done, clarify → in-progress
    transitionPhase(rootDir, 'SPEC-001', 'advance');

    const detail = getSpec(rootDir, 'SPEC-001');
    expect(detail!.phases.specify).toBe('done');
    expect(detail!.phases.clarify).toBe('in-progress');
  });

  it('updates spec status when advancing phases', () => {
    createSpec(rootDir, 'Test spec');

    // Start specify
    transitionPhase(rootDir, 'SPEC-001', 'advance');
    let detail = getSpec(rootDir, 'SPEC-001');
    expect(detail!.summary.status).toBe('specifying');

    // Complete specify, start clarify
    transitionPhase(rootDir, 'SPEC-001', 'advance');
    detail = getSpec(rootDir, 'SPEC-001');
    expect(detail!.summary.status).toBe('specifying'); // clarify is still specifying

    // Complete clarify, start plan
    transitionPhase(rootDir, 'SPEC-001', 'advance');
    detail = getSpec(rootDir, 'SPEC-001');
    expect(detail!.summary.status).toBe('implementing'); // plan = implementing
  });

  it('skips a phase', () => {
    createSpec(rootDir, 'Test spec');

    const result = transitionPhase(rootDir, 'SPEC-001', 'skip', 'Not needed');
    expect(result.success).toBe(true);

    const detail = getSpec(rootDir, 'SPEC-001');
    expect(detail!.phases.specify).toBe('skipped');
    // clarify should now be in-progress (next phase started)
    expect(detail!.phases.clarify).toBe('in-progress');
  });

  it('goes back to current phase (reopens as in-progress)', () => {
    createSpec(rootDir, 'Test spec');

    // Start specify
    transitionPhase(rootDir, 'SPEC-001', 'advance');
    // Complete specify, start clarify
    transitionPhase(rootDir, 'SPEC-001', 'advance');

    // Go back on clarify — reopens clarify as in-progress, downstream reset
    const result = transitionPhase(rootDir, 'SPEC-001', 'back', 'Need to revisit');
    expect(result.success).toBe(true);

    const detail = getSpec(rootDir, 'SPEC-001');
    expect(detail!.phases.clarify).toBe('in-progress');
    expect(detail!.phases.plan).toBe('pending');
  });

  it('returns failure when no active phase to transition', () => {
    createSpec(rootDir, 'Test spec');

    // Advance all 10 times (start + complete for 5 phases)
    for (let i = 0; i < 10; i++) {
      transitionPhase(rootDir, 'SPEC-001', 'advance');
    }

    const result = transitionPhase(rootDir, 'SPEC-001', 'advance');
    expect(result.success).toBe(false);
    expect(result.warning).toContain('No active phase');
  });

  it('persists status change to done when all phases complete', () => {
    createSpec(rootDir, 'Test spec');

    // Start and complete all 5 phases (10 advances: start + complete each)
    for (let i = 0; i < 10; i++) {
      transitionPhase(rootDir, 'SPEC-001', 'advance');
    }

    const detail = getSpec(rootDir, 'SPEC-001');
    expect(detail!.summary.status).toBe('done');
  });
});

describe('archiveSpecById()', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = makeTmpProject();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns failure for non-existent spec', () => {
    const result = archiveSpecById(rootDir, 'SPEC-999');
    expect(result.success).toBe(false);
    expect(result.warning).toContain('not found');
  });

  it('archives a new spec', () => {
    createSpec(rootDir, 'Test spec');

    const result = archiveSpecById(rootDir, 'SPEC-001');
    expect(result.success).toBe(true);

    const detail = getSpec(rootDir, 'SPEC-001');
    expect(detail!.summary.status).toBe('archived');
  });

  it('archives a partially-completed spec', () => {
    createSpec(rootDir, 'Test spec');

    // Start and complete specify
    transitionPhase(rootDir, 'SPEC-001', 'advance');
    transitionPhase(rootDir, 'SPEC-001', 'advance');

    archiveSpecById(rootDir, 'SPEC-001');

    const detail = getSpec(rootDir, 'SPEC-001');
    expect(detail!.summary.status).toBe('archived');
    // specify was done — preserved
    expect(detail!.phases.specify).toBe('done');
  });
});

describe('deleteSpec()', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = makeTmpProject();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns false when confirm is false (safety check)', () => {
    createSpec(rootDir, 'Test spec');
    const result = deleteSpec(rootDir, 'SPEC-001', false);
    expect(result).toBe(false);

    const detail = getSpec(rootDir, 'SPEC-001');
    expect(detail).not.toBeNull();
  });

  it('returns false for non-existent spec even with confirm=true', () => {
    const result = deleteSpec(rootDir, 'SPEC-999', true);
    expect(result).toBe(false);
  });

  it('deletes spec file when confirm is true', () => {
    const summary = createSpec(rootDir, 'Test spec');
    expect(fs.existsSync(summary.filePath)).toBe(true);

    const result = deleteSpec(rootDir, 'SPEC-001', true);
    expect(result).toBe(true);
    expect(fs.existsSync(summary.filePath)).toBe(false);
  });

  it('deleted spec no longer appears in list', () => {
    createSpec(rootDir, 'First');
    createSpec(rootDir, 'Second');

    deleteSpec(rootDir, 'SPEC-001', true);

    const specs = listSpecs(rootDir);
    expect(specs).toHaveLength(1);
    expect(specs[0].id).toBe('SPEC-002');
  });
});

describe('ID collision prevention', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = makeTmpProject();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('skips deleted IDs (uses max, not count)', () => {
    createSpec(rootDir, 'First');
    createSpec(rootDir, 'Second');
    createSpec(rootDir, 'Third');

    deleteSpec(rootDir, 'SPEC-002', true);

    const summary = createSpec(rootDir, 'Fourth');
    expect(summary.id).toBe('SPEC-004');
  });

  it('handles gaps in numbering correctly', () => {
    writeRawSpec(rootDir, 'SPEC-010-something.md', `---
id: SPEC-010
title: Tenth spec
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

    const summary = createSpec(rootDir, 'After gap');
    expect(summary.id).toBe('SPEC-011');
  });
});

// --- spec-kit layout ----------------------------------------------------

describe('spec-kit layout — createSpec', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = makeTmpProject('spec-kit');
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('creates a NNN-slug/ directory instead of a flat file', () => {
    const summary = createSpec(rootDir, 'Add OAuth login', 'T3');
    expect(summary.id).toBe('SPEC-001');

    const specsDir = path.join(rootDir, DEFAULT_CONFIG.specsDir);
    const dirPath = path.join(specsDir, '001-add-oauth-login');
    expect(fs.statSync(dirPath).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dirPath, 'spec.md'))).toBe(true);
  });

  it('SpecSummary.filePath points to spec.md inside the dir', () => {
    const summary = createSpec(rootDir, 'Another feature');
    expect(summary.filePath.endsWith(path.join('001-another-feature', 'spec.md'))).toBe(true);
  });

  it('listSpecs surfaces spec-kit specs', () => {
    createSpec(rootDir, 'First');
    createSpec(rootDir, 'Second');
    const specs = listSpecs(rootDir);
    expect(specs).toHaveLength(2);
    expect(specs[0].id).toBe('SPEC-001');
    expect(specs[1].id).toBe('SPEC-002');
  });

  it('listSpecs reads flat + spec-kit side by side (mixed project)', () => {
    // Create a spec in spec-kit layout (current config)
    createSpec(rootDir, 'New kit spec');

    // Drop a flat file manually
    const specsDir = path.join(rootDir, DEFAULT_CONFIG.specsDir);
    fs.writeFileSync(
      path.join(specsDir, 'SPEC-002-legacy.md'),
      `---
id: SPEC-002
title: Legacy flat spec
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
`,
    );

    const specs = listSpecs(rootDir);
    expect(specs).toHaveLength(2);
    const ids = specs.map(s => s.id).sort();
    expect(ids).toEqual(['SPEC-001', 'SPEC-002']);
  });

  it('nextSpecId considers both flat files and spec-kit dirs', () => {
    const specsDir = path.join(rootDir, DEFAULT_CONFIG.specsDir);
    fs.mkdirSync(specsDir, { recursive: true });
    // Mixed: flat SPEC-001 + dir 002-foo
    fs.writeFileSync(path.join(specsDir, 'SPEC-001-x.md'), '');
    fs.mkdirSync(path.join(specsDir, '002-foo'), { recursive: true });

    expect(nextSpecId(specsDir)).toBe('SPEC-003');
  });

  it('transitionPhase persists state inside spec-kit dir', () => {
    createSpec(rootDir, 'Test spec');

    transitionPhase(rootDir, 'SPEC-001', 'advance');
    const detail = getSpec(rootDir, 'SPEC-001');
    expect(detail?.phases.specify).toBe('in-progress');

    // Verify on disk: spec.md frontmatter shows in-progress
    const specMd = fs.readFileSync(detail!.summary.filePath, 'utf-8');
    expect(specMd).toContain('specify: in-progress');
  });

  it('archiveSpecById works on spec-kit specs', () => {
    createSpec(rootDir, 'Archivable');
    const result = archiveSpecById(rootDir, 'SPEC-001');
    expect(result.success).toBe(true);
    const detail = getSpec(rootDir, 'SPEC-001');
    expect(detail?.summary.status).toBe('archived');
  });

  it('deleteSpec removes the whole directory', () => {
    const summary = createSpec(rootDir, 'Deletable');
    const dirPath = path.dirname(summary.filePath);
    expect(fs.existsSync(dirPath)).toBe(true);

    const ok = deleteSpec(rootDir, 'SPEC-001', true);
    expect(ok).toBe(true);
    expect(fs.existsSync(dirPath)).toBe(false);
  });
});

// --- migration: invariant: no data loss --------------------------------

describe('migrateLayout()', () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('migrates flat → spec-kit losslessly (T0 invariant)', () => {
    rootDir = makeTmpProject('flat');
    const s1 = createSpec(rootDir, 'Feature one', 'T3');
    const s2 = createSpec(rootDir, 'Feature two', 'T1');

    // Snapshot canonical content before
    const before1 = fs.readFileSync(s1.filePath, 'utf-8');
    const before2 = fs.readFileSync(s2.filePath, 'utf-8');
    const beforeFm1 = parseSpec(before1).frontmatter;
    const beforeFm2 = parseSpec(before2).frontmatter;

    const result = migrateLayout(rootDir, 'spec-kit');
    expect(result.success).toBe(true);
    expect(result.migrated).toBe(2);

    // Flat files are gone
    expect(fs.existsSync(s1.filePath)).toBe(false);
    expect(fs.existsSync(s2.filePath)).toBe(false);

    // Spec-kit dirs exist
    const specsDir = path.join(rootDir, DEFAULT_CONFIG.specsDir);
    expect(fs.statSync(path.join(specsDir, '001-feature-one')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(specsDir, '002-feature-two')).isDirectory()).toBe(true);

    // Frontmatter preserved
    const d1 = getSpec(rootDir, 'SPEC-001');
    const d2 = getSpec(rootDir, 'SPEC-002');
    expect(d1?.summary.title).toBe(beforeFm1.title);
    expect(d2?.summary.title).toBe(beforeFm2.title);
    expect(d1?.summary.tier).toBe(beforeFm1.tier);
  });

  it('migrates spec-kit → flat losslessly (T0 invariant)', () => {
    rootDir = makeTmpProject('spec-kit');
    const s1 = createSpec(rootDir, 'Kit feature', 'T3');

    // Mutate the spec so it has rich content in every phase
    transitionPhase(rootDir, 'SPEC-001', 'advance'); // specify in-progress
    transitionPhase(rootDir, 'SPEC-001', 'advance'); // specify done
    const dirPath = path.dirname(s1.filePath);
    const planPath = path.join(dirPath, 'plan.md');
    fs.writeFileSync(planPath, '## Plan\n\nDesign details here.\n', 'utf-8');

    const detailBefore = getSpec(rootDir, 'SPEC-001');
    expect(detailBefore?.content).toContain('Design details here.');

    const result = migrateLayout(rootDir, 'flat');
    expect(result.success).toBe(true);
    expect(result.migrated).toBe(1);

    // Dir gone, flat file present
    expect(fs.existsSync(dirPath)).toBe(false);
    const specsDir = path.join(rootDir, DEFAULT_CONFIG.specsDir);
    const flatPath = path.join(specsDir, 'SPEC-001-kit-feature.md');
    expect(fs.existsSync(flatPath)).toBe(true);

    // Content preserved
    const after = fs.readFileSync(flatPath, 'utf-8');
    expect(after).toContain('Design details here.');
    expect(after).toContain('id: SPEC-001');
    expect(after).toContain('specify: done');
  });

  it('flat → spec-kit → flat is identity on frontmatter and bodies', () => {
    rootDir = makeTmpProject('flat');
    const summary = createSpec(rootDir, 'Round trip', 'T2');
    const planPath = summary.filePath;
    // Hand-author some content into the flat file
    const seed = `---
id: SPEC-001
title: Round trip
tier: T2
status: implementing
created: 2026-05-29
phases:
  specify: done
  clarify: skipped
  plan: in-progress
  tasks: pending
  implement: pending
---

Preamble here.

## Specify

Requirement A.

## Plan

Approach B.

## Tasks

- [ ] Task C
`;
    fs.writeFileSync(planPath, seed, 'utf-8');

    const fmBefore = parseSpec(seed).frontmatter;
    const sectionsBefore = parseSpec(seed).sections;

    expect(migrateLayout(rootDir, 'spec-kit').success).toBe(true);
    expect(migrateLayout(rootDir, 'flat').success).toBe(true);

    const specsDir = path.join(rootDir, DEFAULT_CONFIG.specsDir);
    const finalPath = path.join(specsDir, 'SPEC-001-round-trip.md');
    const finalContent = fs.readFileSync(finalPath, 'utf-8');
    const fmAfter = parseSpec(finalContent).frontmatter;
    const sectionsAfter = parseSpec(finalContent).sections;

    expect(fmAfter).toEqual(fmBefore);
    for (const [heading, body] of sectionsBefore) {
      expect(sectionsAfter.get(heading)).toBe(body);
    }
  });

  it('reports success with zero migrations if already in target layout', () => {
    rootDir = makeTmpProject('spec-kit');
    createSpec(rootDir, 'Already kit');
    const result = migrateLayout(rootDir, 'spec-kit');
    expect(result.success).toBe(true);
    expect(result.migrated).toBe(0);
  });

  it('handles empty specs directory', () => {
    rootDir = makeTmpProject('flat');
    const result = migrateLayout(rootDir, 'spec-kit');
    expect(result.success).toBe(true);
    expect(result.migrated).toBe(0);
  });
});
