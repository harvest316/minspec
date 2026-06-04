/**
 * T0/T1 — DR Sequence Validation (issue #41)
 *
 * Tests validateDrSequence() in src/lib/adr-manager.ts: a Tier-0, offline
 * scan of the decisions directory that WARNS (never throws) on local
 * DR-NNN sequence anomalies:
 *   - gap:       a number missing from the contiguous 1..max run
 *   - duplicate: the same DR number used by two files
 *   - padding:   an id that is not zero-padded to >= 3 digits
 *
 * Triggered by DR-362 being minted while the local register ran to DR-010
 * (global-register number leaked into a project-local register). A clean,
 * contiguous, properly-padded sequence must produce NO warnings.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { validateDrSequence, type DrSequenceWarning } from '../src/lib/adr-manager';

describe('validateDrSequence()', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-drseq-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write an empty DR file with the given file name. */
  function dr(fileName: string): void {
    fs.writeFileSync(path.join(dir, fileName), '---\nid: x\n---\n', 'utf-8');
  }

  function kinds(warnings: DrSequenceWarning[]): string[] {
    return warnings.map(w => w.kind);
  }

  // ─── No-warning cases ───────────────────────────────────────────────────

  it('a clean contiguous sequence produces NO warnings', () => {
    dr('DR-001-alpha.md');
    dr('DR-002-beta.md');
    dr('DR-003-gamma.md');
    expect(validateDrSequence(dir)).toEqual([]);
  });

  it('a single DR produces NO warnings', () => {
    dr('DR-001-only.md');
    expect(validateDrSequence(dir)).toEqual([]);
  });

  it('an empty decisions directory produces NO warnings', () => {
    expect(validateDrSequence(dir)).toEqual([]);
  });

  it('a non-existent decisions directory produces NO warnings', () => {
    expect(validateDrSequence(path.join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('non-DR files (INDEX.md, README.md, notes) are ignored', () => {
    dr('DR-001-alpha.md');
    dr('DR-002-beta.md');
    fs.writeFileSync(path.join(dir, 'INDEX.md'), '# index\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'README.md'), '# readme\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'notes\n', 'utf-8');
    expect(validateDrSequence(dir)).toEqual([]);
  });

  // ─── Gap ────────────────────────────────────────────────────────────────

  it('a gap in the sequence warns (kind: gap), naming the missing number', () => {
    dr('DR-001-alpha.md');
    dr('DR-002-beta.md');
    dr('DR-005-eta.md'); // 003 + 004 missing
    const warnings = validateDrSequence(dir);
    expect(kinds(warnings)).toContain('gap');
    const gaps = warnings.filter(w => w.kind === 'gap').map(w => w.number);
    expect(gaps).toEqual([3, 4]);
  });

  it('the large DR-362-style jump warns as a gap', () => {
    // Model the real scenario: a clean DR-001..DR-010 run, then a leaked
    // global-register number DR-362. Every number 11..361 is now a gap.
    for (let n = 1; n <= 10; n++) {
      dr(`DR-${String(n).padStart(3, '0')}-real.md`);
    }
    dr('DR-362-leaked-global-number.md');
    const warnings = validateDrSequence(dir);
    expect(kinds(warnings)).toContain('gap');
    const gapNumbers = warnings.filter(w => w.kind === 'gap').map(w => w.number);
    expect(gapNumbers[0]).toBe(11);
    expect(gapNumbers).toContain(361);
    expect(gapNumbers).not.toContain(362);
    expect(gapNumbers).not.toContain(10);
  });

  // ─── Duplicate ──────────────────────────────────────────────────────────

  it('a duplicate number warns (kind: duplicate), naming both files', () => {
    dr('DR-001-alpha.md');
    dr('DR-002-beta.md');
    dr('DR-002-beta-again.md');
    const warnings = validateDrSequence(dir);
    expect(kinds(warnings)).toContain('duplicate');
    const dup = warnings.find(w => w.kind === 'duplicate');
    expect(dup?.number).toBe(2);
    expect(dup?.files.length).toBe(2);
    expect(dup?.files).toContain('DR-002-beta.md');
    expect(dup?.files).toContain('DR-002-beta-again.md');
  });

  // ─── Padding ────────────────────────────────────────────────────────────

  it('an under-padded id warns (kind: padding)', () => {
    dr('DR-1-alpha.md');
    const warnings = validateDrSequence(dir);
    expect(kinds(warnings)).toContain('padding');
    const pad = warnings.find(w => w.kind === 'padding');
    expect(pad?.number).toBe(1);
    expect(pad?.files).toContain('DR-1-alpha.md');
  });

  it('a >=3-digit id is NOT a padding warning', () => {
    dr('DR-100-alpha.md');
    dr('DR-101-beta.md');
    dr('DR-102-gamma.md');
    expect(validateDrSequence(dir).filter(w => w.kind === 'padding')).toEqual([]);
  });

  // ─── Every warning carries a human-readable message ─────────────────────

  it('every warning carries a non-empty message', () => {
    dr('DR-001-alpha.md');
    dr('DR-003-gamma.md');
    dr('DR-003-gamma-dup.md');
    dr('DR-5-short.md');
    const warnings = validateDrSequence(dir);
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) {
      expect(typeof w.message).toBe('string');
      expect(w.message.length).toBeGreaterThan(0);
    }
  });
});
