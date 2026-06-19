#!/usr/bin/env node
/**
 * render-review-signals.mjs — integration touchpoint for #180.
 *
 * Thin, deterministic CLI over the pure renderer in `@aiclarity/shared`
 * (`renderReviewSignals`). The dev-time auto-build loop (DR-033 / `/loop`,
 * driven by `scripts/dispatch-issue.sh`) calls this to emit the honest
 * 3-signal review block when it assembles a PR body / comment, so the human
 * reviewer skims a VERIFIED summary instead of reconstructing it.
 *
 * Why a separate `.mjs` and not inline shell: the renderer is a tier-0 pure
 * function with the honesty invariants + tests behind it. This wrapper only
 * does I/O (read JSON inputs → print markdown) and holds NO logic of its own —
 * it must never decide a signal's truth.
 *
 * Usage:
 *   node scripts/render-review-signals.mjs <inputs.json>   # read a file
 *   node scripts/render-review-signals.mjs -                # read stdin
 *   cat inputs.json | node scripts/render-review-signals.mjs
 *
 * The JSON must match `ReviewSignalsInput` from `@aiclarity/shared`:
 *   {
 *     "rootCause": "…",
 *     "changedFiles": ["packages/…/x.ts"],
 *     "rootCauseFiles": ["packages/…/x.ts"],
 *     "regressionTest": "x.test.ts > rejects …",   // optional
 *     "regressionProvenBaseRed": true,             // optional (red half)
 *     "regressionProvenHeadGreen": true,           // optional (green half)
 *     "gate": { "test":"pass","lint":"pass","build":"pass","validate":"pass" }
 *   }
 *
 * Prints the rendered markdown block to stdout. Exits non-zero with a message
 * on stderr if the input is missing or unparseable — it never invents a block.
 *
 * NOTE: requires `@aiclarity/shared` to be built (`npm run build --workspace
 * @aiclarity/shared`). The dispatch gate runs the build before publishing, so
 * the `out/` barrel exists by the time this is called.
 */

import { readFileSync } from 'node:fs';

function fail(msg) {
  process.stderr.write(`render-review-signals: ${msg}\n`);
  process.exit(1);
}

const arg = process.argv[2];

let raw;
if (!arg || arg === '-') {
  // stdin
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    fail('could not read inputs from stdin');
  }
  if (!raw || raw.trim() === '') {
    fail(
      'no input. Pass a JSON file path or pipe JSON on stdin. See the header of this script for the expected shape.',
    );
  }
} else if (arg === '-h' || arg === '--help') {
  process.stdout.write(
    'Usage: node scripts/render-review-signals.mjs <inputs.json | ->\n' +
      'Reads a ReviewSignalsInput JSON and prints the honest 3-signal markdown block.\n',
  );
  process.exit(0);
} else {
  try {
    raw = readFileSync(arg, 'utf8');
  } catch (e) {
    fail(`could not read inputs file '${arg}': ${e.message}`);
  }
}

let input;
try {
  input = JSON.parse(raw);
} catch (e) {
  fail(`inputs are not valid JSON: ${e.message}`);
}

// Import the built tier-0 renderer. Deep-import the compiled module directly so
// the wrapper works even when the package symlink isn't resolvable from the
// dispatch cwd (worktree node-resolution can leak to the primary checkout).
let renderReviewSignals;
try {
  ({ renderReviewSignals } = await import('@aiclarity/shared'));
} catch {
  // Fallback: resolve the built barrel relative to this script.
  const here = new URL('.', import.meta.url);
  const built = new URL('../packages/shared/out/index.js', here);
  try {
    ({ renderReviewSignals } = await import(built.href));
  } catch (e) {
    fail(
      `could not load @aiclarity/shared (build it first: ` +
        `npm run build --workspace @aiclarity/shared): ${e.message}`,
    );
  }
}

process.stdout.write(renderReviewSignals(input) + '\n');
