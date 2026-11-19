# Этап 4 — источники дел, план по сессиям

Спека — [SPEC.md](SPEC.md), раздел 4 (команды работают по-разному), раздел 5 (Slack через коннектор) и раздел 6, «Этап 4».
Аудит — [audit/B.md](audit/B.md) (ревью, Jira, встречи), [audit/D.md](audit/D.md) (забытое), [audit/E.md](audit/E.md)
(Teamwork).

После этапа дела наполняются сами: новый пользователь с GitLab, Jira и Slack получает их за четыре шаблона, не написав
ни одного flow.

Начинается после слияния этапа 3: все сессии опираются на `desk()` (`src/desk/index.ts`), блок `task` у рутины и
инструменты `desk_*`. Общие правила — как в [plan-0.md](plan-0.md).

## Владение файлами

| Сессия | Пункты | Файлы |
|---|---|---|
| src-projects | 4.1, 4.2 | `src/routines/sources/projects.ts` и тест, регистрация вида в `sources/index.ts`; `src/session-review.ts` (итог на сервере, по расписанию, без границы в 14 дней); `web/src/screens/home/Review.tsx` |
| src-teamwork | 4.3 | `src/desk/providers/teamwork.ts` и тест; подключение поставщика в `src/desk/index.ts` (`list` сливает дела хранилища и поставщика); `src/teamwork-server.ts` (мои незакрытые задачи, включая бэклог; назначение и комментарий коллеги — сигналы); `web/src/screens/teamwork/MyTasks.tsx`, `web/src/lib/teamwork/mine.ts` |
| src-jira-meet | 4.4, 4.5 | `src/routines/sources/jira.ts` («назначили на меня», «что изменилось» по changelog); `templates/sources/fireflies.yaml`, разбор встреч в `src/routines/sources/connector.ts` и `src/routines/check.ts` (фильтр не по дате встречи, срок от даты встречи, «мои» по профилю, повторяющаяся встреча — не дубль) |
| src-templates | 4.6, 4.7 | `templates/flows/` (ревью MR, задача в работу, встреча → дела, обход проектов), подстановка flow шаблоном; `web/src/screens/routines/NewRoutine.tsx`, `RoutinesList.tsx` — шаблоны «ревью: назначили в GitLab/GitHub» и «ревью: кинули ссылку в Slack» (Slack — вид `connector`, SPEC 9.1) |

## Правила

- **Шаблон рутины = источник + `task` + flow.** Дело заводит событие (`task.from: event`) или flow инструментом `desk_put`
  (`from: flow`) — не оба.
- **Источник-снимок** («Проекты»): пропало из списка — дело закрыто (`close`, `by: 'routine'`).
- **Teamwork не копируется** в `items.json`: поставщик отдаёт дела на лету, колонка — из статуса задачи.
- **Без модели**, где можно: источник «Проекты» и поставщик Teamwork — только git, файлы сессий и API Teamwork.

## Порядок слияния

src-jira-meet → src-projects → src-teamwork → src-templates. После — ревью, полный прогон, проверка «Готово, когда» на
чистой папке настроек (`AGENTGRAPH_CONFIG_DIR` во временной папке): четыре шаблона → наполненные дела.
