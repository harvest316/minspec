/**
 * #249 / DR-037 — Whole-file template class.
 *
 * Whole-file templates are non-Markdown harness artifacts (the CI workflow YAML)
 * that the section-merge engine cannot carry. They are scaffolded once and, on
 * Refresh, reconciled as a single opaque unit against a recorded content baseline:
 *   - scaffolded once at init,
 *   - refresh PRESERVES a user-edited file (drift),
 *   - refresh UPDATES an unmodified file (clean),
 *   - refresh RE-SCAFFOLDS a deleted file.
 *
 * The first registered whole-file template is .github/workflows/minspec-validate.yml.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { generateHarnessFiles, refreshHarnessFiles } from '../src/lib/scaffold';
import {
  WHOLE_FILE_TEMPLATES,
  computeWholeFileBaseline,
  WHOLE_FILE_BASELINE_HEADING,
} from '../src/lib/template-registry';
import { hashSection } from '../src/lib/merge-refresh';

const WORKFLOW_PATH = '.github/workflows/minspec-validate.yml';

describe('whole-file template registry (#249)', () => {
  it('registers minspec-validate.yml as the first whole-file template', () => {
    const first = WHOLE_FILE_TEMPLATES[0];
    expect(first).toBeDefined();
    expect(first.name).toBe('minspec-validate.yml');
    expect(first.outputPath).toBe(WORKFLOW_PATH);
    expect(first.content.length).toBeGreaterThan(0);
  });

  it('the workflow is valid YAML invoking MinSpec validation', () => {
    const yaml = WHOLE_FILE_TEMPLATES[0].content;

    // Structural YAML sanity (no parser dependency): YAML forbids hard tabs for
    // indentation, and a GitHub Actions workflow needs name / on / jobs.
    expect(yaml).not.toMatch(/\t/);
    expect(yaml).toMatch(/^name:\s*.+$/m);
    expect(yaml).toMatch(/^on:\s*$/m);
    expect(yaml).toMatch(/^jobs:\s*$/m);

    // Indentation is consistent (every indented line uses spaces only).
    for (const line of yaml.split('\n')) {
      const indent = line.match(/^(\s*)/)?.[1] ?? '';
      expect(indent.includes('\t')).toBe(false);
    }

    // It actually runs the MinSpec validator (the post-push gate, DR-037).
    expect(yaml).toMatch(/push:/);
    expect(yaml).toMatch(/pull_request:/);
    expect(yaml).toMatch(/@aiclarity\/minspec-validator/);
  });

  it('computeWholeFileBaseline hashes content under the synthetic heading', () => {
    const baseline = computeWholeFileBaseline();
    const recorded = baseline[WORKFLOW_PATH]?.[WHOLE_FILE_BASELINE_HEADING];
    expect(recorded).toBe(hashSection(WHOLE_FILE_TEMPLATES[0].content));
  });
});

describe('whole-file template scaffolding (#249)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-wholefile-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('init scaffolds the workflow file', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, WORKFLOW_PATH);
    expect(fs.existsSync(full)).toBe(true);
    expect(fs.readFileSync(full, 'utf-8')).toBe(WHOLE_FILE_TEMPLATES[0].content);
  });

  it('init records a whole-file baseline', () => {
    generateHarnessFiles(tmpDir);
    const baselinePath = path.join(tmpDir, '.minspec', 'whole-file-baseline.json');
    expect(fs.existsSync(baselinePath)).toBe(true);
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    expect(baseline[WORKFLOW_PATH]?.[WHOLE_FILE_BASELINE_HEADING]).toBe(
      hashSection(WHOLE_FILE_TEMPLATES[0].content),
    );
  });

  it('init does not overwrite a pre-existing workflow file', () => {
    const full = path.join(tmpDir, WORKFLOW_PATH);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const userContent = 'name: my own workflow\non: push\n';
    fs.writeFileSync(full, userContent);

    generateHarnessFiles(tmpDir);

    expect(fs.readFileSync(full, 'utf-8')).toBe(userContent);
  });

  it('refresh preserves a user-edited workflow (drift)', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, WORKFLOW_PATH);

    const edited =
      fs.readFileSync(full, 'utf-8') + '\n      - name: extra step\n        run: echo hi\n';
    fs.writeFileSync(full, edited);

    refreshHarnessFiles(tmpDir);

    // No Markdown merge, no reassembly — the user's bytes are preserved verbatim.
    expect(fs.readFileSync(full, 'utf-8')).toBe(edited);
  });

  it('refresh updates an unmodified workflow (clean) to the current template', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, WORKFLOW_PATH);

    // Simulate the bundled template having moved upstream since this project was
    // scaffolded: rewrite the on-disk file to an OLD clean baseline, and record
    // that old hash as the baseline. Refresh must then carry the current template
    // forward because the file == its recorded baseline (untouched by the user).
    const oldClean = 'name: MinSpec Validate (old)\non:\n  push:\njobs: {}\n';
    fs.writeFileSync(full, oldClean);
    const baselinePath = path.join(tmpDir, '.minspec', 'whole-file-baseline.json');
    fs.writeFileSync(
      baselinePath,
      JSON.stringify(
        { [WORKFLOW_PATH]: { [WHOLE_FILE_BASELINE_HEADING]: hashSection(oldClean) } },
        null,
        2,
      ) + '\n',
    );

    refreshHarnessFiles(tmpDir);

    expect(fs.readFileSync(full, 'utf-8')).toBe(WHOLE_FILE_TEMPLATES[0].content);
  });

  it('refresh re-scaffolds a deleted workflow', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, WORKFLOW_PATH);
    fs.unlinkSync(full);
    expect(fs.existsSync(full)).toBe(false);

    refreshHarnessFiles(tmpDir);

    expect(fs.existsSync(full)).toBe(true);
    expect(fs.readFileSync(full, 'utf-8')).toBe(WHOLE_FILE_TEMPLATES[0].content);
  });

  it('refresh on an unchanged scaffold is a no-op (idempotent)', () => {
    generateHarnessFiles(tmpDir);
    const full = path.join(tmpDir, WORKFLOW_PATH);
    const before = fs.readFileSync(full, 'utf-8');

    refreshHarnessFiles(tmpDir);

    expect(fs.readFileSync(full, 'utf-8')).toBe(before);
  });

  it('refresh preserves an existing file when no baseline was ever recorded', () => {
    // Project predating the whole-file mechanism: the file exists but there is no
    // baseline to prove it is untouched. Refresh must NOT clobber it.
    const full = path.join(tmpDir, WORKFLOW_PATH);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const userContent = 'name: legacy hand-written workflow\non: push\n';
    fs.writeFileSync(full, userContent);
    // Initialize .minspec without ever writing a whole-file baseline for this path.
    fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.minspec', 'config.json'), '{}\n');

    refreshHarnessFiles(tmpDir);

    expect(fs.readFileSync(full, 'utf-8')).toBe(userContent);
  });
});
