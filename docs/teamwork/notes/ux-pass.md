# UX-проход по экранам Teamwork: отступы и формулировки

Ветка `claude/tw-ux-pass-2c387d` от `f3338e0`, один коммит, не слито и не отправлено. `npm run typecheck && npm test && npm run build:web`
зелёные (1280 тестов, было 1277; `src/runner.spacequeue.test.ts` один раз упал по таймингу под нагрузкой скриншотов, отдельно и в чистом прогоне зелёный). Независимое ревью `code-reviewer` — см. «Ревью».

Жалоба: «много кнопок, где текст прям к границе без отступа, где-то глоссарий топорный/несуразный». Конкретных мест не было, поэтому
проход шёл по всем экранам на двух языках и трёх ширинах со скриншотами и аудитом вычисленных стилей.

## Стенд

- Сервер agentgraph на временном доме данных (`AGENTGRAPH_HOME`, `AGENTGRAPH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL` — в scratchpad), порт 4791,
  Vite с HMR на 5191. Раннер запусков подменён (`runFlow` в `startServer`): агенты не запускаются, черновики пишут готовые артефакты
  (`prd.md`, `architecture.md`, `design.md`, `notes.json`, `tasks.json`), запуск задачи держится «идёт» или заканчивается через 2 с.
- Засев — через настоящие маршруты API: команда «Платёжная команда» (PAY) на bare-репо `file://`, 4 участника (один с длинным
  именем и email), проекты «Экспорт счетов» (полный), «Новый онбординг…» (длинное название), «Старый API счетов» (в архиве);
  ТЗ с FR-1…FR-7 и NFR-1…NFR-3, архитектура, дизайн, два документа в `docs/`; 11 задач с зависимостями и длинными названиями во всех
  колонках; спринт 1 закрыт с переносом, спринт 2 активен, спринт 3 запланирован; комментарии; два запуска «В работу» (идёт и готов);
  три черновика (ТЗ, архитектура, разбивка); настоящий конфликт поля из второго клона («Мария» переименовала PAY-3); неотправленные
  коммиты; вторая команда (MOB) и третья — только в bare-репо, для диалога «Подключиться по ссылке».
- Скрипт стенда: `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/stand.mts` (в репо не входит). Скриншоты и аудит — `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/shots.mjs`: headless Chrome
  по CDP, на каждом кадре `getComputedStyle`/`getBoundingClientRect` всех кнопок, селектов и ссылок-кнопок в `main` и открытых
  диалогах: отступы `.btn`/`.btn.small`, текст у края рамки (< 5 px), содержимое шире кнопки без многоточия, кликабельная область
  < 18 px, кольцо фокуса под предком с `overflow`, разная высота контролов в одном ряду, горизонтальная прокрутка страницы.

Кадры (24 экрана × RU/EN × 1280/800/390 px): список команд, подключение по ссылке, вкладки команды (проекты, участники, процесс,
настройки), форма нового проекта с выбором репо, обзор, ТЗ (чтение, правка раздела, ревью черновика), архитектура (и ревью
черновика), дизайн, документы, бэклог с предложением разбивки (граф), доска, спринты, панель задачи, меню «В работу ▸», панель
идущей задачи, диалог конфликтов, главная с «Моими задачами» и запусками задач.

## Аудит вычисленных стилей: до → после

Число срабатываний по всем 150 кадрам (25 экранов × RU/EN × 3 ширины; «разбивка списком» добавлена к «до» с копии `HEAD`):

| Проверка | До | После |
|---|---|---|
| отступы `.btn` перебиты | 0 | 0 |
| кнопка с рамкой и отступом < 6 px | 0 | 0 |
| текст у края рамки (< 5 px) | 0 | 0 |
| текст шире кнопки без многоточия | 0 | 0 |
| кликабельная область < 18 px | 24 | 0 |
| кольцо фокуса режет предок с overflow | 181 | 126 |
| разная высота контролов в ряду | 8 | 0 |
| горизонтальная прокрутка страницы | 0 | 0 |
| кадр не снялся | 0 | 0 |

- «Отступы `.btn` перебиты», «текст у края рамки», «текст шире кнопки» — ноль уже «до»: модули не перебивают `.btn`. Текст «впритык»
  давали ряд кнопок на карточке доски (пилюля `.quiet`), ключи в разбивке списком и подчёркнутые `a.btn` — см. ниже.
- «Кольцо фокуса режет предок»: после — только сегменты `.seg`, строки выбора репо и «+ Задача» у края доски. У них кольцо теперь
  рисуется внутри (`inset`), аудит меряет геометрию, а не тень, поэтому они остались в счёте. Остальные 55 мест исправлены
  (селекты и «×» в колонках «Ждёт/Блокирует», карточки и «В работу ▸» у края доски, «Править» у разделов).
- Кадр строки синхронизации «не отправлено» снят только «после» (`sync-pending-*`): он разрешает конфликт на стенде.

## Глоссарий RU ↔ EN

