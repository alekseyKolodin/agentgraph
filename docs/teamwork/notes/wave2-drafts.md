# Сессия drafts (волна 2): черновики агентов

Ветка `claude/tw-drafts-a047ea`. Файлы: `src/teamwork-drafts.ts` и `src/teamwork-drafts.test.ts`, маршруты `…/drafts*` в
`src/teamwork-server.ts`, типы черновиков в `src/api-types.ts`. Правки вне своих файлов — в конце.

Черновик — обычный локальный запуск flow команды (`teamwork-prd`, `teamwork-architecture`, `teamwork-split` из `flows/`
репо команды, читается `service.readTeamFlow`, невалидный — 400). Запуск идёт как разовый (`adhoc: true`): flow не лежит
в `flows/` agentgraph, его копия — снимок `flow.yaml` в папке запуска; продолжение и повтор запуска берут spec из снимка,
ссылка `teamwork` наследуется. В `run.json → teamwork` лежит `{ team, project, draft, section?, brief, docs? }`
(`RunTeamworkLink`, поля `brief` и `docs` добавлены). Запуск виден везде, где видны запуски; по ссылке его находят
черновики (`GET …/drafts` фильтрует `RunSummary.teamwork.draft`).

## Маршруты

Все под `/api/teams/:t/projects/:p`, ошибки `{ error, code? }`: 400, 404 (нет команды, проекта, черновика, раздела),
409 `conflict`, 501 — маршрут вызван без объекта черновиков (только в тестах `teamworkRoute`).

| Маршрут | Запрос | Ответ |
|---|---|---|
| `POST …/drafts` | `TeamDraftStart`: `{ kind: 'prd' \| 'architecture' \| 'split', brief?, section?, what?: 'architecture' \| 'design' \| 'both', model?, cwd?, maxBudgetUsd? }` | 201 `TeamDraft` со `status: 'running'` (в `run` — id запуска) |
| `GET …/drafts` | — | `TeamDraft[]`, от новых к старым |
| `GET …/drafts/:run` | — | `TeamDraftDetail` |
| `POST …/drafts/:run/accept` | `TeamDraftAccept`: документ `{ doc?, text, base?, message? }` или разбивка `{ tasks: TeamProposedTask[] }` | 200 `TeamDraftAccepted`: `TeamDoc` или `{ tasks: TeamTask[] }` |

### Старт

- `brief` — задание автора; пусто → «Написать ТЗ по коду» / «Написать по ТЗ» / «Разбить всё ТЗ». `section` — заголовок
  раздела (с «## » или без; раздела нет в документе → 404; у split → 400). `what` только у architecture (по умолчанию
  `both`; с `section` нужен один документ → иначе 400). `cwd` — папка запуска вместо локальной папки основного репо кода.
