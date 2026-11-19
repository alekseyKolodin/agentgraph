// Полоса над доской (docs/desk/plan-5.md, пункт 5.2): «Начни с этого», сверка «N из N» словами SPEC 3.4 и срез по
// проектам. Чистая логика без React. «Начни с этого» по контракту — из web/src/lib/desk-board.ts (сессия board); пока его
// нет, своя — здесь (при слиянии оставить одну).
import type { SpaceListItem } from '@server/api-types';
import type { DeskCheckReply, DeskCheckSource, DeskItem } from '@server/desk/types';
import { clock } from './format';
import { locale, plural, t } from './i18n';

const DAY_MS = 86_400_000;

/** Ход мой и дело не закрыто: «Ждёт других» и «Готово» не начинают. */
const startable = (i: DeskItem) => !i.closed && i.column !== 'done' && i.column !== 'waiting';

/**
 * Местный день (ГГГГ-ММ-ДД) срока: у срока датой («2026-11-27») — сама дата; полночь UTC («2026-11-27T00:00:00Z» — так
 * дату присылают сервисы) — тоже дата, иначе к западу от Гринвича срок съехал бы на день раньше; у срока со временем — его
 * местный день.
 */
export function dueDay(due: string): string | undefined {
  const date = /^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.0+)?)?Z)?$/.exec(due);
  if (date) return date[1];
  const d = new Date(due);
  return Number.isNaN(d.getTime()) ? undefined : localDay(d);
}

/** Срок со временем (не датой): прошёл момент — просрочено, даже если день сегодняшний. */
const dueMoment = (due: string): number | undefined => (/T/.test(due) && !/T00:00(?::00(?:\.0+)?)?Z$/.test(due) ? Date.parse(due) : undefined);

const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export type StartWhy = 'overdue' | 'today' | 'myTurn' | 'fresh';
export type StartPick = { item: DeskItem; why: StartWhy };

/**
 * Порядок «Начни с этого» без модели: просрочено (раньше срок — раньше) → срок сегодня → дольше всех мой ход (ход по вещи
 * мой, дольше всех в колонке) → самое свежее в «Новом». Остальные дела в порядок не входят.
 */
export function startOrder(items: readonly DeskItem[], now: Date = new Date()): StartPick[] {
  const today = localDay(now);
  const open = items.filter(startable);
  const used = new Set<string>();
  const take = (list: DeskItem[], why: StartWhy): StartPick[] =>
    list.filter((i) => (used.has(i.key) ? false : (used.add(i.key), true))).map((item) => ({ item, why }));
  const dated = open.flatMap((i) => {
    const day = i.due ? dueDay(i.due) : undefined;
    if (!day) return [];
    // срок со временем уже прошёл — просрочено, сегодня это или нет
    const at = i.due ? dueMoment(i.due) : undefined;
    return [{ i, day, late: day < today || (at !== undefined && at < now.getTime()) }];
  });
  const byMoved = (a: DeskItem, b: DeskItem) => a.movedAt.localeCompare(b.movedAt);
  const overdue = dated.filter((x) => x.late).sort((a, b) => a.day.localeCompare(b.day) || byMoved(a.i, b.i)).map((x) => x.i);
  const dueToday = dated.filter((x) => !x.late && x.day === today).sort((a, b) => byMoved(a.i, b.i)).map((x) => x.i);
  const myTurn = open.filter((i) => i.turn === 'me').sort(byMoved);
  const fresh = open.filter((i) => i.column === 'new').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...take(overdue, 'overdue'), ...take(dueToday, 'today'), ...take(myTurn, 'myTurn'), ...take(fresh, 'fresh')];
}

/** Почему это первым — одной строкой под карточкой. */
export function startWhyText(p: StartPick, now: Date = new Date()): string {
  switch (p.why) {
    case 'overdue': {
      const day = p.item.due ? dueDay(p.item.due) : undefined;
      return day ? t('просрочено: срок был {date}', { date: dayLabel(day) }) : t('просрочено');
    }
    case 'today':
      return t('срок сегодня');
    case 'myTurn':
      return t('твой ход {age}', { age: ageText(p.item.movedAt, now) });
    case 'fresh':
      return t('новое, пришло {age} назад', { age: ageText(p.item.createdAt, now) });
  }
}

/** «27 ноября» по местному дню. */
const dayLabel = (day: string): string => {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
};

/** Сколько прошло крупно: «5 мин», «3 ч», «2 дня». */
export function ageText(iso: string, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - Date.parse(iso));
  const m = Math.floor(ms / 60_000);
  if (m < 60) return t('{n} мин', { n: Math.max(1, m) });
  const h = Math.floor(m / 60);
  if (h < 24) return t('{n} ч', { n: h });
  const d = Math.floor(ms / DAY_MS);
  return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
}

// ---------------------------------------------------------------- сверка

export type CheckTone = 'ok' | 'wait' | 'fail' | 'off';

/** Цвет точки: сломано — красный, молчит или нет ключа — жёлтый, не проверялось — серый. */
export function checkTone(s: Pick<DeskCheckSource, 'status'>): CheckTone {
  return s.status === 'ok' ? 'ok' : s.status === 'error' ? 'fail' : s.status === 'unchecked' ? 'off' : 'wait';
}

