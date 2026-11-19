// Знание по виду работы (docs/desk/SPEC.md, 6.6) на стороне сервера: после desk_close из сессии ответ подсказывает
// агенту предложить человеку записать вывод в тег вида работы — инструментом knowledge_note, который всегда спрашивает
// человека (ASK_TOOLS). Модель сверх хода сессии не тратится. Те же правила, что у доски (web/src/lib/desk-month.ts:
// hadWork, kindSlug, tagForKind): веб не импортирует рантайм из src, поэтому копия; совпадение проверяет learn.test.ts.
import type { TagListItem } from '../api-types.js';
import { KNOWLEDGE_NOTE_TOOL } from '../tags.js';
import type { DeskItem } from './types.js';

const runsOf = (i: DeskItem): string[] => [...i.links.runs, ...(i.links.mentionedBy ?? []), ...(i.createdBy?.run ? [i.createdBy.run] : [])];
const sessionsOf = (i: DeskItem): string[] => [...i.links.sessions, ...(i.createdBy?.session ? [i.createdBy.session] : [])];

/** Было ли по делу что-то, кроме наблюдателя: запуск или сессия. */
export const hadWork = (i: DeskItem): boolean => runsOf(i).length > 0 || sessionsOf(i).length > 0;

const LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Слаг тега из вида работы: латиница, цифры и дефис (TAG_SLUG_RE); ничего не осталось — 'work'. */
export function kindSlug(kind: string): string {
  const s = [...kind.toLowerCase()].map((c) => LAT[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  return s || 'work';
}

/** Тег для вида работы: тег знаний с таким заголовком или слагом; нет — новый (slug из вида, заголовок — вид). */
export function tagForKind(kind: string, tags: readonly TagListItem[]): { slug: string; title: string; exists: boolean } {
  const k = kind.trim().toLowerCase();
  const slug = kindSlug(kind);
  const hit = tags.find((tg) => tg.kind === 'knowledge' && (tg.title?.trim().toLowerCase() === k || tg.slug === slug));
  return hit ? { slug: hit.slug, title: hit.title ?? hit.slug, exists: true } : { slug, title: kind.trim(), exists: false };
}

// вид дела — чужой текст (рутина, Slack): в подсказку модели — одной строкой, без кавычек и управляющих символов
const KIND_MAX = 40;
const cleanKind = (s: string): string => s.replace(/[\p{Cc}\p{Cf}"«»`]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, KIND_MAX);

/**
 * Подсказка после desk_close из сессии: по делу была работа (запуск или сессия; или сессия открыта по этой вещи) —
 * предложить человеку записать вывод в тег вида работы. Без работы (закрыл наблюдатель или чужое дело) — нет подсказки.
 */
export function learnHint(item: DeskItem, tags: readonly TagListItem[], o: { thingKey?: string } = {}): string | undefined {
  if (!hadWork(item) && o.thingKey !== item.key) return undefined;
  const kind = cleanKind(item.kind) || 'работа';
  const tag = tagForKind(kind, tags);
  const args = tag.exists ? `tag: "${tag.slug}"` : `tag: "${tag.slug}", title: "${tag.title}" — тега ещё нет, он заведётся`;
  return [
    `По делу была работа. Спроси человека, какой вывод стоит запомнить на будущее для работы вида «${kind}», и предложи записать его одной строкой инструментом ${KNOWLEDGE_NOTE_TOOL} (${args}).`,
    'Записывай только то, что человек сформулировал или подтвердил; откажется — не записывай. Заметки тега получат промптом следующие сессии и запуски с этим тегом.',
  ].join(' ');
}
