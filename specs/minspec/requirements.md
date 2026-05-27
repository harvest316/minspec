---
id: SPEC-001
type: requirements
status: implementing
product: minspec
---

# MinSpec — Requirements Specification

**Date:** 2026-05-26
**Status:** Implementing
**Scope:** VS Code extension providing intelligent spec-driven development with complexity-adaptive ceremony.

---

## One-Sentence Scope

A free, agent-agnostic VS Code extension that classifies change complexity and applies proportional SDD ceremony — solving the #1 SDD adoption barrier (overhead) while capturing marketplace position in the 9-month-old, 32K-install, no-dominant-player SDD extension market.

---

## Problem Statement

Every current SDD tool applies uniform ceremony regardless of change size. Martin Fowler documented Kiro generating 16 acceptance criteria for a simple bug fix. HN's top SDD criticism (225pts, 191 comments) is "waterfall with AI." Developers try SDD, hit overhead on small changes, abandon it. No extension adapts.

---

## Target Users

1. **Primary:** Individual developers using AI coding tools (Claude Code, Copilot, Cursor, Cline) who want development discipline without bureaucracy.
2. **Secondary:** Engineering leads mandating SDD adoption who need a tool their team won't revolt against.
3. **Tertiary:** Developers currently using Spec Kit CLI who want a visual layer with intelligent phase-skipping.

---

## Functional Requirements

### FR-1: Change Complexity Classifier

The extension MUST classify every proposed change into one of four complexity tiers before any SDD phases execute.

| Tier | Label | Heuristic signals | Example |
|------|-------|-------------------|---------|
| T1 | Trivial | Single file, <50 lines changed, no new exports, no schema changes, no new dependencies | Fix typo, update constant, tweak CSS |
| T2 | Standard | 2-5 files, <200 lines, no cross-boundary changes, no new public APIs | Add validation, refactor function, fix bug |
| T3 | Complex | 6+ files OR new public APIs OR schema migration OR new dependency | New feature endpoint, DB migration, new package |
| T4 | Architectural | Cross-project impact OR new service OR breaking API change OR new infrastructure | New microservice, auth system rewrite, API v2 |

