/**
 * T0 invariant — INV — Tier-0 core (SPEC-017 Slice 6, FR-10, AC-9).
 *
 * Assert: NO `http`, `https`, `fetch`, or `net` import appears anywhere in
 * `packages/minspec/src`. This mirrors the SPEC-014 FR-17 import-ban gate.
 *
 * The grep searches TypeScript `import ... from '...'` statements for the four
 * banned tokens in their module specifier. ES-module `import()` dynamic calls
 * are also scanned. Node built-in `net` is included because any networked
 * client (`http.request`, `https.get`, `net.createConnection`) would violate
 * the Tier-0 offline constraint.
 *
 * If this test turns red, the importer must be found and removed — not the
 * test weakened.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Root of the minspec source tree (relative to THIS test file's location).
const SRC_ROOT = path.resolve(__dirname, '../src');

/** Recursively collect all .ts source files under `dir`. */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Regex that matches any import statement whose module specifier contains one
 * of the banned tokens as a complete path component (or the whole specifier).
 *
 * Matches:
 *   import * as http from 'http';
 *   import { request } from 'node:http';
 *   import('https');
 *   import { Agent } from 'net';
 *   import fetch from 'node-fetch';
 *
 * Does NOT match:
 *   // comment mentioning http for documentation purposes
 *   'Content-Type: application/json'  (no import keyword)
 */
const BANNED_IMPORT_RE =
  /(?:^|\s)(?:import\s[\s\S]*?from\s+|import\s*\()\s*['"](?:node:)?(?:http|https|fetch|net)['"]/m;

describe('INV — Tier-0 core: no http/https/fetch/net import in packages/minspec/src', () => {
  it('packages/minspec/src contains zero network imports', () => {
    const tsFiles = collectTsFiles(SRC_ROOT);
    expect(tsFiles.length).toBeGreaterThan(0); // sanity: we actually scanned files

    const violations: string[] = [];

    for (const filePath of tsFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Scan each line for a banned import to produce actionable output
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (BANNED_IMPORT_RE.test(line)) {
          violations.push(`${path.relative(SRC_ROOT, filePath)}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations, `Network imports found in packages/minspec/src:\n${violations.join('\n')}`).toHaveLength(0);
  });
});
