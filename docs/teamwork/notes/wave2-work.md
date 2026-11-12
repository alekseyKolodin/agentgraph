# Отчёт сессии work (волна 2): задача в работу и автоматика статусов

Ветка `claude/tw-work-b90e85` от `teamwork` (`a63712d`), не слито и не отправлено. `npm run typecheck && npm test` зелёные.

Файлы: `src/teamwork-status.ts` + `src/teamwork-status.test.ts` (новые), `src/teamwork-work.ts` (новый — маршруты intake и
worktree, инструменты сессии), `src/server.teamwork.work.test.ts` (новый, настоящий HTTP и git, поддельные раннер и pty),
правки в `src/server.ts`, `src/sessions-server.ts`, `src/sessions.ts`, `src/sessions-mcp.ts` (+ тесты), `src/api-types.ts`
(только дополнения), `docs/GETTING_STARTED.md` (три строки таблицы модулей).

## Маршруты

| Маршрут | Запрос | Ответ |
|---|---|---|
| `GET /api/teams/:t/projects/:p/tasks/:id/intake?repo=<ключ>&flow=<flow команды>` | — | `TeamTaskIntake`; 404 — нет команды, проекта, задачи или заданного `?flow=`; 400 — чужой `?repo=`, битый файл задачи, невалидный заданный flow |
| `POST /api/teams/:t/projects/:p/tasks/:id/worktree` | `{ repo?: string }` | 201 `TeamTaskWorktree`; 400 — несколько репо без выбора, у проекта нет репо, ошибка git (ветка занята в другом worktree, плохое имя); 409 `no_local` — репо кода не найдено на этом компьютере |
| `POST /api/runs` | + `teamFlow?: { team, name }` (вместо `flow`/`spec`/`yaml`), `teamwork?: RunTeamworkLink` | как раньше `RunStarted`; 404 — нет flow команды или задачи; 400 — невалидный flow, `teamFlow` вместе с `flow`, кривая связь |
| `POST /api/sessions` | + `teamwork?: RunTeamworkLink` | `SessionView` с `teamwork`; 404/400 как у запуска; 501 — Teamwork недоступен |

`TeamTaskIntake` (src/api-types.ts): `input` — анкета flow (`Задача:`, `Ветка:` заполнены через `composeInput`) и под ней
текст задачи; `context` — текст задачи без анкеты (для flow не из команды форма собирает вход сама); `source: { type:
'teamwork', key: <ID>, title, project?: <локальная папка репо> }`; `teamwork: { team, project, task }`; `teamFlow?: { team,
name }` — `?flow=`, иначе `defaultFlow` команды, иначе `teamwork-task` (нет в репо — поля нет); `teamFlows: string[]`;
`branch` — из файла задачи или `tw/<ID>-<slug заголовка>` (кириллица транслитом, до 40 знаков); `repo?: TeamRepoRef`
(`?repo=`, иначе `repo` задачи, иначе единственное репо проекта; `local` — папка у меня); `repos`; `cwd?` — локальная папка
репо (до worktree); `addDirs: [папка проекта в клоне]`; `space?` — пространство проекта из `local.json`; `work`.

`TeamTaskWorktree` = `WorktreeResult & { branch, repo: TeamRepoRef, task: TeamTask }` — worktree под `worktreesDir()` из
настроек (`<configDir>/worktrees/<репо>/<slug ветки>`), ветка от `defaultBranch` репо проекта (иначе `base` проекта
дашборда, иначе origin/HEAD); `branch` и `repo` записываются в задачу одним коммитом, если менялись — так опрос PR
находит ветку у всех участников.

Текст задачи (spec §9.4): снаружи обёртки — только то, что собрал сервер: `Задача Teamwork PAY-12 · проект <slug> ·
команда <slug>`, пометка и строка документов путями (`<папка проекта>/prd.md, architecture.md, design.md, docs/…`).
Всё из файла задачи и названий команды — в `source-data` через `wrapModelData`: `Проект: … · команда: …`, `Заголовок`,
`Тип · оценка · заблокирована: PAY-11 (К работе)` (статус блокирующих словами колонок), `Требования ТЗ: FR-1`, тело
задачи с заголовками `## X` → `X:`. Отличие от примера спеки: названия проекта и команды тоже внутри `source-data` —
это текст людей.

