import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseSpec, writeSpec, updateSpecFrontmatter, readSpecFile, writeSpecFile, setSpecStatus } from '../src/lib/spec';
import type { ParsedSpec } from '../src/lib/spec';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Example spec from design.md — the canonical format
const EXAMPLE_SPEC = `---
id: SPEC-001
title: Add rate limiting to /api/health
tier: T1
status: implementing
created: 2026-05-26
phases:
  specify: done
  clarify: skipped
  plan: skipped
  tasks: done
  implement: in-progress
---

## Specify

Health endpoint needs rate limiting at 100 req/min per IP.

## Tasks

- [x] Add express-rate-limit middleware to health route
- [ ] Add 429 response test
`;

// Minimal Spec Kit format — just frontmatter + content, no MinSpec extensions
const SPECKIT_MINIMAL = `---
id: SPEC-042
title: Fix login redirect
---

## Requirements

User should be redirected after login.

## Notes

Some additional notes here.
`;

describe('parseSpec()', () => {
  it('parses full frontmatter', () => {
    const spec = parseSpec(EXAMPLE_SPEC);
    expect(spec.frontmatter.id).toBe('SPEC-001');
    expect(spec.frontmatter.title).toBe('Add rate limiting to /api/health');
    expect(spec.frontmatter.tier).toBe('T1');
    expect(spec.frontmatter.status).toBe('implementing');
    expect(spec.frontmatter.created).toBe('2026-05-26');
  });

  it('parses phase statuses from frontmatter', () => {
    const spec = parseSpec(EXAMPLE_SPEC);
    expect(spec.frontmatter.phases.specify).toBe('done');
    expect(spec.frontmatter.phases.clarify).toBe('skipped');
    expect(spec.frontmatter.phases.plan).toBe('skipped');
    expect(spec.frontmatter.phases.tasks).toBe('done');
    expect(spec.frontmatter.phases.implement).toBe('in-progress');
  });

  it('parses phase body sections', () => {
    const spec = parseSpec(EXAMPLE_SPEC);
    expect(spec.phaseSections.specify).toBeDefined();
    expect(spec.phaseSections.specify!.body).toContain('rate limiting');
  });

  it('parses task items', () => {
    const spec = parseSpec(EXAMPLE_SPEC);
    const tasks = spec.phaseSections.tasks!.tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks[0].done).toBe(true);
    expect(tasks[0].text).toBe('Add express-rate-limit middleware to health route');
    expect(tasks[1].done).toBe(false);
    expect(tasks[1].text).toBe('Add 429 response test');
  });

  // T3 regression: a YAML inline comment on a scalar value was baked into the
  // value (parser never stripped ' #…'). For `status` that failed the SpecStatus
  // enum check and silently coerced to 'new' — a false status in the pane.
  // (SPEC-004: `status: implementing  # harness built…` showed as 'new'.)
  it('strips YAML inline comments from scalar values', () => {
    const spec = parseSpec(`---
id: SPEC-004
title: Classifier validation
tier: T2
status: implementing  # harness built + run (n=120, κ=0.80); drove DR-021/022
epic: EPIC-003  # SDD Core Methodology
created: 2026-05-31
---

# Classifier validation
`);
    expect(spec.frontmatter.status).toBe('implementing'); // not 'new'
    // epic keeps its raw form by design (carries a human title comment; consumers
    // strip via epicRefValue). Only closed-enum fields strip at parse time.
    expect(spec.frontmatter.epic).toBe('EPIC-003  # SDD Core Methodology');
  });

  // T3 regression (#153.1): a quoted closed-enum scalar (`status: "done"`) was
  // returned by stripInlineComment WITH its surrounding quotes, so the
  // STATUSES_SET/TIERS_SET `.has()` membership check failed and the value was
  // silently coerced to the default ('new'/'T2') — a false status/tier in the
  // pane — AND the validator (which re-strips the raw line) emitted a spurious
  // `frontmatter.*.unknown`. A matched quoted scalar must have its quotes stripped.
  it('strips surrounding quotes from a matched quoted enum scalar', () => {
    const dq = parseSpec(`---
id: SPEC-001
title: X
tier: "T3"
status: "done"
---
`);
    expect(dq.frontmatter.status).toBe('done'); // not coerced to 'new'
    expect(dq.frontmatter.tier).toBe('T3'); // not coerced to 'T2'

    const sq = parseSpec(`---
id: SPEC-001
title: X
tier: 'T1'
status: 'implementing'
---
`);
    expect(sq.frontmatter.status).toBe('implementing');
    expect(sq.frontmatter.tier).toBe('T1');
  });

  // An empty quoted scalar ("" / '') is an explicitly-empty value, not a member:
  // it must coerce to the default, not become a spurious enum hit.
  it('treats an empty quoted enum scalar as empty (coerces to default)', () => {
    const spec = parseSpec(`---
id: SPEC-001
title: X
tier: ""
status: ''
---
`);
    expect(spec.frontmatter.status).toBe('new'); // empty → default, not a member
    expect(spec.frontmatter.tier).toBe('T2');
  });

  it('strips inline comments from nested (phase) values', () => {
    const spec = parseSpec(`---
id: SPEC-004
title: X
tier: T2
status: implementing
phases:
  specify: done   # finished 2026-05-31
  implement: in-progress  # WIP
---
`);
    expect(spec.frontmatter.phases.specify).toBe('done');
    expect(spec.frontmatter.phases.implement).toBe('in-progress');
  });

  it('does not treat a # without leading whitespace as a comment', () => {
    // YAML rule: '#' starts a comment only when preceded by whitespace. A '#'
    // glued to preceding text is part of the value.
    const spec = parseSpec(`---
id: SPEC-004
title: Issue#42 hotfix
tier: T2
status: done
---
`);
    expect(spec.frontmatter.title).toBe('Issue#42 hotfix');
  });

  it('handles minimal Spec Kit format (no MinSpec extensions)', () => {
    const spec = parseSpec(SPECKIT_MINIMAL);
    expect(spec.frontmatter.id).toBe('SPEC-042');
    expect(spec.frontmatter.title).toBe('Fix login redirect');
    // Defaults for missing fields
    expect(spec.frontmatter.tier).toBe('T2');
    expect(spec.frontmatter.status).toBe('new');
    // All phases default to pending
    expect(spec.frontmatter.phases.specify).toBe('pending');
    expect(spec.frontmatter.phases.implement).toBe('pending');
  });

  it('preserves non-phase sections', () => {
    const spec = parseSpec(SPECKIT_MINIMAL);
    expect(spec.sections.get('Requirements')).toContain('redirected after login');
    expect(spec.sections.get('Notes')).toContain('additional notes');
  });

  it('handles empty content', () => {
    const spec = parseSpec('');
    expect(spec.frontmatter.id).toBe('');
    expect(spec.frontmatter.title).toBe('');
  });

  // T3 regression: tooltip showed "SPEC-004: " with a blank title because
  // spec files carry the human title in the first level-1 # heading, not a
  // frontmatter `title:` field.
  it('falls back to first level-1 # heading when frontmatter has no title', () => {
    const input = `---
id: SPEC-004
tier: T2
status: implementing
created: 2026-05-26
---

# MinSpec — Classifier Validation Harness (Design)

Some intro text.

## Specify

Details here.
`;
    const spec = parseSpec(input);
    expect(spec.frontmatter.title).toBe(
      'MinSpec — Classifier Validation Harness (Design)',
    );
  });

  it('prefers frontmatter title over body heading when both present', () => {
    const input = `---
id: SPEC-005
title: Frontmatter Title Wins
---

# Body Heading Should Be Ignored

## Requirements

Stuff.
`;
    const spec = parseSpec(input);
    expect(spec.frontmatter.title).toBe('Frontmatter Title Wins');
  });

  it('keeps empty title when neither frontmatter nor body heading exists', () => {
    const input = `---
id: SPEC-006
---

## Requirements

No level-1 heading anywhere.
`;
    const spec = parseSpec(input);
    expect(spec.frontmatter.title).toBe('');
  });

  // T3 regression (#153.2): an empty-valued top-level key (`title:` with nothing
  // after it) opened a nested block stored as `{}` even with no children. `{}` is
  // not nullish, so the `?? firstH1Heading()` fallback never fired and `title`
  // became an OBJECT — its consumers (slugify → title.toLowerCase) then crashed.
  it('falls back to the body H1 when title: is empty (not an object)', () => {
    const input = `---
id: SPEC-007
title:
status: done
---

# The Real Title

Body.
`;
    const spec = parseSpec(input);
    expect(typeof spec.frontmatter.title).toBe('string');
    expect(spec.frontmatter.title).toBe('The Real Title'); // H1 fallback fired
  });

  it('yields an empty string (never an object) for an empty title: with no H1', () => {
    const input = `---
id: SPEC-008
title:
status: done
---

## Requirements

No level-1 heading anywhere.
`;
    const spec = parseSpec(input);
    expect(typeof spec.frontmatter.title).toBe('string');
    expect(spec.frontmatter.title).toBe('');
  });

  it('does not mistake a genuine nested block for an empty title', () => {
    // `title:` here truly opens a nested block (indented child) — it must remain an
    // object-shaped value, not be flattened to ''. Guards against over-correcting #153.2.
    const input = `---
id: SPEC-009
phases:
  specify: done
  plan: pending
---

# H1 Title
`;
    const spec = parseSpec(input);
    expect(spec.frontmatter.phases.specify).toBe('done');
    expect(spec.frontmatter.phases.plan).toBe('pending');
  });

  it('handles frontmatter-only (no body)', () => {
    const input = `---
id: SPEC-099
title: Empty spec
tier: T1
status: new
created: 2026-05-26
phases:
  specify: pending
  clarify: pending
  plan: pending
  tasks: pending
  implement: pending
---
`;
    const spec = parseSpec(input);
    expect(spec.frontmatter.id).toBe('SPEC-099');
    expect(spec.sections.size).toBe(0);
  });
});