**Classifier inputs:**
- Git diff analysis (files changed, lines added/removed, file types)
- AST-level analysis where available (new exports, new classes, schema changes)
- User override (always available — classifier suggests, human decides)
- Historical calibration (learn from user's override patterns over time)

### FR-2: Adaptive Phase Selection

Based on complexity tier, the extension MUST select which SDD phases to execute.

| Phase | T1 Trivial | T2 Standard | T3 Complex | T4 Architectural |
|-------|-----------|-------------|------------|------------------|
| **Constitution** | Skip (use project default) | Skip (use project default) | Reference | Create/update |
| **Specify** | One-liner requirement | Requirements list | Full requirements + acceptance criteria | Full + cross-system impact |
| **Clarify** | Skip | Optional (flag ambiguities only) | Required | Required + stakeholder review |
| **Plan** | Skip | Lightweight (approach sentence) | Design document | Full design + ADR entry |
| **Tasks** | Auto-generate single task | Task list | Task DAG with dependencies | Task DAG + milestone gates |
| **Implement** | Direct implementation | Guided implementation | Phase-gated implementation | Phase-gated + review checkpoints |

User can always escalate tier (treat T1 as T2) or skip phases manually. Extension warns but doesn't block.

### FR-3: Spec Kit Compatibility

- MUST read and write Spec Kit's directory structure (`.spec-kit/` or configurable)
- MUST support Spec Kit's four phases (specify, plan, tasks, implement) as a subset of our six-phase model
- MUST interoperate with Spec Kit CLI — files created by either tool are valid in both
- MAY extend Spec Kit file format with optional frontmatter fields (tier, skipped-phases, classifier-confidence)
- MUST NOT require Spec Kit to be installed. Stand-alone operation is default.

### FR-4: Harness File Generation

`minspec init` MUST generate project harness files from templates:

| File | Purpose | Customizable? |
|------|---------|---------------|
| `CLAUDE.md` | Claude Code project instructions | Yes — template + user edits preserved on regenerate |
| `AGENTS.md` | Cross-tool agent instructions (Codex, Copilot) | Yes |
| `.cursorrules` | Cursor-specific rules | Yes |
| `DESIGN.md` | Google Stitch design doc | Yes |
| `.minspec/config.json` | Extension settings (tier thresholds, phase mappings, templates) | Yes |
| `.minspec/constitution.md` | Project constitution (invariants, principles, constraints) | Yes |

Templates are opinionated defaults. User overrides persist across `minspec init --refresh`.

### FR-5: SDD Lifecycle UI

VS Code sidebar panel with:

1. **Spec Tree View** — Hierarchical list of all specs in project, grouped by status (draft / in-review / approved / implementing / done / archived)
2. **Active Spec Panel** — Current spec's phases as a vertical stepper. Completed phases collapsed. Active phase expanded with editor.
3. **Tier Badge** — Complexity tier displayed on each spec. Click to override.
4. **Phase Skip Indicators** — Skipped phases shown as greyed-out steps with "skipped (T1)" label. Click to unskip.
5. **CodeLens Traceability** — Inline annotations in source files showing which spec requirement each function/test implements. Bidirectional: click annotation → jump to spec line. Click spec line → jump to code.

### FR-6: Agent-Agnostic Integration

Extension MUST work with any AI coding tool without requiring that tool's API or subscription:

| Integration | Mechanism |
|---|---|
| Claude Code | Inject spec context into CLAUDE.md. Hooks for session discipline. |
| GitHub Copilot | Inject spec context into workspace instructions. Copilot Chat participant (`@minspec`). |
| Cursor | Inject into .cursorrules. Composer context via workspace files. |
| Cline | Inject into .clinerules or workspace context. |
| Aider | Inject into .aider.conf.yml conventions. |
| Windsurf | Inject into .windsurfrules. |
| Generic | Spec files are plain markdown — any tool can read them from the file system. |

No AI tool dependency. Extension provides structure; AI tool provides generation.

### FR-7: Session Discipline

- MUST enforce session scope declaration before any spec work begins
- MUST detect topic drift (changes to files outside current spec's scope) and prompt parking-lot action
- MUST support GitHub issue creation for parked topics
- Session scope persists across VS Code restarts (stored in `.minspec/session.json`)

### FR-8: Architecture Decision Records

- MUST support `docs/decisions/DR-NNN.md` file format
- Auto-detect when a change is architectural (T4) and prompt for ADR creation
- ADR template includes: context, decision, status, consequences, implementation ref
- Sequential numbering with collision detection

### FR-9: Backlog Management

- MUST support WSJF scoring (Cost of Delay / Job Duration)
- Issue lifecycle: inbox → triaged → agent-ready → wip → done
- GitHub Issues as backing store (not a separate database)
- Label-based filtering and priority views in sidebar

---

## Non-Functional Requirements

### NFR-1: Performance
- Complexity classification MUST complete in <500ms for repos up to 100K files
- Sidebar tree view MUST render in <200ms with up to 500 specs
- CodeLens annotations MUST not add >100ms to editor open time

### NFR-2: Zero Backend
- Extension MUST operate entirely locally. No account, no server, no telemetry.
- All data stored in project directory (`.minspec/`) and user settings.

### NFR-3: Marketplace Standards
- Extension size MUST be <5MB packaged
- MUST score 4+ on VS Code extension quality checklist
- MUST include walkthrough (VS Code Getting Started API) for onboarding

### NFR-4: Extensibility
- Phase definitions MUST be configurable (add/remove/reorder phases via config)
- Tier thresholds MUST be tunable per project
- Templates MUST support user overrides without losing defaults on update

---

## Invariants

These rules MUST NOT be violated by any implementation:

1. **No AI dependency.** Extension works with zero AI tools installed. Specs are plain markdown.
2. **Tiered network consent (DR-004).** Tier 0 (core): zero network calls, fully offline, no accounts, no telemetry. Tier 1 (opt-in): delegates to local CLI tools (`gh`, `claude`), no network code in extension. Tier 2 (MinSpec Pro): network services with explicit consent. No `http`/`https`/`fetch` imports in `packages/minspec` or `packages/shared`.
3. **No lock-in.** Spec files are Spec Kit-compatible markdown. User can delete extension and keep all artifacts.
4. **Ceremony proportional to complexity.** T1 changes MUST NOT require more than one sentence of specification. Enforcement via automated tests.
5. **User override always wins.** Classifier suggests, human decides. No phase is mandatory. No gate blocks without explicit user opt-in.
6. **Harness file regeneration preserves user edits.** `minspec init --refresh` MUST NOT overwrite user customizations in CLAUDE.md, AGENTS.md, etc.

---

## Success Metrics

| Metric | Target | Timeframe |
|--------|--------|-----------|
| Marketplace installs | 5,000 | 90 days post-launch |
| Marketplace rating | 4.5+ stars | 90 days |
| Weekly active users | 1,500 | 90 days |
| ScroogeLLM extension installs (bridge conversion) | 500 | 90 days post-ScroogeLLM launch |
| Spec Kit compatibility issues reported | <5 | 90 days |

---

## Out of Scope (Phase 1)

- Spec conformance checking (Phase 3 — requires ScroogeLLM)
- Proxy integration or ANTHROPIC_BASE_URL injection
- Cost tracking or savings estimation (ScroogeLLM extension's job)
- Paid features or licensing
- Multi-user collaboration features
- CI/CD integration (future: GitHub Actions for spec-gated merges)

---

## Dependencies

| Dependency | Type | Risk |
|---|---|---|
| VS Code Extension API | Runtime | Low — stable API, well-documented |
| Spec Kit file format | Compatibility | Medium — Spec Kit is <1 year old, format may evolve |
| tree-sitter (for AST classification) | Optional runtime | Low — WASM build, widely used in VS Code extensions |
| Git CLI | Runtime | Low — present on all dev machines |

---

## Competitive Positioning

See [vscode-sdd-competitive-landscape-2026-05-26.md](../research/vscode-sdd-competitive-landscape-2026-05-26.md) Section 7 for full two-extension strategy.

**MinSpec's unique angle:** "Just enough spec. Never too much." No other SDD tool adapts ceremony to complexity. This directly addresses the #1 adoption barrier documented across HN discussions, Martin Fowler's analysis, and community feedback.
