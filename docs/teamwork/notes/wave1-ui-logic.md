# Сессия ui-logic (волна 1): что лежит в web/src/lib/teamwork/ и что нужно соседям

Ветка `claude/tw-ui-logic-dcdf7a`, два коммита. Файлы: `web/src/lib/teamwork/{rank,board,backlog,sprint,docs,track,deps,sync}.ts`,
тесты рядом, `fixtures.ts` — фикстура `task()` для тестов. Без React и DOM, типы — `import type` из `src/api-types.ts`.
Тексты для людей — через `t()` из `web/src/lib/i18n.ts`, как в соседних модулях `lib/`; английских ключей в
`web/src/i18n/en/teamwork.ts` ещё нет (файл ui-shell): без них `t()` отдаёт русский.

## Где семантика должна совпасть с сервером (core)

- `rank.ts` `rankBetween(a?, b?)` — midpoint из rocicorp/fractional-indexing на `0-9A-Za-z`, без целой части:
  (∅,∅)→`V`, (`V`,∅)→`l`, (∅,`V`)→`G`, (`V`,`W`)→`VV`. Средний символ — `Math.round(0.5 * (digitA + digitB))`.
  `a >= b`, негодные символы и хвостовой `0` — ошибка. Сравнение рангов — по кодам символов (не localeCompare),
  равные — по id.
- `docs.ts` `splitSections(md)` — разделы по `## ` вне оград кода; текст до первого `## ` — раздел с пустым заголовком.
  `parseRequirements(md)` — строки `^- (FR|NFR)-(\d+)\.\s+(.*)$` вне оград, с заголовком раздела — строго с точкой,
  как на сервере (сверено с оркестратором). Промпт teamwork-prd (заметка flows) пишет двоеточие — его нужно поправить.
  `nextRequirementId(md | reqs, 'FR' | 'NFR', last?)` = max(в документе, last) + 1 — считается отдельно по виду.
- `deps.ts` `checkDependencies(tasks, existing)` → `TeamDependencyReport`:
  - ошибки: `неизвестная задача «X»`, `зависит от самой себя`, у каждой задачи цикла — `цикл: 1 → 2 → 6 → 1`;
  - цикл показывается **в направлении стрелок графа** (предшественник → последователь), не в направлении `dependsOn`;
    если сервер пишет наоборот, подписи разойдутся — хочу, чтобы совпало;
  - волны: без незавершённых предшественников — 1; существующие задачи не `done`, на которые ссылается предложение, —
    волна 1 (`waves[id] = 1`); `done` и неизвестные не считаются; задачи цикла и всё, что от них зависит, без волны;
  - цепочка: только предложенные задачи, очки = сумма `estimate` (нет оценки — 0); при равных очках длиннее, затем
    раньше в предложении.

## Для ui-shell и ui-tasks (волны 2–3)

- Доска: `boardColumns(tasks, sprintNumber)`, `filterColumns(cols, filter, me)`, `assigneeChips(tasks, members, me)`,
  `sprintStrip(tasks)` (`cells` по порядку готово → ревью → в работе → к работе, `label` для aria, `progress`),
  `workSignals` / `signalsText`, `workBadge(task)`, `openBlockers` + `blockedLabel`, `prLabel`, `dropMove(column, index,
  { status?, sprint? })` → `{ move: TeamTaskMove, rank }` (column — без переносимой задачи, см. `without`),
  `keyboardMove`. Фильтр: `BoardFilter { who: 'all' | 'me' | 'none' | { email }, types }`, `parseFilter(raw)` для
  localStorage.
- Бэклог/спринты: `backlogTasks`, `plannedSprint`, `nextSprintTasks`, `tasksAndPoints`, `orderWarnings` +
  `orderWarningText`, `rankForNew`; `startWarnings(sprintTasks, all)` + текст, `startPatches`, `closeSummary`,
  `closeResult(tasks, choices)`, `closePatches`, `sprintResultText`.
- Разбивка: `checkDependencies`, `depsSummary`, `chainText`, `layoutGraph(tasks, existing, report)` → узлы (x, y, col,
  row), рёбра (`path` для `<path d>`, стрелка заканчивается за 2px до узла), колонки (`label`, `note: 'сейчас'`),
  `width/height`; `focusGraph(graph, key)` → состояние узлов `selected | before | after | dim` и подсветка рёбер;
  `chainEdges` для «Показать»; панель: `waitsOn`, `unlocks`, `startNote(key, …, members)`; `addDependency` /
  `removeDependency(tasks, existing, key, dep)` → `{ tasks, report }`. Размеры — `GRAPH_DEFAULTS` из Split.dc.html.
  `existing` — `{ id, status, title?, assignee?, sprint?, estimate? }` из задач проекта.
- Синхронизация: `syncLine(sync, { conflicts?, format?, now? })` → `{ text, tone: ok|live|wait|off, action? }`,
  `unsavedLine(sections)`.

## Для ui-docs и drafts (волны 2–3)

- Чтение: `splitSections`, `tocOf(md)`, `coverage(reqs, tasks)` (`text`, `missingText`, `byReq`), `docHeadLine(doc,
  members)`, `findRefs` / `splitRefs(text, prefix)` для ссылок на задачи, требования и документы, `currentSection`.
- Правка раздела требований: `parseRequirementRows(section.body)` → `{ intro, rows, outro }`,
  `serializeRequirementRows`, `addRequirementRow(parts, kind, allReqs, last?)`, `removeRequirementRow`,
  `moveRequirementRow`, `sectionCommitMessage(name, heading)`, `changesText`.
- Черновик агента: `trackChanges(old, next, notes, decisions, doc?)` → `{ edits, sections (rows, unresolved), progress }`;
  `edit.words` — пословный дифф содержимого без маркера списка и номера (`oldContent` / `nextContent`), `edit.old` /
  `edit.next` — блок как в файле; `applyDecisions(old, next, decisions)` → markdown для «Записать принятые»;
  `acceptRest`, `stepEdit`, `nextUnresolved`, `markConflicts(edits, currentMd)` (старый текст уже не совпадает — принимать
  только руками), `lineDiff` для «Исходника», `foldText`, `editLabel`, `draftTitle`. Записи notes.json с полем `doc`
  (teamwork-architecture) отбираются аргументом `doc`.
- `TeamProposedTask.key` вида `t1` показывается как `1` через `keyLabel`.

## Не проверено

- Совпадение с настоящим `src/teamwork.ts`: на момент работы его в worktree core ещё не было, всё по спеке и брифу.
- Поведение на реальных документах агента: блоки разбираются по упрощённым правилам markdown (вложенные списки идут
  продолжением пункта; таблица, линия — один блок «other»).
- В браузере ничего не проверялось — экранов ещё нет.
