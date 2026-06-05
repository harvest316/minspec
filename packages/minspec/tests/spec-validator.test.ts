import { describe, it, expect } from 'vitest';
import { validateSpec, validateSplitLayoutCoverage } from '../src/lib/spec-validator';
import type { SplitLayoutFile } from '../src/lib/spec-validator';
import { parseSpec } from '../src/lib/spec';
import { DEFAULT_CONFIG } from '../src/lib/config';

function spec(fm: Record<string, string>, body: string): string {
  const phases = fm.phases ?? 'specify: done\n  clarify: pending\n  plan: done\n  tasks: done\n  implement: in-progress';
  const front = [
    '---',
    `id: ${fm.id ?? 'SPEC-001'}`,
    `title: ${fm.title ?? 'Test Spec'}`,
    `tier: ${fm.tier ?? 'T3'}`,
    `status: ${fm.status ?? 'implementing'}`,
    `created: 2026-05-30`,
    fm.aspects ? `aspects: ${fm.aspects}` : '',
    'phases:',
    '  ' + phases,
    '---',
    '',
  ].filter((l) => l !== '').join('\n');
  return front + '\n' + body;
}

const FULL_T3 = `## Specify
Build the thing.
- [ ] criterion one
- [ ] criterion two

## Plan
Do it in steps.

## Tasks
- [ ] task a

## Implement
code goes here.
`;

describe('validateSpec — required sections', () => {
  it('T3 complete spec with criteria passes', () => {
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, FULL_T3)), DEFAULT_CONFIG);
    expect(r.complete).toBe(true);
    expect(r.violations.filter((v) => v.severity === 'error')).toHaveLength(0);
  });

  it('T3 missing plan section is an error → incomplete', () => {
    const body = `## Specify\nthing\n- [ ] c1\n\n## Tasks\n- [ ] t\n\n## Implement\nx\n`;
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.complete).toBe(false);
    expect(r.violations.some((v) => v.rule === 'section.plan.empty' && v.severity === 'error')).toBe(true);
  });

  it('T1 missing optional sections does not error', () => {
    const r = validateSpec(parseSpec(spec({ tier: 'T1' }, `## Specify\none liner\n`)), DEFAULT_CONFIG);
    expect(r.complete).toBe(true);
  });
});

describe('validateSpec — acceptance criteria', () => {
  it('T3 without acceptance criteria errors', () => {
    const body = `## Specify\nprose only no checkboxes\n\n## Plan\np\n\n## Tasks\n- [ ] t\n\n## Implement\ni\n`;
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'acceptance.missing')).toBe(true);
    expect(r.complete).toBe(false);
  });

  it('explicit Acceptance Criteria section satisfies', () => {
    const body = FULL_T3.replace('- [ ] criterion one\n- [ ] criterion two', 'prose') +
      '\n## Acceptance Criteria\n- must work\n';
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'acceptance.missing')).toBe(false);
  });

  it('missing-criteria fixHint points at the canonical FR/INV checkbox format', () => {
    const body = `## Specify\nprose only no checkboxes\n\n## Plan\np\n\n## Tasks\n- [ ] t\n\n## Implement\ni\n`;
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    const v = r.violations.find((x) => x.rule === 'acceptance.missing');
    expect(v).toBeDefined();
    expect(v?.fixHint).toContain('## Acceptance Criteria');
    // describes a plain-language outcome tracing to its FR/INV
    expect(v?.fixHint).toMatch(/FR\/INV/);
    // points the author at the canonical example output (real palette title)
    expect(v?.fixHint).toContain('MinSpec: Generate Example Spec');
  });
});

// T3 regression (#153.2): the checkbox-acceptance FALLBACK read only
// `phaseSections.specify`, but the parser maps a heading to phaseSections only when
// its text is a literal Phase name (`specify`). A `type: requirements` spec carries a
// `## Requirements` heading (which maps to NO phase), so the fallback's source string
// was always '' and could never fire — a requirements spec whose acceptance checklist
// lives under `## Requirements` was FALSELY flagged `acceptance.missing`, and the
// fixHint promised an impossible remedy ("a checkbox list in the Specify section") for
// a file that has no Specify section. The fallback now also scans the Requirements
// section, and the fixHint is honest for requirements specs.
describe('validateSpec — acceptance checkbox fallback for requirements specs (#153.2)', () => {
  // A `type: requirements` spec uses `## Requirements`, not `## Specify`. Build inline
  // (the spec() helper assumes a single-file `## Specify` layout).
  function reqSpec(tier: string, body: string): string {
    return [
      '---',
      'id: SPEC-019',
      'type: requirements',
      `tier: ${tier}`,
      'status: specifying',
      'product: minspec',
      '---',
      '',
      body,
    ].join('\n');
  }

  it('a checkbox list under ## Requirements satisfies acceptance (was impossible before)', () => {
    const body = '# Reqs\n\n## Requirements\n- [ ] **Honest degradation** — incoherent state surfaces \'state unclear\'. (FR-6)\n- [ ] **Never blocks** — warning only. (FR-9)\n';
    const r = validateSpec(parseSpec(reqSpec('T4', body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'acceptance.missing')).toBe(false);
  });

  it('a requirements spec with NO checklist and no acceptance section still errors (true positive)', () => {
    const body = '# Reqs\n\n## Requirements\n- **FR-1** prose requirement, no checkbox.\n- **FR-2** another.\n';
    const r = validateSpec(parseSpec(reqSpec('T4', body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'acceptance.missing' && v.severity === 'error')).toBe(true);
  });

  it('the acceptance fixHint names the Requirements section, not only Specify (honest remedy)', () => {
    const body = '# Reqs\n\n## Requirements\n- **FR-1** prose only.\n';
    const r = validateSpec(parseSpec(reqSpec('T4', body)), DEFAULT_CONFIG);
    const v = r.violations.find((x) => x.rule === 'acceptance.missing');
    expect(v).toBeDefined();
    // mentions the Requirements section as a valid place for the checklist
    expect(v!.fixHint).toMatch(/Requirements/);
  });

  it('an explicit ## Acceptance Criteria section still satisfies a requirements spec (no regression)', () => {
    const body = '# Reqs\n\n## Requirements\nprose\n\n## Acceptance Criteria\n- must work\n';
    const r = validateSpec(parseSpec(reqSpec('T3', body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'acceptance.missing')).toBe(false);
  });

  it('a single-file spec still satisfies via a checkbox in ## Specify (no regression)', () => {
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, FULL_T3)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'acceptance.missing')).toBe(false);
  });
});

