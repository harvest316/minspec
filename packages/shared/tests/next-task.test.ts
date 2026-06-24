/**
 * T0/T1 — Next-Task Resolver (SPEC-012 / DR-019).
 *
 * Each invariant gets a crafted graph + assertion. The resolver is a pure,
 * deterministic, Tier-0 function: same graph → identical NextTask + pipeline,
 * no LLM, no Date, no Math.random, no network, no vscode.
 *
 * T0 = INV-* / coherence / cycle / determinism rows.
 * T1 = FR-5 / FR-6 / FR-7 shape & contract rows.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  resolveNextTask,
  resolvePipeline,
  resolveCorruption,
  type ArtifactGraph,
  type EpicNode,
  type SpecNode,
  type AdrNode,
  type Edge,
} from '@aiclarity/shared';

// ---------------------------------------------------------------------------
// mk* helpers — minimal nodes.
// ---------------------------------------------------------------------------
function mkEpic(id: string, status: EpicNode['status'], extra: Partial<EpicNode> = {}): EpicNode {
  return { id, status, ...extra };
}
function mkSpec(
  id: string,
  status: SpecNode['status'],
  approvalState: SpecNode['approvalState'],
  extra: Partial<SpecNode> = {},
): SpecNode {
  return { id, status, approvalState, ...extra };
}
function mkAdr(id: string, status: AdrNode['status'], extra: Partial<AdrNode> = {}): AdrNode {
  return { id, status, ...extra };
}
function graph(g: Partial<ArtifactGraph>): ArtifactGraph {
  return { epics: g.epics ?? [], specs: g.specs ?? [], adrs: g.adrs ?? [], edges: g.edges };
}

// =====================================================================
// INV-DET — determinism (FR-1)
// =====================================================================
describe('INV-DET — determinism (FR-1)', () => {
  const g = graph({
    epics: [mkEpic('EPIC-001', 'active', { order: 1 }), mkEpic('EPIC-002', 'proposed', { order: 2 })],
    specs: [
      mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
      mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-002' }),
    ],
    adrs: [mkAdr('DR-003', 'proposed', { epic: 'EPIC-002' })],
  });

  it('INV-DET-1: identical NextTask + byte-identical pipeline across runs', () => {
    const first = resolveNextTask(g);
    for (let i = 0; i < 5; i++) {
      expect(resolveNextTask(g)).toStrictEqual(first);
    }
    const pipeStr = JSON.stringify(resolvePipeline(g));
    for (let i = 0; i < 5; i++) {
      expect(JSON.stringify(resolvePipeline(g))).toBe(pipeStr);
    }
  });

  it('INV-DET-2: source contains no Date/Math.random/network/fs/vscode', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/next-task.ts', import.meta.url)),
      'utf-8',
    );
    // Strip the doc-comment header (it legitimately NAMES these in prose) before scanning code.
    const code = src.replace(/^\/\*\*[\s\S]*?\*\//, '');
    expect(code).not.toMatch(/\bnew Date\b/);
    expect(code).not.toMatch(/\bDate\.now\b/);
    expect(code).not.toMatch(/\bMath\.random\b/);
    expect(code).not.toMatch(/from ['"]vscode['"]/);
    expect(code).not.toMatch(/from ['"]fs['"]/);
    expect(code).not.toMatch(/from ['"]node:fs['"]/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/from ['"]https?['"]/);
    expect(code).not.toMatch(/require\(['"](fs|vscode|http|https)['"]\)/);
  });

  it('INV-NOLLM: source makes no model call (pure data→data)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/next-task.ts', import.meta.url)),
      'utf-8',
    );
    const code = src.replace(/^\/\*\*[\s\S]*?\*\//, '').toLowerCase();
    expect(code).not.toContain('anthropic');
    expect(code).not.toContain('openai');
    expect(code).not.toContain('claude');
    expect(code).not.toMatch(/fetch\s*\(/);
  });
});

// =====================================================================
// INV-SEV — severity precedence (FR-2)
// =====================================================================
describe('INV-SEV — severity precedence (FR-2)', () => {
  // One node of each class, with the gate-violation's epic given a HIGHER
  // (worse) epicOrder so we prove class dominates the epicOrder tie-break.
  const g = graph({
    epics: [
      mkEpic('EPIC-001', 'proposed', { order: 9 }), // gate-violation epic — worst order
      mkEpic('EPIC-002', 'active', { order: 1 }), // blocked-ready epic — best order
      mkEpic('EPIC-003', 'proposed', { order: 2 }), // promote-parent epic
      mkEpic('EPIC-004', 'proposed', { order: 3 }), // pending epic (not active, no promote)
    ],
    specs: [
      // gate-violation: spec ahead of proposed epic
      mkSpec('SPEC-001', 'implementing', 'approved', { epic: 'EPIC-001' }),
      // blocked-ready: unapproved under active epic
      mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-002' }),
      // promote-parent producer: pending child under proposed EPIC-003
      mkSpec('SPEC-003', 'specifying', 'unapproved', { epic: 'EPIC-003' }),
      // pending: unapproved under a proposed epic that is NOT being promoted in this test's intent
      mkSpec('SPEC-004', 'new', 'unapproved', { epic: 'EPIC-004' }),
    ],
  });

  it('INV-SEV-1: next task is the gate-violation regardless of epicOrder', () => {
    const next = resolveNextTask(g)!;
    expect(next.severityClass).toBe('gate-violation');
  });

  it('INV-SEV-2: pipeline class sequence is gate-violation → blocked-ready → promote-parent → pending', () => {
    const classes = resolvePipeline(g).map((t) => t.severityClass);
    const firstGate = classes.indexOf('gate-violation');
    const firstBlocked = classes.indexOf('blocked-ready');
    const firstPromote = classes.indexOf('promote-parent');
    const firstPending = classes.indexOf('pending');
    expect(firstGate).toBe(0);
    expect(firstGate).toBeLessThan(firstBlocked);
    expect(firstBlocked).toBeLessThan(firstPromote);
    expect(firstPromote).toBeLessThan(firstPending);
  });
});

// =====================================================================
// INV-COH — coherence (FR-9 / DR-019 §5)
// =====================================================================
describe('INV-COH — coherence (FR-9 / DR-019 §5)', () => {
  it('INV-COH: SPEC-004 implementing under proposed EPIC-004 → top gate-violation', () => {
    const g = graph({
      epics: [mkEpic('EPIC-004', 'proposed')],
      specs: [mkSpec('SPEC-004', 'implementing', 'approved', { epic: 'EPIC-004' })],
    });
    const next = resolveNextTask(g)!;
    expect(next.severityClass).toBe('gate-violation');
    expect(next.evidence.rule).toBe('coherence.spec-ahead-of-epic');
    expect(next.evidence.explanation).toContain('SPEC-004');
    expect(next.evidence.explanation).toContain('implementing');
    expect(next.evidence.explanation).toContain('proposed');
    expect(next.evidence.explanation).toContain('EPIC-004');

    const corr = resolveCorruption(g);
    const inc = corr.filter((c) => c.kind === 'incoherence');
    expect(inc).toHaveLength(1);
    expect(inc[0].refs).toStrictEqual(['EPIC-004', 'SPEC-004']);
  });

  it('INV-COH-2: intra-spec implementing-but-unapproved (DR-012) → gate-violation', () => {
    const g = graph({
      specs: [mkSpec('SPEC-001', 'implementing', 'unapproved')],
    });
    const next = resolveNextTask(g)!;
    expect(next.severityClass).toBe('gate-violation');
    expect(next.evidence.rule).toBe('coherence.implementing-unapproved');
  });

  it('INV-COH-3: ADR accepted under proposed epic → gate-violation', () => {
    const g = graph({
      epics: [mkEpic('EPIC-002', 'proposed')],
      adrs: [mkAdr('DR-009', 'accepted', { epic: 'EPIC-002' })],
    });
    const next = resolveNextTask(g)!;
    expect(next.severityClass).toBe('gate-violation');
    expect(next.evidence.rule).toBe('coherence.adr-ahead-of-epic');
  });
});

// =====================================================================
// INV-TIE — tie-break terms (FR-2, FR-3, DR-039, FR-14)
// =====================================================================
describe('INV-TIE — tie-break (epicOrder, goalRank, priority, artifactId)', () => {
  it('INV-TIE-epicOrder: lower epic.order first (term 2)', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 }), mkEpic('EPIC-002', 'active', { order: 2 })],
      specs: [
        mkSpec('SPEC-010', 'specifying', 'unapproved', { epic: 'EPIC-002' }),
        mkSpec('SPEC-020', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
      ],
    });
    expect(resolveNextTask(g)!.targetId).toBe('SPEC-020'); // order-1 epic wins
  });

  it('INV-TIE-goalRank: lower goalRank first (term 3, DR-039)', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001', goalRank: 2 }),
        mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-001', goalRank: 1 }),
      ],
    });
    expect(resolveNextTask(g)!.targetId).toBe('SPEC-002');
  });

  it('INV-TIE-goalRank-absent: present goalRank outranks absent (absent = lowest precedence)', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001', goalRank: 5 }),
        mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-001' }), // no goalRank
      ],
    });
    expect(resolveNextTask(g)!.targetId).toBe('SPEC-001');
  });

  it('INV-TIE-priority: lower priority first (term 4)', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001', priority: 2 }),
        mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-001', priority: 1 }),
      ],
    });
    expect(resolveNextTask(g)!.targetId).toBe('SPEC-002');
  });

  it('INV-TIE-artifactId: numeric-aware id tie-break (SPEC-2 < SPEC-10) (term 5, FR-14)', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-010', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
      ],
    });
    expect(resolveNextTask(g)!.targetId).toBe('SPEC-002');
    // And in the pipeline, SPEC-002 precedes SPEC-010.
    const ids = resolvePipeline(g).map((t) => t.targetId);
    expect(ids.indexOf('SPEC-002')).toBeLessThan(ids.indexOf('SPEC-010'));
  });
});

// =====================================================================
// INV-ACYCLIC — cycle detection (FR-15)
// =====================================================================
describe('INV-ACYCLIC — cycle detection (FR-15)', () => {
  it('INV-ACYCLIC: depends_on cycle detected, sorted refs, never infinite-loops', { timeout: 1000 }, () => {
    const edges: Edge[] = [
      { kind: 'depends_on', from: 'SPEC-001', to: 'SPEC-002' },
      { kind: 'depends_on', from: 'SPEC-002', to: 'SPEC-001' },
    ];
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
      ],
      edges,
    });
    const corr = resolveCorruption(g);
    const cycles = corr.filter((c) => c.kind === 'cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].refs).toStrictEqual(['SPEC-001', 'SPEC-002']);

    const next = resolveNextTask(g)!;
    expect(next.severityClass).toBe('gate-violation');
    expect(next.evidence.rule).toBe('cycle.depends-on');
  });

  it('INV-ACYCLIC-relates: relates_to is exempt from acyclicity', () => {
    const edges: Edge[] = [
      { kind: 'relates_to', from: 'SPEC-001', to: 'SPEC-002' },
      { kind: 'relates_to', from: 'SPEC-002', to: 'SPEC-001' },
    ];
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
      ],
      edges,
    });
    expect(resolveCorruption(g).filter((c) => c.kind === 'cycle')).toHaveLength(0);
  });

  it('handles a 3-node transitive cycle without looping', { timeout: 1000 }, () => {
    const edges: Edge[] = [
      { kind: 'depends_on', from: 'SPEC-001', to: 'SPEC-002' },
      { kind: 'depends_on', from: 'SPEC-002', to: 'SPEC-003' },
      { kind: 'depends_on', from: 'SPEC-003', to: 'SPEC-001' },
    ];
    const g = graph({
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved'),
        mkSpec('SPEC-002', 'specifying', 'unapproved'),
        mkSpec('SPEC-003', 'specifying', 'unapproved'),
      ],
      edges,
    });
    const cycles = resolveCorruption(g).filter((c) => c.kind === 'cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].refs).toStrictEqual(['SPEC-001', 'SPEC-002', 'SPEC-003']);
  });
});

// =====================================================================
// FR-13 — explicit cross-cutting edges
// =====================================================================
describe('FR-13 — cross-cutting edges', () => {
  it('FR-13-dangling: depends_on to a missing id is corruption, never silently dropped', () => {
    const g = graph({
      specs: [mkSpec('SPEC-001', 'specifying', 'unapproved')],
      edges: [{ kind: 'depends_on', from: 'SPEC-001', to: 'SPEC-999' }],
    });
    const dangling = resolveCorruption(g).filter((c) => c.kind === 'dangling-ref');
    expect(dangling).toHaveLength(1);
    expect(dangling[0].refs).toStrictEqual(['SPEC-001', 'SPEC-999']);
  });

  it('FR-13-blocks: a depends_on dependent ranks below its blocker (blocker has HIGHER id)', () => {
    // The blocker SPEC-009 has a HIGHER id than the dependent SPEC-001, so a pass
    // cannot be a coincidence of id-ordering — it proves the depends_on flooring.
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-009', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
      ],
      edges: [{ kind: 'depends_on', from: 'SPEC-001', to: 'SPEC-009' }],
    });
    // The single next task is the BLOCKER, never the blocked dependent.
    expect(resolveNextTask(g)!.targetId).toBe('SPEC-009');
    const ids = resolvePipeline(g).map((t) => t.targetId);
    expect(ids.indexOf('SPEC-009')).toBeLessThan(ids.indexOf('SPEC-001'));
  });

  it('FR-13-blocks-transitive: a depends_on chain floors blocker-first, against id order', () => {
    // SPEC-001 depends_on SPEC-002 depends_on SPEC-003. Natural id order is
    // [001,002,003]; flooring must invert it to deepest-blocker-first.
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-003', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
      ],
      edges: [
        { kind: 'depends_on', from: 'SPEC-001', to: 'SPEC-002' },
        { kind: 'depends_on', from: 'SPEC-002', to: 'SPEC-003' },
      ],
    });
    expect(resolvePipeline(g).map((t) => t.targetId)).toStrictEqual([
      'SPEC-003',
      'SPEC-002',
      'SPEC-001',
    ]);
    expect(resolveNextTask(g)!.targetId).toBe('SPEC-003');
  });

  it('FR-13-advance-past: advancing past an un-cleared depends_on is a gate-violation', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        // SPEC-002 advancing (implementing+approved) while depending on un-cleared SPEC-001
        mkSpec('SPEC-002', 'implementing', 'approved', { epic: 'EPIC-001' }),
      ],
      edges: [{ kind: 'depends_on', from: 'SPEC-002', to: 'SPEC-001' }],
    });
    const violation = resolvePipeline(g).find((t) => t.evidence.rule === 'depends_on.uncleared');
    expect(violation).toBeDefined();
    expect(violation!.severityClass).toBe('gate-violation');
    expect(violation!.targetId).toBe('SPEC-002');
  });

  it('FR-13-supersedes: superseded target drops out, superseding node carries forward', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
      ],
      edges: [{ kind: 'supersedes', from: 'SPEC-002', to: 'SPEC-001' }],
    });
    const ids = resolvePipeline(g).map((t) => t.targetId);
    expect(ids).not.toContain('SPEC-001');
    expect(ids).toContain('SPEC-002');
  });

  it('FR-13-superseded-incoherence: a superseded node does not emit a coherence gate-violation', () => {
    // SPEC-001 implementing/unapproved WOULD be an incoherence — but it is being
    // superseded (retired), so corruption detection must agree with node
    // generation and stay silent. The signpost must not point at a retiring spec.
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'implementing', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
      ],
      edges: [{ kind: 'supersedes', from: 'SPEC-002', to: 'SPEC-001' }],
    });
    expect(resolveCorruption(g).filter((c) => c.kind === 'incoherence')).toHaveLength(0);
    expect(resolveNextTask(g)!.evidence.rule).not.toContain('coherence');
  });

  it('FR-13-supersedes-noop: superseding an already-done target is a no-op (edge-case #6)', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'done', 'approved', { epic: 'EPIC-001' }), // already out
        mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
      ],
      edges: [{ kind: 'supersedes', from: 'SPEC-002', to: 'SPEC-001' }],
    });
    const ids = resolvePipeline(g).map((t) => t.targetId);
    expect(ids).not.toContain('SPEC-001'); // already out, no error
    expect(ids).toContain('SPEC-002'); // normal
    expect(resolveCorruption(g)).toStrictEqual([]); // no error/corruption
  });

  it('FR-13-relates-cluster: relates_to keeps kindred items adjacent without changing the top', () => {
    // Within blocked-ready: SPEC-001 (top), then SPEC-002 relates_to SPEC-004,
    // so SPEC-004 is pulled adjacent to SPEC-002 ahead of SPEC-003.
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-003', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-004', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
      ],
      edges: [{ kind: 'relates_to', from: 'SPEC-002', to: 'SPEC-004' }],
    });
    const ids = resolvePipeline(g).map((t) => t.targetId);
    // Top unchanged.
    expect(ids[0]).toBe('SPEC-001');
    // SPEC-004 clustered right after SPEC-002, ahead of SPEC-003.
    expect(ids.indexOf('SPEC-004')).toBe(ids.indexOf('SPEC-002') + 1);
    expect(ids.indexOf('SPEC-002')).toBeLessThan(ids.indexOf('SPEC-003'));
  });
});

// =====================================================================
// Edge-cases & output-shape contract (FR-5, FR-6, FR-7, FR-8a)
// =====================================================================
describe('edge-cases & output contract', () => {
  it('EMPTY (edge-case #3): all-cleared graph → null / [] / no corruption', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active')],
      specs: [mkSpec('SPEC-001', 'done', 'approved', { epic: 'EPIC-001' })],
      adrs: [mkAdr('DR-001', 'accepted', { epic: 'EPIC-001' })],
    });
    expect(resolveNextTask(g)).toBeNull();
    expect(resolvePipeline(g)).toStrictEqual([]);
    expect(resolveCorruption(g)).toStrictEqual([]);
  });

  it('EMPTY: a totally empty graph → null / []', () => {
    const g = graph({});
    expect(resolveNextTask(g)).toBeNull();
    expect(resolvePipeline(g)).toStrictEqual([]);
  });

  it('FR-5-shape: resolveNextTask is one object with exactly the contract keys, not an array', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' })],
    });
    const next = resolveNextTask(g)!;
    expect(Array.isArray(next)).toBe(false);
    expect(Object.keys(next).sort()).toStrictEqual(
      ['evidence', 'imperative', 'kind', 'severityClass', 'targetId'].sort(),
    );
    expect(next.imperative).toBe('Approve SPEC-001');
    expect(next.kind).toBe('spec-approve');
  });

  it('FR-7-evidence: emitted evidence carries class + rule + explanation + refs', () => {
    const g = graph({
      epics: [mkEpic('EPIC-004', 'proposed')],
      specs: [mkSpec('SPEC-004', 'implementing', 'approved', { epic: 'EPIC-004' })],
    });
    const ev = resolveNextTask(g)!.evidence;
    expect(ev.severityClass).toBe('gate-violation');
    expect(ev.rule).toBe('coherence.spec-ahead-of-epic');
    expect(typeof ev.explanation).toBe('string');
    expect(ev.explanation.length).toBeGreaterThan(0);
    expect(ev.refs).toContain('SPEC-004');
    expect(ev.refs).toContain('EPIC-004');
  });

  it('FR-6-pipeline: full ordered queue; [0] deep-equals resolveNextTask', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 }), mkEpic('EPIC-002', 'proposed', { order: 2 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-002', 'specifying', 'unapproved', { epic: 'EPIC-002' }),
      ],
      adrs: [mkAdr('DR-003', 'proposed', { epic: 'EPIC-002' })],
    });
    const pipe = resolvePipeline(g);
    expect(pipe.length).toBeGreaterThan(0);
    expect(pipe[0]).toStrictEqual(resolveNextTask(g));
  });

  it('FR-8a-deviation: next task is purely artifact-state derived (no dev-activity input)', () => {
    // Two structurally-identical graphs yield identical next tasks; the resolver has
    // no input channel for "what the dev is doing", so deviation cannot move it.
    const build = () =>
      graph({
        epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
        specs: [mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' })],
      });
    expect(resolveNextTask(build())).toStrictEqual(resolveNextTask(build()));
  });
});
