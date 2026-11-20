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
| `--ink` `--ink-2` `--ink-3` `--ink-off` | text: primary, secondary, captions, disabled. `--ink-3` (#7d848e) passes AA only on `--deck` (4.9:1) and `--panel` (4.6:1), so it is for captions people don't read closely; **data** — time, $, counters, iterations, meta lines — is `--ink-2` |
| `--scrim` | the dimmed page under a drawer (the narrow-screen sidebar), the same as under a dialog |

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
- **Reading text** — `--fs-read 15`, line-height 1.65, a column up to 640px: Teamwork project documents (PRD, architecture, design) are read as documents, not as source.
- Hierarchy is carried by weight and color, not just size. Value — 500–600 and `--ink`, caption — 500 and `--ink-3`, meta — 400 and `--ink-2`. Data set in mono (time, $, `2/5`, counters) is meta, not a caption: `--ink-2`.
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
- `Run row` (Home, `.hrun`) — a grid: 8px dot, name and meta (mono `--ink-2`: flow · project · block · iteration), mini-feed (up to 16 ticks 6×12), "time · $", actions (visible on hover and on "waiting" rows). The second line is a single summary line: "Waiting for reply…", "Paused…", "Stuck: iterations a–b…" (all in `--st-wait`, the dot is amber too) or "Now phase "X" · <model summary>" (without a summary — "iteration N failed: "summary or start of feedback""). The line is truncated with an ellipsis; the full text is in the tooltip. Click or Enter on the row opens the run.

- `Summary` (`.run-summary`) — the focus of "Overview": a 12px 16px panel. The "now" line — `--fs-h3`/500/`--ink`, from live events. Below it, "where we are" (`.sum-digest`, plain `--ink` text) — the model's summary; the same line opens the "Result" card of a finished run. Further down, the last condition's verdict (✓/✕ mono) with the iteration summary, and "waiting for reply" in `--st-wait`. Facts (iterations, $, time) — mono `--fs-meta` on the right.
- **Where the summary and cell text comes from.** After each condition check (and each block without a loop), a cheap model writes in the background the iteration summary (`conditions[].summary`: what was done, why the condition is met or not, what's next) and the run summary (`report.digest.text`), see `src/run-digest.ts`. The summary arrives a few seconds after the verdict as a `digest` event and replaces the text in place. While there's no summary or it failed, the previous text is shown everywhere: the start of the judge's feedback or the command output (`excerpt(feedback)`), and for an accepted one, the reason. One rule for cells, ticks, the summary, the inspector, the Home row and the question card.
- `Iteration cell` (`.rb-cell`) — a `minmax(150px, 1fr)` grid, 6px gap, 7px 9px, `--r-sm`, `--fs-meta`. The cell header has the number and the verdict, both mono. The body is up to 3 lines of the iteration summary (without it, of the feedback) or a chain of phases `✓ · ● · ○`. States: `ok`, `fail`, `live` (`--live` frame), `wait` (`--st-wait` frame and tint), `stop`, `future` (dashed, only on the running block), `open` (expanded below, `--raised` background). There are never more than 4 cells, in one row: these are the latest **groups** of iterations. Consecutive failures with the same feedback (digits don't count) are merged into one cell "4–49 ✕ ×46".
- `History strip` (`.rb-strip`) — appears when there are more than 4 iterations. One tick per iteration up to the limit, 3–16px × 14px, colored by verdict. Future iterations are an empty outline. The expanded iteration is outlined with `--ink`. A click opens the iteration in the phase list.
- `Stuck` — 5+ identical failures in a row on the running block. Raw feedback is compared (digits don't count), not the model's summaries: a retelling of the same thing sounds different every time. The engine detects a repeat the same way and gives it the previous iteration's summary without calling the model, so a merged group has one summary. A `--st-wait` pill label in the group's cell, an amber underline under the ticks, a line in the summary. In the phase list, a long loop shows the last 5 iterations; the rest open with the "Show earlier iterations" button or a click on a tick.
- `Page tabs` (`.page-tabs`) — the screen's main navigation, full width under the header: flow (Builder · Run · YAML) and run. No dangerous action is placed next to them.
- `Menu` (`.menu` under the `⋯` `.icon-more` button) — rare and dangerous screen actions (for a flow, "Delete flow…" with confirmation). Pop-up: `--panel`, border `--line-strong`, `--r-md`, `--shadow-pop`; item — 6px 10px, hover `--hover`, dangerous — `--st-fail`. Closes on selection, a click outside, and Esc.
- `Disclosure row` (`.run-more`, `.flow-scheme`) — a caret, the name 500 `--ink-2`, on the right a quiet summary mono `--fs-meta` `--ink-3`: what's inside or what's set to a non-default value (`.set` — `--ink-2`). Open state is remembered.
- `Sticky action bar` (`.run-bar`) — the form's main action (`Run`) sticks to the bottom of the screen while the form is taller than the screen: `--deck` background, a `--line` line on top.
- `Space picker` (`SpacePicker`) — one component for the run form, the session form and the session screen. A field that shows the chosen space (title 500, slug mono `--ink-3`) or the placeholder "no space"; focus or a click opens a list right under it (`--panel`, border `--line-strong`, `--r-md`, `--shadow-pop`, up to 8 rows, then it scrolls). A row is the title (500, the slug when there's no title) and below it, mono `--fs-meta` `--ink-3`, the slug and the last activity; the freshest spaces come first. At the bottom: "+ New space «slug»" when the typed text is a new valid slug (Enter picks it, not "No space"), then "No space". Typing filters by slug, title and the beginning of the state. Keyboard: ↑ ↓ move, Enter picks, Esc closes and restores the choice, Tab leaves. With no space chosen, no row is highlighted until the first arrow (Enter just closes the list), and Enter in the closed field doesn't submit the form. The active row has a `--select` background, not an outline. ARIA: `combobox` with a `listbox` and `aria-activedescendant`. Under the field, one line: what the space gives, or a slug error in `--st-fail`.
- `Model gets` (`ModelPreview`) — one component for both forms and the session screen, what the space and knowledge tags give the model, from `GET /api/model-context` (built by the same code that sends it). Collapsed: a disclosure row "Model gets" with a mono `--fs-meta` summary — `map ≈1.2k tok. — memory · state ≈600 · 3 docs · 2 folders · 2 knowledge`. Expanded: readable text in a `--well` panel — the map (size, "memory, like a repository's CLAUDE.md", a link to the space), the state as markdown, documents with titles and sizes, read-only folders, knowledge tags with the very line the model gets (inline ones — "in full"); a caption says how it's delivered (session: memory at start plus the SessionStart hook, changes with the next step; run: the end of every phase prompt). The "as is" toggle shows the exact text in mono. A new slug shows one line: "new space — created empty".
- `Fields` (`components/form`, routines first) — one system instead of mixed 24/30/34px controls. Label on top (`--fs-meta`/500/`--ink-3`, optional "?" with a `title`), the control `--ctl-h` (32px), `--r-sm`, `--well` background, `--line-strong` border, the interface font at `--fs-body`; mono only for paths, cron, money and field keys. States: hover — a lighter border, focus — `--focus` ring, warning (won't be saved) — `--st-wait` border and the line under it in `--st-wait`, error — the same in `--st-fail`, disabled — opacity .45. At most one hint line (`--fs-meta` `--ink-3`) and only where you'd get it wrong without it (empty, shared by the source, costs money); the rest goes into "?". What won't be saved is flagged on its own row, not in a status line below.
  - `Field` — label, control, one line; hands id, label and tone to the control inside. `Input`, `TextArea` — the bare controls.
  - `Select` — instead of the native select: a 32px button with the value and a chevron, a pop-up (`--panel`, `--line-strong`, `--r-md`, `--shadow-pop`) with search (by default with more than 7 options) and a listbox; ↑ ↓ skip disabled rows, Enter picks, Esc closes and returns focus to the button, a click outside closes. The active row is `--select`.
  - `TokenInput` — several values as 22px tokens (`--raised`, `--r-xs`, ×) in a growing 32px box; Enter or a comma adds, Backspace in the empty field removes the last one.
  - `Seg` — one of 2–4 options, 32px, `aria-pressed`; more options — `Select` (the source page's poll interval is the one exception with five).
  - `Chips` — mark several, `--chip-h` (24px) pills; only for moments and marks.
  - `NumberField` — a number with a quiet prefix/suffix ("$ 0.50 не больше", "30 мин"); empty is "no limit"; an invalid value gets the error border and isn't passed on.
  - A compact button is `--ctl-h-sm` (26px). 14px between fields, 32px between sections.
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

**Rail and panel.** On the left a 48px **rail** of section icons (`<nav aria-label="Sections">`), next to it a 264px **panel**. Both are `--panel`, separated by a `--line`.
- **Rail** — 34px icon buttons, 18px line icons (stroke 1.4, like the other icons), `--ink-3`, hover `--hover`/`--ink`; the label and hint are in the tooltip and `aria-label`. Top to bottom: Home (amber question counter in its corner); "+" — the quick session; a short `--line` divider; the panel lists **Flow, Runs, Sessions**; a divider; the screens Spaces and Knowledge next to it (a space has its own knowledge tags), Teamwork, Code; at the bottom, after a gap, Context and "Hide panel". There are two kinds of "where I am": the open screen has a `--select` background (a `NavLink`), and the list shown in the panel has a 2px `--ink` bar at the rail's edge (`aria-pressed`). Both can be lit at once.
- **Lists in the panel.** A list icon shows that list in the panel; the same icon again hides the panel, as in VS Code (the panel toggle at the bottom does the same). The panel follows what you open: a flow or the draft — Flow, a run — Runs, a session — Sessions; a hidden panel stays hidden. Without the panel "Now" isn't visible, so the Runs icon gets a 7px dot (`--st-wait` waiting for you, `--live` running). The choice and the hidden state are remembered (`agentgraph.sidePanel`, `agentgraph.sidePanelHidden`).
- **Panel**, top to bottom: the brand with the update badge and EN/RU; **"Now"** — active runs and live terminal sessions, it doesn't shrink and scrolls inside itself; then one list for the whole remaining height, its title `--fs-small` 600 `--ink` (the only list, so it isn't a quiet label): **Flow** — the library with search, folders and drag-and-drop; **Runs** — the whole history with search, a status filter, grouping by project, hiding and deleting; **Sessions** — "New" (to `/sessions`) and the ended terminal sessions grouped by space.
- **Every row is a link** (`.row-link`): the name is a `Link` whose `::after` is stretched over the whole row, so a click anywhere opens it, Cmd/Ctrl-click and the middle button open it in a new window or tab, Tab reaches it and Enter opens it. What sits inside the row and does something else — "Hide" and "Delete", the space link in the meta, the rename pencil — lies above the link (`z-index: 1`); "Hide" and "Delete" show on hover and on keyboard focus inside the row (`:has(:focus-visible)` — a mouse click on the row doesn't leave them on). The keyboard focus ring (`--focus`) is drawn by the `::after`, around the whole row (the link itself has none). Hints of small marks in the row (`2/5`, `›_`) go into the row's tooltip — the link lies over them. A flow row drags by the same link (the drag ghost is the whole row); a plain click still goes through the unsaved-changes questions.
- `"Now" row` (`.lrun`) — an 8px dot (`--live` running, `--st-wait` waiting for you: question, pause, stuck), the name 500, below it an `--fs-meta` caption (`waiting for reply · phase "X"`, `paused`, `phase "X"`), on the right the iteration `2/5` mono `--ink-2`. Waiting runs come first and are amber. A live terminal session is the same row: the dot (`--live` working, `--st-wait` waiting for you, an outline while starting), its name (renamed in place: double-click or the pencil; a single click opens the session after a short pause for the double-click), below it `◇ space · status · time of the last activity` (without a space — the folder name), on the right `›_` mono `--ink-2`. The section header has "waiting N · running M" mono `--ink-2` (`--st-wait` if any are waiting). An empty section is hidden. Data comes from `/api/home`; without it, statuses from `/api/runs`.
- `Run row` (`.list li`, the run history) — two lines. The name (500–600) on one line with an ellipsis; without a model-given name, the flow. Below it one meta line, `--fs-meta` `--ink-2`, cut with an ellipsis, in order of importance: the status as a word in its signal color (history has five final statuses — a dot can't tell them apart), the time (today — "18:50", otherwise "30.10, 18:50"), `◇ space` as a link to the space, then the flow (when the run has its own name), the project (in the flat list only), `≈$`, `#knowledge` tags, "one-off". The tooltip holds the rest: the full date, iterations, the folder, who called it. A called run sits under its parent with an indent and a line on the left.
- `Status filter` — chips in **one line**: "all" first, then statuses present, by urgency, with counts. What doesn't fit scrolls sideways (the mouse wheel over the row scrolls it sideways too, until the end), and the edge where more chips hide fades out.
- `Ended session row` — inside a space group (`◇ slug`, or "no space"; the freshest group first; first 5 and "N more"; fold-all in the section header). The name renamed in place, like in "Now"; below it the meta line: "didn't start" or "folder not trusted" in `--st-fail` when that's how it ended, the folder (only in the "no space" group — there it's what tells sessions apart), the time of the last activity, turns. Opening an ended session reveals its section and group.

### Narrow screen and shell states

- **Skip link.** "Skip to content" is the first Tab stop, hidden until focused (`--raised`, `--line-strong`, the `--focus` ring); it moves focus to `main`.
- **≤ 800px** (the UI in a browser tab on half a screen; the app window is never narrower than 900px): a top bar (`--panel`, a `--line` below) with "Menu", the brand and the question counter; `main` goes first and fills the screen. The sidebar becomes a drawer from the left: `min(320px, 88vw)`, the rail and the panel always shown (there is no hiding the panel there), `--shadow-pop`, over a `--scrim`; it takes focus when it opens, the rest of the page is `inert` meanwhile; it closes on navigation (focus goes to `main`), Esc unless a dialog is open (focus returns to "Menu"), its × and a click outside, and when the window gets wider. While closed it is `visibility: hidden` — Tab doesn't walk through it.
- `main` and the sidebar have no permanent `tabindex`: with one, a click on plain text would move focus off `body`, and screen-level Esc handlers (the builder's inspector) look at `body`.
- **Loading.** Until `/api/config` answers there's nothing to show; after 300ms a single quiet "Loading…" line appears in the center (a quick answer doesn't flash it).
- **Not responding.** If `/api/config` fails: a centered card (`--panel`, `--r-md`) "AgentGraph is not responding", a line on what to do, the error mono `--st-fail`, and "Retry" — the only primary; while it checks, the card stays and the button says "Checking…".

## Builder (flow → "Edit")

- **Layout** — on top the "not saved" bar (only when there is something to save), below it the scheme on the left (`minmax(0, 1fr)`) and the right panel (`clamp(340px, 32%, 460px)`, sticky, as tall as the window from its top). On a narrow screen (≤1100px) the panel goes under the scheme. "Scheme | YAML" is a segment above the canvas; in YAML the panel is gone.
- **Canvas** — the graph; under it a quiet hint and two ghost buttons, "Add phase" and "Flow settings". Click on a node → its fields in the right panel.
- **"Not saved" bar** (`.unsaved`): `--st-ok` tinted border and background, the title (600) and one `--ink-2` line ("1 new phase and 3 changed — highlighted in green. Until you save, runs use the old version."), "Undo edit" (only after an AI edit) and `Save` — the only primary ("Apply" for a draft). After saving — a short "Saved" in its place.
- **Right panel** (`.edit-side`, `--panel`, `--line-strong`, `--r-lg`): a header with the "Assistant | Phase N" segment (× and Esc go back) and, for the assistant, a quiet model select. The assistant is a chat: the person's request is a `--raised` bubble on the right; the AI reply is rendered markdown, "What changed" rows (a tag `new` `--st-ok` / `edit` `--ink-2` / `removed` `--st-fail` 15% tint, the name 600, one phrase; a click opens the phase), warnings in a `--st-wait` 40% bordered plate, the facts mono `--ink-2`, the steps and technical log collapsed. While the AI works: a pulsing `--live` dot with "Editing the flow", a timer, "Abort", steps with ✓ `--st-ok`, the current one with the dot. At the bottom the big "What to change" field (`--well`, 4 rows) with ⌘↵ and "Send".
- **Phase / block / flow settings** in the same panel: the full phase form ("Advanced" expanded, "Ask the AI to fix this phase" at the bottom), the block (mode, condition, limit, knowledge tags, the block's phases as chips), "Flow settings" (description, default task, files, blocks with "Add block" and "Add flow call"). The selected node and block frame are outlined with `--ink`; nodes changed by the AI with `--st-ok`.

## Run form (flow → "Run")

At the top, the space: the space picker with its note line, the "Update the space's state after the run" checkbox (without a space — "Create a space automatically"), and the "Model gets" preview (run variant). Then "Project directory" with recent paths: picking a space fills in its working folder, with a "from space «X»" caption under the field until the field is edited by hand. Then "Task"; the source (MR, issue) is under the task. Everything else is in the "Advanced" disclosure (knowledge tags, attachments, additional directories, worktree, limits, model); its summary shows what's set to a non-default value (`#qa · 2 files · up to $2`). Files dropped on the form expand it. "Run" is in the sticky bar. Below the form is a single "Scheme" disclosure with the flow's composition in its summary ("3 blocks · 5 phases" or "2 phases · up to 3 iterations, …") and the graph, open by default.

## Sessions

- **Sessions page** (`/sessions`) — the new-session form on top, the table below (live first, then by the last activity). The form, top to bottom: the space picker with its note, "Folder" (filled in from the space with a "from space «X»" caption; recent folders as chips), knowledge tags, the "Model gets" preview (session variant), "Advanced" (name, model, permission mode, "Update the space's state on exit"), "Open terminal" — the only primary. A table row: the status dot, the name, the space badge as a link and knowledge badges, the folder mono `--ink-3`, the last activity, turns; an ended row has "Continue".
- **Quick session** — "+" on the rail or ⌘N (in the app; the browser keeps ⌘N): a `dialog` near the top like a command palette, `--shadow-pop`. A search field, then up to 8 sets: pinned (★), spaces by recent work, folders of past sessions, recent folders; a row is the name 500 `--ink` (the slug mono `--ink-3` after it) and the set mono `--ink-2` (folder, number of read folders and knowledge tags); the highlighted row has `--select`. Enter opens the terminal at once, ⌘Enter or "Configure…" — the full form with the set. A space without a working folder opens the form. A full path typed in the search becomes the first row.
- **Folder sets live in the space.** The form's "More folders (read-only)" fills in from the picked space; a change there is saved into the space on "Open terminal"; folders without a space save the set as a new space (its slug from the folder name, editable). The space page has the tabs **Folders** (working folder and read folders, with a count) and **Knowledge** (the space's knowledge tags: the session and run forms add them when the space is picked, removable there).
- **Unfinished on Home** — under "Running": a quiet caption heading with "Review sessions…" on the right. The click shows the price first (sessions, sonnet, `≈ $low–high · cap $x`) and "Review" — the model is only called then; the review keeps going if you leave Home. Rows like running runs: the dot (`--st-wait` for "unfinished", `--ink-3` for "last step"), the name, the verdict `--fs-meta` (`--st-wait` / `--ink-2`), "Left:" and the next message mono `--ink` (copied on "Continue"), "Continue" (`--resume`) or "Open" for a live one, × hides until the next review. Done sessions are one quiet line with "Remove".
- **Session screen** (`/sessions/<id>`) — a header: "‹ Sessions", the name (`--fs-h2`/600), the status pill, the folder mono `--ink-3`; on the right "Update state", "End" or "Continue", and `⋯` (Restart, Delete…). Below it, the context row: "Space" with the space chip (neutral like `.badge.space`, weight 500 — color is meaning, and blue means "running"; a link; dashed with a clock until the change reaches the model; × removes it; after a pick or a removal from the keyboard, focus moves to the chip link or back to the picker; without a space — the space picker, for a live and an ended session alike), a divider, "Knowledge" with tag chips and "+ tag" (also on an ended session: it takes effect with "Continue"), and on the right the state note (`--st-ok` dot when written, `--st-wait` when the app was closed before it was written). Under the row — the "Model gets" preview (session variant), collapsed. Then the terminal at full height; an ended session shows its last screen under a card with "Continue".

## Spaces

The same two columns as Knowledge: the list on the left (`minmax(260px, 320px)`) — the "All spaces N" heading, a `+ New space` button that expands a compact form above the list (slug and title in a row, the gist, paths, "Create space"; with no spaces it's open right away), search, rows (links, reachable with Tab) with the title, the beginning of the state and a meta line in `--fs-meta` `--ink-3` (map, documents, sessions and runs, "N running", date). On the right is the editor of the selected space: a header (title `--fs-h2`/600 as on the session screen, the slug mono `--ink-3`, the folder path; on the right "New session", "Session in the folder" ghost, "Delete" ghost danger, "Save" — the only primary, disabled without changes), then tabs "Map · State · Documents · Context · Settings" (the selected one is kept when you come back to the page; ← → switch them, as on the run page). "Settings" holds the title, the working folder (the folder both forms fill in when the space is picked; without one — the folder of its latest session or run) and the read-only paths; "New session" opens the session form with the space and this folder. From 1180px of container width the space's sessions and runs go into a 300px column on the right (live first, a dot as in "Now"); narrower — below the editor. The space badge everywhere (run list, run page, sessions) is `.badge.space` with a `◇` mark; a link where there's somewhere to go.

## Knowledge

The tag list is the main element, on the left (`minmax(260px, 340px)`): the "All tags N" heading and a `+ New tag` button, which expands a compact form above the list (slug and title in a row, "Create tag"; Esc or "Cancel" close it; with no tags it's open right away). On the right is the editor of the selected tag; with nothing selected, a single hint line, not an empty panel. A large field editor appears as a third column, only when a field has focus and the container is wider than 1200px.

## Pages

- **Run** — tabs "Overview · Graph · Log · Artifacts", the selected tab is remembered. Overview: the "where we are now" summary, the iteration feed, the current phase with its log tail. Graph: the "Pult" style, a node inspector on the right (only when selected), "follow current" mode.
- **Sidebar, builder, run form, spaces, knowledge** — see the sections above.
- **Routine source** (`/routines/sources/:slug`) — the header: status dot, title, kind and last check, "Check now" (disabled while there are unsaved edits: it polls the saved source) and "Delete" (disabled while routines use it). Left: one card of `150px | 1fr` rows — Name, Connection (keys show only the name and "saved", never the value; "Replace key" saves at once), Polling (segments, shared by all routines of the source), Record fields (`label ← path`), How to reply. Under the card: what changed and how many routines it affects in `--st-wait`, "Cancel" and "Save source". Right: "Latest records" (a row opens the record as the flow will get it) and "Used by" with "+ New routine with this source".
- **Home** — "Waiting for you" (questions with context), then "Running" as rows with a summary, then "MRs · need attention" (only when something is connected; with nothing connected — a single quiet "Tasks and code — nothing connected" line with "Connections"). On the right, the events feed. In `/api/home` the server returns `conds` for each run: verdicts of the running block's checks, up to 50, text up to 300 characters, `summary` — the model's iteration summary, if any; and `digest` — the run summary.
