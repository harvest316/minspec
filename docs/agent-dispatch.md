# Agent Dispatch — Quick Reference

Dev-time scripts that drive the local agent pipeline for this repo. Triage decides whether an issue is auto-buildable; dispatch runs the role agent in an isolated worktree; drain chains both for the whole inbox. Roles live in `scripts/roles/` (`triage`, `dev`, `architect`, `security`, `reviewer`).

| Command | Purpose |
|---|---|
| `scripts/triage-inbox.sh [N]` | Run triage agent on all `inbox` issues (or just `#N`). Auto-buildable T1/T2 get labelled `agent-ready`; human-only / T3-T4 get `needs-review`. |
| `scripts/dispatch-issue.sh <N> [--role <role>]` | Dispatch one `agent-ready` issue. Resolves role from labels (override with `--role`), creates worktree under `/tmp/minspec-agent/issue-N`, branches `agent/issue-N`, and runs `claude --bg` credential-free. Agent commits locally; dispatcher publishes the PR after exit. |
| `scripts/drain-inbox.sh [--dry-run]` | Triage every `inbox` issue then dispatch every resulting `agent-ready` issue, sequentially. Backgrounded with a `/tmp/minspec-drain-inbox.lock` so only one drain runs at a time; log at `/tmp/minspec-drain-inbox.log`. Hooked from session-start so inbox work piggybacks onto active sessions (#239 / PR #240). |

**Posture:** PR-gate-for-all. Agents never auto-merge; every dispatched issue lands as a PR for human review (see `feedback_auto_triage_auto_build` — backstops #180/#130/#88 built but not active).
