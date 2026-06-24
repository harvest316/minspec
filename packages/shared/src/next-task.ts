/**
 * Next-Task Resolver — SPEC-012 / DR-019 (Tier-0 pure core).
 *
 * A deterministic engine that unifies every pending HUMAN decision into one
 * total order and emits the single next human task — never a list (FR-5; the
 * full pipeline is the optional FR-6 expansion). Priority is a pure function of
 * structural state (epic/spec/ADR status + the `epic.order` / goal-rank /
 * priority dials + explicit cross-cutting edges), NEVER an LLM judgement
 * (DR-019 §1, FR-1).
 *
 * INVARIANTS (do not break):
 *   - DETERMINISM / Tier-0. Pure function of its inputs. No `vscode`, no `fs`,
 *     no network, no `Date`, no `Math.random`, no LLM. Same graph → identical
 *     NextTask + identical pipeline. (DR-019 §1/§6, FR-1, FR-11.)
 *   - SEVERITY PRECEDENCE. gate-violation ▸ blocked-ready ▸ promote-parent ▸
 *     pending; the next task is the MINIMUM of the total order. (DR-019 §2, FR-2.)
 *   - COHERENCE. A child must not be ahead of its parent's status (spec
 *     `implementing` under a `proposed` epic; ADR `accepted` under a `proposed`
 *     epic) → top gate-violation. (DR-019 §5, FR-9.)
 *   - DETECT-ONLY corruption. Cycles / dangling refs / incoherence are DETECTED
 *     deterministically and surfaced; this core NEVER repairs. (FR-15.)
 *
 * DEFERRED — typed seams, not stubs:
 *   - FR-13 edge PARSING (frontmatter→Edge[]) is the fs-adapter's job (deferred);
 *     this core only consumes a built Edge[]. Absent edges ⇒ pure tree order.
 *   - 'phase-action' nodes come from SPEC-010's per-feature resolver (FR-4,
 *     deferred); declared in the NodeKind union as a typed seam, never generated
 *     here.
 *   - FR-3b milestones, FR-15 LLM repair-escalation, PR-review nodes (#182),
 *     pre-phase gates (#227) are out of this slice. This core DETECTS corruption
 *     only; the repair ladder (deterministic→LLM offer) is a follow-up consumer
 *     of `resolveCorruption()`.
 *   - The fs adapter (build ArtifactGraph from real epics/specs/DRs) and all UI
 *     surfaces (status-bar/explorer) are a separate follow-up PR.
 */

// ---- Status enums (mirror packages/minspec source-of-truth, redeclared Tier-0-locally) ----
export type EpicStatus = 'proposed' | 'active' | 'done' | 'abandoned';
export type SpecStatus = 'new' | 'specifying' | 'implementing' | 'done' | 'archived';
export type AdrStatus = 'proposed' | 'accepted' | 'deprecated' | 'superseded';
export type ApprovalState = 'approved' | 'stale' | 'unapproved';
export type Phase = 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement';
export type PhaseStatus = 'pending' | 'in-progress' | 'done' | 'skipped';

// ---- Explicit cross-cutting edges (FR-13). The resolver ACCEPTS these; file-parsing is deferred. ----
export type EdgeKind = 'depends_on' | 'supersedes' | 'relates_to';
export interface Edge {
  kind: EdgeKind;
  from: string;
  to: string;
}

// ---- Per-artifact shared ranking inputs (the FR-3 / DR-039 dials) ----
export interface RankingInputs {
  /** epic.order coarse dial — resolved onto the artifact from its epic (lower = higher priority). */
  epicOrder?: number;
  /** DR-039 goal-rank (lower = higher). Absent ⇒ lowest precedence in that term. */
  goalRank?: number;
  /** FR-3 fine per-artifact priority (lower = higher). */
  priority?: number;
}

export interface EpicNode {
  id: string; // EPIC-NNN
  status: EpicStatus;
  order?: number; // epic.order dial
  goalRank?: number;
  priority?: number;
}
export interface SpecNode {
  id: string; // SPEC-NNN
  status: SpecStatus;
  tier?: 'T1' | 'T2' | 'T3' | 'T4';
  phase?: Phase; // current phase (informational; phase-action deferred to SPEC-010 source)
  epic?: string; // EPIC-NNN membership
  approvalState: ApprovalState;
  goalRank?: number;
  priority?: number;
}
export interface AdrNode {
  id: string; // DR-NNN
  status: AdrStatus;
  epic?: string;
  goalRank?: number;
  priority?: number;
}

