# Рутины — спецификация реализации

Рутина — правило «когда → делай»: событие из любого источника запускает flow. Дизайн согласован 17.11.2026.
Делаем сразу всё (без урезанной первой версии) и покрываем e2e.

- Экраны: `docs/routines/design/*.dc.html` (холст https://claude.ai/artifact/R3WmQW6SrTs9sv785zvvPg). Main — список,
  New — создание (4 шага), Source — «Подключить сервис», Editor — редактор правила, Log — срабатывания,
  Home — карточка ожидания на главной, States — пустой список и состояния. Тексты в макетах — финальные.
- Механика и решения: `docs/routines/design/mechanics.html`.
- Контракт кода: `src/routines/types.ts` (общий с вебом), `src/routines/kind.ts` (ядро ↔ виды источников).
  Контракт только дописываем; если поле нужно поменять — правка здесь и в types.ts, с пометкой в отчёте.

## 1. Путь события

1. **Событие.** Источник отдаёт записи → `RoutineEvent`. Виденные id (по источнику) не повторяются.
2. **Условия** (`when.match`, без модели) — см. `MatchRule` в types.ts.
3. **Проверка словами** (`when.check`, необязательно) — haiku (`claude-haiku-4-5-20251001`, как `SUGGEST_MODEL` в
   attention.ts): «подходит ли событие под условие» + «дубль ли это недавних (последние 20 запущенных событий
   рутины)». В промпт идут последние 5 событий, на которые человек ответил «Это не баг» (`rejected`), как отрицательные
   примеры. Ответ строго JSON `{ "match": bool, "duplicate": bool, "reason": "…" }`. Текст события — в `wrapData`.
4. **Запуск** — обычный `startRun` сервера: flow, space, cwd, worktree (`new` — новый worktree как с главной),
   knowledge, model, бюджет `limits.usd`. Вход = `run.input` + «Событие:» + `wrapData(title/text/link/author/fields)`.
   `RunSource` расширяется типом `'routine'` (key = слаг рутины, title = заголовок события, url = link).
5. **Остановка.** `mode: until_pause` + `run.pause_before` → новая опция раннера `pauseBefore: string[]`: перед
   первой итерацией указанного блока раннер ставит паузу с `pauseReason` (виден на главной как ожидание рутины).
   `mode: suggest` — запуска нет, событие ждёт «Запустить?». `auto` — без остановок, `pause_before` игнорируется.
6. **Ответ** (`reply`): на `start`/`pause`/`end`. Текст без модели: на паузе — «Взял в работу: <title>. Жду
   подтверждения перед «<block>»»; в конце — сводка запуска (`report.digest.text`, если есть) или статус. `draft: true`
   — текст ждёт в карточке ожидания (`replyDraft`) и уходит с решением человека (галочка «ответить в тред»);
   на `end` при draft — карточка «Ответ готов» с кнопкой «Отправить». `to: 'source'` — `kind.reply(ctx, event.replyTo)`;
   `to: <слаг>` — reply источника-слага без target (его чат по умолчанию). Источник без reply → ошибка в журнал.

Лимиты: `per_day` (запусков за сутки), `parallel` (идущих одновременно; лишние ждут очереди, не теряются),
`usd` — бюджет запуска. Превышение — запись `limit` в журнал.

Петля на себя: `kind.isSelf` (свой бот, ответы в тредах) — не событие.

**Дело** (`task`, «Мои дела», [../desk/SPEC.md](../desk/SPEC.md) этап 3). Событие, прошедшее условия и проверку
словами, заводит дело: `desk().put(ключ, …, 'routine')`. Ключ — по `task.same`: `thing` — главная вещь события
(`event.things[0]`), `thread` — `threadKey(event.thread)`, `event` — `own:<источник>/<id события>`; не задано — вещь,
иначе нить, иначе событие. В деле — вид, колонка (`column`), сигнал с `replyTo` и слагом рутины, проект (`task.project`, иначе
`run.space` или пространство `run.cwd`), `on_repeat` и правило закрытия `close` (закрывает сверка доски). `run`
необязателен: без него рутина только заводит дела (строка журнала `task`); `from: flow` — дела заводит flow
инструментом `desk_put`, движок их не заводит, и `run` нужен. У рутины с делом повтор по вещи режет только запуск —
сигнал дело получает. Ожидание (`suggest`) — это дело в «Новом» (`RoutineWait.deskKey`): «Запустить» — запуск и дело «В
работе», «Не сейчас» — дело в план, «Не то» — дело закрыто. Первый опрос источника у такой рутины (и первый после
того, как рутина начала заводить дела, — отметка `task:<рутина>@<источник>` в `last-check.json`) заводит дела по
текущему списку без запусков: не больше 50 самых свежих записей, отметка — только когда все дела завелись (доска
недоступна — засев на следующем опросе). События простоя заводят дела сами; «догнать» остаётся только для запуска и
второй раз их не проверяет. Расписание без flow — проблема правила.

Работает, пока открыт сервер. **Простой:** при старте первый опрос источника отдаёт записи, пришедшие пока сервер был
выключен (at > время последней проверки) — они не запускаются, а копятся в `CatchUp` («пришло 9 событий, 2
подходят» — подходят по условиям, без модели). Пропущенное расписание (`missed: ask`) — одна строка `CatchUp` на
рутину с `missedAt`; `skip` — молча. Ответ «Догнать» прогоняет подходящие через полный путь, «Пропустить» — в журнал как `missed`.

## 2. Файлы

| Путь | Что |
|---|---|
| `~/.agentgraph/routines/<slug>.yaml` | `RoutineSpec` (личные, не в репо) |
| `~/.agentgraph/sources/<slug>.yaml` | `SourceSpec` без секретов |
| `~/.agentgraph/secrets.json` (0600) | `{ "<ИМЯ>": "значение" }`; наружу API не отдаёт никогда |
| `~/.agentgraph/recipes/*.yaml`, `templates/sources/*.yaml` | рецепты — готовые источники файлом |
| `~/.agentgraph/routines-state/` | `seen/<source>.json` (id, не больше 2000 на источник), `cursors/<source>.json`, `log/<routine>.jsonl`, `waits.json`, `catchup.json`, `last-check.json` |

Корень — `configDir()` из settings.ts (уважает `AGENTGRAPH_CONFIG_DIR`, тесты и e2e подставляют временную папку).
Слаг — `[a-z0-9-]`, путь проверять через safe-fs. YAML читать пакетом `yaml`, проверять zod-схемой
(`src/routines/schema.ts`); битый файл не валит движок — рутина показывается с `problems`.

## 3. API (все под `/api/routines`, JSON, существующие проверки Host/Origin сервера)

| Метод и путь | Тело → ответ |
|---|---|
| `GET /api/routines` | → `RoutinesOverview` |
| `GET /api/routines/:slug` | → `RoutineView` |
| `PUT /api/routines/:slug` | `{ spec: RoutineSpec }` или `{ yaml: string }` → `RoutineView` (400 с `problems` при ошибке схемы) |
| `DELETE /api/routines/:slug` | → `{ ok: true }` |
| `POST /api/routines/:slug/enabled` | `{ enabled: boolean }` → `RoutineView` |
| `POST /api/routines/:slug/history` | `{ spec?: RoutineSpec, limit?: number }` → `HistoryCheck` (по последним событиям источника из журнала и свежему опросу; можно для несохранённого spec — «Проверить на истории» в редакторе и создании) |
| `POST /api/routines/:slug/run` | `{ eventId?: string }` → `{ runId?: string; wait?: RoutineWait }` (ручной запуск; для расписания — сейчас) |
| `GET /api/routines/:slug/log?outcome=a,b&limit=` | → `LogEntry[]` (новые сверху, с `feedback`) |
| `POST /api/routines/:slug/feedback` | `{ eventId, verdict: 'match' \| 'no_match' \| 'not_duplicate' }` → `{ ok: true }` (`routines-state/feedback/<routine>.json`; match/no_match — примеры проверки словами, not_duplicate — не дубль) |
| `POST /api/routines/waits/:id` | `WaitAction` → `{ ok: true; runId?: string }` |
| `POST /api/routines/catchup/:id` | `{ action: 'run' \| 'skip' }` → `{ ok: true }` |
| `GET /api/routines/sources` | → `SourceView[]` |
| `PUT /api/routines/sources/:slug` | `{ spec: SourceSpec; secrets?: Record<string,string> }` → `SourceView` |
| `DELETE /api/routines/sources/:slug` | 409, если источник используют рутины |
| `POST /api/routines/sources/test` | `{ spec: SourceSpec; secrets?: Record<string,string> }` → `SourceTestResult` |
| `POST /api/routines/sources/draft` | `{ description: string }` → `DraftView` (подключение словами) |
| `GET /api/routines/sources/draft/:id` | → `DraftView` |
| `POST /api/routines/sources/draft/:id/secret` | `{ name, value }` → `DraftView` |
| `POST /api/routines/sources/draft/:id/refine` | `{ note }` → `DraftView` |
| `DELETE /api/routines/sources/draft/:id` | → `{ ok: true }` |
| `GET /api/routines/recipes` | → `Recipe[]` без поля file |
| `POST /api/routines/recipes/import` | `{ yaml: string }` → `Recipe` (положить в `~/.agentgraph/recipes`) |

Изменения (новое событие в журнале, ожидание, статус источника) — `homeBroadcast({ type: 'routines', runId: '', flow: '' })`
в существующий `/api/events`; UI перечитывает `GET /api/routines`. Ожидания рутин также видны на главной.

## 4. Источники

Вид — объект `SourceKind` (kind.ts). Ядро: `command` (любая команда печатает JSON; `map` — какие поля id/title/…;
ключи — переменными окружения; таймаут 60 с) и расписание (`when.schedule`, cron 5 полей, свой парсер, тик раз в 30 с,
событие `{ source: 'schedule', id: '<routine>@<ISO минуты>' }`). Виды-сервисы (сессия «источники»):

- **slack** — токен пользователя/бота (`SLACK_TOKEN`), каналы; live через Socket Mode, если есть app-токен
  (`SLACK_APP_TOKEN`, пакет `ws` уже в зависимостях), иначе опрос `conversations.history` (минимум 30 с). Поля: channel,
  thread (bool), author, bot (bool), files. reply — `chat.postMessage` в тред. isSelf — свой bot_id / user.
- **telegram** — бот (`TELEGRAM_BOT_TOKEN`), live через long polling `getUpdates`; поля chat, author, is_command.
  reply — `sendMessage` (в чат события или в чат по умолчанию: его запоминает первое сообщение `/start`).
- **gitlab / github** — через существующие `glab`/`gh` (git.ts): новые MR/PR, где я ревьюер или упомянут, новые
  комментарии; reply — комментарий в MR/PR.
- **jira** — существующий клиент jira.ts и сохранённый токен; JQL (по умолчанию «назначено на меня»); события «назначили на меня», «что изменилось» (по changelog), «комментарий или правка без истории» и «новая в выборке», у события — вещь `jira`; reply — комментарий.
- **rss** — fetch + разбор RSS/Atom без новых зависимостей.
- **folder** — новые файлы в папке (опрос списка; text — первые 4 КБ текстового файла).
- **email** — IMAP через `curl` (`imaps://`, SEARCH UNSEEN/SINCE + FETCH заголовков), ключ `EMAIL_PASSWORD`.
- **connector** — подключение claude.ai: сессия haiku через Agent SDK вызывает read-only инструмент-«список» и
  возвращает JSON записей; интервал не меньше 30 мин, `delivery: 'model'`.
  Ответ в источник — по явному выбору: `config.reply = { tool, args }` — один пишущий инструмент сервиса и шаблон его
  аргументов (`{{channel}}`, `{{thread}}` из `event.replyTo`, `{{text}}`); вызывается через `mcp-call` без модели, читать им
  источник нельзя. `SourceView.canReply` у источника — только если ответ настроен; свой ответ при опросе — не событие (`isSelf`).
- **рецепты** — `templates/sources/*.yaml` (несколько примеров на `command`: Fireflies GraphQL, Sentry issues, Linear,
  GitHub notifications) и `~/.agentgraph/recipes`.

**Подключение словами** (`sources/draft.ts`): сессия Agent SDK (sonnet, WebSearch/WebFetch, без записи файлов и без
Bash) по описанию находит API и возвращает JSON `SourceSpec` вида `command` (обычно `curl` с `$ИМЯ_КЛЮЧА`) + как
получить ключ. Нет ключа → `needs_secret`. Есть → `testSource` (без модели). Ошибка проверки → до 2 повторов сессии с
текстом ошибки. `ready` показывает `request` и `sample`; сохранение — обычный `PUT /api/routines/sources/:slug`.
Сессии — через `runSession` из agent.ts с подменой `deps` в тестах.

## 5. Владельцы файлов (сессии работают в одной папке, не коммитят, чужие файлы не трогают)

| Сессия | Файлы |
|---|---|
| ядро | `src/routines/*.ts` (кроме types.ts/kind.ts — только дописывать), `src/runner.ts` (pauseBefore), `src/server.ts` (подключение маршрутов и движка), `src/api-types.ts` (RunSource 'routine'), `src/schema.ts` при нужде |
| источники | `src/routines/sources/**`, `templates/sources/**` |
| интерфейс | `web/**` |
| e2e (после трёх) | `e2e/**`, `package.json` (скрипт e2e, devDependency), правки багов где угодно |

## 6. Проверка

- Юнит: `node:test` рядом с модулем (скилл agentgraph-tests), без сети и настоящего Agent SDK.
- e2e: Playwright (`e2e/`, `npm run e2e`): настоящий сервер на временном порту с `AGENTGRAPH_CONFIG_DIR` и
  `AGENTGRAPH_HOME` во временной папке, `AGENTGRAPH_CLAUDE_EXECUTABLE` → фейковый `claude` (stream-json), фейковые
  HTTP-сервера Slack и Telegram (базовые адреса API видов переопределяются переменными `AGENTGRAPH_SLACK_API`,
  `AGENTGRAPH_TELEGRAM_API`). Сценарии: создать рутину через UI на каждый тип источника (своя команда, словами,
  расписание, Slack, Telegram); событие → условия → проверка словами → запуск → пауза перед блоком → карточка на
  главной → «Чинить» с ответом в тред → ответ ушёл в фейковый Slack; «Это не баг»; suggest; лимиты; журнал и фильтры;
  пауза рутины; простой и «догнать»; пропущенное расписание; редактор и проверка на истории; YAML вручную.
