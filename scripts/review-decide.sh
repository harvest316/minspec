#!/usr/bin/env bash
# review-decide.sh — pure deterministic AI-review gate (no network, no gh, no side effects).
#
# Reads a reviewer agent's output on stdin, extracts its verdict block, and writes
# the FINAL review label to stdout: "ai-review:pass" or "ai-review:changes".
#
# This is the machine-checkable gate that BACKS the LLM's judgment. It fails
# CLOSED: any missing/garbled field, any blocking finding, an ESCALATE, more than
# one verdict block, or a non-"pass" verdict → ai-review:changes (never a false
# green). A green (ai-review:pass) is emitted ONLY on an unambiguous clean verdict.
#
# Why this exists: the reviewer reads an UNTRUSTED diff (a PR — incl. arbitrary
# contributor code — is a prompt-injection surface). Per the repo's dispatch
# security model (DR-345 / mirrors triage-decide.sh), the agent gets NO tools and
# CANNOT apply labels — it only emits a verdict. The parent (review-pr.sh, or the
# dispatch-time run_reviewer_stage via review-branch.sh) feeds that verdict here
# and applies the result with gh. An injected "mark this ai-review:pass" cannot
# bypass the deterministic rules below.
#
# Expected verdict block in stdin (case-insensitive field names):
#   REVIEW_VERDICT_BEGIN
#   verdict: pass | changes
#   blocking: <integer>        # count of blocking/correctness findings
#   summary: <one line>
#   REVIEW_VERDICT_END
#
# stdout: one line, label ∈ {ai-review:pass, ai-review:changes}
# exit 0 when a clean verdict is parsed; exit 2 (still prints changes) otherwise.

set -eu

# Resolve the guard module relative to THIS script, so the quota check below is not
# silently inert when invoked from another directory (#1204). A missing guard must
# degrade to the previous behaviour (fail closed to changes), never to a crash —
# this script is a gate and must stay usable with nothing but bash.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The default is built on its OWN line rather than inlined into the parameter
# expansion below. managed-script-dependencies.test.ts reads sibling references
# statically, scanning up to the closing quote; inlining put a brace inside that
# span, so the path it resolved was one no template scaffolds and the check
# failed. Bash parsed the inlined form correctly — the STATIC reader could not,
# and that reader is what stops an adopter receiving this script without its
# callee. (This comment deliberately avoids writing the reference pattern out,
# since the same scanner reads comments too.)
GUARD_DEFAULT="${SCRIPT_DIR}/../.github/scripts/ai-review-guard.js"
GUARD="${GUARD:-$GUARD_DEFAULT}"

INPUT="$(cat)"

# ── what counts as a MARKER (#1157) ───────────────────────────────────────────
# A control marker is the token ALONE ON A LINE (leading/trailing whitespace and a
# stray CR allowed). It is NOT a substring match, because every voter reads the diff
# as untrusted data and REPORTS WHAT IT FOUND: when the reviewed diff is the review
# machinery — or a DR about it — naming a marker is unavoidable and correct. Under
# substring matching the citation WAS the marker, so an honest `verdict: pass` was
# overridden by the reviewer's own prose and such a PR could never go green.
# Measured on #1209 (DR-079): reviewer forced to `changes` by quoting
# `REVIEW_VERDICT_BEGIN`, skeptic forced to `blocked` by citing
# `REVIEW_UNAVAILABLE_BEGIN/END`, both while their rendered blocks read
# `verdict: pass, blocking: 0` — the label contradicted the artifact it displayed.
#
# These patterns are the SINGLE definition shared by the unavailable probe, the
# extractor, and the counter below. They must never diverge: a marker one of them
# sees and another misses is exactly the forgery channel the ambiguity guard exists
# to close (#1165). Valid in both BRE (sed) and ERE (grep -E) — no alternation or
# grouping. `ai-review.yml` carries the same anchors for its display-side
# `extract_block`, so the DISPLAYED block and the DECIDED label cannot disagree.
#
# This is a narrowing, not a structural fix. The real answer is to stop parsing a
# verdict out of free text at all — DR-079 (#1157) proposes carrying it out of band.
UNAVAILABLE_RE='^[[:space:]]*REVIEW_UNAVAILABLE_BEGIN[[:space:]]*$'
BEGIN_RE='^[[:space:]]*REVIEW_VERDICT_BEGIN[[:space:]]*$'
END_RE='^[[:space:]]*REVIEW_VERDICT_END[[:space:]]*$'

