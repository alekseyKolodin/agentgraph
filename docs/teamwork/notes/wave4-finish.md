# Отчёт сессии finish (волна 4): доводка Teamwork

Ветка `claude/tw-finish-4fffee` от `teamwork` (`2e53dac`), не слито и не отправлено. `npm run typecheck && npm test && npm run build:web`
зелёные. Проверено живьём в браузере (сервер на песочной папке настроек и `AGENTGRAPH_HOME`, команда на bare-репо через `file://`,
репо кода — локальный git с origin `git@github.com:acme/billing.git`; Vite с HMR поверх). Скриншоты — в общей папке заметок сессий:
`finish-home-my-tasks-en.jpg`, `finish-home-my-tasks-ru.jpg`, `finish-draft-review-en.jpg`, `finish-conflicts-en.jpg`.

## 1. «Мои задачи» на главной (spec §11)

**Сервер.** `GET /api/teams/mine` → `TeamMine` (`src/api-types.ts`, сразу после `TeamDetail`):

```ts
type TeamMineTeam = Pick<TeamDetail, 'slug' | 'title' | 'prefix' | 'flows'> & { columns?; defaultFlow?; me?: string; error?: string };
type TeamMineProject = { team; slug; title; sprint: { number; title }; repos: TeamRepoRef[] };
type TeamMineTask = { team; project; task: TeamTask; waiting: string[] };
type TeamMine = { teams: TeamMineTeam[]; projects: TeamMineProject[]; tasks: TeamMineTask[] };
```

`TeamService.mine()` (`src/teamwork-server.ts`, рядом с `listTeams`): все команды (`teams` — и те, где `teamwork.yaml` не читается, с
`error`), для каждой — `me` по `git config user.email` клона; задачи активного спринта каждого активного (не архивного) проекта, где
`assignee` совпадает с `me` без учёта регистра; `waiting` — предшественники не в «Готово» (как `openBlockers` доски); у задачи —
`work` с живыми статусами (как в `GET …/tasks`). Репо кода проектов — с моими папками, как у `TeamProject.repos`: `local.json`, иначе
один обход проектов дашборда на все ссылки (`findLocals`). Фонового pull маршрут не тянет (главную открывают часто). Маршрут стоит до
`/api/teams/:t`, поэтому слаг `mine` зарезервирован: `freeTeamSlug` (`src/teamwork-repo.ts`) даёт репо `mine.git` слаг `mine-2`
(заодно `check` и `join`).

**UI.** `web/src/screens/teamwork/MyTasks.tsx` (+ `MyTasks.module.css`), экспорт из `screens/teamwork/index.ts`; `HomeScreen` грузит его
лениво (тот же чанк экранов Teamwork) и только когда `teams.length > 0`; запрос — `useTeamMine(useFeature('teamwork'))` в
`web/src/api/teamwork.ts`, ключ `teamKeys.mine = ['teams', 'mine']` — событие `team` сбрасывает его вместе с остальным кэшем; пока у
моих задач есть `work`, опрос раз в 30 с (смена «идёт → ждёт ответа» события `team` не даёт). Строка: номер, заголовок (ссылка
`/teamwork/<t>/<p>/board?task=ID`, клик по строке — то же, клики внутри меню и формы «В работу» не считаются), «команда · проект ·
спринт», колонка, «ждёт PAY-3», мой запуск или сессия по задаче (`workBadge`), «Ответить» у ждущей, `ToWorkButton` (то же правило, что на
карточке доски; у команды с форматом новее — `TeamMineTeam.readonly` — кнопки нет). Порядок и подписи — `web/src/lib/teamwork/mine.ts` (+ тест): сначала ждущие ответа и упавшие, потом «В работе»,
«Ревью», «К работе»; готовые — только числом «Уже готово: ещё N задач». Задач нет — строка со ссылкой на команду; команда без моего
email — подсказка с `git config`.

`ToWork.tsx`: props `ToWorkButton`, `ToWorkDialog`, `workMenu` сужены до `WorkTeam = Pick<TeamDetail, 'slug' | 'defaultFlow' | 'flows'>` и
`WorkProject = Pick<TeamProject, 'slug' | 'repos'>` — экран проекта передаёт то же, главная — объекты из `TeamMine`.

