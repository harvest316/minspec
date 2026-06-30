/**
 * SPEC-017 Slice 6 — Trust chart model + pure inline-SVG renderer (FR-10, FR-12, AC-9).
 *
 * `TrustChartModel`     — read-only data model: M1 rework bars + M2 wasted-review bars.
 * `renderTrustChart`    — pure string→string. STATIC inline SVG only:
 *                          - NO <script> (so no nonce needed)
 *                          - NO http/https/fetch/net import
 *                          - NO remote asset (no src=/href= to a URL)
 *                          - NO vscode import
 *                          - NO crypto import
 *
 * INV — Tier-0 core: no network, no vscode, no crypto.
 * INV — Non-destructive: reads no spec bytes, writes nothing.
 */

/** One M1 rework bar. `pct === null` means no datapoint (first-ever / legacy record). */
export interface ReworkPoint {
  readonly specId: string;
  readonly pct: number | null; // [0, 1] | null (no datapoint)
}

/** One M2 wasted-review bar (superseded spec). */
export interface WastedPoint {
  readonly specId: string;
  readonly approvedChars: number;
}

/** Read-only chart data model built from specs + ledger. Pure data — no side effects. */
export interface TrustChartModel {
  readonly rework: ReadonlyArray<ReworkPoint>;
  readonly wasted: ReadonlyArray<WastedPoint>;
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG rendering constants
// ─────────────────────────────────────────────────────────────────────────────

const BAR_HEIGHT = 18;
const BAR_GAP = 6;
const LABEL_WIDTH = 90;
const BAR_MAX_WIDTH = 200;
const SECTION_GAP = 24;
const HEADER_H = 20;
const PADDING = 12;

// ─────────────────────────────────────────────────────────────────────────────
// Pure SVG escape helper (no HTML entity library — Tier-0, zero deps)
// ─────────────────────────────────────────────────────────────────────────────

function svgText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure string→string. Emits a static inline SVG showing:
 *   - M1 rework bars (green → red gradient by pct; grey for null/no-datapoint)
 *   - M2 wasted-review bars (orange, proportional to approvedChars)
 *
 * NO <script>, NO remote asset, NO network import, NO vscode, NO crypto.
 * Styles are inlined as SVG presentation attributes + a single <style> block
 * (covered by CSP `style-src 'unsafe-inline'` — no nonce required).
 */
export function renderTrustChart(model: TrustChartModel): string {
  const rework = model.rework;
  const wasted = model.wasted;

  const hasRework = rework.length > 0;
  const hasWasted = wasted.length > 0;

  if (!hasRework && !hasWasted) {
    return renderEmptyChart();
  }

  // Compute heights for each section
  const reworkSectionH = hasRework
    ? HEADER_H + rework.length * (BAR_HEIGHT + BAR_GAP)
    : 0;
  const wastedSectionH = hasWasted
    ? HEADER_H + wasted.length * (BAR_HEIGHT + BAR_GAP)
    : 0;

  const totalH =
    PADDING +
    (hasRework ? reworkSectionH : 0) +
    (hasRework && hasWasted ? SECTION_GAP : 0) +
    (hasWasted ? wastedSectionH : 0) +
    PADDING;

  const totalW = PADDING + LABEL_WIDTH + BAR_MAX_WIDTH + PADDING;

  const parts: string[] = [];
  parts.push(svgOpen(totalW, totalH));

  // Inline styles (CSP: style-src 'unsafe-inline' covers this — no nonce needed)
  parts.push(`<style>
    .tc-label { font: 11px/1 var(--vscode-font-family, -apple-system, sans-serif); fill: var(--vscode-descriptionForeground, #999); }
    .tc-section-label { font: 10px/1 var(--vscode-font-family, -apple-system, sans-serif); font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; fill: var(--vscode-descriptionForeground, #888); }
    .tc-no-data { font: 11px/1 var(--vscode-font-family, -apple-system, sans-serif); fill: var(--vscode-disabledForeground, #666); font-style: italic; }
    .tc-pct-label { font: 10px/1 var(--vscode-font-family, -apple-system, sans-serif); fill: var(--vscode-foreground, #ccc); }
  </style>`);

  let y = PADDING;

  // ── M1 rework section ────────────────────────────────────────────────────
  if (hasRework) {
    parts.push(sectionLabel('Char Rework (M1)', PADDING, y + HEADER_H - 4));
    y += HEADER_H;

    // Compute max pct for relative scale (null entries are skipped)
    const maxPct = rework.reduce((m, r) => (r.pct !== null ? Math.max(m, r.pct) : m), 0);

    for (const row of rework) {
      const barWidth =
        row.pct === null
          ? 0
          : maxPct > 0
            ? Math.round((row.pct / Math.max(maxPct, 0.01)) * BAR_MAX_WIDTH)
            : 0;

      const fill = row.pct === null
        ? 'var(--vscode-disabledForeground, #555)'
        : reworkFill(row.pct);

      parts.push(barRow({
        x: PADDING,
        y,
        label: svgText(row.specId),
        barWidth,
        barFill: fill,
        annotationText: row.pct === null
          ? 'no data'
          : `${Math.round(row.pct * 100)}%`,
        isNoData: row.pct === null,
      }));

      y += BAR_HEIGHT + BAR_GAP;
    }
  }

  // ── gap between sections ─────────────────────────────────────────────────
  if (hasRework && hasWasted) {
    y += SECTION_GAP;
  }

  // ── M2 wasted-review section ─────────────────────────────────────────────
  if (hasWasted) {
    parts.push(sectionLabel('Wasted Review (M2)', PADDING, y + HEADER_H - 4));
    y += HEADER_H;

    const maxChars = wasted.reduce((m, w) => Math.max(m, w.approvedChars), 0);

    for (const row of wasted) {
      const barWidth =
        maxChars > 0
          ? Math.round((row.approvedChars / maxChars) * BAR_MAX_WIDTH)
          : 0;

      parts.push(barRow({
        x: PADDING,
        y,
        label: svgText(row.specId),
        barWidth,
        barFill: 'var(--vscode-charts-orange, #cca700)',
        annotationText: `${row.approvedChars} ch`,
        isNoData: false,
      }));

      y += BAR_HEIGHT + BAR_GAP;
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-renderers (pure string helpers)
// ─────────────────────────────────────────────────────────────────────────────

function renderEmptyChart(): string {
  const w = PADDING + LABEL_WIDTH + BAR_MAX_WIDTH + PADDING;
  const h = PADDING + HEADER_H + PADDING;
  return [
    svgOpen(w, h),
    `<text x="${PADDING}" y="${PADDING + HEADER_H - 4}" class="tc-no-data">No trust data yet — approve a spec to begin.</text>`,
    '</svg>',
  ].join('\n');
}

function svgOpen(w: number, h: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="Trust chart">`;
}

function sectionLabel(label: string, x: number, y: number): string {
  return `<text x="${x}" y="${y}" class="tc-section-label">${svgText(label)}</text>`;
}

interface BarRowOpts {
  x: number;
  y: number;
  label: string;
  barWidth: number;
  barFill: string;
  annotationText: string;
  isNoData: boolean;
}

function barRow(opts: BarRowOpts): string {
  const { x, y, label, barWidth, barFill, annotationText, isNoData } = opts;
  const barX = x + LABEL_WIDTH;
  const labelY = y + Math.floor(BAR_HEIGHT * 0.72);

  const barEl = isNoData || barWidth === 0
    ? `<rect x="${barX}" y="${y}" width="2" height="${BAR_HEIGHT}" fill="var(--vscode-disabledForeground, #444)" rx="1" />`
    : `<rect x="${barX}" y="${y}" width="${barWidth}" height="${BAR_HEIGHT}" fill="${barFill}" rx="2" />`;

  const annotX = barX + Math.max(barWidth, 4) + 4;
  const annotClass = isNoData ? 'tc-no-data' : 'tc-pct-label';

  return [
    `<text x="${x + LABEL_WIDTH - 4}" y="${labelY}" class="tc-label" text-anchor="end">${label}</text>`,
    barEl,
    `<text x="${annotX}" y="${labelY}" class="${annotClass}">${svgText(annotationText)}</text>`,
  ].join('\n');
}

/**
 * Rework bar colour: green (0%) → yellow (50%) → red (100%).
 * Uses CSS custom properties for VS Code theme compatibility; falls back to
 * hard-coded hex for environments without VS Code token resolution.
 */
function reworkFill(pct: number): string {
  if (pct < 0.33) return 'var(--vscode-testing-iconPassed, #73c991)';
  if (pct < 0.66) return 'var(--vscode-charts-yellow, #cca700)';
  return 'var(--vscode-charts-red, #f14c4c)';
}
