---
epic: EPIC-003  # SDD Core Methodology
id: SPEC-002
type: design
tier: T4
# Editing voids approval (hash in .minspec/approvals.json → stale); re-run "MinSpec: Approve Spec". DR-012
status: implementing
product: minspec
---

# MinSpec — Design Document

> **⏳ Tier model under revision — review T1–T4 as provisional.** Fork B is accepted
> ([DR-024](../../docs/decisions/DR-024.md)): the unit of ceremony becomes a **risk
> profile** and `tier` (T1–T4) becomes a **derived/display label**; the tier→phase
> ladder will be replaced by risk→phase. Migration is **deferred until reach
> validation [#91](https://github.com/harvest316/minspec/issues/91) clears** (then
> [#90](https://github.com/harvest316/minspec/issues/90)). The T1–T4 content below is
> the live, operative model until then — not final.

**Date:** 2026-05-26
**Status:** Implementing
**Requirements:** [requirements.md](requirements.md)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    VS Code Extension                 │
├─────────┬──────────┬──────────┬──────────┬──────────┤
│ Sidebar │ CodeLens │ Commands │ Walkthru │  Status  │
│ Tree    │ Provider │ Palette  │ Flow     │  Bar     │
├─────────┴──────────┴──────────┴──────────┴──────────┤
│                   Core Services                      │
├──────────┬───────────┬──────────┬───────────────────┤
│ Classify │ Lifecycle │ Harness  │ Session           │
│ Engine   │ Manager   │ Generator│ Enforcer          │
├──────────┴───────────┴──────────┴───────────────────┤
│                   Data Layer                         │
├──────────┬───────────┬──────────┬───────────────────┤
│ Spec     │ Git       │ Config   │ Template          │
│ Store    │ Analyzer  │ Store    │ Registry          │
└──────────┴───────────┴──────────┴───────────────────┘
```

All local. No network. No backend. Filesystem is the database.

---

## Core Services

### 1. Classification Engine (FR-1)

**Approach:** Multi-signal heuristic classifier. No ML — deterministic, fast, debuggable.

```typescript
interface ClassificationResult {
  tier: 'T1' | 'T2' | 'T3' | 'T4';
  confidence: number;          // 0-1
  signals: ClassificationSignal[];
  suggestedPhases: Phase[];    // which phases to execute
  overriddenBy?: 'user';       // if user changed tier
}

interface ClassificationSignal {
  name: string;                // e.g. "files_changed", "new_exports", "schema_change"
  value: number | boolean;
  weight: number;
  tierContribution: 'T1' | 'T2' | 'T3' | 'T4';
}
```

**Signal pipeline:**

```
Git diff → File-level signals → AST signals (optional) → Score → Tier
           │                     │
           ├─ file count         ├─ new exports
           ├─ line count         ├─ new classes/interfaces
           ├─ file types         ├─ schema changes (Prisma, SQL, Zod)
           ├─ cross-directory    ├─ breaking changes (removed exports)
           └─ new files          └─ dependency changes (package.json)
```

**Scoring:** Each signal maps to a tier. Highest-tier signal wins, with confidence = (signals at winning tier) / (total signals). If confidence < 0.5, suggest winning tier but flag uncertainty.

**AST analysis:** Optional. Uses tree-sitter WASM for JS/TS/Python. Falls back to regex heuristics for other languages. Graceful degradation — never blocks on missing parser.

**Calibration:** Store user overrides in `.minspec/calibration.json`. After 20+ overrides, adjust signal weights. Simple exponential moving average, not ML.

### 2. Lifecycle Manager (FR-2, FR-5)

**State machine per spec:**

```
                    ┌──── skip ────┐
                    ▼              │
[new] → [specify] → [clarify] → [plan] → [tasks] → [implement] → [done]
  │         │           │          │         │           │
  │         ▼           ▼          ▼         ▼           ▼
  │      [skipped]  [skipped]  [skipped] [skipped]   [skipped]
  │
  └→ [archived]  (can archive from any state)
```

Phase transitions:
- Forward: always allowed
- Skip: allowed, records reason ("T1 — trivial change")
- Back: allowed with confirmation ("reopening specify will invalidate downstream phases")
- Archive: allowed from any state

**Spec file format** (Spec Kit compatible + extensions):

```markdown
---
id: SPEC-001
title: Add rate limiting to /api/health
tier: T1
status: implementing
created: 2026-05-26
phases:
  specify: done
  clarify: skipped
  plan: skipped
  tasks: done
  implement: in-progress
---

## Specify

Health endpoint needs rate limiting at 100 req/min per IP.

## Tasks

- [x] Add express-rate-limit middleware to health route
- [ ] Add 429 response test
```

Frontmatter fields `tier`, `status`, `phases` are MinSpec extensions. Spec Kit ignores unknown frontmatter — verified compatible.

### 3. Harness Generator (FR-4)

**Template system:**

```
.minspec/
  templates/
    CLAUDE.md.hbs          # Handlebars templates
    AGENTS.md.hbs
    .cursorrules.hbs
    DESIGN.md.hbs
    constitution.md.hbs
```

**Merge strategy for `--refresh`:**

1. Parse existing file into sections (delimited by `## ` headers or `---`)
2. For each section in template:
   - If section exists in user file AND has been modified (hash differs from last generated) → keep user version
   - If section exists in user file AND is unmodified → regenerate from template
   - If section is new in template → append
3. Write merged result
4. Store section hashes in `.minspec/generated-hashes.json`

This preserves user customizations while allowing template updates.

### 4. Session Enforcer (FR-7)

**Scope declaration flow:**

1. On first spec-related command in a session → prompt for scope
2. Store in `.minspec/session.json`: `{ scope, project, type, startedAt, specIds }`
3. Monitor file saves — if saved file is outside spec's file allowlist → surface drift warning
4. Drift warning offers: "Park as issue" / "Add to scope" / "Dismiss"

**Parking lot → GitHub Issues:**

```typescript
interface ParkingLotEntry {
  title: string;
  body: string;
  repo: string;        // auto-detected from git remote
  labels: string[];    // ['idea', 'inbox'] default
  sessionScope: string;
}
```

Uses `gh` CLI for issue creation. If `gh` not available, falls back to writing `.minspec/parking-lot.md` for manual triage.

---

## UI Components

### Sidebar: Spec Tree View

```
MINSPEC
├─ Active Session: "Add rate limiting" (T1)
├─ 📋 Specs
│   ├─ 🟢 SPEC-001: Rate limiting (T1, implementing)
│   ├─ 🟡 SPEC-002: Auth refactor (T3, in-review)
│   ├─ ⚪ SPEC-003: Fix typo (T1, done)
│   └─ 📥 3 archived
├─ 📊 Classification
│   └─ Current diff: T2 (3 files, 87 lines, 1 new export)
└─ ⚙ Settings
```

### CodeLens: Spec Traceability

```typescript
// Requirement: SPEC-001 > "Rate limit at 100 req/min per IP"  ← CodeLens
export function rateLimitMiddleware() {
  return rateLimit({ windowMs: 60000, max: 100 });
}
```

**Mapping storage:** `.minspec/traceability.json`
```json
{
  "SPEC-001": {
    "requirements": {
      "rate-limit-100": {
        "files": ["src/middleware/rate-limit.ts:3-5"],
        "tests": ["tests/rate-limit.test.ts:12-30"]
      }
    }
  }
}
```

Mappings are semi-automated: classifier suggests based on file paths in task list, user confirms/adjusts. Manual mapping always available via CodeLens action.

### Status Bar

```
$(shield) MinSpec: T2 | Specify → Plan → Tasks | 2/5
```

Click opens the active spec panel (the review webview, below).

### Active Spec Panel (implemented) · Review Webview (specified — [SPEC-014](review-webview/requirements.md))

**Implemented today:** the active-spec panel (`views/spec-panel.ts` + pure-HTML
`views/spec-panel-html.ts`) — renders the spec with phase-step progress; its only
write action is toggling task checkboxes.

**Specified, NOT yet built** (SPEC-014, status `specifying`; materialises
[#36](https://github.com/harvest316/minspec/issues/36)): the upgrade to a *review*
webview — rendered (not raw) markdown, selectable text, inline **comment pins**, an
LLM **revision loop** (revision = agent *delegation*, kept Tier-0-safe), per-revision
change-highlighting, and an in-panel **Approve** action (re-hash, DR-012 gate). This
is the *intended* surface for the per-doc review flow — not the current one.

### Dependency Map — planned ([#48](https://github.com/harvest316/minspec/issues/48))

A colour-coded, clickable artifact **minimap** visualising the cross-artifact edges
(`depends_on` / `relates_to` / `supersedes`, the SPEC-012 vocabulary) across specs,
DRs, and epics. **Not yet built** — tracked in #48; would render the same dependency
DAG the next-task resolver (SPEC-012) already computes, so it is a *view* over
existing data, not a new source of truth.

---

## File System Layout

```
project-root/
├─ .minspec/
│   ├─ config.json              # Extension settings
│   ├─ constitution.md          # Project invariants & principles
│   ├─ session.json             # Current session state
│   ├─ calibration.json         # Classifier override history
│   ├─ generated-hashes.json    # Template section hashes
│   ├─ traceability.json        # Spec-to-code mappings
│   └─ templates/               # User-customizable templates
│       ├─ CLAUDE.md.hbs
│       ├─ AGENTS.md.hbs
│       ├─ .cursorrules.hbs
│       └─ DESIGN.md.hbs
├─ specs/                       # Spec files (Spec Kit compatible)
│   ├─ SPEC-001-rate-limiting.md
│   ├─ SPEC-002-auth-refactor.md
│   └─ ...
├─ docs/
│   └─ decisions/               # ADR files
│       ├─ DR-001.md
│       └─ ...
├─ CLAUDE.md                    # Generated + user-edited
├─ AGENTS.md                    # Generated + user-edited
├─ .cursorrules                 # Generated + user-edited
└─ DESIGN.md                    # Generated + user-edited
```

---

## Migration Path to Conformance (Phase 3)

MinSpec Phase 1 lays groundwork for ScroogeLLM conformance integration:

1. **Traceability mappings** (`.minspec/traceability.json`) become the conformance contract — ScroogeLLM's proxy knows which spec requirements map to which code locations
2. **Classification engine** reuses in ScroogeLLM for model routing — same complexity signal pipeline, different output (tier → model selection instead of tier → phase selection)
3. **Spec file format** includes machine-readable acceptance criteria that conformance checker validates against
4. **Extension Pack activation:** When both extensions installed, MinSpec exposes `minspec.conformance.enabled` setting. ScroogeLLM reads traceability mappings and validates AI output against spec requirements pre-delivery.

No MinSpec code changes needed for Phase 3 — just the ScroogeLLM extension reading MinSpec's data files.

---

## Technology Choices

| Component | Choice | Rationale |
|---|---|---|
| Language | TypeScript | VS Code extension standard |
| Bundler | esbuild | Fast, small output, VS Code recommended |
| Template engine | Handlebars | Simple, logic-less, widely understood |
| AST parsing | tree-sitter WASM | Fast, multi-language, used by VS Code itself |
| Git integration | simple-git | Lightweight, well-maintained, no native deps |
| Test framework | Vitest | Fast, TypeScript-native, VS Code extension testing support |
| Spec format | Markdown + YAML frontmatter | Spec Kit compatible, human-readable, git-friendly |

---

## Dependency Budget

3 runtime deps (within budget for a complex extension):
1. `simple-git` — git operations
2. `handlebars` — template rendering
3. `web-tree-sitter` — AST analysis (optional, lazy-loaded)

Dev deps: `vitest`, `esbuild`, `@types/vscode`, `@vscode/test-electron`

---

## Risks & Mitigations

Design-level (approach) risks. Several trace to live issues — that is the section
working, not failing. Per DR-020 (interim; becomes screen-gated under DR-022).

| # | Risk | Likelihood · Impact | Mitigation |
|---|---|---|---|
| R1 | **Classifier floor mis-set** — ceremony is routed off `tier`, but the size classifier (Classification Engine, FR-1) under-tiers subtle small fixes (κ=0.80, n=120). | Med · Med | DR-021 upward-only **ratchet** (predicted tier is a 100%-precise *lower bound*, never auto-down) + DR-022 **consequence axis** (reach) replacing size as the driver. *Evolving — gated on #91.* |
| R2 | **Harness Generator clobbers user edits** — it writes into shared files (CLAUDE.md, AGENTS.md, .cursorrules, DESIGN.md, constitution). A bad merge overwrites hand-authored prose. | Med · High | Marker-bounded merge + `generated-hashes.json` (DR-011): only content *between* MinSpec markers is replaced; everything else preserved (invariant). T0 test on the merge boundary. |
| R3 | **`traceability.json` staleness** — the semi-automated requirement→code map rots as code moves; CodeLens then points at the wrong lines, eroding trust. | High · Med | Re-derive/validate on demand rather than cache as truth; manual override always available via the CodeLens action; surface stale mappings as a diagnostic, never silently. |
| R4 | **Session Enforcer nag fatigue** — false scope-drift warnings (FR-7) train devs to disable the feature, losing the parking-lot too. | Med · Med | Advisory + dismissible (INV #5 override); **propose-not-prompt** scope (FR-7 revision — derive from the next-task resolver, SPEC-012); tune drift sensitivity; warn at boundaries, not every save. |
| R5 | **Tier-0 boundary creep** — design surfaces that need AI (conformance checking; the webview revision loop) pull network/model calls into the air-gapped core, breaking invariant #2 / DR-004. | Med · High | Revision/conformance is **delegation, not in-extension model calls** (SPEC-014 reframe; agent-execute / `claude -p`, DR-015/017). DR-004 tiered consent gates any network. Core stays Tier-0. |
| R6 | **Split-layout fragility** — the design assumes single-file specs with in-file phase sections; the live `type:`-split layout (requirements/design/tasks) breaks that assumption. | High · Med | Tracked: #93 (approve gate refuses split specs), #58 (SPEC id collisions), #96 (frontmatter schema canonicalization). Reconcile the phase-section model with split-layout. |
| R7 | **Conformance over-coupled to ScroogeLLM** — this doc (Migration Path; cf. SPEC-001:202) ties spec-conformance to ScroogeLLM. Conformance needs *an LLM*, which is the Tier-1 AI layer — ScroogeLLM is only an optional cost-optimizer, not a requirement. | Med · Med | Re-point conformance at the Tier-1 AI layer (agent-execute / `claude -p`, DR-015/017); treat ScroogeLLM as optional. Stale two-extension-era coupling — fix when the conformance phase is specced. |
