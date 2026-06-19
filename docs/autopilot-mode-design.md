# MinSpec "Do-It-All" Mode — Design for Greenlight Review

*Internal name: **Autopilot Mode** (approve the blueprint, agents fly the build). Synthesis of three design takes, hardened against three code-level adversarial reviews. Scope: three throwaway "playground" repos only — MeetLoop, HireLoop, SourceBridge. Never MinSpec core.*

---

## 1. What this mode is

Today MinSpec asks a human to read and approve every spec, plan, task list, and pull request. Autopilot Mode **inverts who does what**: the human approves **one thing, once** — a plain-language product brief plus a clickable prototype ("the blueprint") — and then a chain of AI agents runs the entire specify → plan → tasks → build → deploy pipeline with no further human stops. The human supplies the one thing no machine can: *judgment about what to build and whether the product shape is right*. Everything downstream of that signature is mechanically checkable, so it is mechanized. The bet is narrow and explicit: this is **only** safe on throwaway playground repos where a wrong build costs nothing real, and it is fenced so it can never touch MinSpec itself.

---

## 2. The single gate

The PO approves **one composite artifact, the Blueprint**, before any build begins. It has two halves, locked together as a single unit:

| Half | What it is | Who writes it | What the PO does |
|---|---|---|---|
| **A — Overview brief** | One page: product one-liner, requirements list (each tagged `auto-build` or `human-only`), out-of-scope fence, open questions, and a one-line PASS/CONCERN verdict per risk (authored *last* by a reality-check agent) | Architect agent, from the repo's existing DESIGN/HANDOVER docs | Reads one-liner + guardrails + out-of-scope, **answers the open questions**, skims the verdict line |
| **B — Clickable prototype** | A navigable Claude Design wireframe — real buttons, real screen-to-screen navigation, placeholder data — one card per user-visible surface, plus an explicit "operational / no UI" card for every screenless requirement | Same agent, via the DesignSync tool | **Clicks through it** like walking a model home |

**One keyboard chord** (`MinSpec: Approve Blueprint`) hash-locks both halves and records the approval.

**What approval authorizes:** the full autonomous run on the `auto-build`-tagged requirements only. `human-only` requirements (anything legal, financial, irreversible, or marketing) are written as `status: blocked-human` specs and **never enter the build queue**.

> **Critical correction from review (see §4):** the hash must literally contain the prototype's content digest *as text inside the overview*, and the approval record must carry a `human` provenance marker. Neither exists in the current code — they are the first things to build.

---

## 3. The autonomous spine

Five phases. Each is a **gate → refute → advance** step: a phase moves forward only if its deterministic gate passes **and** an adversarial agent panel fails to find a defect. Otherwise it self-aborts to a human-needed queue — it **never relaxes a gate to proceed.**

| Phase | MinSpec mapping | Agent role | Gate before advancing |
|---|---|---|---|
| **0. Blueprint** | specify (compressed) | Architect | Required OQs answered; every requirement tagged; tier = T3 enforced (not assumed); **human signs here — the only stop** |
| **1. Spec fan-out** | specify per requirement | Architect ×N | `validateSpec` returns `complete:true` with symmetric-primitive rules **elevated to error**; Spec-Refuter panel finds nothing |
| **2. Plan** | plan | Architect | `/analyze` zero-inconsistency; cross-asset contracts named; Plan-Refuter panel clean |
| **3. Tasks** | tasks | Tasks agent | Every task back-links to a requirement + plan section; no task touches a `human-only` or out-of-scope path |
| **4. Implement + deploy** | implement | Dev agents (isolated worktrees, credential-free) | `npm test/lint/build/validate` exit 0; diff ⊆ file allowlist; no new stubs/TODOs; Reviewer + Security + **PO-Proxy** refuters all pass; only then auto-merge |

**Self-abort contract:** any phase that can't reach green in 3 bounded retries, or whose refuters land an unrefuted defect or deadlock, writes `status: human-needed` and **stops that branch of the work** (siblings keep flowing), surfacing it in the existing PR-review-queue pane (DR-033 #182/#211).

