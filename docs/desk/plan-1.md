# Этап 1 — проект и «кто я», план по сессиям

Спека — [SPEC.md](SPEC.md), раздел 2 (решение «проект = пространство») и раздел 6, «Этап 1». Аудит — [audit/A.md](audit/A.md)
(раздел 1.3, таблица «Единой сущности „проект“ нет») и [audit/E.md](audit/E.md) (1.6).

Две сессии работают параллельно в своих worktree от ветки `desk`. Общие правила — как в [plan-0.md](plan-0.md).

## Владение файлами

| Сессия | Пункты | Файлы |
|---|---|---|
| project | 1.1, 1.2, 1.3, 1.4 | `src/spaces.ts`, `src/projects.ts`, `src/integrations.ts` (только список проектов), поля в `src/api-types.ts`, их тесты; `web/src/lib/runs.ts`, `web/src/lib/session-history.ts`, `web/src/lib/spaces.ts`, `web/src/components/shell/RunList.tsx`, `SessionList*`, подписи проекта в `web/src/screens/home/HomeRuns.tsx`, `Attention.tsx`, `Feed.tsx`, `web/src/screens/spaces/**`, `web/src/screens/code/**`, `web/src/screens/home/Dash.tsx` |
| profile | 1.5 | `src/settings.ts` и тест; экран «Подключения» (где сейчас настройки Jira); `src/routines/sources/slack.ts`, `src/routines/sources/connector.ts` — только `isSelf` и «обращено ко мне»; поле профиля в `src/api-types.ts` |

## Контракт

Проект — пространство (`spaces.ts`). Сессия project добавляет:

```ts
// src/api-types.ts
export type ProjectRef = { space: string; title: string } | { space: null; title: 'Без проекта' };
```

и одну серверную функцию `projectOfPath(path): ProjectRef` (корень git → репозиторий → пространство, к которому он привязан;
иначе — пространство, чья папка содержит путь: папка самого пространства — всегда, рабочая папка и папки чтения — только
для путей вне git; иначе «Без проекта»). Запуски, сессии, MR и рутины получают проект
через неё; веб получает уже готовый `ProjectRef`, а не вычисляет его сам.

Профиль (сессия profile):

```ts
// src/api-types.ts
export type Profile = { names: string[]; emails: string[]; gitlab?: string; github?: string; slackUserId?: string; jiraEmail?: string };
```

`GET/PUT /api/settings/profile`; пустые поля заполняются сами из `glab`, `gh`, `git config` и настроек Jira при первом чтении.
`isSelf` у вида `connector`: автор события совпал с профилем → не событие.

## Порядок слияния

profile → project. После слияния — ревью и проверка в браузере: один репозиторий подписан одинаково в запусках, сессиях,
MR и рутине; шестой проект добавляется в одном месте.