**Запуск по задаче на главной** (хвост wave2-work): `HomeRun.teamwork` (`liveRuns` в `src/server.ts`) — в строке идущего запуска номер
задачи ссылкой на её панель, у черновика — «черновик ТЗ / архитектуры / разбивка ТЗ» ссылкой на вкладку (`runTeamworkLink` в
`screens/teamwork/shell.ts`, там же `taskBoardPath`). На странице запуска строка «Задача: PAY-2 — …» теперь тоже ссылка на задачу. В
списке запусков сайдбара и в «Задачи и код» ничего не менялось (там `source.type: 'teamwork'` не показывался и не показывается).

Тесты: `src/server.teamwork.test.ts` «мои задачи: …» (пусто без активного спринта, запланированный спринт не считается, чужие и бэклог
не входят, `waiting` и его снятие, репо с папками как у проекта, архив; слаг `mine-2`); `src/server.teamwork.work.test.ts` — у идущего
запуска по задаче в `/api/home` есть `teamwork`.

## 2. Диалог выхода (spec §7.5)

Как сейчас данные приходят: `main.ts` после старта сервера динамически импортирует `sessions-server.js` → `liveSessionNames()`. Тот же
путь для Teamwork: `teamwork-server.js` → `unsentTeams()` (команды с коммитами, которых нет в репо команды: `slug`, `title`, `unpushed`,
`error` из строки синхронизации) и `pushTeams(slugs)` (`service.sync` каждой). Текст и кнопки — чистая функция `quitPrompt` в
`src/quit-dialog.ts` (без Electron, тест `src/quit-dialog.test.ts`; туда же переехал `sessionsLine`):

- только сессии — как было: «Завершить сессии и закрыть» / «Отмена», абзац про состояние пространства;
- неотправленные изменения — «Не отправлено в Teamwork: «Платежи» — 3 изменения (<причина одной строкой, до 120 знаков>)…» и кнопки
  «Отправить и закрыть» (по умолчанию) / «Закрыть без отправки» / «Отмена»; вместе с сессиями — оба абзаца и «Отправить, завершить
  сессии и закрыть»;
- «Отправить…» синхронизирует команды (не дольше 20 с) и выходит, если всё ушло; не ушло — тот же диалог с заголовком «Изменения
  Teamwork не отправились», без «Отправить», по умолчанию «Отмена».

`before-quit` теперь откладывает выход всегда (коммиты считает git, асинхронно; подсчёт ограничен 3 с), спрашивать не о чем — выходит
сразу; диалог не открылся (исключение) — выходит, как раньше без вопроса. SIGTERM/SIGINT и перезапуск после автообновления
(`quitConfirmed`) по-прежнему без вопроса.

**Не видел живьём**: Electron не запускал. Проверены чистая функция и `unsentTeams`/`pushTeams` на настоящем git (тест «мои задачи…»:
неотправленное видно до `pushTeams` и пропадает после). Строка «не отправлено» с ошибкой сети в UI проверена живьём (bare-репо убран и
возвращён, «Повторить»).

## 3. Подписи статуса черновика

`draftLine` (`web/src/lib/teamwork/doc-view.ts`): `waiting` — «Черновик ждёт вашего ответа» (кнопка «Ответить в запуске»), `paused` —
«Черновик на паузе» (раньше тоже «ждёт ответа», а кнопка звала отвечать), неудача — «Черновик не получился: <причина>» через новый
`draftStopText`: `interrupted` — «agentgraph остановили, пока он шёл», `aborted` — «запуск остановили», `failed` — «запуск упал с ошибкой»,
`budget_exceeded` — «кончился лимит стоимости», остальное — `statusLabel`. Разбивка (`SplitReview.tsx`): идущая на паузе — «Разбивка ТЗ
на паузе» (янтарная точка); закончилась без задач — «Задач нет: <причина>.» вместо сырого «со статусом «interrupted»». Тесты — в
`doc-view.test.ts`. Живьём — поддельный черновик архитектуры со статусом `interrupted` и готовый черновик ТЗ в `runs/` песочницы.

## 4. Английский

Прошёл глазами на английском (сбор кириллицы со страницы скриптом: текст, `title`, `aria-label`, `placeholder`, значения полей): список
команд и форма создания, диалог подключения с найденной командой, команда (проекты, форма проекта и выбор репо, участники, процесс,
настройки), обзор проекта, ТЗ (чтение, правка раздела строками требований, «С агентом…», «История»), рецензия черновика ТЗ, строка
упавшего черновика на архитектуре, документы, бэклог с предложением разбивки (граф), доска, панель задачи, «В работу ▸» и форма запуска с
главной, спринты, строка синхронизации «не отправлено · Повторить» (настоящая ошибка push), диалог конфликтов (поле и текст), «Мои задачи»,
строка идущего запуска с задачей, страница запуска. Кириллица осталась только в данных (заголовки, тексты, сообщения коммитов,
описания flow команды, названия колонок в полях настроек).

