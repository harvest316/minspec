# Changelog

All notable changes to the MinSpec extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
