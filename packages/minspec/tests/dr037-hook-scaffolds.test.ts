/**
 * DR-037 — editor-independent gate harness scaffolds (#247 / #246 / #244).
 *
 * The SDD gates (spec `id:` frontmatter, RCDD root-cause, ref-egress) only fired on
 * the VS Code command path. DR-037 scaffolds three cooperating files into the user
 * project so a terminal / other-editor / AI-agent commit is gated too:
 *
 *   .minspec/hooks/pre-commit   — gitleaks secret scan (#244, graceful-degrade) +
 *                                 the DR-037 Node→python→shell detection chain
 *   .minspec/hooks/commit-msg   — RCDD root-cause gate (DR-003)
 *   .minspec/hooks/validate.py  — python mid-tier validator (#246), a language-
 *                                 agnostic twin of the Node validator's core checks
 *
 * All three are managed-region templates: they scaffold with `#`-comment markers,
 * refresh OVERWRITES only the marked region and PRESERVES user content outside it,
 * and they carry the execute bit + a shebang on line 1 so git runs them.
 *
 * Tests:
 *   - each scaffolds with markers, a line-1 shebang, and the execute bit;
 *   - the hook scripts actually enforce the gates (asserted on the rendered text);
 *   - refresh preserves user-added content outside the markers;
 *   - the python validator's core checks MATCH the Node validator on a fixture
 *     (run end-to-end against the scaffolded validate.py via python3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

import { generateHarnessFiles, refreshHarnessFiles } from '../src/lib/scaffold';
import {
  MANAGED_REGION_TEMPLATES,
  MINSPEC_HOOKS_DIR,
  managedRegionStartMarker,
  managedRegionEndMarker,
  renderManagedFile,
  renderManagedBlock,
} from '../src/lib/template-registry';
import { splitManagedRegion } from '../src/lib/merge-refresh';

const PRE_COMMIT = `${MINSPEC_HOOKS_DIR}/pre-commit`;
const COMMIT_MSG = `${MINSPEC_HOOKS_DIR}/commit-msg`;
const VALIDATE_PY = `${MINSPEC_HOOKS_DIR}/validate.py`;

const byPath = (p: string) =>
  MANAGED_REGION_TEMPLATES.find((t) => t.outputPath === p)!;

function python3Available(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('DR-037 hook templates are registered as managed-region templates', () => {
  it('registers pre-commit, commit-msg, and validate.py under .minspec/hooks', () => {
    for (const p of [PRE_COMMIT, COMMIT_MSG, VALIDATE_PY]) {
      const tpl = byPath(p);
      expect(tpl, `expected a managed-region template for ${p}`).toBeDefined();
      expect(tpl.commentStyle).toBe('hash');
      expect(tpl.executable).toBe(true);
      expect(tpl.content.length).toBeGreaterThan(0);
    }
  });

  it('hook scripts carry a shebang preamble (line 1 for git execution)', () => {
    expect(byPath(PRE_COMMIT).preamble).toBe('#!/usr/bin/env sh');
    expect(byPath(COMMIT_MSG).preamble).toBe('#!/usr/bin/env sh');
    expect(byPath(VALIDATE_PY).preamble).toBe('#!/usr/bin/env python3');
  });

  it('renderManagedFile puts the shebang on line 1, then the marked block', () => {
    const tpl = byPath(PRE_COMMIT);
    const file = renderManagedFile(tpl);
    const lines = file.split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env sh');
    // The managed block (markers + body) still round-trips via split.
    const start = managedRegionStartMarker(tpl.name, tpl.commentStyle);
    const end = managedRegionEndMarker(tpl.name, tpl.commentStyle);
    expect(splitManagedRegion(file, start, end)).not.toBeNull();
    // No preamble → renderManagedFile === renderManagedBlock (CI workflow unchanged).
    const wf = byPath('.github/workflows/minspec-validate.yml');
    expect(renderManagedFile(wf)).toBe(renderManagedBlock(wf));
  });
});

describe('the scaffolded hook scripts actually enforce the SDD gates', () => {
  it('commit-msg requires a Root cause: line on fix: commits (RCDD / DR-003)', () => {
    const c = byPath(COMMIT_MSG).content;
    // Gates only fix-shaped subjects, requires the root-cause marker, has a bypass.
    expect(c).toMatch(/\^fix.*:/);
    expect(c).toMatch(/root\[ -\]cause:/i);
    expect(c).toContain('MINSPEC_GATE_OFF');
    expect(c).toContain('exit 1');
  });

  it('commit-msg gates prose-only deferrals — follow-up materialization (DR-023)', () => {
    const c = byPath(COMMIT_MSG).content;
    // Detects deferral language, and accepts either an issue ref or an explicit escape.
    expect(c).toMatch(/held back\|separate/i);
    expect(c).toMatch(/#\[0-9\]\+/); // issue-ref escape
    expect(c).toMatch(/follow-\?ups\?/i); // "Follow-ups: none" escape (hyphen optional)
    expect(c).toContain('follow-up gate');
  });

  it('pre-commit gates author identity ONLY when an allowlist is configured (#1114)', () => {
    const c = byPath(PRE_COMMIT).content;
    // Opt-in config key + the documented bypass.
    expect(c).toContain('minspec.allowedCommitEmails');
    expect(c).toContain('EMAIL_GATE_OFF');
    // Reads the live identity, not a cached/assumed one.
    expect(c).toContain('git config --get user.email');
    // Names the actual symptom this gate exists to prevent, so the refusal is
    // self-explanatory rather than a bare "not allowed".
    expect(c).toMatch(/ghost/i);
  });

  it('pre-commit runs gitleaks but degrades to a WARNING when absent (#244)', () => {
    const c = byPath(PRE_COMMIT).content;
    expect(c).toContain('command -v gitleaks');
    // gitleaks present → can block (exit 1); absent → warn + continue (no exit 1).
    expect(c).toMatch(/gitleaks (protect|detect)/);
    expect(c).toContain('not installed');
    // The gitleaks-absent branch (between `else` and its closing `fi`) warns and
    // does NOT exit non-zero — a missing optional tool degrades, never blocks.
    const m = c.match(/\belse\b([\s\S]*?)\bfi\b/);
    expect(m, 'expected an else…fi block for the gitleaks-absent path').not.toBeNull();
    const elseBranch = m![1];
    expect(elseBranch).toContain('SKIPPED');
    expect(elseBranch).not.toContain('exit 1');
  });

  it('pre-commit implements the Node→python→shell detection chain (DR-037)', () => {
    const c = byPath(PRE_COMMIT).content;
    expect(c).toContain('@aiclarity/minspec-validator');
    expect(c).toContain('validate.py');
    // Shell fallback checks the spec-id frontmatter gate over staged files.
    expect(c).toContain('git diff --cached --name-only');
    expect(c).toContain('id: SPEC-NNN');
    // DR-032 egress: flags an internal marker leaking out of the hooks dir.
    expect(c).toContain('minspec:managed:');
  });

  it('Node tier is opportunistic: --no-install probe never network-fetches (never-brick)', () => {
    // The not-yet-published @aiclarity/minspec-validator must NOT be able to E404-
    // block a commit. The hook probes with `--no-install` (uses only an already-
    // resolvable package) and NEVER `--yes`/auto-install for the gate run.
    const c = byPath(PRE_COMMIT).content;
    expect(c).toContain('npx --no-install @aiclarity/minspec-validator');
    expect(c).not.toContain('npx --yes @aiclarity/minspec-validator');
    // Python tier only fires when both python3 and the script are present.
    expect(c).toContain('command -v python3');
    expect(c).toContain('[ -f "$hook_dir/validate.py" ]');
    // The always-present shell gate is the terminal fallback.
    expect(c).toContain('minspec_shell_gate');
  });
});

describe('commit-msg follow-up gate (DR-023) — executed behavior', () => {
  function runHook(message: string, env: Record<string, string> = {}): { code: number; stderr: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-followup-'));
    try {
      const hookPath = path.join(dir, 'commit-msg');
      fs.writeFileSync(hookPath, renderManagedFile(byPath(COMMIT_MSG)));
      fs.chmodSync(hookPath, 0o755);
      const msgPath = path.join(dir, 'MSG');
      fs.writeFileSync(msgPath, message);
      // Start from a clean env: the ambient shell may export MINSPEC_GATE_OFF=1
      // (which would bypass the gate); tests opt into the bypass explicitly.
      const base = { ...process.env };
      delete base.MINSPEC_GATE_OFF;
      try {
        execFileSync('sh', [hookPath, msgPath], { stdio: 'pipe', env: { ...base, ...env } });
        return { code: 0, stderr: '' };
      } catch (e: unknown) {
        const err = e as { status?: number; stderr?: Buffer };
        return { code: err.status ?? 1, stderr: String(err.stderr ?? '') };
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('BLOCKS a commit that defers work with no issue ref', () => {
    const r = runHook('feat: add X\n\nCI files held back for a separate PR.\n');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('follow-up gate');
  });

  it('ALLOWS a deferral that cites a tracked issue (#NNN)', () => {
    expect(runHook('feat: add X\n\nCI files held back — tracked in #12.\n').code).toBe(0);
  });

  it('ALLOWS a deferral with an explicit "Follow-ups: none"', () => {
    expect(runHook('feat: add X\n\nHeld back nothing.\n\nFollow-ups: none\n').code).toBe(0);
  });

  it('ALLOWS a normal commit with no deferral language', () => {
    expect(runHook('feat: add X\n\nA clean, self-contained change. Closes #5.\n').code).toBe(0);
  });

  it('MINSPEC_GATE_OFF=1 bypasses the gate', () => {
    expect(runHook('feat: add X\n\nheld back a bunch, no ref.\n', { MINSPEC_GATE_OFF: '1' }).code).toBe(0);
  });

  // DR-059 §3 — false-positive mitigations the #725 review asked for.
  it('does NOT false-trigger on the git commit -v verbose diff below the scissors line', () => {
    // A legit deferral-free commit whose appended verbose diff happens to contain
    // "follow-up" / "out of scope". The gate must scan only the human body.
    const msg =
      'feat: add X\n\nA clean self-contained change.\n' +
      '# ------------------------ >8 ------------------------\n' +
      '# Do not modify or remove the line above.\n' +
      'diff --git a/notes.md b/notes.md\n' +
      '+This is a follow-up idea, out of scope, deferred for later.\n';
    expect(runHook(msg).code).toBe(0);
  });

  it('ALLOWS "out of scope for X but handled here" (handled-here escape, no fake ref)', () => {
    expect(runHook('feat: add X\n\nLogging is out of scope for X but handled here.\n').code).toBe(0);
  });

  it('BLOCKS "not in this PR" — the handled-here escape must NOT self-escape a real deferral (DR-059)', () => {
    // Regression: the escape `in this (pr|commit|change)` was a superstring of the
    // trigger `not in this (pr|commit)`, so a genuine "not in this PR" deferral
    // self-escaped and passed. The escape now requires an affirmative verb.
    expect(runHook('feat: add X\n\nThe retry path is not in this PR.\n').code).toBe(1);
    expect(runHook('feat: add X\n\nThat cleanup is not in this commit.\n').code).toBe(1);
  });

  it('ALLOWS an affirmative "done in this PR" / "fixed in this commit" (real handled signal)', () => {
    expect(runHook('feat: add X\n\nThe follow-up cleanup is done in this PR.\n').code).toBe(0);
  });

  it('ALLOWS an explicit "nothing deferred" negation with no issue ref', () => {
    expect(runHook('feat: add X\n\nRefactor only; nothing deferred.\n').code).toBe(0);
  });

  it('still BLOCKS a genuine untracked prose deferral inside a -v verbose message', () => {
    // The deferral is in the HUMAN body (above the scissors), so it must still block
    // even when a verbose diff is appended.
    const msg =
      'feat: add X\n\nCI files held back for a separate PR.\n' +
      '# ------------------------ >8 ------------------------\n' +
      'diff --git a/x b/x\n+noise\n';
    expect(runHook(msg).code).toBe(1);
  });

  it('still enforces the RCDD root-cause gate on fix: commits (no regression)', () => {
    expect(runHook('fix: thing\n\nno diagnosis here.\n').code).toBe(1);
    expect(runHook('fix: thing\n\nRoot cause: the widget was null.\n').code).toBe(0);
  });
});

describe('hook scaffolds: markers, shebang, execute bit (#247)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-dr037-hooks-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('init scaffolds all three hook files with markers + line-1 shebang', () => {
    generateHarnessFiles(tmpDir);

    for (const rel of [PRE_COMMIT, COMMIT_MSG, VALIDATE_PY]) {
      const full = path.join(tmpDir, rel);
      expect(fs.existsSync(full), `expected ${rel} to exist`).toBe(true);
      const tpl = byPath(rel);
      const onDisk = fs.readFileSync(full, 'utf-8');
      expect(onDisk).toBe(renderManagedFile(tpl));
      expect(onDisk.split('\n')[0]).toBe(tpl.preamble);
      const start = managedRegionStartMarker(tpl.name, tpl.commentStyle);
      const end = managedRegionEndMarker(tpl.name, tpl.commentStyle);
      expect(splitManagedRegion(onDisk, start, end)).not.toBeNull();
    }
  });

  it('scaffolded hook files carry the execute bit', () => {
    generateHarnessFiles(tmpDir);
    for (const rel of [PRE_COMMIT, COMMIT_MSG, VALIDATE_PY]) {
      const mode = fs.statSync(path.join(tmpDir, rel)).mode;
      // Owner-execute bit set.
      expect(mode & 0o100, `${rel} should be executable`).toBe(0o100);
    }
  });

  it('init does not overwrite a pre-existing hook file', () => {
    const full = path.join(tmpDir, PRE_COMMIT);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const userContent = '#!/usr/bin/env sh\n# my own hook\nexit 0\n';
    fs.writeFileSync(full, userContent);

    generateHarnessFiles(tmpDir);
    expect(fs.readFileSync(full, 'utf-8')).toBe(userContent);
  });

  it('refresh PRESERVES user content outside the markers, updates the region', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, PRE_COMMIT);
    const tpl = byPath(PRE_COMMIT);
    const start = managedRegionStartMarker(tpl.name, tpl.commentStyle);
    const end = managedRegionEndMarker(tpl.name, tpl.commentStyle);

    // User edits the region body stale + adds content after the end marker.
    const stale =
      `#!/usr/bin/env sh\n${start}\n# OLD hook body\nexit 0\n${end}\n` +
      '# my own extra check below the MinSpec region\nmy_custom_check\n';
    fs.writeFileSync(full, stale);

    const warnings = refreshHarnessFiles(tmpDir);
    expect(warnings).toEqual([]);

    const onDisk = fs.readFileSync(full, 'utf-8');
    // User's outside content survives...
    expect(onDisk).toContain('# my own extra check below the MinSpec region');
    expect(onDisk).toContain('my_custom_check');
    // ...the MinSpec region is current again...
    expect(onDisk).toContain('@aiclarity/minspec-validator');
    expect(onDisk).not.toContain('# OLD hook body');
    // ...and the shebang is still line 1 for git.
    expect(onDisk.split('\n')[0]).toBe('#!/usr/bin/env sh');
  });

  it('refresh with markers DELETED → skip + warn, file untouched', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, VALIDATE_PY);
    const noMarkers = '#!/usr/bin/env python3\nprint("hand-rolled, markers removed")\n';
    fs.writeFileSync(full, noMarkers);

    const warnings = refreshHarnessFiles(tmpDir);

    expect(fs.readFileSync(full, 'utf-8')).toBe(noMarkers);
    const w = warnings.find((x) => x.outputPath === VALIDATE_PY);
    expect(w).toBeDefined();
    expect(w!.message).toContain('markers missing');
  });

  it('refresh re-scaffolds a DELETED hook file with shebang + markers + exec bit', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, COMMIT_MSG);
    fs.unlinkSync(full);

    const warnings = refreshHarnessFiles(tmpDir);
    expect(warnings).toEqual([]);

    expect(fs.existsSync(full)).toBe(true);
    expect(fs.readFileSync(full, 'utf-8')).toBe(renderManagedFile(byPath(COMMIT_MSG)));
    expect(fs.statSync(full).mode & 0o100).toBe(0o100);
  });
});

/**
 * Python mid-tier ↔ Node core-check parity (#246).
 *
 * The scaffolded validate.py is a language-agnostic twin of the Node validator's
 * core FATAL checks. We run the actual scaffolded script via python3 over a fixture
 * tree and assert its verdict matches the Node validator's core rules:
 *   - specs/**\/*.md must carry `id: SPEC-NNN`
 *   - docs/domain/*.md must carry `type: domain`
 */
