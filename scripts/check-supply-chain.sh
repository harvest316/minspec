#!/bin/sh
# Pre-publish supply-chain gate for MinSpec / ScroogeLLM VS Code extensions.
#
# Scans the repo with perplexityai/bumblebee and fails the build if any
# bundled package matches an entry in the local exposure catalog.
#
# Wired into packages/<ext>/package.json as a "prepackage" / "prepublish" hook.
# Bypass with SKIP_SUPPLY_CHAIN_CHECK=1 (use only for known-good emergency cuts).
#
# Catalogs live in ~/.cache/bumblebee/catalogs/*.json. Empty catalog dir =
# pre-flight inventory only (script still fails on bumblebee errors).
#
# BUMBLEBEE_VERSION below also pins scripts/fetch-bumblebee-catalogs.sh's catalog
# fetch ref. The version pins across FOUR surfaces (both scripts + ci.yml +
# supply-chain-daily.yml) — bump all four together; the drift test
# (packages/minspec/tests/fetch-bumblebee-catalogs.test.ts) enforces they agree (#848/#850).
#
# Read-only: bumblebee never executes package managers or reads source files.
# https://github.com/perplexityai/bumblebee
#
# Exit codes (#869 — callers MUST branch on these, not just "nonzero"):
#   0 = scan ran to completion, no threat-catalog matches
#   1 = scan ran to completion AND found a real threat-catalog match (a finding)
#   2 = scan did NOT run to completion (missing Go toolchain, bumblebee install
#       failure, or scanner crash / unsupported catalog schema) — an infra/tooling
#       problem, NOT a security finding. Callers must not file a "compromised package
#       detected" alert for this code; it means "bump/repair bumblebee", not "compromise".

set -e

if [ "${SKIP_SUPPLY_CHAIN_CHECK}" = "1" ]; then
  echo "check-supply-chain: SKIP_SUPPLY_CHAIN_CHECK=1 — bypassing" >&2
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# Pinned to a main SHA reading exposure-catalog schema 0.2.0 (no released tag does;
# checksum-pinned SHA = immutable + GOSUMDB-verified, #850-intent-safe). DR-005/#866.
BUMBLEBEE_VERSION="${BUMBLEBEE_VERSION:-4a02b80aaca86641767c0d6cbe77c6856e4b481b}"
BUMBLEBEE_BIN="${BUMBLEBEE_BIN:-$HOME/go/bin/bumblebee}"
# GO_BIN is deliberately NOT defaulted here — resolve_go_bin() below searches for a
# toolchain, so an explicitly-set $GO_BIN stays distinguishable from an unset one (#1506).
CATALOG_DIR="${BUMBLEBEE_CATALOGS:-$HOME/.cache/bumblebee/catalogs}"
OUT_DIR="$REPO_ROOT/.cache/supply-chain"
OUT_FILE="$OUT_DIR/$(date +%Y%m%d-%H%M%S).ndjson"

# --- Scan-output retention (#915) -------------------------------------------
# check-supply-chain writes a NEW timestamped NDJSON every run (OUT_FILE above) and,
# being a `bumblebee scan` caller, also grows the bumblebee tool cache (scans/<date>/
# per-run outputs + a malicious-packages clone under sources/). Nothing ever pruned those
# per-run outputs, so on a persistent/local machine they accumulated without bound — the
# cache reached ~11G and helped fill the container disk (2026-07-25). Keep only the last
# few runs: enough to diff a scan against its predecessor, bounded in size.
SUPPLY_CHAIN_KEEP="${SUPPLY_CHAIN_KEEP:-2}"          # most-recent runs to retain (>=1)
[ "$SUPPLY_CHAIN_KEEP" -ge 1 ] 2>/dev/null || SUPPLY_CHAIN_KEEP=2
# Root of the bumblebee tool's OWN cache (its scans/<date>/ history and any sources/
# clone). Honored (BUMBLEBEE_CACHE) so the cache can be relocated off the overlay if a
# writable volume is ever mounted; defaults to the standard location.
BUMBLEBEE_CACHE="${BUMBLEBEE_CACHE:-$HOME/.cache/bumblebee}"

