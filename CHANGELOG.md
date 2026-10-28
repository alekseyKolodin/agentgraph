# Changelog

agentgraph versions. Sections are written by `npm run release`; when a new version reaches `main`, CI publishes the GitHub release `v<version>` with its section.

## 0.2.0 — 2026-10-28

### Features

- Run chat as a dock beside every run tab (Overview, Graph, Log, Artifacts): replies render as markdown with a collapsible list of the agent's steps and widgets — tables, links to run files, artifacts and phases, action buttons and reply chips
- Run chat acts on the run safely: pause, resume, the iteration limit, instructions and answers to agent questions happen right away; stopping the run, writing an artifact, answering a pause, applying or saving a flow edit, continuing (with a model and a cost limit) and running again are offered as buttons that run once after you confirm
- AI flow generation and "Edit with AI": a model picker, live progress (step, model, timer, latest log lines, API retries, a warning when the session goes quiet), "Abort", and the model, duration and cost in the result
- Fix and continue the same run: give the next step or the rest of the run an instruction, edit the run's flow on pause or take the current `flows/<name>.yaml` (optionally saving the edit back to `flows/` without overwriting changes made there since the start), or repeat the iteration with an instruction; `/agentgraph` skill commands `note` and `flow-reload`
- Flow calls: a block with `flow: <name>` runs another flow as a child run with its own run folder and page, passes its result on in `{{prev}}` and `{{phases.<block>}}` and can repeat with `loop`; pause and stop reach the child, "Continue" resumes a stopped child run, and calls are checked on save (missing flow, cycles, more than 3 levels deep)
- Branching: `next` rules on a block (`marker`, `command` or `judge`) jump forward to a later block or `end`; the Builder adds "Add flow call" and "After the block", the graph draws calls and branches, and child runs are listed under their parent; example `flows/example/example-compose.yaml`
- Sessions tab: an interactive Claude Code session (the real `claude` TUI) in a terminal inside agentgraph, in the desktop app and the browser; task and knowledge tags reach it at start and when added mid-session (`knowledge_read` and `tag_read` tools), task tag summaries are updated when it exits, and "Continue" resumes it with `claude --resume`
- Live terminal sessions are listed under "Now" in the sidebar, a tag's page has "Open a session with this tag", and in the desktop app Cmd+Q asks first while sessions are running; `node-pty` is an optional dependency (ready builds for macOS; on Linux it is compiled, and without it there is simply no Sessions tab)

### Fixes

- Pausing while the condition of a block's last iteration is being checked now stops the run before the block ends, so you can still raise its limit
- A flow generation that finishes after the "New flow" dialog was closed no longer jumps to the new flow and drops unsaved Builder edits; a notification offers to open it instead
- Task tag summaries from runs that finish at the same time with the same tag are now written one after another instead of overwriting each other

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
