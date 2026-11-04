// Страница «Пространства» и выбор пространства в формах без React и DOM: поиск, подписи, снимок формы и патч,
// документы, история обновлений состояния, сессии и запуски пространства.
import type { ModelContextView, Space, SpaceDoc, SpaceListItem, SpaceRun, SpaceSession, SpaceUpdate, SpaceWorkdir } from '@server/api-types';
import { ctxTokens } from './context';
import { plural, when } from './format';
import { t } from './i18n';
import { searchWords, textMatches } from './search';

/** Слаг — как у тегов: строчные латинские буквы, цифры и дефис, до 64 знаков. */
export const SPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SPACE_SLUG_ERROR = t('Слаг пространства: строчные латинские буквы, цифры и дефис');
/** Карта длиннее — предупреждение: она в каждом запросе модели. Как SPACE_MAP_WARN на сервере. */
export const SPACE_MAP_WARN = 6000;
/** Как SPACE_STATE_MAX на сервере: длиннее состояние обрежется. */
export const SPACE_STATE_MAX = 2500;

/** Подпись пространства: заголовок, иначе слаг. */
export const spaceLabel = (s: Pick<SpaceListItem, 'slug' | 'title'>): string => s.title || s.slug;

/** Поиск по слагу, заголовку и превью: каждое слово запроса должно найтись хоть где-то. */
export function filterSpaces<T extends Pick<SpaceListItem, 'slug' | 'title' | 'preview'>>(list: T[], query: string): { shown: T[]; count: string } {
  const words = searchWords(query);
  const shown = words.length ? list.filter((s) => textMatches([s.slug, s.title, s.preview], words)) : list;
  return { shown, count: words.length ? t('{shown} из {total}', { shown: shown.length, total: list.length }) : list.length ? String(list.length) : '' };
}

/** Первая строка превью (состояние, без него — карта); пусто — подсказка, что там будет. */
export const spacePreview = (s: Pick<SpaceListItem, 'preview'>): string => s.preview.split('\n')[0] || t('состояния ещё нет');

/** Строка под превью: есть ли карта, документов, когда обновлено. */
export const spaceMetaLine = (s: Pick<SpaceListItem, 'hasMap' | 'docs' | 'updatedAt'>): string =>
  [s.hasMap ? t('карта') : t('без карты'), t('документов: {n}', { n: s.docs }), when(s.updatedAt)].filter(Boolean).join(' · ');

/** Что даст выбранное пространство — строкой под полем; пустое — подсказка, неверный слаг — ошибка. */
export function spaceFieldNote(value: string, options: SpaceListItem[]): { text: string; tone: '' | 'err' } {
  const slug = value.trim();
  if (!slug) return { text: t('Без пространства: только папка и теги знаний'), tone: '' };
  if (!SPACE_SLUG_RE.test(slug)) return { text: t('Слаг пространства: строчные латинские буквы, цифры и дефис'), tone: 'err' };
  const s = options.find((o) => o.slug === slug);
  if (!s) return { text: t('{slug}: новое пространство — заведётся пустым, карту заполнишь на его странице', { slug }), tone: '' };
  const what = [s.hasMap ? t('карта — памятью') : t('карты нет'), s.docs ? t('документов: {n}', { n: s.docs }) : '', s.hasState ? t('состояние — в контексте') : t('состояния ещё нет')];
  return { text: `${spaceLabel(s)}: ${what.filter(Boolean).join(' · ')}`, tone: '' };
}

// ---------- выбор пространства в формах: рабочая папка и порядок «свежие сверху»

/** Откуда рабочая папка: задана у пространства, папка последней сессии или последнего запуска в нём (считает сервер). */
export type { SpaceWorkdir } from '@server/api-types';

/** Рабочая папка пространства для формы — её посчитал сервер (SpaceListItem.workdir); нет пространства или папки — undefined. */
export function spaceWorkdir(slug: string, options: Pick<SpaceListItem, 'slug' | 'workdir'>[]): SpaceWorkdir | undefined {
  const s = slug.trim();
  return s ? options.find((o) => o.slug === s)?.workdir : undefined;
}

/** Подпись под полем папки, когда её подставило пространство. */
export function workdirNote(space: Pick<SpaceListItem, 'slug' | 'title'> | undefined, slug: string, wd: SpaceWorkdir): string {
  const name = space ? spaceLabel(space) : slug;
  if (wd.from === 'space') return t('из пространства «{name}»: его рабочая папка', { name });
  return wd.from === 'session' ? t('из пространства «{name}»: папка его последней сессии', { name }) : t('из пространства «{name}»: папка его последнего запуска', { name });
}

