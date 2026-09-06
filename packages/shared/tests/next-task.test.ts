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
  formatNextTaskLabel,
  formatImperativeForSignpost,
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

  it('#893-relates-dangling: a dangling relates_to is NOT corruption and NOT a gate-violation', () => {
    // relates_to is the soft, non-gating edge (already exempt from acyclicity). A
    // dangling relates_to is commonly a legitimate cross-register ref (a local DR
    // relating to a parent-register DR that does not resolve in this repo). It must
    // NOT surface as a top gate-violation that buries the real next human task.
    const g = graph({
      // One genuine pending decision to be surfaced instead of the dangler.
      adrs: [mkAdr('DR-001', 'proposed')],
      specs: [mkSpec('SPEC-001', 'specifying', 'unapproved')],
      edges: [{ kind: 'relates_to', from: 'DR-001', to: 'DR-355' }], // DR-355 = parent register, unresolved here
    });
    // No dangling-ref corruption emitted for the soft edge.
    expect(resolveCorruption(g).filter((c) => c.kind === 'dangling-ref')).toHaveLength(0);
    // The next task is a real pending decision, not a "state unclear" gate-violation.
    const next = resolveNextTask(g)!;
    expect(next.severityClass).not.toBe('gate-violation');
    expect(next.evidence.rule).not.toMatch(/^dangling\./);
  });

  it('#893-gating-dangling-still-corruption: a dangling supersedes/depends_on remains corruption', () => {
    // The fix is scoped to relates_to only — the GATING edges still fail loudly.
    const g = graph({
      specs: [mkSpec('SPEC-001', 'implementing', 'approved')],
      edges: [{ kind: 'supersedes', from: 'SPEC-001', to: 'SPEC-777' }],
    });
    const dangling = resolveCorruption(g).filter((c) => c.kind === 'dangling-ref');
    expect(dangling).toHaveLength(1);
    expect(dangling[0].refs).toStrictEqual(['SPEC-001', 'SPEC-777']);
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
    // #1237: the target is the BLOCKER, not the blocked artifact. `minspec.nextTask`
    // reveals `targetId`, so this is what decides which file the human is sent to —
    // and the only actionable end of the edge is the un-cleared one.
    expect(violation!.targetId).toBe('SPEC-001');
  });

  it('FR-13-advance-past (#1237): the imperative tells you to clear the blocker, and evidence keeps both ends', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-002', 'implementing', 'approved', { epic: 'EPIC-001' }),
      ],
      edges: [{ kind: 'depends_on', from: 'SPEC-002', to: 'SPEC-001' }],
    });
    const v = resolvePipeline(g).find((t) => t.evidence.rule === 'depends_on.uncleared')!;
    // The imperative's OBJECT is the blocker — asserted on the leading verb phrase so a
    // future reword that quietly puts the blocked artifact back in front fails here.
    expect(v.imperative).toMatch(/^Clear SPEC-001\b/);
    expect(v.imperative).toContain('SPEC-002');
    // Narrowing the target must not drop information: both ends stay in refs.
    expect(v.evidence.refs).toContain('SPEC-001');
    expect(v.evidence.refs).toContain('SPEC-002');
  });

  it('FR-13-advance-past (#1237): with several blockers, the first sorted one is the target and the rest are still named', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-003', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-009', 'implementing', 'approved', { epic: 'EPIC-001' }),
      ],
      edges: [
        // Deliberately declared out of order — the target must come from the
        // compareIds sort in unclearedDependsOn, not from edge declaration order,
        // or the signpost would be non-deterministic across graph rebuilds.
        { kind: 'depends_on', from: 'SPEC-009', to: 'SPEC-003' },
        { kind: 'depends_on', from: 'SPEC-009', to: 'SPEC-001' },
      ],
    });
    const v = resolvePipeline(g).find((t) => t.evidence.rule === 'depends_on.uncleared')!;
    expect(v.targetId).toBe('SPEC-001');
    expect(v.imperative).toMatch(/^Clear SPEC-001\b/);
    expect(v.imperative).toContain('SPEC-003');
    expect(v.evidence.refs).toStrictEqual(['SPEC-009', 'SPEC-001', 'SPEC-003']);
  });

  it('FR-13-advance-past (#1237): two advancing artifacts sharing one blocker BOTH keep their violation', () => {
    // Regression guard for the review finding on #1241: `artifactId` is the identity
    // key for topoFloorBlock's `emitted` set, so pointing it at the shared blocker
    // would collapse these two nodes into one — a gate that silently stops firing for
    // the second artifact (constitution invariant #2, no silent gate).
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-002', 'implementing', 'approved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-003', 'implementing', 'approved', { epic: 'EPIC-001' }),
      ],
      edges: [
        { kind: 'depends_on', from: 'SPEC-002', to: 'SPEC-001' },
        { kind: 'depends_on', from: 'SPEC-003', to: 'SPEC-001' },
      ],
    });
    const violations = resolvePipeline(g).filter((t) => t.evidence.rule === 'depends_on.uncleared');
    expect(violations).toHaveLength(2);
    // Both point at the shared blocker...
    expect(violations.map((v) => v.targetId)).toStrictEqual(['SPEC-001', 'SPEC-001']);
    // ...but each still names its own advancing artifact, so neither is a duplicate.
    const imperatives = violations.map((v) => v.imperative).sort();
    expect(imperatives[0]).toContain('SPEC-002');
    expect(imperatives[1]).toContain('SPEC-003');
  });

  it('FR-13-advance-past (#1237): the single signpost sends you to the blocker', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
        mkSpec('SPEC-002', 'implementing', 'approved', { epic: 'EPIC-001' }),
      ],
      edges: [{ kind: 'depends_on', from: 'SPEC-002', to: 'SPEC-001' }],
    });
    // End-to-end through the one function the command and status bar both call.
    expect(resolveNextTask(g)!.targetId).toBe('SPEC-001');
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

  it('SUPERSEDED (#579): a superseded spec is terminal-out, same as done/archived, not a pending task', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active')],
      specs: [mkSpec('SPEC-001', 'superseded', 'unapproved', { epic: 'EPIC-001' })],
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

// =====================================================================
// #227 answer-OQ — pre-phase open-questions gate
// =====================================================================
describe('#227 answer-OQ — open-questions gate', () => {
  it('in-flight: an implementing spec with an unresolved OQ surfaces as a pending answer-OQ node, not corruption', () => {
    const g = graph({
      specs: [
        mkSpec('SPEC-001', 'implementing', 'approved', { hasUnresolvedOpenQuestions: true }),
      ],
    });
    expect(resolveCorruption(g)).toHaveLength(0);
    const next = resolveNextTask(g)!;
    expect(next.kind).toBe('answer-OQ');
    expect(next.targetId).toBe('SPEC-001');
    expect(next.severityClass).toBe('pending');
  });

  it('in-flight: blocked-ready when the parent epic is active', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'implementing', 'approved', {
          epic: 'EPIC-001',
          hasUnresolvedOpenQuestions: true,
        }),
      ],
    });
    const next = resolveNextTask(g)!;
    expect(next.kind).toBe('answer-OQ');
    expect(next.severityClass).toBe('blocked-ready');
  });

  it('a resolved (or absent) flag never generates an answer-OQ node', () => {
    const g = graph({
      specs: [
        mkSpec('SPEC-001', 'implementing', 'approved', { hasUnresolvedOpenQuestions: false }),
        mkSpec('SPEC-002', 'implementing', 'approved'),
      ],
    });
    expect(resolvePipeline(g).some((t) => t.kind === 'answer-OQ')).toBe(false);
  });

  it('terminal (spec): done with an unresolved OQ is a gate-violation, not a normal pending node — closes "shipped with a dangling OQ"', () => {
    const g = graph({
      specs: [mkSpec('SPEC-001', 'done', 'approved', { hasUnresolvedOpenQuestions: true })],
    });
    const corruptions = resolveCorruption(g);
    expect(corruptions).toHaveLength(1);
    expect(corruptions[0].rule).toBe('coherence.terminal-with-open-oq');
    expect(corruptions[0].refs).toEqual(['SPEC-001']);
    const next = resolveNextTask(g)!;
    expect(next.severityClass).toBe('gate-violation');
  });

  it('terminal (spec): archived with an unresolved OQ is also a gate-violation', () => {
    const g = graph({
      specs: [mkSpec('SPEC-001', 'archived', 'approved', { hasUnresolvedOpenQuestions: true })],
    });
    expect(resolveCorruption(g)[0]?.rule).toBe('coherence.terminal-with-open-oq');
  });

  it('terminal (DR): accepted with an unresolved OQ is a gate-violation — a DR has no "implementing" phase, so accepted IS its shipped state', () => {
    const g = graph({
      adrs: [mkAdr('DR-001', 'accepted', { hasUnresolvedOpenQuestions: true })],
    });
    const corruptions = resolveCorruption(g);
    expect(corruptions).toHaveLength(1);
    expect(corruptions[0].rule).toBe('coherence.terminal-with-open-oq');
    expect(corruptions[0].refs).toEqual(['DR-001']);
  });

  it('a proposed DR with an unresolved OQ is NOT flagged — still authoring, mirrors specifying', () => {
    const g = graph({
      adrs: [mkAdr('DR-001', 'proposed', { hasUnresolvedOpenQuestions: true })],
    });
    expect(resolveCorruption(g)).toHaveLength(0);
  });

  it('a superseded spec/DR with an unresolved OQ is exempt (it is being retired, not shipped)', () => {
    const g = graph({
      specs: [mkSpec('SPEC-001', 'done', 'approved', { hasUnresolvedOpenQuestions: true })],
      adrs: [mkAdr('DR-001', 'accepted', { hasUnresolvedOpenQuestions: true })],
      edges: [
        { kind: 'supersedes', from: 'SPEC-002', to: 'SPEC-001' },
        { kind: 'supersedes', from: 'DR-002', to: 'DR-001' },
      ],
    });
    // SPEC-002/DR-002 don't resolve (dangling supersedes source) but that's a
    // separate corruption class; assert specifically that terminal-with-open-oq
    // does not fire for the superseded targets.
    expect(
      resolveCorruption(g).filter((c) => c.rule === 'coherence.terminal-with-open-oq'),
    ).toHaveLength(0);
  });

  it('deprecated/superseded-status DR with an unresolved OQ is also a gate-violation', () => {
    const g = graph({
      adrs: [mkAdr('DR-001', 'deprecated', { hasUnresolvedOpenQuestions: true })],
    });
    expect(resolveCorruption(g)[0]?.rule).toBe('coherence.terminal-with-open-oq');
  });

  it('determinism: identical graph yields identical answer-OQ node across runs', () => {
    const g = graph({
      specs: [mkSpec('SPEC-001', 'implementing', 'approved', { hasUnresolvedOpenQuestions: true })],
    });
    const first = resolveNextTask(g);
    for (let i = 0; i < 5; i++) {
      expect(resolveNextTask(g)).toStrictEqual(first);
    }
  });
});

