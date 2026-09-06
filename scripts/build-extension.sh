#!/usr/bin/env bash
# build-extension.sh — the ONE bundle-producing path for the extension, stamped with the
# commit it was built from (#1439, #1527).
#
# Why the stamp exists: a stale installed extension silently disables shipped gates, and a
# VERSION check cannot detect it. Measured 2026-08-12 — the installed build and the rebuilt
# one were both `0.1.26`, five days and one security-relevant gate apart. Only the commit
# distinguishes them, so the commit is what gets baked in.
#
# The SHA is injected with esbuild `--define`, so it lands as a literal in the bundle. There
# is no generated source file to commit, and therefore no generated file to go stale — the
# stamp cannot outlive the build it describes.
#
# Why this is the ONLY bundler invocation (#1527): it used to be reachable through
# `build:prod` alone, while a second, unstamped `build` script bundled the same entry point
# without the `--define`. Every caller that was not `npm run package` — the CI `package` job
# that uploads the downloadable .vsix, the `build`/`e2e` jobs, `pretest:e2e`, `watch` — took
# that other path, so the artifact a third party is most likely to install was permanently
# silent about skew. Two ways to bundle is one too many: callers now pass FLAGS to this
# script (`npm run build -- --watch --sourcemap`) instead of maintaining a rival command
# line that can drift out of stamp.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../packages/minspec"

# Dirty tree ⇒ mark it. A bundle built from uncommitted work is not identified by any commit,
# and silently stamping the last commit would misreport what is actually running — the exact
# class of false signpost this feature exists to remove.
sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git status --porcelain -- ../../packages ../../scripts 2>/dev/null)" ]; then
  sha="${sha}-dirty"
fi

# A default is DROPPED when the caller supplies its own, never emitted alongside it — the
# command line then never depends on esbuild's duplicate-flag precedence.
outfile="out/extension.js"
watching=false
outfile_overridden=false
sourcemap_overridden=false
for arg in "$@"; do
  case "$arg" in
    --outfile=*)
      outfile="${arg#--outfile=}"
      outfile_overridden=true
      ;;
    --watch | --watch=*) watching=true ;;
    --sourcemap | --sourcemap=*) sourcemap_overridden=true ;;
  esac
done

flags=(
  --bundle
  --external:vscode
  --format=cjs
  --platform=node
  --minify
  "--define:__MINSPEC_BUILD_SHA__=\"${sha}\""
)
if [ "$outfile_overridden" = false ]; then
  flags+=("--outfile=${outfile}")
fi
# `.vscodeignore` keeps `out/*.js.map` out of the .vsix, so this costs the shipped artifact
# nothing; `watch` passes `--sourcemap` (linked) so the debugger can find it.
if [ "$sourcemap_overridden" = false ]; then
  flags+=(--sourcemap=external)
fi

echo "build-extension: stamping build with ${sha}" >&2

# Watch never returns, so the verification below is unreachable there — and a watch loop
# produces no shipped artifact, so exec straight into it.
if [ "$watching" = true ]; then
  exec npx esbuild src/extension.ts "${flags[@]}" "$@"
fi

npx esbuild src/extension.ts "${flags[@]}" "$@"

# Verify our own output instead of trusting that the flag took (SPEC-060 INV-1: a missing or
# unverifiable build stamp fails visibly and closed). A bundle that silently lost its stamp
# reports `dev` at runtime, which short-circuits `detectBuildSkew` to `not-applicable` — the
# install is then permanently unable to say it is stale, which is worse than a failed build.
#
# Grep for the stamped VALUE, never the identifier: `--define` substitutes at build time, so
# `__MINSPEC_BUILD_SHA__` appears ZERO times in a correctly stamped bundle and a symbol-name
# grep would pass vacuously on an unstamped one.
if ! grep -qF -- "${sha}" "${outfile}"; then
  echo "build-extension: FATAL — ${outfile} does not contain the build stamp ${sha}." >&2
  echo "  The --define did not reach the bundle, so the build would install unable to" >&2
  echo "  report its own staleness (SPEC-060 INV-1). Refusing to emit it." >&2
  exit 1
fi
