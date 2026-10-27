// Английский словарь: fix. Ключ — русский текст из t() как есть.
export const fix: Record<string, string> = {
  // поле указания и указания на карточках (FixPanel.tsx, Overview.tsx)
  'Указание': 'Instruction',
  'Указание до конца запуска': 'Instruction for the rest of the run',
  'Без галочки — только следующему шагу': 'Unchecked — for the next step only',
  'до конца запуска': 'for the rest of the run',
  'Дать указание': 'Give instruction',
  'Ждущие указания': 'Pending instructions',
  'ждёт следующего шага': 'waits for the next step',
  'Указание следующему шагу: что поправить или учесть — этот этап уже идёт': 'Instruction for the next step: what to fix or keep in mind — this phase is already running',
  'Указание следующему шагу: что поправить или учесть — проверка уже идёт': 'Instruction for the next step: what to fix or keep in mind — the check is already running',
  'Указание следующему шагу: что поправить или учесть. Потом — «Возобновить»': 'Instruction for the next step: what to fix or keep in mind. Then — "Resume"',

  // действия на паузе (FixPanel.tsx)
  'Починить и продолжить этот запуск': 'Fix and continue this run',
  'Повторить итерацию': 'Repeat iteration',
  'Повторить итерацию? Недоделанные шаги итерации {it}, если они есть, не пойдут: дальше — итерация {next}, лимит блока {from} → {to}.':
    'Repeat the iteration? The unfinished steps of iteration {it}, if any, will not run: next comes iteration {next}, block limit {from} → {to}.',
  'Указание: {text}': 'Instruction: {text}',
  'Итерация {it} · лимит {max}': 'Iteration {it} · limit {max}',
  'Оставшиеся шаги итерации не пойдут: начнётся итерация {next}, указание из поля — в её {{feedback}}, лимит блока +1':
    'The remaining steps of the iteration will not run: iteration {next} starts, the instruction from the field goes to its {{feedback}}, block limit +1',
  'Править flow запуска': 'Edit the run\'s flow',
  'Поправить снимок flow этого запуска: следующие шаги пойдут по нему': 'Edit this run\'s flow snapshot: the next steps will follow it',
  'Взять flow из flows/': 'Take the flow from flows/',
  'Поправил flow в Claude Code: следующие шаги пойдут по текущей версии из flows/': 'Fixed the flow in Claude Code: the next steps will follow the current version from flows/',
  'Flow запуска взят из flows/: {list}': 'The run\'s flow was taken from flows/: {list}',
  'В flows/ та же версия flow: менять нечего': 'flows/ has the same version of the flow: nothing to change',

  // диалог правки (RunFlowDialog.tsx)
  'Правка действует только в этом запуске: следующие шаги пойдут по ней. Пройденные блоки, имя, задачу и объявления артефактов менять нельзя.':
    'The edit applies to this run only: the next steps will follow it. Finished blocks, the name, the task and artifact declarations can\'t be changed.',
  'Загружаю снимок…': 'Loading the snapshot…',
  'Сохранить и в flows/{name}.yaml': 'Also save to flows/{name}.yaml',
  'Применить к запуску': 'Apply to the run',
  'Flow запуска поправлен: {list}': 'The run\'s flow was edited: {list}',
  'Запуск уже идёт по этой версии; в flows/ сохранено': 'The run already follows this version; saved to flows/',
  'Изменений нет: запуск идёт по этой версии': 'No changes: the run already follows this version',
  'Правка не подходит идущему запуску — он пойдёт по-старому:': 'The edit doesn\'t fit the running run — it will go on as before:',

  // повтор итерации и правки flow в отчёте (Overview.tsx, lib/run/view.ts, runner-text.ts)
  'Итерация перезапущена': 'Iteration restarted',
  '↺ перезапущена': '↺ restarted',
  'перезапущено пользователем': 'restarted by the user',
  'flow правили на ходу: {n}': 'flow edited mid-run: {n}',
  'из flows/': 'from flows/',
  'правка снимка': 'snapshot edit',
  'и в flows/': 'also to flows/',
  'Новый запуск по снимку flow этого запуска (его правили на ходу): пройденные блоки не повторяются':
    'A new run with this run\'s flow snapshot (it was edited mid-run): finished blocks are not repeated',
};