Согласован с остальным agentgraph (`web/src/i18n/en/*.ts`): запуск — run, сессия — session, пространство — space, flow — flow,
«ждёт тебя» — сигнал «Пульта», как на других экранах.

| RU | EN | Примечание |
|---|---|---|
| команда | team | |
| репо команды | team repo | git-репо с документами, задачами и спринтами |
| клон | clone | локальная копия репо команды |
| участник | member | |
| префикс задач | task prefix | |
| проект | project | |
| slug | slug | |
| суть (одной строкой) | (one-line) summary | |
| репо кода | code repo | «репо» — мужского рода, как «репозиторий»: «репо не пустой», «не найден» |
| ссылка на репо | repo URL | для адресов git по-английски URL; «link» — только у ссылок интерфейса («Copy link») |
| папка | folder | |
| ветка | branch | |
| ТЗ | PRD | |
| требование, FR-N / NFR-N | requirement, FR-N / NFR-N | функциональное / нефункциональное; номера не переиспользуются |
| покрывать (требование) | cover | задача закрывает требование |
| архитектура, дизайн | architecture, design | |
| документы (`docs/`) | documents (`docs/`) | |
| раздел | section | |
| правка | edit | и правка раздела человеком, и правка агента в черновике |
| черновик (агента) | (agent) draft | запуск flow команды; кнопка «Черновик с агентом…». В «Пространствах» — «Черновик с моделью…»: там одна сессия модели, а не flow |
| принять / отклонить (правку) | accept / reject | |
| записать (принятые правки) | save | запись в репо команды |
| бросить (правку) | discard | |
| разбивка, разбить | breakdown, break down | было «split» |
| предложение (агента) | proposal | |
| волна | wave | |
| задача, номер задачи | task, task ID | |
| зависимость | dependency | |
| ждёт | waits for | задача ждёт предшественника |
| блокирует | blocks | обратная сторона «ждёт»; в разбивке было «Открывает / Unblocks» |
| бэклог | backlog | |
| доска, колонка | board, column | К работе / В работе / Ревью / Готово ↔ To do / In progress / Review / Done |
| спринт; запустить / завершить / запланировать | sprint; start / close / plan | «Запустить» у спринта было «Run» |
| оценка, очки | estimate, points | |
| исполнитель | assignee | |
| критерии приёмки | acceptance criteria | |
| обсуждение, комментарий | discussion, comment | |
| «В работу ▸» | “Start work ▸” | отправить задачу агенту: flow или сессия |
| работа агентов | agent work | запуски и сессии по задачам на этом компьютере; было «Агенты по проекту» |
| запуск, сессия | run, session | как во всём agentgraph |
| flow команды | team flow | |
| синхронизация | sync | |
| отправить / получить (изменения) | push / pull | |
| конфликт (синхронизации), разобрать | (sync) conflict, resolve | заголовок диалога был «Конфликты правок / Edit conflicts» |
| версия команды / моя версия | team’s version / my version | |
| лента команды | team activity | |

## Формулировки: было → стало

Ключ перевода — сам русский текст, поэтому русская правка — это новый ключ в исходниках и словаре; старый ключ удалён.

### RU (ключ перевода — сам русский текст)

