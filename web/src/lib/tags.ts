// Страница «Теги» (порт логики ui/tags.js): поиск по списку, подписи строк, снимок формы, патч сохранения, крупный редактор.
// Без React и DOM.
import type { Tag, TagKind, TagListItem } from '@server/api-types';
import { when } from './format';
import { searchWords, textMatches } from './search';

/** Поиск по слагу, заголовку и превью: каждое слово запроса должно найтись хоть где-то, без учёта регистра. */
export const tagMatches = (t: Pick<TagListItem, 'slug' | 'title' | 'preview'>, words: string[]): boolean =>
  textMatches([t.slug, t.title, t.preview], words);

/** Что показать в списке и в счётчике: при запросе — «N из M», без него — число тегов (пусто, если тегов нет). */
export function filterTags<T extends Pick<TagListItem, 'slug' | 'title' | 'preview'>>(list: T[], query: string): { shown: T[]; count: string } {
  const words = searchWords(query);
  const shown = words.length ? list.filter((t) => tagMatches(t, words)) : list;
  return { shown, count: words.length ? `${shown.length} из ${list.length}` : list.length ? String(list.length) : '' };
}

/** Первая строка превью; без неё — «саммари ещё нет» (у тега знаний — «заметок ещё нет»). */
export const tagPreview = (t: Pick<TagListItem, 'kind' | 'preview'>): string =>
  t.preview.split('\n')[0] || (t.kind === 'knowledge' ? 'заметок ещё нет' : 'саммари ещё нет');

/** Строка под превью: вид, время правки и у тега задачи — число запусков. */
export const tagMetaLine = (t: Pick<TagListItem, 'kind' | 'updatedAt' | 'runs'>): string =>
  `${t.kind === 'knowledge' ? 'область знаний' : 'задача'} · ${when(t.updatedAt)}${t.kind === 'knowledge' ? '' : ` · запусков: ${t.runs}`}`;

/** Пустой список: тегов нет совсем или поиск ничего не нашёл. */
export const tagsNoneText = (total: number): string => (total ? 'Ничего не нашлось' : 'Тегов пока нет — заведи первый выше');

// ---------- форма тега

export type TagForm = { title: string; summary: string; notes: string; dirs: string };
export type TagField = 'summary' | 'notes' | 'dirs';

export const tagFormOf = (tag: Tag): TagForm => ({
  title: tag.title || '',
  summary: tag.summary || '',
  notes: tag.notes || '',
  dirs: (tag.dirs || []).join('\n'),
});

/** Снимок полей формы: по нему — «есть несохранённое». У тега знаний саммари нет: его поле скрыто и в снимок не идёт. */
export const tagSnapshot = (f: TagForm, kind: TagKind): string =>
  JSON.stringify([f.title, kind === 'knowledge' ? '' : f.summary, f.notes, f.dirs]);

/** Строки поля «Пути»: без пробелов по краям и пустых. */
export const tagDirLines = (text: string): string[] => text.split('\n').map((x) => x.trim()).filter(Boolean);

export type TagPatch = { title?: string; summary?: string; notes?: string; dirs?: string[] };

/** Только изменённые поля: пока страница открыта, запуск мог переписать саммари — правка заметок его не затрёт. */
export function tagPatch(f: TagForm, t: Tag): TagPatch {
  const dirs = tagDirLines(f.dirs);
  return {
    ...(f.title !== (t.title || '') ? { title: f.title } : {}),
    ...(t.kind !== 'knowledge' && f.summary !== (t.summary || '') ? { summary: f.summary } : {}),
    ...(f.notes !== (t.notes || '') ? { notes: f.notes } : {}),
    ...(dirs.join('\n') !== (t.dirs || []).join('\n') ? { dirs } : {}),
  };
}

/** Тело POST /api/tags: заголовок — если вписан, вид знаний — если сервер умеет виды. Пустой слаг — null (форма не уходит). */
export function newTagBody(slug: string, title: string, kind: TagKind, kinds: boolean): { slug: string; title?: string; kind?: 'knowledge' } | null {
  const s = slug.trim();
  if (!s) return null;
  return { slug: s, ...(title.trim() ? { title: title.trim() } : {}), ...(kinds && kind === 'knowledge' ? { kind: 'knowledge' as const } : {}) };
}

export const TAG_DIRTY_TEXT = 'В теге есть несохранённые правки. Перейти без сохранения?';
export const tagDeleteText = (slug: string): string => `Удалить тег ${slug}: саммари, заметки, пути и вложения? Запуски с ним останутся.`;
export const tagNotesLabel = (kind: TagKind): string => (kind === 'knowledge' ? 'Знание (промпт для этапов)' : 'Заметки (промпт тега)');

// ---------- крупный редактор справа: зеркало поля тега, в котором стоит фокус

/** Моноширинно в крупном редакторе — как у самих полей. */
export const TAG_FOCUS_MONO: readonly TagField[] = ['summary', 'dirs'];

/** Подпись поля в шапке крупного редактора. */
export const tagFocusLabel = (field: TagField, kind: TagKind): string =>
  field === 'dirs' ? 'Пути' : field === 'summary' ? 'Саммари' : tagNotesLabel(kind);

export const tagFocusCount = (v: string): string => `строк: ${v ? v.split('\n').length : 0} · знаков: ${v.length}`;

/**
 * Поле крупного редактора после открытия тега: после сохранения того же тега — то же поле, иначе саммари; у тега знаний
 * саммари скрыто, его знание — заметки.
 */
export function tagFocusField(keep: TagField | undefined, kind: TagKind): TagField {
  const knows = kind === 'knowledge';
  return keep && !(knows && keep === 'summary') ? keep : knows ? 'notes' : 'summary';
}
