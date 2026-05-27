---
id: SPEC-003
type: tasks
status: implementing
product: minspec
---

# MinSpec — Task Breakdown

**Date:** 2026-05-26
**Status:** Implementing
**Design:** [design.md](design.md)

---

## Phase 1: Foundation (Week 1-2)

### 1.1 Extension Scaffold
- [x] Initialize VS Code extension with TypeScript + esbuild
- [x] Configure Vitest with VS Code extension test harness
- [x] Set up CI (GitHub Actions: lint, test, package)
- [x] Create extension manifest (`package.json`) with activation events, commands, views
- [x] Implement `minspec.init` command — creates `.minspec/` directory structure

### 1.2 Config System
- [x] Define `.minspec/config.json` schema (tier thresholds, phase mappings, spec directory)
- [x] Implement config loader with defaults + user overrides
- [x] VS Code settings integration (Settings UI entries for key config)

### 1.3 Spec File Format
- [x] Define spec markdown schema (YAML frontmatter + phase sections)
- [x] Implement spec parser (frontmatter extraction, phase detection, task list parsing)
- [x] Implement spec writer (preserve user content, update frontmatter)
- [x] Spec Kit compatibility tests (round-trip: write with MinSpec, read with Spec Kit, and vice versa)

---

## Phase 2: Classification Engine (Week 2-3)

### 2.1 Git Analyzer
- [x] Integrate `simple-git` — detect repo, get diff, get file list
- [x] Implement file-level signals: file count, line count, file types, new files, cross-directory changes
- [x] Implement dependency signals: package.json changes, new dependencies

### 2.2 AST Analyzer (Optional)
- [x] Regex-based heuristics (tree-sitter-ready interface for future swap)
- [x] Implement JS/TS signals: new exports, new classes, removed exports
- [x] Implement schema signals: Prisma/SQL/Zod file changes
- [x] Graceful fallback when parser unavailable

### 2.3 Classifier Core
- [x] Implement signal → tier scoring algorithm
- [x] Implement confidence calculation
- [x] Implement phase selection based on tier (FR-2 mapping table)
- [x] User override support with calibration storage
- [x] **T0 tests:** Classification of known diffs produces correct tiers

---

## Phase 3: Lifecycle Manager (Week 3-4)

### 3.1 State Machine
- [x] Implement spec lifecycle state machine (new → specify → ... → done/archived)
- [x] Phase transitions: forward, skip, back (with validation)
- [x] Status tracking in spec frontmatter
- [x] **T0 tests:** State transitions respect invariants (no skipping without record, back-transition warns)

### 3.2 Spec CRUD
- [x] Create spec command (auto-ID, slug filename, tier-based phase sections)
- [x] List specs (by status, by tier)
- [x] Update spec (phase transitions, content edits)
- [x] Archive spec
- [x] Delete spec (with confirmation)

---

## Phase 4: UI — Sidebar (Week 4-5)

### 4.1 Spec Tree View
- [x] Register TreeDataProvider for sidebar
- [x] Spec nodes grouped by status (active / done / archived)
- [x] Tier badge icons (T1-T4) via ThemeIcon
- [x] Click to open spec file
- [x] Context menu: change tier, transition phase, archive

### 4.2 Active Spec Panel
- [x] Webview panel showing current spec phases as vertical stepper
- [x] Phase status indicators (done / active / skipped / pending)
- [x] Inline task checklist with toggle support
- [x] Classification breakdown (signals, confidence, tier)

### 4.3 Status Bar
- [x] Status bar item showing: tier | active phase | progress
- [x] Click to open active spec panel
- [x] Update on spec transitions and task completions (file watcher)

---

## Phase 5: Harness Generator (Week 5-6)

### 5.1 Template System
- [x] Bundle default Handlebars templates for CLAUDE.md, AGENTS.md, .cursorrules, DESIGN.md, constitution.md
- [x] Implement template rendering with project context variables
- [x] `minspec init` command — generate all harness files from templates

