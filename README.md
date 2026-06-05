# MinSpecPro

![status](https://img.shields.io/badge/status-under%20construction-orange)
![release](https://img.shields.io/badge/release-none%20yet-lightgrey)
![marketplace](https://img.shields.io/badge/marketplace-not%20published-red)

> 🚧 **Under construction — pre-release.** APIs, specs, and layout change daily; nothing here is published to the VS Code Marketplace or Open VSX, and there are no stability guarantees. Star/watch to follow along — don't depend on it yet.
>
> **ScroogeLLM is not in this repo.** Its source, spec, design, and research live in a separate private repository ([DR-027](docs/decisions/DR-027.md)). This monorepo hosts **MinSpec** (open), the shared classifier, and the extension-pack manifest.

Monorepo for the open **MinSpec** VS Code extension, the shared classifier engine, and the MinSpec Pro extension-pack manifest.

| Package | ID | Domain | Status |
|---|---|---|---|
| [`packages/minspec`](packages/minspec) | `aiclarity.minspec` | [minspec.dev](https://minspec.dev) | SDD Implement (pre-release) |
| [`packages/shared`](packages/shared) | `@aiclarity/shared` | — | Shared classifier |
| [`packages/extension-pack`](packages/extension-pack) | `aiclarity.minspec-pro` | — | Manifest only — refs ScroogeLLM by marketplace ID |

> **ScroogeLLM** (`aiclarity.scroogellm`, [scroogellm.com](https://scroogellm.com)) — developed in a private repo (see banner above). The pack references it by marketplace ID once published.

## What is this?

**MinSpec** — scope-adaptive spec-driven development. Classifies each change by its mechanical scope (blast radius — files touched, lines, cross-boundary spread) into a tier, then applies proportional ceremony. A tier measures *how far a change reaches*, not how hard it is to think through. One-file fix = one sentence of spec. Architecture rewrite = full treatment. The predicted tier is a *floor* (ceremony only ratchets up); you can always raise it. Works with zero AI tools installed.

**ScroogeLLM** — LLM proxy that minimises token spend. Anonymises PII, caches aggressively, downgrades models when the task allows. Every token counts.

**MinSpec Pro** — extension pack referencing both. Unlocks spec-conformance checks that use ScroogeLLM as the inference layer.

## Invariants

Rules every change must preserve. See [CLAUDE.md](CLAUDE.md) for full list.

### MinSpec

1. No AI dependency — core path makes zero AI calls.
2. Tiered network consent ([DR-004](docs/decisions/DR-004.md)) — Tier 0 fully offline. No `http`/`fetch` in `packages/minspec` or `packages/shared`.
3. No lock-in — Spec Kit-compatible markdown, no proprietary format.
4. Ceremony proportional to complexity.
5. User override always wins — classifier suggests, human decides.
6. Harness regeneration preserves user edits (merge, not overwrite).

### ScroogeLLM

7. All LLM calls go through proxy.
8. Savings auditable — raw vs actual cost logged per request.
9. PII anonymisation deterministic.
10. User API keys in OS keychain only.
11. Proxy binds localhost by default.
12. Free-tier optimisations always active.

## Commands

```bash
npm test          # all packages
npm run lint
npm run build
npm run validate  # frontmatter check on specs/**/*.md

# Package one extension
cd packages/minspec && npm run package    # → .vsix

# Publish (requires vsce token)
cd packages/minspec && npx vsce publish
```

## Layout

```
specs/<product>/         SDD artifacts (requirements, design, tasks)
docs/decisions/DR-NNN.md Architectural decisions (see INDEX.md)
docs/research/           Background research
sites/minspec.dev/       Marketing site
sites/scroogellm.com/    Marketing site
packages/                Workspaces
scripts/hooks/           Pre-commit + dispatch
```

## Methodology

Spec-driven development. Three phases per product: **Specify → Plan → Implement**. MinSpec is at Implement. ScroogeLLM has not started Specify.

Bug fixes follow [**RCDD** — Root-Cause-Driven Debugging](docs/decisions/DR-003.md) — reproduce, diagnose, fix, harden. No code changes in phases 1–2.

All architectural decisions land in [docs/decisions/](docs/decisions/INDEX.md) as `DR-NNN.md`.

## License

Multi-licensed — see [`LICENSE`](LICENSE) and [DR-018](docs/decisions/DR-018.md). Each package's `LICENSE` file is authoritative.

| Path | License |
|---|---|
| `packages/shared` (classifier engine + contracts) | **MPL-2.0** |
| `packages/minspec`, `packages/extension-pack` | **MIT** |
| docs / site copy / whitepaper ([`LICENSE-CONTENT`](LICENSE-CONTENT)) | **CC-BY-4.0** |

Publisher: `aiclarity`.
