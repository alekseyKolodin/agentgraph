# Финальное ревью ветки `teamwork` (после UX-прохода, `da2b1c3`)

Три независимых ревью `code-reviewer` только на чтение, диапазон `9be0663..teamwork`. На момент ревью `npm run typecheck`,
`npm test` (1280) и `npm run build:web` зелёные. Вердикт всех трёх — «после правок». Номера ниже — для брифов волны исправлений:
`D-*` — данные и синхронизация, `W-*` — веб, `S-*` — права агентов и сервер.

## D — данные и синхронизация (`src/teamwork*.ts`, `src/git.ts`, `src/quit-dialog.ts`)

D-1…D-5 и D-12 воспроизведены на настоящих клонах с bare-репо; скрипты — `exp1.mts`…`exp4.mts` в scratchpad оркестратора
(`/private/tmp/claude-501/-Users-aleksey--claude-spares-spare-8cRbWb/73cae633-0b16-41c6-905b-15a5ea53f0f4/scratchpad/exp/`).

- **D-1 high — replay портит бинарные файлы и молча удаляет то, что не смог прочитать.** `src/teamwork-repo.ts:524-529` (`show`),
  `:604`, `:621`, `:656-658`; `src/git.ts:48` (stdout как UTF-8). Картинка в `projects/p/docs/` + конфликт задачи в той же пачке
  → png переписан строкой (15 → 25 байт) и уходит команде. Ещё: файл > 32 МБ или ошибка `show` → `null` → файл удалён;
  `--name-status` без `-z` (имена с табом/переводом строки в кавычках) → удалён; смена типа (`T`) не разбирается.
  Исправление: файлы, которые менял только я, — без текста (`checkout <head> -- <file>`/`rm`/`update-index --cacheinfo`);
  бинарный файл, изменённый обеими сторонами (`--numstat` даёт `-`), — сразу в конфликт; ошибка `show` — исключение;
  `--name-status -z`; `.gitignore` с `.DS_Store` в `templates/teamwork` (иначе `commitManual` разносит его всем).
- **D-2 high — прерванный rebase: маркеры конфликта уходят в репо команды, клон не восстанавливается.** `src/teamwork-repo.ts:362-376`
  (`commitManual`), `:454-487`, `:502-516`. Выход/сбой, пока `git rebase` стоит на конфликте → при следующем запуске `add -A`
  коммитит `<<<<<<<` в detached HEAD, `merge-base == remote` → пуш; мои коммиты после конфликтного остаются только в
  `refs/heads/main`, `unpushed()` от HEAD = 0, строка синхронизации «ok», `.git/rebase-merge` навсегда; «Отключить» без force
  удалит их без вопроса. Исправление: в начале `write`/`syncNow` — при `rebase-merge`/`rebase-apply`/`MERGE_HEAD`/`CHERRY_PICK_HEAD`
  (`git rev-parse --git-path …`) делать abort; при непустом `git ls-files -u` не коммитить; detached HEAD → `checkout <branch>`.
  Тест: клон посреди rebase → `sync()`.
- **D-3 high — списки сливаются целым значением.** `src/teamwork.ts:774-793` (`mergeRecords`): `members`, `blockedBy`, `covers`,
  `repos`, `columns`. Двое одновременно подключаются с «добавить меня» → у второго конфликт `members`, любая кнопка диалога кого-то
  теряет (воспроизведено: 3 участника вместо 4). Так же одновременные добавления в `blockedBy`. Исправление: трёхстороннее слияние
  множеств (добавленное обеими — объединить, удалённое любой — убрать); `members` по email, `repos` по key; `columns` и
  `lastRequirement` — по вложенным ключам; конфликт — только если один элемент изменён по-разному.
- **D-4 medium — при переименовании своей задачи комментарии остаются на старом номере.** `src/teamwork-repo.ts:606-618`, `:721-732`.
  Моя PAY-2 стала PAY-3, а `comments/PAY-2/…` ушёл всем как комментарий к чужой PAY-2. Переносить мои добавленные файлы
  `comments/<old>/` → `comments/<new>/`.
- **D-5 medium — удаление против правки: в конфликт попадает только файл задачи.** `src/teamwork-repo.ts:620-630`, `deleteTask` в
  `src/teamwork-server.ts:1074-1083`. Я удалил PAY-1 (файл, комментарии, `blockedBy` у PAY-2), коллега правил PAY-1 и отправил первым
  → PAY-1 осталась, комментарии удалены у всех, PAY-2 больше не ждёт PAY-1. При конфликте `deleted` не применять удаление
  комментариев и правки `blockedBy` из того же удаления; мой комментарий к задаче, которую удалили они, — в конфликт.
