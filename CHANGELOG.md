# Changelog

agentgraph versions. Sections are written by `npm run release`; when a new version reaches `main`, CI publishes the GitHub release `v<version>` with its section.

## 0.5.0 — 2026-11-17

### Features

- Routines: a "when → do" rule starts a flow on an event from any source — a Slack message in #bugs, a new MR to review, a finished meeting, a weekday at 9:30. Events from every source look the same (title, text, link, author, fields), so conditions, the check and the flow input work the same way for all of them. agentgraph fetches events itself while the app is open; rules live in `~/.agentgraph/routines`, sources in `~/.agentgraph/sources`, keys separately in `secrets.json`
- Sources: your own command (anything that prints a JSON list of records), a schedule (cron), Slack (live with an app token, polling otherwise), Telegram bot, GitLab and GitHub (MRs/PRs to review, mentions, comments), Jira (JQL), RSS/Atom, a folder, email over IMAP and claude.ai connectors, plus ready recipes for Fireflies, Sentry, Linear and GitHub notifications. "Describe in words" connects any other service: an agent finds its API, asks for the key, builds the check and shows what it found and what will run before you save it
- The path of an event: field conditions without a model, an optional check in words (haiku reads the event against your condition and looks for duplicates), then an ordinary run with space, worktree and budget. "Wait for me" stops the run before chosen blocks (new runner option `pauseBefore`) and shows a card on Home with what the agent already did: "Fix", "Not now", "Not a bug". The result goes back where the event came from — Slack thread, Telegram chat, MR or Jira comment — after your check, right away, or not at all, chosen when you create the routine. Your own bot's messages never trigger a routine
- Routines screens: the list with recent triggers and a pause switch, "New routine" in four steps with the rule as a sentence, "Connect a service", the editor with "Check on history" (what would have run, where the rule disagrees with your past answers, an estimate per week), the trigger log with filters and "It's a bug" / "Not a duplicate" feedback that teaches the check. Limits per day, in parallel and per run. What arrived while the app was closed and missed schedules are offered once on Home instead of running on their own
- Quick session: "+" on the rail and ⌘N — pinned folder sets, spaces, folders of past sessions; Enter opens the terminal right away, ⌘Enter the full form. A space keeps its folder set and knowledge tags (the "Folders" and "Knowledge" tabs), and session and run forms fill them in
- "Unfinished" on Home: a model reviews recent sessions and says, for each, what is left and where to continue; the price is estimated first and it runs only on your click
- "Code" section: Jira tasks, MRs and project branches moved from Home to their own screen. The left menu is now a rail of section icons and one panel with "Now" and a single list — Flows, Runs or Sessions
- Desktop: `npm run desktop:install` puts AgentGraph.app in Applications to start from Finder and keep in the Dock. Notifications come from the app itself, and clicking one opens the run or session it is about
- e2e tests on Playwright (`npm run e2e`): a real server on temporary folders with fake `claude`, Slack and Telegram

## 0.4.0 — 2026-11-14

### Features

- Teamwork: plan a feature as a team in a shared git repo. A team's projects (PRD, architecture, design, documents, tasks with dependencies, backlog and sprints) are files in an ordinary git repository, and code stays in its own repos. "Create team" on an empty repo gives it the template, including the agents' flows; teammates join with "Join by URL". agentgraph keeps a local clone, commits every change, pushes it a few seconds later and pulls teammates' changes in the background. The sync line says what hasn't gone out and why. Concurrent edits are merged field by field, and what can't be merged is shown with both versions
- Project documents read like documents: a table of contents, and requirements `FR-N`/`NFR-N` as rows with the tasks that cover them. A requirement without tasks is marked and gets "Create task", and task numbers, requirements and document paths in the text are links. You edit one section at a time in place, with live markdown and requirement rows you can drag. Saving conflicts only when someone changed that same section. "History" opens past versions as diffs
- Agent drafts: the team's flows draft the PRD from the code, architecture and design from the PRD, and "Break down the PRD into tasks". They run as ordinary runs, and you accept their edits one by one; "With an agent…" rewrites a single section. A breakdown proposal shows the tasks by waves, as a list or a dependency graph, with the longest chain and a cycle check, and every task can be edited before you accept it
- Backlog, sprints and board: an ordered backlog with quick add, drag and drop (or "Move…" and ⌥-arrows from the keyboard) and actions on several tasks. Sprints have no dates: "Start a sprint", "Close sprint" with a summary and a choice for unfinished tasks, then a history of closed sprints. The board has four columns and filters, and its cards show blockers, runs, sessions and the PR. The task panel holds fields, acceptance criteria, comments and the work done on the task
- "Start work ▸" sends a task to the team's flow or to a Claude Code session in a worktree on the task branch `tw/<ID>-<slug>`, with everything the agent gets shown in the run form first. The task moves to "In progress" when work starts, to "Review" when the run is done or a PR is opened, and to "Done" when the PR is merged. Statuses only move forward, and PRs are found with `gh` or `glab`. A session opened from a task can update the task and write the project's architecture, design and documents, always asking you first
- Home shows "My tasks" across all teams. The desktop app asks before quitting while team changes are unpushed and can send them first
- Team flows run only in a version you trust: one changed by a teammate shows its diff, shell commands and risky tools until you choose "Trust this version". Team flows can't use plugins, extra folders, local flows or permission modes above `default` and `plan`. `.claude` folders in the team repo are not applied, and the project overview names them
- Terminal sessions can edit their own space (map, state, documents, `space.json`, its `.claude/`) and flows, with your approval: every edit asks, in every permission mode, with claude 2.1.285 or newer. `space.json` and flow files are checked like in the API before the question, and an edit that doesn't pass is refused with the errors. In `dontAsk` the edit is refused with the reason, since Claude Code shows no question there. In `bypassPermissions` a Bash command that names the space or flows folder asks too. New session tools are `space_map_write`, `space_state_write`, `space_settings` and `flow_write`

### Fixes

- Terminal sessions can no longer write agentgraph's settings files (`settings.json`, tokens). The write hook that guards knowledge tags and other spaces now runs in every session, not only in one started in a space folder
- A failed git command is named in the error ("git fetch: …"), not by its first option ("git -c: …")

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
