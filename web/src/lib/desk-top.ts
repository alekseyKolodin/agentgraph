// Полоса над доской (docs/desk/plan-5.md, пункт 5.2): сверка «N из N» словами SPEC 3.4, срез по проектам и подсказка
// пустой доски. Чистая логика без React. «Начни с этого» и срок — одно правило с доской: web/src/lib/desk-board.ts
// (startQueue, dueView).
import type { SpaceListItem } from '@server/api-types';
import type { DeskCheckReply, DeskCheckSource, DeskItem } from '@server/desk/types';
import { clock } from './format';
import { locale, plural, t } from './i18n';

const DAY_MS = 86_400_000;

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

// ---------------------------------------------------------------- пустая доска

export type QuietBoard = { title: string; line: string; tone: CheckTone };

/**
 * Рутины есть, а открытых дел нет: почему пусто — словами сверки, чтобы пустые колонки не выглядели поломкой. Сверки ещё не
 * было — «рутины проверяют источники»; проверено и пусто — когда; есть поломка — она первой (её же видно в «N из N»).
 */
export function quietBoard(reply: DeskCheckReply | undefined, now: Date = new Date()): QuietBoard {
  const sum = checkSummary(reply);
  const title = t('Открытых дел нет');
  if (!sum.total || !reply?.at) return { title, line: t('Рутины проверяют источники: новое появится здесь само.'), tone: 'off' };
  const broken = sum.problems.find((p) => p.status === 'error' || p.status === 'needs_secret');
  if (broken) return { title, line: t('{source}: {state} — пока это не починено, дела оттуда не придут.', { source: broken.title, state: checkText(broken, now) }), tone: sum.tone };
  const ago = checkedAgo(reply, now);
  return { title, line: t('{checked}: {ok} из {total} в порядке, нового нет.', { checked: ago, ok: sum.ok, total: sum.total }), tone: sum.tone };
}
