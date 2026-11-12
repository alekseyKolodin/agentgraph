# Сессия flows (волна 1): что лежит в templates/teamwork/flows/ и что нужно соседям

Ветка `claude/tw-flows-81013e`. Файлы: `templates/teamwork/flows/teamwork-{prd,architecture,split,task}.yaml`,
`src/teamwork-flows.test.ts`, «Задача:»/«Task:» в `composeInput` (`src/intake.ts`, тест в `src/intake.test.ts`).
Полное описание входа каждого flow — комментарий в начале его файла, с примером.

## Для drafts (волна 2): как собирать вход

Все четыре flow — анкета в `input` (строки `Поле: <…>`). Строки с нашими значениями заполняются на месте, строки с текстом
людей получают значение блоком `source-data` с новой строки (как `wrapData` из `src/intake.ts`):

```
Проект: invoice-export · «Экспорт счетов»
Суть проекта:
<source-data>
Бухгалтерия выгружает счета за период в CSV и 1С
</source-data>
Что сделать:
<source-data>
Добавь журнал выгрузок
</source-data>
Раздел: весь документ            | ## Требования   (режим «только раздел»: «С агентом…»)
Новые номера: FR-9, NFR-3        (только prd: nextRequirementId(prd, 'FR'/'NFR'))
Что писать: архитектура | дизайн | оба   (только architecture)
Папка проекта: /abs/path/to/projects/<slug>   (доп. папка только на чтение)
Репо кода:                       (только split: список с новой строки, по строке на репо)
- billing — git@github.com:acme/billing.git, ветка main, рабочая папка запуска
- docs-site — url, ветка main, дополнительная папка | локально нет
Существующие задачи (номер · заголовок · тип · статус · исполнитель · требования · ждёт):   (только split)
<source-data>
- PAY-14 · Шаблон выгрузки для 1С · feature · in_progress · alex@example.com · FR-3 · PAY-13
</source-data>
```

Папка запуска — основной репо кода проекта. Текущие документы — в `initial` артефактов: prd → `prd`,
architecture.md/design.md → `architecture`/`design`. `notes.initial` = `[]`, `tasks.initial` = `{ "tasks": [] }` не менять.

Артефакты и их файлы: `prd` (prd.md), `notes` (notes.json: `[{ "at": "FR-3" | "## Раздел", "why": "фраза" }]`;
у teamwork-architecture в записи ещё `"doc": "architecture" | "design"` — разделы с одним названием есть в обоих документах,
это дополнение к spec §9.1, его должны знать drafts и ui-docs),
`architecture` (architecture.md), `design` (design.md), `tasks` (tasks.json по схеме spec §9.1, ключи `t1, t2…`,
`dependsOn` — ключи или номера существующих задач). У teamwork-task артефактов нет.

## Для work (волна 2): teamwork-task

Анкета — `Задача: <…>` и `Ветка: <…>`; `composeInput(spec.input, { ticket: 'PAY-12', branch: 'tw/PAY-12-…' }, текст §9.4)`
заполняет обе строки. Ниже — текст задачи ровно как в spec §9.4. Судья проверяет критерии приёмки по коду, тесты — по
выводу этапа (у судьи нет Bash). Flow не пушит и не открывает PR. У цикла `pause_marker: <NEEDS_USER>`: невыполнимый
критерий ставит запуск на паузу (статус задачи по §10 не меняется: запуск не done и не упал), человек отвечает и
продолжает.

## Формат требований в prd.md

Промпт teamwork-prd требует строки `- FR-1. Текст.` и `- NFR-1. Текст.` (точка после номера), как `REQUIREMENT_RE` в
`src/teamwork.ts`; формат обязательный, «сохранять оформление документа» для требований убрано. Тест
`src/teamwork-flows.test.ts` прогоняет примеры из промпта через `REQUIREMENT_RE`.