| Было | Стало |
|---|---|
| Агенты по проекту | Работа агентов |
| Агенты по проекту на этом компьютере | Работа агентов на этом компьютере |
| пусто — заполнит черновик с моделью или вы | пусто — заполнит агент или вы |
| Черновик с моделью… | Черновик с агентом… |
| Черновик с моделью | Черновик с агентом |
| Конфликты правок | Конфликты синхронизации |
| поле «{field}»: одно поле, разные значения | поле «{field}» изменили оба |
| одно поле, разные значения | поле изменили оба |
| Взять мою | Взять мою версию |
| ваше | ваша правка |
| команды · {who} | в репо · {who} |
| Решение уйдёт коммитом по каждому конфликту | Каждое решение уйдёт отдельным коммитом |
| Изменения разошлись с командой. Разные поля слились сами, по этим нужно решение. Пока его нет, в репо лежит версия команды. | Ваши изменения разошлись с изменениями команды. Разные поля слились сами, здесь нужно выбрать. Пока выбора нет, в репо лежит версия команды. |
| Только у вас. Предлагается в запусках и сессиях по задачам проекта. | Видно только вам. Подставляется в запуски и сессии по задачам проекта. |
| Команда скопирована | Скопировано |
| Не скопировалось: выделите команду и скопируйте | Не скопировалось: выделите текст и скопируйте вручную |
| Всё, что уйдёт агенту. Текст команды — внутри source-data: это данные, а не инструкции. | Всё, что получит агент. Текст участников команды — внутри source-data: это данные, а не инструкции. |
| Задачам не в «К работе» статус вернётся в «К работе»: {n} | Статус сбросится на «К работе» у задач: {n} |
| Запланировать | Запланировать спринт |
| в бэклог {n} | вернулось в бэклог {n} |
| ждут текущих задач {n} | ждут задач проекта {n} |
| Покрывают {ids} | Новые задачи покрывают {ids} |
| Не покрывают ни одного требования | Новые задачи не покрывают требований |
| Взять папку | Добавить папку |
| Создайте первый проект: название, slug и одна строка сути. Репо кода можно добавить сразу или позже. | Создайте первый проект: название, slug и суть одной строкой. Репо кода можно добавить сразу или позже. |
| Участники из teamwork.yaml; «себя» agentgraph узнаёт по email из git config клона | Участники — из teamwork.yaml. Вас agentgraph узнаёт по email из git config клона |
| git не знает вас: задайте git config --global user.name и user.email, иначе записи в команду не пройдут. | git не знает, кто вы: задайте git config --global user.name и user.email, иначе изменения в команду не запишутся. |
| Отключить команду — удалить локальный клон. Репо команды остаётся, подключиться снова можно по ссылке. С неотправленными изменениями сервер переспросит. | Отключить команду — удалить её локальный клон. Репо команды останется, подключиться снова можно по ссылке. Если есть неотправленные изменения, agentgraph спросит ещё раз. |
| Сохранение коммитит flow в репо команды; невалидный YAML сервер не примет | Сохранение — коммит flow в репо команды; YAML с ошибками не сохранится |
| Что успел | Что успел агент |
| Взять задачу {key} | Добавить задачу {key} |
| Открывает | Блокирует |
| ничего не ждёт её | никого |
| + Зависимость: от чего ждёт | + Зависимость: чего она ждёт |
| Предшественники вне спринта | Ждут задач вне спринта |
| Задача уже в этом спринте: убрать — перенесите её в бэклог | Задача уже в этом спринте. Чтобы убрать её, перенесите задачу в бэклог |
| Задачи активных спринтов во всех командах, где исполнитель — вы | Ваши задачи в активных спринтах всех команд |
| Новое репо кода | Добавить репо кода |
| Сервер не умеет Teamwork: обновите agentgraph. | Этот сервер не поддерживает Teamwork: обновите agentgraph. |
| · ветка появится при «В работу» | ветка появится при «В работу» |
| идёт запуск · запуск (значок работы без имени запуска) | идёт запуск |
| запуск / запуск · идёт · 5 мин назад (панель задачи) | Запуск / идёт · 5 мин назад |
| title · поле «title»: одно поле, разные значения (диалог конфликтов) | Заголовок · изменили оба |
| ничего не ждёт | ничего |

### EN

