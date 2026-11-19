// Дела в существующих блоках Главной (SPEC этап 3, 3.10): доски ещё нет, и открытые дела, где ход мой, видны в «MR ·
// нужно внимание» (дела о MR) и в «Не доделано» (сессии, ветки, «Забытое»). Чистая логика без React.
import type { DeskColumn, DeskItem } from '@server/desk/types';

/** Ход мой: «Ждёт других» и «Готово» на Главную не выносим. */
const MINE: readonly DeskColumn[] = ['new', 'plan', 'work'];

const open = (i: DeskItem) => !i.closed && MINE.includes(i.column);

/** Адрес без хвостового «/» и «#…» — чтобы MR из «Подключений» и дело о нём совпали. */
const normUrl = (u: string | undefined): string => (u ?? '').trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();

export type DeskMrRow = { key: string; sign: '!' | '#'; num: string; title: string; url?: string; project?: string; why: string; kind: string };

/** Адрес для ссылки — только http(s): ссылки сигналов приходят от рутин как есть. */
const web = (u: string | undefined): string | undefined => (u && /^https?:\/\//i.test(u) ? u : undefined);
const urlOf = (i: DeskItem): string | undefined => web(i.thing?.url) ?? web(i.links.mr) ?? i.signals.map((s) => web(s.link)).find(Boolean);

/**
 * Дела о MR для блока «MR · нужно внимание»: открытые, ход мой, и не те, что блок уже показал из «Подключений»
 * (сравнение по адресу MR). Свежие сверху — как отдаёт сервер.
 */
export function deskMrRows(items: readonly DeskItem[] | undefined, shownUrls: readonly string[]): DeskMrRow[] {
  if (!items?.length) return [];
  const shown = new Set(shownUrls.map(normUrl));
  return items.flatMap((i) => {
    if (i.thing?.type !== 'mr' || !open(i)) return [];
    const url = urlOf(i);
    if (url && shown.has(normUrl(url))) return [];
    const ref = i.thing.ref;
    const num = typeof ref.number === 'number' || typeof ref.number === 'string' ? String(ref.number) : (i.key.match(/\/(\d+)$/)?.[1] ?? '');
    return [{ key: i.key, sign: ref.forge === 'github' ? '#' : '!', num, title: i.title, ...(url ? { url } : {}), ...(i.project ? { project: i.project } : {}), why: i.why, kind: i.kind }];
  });
}

export type DeskLeftRow = { key: string; title: string; session?: string; project?: string; why: string; kind: string };

/** Что относится к «Не доделано»: сессии, ветки и «Забытое». */
const LEFT_TYPES = new Set(['session', 'branch']);

/** Дела для «Не доделано»: открытые, ход мой; сессии, которые уже показал разбор модели, — не дублируем. */
export function deskLeftRows(items: readonly DeskItem[] | undefined, shownSessions: readonly string[]): DeskLeftRow[] {
  if (!items?.length) return [];
  const shown = new Set(shownSessions);
  return items.flatMap((i) => {
    if (!open(i) || !(LEFT_TYPES.has(i.thing?.type ?? '') || i.kind === 'Забытое')) return [];
    const session = i.thing?.type === 'session' && typeof i.thing.ref.id === 'string' ? i.thing.ref.id : i.key.startsWith('session:') ? i.key.slice('session:'.length) : undefined;
    if (session && shown.has(session)) return [];
    return [{ key: i.key, title: i.title, ...(session ? { session } : {}), ...(i.project ? { project: i.project } : {}), why: i.why, kind: i.kind }];
  });
}