describe('python validate.py mirrors the Node validator core checks (#246)', () => {
  let tmpDir: string;
  const hasPy = python3Available();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-dr037-py-'));
    generateHarnessFiles(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runValidatePy(): { code: number; stderr: string } {
    try {
      execFileSync('python3', [path.join(tmpDir, VALIDATE_PY)], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stderr: '' };
    } catch (e: unknown) {
      const err = e as { status?: number; stderr?: string };
      return { code: err.status ?? 1, stderr: err.stderr ?? '' };
    }
  }

  /** The Node validator's CORE rules, applied in-process as the parity oracle. */
  function nodeCoreVerdict(): { errors: number; offenders: string[] } {
    const offenders: string[] = [];
    const parseFm = (content: string): Record<string, string> => {
      const m = content.match(/^---\n([\s\S]*?)\n---/);
      if (!m) return {};
      const fm: Record<string, string> = {};
      for (const line of m[1].split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        if (key) fm[key] = line.slice(idx + 1).trim();
      }
      return fm;
    };
    const walk = (dir: string): string[] => {
      if (!fs.existsSync(dir)) return [];
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(full));
        else if (e.name.endsWith('.md')) out.push(full);
      }
      return out;
    };
    for (const f of walk(path.join(tmpDir, 'specs'))) {
      const id = (parseFm(fs.readFileSync(f, 'utf-8'))['id'] ?? '').split('#')[0].trim();
      if (!/^SPEC-\d+$/.test(id)) offenders.push(path.relative(tmpDir, f));
    }
    for (const f of walk(path.join(tmpDir, 'docs', 'domain'))) {
      const type = (parseFm(fs.readFileSync(f, 'utf-8'))['type'] ?? '').split('#')[0].trim();
      if (type !== 'domain') offenders.push(path.relative(tmpDir, f));
    }
    return { errors: offenders.length, offenders };
  }

  function writeSpec(rel: string, body: string): void {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }

  it.skipIf(!hasPy)('agrees with Node: a clean fixture passes both', () => {
    writeSpec('specs/spec-001/spec.md', '---\nid: SPEC-001\nstatus: specifying\n---\n# ok\n');
    writeSpec('docs/domain/glossary.md', '---\ntype: domain\n---\n# terms\n');

    const node = nodeCoreVerdict();
    expect(node.errors).toBe(0);

    const py = runValidatePy();
    expect(py.code).toBe(0);
  });

  it.skipIf(!hasPy)('agrees with Node: a spec missing id: SPEC-NNN fails both', () => {
    writeSpec('specs/spec-001/spec.md', '---\nstatus: specifying\n---\n# no id\n');

    const node = nodeCoreVerdict();
    expect(node.errors).toBeGreaterThan(0);
    expect(node.offenders).toContain('specs/spec-001/spec.md');

    const py = runValidatePy();
    expect(py.code).toBe(1);
    expect(py.stderr).toContain('specs/spec-001/spec.md');
    expect(py.stderr).toContain('id: SPEC-NNN');
  });

  it.skipIf(!hasPy)('agrees with Node: a domain doc missing type: domain fails both', () => {
    writeSpec('docs/domain/glossary.md', '---\nstatus: draft\n---\n# terms\n');

    const node = nodeCoreVerdict();
    expect(node.errors).toBeGreaterThan(0);
    expect(node.offenders).toContain('docs/domain/glossary.md');

    const py = runValidatePy();
    expect(py.code).toBe(1);
    expect(py.stderr).toContain('docs/domain/glossary.md');
    expect(py.stderr).toContain('type: domain');
  });

  it.skipIf(!hasPy)('agrees with Node: an invalid id (SPEC-abc) fails both', () => {
    writeSpec('specs/spec-x/spec.md', '---\nid: SPEC-abc\n---\n# bad id\n');

    const node = nodeCoreVerdict();
    expect(node.errors).toBeGreaterThan(0);

    const py = runValidatePy();
    expect(py.code).toBe(1);
    expect(py.stderr).toContain('specs/spec-x/spec.md');
  });

  it.skipIf(!hasPy)('python parses an inline comment on id (id: SPEC-001 # note)', () => {
    writeSpec('specs/spec-001/spec.md', '---\nid: SPEC-001  # primary\n---\n# ok\n');

    const node = nodeCoreVerdict();
    expect(node.errors).toBe(0);

    const py = runValidatePy();
    expect(py.code).toBe(0);
  });
});
