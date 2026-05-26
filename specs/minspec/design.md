---
id: SPEC-002
type: design
status: implementing
product: minspec
---

# MinSpec — Design Document

**Date:** 2026-05-26
**Status:** Draft
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
$(shield) MinSpec: T2 | Specify → Plan → Tasks | 2/5 done
```

Click opens active spec panel.

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
