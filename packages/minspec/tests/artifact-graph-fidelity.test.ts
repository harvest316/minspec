/**
 * INV-FIDELITY — the artifact-graph adapter maps the REAL workspace onto the
 * resolver's `ArtifactGraph` faithfully.
 *
 * A fixture workspace with known epic/spec/DR states + real DR-034 approval
 * sidecars must produce the EXACT graph: mapped statuses, approvalState,
 * epic.order, goalRank, and edges. The load-bearing assertion is the DERIVATION:
 * spec node status comes from the project's own `deriveStatus(phases, approval,
 * terminal)`, NEVER the literal `status:` frontmatter line (which is a mirror
 * cache that can drift — feeding it would re-introduce the #112/#148 class of
 * stale-status bug). The stale-hash spec is the regression guard: it must map to
 * BOTH approvalState 'stale' AND derived status 'specifying'.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { resolveCorruption } from '@aiclarity/shared';
import { buildArtifactGraph } from '../src/lib/artifact-graph';
import { approveSpec } from '../src/lib/approval';

let root: string;

const fixedClock = () => new Date('2026-06-23T00:00:00.000Z');

function write(rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

/** A spec requirements.md with explicit phases + status. */
function specFile(opts: {
  id: string;
  tier: string;
  status: string;
  epic?: string;
  phases: Record<string, string>;
  goal?: string;
  dependsOn?: string[];
  relatesTo?: string[];
  body?: string;
}): string {
  const lines = ['---', `id: ${opts.id}`, 'type: requirements', `tier: ${opts.tier}`, `status: ${opts.status}`, 'created: 2026-06-01'];
  if (opts.epic) lines.push(`epic: ${opts.epic}`);
  if (opts.goal) lines.push(`goal: ${opts.goal}`);
  if (opts.dependsOn) lines.push(`depends_on: [${opts.dependsOn.join(', ')}]`);
  if (opts.relatesTo) lines.push(`relates_to: [${opts.relatesTo.join(', ')}]`);
  lines.push('phases:');
  for (const [p, s] of Object.entries(opts.phases)) lines.push(`  ${p}: ${s}`);
  lines.push('---', '', `# ${opts.id}`, '', opts.body ?? 'Body.');
  return lines.join('\n') + '\n';
}

function epicFile(id: string, slug: string, status: string, order: number): string {
  return [
    '---',
    `id: ${id}`,
    `slug: ${slug}`,
    `title: ${slug}`,
    `status: ${status}`,
    `order: ${order}`,
    '---',
    '',
    `# ${id}: ${slug}`,
    '',
    '## Goal',
    '',
    'Real goal text.',
    '',
    '## Artifacts',
    '',
    'Real artifacts.',
    '',
  ].join('\n');
}

function adrFile(id: string, status: string, epic?: string): string {
  const lines = ['---', `id: ${id}`, `title: ${id} decision`, `status: ${status}`, 'date: 2026-06-01'];
  if (epic) lines.push(`epic: ${epic}`);
  lines.push('---', '', `# ${id}`, '', '## Context', '', 'ctx', '', '## Decision', '', 'dec', '');
  return lines.join('\n');
}

const ALL_PENDING = { specify: 'pending', clarify: 'pending', plan: 'pending', tasks: 'pending', implement: 'pending' };
const SPECIFY_DONE = { specify: 'done', clarify: 'pending', plan: 'pending', tasks: 'pending', implement: 'pending' };
const IMPLEMENTING = { specify: 'done', clarify: 'done', plan: 'done', tasks: 'done', implement: 'in-progress' };

