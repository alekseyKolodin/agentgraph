# agentgraph: how it works and how to use it

A short guide for those seeing the project for the first time. The full reference (every `flow.yaml` field, every UI button, the API) is in [REFERENCE.md](REFERENCE.md), and an overview with a demo is in the [README](../README.md); this guide covers only what you need to get started.

## What it is

agentgraph runs Claude Code not as a single session but as a **chain of phases in a loop**, until a condition is met.

```
task ──► phase 1 ──► phase 2 ──► … ──► condition ──► done
             ▲                             │
             └──── condition feedback ─────┘   (next iteration)
```

A few words you will see below:

- **Flow** — a YAML file in `flows/`: which blocks and phases it consists of, what each phase does (its prompt), which tools it has, and when the result counts as done.
- **Phase** (the `phases` field in YAML) — a fresh Claude Code session with its own prompt. The prompt gets the task (`{{input}}`) and the output of the previous phase (`{{prev}}`). A phase sees only this text, not what the previous one read and thought, so every boundary between phases is a loss. Most often there is a single phase: it figures things out, does the work and checks it, and the block's condition does the acceptance. A separate phase is justified at a context boundary: a read-only review after a writing phase, parallel independent work, a step with a huge context that must be compressed before the next one.
- **Group** (the `group` field of a phase in YAML) — adjacent phases of one block that run at the same time. They all see the same `{{prev}}` — the output from before the group — and the next phase gets their outputs joined together. Good for independent reviews and research.
- **Block** — a set of phases: either a loop until a condition, or a single pass. A flow can consist of several blocks in a row. For example: "write the spec until the judge accepts it" → "split into tasks in one pass" → "implement until the tests are green". A block can also call another flow instead of having phases (`flow: <name>`: it runs as a separate child run, and its result goes on as `{{prev}}`), and a block's `next` can jump forward to a later block or end the run depending on a marker, a command or a judge; see ["Calling another flow and branching"](REFERENCE.md#calling-another-flow-and-branching).
- **Condition** — checked after all phases of the block have run. Types: **command** (a shell command returned 0, e.g. `npm test`), **judge** (a Claude session evaluates the result against a rubric) and **marker** (the phase output contains a given string). If the condition is not met, a new iteration starts.
- **Feedback** — what the condition reported: the output of the failed command or the judge's feedback. It goes into the next iteration's prompts as `{{feedback}}`.
- **Artifact** (the `artifacts` field in YAML) — a named run file: a plan, a checklist, decisions. It lives for the whole run, survives iterations and blocks, and carries over when the run is continued. A phase gets it through `reads`, `writes` or `{{artifacts.KEY}}` and writes only to its own `writes`. You can edit it in the UI between steps, and the next phase will see the edit. Unlike `{{prev}}`, which lives until the next phase, an artifact has one current copy.
- **Task** — what needs to be done. Its text goes into prompts as `{{input}}`.
- **Space** — a feature or a project that sessions and runs work on: implementation, bug fixes, review fixes, conflicts. The task is what to do now; the space is which feature it is, where things are and where it stands. A space is a folder `~/.agentgraph/spaces/<slug>/` with its own `CLAUDE.md` (the map: the gist, where things are, where to go for what, agreements), `docs/` (specs, decisions, notes) and `STATE.md` ("where we are now", rewritten by a short model session after a successful run or a terminal session). You pick it at the start of a session or a run, and the agent gets the map as memory, like a repository's `CLAUDE.md`, the list of documents and the state. Spaces are edited on the "Spaces" page; the AI can create a new one from the task text via the "Create a space automatically" checkbox. Spaces replaced task tags: old task tags became spaces with the same slugs on the first start (the tag folders are copied to `~/.agentgraph/backups/pre-spaces/` first). After updating, restart the app, and don't run an older agentgraph on the same `~/.agentgraph` alongside this one: it would keep writing task tag summaries the spaces don't take in by themselves. Then, for each moved space: write its map if the tag had no notes, add the sessions of the same work that had no tag (the space page offers those from the same folders), and decide whether to click "Update state" on a session marked "the app was closed" (a paid haiku session) — see ["Moving from task tags"](REFERENCE.md#spaces-a-feature-or-project).
- **Knowledge tag** — what the phases of a block need to know: frontend, backend, QA. A "when it's needed" description, notes (instructions), paths and attachments; no summary. It is attached to a block with the `knowledge: [qa]` field in flow.yaml, or to the whole run or a terminal session with a chip in the form; tags are edited on the "Knowledge" page. The block's phases get one line per tag at the end of the prompt (slug, title, description) and the `knowledge_read` tool, which they use to read the notes and the list of attachments when they need them; the tag's paths are always open for reading. A short tag with "every time" rules can be marked "always insert the notes into the prompt in full".
- **Run** — one execution of a flow. Everything that happened is saved in `runs/<date>-<flow>/`.
- **One-off run** — a run of a flow that is not saved to `flows/`: the flow is generated for the task, edited as a draft and run right away. Its only copy is the snapshot `runs/<id>/flow.yaml`, and `run.json` has `adhoc: true`. If you like it, use "Save as flow".
- **Project directory** — the folder where agents read and edit files: your target project, not the agentgraph folder.

You can write a flow by hand, assemble it in the UI builder, or generate it from a task description: the generator (also Claude) proposes the phases, prompts and condition itself.

## Prerequisites

| | |
|---|---|
| **Node.js 20+** | `node -v` |
| **Claude Code with authentication** | agentgraph works through `@anthropic-ai/claude-agent-sdk` and uses the same authentication as `claude` in the terminal: a subscription login (`claude`, then `/login`) or the `ANTHROPIC_API_KEY` variable. If `claude` works in your terminal, agentgraph will work too. |
| macOS or Linux | not tested on Windows |
| `terminal-notifier` (optional, macOS) | `brew install terminal-notifier`: clicking a system notification opens the right run |

## Installation

```bash
cd agentgraph          # unpacked archive or repository clone
npm install
```

`npm install` also downloads the Claude Code binary for your platform. That is why you can't copy `node_modules` from someone else's machine: install the dependencies yourself.

`node-pty`, the terminal of the Sessions tab, is an optional dependency with ready builds for macOS; on Linux it is compiled with node-gyp (Python 3, make, a C++ compiler). If that fails, `npm install` still succeeds and there is simply no Sessions tab.

Check that everything is in place:

```bash
npm run typecheck && npm test
```

## Launching

The main way is the web interface:

```bash
npm run ui
```

Open http://127.0.0.1:4747. Useful options (after `--`):

```bash
npm run ui -- --cwd ~/code/my-repo   # default project directory in the run form
npm run ui -- --port 4848            # a different port
npm run ui -- --no-notify            # no system notifications
```

The interface is a React app from `web/`. `npm run ui` builds it into `dist/web` before starting the server if there is no build or `web/` has changed (the first time takes a few seconds). To build manually: `npm run build:web`. Old links to runs and flows (`/#run/<id>`, `/#flow/<name>`, `/next/…`) open the same screens.

To stop the server: `Ctrl+C`. Runs in progress at that moment are cut off and show up in the list as "interrupted". Such a run can be continued from where it stopped.

### Updates

When agentgraph runs from a git checkout (`npm run ui`, `agentgraph ui`, `npm run desktop:dev`, the app from `npm run desktop:install`), the server runs `git fetch` 10 seconds after start and then once an hour, and compares the branch with its upstream (no upstream — `origin/<branch>`). If there are new commits, an **Update** badge appears next to the name in the sidebar; it opens the list of new commits and **Update and restart**:

1. `git merge --ff-only` to the upstream — only a fast-forward: with uncommitted changes to tracked files or with local commits of your own, the dialog says why it can't update and suggests `git pull` by hand;
2. `npm install` if `package.json` or `package-lock.json` changed (a `package-lock.json` rewritten by your npm version is put back to the committed one); `npm run build` if `src/` changed and there is a `dist/` build (the desktop app and `bin/agentgraph` run from it); `npm run build:web` if `web/` changed;
3. runs in progress are stopped as with "Stop" (they can be continued), terminal sessions end (the conversation is kept), and the process restarts: `npm run ui` / `agentgraph ui` replace themselves in place (`process.execve`, Node 22.15+; the same terminal, `Ctrl+C` works as before), the desktop app quits and relaunches (if a window has unsaved changes and you choose "Stay", it keeps running and asks you to restart by hand). The page reloads by itself when the new server answers; other open tabs stay on the old interface until you reload them.

If a step fails, the checkout is reset to the previous commit, the steps that had started (dependencies, builds) are repeated for it, and the dialog shows the error. Without `process.execve` the update is applied and the dialog asks you to restart by hand. The packaged app (`.dmg`) and an archive from `npm run share` aren't git checkouts and don't check for updates. The background `git fetch` never asks for anything in the terminal: ssh runs with `BatchMode=yes` unless you set `GIT_SSH_COMMAND` yourself. To turn checking off: `AGENTGRAPH_NO_UPDATE_CHECK=1`. API: `GET /api/update`, `POST /api/update/check` (fetch now), `POST /api/update`; the server checks only when started with `update: true` (`agentgraph ui`, the desktop app).

### Desktop app (macOS)

The same server and the same UI in a separate window, without a terminal or a browser tab. It is an Electron wrapper: the main process (`src/desktop/main.ts`) calls `startServer()` from `src/server.ts` on a free `127.0.0.1` port and opens a window at `http://localhost:<port>/` — over http, not from `file://`, otherwise `server-guard.ts` would reject the requests. Electron rather than Tauri: the Agent SDK runs only in Node, and Electron carries Node inside.

```bash
npm run desktop:install # put AgentGraph.app into Applications: launch it by its icon, keep it in the Dock; code and data stay in this checkout
npm run desktop:dev     # build the UI (if outdated) and the server, open the window; data comes from the project root, as with npm run ui
npm run desktop:build   # build release/desktop/AgentGraph-<version>-<arch>.dmg and .zip (and the .app itself in release/desktop/mac-<arch>/)
```

The Electron binary (~100 MB) is downloaded on the first `desktop:install`, `desktop:dev` or `desktop:build`, not on `npm install`: those who use only `npm run ui` and the CLI don't need it.

