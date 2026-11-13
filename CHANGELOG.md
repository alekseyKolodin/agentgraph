# Changelog

agentgraph versions. Sections are written by `npm run release`; when a new version reaches `main`, CI publishes the GitHub release `v<version>` with its section.

## 0.3.0 — 2026-11-04

### Features

- Spaces replace task tags: a space is a folder in `~/.agentgraph/spaces/<slug>/` for one feature or project — the map `CLAUDE.md`, the state `STATE.md` ("where we are now", rewritten after finished runs and terminal sessions), skill documents in `docs/` and `space.json`. Sessions and runs get the folder, so Claude Code loads the map as memory like a repository's `CLAUDE.md`. Task tags move into spaces on the first start (the summary becomes the state, notes the map, attachments documents); knowledge tags stay, and the "Tags" page is now "Knowledge". In the CLI `--tag` gives way to `--space`, `--auto-space` and `--knowledge`
- The Spaces page: the map, the state, documents, the space's sessions and runs, its working folder and sessions in the same folders that can be added to it. The space is the first field of the run and session forms and fills in its working folder; a "Model gets" preview in both forms and on the session screen shows exactly what the space and knowledge tags give the model
- Space drafts with a model: "Draft with a model…" in the new-space form and on the "Map" tab writes a map like the `CLAUDE.md` from `/init`, up to five skill documents, the state and the folders — from a description and the project, or from chosen sessions and runs. An estimate and a price ceiling come before the start, progress is live with "Cancel", an existing space gets a line diff, and nothing is saved until you accept it; the model only reads. "Propose spaces…" groups sessions and runs that have no space and opens each proposal as a draft
- Sessions: a session started without a name is named after its first message; rename it in place (double-click or the pencil) in the sidebar, the sessions list and the header. A live session row shows its space, status and last activity, and ended sessions have their own sidebar section grouped by space
- A session that starts waiting for you shows up under "Waiting for you" on Home (working ones under "Running"), and you get a notification when no window shows it; an ended session says who stopped claude instead of "code 129"
- Sessions: claude can open a new session next to the current one (it always asks first), and text Claude Code selects with the mouse is copied to the clipboard
- Run page: rename a finished run in its header; the "Log" of a finished run is built from the phase transcripts; the status sits next to the name, "Hide from the list" and "Delete run…" are in the "⋯" menu, and a run that fails to open says why and offers a retry
- Phase transcripts and the live log read like Claude Code: agent text as markdown, a tool call as one line with its result under it, refusals in red, long runs of calls folded into a summary; "as text" shows the raw lines
- Live token spend of a running phase, subagents included: a chip on the phase card and "≈N tokens" in the header, yellow once the phase has spent more than the costliest finished phase of the run
- Flow generation reads the project first and names only commands and paths it has seen; new design rules for work lists and checks are shared with "Edit with AI" and the flow-author skill
- Auto-update from the git checkout: a sidebar badge shows new commits and "Update and restart" (fast-forward, `npm install` and builds when needed, restart); off outside a git checkout and with `AGENTGRAPH_NO_UPDATE_CHECK=1`
- Sidebar and shell: run, flow and session rows are links (Cmd-click opens a new window, Tab and Enter work); a run row takes two lines; below 800 px the sidebar is a drawer behind "Menu"; labels for screen readers and a "Skip to content" link; secondary text has more contrast; "Loading…" and an "AgentGraph is not responding" screen with "Retry" instead of an empty window
- Builder: the graph refits around the selected block when the inspector opens or closes, fits no smaller than 85%, and node names take two lines
- Desktop app: an app icon and the AgentGraph name

### Fixes

- Turns made while "Update state" was running are no longer lost when claude exits, and a space re-created with the same slug gets the session's new turns
- Deleting a space checks first and is all or nothing; a space document with unsaved text no longer crashes the page
- Write guards of sessions and run phases also cover `.claude/`, `space.json` and the tags folder in any letter case, and paths are normalized the way Claude Code does
- The spend of a phase stopped before its result is kept
- Flow analysis no longer contradicts the run data, and its condition rules match the generator's
- Cyrillic copied from the terminal is no longer garbled; tag pills stay on one line
- The desktop app's quit dialog talks about the space state, not task tag summaries

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
