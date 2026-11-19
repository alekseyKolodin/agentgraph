# Этап 3 — дело, план по сессиям

Спека — [SPEC.md](SPEC.md), раздел 3.2 (дело и правила движения), 3.4 (сверка) и раздел 6, «Этап 3». Аудит —
[audit/C.md](audit/C.md) (одно дело из двух источников), [audit/A.md](audit/A.md) (после простоя и отпуска).

После этапа дела существуют, заводятся отовсюду и ходят сами. Доски ещё нет: дела видны в существующих блоках Главной.

Три сессии работают параллельно в своих worktree от ветки `desk`. Общие правила — как в [plan-0.md](plan-0.md).

## Контракт (уже в `desk`)

- `src/desk/types.ts` — `DeskItem`, `DeskColumn`, `DeskBy`, `DeskSignal`, `DeskPatch`, `DeskFilter`, `DeskApi`, `DeskMove`,
  HTTP-маршруты и событие `{ type: 'desk' }`.
- `src/desk/index.ts` — `openDesk(dir?)` и `desk()`. Пока заглушка; реализацию пишет desk-core. Остальные сессии
  импортируют только эти две функции, а в тестах передают свой `DeskApi` через deps.
- `src/routines/types.ts` — `TaskRule`, поле `task?` у `RoutineSpec`, `deskKey?` у `RoutineWait`.
- Вещи и ключи — `src/things/` (этап 2): `parseKey`, `mrKey` и др. в `keys.ts`, `watch(things, signal)` в `index.ts`,
  `resolveThings` в `resolve.ts`. У события рутины уже есть `things?` и `thread?`.

## Владение файлами

| Сессия | Пункты | Файлы |
|---|---|---|
| desk-core | 3.1, 3.2, 3.10 | `src/desk/index.ts`, `store.ts`, `rules.ts`, `reconcile.ts`, `routes.ts` и тесты; подключение маршрутов и сверки в `src/server.ts` (сверка при старте и по таймеру наблюдателей, итог — `CheckResult` на диске); `web/src/api/desk.ts`; `web/src/screens/home/Attention.tsx`, `Review.tsx` (читают дела, вид не меняется) |
| desk-routine | 3.3, 3.4, 3.8, 3.9 | `src/routines/types.ts` (`run` необязателен при `task`), `src/routines/schema.ts`, `src/routines/engine.ts` (событие → `put` по `same`, первый опрос с `task` заводит дела по текущему списку, ожидание с `task` — дело), `src/routines/routes.ts`; `web/src/screens/routines/RoutineEditor.tsx` и шаги редактора, `web/src/screens/home/RoutineWaits.tsx`, `web/src/lib/routines/**` |
| desk-tools | 3.5, 3.6, 3.7 | `src/desk/tools.ts` (общие описания и обработчики `desk_put`/`desk_close`/`desk_list`) и тест; `src/sessions-mcp.ts` (сессия, проект, ветка подставляются сами); `src/runner.ts` (тот же сервер у этапа flow, запуск привязывается сам; счётчик дел запуска для журнала рутины); `src/cli.ts` (`agentgraph desk add/list/close`) |

## Правила

- **Правила движения — только в `src/desk/rules.ts`** (desk-core): чистая функция `(item | undefined, событие) → item`.
  Таблица SPEC 3.2 переносится в тесты один к одному. Перенос руками держится до следующего изменения вещи — для этого
  поле `seen`.
- **Одно дело на ключ.** `same: thread` даёт ключ `thread:…` (`threadKey`), `same: event` — `own:<источник>/<id события>`.
- **Сверка не тратит модель** и не запускает flow: только наблюдатели этапа 2. После простоя — тот же проход при старте.
- **Открытые дела Teamwork** в хранилище не копируются (этап 4).
- Дела — личные: `<configDir()>/desk/`. В тестах — временная папка через `openDesk(dir)`.

## Порядок слияния

desk-core → desk-tools → desk-routine. После — ревью `code-reviewer`, полный прогон, e2e на сценарий «Готово, когда»
этапа 3 (две рутины на один MR → одно дело; автор ответил → в план; MR смержен при закрытом приложении → после старта в
«Готово»), проверка в браузере.
