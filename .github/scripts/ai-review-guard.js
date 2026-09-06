// ai-review-guard — pure decision logic for the ai-review label-integrity gate.
//
// This module is deliberately I/O-free: no network, no `github`/octokit, no
// `fs`, no process access. Every function is a pure input→output mapping so the
// security-critical decisions (revert-or-not, strip-or-not, verified-or-not,
// green-or-not) can be unit-tested exhaustively (see ai-review-guard.test.js)
// and the workflow that requires it stays a thin, auditable I/O shell.
//
// Threats this closes (see the header of ready-to-merge.yml for the full note):
//   #359 staleness  — a greenlight from an old head must not survive new commits.
//   #397 provenance — an `ai-review:pass` applied by anyone other than the
//                     configured reviewer identity must not count as a review.
//
// NEVER TRUST BARE PRESENCE. The active guards below (revert at add-time, strip
// at push-time) are best-effort *cleanup*; they can transiently fail (rate
// limit / 5xx), leaving a forged or stale `ai-review:pass` on the PR. So the
// authoritative gate (`decideStatus`) does NOT green on label presence alone:
// a surviving pass counts only if `verifyPassProvenance` confirmed — from the
// PR's own event timeline — that it was LAST APPLIED BY an allowlisted reviewer
// identity AND AFTER the current head commit. Anything unverifiable ⇒ not green.
//
// SECURITY: callers pass label names / actor logins / timestamps in here as
// plain JS data. Nothing in this module (or the workflow) may forward that
// untrusted data to a shell — it is only ever compared as data or handed to the
// REST API as JSON.

'use strict';

const PASS = 'ai-review:pass';
const CHANGES = 'ai-review:changes';
// #466 — the SHA-bound pass witness. The ai-review workflow posts this commit
// status (success/failure) on the EXACT head SHA it evaluated, BEFORE it applies
// the `ai-review:pass` label. Because a commit status is bound to its SHA, its
// presence on the CURRENT head is an exact proof that THIS commit was reviewed —
// unlike the timestamp proxy in `verifyPassProvenance`.
const PASS_STATUS_CONTEXT = 'ai-review/pass';
// The name of the honest verdict CHECK-RUN posted by decideReviewCheck (below).
// Declared here, with the other wire-format constants, because #810 made it a
// SECOND load-bearing head witness read by verifyHeadPassCheckRun — producer
// (decideReviewCheck) and verifier (verifyHeadPassCheckRun) must bind the SAME
// constant so the two can never drift apart (#822).
const CHECK_NAME = 'ai-review';
// The reviewer could NOT run to a verdict for a TRANSIENT, non-code reason —
// almost always the Claude subscription's session quota being exhausted, but also
// a rate-limit / overload / auth blip. This is NOT a review of the PR: it must be
// visibly distinct from `ai-review:changes` (which means "the reviewer read your
// code and wants changes"), and it is safe to RETRY once the window resets. See
// isQuotaExhaustion() and the ai-review-retry workflow.
const BLOCKED = 'ai-review:blocked';

// ── The verdict channel (DR-079, #1157/#1165) ────────────────────────────────
//
// The verdict used to be TEXT the reviewer typed, parsed back out of its prose.
// That made every token the pipeline keys on a token an honest reviewer might
// legitimately write — and a review of THIS file writes all of them. Eight
// consumers could be flipped by a bare mention, and `BEGIN_COUNT != 1` caught
// ambiguity but never forgery: a lone injected block decided `pass`.
//
// Now the verdict is a VALUE the reviewer returns (`claude -p --json-schema` →
// `.structured_output`), and the block below is rendered by the PARENT from
// validated fields. Two properties follow, and they are the whole point:
//   • exactly one block exists, because we write it — the count guard can no
//     longer be tripped by prose;
//   • a quoted marker arrives as a JSON string VALUE, and a value cannot become
//     structure.
//
// No `maxLength`, `maxItems` or `format` here, deliberately: a cap that makes the
// model fail to produce `structured_output` would recreate #1157 as an
// intermittent self-block correlated with THOROUGH reviews — the worst possible
// correlation. Length is bounded at render time, where it can shorten display
// text but can never withhold a verdict.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'blocking', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes'] },
    blocking: { type: 'integer', minimum: 0 },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'location', 'problem'],
        properties: {
          severity: { type: 'string' },
          location: { type: 'string' },
          problem: { type: 'string' },
        },
      },
    },
  },
};

// Neutralise every protocol token inside model-authored TEXT before it is
// rendered between real delimiters. Without this the fix would be cosmetic: a
// summary containing `REVIEW_VERDICT_BEGIN` would mint a second marker in the
// block we just wrote, reproducing #1157 through the new channel. Mirrors the
// diff-defanging in review-branch.sh, and leaves a visible marker so a reader
// can still see that the text was there.
function defangProtocolTokens(text) {
  return String(text == null ? '' : text)
    .replace(/\r/g, '')
    // The replacement must NOT contain the token it replaces. review-decide.sh:41
    // matches REVIEW_UNAVAILABLE as a BARE SUBSTRING, so a marker like
    // "[defanged: REVIEW_UNAVAILABLE]" would still trip it — the defang would look
    // applied and change nothing. Hyphens keep the text readable while breaking the
    // literal the consumers grep for.
    .replace(/REVIEW_VERDICT_(BEGIN|END)/g, (_m, k) => `[defanged marker: REVIEW-VERDICT-${k}]`)
    .replace(
      /REVIEW_UNAVAILABLE(_BEGIN|_END)?/g,
      (_m, k) => `[defanged marker: REVIEW-UNAVAILABLE${k ? k.replace('_', '-') : ''}]`,
    )
    // Only the line-anchored form is load-bearing downstream (review-decide.sh
    // greps `^[[:space:]]*ESCALATE:`), so neutralise it there and leave prose
    // mentions mid-sentence readable.
    .replace(/^(\s*)ESCALATE:/gm, '$1[defanged: ESCALATE]:');
}

// Bound a single rendered line. Applied to DISPLAY text only — never to the
// verdict or blocking fields, so truncation can never change a decision.
const MAX_FIELD = 500;
function clampField(text) {
  const s = defangProtocolTokens(text).replace(/\n+/g, ' ').trim();
  return s.length <= MAX_FIELD ? s : `${s.slice(0, MAX_FIELD - 1)}…`;
}

/**
 * Render the ONE canonical verdict block from a validated structured object.
 * Returns '' for anything unusable, which downstream reads as "no verdict" and
 * fails closed to ai-review:changes — never a spurious pass.
 */