/** Строка списка выбора пространства. */
export type PickerRow = { kind: 'space'; s: SpaceListItem; at: string } | { kind: 'none' } | { kind: 'new'; slug: string };

/**
 * Строки выбора пространства: по запросу (слаг, заголовок, начало состояния), свежие сверху — по последней работе в
 * пространстве или его обновлению; дальше «+ новое пространство», если вписан новый верный слаг (Enter на нём — оно, а не
 * «без пространства»), и «без пространства» последней.
 */
export function pickerRows(query: string, options: SpaceListItem[]): PickerRow[] {
  const at = (s: SpaceListItem) => (s.lastWorkAt && s.lastWorkAt > s.updatedAt ? s.lastWorkAt : s.updatedAt);
  const shown = filterSpaces(options, query).shown.map((s) => ({ kind: 'space' as const, s, at: at(s) }));
  shown.sort((a, b) => b.at.localeCompare(a.at));
  const q = query.trim();
  const fresh = SPACE_SLUG_RE.test(q) && !options.some((o) => o.slug === q);
  return [...shown, ...(fresh ? [{ kind: 'new' as const, slug: q }] : []), { kind: 'none' }];
}

// ---------- «Модель получит»: строка-сводка превью

/** Как CHARS_PER_TOKEN на странице «Контекст»: оценка, точно — листинг Claude Code. */
const CHARS_PER_TOKEN = 3.2;
const approx = (chars: number): string => `≈${ctxTokens(Math.round(chars / CHARS_PER_TOKEN))}`;

/** Свёрнутая строка превью: «карта ≈1.2k ток. — памятью · состояние ≈600 ток. · документов: 3 · папок: 2 · знаний: 2». */
export function modelSummary(v: Pick<ModelContextView, 'space' | 'knowledge'>): string {
  const parts: string[] = [];
  if (v.space) {
    parts.push(v.space.map.chars ? t('карта {n} ток. — памятью', { n: approx(v.space.map.chars) }) : t('карты нет'));
    parts.push(v.space.state ? t('состояние {n} ток.', { n: approx(v.space.state.length) }) : t('состояния ещё нет'));
    if (v.space.docs.length) parts.push(t('документов: {n}', { n: v.space.docs.length }));
    if (v.space.dirs.length) parts.push(t('папок: {n}', { n: v.space.dirs.length }));
  }
  if (v.knowledge.length) parts.push(t('знаний: {n}', { n: v.knowledge.length }));
  return parts.join(' · ');
}

export const spacesNoneText = (total: number): string => (total ? t('Ничего не нашлось') : t('Пространств пока нет — заведи первое выше'));

/** Размер файла: байты, КБ, МБ. */
export function docSize(n: number): string {
  if (n < 1024) return t('{n} Б', { n });
  if (n < 1024 * 1024) return t('{n} КБ', { n: Math.max(1, Math.round(n / 1024)) });
  return t('{n} МБ', { n: (n / 1024 / 1024).toFixed(1) });
}

/** Строка документа: имя, заголовок «# …», размер. */
export const docLine = (d: SpaceDoc): string => [d.title, docSize(d.size)].filter(Boolean).join(' · ');

/** Кто обновил состояние: «запуск flow · дата» или «сессия «имя» · дата». */
export function updateLine(u: SpaceUpdate): string {
  const who = u.kind === 'session' ? t('сессия «{name}»', { name: u.title || u.id.slice(0, 8) }) : t('запуск {flow}', { flow: u.title || u.flow || u.id });
  return `${who}${u.at ? ` · ${when(u.at)}` : ''}`;
}

/** Строка над редактором состояния: кто обновил его последним; нет истории — откуда оно возьмётся. */
export const stateByText = (s: Pick<Space, 'history' | 'state'>): string =>
  s.history[0] ? t('Обновил: {who}', { who: updateLine(s.history[0]) }) : s.state.trim() ? t('Состояние правили только руками') : t('Состояние запишет короткая сессия после первой сессии или запуска «готово» в этом пространстве');

/** Сессии и запуски пространства одним списком, свежие сверху; живые сессии — первыми. */
export type SpaceItem = { kind: 'session'; at: string; s: SpaceSession } | { kind: 'run'; at: string; r: SpaceRun };