### Другие дополнения `src/api-types.ts`

- `RunSource.type` получил `'teamwork'` (key — номер задачи).
- `TeamTaskPatch.pr?: { url, state? } | null` — PATCH задачи принимает ссылку на PR (пишут автоматика и `team_task_update`).
- `SessionView.teamwork?: RunTeamworkLink`.
- `TeamTaskIntake`, `TeamTaskWorktree`.

## Автоматика статусов (`src/teamwork-status.ts`, spec §10)

Чистые функции `startPatch`, `runEndPatch`, `prPatch`, `watched`, `prNumber`, `fetchPrState`, `parseTeamworkLink`; класс
`TeamworkStatus` (`check`, `started`, `ended`, `poll`, `start`, `stop`); адаптер `statusService(teamService())`; синглтон
`teamworkStatus(deps)` / `stopTeamworkStatus()`.

- Старт запуска или сессии из задачи (`started`): запись в `local.json → work` со статусом, `todo → in_progress`,
  исполнитель — я, если пусто. Зовётся из `startRun` в `server.ts` (и для продолжения, и для повтора запуска) и из
  `SessionManager.create`. Не бросает: запуск уже идёт, сбой — в лог.
- Конец запуска (`ended`, из `broadcast` события `end` в `launchRun`, не у дочерних запусков блоков-вызовов): статус в
  `work`; `done` — `in_progress → review`; упал, остановлен — без перехода. Конец очень короткого запуска ждёт запись
  старта той же задачи. Конец сессии — только статус `ended` в `work`.
- Опрос PR раз в 2 минуты (`PR_POLL_MS`), только пока есть задачи `in_progress` или `review` с веткой и не смёрженным PR;
  один `listMergeRequests` на remote за опрос; задача без `repo` в проекте с несколькими репо пропускается; ссылка репо без
  хоста (путь, `file://`) — тоже. Открытый PR по ветке — `pr: { url, state: 'open' }` и `review` из `todo`/`in_progress`;
  PR, бывший открытым и пропавший из списка, — точный запрос по номеру (`gh api repos/<path>/pulls/<n>`:
  `merged_at` → merged; `glab api projects/<id>/merge_requests/<iid>`: `state`) — `merged` → `done` из любого статуса,
  `closed` → только `pr.state`. Повторное наблюдение того же PR в том же состоянии ничего не пишет: ручной возврат назад
  не отменяется. Ошибки gh/glab (не установлен, сеть) — в итог опроса и один раз в лог на remote.
- Таймер снимается в `stopServer`; с `teamwork.timers: false` (тесты) опроса по таймеру нет.

## Сессии из задачи (spec §8.9, §9.5)

`SessionRecord.teamwork`, `SessionView.teamwork`; `setSessionTeamwork(hooks)` ставит `server.ts` через `sessionTeamwork(service,
status)` из `teamwork-work.ts`. MCP сессии из задачи получает два инструмента (у остальных сессий их нет в списке):

- `team_task_update { status?, pr?, comment? }` — PATCH задачи (статус, `pr: { url, state: 'open' }`) и комментарий;
  ответ — что изменилось.
- `team_doc_write { name, text }` — `architecture`, `design` или `docs/<имя>.md` проекта целиком (ТЗ не пишется — только
  через черновик), коммит `<project>: <документ> — из сессии по задаче <ID>`; ответ — путь файла в клоне.

Оба — в `permissions.ask` и под хуком PreToolUse (`ASK_TOOLS` в `sessions.ts`), причина вопроса — подпись задачи и что
сделает вызов (`askDetail`). `sessionWorkStatus(id)` отдаёт живой статус сессии для `TeamTask.work`.

## `TeamTask.work`