export interface ArtifactGraph {
  epics: EpicNode[];
  specs: SpecNode[];
  adrs: AdrNode[];
  /** Explicit cross-cutting edges (FR-13). May be empty/absent — handled gracefully. */
  edges?: Edge[];
}

// ---- Output ----
export type SeverityClass = 'gate-violation' | 'blocked-ready' | 'promote-parent' | 'pending';
//  NOTE: 'phase-action' is in the kind UNION (DR-019/FR-8 vocabulary) but NOT
//  emitted by the core slice — its source is SPEC-010 (FR-4, deferred). Declared
//  for the typed seam, never produced.
export type NodeKind = 'epic-promote' | 'spec-approve' | 'adr-accept' | 'phase-action';

export interface Evidence {
  severityClass: SeverityClass;
  /** machine rule id that produced this node, e.g. 'coherence.spec-ahead-of-epic', 'depends_on.uncleared'. */
  rule: string;
  /** human-readable derivation, FR-7 (e.g. "SPEC-004 implementing under proposed EPIC-004"). */
  explanation: string;
  /** ids that participated in the decision (the artifact + its blocker/parent). */
  refs: string[];
}

export interface NextTask {
  kind: NodeKind;
  targetId: string;
  imperative: string; // "Approve SPEC-001" | "Promote EPIC-004" | "Accept DR-003"
  severityClass: SeverityClass;
  evidence: Evidence;
}

// ---- Corruption (FR-15: detect-only, never repair) ----
export type CorruptionKind = 'cycle' | 'dangling-ref' | 'incoherence';
export interface Corruption {
  kind: CorruptionKind;
  rule: string;
  message: string; // "state unclear — <ids>"
  refs: string[]; // offending artifact ids / cycle members
}

// =====================================================================
// Internal indexing
// =====================================================================

type AnyNode = EpicNode | SpecNode | AdrNode;

interface Index {
  byId: Map<string, AnyNode>;
  epicById: Map<string, EpicNode>;
  kindOf: Map<string, NodeKind>; // natural NextTask kind for an artifact id
}

function naturalKind(node: AnyNode, epicById: Map<string, EpicNode>): NodeKind {
  if (epicById.has(node.id)) return 'epic-promote';
  if ((node as SpecNode).approvalState !== undefined) return 'spec-approve';
  return 'adr-accept';
}

function buildIndex(graph: ArtifactGraph): Index {
  const byId = new Map<string, AnyNode>();
  const epicById = new Map<string, EpicNode>();
  const kindOf = new Map<string, NodeKind>();

  for (const e of graph.epics) {
    byId.set(e.id, e);
    epicById.set(e.id, e);
  }
  for (const s of graph.specs) byId.set(s.id, s);
  for (const a of graph.adrs) byId.set(a.id, a);

  for (const node of byId.values()) {
    kindOf.set(node.id, naturalKind(node, epicById));
  }
  return { byId, epicById, kindOf };
}

// =====================================================================
// Deterministic, numeric-aware id comparison (FR-14 final tie-break)
// =====================================================================

const ID_RE = /^([A-Za-z]+)-(\d+)$/;

