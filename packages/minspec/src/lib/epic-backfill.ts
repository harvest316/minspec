import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadConfig, resolveAndValidate } from './config';
import { listAdrs } from './adr-manager';
import { parseSpec } from './spec';
import { slugify } from './spec-manager';
import {
  listEpics,
  createEpic,
  writeEpicIndex,
  setArtifactEpic,
  readArtifactEpic,
} from './epic-manager';
import type { EpicSummary } from './epic-manager';

const execFileAsync = promisify(execFile);

/**
 * Epic backfill (DR-016). Two engines producing one proposal shape:
 *   - heuristic (Tier 0, pure file-system) — always available
 *   - AI (Tier 1, `claude -p`) — opt-in, degrades to heuristic when absent
 *
 * Nothing here writes frontmatter until `applyBackfill` is called with an
 * approved proposal (HITL — DR-012 ethos). No `http`/`fetch`; the only network
 * touch is the locally-installed `claude` binary owning its own connection.
 */

// ─── Contract ─────────────────────────────────────────────────────────────────

export type ArtifactKind = 'spec' | 'adr';

/** A single artifact gathered for proposal input. */
export interface ArtifactRef {
  readonly id: string;          // SPEC-NNN / DR-NNN
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly filePath: string;
  /** Existing epic ref, if already assigned. */
  readonly epic?: string;
  /** Parent directory basename (spec feature folder) — a heuristic signal. */
  readonly group?: string;
  /** First non-empty prose paragraph (for the AI digest). */
  readonly digest?: string;
}

export interface ProposedEpic {
  /** Present when mapping onto an already-registered epic; absent = new. */
  readonly id?: string;
  readonly slug: string;
  readonly title: string;
  readonly rationale: string;
}

export interface ProposedMapping {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly filePath: string;
  readonly epicSlug: string;
  /** 0..1 — heuristic similarity, or AI-reported confidence. */
  readonly confidence: number;
  readonly rationale: string;
}

export interface BackfillProposal {
  readonly epics: ProposedEpic[];
  readonly mappings: ProposedMapping[];
  readonly source: 'heuristic' | 'ai';
}

export interface ApplyResult {
  readonly epicsCreated: number;
  readonly artifactsTagged: number;
  readonly skipped: number;
}

// ─── Tier-1 availability ──────────────────────────────────────────────────────

/** True when the local `claude` binary is callable (mirrors isGhAvailable). */
export async function isClaudeAvailable(): Promise<boolean> {
  try {
    await execFileAsync('claude', ['--version'], { timeout: 5000, env: { ...process.env } });
    return true;
  } catch {
    return false;
  }
}

// ─── Artifact collection (vscode-free) ────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'for', 'to', 'of', 'and', 'or', 'use', 'with', 'in', 'on', 'minspec', 'spec', 'epic']);

function titleTokens(title: string): Set<string> {
  return new Set(slugify(title).split('-').filter(t => t.length > 0 && !STOP.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** First non-empty paragraph after frontmatter + H1, capped. */
function firstParagraph(body: string, cap = 280): string {
  const afterFm = body.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const lines = afterFm.split('\n');
  const para: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#') || t.startsWith('<!--') || t === '') {
      if (para.length > 0) break;
      continue;
    }
    para.push(t);
    if (para.join(' ').length >= cap) break;
  }
  return para.join(' ').slice(0, cap);
}

/** Recursively collect SPEC-*.md artifacts under specsDir (any nesting). */
function collectSpecs(rootDir: string): ArtifactRef[] {
  const config = loadConfig(rootDir);
  let specsDir: string;
  try {
    specsDir = resolveAndValidate(rootDir, config.specsDir);
  } catch {
    return [];
  }
  if (!fs.existsSync(specsDir)) return [];

  const out: ArtifactRef[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        let content: string;
        try {
          content = fs.readFileSync(full, 'utf-8');
        } catch {
          continue;
        }
        let fm;
        try {
          fm = parseSpec(content).frontmatter;
        } catch {
          continue;
        }
        if (!fm.id || !/^SPEC-/.test(fm.id)) continue;
        // Folder name is an epic signal ONLY when it's a feature folder — not the
        // product container itself (e.g. specs/minspec/ holds the core specs but
        // "minspec" is the product, not an epic). Skip when folder == product.
        const folder = path.basename(path.dirname(full));
        const product = (content.match(/^---\n[\s\S]*?\n---/)?.[0].match(/^product\s*:\s*(.+)$/m)?.[1] ?? '').trim();
        const group = product && slugify(folder) === slugify(product) ? undefined : folder;
        out.push({
          id: fm.id,
          kind: 'spec',
          title: fm.title || fm.id,
          filePath: full,
          epic: fm.epic,
          group,
          digest: firstParagraph(content),
        });
      }
    }
  };
  walk(specsDir);
  return out;
}