describe('writeSpec()', () => {
  it('round-trips full spec without data loss', () => {
    const parsed = parseSpec(EXAMPLE_SPEC);
    const written = writeSpec(parsed);
    const reparsed = parseSpec(written);

    expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
    expect(reparsed.phaseSections.specify!.body).toEqual(parsed.phaseSections.specify!.body);
    expect(reparsed.phaseSections.tasks!.tasks).toEqual(parsed.phaseSections.tasks!.tasks);
  });

  it('emits the approval-reminder comment above status, inertly', () => {
    const written = writeSpec(parseSpec(EXAMPLE_SPEC));
    // Comment is present, accurate, and sits directly above the status line.
    expect(written).toMatch(/# Editing voids approval[^\n]*DR-012\nstatus: /);
    // It is inert: status still parses correctly (parser skips full-line `#`).
    expect(parseSpec(written).frontmatter.status).toBe('implementing');
  });

  it('round-trips Spec Kit format preserving user sections', () => {
    const parsed = parseSpec(SPECKIT_MINIMAL);
    const written = writeSpec(parsed);
    const reparsed = parseSpec(written);

    expect(reparsed.frontmatter.id).toBe('SPEC-042');
    expect(reparsed.sections.get('Requirements')).toContain('redirected after login');
    expect(reparsed.sections.get('Notes')).toContain('additional notes');
  });

  it('outputs valid frontmatter delimiters', () => {
    const parsed = parseSpec(EXAMPLE_SPEC);
    const written = writeSpec(parsed);
    expect(written.startsWith('---\n')).toBe(true);
    expect(written).toContain('\n---\n');
  });

  it('ends with newline', () => {
    const parsed = parseSpec(EXAMPLE_SPEC);
    const written = writeSpec(parsed);
    expect(written.endsWith('\n')).toBe(true);
  });
});

describe('updateSpecFrontmatter()', () => {
  it('updates tier without changing body', () => {
    const updated = updateSpecFrontmatter(EXAMPLE_SPEC, { tier: 'T3' });
    const reparsed = parseSpec(updated);
    expect(reparsed.frontmatter.tier).toBe('T3');
    // Body preserved
    expect(reparsed.phaseSections.specify!.body).toContain('rate limiting');
    expect(reparsed.phaseSections.tasks!.tasks).toHaveLength(2);
  });

  it('updates individual phase status', () => {
    const updated = updateSpecFrontmatter(EXAMPLE_SPEC, {
      phases: { specify: 'done', clarify: 'skipped', plan: 'skipped', tasks: 'done', implement: 'done' },
    });
    const reparsed = parseSpec(updated);
    expect(reparsed.frontmatter.phases.implement).toBe('done');
  });

  it('preserves non-updated frontmatter fields', () => {
    const updated = updateSpecFrontmatter(EXAMPLE_SPEC, { status: 'done' });
    const reparsed = parseSpec(updated);
    expect(reparsed.frontmatter.id).toBe('SPEC-001');
    expect(reparsed.frontmatter.title).toBe('Add rate limiting to /api/health');
    expect(reparsed.frontmatter.tier).toBe('T1');
    expect(reparsed.frontmatter.status).toBe('done');
  });

  it('preserves an epic title comment across a frontmatter re-serialize', () => {
    const withEpic = EXAMPLE_SPEC.replace(
      /^id: SPEC-001$/m,
      'id: SPEC-001\nepic: EPIC-001  # Telemetry & Privacy',
    );
    const updated = updateSpecFrontmatter(withEpic, { status: 'done' });
    // The cosmetic title comment must survive a full writeSpec round-trip.
    expect(updated).toContain('epic: EPIC-001  # Telemetry & Privacy');
  });
});

describe('readSpecFile() / writeSpecFile()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-spec-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips through filesystem', () => {
    const filePath = path.join(tmpDir, 'SPEC-001.md');
    fs.writeFileSync(filePath, EXAMPLE_SPEC);

    const parsed = readSpecFile(filePath);
    expect(parsed.frontmatter.id).toBe('SPEC-001');

    // Modify and write back
    const modified: ParsedSpec = {
      ...parsed,
      frontmatter: { ...parsed.frontmatter, status: 'done' },
    };
    writeSpecFile(filePath, modified);

    const reread = readSpecFile(filePath);
    expect(reread.frontmatter.status).toBe('done');
    expect(reread.phaseSections.tasks!.tasks).toHaveLength(2);
  });
});

