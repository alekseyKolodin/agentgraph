# Отчёт сессии ui-shell (волна 2)

Ветка `claude/tw-ui-shell-e217b5` поверх `teamwork` (`a63712d`). `npm run typecheck && npm test && npm run build:web` зелёные (1155 тестов). Проверено живьём в браузере на песочной папке настроек и двух bare-репо через `file://`: создание команды, подключение по ссылке вторым клоном, проект, обзор, строка синхронизации во всех состояниях, настоящий конфликт поля между двумя клонами и его разбор, flow команды в редакторе YAML с сохранением, настройки, отключение команды. Скриншоты — в общей папке заметок сессий (`ui-shell-project-overview.jpg`, `ui-shell-conflicts.jpg`, `ui-shell-overview-agents-readonly.jpg`).

## Маршруты (`web/src/App.tsx`)

| Адрес | Экран |
|---|---|
| `/teamwork` | `TeamsScreen`: мои команды, форма «Создать команду» (проверка ссылки `POST /api/teams/check` по мере ввода), «Подключиться по ссылке» — диалог `JoinDialog` |
| `/teamwork/:team` | `TeamScreen`, вкладка — `?tab=projects` (по умолчанию) · `members` · `process` · `settings` |
| `/teamwork/:team/:project/:tab?` | `ProjectScreen`, `tab` — `prd` · `architecture` · `design` · `docs` · `backlog` · `board` · `sprints`; без хвоста — «Обзор»; незнакомый хвост — редирект на обзор |
| `…?task=PAY-12` | панель задачи (`TaskDrawer` → `tasks/TaskPanel`) поверх любой вкладки проекта; закрывается ×, Esc и кликом мимо (параметр снимается `replace`) |

Три экрана лениво грузятся одним файлом сборки (`screens/teamwork/index.ts`, чанк `teamwork-*.js` ≈65 КБ). Пункт «Teamwork» в сайдбаре — в рабочей колонке между «Пространствами» и «Сессиями», только с фичей `teamwork` из `/api/config`; без фичи экраны показывают «Сервер не умеет Teamwork». Помощники адресов — `screens/teamwork/shell.ts`: `teamPath`, `teamTabPath`, `projectPath(team, project, tab)`, `projectTabOf`, `teamTabOf`, `TASK_PARAM`, `PROJECT_TABS`, `TEAM_TABS`, подписи вкладок.

## `web/src/api/teamwork.ts`

Все ключи React Query — под `teamKeys.all = ['teams']`; событие `team` общего потока сбрасывает их разом (`useHomeEvents.ts`, через `soon()`). Структура ключей: `list` · `team(t)` · `local(t)` · `conflicts(t)` · `flow(t, name)` · `projects(t)` · `project(t, p)` · `doc(t, p, name)` · `history(t, p, doc?, limit?)` · `tasks(t, p)` · `comments(t, p, id)` · `sprints(t, p)`.

Хуки: `useTeams(enabled?)`, `useTeam(team)`, `useTeamLocal(team)`, `useTeamConflicts(team, enabled?)`, `useTeamFlow(team, name)`, `useProjects(team)`, `useProject(team, project)`, `useDoc(team, project, name)`, `useHistory(team, project, { doc?, limit? })`, `useTasks(team, project)`, `useComments(team, project, id)`, `useSprints(team, project)`. Аргумент `undefined` выключает запрос. `useTeam` и `useTeams` перечитываются сами: раз в 5 с, пока `sync.state` — `pushing` или `pending` (отправка через 3 с после записи события не шлёт), иначе раз в 30 с — как фоновый pull сервера, чтобы «синхронизировано N с назад» и чужие изменения не отставали.

Функции (все отдают типы из `src/api-types.ts`): `fetchTeams`, `fetchTeam`, `checkTeamRemote(url)`, `createTeam({ url, title, prefix })`, `joinTeam({ url, addMe? })`, `updateTeam(team, TeamPatch)`, `removeTeam(team, force?)` (409 `unpushed` → `err.data.commits`), `syncTeam(team)`, `fetchTeamLocal`, `updateTeamLocal(team, { repoPaths?, projectSpaces? })` (null снимает ключ), `fetchTeamConflicts`, `keepTheirs(team, id)`, `keepMine(team, id)`, `fetchTeamFlow`, `saveTeamFlow(team, name, yaml)`, `fetchProjects`, `createProject(team, NewProject)`, `fetchProject`, `updateProject(team, project, ProjectPatch)`, `fetchDoc`, `saveDoc(team, project, name, DocWrite)` (целиком `{ text, base? }` или раздел `{ text, section, hash?, message? }`), `fetchHistory`, `fetchTasks`, `fetchTask`, `createTask(team, project, NewTask)`, `createTasks(team, project, NewTask[])`, `updateTask(team, project, id, TeamTaskPatch)`, `deleteTask`, `moveTask(team, project, id, TeamTaskMove)`, `fetchComments`, `addComment`, `fetchSprints`, `createSprint(team, project, NewSprint)`, `startSprint(team, project, n, body?)`, `closeSprint(team, project, n, { next? })`. Типы: `TeamPatch`, `ProjectPatch`, `NewProject`, `NewTask`, `NewSprint`, `DocWrite`, `TeamFlowView = TeamFlow<FlowSpec>`.