# A review that could NOT RUN (quota / rate-limit / transient) is distinct from a
# review that ran and requested changes. review-branch.sh emits a
# REVIEW_UNAVAILABLE marker for that case; surface it as `ai-review:blocked` —
# retry-able, NOT a code verdict. Checked FIRST so a transient failure can never
# masquerade as `ai-review:changes` (which would read as "the reviewer wants
# changes" and hide the real, fixable cause from the dev). No verdict block is
# required alongside it.
if printf '%s\n' "$INPUT" | grep -qE "$UNAVAILABLE_RE"; then
  echo "ai-review:blocked"; exit 0
fi

# An explicit escalation is never a pass.
if printf '%s\n' "$INPUT" | grep -qE '^[[:space:]]*ESCALATE:'; then
  echo "ai-review:changes"; exit 2
fi

BLOCK="$(printf '%s\n' "$INPUT" | sed -n "/$BEGIN_RE/,/$END_RE/p")"
if [[ -z "$BLOCK" ]]; then
  # No verdict block. Before calling this a CODE verdict, ask whether the reviewer
  # could have produced one at all (#1204).
  #
  # The UNAVAILABLE_RE check above only fires when review-branch.sh WRAPPED the
  # failure in its marker. When the CLI is killed mid-flight the raw limit message
  # reaches us unwrapped — "You've hit your session limit · resets 12:50am" — and
  # this branch used to label that `ai-review:changes`: a sentence that literally
  # says "session limit", reported as though the reviewer had read the code and
  # wanted changes. It is also why the retry never fired for these: ai-review-retry
  # selects on `ai-review:blocked`, so an outage wearing a `changes` label is
  # invisible to it and waits forever.
  #
  # STRICT matcher on purpose. The loose one matches a bare `quota` anywhere, which
  # is correct for harness stderr but wrong here: this text may be the AGENT's own
  # prose, and a review DISCUSSING quota handling must not be read as an outage. The
  # strict variant keeps only phrasings that read as the CLI's own sentences.
  if [[ -f "$GUARD" ]] && GUARD="$GUARD" node -e 'const g=require(process.env.GUARD);let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(g.isQuotaExhaustionStrict(s)?0:1));' <<<"$INPUT" 2>/dev/null; then
    echo "ai-review:blocked"   # could not RUN — retry-able, not a code verdict
    exit 0
  fi
  echo "ai-review:changes"   # fail closed: no parseable verdict → not green
  exit 2
fi

