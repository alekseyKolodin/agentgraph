# Changelog

agentgraph versions. Sections are written by `npm run release`; when a new version reaches `main`, CI publishes the GitHub release `v<version>` with its section.

## 0.1.0 — 2026-10-25

### Features

- First public version: flows as YAML (`flow.yaml`) — blocks of phases looping until an acceptance condition passes (tests, an LLM judge with a rubric, or a done marker)
- Runner on the Claude Agent SDK: a fresh Claude Code session per phase, parallel phase groups, pause, continuation, budget and iteration limits
- Run artifacts with per-phase read/write permissions and versioning
- Task and knowledge tags
- Web UI (React): Home, flow builder, run page with graph, log, artifacts and chat; "Context" page; desktop app (Electron)
- CLI: generate a flow from a task, run, edit, eval
- Run from a Jira issue, a GitLab merge request, a GitHub pull request or a branch, with git worktree setup
- `/agentgraph` and `/session-to-flow` Claude Code skills
