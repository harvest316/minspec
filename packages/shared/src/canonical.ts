/**
 * Canonical spec hashing — SPEC-022 / DR-034 (FR-3).
 *
 * One canonicalization contract, two twins. This is the Node twin; the Python
 * twin lives in `scripts/hooks/canonical.py` and MUST produce byte-identical
 * output (guarded by the INV-2 corpus-parity test). Keep the two in lockstep:
 * any change here must be mirrored there or INV-2 fails.
 *
 * The approved `specHash` covers a CANONICAL form of the spec, defined precisely
 * so independent implementations reproduce it byte-identically:
 *
 *   1. Normalize EOL to `\n` up front (deterministic before any splitting).
 *   2. Split the frontmatter block from the body.
 *   3. From the frontmatter, remove exactly the lifecycle keys `status` and
 *      `phases` (the latter including its indented child lines). Everything else
 *      — id, tier, type, epic, title, … — is content and is retained verbatim.
 *   4. Rejoin frontmatter-minus-lifecycle + body.
 *   5. Collapse ALL relative-link URLs to `](RELLINK)` (#252) — external,
 *      anchor and absolute links are kept; link text is kept.
 *   6. Normalize: strip trailing whitespace per line; collapse the trailing
 *      newline run to exactly one.
 *   7. sha256 the UTF-8 bytes; return the hex digest.
 *
 * Consequence (the fix): editing `status`/`phases` — the tool's own lifecycle
 * transitions — no longer voids a content approval. Editing the body or any
 * other frontmatter field still voids it (substantive change re-triggers review).
 *
 * Tier-0: depends only on `crypto`. No `vscode`, no `fs`, no network. This is a
 * pure string transform — it must NOT route through `parseSpec`, whose
 * default-injection and re-serialization would change bytes and break the
 * byte-for-byte contract.
 */

import * as crypto from 'crypto';

/**
 * Same anchor as `FRONTMATTER_RE` in `spec.ts` (and the Python twin's regex):
 * a leading `---\n`, lazily-captured block, then `\n---` with an optional
 * trailing newline. Operates on EOL-normalized (`\n`) input only.
 */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/** A top-level `status:` key line (column 0, no leading indent). */
const STATUS_LINE_RE = /^status[ \t]*:/;
/** A top-level `phases:` key line — opens the indented phases block. */
const PHASES_LINE_RE = /^phases[ \t]*:/;
/** Any indented line (a child of the open `phases:` block, or other nesting). */
const INDENTED_LINE_RE = /^[ \t]+/;

/**
 * Remove the lifecycle keys (`status`, `phases` + children) from a frontmatter
 * block, line-oriented. KEEPS every other line verbatim — including blank lines,
 * `#` comment lines, and every non-lifecycle key. The `phases:` block ends at the
 * first non-indented line (a new top-level key or a blank line), mirroring how the
 * YAML parser treats a nested block.
 *
 * A `status:`/`phases:` key with an inline comment (`status: implementing # x`) is
 * dropped wholesale — the whole line goes.
 */
function stripLifecycle(fm: string): string {
  const out: string[] = [];
  let inPhasesBlock = false;
  for (const line of fm.split('\n')) {
    if (inPhasesBlock) {
      // Still inside the phases block while the line is indented; a blank line or
      // a new top-level key ends it. (A blank line is NOT indented → ends block.)
      if (INDENTED_LINE_RE.test(line)) {
        continue; // drop child line
      }
      inPhasesBlock = false;
      // fall through to re-evaluate this line as a (possibly droppable) top-level key
    }
    if (PHASES_LINE_RE.test(line)) {
      inPhasesBlock = true;
      continue; // drop the `phases:` line itself
    }
    if (STATUS_LINE_RE.test(line)) {
      continue; // drop the `status:` line
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Compute the canonical string form of a raw spec. Pure, deterministic, and
 * byte-for-byte reproducible by the Python twin.
 */
export function canonicalizeSpec(raw: string): string {
  // 1. Normalize EOL up front.
  const normalized = raw.replace(/\r\n?/g, '\n');

  // 2. Split frontmatter from body.
  const m = normalized.match(FRONTMATTER_RE);
  let joined: string;
  if (!m) {
    // No frontmatter → body is the whole string.
    joined = normalized;
  } else {
    const fm = m[1];
    const body = normalized.slice(m[0].length);
    // 3. Remove lifecycle keys.
    const fmClean = stripLifecycle(fm);
    // 4. Rejoin.
    joined = '---\n' + fmClean + '\n---\n' + body;
  }

  // 5. Collapse relative-link URLs (#252). Automated directory renumbering
  //    (#83/#175) rewrites sibling-spec link *paths* without changing what is
  //    referenced; collapsing them stops that cry-wolf. ALL relative URLs are
  //    collapsed (`./…`, `../…`, bare-relative `child/x.md`, `file.md`); external
  //    (`scheme://…`, `mailto:`), anchors (`#…`) and absolute (`/…`) are KEPT.
  //    Link *text* is preserved, so changing the referenced spec is still caught.
  //    MUST stay byte-identical to the Python twin's regex.
  const linked = joined.replace(/\]\((?![a-z][a-z0-9+.-]*:)(?!#)(?!\/)[^)]*\)/gi, '](RELLINK)');

  // 6. Normalize per-line trailing whitespace (the design's `trimEnd()` — strips
  //    all trailing whitespace; lines are already newline-free after the split, so
  //    this matches Python's `str.rstrip()` byte-for-byte), then collapse the
  //    trailing newline run to exactly one.
  const lines = linked.split('\n').map((ln) => ln.replace(/\s+$/, ''));
  return lines.join('\n').replace(/\n*$/, '') + '\n';
}

/** sha256 hex digest of the canonical form (FR-3). */
export function specHash(raw: string): string {
  return crypto.createHash('sha256').update(Buffer.from(canonicalizeSpec(raw), 'utf-8')).digest('hex');
}

// Two boundaries: canonical = frontmatter-minus-lifecycle + body (specHash); getSpecBodyOnly = body only.
/**
 * SPEC-017 FR-4 baseline boundary: the spec body AFTER the frontmatter block.
 *
 * Reuses the SAME `FRONTMATTER_RE` anchor `canonicalizeSpec` (and `parseSpec`)
 * use, so there is exactly ONE body-split definition — no second anchor to drift.
 * EOL is normalized to `\n` first (matching `parseSpec`). A spec with no
 * frontmatter returns the whole (normalized) content as body.
 *
 * Distinct from the canonical-hash boundary on purpose: `specHash` keeps
 * frontmatter-minus-lifecycle so editing `status`/`phases` does not void approval;
 * `getSpecBodyOnly` excludes ALL frontmatter so frontmatter churn never registers
 * as the human reworking the LLM's prose. Pure, Tier-0 (no new dependency).
 */
export function getSpecBodyOnly(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const m = normalized.match(FRONTMATTER_RE);
  return m ? normalized.slice(m[0].length) : normalized;
}