`TeamServiceDeps.workStatus` (ставит `server.ts`: `teamWorkStatus`) сверяет записи `local.json` с живыми запусками (ждёт
ответа, на паузе, running), завершёнными (`run.json`: done, failed, aborted, interrupted) и сессиями менеджера
(starting, working, waiting, ended); `title` — имя запуска или сессии.

## Что звать UI (волна 3)

- Меню «В работу ▸» на карточке и в задаче: если у задачи нет `repo` и репо проекта несколько — выбор репо (`TeamProject.repos`);
  затем `POST …/tasks/:id/worktree { repo }` (409 `no_local` — показать «репо кода не найдено локально», ссылка на настройки
  команды `PUT /api/teams/:t/local { repoPaths }`), затем `GET …/tasks/:id/intake?repo=` и открыть форму запуска:
  `input` = `intake.input`, flow — `intake.teamFlow` (в списке группа «Flow команды» из `intake.teamFlows` и группа «Мои
  flow»; при выборе другого flow команды — снова `GET …/intake?flow=<name>`, своего — собрать `Задача:`/`Ветка:` из
  шаблона и `intake.context`), папка — `worktree.path`, `worktree: { path, branch }`, `addDirs` = `intake.addDirs`,
  пространство — `intake.space`. Тело `POST /api/runs`: `{ teamFlow: intake.teamFlow, teamwork: intake.teamwork, input,
  cwd, worktree, addDirs, space, source: intake.source }` (для своего flow — `flow` вместо `teamFlow`).
- «Сессия»: `POST /api/sessions { cwd: worktree.path, prompt: intake.context, space: intake.space, teamwork: intake.teamwork }`.
- Доска и панель задачи: `TeamTask.work[]` — запуски и сессии со статусами (значок «запуск не дошёл до конца» — `kind:
  'run'` со статусом не `done` и не `running`/`waiting`/`paused`), `TeamTask.pr` — ссылка и состояние, `TeamTask.branch`.
  Событие `team` в `/api/events` приходит после каждого изменения (старт, конец, PR, запись work) — сбросить кэш проекта.
- `RunSummary.teamwork`/`source.type === 'teamwork'` — связать запуск с задачей на главной; `SessionView.teamwork` — сессию.
- Настройки команды: написать, что без `gh` и `glab` переходы по PR не работают (spec §10).

## Правки вне своих файлов

- `src/teamwork-server.ts` (core, 2 места): `TeamServiceDeps.workStatus` + его применение в `readTasks`; блок `patch.pr` в
  `changeTask` (сообщение коммита `PR открыт|смёржен|закрыт: <url>` / `PR снят`). Drafts правит тот же файл — конфликты
  маловероятны (другие методы), но слить надо глазами.
- `web/src/lib/run-form.ts` + тест (ui-logic): `sourceLabel` для `teamwork` — «Задача».
- `src/api-types.ts`: только дополнения, существующие поля не менялись (кроме расширения union `RunSource.type`).
- `docs/GETTING_STARTED.md`: строки `sessions-mcp.ts`, `teamwork-server.ts` (убрано «intake и worktree добавят»), новые
  `teamwork-work.ts`, `teamwork-status.ts`.

## check-sdk-hooks

Прогонять не обязательно: guard папок данных и `launchDirs` не трогались. Изменены `ASK_TOOLS` (два новых инструмента в
`permissions.ask` и PreToolUse) — это та же механика, что у `space_write`, покрыта `sessions.test.ts` и
`server.teamwork.work.test.ts`. Если прогон запланирован ради drafts или core — добавить сценарий «сессия из задачи зовёт
`team_task_update` в auto → вопрос».

## Не проверено

- Живой UI (экранов нет), настоящий `gh`/`glab` (опрос PR — только с поддельным `exec`), настоящий claude в сессии из задачи.
- Опрос PR по таймеру в живом сервере (в тестах — явный `poll()` и короткий интервал у отдельного экземпляра).
- `continue`/повтор запуска по задаче: `started` зовётся из `startRun`, но тестом не покрыт.
- Группировка «мои запуски по задаче» на главной — не делалась (волна 4).
