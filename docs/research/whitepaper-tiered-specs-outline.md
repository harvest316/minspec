# White Paper — Outline + Experiment Design

**Working title:** *Proportional Specs: Does Matching Specification Ceremony to Task
Complexity Improve AI Coding-Agent Success?*

**Status:** Plan / pre-registration draft (2026-05-29)
**Scope decision:** Paper B (narrow, falsifiable, reproducible) — not Paper A (broad
public-project mining). See session note for why A was rejected (methodology risk to
the "research-backed" brand promise).
**Builds on:** [SPEC-004 classifier-validation harness](../../specs/minspec/SPEC-004-classifier-validation/requirements.md), DR-009.

---

## 1. Thesis (one sentence)

Specification ceremony proportional to task complexity (MinSpec tiering) yields higher
AI-agent task-resolution rates and/or lower token cost than either no spec or uniformly
heavy specs.

If the experiment refutes this, **we do not publish a marketing claim** — we learn it
privately first. The brand promise "research-backed" is only as good as the result.

## 2. Why this paper (and not the broad one)

- We own a clean data path already (SWE-bench-Verified → real classifier → harness).
- One falsifiable hypothesis, pre-registered, beats N mined correlations.
- Reproducibility is the moat: ship the harness, anyone can rerun. Most "AI best
  practice" content is vibes; ours has a repo + a confusion matrix.
- It *is* the MinSpec thesis — the paper and the product make the same bet.

## 3. Falsifiable hypotheses (pre-register BEFORE running)

- **H1 (primary):** Tiered specs > flat-heavy specs on resolve-rate, SWE-bench-Verified.
- **H2:** Tiered specs ≥ no-spec on resolve-rate while using fewer tokens than flat-heavy.
- **H3 (secondary):** The MinSpec classifier's tier prediction correlates with human
  task scope (this is SPEC-004's existing measurement — reused here as a sub-result).
- **Null we must respect:** ceremony level has no significant effect on resolve-rate.

State expected direction, sample size, and the stat test **before** the first run.

## 4. Experimental design

### 4.1 Conditions (the independent variable)

For each task, run the same agent under three spec conditions:

| Condition | Spec given to agent |
|---|---|
| **C0 — none** | Problem statement only (baseline; what most people do). |
| **C1 — flat-heavy** | Full ceremony regardless of size (requirements+design+tasks for everything). |
| **C2 — tiered (MinSpec)** | Ceremony chosen by the MinSpec classifier tier for that task. |

### 4.2 Dataset

- SWE-bench-Verified, the ~50-instance labelled subset from SPEC-004 (NFR-2), expanded
  toward 150–200 if the early signal warrants the cost. State final N before analysis.
- `expectedTier` already hand-labelled per the rubric in
  [labels.json](../../scripts/classifier-validation/labels.json).

### 4.3 Dependent variables

- **Primary:** resolve-rate (gold-test pass after agent patch applied) per condition.
- **Secondary:** tokens consumed; wall-clock; fabrication incidents (ties to the
  Stella Lorenzo validator-gate sub-result — agent inventing APIs/citations).

### 4.4 Controls / confounders to pin down

- Same agent model + same temperature across conditions. Record exact model ID.
- Randomise task order; run each task under all three conditions (within-task design
  removes task-difficulty confounder — the big one).
- Blind grading: resolve-rate scored by gold tests, not human judgement.
- Multiple seeds per (task, condition) cell to estimate variance; report CIs not point
  estimates.
- Pre-declared exclusion rules (e.g. task that fails to apply under all conditions).

### 4.5 Statistics

- Within-task paired design → McNemar / paired test on resolve outcomes across conditions.
- Report effect size + confidence intervals, not just p. Bonferroni for the 3 pairwise.
- Pre-register N and stopping rule to avoid optional-stopping bias.

### 4.6 What extends SPEC-004 vs what's new

- **Reuse:** fetch script, fixture shape, real-path classifier call, confusion matrix.
- **New:** agent-runner stage (applies spec condition, invokes agent, runs gold tests),
  resolve-rate aggregation, token accounting. This is a Tier-1 network/agent activity —
  keep it **out of `packages/minspec`** (invariant #2); it lives in `scripts/` like the
  fetch script.

## 5. Paper structure (→ maps to blog series)

1. **Abstract** — thesis + headline number.
2. **Intro** — the flat-spec tax: heavy ceremony on trivial tasks wastes tokens; no
   spec on hard tasks fails. → *blog post 1*
3. **The tier classifier** — how MinSpec scopes ceremony. → *blog post 2*
4. **Method** — SWE-bench-Verified, 3 conditions, within-task design. → *blog post 3*
5. **Results** — resolve-rate chart, token chart, confusion matrix. → *blog post 4 (the chart)*
6. **Fabrication sub-result** — gated specs vs hallucinated APIs (Stella tie-in,
   reproduced not cited). → *bonus post*
7. **Limitations** — single benchmark, single agent model, SWE-bench ≠ greenfield.
8. **Reproduce it** — point at the harness repo. → *blog post 5 (CTA)*

## 6. Distribution sequence

1. **arXiv cs.SE** preprint — credibility anchor, makes "research-backed" literally true.
2. **minspec.dev** canonical long-form (same day).
3. **HN + Lobsters** same day — only survives if method + repo are airtight.
4. **r/programming, r/ExperiencedDevs** — secondary.
5. **dev.to / Hashnode** — syndicate with canonical link back.
6. **X / LinkedIn** — 5–7 post thread dripped over 2 weeks: hypothesis → method →
   the chart → the surprise → repo.

## 7. Risks / kill-switches

- **Result is null/negative** → do not publish marketing claim; publish honestly as
  "no effect found" only if we want the credibility, else shelve. Decide after data.
- **Single-benchmark critique** → acknowledge in Limitations; frame as v1, invite reruns.
- **Cost** → agent runs × 3 conditions × seeds × N can get expensive. Pilot at N=20,
  1 seed, decide scale from variance.
- **Invariant #2** → agent-runner must stay in `scripts/`, never import network into
  the extension packages.

## 8. Next concrete steps (not yet authorized — separate session)

1. Finish SPEC-004 labelling (50 instances) — already in flight.
2. Pre-register H1–H3 + N + stat test as a committed doc (timestamped) before any run.
3. Build agent-runner stage in `scripts/` (Tier-1, out-of-tree).
4. Pilot N=20, inspect variance, decide full N.
5. Run, analyse, **then** decide publish/shelve.