export function spaceItems(sessions: SpaceSession[], runs: SpaceRun[]): SpaceItem[] {
  const items: SpaceItem[] = [
    ...sessions.map((s): SpaceItem => ({ kind: 'session', at: s.lastActivityAt, s })),
    ...runs.map((r): SpaceItem => ({ kind: 'run', at: r.finishedAt ?? r.startedAt, r })),
  ];
  const live = (i: SpaceItem) => (i.kind === 'session' ? i.s.live : i.r.status === 'running');
  return items.sort((a, b) => Number(live(b)) - Number(live(a)) || b.at.localeCompare(a.at));
}

/** «3 сессии · 5 запусков» для заголовка блока; пусто — ничего не было. */
export function itemsCount(sessions: number, runs: number): string {
  const parts = [
    ...(sessions ? [`${sessions} ${plural(sessions, 'сессия', 'сессии', 'сессий')}`] : []),
    ...(runs ? [`${runs} ${plural(runs, 'запуск', 'запуска', 'запусков')}`] : []),
  ];
  return parts.join(' · ');
}

// ---------- форма пространства: карта, состояние, заголовок, папки

/** cwd — рабочая папка пространства (её подставят формы сессии и запуска); пусто — папка последней работы. */
export type SpaceForm = { title: string; map: string; state: string; dirs: string; cwd: string };
export type SpaceField = 'map' | 'state' | 'dirs';

export const spaceFormOf = (s: Space): SpaceForm => ({ title: s.title || '', map: s.map, state: s.state, dirs: (s.dirs || []).join('\n'), cwd: s.cwd || '' });

/** Снимок полей формы: по нему — «есть несохранённое». Перевод строки в конце карты и состояния не считается правкой. */
export const spaceSnapshot = (f: SpaceForm): string => JSON.stringify([f.title.trim(), f.map.trimEnd(), f.state.trim(), dirLines(f.dirs).join('\n'), f.cwd.trim()]);

/** Строки поля «Папки»: без пробелов по краям и пустых. */
export const dirLines = (text: string): string[] => text.split('\n').map((x) => x.trim()).filter(Boolean);

export type SpacePatch = { title?: string; map?: string; state?: string; dirs?: string[]; cwd?: string; mapBase?: number; stateBase?: number };

/**
 * Только изменённые поля, с базой: пока страница открыта, сессия состояния могла переписать STATE.md — сервер ответит
 * 409, а не затрёт его. База отсутствующего файла — 0.
 */
export function spacePatch(f: SpaceForm, s: Space): SpacePatch {
  const dirs = dirLines(f.dirs);
  return {
    ...(f.title.trim() !== (s.title || '') ? { title: f.title.trim() } : {}),
    ...(f.map.trimEnd() !== s.map.trimEnd() ? { map: f.map, mapBase: s.mapMtimeMs ?? 0 } : {}),
    ...(f.state.trim() !== s.state.trim() ? { state: f.state, stateBase: s.stateMtimeMs ?? 0 } : {}),
    ...(dirs.join('\n') !== (s.dirs || []).join('\n') ? { dirs } : {}),
    ...(f.cwd.trim() !== (s.cwd || '') ? { cwd: f.cwd.trim() } : {}),
  };
}

/** Тело POST /api/spaces; пустой слаг — null (форма не уходит). */
export function newSpaceBody(
  slug: string,
  title: string,
  gist: string,
  dirs: string,
  cwd = '',
): { slug: string; title?: string; gist?: string; dirs?: string[]; cwd?: string } | null {
  const s = slug.trim();
  if (!s) return null;
  const list = dirLines(dirs);
  return { slug: s, ...(title.trim() ? { title: title.trim() } : {}), ...(gist.trim() ? { gist: gist.trim() } : {}), ...(list.length ? { dirs: list } : {}), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) };
}

/** Счётчик под редактором: строк и знаков. */
export const fieldCount = (v: string): string => t('строк: {lines} · знаков: {chars}', { lines: v ? v.split('\n').length : 0, chars: v.length });

export const SPACE_DIRTY_TEXT = t('В пространстве есть несохранённые правки. Перейти без сохранения?');
export const spaceDeleteText = (slug: string): string =>
  t('Удалить пространство {slug}: карту, состояние и документы? Сессии и запуски с ним останутся, но новые его не получат.', { slug });

/** Подсказка структуры карты — в placeholder редактора, не в файле: всё в CLAUDE.md модель читает как инструкции. */
export const MAP_PLACEHOLDER = t('# Название фичи или проекта\n\nСуть: что делаем и зачем, в двух фразах.\n\n## Где что\n- ~/code/android — клиент, экран тревоги в feature/alert\n- ~/code/api — бэкенд, эндпоинт /alerts\n\n## Куда за чем ходить\n- спека — docs/spec.md\n\n## Договорённости\n- …');
