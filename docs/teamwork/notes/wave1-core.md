# Отчёт сессии core (волна 1)

Ветка `claude/tw-core-d6e287`, 5 коммитов поверх `564cac3`, не слито и не отправлено. `npm run typecheck && npm test` зелёные: 1097 тестов. Независимое ревью `code-reviewer` прошло, все его замечания исправлены последним коммитом.

Коммиты:
1. `feat(teamwork): чистая логика ядра` — `src/teamwork.ts` + тест.
2. `feat(teamwork): шаблон репо команды и клон` — `templates/teamwork/`, `src/teamwork-template.ts`, `src/teamwork-repo.ts` + тест на настоящем git.
3. `feat(teamwork): сервис команды, маршруты /api/teams, событие team и guard` — `src/teamwork-server.ts`, подключение в `src/server.ts`, `src/api-types.ts`, guard в `src/spaces.ts` и `src/sessions.ts`, тесты.
4. `docs(getting-started)` — четыре строки в таблице модулей.
5. `fix(teamwork): правки по ревью и сверка цикла с UI`.

## Экспорты

### `src/teamwork.ts` (чистая логика)

- Константы: `TEAM_FORMAT = 1`, `TASK_STATUSES`, `TASK_TYPES`, `SPRINT_STATUSES`, `PROJECT_STATUSES`, `DEFAULT_COLUMNS`, `TEAM_SLUG_RE`, `PREFIX_RE`, `TASK_ID_RE`, `FLOW_NAME_RE`, `REQUIREMENT_RE = /^- (FR|NFR)-(\d+)\.\s+(.*)$/`, `RANK_DIGITS`, `DOC_FILES`, `DOC_LABELS`.
- `teamsDir(): string` — `<configDir()>/teams`.
- `textHash(text): string` (sha256, 16 hex), `yamlText(obj): string`, `updateYaml(text, patch): string` (правка YAML по месту, комментарии и неизвестные поля остаются; `undefined` снимает ключ).
- `parseTeamConfig(text): TeamConfig` (бросает), `parseColumns`, `parseMembers`, `serializeTeamConfig(cfg)`. `TeamConfig = { format, title, prefix, columns, members, defaultFlow?, extra }`.
- `parseProject(text, slug?): ProjectConfig` (бросает), `serializeProject(p)`. `ProjectConfig = { slug, title, summary, status, repos: ProjectRepo[], createdAt?, createdBy?, lastRequirement?: { FR?, NFR? }, extra }`.
- `parseSprint(text, numberFromFile?): SprintFile` (бросает), `serializeSprint(s)`, `sprintView(s): TeamSprint`, `nextSprintNumber(sprints)`, `sprintSummary(tasks, n)`.
- `splitFrontmatter(text)`, `parseTask(text, file): TaskFile` (никогда не бросает: битый файл → `error`), `taskFrontmatter(t)`, `composeTask(frontmatter, body)`, `serializeTask(t)`, `taskView(t): TeamTask`, `acceptanceOf(body)`. `TaskFile = TeamTask & { extra }`.
- `nextTaskId(ids, prefix)`, `taskNumber(id)`, `compareTasks(a, b)`, `sortTasks(tasks)`.
- `rankBetween(a?, b?)` (midpoint, бросает на a ≥ b, хвостовом 0, чужих символах), `validRank(r)`, `rankNear(a?, b?)` (не бросает: битый rank — пустой, перевёрнутые соседи — после a).
- `splitSections(md): DocSection[]` (`{ heading, text, start, end }`, text — кусок от строки `## ` до следующей), `sectionHash(text)`, `findSection(md, heading)`, `replaceSection(md, heading, text)`.
- `parseRequirements(md): TeamRequirement[]`, `requirementMax(md)`, `nextRequirementId(md, kind, last?)`.
- `checkDependencies(tasks: TeamProposedTask[], existing): TeamDependencyReport` — `cycle` по стрелкам графа (от предшественника к зависимой).
- `commentFileName(at, email)`, `parseComment(text, file)`, `serializeComment(c)`.
- `docFile(name)`, `isDocName(name)`, `docTitle(text, fallback)`, `docLabel(name)`.
- `remoteProblem(url): string | undefined`, `teamSlugFromUrl(url)`.
- `mergeRecords(base?, mine, theirs)`, `mergeTaskTexts(base?, mine, theirs, file, mergeText): Promise<{ text, conflicts }>`, `mergeYamlTexts(base?, mine, theirs)`, тип `MergeText`.
- `taskChangeMessage(id, changes)`.

### `src/teamwork-template.ts`

`TEMPLATE_DIR`, `PROJECT_TEMPLATE_DIR = 'project-template'`, `PROJECT_DOC_FILES`, `templateFiles(from?)`, `copyTemplate(dest, from?)`, `renderTeamConfig(templateText, { title, prefix, member })`, `renderDoc(template, { title, summary })`, `projectDocs({ title, summary }, dirs?)`.

