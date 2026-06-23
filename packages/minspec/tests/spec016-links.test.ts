import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * T3 regression — harvest316/minspec#166.
 *
 * SPEC-016 reality-check linked to the old `specs/minspec/epic-backfill/`
 * directory, which the #83 spec-directory renumbering moved to
 * `specs/minspec/SPEC-011-epic-backfill/`. The relative markdown link went
 * stale (dead-ended on disk) because nothing re-pointed cross-spec links when
 * the directory was renamed.
 *
 * This guards every relative markdown link in SPEC-016's requirements against
 * silently dead-ending again. It scans committed markdown (not behaviour), the
 * same discipline as positioning-docs.test.ts.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SPEC016 = path.join(
  REPO_ROOT,
  'specs',
  'agent-execute',
  'SPEC-016-reality-check',
  'requirements.md',
);

function relativeLinkTargets(md: string): string[] {
  const targets: string[] = [];
  // [text](target) — capture markdown link targets.
  const re = /\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    let target = m[1].trim();
    // Strip any trailing "title" and a #fragment / ?query.
    target = target.split(/\s+/)[0];
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    // Only check on-disk relative links (skip http(s):, mailto:, absolute).
    if (/^[a-z]+:/i.test(target)) continue;
    if (target.startsWith('/')) continue;
    targets.push(target);
  }
  return targets;
}

describe('SPEC-016 reality-check — relative links resolve on disk (#166)', () => {
  const md = fs.readFileSync(SPEC016, 'utf-8');
  const targets = relativeLinkTargets(md);
  const specDir = path.dirname(SPEC016);

  it('has relative links to check', () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  it.each(targets)('relative link resolves: %s', (target) => {
    const resolved = path.resolve(specDir, target);
    expect(fs.existsSync(resolved), `link target does not exist: ${target}`).toBe(true);
  });
});
