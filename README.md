# agentgraph

[![CI](https://github.com/alekseyKolodin/agentgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/alekseyKolodin/agentgraph/actions/workflows/ci.yml)

**An orchestrator for Claude Code agents with a guaranteed result.** agentgraph describes an engineering task as a process: one or more phases, an acceptance condition and a loop. The process runs until the result passes formal acceptance: tests, an LLM judge with a rubric, or an explicit done marker. It runs locally: in the browser, in the desktop app or from the CLI.

<p align="center"><img src="docs/assets/run-overview.png" width="960" alt="Run page: the &quot;where we are now&quot; summary, the judge's verdict on the first iteration and the feed of iterations by block"></p>

## What problem it solves

A single AI agent session is an attempt, not a result. The agent can stop halfway, "close" a task without checking it, or lose context in a long conversation. The team spends time re-checking and pushing the work to completion.

agentgraph turns agent work into a controlled process:

| Business need | How it's solved |
|---|---|
| **Predictable quality** | Every iteration goes through acceptance: `npm test`, a judge with a rubric, or a marker. If the work isn't accepted, the feedback goes into the next iteration and the agent reworks it on its own. |
| **Cost control** | A budget limit per run and per phase, a turn limit and an iteration limit, a separate model for each phase (a cheap one for routine work, a strong one for design). Cost is shown for every phase. |
| **Repeatability** | The process is stored as a YAML file in git: you can review it, version it and share it with the team. A successful session can be turned into a flow with one command. |
| **Transparency** | Prompt, transcript, output and cost of every phase. A model briefly sums up where the run is now and how each iteration ended. |
| **Human in the loop** | The agent can ask a question or pause the run. You answer in the interface, and the run continues from the same place. |
| **Scale** | Several runs in parallel, each in its own project or git worktree. Questions from all runs are collected on one page. |

## How it works

```
task ──► phase (usually one) ──► acceptance condition ──► done
              ▲                          │
              └─── condition feedback ───┘   next iteration
```

- **Flow** — a sequence of blocks. A block is a chain of phases with an optional loop and acceptance condition.
- **Phase** — a separate Claude Code session with its own prompt, set of tools, model and reasoning level. The next phase gets the previous phase's output, not the whole conversation. This is both an advantage (clean context, the reviewer doesn't see the implementer's reasoning) and a cost (a retelling loses details), so keep the number of phases as small as possible: one by default, split only where the contexts really must not mix — independent review, parallel work, a context that is too large.
- **Acceptance condition** comes in four types: `command` (exit code of a shell command), `judge` (an LLM judge with a rubric that reads the project files), `marker` (the phase ends its output with a given string), `none` (a fixed number of iterations).
- **Parallel groups.** Phases of a block with a shared `group` run at the same time, for example independent reviews from different angles.
- **Artifacts** — run files with explicit access rights: which phase reads, which phase writes. You can edit them between steps.
- **Tags** mix in context at run time: a feature summary from past runs (task tag) goes into the task, and area rules (knowledge tag) reach the phase as a single line, which the phase reads in full on demand. The flow stays generic, and the context is filled in at run time.
- **Flow analysis and eval.** After a run, a model looks at the facts (each phase's peak context, stalled feedback, excess permissions) and suggests which phases to merge and which to split. The `eval` command runs a set of tasks through two variants of a flow and shows which tasks "flipped".

An example of a block that loops until the judge approves. The review is a separate phase here not because of the type of work but because of context: the reviewer only reads and doesn't see the implementer's reasoning, so it isn't swayed by the implementer's explanations.

```yaml
blocks:
  - name: implement
    loop:
      max_iterations: 3
      until:
        type: judge
        prompt: |
          Task: {{input}}
          Result: {{outputs}}
          done=true only if the requirements are met and the tests aren't broken; otherwise, put feedback in feedback.
    phases:
      - name: code
        tools: [Read, Grep, Glob, Edit, Bash]
        prompt: |
          {{input}}
          Feedback from the previous iteration: {{feedback}}
      - name: review
        tools: [Read, Grep, Glob]   # the reviewer can't edit code
        prompt: |
          Review the changes from the code phase: {{phases.code}}
```

You can generate a flow from a text description, build it in the visual builder, or edit it in words ("add a review phase with a judge").

<p align="center"><img src="docs/assets/builder-blocks.png" width="860" alt="Builder: a flow graph of three blocks — a loop until the judge approves, single-pass steps, a loop until the done marker"></p>

## Tags

A tag is context that lives outside the flow and is filled in at run time. This way the same flow works for different features and different parts of the code. There are two kinds of tags; the kind is set at creation and can't be changed later.

| | Task tag (`task`) | Knowledge tag (`knowledge`) |
|---|---|---|
| **Why** | A feature that carries over between runs: implementation → bug fixes → review fixes → conflicts. You don't have to describe it again. | What the phases need to know: frontend, backend, QA rules. |
| **What's inside** | Summary, notes, paths, attachments | A "when it's needed" description, notes (instructions), paths, attachments; no summary |
| **Where it goes** | A `<!-- tag:<slug> -->` block at the start of the task (`{{input}}`) | One line per tag at the end of the prompt of every phase in the block; the phase gets the full text with the `knowledge_read` tool when it needs it (like a skill). A tag marked "always in the prompt" is inserted in full |
| **How to attach** | The run form or `--tag <slug>`; AI can create a new tag (`--auto-tag`) | The block's `knowledge` field in flow.yaml; for the whole run, as a chip in the form or `--tag <slug>` |
| **After the run** | If the run ended with the "done" status, a short session (haiku, read-only) rewrites the summary in full: the gist, where the code is, key decisions, what's left | Doesn't change |

A knowledge tag is attached to a block by its slug:

```yaml
blocks:
  - name: implement
    knowledge: [frontend-rules]   # the line with the tag description goes to every phase of the block, the full text on demand via knowledge_read
    phases:
      - name: code
        tools: [Read, Grep, Glob, Edit, Bash]
        prompt: |
          {{input}}
```

A slug is lowercase Latin letters, digits and hyphens, up to 64 characters. If the tag doesn't exist or is a task tag, the run fails with an error before the first phase.

A knowledge tag is disclosed gradually: the phase prompt contains only "what it is and when it's needed", and the phase requests the notes, paths and attachments with the `knowledge_read` tool when the task touches on them. This way an "Android" tag doesn't bloat every iteration with build rules when the phase is editing documentation. Short rules that must always apply are marked on the **Tags** page as "always insert into the prompt in full". The tag's paths and its attachments folder are attached to phases as additional directories in either mode. A task tag also gives phases access to the artifacts of the last three runs with it: the summary refers to them. The summary in the task is wrapped as data, not instructions: a model wrote it. Notes are your own text and go in as is.

Each tag is a folder `~/.agentgraph/tags/<slug>/`:

```
summary.md     task tag summary: the current state of the feature, not a log
notes.md       your notes; the summary session doesn't touch them
attachments/   tag attachments
tag.json       kind, title, paths, last 20 runs; for a knowledge tag, the description and the "in full" mode
```

You view and edit tags (title, summary, notes, paths, attachments, and for a knowledge tag also the description and the "always insert in full" checkbox) on the **Tags** page in the interface; the list with each tag's kind is `npm run agentgraph -- tags`. The **Update tag summaries after the run** checkbox in the form (or `--no-save-tag`) turns off summary rewriting. Limits: up to 10 tags per run, up to 20 paths per tag, notes up to 4000 characters, description up to 200, summary up to 2500.

## Features

- **Visual builder.** A flow graph with blocks, parallel groups, conditions and artifacts, plus a YAML editor and editing with AI.
- **Live monitoring.** Real-time node statuses on the graph, an iteration feed with verdicts, the log tail, a phase inspector, and a "stuck" warning when the agent fails on the same thing over and over.
- **Run control.** Pause, stop, change the iteration limit on the fly, continue from where it stopped, `claude --resume` for any session, chat with the agent about the run.
- **Entry from work systems.** Run from a Jira issue, a GitLab merge request (`glab`), a GitHub pull request (`gh`) or a branch, with automatic git worktree setup.
- **Home page.** Agent questions from all runs, active runs, MRs and PRs that need attention, the events feed, Claude subscription limits.
- **Flow architecture check.** The **Analyze flow** button on a finished run's page: a model looks at the facts (each phase's peak context, stalled feedback, turns, excess permissions) and advises which phases to merge, which to split, and where to replace a judge with a command. The `eval` command runs a set of tasks through two variants of a flow several times and shows which tasks "flipped".
- **What goes into the context.** The **Context** page shows, for any phase, CLAUDE.md and rules, skills, subagents, MCP and tokens, as well as what the phase prompt is built from with each source's share, and warns you if knowledge tags bloat the prompt.
- **Claude Code integration.** The `/agentgraph` skill runs a flow from the chat and forwards the agent's questions there. The `/session-to-flow` skill turns a past session into a flow.

## Security

- The server listens only on `127.0.0.1` and rejects requests from other pages: it checks `Host`, `Origin` and the request body type, which protects against DNS rebinding and CSRF.
- Tools are granted to a phase explicitly: a phase without `Edit` and `Write` can't change project files.
- Artifact permissions (`reads`, `writes`) are checked by a hook before every tool call, including in subagents.
- Text from agents and external systems is shown in the interface as text: markdown is rendered through an escaping parser.
- Settings and integration tokens are stored in `~/.agentgraph`, outside the repository and outside run logs.

## Technologies

| Layer | Stack |
|---|---|
| Core and server | Node.js 20+, TypeScript (strict, ESM), `node:http` without frameworks, SSE for live events |
| Agents | `@anthropic-ai/claude-agent-sdk`: the same authorization and tools as `claude` (subscription or `ANTHROPIC_API_KEY`) |
| Flow schema | YAML + zod validation |
| Web interface | React 19, TypeScript, Vite, React Router, TanStack Query, React Flow (`@xyflow/react`), CodeMirror 6 |
| Desktop | Electron: the same server and the same interface in a native macOS window |
| Tests and CI | `node:test`, server and UI typecheck, UI build in CI |

The interface talks to the server only over HTTP and SSE, so the browser and desktop versions use the same code.

## Quick start

You need Node.js 20+ and the `claude` CLI installed and signed in.

```bash
npm install
```

```bash
npm run ui
```

Open http://127.0.0.1:4747, pick **example → example-blocks**, the **Run** tab, and click **Run**. The example's phases have no tools; a run costs a few cents.

Desktop app (macOS):

```bash
npm run desktop:dev
```

Command line:

```bash
# generate a flow from a description and run it right away
npm run agentgraph -- "Fix the failing tests, don't change the tests themselves" --cwd ~/code/my-repo --max-budget 3

# run an existing flow with feature and area-rules tags
npm run agentgraph -- run add-feature --cwd ~/code/my-repo --tag loyalty-card --tag frontend-rules

# compare two variants of a flow on a set of tasks, each task twice
npm run agentgraph -- eval fix-tests --compare fix-tests-solo --tasks evals/tasks.yaml --runs 2 --cwd ~/code/my-repo
```

The `tasks.yaml` format and the "do you need this phase" recipe are in the "Eval" section of the [guide](docs/GETTING_STARTED.md).

## Project structure

```
src/            core: flow schema, runner, Agent SDK sessions, API server, integrations (Jira, GitLab, GitHub, git)
src/desktop/    Electron main process
web/            React web interface
flows/example/  example flows: blocks, agent questions, pause, parallel groups, artifacts
docs/           guide and reference
scripts/        UI build, zip archive, releases, SDK hook check
.claude/        /agentgraph and /session-to-flow skills, development rules (agentgraph-core, -web, -tests, flow-author skills), code-reviewer subagent
```

The log of every run (prompts, transcripts, outputs, cost) is written to `runs/<date>-<flow>/`; tags are stored in `~/.agentgraph/tags/`.

## Development

| Command | What it does |
|---|---|
| `npm run ui` | Server and built UI at http://127.0.0.1:4747 |
| `npm run dev:web` | UI with hot reload (needs `npm run ui` running) |
| `npm run typecheck` | Type check of the server and UI |
| `npm test` | Tests |
| `npm run build:web` | UI build into `dist/web` |
| `npm run desktop:build` | Build `.app` and `.dmg` into `release/desktop/` |

The rules for working on the code live as skills in `.claude/skills/` and load into a Claude Code session on their own when an edit touches their area: `agentgraph-core` for `src/`, `agentgraph-web` for `web/`, `agentgraph-tests` for tests, `flow-author` for flows. Independent review before a commit is the `code-reviewer` subagent in `.claude/agents/`: read-only and a clean context.

**Language.** The documentation is in English and the UI has an EN / RU switch, but the code is Russian-first: comments, `.describe()` texts in the flow schema, error messages, the development skills and the `code-reviewer` subagent are in Russian.

CI runs on GitHub Actions: typecheck, tests and the UI build on every pull request; a new version merged into `main` gets a GitHub release with its section from [CHANGELOG.md](CHANGELOG.md). Details are in [GETTING_STARTED.md](docs/GETTING_STARTED.md#releases-and-ci).

## Documentation

- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) — installation, first run, day-to-day work, deployment, how the code is organized.
- [docs/REFERENCE.md](docs/REFERENCE.md) — reference: all `flow.yaml` fields, interface screens, artifacts, tags, cost, limitations.
- [flows/example/](flows/example/) — ready-made example flows.

## License

[MIT](LICENSE)