| Русский ключ | Было | Стало |
|---|---|---|
| Этот сервер не поддерживает Teamwork: обновите agentgraph. | This server has no Teamwork: update agentgraph. | This server doesn’t support Teamwork: update agentgraph. |
| Открыть команду | Open the team | Open team |
| Создать команду | Create a team | Create team |
| Подключиться по ссылке | Join by link | Join by URL |
| Ссылка на пустой репо | Link to an empty repo | Empty repo URL |
| Репо не пустой и не команда: нужен пустой репо | The repo is not empty and not a team: an empty repo is needed | This repo isn’t empty and isn’t a team: use an empty repo |
| Номера задач будут {p}-1, {p}-2… Префикс потом не меняется. | Task ids will be {p}-1, {p}-2… The prefix can’t be changed later. | Task IDs will be {p}-1, {p}-2… The prefix can’t be changed later. |
| Латиница, 2–6 букв: номера задач будут PLT-1, PLT-2… Префикс потом не меняется. | Latin letters, 2–6 of them: task ids will be PLT-1, PLT-2… The prefix can’t be changed later. | 2–6 Latin letters: task IDs will be PLT-1, PLT-2… The prefix can’t be changed later. |
| разбивка на задачи | split into tasks | breakdown into tasks |
| задача в работу | task to work | starting work on a task |
| Вставьте ссылку на репо команды. agentgraph склонирует его к себе и покажет проекты. | Paste the link to the team repo. agentgraph clones it here and shows the projects. | Paste the team repo URL. agentgraph clones it here and shows its projects. |
| Ссылка на репо команды | Link to the team repo | Team repo URL |
| Добавить меня в участники | Add me to the members | Add me as a member |
| Репо кода проектов | Code repos of the projects | Projects’ code repos |
| Команды {slug} нет | There is no team {slug} | Team {slug} not found |
| Команда не открылась | The team didn’t open | Couldn’t open the team |
| Ссылка на репо кода | Code repo link | Code repo URL |
| Убрать репо | Remove the repo | Remove repo |
| Создать проект | Create the project | Create project |
| Участники — из teamwork.yaml. Вас agentgraph узнаёт по email из git config клона | Members from teamwork.yaml; agentgraph recognizes you by the email in the clone’s git config | Members come from teamwork.yaml. agentgraph recognizes you by the email in the clone’s git config |
| git не знает, кто вы: задайте git config --global user.name и user.email, иначе изменения в команду не запишутся. | git doesn’t know you: set git config --global user.name and user.email, or writes to the team will fail. | git doesn’t know who you are: set git config --global user.name and user.email, or your changes won’t reach the team. |
| Сохранение — коммит flow в репо команды; YAML с ошибками не сохранится | Saving commits the flow to the team repo; the server rejects invalid YAML | Saving commits the flow to the team repo; YAML with errors isn’t saved |
| Префикс после создания не меняется: на него ссылаются номера задач | The prefix can’t change after creation: task ids refer to it | The prefix can’t change after creation: task IDs refer to it |
| Отключить команду — удалить её локальный клон. Репо команды останется, подключиться снова можно по ссылке. Если есть неотправленные изменения, agentgraph спросит ещё раз. | Disconnecting the team deletes the local clone. The team repo stays, and you can join again by link. With unpushed changes the server asks again. | Disconnecting deletes the team’s local clone. The team repo stays, and you can join again by its URL. If there are unpushed changes, agentgraph asks again. |
| Отключить команду… | Disconnect the team… | Disconnect team… |
| Отключить команду «{title}»? Локальный клон удалится; репо команды и всё, что в нём, останутся. Подключиться снова можно по ссылке. | Disconnect team “{title}”? The local clone is deleted; the team repo and everything in it stay. You can join again by link. | Disconnect team “{title}”? The local clone is deleted; the team repo and everything in it stay. You can join again by its URL. |
| Синхронизировать сейчас: получить изменения команды и отправить свои | Sync now: get the team’s changes and push yours | Sync now: pull the team’s changes and push yours |
| Конфликты синхронизации | Edit conflicts | Sync conflicts |
| Ваши изменения разошлись с изменениями команды. Разные поля слились сами, здесь нужно выбрать. Пока выбора нет, в репо лежит версия команды. | Your changes diverged from the team’s. Different fields merged on their own; these need a decision. Until then the repo holds the team’s version. | Your changes diverged from the team’s. Different fields merged automatically; these need your choice. Until then the repo keeps the team’s version. |
| поле изменили оба | one field, different values | field changed on both sides |
| изменили оба | — | changed on both sides |
| поле «{field}» изменили оба | field “{field}”: one field, different values | field “{field}” changed on both sides |
| текст изменили оба | both changed the text | text changed on both sides |
| Взять мою версию | Take mine | Take my version |
| ваша правка | yours | your edit |
| в репо · {who} | team’s · {who} | in the repo · {who} |
| Каждое решение уйдёт отдельным коммитом | The decision goes out as a commit per conflict | Each decision is committed separately |
| Сохранить решение | Save the decision | Save decisions |
| Проекта {slug} нет | There is no project {slug} | Project {slug} not found |
| Проект не открылся | The project didn’t open | Couldn’t open the project |
| Открыть бэклог | Open the backlog | Open backlog |
| Открыть доску | Open the board | Open board |
| Работа агентов | Agents on the project | Agent work |
| пусто — заполнит агент или вы | empty — a draft with the model or you fill it in | empty — an agent or you can fill it in |
| Сменить папку | Change the folder | Change folder |
| Указать, где лежит клон этого репо | Point to where the clone of this repo is | Set the folder of this repo’s clone |
| Указать папку | Set the folder | Set folder |
| Видно только вам. Подставляется в запуски и сессии по задачам проекта. | Only on your side. Offered in runs and sessions on the project’s tasks. | Only you see it. It’s preselected in runs and sessions for the project’s tasks. |
| Лента команды | Team feed | Team activity |
| Выбрано {n} | Selected {n} | {n} selected |
| сверху важнее · перетаскивайте или ⌥↑ ⌥↓ | top is more important · drag or ⌥↑ ⌥↓ | higher is more important · drag or ⌥↑ ⌥↓ |
| перенесено {n} | carried over {n} | {n} carried over |
| вернулось в бэклог {n} | to the backlog {n} | {n} back to the backlog |
| Новые задачи не покрывают требований | Cover no requirements | New tasks cover no requirements |
| Новые задачи покрывают {ids} | Cover {ids} | New tasks cover {ids} |
| ждут задач проекта {n} | waiting on existing tasks: {n} | waiting on project tasks: {n} |
| только чтение: формат {n} новее этой версии agentgraph | read-only: format {n} is newer than this agentgraph | read-only: format {n} is newer than this version of agentgraph |
| только чтение: формат новее этой версии agentgraph | read-only: the format is newer than this agentgraph | read-only: the format is newer than this version of agentgraph |
| Ваши задачи в активных спринтах всех команд | Tasks of active sprints in all teams where you are the assignee | Your tasks in active sprints of all teams |
| разбивка ТЗ | PRD split | PRD breakdown |
| Разбивка ТЗ на паузе | The PRD split is paused | The PRD breakdown is paused |
| Добавить: ссылка и ветка — из git этой папки | Add: the link and branch come from this folder’s git | Add: the URL and branch come from this folder’s git |
| У папки нет origin: ссылку придётся ввести | The folder has no origin: you’ll have to enter the link | The folder has no origin: you’ll have to enter the URL |
| origin папки {path} не годится как ссылка ({url}) — участники не найдут репо автоматически | The origin of {path} is not a usable link ({url}) — teammates won’t find the repo automatically | The origin of {path} is not a usable URL ({url}) — teammates won’t find the repo automatically |
| Ввести ссылку | Enter a link | Enter URL |
| Добавить папку | Use folder | Add folder |
| Ссылка как для git clone — если папки этого репо у вас нет | A link as for git clone — if you don’t have this repo’s folder | A git clone URL — if you don’t have this repo locally |
| Нужна ссылка: без неё репо не добавится | A link is needed: without it the repo won’t be added | A URL is needed to add the repo |
| Ссылка — origin этой папки | The link is this folder’s origin | The URL is this folder’s origin |
| Не скопировалось: выделите текст и скопируйте вручную | Couldn’t copy: select the command and copy it | Couldn’t copy: select the text and copy it manually |
| Ничего не скачивается: в проект попадают ссылка (origin) и ветка, а ваша папка остаётся только у вас. У коллег agentgraph найдёт их папку этого репо по origin среди их проектов. Ключ — короткое имя репо в задачах и у агента. | Nothing is downloaded: the project gets the link (origin) and the branch, and your folder stays on your computer only. On teammates’ computers agentgraph finds their folder of this repo by origin among their projects. The key is the short repo name in tasks and for the agent. | Nothing is downloaded: the project gets the URL (origin) and the branch, and your folder stays on your computer only. On teammates’ computers agentgraph finds their folder of this repo by origin among their projects. The key is the short repo name in tasks and for the agent. |
| У проекта нет репо кода. «+ Репо» — выбрать свою папку: ссылка и ветка возьмутся из git, ничего не скачивается. | The project has no code repos. “+ Repo” — pick your folder: the link and branch come from git, nothing is downloaded. | The project has no code repos. “+ Repo” — pick your folder: the URL and branch come from git, nothing is downloaded. |
| Добавить репо кода | New code repo | Add a code repo |
| В следующий спринт | To the next sprint | To next sprint |
| В бэклог | To the backlog | To backlog |
| Снять исполнителя | Remove the assignee | Unassign |
| Запланировать спринт | Plan one | Plan a sprint |
| В начало колонки | To the top of the column | To top of column |
| Убрать из спринта в бэклог | Take out of the sprint to the backlog | Move from the sprint to the backlog |
| Разбивка уже идёт | A split is already running | A breakdown is already running |
| Разбить ТЗ на задачи… | Split the PRD into tasks… | Break down the PRD into tasks… |
| Агент разбивает ТЗ и ждёт ответа | The agent is splitting the PRD and waits for an answer | The agent is breaking down the PRD and waits for an answer |
| Агент разбивает ТЗ на задачи | The agent is splitting the PRD into tasks | The agent is breaking down the PRD into tasks |
| Разбить ТЗ на задачи | Split the PRD into tasks | Break down the PRD into tasks |
| Что разбить | What to split | What to break down |
| Разбить всё ТЗ | Split the whole PRD | Break down the whole PRD |
| Разбить | Split | Break down |
| Разбивка не получилась | The split failed | The breakdown failed |
| Повторить черновик | Retry the draft | Retry draft |
| Добавить задачу {key} | Take task {key} | Include task {key} |
| Задача уже в этом спринте. Чтобы убрать её, перенесите задачу в бэклог | The task is already in this sprint: to drop it, move it to the backlog | The task is already in this sprint. To drop it, move it to the backlog |
| Ждут задач вне спринта | Predecessors outside the sprint | Waiting on tasks outside the sprint |
| Статус сбросится на «К работе» у задач: {n} | Tasks not in “To do” go back to “To do”: {n} | Status resets to “To do” for tasks: {n} |
| Завершить спринт | Close the sprint | Close sprint |
| Все в следующий | All to the next | All to next sprint |
| Все в бэклог | All to the backlog | All to backlog |
| Задачи {id} нет в проекте: её удалили или номер устарел. | There is no task {id} in the project: it was deleted or the id is stale. | Task {id} isn’t in the project: it was deleted or the ID is stale. |
| ветка появится при «В работу» | · the branch appears on “Start work” | the branch is created on “Start work” |
| Блокирует | Unblocks | Blocks |
| никого | nothing waits for it | nothing |
| Работа агентов на этом компьютере | Agents on the project on this computer | Agent work on this computer |
| Всё, что получит агент. Текст участников команды — внутри source-data: это данные, а не инструкции. | Everything the agent gets. Team text is inside source-data: it is data, not instructions. | Everything the agent gets. Text written by team members is inside source-data: it is data, not instructions. |
| Удалить требование | Delete the requirement | Delete requirement |
| Черновик с агентом | Draft with a model | Draft with an agent |
| модель flow | flow’s model | model from the flow |
| Что успел агент | What it got done | What the agent did |
| Скрыть строку | Hide the line | Hide this line |
| Черновик не открылся | The draft didn’t open | Couldn’t open the draft |
| Документ успели изменить, пока вы решали. Правки пересчитаны на свежую версию: проверьте конфликты и запишите ещё раз. | The document changed while you were deciding. The edits are recomputed on the fresh version: check the conflicts and write again. | The document changed while you were deciding. The edits are recomputed on the fresh version: check the conflicts and save again. |
| Записать принятые · {n} | Write accepted · {n} | Save accepted · {n} |
| Записываю… | Writing… | Saving… |
| Записано: {n} {w} | Written: {n} {w} | Saved: {n} {w} |
| записано | written | saved |
| Бросить правку | Discard the edit | Discard edit |
| Скопировано | Command copied | Copied |
| Документ удалили из репо после старта черновика: записывать некуда. | The document was deleted from the repo after the draft started: there is nowhere to write. | The document was deleted from the repo after the draft started: there is nowhere to save. |
| Запись заменит правки, сделанные в документе после старта черновика:↵{list}↵Записать всё равно? | Writing replaces edits made to the document after the draft started:↵{list}↵Write anyway? | Saving replaces edits made to the document after the draft started:↵{list}↵Save anyway? |
| Запустить#sprint | Run | Start |
| Вид#view | Kind | View |
| Записать#draft | Write | Save |
| Место в списке | — | Position |
| Колонки | — | Columns |
| Формат | — | Format |
| Сессия Claude Code | — | Claude Code session |
| ничего#deps | waits for nothing | nothing |
| Отправить сейчас | — | Push now |
| Черновик с агентом… | Draft with a model… | Draft with an agent… |