describe('validateSpec — aspect: ux', () => {
  const uxBody = FULL_T3.replace('Build the thing.', 'Build the new settings screen with a toggle button.');

  it('declared ux aspect without mockup errors at T3', () => {
    const r = validateSpec(parseSpec(spec({ tier: 'T3', aspects: 'ux' }, uxBody)), DEFAULT_CONFIG);
    expect(r.effectiveAspects).toContain('ux');
    expect(r.violations.some((v) => v.rule === 'aspect.ux.no-mockup' && v.severity === 'error')).toBe(true);
    expect(r.complete).toBe(false);
  });

  it('detected-only ux aspect softens to warning (still complete)', () => {
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, uxBody)), DEFAULT_CONFIG);
    expect(r.detectedAspects).toContain('ux');
    const v = r.violations.find((x) => x.rule === 'aspect.ux.no-mockup');
    expect(v?.severity).toBe('warning');
    expect(r.complete).toBe(true);
  });

  it('ux aspect WITH an image mockup passes', () => {
    const r = validateSpec(parseSpec(spec({ tier: 'T3', aspects: 'ux' },
      uxBody + '\n## UX\n![wireframe](./mock.png)\n')), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.ux.no-mockup')).toBe(false);
  });

  it('ux aspect WITH a mermaid diagram passes', () => {
    const r = validateSpec(parseSpec(spec({ tier: 'T3', aspects: 'ux' },
      uxBody + '\n## UX\n```mermaid\nflowchart TD\n A-->B\n```\n')), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.ux.no-mockup')).toBe(false);
  });
});

