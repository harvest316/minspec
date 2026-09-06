/**
 * T0 — the DR-086 autonomy gate is WIRED into both unattended merge actors (#1614).
 *
 * Root cause this suite pins: `scripts/lib/autonomy.ts` was complete and fully
 * unit-tested, and `mayProceed` had ZERO production call sites — it was called only
 * from its own test file. The mechanism existed and nothing asked it anything, so
 * the `autonomy` setting was inert: `dispatch-issue.sh` armed GitHub-native
 * auto-merge (DR-061) and performed the SPEC-024 consequence-hybrid merge without
 * ever asking whether the project was in `act` mode. A gate nobody calls is prose
 * with a test suite attached — the constitution's "enforce, don't trust the model"
 * failure, one level up: enforced, and then not consulted.
 *
 * The gate that should have caught it: nothing asserted that the decision function
 * had a CALLER. That is what this file is. Every assertion below is about the
 * wiring and its fail-closed edges, not about `mayProceed` itself (autonomy.test.ts
 * owns that).
 *
 * Two properties, both load-bearing:
 *
 *   1. FAIL-CLOSED. A gate that cannot RUN must not admit. An unrunnable CLI, a
 *      diff that cannot be enumerated, an empty change set — every one denies. The
 *      empty case is the sharp one: an empty stop-class list would read to
 *      `mayProceed` as "no stop classes apply" and PROCEED, so "we could not tell"
 *      must never be spelled the same way as "nothing applies".
 *
 *   2. ONE AUTHORITY. Both arms call the same `autonomy_may_merge`, which shells the
 *      TypeScript. The decision is not re-expressed in bash — a second copy of a
 *      rule in a second language is how the two drift, which this repo has already
 *      paid for twice (gh-bot.sh's write vocabulary #1401, the machinery regex
 *      #1758). Routing both arms through one classifier also closes an asymmetry as
 *      a side effect: the SPEC-024 arm never called `paths_have_approvable_doc` at
 *      all, so the machinery hold that MACHINERY_PATH_RE was added to
 *      double-witness (#1264) had its second witness on the native arm only.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAutonomyCli } from '../../../scripts/lib/autonomy';

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'scripts')) && fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate the repo root from ' + __dirname);
}

const ROOT = findRepoRoot();
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch-issue.sh');
const AUTONOMY_TS = path.join(ROOT, 'scripts', 'lib', 'autonomy.ts');
const AUTONOMY_SH = path.join(ROOT, 'scripts', 'lib', 'autonomy.sh');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

const DISPATCH_SRC = fs.readFileSync(DISPATCH, 'utf-8');
const AUTONOMY_SH_SRC = fs.readFileSync(AUTONOMY_SH, 'utf-8');

/** Spawning tsx costs ~1s; every `it` in this file that shells out gets headroom. */
const SPAWN_TIMEOUT = 30_000;

interface Run {
  code: number;
  out: string;
}

/**
 * Run one of dispatch-issue.sh's pure seams with `paths` on stdin.
 *
 * A key given `undefined` is DELETED from the child env, never passed as ''. That
 * distinction is load-bearing here: `readAutonomy` treats any DEFINED
 * `MINSPEC_AUTONOMY` as an override, so '' does not mean "unset", it means "ask"
 * — and a test that spelled it '' would silently stop exercising the config file.
 */
function seam(flag: string, paths: string, env: NodeJS.ProcessEnv = {}): Run {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  try {
    const out = execFileSync('bash', [DISPATCH, flag], {
      input: paths,
      encoding: 'utf-8',
      env: childEnv,
    });
    return { code: 0, out: out.trim() };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? -1, out: String(err.stdout ?? '').trim() };
  }
}

/** The classes `autonomy_stop_classes_for_paths` derives for a change set. */
function classesFor(paths: string, env: NodeJS.ProcessEnv = {}): string[] {
  const r = seam('--autonomy-stop-classes', paths, env);
  expect(r.code, `derivation exited ${r.code}: ${r.out}`).toBe(0);
  return r.out === '' ? [] : r.out.split(',');
}

/** The whole merge decision, exactly as both arms make it. */
function mayMerge(paths: string, env: NodeJS.ProcessEnv = {}): Run {
  return seam('--may-merge', paths, env);
}