Кроме таблиц:

- «идёт запуск · запуск», «ждёт ответа · запуск» → «идёт запуск», «ждёт ответа»: у запуска без имени хвоста больше нет (`workBadge` в
  `web/src/lib/teamwork/board.ts`, тест). Имя запуска, когда оно есть, теперь стоит и у упавшего («запуск остановлен: ошибка ·
  Работа над PAY-9»). На обзоре проекта убрана отдельная подпись запуска справа от задачи — она повторяла ту же строку. В панели
  задачи («Работа агентов») строка без имени была «запуск / запуск · идёт · 5 мин назад», стала «Запуск / идёт · 5 мин назад»; вид
  работы под строкой остаётся только у запуска с именем.
- «Ждёт: ничего не ждёт» / «Waits for: waits for nothing» в панели задачи и разбивке → «Ждёт: ничего» / «nothing» (ключ с
  контекстом `'ничего#deps'`), «Блокирует: её никто не ждёт» → «Блокирует: никого», как уже было в панели задачи.
- Диалог конфликтов: поле подписано по-человечески (`fieldLabel` в `web/src/lib/teamwork/sync.ts`, тест): `title` у задачи —
  «Заголовок», как в её панели, у проекта, команды и спринта — «Название», как в их формах; `status` — «Статус», `pr` — «PR»;
  незнакомое поле — как в файле. Рядом «изменили оба» вместо «поле «title»: одно поле, разные значения». Варианты «Взять мою версию ·
  ваша правка» и «Оставить версию команды · в репо · Мария». Конфликт поля в `sprints/*.yaml` (сервер даёт ему вид `sprint`)
  подписан «изменили оба»; пояснение про два активных спринта осталось только у поля `status`.
