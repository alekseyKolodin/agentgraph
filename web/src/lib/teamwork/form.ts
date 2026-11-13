// Состояние экранов и форм Teamwork поверх данных, которые перечитываются сами (событие `team`, опрос, pull): ошибка фоновой
// перечитки не сносит экран с открытым вводом; поле формы, которое человек не трогал, берёт свежее значение, а запись уносит
// только тронутые поля — чужая правка соседнего поля не откатывается.

/** Как показать ошибку запроса: без данных — на весь экран; с данными (упала перечитка) — строкой, экран и ввод остаются. */
export const failView = (error: unknown, hasData: boolean): 'screen' | 'line' | undefined => (error ? (hasData ? 'line' : 'screen') : undefined);

/** Чего нет по ответу 404 на экране проекта: команды (её отключили, ссылка устарела) или проекта. Команда важнее. */
export const missingOf = (teamStatus: number | undefined, projectStatus: number | undefined): 'team' | 'project' | undefined =>
  teamStatus === 404 ? 'team' : projectStatus === 404 ? 'project' : undefined;

export type FormValues = Record<string, string>;

/**
 * Значения формы после перечитки данных: поле, которое поменяли в данных и не трогали в форме (равно прежней базе), — из
 * свежих данных; тронутое — как есть. «Равно» — без пробелов по краям, как в changedFields: иначе поле с хвостовым пробелом
 * не подтянуло бы чужую правку, а запись соседнего поля унесла бы его старое значение. Поле, которое в данных не менялось,
 * не трогается: перечитка из-за другого поля (строка синхронизации) не срезает пробел, который сейчас набирают.
 */
export function rebaseForm<T extends FormValues>(form: T, base: T, next: T): T {
  const out = { ...form };
  for (const k of Object.keys(next) as (keyof T)[]) {
    if (next[k] !== base[k] && (form[k] ?? '').trim() === (base[k] ?? '').trim()) out[k] = next[k];
  }
  return out;
}

/** Поля, изменённые относительно базы формы; значения — без пробелов по краям, как уйдут на сервер. */
export function changedFields<T extends FormValues>(form: T, base: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(form) as (keyof T)[]) {
    const v = form[k]!.trim();
    if (v !== (base[k] ?? '').trim()) out[k] = v as T[keyof T];
  }
  return out;
}
