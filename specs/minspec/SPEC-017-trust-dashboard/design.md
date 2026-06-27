---
id: SPEC-017
type: design
status: implementing
product: minspec
epic: EPIC-002  # Signpost Integrity
---

# Trust Dashboard — Char-Rework + Superseded Chart (Design)

> Plan phase for [SPEC-017](./requirements.md), **scope M1 + M2 only**. The
> requirements (M1: FR-1..FR-4; M2: FR-5..FR-6; chart: FR-10..FR-12; INVs;
> AC-1..AC-5, AC-9) are binding; this is the HOW. **M3 (time-to-approve /
> engagement — FR-7..FR-9, AC-6..AC-8) is DEFERRED this slice per
> [DR-042](../../../docs/decisions/DR-042.md): it needs engagement capture
> ([SPEC-018](../SPEC-018-spec-custom-editor/requirements.md)).** This design
> *reserves* the data-model seam for it (the optional `reviewStart?` placeholder)
> and ships **nothing** that samples the human — see [§Deferred & Follow-ups](#deferred--follow-ups).
> Implements the git-blob baseline of [DR-043](../../../docs/decisions/DR-043.md)
> and **extends** the committed-record foundation of
> [SPEC-022](../SPEC-022-approval-foundation/design.md)
> ([`approval.ts`](../../../packages/minspec/src/lib/approval.ts) /
> [`approval-store.ts`](../../../packages/minspec/src/lib/approval-store.ts)).

## Approach

M1 and M2 are pure functions of files-on-disk + the committed approval ledger
(INV — Deterministic, FR-12). The build is one coupled change with five seams,
each a thin vertical slice that extends the SPEC-022 approval record rather than
inventing a parallel store:

1. **Extend the record, don't fork it.** `ApprovalRecord`
   ([approval.ts:38-45](../../../packages/minspec/src/lib/approval.ts#L38)) gains
   one required field `baselineBlob: string` (the FR-1 baseline pointer) and one
   **reserved-for-M3** optional field `reviewStart?: string`. `isValidRecord`
   ([approval-store.ts:55-66](../../../packages/minspec/src/lib/approval-store.ts#L55))
   is widened symmetrically. The back-compat read is explicit: a legacy record with
   **no `baselineBlob`** is still a valid *approval* (M1 just has no datapoint for
   it) — never a crash, never a vanished approval (Costly #1).
2. **Mint the baseline at the one approve site.** After `writeRecord`
   ([approval.ts:134](../../../packages/minspec/src/lib/approval.ts#L134)), the
   approve path mints a git blob of the **FR-4 body-only** bytes
   (`git hash-object -w --stdin`), pins it under a **sanitized** ref key
   `refs/minspec/snapshots/<refKey(specPath)>`, and re-writes the sidecar with the
   SHA (DR-043 pts 1-3). Non-git **or** a failed pin → gzip `.minspec/snapshots/`
   fallback (DR-043 pt 5) so the baseline is always pinned *somewhere*. All Tier-0,
   offline, confined to the single SPEC-022 approve write path (A1).
3. **M1 = pure `reworkPct(baselineBody, currentBody)`** in `@aiclarity/shared`
   (Tier-0, no `vscode`/no network — same package as
   [`canonical.ts`](../../../packages/shared/src/canonical.ts)). Char-level diff ÷
   `max(len)` (FR-2, **confirmed** — whitespace-strip variant rejected, §M1). The
   `vscode` glue recovers the baseline via `git cat-file` (or gzip fallback) and
   feeds these two strings in; the metric stays pure (FR-12, INV — Deterministic).
4. **M2 = superseded "wasted review" bar**, leaning on SPEC-022's explicit-terminal
   `superseded` (INV-6). This slice's **only data-model coupling outside this spec**
   is adding `superseded` to `SPEC_STATUSES` + the SPEC-015 lane map (FR-5) — a
   *forcing* dependency, surfaced not buried (§M2, §Deferred).
5. **First chart in MinSpec** — a new inline-SVG section in the existing
   `spec-panel` webview (FR-10), rendered by a **pure** `renderTrustChart(model)`
   string function mounted in the existing
   [spec-panel-html.ts](../../../packages/minspec/src/views/spec-panel-html.ts)
   template. The chart is **static inline SVG with no script**, so it needs no
   nonce (the CSP nonce gates `<script>`, not styles — §Chart). No
   `http`/`https`/`fetch`/`net` import enters `packages/minspec` (INV — Tier-0).

Greenfield note: `grep` confirms **zero** prior `reworkPct`/M1/M2/snapshot code in
`packages/minspec/src` — this is the first instantiation of these metrics.

## Module layout

| File | Status | Gains / loses |
|---|---|---|
| [`packages/shared/src/canonical.ts`](../../../packages/shared/src/canonical.ts) | edit | **Gains** `getSpecBodyOnly(raw): string` (FR-4) — the body-after-frontmatter, reusing the existing `FRONTMATTER_RE` + EOL-normalize. Pure, Tier-0 (`crypto` already imported; this adds none). Does **not** touch `canonicalizeSpec`/`specHash`. |
| `packages/shared/src/rework.ts` | **new** | Owns `reworkPct(baselineBody, currentBody): number` (FR-2) and the vendored `charDelta` (LCS-subsequence DP) it calls. Pure string→number, Tier-0 (no deps). Exported via the barrel. |
| `packages/shared/src/trust-model.ts` | **new** | Owns the pure render contract: `TrustChartModel` type + `renderTrustChart(model): string` (static inline SVG, FR-10/FR-12). Pure string→string; **no** `vscode`, **no** network, **no** `crypto`. |
| [`packages/shared/src/index.ts`](../../../packages/shared/src/index.ts) | edit | `export * from './rework'; export * from './trust-model';` and `getSpecBodyOnly` via the canonical export. |
| [`approval.ts`](../../../packages/minspec/src/lib/approval.ts) | edit | `ApprovalRecord` **gains** `baselineBlob: string` + `reviewStart?: string`. `approveSpec` **gains** the FR-1 baseline mint (blob+ref, gzip fallback) after `writeRecord`, reading the spec file **once** (§Approve write path). New exports: `mintBaseline(...)`, `recoverBaseline(...)`, `refKey(...)`. |
| [`approval-store.ts`](../../../packages/minspec/src/lib/approval-store.ts) | edit | `isValidRecord` **gains** `baselineBlob` (optional string, back-compat — §Data model) + `reviewStart` (optional string) validation. `writeRecord`/`readRecord` unchanged (JSON carries new fields). |
| `packages/minspec/src/lib/trust-metrics.ts` | **new** | `vscode`-free glue: `computeSpecRework(rootDir, specFilePath): number \| undefined` (recover baseline → `reworkPct`) and `computeWastedReview(rootDir, specs): WastedBar[]` (M2). The git/fs reads live here (like file I/O); pure math stays in `@aiclarity/shared`. |
| [`spec.ts`](../../../packages/minspec/src/lib/spec.ts) | edit | `SPEC_STATUSES` ([spec.ts:14](../../../packages/minspec/src/lib/spec.ts#L14)) **gains** `'superseded'` (FR-5) — forces the SPEC-015 lane map (INV-1). `superseded-by` recognized as a known frontmatter field. |
| [`lifecycle.ts`](../../../packages/minspec/src/lib/lifecycle.ts) | edit | `ExplicitTerminal` ([lifecycle.ts:89](../../../packages/minspec/src/lib/lifecycle.ts#L89)) widens `'archived' \| undefined` → `'archived' \| 'superseded' \| undefined` (INV-6; SPEC-022 already routes terminals through `deriveStatus`). |
| [`spec-panel-html.ts`](../../../packages/minspec/src/views/spec-panel-html.ts) | edit | `getHtml` gains a third optional param `trustModel?` (mirroring `classification?`); **gains** a `${chartHtml}` section after `classificationHtml` ([spec-panel-html.ts:158](../../../packages/minspec/src/views/spec-panel-html.ts#L158)) in the template body; calls `renderTrustChart(trustModel)` (no nonce — static SVG). |
| [`spec-panel.ts`](../../../packages/minspec/src/views/spec-panel.ts) | edit | Glue: build the `TrustChartModel` (read-only over specs + ledger, FR-11) and pass it as the new `getHtml(spec, classification, trustModel)` arg ([spec-panel.ts:66](../../../packages/minspec/src/views/spec-panel.ts#L66)). No spec bytes written. |

New files: `rework.ts`, `trust-model.ts`, `trust-metrics.ts`, plus tests. No new
runtime dependency (the diff is vendored — §M1).

## Data model — extend `ApprovalRecord`

The record is the SPEC-022 sidecar
([approval.ts:38-45](../../../packages/minspec/src/lib/approval.ts#L38)). Two fields
added (FR-1, and the M3-reserved placeholder):

```ts
export interface ApprovalRecord {
  readonly specPath: string;     // (unchanged) repo-relative POSIX
  readonly specHash: string;     // (unchanged) canonical hash, FR-3
  readonly approvedAt: string;   // (unchanged) ISO-8601 UTC
  readonly approvedBy: string;   // (unchanged) git config user.email
  readonly tier: Tier;           // (unchanged)
  readonly migrated: boolean;    // (unchanged) FR-5/SPEC-022 backfill flag
  readonly baselineBlob: string; // NEW (FR-1): the FR-4 body-only baseline pointer
                                 //   at approval time. One of THREE forms, frozen
                                 //   forever (committed): a 40-hex git blob SHA |
                                 //   the literal GZIP_MARKER ('gzip:fallback') |
                                 //   '' (both mint paths failed → no M1 datapoint).
  readonly reviewStart?: string; // NEW, RESERVED for M3 (FR-7) — NOT populated this
                                 //   slice. Optional so M3 can backfill later
                                 //   without a second migration. Absent in M1.
}
```

`baselineBlob` is a small closed enum of string forms (SHA | `GZIP_MARKER` | `''`)
so `recoverBaseline` can branch by **exact equality**, never by guessing whether an
arbitrary string is a blob (§gzip fallback).

**On-disk shape** (extends the SPEC-022 example, pretty-printed + trailing newline):

```
.minspec/approvals/specs/minspec/SPEC-007-foo/requirements.md.json
{
  "specPath": "specs/minspec/SPEC-007-foo/requirements.md",
  "specHash": "4baf6583…",
  "approvedAt": "2026-06-27T01:12:00.000Z",
  "approvedBy": "paul@harvest316.com",
  "tier": "T3",
  "migrated": false,
  "baselineBlob": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
}
```
(`reviewStart` is **omitted** in M1 — `JSON.stringify` drops `undefined`.)

**Validation — `isValidRecord` widened symmetrically**
([approval-store.ts:55-66](../../../packages/minspec/src/lib/approval-store.ts#L55)).
This is the back-compat enforcement point; it must accept legacy records (no
`baselineBlob`) **without** dropping them, or every pre-SPEC-017 approval vanishes
(the aggressive risk flagged in the integration map). Therefore `baselineBlob` is
validated as `string | undefined`, not required-string:

```ts
function isValidRecord(v: unknown): v is ApprovalRecord {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.specPath === 'string' &&
    typeof r.specHash === 'string' &&
    typeof r.approvedAt === 'string' &&
    typeof r.approvedBy === 'string' &&
    typeof r.tier === 'string' &&
    typeof r.migrated === 'boolean' &&
    // back-compat: legacy records predate baselineBlob → absent is valid (no M1
    // datapoint), present must be a string. NEVER required, or legacy approvals drop.
    (r.baselineBlob === undefined || typeof r.baselineBlob === 'string') &&
    (r.reviewStart === undefined || typeof r.reviewStart === 'string')
  );
}
```

**Back-compat read rule (explicit).** `readRecord` returns the legacy record intact
(it is a valid approval). `computeSpecRework` (§M1 glue) treats `baselineBlob`
absent **or** `''` as **"no prior review → no M1 datapoint"** and returns
`undefined` — the dashboard renders that spec without a rework figure, never throws
(AC-1 back-compat clause; Failure-mode "legacy record"). This is *softer* than the
integration-map default of making `baselineBlob` required and letting old records
fall out: required-string would silently delete every existing approval, so this
design **rejects** that and keeps the field optional-at-the-validator while
**always populating it on new approvals** (§Approve write path).

> *Satisfies: FR-1 (record carries the baseline pointer), AC-1 back-compat clause,
> INV — Non-destructive (no spec bytes touched), and reserves FR-7's `reviewStart`
> without building M3.*

## Approve write path — mint the FR-4 body-only baseline

Extends `approveSpec`
([approval.ts:115-136](../../../packages/minspec/src/lib/approval.ts#L115)). The
spec file is read **once** at the top; both the canonical hash and the FR-4
body-only baseline are derived from that **same in-memory string**, so there is no
double read and no TOCTOU window where the hashed bytes and the minted baseline
could describe different on-disk states. The record is constructed and written, then
the baseline is minted and the record re-written with the SHA. Sequence:

```ts
export function approveSpec(rootDir, specFilePath, tier, email, now = () => new Date()): ApprovalRecord {
  // 0. Single read — hash and baseline both derive from THESE bytes (no double
  //    read, no TOCTOU skew between specHash and baselineBlob).
  let raw: string;
  try {
    raw = fs.readFileSync(specFilePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read spec file to approve: ${specFilePath}`);
  }
  const hash = specHash(raw);            // canonical-hash boundary (SPEC-022)

  // 1. FR-4 body-only bytes — NOT the canonical-hash boundary. The baseline diff
  //    measures LLM prose, so frontmatter is excluded ENTIRELY (canonical keeps
  //    frontmatter-minus-lifecycle; see §Why two boundaries). Same `raw` string.
  const bodyOnly = getSpecBodyOnly(raw); // @aiclarity/shared
  const specPath = specRelPath(rootDir, specFilePath);

  // 2. Mint + pin the baseline (git blob → sanitized ref), gzip fallback if non-git
  //    OR if the ref pin fails — never leave a blob unpinned (gc would prune it).
  const baselineBlob = mintBaseline(rootDir, specPath, bodyOnly); // '' if all paths fail

  const record: ApprovalRecord = {
    specPath, specHash: hash, approvedAt: now().toISOString(),
    approvedBy: email, tier, migrated: false,
    baselineBlob,                    // reviewStart omitted (M3 reserved)
  };
  writeRecord(rootDir, record);
  return record;
}
```

> Note: `specHash(raw)` is the string-input form of SPEC-022's hash. If `approval.ts`
> currently exposes only a `canonicalSpecHash(path)` that reads the file itself, this
> slice adds/uses the raw-string variant so the single read above can feed it — a pure
> refactor that does not change the canonical boundary.

**`mintBaseline(rootDir, specPath, bodyOnly): string`** (new in `approval.ts`,
Tier-0, reuses the `execFileSync` + try/catch degrade pattern already at
[approval.ts:69-79](../../../packages/minspec/src/lib/approval.ts#L69)):

```ts
const GZIP_MARKER = 'gzip:fallback'; // frozen sentinel: non-hex, ≠ '', stable forever

/** Encode a repo-relative POSIX specPath into a SINGLE, git-legal ref component.
 *  Hashing sidesteps git's ref-name grammar (no '..', no '.lock' suffix, no
 *  leading '.', no control chars, no trailing '/'), which a legal spec path could
 *  otherwise trip — making `update-ref` reject an honest path and strand an
 *  unpinned blob for gc to prune. */
function refKey(specPath: string): string {
  return crypto.createHash('sha256').update(specPath).digest('hex'); // already imported
}

function mintBaseline(rootDir: string, specPath: string, bodyOnly: string): string {
  const buf = Buffer.from(bodyOnly, 'utf-8');
  try {
    // DR-043 pt 1: content-addressed blob (zlib-compressed, deduped; dirty-tree-safe).
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'],
      { cwd: rootDir, input: buf }).toString().trim();
    // DR-043 pt 2: pin against gc under a sanitized, always-legal ref name.
    try {
      execFileSync('git', ['update-ref', `refs/minspec/snapshots/${refKey(specPath)}`, sha],
        { cwd: rootDir, stdio: 'ignore' });
      return sha;                       // blob written AND pinned — durable.
    } catch {
      // Pin failed (shouldn't, given refKey) → the blob is unpinned and gc could
      // prune it later, leaving the ledger SHA dangling. Fall through to a
      // pinned-somewhere fallback instead of returning a fragile SHA.
      return writeGzipFallback(rootDir, specPath, buf) ? GZIP_MARKER : '';
    }
  } catch {
    // DR-043 pt 5: non-git (or git absent) → gzip sidecar, per-machine fallback.
    return writeGzipFallback(rootDir, specPath, buf) ? GZIP_MARKER : '';
  }
}
```

- **FR-4 boundary, exactly.** `bodyOnly = getSpecBodyOnly(raw)` reuses the **same**
  `FRONTMATTER_RE` body split `parseSpec` uses
  ([spec.ts:244-246](../../../packages/minspec/src/lib/spec.ts#L244)) —
  `getSpecBodyOnly` is lifted into `canonical.ts` so there is **one** anchor (the
  drift risk in the map). This is **not** the canonical-hash boundary: see below.
- **Ref key = `sha256(specPath)`, not the raw path.** The path-key is the SPEC-022
  collision-free unique key (INV-5), but git's ref-name grammar forbids several
  things a legal spec path could (rarely) contain — a component ending in `.lock`, a
  `..` sequence, a component starting with `.`, a trailing `/`, control chars (empir-
  ically confirmed `refs/minspec/snapshots/foo.lock` is rejected by `update-ref`).
  Hashing into one hex component makes `update-ref` **never** fail on a legal path,
  so the blob is always pinned and `git gc` cannot silently prune it. The ref stays
  invisible to branch UIs (DR-043 risk row). The `specPath`↔`refKey` map is
  deterministic, so recovery recomputes the same key.
- **Pin failure degrades, never strands.** Even with `refKey`, an `update-ref`
  failure falls through to the gzip fallback (and records `GZIP_MARKER`), so a
  baseline is **always pinned somewhere** — we never return a SHA whose blob is
  unpinned and gc-prunable. A returned 40-hex SHA therefore means "blob written *and*
  pinned by a ref."
- **gzip fallback** (`writeGzipFallback`): `zlib.gzipSync` of the body bytes to
  `.minspec/snapshots/<refKey>.json.gz` (Node stdlib `zlib`, no new dep). The stored
  field becomes the sentinel `GZIP_MARKER` (`'gzip:fallback'`) so `recoverBaseline`
  knows to read the gz; `''` means **all** paths failed (→ no M1 datapoint, never a
  crash).
- **Tier-0 / offline.** `git hash-object`/`update-ref` are local plumbing (no
  network), same posture as the existing `git config user.email` call. Approval
  **never** fails on baseline mint — any git error degrades; the record (and the
  approval) is written regardless (A1, AC-1).

**Recovery — `recoverBaseline(rootDir, record): string | undefined`** (new),
branching on **exact equality** of `record.baselineBlob`:

- `=== ''` or **absent** → `undefined` (no datapoint).
- `=== GZIP_MARKER` → `zlib.gunzipSync` of `.minspec/snapshots/<refKey(specPath)>.json.gz`
  → body string; any read/gunzip error → `undefined`.
- a 40-hex SHA → `git cat-file blob <sha>` → `.toString('utf-8')`; **any error
  (including a later gc-prune that the ledger SHA outlives) → `undefined`, never a
  throw.** Recovery degrading to `undefined` is the contract — a missing blob is a
  missing datapoint, not a crash.

This is the `vscode`-free glue the metric consumes; the metric stays pure (FR-12,
INV — Deterministic).

### Why two boundaries (canonical-hash vs FR-4 body-only)

A one-line comment lands in `canonical.ts` to prevent future conflation:
`specHash` (SPEC-022) keeps **frontmatter-minus-lifecycle + body** so editing
`status`/`phases` does **not** void approval; `getSpecBodyOnly` (SPEC-017 FR-4)
excludes **all** frontmatter so frontmatter churn never registers as the human
reworking the LLM's prose (FR-4, Risk R5). They are intentionally different; the
baseline blob is the **body-only** bytes, not the canonical form.

Consequence to keep in mind (also noted in §M2): because `specHash` covers content
*other than* `status`/`phases`, any content-field frontmatter edit (e.g. adding
`superseded-by:`) **voids the live approval** under SPEC-022 — but the *baseline
blob* is content-addressed and pinned independently of the ledger's `specHash`, so a
voided approval never loses its baseline. `recoverBaseline` reads the **prior**
baseline blob regardless of approval freshness, and degrades to `undefined` only if
the blob itself is truly gone.

> *Satisfies: FR-1 (blob+ref+SHA-in-committed-ledger, gzip fallback), FR-3
> (counts edits anywhere — content, not events: the baseline is content),
> FR-4 (body-only boundary via the existing `parseSpec` split), INV —
> Deterministic, INV — Non-destructive (no spec bytes written), AC-1, AC-9.*

## M1 — `reworkPct` (char-level, confirmed)

Pure function in `packages/shared/src/rework.ts`:

```ts
/** FR-2: share of approved-body chars that differ from the baseline.
 *  changed chars ÷ max(approvedChars, currentChars). Char-level (CONFIRMED).
 *  Range [0,1]; 0 when identical OR when max length is 0 (empty body). */
export function reworkPct(baselineBody: string, currentBody: string): number {
  const denom = Math.max(baselineBody.length, currentBody.length);
  if (denom === 0) return 0;                 // empty body → no div-by-zero (FR-2 edge)
  return charDelta(baselineBody, currentBody) / denom;
}
```

- **`charDelta` is pinned, unambiguously, as `max(len) − LCS`** where `LCS` is the
  **longest common *subsequence*** length (NOT substring/run), computed via the
  standard O(n·m) dynamic-programming table (~40 vendored lines). This is the only
  definition that satisfies AC-2, and it is frozen forever (committed, METRIC v1):

  ```ts
  /** METRIC v1 — DO NOT change without a full re-baseline of every historical
   *  number. changed = max(len) − LCS-SUBSEQUENCE length, standard O(n·m) DP.
   *  Worked AC-2 lock: LCS("abcde","abXde") = "abde" (length 4);
   *    changed = max(5,5) − 4 = 1 ⇒ reworkPct = 1/5 = 0.2.  (substring/run length
   *    would give "ab"/"de" = 2 ⇒ 5−2 = 3 ⇒ 3/5 — WRONG, breaks AC-2.) */
  function charDelta(a: string, b: string): number {
    const n = a.length, m = b.length;
    // DP over LCS subsequence (rolling two rows to keep it O(min(n,m)) memory).
    let prev = new Uint32Array(m + 1);
    let curr = new Uint32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        curr[j] = a[i - 1] === b[j - 1]
          ? prev[j - 1] + 1
          : Math.max(prev[j], curr[j - 1]);
      }
      [prev, curr] = [curr, prev];
      curr.fill(0);
    }
    const lcs = prev[m];
    return Math.max(n, m) - lcs;     // changed chars
  }
  ```

  The earlier draft's "LCS-free / two-pointer / commonRunLength" phrasing is
  **deleted**: a two-pointer contiguous-run scan computes longest common *substring*,
  which yields `3/5` for `"abcde"→"abXde"` and **fails AC-2**. A subsequence LCS
  cannot be computed by a two-pointer scan; the O(n·m) DP above is required and is
  what ships.
- **Diff = vendored, no dependency.** The `diff` npm package is present only as a
  *transitive dev* dep of mocha and is **not** a production dependency of
  `minspec`/`shared`; FR-2 mandates **vendored/no-network**. So `charDelta` (the
  LCS-DP above) is committed to `rework.ts`. **Decision: vendored, zero new dep**
  (Costly #3 lock) — chosen over adding `diff` because Tier-0/no-network is an
  invariant, not a preference, and the algorithm must be pinned forever anyway.
- **`max` denominator, char mode, body-only, LCS-subsequence — locked** (Costly #3).
  Changing any of these silently re-computes *every historical number*; the choice is
  frozen here and the `METRIC v1 — do not change without a re-baseline` comment above
  guards the site, alongside the worked AC-2 example so the lock is reproducible.
- **Whitespace-strip rejected (empirically, hard-data-driven).** A
  whitespace-insensitive variant was considered and **rejected**: it under-counts
  real prose reflow and mis-aligns with the char-level contract; raw char delta is
  the confirmed metric. (Recorded inline per the requirements' resolved-OQ style.)

**Glue (`trust-metrics.ts`, `vscode`-free):**
`computeSpecRework(rootDir, specFilePath)` → recover record; if `baselineBlob`
absent/`''` → `undefined` (no datapoint); if `recoverBaseline(...)` itself returns
`undefined` (blob gone) → `undefined` (no datapoint, never throw); else
`reworkPct(recoverBaseline(...), getSpecBodyOnly(read(specFilePath)))`. The
"current" side is the next approval's baseline if re-approved, else the on-disk body
(FR-2). Pure recompute, same inputs ⇒ same number (INV — Deterministic).

> *Satisfies: FR-2 (char delta ÷ max via LCS-subsequence, vendored/no-network,
> recomputable), FR-4 (body-only via `getSpecBodyOnly`), FR-12 (pure, testable),
> INV — Deterministic, AC-2.*

## M2 — superseded "wasted review" bar

A wholly-replaced spec's previously-approved chars are wasted review, shown as a
**separate bar**, never folded into M1's denominator (FR-6).

- **Dependency (FR-5, surfaced not buried).** `superseded` must join
  `SPEC_STATUSES` ([spec.ts:14](../../../packages/minspec/src/lib/spec.ts#L14)) and
  `ExplicitTerminal` ([lifecycle.ts:89](../../../packages/minspec/src/lib/lifecycle.ts#L89)).
  Per **SPEC-015 INV-1** (total, disjoint status→lane map, T0-tested) this *forces*
  a lane-mapping decision — the intended gate, not an accident. SPEC-022 already
  routes terminals through `deriveStatus(phases, approval, explicitTerminal)` and
  treats them as **human acts, never inferred** (INV-6); `superseded` slots into
  that existing seam (`if (explicitTerminal) return explicitTerminal;`). The
  `superseded-by: SPEC-NNN` link is a recognized frontmatter field.
- **Supersession voids the live approval — and M2 is unaffected by that, by design.**
  Transitioning a spec to `superseded` writes a `superseded-by: SPEC-NNN` frontmatter
  field. That field is a **content field under SPEC-022's canonical hash** (canonical
  strips *only* `status`/`phases`), so adding it changes `specHash` and **voids the
  spec's live approval** (`resolveStatus` → `stale`). M2 deliberately does **not**
  read a fresh approval: it reads the **prior** `baselineBlob` body length (the
  approved chars), which is preserved by the content-addressed blob + ref + committed
  ledger SHA **independently** of approval freshness. So the wasted-chars figure is
  computed from the surviving baseline even though the approval is now stale. The lane
  is still correct because `deriveStatus` returns the explicit terminal `superseded`
  **before** any approval/staleness check. An implementer must NOT assume the approval
  stays `approved` after supersession — it does not; M2 is built to not care.
- **The wasted figure** is read from the **prior committed baseline** of the
  superseded spec (its `baselineBlob` body length = the approved chars at approval
  time), surfaced via `computeWastedReview(rootDir, specs): WastedBar[]` where
  `WastedBar = { specPath: string; approvedChars: number }`. A spec **superseded
  before it was ever approved** (no record / no `baselineBlob` / unrecoverable blob)
  contributes `0` — no phantom waste (Failure-mode).
- **Cross-spec ripple is the cost** (Costly #2): the enum addition touches the spec
  parser, validator, and SPEC-015 lane map. This slice **adds the enum + the lane
  mapping** (forced green by SPEC-015's coverage test) and **defers** any broader
  `superseded` adoption tooling to the tracked SPEC-015 amendment (§Deferred).

> *Satisfies: FR-5 (`superseded` ∈ `SPEC_STATUSES` + `superseded-by`, forcing the
> SPEC-015 lane map via INV-1/INV-6), FR-6 (separate wasted-review bar, not in the
> M1 denominator), AC-4, AC-5.*

## Chart — inline-SVG section in the spec panel

First chart in MinSpec. Pure render in `packages/shared/src/trust-model.ts`,
mounted in the existing spec-panel webview (FR-10, **independent of the unbuilt
SPEC-014**).

```ts
export interface TrustChartModel {
  readonly rework: ReadonlyArray<{ specId: string; pct: number | null }>; // M1 (null = no datapoint)
  readonly wasted: ReadonlyArray<{ specId: string; approvedChars: number }>; // M2
}
/** Pure string→string. STATIC inline SVG only — NO <script>, so NO nonce needed;
 *  NO http/fetch/net, NO vscode, NO crypto, NO remote asset. */
export function renderTrustChart(model: TrustChartModel): string { /* SVG bars */ }
```

- **Render host — the `getHtml` seam.** The webview HTML is built by
  `getHtml(spec, classification?)`
  ([spec-panel-html.ts:81](../../../packages/minspec/src/views/spec-panel-html.ts#L81)),
  called from
  [spec-panel.ts:66](../../../packages/minspec/src/views/spec-panel.ts#L66). This
  slice adds a **third optional param** mirroring the existing `classification?`:
  `getHtml(spec, classification?, trustModel?)`. Inside `getHtml`, after
  `classificationHtml` is built ([line 127-129](../../../packages/minspec/src/views/spec-panel-html.ts#L127)),
  the chart HTML is rendered (`const chartHtml = trustModel ? renderTrustChart(trustModel) : '';`)
  and interpolated into the template body **after** `classificationHtml`
  ([spec-panel-html.ts:158](../../../packages/minspec/src/views/spec-panel-html.ts#L158)).
  `spec-panel.ts:66` builds the `TrustChartModel` read-only over specs + ledger and
  passes it as the new arg. No CDN, no remote font/script.
- **CSP — corrected.** The webview CSP at
  [spec-panel-html.ts:138](../../../packages/minspec/src/views/spec-panel-html.ts#L138)
  is `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`.
  The **nonce gates `<script>`, not styles** — styles (including any `<style>` inside
  the inline SVG) are already permitted by `style-src 'unsafe-inline'` and need **no
  nonce**. `renderTrustChart` emits **static inline SVG with no script**, so it needs
  no nonce at all and `getHtml` does not thread the nonce into it. (The earlier
  draft's "nonce on inner `<style>`" requirement was a misread of the CSP and is
  dropped; it would have been a no-op. If a future iteration adds a `<script>` to the
  chart, *that* script — and only that — must carry `nonce="${nonce}"`.)
- **Tier-0 import-ban.** `trust-model.ts` lives in `@aiclarity/shared` and imports
  nothing networked; `packages/minspec` gains **no** `http`/`https`/`fetch`/`net`
  import (INV — Tier-0 core, mirrors SPEC-014 FR-17). Render is host-agnostic so a
  later review-pane mount is a re-wire, not a rewrite (FR-12, Costly #5).
- **Read-only.** The panel glue computes the model over specs + ledger and writes
  **no** spec byte (FR-11, INV — Non-destructive).

> *Satisfies: FR-10 (inline-SVG, no network, own spec-panel section, CSP-compatible),
> FR-11 (read-only), FR-12 (pure render), INV — Tier-0 core, INV — Non-destructive,
> AC-9.*

## Edge cases (M1/M2)

| Case | Behaviour | Where |
|---|---|---|
| **First-ever approval** (no prior baseline to diff against) | rework `undefined`/"no prior review"; first approval mints the baseline, it is not itself reworked vs nothing. **Not 100%, not div-by-zero.** | `computeSpecRework` (absent baseline ⇒ `undefined`) |
| **Empty body** (`max(approved,current)=0`) | `reworkPct` returns `0` (guard before divide). | `rework.ts` `denom===0` |
| **Legacy record** (no `baselineBlob`) | Valid approval; M1 datapoint `undefined` (chart shows the spec without a bar). Never crash, never drop the approval. | `isValidRecord` optional + glue `undefined` |
| **Non-git repo** | `git hash-object` throws → gzip `.minspec/snapshots/<refKey>.gz` fallback (`GZIP_MARKER`); baseline per-machine; M1/M2 still compute. `''` only if gzip also fails. | `mintBaseline` outer catch |
| **Pathological-but-legal spec path** (e.g. a component ending `.lock` / containing `..`) | `refKey = sha256(specPath)` is always a legal single ref component → `update-ref` never fails on it; blob stays pinned, survives `gc`. | `refKey` + `mintBaseline` |
| **Ref pin fails anyway** | Falls through to the gzip fallback (`GZIP_MARKER`) — baseline pinned *somewhere*, never an unpinned gc-prunable blob with a dangling ledger SHA. | `mintBaseline` inner catch |
| **Baseline blob later gc-pruned / missing on recompute** | `recoverBaseline` → `undefined` ⇒ `computeSpecRework` → `undefined` (no datapoint). **Never throws** on a missing `cat-file`. | `recoverBaseline` catch |
| **Identical re-approval** (same body) | char delta `0` ⇒ `reworkPct = 0` for that round; not counted as reworked (FR-2 diffs content, not the approve event). | `reworkPct` |
| **Superseded before ever approved** | `0` approved chars → contributes nothing to the wasted bar (no phantom/negative waste). | `computeWastedReview` |
| **Superseded after approval** (`superseded-by` voids the live approval) | Approval goes `stale`, but M2 reads the **prior** preserved `baselineBlob` → wasted chars still report; lane stays `superseded` (explicit terminal precedes approval check). | `computeWastedReview` + `deriveStatus` |

## Test plan

T0 invariant tests written **first** (fail pre-change, pass after), under
`packages/minspec/tests/` (vitest) + `packages/shared/tests/`:

| ID | Maps to | Test file · case |
|---|---|---|
| INV — Tier-0 core | FR-10, AC-9 | `tier0-import-ban.test.ts` · grep `packages/minspec/src` for `http`/`https`/`fetch`/`net` import → none (mirrors SPEC-014 FR-17). |
| INV — Non-destructive | FR-11, AC-9 | `trust-nondestructive.test.ts` · build the model + render the chart over a fixture spec → spec bytes **and** `specHash` byte-identical before/after; no sidecar `specHash` changes (opening the dashboard invalidates no approval). |
| INV — Deterministic | FR-2, FR-12, AC-2 | `rework.test.ts` · `reworkPct(a,b)` recomputed twice from the same strings yields the identical number; pure, no `vscode` stub present. |
| INV-6 (terminal honesty) | FR-5, AC-4 | `lifecycle.test.ts` · `deriveStatus` returns `superseded` **only** when `explicitTerminal==='superseded'`, never inferred from phases. |
| SPEC-015 INV-1 | FR-5, AC-4 | SPEC-015 lane-coverage T0 · `superseded ∈ SPEC_STATUSES` ⇒ status→lane map total/disjoint (goes red until the lane is mapped — the forced gate). |
| AC-1 (FR-1) — contract | FR-1 | `approve-baseline.test.ts` · approve a fixture → record carries a 40-hex `baselineBlob`; `refs/minspec/snapshots/<refKey>` exists; `git gc --prune=now` then `git cat-file blob <sha>` still returns the body (gc-survival). |
| AC-1 (FR-1) — pathological path | FR-1 | `approve-baseline.test.ts` · a spec path with a git-illegal-as-ref component (e.g. ends `.lock`, contains `..`) → `update-ref` still succeeds (refKey is hashed); blob pinned + gc-survives. |
| AC-1 (FR-1) — pin-failure fallthrough | FR-1 | `approve-baseline.test.ts` · with `update-ref` forced to fail → `mintBaseline` returns `GZIP_MARKER`, gz written, `recoverBaseline` round-trips (no unpinned-SHA stranding). |
| AC-1 back-compat | FR-1 | `approve-baseline.test.ts` · a legacy record JSON (no `baselineBlob`) still reads as a valid approval; `computeSpecRework` returns `undefined` (no datapoint), no throw. |
| AC-1 missing-blob recovery | FR-1 | `approve-baseline.test.ts` · ledger SHA whose blob is absent (simulated prune) → `recoverBaseline` returns `undefined`, `computeSpecRework` returns `undefined`, **no throw**. |
| AC-1 non-git | FR-1 | `approve-baseline.test.ts` · in a non-git tmp dir, approve → gzip `.minspec/snapshots/*.gz` written, record carries `GZIP_MARKER`; `recoverBaseline` round-trips the body. |
| AC-2 (FR-2/FR-4) | FR-2, FR-4 | `rework.test.ts` · `"abcde"`→`"abXde"` ⇒ exactly `1/5` (LCS-subsequence lock); flip only frontmatter `status:` ⇒ `0%` (body-only excludes frontmatter); empty body ⇒ `0%`; identical ⇒ `0%`; first/no-baseline ⇒ `undefined`. |
| AC-3 (FR-3) | FR-3 | `rework.test.ts` · the same char delta applied via an editor-style string and an agent-style string yields identical `reworkPct` — the metric diffs content, no surface instrumented. |
| AC-5 (FR-6) | FR-6 | `wasted-review.test.ts` · supersede an approved fixture → its approved chars appear in `computeWastedReview` and are **not** in any M1 denominator; **supersession stales the live approval (specHash voided by `superseded-by`) yet wasted-review still reports the prior `approvedChars`**; superseded-before-approved ⇒ `0`. |
| AC-9 (FR-10/11/12) | FR-10, FR-11, FR-12 | `trust-model.test.ts` · `renderTrustChart(model)` returns inline SVG with **no `http`/`https`/`fetch`/`net` import and no remote asset reference** (no `src=`/`href=` to a URL), and **no `<script>`**; pure, no `vscode` stub present; import-ban green. (Asserts inline-static render — **not** a nonce on a `<style>`.) |

`getSpecBodyOnly` parity: a `canonical.test.ts` case asserts it extracts the **same**
body `parseSpec` does (single-anchor guard), and that a spec with no frontmatter
returns the whole content as body (documented behaviour).

## Build order (vertical slices)

1. **`getSpecBodyOnly` + `reworkPct`/`charDelta` + INV — Deterministic / AC-2.** Pure
   shared functions + their tests (body-only parity, LCS-subsequence char delta with
   the worked `"abcde"→"abXde"`=1/5 lock, all edge cases). No store, no git yet —
   proves the metric in isolation, locks Costly #3.
2. **Record extension + back-compat.** `ApprovalRecord` fields + `isValidRecord`
   widening + the legacy-read test (AC-1 back-compat). No git mint yet.
3. **Baseline mint/recover + AC-1.** `refKey`/`mintBaseline`/`recoverBaseline`
   (blob+sanitized ref, pin-failure + gzip fallback) wired into `approveSpec` with the
   single-read refactor; gc-survival + pathological-path + pin-failure + missing-blob
   + non-git tests.
4. **M1 glue + AC-3.** `computeSpecRework`; same-delta-any-surface + missing-blob→
   `undefined` tests.
5. **M2 enum + lane map + INV-6 / SPEC-015 INV-1 / AC-4 / AC-5.** Add `superseded` to
   `SPEC_STATUSES` + `ExplicitTerminal`; map the lane (forced green); wasted-review
   glue + the supersession-stales-approval-yet-wasted-still-reports test.
6. **Chart + INV — Tier-0 / Non-destructive / AC-9.** `renderTrustChart` +
   `getHtml(spec, classification?, trustModel?)` seam + the spec-panel section;
   import-ban + non-destructive + inline-static-SVG tests.

## Risks

| Risk (requirements) | Design-level mitigation |
|---|---|
| **Required `baselineBlob` would drop every legacy approval** (Costly #1, map risk). | Field is validator-**optional** (`string \| undefined`); always populated on *new* approvals; legacy ⇒ no M1 datapoint, never a vanished approval. Back-compat test pins it. |
| **Diff-algorithm drift re-computes all history** (Costly #3, R-unfixable). | Vendored char-delta as `max(len) − LCS-subsequence` (standard O(n·m) DP), `max` denominator, body-only — frozen with a `METRIC v1` guard comment + a worked AC-2 example; zero new dep so the algorithm can't move under us via an upgrade. |
| **Metric defined by a self-contradictory algorithm** (review HIGH). | "LCS-free / two-pointer / commonRunLength" phrasing deleted; only LCS-*subsequence* DP yields AC-2's `1/5`; the worked example is committed beside the impl. |
| **Two body anchors drift** (map risk: `parseSpec` vs new extractor). | `getSpecBodyOnly` lifted into `canonical.ts` reusing the single `FRONTMATTER_RE`; parity test asserts it equals `parseSpec`'s split. |
| **Frontmatter churn counted as rework** (R5). | FR-4 body-only boundary — `getSpecBodyOnly` excludes **all** frontmatter (stricter than canonical-hash); AC-2 `status:`-flip ⇒ 0% test. |
| **Baseline blob pruned by `git gc`** (DR-043). | `refs/minspec/snapshots/<sha256(specPath)>` pin (always git-legal); gc-survival T1 test; on a later miss `recoverBaseline` → `undefined` (no datapoint), never a throw. |
| **A legal spec path makes `update-ref` reject the ref** (review MEDIUM). | Ref component is `sha256(specPath)`, sidestepping git's ref-name grammar entirely; pathological-path test. On any pin failure, fall through to gzip fallback so no unpinned/gc-prunable blob is left behind. |
| **Snapshot/baseline write invalidates the approval** (R6). | Baseline lives in git objects / `.minspec/`, never in the spec file; INV — Non-destructive test asserts spec bytes + hash unchanged. |
| **Supersession voids the live approval and M2 reads a stale one** (review MEDIUM). | `superseded-by` is a canonical-hashed content field → it *does* stale the approval; M2 reads the **prior** content-addressed baseline (preserved by blob+ref+ledger), and `deriveStatus` returns the explicit terminal before the approval check, so wasted-chars and the lane are both correct. Test asserts both. |
| **Approval fails when git absent** (DR-043). | `mintBaseline` try/catch → gzip fallback; approval (and record) always written; `''` ⇒ graceful no-datapoint, never a thrown approval. |
| **`GZIP_MARKER` sentinel ambiguity** (review LOW). | Pinned to the concrete constant `'gzip:fallback'` (non-hex, ≠ `''`, stable forever); `recoverBaseline` branches by exact equality; `baselineBlob` is the closed set {40-hex SHA \| `GZIP_MARKER` \| `''`}. |
| **Double read / TOCTOU between specHash and baseline** (review LOW). | `approveSpec` reads the file once; `specHash(raw)` and `getSpecBodyOnly(raw)` derive from the same in-memory string — no second read, no skew. |
| **`superseded` enum ripples beyond the chart** (Costly #2). | Scoped to enum + lane map this slice (forced green by SPEC-015 INV-1); broader adoption tooling deferred to the tracked SPEC-015 amendment. |

## Deferred & Follow-ups

**Deferred this slice (M3, explicitly out of scope — per DR-042):**

- **M3 time-to-approve / engagement (FR-7, FR-7a, FR-7b, FR-8, FR-9; AC-6, AC-7,
  AC-8; INV — Consensual human telemetry).** Needs an engagement-capture surface
  that does not exist yet; **no** code in this slice samples the human, stores a
  timestamp beyond `approvedAt`, or renders a time axis. The data model is made
  M3-ready by the **reserved `reviewStart?` placeholder** (populated only when M3
  ships) so M3 needs no second `ApprovalRecord` migration.
- **SPEC-018 Spec Custom Editor** — the richest engagement source for FR-7a;
  M3 must work via the plain-editor fallback too, so it is a *soft* dependency, not
  a blocker. Tracked at
  [SPEC-018](../SPEC-018-spec-custom-editor/requirements.md).

**Follow-ups (tracked):**

- **SPEC-015 `superseded` lane amendment (FR-5).** The cross-spec `superseded`
  data-model change (parser/validator/lane map) beyond this dashboard's two-line
  enum/lane addition → file a SPEC-015 amendment / `harvest316/minspec` issue
  before broader adoption (DR-023 forward rule).
- **`refs/minspec/snapshots/*` cross-machine push (DR-043 follow-up).** Refs are a
  local optimisation; the committed ledger SHA is the shared record. Decide whether
  to push the ref namespace for cross-machine baseline recovery → file at implement
  (default: no).
- **Chart polish.** Scatter bucketing for sparse data, axis labelling, and the
  M3 engaged-time × rework scatter (FR-9) all land with M3 — out of scope here; the
  M1/M2 bars ship first.
- **Marketing / site copy** — "measure how much you're rubber-stamping" (non-code,
  never enters SDD) → file a `harvest316/minspec` issue per DR-023 if the team takes
  the angle; `None` if declined.