function collectAdrs(rootDir: string): ArtifactRef[] {
  return listAdrs(rootDir).map(a => {
    let digest = '';
    try {
      digest = firstParagraph(fs.readFileSync(a.filePath, 'utf-8'));
    } catch {
      // best-effort
    }
    return {
      id: a.id,
      kind: 'adr' as const,
      title: a.title,
      filePath: a.filePath,
      epic: a.epic,
      digest,
    };
  });
}

/** All specs + ADRs in the project, for proposal input. */
export function collectArtifacts(rootDir: string): ArtifactRef[] {
  return [...collectSpecs(rootDir), ...collectAdrs(rootDir)];
}

// ─── Heuristic engine (Tier 0) ────────────────────────────────────────────────

const SUBDIR_CONFIDENCE = 0.9;
// Matches ADR_SIMILARITY_THRESHOLD (adr-manager) — the gate only proposes; a
// weak match costs one unchecked review row, a missed match costs a manual tag.
const TOKEN_THRESHOLD = 0.3;

function titleCase(slug: string): string {
  return slug.split(/[-_]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Cluster artifacts into candidate epics from repo signals (pure, Tier 0):
 *  1. existing registered epics are kept as anchors,
 *  2. spec feature-subdir names seed strong candidate epics,
 *  3. remaining artifacts attach to the best candidate by title-token overlap
 *     (Jaccard ≥ threshold); below threshold → left unmapped (no forced guess).
 */
export function proposeHeuristic(rootDir: string): BackfillProposal {
  const artifacts = collectArtifacts(rootDir);
  const registered = listEpics(rootDir);

  // Candidate epics keyed by slug. Seed from the registry.
  const epicsBySlug = new Map<string, ProposedEpic>();
  const tokensBySlug = new Map<string, Set<string>>();
  for (const e of registered) {
    epicsBySlug.set(e.slug, { id: e.id, slug: e.slug, title: e.title, rationale: 'Existing registered epic.' });
    tokensBySlug.set(e.slug, titleTokens(e.title));
  }

  // Seed candidates from spec feature-subdir names.
  for (const a of artifacts) {
    if (a.kind !== 'spec' || !a.group) continue;
    const slug = slugify(a.group);
    if (!slug || epicsBySlug.has(slug)) continue;
    epicsBySlug.set(slug, { slug, title: titleCase(a.group), rationale: `Spec feature folder "${a.group}".` });
    tokensBySlug.set(slug, titleTokens(titleCase(a.group)));
  }

  const mappings: ProposedMapping[] = [];
  for (const a of artifacts) {
    // Subdir-based: a spec in a feature folder maps to that folder's epic.
    if (a.kind === 'spec' && a.group) {
      const slug = slugify(a.group);
      if (epicsBySlug.has(slug)) {
        mappings.push({
          artifactId: a.id, kind: a.kind, filePath: a.filePath, epicSlug: slug,
          confidence: SUBDIR_CONFIDENCE, rationale: `In feature folder "${a.group}".`,
        });
        continue;
      }
    }
    // Token-overlap: best candidate epic by title similarity.
    const aTokens = titleTokens(a.title);
    let best: { slug: string; score: number } | null = null;
    for (const [slug, eTokens] of tokensBySlug) {
      const score = jaccard(aTokens, eTokens);
      if (!best || score > best.score) best = { slug, score };
    }
    if (best && best.score >= TOKEN_THRESHOLD) {
      mappings.push({
        artifactId: a.id, kind: a.kind, filePath: a.filePath, epicSlug: best.slug,
        confidence: Number(best.score.toFixed(2)),
        rationale: `Title overlaps epic "${epicsBySlug.get(best.slug)!.title}".`,
      });
    }
    // else: unmapped — heuristic declines to guess.
  }

  // Drop candidate epics that ended up with no mapping (keep registered anchors).
  const used = new Set(mappings.map(m => m.epicSlug));
  const epics = [...epicsBySlug.values()].filter(e => used.has(e.slug) || e.id);
  return { epics, mappings, source: 'heuristic' };
}

// ─── AI engine (Tier 1) ───────────────────────────────────────────────────────

function buildPrompt(artifacts: ArtifactRef[], registered: EpicSummary[]): string {
  const digest = artifacts.map(a =>
    `- ${a.id} [${a.kind}] "${a.title}"${a.epic ? ` (epic: ${a.epic})` : ''}${a.digest ? ` — ${a.digest}` : ''}`,
  ).join('\n');
  const existing = registered.length
    ? registered.map(e => `- ${e.id} slug=${e.slug} "${e.title}"`).join('\n')
    : '(none)';
  return [
    'You are organizing a software project\'s specs and architecture decisions (ADRs) into "epics" — coherent bodies of work.',
    '',
    'EXISTING EPICS (reuse these slugs where an artifact fits):',
    existing,
    '',
    'ARTIFACTS:',
    digest,
    '',
    'Propose a concise epic taxonomy (prefer 3–8 epics; reuse existing where apt) and map each artifact to exactly one epic where confident. Leave an artifact unmapped rather than force a poor fit.',
    '',
    'Output ONLY a JSON object, no prose, no markdown fences, matching exactly:',
    '{"epics":[{"slug":"kebab-case","title":"Title Case","rationale":"why"}],"mappings":[{"artifactId":"SPEC-001","epicSlug":"kebab-case","confidence":0.0,"rationale":"why"}]}',
  ].join('\n');
}

/** Extract the first balanced top-level JSON object from arbitrary stdout. */
function extractJson(stdout: string): string | null {
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < stdout.length; i++) {
    const c = stdout[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return stdout.slice(start, i + 1); }
  }
  return null;
}

/**
 * Validate + normalize a parsed AI object into a BackfillProposal. Drops
 * mappings whose artifactId is unknown or epicSlug has no epic. Returns null on
 * structural failure so the caller falls back to the heuristic.
 */
export function normalizeAiProposal(parsed: unknown, artifacts: ArtifactRef[]): BackfillProposal | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.epics) || !Array.isArray(obj.mappings)) return null;

  const byId = new Map(artifacts.map(a => [a.id, a]));
  const epics: ProposedEpic[] = [];
  const slugs = new Set<string>();
  for (const e of obj.epics) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const slug = typeof r.slug === 'string' ? slugify(r.slug) : '';
    const title = typeof r.title === 'string' ? r.title : titleCase(slug);
    if (!slug || slugs.has(slug)) continue;
    slugs.add(slug);
    epics.push({ slug, title, rationale: typeof r.rationale === 'string' ? r.rationale : '' });
  }

  const mappings: ProposedMapping[] = [];
  for (const m of obj.mappings) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    const artifactId = typeof r.artifactId === 'string' ? r.artifactId : '';
    const epicSlug = typeof r.epicSlug === 'string' ? slugify(r.epicSlug) : '';
    const art = byId.get(artifactId);
    if (!art || !slugs.has(epicSlug)) continue; // unknown artifact or epic → drop
    const confRaw = typeof r.confidence === 'number' ? r.confidence : 0.5;
    mappings.push({
      artifactId, kind: art.kind, filePath: art.filePath, epicSlug,
      confidence: Math.max(0, Math.min(1, confRaw)),
      rationale: typeof r.rationale === 'string' ? r.rationale : '',
    });
  }

  if (epics.length === 0) return null;
  // Drop epics no mapping references.
  const used = new Set(mappings.map(m => m.epicSlug));
  return { epics: epics.filter(e => used.has(e.slug)), mappings, source: 'ai' };
}