### `src/teamwork-repo.ts`

- `class TeamError extends Error { status; code?; extra?; body() }`.
- `type LocalData`, `type RepoDeps`, `defaultRepoDeps()`, `type ChangeEvent = { team, projects }`, `type CommitMessage`, `LOCAL_FILE`, `REPO_DIR`, `TASK_FILE_RE`, `projectsOf(files)`, `scrub(text)`.
- `class TeamRepo`: `static open(slug, deps?, root?)`, `static list(root?)`; `local()`, `saveLocal(mutate)`, `branch()`; `abs(rel)`, `read`, `exists`, `writeFile`, `remove`, `list(rel, filter?)`, `dirs(rel)`, `config()`, `readonly()`; `git(args, timeoutMs?)`, `identity()`, `requireIdentity()`, `rev(ref)`; `onChange(fn)`, `enqueue(fn)`; `write(message | () => message, mutate, { author? })`; `schedulePush(delayMs?)`, `push()`, `pull(): Promise<string[]>`, `sync(): Promise<TeamSync>`; `mergeText(base, mine, theirs)`; `unpushed()`, `unpushedSubjects()`, `syncState()`, `history({ path?, limit? })`; `startTimers(hasSubscribers)`, `stop()`, `disconnect(force)`.
- `checkRemote(url, deps?): Promise<TeamRemoteCheck>`, `freeTeamSlug(url, root?)`, `createTeam({ url, title, prefix }, deps?, root?)`, `joinTeam({ url, addMe? }, deps?, root?) → { repo, added }`.

### `src/teamwork-server.ts`

- `teamService(deps?)` (синглтон), `stopTeamwork()`, `teamworkRoute(method, url, readBody, { service })`, `findLocalRepo(url, exec?)`.
- Типы: `TeamServiceDeps = { root?, repo?, hasSubscribers?, timers?, findLocal? }`, `NewTask`, `WriteDocOptions`, `TaskWriteOptions = { message?, author? }`, `NewSprint`, `CloseSprint`, `TeamFlow = TeamFlowOf<FlowSpec>`.
- `class TeamService`: `listTeams()`, `check(url)`, `createTeam(body)`, `joinTeam(body)`, `removeTeam(slug, force)`, `team(slug)`, `updateTeam(slug, body)`, `sync(slug)`, `local(slug)`, `updateLocal(slug, body)`, `conflicts(slug)`, `resolveConflict(slug, id, 'theirs' | 'mine')`, `listProjects(slug)`, `project(team, slug)`, `createProject(team, body)`, `updateProject(team, slug, body)`, `doc(team, slug, name)`, `writeDoc(team, slug, name, text, { base?, section?, hash?, message? })`, `history(team, slug, { doc?, limit? })`, `tasks`, `task`, `createTasks(team, slug, NewTask[], opts?)`, `updateTask(team, slug, id, TeamTaskPatch, opts?)`, `moveTask(team, slug, id, TeamTaskMove, opts?)`, `deleteTask`, `recordWork(team, taskId, work)`, `comments`, `addComment(team, slug, id, text)`, `sprints`, `createSprint(team, slug, { title?, goal?, start?, tasks? })`, `startSprint(team, slug, n, { title?, goal?, tasks? })`, `closeSprint(team, slug, n, { next? })`, `teamFlow(team, name)` (с `error`), `readTeamFlow(team, name)` (400 на невалидный), `writeTeamFlow(team, name, yaml)`, `onChange(fn)`, `stop()`, `repo(slug)`.

## Маршруты (все под `/api/teams`, ошибки `{ error, code? }`)

