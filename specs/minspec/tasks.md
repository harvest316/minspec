---
id: SPEC-003
type: tasks
status: implementing
product: minspec
---

# MinSpec — Task Breakdown

**Date:** 2026-05-26
**Status:** Draft
**Design:** [design.md](design.md)

---

## Phase 1: Foundation (Week 1-2)

### 1.1 Extension Scaffold
- [ ] Initialize VS Code extension with TypeScript + esbuild
- [ ] Configure Vitest with VS Code extension test harness
- [ ] Set up CI (GitHub Actions: lint, test, package)
- [ ] Create extension manifest (`package.json`) with activation events, commands, views
- [ ] Implement `minspec.init` command — creates `.minspec/` directory structure

### 1.2 Config System
- [ ] Define `.minspec/config.json` schema (tier thresholds, phase mappings, spec directory)
- [ ] Implement config loader with defaults + user overrides
- [ ] VS Code settings integration (Settings UI entries for key config)

### 1.3 Spec File Format
- [ ] Define spec markdown schema (YAML frontmatter + phase sections)
- [ ] Implement spec parser (frontmatter extraction, phase detection, task list parsing)
- [ ] Implement spec writer (preserve user content, update frontmatter)
- [ ] Spec Kit compatibility tests (round-trip: write with MinSpec, read with Spec Kit, and vice versa)

---

## Phase 2: Classification Engine (Week 2-3)

### 2.1 Git Analyzer
- [ ] Integrate `simple-git` — detect repo, get diff, get file list
- [ ] Implement file-level signals: file count, line count, file types, new files, cross-directory changes
- [ ] Implement dependency signals: package.json changes, new dependencies

### 2.2 AST Analyzer (Optional)
- [ ] Integrate `web-tree-sitter` with lazy loading
- [ ] Implement JS/TS signals: new exports, new classes, removed exports
- [ ] Implement schema signals: Prisma/SQL/Zod file changes
- [ ] Graceful fallback when parser unavailable

### 2.3 Classifier Core
- [ ] Implement signal → tier scoring algorithm
- [ ] Implement confidence calculation
- [ ] Implement phase selection based on tier (FR-2 mapping table)
- [ ] User override support with calibration storage
- [ ] **T0 tests:** Classification of known diffs produces correct tiers

---

## Phase 3: Lifecycle Manager (Week 3-4)

### 3.1 State Machine
- [ ] Implement spec lifecycle state machine (new → specify → ... → done/archived)
- [ ] Phase transitions: forward, skip, back (with validation)
- [ ] Status tracking in spec frontmatter
- [ ] **T0 tests:** State transitions respect invariants (no skipping without record, back-transition warns)

### 3.2 Spec CRUD
- [ ] Create spec command (prompts for title, auto-classifies, generates skeleton)
- [ ] List specs (by status, by tier)
- [ ] Update spec (phase transitions, content edits)
- [ ] Archive spec
- [ ] Delete spec (with confirmation)

---

## Phase 4: UI — Sidebar (Week 4-5)

### 4.1 Spec Tree View
- [ ] Register TreeDataProvider for sidebar
- [ ] Spec nodes grouped by status (active / done / archived)
- [ ] Tier badge icons (T1-T4)
- [ ] Click to open spec file
- [ ] Context menu: change tier, transition phase, archive

### 4.2 Active Spec Panel
- [ ] Webview panel showing current spec phases as vertical stepper
- [ ] Phase status indicators (done / active / skipped / pending)
- [ ] Inline task checklist with toggle support
- [ ] Classification breakdown (signals, confidence, tier)

### 4.3 Status Bar
- [ ] Status bar item showing: tier | active phase | progress
- [ ] Click to open active spec panel
- [ ] Update on spec transitions and task completions

---

## Phase 5: Harness Generator (Week 5-6)

### 5.1 Template System
- [ ] Bundle default Handlebars templates for CLAUDE.md, AGENTS.md, .cursorrules, DESIGN.md, constitution.md
- [ ] Implement template rendering with project context variables
- [ ] `minspec init` command — generate all harness files from templates