/** Compare two artifact ids: prefix lexically, then number numerically (SPEC-2 < SPEC-10). */
function compareIds(a: string, b: string): number {
  const ma = ID_RE.exec(a);
  const mb = ID_RE.exec(b);
  if (ma && mb) {
    if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
    const na = Number(ma[2]);
    const nb = Number(mb[2]);
    if (na !== nb) return na < nb ? -1 : 1;
    return 0;
  }
  // Deterministic fallback for non-matching ids.
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// =====================================================================
// Status helpers
// =====================================================================

/** A spec terminal-out state: no longer a pending human task. */
function isSpecTerminal(s: SpecNode): boolean {
  return s.status === 'done' || s.status === 'archived';
}

/**
 * Is the artifact at `id`'s OWN gate cleared? (a `depends_on` target is cleared
 * when: epic→active, spec→approved, adr→accepted). Unknown id ⇒ treated as
 * not-cleared by callers, but danglers are reported separately in Step 2a.
 */
function gateCleared(id: string, index: Index): boolean {
  const node = index.byId.get(id);
  if (!node) return false;
  if (index.epicById.has(id)) {
    const e = node as EpicNode;
    return e.status === 'active' || e.status === 'done';
  }
  if ((node as SpecNode).approvalState !== undefined) {
    const s = node as SpecNode;
    return s.approvalState === 'approved' || isSpecTerminal(s);
  }
  const a = node as AdrNode;
  return a.status === 'accepted';
}

// Coherence ladder (a child must NOT be ahead of its parent): the resolver flags
// the concrete DR-019 §5 cases directly in `detectIncoherence` — a spec
// `implementing`/`done` (work past the gate) under a `proposed` epic, and an ADR
// `accepted` under a `proposed` epic. The progress order epics imply is
// proposed(0) ▸ active(1) ▸ done(2); `abandoned` is terminal (no children-ahead
// check). Encoded inline at the two breach sites rather than via a shared rank fn.

// =====================================================================
// Step 1 — supersedes pruning (FR-13)
// =====================================================================

/**
 * Ids that are the `to` of a `supersedes` edge AND not already terminal-out drop
 * out of the candidate set. Edge-case #6: superseding an already-out target is a
 * no-op (the target was never going to be a task anyway).
 */
function computeSuperseded(graph: ArtifactGraph, index: Index): Set<string> {
  const out = new Set<string>();
  for (const edge of graph.edges ?? []) {
    if (edge.kind !== 'supersedes') continue;
    const target = index.byId.get(edge.to);
    if (!target) continue; // dangling — reported as corruption in Step 2a, not silently superseded
    out.add(edge.to);
  }
  return out;
}

// =====================================================================
// Step 2 — structural corruption detection (FR-15), deterministic
// =====================================================================

/** 2a — dangling refs: any membership ref or edge endpoint not in the index. */
function detectDangling(graph: ArtifactGraph, index: Index): Corruption[] {
  const out: Corruption[] = [];
  const seen = new Set<string>(); // dedupe by "from→to" / "id→ref"

  const note = (key: string, c: Corruption) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  for (const s of graph.specs) {
    if (s.epic && !index.byId.has(s.epic)) {
      note(`${s.id}->${s.epic}`, {
        kind: 'dangling-ref',
        rule: 'dangling.epic-ref',
        message: `state unclear — ${s.id} references missing epic ${s.epic}`,
        refs: [s.id, s.epic],
      });
    }
  }
  for (const a of graph.adrs) {
    if (a.epic && !index.byId.has(a.epic)) {
      note(`${a.id}->${a.epic}`, {
        kind: 'dangling-ref',
        rule: 'dangling.epic-ref',
        message: `state unclear — ${a.id} references missing epic ${a.epic}`,
        refs: [a.id, a.epic],
      });
    }
  }
  for (const edge of graph.edges ?? []) {
    if (!index.byId.has(edge.from)) {
      note(`edge-from:${edge.from}->${edge.to}`, {
        kind: 'dangling-ref',
        rule: `dangling.${edge.kind}`,
        message: `state unclear — edge source ${edge.from} does not resolve`,
        refs: [edge.from, edge.to],
      });
    }
    if (!index.byId.has(edge.to)) {
      note(`edge-to:${edge.from}->${edge.to}`, {
        kind: 'dangling-ref',
        rule: `dangling.${edge.kind}`,
        message: `state unclear — ${edge.from} ${edge.kind} ${edge.to}, but ${edge.to} does not resolve`,
        refs: [edge.from, edge.to],
      });
    }
  }
  return out;
}

/**
 * 2b — cycle detection (INV-ACYCLIC). Gating edges only = `depends_on` +
 * `supersedes` (per FR-13: `relates_to` is exempt from acyclicity). Iterative
 * three-color DFS with an explicit stack — NO recursion, so a cycle can never
 * blow the stack or infinite-loop. Terminates in O(V+E).
 */
function detectCycles(graph: ArtifactGraph, index: Index): Corruption[] {
  // Build adjacency over gating edges whose BOTH endpoints resolve (danglers are
  // their own corruption class; including them here would crash traversal).
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const id of index.byId.keys()) {
    adj.set(id, []);
    nodes.add(id);
  }
  for (const edge of graph.edges ?? []) {
    if (edge.kind !== 'depends_on' && edge.kind !== 'supersedes') continue;
    if (!index.byId.has(edge.from) || !index.byId.has(edge.to)) continue;
    adj.get(edge.from)!.push(edge.to);
  }
  // Deterministic neighbour order.
  for (const list of adj.values()) list.sort(compareIds);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodes) color.set(id, WHITE);

  const out: Corruption[] = [];
  const reportedCycles = new Set<string>();

  // Process roots in deterministic id order.
  const roots = [...nodes].sort(compareIds);

  for (const root of roots) {
    if (color.get(root) !== WHITE) continue;
    // Explicit stack: each frame tracks its neighbour cursor. `path` mirrors the
    // gray chain so a back-edge can name the exact cycle members.
    const stack: Array<{ id: string; i: number }> = [{ id: root, i: 0 }];
    const path: string[] = [];
    color.set(root, GRAY);
    path.push(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbours = adj.get(frame.id)!;
      if (frame.i < neighbours.length) {
        const next = neighbours[frame.i];
        frame.i++;
        const c = color.get(next);
        if (c === GRAY) {
          // Back-edge to a gray node → cycle. Members = the path slice from `next`.
          const idx = path.indexOf(next);
          const members = path.slice(idx).slice();
          const sorted = [...members].sort(compareIds);
          const key = sorted.join('|');
          if (!reportedCycles.has(key)) {
            reportedCycles.add(key);
            out.push({
              kind: 'cycle',
              rule: 'cycle.depends-on',
              message: `state unclear — dependency cycle among ${sorted.join(', ')}`,
              refs: sorted,
            });
          }
        } else if (c === WHITE) {
          color.set(next, GRAY);
          path.push(next);
          stack.push({ id: next, i: 0 });
        }
        // BLACK ⇒ already fully explored, skip.
      } else {
        // Done with this frame: blacken, pop from stack and path.
        color.set(frame.id, BLACK);
        stack.pop();
        path.pop();
      }
    }
  }
  return out;
}