После мутации волне 3 достаточно `qc.invalidateQueries({ queryKey: teamKeys.all })` (или точнее — `teamKeys.tasks(t, p)`); событие `team` после коммита сделает то же само.

## Экраны (`web/src/screens/teamwork/`)

- `TeamsScreen.tsx` — список (`TeamRow`: название-ссылка на всю строку, префикс, строка синхронизации без действий, репо и участники, проекты строкой) и `CreateForm` (поля переживают уход с экрана через `useMemoryState`; ссылка проверяется `useRemoteCheck`; 409 `is_team` предлагает подключиться).
- `JoinDialog.tsx` — ссылка, найденная команда (название, префикс, формат, участники), галочка «Добавить меня», репо кода проектов, «Подключиться» → `onJoined(TeamDetail)`.
- `TeamScreen.tsx` — шапка (крошки, название, репо · префикс, `SyncLine`, `People`), вкладки; `ProjectsTab` (строки с `SprintStrip` по `sprint.counts`, архив внизу, `NewProjectForm` — slug, название, суть, репо кода строками), `MembersTab` («Добавить меня», если меня нет среди участников; предупреждение без `user.email`), `ProcessTab` (список flow, `YamlEditor` из `screens/flow/`, «Сохранить» → `PUT …/flows/:name`; чужая правка после pull подхватывается в чистый редактор, с правками — предупреждение), `SettingsTab` (название, названия колонок, flow для «В работу», путь клона, «Отключить команду…» с переспросом про неотправленные коммиты).
- `ProjectScreen.tsx` — шапка (крошки, название, суть, `SyncLine` команды, `People`, меню ⋯: «Переименовать…» — диалог названия и сути, «В архив…»/«Вернуть из архива»), вкладки со счётчиками (`docs/` и бэклог) и синей точкой на «Доске», когда по задачам работает агент; `TaskDrawer` для `?task=`.
- `OverviewTab.tsx` — активный спринт (полоса, счётчики по названиям колонок команды, очки) или «Спринт не запущен» с подсказкой `noSprintText`; «Агенты по проекту» (только когда у задач есть `work`: `workBadge`, ссылка на запуск или сессию); документы (`updatedText`, размер `docSize`, `docs/` списком); репо кода («Указать папку»: поле + `PickDirButton` → `PUT …/local { repoPaths }`); «Моё пространство для проекта» (`SpacePicker` compact → `PUT …/local { projectSpaces }`, «Сменить», «Снять»); лента команды (`GET …/history?limit=10`).
- `SyncLine.tsx` — `syncLine()` из `lib/teamwork/sync.ts`; клик по тексту — `POST …/sync`; «Повторить» — то же; «Разобрать» — `onResolve`; «Обновить agentgraph» — подпись со ссылкой на плашку в сайдбаре (без своего действия).
- `ConflictsDialog.tsx` — конфликты группами по задаче или документу, у каждого «Взять мою» / «Оставить версию команды» (по умолчанию команды), для `sprint` — только версия команды; «Сохранить решение» применяет по порядку (`keepMine` / `keepTheirs`) и сбрасывает кэш.
- `useRemoteCheck.ts` — проверка ссылки с паузой 600 мс, только когда строка похожа на ссылку (`urlLooksComplete`).
- `parts.tsx`, `Teamwork.module.css` — общее, см. ниже.

## Заглушки волны 3 и их props

| Файл | Props | Что уже показывает |
|---|---|---|
| `docs/DocTab.tsx` | `{ team: string; project: string; doc: TeamDocName }` | имя файла, знаков, разделов (`useDoc`) |
| `docs/DocsListTab.tsx` | `{ team: string; project: string }` | имена файлов из `docs/` |
| `tasks/BacklogTab.tsx` | `{ team: string; project: string }` | число задач без спринта |
| `tasks/BoardTab.tsx` | `{ team: string; project: string }` | активный спринт и прогресс |
| `tasks/SprintsTab.tsx` | `{ team: string; project: string }` | число спринтов и закрытых |
| `tasks/TaskPanel.tsx` | `{ team: string; project: string; id: string; onClose: () => void }` | номер, заголовок, × закрыть (внутри `TaskDrawer`, который уже даёт затемнение, Esc и клик мимо) |