// =====================================================================
// formatNextTaskLabel — the ONE canonical signpost label (shared by the
// status-bar item AND the planned DAG-viz node, #742/#48)
// =====================================================================
describe('formatNextTaskLabel — single-source signpost wording', () => {
  it('null → "clear"', () => {
    expect(formatNextTaskLabel(null)).toBe('clear');
  });

  it('task → "Next Task: <imperative>", verbatim from the resolved imperative', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [mkSpec('SPEC-001', 'specifying', 'unapproved', { epic: 'EPIC-001' })],
    });
    const next = resolveNextTask(g)!;
    expect(next.imperative).toBe('Approve SPEC-001');
    // The label runs the imperative through the same one-line normalization
    // every surface shares (#1596) — a no-op here since there's no tasks.md
    // markdown/metadata to strip, so it still reads verbatim.
    expect(formatNextTaskLabel(next)).toBe('Next Task: Approve SPEC-001');
  });

  it('is pure — same NextTask yields the same string', () => {
    const g = graph({ adrs: [mkAdr('DR-001', 'proposed')] });
    const next = resolveNextTask(g);
    expect(formatNextTaskLabel(next)).toBe(formatNextTaskLabel(next));
  });
});

// =====================================================================
// formatImperativeForSignpost — strips tasks.md authoring residue from a
// one-line surface (#1596: the signpost was leaking raw markdown, the
// allowlist clause, and the AC/INV trace clause into the status bar).
// =====================================================================
describe('formatImperativeForSignpost — one-line tasks.md cleanup (#1596)', () => {
  it('drops the trailing " - allowlist: …" clause', () => {
    expect(
      formatImperativeForSignpost(
        'Implement SPEC-038: wire the adapter - allowlist: packages/minspec/tests/ownership.test.ts',
      ),
    ).toBe('Implement SPEC-038: wire the adapter');
  });

  it('drops the trailing "(AC-n, INV-n)" trace clause', () => {
    expect(formatImperativeForSignpost('Implement SPEC-038: wire the adapter (AC-7, INV-2)')).toBe(
      'Implement SPEC-038: wire the adapter',
    );
  });

  it('drops both clauses however they nest, and strips residual emphasis', () => {
    // Real tasks.md convention (SPEC-038-spec-code-ownership/tasks.md): the
    // trace clause precedes the allowlist clause, both em-dash-joined, and
    // the task title is bold.
    expect(
      formatImperativeForSignpost(
        'Implement SPEC-038: **wire the adapter** *(AC-7, INV-2)* — allowlist: `packages/minspec/tests/ownership.test.ts`',
      ),
    ).toBe('Implement SPEC-038: wire the adapter');
  });

  it('collapses whitespace left behind by clause removal', () => {
    expect(formatImperativeForSignpost('Implement SPEC-038:   wire   the adapter   (AC-1)')).toBe(
      'Implement SPEC-038: wire the adapter',
    );
  });

  it('truncates a long imperative on a WORD boundary, never mid-token', () => {
    const long = `Implement SPEC-038: ${'wire the adapter '.repeat(8).trim()}`;
    const result = formatImperativeForSignpost(long);
    expect(result.length).toBeLessThanOrEqual(101); // 100 chars + the ellipsis
    expect(result.endsWith('…')).toBe(true);
    // No dangling half-word right before the ellipsis.
    expect(result.slice(0, -1).endsWith(' ')).toBe(false);
    expect(long.startsWith(result.slice(0, -1))).toBe(true);
  });

  it('a clean imperative with nothing to strip passes through unchanged', () => {
    expect(formatImperativeForSignpost('Implement SPEC-038: wire the adapter')).toBe(
      'Implement SPEC-038: wire the adapter',
    );
  });

  it('is idempotent', () => {
    const once = formatImperativeForSignpost(
      'Implement SPEC-038: **wire the adapter** *(AC-7, INV-2)* — allowlist: `foo.ts`',
    );
    expect(formatImperativeForSignpost(once)).toBe(once);
  });

  it('end-to-end via a real implement-hole: the label drops what the tooltip keeps', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-038', 'implementing', 'approved', {
          epic: 'EPIC-001',
          phase: 'implement',
          implementHole: {
            kind: 'unchecked-tasks',
            remaining: 1,
            total: 11,
            nextItem: '(test, T0 — symmetry) wire the adapter (AC-7, INV-2) — allowlist: ownership.test.ts',
          },
        }),
      ],
    });
    const next = resolveNextTask(g)!;
    // The label (status bar / toast / accessibility text) is markdown/metadata-free.
    expect(formatNextTaskLabel(next)).toBe(
      'Next Task: Implement SPEC-038: (test, T0 — symmetry) wire the adapter',
    );
    // The tooltip-bound explanation keeps the full line — it has the room.
    expect(next.evidence.explanation).toContain(
      '— next: (test, T0 — symmetry) wire the adapter (AC-7, INV-2) — allowlist: ownership.test.ts',
    );
  });
});

