/**
 * Artifact-Graph fs adapter — SPEC-012 signpost wiring (the fs/vscode-free Node
 * layer that feeds the Tier-0 resolver in `@aiclarity/shared`).
 *
 * Reads the REAL workspace (epics, specs, ADRs, approval sidecars, the
 * constitution Goals list, and cross-cutting frontmatter edges) and maps it onto
 * the resolver's `ArtifactGraph` shape. It is a PURE MAPPING LAYER:
 *
 *   - It CONSUMES the resolver (`resolveNextTask` etc. live in @aiclarity/shared);
 *     no severity / coherence / cycle logic is reimplemented here (INV-CONSUME).
 *   - It NEVER imports `vscode` (Tier-1 fs layer, not a UI surface).
 *   - It DERIVES every spec's status via the project's OWN `deriveStatus`
 *     (DR-034) — NEVER the literal `status:` frontmatter line, which is a mirror
 *     cache that can drift (SPEC-022). Feeding the literal would re-introduce the
 *     #112/#148 stale-status class of bug the approval foundation closed.
 *     (INV-FIDELITY.)
 *   - Missing dirs / empty workspace ⇒ an empty (but well-formed) graph, never a
 *     throw (INV-DEGRADE); the command layer degrades on top of that.
 *
 * Edges (FR-13: `depends_on` / `supersedes` / `relates_to`) are passed through
 * FAITHFULLY, including danglers — the resolver detects danglers as corruption;
 * the adapter must not pre-filter (it would hide a real "state unclear").
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  ArtifactGraph,
  EpicNode,
  SpecNode,
  AdrNode,
  Edge,
  EdgeKind,
  EpicStatus as ResolverEpicStatus,
  SpecStatus as ResolverSpecStatus,
  AdrStatus as ResolverAdrStatus,
  ApprovalState as ResolverApprovalState,
} from '@aiclarity/shared';

import { loadConfig, resolveAndValidate } from './config';
import { listEpics, epicRefValue, resolveEpic, type EpicStatus } from './epic-manager';
import { listAdrs, type AdrStatus } from './adr-manager';
import { parseSpec, type ParsedSpec, type SpecStatus } from './spec';
import { getCurrentPhase } from './lifecycle';
import { deriveStatus, type ExplicitTerminal } from './lifecycle';
import { getApprovalStatus, type ApprovalStatus } from './approval';

// ───────────────────────────────────────────────────────────────────────────
// Status-enum mapping tables — STRICT 1:1 (INV-FIDELITY).
//
// All three enums are already identical in name + meaning between this package
// and the resolver's Tier-0 redeclarations. The maps are the identity, but they
// are declared explicitly with `satisfies Record<RealEnum, ResolverEnum>` so a
// FUTURE enum drift fails to compile (a test, not a silent mis-coercion).
// ───────────────────────────────────────────────────────────────────────────

const EPIC_STATUS_MAP = {
  proposed: 'proposed',
  active: 'active',
  done: 'done',
  abandoned: 'abandoned',
} satisfies Record<EpicStatus, ResolverEpicStatus>;

const SPEC_STATUS_MAP = {
  new: 'new',
  specifying: 'specifying',
  implementing: 'implementing',
  done: 'done',
  archived: 'archived',
} satisfies Record<SpecStatus, ResolverSpecStatus>;

const ADR_STATUS_MAP = {
  proposed: 'proposed',
  accepted: 'accepted',
  deprecated: 'deprecated',
  superseded: 'superseded',
} satisfies Record<AdrStatus, ResolverAdrStatus>;

const APPROVAL_STATE_MAP = {
  approved: 'approved',
  stale: 'stale',
  unapproved: 'unapproved',
} satisfies Record<ApprovalStatus, ResolverApprovalState>;

// ───────────────────────────────────────────────────────────────────────────
// Frontmatter readers — array edges + goal ref.
//
// The lightweight YAML parsers in spec.ts / epic-manager.ts do NOT parse arrays,
// and `SpecFrontmatter` carries no `goal` field, so both are read here with
// dedicated regexes against the RAW frontmatter block (mirroring `readArtifactEpic`).
// ───────────────────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const EDGE_KINDS: readonly EdgeKind[] = ['depends_on', 'supersedes', 'relates_to'];

/** Extract the leading `---`…`---` frontmatter block from raw file content, or ''. */
function frontmatterBlock(content: string): string {
  const m = content.replace(/\r\n?/g, '\n').match(FRONTMATTER_RE);
  return m ? m[1] : '';
}

/**
 * Parse a `kind: [A, B, C]` inline-array frontmatter line into `Edge[]` from
 * `fromId`. The value may carry a trailing inline `# comment` after the `]`,
 * which is dropped (the regex stops at the first `]`). Empty/absent ⇒ no edges.
 */
function parseEdgeArray(fmBlock: string, kind: EdgeKind, fromId: string): Edge[] {
  const re = new RegExp(`^${kind}:\\s*\\[([^\\]]*)\\]`, 'm');
  const m = fmBlock.match(re);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((to) => ({ kind, from: fromId, to }));
}

