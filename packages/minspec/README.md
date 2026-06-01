# MinSpec

> Just enough Spec. Never too much.


[![Tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/harvest316/minspec/badges/tests.json)](https://github.com/harvest316/minspec/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/harvest316/minspec/badges/coverage.json)](https://github.com/harvest316/minspec/actions/workflows/ci.yml)
[![No AI Required](https://img.shields.io/badge/AI-not%20required-lightgrey.svg)](https://github.com/harvest316/minspec)
[![Internet not required](https://img.shields.io/badge/Internet-not%20required-lightgrey.svg)](https://github.com/harvest316/minspec)
[![Privacy first](https://img.shields.io/badge/Privacy-first-brightgreen.svg)](#what-minspec-does-on-your-network)

## Why This Exists

Every [specification-driven development](https://github.com/spec-kit/spec-kit) tool applies the same ceremony to every change. A one-line bug fix gets the same multi-page spec treatment as a full architecture rewrite. Developers try SDD, hit the overhead on small changes, and abandon it.

MinSpec fixes this. It classifies each change by complexity and applies proportional ceremony -- a trivial fix needs one sentence of spec, while an architectural change gets a full design document. You get the discipline of specification-driven development without the bureaucracy.

> **More info:** [**minspec.dev**](https://minspec.dev) — full methodology, FAQ, stack diagram, and the case for adaptive ceremony.

## Methodology Stack

MinSpec is mostly **SDD** (Spec-Driven Development, ~70%) with a thin **CDD** layer (Contract-Driven Development, ~15%) and a few borrowed best practices: ADR, WSJF, GTD-style session discipline. Bug fixes follow **RCDD** (Root-Cause-Driven Debugging) — a separate lifecycle, because bug-fix work doesn't fit a feature-shaped process.

![MinSpec methodology stack — SDD spine with CDD layer and satellite practices](https://raw.githubusercontent.com/harvest316/minspec/main/packages/minspec/media/methodology-stack.png)

Full explanation, attribution to source methodologies, and FAQ at [**minspec.dev/#methodology**](https://minspec.dev/#methodology).

## What MinSpec Does on Your Network

The MinSpec extension itself makes **zero network calls** — no telemetry, no analytics, no accounts, no backend. All spec data lives in your project directory.

Three opt-in commands shell out to your local [GitHub CLI](https://cli.github.com/) (`gh`) when you invoke them:

- **MinSpec: Park Topic** — creates a GitHub Issue via `gh issue create`
- **MinSpec: Quick Triage Inbox Issue** — labels/comments via `gh issue edit`
- **MinSpec: Refresh Backlog** — lists issues via `gh issue list`

These run under your own GitHub authentication and only when you trigger them. If `gh` isn't installed, MinSpec falls back to local files (e.g. `.minspec/parking-lot.md`). Nothing else in the extension contacts a network.

## Quick Start

1. Install MinSpec from the VS Code Marketplace.
2. Open your project in VS Code.
3. MinSpec auto-detects your project state and offers setup actions as toasts -- accept "Initialize", "Refresh", or "Classify" when prompted.
4. Write your spec -- MinSpec tells you how much (or how little) you need.

![MinSpec Sidebar](https://raw.githubusercontent.com/harvest316/minspec/main/packages/minspec/media/screenshots/sidebar.png)

### What Initialization Produces — Files & AI Tool Integration

When you accept the "Initialize" toast, MinSpec scaffolds the SDD structure for your project. The same files double as integration points: any AI coding tool that already reads these conventions (Claude Code, Cursor, Cline, Aider, Windsurf, Copilot) automatically picks up your active spec context, because MinSpec injects it into the file the tool already loads.

| Path | Purpose | Picked up by |
|------|---------|--------------|
| `CLAUDE.md` | Project instructions + active spec context block | Claude Code |
| `AGENTS.md` | Cross-tool agent instructions + active spec context | GitHub Copilot, Codex, generic agent runners |
| `.cursorrules` | Cursor-specific rules + active spec context | Cursor |
| `.clinerules` | Cline-specific rules + active spec context | Cline |
| `CONVENTIONS.md` | Project conventions + active spec context | Aider (auto-loads) |
| `.windsurfrules` | Windsurf-specific rules + active spec context | Windsurf |
| `DESIGN.md` | Design document template | Humans + LLMs reviewing architecture |
| `.minspec/constitution.md` | Project invariants and principles | MinSpec classifier + humans |
| `.minspec/config.json` | Tier thresholds, phase mappings, spec dir | MinSpec extension |
| `.minspec/session.json` | Current session scope + file allowlist | MinSpec drift detection |
| `.minspec/preferences.json` | Auto-bootstrap prompt preferences | MinSpec extension |
| `.minspec/calibration.json` | Persisted user overrides for classifier learning | MinSpec classifier |
| `.minspec/traceability.json` | Code-to-spec requirement mappings | MinSpec CodeLens |
| `.minspec/parking-lot.md` | Out-of-scope items when `gh` CLI unavailable | MinSpec park command |
| `specs/SPEC-NNN-*.md` | Individual spec files (markdown, Spec Kit-compatible) | MinSpec + Spec Kit + humans |
| `docs/decisions/DR-NNN.md` | Architecture Decision Records | MinSpec ADR tree + humans |
| `docs/decisions/INDEX.md` | Auto-regenerated index of all DRs | MinSpec ADR command |

Templates are rendered with project context variables (project name, repo URL, detected tool list). Tool-specific files are only generated for tools that exist or are explicitly requested — no clutter from tools you don't use.

Accepting the "Refresh" toast later merges template updates with your edits via section-level hashing. Sections you modified are preserved. Unmodified sections get the latest template content. New template sections are appended. No AI tool is required — your specs are plain markdown files that any tool (or no tool) can read.

## Features

### Complexity Classifier

MinSpec analyzes your git diff and classifies each change into one of four tiers. The classifier examines file count, line count, new exports, schema changes, dependency additions, and more -- then recommends the right level of specification ceremony.

![Complexity Classification](https://raw.githubusercontent.com/harvest316/minspec/main/packages/minspec/media/screenshots/classification.png)

### Adaptive Phase Lifecycle

Each spec moves through a lifecycle of phases: **Specify, Clarify, Plan, Tasks, Implement**. MinSpec skips phases that do not add value for the current tier. A T1 trivial change jumps straight from a one-liner spec to implementation. A T3 complex change goes through the full pipeline.

![Phase Lifecycle](https://raw.githubusercontent.com/harvest316/minspec/main/packages/minspec/media/screenshots/phase-lifecycle.png)

Solid arrows are the full T3/T4 path. Dashed arrows show how T1 collapses Specify directly to a single auto-generated Tasks step, and how T2 makes Clarify optional and reduces Plan to a single sentence.

![Phase Stepper](https://raw.githubusercontent.com/harvest316/minspec/main/packages/minspec/media/screenshots/spec-panel-stepper.png)

### Sidebar Tree View

All specs in your project appear in the Explorer sidebar, grouped by status (active, done, archived) with tier badges (T1-T4). Click any spec to open it. Right-click for actions like reclassification and phase transitions.

![Sidebar Tree View](https://raw.githubusercontent.com/harvest316/minspec/main/packages/minspec/media/screenshots/sidebar.png)

### Active Spec Panel

A webview panel displays the current spec as a vertical stepper. Completed phases collapse. The active phase expands with its content. Tasks appear as an interactive checklist you can toggle directly.

![Phase Stepper](https://raw.githubusercontent.com/harvest316/minspec/main/packages/minspec/media/screenshots/spec-panel-stepper.png)

![Task Checklist](https://raw.githubusercontent.com/harvest316/minspec/main/packages/minspec/media/screenshots/spec-panel-tasks.png)

### CodeLens Traceability

Inline CodeLens annotations appear above functions and classes, showing which spec requirement each piece of code implements. Click a CodeLens annotation to jump to the spec. Click a spec requirement to jump to the code. Create mappings manually or let MinSpec suggest them from task file paths.

![CodeLens Annotations](https://raw.githubusercontent.com/harvest316/minspec/main/packages/minspec/media/screenshots/codelens.png)

### Architecture Decision Records

MinSpec manages Architecture Decision Records (ADRs) in `docs/decisions/DR-NNN.md`. When you classify a change as T4 (Architectural), MinSpec prompts you to create an ADR. The sidebar shows all decisions in a dedicated tree view.

![ADR Tree View](https://raw.githubusercontent.com/harvest316/minspec/main/packages/minspec/media/screenshots/adr-tree.png)

### Session Discipline

Declare your session scope before starting work. MinSpec monitors file saves and warns you when you drift outside scope. Drifted work can be parked as a GitHub Issue (via `gh` CLI) or saved to a local parking lot file for later triage.

A MinSpec "session" is distinct from your Claude / Cursor / Copilot chat session -- it's a unit of intent ("today I'm fixing the rate limiter"), not a chat window. Run **MinSpec: Declare Session Scope** from the Command Palette to set it; the scope persists to `.minspec/session.json` and survives chat restarts, editor reloads, and machine reboots.

This is a MinSpec-specific discipline -- inspired by SDD and SAFe but not literally either -- and is opt-in. You can ignore it entirely and MinSpec still works.

### Status Bar

The status bar shows the active spec's tier, current phase, and task progress at a glance. Click it to open the active spec panel.

![Status Bar](https://raw.githubusercontent.com/harvest316/minspec/main/packages/minspec/media/screenshots/status-bar.png)

## Tier System

MinSpec classifies every change into one of four complexity tiers:

| Tier | Label | Ceremony | When |
|------|-------|----------|------|
| **T1** | Trivial | One-sentence spec, no planning | Single file, <50 lines, no new exports or schema changes |
| **T2** | Standard | Requirements list, lightweight plan | 2-5 files, <200 lines, no cross-boundary changes |
| **T3** | Complex | Full requirements, design doc, task DAG | 6+ files, new APIs, schema migrations, new dependencies |
| **T4** | Architectural | Full spec + ADR + stakeholder review | Cross-project impact, new services, breaking API changes |

The classifier suggests a tier. You always have the final say -- override any classification with a single click.

## Phase Lifecycle

Each spec follows a lifecycle adapted to its tier:

| Phase | T1 | T2 | T3 | T4 |
|-------|----|----|----|----|
| **Specify** | One-liner | Requirements list | Full requirements + acceptance criteria | Full + cross-system impact |
| **Clarify** | Skip | Optional | Required | Required + review |
| **Plan** | Skip | One sentence | Design document | Full design + ADR |
| **Tasks** | Auto single task | Task list | Task DAG with deps | DAG + milestone gates |
| **Implement** | Direct | Guided | Phase-gated | Phase-gated + checkpoints |

Skipped phases appear greyed-out in the panel with a label like "skipped (T1)." You can unskip any phase at any time.

## Configuration

All settings are under the `minspec.*` namespace in VS Code Settings.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `minspec.specsDir` | `string` | `"specs"` | Directory for spec files, relative to workspace root |
| `minspec.decisionsDir` | `string` | `"docs/decisions"` | Directory for Architecture Decision Records, relative to workspace root |
| `minspec.thresholds.t1Max` | `number` | `3` | Maximum complexity score for T1 (trivial) classification |
| `minspec.thresholds.t2Max` | `number` | `7` | Maximum complexity score for T2 (standard) classification |
| `minspec.thresholds.t3Max` | `number` | `14` | Maximum complexity score for T3 (complex) classification |
| `minspec.codelens.enabled` | `boolean` | `true` | Enable/disable CodeLens annotations showing spec requirement mappings |

Tier thresholds are tunable per project. Scores above `t3Max` classify as T4 (architectural).

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type "MinSpec" to see all commands.

Manual commands are listed below. Setup commands (init, refresh, classify) are auto-triggered via toasts -- no need to invoke them manually.

| Command | Description |
|---------|-------------|
| **MinSpec: Show SDD Status** | Display a summary of all specs, their tiers, and current phases |
| **MinSpec: Refresh Spec Tree** | Manually refresh the sidebar spec tree view |
| **MinSpec: Declare Session Scope** | Set the scope for your current work session (enables drift detection) |
| **MinSpec: Park Topic** | Create a GitHub Issue (or local note) for an out-of-scope topic |
| **MinSpec: Inject Active Spec Context** | Write the active spec's context into detected AI tool config files |
| **MinSpec: Remove Active Spec Context** | Remove injected spec context from AI tool config files |
| **MinSpec: Show Active Spec Panel** | Open the webview panel displaying the current spec's phase stepper and task checklist |
| **MinSpec: Generate Example Spec** | Create a sample spec file for demo and learning purposes |
| **MinSpec: Create Architecture Decision Record** | Create a new DR-NNN.md file from the ADR template with sequential numbering |
| **MinSpec: Score Issue (WSJF)** | Calculate a Weighted Shortest Job First score for backlog prioritization |
| **MinSpec: Quick Triage Inbox Issue** | Triage an inbox-labelled GitHub Issue with priority and labels |
| **MinSpec: Refresh Backlog** | Manually refresh the sidebar backlog view from GitHub Issues |
| **MinSpec: Go to Spec Requirement** | Navigate from code to the linked spec requirement |
| **MinSpec: Go to Code Location** | Navigate from a spec requirement to its implementing code |
| **MinSpec: Link Code to Spec Requirement** | Create a traceability mapping between a code location and a spec requirement |

## Spec File Format

Specs are plain markdown with YAML frontmatter. They are compatible with [Spec Kit](https://github.com/spec-kit/spec-kit) -- you can use both tools on the same project.

```markdown
---
id: SPEC-001
title: Add rate limiting to /api/health
tier: T2
status: implementing
created: 2026-05-26
phases:
  specify: done
  clarify: skipped
  plan: done
  tasks: done
  implement: in-progress
---

## Specify

Health endpoint needs rate limiting at 100 req/min per IP.

## Tasks

- [x] Add express-rate-limit middleware to health route
- [ ] Add 429 response test
```

MinSpec extends the Spec Kit format with optional frontmatter fields (`tier`, `status`, `phases`). Spec Kit ignores these fields, so interoperability is maintained in both directions.

## FAQ

### Does MinSpec require an AI coding tool?

No. MinSpec has zero AI dependencies. It works with any AI coding tool (Claude Code, Cursor, Copilot, Cline, Aider, Windsurf) but does not require any of them. Your specs are plain markdown files.

### Does MinSpec make network calls or require an account?

The extension binary makes no network calls — no telemetry, no analytics, no accounts, no backend. Three opt-in commands (Park Topic, Quick Triage, Refresh Backlog) shell out to your local `gh` CLI under your own GitHub auth, and only when you invoke them. If `gh` isn't installed, they fall back to local files. See [What MinSpec Does on Your Network](#what-minspec-does-on-your-network) above.

### Can I use MinSpec with Spec Kit?

Yes. MinSpec reads and writes Spec Kit's markdown format. Files created by either tool work in both. MinSpec adds optional frontmatter fields that Spec Kit safely ignores.

### What happens if I uninstall MinSpec?

You keep everything. Specs are plain markdown. Harness files (CLAUDE.md, AGENTS.md, etc.) are standard files in your repo. The `.minspec/` directory contains JSON config you can read or delete. There is no lock-in.

### How does the classifier work?

The classifier is a deterministic, multi-signal heuristic engine -- not ML. It analyzes your git diff for file count, line count, new exports, schema changes, dependency additions, cross-directory changes, and more. Each signal contributes to a complexity score that maps to a tier. You can override any classification, and MinSpec learns from your overrides over time.

## Contributing

Contributions are welcome. See the [GitHub repository](https://github.com/harvest316/minspec) for issues and pull requests.

## Privacy

MinSpec collects **zero data**. No telemetry, no analytics, no accounts, no backend. The extension binary makes no network calls. Three opt-in commands (Park Topic, Quick Triage Inbox Issue, Refresh Backlog) delegate to your local `gh` CLI under your own GitHub authentication, and only when you trigger them — see [What MinSpec Does on Your Network](#what-minspec-does-on-your-network). All spec data stays on your local filesystem. [Privacy Policy](https://aiclarity.com.au/privacy)

## License

MIT. The bundled `@aiclarity/shared` classification engine is licensed MPL-2.0 (file-level copyleft); distributing it inside this MIT extension is permitted, and modifications to its source files stay open. See the repository `LICENSE` and DR-018.
