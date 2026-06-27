/**
 * #241 — Slash-command shims are merge-refreshable + drift-detected.
 *
 * The `/specify`, `/plan`, … shims MinSpec scaffolds into a project (Claude Code
 * `.claude/commands/<cmd>.md`, Cursor `.cursor/rules/spec-kit-commands.mdc`) used to
 * be CREATE-ONLY: init wrote them, Refresh never updated them, and harness-drift
 * detection was blind to a guidance change — so an improved shim (e.g. the #104
 * shift-left guidance) could never reach an already-initialized project.
 *
 * They are now MANAGED-REGION templates riding the same generate/refresh + drift path
 * as every other harness file:
 *   - refresh OVERWRITES the MinSpec-owned region (the shim body) with the current
 *     guidance, so improvements reach existing projects,
 *   - refresh PRESERVES user content added OUTSIDE the markers,
 *   - a CHANGED shim (upstream guidance moved) is reported by `hasHarnessDrift` so the
 *     "templates updated, refresh?" prompt fires,
 *   - a DELETED shim file is re-scaffolded,
 *   - shims are tool-gated: a Claude shim only when `CLAUDE.md` exists, the Cursor
 *     file only when `.cursorrules` exists.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { generateHarnessFiles, refreshHarnessFiles } from '../src/lib/scaffold';
import {
  MANAGED_REGION_TEMPLATES,
  SLASH_COMMAND_SHIM_TEMPLATES,
  CLAUDE_COMMANDS_DIR,
  CURSOR_SLASH_COMMANDS_PATH,
  managedRegionStartMarker,
  managedRegionEndMarker,
  renderManagedBlock,
  computeTemplateBaseline,
} from '../src/lib/template-registry';
import { splitManagedRegion, loadTemplateBaseline, saveTemplateBaseline } from '../src/lib/merge-refresh';
import { SPEC_KIT_COMMANDS } from '../src/lib/slash-commands';
import { hasHarnessDrift } from '../src/lib/auto-bootstrap';

const SPECIFY_REL = `${CLAUDE_COMMANDS_DIR}/specify.md`;
const PLAN_REL = `${CLAUDE_COMMANDS_DIR}/plan.md`;

const tplByPath = (p: string) =>
  MANAGED_REGION_TEMPLATES.find((t) => t.outputPath === p)!;

describe('slash-command shim templates are registered as managed-region templates (#241)', () => {
  it('registers one Claude shim per command + one Cursor file', () => {
    const claudePaths = SPEC_KIT_COMMANDS.map((c) => `${CLAUDE_COMMANDS_DIR}/${c}.md`);
    for (const p of [...claudePaths, CURSOR_SLASH_COMMANDS_PATH]) {
      const tpl = tplByPath(p);
      expect(tpl, `expected a managed-region template for ${p}`).toBeDefined();
      // Markdown ⇒ html comment markers.
      expect(tpl.commentStyle).toBe('html');
      // Shims carry a YAML frontmatter preamble the AI tool reads on line 1.
      expect(tpl.preamble).toBeDefined();
      expect(tpl.preamble!.startsWith('---')).toBe(true);
      // And they are tool-gated (never blanket-written).
      expect(typeof tpl.condition).toBe('function');
      expect(tpl.content.length).toBeGreaterThan(0);
    }
    expect(SLASH_COMMAND_SHIM_TEMPLATES).toHaveLength(SPEC_KIT_COMMANDS.length + 1);
  });

  it('preserves the existing first managed-region template (workflow stays index 0)', () => {
    // Other tests pin MANAGED_REGION_TEMPLATES[0] === validate-workflow; the shims
    // must be appended, never prepended.
    expect(MANAGED_REGION_TEMPLATES[0].name).toBe('validate-workflow');
  });

  it('each Claude shim is tool-gated on claude and the Cursor file on cursor', () => {
    const noTools = {
      claude: false, cursor: false, cline: false,
      agents: false, windsurf: false, aider: false,
    };
    const claude = tplByPath(SPECIFY_REL);
    expect(claude.condition!(noTools)).toBe(false);
    expect(claude.condition!({ ...noTools, claude: true })).toBe(true);
    expect(claude.condition!({ ...noTools, cursor: true })).toBe(false);

    const cursor = tplByPath(CURSOR_SLASH_COMMANDS_PATH);
    expect(cursor.condition!(noTools)).toBe(false);
    expect(cursor.condition!({ ...noTools, cursor: true })).toBe(true);
  });

  it('the rendered shim carries the markers, the frontmatter outside them, and the guidance inside', () => {
    const tpl = tplByPath(SPECIFY_REL);
    const start = managedRegionStartMarker(tpl.name, tpl.commentStyle);
    const end = managedRegionEndMarker(tpl.name, tpl.commentStyle);
    const block = renderManagedBlock(tpl);
    expect(block.split('\n')[0]).toBe(start);
    expect(block).toContain(end);
    // The body that used to be written verbatim by buildClaudeShim is now the region.
    expect(block).toContain('## Acceptance Criteria');
    expect(tpl.preamble).toContain('description:');
  });
});

describe('slash-command shim scaffolding + refresh (#241)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-shim241-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('init scaffolds each Claude shim wrapped in managed markers, frontmatter on line 1', () => {
    generateHarnessFiles(tmpDir);
    for (const cmd of SPEC_KIT_COMMANDS) {
      const rel = `${CLAUDE_COMMANDS_DIR}/${cmd}.md`;
      const full = path.join(tmpDir, rel);
      expect(fs.existsSync(full), `expected ${rel}`).toBe(true);
      const onDisk = fs.readFileSync(full, 'utf-8');
      // Frontmatter the tool reads is still on line 1 (outside the markers).
      expect(onDisk.startsWith('---\n')).toBe(true);
      // Markers are present and bound the guidance region.
      const tpl = tplByPath(rel);
      const start = managedRegionStartMarker(tpl.name, tpl.commentStyle);
      const end = managedRegionEndMarker(tpl.name, tpl.commentStyle);
      expect(onDisk).toContain(start);
      expect(onDisk).toContain(end);
      expect(splitManagedRegion(onDisk, start, end)).not.toBeNull();
      // The command heading the AI tool routes on is still present.
      expect(onDisk).toContain(`# /${cmd}`);
    }
  });

  it('init scaffolds the Cursor file with markers when .cursorrules is present', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, CURSOR_SLASH_COMMANDS_PATH);
    expect(fs.existsSync(full)).toBe(true);
    const onDisk = fs.readFileSync(full, 'utf-8');
    expect(onDisk.startsWith('---\n')).toBe(true);
    const tpl = tplByPath(CURSOR_SLASH_COMMANDS_PATH);
    const start = managedRegionStartMarker(tpl.name, tpl.commentStyle);
    const end = managedRegionEndMarker(tpl.name, tpl.commentStyle);
    expect(splitManagedRegion(onDisk, start, end)).not.toBeNull();
    for (const cmd of SPEC_KIT_COMMANDS) {
      expect(onDisk).toContain(`## /${cmd}`);
    }
  });

  it('REFRESH updates an unmodified shim to the current guidance (was create-only)', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, SPECIFY_REL);
    const tpl = tplByPath(SPECIFY_REL);
    const start = managedRegionStartMarker(tpl.name, tpl.commentStyle);
    const end = managedRegionEndMarker(tpl.name, tpl.commentStyle);

    // Simulate an OLD shim: keep frontmatter + markers, but stale body inside the region.
    const onDisk = fs.readFileSync(full, 'utf-8');
    const split = splitManagedRegion(onDisk, start, end)!;
    const stale = `${split.before}\n${start}\n# /specify\n\nOLD STALE GUIDANCE\n${end}\n`;
    fs.writeFileSync(full, stale);

    const warnings = refreshHarnessFiles(tmpDir);
    expect(warnings).toEqual([]);

    const refreshed = fs.readFileSync(full, 'utf-8');
    // The current guidance is restored inside the region; the stale text is gone.
    expect(refreshed).not.toContain('OLD STALE GUIDANCE');
    expect(refreshed).toContain('## Acceptance Criteria');
    expect(refreshed).toContain(tpl.content);
  });

  it('REFRESH preserves user content added OUTSIDE the markers', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, PLAN_REL);
    const scaffolded = fs.readFileSync(full, 'utf-8');

    const userTail = '\n## My Project Notes\n\nProject-specific plan reminders.\n';
    fs.writeFileSync(full, scaffolded + userTail);

    const warnings = refreshHarnessFiles(tmpDir);
    expect(warnings).toEqual([]);

    const onDisk = fs.readFileSync(full, 'utf-8');
    // User content survives verbatim...
    expect(onDisk).toContain('## My Project Notes');
    expect(onDisk).toContain('Project-specific plan reminders.');
    // ...and MinSpec's region is still present (frontmatter on line 1).
    expect(onDisk.startsWith('---\n')).toBe(true);
    const tpl = tplByPath(PLAN_REL);
    expect(onDisk).toContain(tpl.content);
  });

  it('REFRESH updates the MinSpec region EVEN WHEN the user edited outside it', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, SPECIFY_REL);
    const tpl = tplByPath(SPECIFY_REL);
    const start = managedRegionStartMarker(tpl.name, tpl.commentStyle);
    const end = managedRegionEndMarker(tpl.name, tpl.commentStyle);

    const onDisk = fs.readFileSync(full, 'utf-8');
    const split = splitManagedRegion(onDisk, start, end)!;
    // Stale region body AND a user edit appended after the region.
    const mixed =
      `${split.before}\n${start}\n# /specify\n\nOLD\n${end}\n\n## User Tail\n\nkeep me\n`;
    fs.writeFileSync(full, mixed);

    refreshHarnessFiles(tmpDir);

    const refreshed = fs.readFileSync(full, 'utf-8');
    expect(refreshed).toContain('## User Tail');
    expect(refreshed).toContain('keep me');
    expect(refreshed).not.toContain('\nOLD\n');
    expect(refreshed).toContain(tpl.content);
  });

  it('REFRESH on a shim with markers DELETED → skip + warn, file untouched', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, SPECIFY_REL);
    const userOwned = '---\ndescription: my own specify\n---\n\n# my custom specify\n';
    fs.writeFileSync(full, userOwned);

    const warnings = refreshHarnessFiles(tmpDir);

    expect(fs.readFileSync(full, 'utf-8')).toBe(userOwned);
    const warn = warnings.find((w) => w.outputPath === SPECIFY_REL);
    expect(warn, 'expected a missing-markers warning for the shim').toBeDefined();
    expect(warn!.message).toContain('markers missing');
    expect(warn!.message).toContain(SPECIFY_REL);
  });

  it('REFRESH re-scaffolds a DELETED shim file', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, SPECIFY_REL);
    fs.unlinkSync(full);
    expect(fs.existsSync(full)).toBe(false);

    const warnings = refreshHarnessFiles(tmpDir);
    expect(warnings).toEqual([]);

    expect(fs.existsSync(full)).toBe(true);
    const onDisk = fs.readFileSync(full, 'utf-8');
    expect(onDisk.startsWith('---\n')).toBe(true);
    expect(onDisk).toContain('## Acceptance Criteria');
  });

  it('a guidance update reaches an existing project on refresh (the core #241 win)', () => {
    // Reproduce the original bug scenario: a project initialized on an OLD shim. We
    // simulate "old" by stomping the scaffolded region body with stale text (markers
    // intact, as a real older shim would have). Refresh must deliver the new guidance —
    // the create-only code path could never do this.
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, PLAN_REL);
    const tpl = tplByPath(PLAN_REL);
    const start = managedRegionStartMarker(tpl.name, tpl.commentStyle);
    const end = managedRegionEndMarker(tpl.name, tpl.commentStyle);

    const split = splitManagedRegion(fs.readFileSync(full, 'utf-8'), start, end)!;
    fs.writeFileSync(full, `${split.before}\n${start}\n# /plan\n\nold plan guidance\n${end}\n`);

    refreshHarnessFiles(tmpDir);

    const onDisk = fs.readFileSync(full, 'utf-8');
    expect(onDisk).not.toContain('old plan guidance');
    // The current /plan guidance (shift-left aspect-artifact text) is now delivered.
    expect(onDisk).toContain('shift-left');
  });
});

describe('slash-shim guidance change is drift-detected (#241)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-shim241-drift-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computeTemplateBaseline records every slash-shim output path', () => {
    const baseline = computeTemplateBaseline();
    for (const cmd of SPEC_KIT_COMMANDS) {
      expect(baseline[`${CLAUDE_COMMANDS_DIR}/${cmd}.md`]).toBeDefined();
    }
    expect(baseline[CURSOR_SLASH_COMMANDS_PATH]).toBeDefined();
  });

  it('a guidance change to a shim is reported by hasHarnessDrift (prompt fires)', () => {
    generateHarnessFiles(tmpDir);
    // Fresh generate ⇒ baseline matches current ⇒ no drift.
    expect(hasHarnessDrift(tmpDir)).toBe(false);

    // Simulate the bundled shim guidance moving upstream: tamper the RECORDED baseline
    // hash for one shim so the current raw template no longer matches it. This is
    // exactly what a real guidance edit produces (current template hash changes vs the
    // baseline written at the last refresh).
    const baseline = loadTemplateBaseline(tmpDir);
    const tpl = tplByPath(SPECIFY_REL);
    const tampered = {
      ...baseline,
      [SPECIFY_REL]: { [tpl.name]: 'stale-hash-from-older-shim-guidance' },
    };
    saveTemplateBaseline(tmpDir, tampered);

    expect(hasHarnessDrift(tmpDir)).toBe(true);

    // Not vacuous: a refresh re-records the baseline and clears the drift.
    refreshHarnessFiles(tmpDir);
    expect(hasHarnessDrift(tmpDir)).toBe(false);
  });
});