describe('Spec Kit compatibility', () => {
  it('Spec Kit file readable by MinSpec (graceful defaults)', () => {
    // Spec Kit produces: id, title, maybe status. No tier, no phases, no created.
    const specKitFile = `---
id: SK-001
title: A Spec Kit spec
status: draft
---

## Requirements

Something important.
`;
    const parsed = parseSpec(specKitFile);
    expect(parsed.frontmatter.id).toBe('SK-001');
    expect(parsed.frontmatter.tier).toBe('T2'); // default
    expect(parsed.frontmatter.phases.specify).toBe('pending'); // default
    expect(parsed.sections.get('Requirements')).toContain('Something important');
  });

  it('MinSpec file readable by Spec Kit (unknown frontmatter ignored)', () => {
    // Spec Kit ignores unknown frontmatter keys (tier, phases, etc.)
    // Verify our output has standard YAML frontmatter that any parser can read
    const parsed = parseSpec(EXAMPLE_SPEC);
    const written = writeSpec(parsed);

    // Must have valid --- delimiters
    const fmMatch = written.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();

    // Must have id and title (Spec Kit required fields)
    expect(fmMatch![1]).toContain('id: SPEC-001');
    expect(fmMatch![1]).toContain('title: Add rate limiting');

    // Body sections use standard ## markdown headings
    expect(written).toContain('## Specify');
    expect(written).toContain('## Tasks');
  });
});

