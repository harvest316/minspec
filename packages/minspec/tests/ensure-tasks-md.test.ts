/**
 * #225 — ensure every spec has a tasks.md (create + offer-to-fix).
 *
 * T0/T1: the pure scaffolder + detector in scaffold.ts.
 *   - scaffoldTasksMd: creates a sibling tasks.md (frontmatter matching the
 *     requirements.md convention) for a split-layout dir that lacks one.
 *   - findSpecDirsMissingTasksMd: detects split-layout T3/T4 spec dirs (whose
 *     Tasks phase is required) that have a requirements.md but no tasks.md.
 *
 * Invariants asserted:
 *   - a created tasks.md carries valid frontmatter (id/type/status — passes the
 *     frontmatter validator AND the closed-set spec validator);
 *   - an existing tasks.md is never overwritten;
 *   - a single-file spec (no `type:`) is never offered a sibling tasks.md;
 *   - a tier whose Tasks phase is NOT required (T1/T2) is never offered;
 *   - deterministic + offline (real fs only, no mocks).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  scaffoldTasksMd,
  findSpecDirsMissingTasksMd,
  type MissingTasksMdSpec,
} from '../src/lib/scaffold';
import { parseSpec } from '../src/lib/spec';
import { validateSpec } from '../src/lib/spec-validator';
import { DEFAULT_CONFIG } from '../src/lib/config';

// ── fixtures ──────────────────────────────────────────────────────────────

/** Minimal .minspec/config.json so loadConfig resolves the specsDir. */
function writeConfig(root: string): void {
  fs.mkdirSync(path.join(root, '.minspec'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.minspec', 'config.json'),
    JSON.stringify({ version: '1' }),
  );
}

interface ReqOpts {
  readonly id: string;
  readonly tier?: string;
  readonly status?: string;
  readonly product?: string;
  readonly epic?: string;
  readonly title?: string;
}

/**
 * Write a split-layout `requirements.md` (the primary artifact) into
 * specs/<product>/<dir>/requirements.md. Mirrors the real corpus shape.
 */
function writeRequirements(root: string, relDir: string, o: ReqOpts): string {
  const dir = path.join(root, 'specs', relDir);
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    `id: ${o.id}`,
    'type: requirements',
    `status: ${o.status ?? 'implementing'}`,
    ...(o.product ? [`product: ${o.product}`] : []),
    `tier: ${o.tier ?? 'T3'}`,
    ...(o.epic ? [`epic: ${o.epic}`] : []),
    '---',
    '',
    `# ${o.title ?? o.id} (Requirements)`,
    '',
    '## Requirements',
    '',
    '- [ ] something. (FR-1)',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'requirements.md'), fm);
  return dir;
}

/** Write a single-file spec (no `type:`) directly under specsDir. */
function writeSingleFileSpec(root: string, id: string, tier = 'T3'): void {
  const dir = path.join(root, 'specs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}-thing.md`),
    [
      '---',
      `id: ${id}`,
      `title: ${id}`,
      `tier: ${tier}`,
      'status: new',
      'created: 2026-06-27',
      'phases:',
      '  specify: done',
      '---',
      '',
      `# ${id}`,
      '',
      '## Tasks',
      '',
      '- [ ] do the thing',
      '',
    ].join('\n'),
  );
}

