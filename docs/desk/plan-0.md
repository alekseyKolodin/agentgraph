# Этап 0 — починки, план по сессиям

Спека — [SPEC.md](SPEC.md), раздел 6, «Этап 0». Аудит с путями к коду — [audit/](audit/).

Четыре сессии работают параллельно, каждая в своём worktree от ветки `desk` и правит только свои файлы. Оркестратор
сливает ветки в `desk` после проверки.

## Общие правила

- Перед правкой `src/` — скилл `agentgraph-core`, перед `web/` — `agentgraph-web`, для тестов — `agentgraph-tests`.
- Правь только файлы своей строки. Нужна правка чужого файла — минимальная, с пометкой в отчёте.
- Контракты (`src/routines/types.ts`, `src/api-types.ts`) только дополняются.
- Тексты интерфейса — по-русски, коротко, как в соседних экранах; английский перевод — в `web/src/i18n/en/*`.
- Готово, когда `npm run typecheck && npm test` зелёные (для `web/` ещё `npm run build:web`), новое поведение покрыто
  тестом, всё закоммичено в свою ветку, отчёт перечисляет сделанное, непроверенное и правки чужих файлов.

## Владение файлами

| Сессия | Пункты | Файлы |
|---|---|---|
| rt-engine | 0.1, 0.2, 0.3, 0.4, 0.5, 0.12 | `src/routines/store.ts`, `engine.ts`, `types.ts`, `routes.ts`, `sources/connector.ts` и их тесты; `src/notify.ts`; в `src/server.ts` — только уведомления о конце запуска; `web/src/lib/routines/**`, `web/src/api/routines.ts`, `web/src/screens/home/RoutineWaits.tsx` и `HomeScreen.tsx` (строка о сломанном источнике) |
| slack-feed | 0.6, 0.8 | `src/routines/sources/slack.ts` и тест; `src/feed.ts` и тест; в `src/server.ts` — только место, где запуск помечается `interrupted` |
| sessions-wait | 0.7, 0.9 | `src/sessions.ts`, `src/sessions-server.ts` и их тесты; поля сессии в `src/api-types.ts`; `web/src/lib/sessions.ts`, `web/src/api/sessions.ts`, `web/src/screens/sessions/**`, отображение «ждёт» в `web/src/components/shell/Sidebar.tsx` и `web/src/screens/home/HomeSessions.tsx` |
| routine-ui | 0.10, 0.11 | `web/src/screens/routines/NewRoutine.tsx`, `RoutineEditor.tsx`, `RoutinesList.tsx`, `web/src/i18n/en/routines.ts`, `web/src/screens/run/pauseAnswer.ts` |

## Контракт между сессиями

`CheckResult` (rt-engine) — в `src/routines/types.ts`:

```ts
export type CheckResult = { at: string; ok: boolean; total: number; fresh: number; error?: string; emptySince?: string };
```

`SourceView` получает `check?: CheckResult` и статус `'empty'` (пусто дольше обычного) и `'unchecked'` (не проверялось
с запуска). routine-ui этих полей не трогает: список рутин показывает статус через существующий `web/src/lib/routines/view.ts`,
который правит rt-engine.

## Порядок слияния

slack-feed → routine-ui → sessions-wait → rt-engine (больше всех правит общие файлы, сливается последней).
После слияния — полный прогон, `code-reviewer`, проверка в браузере по критериям «Готово, когда» этапа 0.
