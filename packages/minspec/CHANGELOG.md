# Changelog

All notable changes to the MinSpec extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.11] - 2026-05-28

### Changed

- **README badges restructured.** Tests, Coverage, "No AI Required", and "Internet not required" remain at the top (high-signal). License, VS Code version, TypeScript version, and CI status moved to the marketplace sidebar (`package.json` `badges` array) — same info, less visual noise above the fold.
- Renamed badge "Offline Core" → "Internet: not required" for plain-English clarity.
- First mention of "specification-driven development" in the README now links to [Spec Kit](https://github.com/spec-kit/spec-kit) — the upstream SDD methodology / file format MinSpec stays compatible with.
- Phase Lifecycle diagram regenerated with thicker connectors (4px solid for the T3/T4 path, 3px dashed for T1/T2 skip arrows) and bold phase labels for readability at marketplace render scale.

### Fixed

- **"MinSpec: Decisions" section title flicker:** Hovering the explorer pane no longer expands the title bar to "MinSpec: Create Architecture D…". The `minspec.createAdr` command now declares `shortTitle: "New ADR"` plus a `$(add)` icon, so VS Code renders it as an icon-only action button instead of stretching the full title.

## [0.1.10] - 2026-05-28

### Changed

- **Phase Lifecycle diagram** replaced inline Mermaid block with a pre-rendered PNG (`phase-lifecycle.png`). VS Code Marketplace doesn't render Mermaid; pre-render keeps the listing visually consistent. Source `.mmd` retained alongside the PNG so it can be regenerated.
- Open VSX publish now live alongside VS Code Marketplace at the same version.

## [0.1.9] - 2026-05-28

### Added

- **Status Bar screenshot** in README — visible example of the active-spec tier/phase/progress strip.

### Changed

- Merged "Harness Generator" and "AI Tool Integration" sections in the README into a single "What Initialization Produces — Files & AI Tool Integration" table that lists every file MinSpec creates or maintains (CLAUDE.md, AGENTS.md, .cursorrules, .clinerules, CONVENTIONS.md, .windsurfrules, DESIGN.md, .minspec/constitution.md, config.json, session.json, preferences.json, calibration.json, traceability.json, parking-lot.md, specs/, docs/decisions/) and which AI tool (if any) auto-loads each.
- **Listings aligned:** minspec.dev site language updated to match the accurate "extension binary makes zero network calls; three opt-in commands shell to local `gh` CLI" claim that already lives in the marketplace README. Meta description on the site updated from "no backend" to "offline core" for consistency with the README badge.
- Re-publish that also covers the 0.1.8 release content (0.1.8 had been published under a prior package — see the 0.1.8 entry below for the underlying feature set).

## [0.1.8] - 2026-05-28

### Added

- **Auto-bootstrap (detect + offer):** On activation, MinSpec detects missing `.minspec/`, harness template drift, or unclassified git changes and surfaces one toast at a time offering the appropriate setup action. Replaces the previous manual Ctrl-Shift-P workflow for first-time setup. Master toggle: `minspec.autoBootstrap.enabled` (default true). Per-prompt "Don't ask again" persisted to `.minspec/preferences.json`. See [DR-006](https://github.com/harvest316/minspec/blob/main/docs/decisions/DR-006.md).
- **Auto-classify on commit** (opt-in): `minspec.autoClassifyOnCommit` setting (default false) installs a watcher on `.git/HEAD` and `.git/refs/heads/*` that auto-runs classification after each commit.
- **Real classify command:** `MinSpec: Classify Task Complexity` is no longer a Phase-2 stub — it analyses the current git diff via the existing classifier engine and reports tier, confidence, and suggested phases with an Override option.
- **Aider integration:** Aider (`CONVENTIONS.md`) added to tool detection and active-spec context injection alongside Claude / Cursor / Cline / Windsurf.
- **Detailed Decision Register INDEX:** New command `MinSpec: Regenerate Decision Register INDEX` (also a button in the **MinSpec: Decisions** sidebar) rewrites `docs/decisions/INDEX.md` with a heading per DR — clickable title linking to the DR file, status/date meta line, and a 40–80 word summary auto-extracted from each DR's Context section. Generation is fully offline (no AI dependency, Tier 0). Output is wrapped in `<!-- minspec:dr-index:start/end -->` markers so subsequent regenerations preserve any user-authored notes outside the auto block (invariant 6).

### Changed

- `MinSpec: Initialize SDD Structure`, `MinSpec: Refresh Harness Files`, and `MinSpec: Classify Task Complexity` are hidden from the Command Palette (`when: "false"`) — they remain programmatically callable but are now invoked via auto-bootstrap toasts.
- Marketplace screenshots recropped to remove distracting git toasts and tighten framing; `spec-panel.png` split into `spec-panel-stepper.png` and `spec-panel-tasks.png`.
- README rewritten: merged Harness Generator into Initialize section, added 5-phase Mermaid lifecycle diagram, clarified that MinSpec's session scope is distinct from chat-session scope, and replaced the manual-command Quick Start with the new toast-driven flow.

## [0.1.5] - 2026-05-27

### Changed

- Marketplace listing republished to refresh CDN cache for icon and gallery images.

## [0.1.4] - 2026-05-27

### Fixed

- README images now use absolute URLs so they render correctly on the Marketplace listing page (relative paths only resolve inside the repo).

## [0.1.3] - 2026-05-27

### Fixed

- Path traversal validation hardened across spec/decision/parking-lot file operations.
- Webview Content Security Policy tightened to block inline scripts and remote sources.
- `.gitignore` and HTTP-style response headers cleaned up for the marketplace publish.

## [0.1.2] - 2026-05-27

### Fixed

- Marketplace metadata (publisher, repository, categories) corrected; lint errors that were blocking CI badges resolved.

## [0.1.1] - 2026-05-26

### Added

- Branded MinSpec icon (256×256) and 1280×280 gallery banner for the marketplace listing.
- Automated screenshot capture via VS Code extension-host e2e tests.
- Dynamic test and coverage badges generated from GitHub Actions.
- Privacy section in README with link to the AIClarity privacy policy.
- `.vscodeignore` for clean marketplace packaging.

### Fixed

- Operator precedence bug, `globalState` misuse, duplicated logic, status bar refresh issue.
- ScroogeLLM bridge: nudge surface, conformance contract, traceability export (Phase 10).

## [0.1.0] - 2026-05-26

### Added

- **Complexity classifier**: Multi-signal heuristic engine that analyzes git diffs (file count, line count, new exports, schema changes, dependency additions) and classifies changes into four tiers (T1 Trivial, T2 Standard, T3 Complex, T4 Architectural).
- **AST analyzer**: Regex-based heuristic analysis of JS/TS exports, classes, and schema files (Prisma, SQL, Zod) with a tree-sitter-ready interface for future upgrades. Graceful fallback when parsers are unavailable.
- **Classifier calibration**: Stores user tier overrides in `.minspec/calibration.json` and adjusts signal weights after sufficient override history.
- **Spec lifecycle manager**: State machine guiding specs through phases (specify, clarify, plan, tasks, implement, done/archived) with forward, skip, and back transitions.
- **Adaptive phase selection**: Automatically selects which SDD phases to execute based on the classified complexity tier. T1 skips clarify and plan; T4 requires full ceremony.
- **Spec CRUD operations**: Create, list, update, archive, and delete spec files with auto-generated IDs and tier-based phase sections.
- **Spec file format**: YAML frontmatter + markdown body, compatible with Spec Kit. Extended with optional `tier`, `status`, and `phases` frontmatter fields.
- **Config system**: Project-level configuration via `.minspec/config.json` with VS Code Settings UI integration for tier thresholds and directory paths.
- **Sidebar tree view**: Explorer panel showing all specs grouped by status (active, done, archived) with tier badge icons (T1-T4). Click to open; context menu for reclassification and phase transitions.
- **Active spec panel**: Webview stepper displaying the current spec's phase progress with status indicators (done, active, skipped, pending) and an interactive task checklist.
- **Status bar**: Displays active spec tier, current phase, and task progress. Click to open the active spec panel. Auto-updates on spec changes via file watcher.
- **Harness generator**: `minspec init` command generates CLAUDE.md, AGENTS.md, .cursorrules, DESIGN.md, and constitution.md from bundled Handlebars templates.
- **Merge-on-refresh**: `minspec init --refresh` merges template updates with user edits using section-level hashing. User-modified sections are preserved; unmodified sections are regenerated; new template sections are appended.
- **Constitution**: Project invariants and principles template linked to the classifier for tier threshold influence.
- **AI tool context injection**: Detects installed AI coding tools (Claude Code, Cursor, Cline, Aider, Windsurf, Copilot) and injects/removes active spec context into their configuration files.
- **Session discipline**: Scope declaration prompt, session state persistence in `.minspec/session.json`, file save monitoring for drift detection, and drift warning UI (park / add to scope / dismiss).
- **Parking lot**: Out-of-scope topics are filed as GitHub Issues via `gh` CLI with auto-labels and session context. Falls back to `.minspec/parking-lot.md` when `gh` is unavailable.
- **Eighteen commands**: init, refresh harness, classify, show status, refresh tree, declare scope, park topic, inject context, remove context, show spec panel, generate example spec, create ADR, score issue (WSJF), quick triage inbox issue, refresh backlog, go to spec, go to code, link code to spec.
- **Six configuration settings**: `specsDir`, `decisionsDir`, `thresholds.t1Max`, `thresholds.t2Max`, `thresholds.t3Max`, `codelens.enabled`.
