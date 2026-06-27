---
id: SPEC-017
type: tasks
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: implementing
product: minspec
epic: EPIC-002  # Signpost Integrity
---

# MinSpec — Trust Dashboard: Char-Rework + Superseded Chart (Tasks)

**Requirements:** [requirements.md](requirements.md) · **Design:** [design.md](design.md) · **Decisions:** [DR-042](../../../docs/decisions/DR-042.md) (M3 deferral / committed record) · [DR-043](../../../docs/decisions/DR-043.md) (git-blob baseline)

**Scope: M1 + M2 only** (FR-1..FR-6, FR-10..FR-12; INVs; AC-1..AC-5, AC-9). **M3 deferred** (FR-7..FR-9, AC-6..AC-8, INV — Consensual human telemetry) — see [Deferred](#deferred-m3--cross-spec-follow-ups) tail.

Order follows the design's six vertical slices. **Within each slice, T0/T1 test tasks precede the implementation they cover (DR-003 test-first).** Each task names its file allowlist (from the design Module-layout table) and the FR/AC/INV it advances. Tests are vitest under `packages/shared/tests/` and `packages/minspec/tests/`.

---

## Slice 1 — Pure metric: `getSpecBodyOnly` + `reworkPct`/`charDelta` (locks Costly #3, AC-2)

*Goal: prove M1's char metric in isolation — no store, no git. Locks the frozen METRIC v1 algorithm.*

- [ ] **(test, T1)** `packages/shared/tests/canonical.test.ts`: add `getSpecBodyOnly` parity case — asserts it extracts the **same** body `parseSpec` does (single-anchor guard via `FRONTMATTER_RE`), and a spec with **no frontmatter** returns the whole content as body. *(FR-4)* — allowlist: `packages/shared/tests/canonical.test.ts`
- [ ] **(test, T0/T1 — INV — Deterministic, AC-2)** `packages/shared/tests/rework.test.ts`: write the metric lock cases (all must fail pre-impl) — `reworkPct("abcde","abXde") === 1/5` (LCS-**subsequence** lock; substring would give 3/5 and must fail); flip-only-frontmatter ⇒ `0%` (body-only excludes frontmatter); empty body ⇒ `0%`; identical re-approval ⇒ `0%`; recompute twice from same strings ⇒ identical number; no `vscode` stub present (pure). *(FR-2, FR-4, FR-12, AC-2, AC-3 metric-side, INV — Deterministic)* — allowlist: `packages/shared/tests/rework.test.ts`
- [ ] **(impl)** `packages/shared/src/canonical.ts`: add pure `getSpecBodyOnly(raw): string` (body-after-frontmatter, reusing existing `FRONTMATTER_RE` + EOL-normalize). Do **not** touch `canonicalizeSpec`/`specHash`. Add the one-line "two boundaries" comment (canonical = frontmatter-minus-lifecycle + body; `getSpecBodyOnly` = body only). *(FR-4)* — allowlist: `packages/shared/src/canonical.ts`
- [ ] **(impl)** `packages/shared/src/rework.ts` (**new**): `reworkPct(baselineBody, currentBody): number` = `charDelta ÷ max(len)` with `denom===0 ⇒ 0` guard; vendored `charDelta` = `max(len) − LCS-subsequence` via standard O(n·m) DP (rolling two `Uint32Array` rows). Add the frozen `METRIC v1 — DO NOT change without a full re-baseline` guard comment + the worked `"abcde"→"abXde"=1/5` example. **Zero new dependency.** *(FR-2, FR-12, AC-2, Costly #3 lock)* — allowlist: `packages/shared/src/rework.ts`
- [ ] **(impl)** `packages/shared/src/index.ts`: barrel `export * from './rework';` and export `getSpecBodyOnly` via the canonical export. *(FR-2, FR-4)* — allowlist: `packages/shared/src/index.ts`

## Slice 2 — Record extension + back-compat (Costly #1)

*Goal: `ApprovalRecord` carries the FR-1 baseline pointer + the M3-reserved placeholder; legacy records never drop.*

- [ ] **(test, AC-1 back-compat)** `packages/minspec/tests/approve-baseline.test.ts` (**new**): a legacy record JSON (no `baselineBlob`) still reads as a **valid approval** via `isValidRecord`/`readRecord` (not dropped); a record with `reviewStart` absent is valid. (Fails until the validator is widened.) *(FR-1, AC-1 back-compat clause)* — allowlist: `packages/minspec/tests/approve-baseline.test.ts`
- [ ] **(impl)** `packages/minspec/src/lib/approval.ts`: extend `ApprovalRecord` with required `baselineBlob: string` (closed enum of forms: 40-hex SHA | `GZIP_MARKER` | `''`) and **reserved-for-M3** optional `reviewStart?: string`. No write-path change yet. *(FR-1; reserves FR-7 without building M3)* — allowlist: `packages/minspec/src/lib/approval.ts`
- [ ] **(impl)** `packages/minspec/src/lib/approval-store.ts`: widen `isValidRecord` **symmetrically** — validate `baselineBlob` as `string | undefined` (back-compat: absent is valid, present must be string; **never** required-string) and `reviewStart` as `string | undefined`. `writeRecord`/`readRecord` unchanged. *(FR-1, AC-1 back-compat, INV — Non-destructive)* — allowlist: `packages/minspec/src/lib/approval-store.ts`

## Slice 3 — Baseline mint/recover wired into the approve site (AC-1, DR-043)

*Goal: mint the FR-4 body-only baseline as a pinned git blob (gzip fallback), recover it deterministically, never throw, never strand an unpinned blob.*

- [ ] **(test, AC-1 — contract)** `packages/minspec/tests/approve-baseline.test.ts`: approve a fixture → record carries a 40-hex `baselineBlob`; `refs/minspec/snapshots/<refKey>` exists; `git gc --prune=now` then `git cat-file blob <sha>` still returns the body (gc-survival). *(FR-1, AC-1)* — allowlist: `packages/minspec/tests/approve-baseline.test.ts`
- [ ] **(test, AC-1 — pathological path)** same file: a spec path with a git-illegal-as-ref component (ends `.lock`, contains `..`) → `update-ref` still succeeds (refKey is `sha256(specPath)`); blob pinned + gc-survives. *(FR-1)* — allowlist: `packages/minspec/tests/approve-baseline.test.ts`
- [ ] **(test, AC-1 — pin-failure fallthrough)** same file: with `update-ref` forced to fail → `mintBaseline` returns `GZIP_MARKER`, gz written, `recoverBaseline` round-trips (no unpinned-SHA stranding). *(FR-1)* — allowlist: `packages/minspec/tests/approve-baseline.test.ts`
- [ ] **(test, AC-1 — non-git)** same file: in a non-git tmp dir, approve → gzip `.minspec/snapshots/<refKey>.json.gz` written, record carries `GZIP_MARKER`; `recoverBaseline` round-trips the body. *(FR-1)* — allowlist: `packages/minspec/tests/approve-baseline.test.ts`
- [ ] **(test, AC-1 — missing-blob recovery)** same file: ledger SHA whose blob is absent (simulated prune) → `recoverBaseline` returns `undefined`, **no throw**. *(FR-1, INV — Deterministic)* — allowlist: `packages/minspec/tests/approve-baseline.test.ts`
- [ ] **(test, INV — Non-destructive)** `packages/minspec/tests/trust-nondestructive.test.ts` (**new**): approving a fixture writes **no** spec bytes and changes no spec `specHash` (baseline lives in git objects / `.minspec/`, never in the spec file). *(FR-11, INV — Non-destructive, AC-9 non-destructive clause)* — allowlist: `packages/minspec/tests/trust-nondestructive.test.ts`
- [ ] **(impl)** `packages/minspec/src/lib/approval.ts`: add `refKey(specPath)` = `sha256(specPath)` (single git-legal ref component), the frozen `GZIP_MARKER = 'gzip:fallback'` sentinel, `mintBaseline(rootDir, specPath, bodyOnly): string` (`git hash-object -w --stdin` → `update-ref refs/minspec/snapshots/<refKey>` → SHA; pin-failure **and** non-git both fall through to `writeGzipFallback` ⇒ `GZIP_MARKER`; all-paths-fail ⇒ `''`), `writeGzipFallback` (`zlib.gzipSync` to `.minspec/snapshots/<refKey>.json.gz`), and `recoverBaseline(rootDir, record)` branching by **exact equality** (`''`/absent ⇒ `undefined`; `GZIP_MARKER` ⇒ gunzip; 40-hex ⇒ `git cat-file blob`; **any error ⇒ `undefined`, never throw**). Reuse the existing `execFileSync` + try/catch degrade pattern. All Tier-0/offline. *(FR-1, FR-3 baseline-is-content, INV — Deterministic, AC-1)* — allowlist: `packages/minspec/src/lib/approval.ts`
- [ ] **(impl)** `packages/minspec/src/lib/approval.ts`: extend `approveSpec` — read the spec file **once**; derive both `specHash(raw)` and `bodyOnly = getSpecBodyOnly(raw)` from the **same in-memory string** (no double read, no TOCTOU); call `mintBaseline` **after** the record is built and write the `baselineBlob` (`reviewStart` omitted). Approval **never** fails on baseline mint — any git error degrades, the record is written regardless. (Add/use the raw-string `specHash(raw)` form if only a path form exists — pure refactor, canonical boundary unchanged.) *(FR-1, FR-3, FR-4, INV — Non-destructive, A1, AC-1)* — allowlist: `packages/minspec/src/lib/approval.ts`

## Slice 4 — M1 glue (`computeSpecRework`) + AC-3

*Goal: the `vscode`-free glue that recovers the baseline and feeds `reworkPct`; same delta on any surface yields the same number; first-ever / no-baseline yields no datapoint (never 0%/100%/throw).*

- [ ] **(test, AC-3)** `packages/minspec/tests/trust-metrics.test.ts` (**new**): the **same** char delta applied via an editor-style on-disk body and an agent-style on-disk body yields identical `computeSpecRework` — no surface instrumented, the file is the source of truth; a record with `baselineBlob` absent/`''` ⇒ `undefined` (no datapoint); a recoverable baseline ⇒ correct `reworkPct`; an unrecoverable (missing) blob ⇒ `undefined`, no throw. *(FR-2, FR-3, AC-1 back-compat, AC-3, INV — Deterministic)* — allowlist: `packages/minspec/tests/trust-metrics.test.ts`
- [ ] **(test, AC-2 — first-ever/no-baseline edge)** `packages/minspec/tests/trust-metrics.test.ts`: a **first-ever approval** (no prior baseline to diff against — mints its own, nothing to compare) ⇒ `computeSpecRework` returns `undefined` — **never `0%`, never `100%`, never div-by-zero, never throw** (matches design Edge-cases "First-ever approval" row + the AC-2 "first/no-baseline ⇒ undefined" clause). *(FR-2, FR-4, AC-2, INV — Deterministic)* — allowlist: `packages/minspec/tests/trust-metrics.test.ts`
- [ ] **(test, INV — Deterministic — git-read side)** `packages/minspec/tests/trust-metrics.test.ts`: `computeSpecRework(root, specPath)` called **twice with no intervening change** to the repo state returns an **identical** number — locks the git-read/fs side of determinism (the pure-string side is locked in Slice 1's `rework.test.ts`). *(FR-2, FR-12, AC-2, INV — Deterministic)* — allowlist: `packages/minspec/tests/trust-metrics.test.ts`
- [ ] **(impl)** `packages/minspec/src/lib/trust-metrics.ts` (**new**): `computeSpecRework(rootDir, specFilePath): number | undefined` — recover record; `baselineBlob` absent/`''` ⇒ `undefined`; `recoverBaseline` ⇒ `undefined` ⇒ `undefined`; else `reworkPct(recoverBaseline(...), getSpecBodyOnly(read(specFilePath)))`. First-ever approval surfaces as absent-baseline ⇒ `undefined` (no phantom 0%/100%). Git/fs reads live here; pure math stays in `@aiclarity/shared`. *(FR-2, FR-3, FR-4, FR-12, INV — Deterministic, AC-2, AC-3)* — allowlist: `packages/minspec/src/lib/trust-metrics.ts`

## Slice 5 — M2: `superseded` enum + lane map + wasted-review bar (AC-4, AC-5)

*Goal: bring specs to `superseded` parity (forced through the SPEC-015 lane gate) and surface previously-approved chars as a separate wasted-review bar. **Red→green ordering is load-bearing:** the SPEC-015 INV-1 coverage test only goes red once `superseded` is added to `SPEC_STATUSES` — so the enum widening lands first, the coverage test is then observed FAILING (superseded unmapped), then the lane is mapped to turn it green. Running the coverage test before the enum edit shows a still-green, un-exercised gate.*

- [ ] **(test, T0 — INV-6 terminal honesty)** `packages/minspec/tests/lifecycle.test.ts`: `deriveStatus` returns `superseded` **only** when `explicitTerminal==='superseded'`, never inferred from phases. *(FR-5, AC-4, INV-6)* — allowlist: `packages/minspec/tests/lifecycle.test.ts`
- [ ] **(test, AC-5)** `packages/minspec/tests/wasted-review.test.ts` (**new**): supersede an approved fixture → its approved chars appear in `computeWastedReview` and are **not** in any M1 denominator; **supersession voids the live approval (`specHash` changed by `superseded-by`) yet wasted-review still reports the prior `approvedChars`** (read from the preserved baseline); superseded-before-ever-approved ⇒ `0` (no phantom waste). *(FR-6, AC-5)* — allowlist: `packages/minspec/tests/wasted-review.test.ts`
- [ ] **(impl, step 1 — widen enum/terminal)** `packages/minspec/src/lib/spec.ts`: add `'superseded'` to `SPEC_STATUSES` ([spec.ts:14](../../../packages/minspec/src/lib/spec.ts#L14)); recognize `superseded-by: SPEC-NNN` as a known frontmatter field. *(FR-5, AC-4)* — allowlist: `packages/minspec/src/lib/spec.ts`
- [ ] **(impl, step 1 — widen enum/terminal)** `packages/minspec/src/lib/lifecycle.ts`: widen `ExplicitTerminal` ([lifecycle.ts:89](../../../packages/minspec/src/lib/lifecycle.ts#L89)) `'archived' | undefined` → `'archived' | 'superseded' | undefined`; `superseded` slots into the existing `if (explicitTerminal) return explicitTerminal;` seam (terminal precedes the approval/staleness check). *(FR-5, AC-4, INV-6)* — allowlist: `packages/minspec/src/lib/lifecycle.ts`
- [ ] **(test, T0 — SPEC-015 INV-1 — observe RED)** `packages/minspec/tests/spec-tree-provider.test.ts`: with `superseded` now in `SPEC_STATUSES` (step 1), the existing INV-1 case `'INV-1: lanes cover every SpecStatus exactly once (total + disjoint)'` ([spec-tree-provider.test.ts:543](../../../packages/minspec/tests/spec-tree-provider.test.ts#L543)) **now FAILS** (the `STATUS_GROUPS` map no longer covers every status — `superseded` is unmapped). This is the forced lane gate; it is not runnable-red until the enum edit above lands. *(FR-5, AC-4, SPEC-015 INV-1)* — allowlist: `packages/minspec/tests/spec-tree-provider.test.ts`
- [ ] **(impl, step 2 — map the lane → GREEN)** `packages/minspec/src/views/spec-tree-provider.ts`: map the new `superseded` status into the `STATUS_GROUPS` status→lane map ([spec-tree-provider.ts:154](../../../packages/minspec/src/views/spec-tree-provider.ts#L154)) — a terminal collapsed lane — turning the SPEC-015 INV-1 coverage test green (the forced lane decision, not left partial). *(FR-5, AC-4, SPEC-015 INV-1)* — allowlist: `packages/minspec/src/views/spec-tree-provider.ts`
- [ ] **(impl)** `packages/minspec/src/lib/trust-metrics.ts`: add `computeWastedReview(rootDir, specs): WastedBar[]` where `WastedBar = { specPath: string; approvedChars: number }` — read each superseded spec's **prior** `baselineBlob` body length (approved chars at approval time, preserved independently of approval freshness); superseded-before-approved / no-record / unrecoverable ⇒ `0`. Must **not** assume the approval stays `approved` after supersession. *(FR-6, AC-5)* — allowlist: `packages/minspec/src/lib/trust-metrics.ts`

## Slice 6 — Chart: inline-SVG section in the spec panel (AC-9, INV — Tier-0, INV — Non-destructive)

*Goal: MinSpec's first chart — a pure, host-agnostic, network-free inline-SVG section mounted in the existing spec panel; read-only over specs + ledger.*

- [ ] **(test, T0 — INV — Tier-0 core)** `packages/minspec/tests/tier0-import-ban.test.ts`: grep `packages/minspec/src` for any `http`/`https`/`fetch`/`net` import → none (mirrors SPEC-014 FR-17). *(FR-10, AC-9, INV — Tier-0 core)* — allowlist: `packages/minspec/tests/tier0-import-ban.test.ts`
- [ ] **(test, AC-9 — pure render)** `packages/shared/tests/trust-model.test.ts` (**new**): `renderTrustChart(model)` returns inline SVG with **no** `http`/`https`/`fetch`/`net` import, **no** remote asset (`src=`/`href=` to a URL), and **no** `<script>`; pure, no `vscode` stub present. (Asserts inline-static render — **not** a nonce on a `<style>`.) *(FR-10, FR-12, AC-9, INV — Tier-0 core)* — allowlist: `packages/shared/tests/trust-model.test.ts`
- [ ] **(test, INV — Non-destructive)** `packages/minspec/tests/trust-nondestructive.test.ts`: build the `TrustChartModel` + render the chart over a fixture spec → spec bytes **and** `specHash` byte-identical before/after; no sidecar `specHash` changes (opening the dashboard invalidates no approval). *(FR-11, AC-9, INV — Non-destructive)* — allowlist: `packages/minspec/tests/trust-nondestructive.test.ts`
- [ ] **(impl)** `packages/shared/src/trust-model.ts` (**new**): `TrustChartModel` type (`rework: {specId, pct: number|null}[]` + `wasted: {specId, approvedChars}[]`) and pure `renderTrustChart(model): string` emitting **static inline SVG bars, no `<script>`** (so no nonce), no `vscode`, no network, no `crypto`, no remote asset. *(FR-10, FR-12, AC-9, INV — Tier-0 core)* — allowlist: `packages/shared/src/trust-model.ts`
- [ ] **(impl)** `packages/shared/src/index.ts`: barrel `export * from './trust-model';`. *(FR-10, FR-12)* — allowlist: `packages/shared/src/index.ts`
- [ ] **(impl)** `packages/minspec/src/views/spec-panel-html.ts`: `getHtml` gains a third optional param `trustModel?` (mirroring `classification?`); render `const chartHtml = trustModel ? renderTrustChart(trustModel) : '';` and interpolate `${chartHtml}` into the template body **after** `classificationHtml` ([spec-panel-html.ts:158](../../../packages/minspec/src/views/spec-panel-html.ts#L158)). **No nonce threaded** (static SVG; CSP `style-src 'unsafe-inline'` already covers styles, the nonce gates `<script>` only). *(FR-10, AC-9)* — allowlist: `packages/minspec/src/views/spec-panel-html.ts`
- [ ] **(impl)** `packages/minspec/src/views/spec-panel.ts`: glue — build the `TrustChartModel` **read-only** over specs + ledger (`computeSpecRework` per spec, `computeWastedReview` for M2) and pass it as the new `getHtml(spec, classification, trustModel)` arg ([spec-panel.ts:66](../../../packages/minspec/src/views/spec-panel.ts#L66)). Write **no** spec byte. *(FR-10, FR-11, FR-12, AC-9, INV — Non-destructive)* — allowlist: `packages/minspec/src/views/spec-panel.ts`

## Wire-up & verification

- [ ] Run `npm run build` (all packages) — `@aiclarity/shared` exports resolve in `packages/minspec`. — allowlist: none (build)
- [ ] Run `npm test` — all new T0/T1/T2 tests green; pre-existing suite still green (especially `approval.test.ts`, `approval-store.test.ts`, `lifecycle.test.ts`, `spec-tree-provider.test.ts` SPEC-015 lane coverage). — allowlist: none (test)
- [ ] Run `npm run validate` — frontmatter validation passes with `superseded` now a known status. — allowlist: none (validate)
- [ ] `git diff --name-only` review: confirm changes stay within the allowlists above; no spec body bytes mutated (INV — Non-destructive). — allowlist: none (review)

---

## Definition of Done

*Every M1+M2 AC + every applicable INV mapped to the task(s) that satisfy it. M3 ACs/INV are out of scope (see Deferred).*

| AC / INV | Satisfied by |
|---|---|
| **AC-1** (FR-1 — blob+ref+SHA in ledger; gc-survival; pathological path; pin-failure→gzip; non-git→gzip; back-compat legacy read; missing-blob no-throw) | Slice 2 (record + validator widening + back-compat test), Slice 3 (all `approve-baseline.test.ts` cases + `mintBaseline`/`recoverBaseline`/`refKey` + single-read `approveSpec`) |
| **AC-2** (FR-2/FR-4 — `1/5` LCS-subsequence lock; frontmatter-flip ⇒ 0%; empty ⇒ 0%; deterministic recompute; first-ever/no-baseline ⇒ undefined) | Slice 1 (`rework.test.ts` lock cases + `reworkPct`/`charDelta` METRIC v1 + `getSpecBodyOnly`) + Slice 4 (`trust-metrics.test.ts` first-ever/no-baseline ⇒ `undefined` + git-read deterministic recompute + `computeSpecRework`) |
| **AC-3** (FR-3 — same delta any surface ⇒ same M1; file is source of truth) | Slice 1 (metric-side cases) + Slice 4 (`trust-metrics.test.ts` editor-vs-agent body) |
| **AC-4** (FR-5 — `superseded ∈ SPEC_STATUSES` + `superseded-by`; SPEC-015 lane map total) | Slice 5 (`spec.ts` enum + `lifecycle.ts` terminal + `spec-tree-provider.ts` lane map + `lifecycle.test.ts` + `spec-tree-provider.test.ts` INV-1 coverage red→green) |
| **AC-5** (FR-6 — separate wasted-review bar, not in M1 denominator; survives approval-void) | Slice 5 (`wasted-review.test.ts` + `computeWastedReview`) |
| **AC-9** (FR-10/11/12 — inline-SVG own spec-panel section; no network import; no spec mutation / no approval invalidated) | Slice 6 (`trust-model.ts` + `tier0-import-ban.test.ts` + `trust-model.test.ts` + `trust-nondestructive.test.ts` + `spec-panel-html.ts`/`spec-panel.ts` seam) |
| **INV — Tier-0 core** (no `http`/`https`/`fetch`/`net` in `packages/minspec`) | Slice 6 (`tier0-import-ban.test.ts`; `trust-model.ts` in `@aiclarity/shared`, network-free) |
| **INV — Non-destructive** (no spec bytes / no `specHash` change; opening dashboard invalidates no approval) | Slice 3 + Slice 6 (`trust-nondestructive.test.ts`); all baseline state in git objects / `.minspec/` |
| **INV — Deterministic** (M1/M2 pure fns of body + baseline + ledger; same inputs ⇒ same numbers) | Slice 1 (`rework.test.ts` pure-string recompute) + Slice 3 (`recoverBaseline` no-throw degrade) + Slice 4 (`computeSpecRework` git-read recompute-twice-identical + missing-blob ⇒ `undefined`) |
| **INV-6** (terminal honesty — `superseded` never inferred) | Slice 5 (`lifecycle.test.ts` + `deriveStatus` explicit-terminal seam) |
| **SPEC-015 INV-1** (total, disjoint status→lane map) | Slice 5 (`spec-tree-provider.test.ts` INV-1 coverage red-then-green; `STATUS_GROUPS` updated in `spec-tree-provider.ts`, not left partial) |

---

## Deferred (M3 + cross-spec follow-ups)

*Explicitly out of this slice — recorded so they are not silently dropped.*

- **M3 — time-to-approve / engagement** (FR-7, FR-7a, FR-7b, FR-8, FR-9; **AC-6, AC-7, AC-8**; **INV — Consensual human telemetry**). Deferred per DR-042: needs an engagement-capture surface that does not exist yet. **No** task here samples the human, stores a timestamp beyond `approvedAt`, or renders a time axis. The data model is left M3-ready by the **reserved `reviewStart?` placeholder** (Slice 2) so M3 needs no second `ApprovalRecord` migration.
- **SPEC-018 Spec Custom Editor** — richest engagement source for FR-7a; a *soft* dependency (M3 must also work via the plain-editor fallback), not built here. Tracked at [SPEC-018](../SPEC-018-spec-custom-editor/requirements.md).
- **SPEC-015 `superseded` lane amendment** — this slice adds only the enum + lane mapping; broader `superseded` adoption tooling across parser/validator → file a SPEC-015 amendment / `harvest316/minspec` issue before broader adoption (DR-023 forward rule).
- **`refs/minspec/snapshots/*` cross-machine push** (DR-043 follow-up) — refs are a local optimisation; the committed ledger SHA is the shared record. Decide whether to push the ref namespace for cross-machine baseline recovery → file at implement (default: no).
- **Chart polish** — scatter bucketing for sparse data, axis labelling, and the M3 engaged-time × rework scatter (FR-9) land with M3; the M1/M2 bars ship first.
- **Marketing / site copy** — "measure how much you're rubber-stamping" (non-code, never enters SDD) → file a `harvest316/minspec` issue per DR-023 if the team takes the angle; `None` if declined.