// T3 regression (#153.3): TWO coupled defects in the ux aspect/mockup gate.
//  (1) DEAD section clause + operator precedence. `aspect.ux.no-mockup` was
//      `hasImage || hasSection(…) && (…) || hasAsciiBox || hasMermaid`. With `&&`
//      binding tighter than `||`, the trailing `|| hasAsciiBox || hasMermaid` made ANY
//      box/mermaid ANYWHERE satisfy the rule — the section-scoped clause never
//      enforced. So a UX spec whose only "mockup" was an unrelated architecture box
//      passed. Fix: parenthesize so a box/mermaid counts ONLY under a mockup section.
//  (2) ux OVER-detection. `component`/`view`/`page`/`layout`/`form`/`icon` were STRONG
//      single-hit keywords, so a software "component", a `*-view.ts` filename, or a
//      titlebar "icon" flagged architecture/data design specs as a UX surface with no
//      mockup. Fix (the #108/#153.4 pattern): strong/ambiguous split + scan
//      code-stripped prose, so a code identifier or a lone ambiguous word never fires.
//  Naively fixing (1) alone re-flagged 3 real design specs (SPEC-002/004/008); the cure
//  for the over-detection (2) plus broadening the mockup-section allowlist to the REAL
//  headings those specs use (e.g. `## UI Components`) keeps the real corpus clean.
describe('validateSpec — ux mockup gate enforcement + over-detection cure (#153.3)', () => {
  const uxBody = FULL_T3.replace('Build the thing.', 'Build the new settings screen with a toggle button.');

  // ── (1) the section requirement now actually enforces (was dead) ──
  it('a declared ux spec with an ASCII box NOT under a mockup section is FLAGGED (dead clause cured)', () => {
    // The box lives under the Plan section, not a UX/UI/mockup heading. Before the
    // precedence fix, the bare box satisfied the rule and the spec passed.
    const body = uxBody + '\n## Plan\n```\n┌────────┐\n│ thing  │\n└────────┘\n```\n';
    const r = validateSpec(parseSpec(spec({ tier: 'T3', aspects: 'ux' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.ux.no-mockup' && v.severity === 'error')).toBe(true);
  });

  it('a declared ux spec with a real ASCII mockup UNDER a "## UX" section passes', () => {
    const body = uxBody + '\n## UX\n```\n┌────────┐\n│ Button │\n└────────┘\n```\n';
    const r = validateSpec(parseSpec(spec({ tier: 'T3', aspects: 'ux' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.ux.no-mockup')).toBe(false);
  });

  it('a real ASCII mockup under a broadened "## UI Components" heading satisfies the gate (SPEC-002 shape)', () => {
    // SPEC-002 carries its sidebar tree-view mockup under `## UI Components`, which the
    // original narrow ux|mockup|wireframe|design allowlist missed.
    const body = uxBody + '\n## UI Components\n```\nMINSPEC\n├─ Specs\n│  └─ SPEC-001\n└─ Settings\n```\n';
    const r = validateSpec(parseSpec(spec({ tier: 'T3', aspects: 'ux' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.ux.no-mockup')).toBe(false);
  });

  it('a declared ux spec with NO mockup at all is still FLAGGED (true positive preserved)', () => {
    const r = validateSpec(parseSpec(spec({ tier: 'T3', aspects: 'ux' }, uxBody)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.ux.no-mockup' && v.severity === 'error')).toBe(true);
  });

  // ── (2) over-detection cure: ambiguous words / code identifiers no longer trip ux ──
  it('a lone "component" in prose does NOT detect ux (SPEC-004: "network-only component")', () => {
    const body = FULL_T3.replace('Build the thing.', 'A network-only component fetches the dataset.');
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.detectedAspects, '"component" alone tripped ux').not.toContain('ux');
    expect(r.violations.some((v) => v.rule === 'aspect.ux.no-mockup')).toBe(false);
  });

  it('a lone "view"/"page"/"icon"/"layout"/"form" in prose does NOT detect ux', () => {
    for (const word of ['view', 'page', 'icon', 'layout', 'form']) {
      const body = FULL_T3.replace('Build the thing.', `The ${word} is computed from existing data.`);
      const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
      expect(r.detectedAspects, `"${word}" alone tripped ux`).not.toContain('ux');
    }
  });

  it('a code identifier (`backlog-view.ts`) in a code span does NOT detect ux (SPEC-008 shape)', () => {
    // "view" + "icon" both arrive via code/incidental tokens; stripping code spans
    // leaves only "icon" (one ambiguous), so ux does not fire.
    const body = FULL_T3.replace(
      'Build the thing.',
      'The `backlog-view.ts` module resolves the epic, flipped by a titlebar nav icon.',
    );
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.detectedAspects, 'code-span view + lone icon tripped ux').not.toContain('ux');
    expect(r.violations.some((v) => v.rule === 'aspect.ux.no-mockup')).toBe(false);
  });

  it('a single STRONG ux keyword still detects the ux aspect (no regression)', () => {
    for (const word of ['screen', 'button', 'modal', 'dialog', 'wireframe', 'menu']) {
      const body = FULL_T3.replace('Build the thing.', `Add a ${word} to the app.`);
      const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
      expect(r.detectedAspects, `"${word}" failed to detect ux`).toContain('ux');
    }
  });

  it('TWO corroborating ambiguous ux keywords do detect the ux aspect', () => {
    const body = FULL_T3.replace('Build the thing.', 'The page layout arranges the form fields.');
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.detectedAspects).toContain('ux');
  });
});

describe('validateSpec — aspect: api', () => {
  const apiBody = FULL_T3.replace('Build the thing.', 'Add a POST /users endpoint returning a response payload.');

  it('declared api aspect without schema errors at T4', () => {
    const r = validateSpec(parseSpec(spec({ tier: 'T4', aspects: 'api' }, apiBody)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.api.no-schema' && v.severity === 'error')).toBe(true);
  });

  it('api aspect WITH a json fence passes', () => {
    const r = validateSpec(parseSpec(spec({ tier: 'T4', aspects: 'api' },
      apiBody + '\n## API\n```json\n{ "id": 1 }\n```\n')), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.api.no-schema')).toBe(false);
  });
});

// T3 regression (#108): the api aspect keyword set included bare ambiguous English
// words — `rest` (REST vs "the rest"), and similarly `route`/`request`/`response`/
// `http` appear in everyday prose. Word-boundary matching alone can't tell REST from
// rest, so SPEC-015 (status-lanes), which defines NO api, tripped `aspect.api.no-schema`
// on the phrase "…the rest". Fix: bare `rest` dropped; a single *ambiguous* keyword no
// longer triggers the aspect — it needs a real API signal (one *strong* keyword) OR
// ≥2 corroborating keywords.
describe('validateSpec — api aspect false-positives (#108)', () => {
  it('prose "the rest" does NOT detect the api aspect (the SPEC-015 bug)', () => {
    // Verbatim shape of the SPEC-015 prose that tripped the false positive.
    const body = FULL_T3.replace(
      'Build the thing.',
      'Done and Archived lanes collapse by default; the rest stay expanded.',
    );
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.detectedAspects).not.toContain('api');
    expect(r.violations.some((v) => v.rule === 'aspect.api.no-schema')).toBe(false);
  });

  it('a single ambiguous keyword in prose does not detect the api aspect', () => {
    // 'route' / 'request' / 'response' / 'http' are each ambiguous English words;
    // one alone (no corroboration) must not flag an api surface.
    for (const word of ['route', 'request', 'response']) {
      const body = FULL_T3.replace('Build the thing.', `The user can ${word} through the menu.`);
      const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
      expect(r.detectedAspects, `"${word}" alone tripped api`).not.toContain('api');
    }
  });

  it('a single STRONG api keyword still detects the api aspect', () => {
    // Unambiguous signals must keep working — one is enough.
    for (const word of ['endpoint', 'webhook', 'graphql', 'payload']) {
      const body = FULL_T3.replace('Build the thing.', `Add a ${word} to the service.`);
      const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
      expect(r.detectedAspects, `"${word}" failed to detect api`).toContain('api');
    }
  });

  it('"REST API" / "RESTful" prose still detects the api aspect (real signal)', () => {
    for (const phrase of ['Expose a REST API for clients.', 'A RESTful service.']) {
      const body = FULL_T3.replace('Build the thing.', phrase);
      const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
      expect(r.detectedAspects, `"${phrase}" failed to detect api`).toContain('api');
    }
  });

  it('TWO corroborating ambiguous keywords do detect the api aspect', () => {
    // request + response + route together is a genuine API signal even without a strong word.
    const body = FULL_T3.replace('Build the thing.', 'Define the request and response shapes for the route.');
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.detectedAspects).toContain('api');
  });
});

// T3 regression (#153.4): siblings of the shipped #108 fix.
//  (api) `request` + `response` are the SOFTEST ambiguous keywords — both are everyday
//        UX/interaction prose ("the user's request", "in response to a click"). The
//        #108 rule (≥2 ambiguous ⇒ api) let that pair trip `aspect.api.no-schema` on UX
//        prose with no API at all. The corroboration is tightened so the soft pair needs
//        a STRUCTURAL ambiguous keyword (route/http) or a strong keyword to corroborate —
//        request+response alone no longer fires; request+route / response+http still do.
//  (data) the data aspect had a FLAT keyword list (no strong/ambiguous split, unlike api).
//        `table`/`query`/`index` are polysemous (markdown table, "query the user",
//        "index.md"), so a lone one tripped `aspect.data.no-schema`. The same #108
//        strong/ambiguous split is now applied to data: one ambiguous word alone never
//        fires; it needs a strong data keyword OR ≥2 ambiguous corroborating.
describe('validateSpec — api/data over-match on polysemous prose (#153.4)', () => {
  // ── api: the soft request+response pair ──
  it('request + response in UX prose (no route/http, no strong) does NOT detect api', () => {
    const body = FULL_T3.replace(
      'Build the thing.',
      "On the user's request, in response to a click, the panel expands.",
    );
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.detectedAspects).not.toContain('api');
    expect(r.violations.some((v) => v.rule === 'aspect.api.no-schema')).toBe(false);
  });

  it('request + route (a structural ambiguous keyword) still detects api', () => {
    const body = FULL_T3.replace('Build the thing.', 'The route handles the incoming request.');
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.detectedAspects).toContain('api');
  });

  it('response + http still detects api', () => {
    const body = FULL_T3.replace('Build the thing.', 'Return an http response.');
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.detectedAspects).toContain('api');
  });

  it('request + response WITH a strong api keyword still detects api', () => {
    const body = FULL_T3.replace('Build the thing.', 'The endpoint takes a request and returns a response.');
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.detectedAspects).toContain('api');
  });

  // ── data: polysemous table/query/index ──
  it('a lone "table" in prose (markdown table) does NOT detect data', () => {
    const body = FULL_T3.replace('Build the thing.', 'Render the results in a table on the page.');
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.detectedAspects, '"table" alone tripped data').not.toContain('data');
    expect(r.violations.some((v) => v.rule === 'aspect.data.no-schema')).toBe(false);
  });

  it('a lone "query"/"index" in prose does NOT detect data', () => {
    for (const word of ['query', 'index']) {
      const body = FULL_T3.replace('Build the thing.', `We ${word} the user before proceeding.`);
      const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
      expect(r.detectedAspects, `"${word}" alone tripped data`).not.toContain('data');
    }
  });

  it('a single STRONG data keyword still detects the data aspect', () => {
    for (const word of ['schema', 'migration', 'database', 'column', 'entity', 'sql']) {
      const body = FULL_T3.replace('Build the thing.', `Add a ${word} to the store.`);
      const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
      expect(r.detectedAspects, `"${word}" failed to detect data`).toContain('data');
    }
  });

  it('TWO corroborating ambiguous data keywords (table + query) detect the data aspect', () => {
    const body = FULL_T3.replace('Build the thing.', 'Add an index and a query against the table.');
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.detectedAspects).toContain('data');
  });

  it('a strong data keyword without a schema artifact still ERRORS at T4 (no over-soften)', () => {
    const body = FULL_T3.replace('Build the thing.', 'Add a database migration for the new column.');
    const r = validateSpec(parseSpec(spec({ tier: 'T4', aspects: 'data' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.data.no-schema' && v.severity === 'error')).toBe(true);
  });
});

describe('validateSpec — aspect: architecture', () => {
  it('declared architecture aspect without diagram errors at T4', () => {
    const body = FULL_T3.replace('Build the thing.', 'Introduce a new broker service and message queue subsystem.');
    const r = validateSpec(parseSpec(spec({ tier: 'T4', aspects: 'architecture' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.architecture.no-diagram' && v.severity === 'error')).toBe(true);
  });
});

// T3 regression (#153.1): a plain markdown table tripped `hasAsciiBox`, because the
// box-line regex counted any line beginning with `|` — and a markdown table row starts
// with `|`. 3+ table rows therefore read as an "ascii box", FALSELY satisfying the
// ux/architecture diagram gates (a false negative: the gate passes on prose-plus-table
// with no real diagram/mockup). A markdown table is NOT a wireframe nor a component
// diagram. The fix tightens box detection to require a genuine box-drawing glyph or a
// +--- frame, excluding markdown table rows — while a REAL ascii diagram (which uses
// box-drawing chars / +---) still satisfies the gate.
describe('validateSpec — markdown table is not an ascii box (#153.1)', () => {
  const TABLE = '\n| Mode | Trigger | Sandbox |\n|---|---|---|\n| Manual | human | no |\n| Auto | cron | yes |\n';
  const ASCII_BOX = '\n```\n┌──────────┐\n│  Widget  │\n└──────────┘\n```\n';
  const PLUS_BOX = '\n+----------+\n|  Widget  |\n+----------+\n';

  it('a declared ux aspect with ONLY a markdown table still errors (table ≠ mockup)', () => {
    const body = FULL_T3.replace('Build the thing.', 'Build the settings screen.') + TABLE;
    const r = validateSpec(parseSpec(spec({ tier: 'T3', aspects: 'ux' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.ux.no-mockup' && v.severity === 'error')).toBe(true);
  });

  it('a declared architecture aspect with ONLY a markdown table still errors (table ≠ diagram)', () => {
    const body = FULL_T3.replace('Build the thing.', 'Introduce a new broker subsystem.') + TABLE;
    const r = validateSpec(parseSpec(spec({ tier: 'T4', aspects: 'architecture' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.architecture.no-diagram' && v.severity === 'error')).toBe(true);
  });

  it('a REAL unicode ascii box still satisfies the architecture diagram gate (no regression)', () => {
    const body = FULL_T3.replace('Build the thing.', 'Introduce a new broker subsystem.') + ASCII_BOX;
    const r = validateSpec(parseSpec(spec({ tier: 'T4', aspects: 'architecture' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.architecture.no-diagram')).toBe(false);
  });

  it('a REAL +--- frame box still satisfies the architecture diagram gate (no regression)', () => {
    const body = FULL_T3.replace('Build the thing.', 'Introduce a new broker subsystem.') + PLUS_BOX;
    const r = validateSpec(parseSpec(spec({ tier: 'T4', aspects: 'architecture' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.architecture.no-diagram')).toBe(false);
  });

  it('a markdown table AND a real ascii box together still satisfies (box counted, table ignored)', () => {
    const body = FULL_T3.replace('Build the thing.', 'Introduce a new broker subsystem.') + TABLE + ASCII_BOX;
    const r = validateSpec(parseSpec(spec({ tier: 'T4', aspects: 'architecture' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.architecture.no-diagram')).toBe(false);
  });
});

describe('validateSpec — epic reference (DR-013 FR-9)', () => {
  // Spec with an `epic:` frontmatter field (the spec() helper omits it, so build inline).
  function specWithEpic(epicRef: string): string {
    return [
      '---',
      'id: SPEC-001',
      'title: Test',
      'tier: T3',
      'status: implementing',
      'created: 2026-05-30',
      `epic: ${epicRef}`,
      'phases:',
      '  specify: done',
      '  clarify: pending',
      '  plan: done',
      '  tasks: done',
      '  implement: in-progress',
      '---',
      '',
      FULL_T3,
    ].join('\n');
  }

  it('warns (never errors) when the epic ref does not resolve', () => {
    const known = new Set(['epic-001', 'telemetry']);
    const r = validateSpec(parseSpec(specWithEpic('nope')), DEFAULT_CONFIG, known);
    const v = r.violations.find((x) => x.rule === 'epic.unresolved');
    expect(v).toBeDefined();
    expect(v!.severity).toBe('warning');
    // warning must not break completeness
    expect(r.complete).toBe(true);
  });

  it('does not warn when the ref resolves (by id or slug, case-insensitive)', () => {
    const known = new Set(['epic-001', 'telemetry']);
    expect(validateSpec(parseSpec(specWithEpic('EPIC-001')), DEFAULT_CONFIG, known)
      .violations.some((x) => x.rule === 'epic.unresolved')).toBe(false);
    expect(validateSpec(parseSpec(specWithEpic('Telemetry')), DEFAULT_CONFIG, known)
      .violations.some((x) => x.rule === 'epic.unresolved')).toBe(false);
  });

  it('does not warn when no registry set is supplied (check skipped)', () => {
    const r = validateSpec(parseSpec(specWithEpic('whatever')), DEFAULT_CONFIG);
    expect(r.violations.some((x) => x.rule === 'epic.unresolved')).toBe(false);
  });

  it('warns epic.missing (never errors) when the spec has no epic field but epics are registered', () => {
    // Regression: SPEC-004 sat orphaned because a missing `epic:` was not flagged —
    // only a *dangling* ref was. A missing ref strands the spec under "(no epic)"
    // just the same, so it must surface too.
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, FULL_T3)), DEFAULT_CONFIG, new Set(['epic-001']));
    const v = r.violations.find((x) => x.rule === 'epic.missing');
    expect(v).toBeDefined();
    expect(v!.severity).toBe('warning');
    expect(r.complete).toBe(true); // warning must not break completeness
    // and it is reported as missing, not as an unresolved ref
    expect(r.violations.some((x) => x.rule === 'epic.unresolved')).toBe(false);
  });

  it('does not warn epic.missing when no epics are registered (pre-epic repo, graceful)', () => {
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, FULL_T3)), DEFAULT_CONFIG, new Set());
    expect(r.violations.some((x) => x.rule === 'epic.missing')).toBe(false);
  });

  it('does not warn epic.missing when no registry set is supplied (check skipped)', () => {
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, FULL_T3)), DEFAULT_CONFIG);
    expect(r.violations.some((x) => x.rule === 'epic.missing')).toBe(false);
  });
});

describe('validateSpec — split-layout (#93 regression)', () => {
  // A split-layout phase file (`type: design`) carries no in-file
  // ## Plan/## Clarify/## Implement sections — those live in sibling
  // requirements.md / tasks.md. It MUST NOT be flagged for missing phase
  // sections, and (not being the requirements/specify file) MUST NOT be
  // required to carry acceptance criteria. Regression: issue #93.
  const splitDesign = `---
id: SPEC-002
type: design
tier: T4
status: implementing
product: minspec
---

# Design Document

## Architecture Overview
The design content lives here; phase sections live in sibling files.
`;

  it('split-layout design file does not error on missing phase sections', () => {
    const r = validateSpec(parseSpec(splitDesign), DEFAULT_CONFIG);
    const phaseErrors = r.violations.filter((v) => /^section\.\w+\.empty$/.test(v.rule));
    expect(phaseErrors).toHaveLength(0);
  });

  it('split-layout design file does not error on missing acceptance criteria', () => {
    const r = validateSpec(parseSpec(splitDesign), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'acceptance.missing')).toBe(false);
  });

  it('split-layout design file is complete (approvable)', () => {
    const r = validateSpec(parseSpec(splitDesign), DEFAULT_CONFIG);
    expect(r.complete).toBe(true);
  });

  it('single-file spec still enforces phase sections (no regression)', () => {
    const body = `## Specify\nthing\n- [ ] c1\n\n## Tasks\n- [ ] t\n\n## Implement\nx\n`;
    const r = validateSpec(parseSpec(spec({ tier: 'T3' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'section.plan.empty' && v.severity === 'error')).toBe(true);
  });

  // Aspect artifacts (mockup/schema/diagram) are design-phase deliverables: a
  // tasks/requirements file that references a UX/API surface must not be flagged
  // for a missing artifact that lives in the sibling design file. (#93 class.)
  const splitTasksWithAspects = `---
id: SPEC-003
type: tasks
tier: T3
status: implementing
product: minspec
aspects: [ux, api, data, architecture]
---

# Task Breakdown
- [ ] build the dashboard, wire the endpoint, migrate the table
`;

  it('split-layout tasks file does not flag missing design artifacts', () => {
    const r = validateSpec(parseSpec(splitTasksWithAspects), DEFAULT_CONFIG);
    expect(r.violations.filter((v) => /^aspect\./.test(v.rule))).toHaveLength(0);
    expect(r.complete).toBe(true);
  });

  it('architecture aspect satisfied by a flow diagram in a fence (any section name)', () => {
    const body = `---
id: SPEC-X
type: design
tier: T3
status: implementing
product: minspec
aspects: [architecture]
---

# Design
## Data flow
\`\`\`
fetch.mjs ──network──> subset ──> .data/instances.json
                                        │
labels.json ──────────────────────┐    │
                                   ▼    ▼
  harness reads both
\`\`\`
`;
    const r = validateSpec(parseSpec(body), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.architecture.no-diagram')).toBe(false);
  });

  it('architecture aspect STILL flagged when there is no diagram at all', () => {
    const body = `---
id: SPEC-Y
type: design
tier: T3
status: implementing
product: minspec
aspects: [architecture]
---

# Design
## Overview
Prose only, no diagram, no fence.
`;
    const r = validateSpec(parseSpec(body), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.architecture.no-diagram')).toBe(true);
  });

  it('split-layout design file STILL enforces aspect artifacts', () => {
    const splitDesignUx = `---
id: SPEC-002
type: design
tier: T3
status: implementing
product: minspec
aspects: [ux]
---

# Design
## Architecture
no mockup here.
`;
    const r = validateSpec(parseSpec(splitDesignUx), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.ux.no-mockup')).toBe(true);
  });
});

// #111: per-file #93 skip left the DIRECTORY-level question unasked — does the SET
// of sibling split-layout files cover the tier's required, file-backed phases? A T3
// dir with only requirements.md (no design.md / tasks.md) validated clean. This block
// pins the new cross-file coverage gate: an incomplete split set is flagged (warning),
// a complete one passes, and a non-split set is not its concern. WARNING severity is
// load-bearing — mid-authoring dirs (requirements-only) must surface, not block.
describe('validateSplitLayoutCoverage — split-layout cross-file coverage (#111)', () => {
  const f = (type: string, tier?: string): SplitLayoutFile =>
    ({ type, ...(tier ? { tier: tier as SplitLayoutFile['tier'] } : {}) });

  it('flags an INCOMPLETE T3 split set: requirements only (missing design + tasks)', () => {
    const r = validateSplitLayoutCoverage([f('requirements', 'T3')], DEFAULT_CONFIG);
    expect(r.notSplitLayout).toBe(false);
    const rules = r.violations.map((v) => v.rule).sort();
    expect(rules).toEqual(['split-coverage.design.missing', 'split-coverage.tasks.missing']);
    // Coverage gaps are warnings — they must NOT block (mid-authoring is legitimate).
    expect(r.violations.every((v) => v.severity === 'warning')).toBe(true);
  });

  it('passes a COMPLETE T3 split set: requirements + design + tasks', () => {
    const r = validateSplitLayoutCoverage(
      [f('requirements', 'T3'), f('design'), f('tasks')],
      DEFAULT_CONFIG,
    );
    expect(r.notSplitLayout).toBe(false);
    expect(r.violations).toHaveLength(0);
  });

  it('flags a T3 split set missing only tasks.md', () => {
    const r = validateSplitLayoutCoverage(
      [f('requirements', 'T3'), f('design')],
      DEFAULT_CONFIG,
    );
    expect(r.violations.map((v) => v.rule)).toEqual(['split-coverage.tasks.missing']);
  });

  it('passes a COMPLETE T2 split set: requirements + design (T2 needs specify + plan, not tasks)', () => {
    const r = validateSplitLayoutCoverage(
      [f('requirements', 'T2'), f('design')],
      DEFAULT_CONFIG,
    );
    expect(r.violations).toHaveLength(0);
  });

  it('flags a T2 split set missing design.md (plan phase uncovered)', () => {
    const r = validateSplitLayoutCoverage([f('requirements', 'T2')], DEFAULT_CONFIG);
    expect(r.violations.map((v) => v.rule)).toEqual(['split-coverage.design.missing']);
  });

  it('passes a T1 split set: requirements only (T1 requires specify only)', () => {
    const r = validateSplitLayoutCoverage([f('requirements', 'T1')], DEFAULT_CONFIG);
    expect(r.violations).toHaveLength(0);
  });

  it('reports notSplitLayout for a set with NO split `type:` files', () => {
    const r = validateSplitLayoutCoverage([f(''), f('')], DEFAULT_CONFIG);
    expect(r.notSplitLayout).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('takes the tier from requirements.md, not a secondary file', () => {
    // requirements is T3 (needs design + tasks); a stray T1 design tier must not win.
    const r = validateSplitLayoutCoverage(
      [f('requirements', 'T3'), f('design', 'T1')],
      DEFAULT_CONFIG,
    );
    expect(r.violations.map((v) => v.rule)).toEqual(['split-coverage.tasks.missing']);
  });

  it('uses fallback tier when no file declares a tier', () => {
    // No tier anywhere → fallback T2 (specify + plan). Only requirements present →
    // design.md (plan) is the one missing file.
    const r = validateSplitLayoutCoverage([f('requirements')], DEFAULT_CONFIG, 'T2');
    expect(r.violations.map((v) => v.rule)).toEqual(['split-coverage.design.missing']);
  });

  it('a full T4 split set passes (clarify/implement are not separate files)', () => {
    // T4 requires specify, clarify, plan, tasks, implement — but clarify lives in
    // requirements.md and implement in tasks.md, so the file SET is the same three.
    const r = validateSplitLayoutCoverage(
      [f('requirements', 'T4'), f('design'), f('tasks')],
      DEFAULT_CONFIG,
    );
    expect(r.violations).toHaveLength(0);
  });
});

// T3 regression (#115 follow-up): the parser coerces an unrecognized `status`/
// `tier` to a hardcoded default ('new'/'T2'). Post-parse that is indistinguishable
// from a genuine default, so the SPECS pane shows a FALSE status (signpost-lie) with
// no signal. The asymmetric gate: validateSpec asserts dangling/missing epic refs but
// never that a PRESENT status/tier is a recognized enum member. This gate closes it —
// re-reading the RAW frontmatter line (lossy after coercion) and WARNING (never
// blocking — foreign vocabularies like Spec Kit's `draft` are legitimate, just not
// MinSpec's) when a present value is unknown.
describe('validateSpec — unrecognized closed-enum frontmatter (#115)', () => {
  function rawSpec(fm: string): string {
    return `---\n${fm}\ncreated: 2026-05-30\nphases:\n  specify: done\n  clarify: pending\n  plan: done\n  tasks: done\n  implement: in-progress\n---\n\n## Specify\nBuild it.\n- [ ] c1\n\n## Plan\nSteps.\n\n## Tasks\n- [ ] t\n\n## Implement\ncode.\n`;
  }

  it('warns when status is present but not a recognized SpecStatus (typo)', () => {
    // 'implmenting' (typo) parses to 'new' silently — must be surfaced as a warning.
    const r = validateSpec(
      parseSpec(rawSpec('id: SPEC-009\ntitle: Y\ntier: T3\nstatus: implmenting')),
      DEFAULT_CONFIG,
    );
    const v = r.violations.find((x) => x.rule === 'frontmatter.status.unknown');
    expect(v).toBeDefined();
    expect(v!.severity).toBe('warning');
    expect(v!.message).toContain('implmenting');
    // Never an error — must not block approval.
    expect(r.violations.some((x) => x.rule === 'frontmatter.status.unknown' && x.severity === 'error')).toBe(false);
  });

  it('warns on a foreign-but-present status (Spec Kit `draft`)', () => {
    const r = validateSpec(
      parseSpec(rawSpec('id: SK-001\ntitle: Z\ntier: T3\nstatus: draft')),
      DEFAULT_CONFIG,
    );
    expect(r.violations.some((x) => x.rule === 'frontmatter.status.unknown' && x.severity === 'warning')).toBe(true);
  });

  it('does NOT warn for a valid status', () => {
    const r = validateSpec(
      parseSpec(rawSpec('id: SPEC-001\ntitle: Y\ntier: T3\nstatus: implementing')),
      DEFAULT_CONFIG,
    );
    expect(r.violations.some((x) => x.rule === 'frontmatter.status.unknown')).toBe(false);
  });

  it('does NOT warn when status carries a valid value + inline comment', () => {
    // The parser strips the comment; the gate must too, mirroring parse semantics.
    const r = validateSpec(
      parseSpec(rawSpec('id: SPEC-004\ntitle: Y\ntier: T3\nstatus: implementing  # built: harness done')),
      DEFAULT_CONFIG,
    );
    expect(r.violations.some((x) => x.rule === 'frontmatter.status.unknown')).toBe(false);
  });

  it('does NOT warn when status is absent (legitimate default)', () => {
    // No status: line at all → parser defaults to 'new'; that is not a coercion of a
    // present value, so no signpost-lie and no warning.
    const r = validateSpec(
      parseSpec(rawSpec('id: SK-002\ntitle: Y\ntier: T3')),
      DEFAULT_CONFIG,
    );
    expect(r.violations.some((x) => x.rule === 'frontmatter.status.unknown')).toBe(false);
  });

  it('warns when tier is present but not a recognized Tier (typo)', () => {
    const r = validateSpec(
      parseSpec(rawSpec('id: SPEC-009\ntitle: Y\ntier: T7\nstatus: implementing')),
      DEFAULT_CONFIG,
    );
    const v = r.violations.find((x) => x.rule === 'frontmatter.tier.unknown');
    expect(v).toBeDefined();
    expect(v!.severity).toBe('warning');
    expect(v!.message).toContain('T7');
  });

  it('does NOT warn for a valid tier, and ignores a `status:` that appears only in the body', () => {
    // A `status:` token in prose / a section heading must not be mistaken for the
    // frontmatter field — only the top-level frontmatter line is inspected.
    const withBodyStatus = `---\nid: SPEC-001\ntitle: Y\ntier: T3\nstatus: done\ncreated: 2026-05-30\nphases:\n  specify: done\n  clarify: pending\n  plan: done\n  tasks: done\n  implement: done\n---\n\n## Specify\nWe set status: bogus in the example below.\n- [ ] c1\n\n## Plan\nx\n\n## Tasks\n- [ ] t\n\n## Implement\nstatus: alsobogus\n`;
    const r = validateSpec(parseSpec(withBodyStatus), DEFAULT_CONFIG);
    expect(r.violations.some((x) => x.rule === 'frontmatter.status.unknown')).toBe(false);
    expect(r.violations.some((x) => x.rule === 'frontmatter.tier.unknown')).toBe(false);
  });
});

// ── #137: symmetric closed-set / reference frontmatter primitive ───────────────
// The recurring DR-003 Phase-4 asymmetry: validateSpec checked values that
// *resolve* but never asserted (b) a *required* closed-set field is *present*, nor
// — symmetrically — that a *required* reference is present. SPEC-004 sat orphaned
// because a *missing* epic was as invisible as a *dangling* one; #115 patched
// present⇒valid for status/tier but not required⇒present. This block locks in BOTH
// directions for EVERY field class through one primitive: (a) present-but-unknown
// closed-set value, (b) missing required closed-set field, (c) dangling reference,
// (d) missing required reference. Severity = warning always (foreign-but-valid
// vocabularies + incremental authoring must never be blocked, per #115).
describe('validateSpec — symmetric frontmatter primitive (#137)', () => {
  // Raw spec WITHOUT the spec() helper's defaults, so individual fields can be
  // omitted to exercise the required⇒present direction. No `phases:` block needed
  // for these frontmatter-only gates; a minimal body keeps the parser happy.
  function rawSpec(fmLines: string[], body = '## Specify\nx\n'): string {
    return `---\n${fmLines.join('\n')}\n---\n\n${body}`;
  }

  // (a) closed-set present ⇒ valid — preserved from #115 (status/tier), extended to type.
  describe('(a) closed-set present ⇒ valid', () => {
    it('warns on an unrecognized status (preserves #115)', () => {
      const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'tier: T3', 'status: bogus'])), DEFAULT_CONFIG);
      expect(r.violations.some((x) => x.rule === 'frontmatter.status.unknown' && x.severity === 'warning')).toBe(true);
    });

    it('warns on an unrecognized tier (preserves #115)', () => {
      const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'tier: T9', 'status: done'])), DEFAULT_CONFIG);
      expect(r.violations.some((x) => x.rule === 'frontmatter.tier.unknown' && x.severity === 'warning')).toBe(true);
    });

    it('warns on an unrecognized type (NEW closed-set field)', () => {
      const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'status: done', 'type: blueprint'])), DEFAULT_CONFIG);
      const v = r.violations.find((x) => x.rule === 'frontmatter.type.unknown');
      expect(v).toBeDefined();
      expect(v!.severity).toBe('warning');
      expect(v!.message).toContain('blueprint');
    });

    it('does NOT warn for a recognized type (requirements/design/tasks)', () => {
      for (const t of ['requirements', 'design', 'tasks']) {
        const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'status: done', `type: ${t}`])), DEFAULT_CONFIG);
        expect(r.violations.some((x) => x.rule === 'frontmatter.type.unknown')).toBe(false);
      }
    });

    it('does NOT warn when type is absent (single-file spec — legitimate)', () => {
      const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'status: done'])), DEFAULT_CONFIG);
      expect(r.violations.some((x) => x.rule === 'frontmatter.type.unknown')).toBe(false);
    });
  });

  // (b) closed-set required ⇒ present — THE gap. status is genuinely required
  //     (parser silently defaults a missing one to 'new' → signpost-lie). tier/type
  //     are closed-set but NOT required, so their absence must stay silent.
  describe('(b) closed-set required ⇒ present', () => {
    it('warns when a required closed-set field (status) is absent', () => {
      // T1 + a Specify section → the only completeness requirement is satisfied, so
      // `complete` reflects ONLY the frontmatter gate: a missing status must warn,
      // never error (it must not flip an otherwise-complete spec to incomplete).
      const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'tier: T1'], '## Specify\none-liner\n')), DEFAULT_CONFIG);
      const v = r.violations.find((x) => x.rule === 'frontmatter.status.missing');
      expect(v).toBeDefined();
      expect(v!.severity).toBe('warning');
      // never an error — must not block approval
      expect(r.violations.some((x) => x.rule === 'frontmatter.status.missing' && x.severity === 'error')).toBe(false);
      expect(r.complete).toBe(true);
    });

    it('does NOT warn missing tier for a secondary (split-layout) spec — design/tasks omit it', () => {
      // 10/21 real specs legitimately omit tier — they are split-layout design/tasks
      // files (secondary artifacts). Requiring tier on those would flood. (See the
      // #103 block below for the primary-spec direction, which DOES warn.)
      const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'type: design', 'status: done'])), DEFAULT_CONFIG);
      expect(r.violations.some((x) => x.rule === 'frontmatter.tier.missing')).toBe(false);
    });

    it('does NOT warn missing for type (single-file specs omit it)', () => {
      const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'status: done'])), DEFAULT_CONFIG);
      expect(r.violations.some((x) => x.rule === 'frontmatter.type.missing')).toBe(false);
    });

    it('warns when the required identity field (id) is absent', () => {
      const r = validateSpec(parseSpec(rawSpec(['title: No Id', 'tier: T1', 'status: done'], '## Specify\nx\n')), DEFAULT_CONFIG);
      const v = r.violations.find((x) => x.rule === 'frontmatter.id.missing');
      expect(v).toBeDefined();
      expect(v!.severity).toBe('warning');
      expect(r.complete).toBe(true);
    });

    it('does NOT warn id.missing when id is present', () => {
      const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'status: done'])), DEFAULT_CONFIG);
      expect(r.violations.some((x) => x.rule === 'frontmatter.id.missing')).toBe(false);
    });
  });

  // (c) reference present ⇒ resolvable — the epic.unresolved direction (preserved).
  it('(c) reference present ⇒ resolvable: warns on a dangling epic ref', () => {
    const r = validateSpec(
      parseSpec(rawSpec(['id: SPEC-001', 'status: done', 'epic: EPIC-999'])),
      DEFAULT_CONFIG,
      new Set(['epic-001']),
    );
    expect(r.violations.some((x) => x.rule === 'epic.unresolved' && x.severity === 'warning')).toBe(true);
  });

  // (d) reference required ⇒ present — the epic.missing direction (preserved). The
  //     SPEC-004 incident: a missing epic ref was as invisible as a dangling one.
  it('(d) reference required ⇒ present: warns on a missing epic when epics are registered', () => {
    const r = validateSpec(
      parseSpec(rawSpec(['id: SPEC-001', 'status: done'])),
      DEFAULT_CONFIG,
      new Set(['epic-001']),
    );
    expect(r.violations.some((x) => x.rule === 'epic.missing' && x.severity === 'warning')).toBe(true);
  });

  // Invariant: NOTHING the primitive emits is ever an error (warning-only contract).
  it('never emits an error-severity frontmatter/reference violation', () => {
    const r = validateSpec(
      parseSpec(rawSpec(['title: broken', 'tier: T9', 'status: bogus', 'type: nope', 'epic: EPIC-999'])),
      DEFAULT_CONFIG,
      new Set(['epic-001']),
    );
    const frontmatterRules = r.violations.filter(
      (v) => v.rule.startsWith('frontmatter.') || v.rule.startsWith('epic.'),
    );
    expect(frontmatterRules.length).toBeGreaterThan(0); // we did trip several
    expect(frontmatterRules.every((v) => v.severity === 'warning')).toBe(true);
  });
});

