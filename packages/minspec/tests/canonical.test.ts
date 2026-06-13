import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { canonicalizeSpec, specHash } from '@aiclarity/shared';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'canonical');

// ─────────────────────────────────────────────────────────────────────────────
// INV-3 (lifecycle-edit non-void) + AC-4. T0 — written before implementation.
//
// AC-10 discipline: each assertion below would FAIL against the pre-change code,
// which had NO `canonicalizeSpec`/`specHash` (the approval hash was sha256 over
// RAW bytes via `hashContent`/`hashSpecFile`). Under raw-byte hashing, editing
// only `status`/`phases` DID change the hash (the #116/#148/#166 self-voiding
// bug). These tests pin the new contract: lifecycle edits are non-void; body and
// non-lifecycle frontmatter edits still void.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = [
  '---',
  'id: SPEC-007',
  'tier: T3',
  'epic: EPIC-002',
  'status: specifying',
  'phases:',
  '  specify: done',
  '  plan: pending',
  '---',
  '# Thing',
  '',
  'The body.',
  '',
].join('\n');

describe('INV-3 — lifecycle-edit non-void (AC-4)', () => {
  it('editing ONLY status leaves specHash unchanged', () => {
    const edited = BASE.replace('status: specifying', 'status: implementing');
    expect(edited).not.toBe(BASE); // the raw bytes DID change
    expect(specHash(edited)).toBe(specHash(BASE)); // …but the canonical hash did not
  });

  it('editing ONLY phases leaves specHash unchanged', () => {
    const edited = BASE.replace('  plan: pending', '  plan: in-progress');
    expect(edited).not.toBe(BASE);
    expect(specHash(edited)).toBe(specHash(BASE));
  });

  it('editing BOTH status and phases together leaves specHash unchanged', () => {
    const edited = BASE
      .replace('status: specifying', 'status: implementing')
      .replace('  plan: pending', '  plan: done');
    expect(specHash(edited)).toBe(specHash(BASE));
  });

  it('editing the body DOES change specHash', () => {
    const edited = BASE.replace('The body.', 'The body, edited.');
    expect(specHash(edited)).not.toBe(specHash(BASE));
  });

  it('editing a non-lifecycle frontmatter field (id) DOES change specHash', () => {
    const edited = BASE.replace('id: SPEC-007', 'id: SPEC-999');
    expect(specHash(edited)).not.toBe(specHash(BASE));
  });

  it('editing a non-lifecycle frontmatter field (tier) DOES change specHash', () => {
    const edited = BASE.replace('tier: T3', 'tier: T4');
    expect(specHash(edited)).not.toBe(specHash(BASE));
  });

  it('editing a non-lifecycle frontmatter field (epic) DOES change specHash', () => {
    const edited = BASE.replace('epic: EPIC-002', 'epic: EPIC-003');
    expect(specHash(edited)).not.toBe(specHash(BASE));
  });
});

describe('INV-3 — CRLF and LF copies hash identically (AC-4)', () => {
  it('CRLF input hashes the same as the LF equivalent', () => {
    const lf = BASE;
    const crlf = BASE.replace(/\n/g, '\r\n');
    expect(crlf).not.toBe(lf);
    expect(specHash(crlf)).toBe(specHash(lf));
  });

  it('old-Mac CR input hashes the same as the LF equivalent', () => {
    const lf = BASE;
    const cr = BASE.replace(/\n/g, '\r');
    expect(specHash(cr)).toBe(specHash(lf));
  });
});

describe('canonicalizeSpec — golden fixtures (shared with the Python twin)', () => {
  const names = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.input'))
    .map((f) => f.replace(/\.input$/, ''));

  it('has fixtures to assert against', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(`canonicalizes "${name}" to its pinned golden output`, () => {
      const input = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.input`), 'utf-8');
      const expected = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.expected`), 'utf-8');
      expect(canonicalizeSpec(input)).toBe(expected);
    });
  }
});

describe('canonicalizeSpec — structural guarantees', () => {
  it('output ends with exactly one trailing newline', () => {
    expect(canonicalizeSpec('---\nid: X\n---\nbody\n\n\n')).toMatch(/[^\n]\n$/);
  });

  it('strips per-line trailing whitespace', () => {
    expect(canonicalizeSpec('---\nid: X   \n---\nbody\t\n')).toBe('---\nid: X\n---\nbody\n');
  });

  it('keeps a status: token that appears in the body prose', () => {
    const out = canonicalizeSpec('---\nid: X\nstatus: done\n---\nstatus: in-prose\n');
    expect(out).toContain('status: in-prose');
    expect(out).not.toContain('status: done');
  });

  it('is idempotent — canonicalizing canonical output is a no-op', () => {
    const once = canonicalizeSpec(BASE);
    expect(canonicalizeSpec(once)).toBe(once);
  });

  it('specHash is the sha256 of the canonical UTF-8 bytes', () => {
    // Deterministic, stable hex digest.
    expect(specHash(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });
});