- **D-6 medium — replay не атомарен.** `src/teamwork-repo.ts:655-677`: `reset --hard remote` до записи и коммита, конфликты в
  `local.json` — после коммита. Сбой/ошибка коммита (`commit.gpgsign`, ENOTDIR) посередине → мои коммиты только в reflog, конфликты
  не сохранены, следующий `commitManual` отправит частичный набор. Собирать коммит без HEAD (временный `GIT_INDEX_FILE`,
  `hash-object -w`, `write-tree`, `commit-tree`), сохранить конфликты, потом `reset --hard <новый>`.
- **D-7 medium — без merge-base replay считает «моим» всё дерево.** `src/teamwork-repo.ts:507`, `:515` (`.catch(() => '')`).
  Переписанная история / пересозданный репо → `replay(remote, head, remote)` откатывает репо команды к моему снимку. Нет
  merge-base — ошибка синхронизации «история репо переписана, подключитесь заново», без replay и push.
- **D-8 medium — новый `format` блокирует только запись через API, синхронизация всё равно переписывает и пушит.**
  `src/teamwork-repo.ts:454-487`, `:681-791`. Если после fetch `origin:teamwork.yaml` новее известного формата — только
  fast-forward, без replay/rename/demote/push; показать «обновите agentgraph».
- **D-9 medium — вложенные неизвестные поля теряются при записи (spec §5.9).** `src/teamwork-repo.ts:1050` (`joinTeam` переписывает
  `members` из `parseMembers`), `src/teamwork-server.ts:346` (members), `:684-688` (repos), `:321-331` (columns — 4 ключа),
  `:776-779` (`lastRequirement` — FR/NFR); `src/teamwork.ts:307-322` (`pr`/`blockedBy` неожиданного вида молча исчезают). Править
  элементы по месту через `parseDocument`; известное поле неожиданного вида → `error` у задачи, а не нормализация.
- **D-10 medium — PATCH настроек и репо проекта перезаписывает весь список без base.** `src/teamwork-server.ts:333-361`, `:684-688`.
  Pull принёс участника, сохраняю форму настроек → участник удалён у всех; `columns` считаются от `config()` вне очереди. `base`
  (хэш файла) с 409 или патч по элементам внутри mutate. Связано с W-8.
- **D-11 medium — отключение команды.** `src/teamwork-repo.ts:865-872`: `unpushed()` вне очереди и до `stop()`; нерешённые
  `conflicts[].ours` не входят в предупреждение. Сначала `stopped = true` и дождаться цепочки, потом считать; при отказе вернуть
  таймеры.
- **D-12 low — `rankNear` при равных соседях.** `src/teamwork-server.ts:1054`, `src/teamwork.ts:442-450`: A(l), B(l), C(p), D(s),
  X между A и B → ранг `t`, X в самом конце. Верхняя граница — ближайший ранг больше `after` (как в `createTasks`) или переранжировать.
- **D-13 low — конфликт поля спринта нельзя решить «моё».** `src/teamwork-repo.ts:639` (kind `sprint`), `src/teamwork-server.ts:455`,
  `web/src/screens/teamwork/ConflictsDialog.tsx:40`. Kind `field` для полей; `sprint` — только для `demoteSecondSprint`.
- **D-14 low — после переименования номера остаются ссылки на старый.** `renameDuplicateIds` (`src/teamwork-repo.ts:734`) правит
  `blockedBy` только в моих добавленных файлах; живые запуски держат старый `teamwork.task`, `ended()` (`src/teamwork-status.ts:224-241`)
  переведёт в «Ревью» чужую задачу с тем же номером.
- **D-15 low — очередь после `stop()`/`disconnect` ещё принимает операции.** `push`/`pull`/`sync` (`src/teamwork-repo.ts:429-446`)
  не проверяют `stopped`; `saveLocal` в catch заново создаёт `teams/<slug>/local.json` → следующее подключение получает `<slug>-2`.
- **D-16 low — выход из приложения.** `within(d.unsent(), 3_000, [])` (`src/quit-dialog.ts:96`): при таймауте выходим без вопроса;
  `stopTeamworkStatus()` (`src/server.ts:289`, `src/teamwork-status.ts:347-348`) ждёт без срока опрос PR за fetch до 120 с.