/** «обычно 3 в день» / «обычно раз в день» / «обычно раз в 5 дней». */
export function usualText(usual: number): string {
  if (usual >= 1.5) return t('обычно {n} в день', { n: Math.round(usual) });
  if (usual >= 0.75) return t('обычно раз в день');
  const n = Math.max(2, Math.round(1 / usual));
  return t('обычно раз в {n} {days}', { n, days: plural(n, 'день', 'дня', 'дней') });
}

/**
 * Состояние строки сверки словами SPEC 3.4: «проверено 09:12, 14 записей, 2 новых», «проверено, пусто 6 дней — обычно 3 в
 * день», «сломано: ключ не принят», «нет ключа», «не проверялось с запуска приложения». У наблюдателей — вещи и сколько
 * дел передвинулось.
 */
export function checkText(s: DeskCheckSource, now: Date = new Date()): string {
  const r = s.result;
  switch (s.status) {
    case 'error':
      return t('сломано: {error}', { error: s.error ?? r?.error ?? t('проверка не прошла') });
    case 'needs_secret':
      return t('нет ключа');
    case 'unchecked':
      return t('не проверялось с запуска приложения');
    case 'empty': {
      const since = r?.emptySince ? Date.parse(r.emptySince) : NaN;
      const days = Number.isFinite(since) ? Math.floor((now.getTime() - since) / DAY_MS) : 0;
      const empty = days ? t('проверено, пусто {n} {days}', { n: days, days: plural(days, 'день', 'дня', 'дней') }) : t('проверено, пусто');
      return s.usual ? `${empty} — ${usualText(s.usual)}` : empty;
    }
    case 'ok': {
      if (!r) return t('проверено');
      const at = clock(r.at, now);
      if (s.kind === 'watcher') {
        const things = `${r.total} ${plural(r.total, 'вещь', 'вещи', 'вещей')}`;
        return r.fresh ? t('проверено {at}, {things}, передвинуто {n}', { at, things, n: r.fresh }) : t('проверено {at}, {things}', { at, things });
      }
      const records = `${r.total} ${plural(r.total, 'запись', 'записи', 'записей')}`;
      return r.fresh
        ? t('проверено {at}, {records}, {fresh}', { at, records, fresh: `${r.fresh} ${plural(r.fresh, 'новая', 'новых', 'новых')}` })
        : t('проверено {at}, {records}', { at, records });
    }
  }
}

export type CheckSummary = { ok: number; total: number; tone: CheckTone; problems: DeskCheckSource[] };

/**
 * «N из N»: сколько строк сверки в порядке из всех. problems — что показать сразу, не раскрывая: сломано, нет ключа,
 * молчит дольше обычного. «Не проверялось» — не поломка: его видно в раскрытом списке.
 */
export function checkSummary(reply: DeskCheckReply | undefined): CheckSummary {
  const list = reply?.sources ?? [];
  const ok = list.filter((s) => s.status === 'ok').length;
  const problems = list.filter((s) => s.status === 'error' || s.status === 'needs_secret' || s.status === 'empty');
  const tone: CheckTone = problems.some((s) => s.status === 'error') ? 'fail' : problems.length ? 'wait' : ok === list.length && list.length ? 'ok' : 'off';
  return { ok, total: list.length, tone, problems };
}

/** «Проверено 2 мин назад» по самой свежей проверке; проверок ещё не было — пусто. */
export function checkedAgo(reply: DeskCheckReply | undefined, now: Date = new Date()): string {
  if (!reply?.at) return '';
  const m = Math.floor((now.getTime() - Date.parse(reply.at)) / 60_000);
  if (m < 1) return t('Проверено только что');
  if (m < 60) return t('Проверено {m} {minutes} назад', { m, minutes: plural(m, 'минуту', 'минуты', 'минут') });
  return t('Проверено в {at}', { at: clock(reply.at, now) });
}

// ---------------------------------------------------------------- срез по проектам

/** Проект в срезе: слаг пространства ('' — без проекта), заголовок, открытых дел, сколько сессий и запусков идёт. */
export type ProjectSlice = { project: string; title: string; count: number; live: number };

/**
 * Срез по проектам: открытые дела по пространствам, больше дел — левее; «Без проекта» — последним. Заголовок и «идёт N» —
 * из списка пространств; пространства нет в списке (удалено) — слаг как есть.
 */
export function projectSlices(items: readonly DeskItem[], spaces: readonly SpaceListItem[] = []): { all: number; slices: ProjectSlice[] } {
  const open = items.filter((i) => !i.closed && i.column !== 'done');
  const by = new Map<string, number>();
  for (const i of open) by.set(i.project ?? '', (by.get(i.project ?? '') ?? 0) + 1);
  const space = new Map(spaces.map((s) => [s.slug, s]));
  const slices = [...by].map(([project, count]): ProjectSlice => {
    const s = space.get(project);
    return { project, title: project ? (s?.title ?? project) : t('Без проекта'), count, live: s?.live ?? 0 };
  });
  slices.sort((a, b) => Number(!a.project) - Number(!b.project) || b.count - a.count || a.title.localeCompare(b.title, locale()));
  return { all: open.length, slices };
}
