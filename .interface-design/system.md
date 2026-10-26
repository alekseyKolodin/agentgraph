# agentgraph · design system "Pult"

The source of truth for the UI. Tokens live in `web/src/styles/tokens.css`, their meaning and rules live here; global primitives (`.btn`, `.row`, `.badge`, `dialog`) are in `web/src/styles/base.css`, everything else is CSS Modules next to the components. A new color, size or radius that bypasses the tokens means the system has started to blur. Add a token first and describe it here.

## Who and why

The user keeps several agent runs and MRs open and watches them the way they watch CI. They most often open **Home** (MRs that need attention and active runs), then the **run page** to follow the agent's work. They need to grasp three things in a second: what's running, where it's stuck, and what's waiting for their reply.

**Feel:** a dispatcher's console. Dark, dense, calm. Color lights up only when it means something.

## Signature

**The iteration loop.** A flow keeps cycling until the condition is met. This is shown the same way everywhere:
- in the run Overview — a feed of iteration cells: number, condition verdict, short summary;
- on the graph — a dashed arc from the condition diamond back, with a `↺ 2 / 5` counter and the last verdict as a caption;
- in the run list — a compact `2/5 ✕●` in a monospace font.

## Color

Dark theme only (`color-scheme: dark`). Surfaces differ only in lightness; there is a single hue.

| Token | Meaning |
|---|---|
| `--deck` | the console floor, page background |
| `--panel` | panels and cards |
| `--raised` | raised: buttons, selected segment, phase number |
| `--well` | sunken: log, code, previews |
| `--hover` / `--select` | hover / selected row (instead of an outline) |
| `--line` / `--line-strong` | quiet border / control border |
| `--ink` `--ink-2` `--ink-3` `--ink-off` | text: primary, secondary, captions, disabled |

**Signals.** Each color has one meaning and isn't used for decoration.

| Token | Meaning |
|---|---|
| `--live` (blue) | running now, selection, focus, links |
| `--st-ok` (green) | done, condition met |
| `--st-fail` (red) | failure, condition not met, dangerous action |
| `--st-wait` (amber) | **waiting for you**: agent question, pause, limit reached, warning |

**Action is neutral.** `.btn.primary` is a light `--act` button with dark text. Blue is taken by the "running" status, so the main action isn't painted in the accent color. One primary button per screen.

`--cat-1…8` are categorical colors for charts only (the context bar). Don't use them for statuses.

## Typography

- System sans, a ~1.2 scale from 14px:
  `--fs-cap 11 · --fs-meta 12 · --fs-small 13 · --fs-body 14 · --fs-h3 16 · --fs-h2 18 · --fs-h1 22`.
- Hierarchy is carried by weight and color, not just size. Value — 500–600 and `--ink`, caption — 500 and `--ink-3`, meta — 400 and `--ink-2`.
- **Section headings are quiet captions**: `--fs-meta`, 500, `--ink-3`, normal case. Letter-spaced all caps isn't used.
- **Mono** (`--font-mono`, tabular figures): cost, time, iteration counters, phase ids, paths, log. Live numbers must not jump.
- Weights: 400, 500, 600. 700 isn't used.

## Density and shape

- Spacing step is 4px. Controls — 6px 12px, cards — 10px 14px, 16–22px between sections.
- Radii: `--r-xs 4` (chips, inline code) · `--r-sm 6` (buttons, fields, nodes) · `--r-md 8` (cards, panels) · `--r-lg 12` (dialogs, block frames on the graph) · `--r-pill` (status badges).
- **Depth comes from borders only.** Shadows don't read on dark. Only pop-ups have a shadow (`--shadow-pop`): toast, flow picker.
- A one-sided stripe has no rounding.
- Lists are rows with dividers, not a card per item. Don't put a card inside a card.

## States and motion

- Keyboard focus is a single `--focus` ring (box-shadow). Selection is drawn with the `--select` background, not an outline, so it isn't confused with focus.
- Button: hover gets lighter, `:active` — `scale(.97)`, a 120ms transition for `background-color` and `border-color` only.
- The current phase on the graph pulses. With `prefers-reduced-motion`, a static ring replaces the pulse.

## Components (values)

