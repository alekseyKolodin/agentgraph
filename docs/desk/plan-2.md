# Этап 2 — вещи и наблюдатели, план по сессиям

Спека — [SPEC.md](SPEC.md), раздел 3.1 (сигнал → вещь → наблюдатель), раздел 4 (команды работают по-разному), раздел 5
(Slack и коннектор) и раздел 6, «Этап 2». Аудит — [audit/B.md](audit/B.md) (ревью и Jira), [audit/D.md](audit/D.md) (ветки,
сессии), [audit/C.md](audit/C.md) (ключ «то же самое»).

После этапа приложение знает состояние вещей. Дел ещё нет — их делает этап 3.

Пять сессий работают параллельно в своих worktree от ветки `desk`. Общие правила — как в [plan-0.md](plan-0.md). Sonnet —
только с усилием high или xhigh.

## Контракт (уже в `desk`)

- `src/things/types.ts` — `Thing`, `ThingType`, `ThreadRef`, `Turn`, `ThingState`, `Watcher`, формат ключей.
- `src/routines/types.ts` — у `RoutineEvent` поля `things?` и `thread?`; у `FieldMap` пути `thread?` и `channel?`.
- Ключи собирает только `src/things/keys.ts` (сессия things-core): `mrKey`, `jiraKey`, `branchKey`, `threadKey` и
  `parseKey`. Пока things-core не слита, остальные сессии пишут ключи строкой по формату из `types.ts` и в отчёте
  перечисляют места, которые надо перевести на `keys.ts`.
- Реестр наблюдателей — `src/things/index.ts` (things-core): `watchers(): Watcher[]`, `watch(things, signal)`. Каждая
  сессия-наблюдатель экспортирует фабрику своего наблюдателя из своего файла; подключение в реестр — одна строка при слиянии.

## Владение файлами

| Сессия | Пункты | Файлы |
|---|---|---|
| things-core | 2.1, 2.2, 2.9, 2.10 | `src/things/keys.ts`, `resolve.ts`, `index.ts` и тесты; в `src/routines/engine.ts` — разбор ссылок при приходе события и виденное по ключу вещи; `src/routines/sources/forge.ts` (версия в id ревью, комментарии к одному MR за опрос — одно событие); `src/routines/sources/connector.ts` — только заполнение `thread`/`channel` по `FieldMap` и подсказка сборщику; `src/routines/sources/slack.ts` — только `thread` у события |
| watch-forge | 2.3 | `src/things/forge.ts` и тест; `src/attention.ts` (читает общий наблюдатель); опрос PR в `src/teamwork-status.ts` (через общий наблюдатель, автоматика Teamwork не меняется) |
| watch-local | 2.4, 2.5 | `src/things/jira.ts`, `src/things/branch.ts` и тесты; `src/jira.ts` (changelog, пресет «назначено на меня»); `src/git.ts` (грязный checkout, ahead/behind, есть ли MR — через forge-ссылку, без вызова watch-forge); пресет в `src/integrations.ts` |
| work-links | 2.6, 2.7, 2.8 | `RunSource` и поля сессии в `src/api-types.ts`; `startRoutineRun` и продолжение запуска в `src/server.ts`; `src/sessions-server.ts` (источник сессии, «начать сессию» из задачи и MR); `web/src/screens/home/Dash.tsx`, `web/src/lib/dash.ts`, `web/src/api/sessions.ts` |
| connector-reply | 2.11 | `src/routines/sources/connector.ts` — только `reply` и выбор пишущего инструмента; `src/mcp-call.ts`; `web/src/screens/routines/ConnectSource.tsx` и редактор рутины (подсказка «ответ из flow») |

`connector.ts` правят две сессии в разных функциях: things-core — разбор записи (`FieldMap` → событие), connector-reply —
`reply` и настройки ответа. Сливается сначала things-core.

## Правила

- **Чей ход у MR** — по обсуждениям и коммитам, не по полю «ревьюер» (SPEC 3.1): мой ход — есть коммиты или ответы автора
  после моей последней реплики, либо ревью запрошено заново; ход других — последняя реплика моя. «Я» — из профиля
  (`loadProfile` в `src/settings.ts`).
- **Нет доступа** к хосту — `ThingState.exists: false` с понятной `error`, никаких исключений наружу.
- **Наблюдатель не тратит модель.** Только `glab`, `gh`, Jira API, git.

## Порядок слияния

things-core → watch-forge → watch-local → work-links → connector-reply. После — ревью, полный прогон, проверка по
критериям «Готово, когда» этапа 2.