const CONSTITUTION = [
  '# Constitution',
  '',
  '## Goals',
  '',
  'Ranked goals. Order = importance.',
  '',
  '1. **G-1 — First goal.** desc',
  '2. **G-2 — Second goal.** desc',
  '3. **G-3 — Third goal.** desc',
  '',
  '## Invariants',
  '',
  'none',
  '',
].join('\n');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-fidelity-'));
  write('.minspec/constitution.md', CONSTITUTION);

  // Epics.
  write('docs/epics/EPIC-001-alpha.md', epicFile('EPIC-001', 'alpha', 'active', 1));
  write('docs/epics/EPIC-002-beta.md', epicFile('EPIC-002', 'beta', 'proposed', 2));

  // SPEC-001 — all pending, no sidecar → derived 'new', approvalState 'unapproved'.
  write('specs/p/SPEC-001-a/requirements.md', specFile({
    id: 'SPEC-001', tier: 'T2', status: 'specifying', phases: ALL_PENDING,
    dependsOn: ['SPEC-002'], relatesTo: ['DR-001'], goal: 'G-2',
  }));

  // SPEC-002 — implement in-progress + APPROVED sidecar → derived 'implementing'.
  const spec2 = write('specs/p/SPEC-002-b/requirements.md', specFile({
    id: 'SPEC-002', tier: 'T4', status: 'implementing', epic: 'EPIC-001', phases: IMPLEMENTING,
  }));

  // SPEC-003 — specify done; sidecar will be made STALE → derived 'specifying'.
  const spec3 = write('specs/p/SPEC-003-c/requirements.md', specFile({
    id: 'SPEC-003', tier: 'T2', status: 'specifying', phases: SPECIFY_DONE,
  }));

  // SPEC-004 — literal status archived → explicitTerminal → derived 'archived'.
  write('specs/p/SPEC-004-d/requirements.md', specFile({
    id: 'SPEC-004', tier: 'T1', status: 'archived', phases: SPECIFY_DONE,
  }));

  // ADRs.
  write('docs/decisions/DR-001-x.md', adrFile('DR-001', 'proposed', 'EPIC-002'));
  write('docs/decisions/DR-002-y.md', adrFile('DR-002', 'accepted'));

  // Real DR-034 sidecars (exercise the real store + canonical hash).
  approveSpec(root, spec2, 'T4', 'tester@example.com', fixedClock);
  approveSpec(root, spec3, 'T2', 'tester@example.com', fixedClock);
  // Now make SPEC-003's approval STALE by editing its body AFTER approval.
  fs.appendFileSync(spec3, '\nEdited after approval — voids the canonical hash.\n', 'utf-8');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('INV-FIDELITY: buildArtifactGraph maps the workspace exactly', () => {
  it('maps epics (status + order) faithfully', () => {
    const g = buildArtifactGraph(root);
    const byId = Object.fromEntries(g.epics.map((e) => [e.id, e]));
    expect(byId['EPIC-001']).toMatchObject({ status: 'active', order: 1 });
    expect(byId['EPIC-002']).toMatchObject({ status: 'proposed', order: 2 });
  });

  it('canonicalises a SLUG-form epic ref to its EPIC-NNN id (no false dangling-ref)', () => {
    // MinSpec accepts `epic: <slug>`; the Tier-0 resolver matches by id only. The
    // adapter must canonicalise, else a valid slug ref becomes a confidently-wrong
    // "state unclear" corruption on the never-wrong signpost.
    write('specs/p/SPEC-009-slug/requirements.md', specFile({
      id: 'SPEC-009', tier: 'T2', status: 'specifying', epic: 'alpha', // SLUG of EPIC-001
      phases: ALL_PENDING,
    }));
    const g = buildArtifactGraph(root);
    expect(g.specs.find((s) => s.id === 'SPEC-009')!.epic).toBe('EPIC-001'); // not 'alpha'
    expect(
      resolveCorruption(g).filter((c) => c.kind === 'dangling-ref' && c.refs.includes('SPEC-009')),
    ).toHaveLength(0);
  });

  it('keeps a genuinely unresolvable epic ref raw, so real danglers still surface', () => {
    write('specs/p/SPEC-010-bad/requirements.md', specFile({
      id: 'SPEC-010', tier: 'T2', status: 'specifying', epic: 'no-such-epic',
      phases: ALL_PENDING,
    }));
    const g = buildArtifactGraph(root);
    expect(g.specs.find((s) => s.id === 'SPEC-010')!.epic).toBe('no-such-epic');
    expect(
      resolveCorruption(g).filter((c) => c.kind === 'dangling-ref' && c.refs.includes('SPEC-010')).length,
    ).toBeGreaterThan(0);
  });

  it('DERIVES spec status (never the literal frontmatter line)', () => {
    const g = buildArtifactGraph(root);
    const byId = Object.fromEntries(g.specs.map((s) => [s.id, s]));

    // all-pending, no sidecar
    expect(byId['SPEC-001']).toMatchObject({ status: 'new', approvalState: 'unapproved' });

    // approved + implement in-progress
    expect(byId['SPEC-002']).toMatchObject({ status: 'implementing', approvalState: 'approved', epic: 'EPIC-001' });

    // CONSISTENCY POINT: stale hash ⇒ approvalState 'stale' AND derived 'specifying'
    // (NOT the literal 'specifying' coincidence — derivation, not the cache).
    expect(byId['SPEC-003']).toMatchObject({ status: 'specifying', approvalState: 'stale' });

    // explicit terminal
    expect(byId['SPEC-004']).toMatchObject({ status: 'archived' });
  });

  it('maps ADR status + epic faithfully', () => {
    const g = buildArtifactGraph(root);
    const byId = Object.fromEntries(g.adrs.map((a) => [a.id, a]));
    expect(byId['DR-001']).toMatchObject({ status: 'proposed', epic: 'EPIC-002' });
    expect(byId['DR-002']).toMatchObject({ status: 'accepted' });
    expect(byId['DR-002'].epic).toBeUndefined();
  });

  it('resolves goalRank from constitution + goal: ref (undefined when absent)', () => {
    const g = buildArtifactGraph(root);
    const byId = Object.fromEntries(g.specs.map((s) => [s.id, s]));
    expect(byId['SPEC-001'].goalRank).toBe(2); // goal: G-2 → rank 2
    expect(byId['SPEC-002'].goalRank).toBeUndefined(); // no goal ref
  });

  it('parses depends_on / relates_to edges as faithful pass-through', () => {
    const g = buildArtifactGraph(root);
    expect(g.edges).toContainEqual({ kind: 'depends_on', from: 'SPEC-001', to: 'SPEC-002' });
    expect(g.edges).toContainEqual({ kind: 'relates_to', from: 'SPEC-001', to: 'DR-001' });
  });

  it('does not invent extra nodes', () => {
    const g = buildArtifactGraph(root);
    expect(g.epics).toHaveLength(2);
    expect(g.specs).toHaveLength(4);
    expect(g.adrs).toHaveLength(2);
  });
});