- **D-17 low — закрытие спринта одновременно с переносом в него.** Незавершённая задача остаётся в закрытом спринте, не видна ни
  в бэклоге, ни на доске. В `afterIntegrate` возвращать такие задачи в бэклог.
- **D-18 low — `team_doc_write` пишет документ целиком без base.** `src/teamwork-work.ts:269`. Запомнить HEAD клона на старте
  сессии; при записи, если документ менялся, — `mergeText(doc@start, text, current)` или ошибка «перечитай» модели. (= S-6)

Проверено, ок: одна очередь git на команду, mutate и проверки `base`/`hash` внутри неё; откат рабочей копии при ошибке; нет
сети / push отклонён → коммиты остаются, повторы 5 с…5 мин; таймеры `unref`; `mergeStamps`; `lastTask`/`lastRequirement` по max;
повторы номеров задач (кроме D-4, D-14); `rankBetween`/`midpoint` на краях; понижение второго активного спринта одинаково на всех
клонах; новый format → 409 на запись; неизвестные поля верхнего уровня сохраняются.

## W — веб (`web/src/screens/teamwork/**`, `web/src/lib/teamwork/**`)

- **W-1 high — одна упавшая фоновая перечитка сносит экран вместе с вводом.** `ProjectScreen.tsx:55-65`, `TeamScreen.tsx:42-51`
  (`retry: false` в `App.tsx`; React Query v5 при упавшем refetch ставит `error`, сохраняя `data`). Опрос/событие `team`/перезапуск
  сервера/500 во время pull → «Проект не открылся», размонтируются TaskDrawer, ToWorkDialog, SplitReview, диалоги спринтов,
  настройки, YAML «Процесса», форма нового проекта. Полноэкранная ошибка — только без данных (`err && !(td && p)`), с данными —
  `ErrorLine` над вкладками. Тот же шаблон — `docs/DocTab.tsx:90`, `docs/DraftReview.tsx:40`.
- **W-2 high — состояние панели задачи переезжает на другую задачу.** `ProjectScreen.tsx:104` (у `TaskPanel` нет `key`),
  `tasks/TaskPanel.tsx:308-316, 411-435, 154`. «Править» описание PAY-3 → клик по PAY-2 в «Ждёт»/«Блокирует» → «Сохранить»
  перезаписывает описание PAY-2 текстом PAY-3; так же черновик комментария, «+ Зависимость», «+ Критерий». `<TaskPanel key={taskId}/>`.
- **W-3 medium — описание пропадает при ошибке сохранения.** `TaskPanel.tsx:311-315`: `setEdit(undefined)` до ответа; 409/сеть →
  только тост. `if (await ops.patch(...)) setEdit(undefined)`.
- **W-4 medium — Esc и клик мимо панели теряют черновики.** `TaskPanel.tsx:462` (Esc в комментарии стирает текст, а подсказка ×
  — «Закрыть (Esc)»), `ProjectScreen.tsx:120, 128` (затемнение/Esc закрывают панель при открытом редакторе или непустом
  комментарии). Esc в комментарии — только blur; закрытие при несохранённом — `askConfirm` или черновики по (команда, проект, id),
  как `edits.ts`.
- **W-5 medium — «+ Задача» на доске стирает заголовок при ошибке.** `tasks/BoardTab.tsx:283-289`; правильно — `BacklogTab.tsx:96-98`.
  `if (await onCreate(...)) setTitle('')`.
- **W-6 medium — в разбивке не ввести второе требование.** `tasks/SplitReview.tsx:575`: управляемое `covers.join(', ')`, `onChange`
  режет `[\s,]+` → запятая исчезает. Сырой текст в state, разбор на blur.
- **W-7 medium — правки предложения разбивки теряются при смене вкладки.** `SplitReview.tsx:162-172`, `BacklogTab.tsx:150`.
  `proposal`/`off` — в модульном store или localStorage по номеру запуска.
- **W-8 medium — сохранение откатывает чужие правки.** `TeamScreen.tsx:361-377` (настройки: правлю колонку, коллега переименовал
  команду → «Сохранить» шлёт старый title), `ProjectScreen.tsx:199-201` (RenameDialog уносит старую суть). Сбрасывать каждое
  нетронутое поле отдельно, patch — только по полям, изменённым относительно `base`. Связано с D-10.