/**
 * 2c — incoherence / coherence (FR-9, INV-COH). A child must NOT be ahead of its
 * parent's status. Also DR-012 intra-spec coherence (implementing-but-unapproved).
 */
function detectIncoherence(
  graph: ArtifactGraph,
  index: Index,
  superseded: Set<string>,
): Corruption[] {
  const out: Corruption[] = [];

  for (const s of graph.specs) {
    // A superseded artifact is being retired — its internal coherence breach is
    // moot and must not surface as the top gate-violation (it would tell the
    // human to fix a spec that is on its way out). Node generation already drops
    // superseded nodes; corruption detection must agree (consistency).
    if (superseded.has(s.id)) continue;
    // Intra-spec (DR-012): implementing while not approved is incoherent — even
    // with no epic.
    if (s.status === 'implementing' && s.approvalState !== 'approved') {
      out.push({
        kind: 'incoherence',
        rule: 'coherence.implementing-unapproved',
        message: `state unclear — ${s.id} is implementing but unapproved (${s.approvalState})`,
        refs: [s.id],
      });
    }
    // Spec ahead of a proposed epic: implementing/done work past the gate.
    if (s.epic) {
      const epic = index.epicById.get(s.epic);
      if (epic && epic.status === 'proposed' && (s.status === 'implementing' || s.status === 'done')) {
        out.push({
          kind: 'incoherence',
          rule: 'coherence.spec-ahead-of-epic',
          message: `state unclear — ${s.id} ${s.status} under proposed ${epic.id}`,
          refs: [epic.id, s.id].sort(compareIds),
        });
      }
    }
  }

  for (const a of graph.adrs) {
    if (superseded.has(a.id)) continue;
    if (a.epic) {
      const epic = index.epicById.get(a.epic);
      if (epic && epic.status === 'proposed' && a.status === 'accepted') {
        out.push({
          kind: 'incoherence',
          rule: 'coherence.adr-ahead-of-epic',
          message: `state unclear — ${a.id} accepted under proposed ${epic.id}`,
          refs: [epic.id, a.id].sort(compareIds),
        });
      }
    }
  }

  return out;
}

