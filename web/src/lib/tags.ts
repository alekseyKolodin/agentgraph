// Страница «Знания» (теги знаний; порт логики ui/tags.js): поиск по списку, подписи строк, снимок формы, патч сохранения,
// крупный редактор. Без React и DOM. Тегов задач больше нет — их заменили пространства (lib/spaces.ts).
import type { Tag, TagListItem } from '@server/api-types';
import { when } from './format';
import { t } from './i18n';
import { searchWords, textMatches } from './search';

/** Поиск по слагу, заголовку и превью: каждое слово запроса должно найтись хоть где-то, без учёта регистра. */
export const tagMatches = (t: Pick<TagListItem, 'slug' | 'title' | 'preview'>, words: string[]): boolean =>
  textMatches([t.slug, t.title, t.preview], words);

/** Что показать в списке и в счётчике: при запросе — «N из M», без него — число тегов (пусто, если тегов нет). */
export function filterTags<T extends Pick<TagListItem, 'slug' | 'title' | 'preview'>>(list: T[], query: string): { shown: T[]; count: string } {
  const words = searchWords(query);
  const shown = words.length ? list.filter((t) => tagMatches(t, words)) : list;
  return { shown, count: words.length ? t('{shown} из {total}', { shown: shown.length, total: list.length }) : list.length ? String(list.length) : '' };
}

/** Первая строка превью (описание или начало заметок); без неё — «заметок ещё нет». */
export const tagPreview = (tag: Pick<TagListItem, 'preview'>): string => tag.preview.split('\n')[0] || t('заметок ещё нет');

/** Строка под превью: вид и время правки. */
export const tagMetaLine = (tag: Pick<TagListItem, 'updatedAt'>): string => `${t('область знаний')} · ${when(tag.updatedAt)}`;

/** Пустой список: тегов нет совсем или поиск ничего не нашёл. */
export const tagsNoneText = (total: number): string => (total ? t('Ничего не нашлось') : t('Тегов знаний пока нет — заведи первый выше'));

// ---------- форма тега знаний

/** description — «когда нужен» тег, inline — «заметки всегда в промпте целиком». */
export type TagForm = { title: string; notes: string; dirs: string; description: string; inline: boolean };
export type TagField = 'notes' | 'dirs';

/** Лимит описания тега знаний — как TAG_DESCRIPTION_MAX на сервере. */
export const TAG_DESCRIPTION_MAX = 200;

export const tagFormOf = (tag: Tag): TagForm => ({
  title: tag.title || '',
  notes: tag.notes || '',
  dirs: (tag.dirs || []).join('\n'),
  description: tag.description || '',
  inline: tag.inline === true,
});

/** Снимок полей формы: по нему — «есть несохранённое». */
export const tagSnapshot = (f: TagForm): string => JSON.stringify([f.title, f.notes, f.dirs, f.description, f.inline]);

/** Строки поля «Пути»: без пробелов по краям и пустых. */
export const tagDirLines = (text: string): string[] => text.split('\n').map((x) => x.trim()).filter(Boolean);

export type TagPatch = { title?: string; notes?: string; dirs?: string[]; description?: string; inline?: boolean };

/** Только изменённые поля. */
export function tagPatch(f: TagForm, t: Tag): TagPatch {
  const dirs = tagDirLines(f.dirs);
  return {
    ...(f.title !== (t.title || '') ? { title: f.title } : {}),
    ...(f.notes !== (t.notes || '') ? { notes: f.notes } : {}),
    ...(dirs.join('\n') !== (t.dirs || []).join('\n') ? { dirs } : {}),
    ...(f.description.trim() !== (t.description || '') ? { description: f.description.trim() } : {}),
    ...(f.inline !== (t.inline === true) ? { inline: f.inline } : {}),
  };
}

/** Тело POST /api/tags: заголовок — если вписан. Пустой слаг — null (форма не уходит). */
export function newTagBody(slug: string, title: string): { slug: string; title?: string } | null {
  const s = slug.trim();
  if (!s) return null;
  return { slug: s, ...(title.trim() ? { title: title.trim() } : {}) };
}

export const TAG_DIRTY_TEXT = t('В теге есть несохранённые правки. Перейти без сохранения?');
export const tagDeleteText = (slug: string): string =>
  t('Удалить тег знаний {slug}: заметки, пути и вложения? Flow, где он в knowledge, перестанут запускаться, пока его не уберут.', { slug });
export const TAG_NOTES_LABEL = t('Знание (текст для этапов)');

/** Подсказка к полю заметок: как текст попадает к этапам и сессиям — по запросу или целиком. */
export const tagNotesHint = (inline: boolean): string =>
  inline
    ? t('Правила области знаний. Вставляются в промпт каждого этапа блока целиком («всегда вставлять» включено) — держи их короткими')
    : t('Правила области знаний. В промпт этапа идёт только строка с описанием; этот текст этап получит инструментом knowledge_read, когда область ему понадобится');

export const TAG_DESCRIPTION_LABEL = t('Описание — когда этот тег нужен');
export const TAG_DESCRIPTION_HINT = t('Одна строка в промпт каждого этапа блока; полный текст этап запросит инструментом knowledge_read, когда понадобится');
export const TAG_INLINE_LABEL = t('Всегда вставлять заметки в промпт целиком');
export const TAG_INLINE_HINT = t('Для коротких правил, которые должны действовать всегда. По умолчанию заметки отдаются по запросу: в промпте — строка с описанием, полный текст — инструментом knowledge_read');

/** Режим тега знаний словами — для списка и страницы «Контекст». */
export const tagModeText = (inline: boolean | undefined): string => (inline ? t('в промпте целиком') : t('по запросу'));

// ---------- крупный редактор справа: зеркало поля тега, в котором стоит фокус

/** Моноширинно в крупном редакторе — как у самих полей. */
export const TAG_FOCUS_MONO: readonly TagField[] = ['dirs'];

/** Подпись поля в шапке крупного редактора. */
export const tagFocusLabel = (field: TagField): string => (field === 'dirs' ? t('Пути') : TAG_NOTES_LABEL);

export const tagFocusCount = (v: string): string => t('строк: {lines} · знаков: {chars}', { lines: v ? v.split('\n').length : 0, chars: v.length });

/** Поле крупного редактора после открытия тега: после сохранения того же тега — то же поле, иначе заметки. */
export const tagFocusField = (keep: TagField | undefined): TagField => keep ?? 'notes';
