/**
 * T0 invariant — INV — Tier-0 network-import ban, repo-wide (SPEC-017 Slice 6,
 * FR-10, AC-9; scope widened per #1511).
 *
 * Assert: NO `http`, `https`, `fetch`, or `net` import appears anywhere in a
 * workspace package's `src/` tree that has been classified Tier-0 below.
 *
 * ORIGINAL BUG (#1511): this gate's root was hardcoded to
 * `packages/minspec/src` alone. `packages/shared` — the designated home for
 * cross-package contract types, itself documented as "no vscode/network" —
 * had no equivalent gate, so a network import landing there would pass every
 * test in the repo. The only assertion that existed for `packages/shared` was
 * `packages/shared/tests/trust-model.test.ts`, scoped to one file
 * (`trust-model.ts`), not the tree.
 *
 * FIX: the scan is now driven by the actual `packages/*` workspace listing
 * (`collectWorkspacePackages`), not a hand-maintained path. Every discovered
 * package with a `src/` tree MUST be explicitly classified below as either
 * `TIER0_BANNED_ROOTS` (scanned, zero network imports allowed) or
 * `EXEMPT_ROOTS` (deliberately out of scope, with a stated reason). A new
 * workspace package with a `src/` tree that is in neither list fails the
 * "every discovered src tree is classified" test below — the missing
 * classification is what reddens, not an import, so the gap can never again
 * go unnoticed the way `packages/shared` did.
 *
 * The grep searches TypeScript `import ... from '...'` statements for the four
 * banned tokens in their module specifier. ES-module `import()` dynamic calls
 * are also scanned. Node built-in `net` is included because any networked
 * client (`http.request`, `https.get`, `net.createConnection`) would violate
 * the Tier-0 offline constraint.
 *
 * If a banned-root scan turns red, the importer must be found and removed —
 * not the test weakened.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Repo root (relative to THIS test file's location: packages/minspec/tests/).
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

/**
 * Workspace packages that are Tier-0 (or documented as such) and therefore
 * MUST NOT contain a network import anywhere in `src/`.
 *
 *   - minspec: the extension itself — must run fully offline (constitution
 *     invariant 1).
 *   - shared:  `@aiclarity/shared` — cross-package contract types, documented
 *     in CLAUDE.md as "Tier-0 shared: contract types (no vscode/network)".
 */
const TIER0_BANNED_ROOTS = ['minspec', 'shared'];

/**
 * Workspace packages with a `src/` tree that are deliberately EXEMPT from the
 * ban, with the reason recorded so the exemption is a visible decision, not a
 * silent gap.
 */
const EXEMPT_ROOTS: Record<string, string> = {
  broker:
    'vendor OIDC review-broker (SPEC-034) — a Cloudflare Worker whose entire ' +
    'job is network I/O (exchanging a GitHub Actions OIDC token for an App ' +
    'installation token). Never shipped in the vsix, explicitly not Tier-0. ' +
    "See packages/broker/package.json's description.",
};

/** One workspace package directory under `packages/`, with its `src/` path if present. */
interface WorkspacePackage {
  name: string;
  srcDir: string | null;
}

/** Discover every `packages/*` workspace package and whether it has a `src/` tree. */
function collectWorkspacePackages(): WorkspacePackage[] {
  return fs
    .readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const srcDir = path.join(PACKAGES_DIR, entry.name, 'src');
      return {
        name: entry.name,
        srcDir: fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory() ? srcDir : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

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
 *   import('node:net');
 *
 * Does NOT match (by design):
 *   import fetch from 'node-fetch';   ← a 3rd-party network *package*, not a core
 *                                       module / global; barred by the no-new-dependency
 *                                       rule + dep audit, not this core-import regex.
 *   // comment mentioning http for documentation purposes
 *   'Content-Type: application/json'  (no import keyword)
 *
 * This issue (#1511) does not change the regex or what it matches — only how
 * many `src/` trees it is run against.
 */
const BANNED_IMPORT_RE =
  /(?:^|\s)(?:import\s[\s\S]*?from\s+|import\s*\()\s*['"](?:node:)?(?:http|https|fetch|net)['"]/m;

/** Scan every .ts file under `srcRoot` and return one description string per violating line. */
function scanForBannedImports(srcRoot: string): string[] {
  const violations: string[] = [];
  for (const filePath of collectTsFiles(srcRoot)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (BANNED_IMPORT_RE.test(line)) {
        violations.push(`${path.relative(srcRoot, filePath)}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return violations;
}

const workspacePackages = collectWorkspacePackages();
const packagesWithSrc = workspacePackages.filter((pkg) => pkg.srcDir !== null);

describe('INV — Tier-0 network-import ban covers every classified workspace src tree', () => {
  it('every workspace package with a src/ tree is classified banned or exempt', () => {
    expect(packagesWithSrc.length).toBeGreaterThan(0); // sanity: we actually found packages

    const unclassified = packagesWithSrc
      .map((pkg) => pkg.name)
      .filter((name) => !TIER0_BANNED_ROOTS.includes(name) && !(name in EXEMPT_ROOTS));

    expect(
      unclassified,
      `packages/${unclassified.join(', packages/')} have a src/ tree but are neither in ` +
        'TIER0_BANNED_ROOTS nor EXEMPT_ROOTS in tier0-import-ban.test.ts. Classify the new ' +
        'package: add it to TIER0_BANNED_ROOTS if it must stay offline, or to EXEMPT_ROOTS ' +
        'with a stated reason if network is a deliberate part of its job.',
    ).toEqual([]);
  });

  // Every banned root name must correspond to a real, discovered src/ tree —
  // catches a stale entry (renamed/removed package) silently going unscanned.
  for (const rootName of TIER0_BANNED_ROOTS) {
    it(`banned root "${rootName}" exists and has a src/ tree`, () => {
      const pkg = workspacePackages.find((p) => p.name === rootName);
      expect(pkg, `TIER0_BANNED_ROOTS references "${rootName}", which is not a packages/* workspace`).toBeDefined();
      expect(
        pkg!.srcDir,
        `TIER0_BANNED_ROOTS references "${rootName}", which has no src/ tree`,
      ).not.toBeNull();
    });
  }

  for (const rootName of TIER0_BANNED_ROOTS) {
    const srcDir = path.join(PACKAGES_DIR, rootName, 'src');

    it(`packages/${rootName}/src contains zero network imports`, () => {
      const tsFiles = collectTsFiles(srcDir);
      expect(tsFiles.length).toBeGreaterThan(0); // sanity: we actually scanned files

      const violations = scanForBannedImports(srcDir);
      expect(
        violations,
        `Network imports found in packages/${rootName}/src:\n${violations.join('\n')}`,
      ).toHaveLength(0);
    });

    it(`a planted network import in packages/${rootName}/src fails the check`, () => {
      const canaryPath = path.join(srcDir, '__tier0_import_ban_canary__.ts');
      expect(fs.existsSync(canaryPath), `canary file already exists at ${canaryPath}`).toBe(false);

      fs.writeFileSync(canaryPath, "import * as https from 'https';\nexport {};\n", 'utf-8');
      try {
        const violations = scanForBannedImports(srcDir);
        expect(
          violations.some((v) => v.startsWith('__tier0_import_ban_canary__.ts:')),
          `planted network import in packages/${rootName}/src was not detected:\n${violations.join('\n')}`,
        ).toBe(true);
      } finally {
        fs.rmSync(canaryPath, { force: true });
      }
    });
  }
});