/**
 * Detect-only structural corruption (FR-15). Returns the typed set for FR-10
 * "state unclear" callers; the resolver also surfaces the same set as top-ranked
 * gate-violation NextTasks so the single signpost never silently drops it.
 */
export function resolveCorruption(graph: ArtifactGraph): Corruption[] {
  const index = buildIndex(graph);
  const superseded = computeSuperseded(graph, index);
  return [
    ...detectDangling(graph, index),
    ...detectCycles(graph, index),
    ...detectIncoherence(graph, index, superseded),
  ];
}

// =====================================================================
// Step 3 — node generation + severity assignment (FR-2)
// =====================================================================

const CLASS_RANK: Record<SeverityClass, number> = {
  'gate-violation': 0,
  'blocked-ready': 1,
  'promote-parent': 2,
  pending: 3,
};

interface RankedNode {
  task: NextTask;
  classRank: number;
  epicOrder: number; // +Infinity when absent → lowest precedence in that term
  goalRank: number;
  priority: number;
  artifactId: string;
}

const INF = Number.POSITIVE_INFINITY;

/** Resolve the `epic.order` dial for an artifact (its parent epic's order). */
function resolveEpicOrder(epicId: string | undefined, index: Index): number {
  if (!epicId) return INF;
  const epic = index.epicById.get(epicId);
  return epic?.order ?? INF;
}

function mkRanked(
  task: NextTask,
  cls: SeverityClass,
  dials: { epicOrder: number; goalRank?: number; priority?: number; artifactId: string },
): RankedNode {
  return {
    task,
    classRank: CLASS_RANK[cls],
    epicOrder: dials.epicOrder,
    goalRank: dials.goalRank ?? INF,
    priority: dials.priority ?? INF,
    artifactId: dials.artifactId,
  };
}

/**
 * Per-id set of un-cleared `depends_on` blockers (resolving targets only;
 * danglers are handled as corruption). Used both to floor a pending node below
 * its blocker and to detect advance-past gate-violations.
 */
function unclearedDependsOn(graph: ArtifactGraph, index: Index): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of graph.edges ?? []) {
    if (edge.kind !== 'depends_on') continue;
    if (!index.byId.has(edge.from) || !index.byId.has(edge.to)) continue; // dangler ⇒ corruption path
    if (gateCleared(edge.to, index)) continue;
    const list = map.get(edge.from) ?? [];
    list.push(edge.to);
    map.set(edge.from, list);
  }
  for (const list of map.values()) list.sort(compareIds);
  return map;
}

/** Is an artifact currently "advancing" (downstream work started)? */
function isAdvancing(node: AnyNode, index: Index): boolean {
  if (index.epicById.has(node.id)) {
    const e = node as EpicNode;
    return e.status === 'active' || e.status === 'done';
  }
  if ((node as SpecNode).approvalState !== undefined) {
    const s = node as SpecNode;
    return s.status === 'implementing' || s.status === 'done';
  }
  const a = node as AdrNode;
  return a.status === 'accepted';
}

