import { describe, it, expect } from 'vitest';
import { parseConstitution, EMPTY_CONSTITUTION } from '../src/lib/constitution';

describe('constitution parser', () => {
  it('parses invariants from numbered list', () => {
    const content = `# Project — Constitution

## Invariants

1. No AI dependency
2. No backend calls
3. All data stays local
`;
    const result = parseConstitution(content);
    expect(result.invariants).toEqual([
      'No AI dependency',
      'No backend calls',
      'All data stays local',
    ]);
  });

  it('parses invariants from bullet list', () => {
    const content = `## Invariants

- Rule A
- Rule B
`;
    const result = parseConstitution(content);
    expect(result.invariants).toEqual(['Rule A', 'Rule B']);
  });

  it('parses all three sections', () => {
    const content = `## Invariants

1. Invariant one

## Principles

1. Principle one
2. Principle two

## Constraints

- Constraint A
- Constraint B
- Constraint C
`;
    const result = parseConstitution(content);
    expect(result.invariants).toEqual(['Invariant one']);
    expect(result.principles).toEqual(['Principle one', 'Principle two']);
    expect(result.constraints).toEqual(['Constraint A', 'Constraint B', 'Constraint C']);
  });

  it('returns empty arrays for missing sections', () => {
    const content = `## Invariants

1. Only invariants defined here
`;
    const result = parseConstitution(content);
    expect(result.invariants).toEqual(['Only invariants defined here']);
    expect(result.principles).toEqual([]);
    expect(result.constraints).toEqual([]);
  });

  it('handles empty content', () => {
    expect(parseConstitution('')).toEqual(EMPTY_CONSTITUTION);
    expect(parseConstitution('   ')).toEqual(EMPTY_CONSTITUTION);
  });

  it('skips HTML comments', () => {
    const content = `## Invariants

<!-- Add invariants here -->
<!-- 1. Example invariant -->
1. Real invariant

## Principles

<!-- No principles yet -->
`;
    const result = parseConstitution(content);
    expect(result.invariants).toEqual(['Real invariant']);
    expect(result.principles).toEqual([]);
  });

  it('handles case-insensitive section headings', () => {
    const content = `## invariants

1. Lower case heading works

## PRINCIPLES

- Upper case too
`;
    const result = parseConstitution(content);
    expect(result.invariants).toEqual(['Lower case heading works']);
    expect(result.principles).toEqual(['Upper case too']);
  });

  it('handles * bullets', () => {
    const content = `## Constraints

* Star bullet one
* Star bullet two
`;
    const result = parseConstitution(content);
    expect(result.constraints).toEqual(['Star bullet one', 'Star bullet two']);
  });

  it('handles mixed list styles in one section', () => {
    const content = `## Invariants

1. Numbered item
- Bullet item
* Star item
`;
    const result = parseConstitution(content);
    expect(result.invariants).toEqual(['Numbered item', 'Bullet item', 'Star item']);
  });

  it('ignores non-list content in sections', () => {
    const content = `## Invariants

Rules that must never be violated.

1. The actual rule

Some trailing text that is not a list.
`;
    const result = parseConstitution(content);
    expect(result.invariants).toEqual(['The actual rule']);
  });
});
