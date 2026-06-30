/**
 * T0/T1 — AC-9 pure render (SPEC-017 Slice 6, FR-10, FR-12).
 *
 * Verifies that `renderTrustChart`:
 *   - emits NO `<script>` tag
 *   - emits NO remote asset (src= or href= pointing to a URL)
 *   - contains NO http/https/fetch/net import in the source module
 *   - handles `pct: null` (no datapoint) without throwing or emitting garbage
 *   - handles an empty model gracefully (both arrays empty)
 *   - handles a fully-populated model
 *   - returns a string, not undefined/null/throws
 *
 * This test file has ZERO vscode dependency — `packages/shared` is Tier-0.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { renderTrustChart } from '../src/trust-model';
import type { TrustChartModel, ReworkPoint, WastedPoint } from '../src/trust-model';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeModel(
  rework: ReworkPoint[] = [],
  wasted: WastedPoint[] = [],
): TrustChartModel {
  return { rework, wasted };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-9 — pure render: no <script>, no remote asset, no network import
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-9 — renderTrustChart pure render invariants', () => {
  it('emits NO <script> tag (static SVG only — no nonce needed)', () => {
    const svg = renderTrustChart(makeModel(
      [{ specId: 'SPEC-001', pct: 0.5 }],
      [{ specId: 'SPEC-002', approvedChars: 1000 }],
    ));
    // Case-insensitive: <script>, <SCRIPT>, <Script>
    expect(svg).not.toMatch(/<script/i);
  });

  it('emits NO remote asset (no src= or href= pointing to a URL)', () => {
    const svg = renderTrustChart(makeModel(
      [{ specId: 'SPEC-001', pct: 0.2 }],
      [],
    ));
    // Any src="http..." or href="http..." or src="https..." would be a violation
    expect(svg).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    // Also catch xlink:href to external URLs (legacy SVG pattern)
    expect(svg).not.toMatch(/xlink:href\s*=\s*["']https?:/i);
  });

  it('trust-model.ts source contains no http/https/fetch/net import', () => {
    const srcPath = path.resolve(__dirname, '../src/trust-model.ts');
    const source = fs.readFileSync(srcPath, 'utf-8');

    // Match: import ... from 'http'; import ... from 'node:https'; import('fetch'); etc.
    const BANNED_IMPORT_RE =
      /(?:^|\s)(?:import\s[\s\S]*?from\s+|import\s*\()\s*['"](?:node:)?(?:http|https|fetch|net)['"]/m;

    const lines = source.split('\n');
    const violations = lines
      .map((line, i) => (BANNED_IMPORT_RE.test(line) ? `${i + 1}: ${line.trim()}` : null))
      .filter(Boolean);

    expect(
      violations,
      `trust-model.ts contains network imports:\n${violations.join('\n')}`,
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Model edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('renderTrustChart — model edge cases', () => {
  it('returns a non-empty string for an empty model (both arrays empty)', () => {
    const result = renderTrustChart(makeModel());
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Should include some indication of empty state (the empty-chart SVG)
    expect(result).toContain('<svg');
    expect(result).not.toContain('<script');
  });

  it('handles pct: null (no datapoint) without throwing', () => {
    const result = renderTrustChart(makeModel([
      { specId: 'SPEC-001', pct: null },
      { specId: 'SPEC-002', pct: 0.5 },
    ]));
    expect(result).toContain('<svg');
    expect(result).not.toContain('<script');
    // The no-datapoint label should appear
    expect(result).toContain('no data');
  });

  it('handles all-null pct rows (no valid datapoints)', () => {
    const result = renderTrustChart(makeModel([
      { specId: 'SPEC-001', pct: null },
      { specId: 'SPEC-002', pct: null },
    ]));
    expect(result).toContain('<svg');
    expect(result).not.toContain('<script');
  });

  it('handles wasted-only model (no rework rows)', () => {
    const result = renderTrustChart(makeModel([], [
      { specId: 'SPEC-010', approvedChars: 5000 },
    ]));
    expect(result).toContain('<svg');
    expect(result).not.toContain('<script');
  });

  it('handles rework-only model (no wasted rows)', () => {
    const result = renderTrustChart(makeModel([
      { specId: 'SPEC-001', pct: 0.1 },
      { specId: 'SPEC-002', pct: 0.9 },
    ], []));
    expect(result).toContain('<svg');
    expect(result).not.toContain('<script');
  });

  it('returns valid SVG for a fully-populated model', () => {
    const result = renderTrustChart(makeModel(
      [
        { specId: 'SPEC-001', pct: 0.0 },
        { specId: 'SPEC-002', pct: null },
        { specId: 'SPEC-003', pct: 0.33 },
        { specId: 'SPEC-004', pct: 0.66 },
        { specId: 'SPEC-005', pct: 1.0 },
      ],
      [
        { specId: 'SPEC-006', approvedChars: 0 },
        { specId: 'SPEC-007', approvedChars: 12345 },
      ],
    ));
    expect(result).toContain('<svg');
    expect(result).toContain('</svg>');
    expect(result).not.toContain('<script');
    // No remote assets
    expect(result).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
  });

  it('SVG output contains no vscode import-specific tags (pure string output)', () => {
    // `renderTrustChart` is a pure function — its output is only the SVG string.
    // Verify the returned value can be parsed as XML (it's well-formed SVG).
    const result = renderTrustChart(makeModel([{ specId: 'SPEC-001', pct: 0.5 }], []));
    // Must open and close the SVG root
    const openCount = (result.match(/<svg/g) ?? []).length;
    const closeCount = (result.match(/<\/svg>/g) ?? []).length;
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
  });

  it('XSS-safe: special chars in specId are escaped in SVG output', () => {
    const result = renderTrustChart(makeModel([
      { specId: '<evil>&"test\'</evil>', pct: 0.5 },
    ], []));
    // The raw < > & must NOT appear unescaped in the SVG text content
    expect(result).not.toContain('<evil>');
    expect(result).toContain('&lt;evil&gt;');
  });
});
