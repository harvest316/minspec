/**
 * T1 — Contract Tests: Epic Backfill (SPEC-011 / DR-016)
 *
 * Covers the pure, vscode-free surface: heuristic proposal, AI-output
 * normalization, apply (frontmatter writes), and setArtifactEpic. The Tier-1
 * `claude -p` call itself (proposeAI / isClaudeAvailable) shells a binary and is
 * exercised only for its graceful-degradation contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  proposeHeuristic,
  normalizeAiProposal,
  applyBackfill,
  collectArtifacts,
  renderProposalMarkdown,
  type ArtifactRef,
} from '../src/lib/epic-backfill';
import { setArtifactEpic, readArtifactEpic, listEpics } from '../src/lib/epic-manager';

function writeConfig(root: string): void {
  const dir = path.join(root, '.minspec');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: '1' }));
}

function writeSpec(root: string, relDir: string, id: string, title: string, body = 'Some prose about the feature.', epic?: string): string {
  const dir = path.join(root, 'specs', relDir);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.md`);
  fs.writeFileSync(fp, [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    'tier: T2',
    'status: new',
    'created: 2026-05-31',
    ...(epic ? [`epic: ${epic}`] : []),
    'phases:',
    '  specify: done',
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n'));
  return fp;
}

function writeAdr(root: string, id: string, title: string): string {
  const dir = path.join(root, 'docs', 'decisions');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}-x.md`);
  fs.writeFileSync(fp, `---\nid: ${id}\ntitle: ${title}\nstatus: accepted\ndate: 2026-05-31\n---\n\n## Context\n\nWhy we did it.\n`);
  return fp;
}

describe('epic-backfill', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-backfill-'));
    writeConfig(tmp);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // ─── collection ──────────────────────────────────────────────────────

  describe('collectArtifacts()', () => {
    it('finds nested specs (any depth) + ADRs with group + digest', () => {
      writeSpec(tmp, 'minspec/auth-flow', 'SPEC-001', 'Auth Flow', 'Implements login and session.');
      writeAdr(tmp, 'DR-001', 'Token storage');
      const arts = collectArtifacts(tmp);
      expect(arts.map(a => a.id).sort()).toEqual(['DR-001', 'SPEC-001']);
      const spec = arts.find(a => a.id === 'SPEC-001')!;
      expect(spec.group).toBe('auth-flow');
      expect(spec.digest).toContain('login');
    });
  });

  // ─── heuristic ───────────────────────────────────────────────────────

  describe('proposeHeuristic()', () => {
    it('seeds an epic per spec feature folder and maps its specs (high confidence)', () => {
      writeSpec(tmp, 'minspec/payment-flow', 'SPEC-001', 'Payment Flow Spec');
      writeSpec(tmp, 'minspec/payment-flow', 'SPEC-002', 'Payment Tasks');
      const p = proposeHeuristic(tmp);
      const epic = p.epics.find(e => e.slug === 'payment-flow');
      expect(epic).toBeDefined();
      const ids = p.mappings.filter(m => m.epicSlug === 'payment-flow').map(m => m.artifactId).sort();
      expect(ids).toEqual(['SPEC-001', 'SPEC-002']);
      expect(p.mappings.every(m => m.confidence >= 0.9)).toBe(true);
      expect(p.source).toBe('heuristic');
    });

    it('attaches an ADR to an epic by title-token overlap', () => {
      writeSpec(tmp, 'minspec/telemetry', 'SPEC-001', 'Telemetry Pipeline');
      writeAdr(tmp, 'DR-001', 'Telemetry retention policy');
      const p = proposeHeuristic(tmp);
      const m = p.mappings.find(x => x.artifactId === 'DR-001');
      expect(m?.epicSlug).toBe('telemetry');
    });

    it('does NOT seed an epic from the product-root folder (folder == product)', () => {
      // specs/<product>/file.md where folder name == frontmatter product:
      // is the product container, not a feature epic.
      writeSpec(tmp, 'minspec', 'SPEC-001', 'Core Requirements'); // folder 'minspec'
      // writeSpec defaults product? No — add product via raw file:
      const fp = path.join(tmp, 'specs', 'minspec', 'SPEC-001.md');
      fs.writeFileSync(fp, [
        '---', 'id: SPEC-001', 'title: Core Requirements', 'tier: T2', 'status: new',
        'created: 2026-05-31', 'product: minspec', 'phases:', '  specify: done', '---', '', '# Core', '', 'body',
      ].join('\n'));
      const p = proposeHeuristic(tmp);
      expect(p.epics.some(e => e.slug === 'minspec')).toBe(false);
    });

    it('declines to map an artifact with no signal (no forced guess)', () => {
      writeSpec(tmp, 'minspec/alpha', 'SPEC-001', 'Alpha One');
      writeAdr(tmp, 'DR-009', 'Completely unrelated zebra giraffe');
      const p = proposeHeuristic(tmp);
      expect(p.mappings.some(m => m.artifactId === 'DR-009')).toBe(false);
    });
  });

  // ─── AI normalization ────────────────────────────────────────────────

  describe('normalizeAiProposal()', () => {
    const arts: ArtifactRef[] = [
      { id: 'SPEC-001', kind: 'spec', title: 'A', filePath: '/a' },
      { id: 'DR-001', kind: 'adr', title: 'B', filePath: '/b' },
    ];

    it('keeps valid epics/mappings, clamps confidence, drops unused epics', () => {
      const res = normalizeAiProposal({
        epics: [{ slug: 'core', title: 'Core', rationale: 'r' }, { slug: 'unused', title: 'U', rationale: '' }],
        mappings: [{ artifactId: 'SPEC-001', epicSlug: 'core', confidence: 1.5, rationale: 'x' }],
      }, arts);
      expect(res).not.toBeNull();
      expect(res!.epics.map(e => e.slug)).toEqual(['core']); // unused dropped
      expect(res!.mappings[0].confidence).toBe(1); // clamped
      expect(res!.source).toBe('ai');
    });

    it('drops mappings to unknown artifacts or unknown epics', () => {
      const res = normalizeAiProposal({
        epics: [{ slug: 'core', title: 'Core', rationale: '' }],
        mappings: [
          { artifactId: 'SPEC-999', epicSlug: 'core', confidence: 0.9, rationale: '' }, // unknown artifact
          { artifactId: 'DR-001', epicSlug: 'ghost', confidence: 0.9, rationale: '' },   // unknown epic
          { artifactId: 'DR-001', epicSlug: 'core', confidence: 0.8, rationale: 'ok' },
        ],
      }, arts);
      expect(res!.mappings.map(m => m.artifactId)).toEqual(['DR-001']);
    });

    it('returns null on structural garbage', () => {
      expect(normalizeAiProposal(null, arts)).toBeNull();
      expect(normalizeAiProposal({ epics: 'no' }, arts)).toBeNull();
      expect(normalizeAiProposal({ epics: [], mappings: [] }, arts)).toBeNull(); // no epics
    });
  });

  // ─── setArtifactEpic / readArtifactEpic ──────────────────────────────

  describe('setArtifactEpic()', () => {
    it('inserts an epic line at top level, before nested phases', () => {
      const fp = writeSpec(tmp, 'minspec/x', 'SPEC-001', 'X');
      setArtifactEpic(fp, 'EPIC-001');
      const content = fs.readFileSync(fp, 'utf-8');
      expect(content).toMatch(/^epic: EPIC-001$/m);
      expect(readArtifactEpic(fp)).toBe('EPIC-001');
      // still parses and phases preserved
      expect(content).toContain('specify: done');
    });

    it('replaces an existing epic ref rather than duplicating', () => {
      const fp = writeSpec(tmp, 'minspec/x', 'SPEC-001', 'X', 'body', 'old-slug');
      setArtifactEpic(fp, 'EPIC-007');
      const content = fs.readFileSync(fp, 'utf-8');
      expect(content.match(/epic:/g)!.length).toBe(1);
      expect(readArtifactEpic(fp)).toBe('EPIC-007');
    });

    it('throws on a file with no frontmatter', () => {
      const fp = path.join(tmp, 'plain.md');
      fs.writeFileSync(fp, '# no frontmatter\n');
      expect(() => setArtifactEpic(fp, 'EPIC-001')).toThrow();
    });
  });

  // ─── apply (HITL writes) ─────────────────────────────────────────────

  describe('applyBackfill()', () => {
    it('creates new epics, tags artifacts, regenerates INDEX', () => {
      const s1 = writeSpec(tmp, 'minspec/billing', 'SPEC-001', 'Billing Spec');
      const proposal = proposeHeuristic(tmp);
      const res = applyBackfill(tmp, proposal);
      expect(res.epicsCreated).toBe(1);
      expect(res.artifactsTagged).toBe(1);
      // spec now carries the created EPIC-001 ref
      const epics = listEpics(tmp);
      expect(epics).toHaveLength(1);
      expect(readArtifactEpic(s1)).toBe(epics[0].id);
      expect(fs.existsSync(path.join(tmp, 'docs/epics/INDEX.md'))).toBe(true);
    });

    it('skips an already-tagged artifact unless override', () => {
      const s1 = writeSpec(tmp, 'minspec/billing', 'SPEC-001', 'Billing', 'body', 'pre-existing');
      const proposal = proposeHeuristic(tmp);
      const res = applyBackfill(tmp, proposal);
      expect(res.artifactsTagged).toBe(0);
      expect(res.skipped).toBeGreaterThanOrEqual(1);
      expect(readArtifactEpic(s1)).toBe('pre-existing'); // untouched
    });

    it('reuses an existing registered epic id instead of creating a duplicate', () => {
      writeSpec(tmp, 'minspec/billing', 'SPEC-001', 'Billing');
      applyBackfill(tmp, proposeHeuristic(tmp));      // creates EPIC-001
      const before = listEpics(tmp).length;
      // second pass with override should not mint another billing epic
      applyBackfill(tmp, proposeHeuristic(tmp), { override: true });
      expect(listEpics(tmp).length).toBe(before);
    });

    // ── #79 regression (T3): backfill must NOT discard the proposal rationale.
    // Every epic minted by applyBackfill was born with an empty `## Goal`
    // because createEpic/generateEpicContent never received the rationale.
    it('writes the proposal rationale into the new epic\'s ## Goal (#79)', () => {
      const rationale = 'Groups all billing and invoicing work so payment flows ship together.';
      const fp = writeSpec(tmp, 'minspec/billing', 'SPEC-001', 'Billing Spec');
      const proposal = {
        epics: [{ slug: 'billing', title: 'Billing', rationale }],
        mappings: [{
          artifactId: 'SPEC-001', kind: 'spec' as const, filePath: fp,
          epicSlug: 'billing', confidence: 0.9, rationale: 'in billing folder',
        }],
        source: 'heuristic' as const,
      };
      const res = applyBackfill(tmp, proposal);
      expect(res.epicsCreated).toBe(1);

      const epic = listEpics(tmp)[0];
      const body = fs.readFileSync(epic.filePath, 'utf-8');
      // ## Goal section is non-empty and contains the rationale (not the placeholder).
      const goal = body.match(/## Goal\n([\s\S]*?)\n## /)?.[1].trim() ?? '';
      expect(goal).toContain(rationale);
      expect(goal).not.toContain('<!--'); // placeholder comment is gone
    });
  });

  describe('renderProposalMarkdown()', () => {
    it('renders epics + grouped mappings', () => {
      writeSpec(tmp, 'minspec/core', 'SPEC-001', 'Core');
      const md = renderProposalMarkdown(proposeHeuristic(tmp));
      expect(md).toContain('# Epic Backfill Proposal (heuristic)');
      expect(md).toContain('SPEC-001');
    });
  });
});
