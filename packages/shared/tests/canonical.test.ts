/**
 * T1 — `getSpecBodyOnly` body-extraction parity (SPEC-017 Slice 1, FR-4).
 *
 * `getSpecBodyOnly` is the SPEC-017 FR-4 baseline boundary: the body-after-
 * frontmatter, used to measure how much the human reworked the LLM's prose.
 * It MUST extract the SAME body `parseSpec` does (single anchor: `FRONTMATTER_RE`)
 * so the two never drift (the "two body anchors drift" risk). It is a different
 * boundary from `canonicalizeSpec`/`specHash`, which keep frontmatter-minus-
 * lifecycle; this test guards only the body-only extractor.
 *
 * Parity is asserted against the SAME algorithm `parseSpec` uses:
 *   normalize EOL → `FRONTMATTER_RE` match → `slice(match[0].length)`, else whole.
 */

import { describe, it, expect } from 'vitest';
import { getSpecBodyOnly } from '@aiclarity/shared';

/**
 * Reproduces `parseSpec`'s body split (spec.ts:233-246) exactly, so the parity
 * assertion is against an independent re-derivation of the same contract — not a
 * tautology against `getSpecBodyOnly` itself.
 */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
function parseSpecBody(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n');
  const fmMatch = normalized.match(FRONTMATTER_RE);
  return fmMatch ? normalized.slice(fmMatch[0].length) : normalized;
}

describe('getSpecBodyOnly — body-extraction parity (FR-4)', () => {
  it('extracts the SAME body parseSpec does (single-anchor FRONTMATTER_RE)', () => {
    const raw = [
      '---',
      'id: SPEC-007',
      'status: implementing',
      'tier: T3',
      '---',
      '# Heading',
      '',
      'Body paragraph one.',
      '',
      '## Section',
      'More body.',
      '',
    ].join('\n');

    const expected = parseSpecBody(raw);
    expect(getSpecBodyOnly(raw)).toBe(expected);
    // And the extracted body is the post-frontmatter content, not the frontmatter.
    expect(getSpecBodyOnly(raw)).toBe(
      '# Heading\n\nBody paragraph one.\n\n## Section\nMore body.\n',
    );
    expect(getSpecBodyOnly(raw)).not.toContain('id: SPEC-007');
  });

  it('normalizes CRLF/CR EOL before splitting (matches parseSpec)', () => {
    const raw = '---\r\nid: SPEC-009\r\nstatus: done\r\n---\r\nLine A\r\nLine B\r\n';
    const expected = parseSpecBody(raw);
    expect(getSpecBodyOnly(raw)).toBe(expected);
    expect(getSpecBodyOnly(raw)).toBe('Line A\nLine B\n');
  });

  it('a spec with NO frontmatter returns the whole content as body', () => {
    const raw = '# Just a heading\n\nNo frontmatter here at all.\n';
    expect(getSpecBodyOnly(raw)).toBe(parseSpecBody(raw));
    expect(getSpecBodyOnly(raw)).toBe(raw); // whole content, EOL already \n
  });

  it('content that is only a frontmatter block returns an empty body', () => {
    const raw = '---\nid: SPEC-010\nstatus: specifying\n---\n';
    expect(getSpecBodyOnly(raw)).toBe(parseSpecBody(raw));
    expect(getSpecBodyOnly(raw)).toBe('');
  });
});
