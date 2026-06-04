/**
 * T1 — Extra Coverage: Epic Backfill (SPEC-011 / DR-016)
 *
 * Covers branches NOT exercised by epic-backfill.test.ts:
 *   - isClaudeAvailable() — success path (line 84) and failure path (line 86)
 *   - proposeAI()         — all child_process outcomes (lines 374-394):
 *       · success with valid JSON → proposal
 *       · success with no JSON in stdout → null
 *       · success with valid JSON envelope but malformed inner JSON → null
 *       · success with valid JSON but normalizeAiProposal returns null → null
 *       · execFile failure (non-zero exit / timeout) → null
 *       · empty artifacts → null (early return, line 375)
 *   - extractJson()       — unbalanced JSON → null (line 320)
 *   - applyBackfill()     — setArtifactEpic throws → skipped++ (line 441)
 *   - renderProposalMarkdown() — epic with id shows "(existing …)" label
 *   - normalizeAiProposal() — duplicate slug is deduplicated; missing title uses
 *       titleCase fallback; confidence below 0 is clamped; all-mappings-dropped
 *       epics are removed; non-object epic/mapping rows are skipped
 *
 * All child_process.execFile calls are mocked via vitest so no real `claude`
 * binary is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mock child_process BEFORE importing the module under test ──────────────
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
    if (typeof _opts === 'function') cb = _opts as Function;
    if (cb) cb(null, { stdout: '', stderr: '' });
  }),
}));

import { execFile } from 'child_process';
import {
  isClaudeAvailable,
  proposeAI,
  normalizeAiProposal,
  applyBackfill,
  renderProposalMarkdown,
  type ArtifactRef,
  type BackfillProposal,
} from '../src/lib/epic-backfill';
import { createEpic } from '../src/lib/epic-manager';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function writeConfig(root: string): void {
  const dir = path.join(root, '.minspec');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: '1' }));
}

function writeSpec(root: string, relDir: string, id: string, title: string, body = 'Some prose.', epic?: string): string {
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

// ─── execFile mock helpers ───────────────────────────────────────────────────

/** Make the mock call back with a successful result containing given stdout. */
function mockExecSuccess(stdout: string): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
      if (typeof _opts === 'function') cb = _opts as Function;
      if (cb) cb(null, { stdout, stderr: '' });
    },
  );
}

/** Make the mock call back with an error (non-zero exit / missing binary). */
function mockExecFailure(msg = 'Command failed'): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
      if (typeof _opts === 'function') cb = _opts as Function;
      if (cb) cb(new Error(msg), { stdout: '', stderr: msg });
    },
  );
}

// ─── Suite setup ────────────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  mockExecFile.mockReset();
  // default: success with empty stdout
  mockExecSuccess('');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-ebx-'));
  writeConfig(tmp);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── isClaudeAvailable ───────────────────────────────────────────────────────

describe('isClaudeAvailable()', () => {
  it('returns true when claude --version succeeds', async () => {
    mockExecSuccess('claude 1.0.0');
    const result = await isClaudeAvailable();
    expect(result).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'claude',
      ['--version'],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });

  it('returns false when claude --version throws (binary absent)', async () => {
    mockExecFailure('claude: command not found');
    const result = await isClaudeAvailable();
    expect(result).toBe(false);
  });
});

// ─── proposeAI ───────────────────────────────────────────────────────────────