function renderVerdictBlock(structured) {
  const o = structured;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return '';
  const verdict = String(o.verdict ?? '').trim().toLowerCase();
  if (verdict !== 'pass' && verdict !== 'changes') return '';
  if (!Number.isInteger(o.blocking) || o.blocking < 0) return '';

  const lines = [
    'REVIEW_VERDICT_BEGIN',
    `verdict: ${verdict}`,
    `blocking: ${o.blocking}`,
    `summary: ${clampField(o.summary) || '(no summary provided)'}`,
  ];
  const findings = Array.isArray(o.findings) ? o.findings : [];
  if (findings.length > 0) {
    lines.push('findings:');
    for (const f of findings) {
      if (!f || typeof f !== 'object') continue;
      const sev = clampField(f.severity) || 'note';
      const loc = clampField(f.location) || '(unspecified)';
      const prob = clampField(f.problem) || '(no detail)';
      lines.push(`- ${sev} ${loc} — ${prob}`);
    }
  }
  lines.push('REVIEW_VERDICT_END');
  return `${lines.join('\n')}\n`;
}

/**
 * Extract the verdict block from `claude -p --output-format json` stdout.
 * Fails closed ('') on anything unexpected: non-JSON, an error result, or a
 * missing/!object `structured_output`. The agent cannot reach this function's
 * input except through the schema-validated channel.
 */
function parseCliVerdict(stdoutText) {
  let env;
  try {
    env = JSON.parse(String(stdoutText == null ? '' : stdoutText));
  } catch {
    return '';
  }
  if (!env || typeof env !== 'object') return '';
  if (env.is_error === true) return '';
  return renderVerdictBlock(env.structured_output);
}

// DR-063 (materialised as SPEC-031 INV-8 / FR-9a) — the single positive "your turn"
// queue signal. Present
// on a PR whose independent AI review has PASSED (the `ready-to-merge` gate is
// green) and whose ONLY remaining gate is a human keystroke. It is the canonical
// "my turn" filter, replacing the ambiguous read of `ai-review:pass` plus a
// negative label — and it never coexists with `ai-review:changes` (a failing gate
// removes it). Owned by ONE applier (ready-to-merge.yml), driven by shouldAwaitApproval().
const AWAITING_APPROVAL = 'awaiting-approval';

// #1247 — the NEGATIVE counterpart to AWAITING_APPROVAL: this PR declares a
// dependency on something that is still open, so it is nobody's turn yet.
//
// Deliberately NOT named `blocked`: `ai-review:blocked` above already means
// something entirely different (the reviewer could not RUN, a transient quota
// condition). Two labels a human scans in the same list must not read as
// variants of one another when they mean unrelated things.
const BLOCKED_BY = 'blocked-by';

// Declarations of a blocking dependency in a PR body, e.g.
//
//   Blocked by #1225
//   Blocked by: #1225, #1179
//   - **Blocked by** #1225
//
// STRICT BY DESIGN. The pattern anchors to the start of a line (after optional
// markdown decoration) so ordinary prose — "this was blocked by a stale cache",
// "#1225 blocked by design" — can never mint the label. A false `blocked-by`
// parks a mergeable PR indefinitely, which is worse than not having the signal:
// the whole point is that the queue tells the truth.
//
// Only `Blocked by` is recognised, NOT `Depends on`. PR bodies say "depends on"
// loosely all the time ("depends on the seam landing first" as narrative), while
// "Blocked by" reads as a declaration in every corpus I checked. One unambiguous
// form beats two fuzzy ones — a second form can be added if a real body wants it.
const BLOCKED_BY_LINE_RE = /^[\s>*_-]*\**\s*blocked\s+by\b\**\s*:?\s*(.+)$/gim;

// Only the LEADING run of refs on a declaring line counts: `#N`, separated by
// commas/`and`/whitespace. Scanning stops at the first token that is not one of
// those, so a trailing explanation cannot smuggle in a second blocker.
//
// Found by using it: the first real declaration written against this parser read
//   Blocked by #1225 — … (DR-078, merged as `proposed` in #1246, awaiting Accept)
// and a whole-line scan returned [1225, 1246]. #1246 was already closed so nothing
// broke, but the declaration was wrong, and a closed ref today is an open one
// tomorrow. An explanation after the refs is the natural way to write this, so the
// grammar has to expect it rather than the author having to remember.
const BLOCKED_BY_REFS_RE = /^(?:\s*(?:,|and\b)?\s*#\d+)+/i;
const ISSUE_REF_RE = /#(\d+)\b/g;

// Detect, from a failed `claude -p` reviewer invocation's combined output, whether
// the cause is an exhausted subscription quota / rate-limit / overload (a transient,
// retry-able, NOT-your-code condition) versus a genuine crash. review-branch.sh
// pipes the captured failure text here (via `node -e`) so the SAME tested pattern
// governs bash and JS — no drift. Pure: text in → boolean out. Conservative by
// design: it only claims "quota/transient" on a clear signal; anything else stays a
// hard failure (which fails closed to ai-review:changes, never a spurious pass).
function isQuotaExhaustion(text) {
  const s = String(text == null ? '' : text);
  // Kept deliberately TIGHT: over-matching would loop a genuine (non-transient)
  // crash forever as `ai-review:blocked` instead of failing closed to `changes`
  // for a human. Only clear quota / rate-limit / overload / retry signals count.
  return /\b(usage limit|rate.?limit(ed)?|quota|too many requests|overloaded|resets? (at|in)|try again (later|in)|429|insufficient (quota|credit))\b/i
    .test(s)
    // Claude CLI's subscription-limit phrasing: "Claude AI usage limit reached",
    // "5-hour limit reached", "You've reached your usage limit", "weekly limit".
    || /usage limit reached|limit reached|reached your (usage )?limit|weekly limit|session limit|5-?hour limit/i.test(s);
}

// STRICT variant for text that may be the AGENT's own prose rather than the harness's
// diagnostics (#1131). The loose predicate above matches a bare `quota` anywhere, which
// is correct for the CLI's stderr — that text is the harness talking — but wrong for
// anything the model wrote: a review that DISCUSSES quota handling is not evidence of a
// quota outage, and reading it as one loops a genuine crash forever as retry-able
// `blocked` instead of failing closed to a human.
//
// So this keeps only phrasings that read as the CLI's own SENTENCES and drops every
// bare topic word a reviewer would naturally use while describing the code — `quota`,
// `overloaded`, `insufficient credit`, and also `rate limit`, which is exactly what a
// review of the rate-limit handling says.
//
// Honest limit: classifying model-authored prose by content is unreliable in principle,
// and this narrows the failure rather than eliminating it. It is acceptable because it
// is a LAST-RESORT path — reached only when the CLI failed while writing nothing at all
// to stderr — and because the residual error now falls toward failing closed to a human
// rather than looping forever as retry-able.
function isQuotaExhaustionStrict(text) {
  const s = String(text == null ? '' : text);
  return /usage limit reached|limit reached|reached your (usage )?limit|weekly limit|session limit|5-?hour limit/i.test(s)
    || /\b(too many requests|429)\b/i.test(s)
    || /\bresets? (at|in)\b/i.test(s);
}

// ─── Reset-instant extraction (#1204) ───────────────────────────────────────
//
// The quota detectors above only ask WHETHER the text looks like a quota block.
// The reset time the CLI states — "resets 8:40am (UTC)", "resets 12:50am
// (Australia/Sydney)" — was matched as a pattern and then thrown away, so the
// retry had nothing to schedule against and polled blindly. On PR #1602 that cost
// six attempts across 4h21m, five of which were futile at the moment they fired.
//
// Returns an ISO-8601 instant (string) or null. Null means "no reset time stated",
// which callers MUST treat as "retry on the normal cadence" — never as "never
// retry". Failing to parse must not strand a PR.
//
// `nowMs` is injected rather than read from the clock so this is a pure function
// and its tests are deterministic across DST boundaries.

/** Offset (ms) of `tz` from UTC at the instant `utcMs`. */
function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asIfUtc - utcMs;
}