function generateNodes(
  graph: ArtifactGraph,
  index: Index,
  superseded: Set<string>,
  corruptions: Corruption[],
): RankedNode[] {
  const ranked: RankedNode[] = [];

  // --- Class A: every Step-2 corruption becomes a top gate-violation node. ---
  for (const c of corruptions) {
    // The natural target/kind: prefer a resolving artifact ref so the node has a
    // real kind; fall back to the first ref.
    const targetId =
      c.refs.find((r) => index.byId.has(r) && !index.epicById.has(r)) ??
      c.refs.find((r) => index.byId.has(r)) ??
      c.refs[0] ??
      'unknown';
    const known = index.byId.get(targetId);
    const kind: NodeKind = known ? index.kindOf.get(targetId)! : 'spec-approve';
    ranked.push(
      mkRanked(
        {
          kind,
          targetId,
          imperative: `Resolve: ${c.message}`,
          severityClass: 'gate-violation',
          evidence: {
            severityClass: 'gate-violation',
            rule: c.rule,
            explanation: c.message,
            refs: c.refs,
          },
        },
        'gate-violation',
        {
          epicOrder: resolveEpicOrder(epicOfRef(targetId, index), index),
          goalRank: goalRankOf(targetId, index),
          priority: priorityOf(targetId, index),
          artifactId: targetId,
        },
      ),
    );
  }

  // --- depends_on advance-past gate-violations (FR-13). ---
  const uncleared = unclearedDependsOn(graph, index);
  for (const [fromId, blockers] of uncleared) {
    const node = index.byId.get(fromId)!;
    if (superseded.has(fromId)) continue;
    if (!isAdvancing(node, index)) continue; // merely-pending-with-blocker is floored later, not a violation
    const kind = index.kindOf.get(fromId)!;
    const blockerList = blockers.join(', ');
    ranked.push(
      mkRanked(
        {
          kind,
          targetId: fromId,
          imperative: `Resolve: ${fromId} advanced past un-cleared depends_on (${blockerList})`,
          severityClass: 'gate-violation',
          evidence: {
            severityClass: 'gate-violation',
            rule: 'depends_on.uncleared',
            explanation: `${fromId} is advancing while it depends_on un-cleared ${blockerList}`,
            refs: [fromId, ...blockers],
          },
        },
        'gate-violation',
        {
          epicOrder: resolveEpicOrder(epicOfRef(fromId, index), index),
          goalRank: goalRankOf(fromId, index),
          priority: priorityOf(fromId, index),
          artifactId: fromId,
        },
      ),
    );
  }

  // --- Gate nodes: spec-approve / adr-accept / epic-promote. ---
  // Track which proposed epics have ≥1 pending child (for promote-parent).
  const epicsWithPendingChild = new Set<string>();

  // Specs.
  for (const s of graph.specs) {
    if (superseded.has(s.id)) continue;
    if (isSpecTerminal(s)) continue;
    const pendingApproval = s.approvalState === 'unapproved' || s.approvalState === 'stale';
    if (!pendingApproval) continue;
    const epic = s.epic ? index.epicById.get(s.epic) : undefined;
    if (epic && epic.status === 'proposed') epicsWithPendingChild.add(epic.id);

    const dials = {
      epicOrder: resolveEpicOrder(s.epic, index),
      goalRank: s.goalRank,
      priority: s.priority,
      artifactId: s.id,
    };
    const cls: SeverityClass =
      epic && epic.status === 'active' ? 'blocked-ready' : 'pending';
    ranked.push(
      mkRanked(
        {
          kind: 'spec-approve',
          targetId: s.id,
          imperative: `Approve ${s.id}`,
          severityClass: cls,
          evidence: {
            severityClass: cls,
            rule: cls === 'blocked-ready' ? 'gate.spec-approve' : 'pending.spec-approve',
            explanation:
              cls === 'blocked-ready'
                ? `${s.id} is ${s.approvalState} under active ${epic!.id} — approve to unblock implement`
                : `${s.id} is ${s.approvalState}${epic ? ` under ${epic.status} ${epic.id}` : ''}`,
            refs: epic ? [epic.id, s.id] : [s.id],
          },
        },
        cls,
        dials,
      ),
    );
  }

  // ADRs.
  for (const a of graph.adrs) {
    if (superseded.has(a.id)) continue;
    if (a.status !== 'proposed') continue;
    const epic = a.epic ? index.epicById.get(a.epic) : undefined;
    if (epic && epic.status === 'proposed') epicsWithPendingChild.add(epic.id);

    const dials = {
      epicOrder: resolveEpicOrder(a.epic, index),
      goalRank: a.goalRank,
      priority: a.priority,
      artifactId: a.id,
    };
    const cls: SeverityClass =
      epic && epic.status === 'active' ? 'blocked-ready' : 'pending';
    ranked.push(
      mkRanked(
        {
          kind: 'adr-accept',
          targetId: a.id,
          imperative: `Accept ${a.id}`,
          severityClass: cls,
          evidence: {
            severityClass: cls,
            rule: cls === 'blocked-ready' ? 'gate.adr-accept' : 'pending.adr-accept',
            explanation:
              cls === 'blocked-ready'
                ? `${a.id} is proposed under active ${epic!.id} — accept/reject`
                : `${a.id} is proposed${epic ? ` under ${epic.status} ${epic.id}` : ''}`,
            refs: epic ? [epic.id, a.id] : [a.id],
          },
        },
        cls,
        dials,
      ),
    );
  }

  // Epic-promote: a proposed epic with ≥1 pending child.
  for (const e of graph.epics) {
    if (superseded.has(e.id)) continue;
    if (e.status !== 'proposed') continue;
    if (!epicsWithPendingChild.has(e.id)) continue;
    ranked.push(
      mkRanked(
        {
          kind: 'epic-promote',
          targetId: e.id,
          imperative: `Promote ${e.id}`,
          severityClass: 'promote-parent',
          evidence: {
            severityClass: 'promote-parent',
            rule: 'promote.proposed-with-children',
            explanation: `${e.id} is proposed with pending children — promote to active`,
            refs: [e.id],
          },
        },
        'promote-parent',
        {
          epicOrder: e.order ?? INF,
          goalRank: e.goalRank,
          priority: e.priority,
          artifactId: e.id,
        },
      ),
    );
  }

  return ranked;
}