/**
 * Run the Tier-1 AI proposal via `claude -p`. Returns null on ANY failure
 * (binary absent, timeout, non-JSON, empty) — caller falls back to heuristic.
 * Never throws.
 */
export async function proposeAI(rootDir: string): Promise<BackfillProposal | null> {
  const artifacts = collectArtifacts(rootDir);
  if (artifacts.length === 0) return null;
  const prompt = buildPrompt(artifacts, listEpics(rootDir));
  try {
    const { stdout } = await execFileAsync('claude', ['-p', prompt], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env },
    });
    const json = extractJson(stdout);
    if (!json) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return null;
    }
    return normalizeAiProposal(parsed, artifacts);
  } catch {
    return null;
  }
}

// ─── Apply (HITL — only after approval) ───────────────────────────────────────

/**
 * Apply an approved proposal: create new epics, tag mapped artifacts, regenerate
 * the INDEX. Idempotent. An artifact already carrying an `epic:` is skipped
 * unless `override`. Pure file-system.
 */
export function applyBackfill(
  rootDir: string,
  proposal: BackfillProposal,
  opts: { override?: boolean } = {},
): ApplyResult {
  // Map proposed epic slugs → concrete ref (existing id, or freshly created),
  // plus slug → title so each tagged artifact gets a human-facing comment.
  const refBySlug = new Map<string, string>();
  const titleBySlug = new Map<string, string>();
  let epicsCreated = 0;
  const registered = new Map(listEpics(rootDir).map(e => [e.slug, e]));

  for (const e of proposal.epics) {
    const existing = e.id ? e.id : registered.get(e.slug)?.id;
    // Prefer the registry's canonical title for existing epics; else the proposal's.
    titleBySlug.set(e.slug, registered.get(e.slug)?.title ?? e.title);
    if (existing) {
      refBySlug.set(e.slug, existing);
    } else {
      // Thread the proposal's rationale into the new epic's `## Goal` so a
      // backfilled epic is born complete, not as a bare skeleton (#79).
      const created = createEpic(rootDir, e.title, e.slug, undefined, e.rationale);
      refBySlug.set(e.slug, created.id);
      epicsCreated++;
    }
  }

  let artifactsTagged = 0;
  let skipped = 0;
  for (const m of proposal.mappings) {
    const ref = refBySlug.get(m.epicSlug);
    if (!ref) { skipped++; continue; }
    if (!opts.override && readArtifactEpic(m.filePath)) { skipped++; continue; }
    try {
      setArtifactEpic(m.filePath, ref, titleBySlug.get(m.epicSlug));
      artifactsTagged++;
    } catch {
      skipped++;
    }
  }

  writeEpicIndex(rootDir);
  return { epicsCreated, artifactsTagged, skipped };
}

