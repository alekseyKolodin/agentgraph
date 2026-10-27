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
- **Block** — a set of phases: either a loop until a condition, or a single pass. A flow can consist of several blocks in a row. For example: "write the spec until the judge accepts it" → "split into tasks in one pass" → "implement until the tests are green".
- **Condition** — checked after all phases of the block have run. Types: **command** (a shell command returned 0, e.g. `npm test`), **judge** (a Claude session evaluates the result against a rubric) and **marker** (the phase output contains a given string). If the condition is not met, a new iteration starts.
- **Feedback** — what the condition reported: the output of the failed command or the judge's feedback. It goes into the next iteration's prompts as `{{feedback}}`.
- **Artifact** (the `artifacts` field in YAML) — a named run file: a plan, a checklist, decisions. It lives for the whole run, survives iterations and blocks, and carries over when the run is continued. A phase gets it through `reads`, `writes` or `{{artifacts.KEY}}` and writes only to its own `writes`. You can edit it in the UI between steps, and the next phase will see the edit. Unlike `{{prev}}`, which lives until the next phase, an artifact has one current copy.
- **Task** — what needs to be done. Its text goes into prompts as `{{input}}`.
- **Task tag** — a record of a feature that carries over between runs: implementation, bug fixes, review fixes, conflicts. The task is what to do in this run; the tag is which feature it is and where it stands now. A tag holds a summary (rewritten by the model after a successful run), your notes, paths and attachments; all of this is inserted at the start of the task. A run can have several tags. You pick or type a tag in the run form, or the AI creates a new tag via the "Create a task tag automatically" checkbox. Tags live in `~/.agentgraph/tags/<slug>/` and are edited on the "Tags" page.
- **Knowledge tag** — what the phases of a block need to know: frontend, backend, QA. A "when it's needed" description, notes (instructions), paths and attachments; no summary. It is attached to a block with the `knowledge: [qa]` field in flow.yaml, or to the whole run with a chip in the form. The block's phases get one line per tag at the end of the prompt (slug, title, description) and the `knowledge_read` tool, which they use to read the notes and the list of attachments when they need them; the tag's paths are always open for reading. A short tag with "every time" rules can be marked "always insert the notes into the prompt in full".
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

### Desktop app (macOS)

The same server and the same UI in a separate window, without a terminal or a browser tab. It is an Electron wrapper: the main process (`src/desktop/main.ts`) calls `startServer()` from `src/server.ts` on a free `127.0.0.1` port and opens a window at `http://localhost:<port>/` — over http, not from `file://`, otherwise `server-guard.ts` would reject the requests. Electron rather than Tauri: the Agent SDK runs only in Node, and Electron carries Node inside.

```bash
npm run desktop:dev     # build the UI (if outdated) and the server, open the window; data comes from the project root, as with npm run ui
npm run desktop:build   # build release/desktop/agentgraph-<version>-<arch>.dmg and .zip (and the .app itself in release/desktop/mac-<arch>/)
```

The Electron binary (~100 MB) is downloaded on the first `desktop:dev` or `desktop:build`, not on `npm install`: those who use only `npm run ui` and the CLI don't need it.

What you should know:

