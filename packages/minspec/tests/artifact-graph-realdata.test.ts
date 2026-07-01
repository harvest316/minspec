/**
 * INV-REALDATA — buildArtifactGraph on THIS repo's real docs/epics + specs +
 * decisions returns a non-empty graph, and resolveNextTask returns a plausible
 * task (or a clean null). Smoke test against ground truth; skips gracefully if
 * the real dirs are absent (so it never false-fails in a stripped checkout).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { buildArtifactGraph } from '../src/lib/artifact-graph';
import { resolveNextTask, type NextTask, type SeverityClass } from '@aiclarity/shared';

// Repo root from the worktree: packages/minspec/tests → up three.
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const hasRealData =
  fs.existsSync(path.join(repoRoot, 'docs', 'epics')) &&
  fs.existsSync(path.join(repoRoot, 'specs')) &&
  fs.existsSync(path.join(repoRoot, 'docs', 'decisions'));

const ID_RE = /^(SPEC|DR|EPIC)-\d+$/;
const SEVERITY_CLASSES: SeverityClass[] = ['gate-violation', 'blocked-ready', 'promote-parent', 'pending'];

describe.skipIf(!hasRealData)('INV-REALDATA: graph over the real repo', () => {
  it('produces a non-empty graph with real epics + specs + ADRs + edges', () => {
    const g = buildArtifactGraph(repoRoot);
    expect(g.epics.length).toBeGreaterThanOrEqual(9); // EPIC-001..009
    expect(g.specs.length).toBeGreaterThan(0);
    expect(g.adrs.length).toBeGreaterThan(0);
    expect(g.edges && g.edges.length).toBeGreaterThan(0); // real depends_on/relates_to arrays
  });

  it('resolveNextTask returns null OR a well-formed, plausible task — never throws', () => {
    const g = buildArtifactGraph(repoRoot);
    let task: NextTask | null = null;
    expect(() => { task = resolveNextTask(g); }).not.toThrow();
    if (task !== null) {
      const t: NextTask = task;
      expect(['epic-promote', 'spec-approve', 'adr-accept', 'phase-action']).toContain(t.kind);
      expect(t.imperative.length).toBeGreaterThan(0);
      expect(SEVERITY_CLASSES).toContain(t.severityClass);
      expect(t.targetId).toMatch(ID_RE);
    }
  });
});
