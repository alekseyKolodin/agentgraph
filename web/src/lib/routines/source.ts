// «Подключить сервис»: интервал опроса, сборка SourceSpec для «Своей команды» и «Готовых» (форма из setup вида),
// строки «нашёл N записей» из пробной проверки.
import type { FieldMap, KindField, RoutineEvent, SourceCheckNow, SourceKindView, SourceSpec } from '@server/routines/types';
import { clock } from '../format';
import { locale, plural, t } from '../i18n';

/** '30s' | '5m' | '1h' → мс; не разобрать — NaN. */
export function everyMs(every: string): number {
  const m = /^(\d+)\s*(s|m|h)$/.exec(every.trim());
  if (!m) return NaN;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'];
}

const STEPS = ['30s', '1m', '5m', '15m', '30m', '1h', '3h'];

/** Интервалы на выбор: не чаще минимума вида. */
export function everyOptions(minEvery: string | undefined): string[] {
  const min = minEvery ? everyMs(minEvery) : 0;
  const list = STEPS.filter((s) => !(everyMs(s) < min));
  return list.length ? list : [minEvery ?? '5m'];
}

/** «каждые 5 минут», «каждые 30 секунд», «каждый час». */
export function everyLabel(every: string): string {
  const m = /^(\d+)\s*(s|m|h)$/.exec(every.trim());
  if (!m) return every;
  const n = Number(m[1]);
  if (m[2] === 's') return t('каждые {n} {w}', { n, w: plural(n, 'секунду', 'секунды', 'секунд') });
  if (m[2] === 'm') return n === 1 ? t('каждую минуту') : t('каждые {n} {w}', { n, w: plural(n, 'минуту', 'минуты', 'минут') });
  return n === 1 ? t('каждый час') : t('каждые {n} {w}', { n, w: plural(n, 'час', 'часа', 'часов') });
}

/** Поля записи «Своей команды» по умолчанию: команда печатает список объектов с id, title, text, link. */
export const DEFAULT_MAP: FieldMap = { id: 'id', title: 'title', text: 'text', link: 'link' };
export const MAP_KEYS: Array<keyof FieldMap> = ['items', 'id', 'title', 'text', 'link', 'at', 'author'];

/** Подпись поля записи в форме «Своей команды». */
export function mapLabel(k: keyof FieldMap): string {
  return { items: t('Список записей'), id: 'id', title: t('название'), text: t('текст'), link: t('ссылка'), at: t('время'), author: t('автор'), thread: t('тред'), channel: t('канал') }[k];
}

/** Название по умолчанию из команды: первое слово-программа и следующее («gh api»). */
export function commandTitle(cmd: string): string {
  const words = cmd.trim().split(/\s+/).filter((w) => !/^[-'"$]/.test(w));
  return words.slice(0, 2).join(' ') || t('Своя команда');
}

/** «Своя команда» → SourceSpec вида command; пустые пути map не пишутся, id обязателен. */
export function commandSpec(cmd: string, title: string, map: FieldMap, every: string): SourceSpec {
  const clean = Object.fromEntries(Object.entries(map).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, (v as string).trim()])) as FieldMap;
  return { title: title.trim() || commandTitle(cmd), kind: 'command', config: { command: cmd.trim() }, every, map: { ...clean, id: clean.id || 'id' } };
}

/** Значения формы вида → SourceSpec и ключи отдельно: секретные поля в файл источника не попадают. */
export function kindSpec(kind: Pick<SourceKindView, 'kind' | 'title' | 'setup'>, values: Record<string, string>, title: string, every: string | undefined): { spec: SourceSpec; secrets: Record<string, string> } {
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  const names: string[] = [];
  for (const f of kind.setup) {
    const v = (values[f.key] ?? '').trim();
    if (f.secret) {
      names.push(f.key);
      if (v) secrets[f.key] = v;
    } else if (v) config[f.key] = v;
  }
  const spec: SourceSpec = { title: title.trim() || kind.title, kind: kind.kind, config, ...(every ? { every } : {}), ...(names.length ? { secrets: names } : {}) };
  return { spec, secrets };
}

/** Чего не хватает в форме вида: обязательные поля без значения (ключи, которые уже сохранены, — не обязательны). */
export function missingFields(setup: KindField[], values: Record<string, string>, savedSecrets: string[] = []): KindField[] {
  return setup.filter((f) => !f.optional && !(values[f.key] ?? '').trim() && !(f.secret && savedSecrets.includes(f.key)));
}

/** «Сервис отвечает. Нашёл 3 записи.» */
export function foundText(total: number, command = false): string {
  const w = plural(total, 'запись', 'записи', 'записей');
  return command ? t('Команда отработала. Нашёл {n} {w}.', { n: total, w }) : t('Сервис отвечает. Нашёл {n} {w}.', { n: total, w });
}

/** Итог «Проверить сейчас» одной фразой: что нашлось и что стало с новым. */
export function checkNowText(r: SourceCheckNow): string {
  if (!r.ok) return r.error ?? t('не отвечает');
  const nw = plural(r.fresh, 'событие', 'события', 'событий');
  if (!r.routines) return t('Нашёл {n} {w}. Ни одной включённой рутине этот источник не нужен — события не обрабатывались.', { n: r.total, w: plural(r.total, 'запись', 'записи', 'записей') });
  if (r.first) return t('Первая проверка: {n} {w} запомнил как «уже были», ничего не запускал. Новое запустится по правилам.', { n: r.fresh, w: plural(r.fresh, 'запись', 'записи', 'записей') });
  if (!r.fresh) return t('Новых событий нет (в сервисе {n}).', { n: r.total });
  const parts = [
    r.started ? t('запущено {n}', { n: r.started }) : '',
    r.waiting ? t('ждёт тебя {n}', { n: r.waiting }) : '',
    r.tasks ? t('заведено дел {n}', { n: r.tasks }) : '',
    r.skipped ? t('пропущено {n}', { n: r.skipped }) : '',
    r.errors ? t('ошибок {n}', { n: r.errors }) : '',
    r.retrying ? t('повторит запуск {n}', { n: r.retrying }) : '',
  ].filter(Boolean);
  return parts.length ? t('{fresh} новых {w}: {parts}.', { fresh: r.fresh, w: nw, parts: parts.join(', ') }) : t('{fresh} новых {w}, ни одна рутина их не взяла (свои сообщения или чужой источник).', { fresh: r.fresh, w: nw });
}

/** Строка найденной записи: заголовок и время. */
export function foundRow(e: Pick<RoutineEvent, 'title' | 'text' | 'at' | 'id'>, now: Date = new Date()): { title: string; meta: string } {
  const title = e.title || e.text.split('\n')[0] || e.id;
  if (!e.at) return { title, meta: '' };
  const d = new Date(e.at);
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const meta = d.toDateString() === now.toDateString() ? t('сегодня {time}', { time }) : d.toDateString() === y.toDateString() ? t('вчера {time}', { time }) : clock(e.at, now);
  return { title, meta };
}
