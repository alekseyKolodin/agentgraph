// Форматирование дат, денег и длительностей для интерфейса: как хелперы старого ui/app.js и ui/feed.js. Без React и DOM.

/** Дата и время коротко: «24.10.2026, 20:59». Пустая строка, если даты нет (ui/app.js when). */
export const when = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '';

/** Сегодня — «20:59», не сегодня — «24.10, 20:59» (ui/feed.js clock). */
export function clock(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Стоимость: «$1.23»; нет числа — «$0.00». */
export const usd = (n: number | null | undefined): string => `$${Number(n || 0).toFixed(2)}`;

/** Длительность: до минуты — «42с», дальше — «3м 5с». */
export const dur = (ms: number): string =>
  ms < 60000 ? `${Math.round(ms / 1000)}с` : `${Math.floor(ms / 60000)}м ${Math.round((ms % 60000) / 1000)}с`;

/** Сколько прошло: «меньше минуты», «12 мин», «2 ч 5 мин». */
export function ago(iso: string, now: number = Date.now()): string {
  const m = Math.floor((now - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'меньше минуты' : m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/** Форма слова по числу: plural(3, 'вопрос', 'вопроса', 'вопросов') → «вопроса». */
export const plural = (n: number, one: string, few: string, many: string): string =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;

/** Первые слова текста агента или вывода команды без разметки — для одной строки. */
export function excerpt(text: string | null | undefined, max = 160): string {
  const s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[\s>#*\-+\d.]+/gm, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Время события в ленте: недавнее — «N мин назад», старше часа — clock (ui/feed.js feedTime). */
export function feedTime(iso: string, now: Date = new Date()): string {
  const min = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  return clock(iso, now);
}

/** Подписи статусов запуска (ui/app.js STATUS). */
export const STATUS: Record<string, string> = {
  running: 'выполняется', waiting: 'ждёт ответа', done: 'готово', max_iterations: 'лимит итераций',
  failed: 'ошибка', budget_exceeded: 'лимит стоимости', aborted: 'прервано', pending: 'ожидает', paused: 'на паузе',
  interrupted: 'оборвался',
};

export const statusLabel = (status: string): string => STATUS[status] || status;

/** Имя папки: «/a/b/» → «b». */
export const baseName = (p: string): string => (p || '').replace(/\/+$/, '').split('/').pop() || p;

/**
 * Подписи проектов по cwd (ui/app.js projectLabels): имя папки; совпали имена — с родителем. Пустой cwd — «без проекта».
 */
export function projectLabels(cwds: string[]): Map<string, string> {
  const byName = new Map<string, number>();
  for (const c of cwds) if (c) byName.set(baseName(c), (byName.get(baseName(c)) ?? 0) + 1);
  return new Map(
    cwds.map((c) => [
      c,
      !c ? 'без проекта' : (byName.get(baseName(c)) ?? 0) > 1 ? c.split('/').filter(Boolean).slice(-2).join('/') : baseName(c),
    ]),
  );
}
