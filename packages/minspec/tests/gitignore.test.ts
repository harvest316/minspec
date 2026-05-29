/**
 * T2 — Feature tests: ensureGitignoreEntries
 *
 * Issue #1: `minspec init` should add session/calibration to .gitignore
 * so users don't commit ephemeral data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  ensureGitignoreEntries,
  MINSPEC_GITIGNORE_MARKER,
  MINSPEC_GITIGNORE_ENTRIES,
} from '../src/lib/scaffold';
import { generateHarnessFiles } from '../src/lib/scaffold';

describe('ensureGitignoreEntries()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-gitignore-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .gitignore with marker and entries if missing', () => {
    ensureGitignoreEntries(tmpDir);

    const gitignorePath = path.join(tmpDir, '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain(MINSPEC_GITIGNORE_MARKER);
    for (const entry of MINSPEC_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  it('appends marker block to existing .gitignore without entries', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    const existing = 'node_modules\ndist\n';
    fs.writeFileSync(gitignorePath, existing);

    ensureGitignoreEntries(tmpDir);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    expect(content.startsWith(existing)).toBe(true);
    expect(content).toContain(MINSPEC_GITIGNORE_MARKER);
    for (const entry of MINSPEC_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  it('does not duplicate marker block on second run', () => {
    ensureGitignoreEntries(tmpDir);
    ensureGitignoreEntries(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    const markerCount = content.split(MINSPEC_GITIGNORE_MARKER).length - 1;
    expect(markerCount).toBe(1);

    for (const entry of MINSPEC_GITIGNORE_ENTRIES) {
      const occurrences = content.split('\n').filter((line) => line.trim() === entry).length;
      expect(occurrences, `entry ${entry} should appear exactly once`).toBe(1);
    }
  });

  it('does not re-add entries already present (user added them manually)', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    const existing =
      'node_modules\n' + MINSPEC_GITIGNORE_ENTRIES.map((e) => e).join('\n') + '\n';
    fs.writeFileSync(gitignorePath, existing);

    ensureGitignoreEntries(tmpDir);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    for (const entry of MINSPEC_GITIGNORE_ENTRIES) {
      const occurrences = content.split('\n').filter((line) => line.trim() === entry).length;
      expect(occurrences, `entry ${entry} should appear exactly once`).toBe(1);
    }
  });

  it('preserves existing .gitignore content verbatim', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    const existing = 'node_modules\n.env\n\n# user comment\nbuild/\n';
    fs.writeFileSync(gitignorePath, existing);

    ensureGitignoreEntries(tmpDir);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    expect(content.startsWith(existing)).toBe(true);
  });

  it('handles .gitignore without trailing newline', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules');

    ensureGitignoreEntries(tmpDir);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('node_modules');
    expect(content).toContain(MINSPEC_GITIGNORE_MARKER);
    // Marker block should be separated from previous content by a newline
    const idx = content.indexOf(MINSPEC_GITIGNORE_MARKER);
    expect(content[idx - 1]).toBe('\n');
  });

  it('adds only the missing entries when some already present', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, `node_modules\n${MINSPEC_GITIGNORE_ENTRIES[0]}\n`);

    ensureGitignoreEntries(tmpDir);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    for (const entry of MINSPEC_GITIGNORE_ENTRIES) {
      const occurrences = content.split('\n').filter((line) => line.trim() === entry).length;
      expect(occurrences, `entry ${entry} should appear exactly once`).toBe(1);
    }
  });
});

describe('generateHarnessFiles() — gitignore integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-init-gitignore-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('init creates .gitignore with MinSpec ephemeral entries', () => {
    generateHarnessFiles(tmpDir);

    const gitignorePath = path.join(tmpDir, '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('.minspec/session.json');
    expect(content).toContain('.minspec/calibration.json');
  });

  it('init preserves existing .gitignore content', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    const existing = 'node_modules\ndist\n';
    fs.writeFileSync(gitignorePath, existing);

    generateHarnessFiles(tmpDir);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('node_modules');
    expect(content).toContain('dist');
    expect(content).toContain('.minspec/session.json');
  });
});
