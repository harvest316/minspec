import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { specHash } from '@aiclarity/shared';

// ─────────────────────────────────────────────────────────────────────────────
// INV-2 (cross-impl hash agreement) / AC-5. T0 — written before the gate twin
// depends on the Python module.
//
// The canonical hash of EVERY spec in `specs/` must be byte-identical across the
// Node module (`@aiclarity/shared` specHash) and the Python twin
// (`scripts/hooks/canonical.py --hash`). This genuinely shells out to python3 and
// compares file-by-file — it does NOT trust the two prose impls to agree.
//
// If python3 is absent the test SKIPS with a logged warning (mirrors the old
// approval.test.ts sha256sum skip) so local non-Python dev is not blocked. On CI
// (and this container — python3 3.12 is present) it MUST run and pass. The test
// is NEVER weakened or stubbed: a skip is only legitimate when python3 truly
// cannot be invoked.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SPECS_DIR = path.join(REPO_ROOT, 'specs');
const CANONICAL_PY = path.join(REPO_ROOT, 'scripts', 'hooks', 'canonical.py');

function python3Available(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function walkMd(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(full));
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function pythonHash(file: string): string {
  return execFileSync('python3', [CANONICAL_PY, '--hash', file], {
    encoding: 'utf-8',
  }).trim();
}

describe('INV-2 — Node ≡ Python canonical hash over the whole specs/ corpus (AC-5)', () => {
  const hasPython = python3Available();
  const specFiles = walkMd(SPECS_DIR);

  it('the specs/ corpus is non-empty', () => {
    expect(specFiles.length).toBeGreaterThan(0);
  });

  if (!hasPython) {
    it.skip('python3 unavailable — corpus parity skipped (CI always has python3)', () => {
      console.warn('SKIP: python3 not found; INV-2 corpus parity not verified locally.');
    });
    return;
  }

  for (const file of specFiles) {
    const rel = path.relative(REPO_ROOT, file);
    it(`hashes agree for ${rel}`, () => {
      const raw = fs.readFileSync(file, 'utf-8');
      const nodeHash = specHash(raw);
      const pyHash = pythonHash(file);
      expect(pyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(nodeHash).toBe(pyHash);
    });
  }
});