- Общие слова с другим смыслом в Teamwork получили контекст: «Запустить» спринта (`'Запустить#sprint'` → Start, было Run), «Вид»
  переключателя граф/список и документ/исходник (`'Вид#view'` → View, было Kind), «Записать» в переспросе черновика
  (`'Записать#draft'` → Save, было Write).
- Строка синхронизации «не отправлено: 2 изменения» без ошибки показывала кнопку «Повторить», хотя повторять нечего — отправка
  просто ждёт таймера. Теперь «Отправить сейчас» / “Push now”, «Повторить» — только когда есть ошибка (`syncLine`, тест).
- «Команда скопирована» после «Копировать» у `git clone` в Teamwork читалось как «команду (team) скопировали» → «Скопировано».

Удалённые ключи словаря: все «было» из русской таблицы (кроме тех, что уже были в других словарях: «Черновик с моделью…» живёт в
`space.ts`), плюс «Агенты по проекту на этом компьютере», «Команда скопирована» и «Открывает» — их заменили существующие ключи.
Неиспользуемых ключей в `teamwork.ts` после прохода нет (проверка: каждый ключ встречается литералом в `web/src`).

## Отступы и кликабельные области по экранам

Аудит «до» показал, что отступы самих `.btn`/`.btn.small` нигде не перебиты: правила `padding: 0` в модулях стоят на текстовых
кнопках-ссылках и иконках, а не на `.btn`. Текст «у самой рамки» давали другие причины:

- **Разбивка списком.** Колонка ключа задачи была 22 px: ключи агента («schema», «docs», «cron») налезали на название задачи без
  зазора — «schemaСхема таблицы…». Колонка теперь 62 px, как номер в строке бэклога, длинный ключ режется многоточием. Аудит кнопок
  этого не ловил (ключ — не кнопка), нашлось на скриншоте.