describe('proposeAI()', () => {
  it('returns null immediately when there are no artifacts', async () => {
    // No specs/ADRs written → collectArtifacts returns []
    const result = await proposeAI(tmp);
    expect(result).toBeNull();
    // execFile should NOT have been called (early return)
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns a BackfillProposal when claude outputs valid JSON', async () => {
    writeSpec(tmp, 'minspec/billing', 'SPEC-001', 'Billing Spec');

    const aiOutput = JSON.stringify({
      epics: [{ slug: 'billing', title: 'Billing', rationale: 'Core billing work.' }],
      mappings: [{ artifactId: 'SPEC-001', epicSlug: 'billing', confidence: 0.9, rationale: 'Billing spec.' }],
    });
    // stdout may contain prose before/after the JSON object
    mockExecSuccess(`Here is my proposal:\n${aiOutput}\nDone.`);

    const result = await proposeAI(tmp);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('ai');
    expect(result!.epics).toHaveLength(1);
    expect(result!.epics[0].slug).toBe('billing');
    expect(result!.mappings).toHaveLength(1);
  });

  it('returns null when stdout contains no JSON object at all', async () => {
    writeSpec(tmp, 'minspec/billing', 'SPEC-001', 'Billing Spec');
    mockExecSuccess('I cannot help with that.');
    const result = await proposeAI(tmp);
    expect(result).toBeNull();
  });

  it('returns null when stdout contains an unbalanced/malformed JSON envelope', async () => {
    writeSpec(tmp, 'minspec/billing', 'SPEC-001', 'Billing Spec');
    // Start of a JSON object with no closing brace — extractJson returns null (line 320)
    mockExecSuccess('{ "epics": [ {"slug": "billing"');
    const result = await proposeAI(tmp);
    expect(result).toBeNull();
  });

  it('returns null when JSON.parse fails on the extracted token', async () => {
    writeSpec(tmp, 'minspec/billing', 'SPEC-001', 'Billing Spec');
    // Balanced braces but invalid JSON content (control chars etc.)
    mockExecSuccess('{ invalid json }');
    const result = await proposeAI(tmp);
    expect(result).toBeNull();
  });

  it('returns null when normalizeAiProposal rejects the parsed JSON (no epics)', async () => {
    writeSpec(tmp, 'minspec/billing', 'SPEC-001', 'Billing Spec');
    // Valid JSON structure but empty epics → normalizeAiProposal returns null
    const aiOutput = JSON.stringify({ epics: [], mappings: [] });
    mockExecSuccess(aiOutput);
    const result = await proposeAI(tmp);
    expect(result).toBeNull();
  });

  it('returns a proposal with empty epics/mappings when all mappings reference unknown artifacts', async () => {
    writeSpec(tmp, 'minspec/billing', 'SPEC-001', 'Billing Spec');
    // All mappings reference unknown artifact → mappings dropped → epics filtered to empty.
    // normalizeAiProposal only returns null when epics[] is empty BEFORE the mapping filter
    // (line 362 check). After filtering, it returns the proposal with empty arrays.
    const aiOutput = JSON.stringify({
      epics: [{ slug: 'billing', title: 'Billing', rationale: 'r' }],
      mappings: [{ artifactId: 'SPEC-999', epicSlug: 'billing', confidence: 0.8, rationale: 'r' }],
    });
    mockExecSuccess(aiOutput);
    const result = await proposeAI(tmp);
    // normalizeAiProposal returns { epics: [], mappings: [], source: 'ai' } — not null
    expect(result).not.toBeNull();
    expect(result!.epics).toHaveLength(0);
    expect(result!.mappings).toHaveLength(0);
    expect(result!.source).toBe('ai');
  });

  it('returns null when execFile fails (non-zero exit / timeout)', async () => {
    writeSpec(tmp, 'minspec/billing', 'SPEC-001', 'Billing Spec');
    mockExecFailure('Process exited with non-zero status: 1');
    const result = await proposeAI(tmp);
    expect(result).toBeNull();
  });
});

// ─── normalizeAiProposal — additional branches ───────────────────────────────