# Keep the $1 newest entries from the remaining args (files OR dirs); delete the rest.
# Scan outputs are date/timestamp-named, so a reverse lexical sort is chronological.
# No-op when the glob matched nothing (the literal pattern is passed through unchanged).
prune_keep_latest() {
  keep="$1"
  shift
  for e in "$@"; do [ -e "$e" ] || return 0; break; done
  printf '%s\n' "$@" | sort -r | tail -n +"$((keep + 1))" | while IFS= read -r e; do
    if [ -e "$e" ]; then rm -rf "$e"; fi
  done
}

# Best-effort housekeeping of the shared bumblebee cache. Prune old scans/<date>/ dirs and
# gc the malicious-packages clone (created by the cross-project catalog updater, not here)
# so the cache can't balloon. Pure maintenance — callers wrap this in `|| true`; it must
# never influence the security gate's exit status.
prune_bumblebee_cache() {
  cache="$1"
  keep="$2"
  [ -d "$cache" ] || return 0
  if [ -d "$cache/scans" ]; then
    prune_keep_latest "$keep" "$cache"/scans/*/
  fi
  clone="$cache/sources/malicious-packages"
  if [ -d "$clone/.git" ]; then
    git -C "$clone" gc --prune=now --quiet || true
  fi
  return 0
}
# Resolve the Go toolchain used to install bumblebee (#1506). Search order, first hit
# wins:
#   1. $GO_BIN, if the caller set it AND it is executable — an explicit override wins
#   2. `command -v go` — the ordinary case: respects PATH, survives a Go upgrade
#   3. the legacy $HOME/.local/opt/go*/bin/go location, so setups that relied on the
#      old hardcoded default do not regress (globbed, so it is not version-pinned)
# Prints the resolved path and returns 0, or prints nothing and returns 1.
#
# Why this exists: the previous single hardcoded default made a toolchain that was
# present, correct, and on PATH invisible to this gate. The gate then exited 2
# ("could not run") on a correctly-provisioned machine, and the script's own header
# advertises SKIP_SUPPLY_CHAIN_CHECK=1 — so a misfire here trains operators to
# disable a supply-chain check. That is the real cost, not the lost minute.
resolve_go_bin() {
  if [ -n "${GO_BIN:-}" ] && [ -x "${GO_BIN:-}" ]; then
    printf '%s\n' "$GO_BIN"
    return 0
  fi
  if command -v go >/dev/null 2>&1; then
    command -v go
    return 0
  fi
  for _cand in "$HOME"/.local/opt/go*/bin/go; do
    if [ -x "$_cand" ]; then
      printf '%s\n' "$_cand"
      return 0
    fi
  done
  return 1
}
# ----------------------------------------------------------------------------

# Self-install bumblebee on first run. A missing toolchain or a failed install is a
# scan-COULD-NOT-RUN condition (exit 2), never a finding — the scan never happened.
if [ ! -x "$BUMBLEBEE_BIN" ]; then
  # Not `if ! GO_RESOLVED=$(...)` — under `set -e` that form is fine, but keeping the
  # assignment separate makes the failure branch explicit and the exit code readable.
  GO_RESOLVED="$(resolve_go_bin || true)"
  if [ -z "$GO_RESOLVED" ]; then
    echo "check-supply-chain: no Go toolchain found. Tried, in order:" >&2
    echo "    1. \$GO_BIN                       ${GO_BIN:-(unset)}" >&2
    echo "    2. go on \$PATH                   $(command -v go 2>/dev/null || echo '(not found)')" >&2
    echo "    3. \$HOME/.local/opt/go*/bin/go   (no executable match)" >&2
    echo "  required for bumblebee install. Set GO_BIN or install Go 1.25+." >&2
    echo "  (exit 2: could not run — not a threat finding)" >&2
    exit 2
  fi
  echo "check-supply-chain: installing bumblebee $BUMBLEBEE_VERSION using $GO_RESOLVED..." >&2
  if ! GOBIN="$HOME/go/bin" "$GO_RESOLVED" install "github.com/perplexityai/bumblebee/cmd/bumblebee@$BUMBLEBEE_VERSION"; then
    echo "check-supply-chain: bumblebee@$BUMBLEBEE_VERSION install failed" >&2
    echo "  (exit 2: could not run — not a threat finding; the pinned install target may be unreachable)" >&2
    exit 2
  fi
fi

mkdir -p "$OUT_DIR" "$CATALOG_DIR"

CATALOG_FLAG=""
if [ -n "$(ls -1 "$CATALOG_DIR"/*.json 2>/dev/null)" ]; then
  CATALOG_FLAG="--exposure-catalog=$CATALOG_DIR"
fi

echo "check-supply-chain: scanning $REPO_ROOT" >&2

# A non-zero exit from the scanner ITSELF is a SCAN ERROR (an unsupported catalog
# schema for the pinned reader, a parse failure, I/O) — NOT a compromised-dependency
# finding. Surface it with a DISTINCT exit code (2) so callers (the daily workflow)
# report "scan could not run — bump bumblebee" instead of a false compromise alarm.
# This matters now that the daily scan floats catalogs to upstream HEAD: a schema
# advance past the pinned reader must fail closed as a bump signal, never as a P1
# "compromised dependency" (#850 security / #869). Real findings keep exit 1 below.
set +e
"$BUMBLEBEE_BIN" scan \
  --profile project \
  --root "$REPO_ROOT" \
  --output file \
  --output-file "$OUT_FILE" \
  $CATALOG_FLAG
SCAN_RC=$?
set -e
if [ "$SCAN_RC" -ne 0 ]; then
  echo "" >&2
  echo "✗ check-supply-chain: bumblebee scan errored (rc=$SCAN_RC) — the scan could NOT run." >&2
  echo "  Most likely the pinned reader (bumblebee $BUMBLEBEE_VERSION) does not support the" >&2
  echo "  fetched catalog schema. Bump the pinned bumblebee version. This is a scan error," >&2
  echo "  NOT a compromised-dependency finding." >&2
  exit 2
fi

# Retention (#915): the scan ran to completion, so prune per-run outputs before returning
# the gate result below. Neither the repo cache nor the shared bumblebee cache may grow
# without bound. Housekeeping only — wrapped so a prune failure can never change the exit
# code the findings check computes next.
prune_keep_latest "$SUPPLY_CHAIN_KEEP" "$OUT_DIR"/*.ndjson || true
prune_bumblebee_cache "$BUMBLEBEE_CACHE" "$SUPPLY_CHAIN_KEEP" || true

if [ -n "$CATALOG_FLAG" ]; then
  FINDINGS=$(grep -c '"record_type":"finding"' "$OUT_FILE" 2>/dev/null || true)
  FINDINGS=${FINDINGS:-0}
  if [ "$FINDINGS" -gt 0 ] 2>/dev/null; then
    echo "" >&2
    echo "✗ check-supply-chain: $FINDINGS compromised package(s) detected" >&2
    grep '"record_type":"finding"' "$OUT_FILE" >&2
    echo "" >&2
    echo "  Inventory: $OUT_FILE" >&2
    echo "  Bypass (NOT recommended): SKIP_SUPPLY_CHAIN_CHECK=1 npm run package" >&2
    exit 1
  fi
  echo "check-supply-chain: 0 findings against $(ls -1 "$CATALOG_DIR"/*.json | wc -l) catalog(s)" >&2
else
  echo "check-supply-chain: no exposure catalogs in $CATALOG_DIR — inventory-only run" >&2
fi

PKG_COUNT=$(grep -c '"record_type":"package"' "$OUT_FILE" 2>/dev/null || true)
PKG_COUNT=${PKG_COUNT:-0}
echo "check-supply-chain: ok ($PKG_COUNT packages catalogued → $OUT_FILE)" >&2