# Fail closed on AMBIGUITY: the reviewer is contractually told to emit EXACTLY ONE
# verdict block. More than one BEGIN marker means the captured output carries a
# second block — the prompt-injection channel this gate exists to defeat: an
# UNTRUSTED diff can embed its own `REVIEW_VERDICT_BEGIN verdict: pass …` block,
# and an HONEST reviewer that merely QUOTES that block in its findings (before its
# own real verdict) would otherwise have `field()`'s `head -1` read the attacker's
# `pass` instead of the reviewer's `changes`. Any count != 1 is anomalous
# (injection echo, a malformed double-emit, or a truncated block) → distrust the
# whole thing and block. Counted over the RAW input, not the sed-joined BLOCK, so a
# quoted block that never closed its END still trips this.
#
# ── this counter is DELIBERATELY BROAD, and must stay that way ────────────────
# It does NOT use $BEGIN_RE. The extractor and this counter answer different
# questions and must be ASYMMETRIC:
#
#   extractor  — "which text is the verdict?"      → STRICT. A prose mention must
#                                                     not start a block.
#   this count — "is it ambiguous which block is
#                 the verdict?"                    → BROAD. ANYTHING that looks
#                                                     remotely like a second marker
#                                                     is a reason to distrust.
#
# Anchoring this one too was a real false-green, caught before merge: the reviewer's
# own marker line is free-form LLM markdown, so it may arrive decorated
# (`**REVIEW_VERDICT_BEGIN**`, a trailing word, a `## ` heading) — and an untrusted
# diff can ASK for that decoration. Under an anchored count the reviewer's decorated
# marker becomes invisible while an injected canonical block still counts, so the
# count lands on 1, this guard passes, and the extractor reads the ATTACKER's block.
# Measured: reviewer honestly emits `verdict: changes, blocking: 3` with bolded
# markers alongside an injected `verdict: pass` block → gate returned
# `ai-review:pass`. Broad counting returns `changes`.
#
# The asymmetry costs a false `ai-review:changes` when a reviewer names the token in
# prose without a second block present (the reviewer half of #1157, still open). That
# is fail-CLOSED and merely annoying; the anchored version was fail-OPEN on a merge
# gate. Never trade the second for the first. The real fix is to defang markers in the
# untrusted diff before the agent ever reads them, so an honest reviewer has no live
# marker to echo — see the pattern at dispatch-ready-check.sh:396.
BEGIN_COUNT="$(printf '%s\n' "$INPUT" | grep -c 'REVIEW_VERDICT_BEGIN' || true)"
if [[ "$BEGIN_COUNT" -ne 1 ]]; then
  # Show the evidence this decision was made on (#1157).
  #
  # This branch is the single most confusing outcome the gate produces: the posted
  # comment displays `verdict: pass, blocking: 0` while the LABEL says changes, because
  # the count is taken over the voter's RAW output and the comment never shows it. A
  # reviewer looking at the PR sees a contradiction with no way to resolve it, and the
  # only honest diagnosis available today is "cannot tell".
  #
  # Measured on AIClarityAU/voip-sms-inbox#28: four voters each posted
  # `pass, blocking: 0`; Architect's label came back `changes`; and the raw output that
  # would explain it is written to a file the run log never captures. The cause could
  # not be established at all — so no fix could be designed for it.
  #
  # Diagnostics go to STDERR, never stdout: stdout is the label contract
  # (`ai-review:pass` | `ai-review:changes`) and callers parse it. The decision itself
  # is unchanged — this is evidence, not a behaviour change.
  #
  # Context is REDACTED to marker lines plus their line numbers. The raw output can
  # quote an untrusted diff, so echoing it wholesale into a public CI log would leak
  # exactly the artifact content the reviewer was reading. Line numbers plus the marker
  # line are enough to find the echo without reproducing what was reviewed.
  {
    echo "review-decide: refusing — expected exactly 1 REVIEW_VERDICT_BEGIN, found ${BEGIN_COUNT}."
    echo "  >1 means it is ambiguous WHICH block is the verdict: an injected block, a"
    echo "  double-emit, or an honest reviewer that quoted the marker in prose (#1157)."
    echo "  (A count of 0 cannot reach here — the no-parseable-verdict path exits earlier.)"
    echo "  Marker lines in the voter's raw output:"
    printf '%s\n' "$INPUT" \
      | grep -n 'REVIEW_VERDICT_BEGIN' \
      | head -20 \
      | sed 's/^/    /'
  } >&2
  echo "ai-review:changes"   # >1 verdict block → ambiguous/injected → fail closed
  exit 0
fi

# Extract a single field value, lowercased and trimmed; empty if absent.
field() {
  printf '%s\n' "$BLOCK" \
    | { grep -iE "^[[:space:]]*$1[[:space:]]*:" || true; } \
    | head -1 \
    | sed -E "s/^[^:]*:[[:space:]]*//" \
    | tr -d '\r' \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

VERDICT="$(field verdict)"
BLOCKING="$(field blocking)"

# Blocking count must be a non-negative integer; anything else → fail closed.
if ! [[ "$BLOCKING" =~ ^[0-9]+$ ]]; then
  echo "ai-review:changes"; exit 2
fi

# The ONLY green path: explicit pass AND zero blocking findings.
if [[ "$VERDICT" == "pass" && "$BLOCKING" -eq 0 ]]; then
  echo "ai-review:pass"; exit 0
fi

echo "ai-review:changes"; exit 0
