import { describe, it, expect, vi } from 'vitest';

// diagnostics.ts imports `vscode` at module top level for its registration layer.
// The function under test (violationsToDiagnostics) is pure and never touches the
// vscode API, but the import must still resolve — stub it so the module loads.
vi.mock('vscode', () => ({}));

import { violationsToDiagnostics } from '../src/lib/diagnostics';
import {
  checkReferences,
  type ReferenceRegistry,
  type ReferenceViolation,
} from '../src/lib/reference-checker';

// Registry mirroring a small corpus: SPEC-001 + DR-001 + EPIC-001 exist; only
// docs/real.md exists. Everything else is dangling. (Mirrors the
// reference-checker test's registry so the two stay in step.)
const registry: ReferenceRegistry = {
  specs: new Set(['SPEC-001']),
  decisions: new Set(['DR-001']),
  epics: new Set(['EPIC-001']),
  fileExists: (relPath) => relPath === 'docs/real.md',
};

describe('violationsToDiagnostics', () => {
  it('returns no diagnostics for fully-resolving text', () => {
    const text = 'See SPEC-001 and DR-001 and EPIC-001 plus docs/real.md.';
    const diags = violationsToDiagnostics(text, checkReferences(text, registry));
    expect(diags).toEqual([]);
  });

  it('maps a dangling DR ref to a diagnostic anchored on the token', () => {
    const text = 'line one\nthis cites DR-355 which does not exist';
    const diags = violationsToDiagnostics(text, checkReferences(text, registry));
    expect(diags).toHaveLength(1);
    const d = diags[0];
    expect(d.line).toBe(1);
    // "this cites " is 11 chars → DR-355 starts at column 11.
    expect(d.startCol).toBe(11);
    expect(d.endCol).toBe(11 + 'DR-355'.length);
    expect(d.message).toContain('DR-355');
    expect(d.message).toContain('dangling DR reference');
  });

  it('maps a dangling SPEC ref to the right line/column', () => {
    const text = 'intro\n\n  refers to SPEC-999 here';
    const diags = violationsToDiagnostics(text, checkReferences(text, registry));
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(2);
    expect(diags[0].startCol).toBe('  refers to '.length);
    expect(diags[0].message).toContain('SPEC-999');
  });

  it('maps a dangling file citation onto the path token', () => {
    const text = 'broken ref to src/missing.ts#L42 over here';
    const diags = violationsToDiagnostics(text, checkReferences(text, registry));
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(0);
    expect(diags[0].startCol).toBe('broken ref to '.length);
    expect(diags[0].endCol).toBe('broken ref to '.length + 'src/missing.ts'.length);
    expect(diags[0].message).toContain('src/missing.ts');
  });

  it('produces one diagnostic per distinct dangling ref', () => {
    const text = 'DR-355 and SPEC-999 and EPIC-888';
    const diags = violationsToDiagnostics(text, checkReferences(text, registry));
    expect(diags).toHaveLength(3);
    const msgs = diags.map((d) => d.message).join(' | ');
    expect(msgs).toContain('DR-355');
    expect(msgs).toContain('SPEC-999');
    expect(msgs).toContain('EPIC-888');
  });

  it('ignores external @namespace refs (never dangling)', () => {
    const text = 'cross-repo SPEC-100@scroogellm is fine';
    const diags = violationsToDiagnostics(text, checkReferences(text, registry));
    expect(diags).toEqual([]);
  });

  it('falls back to line 0 when the token cannot be located', () => {
    // Synthetic violation whose token is absent from the text — defensive path.
    const violations: ReferenceViolation[] = [
      { ref: { kind: 'decision', id: 'DR-777' }, message: 'dangling DR reference: DR-777' },
    ];
    const diags = violationsToDiagnostics('unrelated text', violations);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(0);
    expect(diags[0].startCol).toBe(0);
    expect(diags[0].endCol).toBe('DR-777'.length);
  });
});
