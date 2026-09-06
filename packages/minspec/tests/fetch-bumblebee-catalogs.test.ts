/**
 * T3 — fetch-bumblebee-catalogs.sh version-skew regression (#848).
 *
 * check-supply-chain.sh pins the bumblebee scanner binary to BUMBLEBEE_VERSION
 * (default: a checksum-pinned main SHA reading exposure schema 0.2.0 — DR-005/#866).
 * fetch-bumblebee-catalogs.sh fetched the exposure catalogs
 * from the upstream repo's default-branch HEAD with no version pin at all, so
 * the catalog schema could (and did) advance past what the pinned reader
 * supports — the scan then failed closed with "unsupported exposure catalog
 * schema_version" on every CI run, blocking `package` entirely.
 *
 * Fix: the catalog fetch is now pinned to `ref=$BUMBLEBEE_VERSION` (the same
 * variable, same default) — bumping the scanner and the catalog ref is one
 * change, not two independent ones that can drift apart. This test stubs `gh`
 * on PATH and asserts every threat_intel API call the shipped script makes
 * carries that ref — proving the version skew is no longer possible by
 * construction, not just plausible from reading the diff.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const FETCH_SCRIPT = path.resolve(__dirname, '../../../scripts/fetch-bumblebee-catalogs.sh');

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_GH_CALLS_LOG"
case "$1 $2" in
  "api repos/perplexityai/bumblebee/contents/threat_intel?ref=$BUMBLEBEE_VERSION")
    if [[ "$3" == "--jq" ]]; then
      echo "fake-catalog.json"
    fi
    ;;
  "api repos/perplexityai/bumblebee/contents/threat_intel/fake-catalog.json?ref=$BUMBLEBEE_VERSION")
    if [[ "$3" == "--jq" ]]; then
      base64 <<< '{"schema_version":"0.1.0"}'
    fi
    ;;
  *)
    echo "fake-gh: unhandled invocation: $*" >&2
    exit 1
    ;;
esac
`;

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

let scratch: string;
let binDir: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-bumblebee-scratch-'));
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-bumblebee-bin-'));
  writeExecutable(path.join(binDir, 'gh'), FAKE_GH);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
});

function runFetch(bumblebeeVersion: string): { calls: string[]; target: string } {
  const target = path.join(scratch, 'catalogs');
  const callsLog = path.join(scratch, 'gh-calls.log');
  fs.writeFileSync(callsLog, '');

  execFileSync('bash', [FETCH_SCRIPT, target], {
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      BUMBLEBEE_VERSION: bumblebeeVersion,
      FAKE_GH_CALLS_LOG: callsLog,
    },
    encoding: 'utf-8',
  });

  const calls = fs
    .readFileSync(callsLog, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  return { calls, target };
}

describe('fetch-bumblebee-catalogs.sh — pins catalog fetch to BUMBLEBEE_VERSION (#848)', () => {
  it('every threat_intel API call carries ref=$BUMBLEBEE_VERSION', () => {
    const { calls } = runFetch('v0.1.2');
    const threatIntelCalls = calls.filter((c) => c.includes('contents/threat_intel'));
    expect(threatIntelCalls.length).toBeGreaterThan(0);
    for (const call of threatIntelCalls) {
      expect(call).toContain('ref=v0.1.2');
    }
  });

  it('changing BUMBLEBEE_VERSION changes the pinned ref (no hardcoded default)', () => {
    const { calls } = runFetch('v9.9.9-different');
    const threatIntelCalls = calls.filter((c) => c.includes('contents/threat_intel'));
    expect(threatIntelCalls.length).toBeGreaterThan(0);
    for (const call of threatIntelCalls) {
      expect(call).toContain('ref=v9.9.9-different');
      expect(call).not.toContain('ref=v0.1.2');
    }
  });

  it('fetched catalog lands in the target dir', () => {
    const { target } = runFetch('v0.1.2');
    expect(fs.existsSync(path.join(target, 'fake-catalog.json'))).toBe(true);
  });

  const REPO_ROOT = path.resolve(__dirname, '../../..');
  const CHECK_SCRIPT = path.resolve(__dirname, '../../../scripts/check-supply-chain.sh');
  const CI_WORKFLOW = path.join(REPO_ROOT, '.github/workflows/ci.yml');
  const DAILY_WORKFLOW = path.join(REPO_ROOT, '.github/workflows/supply-chain-daily.yml');

  // Script defaults: `BUMBLEBEE_VERSION="${BUMBLEBEE_VERSION:-<pinned ref>}"` (a vX tag or a full SHA)
  const scriptDefaultOf = (file: string): string => {
    const m = fs
      .readFileSync(file, 'utf-8')
      .match(/BUMBLEBEE_VERSION="\$\{BUMBLEBEE_VERSION:-([^}"]+)\}"/);
    expect(m, `no BUMBLEBEE_VERSION default found in ${path.basename(file)}`).toBeTruthy();
    return m![1];
  };
  // yaml env value: `KEY: value   # comment` → 'value'
  const ymlEnvOf = (file: string, key: string): string | null => {
    const m = fs.readFileSync(file, 'utf-8').match(new RegExp(`^\\s*${key}:\\s*(\\S+)`, 'm'));
    return m ? m[1] : null;
  };

  // #850 review (Security blocking + Architect): the two scans have different needs,
  // resolved by decoupling the EXECUTED binary from the fetched catalog DATA.
  //   • The scanner BINARY is pinned EVERYWHERE — ci.yml, both scripts, and the daily
  //     job — so no scan ever `go install`s a floating `bumblebee@main`; a compromised
  //     upstream cannot execute code in a job holding GITHUB_TOKEN + `issues: write` (#850).
  //   • Only the daily scan's CATALOG ref floats (BUMBLEBEE_CATALOG_REF=main) for
  //     early-warning freshness; catalog data is read, not executed, so the blast radius
  //     is bounded to false results, and a schema advance past the pinned reader fails
  //     closed and is surfaced as a bump signal (#869), never executed.
  it('the executed bumblebee binary is pinned everywhere — ci.yml, scripts, AND daily (never floated)', () => {
    const binary = {
      'fetch-bumblebee-catalogs.sh': scriptDefaultOf(FETCH_SCRIPT),
      'check-supply-chain.sh': scriptDefaultOf(CHECK_SCRIPT),
      'ci.yml': ymlEnvOf(CI_WORKFLOW, 'BUMBLEBEE_VERSION'),
      'supply-chain-daily.yml': ymlEnvOf(DAILY_WORKFLOW, 'BUMBLEBEE_VERSION'),
    };
    // Every executed-binary reference must be IMMUTABLE — a pinned release tag
    // (vX...) OR a full 40-hex commit SHA. #850's requirement is "never floating"
    // (no `@main` that auto-pulls upstream code into a token-scoped job); a
    // checksum-pinned SHA is immutable + GOSUMDB-verified and meets that intent.
    // We use a SHA while no released tag reads exposure schema 0.2.0 (DR-005/#866).
    // A branch name (`main`) matches NEITHER pattern and is still rejected.
    for (const [where, ref] of Object.entries(binary)) {
      expect(ref, `no pinned bumblebee binary ref in ${where}`).toBeTruthy();
      expect(
        /^(v\d[\w.-]*|[0-9a-f]{40})$/.test(ref!),
        `${where} binary ref '${ref}' must be a pinned vX tag or a full commit SHA, not a floating ref`,
      ).toBe(true);
    }
    // ...and they must all agree — a single-sided bump re-opens the #836 schema break.
    const canonical = binary['check-supply-chain.sh'];
    expect(Object.values(binary).every((v) => v === canonical), JSON.stringify(binary)).toBe(true);
  });

  it('the daily scan floats ONLY the catalog data ref, never the executed binary (#850 security)', () => {
    const daily = fs.readFileSync(DAILY_WORKFLOW, 'utf-8');
    // Binary install reads the PINNED BUMBLEBEE_VERSION env, not a hardcoded/floating ref.
    expect(daily, 'daily binary install must use ${BUMBLEBEE_VERSION} (pinned)').toMatch(
      /bumblebee@\$\{BUMBLEBEE_VERSION\}/,
    );
    // Catalog ref floats independently — set on the daily job, and NOT a pinned tag.
    const catalogRef = ymlEnvOf(DAILY_WORKFLOW, 'BUMBLEBEE_CATALOG_REF');
    expect(catalogRef, 'daily must set BUMBLEBEE_CATALOG_REF to float catalogs').toBeTruthy();
    expect(
      /^v\d/.test(catalogRef!),
      `daily catalog ref '${catalogRef}' should track HEAD (a branch), not a pinned tag`,
    ).toBe(false);
    // The fetch script derives the catalog `ref=` from BUMBLEBEE_CATALOG_REF (data),
    // defaulting to BUMBLEBEE_VERSION (binary) — the decoupling that lets catalogs float
    // safely while the executed binary stays pinned.
    const fetch = fs.readFileSync(FETCH_SCRIPT, 'utf-8');
    expect(fetch, 'fetch script must default BUMBLEBEE_CATALOG_REF to BUMBLEBEE_VERSION').toMatch(
      /BUMBLEBEE_CATALOG_REF="\$\{BUMBLEBEE_CATALOG_REF:-\$BUMBLEBEE_VERSION\}"/,
    );
    expect(fetch, 'catalog fetch must use ref=${BUMBLEBEE_CATALOG_REF}').toMatch(
      /ref=\$\{BUMBLEBEE_CATALOG_REF\}/,
    );
    expect(fetch, 'catalog fetch must NOT ref off BUMBLEBEE_VERSION directly (that would re-couple)').not.toMatch(
      /ref=\$\{BUMBLEBEE_VERSION\}/,
    );
  });
});

// #850 review (adversarial re-verify, low): the exit-2 fail-closed contract is the
// SECURITY CORE of the fix — a scan ERROR (schema the pinned reader rejects) must exit 2
// (→ low-noise "bump" alert), a real FINDING must exit 1 (→ P1), a clean scan exit 0.
// String-literal pin tests can't catch a regression that mis-wires those codes; this
// stubs the scanner binary and exercises the real check-supply-chain.sh.
describe('check-supply-chain.sh — distinct exit codes: scan-error(2) vs finding(1) vs clean(0)', () => {
  const CHECK_SCRIPT = path.resolve(__dirname, '../../../scripts/check-supply-chain.sh');
  let scratch: string;
  let binDir: string;
  let catDir: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'csc-scratch-'));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csc-bin-'));
    catDir = path.join(scratch, 'catalogs');
    fs.mkdirSync(catDir);
    // A catalog file must exist or check-supply-chain.sh runs inventory-only (no findings path).
    fs.writeFileSync(path.join(catDir, 'cat.json'), '{"schema_version":"0.1.0"}');
  });
  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  // Fake bumblebee: parse --output-file, behave per FAKE_BB_MODE.
  const FAKE_BB = `#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do case "$1" in --output-file) out="$2"; shift 2;; *) shift;; esac; done
case "$FAKE_BB_MODE" in
  error)   echo "unsupported exposure catalog schema_version" >&2; exit 3;;
  finding) printf '%s\\n' '{"record_type":"package","name":"x"}' '{"record_type":"finding","name":"evil"}' > "$out"; exit 0;;
  *)       printf '%s\\n' '{"record_type":"package","name":"x"}' > "$out"; exit 0;;
esac
`;

  const runCheck = (mode: string): number => {
    const fakePath = path.join(binDir, 'bumblebee');
    fs.writeFileSync(fakePath, FAKE_BB);
    fs.chmodSync(fakePath, 0o755);
    try {
      execFileSync('sh', [CHECK_SCRIPT], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          BUMBLEBEE_BIN: fakePath,
          BUMBLEBEE_CATALOGS: catDir,
          FAKE_BB_MODE: mode,
        },
        cwd: scratch,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      return 0;
    } catch (e: unknown) {
      return (e as { status?: number }).status ?? -1;
    }
  };

  it('scan error (scanner exits non-zero) → exit 2, NOT 1 (a schema advance is never filed as a finding)', () => {
    expect(runCheck('error')).toBe(2);
  });
  it('a real finding record → exit 1', () => {
    expect(runCheck('finding')).toBe(1);
  });
  it('clean scan → exit 0', () => {
    expect(runCheck('clean')).toBe(0);
  });

  const runInstallCase = (goBin: string, overrides?: { PATH?: string; HOME?: string }): number => {
    try {
      execFileSync('sh', [CHECK_SCRIPT], {
        env: {
          PATH: overrides?.PATH ?? process.env.PATH,
          HOME: overrides?.HOME ?? process.env.HOME,
          BUMBLEBEE_BIN: path.join(scratch, 'no-such-bumblebee'),
          GO_BIN: goBin,
          BUMBLEBEE_CATALOGS: catDir,
        },
        cwd: scratch,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      return 0;
    } catch (e: unknown) {
      return (e as { status?: number }).status ?? -1;
    }
  };

  /**
   * A PATH carrying only what the script needs before it looks for Go — deliberately no
   * `go`. Needed since #1506: resolution now consults `command -v go`, so inheriting the
   * real PATH means "no toolchain" is only true on a machine that happens to lack one.
   * That is exactly how this suite passed locally and failed on CI, where the runner has
   * Go installed: the script resolved it and went on to a real `go install`, which hung
   * past the 5s timeout instead of exiting 2.
   */
  const pathWithoutGo = (): string => {
    const dir = fs.mkdtempSync(path.join(scratch, 'nogo-bin-'));
    for (const tool of ['git', 'date', 'sh', 'mkdir', 'ls', 'rm', 'sort', 'tail', 'uname']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout.trim();
      if (found) {
        try {
          fs.symlinkSync(found, path.join(dir, tool));
        } catch {
          /* already linked */
        }
      }
    }
    return dir;
  };

  it('missing bumblebee + FAILING Go install → exit 2 (could-not-run, not a finding)', () => {
    const goFail = path.join(binDir, 'go');
    fs.writeFileSync(goFail, '#!/usr/bin/env bash\nexit 1\n');
    fs.chmodSync(goFail, 0o755);
    expect(runInstallCase(goFail)).toBe(2);
  });

  it('missing bumblebee + MISSING Go toolchain → exit 2', () => {
    // "Missing" must now mean missing EVERYWHERE the resolver looks (#1506): an
    // unusable $GO_BIN, no `go` on PATH, and no legacy $HOME/.local/opt/go*/bin/go.
    // A scratch HOME covers the third.
    const emptyHome = fs.mkdtempSync(path.join(scratch, 'nogo-home-'));
    expect(
      runInstallCase(path.join(scratch, 'no-such-go'), {
        PATH: pathWithoutGo(),
        HOME: emptyHome,
      }),
    ).toBe(2);
  });
});