describe('normalizeAiProposal() — extra branches', () => {
  const arts: ArtifactRef[] = [
    { id: 'SPEC-001', kind: 'spec', title: 'Alpha', filePath: '/a.md' },
    { id: 'DR-001', kind: 'adr', title: 'Beta', filePath: '/b.md' },
  ];

  it('deduplicates repeated slugs (keeps first occurrence only)', () => {
    const res = normalizeAiProposal({
      epics: [
        { slug: 'core', title: 'Core', rationale: 'first' },
        { slug: 'core', title: 'Core Duplicate', rationale: 'second' }, // same slug → dropped
      ],
      mappings: [{ artifactId: 'SPEC-001', epicSlug: 'core', confidence: 0.8, rationale: 'r' }],
    }, arts);
    expect(res).not.toBeNull();
    expect(res!.epics).toHaveLength(1);
    expect(res!.epics[0].rationale).toBe('first'); // second entry was deduplicated
  });

  it('falls back to titleCase when epic title is absent/non-string', () => {
    const res = normalizeAiProposal({
      epics: [{ slug: 'auth-flow', rationale: 'r' }], // no title field
      mappings: [{ artifactId: 'SPEC-001', epicSlug: 'auth-flow', confidence: 0.7, rationale: 'x' }],
    }, arts);
    expect(res).not.toBeNull();
    expect(res!.epics[0].title).toBe('Auth Flow'); // titleCase from slug
  });

  it('clamps negative confidence to 0', () => {
    const res = normalizeAiProposal({
      epics: [{ slug: 'core', title: 'Core', rationale: '' }],
      mappings: [{ artifactId: 'SPEC-001', epicSlug: 'core', confidence: -0.5, rationale: '' }],
    }, arts);
    expect(res!.mappings[0].confidence).toBe(0);
  });

  it('defaults confidence to 0.5 when confidence field is missing/non-number', () => {
    const res = normalizeAiProposal({
      epics: [{ slug: 'core', title: 'Core', rationale: '' }],
      mappings: [{ artifactId: 'SPEC-001', epicSlug: 'core', rationale: 'r' }], // no confidence
    }, arts);
    expect(res!.mappings[0].confidence).toBe(0.5);
  });

  it('skips non-object entries in epics array', () => {
    const res = normalizeAiProposal({
      epics: [
        null,              // non-object → skipped
        42,                // non-object → skipped
        { slug: 'core', title: 'Core', rationale: '' },
      ],
      mappings: [{ artifactId: 'SPEC-001', epicSlug: 'core', confidence: 0.8, rationale: '' }],
    }, arts);
    expect(res).not.toBeNull();
    expect(res!.epics).toHaveLength(1);
  });

  it('skips non-object entries in mappings array', () => {
    const res = normalizeAiProposal({
      epics: [{ slug: 'core', title: 'Core', rationale: '' }],
      mappings: [
        null,              // non-object → skipped
        'string',          // non-object → skipped
        { artifactId: 'SPEC-001', epicSlug: 'core', confidence: 0.8, rationale: '' },
      ],
    }, arts);
    expect(res).not.toBeNull();
    expect(res!.mappings).toHaveLength(1);
  });

  it('drops epics that have no surviving mapping (all mappings reference unknown artifact)', () => {
    const res = normalizeAiProposal({
      epics: [
        { slug: 'used', title: 'Used', rationale: '' },
        { slug: 'orphan', title: 'Orphan', rationale: '' }, // no mapping will reference it
      ],
      mappings: [{ artifactId: 'SPEC-001', epicSlug: 'used', confidence: 0.9, rationale: '' }],
    }, arts);
    expect(res!.epics.map(e => e.slug)).toEqual(['used']);
    expect(res!.epics.some(e => e.slug === 'orphan')).toBe(false);
  });

  it('returns null when epics field is not an array', () => {
    expect(normalizeAiProposal({ epics: 'bad', mappings: [] }, arts)).toBeNull();
  });

  it('returns null when mappings field is not an array', () => {
    expect(normalizeAiProposal({ epics: [], mappings: 'bad' }, arts)).toBeNull();
  });
});

// ─── applyBackfill — write-error branch (line 441) ──────────────────────────

describe('applyBackfill() — setArtifactEpic throws → skipped', () => {
  it('increments skipped when tagging a file without frontmatter (override=true)', () => {
    // Write a plain file with no frontmatter — setArtifactEpic will throw on it.
    const badFile = path.join(tmp, 'specs', 'plain.md');
    fs.mkdirSync(path.join(tmp, 'specs'), { recursive: true });
    fs.writeFileSync(badFile, '# No frontmatter here\n\nJust prose.\n');

    const proposal: BackfillProposal = {
      epics: [{ slug: 'core', title: 'Core', rationale: 'backfill' }],
      mappings: [{
        artifactId: 'SPEC-X', kind: 'spec', filePath: badFile,
        epicSlug: 'core', confidence: 0.9, rationale: 'test',
      }],
      source: 'heuristic',
    };

    // override: true so we don't skip at the "already tagged" guard — we want
    // to reach setArtifactEpic and let it throw.
    const result = applyBackfill(tmp, proposal, { override: true });
    expect(result.skipped).toBe(1);
    expect(result.artifactsTagged).toBe(0);
    // The epic was still created even though tagging failed.
    expect(result.epicsCreated).toBe(1);
  });
});