// --- small dial-resolution helpers for corruption/advance nodes ---
function epicOfRef(id: string, index: Index): string | undefined {
  const node = index.byId.get(id);
  if (!node) return undefined;
  if (index.epicById.has(id)) return id; // an epic's own order
  return (node as SpecNode | AdrNode).epic;
}
function goalRankOf(id: string, index: Index): number | undefined {
  return index.byId.get(id)?.goalRank;
}
function priorityOf(id: string, index: Index): number | undefined {
  return index.byId.get(id)?.priority;
}

// =====================================================================
// Step 4 — total order (DR-019 §2 amended by DR-039 §3)
// =====================================================================

function compareRanked(a: RankedNode, b: RankedNode): number {
  if (a.classRank !== b.classRank) return a.classRank - b.classRank;
  if (a.epicOrder !== b.epicOrder) return a.epicOrder < b.epicOrder ? -1 : 1;
  if (a.goalRank !== b.goalRank) return a.goalRank < b.goalRank ? -1 : 1;
  if (a.priority !== b.priority) return a.priority < b.priority ? -1 : 1;
  return compareIds(a.artifactId, b.artifactId);
}

// =====================================================================
// Step 5 — relates_to clustering (FR-13, tie-influence only)
// =====================================================================

/**
 * Within a severity class only, after the Step-4 sort, stable-group `relates_to`
 * neighbours adjacent — WITHOUT crossing class boundaries or moving any element
 * ahead of a strictly-higher-ranked one. So it can never change resolveNextTask's
 * top element; it only adjusts mid-pipeline adjacency. Pure, deterministic.
 */
function clusterRelatesTo(sorted: RankedNode[], graph: ArtifactGraph): RankedNode[] {
  const relates = new Map<string, Set<string>>();
  for (const edge of graph.edges ?? []) {
    if (edge.kind !== 'relates_to') continue;
    if (!relates.has(edge.from)) relates.set(edge.from, new Set());
    if (!relates.has(edge.to)) relates.set(edge.to, new Set());
    relates.get(edge.from)!.add(edge.to);
    relates.get(edge.to)!.add(edge.from);
  }
  if (relates.size === 0) return sorted;

  const out: RankedNode[] = [];
  let i = 0;
  while (i < sorted.length) {
    // Block boundary = same classRank run.
    let j = i;
    while (j < sorted.length && sorted[j].classRank === sorted[i].classRank) j++;
    const block = sorted.slice(i, j);

    // Stable pass: emit in current order, but when an element is emitted, pull
    // its not-yet-emitted relates_to neighbours (in their existing relative
    // order) right after it. Never moves anything earlier than its own position,
    // so the block's first element (and the global top) is untouched.
    const emitted = new Set<number>();
    const clustered: RankedNode[] = [];
    for (let k = 0; k < block.length; k++) {
      if (emitted.has(k)) continue;
      emitted.add(k);
      clustered.push(block[k]);
      const kin = relates.get(block[k].artifactId);
      if (kin) {
        for (let m = k + 1; m < block.length; m++) {
          if (!emitted.has(m) && kin.has(block[m].artifactId)) {
            emitted.add(m);
            clustered.push(block[m]);
          }
        }
      }
    }
    out.push(...clustered);
    i = j;
  }
  return out;
}