Исправлено:
- названия колонок: шаблон пишет в `teamwork.yaml` русские «К работе / В работе / Ревью / Готово», и английская доска, обзор, панель
  задачи, «Переместить…», поля требований показывали их по-русски. `columnName(s, columns)` в `lib/teamwork/board.ts`: название шаблона —
  переводом, своё название команды — как есть (тест); через него `columnText`, заголовки колонок доски, счётчики обзора, `columnMoves`,
  `taskWhere`;
- дата спринта «started 12 нояб. 2026 г.» — `toLocaleDateString(undefined)` → `locale()` интерфейса (`SprintsTab.tsx`);
- «To work ▸» → «Start work ▸» (в настройках команды уже было «Start work»); «Cover no requirement», «can start now 0», «wait for current
  tasks 0» → «Cover no requirements», «ready to start: 0», «waiting on existing tasks: 0»; двойное двоеточие в строке упавшего черновика;
- подсказка меню «В работу» у проекта без репо звала «в настройки проекта», а репо добавляются на обзоре — исправлен русский ключ и
  перевод;
- `aria-label` «Участники: {names}» не было в словаре;
- дерево «Что попадёт в репо» в форме создания: `padEnd(28)` при имени файла в 28 знаков — имя слипалось с описанием (`padEnd(30)`).

Тест `web/src/lib/teamwork/i18n.test.ts`: ключи из `t('…')`, `t('…', vars, 'ctx')` (ключ `…#ctx` или запасной), `plural(n, 'a', 'b', 'c')`
и `t(MAP[x])` (значения объекта `MAP` того же файла) во всех файлах `web/src/screens/teamwork/**` и `web/src/lib/teamwork/**` — у каждого
есть английский; свой тест на сборщик ключей. Не ловит `t(переменная)` с ключом из массива объектов — таких в Teamwork нет, кроме
`DEFAULT_COLUMNS`, который передаётся как `t(DEFAULT_COLUMNS[s])`.

Убрано из `web/src/i18n/en/teamwork.ts` (17 ключей): три ключа core-fixes (заметки про ссылку «как для git clone», «добавить можно в
настройках проекта (⋯)», «Папки … укажете на обзоре проекта»), тексты заглушек волны 3 и сама `Stub` из `screens/teamwork/parts.tsx`
(нигде не использовалась) со стилем `.stub`, «Задачи нет», короткий вариант «Не найден на этом компьютере — …», заменённые «Черновик не
получился» и «Запуск закончился со статусом…». Мой блок новых ключей — `// --- finish (волна 4)` перед блоком core-fixes, в середине
файла, чтобы не сталкиваться с блоком polish в конце; порядок файла не менялся.

## 5. Документация

- `docs/REFERENCE.md`: раздел «Teamwork: a team's projects in a shared git repo» перед «Flow analysis» — команда, хранилище и guard,
  проект, синхронизация и конфликты, диалог выхода, документы, черновики, бэклог/спринты/доска, «Start work», инструменты сессии
  `team_task_update`/`team_doc_write`, «My tasks»; таблица всех маршрутов `/api/teams*` с телами и типами ответов и кодами 409 (teams,
  check, join, mine, `:t`, sync, conflicts, local, repo-info, flows, projects, docs, history и `history/:hash`, tasks, move, comments, intake,
  worktree, sprints, drafts и accept); `POST /api/runs` с `teamFlow`/`teamwork`, `RunSource.type: 'teamwork'`, `RunSummary`/`HomeRun.teamwork`,
  `POST /api/sessions` с `teamwork`, событие `team`, фича `teamwork`. Пункт «Teamwork» в описании сайдбара и «My tasks» в описании главной.
