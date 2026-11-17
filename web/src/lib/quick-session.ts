// Быстрая сессия («+» на рельсе, ⌘N): наборы, с которыми сессия открывается одним нажатием. Набор — пространство с его
// рабочей папкой, папками чтения и тегами знаний или просто папка. Откуда: закреплённые (★, agentgraph.sessionPins),
// пространства (свежая работа сверху), папки и пространства прошлых сессий, недавние папки. Чистая логика без React.
import type { RecentDir, SessionView, SpaceListItem } from '@server/api-types';
import { baseName } from './format';
import { t } from './i18n';

/** Ключ набора: пространство и папка. Пространство без папки — «slug|»: такую сессию открывает только полная форма. */
export const setKey = (space: string, cwd: string): string => `${space}|${cwd}`;

export type QuickRow = {
  key: string;
  /** Слаг пространства; нет — просто папка. */
  space?: string;
  /** Рабочая папка; '' — у пространства её нет, откроется форма. */
  cwd: string;
  title: string;
  /** Папок чтения пространства. */
  dirs: number;
  /** Теги знаний пространства — уйдут в сессию. */
  tags: string[];
  pinned: boolean;
  /** Откуда строка: подпись справа. */
  from: 'pin' | 'space' | 'session' | 'recent' | 'path';
  /** Последняя работа (сортировка внутри источника). */
  at?: string;
};

/** Набор строкой под названием: папка, число папок чтения и тегов. */
export function quickMeta(r: Pick<QuickRow, 'cwd' | 'dirs' | 'tags' | 'space'>, tilde: (p: string) => string): string {
  return [
    r.cwd ? tilde(r.cwd) : t('папка не задана — откроется форма'),
    r.dirs ? t('ещё папок: {n}', { n: r.dirs }) : '',
    r.tags.length ? t('тегов знаний: {n}', { n: r.tags.length }) : '',
  ].filter(Boolean).join(' · ');
}

/** Похоже на путь, который можно открыть сразу: абсолютный или от домашней папки. */
const looksLikePath = (q: string): boolean => /^(?:\/|~\/)./.test(q);

/** Сколько строк показывать: больше без поиска не нужно. */
export const QUICK_ROWS_MAX = 8;

/**
 * Строки быстрой сессии: закреплённые первыми, потом пространства по свежей работе, папки прошлых сессий, недавние папки —
 * без повторов (один набор — одна строка, первая по порядку источников). query — поиск по названию, слагу и пути; путь
 * целиком — первой строкой «открыть в этой папке».
 */
export function quickRows(o: {
  spaces: SpaceListItem[];
  sessions: Pick<SessionView, 'space' | 'cwd' | 'lastActivityAt'>[];
  recent: RecentDir[];
  pins: string[];
  query: string;
}): QuickRow[] {
  const bySlug = new Map(o.spaces.map((s) => [s.slug, s]));
  const rowOf = (space: string | undefined, cwd: string, from: QuickRow['from'], at?: string): QuickRow => {
    const s = space ? bySlug.get(space) : undefined;
    return {
      key: setKey(space ?? '', cwd),
      ...(space ? { space } : {}),
      cwd,
      title: s?.title || space || baseName(cwd),
      dirs: s?.dirs?.length ?? 0,
      tags: s?.tags ?? [],
      pinned: o.pins.includes(setKey(space ?? '', cwd)),
      from,
      ...(at ? { at } : {}),
    };
  };
  const all: QuickRow[] = [];
  const seen = new Set<string>();
  const push = (r: QuickRow) => {
    if (seen.has(r.key)) return;
    seen.add(r.key);
    all.push(r);
  };
  // закреплённые — в порядке закрепления; закреплённое пространство, которого больше нет, не показываем
  for (const key of o.pins) {
    const [space, ...rest] = key.split('|');
    const cwd = rest.join('|');
    if (space && !bySlug.has(space)) continue;
    if (!space && !cwd) continue;
    push({ ...rowOf(space || undefined, cwd, 'pin'), pinned: true });
  }
  const spaces = [...o.spaces].sort((a, b) => (b.lastWorkAt ?? b.updatedAt).localeCompare(a.lastWorkAt ?? a.updatedAt));
  for (const s of spaces) push(rowOf(s.slug, s.workdir?.path ?? '', 'space', s.lastWorkAt));
  const sessions = [...o.sessions].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  for (const s of sessions) {
    // сессия в пространстве, которого больше нет, — просто папка
    const space = s.space && bySlug.has(s.space) ? s.space : undefined;
    // папка сессии пространства совпадает с его рабочей — это та же строка пространства
    if (space && seen.has(setKey(space, s.cwd))) continue;
    push(rowOf(space, s.cwd, 'session', s.lastActivityAt));
  }
  for (const d of o.recent) if (d.exists) push(rowOf(undefined, d.path, 'recent', d.lastUsed));

  const q = o.query.trim().toLowerCase();
  if (!q) return all.slice(0, QUICK_ROWS_MAX);
  const hits = all.filter((r) => [r.title, r.space ?? '', r.cwd].some((x) => x.toLowerCase().includes(q)));
  const path = o.query.trim();
  const exact = looksLikePath(path) && !hits.some((r) => !r.space && r.cwd === path);
  return [...(exact ? [{ ...rowOf(undefined, path, 'path'), title: baseName(path) }] : []), ...hits].slice(0, QUICK_ROWS_MAX);
}

/** Закрепить или открепить набор: новый — в конец, порядок остальных не меняется. */
export function togglePin(pins: string[], key: string): string[] {
  return pins.includes(key) ? pins.filter((x) => x !== key) : [...pins, key];
}
