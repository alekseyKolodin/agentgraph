// Страница «Теги» (порт логики ui/tags.js): поиск по списку, подписи строк, снимок формы, патч сохранения, крупный редактор.
// Без React и DOM.
import type { Tag, TagKind, TagListItem } from '@server/api-types';
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

/** Первая строка превью; без неё — «саммари ещё нет» (у тега знаний — «заметок ещё нет»). */
export const tagPreview = (tag: Pick<TagListItem, 'kind' | 'preview'>): string =>
  tag.preview.split('\n')[0] || (tag.kind === 'knowledge' ? t('заметок ещё нет') : t('саммари ещё нет'));

/** Строка под превью: вид, время правки и у тега задачи — число запусков. */
export const tagMetaLine = (tag: Pick<TagListItem, 'kind' | 'updatedAt' | 'runs'>): string =>
  `${tag.kind === 'knowledge' ? t('область знаний') : t('задача')} · ${when(tag.updatedAt)}${tag.kind === 'knowledge' ? '' : ` · ${t('запусков: {n}', { n: tag.runs })}`}`;

/** Пустой список: тегов нет совсем или поиск ничего не нашёл. */
export const tagsNoneText = (total: number): string => (total ? t('Ничего не нашлось') : t('Тегов пока нет — заведи первый выше'));

// ---------- форма тега

/** description и inline — поля тега знаний: описание «когда нужен» и «заметки всегда в промпте целиком»; у тега задачи скрыты. */
export type TagForm = { title: string; summary: string; notes: string; dirs: string; description: string; inline: boolean };
export type TagField = 'summary' | 'notes' | 'dirs';

/** Лимит описания тега знаний — как TAG_DESCRIPTION_MAX на сервере. */
export const TAG_DESCRIPTION_MAX = 200;

export const tagFormOf = (tag: Tag): TagForm => ({
  title: tag.title || '',
  summary: tag.summary || '',
  notes: tag.notes || '',
  dirs: (tag.dirs || []).join('\n'),
  description: tag.description || '',
  inline: tag.inline === true,
});

/**
 * Снимок полей формы: по нему — «есть несохранённое». У тега знаний саммари нет: его поле скрыто и в снимок не идёт;
 * у тега задачи так же скрыты описание и режим «целиком».
 */
export const tagSnapshot = (f: TagForm, kind: TagKind): string => {
  const knows = kind === 'knowledge';
  return JSON.stringify([f.title, knows ? '' : f.summary, f.notes, f.dirs, knows ? f.description : '', knows ? f.inline : false]);
};

/** Строки поля «Пути»: без пробелов по краям и пустых. */
export const tagDirLines = (text: string): string[] => text.split('\n').map((x) => x.trim()).filter(Boolean);

export type TagPatch = { title?: string; summary?: string; notes?: string; dirs?: string[]; description?: string; inline?: boolean };

/** Только изменённые поля: пока страница открыта, запуск мог переписать саммари — правка заметок его не затрёт. */
export function tagPatch(f: TagForm, t: Tag): TagPatch {
  const dirs = tagDirLines(f.dirs);
  const knows = t.kind === 'knowledge';
  return {
    ...(f.title !== (t.title || '') ? { title: f.title } : {}),
    ...(!knows && f.summary !== (t.summary || '') ? { summary: f.summary } : {}),
    ...(f.notes !== (t.notes || '') ? { notes: f.notes } : {}),
    ...(dirs.join('\n') !== (t.dirs || []).join('\n') ? { dirs } : {}),
    ...(knows && f.description.trim() !== (t.description || '') ? { description: f.description.trim() } : {}),
    ...(knows && f.inline !== (t.inline === true) ? { inline: f.inline } : {}),
  };
}

/** Тело POST /api/tags: заголовок — если вписан, вид знаний — если сервер умеет виды. Пустой слаг — null (форма не уходит). */
export function newTagBody(slug: string, title: string, kind: TagKind, kinds: boolean): { slug: string; title?: string; kind?: 'knowledge' } | null {
  const s = slug.trim();
  if (!s) return null;
  return { slug: s, ...(title.trim() ? { title: title.trim() } : {}), ...(kinds && kind === 'knowledge' ? { kind: 'knowledge' as const } : {}) };
}

export const TAG_DIRTY_TEXT = t('В теге есть несохранённые правки. Перейти без сохранения?');
export const tagDeleteText = (slug: string): string => t('Удалить тег {slug}: саммари, заметки, пути и вложения? Запуски с ним останутся.', { slug });
export const tagNotesLabel = (kind: TagKind): string => (kind === 'knowledge' ? t('Знание (текст для этапов)') : t('Заметки (промпт тега)'));

/** Подсказка к полю заметок: у тега знаний — как текст попадает к этапам (по запросу или целиком), у тега задачи — как раньше. */
export const tagNotesHint = (kind: TagKind, inline: boolean): string =>
  kind !== 'knowledge'
    ? t('Твой текст к тегу: правила, договорённости, что важно помнить. Уходит в задачу каждого запуска с тегом; сессия саммари его не трогает')
    : inline
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
export const TAG_FOCUS_MONO: readonly TagField[] = ['summary', 'dirs'];

/** Подпись поля в шапке крупного редактора. */
export const tagFocusLabel = (field: TagField, kind: TagKind): string =>
  field === 'dirs' ? t('Пути') : field === 'summary' ? t('Саммари') : tagNotesLabel(kind);

export const tagFocusCount = (v: string): string => t('строк: {lines} · знаков: {chars}', { lines: v ? v.split('\n').length : 0, chars: v.length });

/**
 * Поле крупного редактора после открытия тега: после сохранения того же тега — то же поле, иначе саммари; у тега знаний
 * саммари скрыто, его знание — заметки.
 */
export function tagFocusField(keep: TagField | undefined, kind: TagKind): TagField {
  const knows = kind === 'knowledge';
  return keep && !(knows && keep === 'summary') ? keep : knows ? 'notes' : 'summary';
}
