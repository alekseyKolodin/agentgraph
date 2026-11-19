// Дела вне доски (docs/desk/SPEC.md, этап 5): шапка Главной («N дел, M новых»), пустая доска (ни дел, ни рутин — ведём
// к шаблонам) и ссылка на дело у строк MR и задач в «Коде». Одна вещь — одно место: «Код» только ссылается на карточку.
// Чистая логика без React.
import type { DeskColumn, DeskItem } from '@server/desk/types';
import { locale, plural, t } from './i18n';

export const DESK_COLUMN_LABEL: Record<DeskColumn, string> = { new: 'Новое', plan: 'В плане', work: 'В работе', waiting: 'Ждёт других', done: 'Готово' };

/** Параметр адреса Главной: какую карточку показать (`/?desk=<ключ>`). */
export const DESK_PARAM = 'desk';
export const deskHref = (key: string): string => `/?${DESK_PARAM}=${encodeURIComponent(key)}`;

/** Открытые дела по ключу вещи: строка MR или задачи в «Коде» находит своё дело по ключу из mrThing/jiraThing. */
export function deskByKey(items: readonly DeskItem[] | undefined): Map<string, DeskItem> {
  return new Map((items ?? []).filter((i) => !i.closed).map((i) => [i.key, i]));
}

/** Подпись ссылки на дело: «Дело · В плане». */
export const deskLinkText = (i: Pick<DeskItem, 'column'>): string => t('Дело · {column}', { column: t(DESK_COLUMN_LABEL[i.column]) });

/** Шапка Главной: «среда, 18 ноября · 13 дел, 4 новых». Готовые в счёт не идут — они уже не дела. */
export function deskMeta(items: readonly DeskItem[] | undefined, now: Date = new Date()): string {
  const day = now.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  if (!items) return day;
  const open = items.filter((i) => !i.closed && i.column !== 'done');
  const fresh = open.filter((i) => i.column === 'new').length;
  const n = open.length;
  const count = n ? `${n} ${plural(n, 'дело', 'дела', 'дел')}` : t('дел нет');
  return fresh ? `${day} · ${count}, ${fresh} ${plural(fresh, 'новое', 'новых', 'новых')}` : `${day} · ${count}`;
}

/**
 * Пустая доска: ни одного открытого дела (список useDesk() — открытые) и ни одной рутины. Только по ответам: пока
 * грузится или выключено — не пусто (undefined), чтобы не мигать подсказкой.
 */
export function deskEmpty(items: readonly DeskItem[] | undefined, routines: readonly unknown[] | undefined): boolean {
  return Boolean(items && routines && !items.length && !routines.length);
}