| Маршрут | Запрос | Ответ |
|---|---|---|
| `GET /api/teams` | — | `TeamSummary[]` |
| `POST /api/teams` | `{ url, title, prefix }` | 201 `TeamDetail`; 400; 409 `is_team` (`check` в теле), `not_empty` |
| `POST /api/teams/check` | `{ url }` | `TeamRemoteCheck` (плохая ссылка — `kind: 'error'`, нет url — 400) |
| `POST /api/teams/join` | `{ url, addMe? }` (по умолчанию true) | 201 `TeamDetail`; 409 `not_empty` |
| `GET /api/teams/:t` | — | `TeamDetail` (+ фоновый pull при таймерах) |
| `PUT /api/teams/:t` | `{ title?, columns?, members?, defaultFlow? (null снимает) }` | `TeamDetail`; prefix — 400 |
| `DELETE /api/teams/:t[?force=true]` | `{ force? }` | `{ ok }`; 409 `unpushed` + `{ unpushed, commits }` |
| `POST /api/teams/:t/sync` | — | `TeamSync` (ошибка сети — в `error`, код 200) |
| `GET, PUT /api/teams/:t/local` | PUT `{ repoPaths?, projectSpaces? }`, null снимает | `TeamLocal` |
| `GET /api/teams/:t/conflicts` | — | `TeamConflict[]` |
| `DELETE /api/teams/:t/conflicts/:id` | — | оставшиеся `TeamConflict[]` |
| `POST /api/teams/:t/conflicts/:id/mine` | — | оставшиеся `TeamConflict[]`; `sprint` — 400 |
| `GET, PUT /api/teams/:t/flows/:name` | PUT `{ yaml }` | `TeamFlow` (`spec` или `error`); PUT невалидный — 400 |
| `GET, POST /api/teams/:t/projects` | POST `{ slug, title, summary?, repos?: [{ key, url, defaultBranch? }] }` | `TeamProjectBrief[]` / 201 `TeamProject`; 409 `not_empty` |
| `GET, PUT …/projects/:p` | PUT `{ title?, summary?, status?, repos? }` | `TeamProject` |
| `GET, PUT …/projects/:p/docs/:name` | PUT `{ text, base? }` или `{ text, section, hash?, message? }` | `TeamDoc` (+ `requirements`, `nextRequirement`); 409 `conflict` + `current`; новый `docs/<имя>.md` создаётся PUT без base |
| `GET …/projects/:p/history?doc=&limit=` | — | `TeamHistoryItem[]` |
| `GET, POST …/tasks` | POST `NewTask` или `{ tasks: NewTask[] }` | `TeamTask[]` / 201 `TeamTask` или `{ tasks }` |
| `GET, PATCH, DELETE …/tasks/:id` | PATCH `TeamTaskPatch` | `TeamTask`; 409 `conflict` + `current`; битая задача — 400 |
| `POST …/tasks/:id/move` | `TeamTaskMove` (`after` — после кого, `before` — перед кем) | `TeamTask` |
| `GET, POST …/tasks/:id/comments` | POST `{ text }` | `TeamComment[]` / 201 `TeamComment` |
| `GET, POST …/sprints` | POST `{ title?, goal?, start?, tasks? }` | `TeamSprint[]` / 201 `TeamSprint`; 409 `busy` |
| `POST …/sprints/:n/start` | `{ title?, goal?, tasks? }` | `TeamSprint`; 409 `busy` |
| `POST …/sprints/:n/close` | `{ next?: string[] }` (остальные незавершённые — в бэклог) | `TeamSprint` с `result` |

Не заняты: `…/drafts*`, `…/tasks/:id/intake`, `…/tasks/:id/worktree` (волна 2). `teamworkRoute` возвращает `undefined` для них.

## Отклонения от контракта и плана

- `src/api-types.ts` дополнен (ничего существующего не менялось): `HomeEvent.team`/`projects`, `DenialReason` + `'team-readonly'`, `TeamDoc.requirements?`/`nextRequirement?`, `TeamLocal`, `TeamFlow<Spec>`, комментарии к `TeamTaskMove` (смысл before/after), `TeamDoc` (PUT) и `TeamConflict` (API).
- Дополнительные маршруты сверх §12: `GET/DELETE/POST …/conflicts*`, `GET …/sprints`, `GET …/projects/:p/history?doc=` для истории документа; `POST …/sprints` умеет `start: true`. Код 409 `readonly` добавлен к списку плана.
- Шаблон: заготовки документов лежат в `templates/teamwork/project-template/` и копируются в репо команды (команда правит их у себя); спека в дереве §5.1 этой папки не называет. `flows/` в шаблоне нет — её кладёт сессия flows.
- Слаг команды — из последнего сегмента ссылки (`payments-team`), при занятости `-2`; локальный, у участников может отличаться.
- `rankBetween` у соседей с неверным порядком или битым rank не падает: встаём после `after` (`rankNear`).
- Правки чужих файлов (минимальные): `electron-builder.yml` (templates/** в сборку), `web/src/lib/run/artifacts.ts` и `web/src/i18n/en/space.ts` (подпись `team-readonly`), `src/sessions.test.ts` и `src/spaces.test.ts` (ожидания guard с папкой команд).
- «Взять моё» для конфликта `sprint` не реализовано (перенос задач руками), как и «править вручную» отдельной кнопкой — это обычный PUT/PATCH.

## Не проверено

- Живой UI (экранов нет), настоящие GitHub/GitLab по https/ssh с credential helper, таймеры в реальном времени (в тестах таймеры выключены, отправка — явный `POST /sync`).
- `scripts/check-sdk-hooks.mts` не запускался: guard тронут (`phaseProtectedRoots`, `launchDirs`), надо прогнать `data-dirs` и `space-session` и добавить сценарий записи в `~/.agentgraph/teams/<slug>/repo/…`.
- Поведение `git` старше 2.50 (использованы `--diff-filter`, `merge-file -p`, `clone -c`, `ls-remote --heads`, стандартные).
