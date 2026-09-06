/**
 * check-supply-chain.sh — Go toolchain resolution (#1506).
 *
 * The gate previously read one hardcoded, version-pinned path
 * (`$HOME/.local/opt/go1.26.3/bin/go`). A toolchain that was present, correct, and on
 * `PATH` was therefore invisible to it, and it exited 2 ("could not run") on a properly
 * provisioned machine — which pushes operators toward the `SKIP_SUPPLY_CHAIN_CHECK=1`
 * bypass the script advertises in its own header. That is the cost being defended here.
 *
 * WHAT THESE ASSERT, AND WHY NOT THE EXIT CODE. An earlier attempt at this test asserted
 * the script exits 0 once `go` is on `PATH`. That cannot pass and is not what the issue
 * asks: resolution is only reached when bumblebee is absent, and immediately afterwards
 * the script runs `go install …`, which needs the network. Correct resolution therefore
 * still ends at exit 2 — at the *install* branch, not the *not-found* branch. So these
 * tests distinguish the two branches by their messages, and identify WHICH binary was
 * chosen from a shim that records its own path. No network, no real Go.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-supply-chain.sh');

let tmpRoot: string;

/** A minimal PATH: only the tools the script reaches before resolution, never `go`. */
let basePathDir: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-go-'));
  basePathDir = path.join(tmpRoot, 'basebin');
  fs.mkdirSync(basePathDir, { recursive: true });
  // The script calls `git rev-parse` and `date` before it ever looks for Go. Link just
  // those, so `command -v go` is genuinely a miss rather than accidentally finding a
  // real toolchain from the developer's own PATH.
  for (const tool of ['git', 'date', 'sh', 'uname', 'mkdir', 'ls', 'rm', 'sort', 'tail']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout.trim();
    if (found) {
      try {
        fs.symlinkSync(found, path.join(basePathDir, tool));
      } catch {
        /* already linked */
      }
    }
  }
});

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/**
 * A stand-in for the Go toolchain that records the path it was invoked as, then fails.
 * Failing is deliberate: it stops the script at the `install failed` branch instead of
 * letting it march on into a real network install.
 */
function makeGoShim(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'go');
  // Writes to $GO_SHIM_LOG, supplied per-run by runScript(), rather than a path baked in
  // at creation. Baking it in meant every shim logged somewhere the reader never looked,
  // so "which binary ran" silently read as "none ran".
  fs.writeFileSync(shim, `#!/bin/sh\necho "$0" >> "\${GO_SHIM_LOG:-/dev/null}"\nexit 1\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

interface RunResult {
  status: number | null;
  stderr: string;
  invoked: string[];
}

function runScript(opts: { home: string; pathDirs: string[]; goBin?: string }): RunResult {
  const logFile = path.join(tmpRoot, `invoked-${Math.random().toString(36).slice(2)}.log`);
  const env: NodeJS.ProcessEnv = {
    HOME: opts.home,
    PATH: [...opts.pathDirs, basePathDir].join(':'),
    GO_SHIM_LOG: logFile,
  };
  if (opts.goBin !== undefined) env.GO_BIN = opts.goBin;

  const r = spawnSync('sh', [SCRIPT], { env, encoding: 'utf-8', cwd: tmpRoot });
  let invoked: string[] = [];
  try {
    invoked = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
  } catch {
    /* shim never ran */
  }
  return { status: r.status, stderr: r.stderr ?? '', invoked };
}

/** A fresh HOME with no bumblebee, so the install block — and thus resolution — is reached. */
function freshHome(name: string): string {
  const home = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(home, 'go', 'bin'), { recursive: true });
  return home;
}

describe('resolve_go_bin — a toolchain on PATH must not be invisible (#1506)', () => {
  it('falls back to `go` on PATH when the legacy hardcoded location does not exist', () => {
    const home = freshHome('path-fallback');
    const shimDir = path.join(tmpRoot, 'path-fallback-bin');
    makeGoShim(shimDir);

    const r = runScript({ home, pathDirs: [shimDir] });

    // The defect: this used to print "Go toolchain not found" and exit before any
    // attempt, even though `go` was right there on PATH.
    expect(r.stderr).not.toContain('no Go toolchain found');
    expect(r.stderr).toContain('installing bumblebee');
    expect(r.stderr).toContain(path.join(shimDir, 'go'));
  });

  it('uses an explicit $GO_BIN in preference to a different toolchain on PATH', () => {
    const home = freshHome('override');
    const explicitDir = path.join(tmpRoot, 'override-explicit');
    const pathDir = path.join(tmpRoot, 'override-path');
    const explicit = makeGoShim(explicitDir);
    makeGoShim(pathDir);

    const r = runScript({ home, pathDirs: [pathDir], goBin: explicit });

    // Identify the winner by which shim actually ran, not by parsing prose.
    expect(r.invoked.length).toBeGreaterThan(0);
    expect(r.invoked[0]).toBe(explicit);
    expect(r.invoked[0]).not.toContain('override-path');
  });

  it('still honours the legacy $HOME/.local/opt/go*/bin/go, so old setups do not regress', () => {
    const home = freshHome('legacy');
    const legacyDir = path.join(home, '.local', 'opt', 'go1.99.0', 'bin');
    const legacy = makeGoShim(legacyDir);

    // No $GO_BIN and no `go` on PATH — only the legacy location can satisfy this.
    const r = runScript({ home, pathDirs: [] });

    expect(r.stderr).not.toContain('no Go toolchain found');
    expect(r.stderr).toContain(legacy);
  });

  it('fails closed, and names every location it tried, when nothing resolves', () => {
    const home = freshHome('nothing');
    const r = runScript({ home, pathDirs: [] });

    expect(r.status).toBe(2); // "could not run" — an infra condition, never a finding
    expect(r.stderr).toContain('no Go toolchain found');
    // The old message named a single path, which is why it read as "install Go" to
    // someone who already had it. The replacement must show the search that was done.
    expect(r.stderr).toContain('$GO_BIN');
    expect(r.stderr).toContain('go on $PATH');
    expect(r.stderr).toContain('.local/opt/go');
    expect(r.stderr).toContain('exit 2');
  });

  it('ignores a $GO_BIN that is set but not executable, rather than failing outright', () => {
    const home = freshHome('bad-override');
    const shimDir = path.join(tmpRoot, 'bad-override-bin');
    makeGoShim(shimDir);
    const bogus = path.join(tmpRoot, 'not-a-real-go');
    fs.writeFileSync(bogus, 'not executable');
    fs.chmodSync(bogus, 0o644);

    const r = runScript({ home, pathDirs: [shimDir], goBin: bogus });

    // An unusable override must not mask a perfectly good toolchain on PATH.
    expect(r.stderr).not.toContain('no Go toolchain found');
    expect(r.stderr).toContain(path.join(shimDir, 'go'));
  });
});