- **W-9 medium — «Процесс»: несохранённый YAML пропадает без вопроса.** `TeamScreen.tsx:322, 335` (смена flow/вкладки размонтирует
  `YamlEditor`). `askConfirm`, если `editor.value() !== flow.yaml`, или черновик в `useMemoryState` по имени flow.
- **W-10 medium — режим «только чтение» (формат новее) не везде гасит запись.** Меню ⋯ проекта «Переименовать…»/«В архив…»
  (`ProjectScreen.tsx:173-176`), «+ Проект» (`TeamScreen.tsx:93`), «Добавить меня» (`:237`), «Сохранить» flow (`:338`) и настроек
  (`:445`). disabled с `title`, как `agentReason` в DocTab; «Отключить» оставить.
- **W-11 medium — фокус после закрытия не возвращается.** TaskDrawer (`ProjectScreen.tsx:118-125`): после Esc/×/клика мимо фокус в
  body, ловушки фокуса при `aria-modal` нет. Диалоги, снимаемые без `close()`: Start/CloseSprintDialog (`SprintsTab.tsx:178, 272`),
  SplitStart (`SplitReview.tsx:108`), RenameDialog (`ProjectScreen.tsx:190`), CreateTaskDialog (`DocView.tsx:294`), ConflictsDialog,
  JoinDialog, DocDialogs. Решено в `tasks/ToWork.tsx:113-121` — вынести в общий хук.
- **W-12 low — форма «Новый проект» теряет поля при смене вкладки.** `TeamScreen.tsx:134-137`: поля в `useState`, открытость — в
  `useMemoryState`. `useMemoryState` для полей.
- **W-13 low — `'не сохранено'` в `web/src/i18n/en/teamwork.ts:569` перебивает `runart.ts:46` (`'unsaved'`).** Убрать ключ или дать
  контекст `#doc`.
- **W-14 low — одинаковые заголовки разделов.** `DocView.tsx:100`, `SectionEditor.tsx:49-51`, сервер `src/teamwork.ts:513`: клик по
  второму «## Примеры» правит первый. Адресовать по номеру вхождения или запретить правку дубля с подсказкой.
- **W-15 low — мелкие состояния ошибок.** `TaskPanel.tsx:47`: список задач не загрузился → бесконечный спиннер (`?task=` с главной);
  `ProjectScreen.tsx:57-61`: 404 команды → «Проекта X нет». Показывать ошибку `useTasks`, различать `teamQ.error`.

Проверено, ок: только `import type` из `src/`; ключи запросов различают команду/проект/run/doc/hash; оптимистичные переносы
(очередь на задачу, откат к серверу, 409 → `data.current`); инвалидация; правка раздела документа (`edits.ts`); команда без сети;
клавиатура (⌥↑/⌥↓, меню «Переместить…»/«В работу ▸»); `dangerouslySetInnerHTML` только из `renderMarkdown`; слушатели и таймеры
снимаются; i18n (кроме W-13).

## S — права агентов и сервер (`src/teamwork-server.ts`, `src/teamwork-drafts.ts`, `src/teamwork-work.ts`, `src/server.ts`, сессии)

- **S-1 blocker — flow команды выполняется с полными правами пользователя без подтверждения.** `src/teamwork-drafts.ts:302,326`,
  `src/server.ts:2421`, `src/teamwork-server.ts:1271`, `src/runner.ts:1679`. YAML flow пишет любой с push в репо команды
  (§17: «доступ к команде — это доступ к репо»); `readTeamFlow` делает только `parseFlow`. Flow может: `until`/`next` с
  `type: command` (`spawn(cmd, { shell: true })`), `plugins` (хуки, MCP), `tools: [Bash, Write]` без вопроса,
  `permission_mode: bypassPermissions`, `add_dirs: ['~']`, вызовы любых локальных flow. Участник пушит `flows/teamwork-prd.yaml` с
  командой в `until` → фоновый pull приносит его всем → коллега жмёт «Черновик ТЗ» → shell на его машине. То же для «В работу» с
  flow команды. Противоречит §14. Исправление: доверие по хэшу (`local.json` `trustedFlows: { name: sha256 }`; не совпал → 409
  `flow_untrusted` с YAML и диффом, в UI «Доверять этой версии»); минимум без UI — запретить во flow команды `command`-условия,
  `plugins`, `add_dirs`, `permission_mode` кроме `default`/`plan`, блоки-вызовы. Обновить §14.