- `docs/GETTING_STARTED.md`: подраздел «Work as a team: Teamwork» в «Everyday use»; в таблице модулей — дополнена строка
  `src/teamwork-server.ts` (mine, repo-info, conflicts, history/:hash, unsentTeams/pushTeams), `src/desktop/main.ts`, новые строки
  `src/quit-dialog.ts`, `web/src/api/teamwork.ts`, `web/src/screens/teamwork/`, `…/docs/`, `…/tasks/`, `web/src/lib/teamwork/`; в строке
  `web/src/screens/` — `teamwork/`. Строки остальных `src/teamwork*.ts` уже были (волны 1–3).
- `README.md`: строка «Plan a feature as a team (Teamwork)» в «More things people use it for».

## Правки вне своих файлов

- `src/teamwork-repo.ts` (polish): `RESERVED_TEAM_SLUGS` и одно условие в цикле `freeTeamSlug` — 3 строки, далеко от номеров задач.
- `src/teamwork-server.ts` (polish правит создание задач и запись документов): метод `mine()` после `listTeams`, строка маршрута
  `/api/teams/mine` перед `/api/teams/check`, импорт двух типов; `TeamUnsent`, `unsentTeams`, `pushTeams` перед `TeamworkRouteDeps`.
  Задачи и документы не трогал.
- `src/server.ts`: одна строка в `liveRuns` (`teamwork`).
- `src/api-types.ts`: `TeamMine*` после `TeamDetail`, `HomeRun.teamwork`; существующие поля не менялись.
- `web/src/i18n/en/teamwork.ts`: свой блок в середине, правки существующих строк перевода, удалённые ключи (выше).
- `web/src/screens/teamwork/tasks/` (ui-tasks): `ToWork.tsx` (типы props, ключ подсказки без репо), `parts.tsx` (`columnText` через
  `columnName`), `BoardTab.tsx` (заголовок колонки), `SplitReview.tsx` (подписи), `SprintsTab.tsx` (локаль даты).
- `web/src/screens/teamwork/docs/DocTab.tsx` (ui-docs): «Ответить в запуске» только у `waiting`.
- `web/src/screens/teamwork/` (ui-shell): `OverviewTab.tsx` (счётчики колонок), `TeamsScreen.tsx` (`padEnd`), `parts.tsx` и
  `Teamwork.module.css` (убрана `Stub`), `shell.ts` (`taskBoardPath`, `runTeamworkLink`), `index.ts` (экспорт `MyTasks`).
- `web/src/lib/teamwork/` (ui-logic): `board.ts` (`columnName`), `doc-view.ts` (`draftStopText`, `draftLine`), `task.ts` (`columnMoves`)
  и их тесты; новые `mine.ts`, `i18n.test.ts`. `deps.ts` (polish) не трогал — его подписи поправил только в словаре.
- `web/src/screens/home/` (`HomeScreen.tsx`, `HomeRuns.tsx`, `Home.module.css`), `web/src/screens/run/RunScreen.tsx`, `web/src/api/teamwork.ts`.
- `.claude/launch.json` — временные `tw-finish-api`/`tw-finish-web` на время проверки убраны, файл в исходном виде.

## Не проверено

- Диалог выхода в Electron (`desktop:dev` не запускал): только чистая функция и `unsentTeams`/`pushTeams` в тесте.
- Живой запуск или сессия из «Start work ▸» на главной (тратит деньги): форма открылась, worktree создан по-настоящему, «Отмена»;
  строки идущих запусков с задачей на главной — на подменённом кэше `['home']` (`__agentgraphQuery`), ссылки проверены кликом.
- «Ждёт ответа» у задачи на главной (нужен живой запуск с вопросом): порядок и подпись — тестом `mine.test.ts`; упавший запуск — живьём
  на поддельном `run.json`.
- Пустые состояния «Моих задач» (задач нет, git без email) — на подменённом кэше `['teams','mine']`, не от сервера.
- `scripts/check-sdk-hooks.mts` не запускал: guard и права сессий не трогались.

## Замечания на потом

- Ошибка сети в строке синхронизации начинается с «git -c:» (`exec` в `src/git.ts` подписывает ошибку первым аргументом, а
  `TeamRepo.git` передаёт первым `-c core.quotePath=false`). То же уходит в диалог выхода. Лучше брать первый аргумент не-опцию.
- Шаблон репо команды (`templates/teamwork/`: названия колонок, заготовки документов, flow) и сообщения коммитов сервера — на русском;
  английский интерфейс показывает их как данные. Названия колонок шаблона UI переводит, остальное — нет.
- В поле «Названия колонок» настроек на английском видны русские названия из файла — это значения в репо команды, их правка меняет их для
  всех.