describe('setSpecStatus() — surgical status-line rewrite', () => {
  let tmpDir: string;
  let filePath: string;

  // Mirrors a real SPEC-016-shaped file: a full-line `#` comment sits directly
  // above status, plus rich frontmatter that a full re-serialize would mangle.
  const RICH = `---
id: SPEC-016
type: requirements
# 🔒 Once approved, hash-locked: ANY edit voids approval. DR-012.
status: specifying
tier: T3
depends_on: [DR-029, DR-030]
---

# Title

## Context
Body stays put.
`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-setstatus-'));
    filePath = path.join(tmpDir, 'SPEC-016.md');
    fs.writeFileSync(filePath, RICH);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('flips only the status line, preserving the lock comment, field order, and body', () => {
    expect(setSpecStatus(filePath, 'implementing')).toBe('implementing');
    const after = fs.readFileSync(filePath, 'utf-8');
    expect(after).toContain('status: implementing');
    expect(after).not.toContain('status: specifying');
    // Everything around the status line is byte-preserved.
    expect(after).toContain('# 🔒 Once approved, hash-locked: ANY edit voids approval. DR-012.');
    expect(after).toContain('depends_on: [DR-029, DR-030]');
    expect(after).toContain('## Context\nBody stays put.');
    // Parser agrees.
    expect(parseSpec(after).frontmatter.status).toBe('implementing');
  });

  it('rejects an invalid status (enum gate)', () => {
    expect(() => setSpecStatus(filePath, 'bogus' as never)).toThrow(/invalid spec status/i);
    // File untouched on rejection.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(RICH);
  });

  it('adds a status line when none exists', () => {
    const noStatus = path.join(tmpDir, 'no-status.md');
    fs.writeFileSync(noStatus, '---\nid: SPEC-099\ntier: T2\n---\n# X\n');
    setSpecStatus(noStatus, 'implementing');
    expect(parseSpec(fs.readFileSync(noStatus, 'utf-8')).frontmatter.status).toBe('implementing');
  });

  it('throws when there is no frontmatter block', () => {
    const noFm = path.join(tmpDir, 'no-fm.md');
    fs.writeFileSync(noFm, '# Just a heading\n');
    expect(() => setSpecStatus(noFm, 'done')).toThrow(/no frontmatter/i);
  });
});