- **S-2 high — черновик без репо кода стартует с cwd внутри клона команды.** `src/teamwork-drafts.ts:355` (`cwd = project.dir`); в
  `agent.ts` нет `settingSources` → SDK грузит `<cwd>/.claude/settings.json` (hooks, `permissions.allow`,
  `enableAllProjectMcpServers` + `.mcp.json`). Участник коммитит `projects/p/.claude/settings.json` с хуком → выполняется у каждого,
  кто запустит черновик. Из клона грузятся и `.claude/skills` (в §14 нет). Не давать cwd внутри `teamsDir()`: пустая папка в папке
  запуска, `project.dir` — только доп. папкой.
- **S-3 medium — текст участников попадает в промпт вне `source-data`.** `src/teamwork-work.ts:91-93` (имена `docs/*.md`),
  `:55` + `composeInput` (`task.branch` из frontmatter без проверки в `parseTask`, `src/teamwork.ts:320`), `src/teamwork-drafts.ts:361,374,377`
  (`project.title`, `key`, `url`, `defaultBranch` из `project.yaml`, заголовок раздела — inline). Переносить внутрь `wrapModelData`;
  `branch` в `parseTask` — `^[A-Za-z0-9._/-]+$` без ведущего `-`.
- **S-4 medium — черновики экранируют данные слабее задач.** `src/teamwork-drafts.ts:94`: `fillForm` использует `wrapData`, а не
  `wrapModelData`.
- **S-5 medium — slug проекта берётся из файла, а не из имени папки.** `src/teamwork.ts:173` (`str(s) || slug`), использование
  `src/teamwork-server.ts:571,581-583`. Скопированная папка `projects/alpha` → `projects/gamma` отдаёт документы, спринты и
  пространство alpha. В `readProjectConfig` брать slug папки.
- **S-6 medium — `team_doc_write` затирает чужие правки.** = D-18.
- **S-7 low — висячая ссылка проходит проверку выхода за клон.** `src/teamwork-repo.ts:200` (`fs.existsSync` идёт по ссылке);
  `projectDocs` (`src/teamwork-server.ts:654`) читает файлы заготовки напрямую. Проверять компоненты через `lstatSync`.
- **S-8 low — креды из URL в ошибках и API.** Нет `scrub()` в `checkRemote` (`src/teamwork-repo.ts:910,937`) и в catch
  `createTeam`/`joinTeam` (`:1005,:1060`); `TeamSummary.remote` (`src/teamwork-server.ts:196,413`) отдаёт URL с токеном.
- **S-9 low — `remoteProblem` пропускает remote-helper-ы** (`foo::bar`, `hg::…`). `src/teamwork.ts:722-738`: отклонять
  `/^[a-z][a-z0-9+.-]*::/i`.
- **S-10 low — `pr.url` из файла задачи не проверяется** (`src/teamwork.ts:307`): в `parseTask` отбрасывать не-http(s).
- **S-11 low — относительный `cwd` черновика** (`src/teamwork-drafts.ts:349`): требовать абсолютный.
- **S-12 low — `TeamService` создаётся заново во время остановки сервера** (`src/server.ts:389`): флаг остановки → 503.
- **S-13 low — `spaceWriteGuard` не проверяет папку команд в другом регистре** (`src/sessions-server.ts:1328`): добавить `teamsDir()`
  рядом с `tagsDir`.

Проверено, ок: все `/api/teams/*` проходят `requestProblem` (Host 421, Origin 403, JSON 415, тело 5 МБ); пути из запроса (slug
команды/проекта, `docFile`, `history/:hash`, абсолютные `repo-info.path`/`repos[].local`/`repoPaths`, `RUN_ID_RE`,
`artifactProblems`, `abs()` с realpath — кроме S-7); git только `execFile` с массивом, `--` перед URL и путями, URL с ведущим `-`
отклоняется, `checkBranchName`, `--no-verify`, `core.symlinks=false`; `teamsDir` закрыт в `phaseProtectedRoots` и `launchDirs`,
worktree «в работу» вне клона, `team_task_update`/`team_doc_write` спрашивают человека; `teamwork` в `run.json` опциональный.

Guard тронут (`phaseProtectedRoots`, `launchDirs`) — перед слиянием в `main` прогнать `npx tsx scripts/check-sdk-hooks.mts`.