**The app in the Dock — `npm run desktop:install`.** `desktop:dev` starts the bare `Electron.app` from `node_modules`: its Dock icon can't be kept (pinned, it opens an empty Electron), and macOS doesn't deliver its notifications. `desktop:install` builds the UI and the server and creates `AgentGraph.app` in `/Applications` (in `~/Applications` if that isn't writable; `-- --dir <folder>` for another place): a copy of `Electron.app` with its own name, icon and bundle id (`dev.agentgraph.desktop.checkout`), ad-hoc signed, with a stub that loads `dist/desktop/main.js` of this checkout. It behaves like `desktop:dev` — data in the project root, auto-update from git — but it starts from Finder, Spotlight or the Dock (right-click the Dock icon → Options → Keep in Dock) and picks up the login-shell environment like the built app. On an APFS disk the copy takes no extra space. Run it again after the checkout folder moves or Electron is updated in the checkout (the app tells you); an existing `AgentGraph.app` that isn't this shortcut is never overwritten. The shortcut and the built app from the dmg share `~/Library/Application Support/AgentGraph`, so they don't run at the same time: the second one started hands over to the first. To remove it, move `AgentGraph.app` to the Trash. What goes into the bundle — `src/desktop-link.ts`.

What you should know:

- **Where the data is.** In `desktop:dev`, the project root. The built app needs an external folder with `flows/` and `runs/`: `AGENTGRAPH_HOME` (including from `~/.zshrc` — the app picks up the login-shell environment); otherwise on first launch it asks for a folder (for example, an agentgraph checkout) and remembers it; cancelling uses an empty folder inside the app. To change it: the "File → Data folder…" menu. What it remembers (folder, port) is in `~/Library/Application Support/AgentGraph/desktop.json`.
- **Access to "Documents".** If the data or project folder is in `~/Documents`, `~/Desktop` or `~/Downloads`, macOS asks for permission on first access. Until you answer, the window doesn't respond: the system dialog may end up behind the app window. For the app from `desktop:install` this includes the checkout itself: with the checkout in `~/Documents` the window appears only after you allow access.
- **Notifications** come from the app itself: an agent's question, a pause, a run ending and a terminal session waiting for you — when no app window is in front. Clicking one brings the window up on that run or session (and opens a window if it was closed). macOS asks to allow notifications from AgentGraph the first time; until you allow them — and always in `desktop:dev`, whose Electron isn't signed — a notification is shown the way `npm run ui` shows it (`osascript` or `terminal-notifier`), and its click doesn't lead into the app. See [Notifications](REFERENCE.md#notifications).
- **The port** is its own, not 4747: the app and `npm run ui` can run at the same time. But over the same `runs/`, a run started in one is shown by the other as "running in another process", and it can only be controlled from there. The `/agentgraph` skill gets the app's address through `AGENTGRAPH_URL` (the port is in `desktop.json`).
- **Closing the window** — runs continue; clicking the Dock icon opens the window again. **Quitting (Cmd+Q)** — running runs stop as with the "Stop" button (agents are shut down, the run gets the "aborted" result and can be continued), then the app closes. If terminal sessions are live, it asks first ("Close AgentGraph?"); their claude processes get SIGHUP, and the space's state isn't written: such a session waits for "Update state".
- **Claude Code inside.** The Agent SDK launches the Claude Code CLI from the platform package; in the app it lives in `app.asar.unpacked` (a process can't be launched from inside an asar), and the SDK gets the path through `AGENTGRAPH_CLAUDE_EXECUTABLE`. Authentication is shared with `claude` in the terminal.
- **The Sessions terminal inside.** `node-pty` is a native module: `pty.node` and its `spawn-helper` can't run from inside an asar either, so `electron-builder.yml` unpacks `node_modules/node-pty` to `app.asar.unpacked` (without its Windows builds and sources). It isn't rebuilt for Electron (`npmRebuild: false`): node-pty 1.1.0 is N-API and ships builds for darwin-arm64 and darwin-x64. Before packaging, `desktop:build` runs `scripts/pty-helper.mts` (after the UI and server builds, right before electron-builder), which makes `spawn-helper` executable (1.1.0 ships it without the bit).
- **Packaging is electron-builder** (`electron-builder.yml`), not Electron Forge: we already have our own build (`tsc` for the server, Vite for the UI), and electron-builder simply packages the ready `dist/` with the `dependencies` from `package.json`, while unpacking the SDK binary and `node-pty` from asar and the dmg/zip targets take a couple of config lines. Forge wants to run the build itself through its Vite/webpack plugins.
- **Limitations.** The app is not signed: on another Mac, open it via right-click → "Open" (or `xattr -dr com.apple.quarantine AgentGraph.app`). The build targets only the architecture of the machine it was built on: the Claude Code binary in `node_modules` is installed for it, and there is no universal build.

## First run (costs cents)

1. In the UI, pick the **example-blocks** flow on the left (the `example` folder). The flow opens right on the **Run** tab.
2. Look at the neighboring **Builder** tab: three blocks; for each phase you can see its prompt, tools and what the phase passes on.
3. Go back to **Run** → **Run**. The task is already filled in, and the phases have no tools, so no files will be touched.
4. On the run page you can see the phases go through iterations, what the judge answered and how much it cost. The "prompt / transcript / output" buttons on each phase show exactly what went to the agent and what it returned.

Four more examples in `flows/example/`:

- **example-ask** — the agent asks the user a question (the `AskUserQuestion` tool). The question pops up in the UI, and you answer it there.
- **example-pause** — the agent pauses the run itself when it can't do without a human (`loop.pause_marker`).
- **example-parallel** — three phases run at the same time (the `group` parallel group), and a fourth combines their outputs. On the run page you can see several phases "running" at once.
- **example-compose** — connecting flows: a phase decides what to do and ends with a marker, `next` leads to a call of `example-parallel` or of `example-blocks` (repeated until the judge approves), and each call runs as its own child run with its own page.

## Routines and My tasks: the first hour

Home (`/`) is the **My tasks** board. A task is the state of a real thing (an MR or PR, a Jira issue, a branch, a terminal session, a Slack thread, or your own note), not an event. Five comments on one MR are one task. A review asked for in GitLab and again in Slack is one task with two signals. Tasks are personal and live in `~/.agentgraph/desk/`. They are filled by **routines**, and **watchers** keep them current. The design is in [desk/SPEC.md](desk/SPEC.md).

### What the board shows

- **Five columns:** **New**, **Planned**, **In progress**, **Waiting on others**, **Done**.
  - **Card:** kind (`Ревью`, `Jira`, `Встреча`, `Забытое` — routines name it), project (space), due date and how long it has been in the column.
  - **Why line:** why it is your move ("3 files not committed", "the author replied", "agent finished: …").
  - **Who moved it last:** for example "moved by watcher".
- **Card actions:**
  - **Continue session** / **Start session** — a Claude session for the task; it moves to In progress.
  - **Run a flow…**
  - **Reply** — opens the conversation where you were asked.
  - **Link an MR or issue…**
  - **Move to** (or ⌥← ⌥→), **To plan**, **Not mine** (closes it), **Close**.
- **Above the board:**
  - **Agent questions**: questions from running flows (answered in place), "catch up", routine waits and terminal sessions waiting for your answer. A routine wait that is a task (**Run / Not now / Not mine**) and the question of a session started from a card are on that card, not here; what has no card on the board (a closed task, another project's slice, a pause or a draft reply) stays here.
  - **Start with this** — computed without a model: overdue first, then due today, then the longest your-move, then the newest in New.
  - **"N of N fine"** — every source and the watchers: "checked 09:12, 14 records, 2 new", "checked, empty for 6 days — usually 3 a day", "broken: …", "key missing", "not checked since the app started". With a broken source, **Fix** opens Routines.
  - **By project** — `/?project=<space slug>` shows one project.
- **Empty board:** Home offers the routine templates.

### Fill it in an hour

1. **Who you are.** Rail → **Code** (`/code`) → **Connections** → **Who I am**.
   - Fields: names, emails, GitLab and GitHub logins, Slack member id, Jira email.
   - Empty fields fill themselves from `glab`, `gh`, `git config` and the Jira connection; what you type is kept.
   - Routines use the profile to tell "addressed to me" and "my action items" from the rest, and to skip your own messages.
2. **Connections.** In the same dialog:
   - **Jira**: address, email, API token. The token is checked on save.
   - Your git repositories.
   - Install and log in `glab` (`glab auth login`) or `gh` (`gh auth login`) for MRs and PRs.
   - A project is a space: link its repositories on the space page (**Repositories**). Work outside every space is "No project".
3. **Four templates.** Rail → **Routines** (`/routines`) → **New routine**, or the tiles on an empty board.
   - **Review: assigned in GitLab or GitHub.** A `Ревью` task when you are asked to review. The `desk-review-mr` flow does a first review after you press Run (the routine waits for you). If the source can reply, the draft goes back to the MR.
   - **Review: a link dropped in Slack.** A message with `/merge_requests/` or `/pull/` in it. Slack is connected through Claude: **Connect a service** → **Ready-made** → **Service connected to Claude**, with your claude.ai Slack connector or an MCP server. The same MR from GitLab and from Slack is one task.
   - **Jira: assigned to me.** A `Jira` task when an issue is assigned to you or appears in the query. `desk-task-start` works in a new worktree of the project, so the template needs a project folder.
   - **Meetings → tasks.** The Fireflies.ai recipe (key `FIREFLIES_API_KEY`). `desk-meeting-tasks` turns your action items from the meeting summary into `Встреча` tasks; the due date counts from the meeting date. It runs by itself with a $1 limit.
   - **What saving does:** the template's flow is copied into `flows/Мои дела/`, where you can edit it. The routine is saved switched off; the next screen has **Check on history**, which shows which tasks the recent events would have created. **Turn on** starts it.
   - **First poll:** the routine creates tasks for what is already in the source (for example, reviews assigned before you connected it, up to 50).
4. **The Projects source.** **Connect a service** → **Ready-made** → **Projects**.
   - What it lists: branches of your spaces' repositories that are dirty, have unpushed commits, or are ahead of the base without an MR; terminal sessions that ended on a question. No model.
   - **Spaces** (field): space slugs; empty means all open spaces.
   - **Session review by model** (field): for example `24h`, off by default. Sonnet then reviews sessions with new turns, about $0.05–0.6 per review. Its "unfinished" and "last step" verdicts become tasks too.
   - Then make a routine on this source with **Task**, kind `Забытое`, and flow **nothing — only create a task**.
   - It is a snapshot: a branch that became clean, a session that was answered or deleted — its task closes ("no longer in «Projects»"). If it comes back, the task reopens. A repository that could not be read keeps its previous records.
   - **Alternative — Every morning → project sweep:** the same with a model, as a scheduled flow in one project folder.

### How a task moves by itself

Watchers check the things of open tasks while the app or `agentgraph ui` runs, about every minute for branches, every 2 minutes for MRs and every 5 minutes for Jira. They also run right after start, so whatever happened while the app was closed lands on the first pass, without clicks.

| What happened | Where the task goes |
|---|---|
| Your move again (author replied, review requested again) | Waiting on others → Planned |
| Someone else's move (you replied last) | Planned or In progress → Waiting on others |
| The thing closed (MR merged, issue done, branch clean) | Done (unless the routine's rule is "only by hand") |
| A new signal about the same thing | Waiting on others or Done → Planned |
| A session or run started from the card | In progress; when the run ends, the column stays and the why line says how it went |

A move by hand holds until the thing itself changes. The watcher sees the same state on every pass and leaves your column alone. A thing without a watcher (a thread, your own task) moves only by hand or by the flow and session tools `desk_put` / `desk_close`.

### A month later

- **"Stuck for over N days: K"** above the board (or **Week** when nothing is stuck) opens the **Week review**:
  - what was **Closed**;
  - what is **Stuck** — no move in Planned, Waiting on others or In progress for N days; N is 3, 7, 14 or 30, set in the review, 7 by default;
  - what **Arrived**, by routine, and "by hand and from sessions".
- After a task you worked on (with a run or session) is closed, **Save a lesson** offers a line for the knowledge tag of that kind of work. Phases and sessions with the tag get it next time.

## Everyday use

### Create a flow

- **"New flow" → generate**: describe the task in words ("fix the failing tests, don't touch the tests themselves"), and the generator proposes a flow. Before running it, check the prompts, tools and condition.
- **"New flow" → assemble by hand**: an empty template; phases are added in the builder.
- **"New flow" → one-off run (don't save the flow)**: like "generate", but the flow is not saved. The draft opens in the builder marked "one-off": edit it by hand, with "Edit with AI" or in YAML; the "Apply" button only validates the edit. Then the **Run** tab → "Run": the run follows what is in the builder right now, and nothing appears in `flows/`. The draft lives only in this browser tab, and leaving it asks for confirmation. On the page of such a run, instead of "To flow" there is "Save as flow" (name and folder; a taken name is not overwritten).
- **Edit with AI** (above the graph in the builder): describe what to change ("add a review phase after implementation"). The edit lands in the builder unsaved: you look at what changed and click "Save" (the button at the bottom appears when there are unsaved edits) or "Undo edit".
- The **YAML** tab — for fine-grained text editing.

Flows are saved to `flows/<name>.yaml` or `flows/<folder>/<name>.yaml`. These are ordinary files: you can put them in git and send them to colleagues.

### Run

The **Run** tab:

- **Space** — the first field: pick the feature from the list (freshest first, search by name) or type a new slug (`loyalty-card`, a new space is created empty). Picking it fills in its working folder below, with a "from space «X»" caption. **Model gets** under it shows what the phases will get — the map, the state, documents, knowledge tags — readable or exactly as sent, so you don't need to describe the feature again: write only what to do now. The **Update the space's state after the run** checkbox is on by default: after a run with the "done" status, the state is rewritten. The "Result" card shows "Space state updated" with a "state" button, or the reason it wasn't updated. The space itself — map, documents, state, paths — is edited on the **Spaces** page in the sidebar. More in the reference, section ["Spaces"](REFERENCE.md#spaces-a-feature-or-project).
- **Project directory** — where agents read and edit files, that is, your target project, **not** the agentgraph folder. Picking a space fills it in; a folder you typed or chose yourself stays, and a "use it" button offers the space's folder. You don't have to type the path: the **Choose…** button opens a folder picker in Finder (macOS only). The same button is in the new flow form, when adding a project in "Connections", next to a phase's "Additional directories" in the builder, and next to "Additional directories" in the run form (in both fields the chosen folder is appended as a new line).
- **Task** — what needs to be done; it goes into `{{input}}`.
- **Attachments** — screenshots, PDFs, logs and other text files for the task: "Add files…", drag and drop onto the form, or paste a screenshot right into the task field. Up to 10 files, up to 10 MB each, up to 25 MB in total; `.docx` is not accepted. Every phase gets the paths to them, but the agent opens them with the Read tool, so phases without Read won't see the attachments. The form shows which phases those are.
- **Additional directories** — one path per line: where, besides the project directory, all phases of this run may go (for example, a neighboring repository with rules). They work like a phase's `add_dirs`, but for the whole run.
- **Recent directories** — chips under the project directory and under additional directories: the latest run paths and the projects from "Connections". A click fills in the path, so you don't need to look for it again; the "×" on a chip removes the path from the list until there is a new run with it.
- **Iteration limit**, **cost limit** (USD) and **model** — optional.

### Monitor and intervene

- **Home** (the first item on the left, with the question counter; the logo leads here too) shows all running runs and agent questions from all runs at once. You can answer right from Home.
- **Limits** (in the Home header): how much of the Claude subscription's 5-hour and weekly windows has been used and when the window resets — the same numbers as in Claude Code's `/usage`. They refresh once a minute; click to refresh immediately. With an API key (no subscription) the block is not shown.
- **Log** (the panel on the right of Home): a history of agent questions, pauses at their request and run endings — everything you get notifications about, including what you missed while the UI was closed. It is a log, not an inbox: what waits for you is on the board; a click opens the run. The first 20 events are shown; "N more" opens the rest.
- **Status filter** above the run list on the left: show, for example, only failed runs or only those waiting for a reply.
- **Run name**: a few seconds after the start, the model gives the run a short name based on the task. It is the title in the list, on the run page and on Home, with the flow name in small text under it. Old runs have the flow as the title.
- **Search** in the sidebar: "Find flow…" searches by flow name, folder and description; "Find run…" by name, flow, task, space, knowledge tags, project folder and run id. It works together with the status filter; Esc clears the field.
- **Run chat** — a dock on the right edge of the run page, on every tab (open by default for a running run; "Collapse" or Esc folds it into a strip): ask the agent what is going on and why, or ask it to pause, resume, raise the iteration limit, answer a phase's question or give the next step an instruction, and it does that right away. Stopping the run, writing an artifact, answering a pause, applying or saving a flow edit, repeating an iteration, continuing (with a model and a cost limit) or running again it only offers as buttons under the reply, and they run after you confirm. The reply is markdown with a collapsed list of the agent's steps, plus tables, links and reply chips. "Clear context" or `/clear` starts the conversation over.
- **Agent questions and the pause reason** are shown as formatted markdown, with the question header as a badge; for an answered question, the answer is shown under it.
- **Prompt of a running phase**: on a ⏳ card the "prompt" and "transcript" buttons appear as soon as the phase starts, and a judge check has "judge prompt". The prompt and output open as formatted markdown; "as text" in the window header shows the source. Text longer than 300,000 characters or with a line longer than 10,000 characters is shown in monospace without formatting. The transcript is re-read every time it is opened.
- **Phase model and effort**: each phase card (running and past) has a "model · effort" chip. The model is the actual one, from `system/init`: for a running phase without a set model it appears a second after the start. The effort is the configured one (phase → `defaults`): the SDK doesn't report the actual one, and without a value there is no effort chip. The data is in `run.json` (`phases[].model`, `phases[].effort`); old runs have no chip.
- **Phase context**: next to the model there is a `ctx 172k / 1M · 17%` chip — the phase's context peak, the model window and the percentage (yellow from 70%, red from 90%); for a running phase it grows as the session goes on. The data is `phases[].tokens` in `run.json` (`contextPeak`, `contextWindow`); old runs without a window show only `ctx 90k`, and without `tokens` there is no chip.
- **Run scheme** above the phase blocks: the flow graph, showing which phase and iteration the run is on now, what has been completed and how much it cost; clicking a node leads to the phase card or opens the artifact; the phase node badge shows the percentage of the context window in use.
- **Collapse iterations**: on the run page, blocks and iterations collapse when you click their header, and the "Collapse all" / "Expand all" button does it all at once; by default only the current one is open. The live log is open only for a running run.
- **Pause**: the current phase finishes, and the next one doesn't start until "Resume". This is the best time to edit artifacts: while paused, nobody writes to them.
- **Fix and continue**: the instruction field on the running phase's card and on the pause card adds your text to the next step's prompt (with "for the rest of the run", to every following step). On a pause you can also edit the run's flow ("Apply to the run", optionally "Also save to flows/<name>.yaml"), take the current `flows/<name>.yaml` into the run, or repeat the iteration with an instruction, and the same run goes on under the same id. Changes to finished blocks, the name, the task or artifact declarations are rejected with the reasons. More in [REFERENCE.md](REFERENCE.md), "Fix and continue".
- **Artifacts** (the "Artifacts" tab of the run page, only for flows with `artifacts`): the summary line tells how many artifacts there are, which was changed last and by whom, and whether a phase is writing them right now; below it is a row per artifact. Click a name: a window opens with the text, a markdown preview and versions. "Edit" → "Save" (or "Save and resume" while paused); every step that starts after saving gets the edit, marked "the last edit was made by the user". While a phase that writes this artifact is running, editing is blocked with a reason. If you close the window without saving, the text stays as a draft ("unsaved"), and "Resume" asks whether to save it. Warnings (a phase wrote to the wrong place, a foreign file appeared in the folder) are shown with a ⚠ icon on the iteration and on the artifact. A markdown artifact with a checklist (`- [ ]`, `- [x]`) has an "N of M open" badge in its row and in the window header: it updates as the run goes on and after an edit is saved.
- **Reply to a pause**: if the agent asked for a decision and the flow has a decisions artifact (`decisions: true`), there is a "Reply" field under the pause card. Write a reply and click "Resume with reply" (the same button is in the header): the reply is appended to the decisions artifact together with the agent's questions, and the run continues. On Home, the "Reply on the run page" button leads to the same place. If there is no decisions artifact, the card offers "Open artifacts" or, for a flow without artifacts, to write the decision where the agent asks.
- **Stop run**: aborts the current session immediately.
- **Continue from where it stopped**: a run that hit a limit, failed or was stopped can be continued if its first block was accepted, or if the first block itself hit the iteration limit (it starts again from its first iteration with the limit from the flow; the code and artifacts stay), or if the first block is a flow call that already started its child run. Blocks already accepted are not run again, and artifacts move to the new run together with your edits made after the stop. A run that failed or was stopped inside its first block of phases, single-block or not, can't be continued: run it again from scratch.
- **Enable notifications** (a button on Home, shown until the browser has asked for permission): browser notifications about questions and run endings. If permission is denied, Home shows "Notifications off". If the UI is closed, the server sends a system notification. In the desktop app the button isn't shown: the app shows notifications itself.

### See what goes into the context

- Open **Context** on the left and pick a project directory: you'll see CLAUDE.md and rules with token counts, skills, subagents, MCP and the token total.
- Pick a space to see its `CLAUDE.md` among the memory files (the space page has a "Tokens in Context" button for that). Pick a flow and a phase to see the context of that specific phase: its model, tools, its own system prompt (`system`) and CLAUDE.md from `add_dirs`. If a directory from `add_dirs` doesn't exist, you get a warning.
- The "Phase prompt by source" section shows what the runner will assemble the phase's first message from: the prompt template, the handoff, the list of additional directories, the space section, the knowledge tag lines and the tags inserted in full, with the size and share of each. If full tags take up more than half the prompt, or instructions come from four or more places (CLAUDE.md and rule files, full tags, its own system prompt), the page warns you: such prompts contradict themselves more often than it seems.
- "Open" on a CLAUDE.md or rule opens an editor with a preview; "Save" writes the file to disk. Skills, plugins and managed policies are view-only.
- The listing is cached for a minute: after editing files outside, click "Refresh".

### Work in a Claude Code session in a space

- Open **Sessions** on the left (there's no tab if the server couldn't load the terminal, `node-pty`), click **New session**, pick a space (its working folder fills in the folder), knowledge tags, check **Model gets** if you like, and click **Open terminal**. It's an ordinary Claude Code session — slash commands, permission prompts, `/resume` — in a terminal inside agentgraph; the space's map loads as memory, and its documents, state and the knowledge tag lines arrive in the context at the start.
- Change the space or a tag in the context row while the session runs: the model sees the change with its next step or your next message (until then the chip is dashed). Reading the new folders doesn't ask for permission; the map of a space chosen on the fly becomes memory after "Restart" in the `⋯` menu.
- Reloading the page doesn't stop the session: the screen comes back. Live sessions are listed under "Now" in the sidebar, ended ones in the Sessions list (the terminal icon on the rail), grouped by space (rename them there with a double-click). "End" stops claude; in the desktop app Cmd+Q asks first if sessions are running.
- When claude exits, the space gets a new state from the session's turns (a short haiku session; the checkbox in "Advanced" of the form, on by default). "Update state" does it at any time; after Cmd+Q the session is marked and waits for the button.
- An ended session's space and knowledge tags can be changed before "Continue". "Continue" opens the same conversation (`claude --resume`) in the same folder with the current space and tags; "Restart" in the `⋯` menu does it for a running session. Sessions stay in the list after a restart of agentgraph.
- On a space's page, "New session" starts the form with the space, and "Session in the folder" opens claude in the space folder itself, to work on the space like on a project; the space's sessions are listed next to its runs.
- Claude can change its space and flows, but only with your approval — it asks before every file edit (`Edit`/`Write`) and every agentgraph tool call, in `default`, `acceptEdits`, `auto` and `bypassPermissions` (with claude 2.1.285+; an older claude refuses there instead). In `bypassPermissions` it also asks before a `Bash` command that names the space or flows folder — and before every `Bash` command of a session opened in the space folder. In `dontAsk` such edits are refused with a hint to switch the mode: that mode can't show a question. Ask it to "fix the map", "update the state", "write this into the feature's docs", "add this folder to the space" or "make a flow out of this": it uses `space_map_write`, `space_state_write`, `space_write`, `space_settings`, `flow_write` or edits the files directly. agentgraph checks `space.json`, the map, the state and a flow before asking (a broken one is refused with the errors), the open space page and the flow list update by themselves. Other spaces, knowledge tags and agentgraph's settings stay closed. A space chosen on the fly is written with the tools at once, and its files after "Restart".
- Ask claude to "open a new session for …": it asks your permission (in `auto` mode too) and opens one next to this one — same folder, space, tags, model and current permission mode unless you say otherwise, with the task as the first message. Click the "Claude opened the session …" popup to go there, or find it under "Now".
- To copy, select with the mouse: claude copies the selection itself ("copied N chars to clipboard"). Option+drag selects with the terminal instead, then Cmd+C.
- Rename a session in place: double-click its name under "Now", in the list or in the header, or click the pencil next to it; Enter saves, Esc cancels. A session started without a name is named after your first message (a short haiku session, about $0.006); a name you set is never replaced.
- Shift+Enter is a new line, a file dragged onto the terminal is inserted as a path.

### Work as a team: Teamwork

A team keeps its plans in a **team repo** — an ordinary git repository of files: each project (a feature the whole team builds) has a PRD, architecture and design documents, tasks with dependencies, a backlog and sprints without dates. Code stays in its own repos. Open **Teamwork** on the left: **Create a team** on an empty repo (it gets the template, including the agents' flows) or **Join by link**. agentgraph keeps a clone in `~/.agentgraph/teams/<slug>/`, commits every change you make and pushes it a few seconds later, and pulls your teammates' changes in the background; the sync line in the header says what hasn't gone out and why. Agents write drafts — the PRD from the code, architecture and design from the PRD, the split of the PRD into tasks — as ordinary runs of the team's flows, and you accept their edits one by one. **Start work ▸** on a task makes a worktree on the task branch and starts the team's task flow or a Claude Code session there; the task moves to "In progress", to "Review" when the run is done or a PR is opened, and to "Done" when the PR is merged. Home shows **My tasks** across all teams. Details and the API: [Teamwork](REFERENCE.md#teamwork-a-teams-projects-in-a-shared-git-repo).

### Run from a Jira issue, MR or branch

The **Code** section in the sidebar (`/code`, the `</>` icon on the rail) shows Jira issues, as well as open MRs and local branches of your projects. The first 5 rows of each list are shown; "N more" opens the rest. Each row has a **Run…** button: you pick a flow, and its "Run" tab opens with the task ready. The run itself doesn't start: you can check and edit the task.

- **What goes into the task**: the key and link, type and status, parent, subtasks, links and description (for an MR, the branches and the MR description). The description is wrapped in `source-data` tags with a note that it is data, not instructions for the agent. If the flow's `input` has a questionnaire with `<...>` placeholders, it goes on top, and the `Ticket: <...>`, `Task: <...>` and `Branch: <...>` lines in it are filled in automatically.
- **Jira** is connected with the **Connections** button (in the header of "Code"; on Home it appears only while nothing is connected): an address like `https://company.atlassian.net`, an email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens). The token is checked before saving, stored in `~/.agentgraph/jira-token` with 600 permissions and never sent back to the browser. Presets: "My sprint", "All mine" (unresolved) and "Custom JQL"; the last JQL is remembered.
- **Projects** are picked up automatically from the project directories of past runs (only existing git repositories). In "Connections" you can add a project by hand, rename it or remove it: auto-discovery won't bring a removed project back. MRs are loaded through [`glab`](https://gitlab.com/gitlab-org/cli), which you need to install and authenticate (`glab auth login`); "Mine" takes your login from `glab`.
- **Separate git worktree**: in the run form, pick a project and a branch and click **Prepare worktree**. It goes into `~/.agentgraph/worktrees/<repo>/<branch>`, the project directory is filled in automatically, and a visible note about the worktree is appended to the end of the task. How the branch is chosen: a local branch is taken as is; if it exists only in origin, a tracking branch is created; if it exists nowhere, a new one is created from the project's base branch (`origin/HEAD` by default); without a branch you get a detached HEAD. A branch already checked out in the main checkout can't be used: switch it first. List untracked files like `local.properties` in the project settings, and they will be copied into the new worktree. agentgraph doesn't delete worktrees itself: `git worktree remove <path>`.
- **Related runs**: a run remembers which issue, MR or branch it was started from and which worktree it ran in, including after "Continue from where it stopped". Its chips with status are shown under the row on Home.

Home has the **My MRs: need attention** section (shown once something is connected). It lists your open MRs from the projects in "Connections" that need something from you:
- the latest pipeline failed (the "CI failed" badge leads to the pipeline);
- discussions are waiting for a reply: the discussion is not resolved, and the last non-system message in it is not yours (bots count too);
- there are conflicts with the target branch.

**Run…** builds the input the same way as in "Tasks and code" and adds a line with the reasons. In the background, haiku picks a suitable flow from yours for each MR. If one is found, a "→ <flow>" chip appears in the row: a click opens the "Run" tab of that flow with the input ready. If there is no suitable flow, there is no hint, and that's fine. Here, too, the run itself doesn't start. The list is refreshed with the ↻ button.

### Where the result is

Agents work right in the project directory: code edits, new files and commits appear there. You can see the outcome right away: a finished run has a "Result" card at the top of the page with the status, numbers and the output of the last step (for a parallel group at the end, of all its members), and the CLI prints the same output after the "Result:" line. You only need to dig into iterations for details. The run log is in `runs/<date>-<flow>/`:

```
runs/2026-10-06_11-40-57-example-blocks/
├── flow.yaml                 the flow as it was run
├── run.json                  status, cost, sessionId and tokens of each phase, result (final)
├── attachments/              task attachments (if any)
├── artifacts/                run artifacts (for flows with artifacts): plan.md, decisions.md, …
├── artifacts-history/        artifact versions after each change: ideas/0001.md, 0002.md, …
└── 01-slogan/iter-01/        (for a single-block flow, iter-01/ directly)
    ├── 01-write.prompt.md       what went to the agent
    ├── 01-write.transcript.md   what it did: text and tool calls
    ├── 01-write.output.md       the phase's final output
    └── condition.json           the condition result
```

You can open any session in regular Claude Code: `claude --resume <sessionId>` (run it from the project directory).

Artifacts stay in the run folder after the run ends too: on the run page they are in the "Artifacts" panel with all versions, read-only for a finished run. If warnings came up along the way, the folder may also contain `artifacts-quarantine/` — that's where the runner moves foreign files from the artifacts folder.

## Command line

The same without the UI. In dev mode, commands go through `npm run agentgraph --`:

```bash
# generate a flow and run it right away
npm run agentgraph -- "Fix the failing tests, don't change the tests" --cwd ~/code/my-repo

# one-off run: generate and run, don't save the flow
npm run agentgraph -- "Rename utils to shared and fix the imports" --cwd ~/code/my-repo --once

# only generate, look at the plan
npm run agentgraph -- gen "Add a /health endpoint with tests" --cwd ~/code/my-repo
npm run agentgraph -- show add-health-endpoint

# edit a flow in words
npm run agentgraph -- edit add-health-endpoint "add a review phase"

# run an existing flow, with session progress in the console
npm run agentgraph -- run add-health-endpoint --cwd ~/code/my-repo --max-budget 3 -v

# continue a feature in its space: the map as memory, the state in the prompts, the state rewritten after done; list spaces
npm run agentgraph -- run add-health-endpoint --cwd ~/code/my-repo --space health --input "Address the review feedback"
npm run agentgraph -- spaces

# compare two flow variants on a task set, each task twice
npm run agentgraph -- eval fix-tests --compare fix-tests-solo --tasks evals/tasks.yaml --runs 2 --cwd ~/code/my-repo
```

Options: `--cwd`, `--input` (replace the task), `--once` (one-off run, only with the "generate and run" form, without `-o`), `--max-iterations`, `--max-budget` (USD for the whole run), `--model`, `--space <slug>` (the run's space; a new one is created empty), `--no-save-state` (with `--space`: don't rewrite its state after the run), `--auto-space` (without `--space`: the AI creates a new space from the task text), `--knowledge <slug>` (a knowledge tag, can be repeated), `-v`. `agentgraph spaces` lists the spaces, `agentgraph tags` the knowledge tags. `agentgraph desk add <title|link> [--kind --due --project --column --why]`, `desk list [--column …] [--project]` and `desk close <key> [reason]` work with the personal to-do board (a link to an MR/PR or a Jira task, or a thing key, makes the item about that thing; the project is the current folder's). Full list: `npm run agentgraph -- --help`.

To call plain `agentgraph` from any folder:

```bash
npm run build && npm link
```

Without `npm run build` the `agentgraph` command won't work: it runs the built `dist/`, and the archive doesn't include it.

At the end the CLI prints a "Result:" line (status, iterations, cost), and below it the output of the last phase; long output is truncated to 4000 characters with a path to the full file.

For a flow with artifacts, the CLI prints an "Artifacts:" line with the path to their folder after the result, and `show` lists the flow's artifacts.

Differences from the UI: the CLI has no pause (a run with `pause_marker` ends with an error containing the questions) and no on-the-fly artifact editing (steps run back to back), and agent questions are asked in the terminal.

## Flow analysis after a run

On the page of a finished run, on the "Overview" tab, there is an "Analyze flow" card. The button starts a short session without tools (sonnet by default, a few cents): it is given the run facts (for each phase: context peak and window share, turns, cost, time, guard denials, which variables and artifacts the prompt uses; for each block: condition verdicts per iteration and stagnation, when feedback repeats) and the flow YAML. The model answers with a verdict (keep / improve / redo), a short summary and a list of recommendations by severity: merge phases that work on each other's output with little context; split or narrow a phase that hits the window or the turn limit; replace a judge with a command if the check is deterministic; narrow excess permissions; move reference material behind a tool. Below the recommendations, a table of facts per phase expands. The result is saved to `runs/<id>/analysis.json` and shown the next time it is opened; "Retry" recomputes it.

## Eval: check whether phases are needed

The "one phase or three", "judge or command" debate is settled not by taste but by a run. A task set is described in YAML:

```yaml
tasks:
  - name: fix-tests
    input: "Fix the failing tests, don't change the tests themselves"
    setup: git checkout -- . && git clean -fd    # before each run: reset the repository
    check: npm test                              # after the run: 0 = task solved
  - name: add-health
    input: "Add a /health endpoint with a test"
    setup: git checkout -- . && git clean -fd
    check: npm test && curl -sf localhost:3000/health
```

```bash
npm run agentgraph -- eval fix-tests --tasks evals/tasks.yaml --runs 2 --compare fix-tests-solo --cwd ~/code/my-repo --max-budget 3
```

Each task is run `--runs` times through each flow, sequentially (runs change the working directory). A task is solved if the run ended with `done` and `check` returned 0 (without `check`, only the status counts). At the end there is a table: share solved, average cost, time and iterations per task and flow, and with `--compare`, separately, the "flipped" tasks where the outcomes differ. Running a task once is not enough: a breakage often shows up in one run out of two. Results go to `runs/evals/<date>-<flow>[-vs-<flow2>]/results.json` (a copy with `--json`); the runs themselves are in `runs/` like ordinary ones, named "eval <flow> · <task> #<n>", and are visible in the UI. Agent questions are rejected in eval, and there are no pauses: flows with `AskUserQuestion` and `pause_marker` are not suitable for eval.

A recipe based on Anthropic's article about folding subagents into a single loop: collect 5–10 tasks, run the current flow, then a single-phase variant; keep the extra phase only if, without it, tasks flipped for the worse. "Analyze flow" suggests which phase to start with.

## Running from a Claude Code chat: the `/agentgraph` skill

`.claude/skills/agentgraph/` contains a skill: in a Claude Code chat you say "run flow X on this project", and it starts the UI server (if it isn't running), starts the flow, forwards the agent's questions to you in the chat and summarizes the result at the end. For a flow with artifacts, the skill shows them, edits an artifact at your request, and writes a reply to a pause into the decisions artifact, like the "Reply" field in the UI.

**One-off run from the chat.** If there is no saved flow for the task, the skill makes a one-off run: `agentgraph.mjs draft --task-file F --cwd DIR` generates a flow without saving anything and returns the plan (phases with tools, condition) and the path to the draft YAML. The skill shows the plan and asks for consent: the flow's tools are allowed without confirmation. Only after "Run" does it call `agentgraph.mjs start --spec-file <yaml> --cwd DIR`. To save the flow of such a run later: `agentgraph.mjs save-flow <id> [--name N] [--folder D]`.

Inside the agentgraph folder the skill is available right away. To make it work from any project, install it globally:

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/.claude/skills/agentgraph" ~/.claude/skills/agentgraph
```

Run the command from the agentgraph root. The skill finds the project root itself through the symlink; if you launch it differently, set the `AGENTGRAPH_HOME` variable.

## Flow from a session: the `/session-to-flow` skill

Solved a task in a regular Claude Code session, ran into errors and dead ends along the way, and want a flow to do it next time? At the end of that same session say "make a flow from this session" or call `/session-to-flow`. You can pass a past session by id.

The skill reads the session transcript (`~/.claude/projects/<project>/<id>.jsonl`). The `digest.mjs` helper compresses it into a digest: user messages, errors, denials, repeats, subagent reports; it masks secrets. From the digest, the skill lays out the final working path into phases, and the verified commands and pitfalls into the phase prompts. Checks go into the stop condition, and actions with consequences (push, MR) into a separate block with explicit consent. Then the skill checks the flow with `agentgraph show` and saves it to `flows/<folder>/`. It is installed globally the same way as `/agentgraph`:

```bash
ln -s "$(pwd)/.claude/skills/session-to-flow" ~/.claude/skills/session-to-flow
```

## What it costs and how not to overpay

- Each phase is a separate Claude Code session (~33K tokens of system prompt; repeat sessions within an hour read it cheaply from the cache). A 3-phase flow over 3 iterations = 9 sessions plus condition checks.
- The cost on the run page is an estimate based on API pricing. With a subscription login, usage is counted under the subscription terms.
- Limits: the **cost limit** in the run form (`--max-budget`), `max_iterations` on the loop, `max_turns` and `max_budget_usd` on a phase or in `defaults`.
- Tools from a phase's `tools` are allowed **without confirmation**. Give `Bash`, `Edit` and `Write` only to the phases that really need them, and review them before running someone else's or a generated flow.

## Deployment and shared access

agentgraph is a **local tool**: everyone has their own copy on their own machine.

- The server listens only on `127.0.0.1`, with no authentication. Don't expose it to the network: anyone who can reach it can run agents with file and shell access. The server is protected from foreign pages in your own browser: it answers only to the addresses 127.0.0.1, localhost and [::1] (any port, so an SSH tunnel works), and accepts state-changing requests only from its own page or without an `Origin` header (curl, the skill).
- To use it on a remote machine (for example, on a powerful server next to the repository), start `npm run ui` there and forward the port over SSH:
  ```bash
  ssh -L 4747:127.0.0.1:4747 user@host
  ```
  Then open http://127.0.0.1:4747 locally.
- Share flows as files: put the `.yaml` in `flows/` (or a subfolder), and after a page refresh it appears in the UI.
- To share the tool itself: `npm run share` builds a clean archive `release/agentgraph-<version>-<date>.zip` (details below).

### Environment variables

| Variable | Purpose |
|---|---|
| `AGENTGRAPH_HOME` | where `flows/`, `runs/` and `sessions/` live; the project root by default (the `dist/web` UI build is always next to the code) |
| `AGENTGRAPH_URL` | server address for the `/agentgraph` skill; `http://127.0.0.1:4747` by default |
| `AGENTGRAPH_NOTIFY` | `off` — no system notifications, `log` — write them to the server log |
| `AGENTGRAPH_CONFIG_DIR` | Jira, project and worktree settings, the Jira token; `~/.agentgraph` by default |
| `ANTHROPIC_API_KEY` | API key authentication instead of a subscription login |
| `AGENTGRAPH_CLAUDE_EXECUTABLE` | path to the Claude Code CLI for the Agent SDK; by default the SDK finds it itself, and the desktop app points it to `app.asar.unpacked` |

## Sharing the project with your team

```bash
npm run share                       # → release/agentgraph-0.1.0-2026-10-06.zip
npm run share -- --out ~/Desktop    # put the archive in another folder
npm run share -- --no-examples      # without flows/example/
```

The archive includes the sources (`src/`, `web/`, `bin/`, `scripts/`), `package.json` and `package-lock.json`, the documentation, the `/agentgraph` and `/session-to-flow` skills and the examples from `flows/example/`. It does not include your flows (everything else in `flows/`), runs (`runs/`), `node_modules`, `dist` (`npm run ui` builds the UI on the recipient's side), `.git` and the local `.claude/` settings. The file list is taken from git with `.gitignore` applied, so uncommitted files are included too unless they are ignored.

The recipient unpacks the archive and follows the "Installation" and "Launching" sections above.

To contribute, fork the repository on GitHub and open a pull request into `main`.

## Releases and CI

The version is in `package.json`, following semver. To release, bump it on a branch and merge it into `main` with a pull request:

```bash
npm run release -- minor --dry-run   # show the changelog section without changing anything
npm run release -- minor             # major | minor | patch
```

`npm run release` takes the `feat:` and `fix:` commit titles since the previous release (the `chore(release): vX.Y.Z` commit), writes a section in `CHANGELOG.md` from them, bumps the version in `package.json` and `package-lock.json`, and commits all this as a single commit. Other commit types don't go into the changelog. The first time there is no previous release, so specify the start: `--from <commit>` (for example `--from v0.1.0`). Read the items before opening the pull request; you can fix them with `git commit --amend`.

CI is GitHub Actions (`.github/workflows/ci.yml`):

- on every pull request and on `main` — `npm ci`, `npm run typecheck`, `npm test` and the `npm run build:web` UI build on Node 24;
- on `main`, after the checks pass — if there is no GitHub release for the version in `package.json` yet, it creates the release `v<version>` (and the tag, if it doesn't exist) with this version's section from `CHANGELOG.md`. A version without a `CHANGELOG.md` section fails the job.

So that a pull request can't be merged with red checks, require the `test` check in a branch protection rule for `main` (Settings → Branches).

## How the code is organized

| File | What it does |
|---|---|
| `src/cli.ts` | entry point: the `gen`, `edit`, `run`, `show`, `spaces`, `tags`, `eval`, `ui` commands |
| `src/eval.ts` | end-to-end flow eval from the CLI (`agentgraph eval`): `tasks.yaml` → setup / runFlow / check for each run, pass by `done` and the check exit code, aggregates per (flow, task), flipped tasks with `--compare`, a table in the console, `results.json` in `runs/evals/<date>-<flow>[-vs-<flow2>]/`; the runs are ordinary ones in `runs/`, named "eval <flow> · <task> #<n>" |
| `src/run-analysis.ts` | "Analyze flow" for a finished run: facts from `run.json` (context window share per phase, feedback stagnation, pauses, iteration summaries, error texts, turns, denials, what the prompt uses), a prompt with "boundary between phases only by context" heuristics, a session (sonnet) with structured output that may read only the run folder (`runFilesGuard`), `runs/<id>/analysis.json`; the `GET|POST /api/runs/:id/analysis` route in `server.ts` |
| `src/schema.ts` | the `flow.yaml` schema (zod): phases, blocks, call blocks (`flow:`), branching (`next`), conditions, the tool list |
| `src/compose.ts` | connecting flows: the call graph check (callee exists, no cycles, depth), the called flow's task, picking the next block by `next`, the call result for the parent; the runner and server call it at their entry points |
| `src/flows.ts` | reading, saving and finding flows in `flows/`, folders; calls are checked on save, a called flow can't be deleted; a flow file written past the API (a terminal session) is checked the same way (`checkFlowText`, `plannedFlowFile`) |
| `src/flow-history.ts` | a flow's usage and versions for its screen (`GET /api/flows/:name/history`): runs in the last 30 days, the last run, versions — identical `flow.yaml` snapshots the runs started with (`flow.0.yaml` after an edit on the fly), compared by parsed content; tests `flow-history.test.ts` |
| `src/adhoc.ts` | one-off run: a draft from the request body (`spec`/`yaml`), the run's flow snapshot, which flow to continue from (the snapshot or `flows/`), "Save as flow" |
| `src/generate.ts` | the generator: task → flow (a Claude session with read-only tools: real check commands and paths come from the project); design rules shared with "Edit with AI" |
| `src/edit.ts` | "Edit with AI": the agent edits the YAML with the Edit tool |
| `src/flow-ai.ts` | HTTP responses of generation and "Edit with AI": the same JSON body as always, or with `Accept: application/x-ndjson` a stream of the session's progress (model, API retries, step, log lines, then the body with the model and duration) |
| `src/runner.ts` | execution: blocks, iterations, phases, condition checks, pause, continuation, writing `runs/`; user instructions and edits of a paused run (`RunFix`); call blocks as child runs (`runChild`) and branching by `next` |
| `src/run-fix.ts` | "fix and continue": what an edit of a running run's flow may not change and what it changed (pure functions; the runner applies the edit at a checkpoint) |
| `src/artifacts.ts` | run artifacts without the file system: phase permissions (`reads`, `writes`, substitutions), validation, the map of a large artifact, the "Run artifacts" prompt section, the guard decision, whether an artifact may be edited |
| `src/artifact-store.ts` | run artifact store: files and versions, quarantine and reconciliation with disk before a step, locking during a writing step, authorship, user edits and replies to a pause |
| `src/artifact-tools.ts` | tools for reading an artifact by section for phases and the judge (`artifact_map`, `artifact_read`, `artifact_search`, in-process MCP) |
| `src/artifact-api.ts` | artifact HTTP API: list, read, write with base and lock checks, reply to a pause |
| `src/server-guard.ts` | protects the server from requests from foreign pages: checks `Host`, `Origin` and body type |
| `src/web-static.ts` | serves the UI build (`dist/web`) at `/`: files with caching, router routes to `index.html`, refusal when escaping the folder, 308 from old `/next/…` |
| `src/api-types.ts` | API response types shared by the server and the UI (`web/` takes them via `import type`) |
| `src/model-context.ts` | "Model gets" and the space's "Context" tab: what a space and knowledge tags give the model — the exact SessionStart text (`sessionContext`, with the folder's rule for the map as memory, `mapLoadedAt`) and phase prompt tail (`phaseContextTail` + `phaseSpaceSection`) plus the parts for the readable preview; the `GET /api/model-context` and `GET /api/spaces/:slug/context` replies; tests `model-context.test.ts`, the equality with the hook — `sessions-server.test.ts` |
| `src/safe-fs.ts` | reading and writing agentgraph's settings files safely: a FIFO or a folder in place of a file doesn't hang the server (`O_NONBLOCK`, `fstat`, size limit), writes go through a hidden `O_EXCL` temp file and a rename; paths too broad for spaces and knowledge tags (`tooBroadPath`: the root, the home folder, the agentgraph config folder); tests `safe-fs.test.ts` |
| `src/spaces.ts` | spaces: the store `~/.agentgraph/spaces/<slug>/` (`CLAUDE.md` map, `STATE.md`, `docs/`, `space.json` with the working folder), slug validation, path rules (`tooBroadPath`, `checkSpaceDirs`, `checkSpaceCwd`), editing with an mtime base (409), the check of a `space.json`, map or state written past the API (`checkSpaceMetaText`, `checkSpaceTextFile`), documents (safe names, no links, tmp + rename), the read folders (`spaceReadDirs`: the space folder, its paths, artifacts of its last runs), the text for the model (`spaceContext`: one composer for the session hook, the phase section and the preview), the phase write guard on agentgraph's data folders (`phaseProtectedRoots`, `dataDirsGuard`: spaces, knowledge tags, the Teamwork teams folder, the runs folder, the space's paths outside the project; the roots are created first, a missing one is compared case-insensitively), queued state writes (`queueSpaceState`), moving task tags into spaces (`migrateTaskTags`: a backup of the tag folder, the tag's runs, `legacySummaryOf` — a summary rewritten later by an older version), old runs' space and continuation input (`reportSpace`, `inheritRun`), project = space (`docs/desk/SPEC.md`, section 2): linked repositories (`repos`: an old space gets them once from `cwd`/`dirs` via `withRepos`, a new one — the root of `cwd`), `closedAt`, the project of a folder (`gitRootOf` without git — a worktree folds to its main checkout; `projectOfPath`, `projectResolver` — one snapshot per list: an explicit space, else the linked repo's oldest space, else the deepest space folder (the space folder and `cwd`; read `dirs` only for paths outside git), open spaces before closed ones, else «Без проекта»), wrappers for the `/api/spaces` API; tests `spaces.test.ts`, `spaces.project.test.ts`, `runner.space.test.ts`, `runner.spacequeue.test.ts` |
| `src/tags.ts` | knowledge tags: the store `~/.agentgraph/tags/<slug>/` (notes, paths, attachments), slug validation, the knowledge section for the phase prompt (`knowledgeSection`, `knowledgeBlock`), block knowledge tags (`resolveKnowledge`, `knowledgeDirs`), checking chosen tags (`knowledgeTags`: a task tag — an error with a hint about spaces), removing the tag blocks of old runs from their task (`stripTagBlocks`), wrappers for the `/api/tags` API (a task tag — 404 `moved_to_space`); tests `tags.test.ts`, `runner.knowledge.test.ts` |
| `src/desk/tools.ts` | the to-do board tools `desk_put` (a thing key or a link to an MR/PR/Jira task → its key; kind, title, why, due, signal text), `desk_close`, `desk_list`: shared descriptions, argument parsing and handlers over a `DeskApi`; the in-process MCP server `desk` for flow phases (the run, project and branch are filled in, the tally goes to `RunReport.desk`), the same tools in the session's `agentgraph` server, and `agentgraph desk add/list/close`; tests `desk/tools.test.ts`, `runner.desk.test.ts` |
| `src/knowledge-tools.ts` | the `knowledge_read` tool (in-process MCP, server `knowledge`) for the phases of a block with knowledge tags: the full text of a tag (description, notes, paths, attachments) on request; in the prompt a tag is represented by a single line (`knowledgeBlock` in `tags.ts`) |
| `src/lang.ts` | language of the helper models' text (run name, iteration summaries, flow analysis, auto-space title): `taskLang` counts Latin vs Cyrillic letters in the task, and the prompt names the language explicitly; tests `lang.test.ts` |
| `src/run-title.ts` | run name: a session without tools (haiku) comes up with a short name from the task text; the runner calls it through `nameRun` in parallel with the phases and waits for it before the end; on failure — `{ error }`, and the flow stays as the title; the naming session itself (timeout, stop, answer cleanup) is `pickTitle`, shared with the terminal session name; tests `run-title.test.ts`, `runner.title.test.ts` |
| `src/run-name.ts` | a run name given by hand (`PUT /api/runs/:id/title`): cleaning like a session name (one line, up to 80 characters, empty is an error) and an atomic write of `title` into `run.json` of a finished run; tests `server.runs.test.ts` |
| `src/session-title.ts` | terminal session name: after the first message of a session started without a name, a session without tools (haiku, `pickTitle`) comes up with a short name from its text; `sessions-server.ts` decides when (`nameFrom`: only while `defaultName` from `session.json` is there and the name still equals it — renaming removes it; one attempt); tests `session-title.test.ts`, `sessions-server.name.test.ts` |
| `src/auto-space.ts` | auto-space: a session without tools (haiku) comes up with a slug and title from the task text, and a new space is created on a free slug (`createFreshSpace`, suffix `-2`…); on failure — `{ error }`, and the run goes without a space; tests `auto-space.test.ts` |
| `src/sessions.ts` | "Sessions" tab, pure logic: finding `claude`, its arguments, hooks and `permissions` in `--settings` (`launchDirs`: `--add-dir`, the write bans on the tags and Teamwork teams folders, the other spaces (with no space — the whole spaces folder), artifacts and the service files of the config folder, `ask` on the own space and the flows folder), the `agentgraph` MCP config, the environment, the context of the space and knowledge tags (full on SessionStart, the change on UserPromptSubmit/PostToolBatch) with the hook budget, hook handling, PermissionRequest for the space and tag folders, `ask` for the agentgraph tools that write (in every permission mode; a denial with the reason in `dontAsk`, and with claude older than `ASK_IN_ANY_MODE_SINCE` in `bypassPermissions`), the `PreToolUse` decision shared with `check-sdk-hooks.mts` (`preToolDecision`: write → `writeGuard`, `Bash` in `bypassPermissions` → `bashGuard`), `PostToolUse` → `afterWrite`, "resume or start anew", "awaits a reply" (`ask`: the last paragraph of the answer ends with a question — `questionOf`, no model; a permission request or an MCP form), kept in `session.json` across restarts; tests `sessions.test.ts` |
| `src/session-edit.ts` | a terminal session's edits of its space and flows (with your approval): the write hook's decision at call time (`editDecision`: deny — Teamwork teams, knowledge tags, other spaces, the config folder's service files; ask — the session's own spaces and the flows folder; `space.json`, map, state and flow files checked by the text after the write — the same checks as the API, before the question in every mode), the recheck after the write with a rollback (`recheckEdit`), the `Bash` heuristic for `bypassPermissions` (`bashDecision`: a command naming the own space or flows folder, or run from inside them, asks), the details of the `space_settings` and `flow_write` questions; `space.json` keeps `createdAt`, `history` and `migratedFrom`; tests `session-edit.test.ts`, `sessions-server.edit.test.ts` |
| `src/sessions-mcp.ts` | the session's HTTP MCP server (JSON-RPC without state): `knowledge_read` over the session's current knowledge tags, `space_write` — a document into `docs/` of its space, `space_map_write`, `space_state_write`, `space_settings` — its map, state and settings, `flow_write` — a flow in the flows folder, `session_new` — a new session next to this one; for a session opened from a Teamwork task also `team_task_update` (status, PR link, comment) and `team_doc_write` (architecture, design or `docs/` of the project), both always asked about via the PreToolUse hook; `desk_put`, `desk_close`, `desk_list` (`src/desk/tools.ts`: the session, project and branch are filled in; `desk_list` is allowed without asking); tests `sessions-mcp.test.ts` |
| `src/sessions-pty.ts` | `node-pty` loaded on demand (optional dependency; no package — no feature), the headless screen mirror and the snapshot for a new client, stopping claude with SIGHUP and a timeout |
| `src/sessions-server.ts` | session registry, the `/api/sessions*` routes, hooks and MCP by the session token, the WebSocket upgrade with `Host`/`Origin` checks, stopping on server stop; on disk — `session.json`, the turn log `turns.jsonl`, the last screen; the space's state on exit and by the button by the space each turn was made in (`turnSpaces`, `stateGroups`), releasing sessions when their space is deleted (`releaseSpace`), the write hook's state (`writeGuard`/`afterWrite` over `session-edit.ts`: the session's own spaces at call time, the snapshot before a write for the rollback) and the MCP tools of the space and flows, the `onSessionEdit` subscription (`server.ts` sends it to `/api/events` as `space` or `flows`), reading and saving sessions from before spaces (`readRecord`), the space's sessions for its page (`spaceSessions`, `looseSessions`), "Continue" (`--resume`), "Restart", "Flow from session" (`toFlow`: a new session in the agentgraph code folder with `/session-to-flow <transcript>`), deleting; a working session that started waiting (`onWaiting`: `server.ts` sends it to `/api/events` as `session` and to a system notification when no UI is open), who ended it (`endedBy`); tests `sessions-server.test.ts` (fake pty and state session, real HTTP and WebSocket) |
| `src/space-state.ts` | the space state session after a `done` run: prompt, request (read-only, haiku, with a read guard — `stateReadGuard`: the project, the run folder and the space folders, never the config folder or other secrets; the space drafts use the same guard), response parsing, cleanup of inaccessible paths (`dropRunPaths`); the same for a terminal session from its turn log (`sessionStateRequest`, `turnsDigest`); tests `space-state.test.ts` |
| `src/session-review.ts` | "Unfinished" for the "Projects" routine source (forgotten work comes to the board as "Forgotten" tasks; Home has no separate block): terminal sessions (with turns, not running, not yet reviewed at their current activity — no age limit, freshest first, up to 15 per review) reviewed by a model without tools (sonnet, a price ceiling, a timeout): per session `continue` / `wrap` / `done`, what's done, what's left and how to continue; the turns go only as `source-data`, the answer is parsed by code (`parseReview`: only the given sessions, once each, lines cleaned); the price estimate (`reviewEstimate`); the result accumulates on the server (`<configDir>/desk/session-review.json`: verdict and the activity it was made at, `reviewNow` — one review at a time, `storedReply` for Home); tests `session-review.test.ts` |
| `src/space-draft.ts` | space drafts with a model: the input (`resolveDraftInput`: a description, folders, sessions' turns, runs), the read folders and the request (Read/Grep/Glob under `stateReadGuard`, a price ceiling, a timeout), the prompt (the map like `/init`, skill documents, the state; untrusted text in `source-data`), parsing and cleaning the answer (`parseDraft`: free slug, invisible characters, `@` imports, runs-folder paths, missing paths, document names, folders), "Propose spaces" (`groupsRequest`, `parseGroups`), the price estimate (`draftEstimate`, `groupsEstimate`); nothing is written — saving goes through `/api/spaces`; tests `space-draft.test.ts`, routes in `sessions-server.test.ts` |
| `src/attachments.ts` | task attachments: type and size checks, writing to `runs/<id>/attachments/`, copying on continuation |
| `src/agent.ts` | one Claude Code session through the Agent SDK, `AskUserQuestion` questions |
| `src/template.ts` | substituting `{{variables}}` into prompts |
| `src/server.ts` | the UI HTTP server: REST API and event stream (SSE), managing running runs (a call block's child run is a live run of its own; pause, resume and stop reach it from the parent) |
| `src/things/` | Things and watchers (spec `docs/desk/SPEC.md`, section 3.1): `types.ts` — the contract (`Thing`, `ThingState`, `Watcher`, key format); `keys.ts` — the only place that builds and parses keys (`mrKey`, `jiraKey`, `branchKey`, `threadKey`, `parseKey`: host, project path and case normalised, so a GitLab assignment and a Slack link give one key); `resolve.ts` — signal → things (MR/PR URLs of GitLab and GitHub on any host, Jira URLs on the hosts from the Jira settings and `*.atlassian.net`, bare `ABC-12` keys when there is one Jira host; "own" things from the event link vs "mentioned" ones from the text) and the conversation thread from a `FieldMap`; `index.ts` — the watcher registry (`forge.ts` MR/PR, `jira.ts` Jira issue, `branch.ts` branch; `watchers()`, `trackable()`, `watch(things, signal)`: errors become `exists: false`, never exceptions). The routine engine fills `things` of new events and keeps "one flow run per thing" (`sameFiring` in `engine.ts`); tests `src/things/*.test.ts`, `src/routines/engine.things.test.ts` |
| `src/desk/` | Tasks — "My tasks" (spec `docs/desk/SPEC.md`, 3.2 and stages 3–6; plans `docs/desk/plan-3.md`…`plan-5.md`): `types.ts` — the contract (`DeskItem`, `DeskApi`, routes); `index.ts` — `openDesk(dir)` and the process-wide `desk()`/`deskStore()` merged with the providers (`list` merges stored and provided tasks under one filter; `get/put/move/close` by a provider's key go to it, a thing it doesn't have falls back to the store), `deskStorage()` — the store alone, for the reconcile; `providers/teamwork.ts` — Teamwork tasks as tasks on the fly (SPEC 4.3, not copied into `items.json`): all my open tasks incl. the backlog, the column from the task status (`todo` → plan, blocked `todo` → waiting, `in_progress` → work, `review` → waiting, `done` → done), a colleague's assignment and comments as signals and "new" until I've seen the task, move/close = the task status in the team repo, the space from `local.json → projectSpaces` or the code repo's folder; its own marks — `desk/teamwork.json`; `store.ts` — `<configDir()>/desk/items.json` (atomic write, one write queue per folder plus the `items.lock` file lock, a broken file is set aside as `items.<time>.bad.json`), the move log `log.jsonl` (trimmed on write), the last reconcile result `check.json`; `rules.ts` — the only place that decides the column (one table row of SPEC 3.2 = one test; a rule fires once per change: a known signal or an already `seen` thing state changes nothing, so a manual move holds until the thing changes; column "done" ⇔ `closed`); `reconcile.ts` — watchers (`watch` of `src/things/index.ts`) over the things of open tasks at server start and on the watchers' timer, no model and no flow, one pass per config folder (`reconcile.lock`); `tools.ts` — `desk_put`, `desk_close`, `desk_list` for terminal sessions (`sessions-mcp.ts`), flow phases (`runner.ts`) and the CLI `agentgraph desk`: the model names the thing, title, kind, why, due date and signal text, the session, run, project and branch are filled in; `routes.ts` — `/api/desk` (list with filters), `/api/desk/put`, `move`, `close`, `link` ("Link an MR or issue…" on an own task: the server builds the thing from an MR/PR/Jira URL and the task moves to that key in one write — signals, links and age kept; a thing that already has a task — 409), `/api/desk/check`, `/api/desk/week`; everything from the UI is `by: 'me'`, changes come as `{ type: 'desk' }` in `/api/events`; `check.ts` — the "N of N" check above the board, assembled from the routine sources' check results (`routines-state/checks/`, only sources used by a routine) and the watchers' `check.json`, nothing stored of its own (a result older than the app start is "not checked since the app started"); `week.ts` — the week review (6.1): tasks closed in the period (who closed them — from the move log), open tasks in Planned, Waiting on others and In progress that haven't moved for longer than N days, how many tasks arrived from which routines. A terminal session started from a card (`source.item`) moves its task to In progress and lands in `links.sessions` (`sessions-server.ts`); runs and sessions of closed tasks leave the lists (6.3, `web/src/components/shell/closedWorkFeed.ts` → `web/src/lib/closed-work.ts`). The UI is Home itself, `web/src/screens/home/desk/`: `DeskBoard.tsx` — the five columns (drag and drop, ⌥← ⌥→), `DeskCard.tsx` — kind, project, why, due date, age, who moved it, the session's question, and the card actions (session, flow, reply, link, move, close, and for a routine wait Run / Not now / Not mine), `DeskTop.tsx` — the strip above the board (agent questions, the routine waits and sessions that have no card, "catch up", "Start with this", the check, the project slice), `DeskMonth.tsx` — the "Stuck for over N days" chip with the week review (N kept in the browser) and "Save a lesson" after a closed task that had a run or a session (6.6: the line goes to the notes of the knowledge tag of that kind of work, `POST /api/tags/:slug/notes`, only on click, no model); the logic without React — `web/src/lib/desk-board.ts` (columns, due dates and ages, "Start with this" order), `desk-top.ts`, `desk-month.ts`, `desk.ts` (labels, `/?desk=<key>` links from "Code", the empty board); tests `src/desk/*.test.ts`, `src/server.desk.test.ts`, `web/src/lib/desk*.test.ts` |
| `src/routines/` | Routines, "when → do" (spec `docs/routines/SPEC.md`): `types.ts`/`kind.ts` — the contract shared with the UI and the source kinds; `schema.ts` — zod schemas of routine and source files, slugs, `problems` (no flow, no `pause_before` block, source not connected, bad cron); `store.ts` — `routines/`, `sources/`, `recipes/`, `secrets.json` (0600, never returned by the API) and `routines-state/` (seen — refreshed when an id comes again, cursors, jsonl log — trimmed on append, a log over 8 MB is read by its tail, waits, catch-up, queue, last check as the downtime boundary, `checks/<source>.json` — the `CheckResult` of the last source check, arrivals of new records, model-polling spend by day and the breakage-notice mark) in the config folder; `match.ts` — field conditions (`~ ! > <`, arrays, paths into `fields`); `check.ts` — the "check in words" session (haiku, JSON answer, rejected events as negative examples, duplicates); `command.ts` — the `command` source kind; `schedule.ts` — cron parser and slots; `engine.ts` — polling/listening, the event path (seen → things of the event → isSelf → conditions → "same firing" by the main thing → check → wait or run), limits (`per_day`, `parallel` queue, `usd`), source status from the stored check (`unchecked` before the first one, `error` survives a restart, `empty` — nothing new longer than usual), OS notices through `deps.notify` (a lasting source breakage once, waits, routine runs that did not end `done`, titled by the event), replies on start/pause/end with drafts, downtime and missed schedule → catch-up, the routine log's "why it fired" (`explain`, `recheck`) and the starting prompt of an "Ask Claude" session (`ask`: the event as data, field conditions, routine and source YAML; the UI opens the session through `POST /api/sessions` in manual mode), all effects through deps; `flow-templates.ts` — the ready-made flows of routine templates (`templates/flows/desk-*.yaml`: MR review, task to work, meeting → tasks, project sweep; copied to `flows/Мои дела/` on save when the user has no flow of that name, never overwritten; the templates themselves — `web/src/lib/routines/templates.ts`); `lock.ts` — one engine per config folder (`routines-state/engine.lock`: a second process — the app or `agentgraph ui` — does not poll or start runs until the owner is gone); `routes.ts` — `/api/routines*`; `sources/` — the service kinds, recipes and "connect in words" (sources session); `sources/projects.ts` — the built-in "Projects" snapshot source (`snapshot: true`: a record missing from the next check is forgotten and closes its routine task): dirty, unpushed and MR-less branches of the spaces' repositories (via the branch watcher), sessions that ended on a question, and "Unfinished" verdicts of the scheduled session review. `server.ts` wires the engine (`startServer({ routines: true })` in the CLI `ui` and the desktop) and starts runs with `pauseBefore` (runner option); tests `src/routines/*.test.ts`, `runner.pausebefore.test.ts`, `server.routines.test.ts` |
| `src/chat.ts` | run chat: a Claude session with run tools (status, log, pause, limit, reply, artifacts, flow) and the `ui` widget tools (table, links, action buttons, reply chips); dangerous actions run only on a confirmed click (`chatAction`); history with steps and widgets in `chat.json` |
| `src/notify.ts` | system notifications (macOS, Linux): a notice is a title, a body and the UI path to open on click |
| `src/pid.ts` | whether the runner process recorded in `run.json` is still alive: the pid exists and the process started no later than the run (a reused pid does not keep an abandoned run "running"); on Windows only the pid is checked |
| `src/desktop-link.ts` | the checkout's app shortcut without Electron and without disk writes: `Info.plist` changes, the stub that loads `dist/desktop/main.js`, where to install, and whether Electron in the checkout has moved on from the shortcut's; `scripts/desktop-install.mts` (`npm run desktop:install`) applies it; tests `desktop-link.test.ts` |
| `src/desktop/main.ts` | the desktop app's main process (Electron): data folder, port, login-shell environment, path to the Claude Code CLI outside asar, window at `http://localhost:<port>/`, notifications from the app (`notifier` of `startServer`; a click brings the window to the run or session, falling back to `notify.ts` when macOS refuses), confirming Cmd+Q while terminal sessions are live or Teamwork changes are unpushed (the text and buttons — `src/quit-dialog.ts`; "Send and close" syncs the teams first), stopping runs, sessions and the server (`stopServer`) on quit, relaunching after an auto-update |
| `src/quit-dialog.ts` | the desktop quit dialog without Electron: what to ask when terminal sessions are live and when team clones hold commits not yet in the team repo (`quitPrompt`: message, detail, buttons and what each does — quit, send first, cancel); tests `quit-dialog.test.ts` |
| `electron-builder.yml` | desktop app packaging: what goes into asar, what is unpacked (the Claude Code CLI and `node-pty`), dmg and zip targets |
| `scripts/pty-helper.mts` | before `electron-builder`: makes `node-pty`'s `spawn-helper` executable (1.1.0 ships it without the bit) |
| `src/feed.ts` | the Home events feed from `run.json`: questions, pauses, run endings |
| `src/limits.ts` | Claude subscription limits for Home (5 hours, week) through the Agent SDK |
| `src/context.ts` | the "Context" page: listing a phase session's context through the Agent SDK, reading and writing CLAUDE.md and rules from an allowlist, phase prompt by source (`promptParts`) with warnings about full tags and the number of instruction sources; a chosen space adds its folders to the listing and its section to the prompt |
| `src/integrations.ts` | "Code" API: Jira, projects, my MRs that need attention, task text from an issue/MR/branch, worktree |
| `src/teamwork.ts` | Teamwork pure logic (spec `docs/teamwork/spec.md`, no git or HTTP): parsing and writing the team repo files (`teamwork.yaml`, `project.yaml`, sprints, tasks, comments) keeping unknown fields (a broken task file yields `error`, not an exception), in-place YAML patching that keeps comments (`updateYaml`), task numbers (`nextTaskId`), fractional ordering (`rankBetween`: midpoint over `0-9A-Za-z`, shared with the UI), markdown sections by `## ` outside code fences (`splitSections`, `sectionHash`, `replaceSection`), requirements `FR-N`/`NFR-N` with `lastRequirement`, dependency check of a split proposal (`checkDependencies`: unknown refs, cycles, waves, longest chain by points), field-wise merge for conflicts (`mergeRecords`, `mergeTaskTexts`, `mergeYamlTexts`), repo URL check (`remoteProblem`) and the team slug; tests `teamwork.test.ts` |
| `src/teamwork-template.ts`, `templates/teamwork/` | the team repo template copied whole into a new team repo: `teamwork.yaml` (format 1), `README.md` with how to join, `project-template/` document skeletons of a new project (the team edits them in its repo), `flows/` from the flows session; rendering `teamwork.yaml` of a new team and the documents of a new project |
| `src/teamwork-repo.ts` | the team repo clone `~/.agentgraph/teams/<slug>/repo` with `local.json` (spec §6–7): remote check (`checkRemote`: `git ls-remote` and a shallow clone), create on an empty repo, join, disconnect (409 `unpushed`), one operation queue per team, `write()` commits every API write (author from git config), push 3 s after the last commit with `pull --rebase`, polling every 30 s with `/api/events` subscribers and every 5 minutes without, a conflicting rebase is always aborted and local commits are replayed as field merges (tasks, YAML) and text merges (`git merge-file`), unresolved goes to `local.json → conflicts`, a task number taken on both sides renames the unpushed task, two active sprints keep the earlier one, manual edits in the clone are committed before pull, no network — retries with a growing pause, a newer `format` — read-only; the clone is a non-cone sparse checkout without `.claude` in project folders (`ensureSparse`, cloned with `--no-checkout`, an older clone switches on first open via `prepareSparse`; `add -A` excludes them by pathspec; `projectClaude` lists what was left out), `addMember` adds me to the members for join and "Add me"; git only via `execFile` with `GIT_TERMINAL_PROMPT=0`; tests `teamwork-repo.test.ts` and `teamwork-repo.sync.test.ts` (real git: a bare origin and the clones alice and bob) |
| `src/teamwork-server.ts` | `TeamService` and `teamworkRoute` for `/api/teams*` (spec §12): teams (`POST /api/teams/check`, create, join, settings, sync, `local.json`), projects, documents saved whole with `base` or one section with `hash` (409 `conflict` only when that section changed; requirement numbers go to `lastRequirement`), history, tasks (one or a batch in one commit with `dependsOn → blockedBy`, PATCH with `base`, move between neighbours, delete), comments as separate files, sprints (one `planned` and one `active`; start and close by §8.6), team flows with the schema check, sync conflicts (`GET …/conflicts`, keep the team's version, take mine), a code repo from my folder (`POST …/repo-info`), a document at a commit for the history diff (`…/history/:hash`), "My tasks" for Home and the Teamwork desk provider in one request (`GET /api/teams/mine`: all my open tasks in all teams — sprints and backlog — plus "done" of the active sprint, with open blockers, the project's space and code repos; `mine({ locate: false })` skips looking up code repos among the dashboard projects), `deskTeamService()` — the shared service for the desk provider (or its own without timers outside the server), "Add me" (`POST /api/teams/:t/members/me`), `workTask` — the task a run or session is recorded under in `local.json → work`; `onChange` → the `team` event of `/api/events`, stop in `stopServer`; `unsentTeams` and `pushTeams` for the desktop quit dialog; drafts routes are handled by `teamwork-drafts.ts`, intake and worktree by `teamwork-work.ts`; tests `server.teamwork.test.ts` (real HTTP and git) and `teamwork-server.sync.test.ts` (the service on several clones of one bare repo) |
| `src/teamwork-drafts.ts` | Teamwork agent drafts (spec §9.2–9.3): `TeamDrafts` behind `…/drafts*` routes — starts a trusted team flow (`teamwork-prd`, `teamwork-architecture`, `teamwork-split`; `readTeamFlow` checks trust) as an ordinary adhoc run with the current documents in the artifacts' `initial`, the form filled by field names (people's text, the project title, code repo rows and the section heading only inside `source-data`), the main code repo as cwd (no code repo — an empty folder `workdirs/<run>/<project>` in the settings folder, deleted with the run) and the project folder plus other repos as extra dirs, the link `{ team, project, draft, section, brief, docs }` in `run.json`; reads a draft from the run's `flow.yaml` snapshot (base) and `artifacts/` (agent text, notes, proposed tasks with the core dependency report), drops edits outside the section in section mode; accepts a document through `writeDoc` with `base` or the section hash (409 `conflict`) and a split through `createTasks` in one commit (`dependsOn → blockedBy`); tests `teamwork-drafts.test.ts` (real HTTP and git, a fake runner) |
| `src/teamwork-trust.ts` | trust in team flows (spec §14): a team flow runs only if its content (sha256) is trusted on this computer — shipped in agentgraph's template, saved here on the "Process" tab, or approved with "Trust this version" (`teams/<slug>/trust.json`, outside the repo); otherwise 409 `flow_untrusted` with the YAML, the diff base and the flow's shell commands and risky tools; what a team flow may not use at all (`teamFlowProblems`: plugins, add_dirs, knowledge, calls of local flows, permission modes above `default`/`plan`, unknown tools; `teamFlowTextProblems`: invisible and control characters); a flow matching the template is pinned in `trust.json` on read and, via `pinTemplateFlows`, when a team is created, joined or first opened; a cwd inside the Teamwork folder (`teamsCwdProblem`) and a clone folder with `.claude/` at any depth as an extra dir (`teamsAddDirProblem`) — both also checked by `sessionOptions` in `agent.ts` before every session; tests `teamwork-trust.test.ts`, `server.teamwork.trust.test.ts` |
| `src/teamwork-work.ts` | a Teamwork task into work (spec §8.8, §8.9, §9.4, §9.5): `GET …/tasks/:id/intake` — what the run form prefills (input from the team flow's questionnaire via `composeInput` plus the task text with everything written by the team inside `source-data` through `wrapModelData`, default team flow, code repo with its local folder, branch `tw/<ID>-<slug>`, project folder as an extra read-only dir, project space), `POST …/tasks/:id/worktree` — a worktree on the task branch via `ensureWorktree` with branch and repo written into the task; `sessionTeamwork` — the task tools and start/end of a session opened from a task (the task is looked up by the session's record in `local.json → work`, so a renamed number is followed); tests `server.teamwork.work.test.ts` (real HTTP and git, fake runner and pty) |
| `src/teamwork-status.ts` | status automation of Teamwork tasks (spec §10): run or session started from a task — `todo → in_progress` and me as assignee; run `done` — `in_progress → review`; PR by the task branch via `gh`/`glab` polled every 2 minutes only while some task in `in_progress` or `review` has a branch — open → `review` with the PR link, merged → `done`, closed — only `pr.state`; forward only and edge-triggered on `pr.state` (a task moved back by hand is not re-moved, the same observation writes nothing); `POST /api/runs` accepts `teamFlow: { team, name }` (a one-off run from the team flow) and `teamwork` link, `POST /api/sessions` the same link; `TeamTask.work` carries live statuses of linked runs and sessions; tests `teamwork-status.test.ts` (fake service and fake `exec`, no network) |
| `src/settings.ts` | settings and the Jira token in `~/.agentgraph` |
| `src/jira.ts` | Jira Cloud REST v3 client, ADF → markdown |
| `src/git.ts` | git and `glab` through `execFile`: remote, branches, MRs, worktree |
| `src/git-head.ts` | a folder's current branch from `.git/HEAD` without running git (worktrees too): `SessionView.branch` in the session list, for search |
| `src/update.ts` | auto-update of the agentgraph checkout: `git fetch` against the upstream, why it's blocked (local changes, own commits), fast-forward, `npm install` and rebuilds by the changed files, rollback on failure, restart (`process.execve` for the CLI, `restart` from `ServerOptions`); the `/api/update` routes in `server.ts` (on with `ServerOptions.update`), the badge and dialog in `web/src/components/shell/UpdateBadge.tsx`; tests `update.test.ts` (real temporary git repositories, fake npm) |
| `src/projects.ts` | the «Подключения» repository list: auto-discovery from runs and manual editing, each with its space (`projectRef`); recent directories for the run form |
| `src/reveal.ts` | "Show in Finder" for file paths in the UI and in agent output (`POST /api/reveal`, macOS): a relative path is resolved from the run's cwd, extra dirs, run folder and its artifacts; files and folders are only selected (`open -R`), never opened or executed |
| `src/intake.ts` | task text from an issue, MR or branch |
| `src/work-links.ts` | work remembers its thing (docs/desk, stage 2): the thing of a routine event (`RunSource.thing`, first of `event.things`, else a minimal parse of forge/Jira fields), the routine worktree on the MR branch when origin is that project — the same folder as the run form's, reused and fast-forwarded to origin unless a run or live session works in it (else a new `routine/…` branch with a fixed note to the agent), `root` of a continuation chain, `SessionSource` validation for `POST /api/sessions`, `dropRoutineWorktrees(key)` — removes the routine worktrees of a closed thing (called from stage 3 via `dropThingWorktrees` in `server.ts`); tests `work-links.test.ts` (real temporary git repos), `server.work-links.test.ts` |
| `src/attention.ts` | "My MRs: need attention": reasons (CI, discussions, conflicts), collection across projects, flow selection via haiku |
| `src/reporters.ts`, `src/ui.ts` | console output |
| `web/` | the web interface: React 19 + TypeScript + Vite, built into `dist/web` (`web/vite.config.ts`: dev proxy for `/api` to the server, a ban on runtime imports from `src/`, separate chunks for React, the graph and CodeMirror) |
| `web/src/api/` | the only path to the server: `api()` and `ApiError`, the SSE stream with reconnection (`useEventStream`), React Query requests, features from `/api/config` |
| `web/src/lib/` | pure logic without React or the DOM, with `*.test.ts` tests next to it: formatting, markdown (`md.ts`), sidebar search (`search.ts`), which list the sidebar panel shows (`side-panel.ts`), the quick-session sets (`quick-session.ts`), the desk outside the board — the Home header, the empty board, the "Task · <column>" link in "Code" (`desk.ts`), the graph model and layout (`graph/`), the builder (`flow/`), the run form (`run-form.ts`), run page events and view, artifacts, and parsing phase transcripts and the live log (`run/`, `run/transcript.ts`), Home, spaces, knowledge tags, context, parsing old `/#…` addresses (`legacy-url.ts`) |
| `web/src/lib/i18n.ts`, `web/src/i18n/en/` | interface language: `t()` takes the Russian text as the key and looks up the English in the dictionaries split by area; the EN / RU switch is in the sidebar |
| `web/src/components/` | shared components: the shell and sidebar — the rail and panel, the panel state in `shell/panel.ts`, the quick-session window (`shell/QuickSession.tsx`, "+" on the rail and ⌘N) (`shell/`), the space picker (`SpacePicker`) and the "Model gets" preview (`ModelPreview`) shared by both forms and the session screen, the flow graph on `@xyflow/react` (`graph/`), the file window, the transcript and live log view in the style of Claude Code (`transcript/`), the agent question card, the confirmation dialog, the popover, markdown, renaming in place (`InlineRename`: double-click or the pencil, logic in `lib/rename.ts`) |
| `web/src/screens/` | screens: Home — the task board with the log on the right (`home/`, the board in `home/desk/`), flow and the builder with the run form (`flow/`), the run page with artifacts and chat (`run/`), "Spaces" (`spaces/`), "Knowledge" (`tags/`), "Context" (`context/`), "Sessions" with the xterm.js terminal (`sessions/`), Teamwork (`teamwork/`), "Code" — Jira issues, MRs and branches (`code/`) |
| `web/src/api/teamwork.ts` | Teamwork requests and hooks over `/api/teams*`: every React Query key is under `['teams']`, so the `team` event of `/api/events` drops them at once (`useHomeEvents`) |
| `web/src/screens/teamwork/` | Teamwork screens, loaded lazily as one chunk (`index.ts`): the team list with "Create a team" and "Join by link" (`TeamsScreen`, `JoinDialog`, `useRemoteCheck`), the team with projects, members, process (team flows in the YAML editor) and settings (`TeamScreen`), the project with its tabs and the overview (`ProjectScreen`, `OverviewTab`), the sync line and the conflicts dialog (`SyncLine`, `ConflictsDialog`), the trust dialog for a team flow changed by a teammate (`FlowTrust`: `useFlowTrust().guard` wraps every start of a team flow, shows the diff and retries after "Trust this version"), the code repo picker from my folders (`RepoPicker`), addresses and labels (`shell.ts`: `projectPath`, `taskBoardPath`, `runTeamworkLink` for a run linked to a task or draft), focus return and the task panel's Tab trap (`focus.ts`), unsaved input outside React — task panel fields, split proposal edits, the new project form (`unsaved.ts`) |
| `web/src/screens/teamwork/docs/` | the PRD, architecture, design and `docs/` tabs: reading with a table of contents and requirements with their tasks (`DocView`, `DocText`), editing one section in CodeMirror with requirement rows and 409 with both versions (`SectionEditor`, `MdEditor`), history and source (`DocDialogs`), agent drafts — the draft line, starting one and the edit-by-edit review (`DocTab`, `AgentAsk`, `DraftReview`), unsaved section edits outside React (`edits.ts`) |
| `web/src/screens/teamwork/tasks/` | the backlog with the split proposal and its dependency graph (`BacklogTab`, `SplitReview`), the board (`BoardTab`), sprints (`SprintsTab`), the task panel (`TaskPanel`), "Start work ▸" — worktree, intake and the short run or session form (`ToWork`), shared write queues per task and drag and drop (`ops.ts`) |
| `web/src/lib/teamwork/` | Teamwork logic without React: the board, filters and agent badges (`board.ts`, `columnName` — template column names translated), backlog and sprints (`backlog.ts`, `sprint.ts`), fractional order (`rank.ts`, the same algorithm as the server's `rankBetween`), documents and requirements (`docs.ts`, `doc-view.ts`: draft lines, three-way merge of accepted edits), track changes of a draft (`track.ts`), split dependencies and the graph layout (`deps.ts`), the sync line (`sync.ts`), code repo rows (`repos.ts`), the task body and "Start work" bodies (`task.ts`), "My tasks" rows (`mine.ts`), screen errors over loaded data and forms over re-read data (`form.ts`: `failView`, `rebaseForm`, `changedFields`), the focus trap step (`focus.ts`), the unsaved input store (`unsaved.ts`), the 409 `flow_untrusted` body and its diff (`flow-trust.ts`); `i18n.test.ts` checks that every `t()` key of the Teamwork screens and logic has an English entry |
| `web/src/styles/` | the "Pult" tokens (`tokens.css`, rationale in `.interface-design/system.md`) and global primitives (`base.css`); other styles are CSS Modules next to the components |
| `e2e/` | `npm run e2e`: Playwright end-to-end tests of routines — `support/` (server per test, fake `claude`, Slack, Telegram, HTTP), `specs/` (scenarios from `docs/routines/SPEC.md` §6) |
| `scripts/ensure-web.mts` | before `npm run ui`: builds `dist/web` if there is no build or `web/` and `package-lock.json` are newer |
| `.claude/skills/agentgraph/` | the `/agentgraph` skill and its helper `agentgraph.mjs` (a client for the server API) |
| `.claude/skills/session-to-flow/` | the `/session-to-flow` skill and its helper `digest.mjs` (finding session transcripts and the digest) |
| `scripts/share.sh` | `npm run share`: a zip of the project without personal flows, runs and local settings |
| `src/release.ts`, `scripts/release.mts` | `npm run release`: a new semver version and a `CHANGELOG.md` section from `feat:`/`fix:` commits |
| `.github/workflows/ci.yml` | CI: typecheck, tests and the UI build on pull requests and `main`, a GitHub release when a new version reaches `main` |
| `scripts/check-sdk-hooks.mts` | checks artifact and data-folder protection on a real Claude Code session: guard denials (including in subagents and with every `permission_mode`), what is loaded from the artifacts folder, the read tools, writes of a phase without artifacts into spaces, tags and runs (`data-dirs`, `data-modes`), the deny and ask rules of a session in a space folder (`space-session`), a run of the example with cost measurement |

Development: `npm run ui` runs the server through `tsx` straight from `src/`, so no server build is needed; restart it after editing `src/`. UI with hot reload: `npm run dev:web` while `npm run ui` is running: Vite at http://127.0.0.1:5173 proxies `/api` and SSE to the server (for a different server address: `AGENTGRAPH_API=http://127.0.0.1:4848 npm run dev:web`). Without dev mode, restart `npm run ui` after editing `web/`, and it rebuilds the UI itself. Before committing: `npm run typecheck && npm test && npm run build:web`. Routines have end-to-end tests: `npm run e2e` (Playwright, chromium; `npx playwright install chromium` once) starts a real server per test on a free port with temporary `AGENTGRAPH_CONFIG_DIR`/`AGENTGRAPH_HOME`/`HOME`, a fake `claude` (`e2e/support/fake-claude.mjs`, stream-json, answers from a scenario file) and fake Slack, Telegram and HTTP services (`e2e/support/fakes.ts`); your `~/.agentgraph` is not touched. Working rules are skills in `.claude/skills/`: `agentgraph-core` (the core in `src/`), `agentgraph-web` (the UI in `web/`: stack, where things are, how to check), `agentgraph-tests` (tests), `flow-author` (designing flows); they are loaded into a Claude Code session by their description when relevant. Independent review before a commit is the `.claude/agents/code-reviewer.md` subagent (read-only, fresh context). Comments like "port of `ui/app.js` …" refer to the pre-React UI, which is not part of this repository.

After updating the Agent SDK, and after any change to the artifact guard, the data-folder guard or session permissions, run `npx tsx scripts/check-sdk-hooks.mts` (spends up to $5, on haiku by default; `--only <scenarios>` and `--budget` narrow the check): artifact and data-folder protection relies on the pre-tool-call hook, and a new SDK version may stop calling it, for example in subagents. The report goes to the folder the script prints at the end; any `FAIL` line is a reason not to update until you've figured it out.

## Troubleshooting

| Symptom | What to do |
|---|---|
| A phase fails right away with an authentication error | check that `claude` works in the terminal (`/login`), or set `ANTHROPIC_API_KEY` |
| `EADDRINUSE` on `npm run ui` | the port is taken: another server is already running, or pass `--port` |
| `agentgraph: command not found` or an error about `dist/cli.js` | `npm run build && npm link`, or use `npm run agentgraph -- …` |
| The agent "can't" edit files or run commands | the tool it needs is not in the phase's `tools`: in headless mode everything that isn't allowed is automatically denied |
| The agent doesn't see the project rules | open "Context", pick the project directory (and the phase) and check whether CLAUDE.md is in the list |
| A run hangs with the "waiting for reply" status | the agent asked a question: answer it on Home or on the run page |
| A run failed with the `failed` status and a phase error (e.g. "computer went to sleep") | the phase session ended with an error; fix the cause and click "Continue from where it stopped" |
| A run is "interrupted" | the server was restarted while it was working; on the run page click "Continue from where it stopped" |
| System notifications don't show up (macOS) | allow notifications for Script Editor or terminal-notifier in "System Settings → Notifications"; for the app from `npm run desktop:install` — for AgentGraph |
| The app's Dock icon opens an empty Electron window | the icon of `npm run desktop:dev` was pinned; run `npm run desktop:install` and keep `AgentGraph.app` in the Dock instead |
| Jira answers 401 | wrong email or token; you need an API token from id.atlassian.com, the Jira password won't work |
| MRs don't load | `glab` is not installed or not authenticated on the project's host: `glab auth login --hostname <host>` |
| The "My MRs: need attention" section is empty or shows a project error | `glab` is not authenticated on the project's host: `glab auth login --hostname <host>`, then ↻ in the section |
| "Branch is already checked out in the main checkout" | git doesn't let you check out the same branch twice: switch the main checkout to another branch or work in it without a worktree |
| A flow doesn't appear in the list | check that the file is in `flows/` (or a subfolder one level deep) and that its `name` is unique; refresh the page |
| An artifact can't be edited: "phase X is writing" | a running step is writing this artifact right now; click "Pause" and edit it when the step finishes |
| "Save" rejected: the file changed after you opened it | a phase or another tab changed the artifact; "Reload" takes the version from disk, "Overwrite" writes your text |
| A phase with artifacts fails with "Reached maximum number of turns" | even with `tools: []` the model often opens the artifact with a tool first; remove `max_turns` 1–3 from such a phase or raise it to 5 or more |
| There is no "Sessions" item on the left | the server couldn't load `node-pty` (an optional dependency): `node -e "require('node-pty')"` in the agentgraph folder shows why; run `npm install` again (on Linux it is compiled: Python 3, make and a C++ compiler are needed) and restart `npm run ui` |