- `Button` — 6px 12px · `--r-sm` · 500 · background `--raised`, border `--line-strong`. `.primary` — `--act` / `--on-act`. `.small` — 3px 9px, `--fs-meta`.
- `Tabs` — underlined: 18px gap, inactive `--ink-3`, active `--ink` with a 2px line below.
- Status `Badge` — pill, background `color-mix(signal 18%, transparent)`, text in the signal color.
- `Phase number` (`.pnum`) — 26×26, `--r-sm`, `--raised`, mono.
- `Question card` — background `color-mix(--st-wait 6%, --panel)`, border `--st-wait` 45%. Content order:
  - header: run (500), "phase · iteration" (`--ink-2`), "waiting N" mono `--st-wait`;
  - context on Home: "Task", "Where we are" (the model's summary, if any) and the previous iteration's summary, 96px captions on the left, a 2px line on the side;
  - agent text before the question: short text is shown in full, long text (over 400 characters) is collapsed to its beginning with "expand";
  - the question — `--fs-h3`/500;
  - options — a `minmax(200px, 1fr)` grid. None is preselected; the selected one is outlined with `--ink`. An option ending in "(Recommended)" or "(рекомендую)" gets an "agent recommends" pill;
  - your own answer — a growing `--well` field right below the options; when non-empty, it becomes the selected one;
  - sending — "Reply" or ⌘↵. The "Answer all questions" error clears on any input.
- `Run row` (Home, `.hrun`) — a grid: 8px dot, name and meta (mono `--ink-3`: flow · project · block · iteration), mini-feed (up to 16 ticks 6×12), "time · $", actions (visible on hover and on "waiting" rows). The second line is a single summary line: "Waiting for reply…", "Paused…", "Stuck: iterations a–b…" (all in `--st-wait`, the dot is amber too) or "Now phase "X" · <model summary>" (without a summary — "iteration N failed: "summary or start of feedback""). The line is truncated with an ellipsis; the full text is in the tooltip. Click or Enter on the row opens the run.

- `Summary` (`.run-summary`) — the focus of "Overview": a 12px 16px panel. The "now" line — `--fs-h3`/500/`--ink`, from live events. Below it, "where we are" (`.sum-digest`, plain `--ink` text) — the model's summary; the same line opens the "Result" card of a finished run. Further down, the last condition's verdict (✓/✕ mono) with the iteration summary, and "waiting for reply" in `--st-wait`. Facts (iterations, $, time) — mono `--fs-meta` on the right.
- **Where the summary and cell text comes from.** After each condition check (and each block without a loop), a cheap model writes in the background the iteration summary (`conditions[].summary`: what was done, why the condition is met or not, what's next) and the run summary (`report.digest.text`), see `src/run-digest.ts`. The summary arrives a few seconds after the verdict as a `digest` event and replaces the text in place. While there's no summary or it failed, the previous text is shown everywhere: the start of the judge's feedback or the command output (`excerpt(feedback)`), and for an accepted one, the reason. One rule for cells, ticks, the summary, the inspector, the Home row and the question card.
- `Iteration cell` (`.rb-cell`) — a `minmax(150px, 1fr)` grid, 6px gap, 7px 9px, `--r-sm`, `--fs-meta`. The cell header has the number and the verdict, both mono. The body is up to 3 lines of the iteration summary (without it, of the feedback) or a chain of phases `✓ · ● · ○`. States: `ok`, `fail`, `live` (`--live` frame), `wait` (`--st-wait` frame and tint), `stop`, `future` (dashed, only on the running block), `open` (expanded below, `--raised` background). There are never more than 4 cells, in one row: these are the latest **groups** of iterations. Consecutive failures with the same feedback (digits don't count) are merged into one cell "4–49 ✕ ×46".
- `History strip` (`.rb-strip`) — appears when there are more than 4 iterations. One tick per iteration up to the limit, 3–16px × 14px, colored by verdict. Future iterations are an empty outline. The expanded iteration is outlined with `--ink`. A click opens the iteration in the phase list.
- `Stuck` — 5+ identical failures in a row on the running block. Raw feedback is compared (digits don't count), not the model's summaries: a retelling of the same thing sounds different every time. The engine detects a repeat the same way and gives it the previous iteration's summary without calling the model, so a merged group has one summary. A `--st-wait` pill label in the group's cell, an amber underline under the ticks, a line in the summary. In the phase list, a long loop shows the last 5 iterations; the rest open with the "Show earlier iterations" button or a click on a tick.
- `Page tabs` (`.page-tabs`) — the screen's main navigation, full width under the header: flow (Builder · Run · YAML) and run. No dangerous action is placed next to them.
- `Menu` (`.menu` under the `⋯` `.icon-more` button) — rare and dangerous screen actions (for a flow, "Delete flow…" with confirmation). Pop-up: `--panel`, border `--line-strong`, `--r-md`, `--shadow-pop`; item — 6px 10px, hover `--hover`, dangerous — `--st-fail`. Closes on selection, a click outside, and Esc.
- `Disclosure row` (`.run-more`, `.flow-scheme`) — a caret, the name 500 `--ink-2`, on the right a quiet summary mono `--fs-meta` `--ink-3`: what's inside or what's set to a non-default value (`.set` — `--ink-2`). Open state is remembered.
- `Sticky action bar` (`.run-bar`) — the form's main action (`Run`) sticks to the bottom of the screen while the form is taller than the screen: `--deck` background, a `--line` line on top.
- `Run tabs` — Overview · Graph · Log · Artifacts. A 6px dot marker: "Log" — `--live` while the run is running; "Artifacts" — `--st-wait` when the agent is waiting for a reply there. Whatever is waiting for a human (questions, pause, error) sits above the tabs.

## Graph

One style for the builder, the "Run" tab and the run page.
- **Canvas** — `--well` with a 16px dot grid (dot `rgba(255,255,255,.07)`).
- **Node** — `--panel`, border `--line-strong`, `--r-sm`. Title 500, number and caption mono `--ink-3`. The selected node is outlined with `--ink` (not blue: blue means "running").
- **Block frame** — `--r-lg`, border `--line-strong`, almost transparent background. On the run page, future blocks are dimmed to 50%; the running block's border has a `--live` tint.
- **Edges** — `--ink-3` 1.4px. Labels are mono pills `--fs-cap`.
- **Status on the run page** — a 7px dot before the phase name: empty outline, `--st-ok`, `--live`, `--st-fail`. The running phase has a `--live` border and an 8% tint.
- **Condition diamond** — `--ink-3` outline; not met — `--st-fail`, met — `--st-ok`, being checked — `--live`.
- **Loop** — dashed. On the run page, the caption is "↺ 2 / 5" plus the last check's verdict: "· ✕ iter. 1" (loop and caption red) or "· ✓". In the builder, the caption is the limit.
- **Inspector** (`.run-inspector`, 340px on the right, sticky) appears only when a node is selected. For a phase, it shows what it got as input (the previous iteration's summary, without it the feedback; raw feedback is in the tooltip) or what it passes on, its log tail if it's running, the last iteration, all iterations and files. For a condition — the verdict and the feedback. Closes with Esc or ×. "Show in Overview" leads to the card.
- **Follow current** (on by default, remembered). The canvas keeps the running node in view, and the inspector shows it until you select a node by hand.

## Sidebar

Top to bottom: the brand with the question counter; sections (Home · Tags · Context) as a compact `.side-nav` row (the selected one has a `--select` background); **"Now"** — active runs; **Flow** — the library with search, folders and drag-and-drop; **Runs** — the whole history with search, a status filter, grouping by project, hiding and deleting.
- `"Now" row` (`.lrun`) — an 8px dot (`--live` running, `--st-wait` waiting for you: question, pause, stuck), the name 500, below it an `--fs-meta` caption (`waiting for reply · phase "X"`, `paused`, `phase "X"`), on the right the iteration `2/5` mono `--ink-3`. Waiting runs come first and are amber. The section header has "waiting N · running M" mono (`--st-wait` if any are waiting). An empty section is hidden. Data comes from `/api/home`; without it, statuses from `/api/runs`.

## Builder

- **Canvas** — the graph at full width, height up to `100vh − 250px`. The main editing path is click on a node → inspector.
- **Bar** (`.builder-bar`) above the graph sticks to the top: "Edit with AI" on one line (the field grows with the text, an "AI" mono label), a regular "Change" button, on the right "there are unsaved changes" in `--st-wait` and `Save` — the only primary, disabled without changes. The AI edit result is a panel below it; changed nodes are outlined with `--st-ok`.
- **Inspector** (`#focus-pane`, `minmax(380px, 38%)` on the right, sticky under the bar) exists only when something is selected; closes with × and Esc. Modes: "phase" (the full phase form: prompt, variable chips, tools, connectors, artifacts, "Advanced" expanded), "block" (click on a block frame or diamond: mode, condition, limit, knowledge tags, chips of the block's phases), "field" (a large editor for a field from the feed; a click on "Task" — the default task). The subheading is the block (`--ink-3`), the heading is what's selected (`--fs-h3`/500). The selected node and block frame are outlined with `--ink`.
- **Feed** "All fields as a list" under the graph is a fallback: the flow's description and task, artifacts, all blocks and phases, "Add block". Editing in the feed and in the inspector is the same: the copies stay in sync. On a narrow screen (≤1100px) there's no inspector; a click on a node leads to its card in the feed.

## Run form (flow → "Run")

At the top, "Task" and "Project directory" with recent paths; the source (MR, issue) is under the task. Everything else is in the "Advanced" disclosure (tags, attachments, additional directories, worktree, limits, model); its summary shows what's set to a non-default value (`#tag · 2 files · up to $2`). Files dropped on the form expand it. "Run" is in the sticky bar. Below the form is a single "Scheme" disclosure with the flow's composition in its summary ("3 blocks · 5 phases" or "2 phases · up to 3 iterations, …") and the graph, open by default.

## Tags

The tag list is the main element, on the left (`minmax(260px, 340px)`): the "All tags N" heading and a `+ New tag` button, which expands a compact form above the list (slug and title in a row, kind, "Create tag"; Esc or "Cancel" close it; with no tags it's open right away). On the right is the editor of the selected tag; with nothing selected, a single hint line, not an empty panel. A large field editor appears as a third column, only when a field has focus and the container is wider than 1200px.

## Pages

- **Run** — tabs "Overview · Graph · Log · Artifacts", the selected tab is remembered. Overview: the "where we are now" summary, the iteration feed, the current phase with its log tail. Graph: the "Pult" style, a node inspector on the right (only when selected), "follow current" mode.
- **Sidebar, builder, run form, tags** — see the sections above.
- **Home** — "Waiting for you" (questions with context), then "Running" as rows with a summary, then "MRs · need attention", then "Tasks and code". On the right, the events feed. In `/api/home` the server returns `conds` for each run: verdicts of the running block's checks, up to 50, text up to 300 characters, `summary` — the model's iteration summary, if any; and `digest` — the run summary.