- Вход — анкета `input` flow, заполненная по именам полей (`fillForm`, формат из `wave1-flows.md`): «Проект», «Суть
  проекта» (source-data), «Что сделать» (source-data), «Раздел» («## Заголовок» или «весь документ»), «Новые номера»
  (prd: `nextRequirement` документа), «Что писать» (architecture), «Папка проекта», «Репо кода» (split: список `- ключ —
  url, ветка, рабочая папка запуска | дополнительная папка | локально нет`), «Существующие задачи (номер · заголовок · тип
  · статус · исполнитель · требования · ждёт)» (split: все задачи проекта одним блоком source-data, «(задач ещё нет)»).
  Строки анкеты с неизвестным полем остаются как есть; у flow команды с `input` без плейсхолдеров текст команды остаётся
  сверху, анкета шаблона — под ним. Нет prd.md — «Новые номера» по `project.yaml → lastRequirement` (номера не возвращаются).
  Блоки-вызовы других flow проверяются на старте (`checkCalls`), как у разового запуска.
- Текущие `prd.md`, `architecture.md`, `design.md` кладутся в `initial` одноимённых артефактов, если flow их объявляет (и
  те, что агенту менять не просили: он их читает). `notes.initial` и `tasks.initial` не трогаются. Отсутствие артефакта
  (`prd` и `notes`, `architecture`/`design` и `notes`, `tasks`) — 400.
- Папки: cwd — локальная папка основного (первого) репо кода проекта (`TeamRepoRef.local`: `local.json → repoPaths` или
  найдено по origin среди проектов дашборда); неизвестна → 400 с подсказкой про `PUT /api/teams/:t/local` или `cwd`.
  Проект без репо кода — cwd = папка проекта в клоне. `addDirs` — папка проекта в клоне и остальные репо, которые есть
  локально. Guard `phaseProtectedRoots` закрывает `~/.agentgraph/teams` на запись в любом случае.
- Текст людей (суть проекта, задание, заголовки и поля задач) — только внутри `source-data` (`wrapData`, вложенный тег
  обезвреживается). Снаружи — слаг, название проекта и поля репо из `project.yaml` одной строкой (`oneLine`), пути, номера.

### Черновик (`TeamDraftDetail`)

Общее: `run`, `kind`, `flow`, `status` (статус запуска глазами сервера: `running`, `waiting` — вопрос агента, `paused`,
`done`, `failed`, `aborted`, `interrupted`…), `startedAt`, `finishedAt?`, `section?`, `brief?`, `docs?` (документы
черновика; у split нет).

Документы (`prd`, `architecture`): `documents: TeamDraftDoc[]` по `docs` — `base` (текст на старте запуска, из `initial`
снимка `flow.yaml`), `baseHash`, `next` (текст агента из `artifacts/<file>`; файла ещё нет → `base`), `changed`, `current`
(документ в репо сейчас), `currentHash`, `moved` (документ менялся после старта), `dropped?` (режим раздела: заголовки
разделов, где правки агента отброшены; `next` — base с заменённым разделом, остальное байт в байт). `notes:
TeamDraftNote[]` из `notes.json` (`{ at, why, doc? }`; у architecture `doc` говорит, к какому документу запись). Битый
`notes.json` — `warnings`, записи без `at`/`why` пропускаются.

Разбивка (`split`): `tasks: TeamProposedTask[]` из `tasks.json` (битый или не по схеме — `error`, задач нет, у каждой
задачи `key` по умолчанию `tN`, `type` — `feature`), `report: TeamDependencyReport` от `checkDependencies` ядра
(неизвестные ссылки, цикл, волны, цепочка), `existing: TeamDraftExisting[]` — все задачи проекта (`id, status, title,
assignee?, sprint?, estimate?`) для пунктирных узлов графа.

#### Принятие

- Пока запуск идёт (`running`, `waiting`, `paused` глазами сервера) — 409 `busy`: агент ещё пишет артефакты.
- Документ: `text` — итоговый текст после решений человека (`applyDecisions(base, next, decisions)` из ui-logic);
  `base` — хэш, относительно которого приняты правки: по умолчанию `baseHash`, после ручного разрешения конфликтов —
  `currentHash`; иначе 409 `conflict` с `current: TeamDoc`. `doc` нужен у architecture с двумя документами (иначе
  подставляется единственный); документ не из `docs` черновика — 400. Сообщение коммита по умолчанию `«<slug>: ТЗ — принят
  черновик агента»` (`, раздел «X»` в режиме раздела), своё — `message`.
- Режим раздела (`section` в ссылке): правки вне раздела в `text` — 400 с заголовками разделов; пишется только раздел
  через `writeDoc(…, { section, hash })`, 409 только если этот раздел менялся с базы (правки других разделов не мешают).
- Разбивка: `tasks` после правок человека (ключи и `dependsOn` как в предложении, номера существующих задач — как есть),
  `checkDependencies` → ошибки или цикл — 400 `code: 'dependencies'` с `report`; затем `createTasks` одним коммитом
  (`<slug>: N задач добавлено`), ключи → новые номера, `dependsOn` → `blockedBy`. Ответ `{ tasks: TeamTask[] }`.

## Как UI волны 3 работает с черновиком

1. Старт: `POST …/drafts` → 201 с `run`. Строка на вкладке документа: «Черновик идёт · Открыть запуск» (ссылка на
   `/runs/<run>`; вопросы агента там же, как у любого запуска).
2. Опрос: `GET …/drafts` раз в несколько секунд или по событиям `/api/events` (`end` с `runId` черновика → перечитать).
   Черновик документа — элемент с `docs.includes(name)`; статусы `running | waiting | paused` — идёт, остальное — готов
   («Черновик готов · Посмотреть» у `done`; у `failed`/`interrupted` — ошибка и «Повторить»).
3. Показ: `GET …/drafts/:run` → `trackChanges(doc.base, doc.next, notes, decisions, doc.name)`; `doc.moved` →
   `markConflicts(edits, doc.current)`: правки на изменённых местах — только руками. `dropped` — предупреждение «правки вне
   раздела отброшены». Разбивка: `tasks`, `report`, `existing` → `layoutGraph`, `depsSummary`; правка связей —
   `addDependency`/`removeDependency`, перепроверка `checkDependencies` на клиенте.
4. Принятие: `applyDecisions(base, next, decisions)` → `POST …/accept { text, base: doc.baseHash }`; 409 → показать
   `current` рядом и после ручного слияния повторить с `base: doc.currentHash`. Разбивка: отмеченные задачи с правками
   полей → `POST …/accept { tasks }`; 400 `dependencies` → подсветить `report.errors` по ключам.
5. Нерешённые правки остаются в черновике: запуск никуда не исчезает, `GET …/drafts/:run` отдаёт то же, пока запуск на
   диске.

## Правки вне своих файлов

- `src/server.ts`: импорт `TeamDrafts`/`DraftRunDeps`; в маршруте `/api/teams*` — `drafts: new TeamDrafts(service,
  draftRuns(opts))`; поле `teamwork?: RunOptions['teamwork']` в типе опций `startRun` (сессия work наверняка добавит то
  же — конфликт в одну строку); хелпер `draftRuns(opts)` рядом с `draftDeps` (`runsDir`, `start` через `startRun`,
  `runs` = `listRuns`, `report` = `readReport`, `live` — статус живого запуска); в запасной отчёт `launchRun` → `.catch`
  (раннер упал до события `start`) добавлены `source`, `teamwork`, `worktree` — иначе упавший черновик пропадал из
  `GET …/drafts` (замечание ревью; тест «раннер упал до старта»).
- `src/api-types.ts`: `TeamDraft` расширен (`flow`, `finishedAt?`, `docs?`), `TeamDraftNote.doc?`, новые
  `TeamDraftDocName`, `TeamDraftStart`, `TeamDraftDoc`, `TeamDraftExisting`, `TeamDraftDetail`, `TeamDraftAccept`,
  `TeamDraftAccepted`; `RunTeamworkLink.brief?` и `docs?`. Существующие поля не менялись.
- `docs/GETTING_STARTED.md`: строка `src/teamwork-drafts.ts` в таблице модулей.

## Замечания для соседей

- work: `POST /api/runs` с `teamFlow: { team, name }` стоит тоже запускать с `adhoc: true` — иначе продолжение и повтор
  запуска ищут flow команды в `flows/` agentgraph и не находят.
- Независимое ревью (`code-reviewer`) прошло: два замечания «важно» (поля репо одной строкой вне source-data; упавший до
  `start` черновик без ссылки) и мелочи исправлены, тесты на них добавлены. Осознанно оставлено: дубли мелких хелперов
  (`isRecord`, `bad`, `optStr`) с `teamwork-server.ts` — как в соседних модулях.
- `finish`: подпись статуса `interrupted`/`waiting` для строки черновика; `docs/REFERENCE.md` — маршруты выше.

## Не проверено

- Живой запуск с настоящим Agent SDK: как агент пишет артефакты в `artifacts/` и попадает ли его `prd.md` в `next` на
  ходу (в тестах раннер поддельный, файлы пишет сценарий теста). Снимок `flow.yaml` с `initial` документа проходит
  круг YAML → zod без потерь в тестах (тексты с одним переводом строки в конце); документ с хвостом из пустых строк
  или `\r\n` не проверялся.
- UI: экранов ещё нет, в браузере ничего не смотрел.
- `scripts/check-sdk-hooks.mts` не запускал (guard не трогал).