- **Доска, карточка.** Модификатор «кнопки видны при наведении» назывался `.quiet`, как пилюля «запланирован/активен» в том же модуле
  (фон `--well`, `padding: 2px 9px`, скругление 999px). Ряд «В работу ▸ · ⋯» при наведении (и всегда — на телефоне) становился
  тёмной пилюлей, в которой кнопки упирались в её край. Модификатор переименован в `.hover-only`.
- **`<Link className="btn">` подчёркнут браузером**: «Открыть доску», «Открыть бэклог», «Открыть запуск», «Доска», «Бэклог»,
  «Ответить». В `Teamwork.module.css` (`.view :global(a.btn)`) и `MyTasks.module.css` — `text-decoration: none`. Тот же дефект есть
  на чужих экранах (Пространства, Знания, редактор вызова flow) — не трогал, см. «Вне своих файлов».
- **Строка черновика над документом** (ТЗ/архитектура/дизайн): на 1280 px «Отклонить» одна переносилась на вторую строку. Задание
  (`.dline .brief`) теперь сжимается первым (`flex: 1 1 0; min-width: 80px`), кнопки переносятся только вместе.
- **Шапка документа** (ТЗ, архитектура, дизайн, `docs/`): «История», «Исходник» и «Черновик с агентом…» переносились по одной — в
  колонке документа на вкладке «Документы» «Исходник» уезжал один на вторую строку. Теперь это одна группа (`.dacts`), при переносе
  прижатая вправо, к подсказке «Нажмите на раздел…».
- **Ревью черновика, шапка**: «Отклонить черновик» и «Записать принятые» были обычного размера (35 px) в ряду маленьких (26 px) —
  теперь `small`, высоты совпадают. «Показать» у свёрнутых разделов без правок был голым текстом (`.fold button { padding: 0 }`) —
  теперь `btn ghost small`.
- **Панель задачи на телефоне**: селект «Исполнитель» вылезал за правый край панели, «Репо и ветка» резалась на «ветка появится п»
  без многоточия (`.val { overflow: hidden }` с `inline-flex`). Новые классы `.pick-row` (селект сжимается, `min-width: 0`) и
  `.repo-line` (перенос); подсказка без ведущей «·». Колонка «Ждёт/Блокирует» (`.val.wrap`) больше не режет кольцо фокуса селекта и «×».
- **Кольцо фокуса обрезалось** предком с `overflow`: сегменты `.seg` во всех трёх модулях («Создать команду / Подключиться по
  ссылке», «Граф / Список», «Документ / Исходник», «Текст / Markdown»), строки выбора репо (`.chooser-list`), подсказки ссылок
  (`.picks`), история документа (`.hist`), карточки и «+ Задача» у краёв прокручиваемой доски. Там кольцо теперь внутри
  (`box-shadow: inset var(--focus)`, как уже было у строк бэклога).
- **Иконки и текстовые кнопки без рамки** получили кликабельную область: «×» зависимости и критерия — 22×22 (было 15×15), ручка
  перетаскивания строки бэклога — 18×24 (была 6×12), «×» и ручка требования в правке раздела — по высоте строки (30 px);
  текстовые кнопки-ссылки (`.link-btn`, `.linkBtn`: «Запланировать спринт», «Создать задачу», «← К документу», «Что изменили»,
  «Показать» цепочки) — `padding: 2px 0` и скругление под кольцо фокуса; текст строки синхронизации («конфликт в PAY-3», «не
  отправлено: …» — кнопка «синхронизировать сейчас») — `padding: 3px 6px` и подсветка при наведении, как у `.btn.ghost.small`.
- **Форма нового проекта и настройки команды на телефоне**: ширина второй колонки («Slug», «Префикс задач») была задана
  inline-стилем, и `@media` не мог сложить поля в одну колонку — «Название» сжималось до «Экспорт счетс». Теперь классы
  `.two-slug`/`.two-prefix`, на узком экране поля друг под другом.
- **Фильтры доски на телефоне**: при переносе разделитель между исполнителями и типами повисал один в начале строки — на узком
  экране он скрыт.
- **Диалог «Подключиться по ссылке» на телефоне**: «✓» стоял отдельной строкой над длинным названием команды — название теперь
  переносится рядом с ним.
- **Шапка команды и проекта на телефоне**: «⋯» уезжала одна на отдельную строку. При ширине экрана ≤ 520 px (контейнер `.view`)
  аватары участников скрыты — список есть на вкладке «Участники», — строка синхронизации, «Разобрать» и «⋯» помещаются в одну строку;
  зазор между строками шапки 8 px вместо 12.
- **Полоса спринта** (обзор, список проектов, доска, спринты): ячейки «в работе» не закрашивались, и в полосе была дыра. CSS Modules с
  `camelCaseOnly` отдают `.in_progress` только как `inProgress`, а код брал `styles[status]`. Новый `stripCell(status)` в `parts.tsx`.


## Ревью