// T3 regression (#103): a spec with no `tier:` is silently coerced to T2 by the
// parser (spec.ts), so completeness requirements (required phase sections, aspect
// severities) are computed for the WRONG tier — and nothing warns. This is the
// #137 asymmetry: tier is checked present⇒valid but a missing tier is never flagged.
// The catch: tier is required ONLY for a *primary* spec (a requirements artifact:
// single-file, type absent; OR type: requirements). Split-layout design/tasks files
// legitimately omit tier (they are secondary), so they must stay silent. Extends the
// #137 CLOSED_SET_FIELDS model with a type-conditional required rule; warning-only.
describe('validateSpec — missing tier silently coerced to T2 (#103)', () => {
  function rawSpec(fmLines: string[], body = '## Specify\none-liner\n'): string {
    return `---\n${fmLines.join('\n')}\n---\n\n${body}`;
  }

  it('warns when a single-file (primary) spec has no tier', () => {
    // No `type:` → single-file primary spec → tier is required. A missing tier is
    // silently shown as T2, so the SPECS pane would lie about the ceremony level.
    const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'status: implementing'])), DEFAULT_CONFIG);
    const v = r.violations.find((x) => x.rule === 'frontmatter.tier.missing');
    expect(v).toBeDefined();
    expect(v!.severity).toBe('warning');
    // names the silent default it is shown as, so the fix is obvious
    expect(v!.message).toContain('T2');
  });

  it('warns when a split requirements (primary) spec has no tier', () => {
    // type: requirements is ALSO a primary artifact (the requirements live there).
    const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'type: requirements', 'status: implementing'])), DEFAULT_CONFIG);
    expect(r.violations.some((x) => x.rule === 'frontmatter.tier.missing' && x.severity === 'warning')).toBe(true);
  });

  it('does NOT warn when a split design (secondary) spec has no tier', () => {
    const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'type: design', 'status: implementing'])), DEFAULT_CONFIG);
    expect(r.violations.some((x) => x.rule === 'frontmatter.tier.missing')).toBe(false);
  });

  it('does NOT warn when a split tasks (secondary) spec has no tier', () => {
    const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'type: tasks', 'status: implementing'])), DEFAULT_CONFIG);
    expect(r.violations.some((x) => x.rule === 'frontmatter.tier.missing')).toBe(false);
  });

  it('does NOT warn when a primary spec DOES declare a tier', () => {
    const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'tier: T3', 'status: implementing'])), DEFAULT_CONFIG);
    expect(r.violations.some((x) => x.rule === 'frontmatter.tier.missing')).toBe(false);
  });

  it('the missing-tier warning never blocks approval (warning, not error)', () => {
    // A T1 single-file spec with a Specify section is otherwise complete; a missing
    // tier must surface but must not flip it to incomplete.
    const r = validateSpec(parseSpec(rawSpec(['id: SPEC-001', 'status: implementing'])), DEFAULT_CONFIG);
    expect(r.violations.some((x) => x.rule === 'frontmatter.tier.missing' && x.severity === 'error')).toBe(false);
    expect(r.complete).toBe(true);
  });
});