// =====================================================================
// INV-PA — phase-action, the implement-hole node (#1436)
//
// Before this, the resolver emitted nothing for a spec that was approved and
// mid-implementation, so the signpost read "clear" while real work was pending.
// These rows pin the GATE (what may emit), the RANKING (what wins), and the
// SHAPE (what consumers can rely on).
// =====================================================================
const HOLE_OPEN: SpecNode['implementHole'] = {
  kind: 'unchecked-tasks',
  remaining: 3,
  total: 10,
  nextItem: 'Wire the adapter',
};
const HOLE_NONE: SpecNode['implementHole'] = { kind: 'missing-tasks' };

describe('INV-PA — phase-action implement-hole node (#1436)', () => {
  it('INV-PA-1: an approved, implementing spec with open tasks emits phase-action naming the next item', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'implementing', 'approved', {
          epic: 'EPIC-001',
          phase: 'implement', implementHole: HOLE_OPEN,
        }),
      ],
    });
    const next = resolveNextTask(g)!;
    expect(next.kind).toBe('phase-action');
    expect(next.targetId).toBe('SPEC-001');
    expect(next.imperative).toBe('Implement SPEC-001: Wire the adapter');
    // The tooltip-bound explanation carries the full nextItem too (#1596) — it's
    // a multi-line surface with room the one-line label doesn't have.
    expect(next.evidence.explanation).toBe(
      'SPEC-001 is implementing with 3 of 10 tasks open — next: Wire the adapter',
    );
  });

  it('INV-PA-2 (DR-012 gate): an UNAPPROVED spec never emits phase-action, however open its tasks', () => {
    for (const state of ['unapproved', 'stale'] as const) {
      const g = graph({
        epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
        specs: [
          mkSpec('SPEC-001', 'implementing', state, {
            epic: 'EPIC-001',
            phase: 'implement', implementHole: HOLE_OPEN,
          }),
        ],
      });
      const kinds = resolvePipeline(g).map((t) => t.kind);
      expect(kinds).not.toContain('phase-action');
      // ...and the approval gate is what it DOES surface, so the human is not stranded.
      expect(kinds).toContain('spec-approve');
    }
  });

  it('INV-PA-3: terminal + superseded specs never emit phase-action even carrying a hole', () => {
    for (const status of ['done', 'archived', 'superseded'] as const) {
      const g = graph({
        specs: [mkSpec('SPEC-001', status, 'approved', { phase: 'implement', implementHole: HOLE_OPEN })],
      });
      expect(resolvePipeline(g).map((t) => t.kind)).not.toContain('phase-action');
    }
    // Superseded-by-edge, not by status: the same exclusion must hold.
    const g = graph({
      specs: [
        mkSpec('SPEC-001', 'implementing', 'approved', { phase: 'implement', implementHole: HOLE_OPEN }),
        mkSpec('SPEC-002', 'implementing', 'approved'),
      ],
      edges: [{ kind: 'supersedes', from: 'SPEC-002', to: 'SPEC-001' }],
    });
    expect(resolvePipeline(g).filter((t) => t.targetId === 'SPEC-001')).toStrictEqual([]);
  });

  it('INV-PA-4: no hole ⇒ no node — a fully-checked spec is silent', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [mkSpec('SPEC-001', 'implementing', 'approved', { epic: 'EPIC-001' })],
    });
    expect(resolveNextTask(g)).toBeNull();
    expect(resolvePipeline(g)).toStrictEqual([]);
  });

  it('INV-PA-5: `missing-tasks` is the WEAKER signal — it never outranks real open work', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        // SPEC-001 sorts FIRST by id, so only the severity split can demote it.
        mkSpec('SPEC-001', 'implementing', 'approved', {
          epic: 'EPIC-001',
          phase: 'implement', implementHole: HOLE_NONE,
        }),
        mkSpec('SPEC-002', 'implementing', 'approved', {
          epic: 'EPIC-001',
          phase: 'implement', implementHole: HOLE_OPEN,
        }),
      ],
    });
    const pipe = resolvePipeline(g);
    expect(pipe[0].targetId).toBe('SPEC-002');
    expect(pipe[0].severityClass).toBe('blocked-ready');
    expect(pipe[1].targetId).toBe('SPEC-001');
    expect(pipe[1].severityClass).toBe('pending');
    expect(pipe[1].imperative).toBe('Break SPEC-001 into tasks');
  });

  it('INV-PA-PHASE: a spec still being PLANNED emits nothing, however holed', () => {
    // The adapter folds MinSpec's `planning` band (approved, implement not
    // started) into the resolver's `implementing` on purpose (DR-069), so
    // `status` alone cannot tell them apart. Gating on status alone told the
    // human to "Implement SPEC-X" for specs mid-plan, which is the false
    // signpost DR-069 exists to prevent. A task list is due from `tasks` on.
    for (const phase of ['specify', 'clarify', 'plan'] as const) {
      const g = graph({
        epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
        specs: [
          mkSpec('SPEC-001', 'implementing', 'approved', {
            epic: 'EPIC-001',
            phase,
            implementHole: HOLE_OPEN,
          }),
        ],
      });
      expect(resolvePipeline(g).map((t) => t.kind)).not.toContain('phase-action');
    }
  });

  it('INV-PA-PHASE-2: the `tasks` phase emits, and never claims the spec is being implemented', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'implementing', 'approved', {
          epic: 'EPIC-001',
          phase: 'tasks',
          implementHole: HOLE_OPEN,
        }),
      ],
    });
    const next = resolveNextTask(g)!;
    expect(next.kind).toBe('phase-action');
    expect(next.imperative).toBe('Finish the task list for SPEC-001: Wire the adapter');
    expect(next.imperative).not.toContain('Implement');
    expect(next.evidence.explanation).toBe(
      'SPEC-001 is in the tasks phase with 3 of 10 tasks open — next: Wire the adapter',
    );
  });

  it('INV-PA-STATUS: a non-implementing spec emits nothing even when approved and holed', () => {
    // Guards the `status !== 'implementing'` line itself, which no other row
    // reaches: `specifying` is the only approved-but-pre-implementing status,
    // and it must not produce implement work.
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'specifying', 'approved', {
          epic: 'EPIC-001',
          phase: 'implement',
          implementHole: HOLE_OPEN,
        }),
      ],
    });
    expect(resolvePipeline(g).map((t) => t.kind)).not.toContain('phase-action');
  });

  it('INV-PA-OQ-ORDER: an unanswered open question outranks implementing against it', () => {
    // Both nodes tie on EVERY compareRanked term (same class, dials, id), so the
    // outcome rests on generator order + a stable sort. Pin it: answer first.
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'implementing', 'approved', {
          epic: 'EPIC-001',
          hasUnresolvedOpenQuestions: true,
          phase: 'implement', implementHole: HOLE_OPEN,
        }),
      ],
    });
    const pipe = resolvePipeline(g);
    expect(pipe.map((t) => t.kind)).toStrictEqual(['answer-OQ', 'phase-action']);
    expect(resolveNextTask(g)!.kind).toBe('answer-OQ');
  });

  it('INV-NODE-IDENTITY: two nodes on ONE artifact both survive depends_on flooring', () => {
    // REGRESSION (#1436). `topoFloorBlock` used to key its emitted-set on
    // `artifactId`, so the second node for the same spec was dropped — in the
    // main loop AND the leftover sweep. Flooring arms whenever ANY depends_on
    // edge is un-cleared, so one unrelated edge anywhere used to silence a real
    // pending task. Invariant #2: no gate may fail silently.
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'implementing', 'approved', {
          epic: 'EPIC-001',
          hasUnresolvedOpenQuestions: true,
          phase: 'implement', implementHole: HOLE_OPEN,
        }),
        // Un-cleared dependency: SPEC-003 is unapproved, so the edge does not clear
        // and `floorDependsOn` runs over every severity block.
        mkSpec('SPEC-002', 'implementing', 'approved', {
          epic: 'EPIC-001',
          phase: 'implement', implementHole: HOLE_OPEN,
        }),
        mkSpec('SPEC-003', 'specifying', 'unapproved', { epic: 'EPIC-001' }),
      ],
      edges: [{ kind: 'depends_on', from: 'SPEC-002', to: 'SPEC-003' }],
    });
    // Assert the WHOLE order, not just membership. Keying the main loop on
    // artifactId does not delete the second node outright — the leftover sweep
    // re-adds it at the END — so a membership-only assertion passes through
    // that regression. Position is what distinguishes "kept" from "shunted".
    expect(resolvePipeline(g).map((t) => `${t.targetId}:${t.kind}`)).toStrictEqual([
      // gate-violation: SPEC-002 advances past its un-cleared blocker. Points at
      // the blocker, but ranks on SPEC-002 (artifactId), which is why it is not
      // a duplicate of SPEC-003's own gate node three rows below.
      'SPEC-003:spec-approve',
      'SPEC-001:answer-OQ',
      'SPEC-001:phase-action',
      'SPEC-003:spec-approve',
      // ...and SPEC-002's own node is floored BELOW the blocker it depends on,
      // which is the flooring this dedup change had to leave intact.
      'SPEC-002:phase-action',
    ]);
  });

  it('INV-NODE-IDENTITY-2: the leftover sweep also keeps both nodes (cycle path)', () => {
    // The main loop and the sweep are two separate places that must key on the
    // NODE. A dependency cycle starves the main loop so the sweep runs, which
    // is the only way to reach that second branch with duplicates present.
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'implementing', 'approved', {
          epic: 'EPIC-001',
          phase: 'implement',
          hasUnresolvedOpenQuestions: true,
          implementHole: HOLE_OPEN,
        }),
        mkSpec('SPEC-002', 'implementing', 'approved', {
          epic: 'EPIC-001',
          phase: 'implement',
          implementHole: HOLE_OPEN,
        }),
      ],
      edges: [
        { kind: 'depends_on', from: 'SPEC-001', to: 'SPEC-002' },
        { kind: 'depends_on', from: 'SPEC-002', to: 'SPEC-001' },
      ],
    });
    // THREE nodes on one artifact here: the cycle is corruption (a
    // gate-violation carrying the spec's natural kind), plus the open question,
    // plus the implement hole. All three must survive.
    const forSpec1 = resolvePipeline(g).filter((t) => t.targetId === 'SPEC-001');
    expect(forSpec1.map((t) => t.kind)).toStrictEqual(['spec-approve', 'answer-OQ', 'phase-action']);
    expect(forSpec1[0].severityClass).toBe('gate-violation');
  });

  it('INV-PA-SHAPE: targetId stays a bare artifact id, and the contract keys are unchanged', () => {
    const g = graph({
      specs: [mkSpec('SPEC-042', 'implementing', 'approved', { phase: 'implement', implementHole: HOLE_OPEN })],
    });
    const next = resolveNextTask(g)!;
    expect(next.kind).toBe('phase-action');
    // Consumers (status bar, realdata smoke test) match this exactly — the phase
    // belongs in the imperative, never encoded into the id.
    expect(next.targetId).toMatch(/^(SPEC|DR|EPIC)-\d+$/);
    expect(Object.keys(next).sort()).toStrictEqual(
      ['evidence', 'imperative', 'kind', 'severityClass', 'targetId'].sort(),
    );
  });

  it('INV-PA-DET: phase-action nodes are deterministic across runs', () => {
    const g = graph({
      epics: [mkEpic('EPIC-001', 'active', { order: 1 })],
      specs: [
        mkSpec('SPEC-001', 'implementing', 'approved', { epic: 'EPIC-001', phase: 'implement', implementHole: HOLE_OPEN }),
        mkSpec('SPEC-002', 'implementing', 'approved', { epic: 'EPIC-001', phase: 'implement', implementHole: HOLE_NONE }),
      ],
    });
    const first = JSON.stringify(resolvePipeline(g));
    for (let i = 0; i < 5; i++) expect(JSON.stringify(resolvePipeline(g))).toBe(first);
  });

  it('INV-PA-6: an open-task hole with no nextItem still produces a usable imperative', () => {
    const g = graph({
      specs: [
        mkSpec('SPEC-001', 'implementing', 'approved', {
          phase: 'implement',
          implementHole: { kind: 'unchecked-tasks', remaining: 2, total: 4 },
        }),
      ],
    });
    expect(resolveNextTask(g)!.imperative).toBe('Implement SPEC-001');
  });
});