Сабагент `code-reviewer` (только чтение): блокеров нет. Сделано по его замечаниям: убран ключ `'Суть'` (он перебивал перевод
«Пространств» — словари сливаются, teamwork последним), имя запуска у упавшего значка работы, подписи `pr`/`format` и «Название» у
не-задач, `fieldLabel` перенесён в `lib/teamwork/sync.ts` с тестом (в том числе `constructor` и незнакомое поле), старые подписи в
комментариях, имени теста и `docs/REFERENCE.md`, пояснение у конфликта поля спринта. Не сделано: `--attr-source` в списке опций git
со значением (в коде не используется; добавить, когда понадобится).

## `src/git.ts`: подпись ошибки `exec`

Ошибка подписывалась первым аргументом, и пользователь видел «git -c: …» (`TeamRepo` зовёт `git -c core.quotePath=false …`).
Новая `commandOf(args)` берёт первый аргумент, который не опция: пропускает `-c`, `-C`, `--git-dir`, `--work-tree`, `--namespace`,
`--config-env` вместе со значением и любые другие `-x`/`--x`. Без команды подпись — просто `git:` (раньше «git :»). Тест в
`src/git.test.ts`: разбор аргументов и настоящий `git -c … fetch nowhere` → «git fetch: …».

## Вне своих файлов

- `src/git.ts`, `src/git.test.ts` — по задаче.
- `base.css` и чужие экраны не трогал. Там тот же дефект `a.btn` с подчёркиванием: `screens/spaces/SpacesScreen.tsx` («Сессия в
  папке», «Токены в «Контексте»»), `screens/tags/TagsScreen.tsx` («Открыть сессию с тегом»), `screens/flow/CallEditor.tsx`. Правильнее
  одной строкой `.btn { text-decoration: none; }` в `base.css` — на решение владельца.
- `docs/REFERENCE.md` (раздел Teamwork) — подписи кнопок приведены к новым: “Add me as a member”, “Sync conflicts”, “Take my
  version”, “Draft with an agent…”, “Break down the PRD into tasks…”.
- `.claude/launch.json` — временные конфигурации стенда, откатаны до коммита.
- Не трогал: старые подписи в исторических документах (`docs/teamwork/spec.md`, макеты `design/*.dc.html`, отчёты волн) и
  комментарий в `web/src/api/teamwork.ts` («Взять мою»).

## Не проверено

- Электрон и шрифты другой системы: проверялось в Chrome (headless shell 1248 и панель браузера) на macOS.
- Строка синхронизации «не отправлено … — <ошибка сети>»: на стенде сеть не падала, видел только состояние без ошибки.
- Узкие места, которые аудит не ловит: перенос длинных русских и английских текстов внутри подсказок `title`, порядок фокуса.
- Настоящие агенты, «В работу ▸» до конца и сессии: только поддельный раннер.
- В английском интерфейсе лента команды и история документа показывают сообщения коммитов
  по-русски («PAY-9: оценка → 3»): их пишет сервер, и по spec они не переводятся. Не трогал.
- Шаблонные названия колонок доски в `teamwork.yaml` команды («К работе»…) в поле настроек остаются как в репо — это данные команды.

## Скриншоты

Папки (вне репо):

- до: `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/before/` — 150 кадров и `audit.json`;
- после: `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/after/` — 154 кадров и `audit.json`.

Имя кадра — `<экран>-<ru|en>-<1280|800|390>.jpg`, пара «до/после» — одно имя в двух папках. Экраны: `arch-draft`, `architecture`, `backlog`, `board`, `conflicts`, `design`, `docs`, `home`, `join`, `overview`, `prd`, `prd-draft`, `prd-edit`, `split-graph`, `split-list`, `sprints`, `sync-pending`, `task`, `task-running`, `task-towork`, `team-members`, `team-new-project`, `team-process`, `team-projects`, `team-settings`, `teams`.

Самые показательные пары (полные пути):

- `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/before/board-ru-390.jpg` → `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/after/board-ru-390.jpg`
- `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/before/overview-ru-1280.jpg` → `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/after/overview-ru-1280.jpg`
- `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/before/prd-ru-1280.jpg` → `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/after/prd-ru-1280.jpg`
- `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/before/prd-draft-en-1280.jpg` → `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/after/prd-draft-en-1280.jpg`
- `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/before/split-list-ru-1280.jpg` → `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/after/split-list-ru-1280.jpg`
- `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/before/task-ru-390.jpg` → `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/after/task-ru-390.jpg`
- `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/before/conflicts-ru-1280.jpg` → `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/after/conflicts-ru-1280.jpg`
- `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/before/team-new-project-ru-390.jpg` → `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/after/team-new-project-ru-390.jpg`
- `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/before/docs-en-800.jpg` → `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/after/docs-en-800.jpg`
- `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/after/sync-pending-ru-1280.jpg`, `/private/tmp/claude-501/-Users-aleksey-Documents-agentgraph--claude-worktrees-tw-ux-pass-2c387d/199204b7-4229-4082-bd6d-95eb2db50247/scratchpad/stand/after/sync-pending-en-390.jpg` (только «после»)

