import { describe, it, expect } from 'vitest';
import { validateSpec } from '../src/lib/spec-validator';
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

describe('validateSpec — aspect: architecture', () => {
  it('declared architecture aspect without diagram errors at T4', () => {
    const body = FULL_T3.replace('Build the thing.', 'Introduce a new broker service and message queue subsystem.');
    const r = validateSpec(parseSpec(spec({ tier: 'T4', aspects: 'architecture' }, body)), DEFAULT_CONFIG);
    expect(r.violations.some((v) => v.rule === 'aspect.architecture.no-diagram' && v.severity === 'error')).toBe(true);
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