// =====================================================================
// Step 4.5 — depends_on flooring (FR-13)
// =====================================================================

/**
 * Within a severity class only, stable-topologically order so an un-cleared
 * `depends_on` blocker ranks BEFORE its dependent. Without this a blocked node
 * can surface as the single next task — the never-wrong defect (FR-13: "it MUST
 * rank below an un-cleared target"). Cross-class deps are already separated by
 * classRank (or surfaced as an advance-past gate-violation), so flooring is
 * block-bounded. A dependency cycle (already corruption) makes no Kahn progress
 * and its members are appended in block order — never loops. Pure, deterministic.
 */
function floorDependsOn(
  sorted: RankedNode[],
  graph: ArtifactGraph,
  index: Index,
): RankedNode[] {
  const uncleared = unclearedDependsOn(graph, index);
  if (uncleared.size === 0) return sorted;

  const out: RankedNode[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].classRank === sorted[i].classRank) j++;
    out.push(...topoFloorBlock(sorted.slice(i, j), uncleared));
    i = j;
  }
  return out;
}

/**
 * Stable topological sort of one same-class block: a node is emitted only after
 * all its in-block un-cleared blockers. Block order is the tiebreak, so it never
 * reorders beyond what flooring requires (preserving the Step-4 total order
 * otherwise). A leftover cycle (impossible here — cycles are corruption — but
 * guarded) is appended in block order, so the pass can never infinite-loop.
 */
function topoFloorBlock(
  block: RankedNode[],
  uncleared: Map<string, string[]>,
): RankedNode[] {
  if (block.length < 2) return block;
  const inBlock = new Set(block.map((b) => b.artifactId));
  const blockers = new Map<string, string[]>();
  for (const node of block) {
    blockers.set(
      node.artifactId,
      (uncleared.get(node.artifactId) ?? []).filter((t) => inBlock.has(t)),
    );
  }

  const emitted = new Set<string>();
  const out: RankedNode[] = [];
  let progress = true;
  while (out.length < block.length && progress) {
    progress = false;
    for (const node of block) {
      if (emitted.has(node.artifactId)) continue;
      if (blockers.get(node.artifactId)!.every((b) => emitted.has(b))) {
        emitted.add(node.artifactId);
        out.push(node);
        progress = true;
      }
    }
  }
  // Safety: leftover cycle members (already flagged as corruption) in block order.
  if (out.length < block.length) {
    for (const node of block) {
      if (!emitted.has(node.artifactId)) out.push(node);
    }
  }
  return out;
}

// =====================================================================
// Public API
// =====================================================================

/**
 * The full ranked human-decision queue (FR-6). Sorted minimum-first; `[0]` is the
 * single next task. Empty array ⇒ a genuinely clean empty queue (edge-case #3),
 * NOT corruption (corruption surfaces as top gate-violation nodes here, and via
 * `resolveCorruption`).
 */
export function resolvePipeline(graph: ArtifactGraph): NextTask[] {
  const index = buildIndex(graph);
  const superseded = computeSuperseded(graph, index);
  const corruptions = resolveCorruption(graph);
  const ranked = generateNodes(graph, index, superseded, corruptions);

  const sorted = ranked.slice().sort(compareRanked);
  const floored = floorDependsOn(sorted, graph, index);
  const clustered = clusterRelatesTo(floored, graph);
  return clustered.map((r) => r.task);
}

/**
 * The single next HUMAN task (FR-5), or `null` for a clean empty queue
 * (edge-case #3 — distinct from corruption, which is surfaced as a top
 * gate-violation task and is therefore non-null). Pure, deterministic.
 */
export function resolveNextTask(graph: ArtifactGraph): NextTask | null {
  return resolvePipeline(graph)[0] ?? null;
}
