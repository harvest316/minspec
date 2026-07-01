/**
 * INV-DEGRADE — buildArtifactGraph never throws on an empty / missing / partial
 * workspace; it returns a well-formed (possibly empty) graph and the resolver
 * yields null (a clean empty queue). The signpost must degrade gracefully, never
 * crash the thread.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { buildArtifactGraph } from '../src/lib/artifact-graph';
import { resolveNextTask } from '@aiclarity/shared';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-degrade-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('INV-DEGRADE: missing / empty / partial workspace', () => {
  it('empty dir → empty graph, no throw, resolver null', () => {
    const g = buildArtifactGraph(root);
    expect(g).toEqual({ epics: [], specs: [], adrs: [] });
    expect(g.edges).toBeUndefined();
    expect(resolveNextTask(g)).toBeNull();
  });

  it('partial workspace (only docs/epics exists) → no throw, partial graph', () => {
    fs.mkdirSync(path.join(root, 'docs', 'epics'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'docs', 'epics', 'EPIC-001-a.md'),
      ['---', 'id: EPIC-001', 'slug: a', 'title: a', 'status: proposed', 'order: 1', '---', '', '# EPIC-001'].join('\n'),
      'utf-8',
    );
    const g = buildArtifactGraph(root);
    expect(g.epics).toHaveLength(1);
    expect(g.specs).toEqual([]);
    expect(g.adrs).toEqual([]);
    expect(() => resolveNextTask(g)).not.toThrow();
  });

  it('a non-existent root path → empty graph, no throw', () => {
    const missing = path.join(root, 'does', 'not', 'exist');
    expect(() => buildArtifactGraph(missing)).not.toThrow();
    expect(buildArtifactGraph(missing)).toEqual({ epics: [], specs: [], adrs: [] });
  });
});