// ─── Review rendering ─────────────────────────────────────────────────────────

/** Human-readable markdown for the HITL review surface. */
export function renderProposalMarkdown(proposal: BackfillProposal): string {
  const lines: string[] = [
    `# Epic Backfill Proposal (${proposal.source})`,
    '',
    `Proposes **${proposal.epics.length} epic(s)** and **${proposal.mappings.length} mapping(s)**.`,
    'Review below. Nothing is written until you approve.',
    '',
    '## Epics',
    '',
  ];
  for (const e of proposal.epics) {
    lines.push(`- **${e.title}** \`${e.slug}\`${e.id ? ` (existing ${e.id})` : ' (new)'} — ${e.rationale}`);
  }
  lines.push('', '## Mappings', '');
  const bySlug = new Map<string, ProposedMapping[]>();
  for (const m of proposal.mappings) {
    (bySlug.get(m.epicSlug) ?? bySlug.set(m.epicSlug, []).get(m.epicSlug)!).push(m);
  }
  for (const [slug, ms] of bySlug) {
    lines.push(`### ${slug}`, '');
    for (const m of ms) {
      lines.push(`- ${m.artifactId} \`${path.basename(m.filePath)}\` (${(m.confidence * 100).toFixed(0)}%) — ${m.rationale}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