// ─────────────────────────────────────────────────────────────────────────────
describe('A — the CLI seam is fail-closed on argv (pure, no spawn)', () => {
  const ok = ['--may-proceed', '--repo-root', ROOT, '--summary', 'do a thing', '--rejected-alternatives', 'do nothing'];

  it('proceeds only when autonomy resolves to act AND the action is clean', () => {
    expect(runAutonomyCli(ok, { MINSPEC_AUTONOMY: 'act' }).exitCode).toBe(0);
  });

  it('denies with no autonomy setting at all — the DEFAULT is ask', () => {
    // Own fixture repo root with a .minspec/config.json that has no `autonomy`
    // key. The shared `ok` array's ROOT is THIS repo's real root, and reading
    // its live config.json would pin whatever this repo's governance currently
    // says (e.g. `act`, #1799) rather than the resolver's no-key-present
    // default — so this one test gets its own argv rather than reusing `ok`.
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-cli-nokey-'));
    fs.mkdirSync(path.join(fixture, '.minspec'));
    try {
      fs.writeFileSync(path.join(fixture, '.minspec', 'config.json'), JSON.stringify({}));
      const argv = ['--may-proceed', '--repo-root', fixture, '--summary', 'do a thing', '--rejected-alternatives', 'do nothing'];
      const r = runAutonomyCli(argv, {});
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.line).reason).toBe('autonomy-is-ask');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each([
    ['no --repo-root', ['--may-proceed', '--summary', 'x', '--rejected-alternatives', 'y']],
    ['no --summary', ['--may-proceed', '--repo-root', ROOT, '--rejected-alternatives', 'y']],
    ['a flag with no value', ['--may-proceed', '--repo-root', ROOT, '--summary', '--rejected-alternatives', 'y']],
    ['a bare positional', ['--may-proceed', 'oops', '--repo-root', ROOT]],
    [
      'a non-boolean --verification-pending',
      [...['--may-proceed', '--repo-root', ROOT, '--summary', 'x', '--rejected-alternatives', 'y'], '--verification-pending', 'maybe'],
    ],
  ])('denies on %s, even under act', (_label, argv) => {
    const r = runAutonomyCli(argv as string[], { MINSPEC_AUTONOMY: 'act' });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.line).proceed).toBe(false);
  });

  it('never DROPS an unrecognised stop class — dropping one would turn a stop into a proceed', () => {
    const r = runAutonomyCli(
      [...ok, '--stop-classes', 'a-class-nobody-enumerated'],
      { MINSPEC_AUTONOMY: 'act' },
    );
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.line).detail).toContain('UNKNOWN CLASS');
  });

  it('splits rejected alternatives on newlines, so prose containing a comma stays one reason', () => {
    const r = runAutonomyCli(
      ['--may-proceed', '--repo-root', ROOT, '--summary', 'x', '--rejected-alternatives', 'hold it, and wait'],
      { MINSPEC_AUTONOMY: 'act' },
    );
    expect(r.exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B — the bash seam fails closed when the gate cannot RUN', () => {
  it(
    'DENIES when the runner does not exist (no node_modules / no tsx / offline)',
    () => {
      const r = mayMerge('packages/minspec/src/lib/config.ts', {
        MINSPEC_AUTONOMY: 'act',
        MINSPEC_AUTONOMY_TSX_BIN: path.join(os.tmpdir(), 'no-such-tsx-binary'),
      });
      expect(r.code, r.out).toBe(1);
      expect(JSON.parse(r.out).reason).toBe('gate-invocation-failed');
    },
    SPAWN_TIMEOUT,
  );

  it(
    'DENIES rather than FETCHING a runner when no pinned tsx exists',
    () => {
      // `npx tsx` with no local install downloads the package. Downloading the
      // judge is not a fallback worth having: it is an unconsented network call
      // (invariant 1) to obtain the binary that decides an unattended merge. A
      // missing pinned runner IS "the gate cannot run", and that denies.
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-nonode-'));
      try {
        const r = mayMerge('packages/minspec/src/lib/config.ts', {
          MINSPEC_AUTONOMY: 'act',
          MINSPEC_AUTONOMY_REPO_ROOT: bare, // no node_modules/.bin/tsx here
          MINSPEC_AUTONOMY_TSX_BIN: undefined,
        });
        expect(r.code, r.out).toBe(1);
        expect(JSON.parse(r.out).reason).toBe('gate-invocation-failed');
        expect(JSON.parse(r.out).detail).toContain('refusing to fetch one over the network');
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  it('never shells `npx`, which would fetch the gate it is about to trust', () => {
    expect(AUTONOMY_SH_SRC.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).not.toMatch(/\bnpx\b/);
  });

  it(
    'DENIES when the gate prints something that is not a verdict',
    () => {
      // A runner that exits 0 and prints prose. Exit code alone would ADMIT here —
      // this is the branch that proves the verdict body is also required.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-runner-'));
      const fake = path.join(dir, 'fake-runner.sh');
      fs.writeFileSync(fake, '#!/usr/bin/env bash\necho "everything is fine"\nexit 0\n');
      fs.chmodSync(fake, 0o755);
      try {
        const r = mayMerge('packages/minspec/src/lib/config.ts', {
          MINSPEC_AUTONOMY: 'act',
          MINSPEC_AUTONOMY_TSX_BIN: fake,
        });
        expect(r.code, r.out).toBe(1);
        expect(JSON.parse(r.out).reason).toBe('gate-invocation-failed');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    'DENIES a verdict that contradicts itself (exit 0 but proceed:false)',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-runner-'));
      const fake = path.join(dir, 'liar.sh');
      fs.writeFileSync(
        fake,
        '#!/usr/bin/env bash\necho \'{"proceed":false,"reason":"stop-class-applies","detail":"nope","autonomy":"act"}\'\nexit 0\n',
      );
      fs.chmodSync(fake, 0o755);
      try {
        const r = mayMerge('packages/minspec/src/lib/config.ts', {
          MINSPEC_AUTONOMY: 'act',
          MINSPEC_AUTONOMY_TSX_BIN: fake,
        });
        expect(r.code, r.out).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    'an env override that is SET BUT EMPTY resolves to ask — it does not fall through to the file',
    () => {
      // Fail-closed, and worth pinning: a caller that exports MINSPEC_AUTONOMY=''
      // (a common way to "clear" a variable) gets `ask`, not the file's value.
      const r = mayMerge('packages/minspec/src/lib/config.ts', { MINSPEC_AUTONOMY: '' });
      expect(r.code, r.out).toBe(1);
      expect(JSON.parse(r.out).reason).toBe('autonomy-is-ask');
    },
    SPAWN_TIMEOUT,
  );

  it(
    'reads the setting from .minspec/config.json, not from the arms themselves',
    () => {
      expect(fs.existsSync(TSX), 'node_modules/.bin/tsx is missing — run npm ci').toBe(true);
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-cfg-'));
      fs.mkdirSync(path.join(fixture, '.minspec'));
      try {
        const clean = 'packages/minspec/src/lib/config.ts';
        const withKey = (autonomy: unknown) => {
          fs.writeFileSync(
            path.join(fixture, '.minspec', 'config.json'),
            JSON.stringify(autonomy === undefined ? {} : { autonomy }),
          );
          return mayMerge(clean, {
            MINSPEC_AUTONOMY_REPO_ROOT: fixture,
            MINSPEC_AUTONOMY_TSX_BIN: TSX,
            // UNSET, not ''. See seam() — '' is a defined override meaning ask, and
            // would make this suite pass without ever reading the fixture file.
            MINSPEC_AUTONOMY: undefined,
          });
        };

        // The state on main today: no `autonomy` key ⇒ ask ⇒ the arm does not fire.
        const absent = withKey(undefined);
        expect(absent.code, absent.out).toBe(1);
        expect(JSON.parse(absent.out).reason).toBe('autonomy-is-ask');

        // Anything that is not the exact token is also ask — no fail-open path.
        for (const junk of ['ACT', 'true', 'yes', 'auto', '']) {
          const r = withKey(junk);
          expect(r.code, `${junk}: ${r.out}`).toBe(1);
        }

        const on = withKey('act');
        expect(on.code, on.out).toBe(0);
        expect(JSON.parse(on.out).autonomy).toBe('act');
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C — the stop-class derivation is never empty when the change set is unknown', () => {
  it('an EMPTY change set derives the strongest class, not an empty list', () => {
    // The whole point: `[]` means "no stop classes apply" to mayProceed, which
    // PROCEEDS. "We could not enumerate the diff" must never be spelled that way.
    expect(classesFor('')).toEqual(['irreversible-or-outward-facing']);
    expect(classesFor('\n \t\n')).toEqual(['irreversible-or-outward-facing']);
  });

  it(
    'DENIES when the derivation itself breaks — an empty list is not "nothing applies"',
    () => {
      // The subtle one. Before this, the derivation's last command was a `printf`,
      // which returns 0 — so a broken pipeline printed nothing and exited SUCCESS,
      // and empty stdout reads to mayProceed as "no stop classes apply" ⇒ PROCEED.
      // The failure is injected by shadowing `awk`, which the derivation pipes
      // through, so the whole chain is exercised for real rather than asserted.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-noawk-'));
      const fake = path.join(dir, 'awk');
      fs.writeFileSync(fake, '#!/usr/bin/env bash\nexit 1\n');
      fs.chmodSync(fake, 0o755);
      try {
        const r = mayMerge('packages/minspec/src/lib/config.ts', {
          MINSPEC_AUTONOMY: 'act',
          PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
        });
        expect(r.code, r.out).toBe(1);
        expect(JSON.parse(r.out).reason).toBe('stop-class-derivation-failed');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  it('a genuinely clean, code-only change set derives NO classes', () => {
    // The control. Without this, "always non-empty" would pass vacuously and the
    // gate would be an unconditional hold rather than a gate.
    expect(classesFor('packages/minspec/src/lib/config.ts\npackages/minspec/tests/config.test.ts')).toEqual([]);
  });

  it.each([
    ['scripts/lib/autonomy.ts', 'edits-the-autonomy-rules'],
    ['scripts/lib/autonomy.sh', 'edits-the-autonomy-rules'],
    ['.minspec/config.json', 'edits-the-autonomy-rules'],
    ['sites/minspec.dev/index.html', 'irreversible-or-outward-facing'],
    ['.github/workflows/ai-review.yml', 'irreversible-or-outward-facing'],
    ['.githooks/commit-msg', 'irreversible-or-outward-facing'],
    ['scripts/drain-inbox.sh', 'irreversible-or-outward-facing'],
    ['specs/minspec/SPEC-065-autonomy/requirements.md', 'approval-or-acceptance'],
    ['docs/decisions/DR-086.md', 'approval-or-acceptance'],
    ['.minspec/approvals/specs/minspec/x/y.json', 'approval-or-acceptance'],
    ['.cursorrules', 'approval-or-acceptance'],
  ])('%s ⇒ %s', (p, cls) => {
    expect(classesFor(p)).toContain(cls);
  });

  it('names every mandate a mixed change set actually touches', () => {
    const classes = classesFor('sites/a.html\nspecs/b/requirements.md\nscripts/lib/autonomy.ts');
    expect(classes.sort()).toEqual(
      ['approval-or-acceptance', 'edits-the-autonomy-rules', 'irreversible-or-outward-facing'].sort(),
    );
  });

  it('does not report human-owned CONTENT for a publish-only change set (never-wrong)', () => {
    // A false class is a false signpost. sites/** is outward-facing; nobody
    // approved a document.
    expect(classesFor('sites/minspec.dev/index.html')).toEqual(['irreversible-or-outward-facing']);
  });

  it('lists each class at most once', () => {
    const classes = classesFor('scripts/lib/autonomy.ts\nscripts/drain-inbox.sh\nsites/a.html');
    expect(new Set(classes).size).toBe(classes.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('D — the merge decision both arms make (real bash, real gate)', () => {
  it(
    'with NO autonomy key present, a perfectly clean PR still does not merge',
    () => {
      // Own fixture .minspec/config.json with no `autonomy` key — this pins the
      // resolver's no-key-present path itself, not this repo's live config value
      // (which is governance state that changes independently of this suite, e.g.
      // #1799 setting it to `act`). Same fixture idiom as the
      // "reads the setting from .minspec/config.json" test above.
      expect(fs.existsSync(TSX), 'node_modules/.bin/tsx is missing — run npm ci').toBe(true);
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-nokey-'));
      fs.mkdirSync(path.join(fixture, '.minspec'));
      try {
        fs.writeFileSync(path.join(fixture, '.minspec', 'config.json'), JSON.stringify({}));
        const r = mayMerge('packages/minspec/src/lib/config.ts', {
          MINSPEC_AUTONOMY_REPO_ROOT: fixture,
          MINSPEC_AUTONOMY_TSX_BIN: TSX,
          // UNSET, not ''. See seam() — '' is a defined override meaning ask, and
          // would make this pass without ever reading the fixture file.
          MINSPEC_AUTONOMY: undefined,
        });
        expect(r.code, r.out).toBe(1);
        expect(JSON.parse(r.out).reason).toBe('autonomy-is-ask');
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    'under autonomy: act, a clean code-only PR proceeds',
    () => {
      const r = mayMerge('packages/minspec/src/lib/config.ts', { MINSPEC_AUTONOMY: 'act' });
      expect(r.code, r.out).toBe(0);
      expect(JSON.parse(r.out).proceed).toBe(true);
    },
    SPAWN_TIMEOUT,
  );

  it.each([
    ['scripts/lib/autonomy.ts', 'the autonomy machinery itself'],
    ['scripts/lib/autonomy.sh', 'the autonomy seam'],
    ['.minspec/config.json', 'the autonomy setting'],
    ['sites/minspec.dev/index.html', 'a public publish'],
    ['scripts/dispatch-issue.sh', 'machinery — the second witness, now on BOTH arms'],
    ['specs/minspec/SPEC-065-autonomy/requirements.md', 'an approvable document'],
  ])(
    'DENIES %s even under autonomy: act (%s)',
    (p) => {
      const r = mayMerge(p, { MINSPEC_AUTONOMY: 'act' });
      expect(r.code, r.out).toBe(1);
      expect(JSON.parse(r.out).reason).toBe('stop-class-applies');
    },
    SPAWN_TIMEOUT,
  );

  it(
    'DENIES an unenumerable diff even under autonomy: act',
    () => {
      const r = mayMerge('', { MINSPEC_AUTONOMY: 'act' });
      expect(r.code, r.out).toBe(1);
      expect(JSON.parse(r.out).detail).toContain('irreversible-or-outward-facing');
    },
    SPAWN_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E — both merge actors are wired to the gate', () => {
  it('dispatch-issue.sh sources the autonomy seam', () => {
    expect(DISPATCH_SRC).toMatch(/source\s+"\$\{SCRIPT_DIR\}\/lib\/autonomy\.sh"/);
  });

  it('SITE A: the DR-061 native --auto arm is preceded by the autonomy verdict', () => {
    const armIdx = DISPATCH_SRC.indexOf('--squash --auto');
    expect(armIdx).toBeGreaterThan(-1);
    const guardIdx = DISPATCH_SRC.lastIndexOf('if native_automerge_enabled; then', armIdx);
    const block = DISPATCH_SRC.slice(guardIdx, armIdx);
    // The branch immediately before the arm must be the gate. Any other ordering
    // would let a path reach `--auto` without the verdict.
    expect(block).toMatch(/elif ! autonomy_verdict=\$\(autonomy_may_merge /);
    // …and the gate must not have been closed early (the drain-selfheal shape).
    expect(block).not.toMatch(/^\s*fi\s*$/m);
  });

  it('SITE A still reaches the withhold classifier — through the chain, not by adjacency', () => {
    // The classifier no longer sits IN the arm; it sits one call away, because it
    // is now the populator rather than the decider. That is the intended design,
    // but "the arm consults the classifier" has to stay PROVEN rather than assumed,
    // so pin the whole chain: arm → autonomy_may_merge → autonomy_stop_classes_for_paths
    // → paths_have_approvable_doc.
    //
    // Worth stating why this assertion exists separately from the two older
    // exclusion suites, which appear to cover it: their `armBlock` is
    // `content.slice(content.indexOf('if native_automerge_enabled; then'))`, and
    // that FIRST occurrence is the `--check-native-automerge` pure seam near the
    // top of the file — not the arm's guard. Their slice is therefore almost the
    // whole file, and would still pass with the classifier called from anywhere at
    // all. This one names the actual edges (#1781).
    const armIdx = DISPATCH_SRC.indexOf('--squash --auto');
    const guardIdx = DISPATCH_SRC.lastIndexOf('if native_automerge_enabled; then', armIdx);
    expect(DISPATCH_SRC.slice(guardIdx, armIdx)).toMatch(/autonomy_may_merge /);

    const mayMergeBody = DISPATCH_SRC.match(/^autonomy_may_merge\(\) \{\n([\s\S]*?)\n\}/m);
    expect(mayMergeBody, 'autonomy_may_merge() not found').not.toBeNull();
    expect(mayMergeBody![1]).toMatch(/autonomy_stop_classes_for_paths /);

    const populatorBody = DISPATCH_SRC.match(/^autonomy_stop_classes_for_paths\(\) \{\n([\s\S]*?)\n\}/m);
    expect(populatorBody, 'autonomy_stop_classes_for_paths() not found').not.toBeNull();
    expect(populatorBody![1]).toMatch(/paths_have_approvable_doc <<<"\$changed_files"/);
    // never through a pipe: pipefail + SIGPIPE fail OPEN on a large path list
    expect(populatorBody![1]).not.toMatch(/\|\s*paths_have_approvable_doc/);
  });

  it('SITE B: the SPEC-024 consequence-hybrid merge requires the verdict in its conjunction', () => {
    const mergeIdx = DISPATCH_SRC.indexOf('gh pr merge "$PR_NUM" --repo "$REPO" --squash 2>>"$LOG"');
    expect(mergeIdx).toBeGreaterThan(-1);
    const condIdx = DISPATCH_SRC.lastIndexOf('if [[ "$ELIGIBLE" == "true"', mergeIdx);
    expect(condIdx).toBeGreaterThan(-1);
    const cond = DISPATCH_SRC.slice(condIdx, mergeIdx);
    expect(cond).toMatch(/&&\s*"\$AUTONOMY_PROCEED" == "yes"/);
    // AUTONOMY_PROCEED starts at "no" and is only ever raised by a successful
    // verdict — so every failure path (no PR, unenumerable diff, unrunnable gate)
    // leaves it denying.
    const setup = DISPATCH_SRC.slice(DISPATCH_SRC.lastIndexOf('AUTONOMY_PROCEED="no"', condIdx), condIdx);
    expect(setup).toMatch(/if AUTONOMY_VERDICT=\$\(autonomy_may_merge/);
    expect(setup).toMatch(/AUTONOMY_PROCEED="yes"/);
    expect(DISPATCH_SRC.indexOf('AUTONOMY_PROCEED="yes"')).toBeGreaterThan(
      DISPATCH_SRC.indexOf('AUTONOMY_PROCEED="no"'),
    );
  });

  it('SITE B held for autonomy names THAT gate, not another one (never-wrong)', () => {
    expect(DISPATCH_SRC).toMatch(/HOLD_WHY="autonomy gate \(DR-086\) denied/);
  });

  it('both arms call the SAME function, so they cannot drift apart', () => {
    const calls = DISPATCH_SRC.match(/autonomy_may_merge /g) ?? [];
    // two arms + the pure seam this suite drives
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(DISPATCH_SRC.match(/^autonomy_may_merge\(\) \{/m)).not.toBeNull();
  });

  it('the decision is NOT re-implemented in bash — one authority, in TypeScript', () => {
    // A bash copy of `resolveAutonomy` would be the drift this whole shape exists
    // to prevent, so no bash file may compare against the setting's tokens itself.
    const stripComments = (s: string) =>
      s
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
    for (const [name, src] of [
      ['autonomy.sh', AUTONOMY_SH_SRC],
      ['dispatch-issue.sh', DISPATCH_SRC],
    ] as const) {
      expect(stripComments(src), `${name} compares the autonomy token itself`).not.toMatch(
        /(==|=~)\s*["']?\bact\b/,
      );
    }
    // …and the TypeScript really is what gets run.
    expect(AUTONOMY_SH_SRC).toMatch(/_AUTONOMY_TS="\$\{_AUTONOMY_LIB_DIR\}\/autonomy\.ts"/);
    expect(AUTONOMY_SH_SRC).toMatch(/--may-proceed/);
  });

  it('the CLI seam lives in the module that owns the decision', () => {
    const ts = fs.readFileSync(AUTONOMY_TS, 'utf-8');
    expect(ts).toMatch(/export function runAutonomyCli\(/);
    // and it must not fire on import — otherwise importing the module in a test
    // (or anywhere else) would exit the process.
    expect(ts).toMatch(/process\.argv\[1\]/);
  });
});