/** All cross-cutting edges declared in one artifact's frontmatter block. */
function edgesFrom(fmBlock: string, fromId: string): Edge[] {
  const out: Edge[] = [];
  for (const kind of EDGE_KINDS) out.push(...parseEdgeArray(fmBlock, kind, fromId));
  return out;
}

/** The raw `goal:` ref (e.g. `G-2`) from a frontmatter block, inline-comment-stripped, or null. */
function goalRefOf(fmBlock: string): string | null {
  const m = fmBlock.match(/^goal:\s*([^\s#]+)/m);
  return m ? m[1].trim() : null;
}

// ───────────────────────────────────────────────────────────────────────────
// Constitution Goals → goal-rank map (DR-039).
//
// `## Goals` is a numbered list whose ORDER is importance. Each item names a
// stable id `G-N`; the rank is the LIST position (1-based) — read from the leading
// `N.` rather than re-deriving from the id, so a mis-numbered id can't lie. A
// `goal: G-N` ref on an artifact resolves to that rank; absent/unknown ⇒ undefined
// (the resolver substitutes +Infinity — lowest precedence in that tie-break term).
// ───────────────────────────────────────────────────────────────────────────

const CONSTITUTION_REL = '.minspec/constitution.md';
const GOAL_ID_IN_GOALS_RE = /^\s*(\d+)\.\s+\*\*\s*(G-\d+)\b/;

/** Build `G-N → rank` from the constitution's `## Goals` section. Missing file ⇒ empty map. */
function buildGoalRankMap(rootDir: string): Map<string, number> {
  const map = new Map<string, number>();
  const file = path.join(rootDir, ...CONSTITUTION_REL.split('/'));
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return map; // no constitution ⇒ no goal ranks (degrade, never throw)
  }
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let inGoals = false;
  for (const line of lines) {
    if (/^##\s+Goals\s*$/i.test(line)) {
      inGoals = true;
      continue;
    }
    if (inGoals && /^##\s+/.test(line)) break; // next H2 ends the Goals section
    if (!inGoals) continue;
    const m = line.match(GOAL_ID_IN_GOALS_RE);
    if (m) {
      const rank = Number(m[1]);
      const id = m[2];
      if (Number.isFinite(rank) && !map.has(id)) map.set(id, rank);
    }
  }
  return map;
}

/** Resolve a frontmatter `goal:` ref to its rank, or undefined when absent/unknown. */
function goalRankOf(fmBlock: string, goalRanks: Map<string, number>): number | undefined {
  const ref = goalRefOf(fmBlock);
  if (!ref) return undefined;
  return goalRanks.get(ref);
}

// ───────────────────────────────────────────────────────────────────────────
// Spec discovery — recursive walk + split-layout dedupe.
//
// `listSpecs` reads only top-level `specs/` entries, so the real repo's nested
// `specs/<product>/<feature>/requirements.md` (two levels deep) is invisible to
// it (the §1f gap). We do our own recursive walk and dedupe split-layout siblings
// (`requirements.md` / `design.md` / `tasks.md` sharing one id) by id, taking the
// `specify`-phase file that OWNS approval as the canonical node:
//   requirements.md  ▸  spec.md  ▸  (first seen)
// ───────────────────────────────────────────────────────────────────────────

interface DiscoveredSpecFile {
  readonly filePath: string;
  readonly parsed: ParsedSpec;
  readonly fileName: string;
}

/** Canonical-file precedence within a split-layout id group (lower = preferred). */
function specFileRank(fileName: string): number {
  const lower = fileName.toLowerCase();
  if (lower === 'requirements.md') return 0;
  if (lower === 'spec.md') return 1;
  if (lower === 'design.md') return 2;
  if (lower === 'tasks.md') return 3;
  return 4;
}

/**
 * Walk the specs dir recursively, parse every `.md` carrying a frontmatter `id`,
 * and return one canonical `ParsedSpec` per spec id (split-layout deduped). The
 * returned map is id → discovered file (carrying the path the human should open).
 */
function discoverSpecs(rootDir: string): Map<string, DiscoveredSpecFile> {
  const byId = new Map<string, DiscoveredSpecFile>();
  let specsDir: string;
  try {
    const config = loadConfig(rootDir);
    specsDir = resolveAndValidate(rootDir, config.specsDir);
  } catch {
    return byId;
  }
  if (!fs.existsSync(specsDir)) return byId;

  const stack = [specsDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      let parsed: ParsedSpec;
      try {
        parsed = parseSpec(fs.readFileSync(full, 'utf-8'));
      } catch {
        continue; // unparseable — skip
      }
      const id = parsed.frontmatter.id;
      if (!id) continue;
      const candidate: DiscoveredSpecFile = { filePath: full, parsed, fileName: entry.name };
      const existing = byId.get(id);
      if (!existing || specFileRank(entry.name) < specFileRank(existing.fileName)) {
        byId.set(id, candidate);
      }
    }
  }
  return byId;
}

// ───────────────────────────────────────────────────────────────────────────
// Public adapter API.
// ───────────────────────────────────────────────────────────────────────────

/**
 * An index from artifact id → the file path a human should open to act on it.
 * Built alongside the graph so the command/status-bar layer can reveal a target
 * without re-walking the tree. Corruption nodes may point at a dangling id with
 * no entry here — the caller skips the open in that case (never throws).
 */
export function artifactFileIndex(rootDir: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const e of listEpics(rootDir)) index.set(e.id, e.filePath);
  for (const a of listAdrs(rootDir)) index.set(a.id, a.filePath);
  for (const [id, disc] of discoverSpecs(rootDir)) index.set(id, disc.filePath);
  return index;
}

/**
 * Build the resolver's `ArtifactGraph` from the real workspace at `rootDir`.
 * Pure mapping over the existing readers + the project's own `deriveStatus`.
 * Missing dirs ⇒ empty arrays (INV-DEGRADE). Never throws on a well-formed call;
 * the caller still wraps it in try/catch for defense-in-depth.
 */
export function buildArtifactGraph(rootDir: string): ArtifactGraph {
  const goalRanks = buildGoalRankMap(rootDir);
  const edges: Edge[] = [];

  // Load epics ONCE; reuse for EpicNode[] and for canonicalising membership refs.
  const epicSummaries = listEpics(rootDir);

  // MinSpec allows `epic:` refs in EITHER id form (`EPIC-004`) or kebab-slug form
  // (`telemetry`) — `resolveEpic` accepts both, case-insensitively. The Tier-0
  // resolver indexes epics by `id` ONLY, so a slug ref would look like a dangling
  // ref and the signpost would confidently report "state unclear" for a valid
  // spec. Canonicalise to the resolved epic's id here; keep the raw stripped ref
  // when genuinely unresolvable so real danglers still surface as corruption.
  const canonicalEpic = (ref: string | undefined): string | undefined => {
    if (ref === undefined) return undefined;
    return resolveEpic(ref, epicSummaries)?.id ?? epicRefValue(ref);
  };

  // ── Epics ──────────────────────────────────────────────────────────────
  const epics: EpicNode[] = [];
  for (const e of epicSummaries) {
    let fmBlock = '';
    try {
      fmBlock = frontmatterBlock(fs.readFileSync(e.filePath, 'utf-8'));
    } catch {
      /* unreadable — no edges/goal for this epic */
    }
    edges.push(...edgesFrom(fmBlock, e.id));
    epics.push({
      id: e.id,
      status: EPIC_STATUS_MAP[e.status],
      order: e.order,
      goalRank: goalRankOf(fmBlock, goalRanks),
      priority: undefined,
    });
  }

  // ── Specs ──────────────────────────────────────────────────────────────
  const specs: SpecNode[] = [];
  for (const [id, disc] of discoverSpecs(rootDir)) {
    const fm = disc.parsed.frontmatter;
    const fmBlock = frontmatterBlock(disc.parsed.raw);

    // CRITICAL (INV-FIDELITY): derive, never read the literal `status:` line.
    const approvalState: ApprovalStatus = getApprovalStatus(rootDir, disc.filePath);
    const explicitTerminal: ExplicitTerminal = fm.status === 'archived' ? 'archived' : undefined;
    const derived: SpecStatus = deriveStatus(fm.phases, approvalState, explicitTerminal);

    edges.push(...edgesFrom(fmBlock, id));
    specs.push({
      id,
      status: SPEC_STATUS_MAP[derived],
      tier: fm.tier,
      phase: getCurrentPhase(fm.phases) ?? undefined,
      epic: canonicalEpic(fm.epic),
      approvalState: APPROVAL_STATE_MAP[approvalState],
      goalRank: goalRankOf(fmBlock, goalRanks),
      priority: undefined,
    });
  }

  // ── ADRs ───────────────────────────────────────────────────────────────
  const adrs: AdrNode[] = [];
  for (const a of listAdrs(rootDir)) {
    let fmBlock = '';
    try {
      fmBlock = frontmatterBlock(fs.readFileSync(a.filePath, 'utf-8'));
    } catch {
      /* unreadable — no edges/goal for this ADR */
    }
    edges.push(...edgesFrom(fmBlock, a.id));
    adrs.push({
      id: a.id,
      status: ADR_STATUS_MAP[a.status],
      epic: canonicalEpic(a.epic), // canonicalise id|slug → EPIC-NNN (see canonicalEpic)
      goalRank: goalRankOf(fmBlock, goalRanks),
      priority: undefined,
    });
  }

  // Omit `edges` entirely when none found (the resolver handles absent).
  const graph: ArtifactGraph = { epics, specs, adrs };
  if (edges.length > 0) (graph as { edges?: Edge[] }).edges = edges;
  return graph;
}