### 5.2 Merge-on-Refresh
- [x] Section-level hashing for generated files
- [x] `minspec init --refresh` — merge template updates with user edits
- [x] **T0 tests:** Refresh preserves user edits, updates unmodified sections, appends new sections

### 5.3 Constitution
- [x] Constitution template with invariants, principles, constraints sections
- [x] Link constitution to classifier (constitution rules can influence tier thresholds)

---

## Phase 6: Agent Integration (Week 6-7)

### 6.1 Context Injection
- [x] On spec create/update, inject active spec context into CLAUDE.md session block
- [x] On spec create/update, inject into .cursorrules active-spec section
- [x] On spec create/update, inject into AGENTS.md active-spec section
- [x] Detection of which AI tools are present (check for .cursorrules, .clinerules, etc.)

### 6.2 Session Discipline
- [x] Scope declaration prompt on first spec command per session
- [x] Session state persistence in `.minspec/session.json`
- [x] File save monitoring for scope drift detection
- [x] Drift warning UI (park / add to scope / dismiss)

### 6.3 Parking Lot
- [x] GitHub issue creation via `gh` CLI for parked topics
- [x] Fallback to `.minspec/parking-lot.md` when `gh` unavailable
- [x] Issue template with session context and auto-labels

---

## Phase 7: CodeLens & Traceability (Week 7-8)

### 7.1 CodeLens Provider
- [x] Register CodeLens provider for source files
- [x] Display spec requirement annotations above functions/classes
- [x] Click CodeLens → navigate to spec requirement line
- [x] Click spec requirement → navigate to code location

### 7.2 Traceability Mappings
- [x] Auto-suggest mappings from task file paths
- [x] Manual mapping via CodeLens "Link to spec" action
- [x] Store in `.minspec/traceability.json`
- [x] Bidirectional navigation commands

---

## Phase 8: ADR & Backlog (Week 8-9)

### 8.1 Architecture Decision Records
- [x] `minspec adr` command — create new DR-NNN.md from template
- [x] Sequential numbering with collision detection
- [x] Auto-prompt ADR creation on T4 classification
- [x] ADR tree view in sidebar

### 8.2 Backlog Management
- [x] WSJF scoring UI (input: user business value, time criticality, risk reduction, job size)
- [x] Issue lifecycle labels (inbox → triaged → agent-ready → wip → done)
- [x] Sidebar view: prioritized backlog from GitHub Issues
- [x] Quick-triage command for inbox issues

---

## Phase 9: Polish & Launch (Week 9-10)

### 9.1 Onboarding
- [x] VS Code Getting Started walkthrough (3-5 steps)
- [x] First-run experience: detect existing project, suggest init
- [x] Example spec generation for demo/learning

### 9.2 Marketplace Preparation
- [x] Extension icon and banner design
- [x] Screenshots (sidebar, CodeLens, classification, phase stepper)
- [x] README with GIFs showing key workflows
- [x] CHANGELOG.md
- [x] Marketplace description from Section 7 of competitive landscape report

### 9.3 Quality
- [x] Extension size audit (<5MB target)
- [x] Performance benchmarks (classification <500ms, tree view <200ms)
- [x] Accessibility audit (keyboard navigation, screen reader support)
- [x] Test coverage report (T0 invariant tests: 100%, T1 contract tests: 100%, T2 feature tests: 1-2 per feature)

---

## Post-Launch: ScroogeLLM Bridge (Week 11+)

### 10.1 Bridge Nudge
- [x] Detect LLM API usage patterns (if observable without proxy)
- [x] Surface savings estimate: "ScroogeLLM could save ~$X/month"
- [x] "Install ScroogeLLM" action button

### 10.2 Conformance Preparation
- [x] Export traceability mappings in format ScroogeLLM can consume
- [x] Define conformance API contract between extensions
- [x] `minspec.conformance.enabled` setting (activates when ScroogeLLM detected)
