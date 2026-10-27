// Язык текстов вспомогательных моделей (имя запуска, итоги итераций, вердикт судьи, анализ flow, заголовок автотега) — по задаче.
// Наши промпты русские, и просьбу «пиши на языке задачи» модель под ними не слушается: язык определяем в коде
// и называем в промпте прямо.
import { stripTagBlocks } from './tags.js';

export type ReplyLang = 'ru' | 'en';

const DATA_RE = /<source-data>\n([\s\S]*?)\n<\/source-data>/g;
/** Наши метки внутри данных из трекера (intake.ts): «Заголовок:», «Тип: … · статус: …», «Описание MR:», «(пусто)». */
const OUR_LABELS = /^\s*(?:Задача Jira|Ссылка|Заголовок|Тип|Родитель|Метки|Сабтаски|Связи|Описание(?: MR| PR)?|Ветка|Последний коммит|Требует внимания)\s*:|статус:|приоритет:|есть конфликты|\(пусто\)/gm;
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;
const URL_RE = /https?:\/\/\S+/g;

/**
 * Язык задачи по словам: латинских вдвое больше кириллических — английский, иначе русский; пусто — русский, как было.
 * Задача из трекера (есть обёртки source-data) решается по тексту тикета внутри них: снаружи — наша русская обвязка.
 * Не считаются блоки тегов, код, ссылки и идентификаторы (пути, пакеты, camelCase): в русской задаче их хватает.
 */
export function taskLang(task: string): ReplyLang {
  const text = stripTagBlocks(task);
  const data = [...text.matchAll(DATA_RE)].map((m) => m[1]!);
  const own = data.length ? data.join('\n').replace(OUR_LABELS, ' ') : text;
  let cyr = 0;
  let lat = 0;
  for (const raw of own.replace(CODE_RE, ' ').replace(URL_RE, ' ').split(/\s+/)) {
    const w = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (!w || /[^\p{L}]/u.test(w) || /[a-z][A-Z]/.test(w)) continue;
    if (/[а-яё]/i.test(w)) cyr++;
    else if (/^[a-z]+$/i.test(w)) lat++;
  }
  return lat > cyr * 2 ? 'en' : 'ru';
}

/** Как назвать язык в русском промпте: «пиши …». */
export const replyIn = (lang: ReplyLang): string => (lang === 'en' ? 'по-английски (in English)' : 'по-русски');