**Reviewer + Security run only at phase 4 today — by design, with a gap to close.** The `reviewer.md` + `security.md` role prompts exist (`scripts/roles/`) and are wired into the phase-4 implement gate (`Reviewer + Security + PO-Proxy refuters all pass`). They do **not** run as rows 0–3 refuters. That is mostly correct — code-level review has nothing to bite on until code exists — but two things are mis-placed: a **security** read of the *spec/plan* (e.g. a requirement mandating a legal-invariant-bearing egress path, A6/A8) belongs at phase 1–2, not deferred to post-implement, and `po-proxy.md` (A7) is still unbuilt. Caveat (A9): a bare LLM `CLEAN` from either is a non-vote — it must be backed by a machine-checkable artifact or it self-aborts. **Provenance:** these role prompts are bespoke MinSpec files (commit `32811aa`, DR-004), *not* inherited from `agency-agents` — the "inherit when ready" comment in each is a TODO with no sync mechanism today (#230). Auto-invoking review/security earlier + the init-time auto-merge-on-clean default are tracked in #227 / #229.

---

## 4. The trust backstop — *load-bearing section*

With zero post-gate human reads, the never-wrong invariant is carried by two layers: a **deterministic gate stack** (preferred — repeatable, auditable, no LLM in the trust path) and an **adversarial refutation swarm** (only where judgment is irreducible, and never as the *sole* check on a hard invariant).

The three adversarial reviews independently proved that **the mode as originally pitched does NOT hold** — the reused mechanisms (`spec-gate.py`, the approval hash, `validateSpec`) all guard one narrow thing (source-code edits against an unapproved T3/T4 spec) and the mode relocated the entire safety budget onto artifacts those mechanisms provably do not guard. **Every one of those gaps is verified true against the current code.** This section answers each as a hard prerequisite, not a footnote.

### Attack → mitigation (must-fix to greenlight)

| # | Attack (verified against code) | Mitigation — required before mode runs |
|---|---|---|
| A1 | **The bypass-proof gate guards the empty set.** `spec-gate.py:120-121` allowlists `specs/`, `docs/`, `.minspec/`, `scripts/`, `.github/`, any `*.md`, `package.json`. For these config-is-the-product repos the *entire deliverable* (rulesets, intake configs, ICP lists) lands in those paths — ungated. | **Deliverable registry.** Every generated output path is declared in its owning spec; writing to a declared-deliverable path requires that spec approved-and-fresh. Until built, **Autopilot Mode refuses to run on a repo whose product is config-in-allowlisted-paths.** |
| A2 | **Gate trusts a self-asserted `status`.** `spec-gate.py:161` fires only on `tier∈{T3,T4} AND status==implementing` — both written by the agent being gated (the SPEC-002 lie class, already root-caused here). | Derive build-phase from an **external pipeline-state file the agent cannot write**, OR gate all source-equivalent writes regardless of status. A field the gated thing writes can never be the discriminator. |
| A3 | **Forged approvals are byte-identical to human ones.** `ApprovalRecord` is exactly `{specHash, approvedAt, tier}` (confirmed) — no provenance, no parent-hash. A loop agent can write `approvals.json` (gitignored, editable) with a valid hash + fake `approvedAt`; `resolveStatus` returns `approved`. The audit record itself lies. | Add `approvedBy: human \| blueprint` + `derivedFrom: <blueprintHash>` to the record; **commit `approvals.json` for playground repos** (reverse gitignore) or sign each record with a human-only key the loop agents do not hold; `spec-gate.py` rejects any record it can't verify as human-or-blueprint-derived. Protect `.minspec/config.json` and `scripts/roles/*.md` with a **PreToolUse deny** so a loop agent cannot edit its own gate. |
| A4 | **The hash does not bind the prototype.** `hashSpecFile` sha256s the overview bytes only. A *reference* to a separate lock file doesn't change when the lock changes → prototype drifts, approval stays green, "human approved this UX" becomes false. | **Inline the prototype's content digest as text inside the overview**, so any prototype change mutates the overview bytes → `resolveStatus` → `stale` → gate re-blocks. Recompute freshness in both `npm validate` **and** `spec-gate.py` (not a script agents can skip). |
| A5 | **The symmetric primitive never errors.** Every closed-set / reference / coverage rule in `spec-validator.ts` is hardcoded `severity:'warning'` (confirmed lines 530/540/616/624/721/843); `complete` only goes false on error. Every "elevate to error" gate in the design is **vaporware** — a missing-tier, missing-epic, missing-acceptance spec returns `complete:true` today. | Build the **per-repo severity-elevation seam** for real; ship a T0 test proving a spec missing tier/epic/acceptance/aspect-artifact returns `complete:false` in this mode. Until then G0/G1 are not gates. |
| A6 | **Aspect detection is tuned for false-negatives exactly where risk lives.** The screenless back-office logic carrying all legal risk (deliverability/AU-Spam, LL144/EEOC intake-only wall, flat-fee honesty) contains no UX/API/data keywords → zero required artifacts → silently `complete`. | Add an explicit **`invariant-bearing` tag** (independent of the keyword detector) that *forces* a written, refuter-checked correctness artifact for any requirement touching a named legal/financial invariant. Misclassifying such a requirement fails closed via an independent detector, not the same agent's self-tag. |
| A7 | **PO-Proxy / the "did we build the picture?" check does not exist.** `scripts/roles/` holds only triage/dev/architect/reviewer/security (confirmed). The single backstop that verifies *code against the approved picture* is an unbuilt file. | **Build `po-proxy.md`** — but it may only *add* semantic review. Every hard invariant must have a **deterministic fail-closed test** asserted present by a pure validator, never an agent's judgment. |
| A8 | **Irreversible actions enforced by agent imagination.** "Deploy disarmed (`send_enabled=false`)" depends on every emit path honoring a flag; a new unanticipated send path emits real cold email — the exact CAN-SPAM / AU-Spam-Act act the mode swore to hold for a human. | Make the boundary a **deterministic egress chokepoint**: all outbound email/SMS/real-world API routes through one guarded sender that **hard-refuses without an out-of-band human arm-token**. A new send path then *physically cannot* emit. Code topology, not anticipation. |
| A9 | **Refuter monoculture = fake quorum.** All swarm agents share one base model; 2-of-3 is one correlated vote. A unanimous CLEAN can lie exactly where one human read would have. | A `CLEAN` verdict must be backed by a **machine-checkable artifact** (a passing test the refuter wrote, a resolved checklist) — a bare LLM "CLEAN" is treated as a non-vote → self-abort. Tie-breaker runs on a **different tier/model** (Opus). |
| A10 | **Internal-ref egress leak into the one human-facing artifact.** The overview/prototype are generated *from* internal docs full of DR/SPEC/issue tokens (the DR-032/SPEC-021 leak class, still unguarded in the validator). | Run the DR-032/SPEC-021 egress filter on the PO-facing overview + prototype copy at generation time; **fail closed** if any internal ref leaks. |
| A11 | **Cross-repo / scope leak.** `gate-placement=auto-merge` lives in the editable `.minspec/`; a sibling-worktree or misresolved canonical dir could apply playground semantics to MinSpec core. | Re-derive auto-merge **per loop iteration from verified repo identity** (git remote match against the three hard-named repos) and **hard-refuse** if the repo is not one of the three. |
| A12 | **Quota exhaustion = torn green state.** The swarm is many subscription `claude -p` calls; if the 5h/weekly window empties mid-run, the build halts while the blueprint still reads "approved." | **Reserve, don't estimate,** quota before the gate; on mid-run exhaustion flip status to a loud **"STALLED — not deployed."** A signpost that says go while nothing moves is the purest never-wrong violation. |

**Bottom line:** the deterministic layer must carry the defects the refuters are blind to, and the refuters must carry only what's left. The original pitch had the deterministic layer **holed and toothless precisely where the swarm was blindest.** The 12 fixes above close that overlap. **None is optional.**

---

## 5. Principles reversed / suspended

| Principle | Disposition | Why safe in playground only |
|---|---|---|
| **No bulk-approve / review-each-doc** | **Reversed** — one blueprint read replaces N per-doc reads | The thinking-by-reading is relocated: PO inspects every user-visible surface by *clicking* it, and the deterministic gates + refuters perform the per-doc refutation. Sound only because scope is pinned at the blueprint and every spec is checked ⊆ blueprint. |
| **Per-spec human approval** | **Reversed** — child specs inherit a `blueprint`-derived approval (with a *distinct* provenance marker, A3) | Authority flows from the one signature; a spec that drifts ⊄ blueprint has its derived approval invalidated and fails closed. |
| **Tier-gated HITL (T3/T4 human-before-agent)** | **Reversed for the gate placement, kept for ceremony depth** | A T4 still gets full cross-checks + full refuter panel; only the *human stop* moves to the blueprint. |
| **Symmetric primitive is warning-only** | **Suspended → errors** (per-repo config, A5) | A warning no human reads is the silent lie the invariant forbids; with zero human reads it must fail closed. |
| **Never-wrong / evidence discipline** | **NOT reversed — the thing the whole backstop exists to preserve** | Non-negotiable. The 12 fixes exist precisely so removing the human does not let the signpost lie. |
| **Subscription-default billing** | **NOT reversed** | Stays on subscription `claude -p`; flagged as the dominant cost/quota risk (A12). |

**The firewall keeping this out of MinSpec core:** (1) mode activates only on the three hard-named repos, re-verified by git identity every loop iteration (A11); (2) `.minspec/config.json` + role prompts are PreToolUse-protected from agent edits (A3); (3) the symmetric-primitive elevation and auto-merge are **per-repo config, never hardcoded** — core keeps warning-only + PR-gate-for-all. The mode is an experiment whose failure deletes a config block and touches nothing real.

---

## 6. The deploy problem (honest treatment)

**All three repos have NO deploy path today** — confirmed: zero `package.json` / Dockerfile / CI / build config in any of them. Two are service businesses with no software to run at all. So "zero-stops deploy" **cannot** mean push-to-prod, and saying "deployed" where nothing runs would be exactly the false-"implemented" the never-wrong rule forbids.

Deploy is handled in three honest tiers, chosen per requirement *at the blueprint*:

| Tier | What "deploy" means | Reality for these repos |
|---|---|---|
| **A — Artifact deploy** (default) | Generate the operational config (qualification rulesets, intake configs, ICP lists, sequences) and commit it green-gated to an integration branch. The artifact landing in-repo **is** the deploy — signpost says "built, merged, no runtime target," never "live." | The correct setting for all three **today**. |
| **B — Bootstrap a deploy path** | First implement task scaffolds `package.json` + a deploy target (CF Pages/Wrangler per project default) — but the **deploy workflow must be a fixed, human-owned template the pipeline cannot rewrite** (A2/agent-authored-CI hole). Or: produce a deploy-ready PR a human merges. | Only HireLoop's candidate-sourcing scraper plausibly needs this — and not at first trial. |
| **C — Human-only, never auto** | Live cold email, paying-client onboarding, lawyer-reviewed contracts, any spend. Pipeline produces the artifact and **stops** at a human-needed card, behind the deterministic arm-token chokepoint (A8). | The legal/financial fences for all three. |

**What must be built first:** the deliverable registry (A1), the arm-token chokepoint (A8), and the honest "merged, no runtime" signpost wording — *before* any deploy tier runs. A non-technical owner reading "built + merged" must not be invited to read "live"; the signpost wording is itself a deliverable.

---

## 7. Open decisions for the PO

| Decision | Options | Recommendation |
|---|---|---|
| **Approval-store integrity** | Commit `approvals.json` for playground repos vs. sign records with a human-only key | **Commit it.** Simplest tamper-evidence; gitignore was for per-checkout locality, irrelevant on throwaway repos. |
| **How much backstop before first run** | Build all 12 fixes vs. a minimum viable subset | **Build A1–A5 + A11 first** (the gate/approval/hash/tier/cross-repo floor). A6–A10 are required before any *legal-invariant* requirement auto-builds — so first trial picks a slice with none (see §8). |
| **Prototype fidelity** | Deterministic wireframe vs. styled Claude Design hi-fi | **Deterministic skeleton first**, styled later. The skeleton always renders even if the model call is skipped, and these products have almost no UI. |
| **Refuter tie-breaker model** | Same model vs. cross-tier (Opus) | **Cross-tier.** Same-vendor monoculture is the deepest hole (A9); the tie-breaker must differ. |
| **First-trial repo** | MeetLoop / HireLoop / SourceBridge | **SourceBridge** (see §8). |

---

## 8. First-trial plan

**Run it on SourceBridge first.**

**Why:** it has the most complete spec set (6 specs, 2,051 lines) and the *least dangerous* deliverables of the three. Its v1 outputs are templates and config — an RFQ-intake flow config, a supplier-comparison sheet template, an ICP list + sequence — with the irreversible acts (sending email, signing contracts) already fenced as demand-pilot preconditions the human owns. MeetLoop and HireLoop both put a legal invariant (AU Spam Act; LL144/EEOC) directly in the auto-build path, which needs the A6/A8 invariant-bearing machinery proven first. SourceBridge lets us prove the *mechanism* before trusting it with legal risk.

**Smallest end-to-end slice to prove the mode** (one requirement, full pipeline):

1. Pick **one** Tier-A deliverable — the **supplier-comparison sheet template** (SPEC-004): no UI, no legal invariant, no runtime, fully reversible.
2. Blueprint = a one-paragraph overview + a prototype that is a single "operational / no UI" card (proves the screenless-coverage path, A6-adjacent).
3. Human signs once.
4. Pipeline runs spec → plan → tasks → generate-template → commit-to-integration-branch, through the **deterministic floor only** (A1–A5, A11) plus Reviewer + PO-Proxy refuters.
5. **Success = the artifact lands committed-and-green, the approval record carries a verifiable `human`/`blueprint` provenance marker, the prototype digest is inlined in the overview, and the signpost reads "built, merged, no runtime target" — verified by reading the committed `approvals.json` and the diff, not the agents' self-reports.**

If that slice cannot produce a *non-forgeable* "approved → built → honest-signpost" chain, the mode is not ready — and that failure costs one throwaway template, which is the entire point of choosing a playground.

---

*This document is the meta-design of the mode. It is NOT the in-product gate. The mode does not hold the never-wrong invariant as originally pitched — three code-level reviews proved it — and is greenlightable only with the 12 §4 must-fixes built and the SourceBridge slice in §8 passing first.*
