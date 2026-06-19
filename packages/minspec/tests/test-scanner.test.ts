import { describe, it, expect } from 'vitest';
import { scanTestSource, type TestFinding } from '../src/lib/test-scanner';

/** Convenience: scan one source string under a synthetic path. */
function scan(src: string, path = 'foo.test.ts'): TestFinding[] {
  return scanTestSource(path, src);
}

/** The set of `kind`s reported, in order. */
function kinds(findings: TestFinding[]): string[] {
  return findings.map((f) => f.kind);
}

describe('test-scanner — hollow-test detection (#130, SPEC-006 FR-9 L4)', () => {
  // -- Hollow: no assertion at all --
  it('flags a test with NO expect/assert as hollow', () => {
    const src = `
      it('does a thing', () => {
        const x = compute();
        doSomethingWith(x);
      });
    `;
    const findings = scan(src);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('hollow');
    expect(findings[0].testName).toBe('does a thing');
    expect(findings[0].reason).toMatch(/no.*assert|no.*expect|assertion-free/i);
  });

  // -- Hollow: tautological expect(true).toBe(true) --
  it('flags expect(true).toBe(true) as hollow (tautology)', () => {
    const src = `
      test('tautology', () => {
        expect(true).toBe(true);
      });
    `;
    const findings = scan(src);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('hollow');
    expect(findings[0].reason).toMatch(/tautolog|always.?true|trivial/i);
  });

  it('flags expect(1).toBe(1) as hollow (literal-equals-literal)', () => {
    const src = `
      it('one is one', () => {
        expect(1).toBe(1);
      });
    `;
    expect(kinds(scan(src))).toEqual(['hollow']);
  });

  it('flags assert(true) as hollow', () => {
    const src = `
      it('assert true', () => {
        assert(true);
      });
    `;
    expect(kinds(scan(src))).toEqual(['hollow']);
  });

  it("flags expect('a').toBe('a') (equal string literals) as hollow", () => {
    const src = `
      it('string tautology', () => {
        expect('a').toBe('a');
      });
    `;
    expect(kinds(scan(src))).toEqual(['hollow']);
  });

  it('flags expect(true).toBeTruthy() as hollow', () => {
    const src = `
      it('truthy of literal true', () => {
        expect(true).toBeTruthy();
      });
    `;
    expect(kinds(scan(src))).toEqual(['hollow']);
  });

  // -- Real tests: MUST NOT be flagged --
  it('does NOT flag a real test with a meaningful assertion', () => {
    const src = `
      it('adds', () => {
        expect(add(2, 3)).toBe(5);
      });
    `;
    expect(scan(src)).toEqual([]);
  });

  it('does NOT flag a real test whose assertion compares a value to a literal', () => {
    const src = `
      test('non-trivial literal compare', () => {
        const result = parse('x=1');
        expect(result.x).toBe(1);
      });
    `;
    expect(scan(src)).toEqual([]);
  });

  it('does NOT flag a real test using assert with an expression', () => {
    const src = `
      it('assert expr', () => {
        assert(user.isActive);
      });
    `;
    expect(scan(src)).toEqual([]);
  });

  it('does NOT flag a real test using node:assert deepEqual', () => {
    const src = `
      it('deep equal', () => {
        assert.deepEqual(actual, expected);
      });
    `;
    expect(scan(src)).toEqual([]);
  });

  it('does NOT flag a test that asserts a thrown error', () => {
    const src = `
      it('throws', () => {
        expect(() => boom()).toThrow();
      });
    `;
    expect(scan(src)).toEqual([]);
  });

  // -- Stub detection: must NOT regress (existing SPEC-006 behavior) --
  it('flags an empty test body as a stub (not hollow)', () => {
    const src = `
      it('todo: implement later', () => {});
    `;
    const findings = scan(src);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('stub');
  });

  it("flags a test that throws 'not implemented' as a stub", () => {
    const src = `
      it('pending', () => {
        throw new Error('not implemented');
      });
    `;
    const findings = scan(src);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('stub');
  });

  it('flags a skipped test as a stub', () => {
    const src = `
      it.skip('skipped for now', () => {
        expect(realThing()).toBe(42);
      });
    `;
    const findings = scan(src);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('stub');
  });

  it('flags test.skip too', () => {
    const src = `
      test.skip('also skipped', () => {
        expect(x).toBe(1);
      });
    `;
    expect(kinds(scan(src))).toEqual(['stub']);
  });

  // -- Mixed file: one of each, correctly classified --
  it('classifies stub, hollow, and real tests independently in one file', () => {
    const src = `
      it('real', () => { expect(f()).toBe(1); });
      it('hollow', () => { expect(true).toBe(true); });
      it('stub', () => {});
      it('also hollow no assert', () => { const a = 1; use(a); });
    `;
    const findings = scan(src);
    expect(findings).toHaveLength(3);
    const byName = new Map(findings.map((f) => [f.testName, f.kind]));
    expect(byName.get('hollow')).toBe('hollow');
    expect(byName.get('stub')).toBe('stub');
    expect(byName.get('also hollow no assert')).toBe('hollow');
    expect(byName.has('real')).toBe(false);
  });

  // -- Determinism / Tier-0 sanity --
  it('is deterministic - same input yields identical findings', () => {
    const src = `it('h', () => { expect(true).toBe(true); });`;
    expect(scan(src)).toEqual(scan(src));
  });

  it('reports the source path and a 1-based line number on each finding', () => {
    const src = [
      `it('real', () => { expect(f()).toBe(1); });`,
      `it('hollow', () => { expect(true).toBe(true); });`,
    ].join('\n');
    const findings = scan(src, 'pkg/a.test.ts');
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('pkg/a.test.ts');
    expect(findings[0].line).toBe(2);
  });

  // -- False-positive guard: assertions in strings/comments --
  it('does NOT count a tautology that appears only inside a string literal', () => {
    const src = `
      it('checks message text', () => {
        const msg = 'expect(true).toBe(true)';
        expect(render()).toContain(msg);
      });
    `;
    expect(scan(src)).toEqual([]);
  });

  it('treats a test whose only assertion is commented-out as hollow', () => {
    const src = `
      it('forgot to enable', () => {
        // expect(realThing()).toBe(42);
        doWork();
      });
    `;
    expect(kinds(scan(src))).toEqual(['hollow']);
  });
});
