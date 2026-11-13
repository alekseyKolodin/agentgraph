# Teamwork — план реализации по сессиям

Спека — [spec.md](spec.md). Макеты экранов — [design/](design/) (исходники артбордов холста «Teamwork — макет»; читать как HTML: разметка и стили в `<helmet><style>`, токены «Пульта»). Контракт типов API — раздел «Teamwork» в конце `src/api-types.ts`.

Работа идёт волнами. Сессии одной волны работают параллельно, каждая в своём worktree от ветки `teamwork` и правит только свои файлы. Оркестратор сливает ветки сессий в `teamwork` после проверки и запускает следующую волну от свежей `teamwork`.

## Общие правила для каждой сессии

- Перед правкой `src/` загрузи скилл `agentgraph-core`, перед `web/` — `agentgraph-web`, для тестов — `agentgraph-tests`.
- Правь только файлы из своей строки таблицы владения. Нужна правка чужого файла — сделай минимальную и напиши о ней в отчёте.
- Контракт типов в `src/api-types.ts` можно дополнять. Менять существующие поля — только если без этого нельзя, и с пометкой в отчёте.
- Принципы проекта: этапов flow как можно меньше, справочное агенту — по запросу, текст людей и моделей агенту — только в `source-data`. Guard на папки данных не ослабляется.
- Готово, когда `npm run typecheck && npm test` зелёные (для `web/` ещё `npm run build:web`), всё закоммичено в свою ветку, а отчёт перечисляет сделанное, непроверенное и всё, что нужно следующим волнам.

## Владение файлами

| Сессия | Волна | Файлы |
|---|---|---|
| core | 1 | `src/teamwork.ts`, `src/teamwork-repo.ts`, `src/teamwork-template.ts`, `src/teamwork-server.ts`, их тесты; `templates/teamwork/` кроме `flows/`; подключение в `src/server.ts` (маршрут `/api/teams*`, фича `teamwork`, остановка, событие `team`); guard папки команд в `src/spaces.ts` и `src/sessions.ts`; `HomeEvent.team` в `src/api-types.ts` |
| ui-logic | 1 | `web/src/lib/teamwork/**` |
| flows | 1 | `templates/teamwork/flows/*.yaml`, `src/teamwork-flows.test.ts`; «Задача:»/«Task:» в `composeInput` (`src/intake.ts`, `src/intake.test.ts`) |
| ui-shell | 2 | `web/src/api/teamwork.ts`, маршруты в `web/src/App.tsx`, пункт в `web/src/components/shell/Sidebar.tsx`, `web/src/screens/teamwork/` (кроме `docs/` и `tasks/`), `web/src/i18n/en/teamwork.ts` |
| work | 2 | `src/teamwork-status.ts` и тест; запуски и сессии по задаче в `src/server.ts`, `src/runner.ts`, `src/sessions-server.ts`; `RunSource.type: 'teamwork'`; инструменты `team_task_update`, `team_doc_write` в `src/sessions-mcp.ts` и `src/sessions.ts` |
| drafts | 2 | `src/teamwork-drafts.ts` и тест; маршруты черновиков в `src/teamwork-server.ts` |
| ui-docs | 3 | `web/src/screens/teamwork/docs/` |
| ui-tasks | 3 | `web/src/screens/teamwork/tasks/` |
| finish | 4 | Home «Мои задачи», диалог выхода `src/desktop/main.ts`, перевод, `docs/REFERENCE.md`, `docs/GETTING_STARTED.md` |

## Контракты между волнами

### Хранилище (core)

- Корень команд — `teamsDir()` = `<configDir()>/teams` (`AGENTGRAPH_CONFIG_DIR` в тестах). Команда — `<teamsDir>/<slug>/repo` (клон) и `<teamsDir>/<slug>/local.json` (spec §6).
- Шаблон репо команды — дерево `templates/teamwork/` в checkout agentgraph (путь от `APP_DIR`). core копирует его целиком при создании команды и подставляет название, префикс и первого участника в `teamwork.yaml`. Сессия flows кладёт туда `flows/`.
- Ссылка на репо: только `https://`, `http://`, `ssh://`, scp-вид `user@host:path`, `file://` и абсолютный путь (для тестов). Ведущий `-`, пробелы и переводы строк — отказ.

### Модуль `src/teamwork.ts` (core, чистая логика)

Экспортирует, а следующие волны используют:

- разбор и запись файлов с сохранением неизвестных полей: `parseTeamConfig`, `parseProject`, `parseSprint`, `parseTask(text, file)`, `serializeTask`;
- `rankBetween(a?, b?)` — дробный индекс (тот же алгоритм повторяет ui-logic, тесты с общими примерами);
- `nextTaskId(ids, prefix)`;
- разделы markdown: `splitSections(md)`, `sectionHash(text)`, `replaceSection(md, heading, text)`;
- требования: `parseRequirements(md)` → `TeamRequirement[]`, `nextRequirementId(md, 'FR' | 'NFR')`;
- зависимости предложения: `checkDependencies(tasks: TeamProposedTask[], existing: { id: string; status: TeamTaskStatus }[])` → `TeamDependencyReport`.

### Сервис команды (core)

`src/teamwork-server.ts` экспортирует `teamworkRoute(method, url, readBody, deps)` в стиле `integrationsRoute` и объект сервиса с методами, которые нужны work и drafts:

- `readTeamFlow(team, name)` → `{ spec, yaml, file }` с проверкой схемы;
- `updateTask(team, project, id, patch, { message, author? })` — запись с коммитом и отправкой;
- `createTasks(team, project, tasks)` — пачкой одним коммитом;
- `writeDoc(team, project, name, text, { base?, section?, message })`;
- `recordWork(team, taskId, work)` — `local.json → work`;
- `onChange(listener)` — после локальной записи или pull, сервер шлёт событие `team` в `/api/events`;
- `stop()`.

### API (core делает всё, кроме черновиков и работы по задаче)

Маршруты — spec §12. Ответы — типы Teamwork из `src/api-types.ts`. Ошибки — `{ error }` с кодами 400, 404, 409; 409 с полем `code`: `not_empty`, `is_team`, `conflict`, `unpushed`, `busy`.

Доп. маршрут: `POST /api/teams/check { url }` → `TeamRemoteCheck` для формы создания и подключения.

### Событие `team`

`HomeEvent` получает `team?: string` и `projects?: string[]`. Тип события — `team`, `runId` и `flow` пустые. UI сбрасывает кэш команды.

## Волны

1. **core**, **ui-logic**, **flows** — параллельно.
2. **ui-shell**, **work**, **drafts** — после слияния волны 1.
3. **ui-docs**, **ui-tasks** — после слияния волны 2.
4. **finish**, затем независимое ревью, полный прогон и проверка в браузере.