/** Wall-clock y/m/d h:m in `tz` → UTC ms. Iterated twice to settle DST shifts. */
function zonedWallClockToUtc(y, mo, d, h, mi, tz) {
  let utc = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) utc = Date.UTC(y, mo - 1, d, h, mi) - tzOffsetMs(utc, tz);
  return utc;
}

/** The y/m/d currently showing in `tz` at instant `utcMs`. */
function calendarDateIn(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day };
}

function parseResetInstant(text, nowMs) {
  const s = String(text == null ? '' : text);
  if (!Number.isFinite(nowMs)) return null;

  // Relative first — "resets in 25 minutes", "try again in 2 hours". Unambiguous,
  // and needs no timezone reasoning at all.
  const rel = s.match(/\b(?:resets?|try again)\s+in\s+(\d{1,3})\s*(second|minute|min|hour|hr)s?\b/i);
  if (rel) {
    const n = +rel[1];
    const unit = rel[2].toLowerCase();
    const mult = unit.startsWith('sec') ? 1e3 : unit.startsWith('h') ? 3.6e6 : 6e4;
    return new Date(nowMs + n * mult).toISOString();
  }

  // Absolute wall-clock — "resets 8:40am (UTC)", "resets at 12:50 am (Australia/Sydney)".
  // The zone is optional; without one there is no defensible instant, so we bail
  // rather than guess the runner's local zone (which is UTC on Actions but not
  // necessarily where the quota window is anchored).
  const abs = s.match(
    /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i,
  );
  if (!abs) return null;
  const tz = abs[4];
  if (!tz) return null;

  let h = +abs[1];
  const mi = abs[2] == null ? 0 : +abs[2];
  const mer = abs[3] ? abs[3].toLowerCase() : null;
  if (h > 23 || mi > 59) return null;
  if (mer === 'pm' && h < 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;

  let cand;
  try {
    const today = calendarDateIn(nowMs, tz);
    cand = zonedWallClockToUtc(today.y, today.mo, today.d, h, mi, tz);
    // A stated reset is always in the FUTURE — "resets 12:50am" seen at 20:32 means
    // tomorrow's 12:50am, not one that already passed sixteen hours ago.
    if (cand <= nowMs) {
      const t = calendarDateIn(nowMs + 864e5, tz);
      cand = zonedWallClockToUtc(t.y, t.mo, t.d, h, mi, tz);
    }
  } catch {
    return null; // unknown/invalid IANA zone — treat as "not stated"
  }
  if (!Number.isFinite(cand)) return null;
  return new Date(cand).toISOString();
}

// ─── Patch-fingerprint re-attestation (#1728) ────────────────────────────────
//
// Under `strict` branch protection every merge puts every other open PR BEHIND, and
// the branch update re-triggers a full four-voter review — of a patch that did not
// change. The reviewer reads the THREE-DOT patch (`base...head`), and a forward-merge
// leaves that patch byte-identical, so the previous verdict is still a true statement
// about exactly this content.
//
// What this does NOT do is reuse an old witness. The SHA-binding in
// verifyHeadPassCheckRun (#466/#810) is load-bearing: a witness must correspond to the
// CURRENT head. So a re-attestation posts a FRESH check-run on the new SHA, carrying
// the same verdict and the same fingerprint. The claim changes from "four voters
// reviewed this SHA" to "four voters reviewed this patch, and this SHA has that patch"
// — still true, and stated rather than implied.
//
// HONEST LIMIT, and the reason this is opt-in: an identical patch can produce a
// DIFFERENT merge result, because the base moved. That is the #1394 semantic-conflict
// class. `strict` narrows it (the branch must be current) but does not remove it, so
// re-attestation trades back a little of what `strict` buys.

const PATCH_FINGERPRINT_PREFIX = 'patch-fingerprint:';

/**
 * Stable fingerprint of a three-dot patch. Normalises line endings and trailing
 * whitespace-only difference so a cosmetic re-render is not read as a new patch,
 * but nothing else — any real content change must produce a different digest.
 */
function patchFingerprint(diffText) {
  const norm = String(diffText == null ? '' : diffText).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (norm === '') return null; // an empty patch is never re-attestable (see #1680)
  return require('crypto').createHash('sha256').update(norm, 'utf8').digest('hex');
}

/** Render the marker embedded in a check-run's output so a later run can read it. */
function renderPatchFingerprint(fp) {
  return fp ? `${PATCH_FINGERPRINT_PREFIX}${fp}` : '';
}

/** Read the fingerprint back out of a check-run's output text. */
function parsePatchFingerprint(text) {
  const m = String(text == null ? '' : text).match(/patch-fingerprint:([0-9a-f]{64})\b/);
  return m ? m[1] : null;
}

/**
 * Is there a prior, provenance-verified PASS for this exact patch?
 *
 * Deliberately reuses the SAME strictness as verifyHeadPassCheckRun — completed +
 * success + an allowlisted App slug — because a weaker check here would be a second,
 * softer door into the same gate. The only thing it does NOT require is head_sha
 * equality, which is precisely what makes it a re-attestation rather than a witness.
 */
function findReattestableVerdict({ checkRuns, patchHash, allowlist } = {}) {
  if (!patchHash) return { ok: false, reason: 'no patch fingerprint (empty or unreadable diff)' };
  if (!Array.isArray(checkRuns) || checkRuns.length === 0) {
    return { ok: false, reason: 'no prior check-runs to re-attest from' };
  }
  const allowed = Array.isArray(allowlist) ? allowlist : [];
  if (allowed.length === 0) return { ok: false, reason: 'empty reviewer allowlist — refusing to re-attest' };

  for (const c of checkRuns) {
    if (!c || c.name !== CHECK_NAME) continue;
    if (c.status !== 'completed' || c.conclusion !== 'success') continue;
    const slug = c.app && c.app.slug;
    const identities = [slug, slug ? `${slug}[bot]` : null].filter(Boolean);
    if (!identities.some((i) => allowed.includes(i))) continue;
    const text = [c.output && c.output.title, c.output && c.output.summary, c.output && c.output.text]
      .filter(Boolean)
      .join('\n');
    if (parsePatchFingerprint(text) === patchHash) {
      return { ok: true, sourceSha: c.head_sha, reason: `patch unchanged since ${String(c.head_sha).slice(0, 8)}` };
    }
  }
  return { ok: false, reason: 'no prior passing review of this exact patch' };
}

// GitHub truncates commit-status descriptions at 140 chars; keep ours within it
// even when a description carries a (potentially long) provenance reason.
const MAX_DESCRIPTION = 140;
function truncate(s, n = MAX_DESCRIPTION) {
  const str = String(s == null ? '' : s);
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

// Parse the reviewer-bot allowlist from a raw env string.
// Accepts comma / whitespace / newline separated logins; case-insensitive.
// Entries may be a user login (`review-bot`) or an app/bot login (`my-app[bot]`).
function parseAllowlist(raw) {
  return String(raw == null ? '' : raw)
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Is `login` one of the configured reviewer identities?
// An empty allowlist authorizes nobody — provenance cannot be verified until the
// owner configures AI_REVIEW_BOT_LOGINS, so the gate must fail closed.
function isAuthorizedReviewer(login, allowlist) {
  if (!login) return false;
  return allowlist.includes(String(login).toLowerCase());
}

// #397 — provenance. On a `labeled` event that added `ai-review:pass`, decide
// whether that label must be reverted because it did not come from an allowlisted
// reviewer identity. Only `ai-review:pass` is guarded: a forged `ai-review:changes`
// can only make the gate stricter (fail), never falsely green, so it is fail-safe.
function decideProvenanceRevert({ action, labelName, senderLogin, allowlist } = {}) {
  if (action !== 'labeled') return { revert: false };
  if (labelName !== PASS) return { revert: false };
  const list = Array.isArray(allowlist) ? allowlist : [];
  if (isAuthorizedReviewer(senderLogin, list)) return { revert: false };
  return {
    revert: true,
    reason:
      list.length === 0
        ? 'the reviewer-bot allowlist is unset (repo/org variable AI_REVIEW_BOT_LOGINS) — ' +
          'pass provenance cannot be verified'
        : `applied by \`${sanitizeLogin(senderLogin)}\`, which is not an allowlisted reviewer identity`,
  };
}

// #359 — staleness. On a `synchronize` event (new commits pushed) any existing
// `ai-review:pass` reviewed an older head and is now stale; it must be stripped.
function decideStalenessStrip({ action, labels } = {}) {
  if (action !== 'synchronize') return { strip: false };
  const set = new Set(Array.isArray(labels) ? labels : []);
  if (!set.has(PASS)) return { strip: false };
  return {
    strip: true,
    reason: 'new commits were pushed after ai-review:pass — the greenlight is stale',
  };
}

// #359 + #397 (durable) — provenance-recency verification of a *surviving* pass.
//
// The revert/strip guards above are add-time / push-time *cleanup* and can fail
// transiently, leaving a forged or stale `ai-review:pass` present. So on every
// event the gate must independently re-verify any present pass rather than trust
// its bare presence:
//   • `labelActor`      — who LAST applied `ai-review:pass` (from the PR timeline,
//                         or, on the `labeled` event itself, the GitHub-signed
//                         sender). Must be an allowlisted reviewer identity.
//   • `labelAppliedAt`  — when it was applied (ISO 8601). Must be AT/AFTER…
//   • `headCommittedAt` — …the current head commit's timestamp, else the pass
//                         reviewed an older head and is stale.
//   • `allowlist`       — parsed AI_REVIEW_BOT_LOGINS.
//
// Deny-by-default: an empty allowlist, an unknown applier, or missing/unparseable
// timestamps all return { verified:false } so the gate stays red. This also closes
// the "pass already present before this guard was deployed / on a stale head"
// transition gap — such a pass has no allowlisted, post-head-commit application
// on record, so it never verifies.
//
// NOTE on the recency reference: `headCommittedAt` is the head commit's own
// committer date, which a committer can backdate. That residual (narrow) window
// is covered defence-in-depth by the `synchronize` staleness strip (which now
// fails the run if it cannot remove the label) and by the allowlist check a
// forger cannot satisfy; the primary trust anchor here is the applier identity.
function verifyPassProvenance({ labelActor, labelAppliedAt, headCommittedAt, allowlist } = {}) {
  const list = Array.isArray(allowlist) ? allowlist : [];
  if (list.length === 0) {
    return {
      verified: false,
      reason:
        'reviewer-bot allowlist (AI_REVIEW_BOT_LOGINS) is unset — pass provenance cannot be verified',
    };
  }
  if (!labelActor) {
    return {
      verified: false,
      reason: 'no record of who applied ai-review:pass — provenance unverifiable',
    };
  }
  if (!isAuthorizedReviewer(labelActor, list)) {
    return {
      verified: false,
      reason: `ai-review:pass last applied by \`${sanitizeLogin(labelActor)}\`, not an allowlisted reviewer identity`,
    };
  }
  const applied = Date.parse(labelAppliedAt);
  const committed = Date.parse(headCommittedAt);
  if (!Number.isFinite(applied) || !Number.isFinite(committed)) {
    return {
      verified: false,
      reason: 'missing or unparseable timestamps — cannot confirm ai-review:pass is fresh',
    };
  }
  if (applied < committed) {
    return {
      verified: false,
      reason: 'ai-review:pass predates the current head commit — the greenlight is stale',
    };
  }
  return { verified: true, reason: 'applied by an allowlisted reviewer after the head commit' };
}

// #466 — SHA-bound recency (closes the TOCTOU the timestamp proxy leaves open).
// `verifyPassProvenance` compares the label-application TIME to the head-commit
// TIME; a same-second push, clock skew, or a cancelled `synchronize` strip can slip
// a stale pass through. A commit STATUS is bound to the exact SHA it was posted on,
// so requiring `ai-review/pass`=success on the CURRENT head SHA is an EXACT witness
// that this very commit was reviewed. `statuses` is the commit-status list for the
// current head SHA; `verified` iff it carries `ai-review/pass`=success from an
// allowlisted creator. Absence ⇒ the pass is for a different/older commit ⇒ red.
function verifyHeadPassStatus({ statuses, allowlist } = {}) {
  const list = Array.isArray(allowlist) ? allowlist : [];
  if (list.length === 0) {
    return {
      verified: false,
      reason:
        'reviewer-bot allowlist (AI_REVIEW_BOT_LOGINS) is unset — head-status provenance cannot be verified',
    };
  }
  const ours = (Array.isArray(statuses) ? statuses : []).filter(
    (s) => s && s.context === PASS_STATUS_CONTEXT,
  );
  if (ours.length === 0) {
    return {
      verified: false,
      reason: `no \`${PASS_STATUS_CONTEXT}\` status on the current head commit — the greenlight does not correspond to this SHA (#466)`,
    };
  }
  // Most-recent by created_at (the API returns newest-first, but be explicit).
  const latest = ours.reduce((a, b) =>
    Date.parse(b.created_at) >= Date.parse(a.created_at) ? b : a,
  );
  if (latest.state !== 'success') {
    return {
      verified: false,
      reason: `\`${PASS_STATUS_CONTEXT}\` on the current head is '${sanitizeLogin(latest.state)}', not success`,
    };
  }
  const creator = latest.creator && latest.creator.login;
  if (!creator || !isAuthorizedReviewer(creator, list)) {
    return {
      verified: false,
      reason: `\`${PASS_STATUS_CONTEXT}\` on the current head was posted by \`${sanitizeLogin(creator)}\`, not an allowlisted reviewer`,
    };
  }
  return {
    verified: true,
    reason: `\`${PASS_STATUS_CONTEXT}\`=success on the current head SHA, from an allowlisted reviewer`,
  };
}

// #810 — the SECOND head-bound witness: the `ai-review` CHECK-RUN.
//
// WHY THIS EXISTS. #466 made the `ai-review/pass` commit status the SOLE witness
// the gate would accept, and ai-review.yml posts it BEST-EFFORT (`|| true`). That
// POST was returning `403 Resource not accessible by integration` — the reviewer
// App installation lacks `statuses: write` — so the witness was never written on
// ANY commit while the `ai-review:pass` label still landed. `ready-to-merge` was
// therefore unsatisfiable repo-wide and every merge became an `--admin` bypass,
// which skips the entire required gate (the #466/#776 SHA-binding included).
//
// The `ai-review` check-run is posted by the SAME App (via `checks: write`, which
// it does have) on the SAME head SHA, and is an equally strong witness:
//   • SHA-bound INTRINSICALLY — a check-run carries `head_sha`; unlike a status it
//     cannot be re-pointed after the fact. We additionally assert it equals the
//     head we were asked about (defence in depth against a caller querying by the
//     wrong ref).
//   • PROVENANCE is server-attested — `app.slug` is assigned by GitHub, not
//     claimable by the poster. A PR-authored workflow can post a check-run named
//     `ai-review`, but it posts as `github-actions`, which the SAME configured
//     AI_REVIEW_BOT_LOGINS allowlist rejects. (We deliberately match against that
//     existing allowlist rather than pinning an App *id* — a wrong App-id pin is
//     precisely the unsatisfiable-required-check failure #560 fixed.)
//
// STRICTNESS. Only `status: 'completed'` + `conclusion: 'success'` is a pass
// witness. `neutral` (decideReviewCheck's machinery self-exemption) is NOT — a
// machinery PR is exempt from the CHECK, never certified as reviewed — and
// `failure` / `action_required` / anything else is not. Deny-by-default
// throughout: empty allowlist, unknown app, missing fields ⇒ not verified.
const PASS_CHECK_NAME = CHECK_NAME;
function verifyHeadPassCheckRun({ checkRuns, allowlist, headSha } = {}) {
  const list = Array.isArray(allowlist) ? allowlist : [];
  if (list.length === 0) {
    return {
      verified: false,
      reason:
        'reviewer-bot allowlist (AI_REVIEW_BOT_LOGINS) is unset — check-run provenance cannot be verified',
    };
  }
  const ours = (Array.isArray(checkRuns) ? checkRuns : []).filter(
    (c) =>
      c &&
      c.name === PASS_CHECK_NAME &&
      // Only enforce the SHA match when the caller told us which head to expect;
      // the workflow queries BY the head ref, so this is a belt-and-braces check.
      (headSha === undefined || c.head_sha === headSha),
  );
  if (ours.length === 0) {
    return {
      verified: false,
      reason: `no \`${PASS_CHECK_NAME}\` check-run on the current head commit — the greenlight does not correspond to this SHA (#810)`,
    };
  }
  // Most-recent wins, so a re-review that later FAILS supersedes an earlier pass.
  const latest = ours.reduce((a, b) => (checkRunTime(b) >= checkRunTime(a) ? b : a));
  if (latest.status !== 'completed') {
    return {
      verified: false,
      reason: `\`${PASS_CHECK_NAME}\` on the current head is still '${sanitizeLogin(latest.status)}', not completed`,
    };
  }
  if (latest.conclusion !== 'success') {
    return {
      verified: false,
      reason: `\`${PASS_CHECK_NAME}\` on the current head concluded '${sanitizeLogin(latest.conclusion)}', not success`,
    };
  }
  const app = latest.app || {};
  // A GitHub App's check-run identity is its `slug`; the allowlist is written in
  // login form (`minspec-sdd[bot]`), so accept either spelling of the same App.
  const identities = [app.slug, app.slug ? `${app.slug}[bot]` : null].filter(Boolean);
  if (!identities.some((id) => isAuthorizedReviewer(id, list))) {
    return {
      verified: false,
      reason: `\`${PASS_CHECK_NAME}\` on the current head was posted by \`${sanitizeLogin(app.slug)}\`, not an allowlisted reviewer`,
    };
  }
  return {
    verified: true,
    reason: `\`${PASS_CHECK_NAME}\`=success on the current head SHA, from an allowlisted reviewer App`,
  };
}

// Sort key for check-runs: completion time, falling back to start time so an
// unfinished run still orders sensibly. Unparseable ⇒ -Infinity (never "latest").
function checkRunTime(c) {
  const t = Date.parse((c && (c.completed_at || c.started_at)) || '');
  return Number.isFinite(t) ? t : -Infinity;
}

// #810 — the head-bound pass witness, from EITHER channel.
//
// The gate needs ONE proof that THIS head SHA was the reviewed one. Two
// independent channels can carry it, each SHA-bound and each provenance-checked
// against the same allowlist: the #466 `ai-review/pass` commit status, and the
// `ai-review` check-run. Requiring BOTH would keep the gate hostage to whichever
// App permission is missing (that is the bug); accepting EITHER removes the
// single point of failure without weakening anything — a forged, stale, machinery
// -exempt, or absent pass fails BOTH channels and the gate stays red.
function verifyHeadPassWitness({ statuses, checkRuns, allowlist, headSha } = {}) {
  const viaStatus = verifyHeadPassStatus({ statuses, allowlist });
  if (viaStatus.verified) return viaStatus;
  const viaCheck = verifyHeadPassCheckRun({ checkRuns, allowlist, headSha });
  if (viaCheck.verified) return viaCheck;
  return {
    verified: false,
    // Lead with the check-run reason: with `statuses: write` missing it is the
    // channel an operator can actually act on, and decideStatus truncates to 140.
    reason: `not bound to this head — ${viaCheck.reason}; and ${viaStatus.reason}`,
  };
}

// Compute the `ready-to-merge` commit status. The status is the authoritative
// gate, so it is derived from the *decided* effective label set (pass removed if
// it was reverted or stripped) AND from the provenance-recency verification of
// any surviving pass — independent of whether the best-effort label mutation
// later succeeds. Green iff a *verified* pass survives and no changes flag.
//
// Bare label presence is never trusted: a present `ai-review:pass` with absent
// or unverified `passProvenance` yields a red status (deny-by-default).
function decideStatus({ labels, provenanceRevert, stalenessStrip, passProvenance, headStatus } = {}) {
  const eff = new Set(Array.isArray(labels) ? labels : []);
  if (provenanceRevert || stalenessStrip) eff.delete(PASS);

  const passPresent = eff.has(PASS);
  // A surviving pass counts only if its provenance was verified upstream.
  const passVerified = passPresent && !!(passProvenance && passProvenance.verified);
  // #466 — the SHA-bound witness must ALSO confirm THIS head was the reviewed one.
  // `headStatus` is OPTIONAL: when omitted (a caller/base guard that predates #466,
  // during rollout) it is NOT required — behaviour is unchanged. When supplied it
  // gates: an unverified head status blocks green even with a provenance-verified
  // label (that is exactly the stale-pass-on-a-new-head case #466 closes).
  const headVerified = headStatus === undefined ? true : !!(headStatus && headStatus.verified);
  const isGreen = passVerified && headVerified && !eff.has(CHANGES);

  let description;
  if (stalenessStrip) {
    description = 'stale ai-review:pass stripped on new commits — re-review required';
  } else if (provenanceRevert) {
    description = 'ai-review:pass reverted — not from an allowlisted reviewer';
  } else if (passPresent && !passVerified) {
    // Present but not trusted (unverified applier / stale / allowlist unset).
    description = truncate(
      `ai-review:pass not trusted — ${
        (passProvenance && passProvenance.reason) || 'provenance unverified'
      }`,
    );
  } else if (passPresent && passVerified && !headVerified) {
    // #466 — the label is trustworthy but is not bound to THIS commit's review.
    description = truncate(
      `ai-review:pass not bound to this commit — ${
        (headStatus && headStatus.reason) || 'no ai-review/pass status on the current head SHA'
      }`,
    );
  } else if (isGreen) {
    description = 'AI review passed';
  } else {
    description = 'needs ai-review:pass';
  }

  return {
    state: isGreen ? 'success' : 'failure',
    description, // already within GitHub's 140-char commit-status limit.
    effectiveLabels: [...eff],
  };
}

// DR-063 / SPEC-031 FR-9a — should the `awaiting-approval` "your turn" signal be
// PRESENT on this PR? Pure and side-effect-free so it is unit-testable; ready-to-merge.yml
// applies/removes the label from this boolean on every PR event. Both conditions
// required:
//   - statusState === 'success' — the ready-to-merge gate (decideStatus, the sole
//     authority) is GREEN: a verified, fresh, un-reverted pass with no outstanding
//     `ai-review:changes`. Every stale-strip / forged-revert / changes-flip already
//     drives this to 'failure', so the label is removed with NO extra mirror site.
//   - !autoMergeArmed — the PR will NOT merge itself. A PR with native auto-merge
//     armed (DR-061) merges the instant the gate greens, so it is the ROBOT's turn,
//     never a human's — it must never enter the "my turn" queue.
//   - openBlockers is empty — nothing this PR declared `Blocked by` is still open.
//     A PR waiting on another PR/issue is not a human's turn: pressing merge would
//     land it out of order. #1224 is the case that prompted this (#1247): it read
//     `ai-review:pass` + `awaiting-approval` while genuinely blocked on #1225, so
//     the "my turn" queue was lying about a PR nobody could act on.
//   - !isDraft — a draft cannot be merged at all, so it can never be a human's turn
//     to merge it. Previously drafts entered the queue purely because the gate was
//     green, which is how #1224 showed up there twice over.
//
// Both new conditions fail toward NOT-your-turn. That is the correct direction for
// a positive signal: a missing "your turn" costs a glance at the queue, a false one
// costs a merge nobody should have made.
function shouldAwaitApproval({ statusState, autoMergeArmed, openBlockers, isDraft } = {}) {
  if (isDraft) return false;
  if (Array.isArray(openBlockers) && openBlockers.length > 0) return false;
  return statusState === 'success' && !autoMergeArmed;
}

// #1247 — extract every declared blocking dependency from a PR body. Pure:
// text in → sorted, de-duplicated array of issue/PR NUMBERS out. Empty array for
// null/undefined/no-declaration, so callers need no special-casing.
//
// Returns numbers (not `#N` strings) because the caller's next move is an API
// lookup keyed by number; formatting back to `#N` is a display concern.
function parseBlockedBy(body) {
  const text = String(body == null ? '' : body);
  const found = new Set();
  BLOCKED_BY_LINE_RE.lastIndex = 0;
  let line;
  while ((line = BLOCKED_BY_LINE_RE.exec(text)) !== null) {
    // Only the remainder of the declaring line is scanned for refs, so a `#N`
    // three paragraphs later is never swept into an unrelated declaration — and
    // only its LEADING ref run, so a trailing explanation on the same line
    // cannot either.
    const refRun = BLOCKED_BY_REFS_RE.exec(line[1]);
    if (!refRun) continue;
    const rest = refRun[0];
    ISSUE_REF_RE.lastIndex = 0;
    let ref;
    while ((ref = ISSUE_REF_RE.exec(rest)) !== null) found.add(Number(ref[1]));
  }
  return [...found].sort((a, b) => a - b);
}

// #1247 — should the `blocked-by` label be PRESENT? True iff at least one declared
// blocker is still open. Pure, and the exact complement of the openBlockers arm of
// shouldAwaitApproval, so the two labels can never both be present: one function
// decides, the applier mirrors it.
function shouldMarkBlockedBy({ openBlockers } = {}) {
  return Array.isArray(openBlockers) && openBlockers.length > 0;
}

// Map the reviewer's FINAL verdict label — plus whether the PR touches the
// review machinery — to the `ai-review` check-run's conclusion + human-
// readable title/summary.
//
// #480 (this fix, built on #469's verdict-mirroring fix): a 3-way conclusion
// so `ai-review` can be an ALWAYS-ON REQUIRED ruleset check that still
// self-exempts machinery PRs. GitHub required check-runs treat `neutral`/
// `skipped` as PASSING; only `failure`/`pending` BLOCK. That semantics gives
// us, from one check, both a real gate AND a self-exemption with no bypass
// actor and no path-based ruleset exemption (which GitHub doesn't support):
//
//   isMachineryPr === true       → neutral   (EXEMPT. Wins regardless of
//                                   `label` — precedence, checked first. A
//                                   gate cannot certify a change to itself
//                                   (`.github/`/`scripts/`, #476/#477/…), so
//                                   these are neutral and a human reviews.)
//   label === 'ai-review:pass'   → success   (genuinely passed independent
//                                   review)
//   anything else (changes,
//   empty/errored, unrecognised) → failure   (BLOCKS the required check —
//                                   this is the actual gate. Changed from
//                                   #469's `neutral`, which a required check
//                                   reads as passing and therefore never
//                                   gated a normal `changes` verdict.)
//
// `isMachineryPr` MUST be computed from the SAME predicate the workflow's
// anti-self-cert override already uses — changed-file paths matching
// `^(\.github/|scripts/)` (ai-review.yml's `SELF_EDIT_KIND === "machinery"`),
// never a second, divergent definition. It deliberately EXCLUDES the
// "indeterminate" case (the changed-file diff itself could not be computed):
// that case must stay fail-closed to `failure`, not `neutral` — otherwise a
// PR could win the exemption simply by making the diff computation error.
//
// The check's NAME is the shared `CHECK_NAME` constant declared at the top of
// this module — verifyHeadPassCheckRun (#810) reads check-runs by that same
// constant, so the producer and the verifier cannot drift apart (#822).
function decideReviewCheck(label, isMachineryPr) {
  const machinery = isMachineryPr === true;
  const pass = !machinery && label === PASS;

  let conclusion;
  let title;
  let summary;
  if (machinery) {
    conclusion = 'neutral';
    title = 'AI review: machinery PR — exempt, human review required';
    summary =
      'This PR touches the AI-review machinery (`.github/` or `scripts/`). ' +
      'A gate cannot certify a change to itself, so the reviewer force-labels ' +
      'these `ai-review:changes` regardless of the agent\'s verdict. This check ' +
      'is deliberately **neutral** — GitHub treats `neutral` as passing a ' +
      'required check, so a machinery PR is not permanently blocked by its own ' +
      'gate — but a human must still review and approve it before merging.';
  } else if (pass) {
    conclusion = 'success';
    title = 'AI review: passed';
    summary =
      'The independent AI reviewer approved this PR (`ai-review:pass`). ' +
      'See the AI review comment for the findings behind the verdict.';
  } else if (label === BLOCKED) {
    // The reviewer could not run (quota/rate-limit/transient) — NOT a verdict on
    // the code. `action_required` blocks merge (un-reviewed code must not land)
    // while reading as "needs action: re-run", never "changes requested" or a
    // broken-CI failure. The ai-review-retry workflow re-runs it automatically
    // when the quota window resets.
    conclusion = 'action_required';
    title = 'AI review could not run — quota/transient (auto-retries)';
    summary =
      'The independent AI reviewer could **not** complete — almost always the ' +
      'Claude subscription session-quota being exhausted (also rate-limit / ' +
      'overload). **This is not a review of your code.** It blocks merge only ' +
      'because un-reviewed code must not land. It re-runs automatically when the ' +
      'quota window resets (see the ai-review-retry workflow); to unblock sooner, ' +
      'wait for the reset or enable PAYG-API failover (`ANTHROPIC_API_KEY`). See ' +
      'the AI review comment for the reset time and options.';
  } else {
    conclusion = 'failure';
    title = 'AI review: changes requested — this check blocks merge';
    summary =
      'The independent AI reviewer did **not** pass this PR ' +
      '(`ai-review:changes`), the review could not complete, or the verdict ' +
      'was empty/unrecognised. This check is deliberately **failure**: when ' +
      '`ai-review` is required in the branch ruleset, this blocks merge until ' +
      'a human resolves it. See the AI review comment for details.';
  }

  return { name: CHECK_NAME, conclusion, title, summary };
}

// #816 — the "summon a human" decision for the ai-review Post step.
//
// `needs-human-review` must mean exactly ONE thing: a human is GENUINELY the next
// actor — NOT merely "AI review has not passed (yet)". That keeps `awaiting-approval`
// (DR-063) the unambiguous positive "my turn" filter, and stops the human queue
// being polluted by PRs the pipeline will remediate on its own.
//
// A human is the next actor at review-time in exactly one case: a MACHINERY PR
// (changed paths match `.github/`/`scripts/`, the SELF_EDIT_KIND==="machinery"
// predicate). A gate cannot certify a change to itself, so such a PR can NEVER
// auto-remediate to a green `ready-to-merge` — a human must clear it (this pairs
// with the `machinery-review-required` check, #596). That holds whether the
// machinery PR's honest code verdict is `ai-review:pass` or `ai-review:changes`.
//
// It is NOT the next actor — so we do NOT summon one — for:
//   • a NORMAL (non-machinery) `ai-review:changes`, BUT ONLY where the
//     remediation lane exists: `remediate-pr.sh` auto-remediates it (bounded
//     attempts) and applies `needs-human-review` ITSELF only at exhaustion
//     (cap / escalate / quarantine / conflict). Flagging it here at t=0 is
//     premature — the #816 retirement. Where that script is ABSENT (a repo that
//     has not adopted the dispatch lane) the retirement would delegate to
//     nothing, so the eager summon is kept. Deny-by-default: the caller must
//     prove the lane exists via `remediationAvailable: true`.
//   • ANY `ai-review:blocked` (machinery or not): the reviewer could not RUN
//     (quota / rate-limit / overload) — retry-able, NOT a verdict on the code; the
//     ai-review-retry workflow re-runs it. Never a human-review situation.
//   • a passing NON-machinery PR: it belongs in `awaiting-approval`, not here.
//
// This governs only the ADVISORY `needs-human-review` label; the load-bearing merge
// hold is `ready-to-merge` (decideStatus), which stays red independently for every
// un-passed / machinery PR — so retiring the eager label can never let anything
// merge early. Pure and side-effect-free (mirrors shouldAwaitApproval /
// decideReviewCheck) so ai-review.yml decides via this SAME tested seam: bash and
// JS cannot drift. Deny-by-default: a missing/unknown label with isMachinery unset
// returns false (advisory not applied; the gate still holds red).
function shouldSummonHumanReview({ label, isMachinery, remediationAvailable } = {}) {
  if (label === BLOCKED) return false; // retry-able — ai-review-retry re-runs it, never a human
  if (isMachinery === true) return true; // a gate cannot certify a change to itself

  // The #816 retirement is only safe where the delegate it names actually
  // exists. It hands a normal `ai-review:changes` to `remediate-pr.sh`, which
  // applies `needs-human-review` ITSELF at exhaustion. A consuming repo that
  // has not adopted the dispatch lane has no such delegate, so retiring the
  // eager summon there routes a flagged PR to nobody: not auto-remediated, not
  // escalated, just quietly abandoned. Merge safety is unaffected either way
  // (`ready-to-merge` holds red independently) — what is lost is liveness.
  //
  // Deny-by-default: summon unless the caller can PROVE the lane exists.
  // `undefined` therefore keeps the eager behaviour, so a caller that does not
  // pass the flag fails safe rather than silently dropping the backstop.
  if (label === CHANGES && remediationAvailable !== true) return true;

  return false;
}

// Is a label-removal API failure safe to ignore? ONLY a 404 (the label is
// already gone — e.g. a concurrent removal). Any other status (rate limit, 5xx,
// 403) means the forged/stale `ai-review:pass` may STILL be present, so the
// caller must NOT swallow it — it must fail the run so the removal is retried
// rather than left silently in place (the fail-open hole this closes).
function isBenignRemovalError(status) {
  return status === 404;
}

/** Every label this workflow uses to assert a verdict. Exactly one may survive. */
const PENDING = 'ai-review:pending';
const VERDICT_LABELS = [PASS, CHANGES, BLOCKED, PENDING];

/**
 * Which verdict labels must go, and what the PR must look like afterwards (#1468).
 *
 * WIRED — ai-review.yml's Post-verdict step calls this to decide its removals, inside
 * the `verdict-label-coherence` block (#1468 step 2).
 *
 * That step used to add the new label and best-effort-remove the others, discarding
 * both the error and the result. When one removal silently failed, the PR carried
 * `ai-review:pass` AND `ai-review:changes` at once, and `ready-to-merge` read the
 * contradiction as "not passed" — a legitimately-passing PR that could never merge,
 * with nothing on its surface explaining why. Observed on #1430.
 *
 * Pure so the rule is testable without a live PR: the caller does the I/O and then
 * checks its own post-state against `expected`.
 *
 * @param {{current?: string[], verdict: string}} o - `current` = labels on the PR now.
 * @returns {{expected: string[], remove: string[], add: string[]}}
 *   `expected` is the FULL verdict-label set that must be present when done — always
 *   exactly the one verdict. Non-verdict labels (docs-lane, needs-human-review, …) are
 *   never touched and never appear here.
 */
function decideVerdictLabels({ current = [], verdict } = {}) {
  if (!VERDICT_LABELS.includes(verdict)) {
    throw new Error(`decideVerdictLabels: unknown verdict "${verdict}"`);
  }
  const present = new Set(current.filter((l) => VERDICT_LABELS.includes(l)));
  return {
    expected: [verdict],
    remove: VERDICT_LABELS.filter((l) => l !== verdict && present.has(l)),
    add: present.has(verdict) ? [] : [verdict],
  };
}

/**
 * Did the post-state land? Returns null when correct, else a human-readable fault.
 *
 * WIRED — ai-review.yml's Post-verdict step re-reads the PR's labels after
 * reconciling them and fails the step when this returns non-null, so a contradictory
 * post-state is loud instead of a silent merge wedge (#1468 step 2). The returned
 * string is surfaced verbatim in the `::error` annotation, which is why it names the
 * labels it actually saw.
 *
 * The two-step split was forced: ai-review.yml loads control scripts from the TRUSTED
 * BASE, so a workflow calling this before it was on main died with
 * `TypeError: g.verdictLabelFault is not a function` (observed on #1472's first
 * attempt). Seam first, caller second.
 */
function verdictLabelFault({ current = [], verdict } = {}) {
  const got = current.filter((l) => VERDICT_LABELS.includes(l)).sort();
  if (got.length === 1 && got[0] === verdict) return null;
  if (got.length === 0) return `no verdict label present; expected exactly [${verdict}]`;
  if (got.length > 1) {
    return `contradictory verdict labels [${got.join(', ')}]; expected exactly [${verdict}]`;
  }
  return `verdict label is [${got[0]}]; expected exactly [${verdict}]`;
}

// Defensive: GitHub logins are [A-Za-z0-9-] (apps add a `[bot]` suffix), so they
// can never contain markdown/backtick metacharacters — but strip backticks anyway
// so a malformed value can never break out of the code span in an audit comment.
function sanitizeLogin(login) {
  return String(login == null ? '' : login).replace(/`/g, '');
}

module.exports = {
  PASS,
  CHANGES,
  BLOCKED,
  AWAITING_APPROVAL,
  BLOCKED_BY,
  shouldAwaitApproval,
  parseBlockedBy,
  shouldMarkBlockedBy,
  shouldSummonHumanReview,
  isQuotaExhaustion,
  isQuotaExhaustionStrict,
  patchFingerprint,
  renderPatchFingerprint,
  parsePatchFingerprint,
  findReattestableVerdict,
  PATCH_FINGERPRINT_PREFIX,
  parseResetInstant,
  VERDICT_SCHEMA,
  defangProtocolTokens,
  renderVerdictBlock,
  parseCliVerdict,
  parseAllowlist,
  isAuthorizedReviewer,
  decideProvenanceRevert,
  decideStalenessStrip,
  verifyPassProvenance,
  verifyHeadPassStatus,
  verifyHeadPassCheckRun,
  verifyHeadPassWitness,
  PASS_STATUS_CONTEXT,
  CHECK_NAME,
  decideStatus,
  decideReviewCheck,
  isBenignRemovalError,
  sanitizeLogin,
  PENDING,
  VERDICT_LABELS,
  decideVerdictLabels,
  verdictLabelFault,
};