// ─── applyBackfill — mapping with no refBySlug entry → skipped ──────────────

describe('applyBackfill() — mapping epicSlug not in refBySlug → skipped', () => {
  it('skips a mapping whose epicSlug has no corresponding proposal epic', () => {
    const fp = writeSpec(tmp, 'minspec/core', 'SPEC-001', 'Core Spec');

    const proposal: BackfillProposal = {
      epics: [], // no epics at all
      mappings: [{
        artifactId: 'SPEC-001', kind: 'spec', filePath: fp,
        epicSlug: 'ghost', confidence: 0.8, rationale: 'orphan mapping',
      }],
      source: 'heuristic',
    };

    const result = applyBackfill(tmp, proposal);
    expect(result.skipped).toBe(1);
    expect(result.artifactsTagged).toBe(0);
    expect(result.epicsCreated).toBe(0);
  });
});

// ─── renderProposalMarkdown — existing epic branch ──────────────────────────

describe('renderProposalMarkdown()', () => {
  it('shows "(existing EPIC-NNN)" for an epic that has an id', () => {
    const proposal: BackfillProposal = {
      epics: [
        { id: 'EPIC-001', slug: 'core', title: 'Core', rationale: 'Existing.' },
        { slug: 'new-work', title: 'New Work', rationale: 'Fresh.' },
      ],
      mappings: [
        { artifactId: 'SPEC-001', kind: 'spec', filePath: '/a.md', epicSlug: 'core', confidence: 0.9, rationale: 'x' },
        { artifactId: 'DR-001', kind: 'adr', filePath: '/b.md', epicSlug: 'new-work', confidence: 0.7, rationale: 'y' },
      ],
      source: 'ai',
    };

    const md = renderProposalMarkdown(proposal);

    // Source label
    expect(md).toContain('# Epic Backfill Proposal (ai)');

    // Existing epic uses "(existing EPIC-001)" label
    expect(md).toContain('(existing EPIC-001)');

    // New epic uses "(new)" label
    expect(md).toContain('(new)');

    // Mapping sections exist
    expect(md).toContain('### core');
    expect(md).toContain('### new-work');
    expect(md).toContain('SPEC-001');
    expect(md).toContain('DR-001');
  });

  it('renders an empty-mappings proposal without error', () => {
    const proposal: BackfillProposal = {
      epics: [{ slug: 'solo', title: 'Solo', rationale: 'r' }],
      mappings: [],
      source: 'heuristic',
    };
    const md = renderProposalMarkdown(proposal);
    expect(md).toContain('0 mapping(s)');
    expect(md).toContain('1 epic(s)');
  });
});

// ─── proposeAI — buildPrompt with existing registered epics (line 287) ───────

describe('proposeAI() — buildPrompt with registered epics', () => {
  it('includes existing registered epics in the prompt sent to claude', async () => {
    // Create a spec + an already-registered epic so buildPrompt hits the
    // `registered.length > 0` branch (line 287) that formats existing epic ids.
    writeSpec(tmp, 'minspec/billing', 'SPEC-001', 'Billing Spec');
    createEpic(tmp, 'Core', 'core', undefined, 'Core work');

    // Capture the prompt text by inspecting the execFile call args.
    let capturedPrompt = '';
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: Function) => {
        if (typeof _opts === 'function') cb = _opts as Function;
        // args[0] is '-p', args[1] is the prompt string
        capturedPrompt = args[1] ?? '';
        if (cb) cb(null, { stdout: '', stderr: '' });
      },
    );

    await proposeAI(tmp);

    // The prompt must list the registered epic (not "(none)")
    expect(capturedPrompt).toContain('EXISTING EPICS');
    expect(capturedPrompt).not.toContain('(none)');
    // Registered epic slug appears in the prompt
    expect(capturedPrompt).toContain('slug=core');
  });
});