// Feature (#40): a dangling park reference — prose claiming something is "parked /
// tracked / filed as a separate issue" with NO adjacent `#NNN` or issue URL —
// silently loses parked work (SPEC-005 lost "Corrupt-file repair parked as a separate
// issue", and the issue never existed). This lint warns (never errors) on such a
// claim with no link. It is pure-local Tier 0: it does NOT verify the linked issue
// EXISTS (that is a network check, Tier 1 / DR-004 — explicitly out of scope here).
describe('validateSpec — dangling park reference lint (#40)', () => {
  function rawSpec(body: string): string {
    return `---\nid: SPEC-001\ntier: T1\nstatus: implementing\n---\n\n## Specify\n${body}\n`;
  }

  it('warns when "parked as a separate issue" has no link', () => {
    const r = validateSpec(parseSpec(rawSpec('Corrupt-file repair parked as a separate issue.')), DEFAULT_CONFIG);
    const v = r.violations.find((x) => x.rule === 'park-ref.dangling');
    expect(v).toBeDefined();
    expect(v!.severity).toBe('warning');
    // never an error — must not block approval
    expect(r.violations.some((x) => x.rule === 'park-ref.dangling' && x.severity === 'error')).toBe(false);
    expect(r.complete).toBe(true);
  });

  it('does NOT warn when the park claim carries an adjacent #NNN', () => {
    const r = validateSpec(parseSpec(rawSpec('Corrupt-file repair parked as a separate issue (#39).')), DEFAULT_CONFIG);
    expect(r.violations.some((x) => x.rule === 'park-ref.dangling')).toBe(false);
  });

  it('does NOT warn when the park claim carries an adjacent issue URL', () => {
    const r = validateSpec(parseSpec(rawSpec(
      'Corrupt-file repair parked as a separate issue: https://github.com/harvest316/minspec/issues/39',
    )), DEFAULT_CONFIG);
    expect(r.violations.some((x) => x.rule === 'park-ref.dangling')).toBe(false);
  });

  it('accepts a link on the immediately adjacent line (multi-line park ref)', () => {
    // Real specs put the markdown link on the following line — must not false-positive.
    const r = validateSpec(parseSpec(rawSpec(
      'Corrupt-file repair parked as a separate issue\n[#39](https://github.com/harvest316/minspec/issues/39).',
    )), DEFAULT_CONFIG);
    expect(r.violations.some((x) => x.rule === 'park-ref.dangling')).toBe(false);
  });

  it('warns on "tracked as a separate issue" and "filed as an issue" with no link', () => {
    for (const phrase of [
      'This concern is tracked as a separate issue.',
      'The richer surface was filed as an issue.',
    ]) {
      const r = validateSpec(parseSpec(rawSpec(phrase)), DEFAULT_CONFIG);
      expect(r.violations.some((x) => x.rule === 'park-ref.dangling'), `"${phrase}"`).toBe(true);
    }
  });

  it('does NOT warn on ordinary prose that merely mentions parking/tracking', () => {
    // Must not flood: "tracked as OQ-1", "tracked separately if the team wants",
    // "Park as issue" UI labels, "parking-lot action" — none is a dangling
    // "as a separate issue" CLAIM, so none should trip.
    for (const phrase of [
      'Inline edit is tracked as OQ-1 (review surface), an in-spec open question.',
      'File an issue per DR-023 if the team wants it tracked separately.',
      'Drift warning offers a "Park as issue" / "Add to scope" action.',
      'Out-of-scope edits prompt a parking-lot action.',
    ]) {
      const r = validateSpec(parseSpec(rawSpec(phrase)), DEFAULT_CONFIG);
      expect(r.violations.some((x) => x.rule === 'park-ref.dangling'), `"${phrase}"`).toBe(false);
    }
  });

  it('points the fix hint at adding the issue link', () => {
    const r = validateSpec(parseSpec(rawSpec('Corrupt-file repair parked as a separate issue.')), DEFAULT_CONFIG);
    const v = r.violations.find((x) => x.rule === 'park-ref.dangling');
    expect(v?.fixHint).toMatch(/#NNN|issue/i);
  });
});
