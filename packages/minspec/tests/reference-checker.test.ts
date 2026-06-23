import { describe, it, expect } from 'vitest';
import {
  extractReferences,
  checkReferences,
  type ReferenceRegistry,
} from '../src/lib/reference-checker';

// A registry mirroring a small corpus: SPEC-001 + DR-001 + EPIC-001 exist; a
// real file at docs/real.md exists. Everything else is dangling.
const registry: ReferenceRegistry = {
  specs: new Set(['SPEC-001']),
  decisions: new Set(['DR-001']),
  epics: new Set(['EPIC-001']),
  fileExists: (relPath) => relPath === 'docs/real.md',
};

describe('extractReferences', () => {
  it('extracts SPEC/DR/EPIC artifact refs', () => {
    const refs = extractReferences('See SPEC-001 and DR-002 plus EPIC-001.');
    const kinds = refs.map((r) => `${r.kind}:${r.id}`);
    expect(kinds).toContain('spec:SPEC-001');
    expect(kinds).toContain('decision:DR-002');
    expect(kinds).toContain('epic:EPIC-001');
  });

  it('extracts file:line citations in both `path#Lnn` and `path:nn` forms', () => {
    const refs = extractReferences(
      'see src/foo.ts#L42 and also scripts/bar.ts:70-100',
    );
    const files = refs.filter((r) => r.kind === 'file').map((r) => r.path);
    expect(files).toContain('src/foo.ts');
    expect(files).toContain('scripts/bar.ts');
  });

  it('de-duplicates repeated refs', () => {
    const refs = extractReferences('SPEC-001 SPEC-001 SPEC-001');
    expect(refs.filter((r) => r.kind === 'spec').length).toBe(1);
  });

  it('treats `@namespace`-suffixed refs as external (exempt)', () => {
    const refs = extractReferences('SPEC-100@scroogellm is cross-repo');
    const spec = refs.find((r) => r.kind === 'spec');
    expect(spec?.external).toBe(true);
  });

  it('does not treat a defining frontmatter `id:` line as a ref to itself', () => {
    // The artifact's own `id: SPEC-001` declaration is a definition, not a
    // citation — extracting it would make every spec "reference" itself.
    const refs = extractReferences('---\nid: SPEC-001\ntype: spec\n---\nbody');
    expect(refs.filter((r) => r.kind === 'spec').length).toBe(0);
  });
});

describe('checkReferences — invariants', () => {
  it('INVARIANT: resolving refs pass (no violations)', () => {
    const v = checkReferences(
      'Implements SPEC-001 per DR-001 under EPIC-001; see docs/real.md',
      registry,
    );
    expect(v).toEqual([]);
  });

  it('INVARIANT: a missing SPEC ref is flagged', () => {
    const v = checkReferences('relates to SPEC-999', registry);
    expect(v.some((x) => x.ref.kind === 'spec' && x.ref.id === 'SPEC-999')).toBe(
      true,
    );
  });

  it('INVARIANT: a missing DR ref is flagged', () => {
    const v = checkReferences('see DR-355', registry);
    expect(v.some((x) => x.ref.kind === 'decision' && x.ref.id === 'DR-355')).toBe(
      true,
    );
  });

  it('INVARIANT: a missing EPIC ref is flagged', () => {
    const v = checkReferences('grouped under EPIC-099', registry);
    expect(v.some((x) => x.ref.kind === 'epic' && x.ref.id === 'EPIC-099')).toBe(
      true,
    );
  });

  it('INVARIANT: a dangling file path is flagged', () => {
    const v = checkReferences('see src/missing.ts#L10', registry);
    expect(v.some((x) => x.ref.kind === 'file' && x.ref.path === 'src/missing.ts')).toBe(
      true,
    );
  });

  it('INVARIANT: a resolving file path passes', () => {
    const v = checkReferences('see docs/real.md', registry);
    expect(v.length).toBe(0);
  });

  it('INVARIANT: external `@namespace` refs are exempt, not flagged', () => {
    const v = checkReferences('cross-repo SPEC-100@scroogellm', registry);
    expect(v.length).toBe(0);
  });

  it('every violation carries a human-readable message', () => {
    const v = checkReferences('SPEC-999 and DR-998', registry);
    expect(v.length).toBe(2);
    for (const x of v) expect(typeof x.message).toBe('string');
  });
});