- **Where the data is.** In `desktop:dev`, the project root. The built app needs an external folder with `flows/` and `runs/`: `AGENTGRAPH_HOME` (including from `~/.zshrc` — the app picks up the login-shell environment); otherwise on first launch it asks for a folder (for example, an agentgraph checkout) and remembers it; cancelling uses an empty folder inside the app. To change it: the "File → Data folder…" menu. What it remembers (folder, port) is in `~/Library/Application Support/agentgraph/desktop.json`.
- **Access to "Documents".** If the data or project folder is in `~/Documents`, `~/Desktop` or `~/Downloads`, macOS asks for permission on first access. Until you answer, the window doesn't respond: the system dialog may end up behind the app window.
- **The port** is its own, not 4747: the app and `npm run ui` can run at the same time. But over the same `runs/`, a run started in one is shown by the other as "running in another process", and it can only be controlled from there. The `/agentgraph` skill gets the app's address through `AGENTGRAPH_URL` (the port is in `desktop.json`).
- **Closing the window** — runs continue; clicking the Dock icon opens the window again. **Quitting (Cmd+Q)** — running runs stop as with the "Stop" button (agents are shut down, the run gets the "aborted" result and can be continued), then the app closes.
- **Claude Code inside.** The Agent SDK launches the Claude Code CLI from the platform package; in the app it lives in `app.asar.unpacked` (a process can't be launched from inside an asar), and the SDK gets the path through `AGENTGRAPH_CLAUDE_EXECUTABLE`. Authentication is shared with `claude` in the terminal.
- **Packaging is electron-builder** (`electron-builder.yml`), not Electron Forge: we already have our own build (`tsc` for the server, Vite for the UI), and electron-builder simply packages the ready `dist/` with the `dependencies` from `package.json`, while unpacking the SDK binary from asar and the dmg/zip targets take a couple of config lines. Forge wants to run the build itself through its Vite/webpack plugins.
- **Limitations.** The app is not signed: on another Mac, open it via right-click → "Open" (or `xattr -dr com.apple.quarantine agentgraph.app`). The build targets only the architecture of the machine it was built on: the Claude Code binary in `node_modules` is installed for it, and there is no universal build.

## First run (costs cents)

1. In the UI, pick the **example-blocks** flow on the left (the `example` folder). The flow opens right on the **Run** tab.
2. Look at the neighboring **Builder** tab: three blocks; for each phase you can see its prompt, tools and what the phase passes on.
3. Go back to **Run** → **Run**. The task is already filled in, and the phases have no tools, so no files will be touched.
4. On the run page you can see the phases go through iterations, what the judge answered and how much it cost. The "prompt / transcript / output" buttons on each phase show exactly what went to the agent and what it returned.

Three more examples in `flows/example/`:

- **example-ask** — the agent asks the user a question (the `AskUserQuestion` tool). The question pops up in the UI, and you answer it there.
- **example-pause** — the agent pauses the run itself when it can't do without a human (`loop.pause_marker`).
- **example-parallel** — three phases run at the same time (the `group` parallel group), and a fourth combines their outputs. On the run page you can see several phases "running" at once.

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

- **Task tags** — above the task: pick a feature from the list or type a new slug (`loyalty-card`) and press Enter; there can be several tags, and the cross on a chip removes the tag. Each tag's block (summary, notes, paths, attachments) appears at the start of the task, so you don't need to describe the feature again — write only what to do now. The **Update tag summaries after the run** checkbox is on by default: after a run with the "done" status, each tag's summary is rewritten. The "Result" card shows a line "Tag summary updated" for each tag with a "summary" button, or the reason it wasn't updated. The tags themselves — title, summary, notes, paths, attachments — are edited on the **Tags** page in the sidebar. More in the reference, section ["Tags"](REFERENCE.md#tags-tasks-and-knowledge-areas).
- **Task** — what needs to be done; it goes into `{{input}}`.
- **Project directory** — where agents read and edit files, that is, your target project, **not** the agentgraph folder. You don't have to type the path: the **Choose…** button opens a folder picker in Finder (macOS only). The same button is in the new flow form, when adding a project in "Connections", next to a phase's "Additional directories" in the builder, and next to "Additional directories" in the run form (in both fields the chosen folder is appended as a new line).
- **Attachments** — screenshots, PDFs, logs and other text files for the task: "Add files…", drag and drop onto the form, or paste a screenshot right into the task field. Up to 10 files, up to 10 MB each, up to 25 MB in total; `.docx` is not accepted. Every phase gets the paths to them, but the agent opens them with the Read tool, so phases without Read won't see the attachments. The form shows which phases those are.
- **Additional directories** — one path per line: where, besides the project directory, all phases of this run may go (for example, a neighboring repository with rules). They work like a phase's `add_dirs`, but for the whole run.
- **Recent directories** — chips under the project directory and under additional directories: the latest run paths and the projects from "Connections". A click fills in the path, so you don't need to look for it again; the "×" on a chip removes the path from the list until there is a new run with it.
- **Iteration limit**, **cost limit** (USD) and **model** — optional.

### Monitor and intervene

- **Home** (the first item on the left, with the question counter; the logo leads here too) shows all running runs and agent questions from all runs at once. You can answer right from Home.
- **Limits** (in the Home header): how much of the Claude subscription's 5-hour and weekly windows has been used and when the window resets — the same numbers as in Claude Code's `/usage`. They refresh once a minute; click to refresh immediately. With an API key (no subscription) the block is not shown.
- **Events** (the panel on the right of Home): a feed of agent questions, pauses at their request and run endings — everything you get notifications about, including what you missed while the UI was closed. New items are highlighted until "Mark as read"; a click opens the run. The first 20 events are shown; "N more" opens the rest.
- **Status filter** above the run list on the left: show, for example, only failed runs or only those waiting for a reply.
- **Run name**: a few seconds after the start, the model gives the run a short name based on the task. It is the title in the list, on the run page and on Home, with the flow name in small text under it. Old runs have the flow as the title.
- **Search** in the sidebar: "Find flow…" searches by flow name, folder and description; "Find run…" by name, flow, task, tags, project folder and run id. It works together with the status filter; Esc clears the field.
- **Run chat** at the top of the run page (collapsed by default, expands by clicking the header): ask the agent what is going on and why, or ask it to pause, resume, raise the iteration limit, answer a phase's question, or continue from where it stopped. "Clear context" or `/clear` starts the conversation over.
- **Agent questions and the pause reason** are shown as formatted markdown, with the question header as a badge; for an answered question, the answer is shown under it.
- **Prompt of a running phase**: on a ⏳ card the "prompt" and "transcript" buttons appear as soon as the phase starts, and a judge check has "judge prompt". The prompt and output open as formatted markdown; "as text" in the window header shows the source. Text longer than 300,000 characters or with a line longer than 10,000 characters is shown in monospace without formatting. The transcript is re-read every time it is opened.
- **Phase model and effort**: each phase card (running and past) has a "model · effort" chip. The model is the actual one, from `system/init`: for a running phase without a set model it appears a second after the start. The effort is the configured one (phase → `defaults`): the SDK doesn't report the actual one, and without a value there is no effort chip. The data is in `run.json` (`phases[].model`, `phases[].effort`); old runs have no chip.
- **Phase context**: next to the model there is a `ctx 172k / 1M · 17%` chip — the phase's context peak, the model window and the percentage (yellow from 70%, red from 90%); for a running phase it grows as the session goes on. The data is `phases[].tokens` in `run.json` (`contextPeak`, `contextWindow`); old runs without a window show only `ctx 90k`, and without `tokens` there is no chip.
- **Run scheme** above the phase blocks: the flow graph, showing which phase and iteration the run is on now, what has been completed and how much it cost; clicking a node leads to the phase card or opens the artifact; the phase node badge shows the percentage of the context window in use.
- **Collapse iterations**: on the run page, blocks and iterations collapse when you click their header, and the "Collapse all" / "Expand all" button does it all at once; by default only the current one is open. The live log is open only for a running run.
- **Pause**: the current phase finishes, and the next one doesn't start until "Resume". This is the best time to edit artifacts: while paused, nobody writes to them.
- **Artifacts** (a panel on the run page, only for flows with `artifacts`): the collapsed row tells how many artifacts there are, which was changed last and by whom, and whether a phase is writing them right now. Expand it and click a name: a window opens with the text, a markdown preview and versions. "Edit" → "Save" (or "Save and resume" while paused); every step that starts after saving gets the edit, marked "the last edit was made by the user". While a phase that writes this artifact is running, editing is blocked with a reason. If you close the window without saving, the text stays as a draft ("unsaved"), and "Resume" asks whether to save it. Warnings (a phase wrote to the wrong place, a foreign file appeared in the folder) are shown with a ⚠ icon on the iteration and on the artifact. A markdown artifact with a checklist (`- [ ]`, `- [x]`) has an "N of M open" badge in its row and in the window header: it updates as the run goes on and after an edit is saved.
- **Reply to a pause**: if the agent asked for a decision and the flow has a decisions artifact (`decisions: true`), there is a "Reply" field under the pause card. Write a reply and click "Resume with reply" (the same button is in the header): the reply is appended to the decisions artifact together with the agent's questions, and the run continues. On Home, the "Reply on the run page" button leads to the same place. If there is no decisions artifact, the card offers "Open artifacts" or, for a flow without artifacts, to write the decision where the agent asks.
- **Stop run**: aborts the current session immediately.
- **Continue from where it stopped**: a multi-block run that hit a limit, failed or was stopped can be continued. Blocks already accepted are not run again, and artifacts move to the new run together with your edits made after the stop. A single-block flow can't be continued this way: it is run again from scratch.
- **Enable notifications** (a button on Home, shown until the browser has asked for permission): browser notifications about questions and run endings. If permission is denied, Home shows "Notifications off". If the UI is closed, the server sends a system notification.

### See what goes into the context

- Open **Context** on the left and pick a project directory: you'll see CLAUDE.md and rules with token counts, skills, subagents, MCP and the token total.
- Pick a flow and a phase to see the context of that specific phase: its model, tools, its own system prompt (`system`) and CLAUDE.md from `add_dirs`. If a directory from `add_dirs` doesn't exist, you get a warning.
- The "Phase prompt by source" section shows what the runner will assemble the phase's first message from: the prompt template, the handoff, the list of additional directories, the knowledge tag lines and the tags inserted in full, with the size and share of each. If full tags take up more than half the prompt, or instructions come from four or more places (CLAUDE.md and rule files, full tags, its own system prompt), the page warns you: such prompts contradict themselves more often than it seems.
- "Open" on a CLAUDE.md or rule opens an editor with a preview; "Save" writes the file to disk. Skills, plugins and managed policies are view-only.
- The listing is cached for a minute: after editing files outside, click "Refresh".

### Work in a Claude Code session with tags

- Open **Sessions** on the left (there's no tab if the server couldn't load the terminal, `node-pty`), click **New session**, pick a folder and tags, and click **Open terminal**. It's an ordinary Claude Code session — slash commands, permission prompts, `/resume` — in a terminal inside agentgraph; the task tags' notes and summaries and the knowledge tag lines arrive in its context at the start.
- Add or remove a tag in the tag row while the session runs: the model sees the change with its next step or your next message (until then the chip is dashed). Reading the new tag's folders doesn't ask for permission.
- Reloading the page doesn't stop the session: the screen comes back. Live sessions are listed under "Now" in the sidebar. "End" stops claude; in the desktop app Cmd+Q asks first if sessions are running.
- When claude exits, the task tags get a new summary from the session's turns (a short haiku session per tag; the checkbox in "Advanced" of the form, on by default). "Update summary" does it at any time; after Cmd+Q the session is marked and waits for the button.
- "Continue" on an ended session opens the same conversation (`claude --resume`) in the same folder with the current tags; "Restart with tags" in the `⋯` menu does it for a running session, so the folders of tags added on the fly open without asking. Sessions stay in the list after a restart of agentgraph.
- On a tag's page, "Open a session with this tag" starts the form with the tag; sessions that updated the tag's summary are listed next to its runs.
- Shift+Enter is a new line, a file dragged onto the terminal is inserted as a path.

### Run from a Jira issue, MR or branch

On Home, the **Tasks and code** section shows Jira issues, as well as open MRs and local branches of your projects. The first 5 rows of each list are shown; "N more" opens the rest. Each row has a **Run…** button: you pick a flow, and its "Run" tab opens with the task ready. The run itself doesn't start: you can check and edit the task.

- **What goes into the task**: the key and link, type and status, parent, subtasks, links and description (for an MR, the branches and the MR description). The description is wrapped in `source-data` tags with a note that it is data, not instructions for the agent. If the flow's `input` has a questionnaire with `<...>` placeholders, it goes on top, and the `Ticket: <...>` and `Branch: <...>` lines in it are filled in automatically.
- **Jira** is connected with the **Connections** button: an address like `https://company.atlassian.net`, an email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens). The token is checked before saving, stored in `~/.agentgraph/jira-token` with 600 permissions and never sent back to the browser. Presets: "My sprint", "All mine" (unresolved) and "Custom JQL"; the last JQL is remembered.
- **Projects** are picked up automatically from the project directories of past runs (only existing git repositories). In "Connections" you can add a project by hand, rename it or remove it: auto-discovery won't bring a removed project back. MRs are loaded through [`glab`](https://gitlab.com/gitlab-org/cli), which you need to install and authenticate (`glab auth login`); "Mine" takes your login from `glab`.
- **Separate git worktree**: in the run form, pick a project and a branch and click **Prepare worktree**. It goes into `~/.agentgraph/worktrees/<repo>/<branch>`, the project directory is filled in automatically, and a visible note about the worktree is appended to the end of the task. How the branch is chosen: a local branch is taken as is; if it exists only in origin, a tracking branch is created; if it exists nowhere, a new one is created from the project's base branch (`origin/HEAD` by default); without a branch you get a detached HEAD. A branch already checked out in the main checkout can't be used: switch it first. List untracked files like `local.properties` in the project settings, and they will be copied into the new worktree. agentgraph doesn't delete worktrees itself: `git worktree remove <path>`.
- **Related runs**: a run remembers which issue, MR or branch it was started from and which worktree it ran in, including after "Continue from where it stopped". Its chips with status are shown under the row on Home.

Above this section is the **My MRs: need attention** section. It lists your open MRs from the projects in "Connections" that need something from you:
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

# continue a feature by tag: tag block into the task, update the summary after done; list tags
npm run agentgraph -- run add-health-endpoint --cwd ~/code/my-repo --tag health --input "Address the review feedback"
npm run agentgraph -- tags

# compare two flow variants on a task set, each task twice
npm run agentgraph -- eval fix-tests --compare fix-tests-solo --tasks evals/tasks.yaml --runs 2 --cwd ~/code/my-repo
```

Options: `--cwd`, `--input` (replace the task), `--once` (one-off run, only with the "generate and run" form, without `-o`), `--max-iterations`, `--max-budget` (USD for the whole run), `--model`, `--tag <slug>` (a tag of any kind, can be repeated; a new one is created as a task tag), `--no-save-tag` (with `--tag`: don't update task tag summaries after the run), `--auto-tag` (without a task tag: the AI creates a new tag from the task text), `-v`. `agentgraph tags` shows each tag's kind. Full list: `npm run agentgraph -- --help`.

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
| `AGENTGRAPH_HOME` | where `flows/` and `runs/` live; the project root by default (the `dist/web` UI build is always next to the code) |
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
| `src/cli.ts` | entry point: the `gen`, `edit`, `run`, `show`, `tags`, `eval`, `ui` commands |
| `src/eval.ts` | end-to-end flow eval from the CLI (`agentgraph eval`): `tasks.yaml` → setup / runFlow / check for each run, pass by `done` and the check exit code, aggregates per (flow, task), flipped tasks with `--compare`, a table in the console, `results.json` in `runs/evals/<date>-<flow>[-vs-<flow2>]/`; the runs are ordinary ones in `runs/`, named "eval <flow> · <task> #<n>" |
| `src/run-analysis.ts` | "Analyze flow" for a finished run: facts from `run.json` (context window share per phase, feedback stagnation, turns, denials, what the prompt uses), a prompt with "boundary between phases only by context" heuristics, a session without tools (sonnet) with structured output, `runs/<id>/analysis.json`; the `GET|POST /api/runs/:id/analysis` route in `server.ts` |
| `src/schema.ts` | the `flow.yaml` schema (zod): phases, blocks, conditions, the tool list |
| `src/flows.ts` | reading, saving and finding flows in `flows/`, folders |
| `src/adhoc.ts` | one-off run: a draft from the request body (`spec`/`yaml`), the run's flow snapshot, which flow to continue from (the snapshot or `flows/`), "Save as flow" |
| `src/generate.ts` | the generator: task → flow (a Claude session without tools) |
| `src/edit.ts` | "Edit with AI": the agent edits the YAML with the Edit tool |
| `src/flow-ai.ts` | HTTP responses of generation and "Edit with AI": the same JSON body as always, or with `Accept: application/x-ndjson` a stream of the session's progress (model, API retries, step, log lines, then the body with the model and duration) |
| `src/runner.ts` | execution: blocks, iterations, phases, condition checks, pause, continuation, writing `runs/`; user instructions and edits of a paused run (`RunFix`) |
| `src/run-fix.ts` | "fix and continue": what an edit of a running run's flow may not change and what it changed (pure functions; the runner applies the edit at a checkpoint) |
| `src/artifacts.ts` | run artifacts without the file system: phase permissions (`reads`, `writes`, substitutions), validation, the map of a large artifact, the "Run artifacts" prompt section, the guard decision, whether an artifact may be edited |
| `src/artifact-store.ts` | run artifact store: files and versions, quarantine and reconciliation with disk before a step, locking during a writing step, authorship, user edits and replies to a pause |
| `src/artifact-tools.ts` | tools for reading an artifact by section for phases and the judge (`artifact_map`, `artifact_read`, `artifact_search`, in-process MCP) |
| `src/artifact-api.ts` | artifact HTTP API: list, read, write with base and lock checks, reply to a pause |
| `src/server-guard.ts` | protects the server from requests from foreign pages: checks `Host`, `Origin` and body type |
| `src/web-static.ts` | serves the UI build (`dist/web`) at `/`: files with caching, router routes to `index.html`, refusal when escaping the folder, 308 from old `/next/…` |
| `src/api-types.ts` | API response types shared by the server and the UI (`web/` takes them via `import type`) |
| `src/tags.ts` | tags of two kinds (`kind`: task, knowledge): the store `~/.agentgraph/tags/<slug>/` (summary, notes, paths, attachments), slug validation, inserting task tag blocks into the input (`withTagsInput`, `<!-- tag:… -->` markers), the knowledge tag section for the phase prompt (`knowledgeSection`), block knowledge tags (`resolveKnowledge`, `knowledgeDirs`), splitting the chosen tags by kind (`splitRunTags`), tag read folders (`tagsRunDirs`), wrappers for the `/api/tags` API; tests `tags.test.ts`, `runner.tags.test.ts`, `runner.knowledge.test.ts` |
| `src/knowledge-tools.ts` | the `knowledge_read` tool (in-process MCP, server `knowledge`) for the phases of a block with knowledge tags: the full text of a tag (description, notes, paths, attachments) on request; in the prompt a tag is represented by a single line (`knowledgeBlock` in `tags.ts`) |
| `src/lang.ts` | language of the helper models' text (run name, iteration summaries, flow analysis, auto-tag title): `taskLang` counts Latin vs Cyrillic letters in the task, and the prompt names the language explicitly; tests `lang.test.ts` |
| `src/run-title.ts` | run name: a session without tools (haiku) comes up with a short name from the task text; the runner calls it through `nameRun` in parallel with the phases and waits for it before the end; on failure — `{ error }`, and the flow stays as the title; tests `run-title.test.ts`, `runner.title.test.ts` |
| `src/auto-tag.ts` | auto-tag: a session without tools (haiku) comes up with a slug and title from the task text, and a new task tag is created on a free slug (`createFreshTag`, suffix `-2`…); on failure — `{ error }`, and the run goes without a tag; tests `auto-tag.test.ts` |
| `src/sessions.ts` | "Sessions" tab, pure logic: finding `claude`, its arguments, hooks and `permissions.deny` in `--settings`, the `agentgraph` MCP config, the environment, the tag context (full on SessionStart, the change on UserPromptSubmit/PostToolBatch) with the hook budget, hook handling, PermissionRequest for tag folders, "resume or start anew"; tests `sessions.test.ts` |
| `src/sessions-mcp.ts` | the session's HTTP MCP server (JSON-RPC without state): `knowledge_read` and `tag_read` over the session's current tags; tests `sessions-mcp.test.ts` |
| `src/sessions-pty.ts` | `node-pty` loaded on demand (optional dependency; no package — no feature), the headless screen mirror and the snapshot for a new client, stopping claude with SIGHUP and a timeout |
| `src/sessions-server.ts` | session registry, the `/api/sessions*` routes, hooks and MCP by the session token, the WebSocket upgrade with `Host`/`Origin` checks, stopping on server stop; on disk — `session.json`, the turn log `turns.jsonl`, the last screen; task tag summaries on exit and by the button, "Continue" (`--resume`), "Restart with tags", deleting; tests `sessions-server.test.ts` (fake pty and summary session, real HTTP and WebSocket) |
| `src/tag-summary.ts` | the tag summary session after a `done` run: prompt, request (read-only, haiku), response parsing, cleanup of inaccessible paths (`dropRunPaths`); the same for a terminal session from its turn log (`sessionTagSummaryRequest`, `turnsDigest`); tests `tag-summary.session.test.ts` |
| `src/attachments.ts` | task attachments: type and size checks, writing to `runs/<id>/attachments/`, copying on continuation |
| `src/agent.ts` | one Claude Code session through the Agent SDK, `AskUserQuestion` questions |
| `src/template.ts` | substituting `{{variables}}` into prompts |
| `src/server.ts` | the UI HTTP server: REST API and event stream (SSE), managing running runs |
| `src/chat.ts` | run chat: a Claude session with run tools (status, log, pause, limit, reply, artifacts, flow) and the `ui` widget tools (table, links, action buttons, reply chips); dangerous actions run only on a confirmed click (`chatAction`); history with steps and widgets in `chat.json` |
| `src/notify.ts` | system notifications (macOS, Linux) |
| `src/desktop/main.ts` | the desktop app's main process (Electron): data folder, port, login-shell environment, path to the Claude Code CLI outside asar, window at `http://localhost:<port>/`, confirming Cmd+Q while terminal sessions are live, stopping runs, sessions and the server (`stopServer`) on quit |
| `electron-builder.yml` | desktop app packaging: what goes into asar, what is unpacked (the Claude Code CLI and `node-pty`), dmg and zip targets |
| `scripts/pty-helper.mts` | before `electron-builder`: makes `node-pty`'s `spawn-helper` executable (1.1.0 ships it without the bit) |
| `src/feed.ts` | the Home events feed from `run.json`: questions, pauses, run endings |
| `src/limits.ts` | Claude subscription limits for Home (5 hours, week) through the Agent SDK |
| `src/context.ts` | the "Context" page: listing a phase session's context through the Agent SDK, reading and writing CLAUDE.md and rules from an allowlist, phase prompt by source (`promptParts`) with warnings about full tags and the number of instruction sources |
| `src/integrations.ts` | Home API: Jira, projects, my MRs that need attention, task text from an issue/MR/branch, worktree |
| `src/settings.ts` | settings and the Jira token in `~/.agentgraph` |
| `src/jira.ts` | Jira Cloud REST v3 client, ADF → markdown |
| `src/git.ts` | git and `glab` through `execFile`: remote, branches, MRs, worktree |
| `src/projects.ts` | the project list: auto-discovery from runs and manual editing; recent directories for the run form |
| `src/reveal.ts` | "Show in Finder" for file paths in the UI and in agent output (`POST /api/reveal`, macOS): a relative path is resolved from the run's cwd, extra dirs, run folder and its artifacts; files and folders are only selected (`open -R`), never opened or executed |
| `src/intake.ts` | task text from an issue, MR or branch |
| `src/attention.ts` | "My MRs: need attention": reasons (CI, discussions, conflicts), collection across projects, flow selection via haiku |
| `src/reporters.ts`, `src/ui.ts` | console output |
| `web/` | the web interface: React 19 + TypeScript + Vite, built into `dist/web` (`web/vite.config.ts`: dev proxy for `/api` to the server, a ban on runtime imports from `src/`, separate chunks for React, the graph and CodeMirror) |
| `web/src/api/` | the only path to the server: `api()` and `ApiError`, the SSE stream with reconnection (`useEventStream`), React Query requests, features from `/api/config` |
| `web/src/lib/` | pure logic without React or the DOM, with `*.test.ts` tests next to it: formatting, markdown (`md.ts`), sidebar search (`search.ts`), the graph model and layout (`graph/`), the builder (`flow/`), the run form (`run-form.ts`), run page events and view, and artifacts (`run/`), Home, tags, context, parsing old `/#…` addresses (`legacy-url.ts`) |
| `web/src/lib/i18n.ts`, `web/src/i18n/en/` | interface language: `t()` takes the Russian text as the key and looks up the English in the dictionaries split by area; the EN / RU switch is in the sidebar |
| `web/src/components/` | shared components: the shell and sidebar (`shell/`), the flow graph on `@xyflow/react` (`graph/`), the file window, the agent question card, the confirmation dialog, the popover, markdown |
| `web/src/screens/` | screens: Home (`home/`), flow and the builder with the run form (`flow/`), the run page with artifacts and chat (`run/`), "Tags" (`tags/`), "Context" (`context/`), "Sessions" with the xterm.js terminal (`sessions/`) |
| `web/src/styles/` | the "Pult" tokens (`tokens.css`, rationale in `.interface-design/system.md`) and global primitives (`base.css`); other styles are CSS Modules next to the components |
| `scripts/ensure-web.mts` | before `npm run ui`: builds `dist/web` if there is no build or `web/` and `package-lock.json` are newer |
| `.claude/skills/agentgraph/` | the `/agentgraph` skill and its helper `agentgraph.mjs` (a client for the server API) |
| `.claude/skills/session-to-flow/` | the `/session-to-flow` skill and its helper `digest.mjs` (finding session transcripts and the digest) |
| `scripts/share.sh` | `npm run share`: a zip of the project without personal flows, runs and local settings |
| `src/release.ts`, `scripts/release.mts` | `npm run release`: a new semver version and a `CHANGELOG.md` section from `feat:`/`fix:` commits |
| `.github/workflows/ci.yml` | CI: typecheck, tests and the UI build on pull requests and `main`, a GitHub release when a new version reaches `main` |
| `scripts/check-sdk-hooks.mts` | checks artifact protection on a real Claude Code session: guard denials (including in subagents and with every `permission_mode`), what is loaded from the artifacts folder, the read tools, a run of the example with cost measurement |

Development: `npm run ui` runs the server through `tsx` straight from `src/`, so no server build is needed; restart it after editing `src/`. UI with hot reload: `npm run dev:web` while `npm run ui` is running: Vite at http://127.0.0.1:5173 proxies `/api` and SSE to the server (for a different server address: `AGENTGRAPH_API=http://127.0.0.1:4848 npm run dev:web`). Without dev mode, restart `npm run ui` after editing `web/`, and it rebuilds the UI itself. Before committing: `npm run typecheck && npm test && npm run build:web`. Working rules are skills in `.claude/skills/`: `agentgraph-core` (the core in `src/`), `agentgraph-web` (the UI in `web/`: stack, where things are, how to check), `agentgraph-tests` (tests), `flow-author` (designing flows); they are loaded into a Claude Code session by their description when relevant. Independent review before a commit is the `.claude/agents/code-reviewer.md` subagent (read-only, fresh context). Comments like "port of `ui/app.js` …" refer to the pre-React UI, which is not part of this repository.

After updating the Agent SDK, run `npx tsx scripts/check-sdk-hooks.mts` (spends up to $5, on haiku by default; `--only <scenarios>` and `--budget` narrow the check): artifact protection relies on the pre-tool-call hook, and a new SDK version may stop calling it, for example in subagents. The report goes to the folder the script prints at the end; any `FAIL` line is a reason not to update until you've figured it out.

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
| System notifications don't show up (macOS) | allow notifications for Script Editor or terminal-notifier in "System Settings → Notifications" |
| Jira answers 401 | wrong email or token; you need an API token from id.atlassian.com, the Jira password won't work |
| MRs don't load | `glab` is not installed or not authenticated on the project's host: `glab auth login --hostname <host>` |
| The "My MRs: need attention" section is empty or shows a project error | `glab` is not authenticated on the project's host: `glab auth login --hostname <host>`, then ↻ in the section |
| "Branch is already checked out in the main checkout" | git doesn't let you check out the same branch twice: switch the main checkout to another branch or work in it without a worktree |
| A flow doesn't appear in the list | check that the file is in `flows/` (or a subfolder one level deep) and that its `name` is unique; refresh the page |
| An artifact can't be edited: "phase X is writing" | a running step is writing this artifact right now; click "Pause" and edit it when the step finishes |
| "Save" rejected: the file changed after you opened it | a phase or another tab changed the artifact; "Reload" takes the version from disk, "Overwrite" writes your text |
| A phase with artifacts fails with "Reached maximum number of turns" | even with `tools: []` the model often opens the artifact with a tool first; remove `max_turns` 1–3 from such a phase or raise it to 5 or more |