describe('#225 scaffoldTasksMd()', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-225-test-'));
    writeConfig(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates tasks.md for a split-layout dir that lacks one', () => {
    const dir = writeRequirements(tmpDir, 'minspec/SPEC-001-feature', {
      id: 'SPEC-001',
      product: 'minspec',
      epic: 'EPIC-001  # My Epic',
      tier: 'T3',
    });
    const created = scaffoldTasksMd(dir);
    expect(created).toBe(true);
    expect(fs.existsSync(path.join(dir, 'tasks.md'))).toBe(true);
  });

  it('the created tasks.md carries frontmatter mirroring the requirements sibling', () => {
    const dir = writeRequirements(tmpDir, 'minspec/SPEC-002-feature', {
      id: 'SPEC-002',
      product: 'minspec',
      epic: 'EPIC-007  # Some Epic',
      status: 'implementing',
      tier: 'T4',
    });
    scaffoldTasksMd(dir);
    const raw = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf-8');
    const parsed = parseSpec(raw);
    expect(parsed.frontmatter.id).toBe('SPEC-002');
    expect(parsed.frontmatter.type).toBe('tasks');
    expect(parsed.frontmatter.status).toBe('implementing');
    expect(parsed.frontmatter.product).toBe('minspec');
    // epic carries its inline `# Title` comment verbatim (the corpus convention).
    expect(parsed.frontmatter.epic).toContain('EPIC-007');
  });

  it('the created tasks.md passes the spec validator with no errors (valid frontmatter)', () => {
    const dir = writeRequirements(tmpDir, 'minspec/SPEC-003-feature', {
      id: 'SPEC-003',
      product: 'minspec',
      tier: 'T3',
    });
    scaffoldTasksMd(dir);
    const raw = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf-8');
    const result = validateSpec(parseSpec(raw), DEFAULT_CONFIG);
    // A `type: tasks` file is split-layout → validateSpec skips the in-file phase
    // checks; the frontmatter (id/type/status) must be recognized: zero errors.
    expect(result.complete).toBe(true);
    expect(result.violations.filter((v) => v.severity === 'error')).toEqual([]);
    // No `frontmatter.*.unknown` / `.missing` for the fields we wrote.
    expect(result.violations.map((v) => v.rule)).not.toContain('frontmatter.id.missing');
    expect(result.violations.map((v) => v.rule)).not.toContain('frontmatter.status.missing');
    expect(result.violations.map((v) => v.rule)).not.toContain('frontmatter.type.unknown');
  });

  it('the created tasks.md carries a valid `id: SPEC-NNN` frontmatter line (CI gate)', () => {
    const dir = writeRequirements(tmpDir, 'minspec/SPEC-004-feature', {
      id: 'SPEC-004',
      product: 'minspec',
      tier: 'T3',
    });
    scaffoldTasksMd(dir);
    const raw = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf-8');
    // The CI validator (scripts/validate-frontmatter.ts) requires this exact shape.
    expect(/^id:\s*SPEC-\d+/m.test(raw)).toBe(true);
  });

  it('never overwrites an existing tasks.md', () => {
    const dir = writeRequirements(tmpDir, 'minspec/SPEC-005-feature', {
      id: 'SPEC-005',
      product: 'minspec',
      tier: 'T3',
    });
    const existing = '---\nid: SPEC-005\ntype: tasks\nstatus: done\n---\n\n# hand-written\n';
    fs.writeFileSync(path.join(dir, 'tasks.md'), existing);
    const created = scaffoldTasksMd(dir);
    expect(created).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'tasks.md'), 'utf-8')).toBe(existing);
  });

  it('returns false (no-op) for a dir with no requirements.md', () => {
    const dir = path.join(tmpDir, 'specs', 'minspec', 'SPEC-006-empty');
    fs.mkdirSync(dir, { recursive: true });
    expect(scaffoldTasksMd(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'tasks.md'))).toBe(false);
  });
});

describe('#225 findSpecDirsMissingTasksMd()', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-225-detect-'));
    writeConfig(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const ids = (r: MissingTasksMdSpec[]) => r.map((s) => s.id).sort();

  it('detects a T3 split-layout dir missing its tasks.md', () => {
    writeRequirements(tmpDir, 'minspec/SPEC-001-a', { id: 'SPEC-001', tier: 'T3' });
    expect(ids(findSpecDirsMissingTasksMd(tmpDir))).toEqual(['SPEC-001']);
  });

  it('detects a T4 split-layout dir missing its tasks.md', () => {
    writeRequirements(tmpDir, 'minspec/SPEC-002-b', { id: 'SPEC-002', tier: 'T4' });
    expect(ids(findSpecDirsMissingTasksMd(tmpDir))).toEqual(['SPEC-002']);
  });

  it('does NOT offer a dir that already has tasks.md', () => {
    const dir = writeRequirements(tmpDir, 'minspec/SPEC-003-c', { id: 'SPEC-003', tier: 'T3' });
    fs.writeFileSync(path.join(dir, 'tasks.md'), '---\nid: SPEC-003\ntype: tasks\nstatus: new\n---\n');
    expect(findSpecDirsMissingTasksMd(tmpDir)).toEqual([]);
  });

  it('does NOT offer a T1/T2 dir (Tasks phase not required for that tier)', () => {
    writeRequirements(tmpDir, 'minspec/SPEC-004-d', { id: 'SPEC-004', tier: 'T2' });
    writeRequirements(tmpDir, 'minspec/SPEC-005-e', { id: 'SPEC-005', tier: 'T1' });
    expect(findSpecDirsMissingTasksMd(tmpDir)).toEqual([]);
  });

  it('does NOT offer a single-file spec (no split layout)', () => {
    writeSingleFileSpec(tmpDir, 'SPEC-006', 'T3');
    expect(findSpecDirsMissingTasksMd(tmpDir)).toEqual([]);
  });

  it('returns the missing dirs across products + reports tier/dir', () => {
    writeRequirements(tmpDir, 'minspec/SPEC-001-a', { id: 'SPEC-001', tier: 'T3' });
    writeRequirements(tmpDir, 'agent-execute/SPEC-002-b', { id: 'SPEC-002', tier: 'T4' });
    const found = findSpecDirsMissingTasksMd(tmpDir);
    expect(ids(found)).toEqual(['SPEC-001', 'SPEC-002']);
    const a = found.find((s) => s.id === 'SPEC-001')!;
    expect(a.tier).toBe('T3');
    expect(fs.existsSync(path.join(a.dirPath, 'requirements.md'))).toBe(true);
  });

  it('returns [] when specs/ does not exist', () => {
    expect(findSpecDirsMissingTasksMd(tmpDir)).toEqual([]);
  });
});