### 5.2 Merge-on-Refresh
- [ ] Section-level hashing for generated files
- [ ] `minspec init --refresh` — merge template updates with user edits
- [ ] **T0 tests:** Refresh preserves user edits, updates unmodified sections, appends new sections

### 5.3 Constitution
- [ ] Constitution template with invariants, principles, constraints sections
- [ ] Link constitution to classifier (constitution rules can influence tier thresholds)

---

## Phase 6: Agent Integration (Week 6-7)

### 6.1 Context Injection
- [ ] On spec create/update, inject active spec context into CLAUDE.md session block
- [ ] On spec create/update, inject into .cursorrules active-spec section
- [ ] On spec create/update, inject into AGENTS.md active-spec section
- [ ] Detection of which AI tools are present (check for .cursorrules, .clinerules, etc.)

### 6.2 Session Discipline
- [ ] Scope declaration prompt on first spec command per session
- [ ] Session state persistence in `.minspec/session.json`
- [ ] File save monitoring for scope drift detection
- [ ] Drift warning UI (park / add to scope / dismiss)

### 6.3 Parking Lot
- [ ] GitHub issue creation via `gh` CLI for parked topics
- [ ] Fallback to `.minspec/parking-lot.md` when `gh` unavailable
- [ ] Issue template with session context and auto-labels

---

## Phase 7: CodeLens & Traceability (Week 7-8)

### 7.1 CodeLens Provider
- [ ] Register CodeLens provider for source files
- [ ] Display spec requirement annotations above functions/classes
- [ ] Click CodeLens → navigate to spec requirement line
- [ ] Click spec requirement → navigate to code location

### 7.2 Traceability Mappings
- [ ] Auto-suggest mappings from task file paths
- [ ] Manual mapping via CodeLens "Link to spec" action
- [ ] Store in `.minspec/traceability.json`
- [ ] Bidirectional navigation commands

---

## Phase 8: ADR & Backlog (Week 8-9)

### 8.1 Architecture Decision Records
- [ ] `minspec adr` command — create new DR-NNN.md from template
- [ ] Sequential numbering with collision detection
- [ ] Auto-prompt ADR creation on T4 classification
- [ ] ADR tree view in sidebar

### 8.2 Backlog Management
- [ ] WSJF scoring UI (input: user business value, time criticality, risk reduction, job size)
- [ ] Issue lifecycle labels (inbox → triaged → agent-ready → wip → done)
- [ ] Sidebar view: prioritized backlog from GitHub Issues
- [ ] Quick-triage command for inbox issues

---

## Phase 9: Polish & Launch (Week 9-10)

### 9.1 Onboarding
- [ ] VS Code Getting Started walkthrough (3-5 steps)
- [ ] First-run experience: detect existing project, suggest init
- [ ] Example spec generation for demo/learning

### 9.2 Marketplace Preparation
- [ ] Extension icon and banner design
- [ ] Screenshots (sidebar, CodeLens, classification, phase stepper)
- [ ] README with GIFs showing key workflows
- [ ] CHANGELOG.md
- [ ] Marketplace description from Section 7 of competitive landscape report

### 9.3 Quality
- [ ] Extension size audit (<5MB target)
- [ ] Performance benchmarks (classification <500ms, tree view <200ms)
- [ ] Accessibility audit (keyboard navigation, screen reader support)
- [ ] Test coverage report (T0 invariant tests: 100%, T1 contract tests: 100%, T2 feature tests: 1-2 per feature)

---

## Post-Launch: ScroogeLLM Bridge (Week 11+)

### 10.1 Bridge Nudge
- [ ] Detect LLM API usage patterns (if observable without proxy)
- [ ] Surface savings estimate: "ScroogeLLM could save ~$X/month"
- [ ] "Install ScroogeLLM" action button

### 10.2 Conformance Preparation
- [ ] Export traceability mappings in format ScroogeLLM can consume
- [ ] Define conformance API contract between extensions
- [ ] `minspec.conformance.enabled` setting (activates when ScroogeLLM detected)