Заглушка — компонент `Stub` из `parts.tsx` с текстом «Будет в следующей волне: …». Заменяйте содержимое файлов, не меняя props: `ProjectScreen.tsx` их уже подключает. `TeamProject` и `TeamTask[]` экран проекта уже держит в кэше (`useProject`, `useTasks`) — повторные хуки в вкладках не дают лишних запросов.

## Что волне 3 брать готовым

- `parts.tsx`: `Who` (инициалы участника или email; без обоих — пунктирный «без исполнителя»), `People` (ряд участников с «+N»), `SprintStrip({ counts, label, big? })` (ячейки по `STRIP_ORDER`, классы `st.done/review/in_progress/todo` — те же, что у макета доски), `Tabs`/`TabItem` (подчёркнутые вкладки-ссылки со счётчиком и точкой), `Crumbs`, `Stub`, `ErrorLine`, `cx`.
- `Teamwork.module.css`: `.dot` (`.s6`, тоны `.ok .wait .fail .off`), `.who`, `.meta`, `.cap`, `.note` (тоны), `.rows`, `.hrun*` (строка агента, как на макете Board/Overview), `.doc`, `.f` (поля вне `.form`), `.dlg`/`.dlg-body`/`.foot`/`.opts`/`.opt`/`.val` (диалоги), `.drawer` (панель задачи), `.strip`/`.st`, `.t-wait .t-ok .t-fail`. Новые модули рядом с вкладками — обычное дело; общие классы лучше импортировать отсюда, чем копировать.
- `shell.ts`: адреса и вкладки (выше), `initialsOf`, `remoteLabel`, `PREFIX_RE`, `SLUG_RE`, `conflictValue`, `conflictKindText`.
- `SyncLine` и `ConflictsDialog` — для шапки документа и любых экранов, где нужна строка синхронизации; `unsavedLine()` из `lib/teamwork/sync.ts` для несохранённого раздела в неё пока не подключён (документов ещё нет).
- `YamlEditor` (`screens/flow/YamlEditor.tsx`) — как редактор markdown-раздела не годится (режим YAML); для документов нужен свой с `@codemirror/lang-markdown` (его пока нет в зависимостях — обосновать в коммите).

## Английский словарь

`web/src/i18n/en/teamwork.ts` — все ключи экранов оболочки и все `t()` из `web/src/lib/teamwork/*.ts` (волна 1 их не переводила). Ключи, которые уже есть в других словарях с тем же смыслом (`Готово`, `Документы`, `Обзор`, `Сохраняю…`, `запуск`, `сессия`…), не дублируются. `Команда` в `compose.ts` переведено как «Command», поэтому подпись вкладок команды идёт с контекстом: `t('Команда', undefined, 'team')`.

## Правки вне своих файлов

- `web/src/components/shell/useHomeEvents.ts` — событие `team` → `soon(teamKeys.all)` и выход (запусков оно не касается). 3 строки.
- `web/src/i18n/en/index.ts` — подключён словарь `teamwork`.
- `.claude/launch.json` — временные конфигурации `tw-api`/`tw-web` на время проверки убраны, файл в исходном виде.

Файлы волны 1 не трогались.

## Замечания соседям

- core: при конфликте одного поля задачи сервер записывает вторым конфликтом `updatedAt` (`ours`/`theirs` — две метки времени с разницей в 100 мс). В диалоге это шум; лучше сливать `updatedAt`/`updatedBy` как максимум без конфликта.
- core: `POST /sync` и отложенная отправка не шлют событие `team` после успешного push — строка синхронизации узнаёт об этом только перечиткой (отсюда опрос раз в 5 с в `useTeam`). Событие после push сняло бы опрос.
- ui-logic: `deps.ts` зовёт `t('Цикл')` для колонки графа, а в `flow.ts` этот ключ переведён как «Loop»; на английском колонка будет «Loop». Нужен контекст: `t('Цикл', undefined, 'deps')` плюс ключ `Цикл#deps` в словаре.
- spec §11 говорит про «Клонировать» у ненайденного репо кода — маршрута для клонирования нет, кнопки нет; только «Указать папку».

## Не проверено

- Настоящие GitHub/GitLab по https/ssh: проверялось только на `file://` bare-репо; ошибки доступа (`pending` с текстом ошибки) видел только по коду `syncLine()` и его тестам, живьём не воспроизводил.
- Состояние `pushing` живьём не поймано (отправка быстрая); `readonly` и блок «Агенты по проекту» проверены на подменённых данных кэша (`__agentgraphQuery.setQueryData`), не от сервера.
- Конфликты `text`, `deleted` и `sprint` в диалоге — только по коду; живьём был конфликт `field`.
- Узкий экран (≤ 800 px) — только правила в CSS, в браузере не смотрел.
- Тестов на `screens/teamwork/shell.ts` нет: `npm test` берёт только `web/src/lib/**`, а `lib/teamwork/` — папка волны 1.
