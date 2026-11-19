// Месяц на доске (docs/desk/SPEC.md, этап 6) без React: работа закрытых дел уходит с глаз (6.3, фильтр для
// closed-work.ts), предложение записать знание после закрытого дела (6.6) и строки обзора недели (6.1).
import type { RunSummary, SessionView, TagListItem } from '@server/api-types';
import type { DeskItem, DeskWeekReply } from '@server/desk/types';
import type { ClosedWork } from './closed-work';
import { LIVE_STATUSES } from './home';
import { plural, t } from './i18n';

/** Запуски, связанные с делом: начатые по нему, заведшие или дополнившие его (desk_put). */
const runsOf = (i: DeskItem): string[] => [...i.links.runs, ...(i.links.mentionedBy ?? []), ...(i.createdBy?.run ? [i.createdBy.run] : [])];
const sessionsOf = (i: DeskItem): string[] => [...i.links.sessions, ...(i.createdBy?.session ? [i.createdBy.session] : [])];

/**
 * Фильтр «работа закрытых дел уходит с глаз»: запуск или сессия, которые есть только у закрытых дел. Связанные и с
 * открытым делом остаются: работа по нему ещё идёт. Живые (идёт, ждёт ответа, на паузе) остаются всегда: дело могли
 * закрыть посреди хода. Запуск-продолжение узнаётся по корню цепочки. Закрытых нет — null (фильтр снят).
 */
export function closedWorkFrom(items: readonly DeskItem[]): ClosedWork | null {
  const openRuns = new Set<string>();
  const openSessions = new Set<string>();
  const runs = new Set<string>();
  const sessions = new Set<string>();
  for (const i of items) {
    const [r, s] = i.closed ? [runs, sessions] : [openRuns, openSessions];
    for (const id of runsOf(i)) r.add(id);
    for (const id of sessionsOf(i)) s.add(id);
  }
  for (const id of openRuns) runs.delete(id);
  for (const id of openSessions) sessions.delete(id);
  if (!runs.size && !sessions.size) return null;
  const chainOpen = (r: RunSummary) => openRuns.has(r.id) || (r.root !== undefined && openRuns.has(r.root));
  return {
    run: (r) => !LIVE_STATUSES.includes(r.status) && !chainOpen(r) && (runs.has(r.id) || (r.root !== undefined && runs.has(r.root))),
    session: (s: SessionView) => !s.live && sessions.has(s.id),
  };
}

/** Предложение записать знание живёт столько после закрытия. */
export const LEARN_WINDOW_MS = 3 * 24 * 3600_000;
const LEARN_SHOWN = 3;

/** Было ли по делу что-то, кроме наблюдателя: запуск или сессия. */
export const hadWork = (i: DeskItem): boolean => runsOf(i).length > 0 || sessionsOf(i).length > 0;

/**
 * Закрытые за последние три дня дела, по которым шла работа (запуск или сессия), — кандидаты «записать знание»; дело,
 * закрытое наблюдателем без моего участия (ни запуска, ни сессии), не предлагается. skip — id уже записанных или
 * отклонённых. Свежие сверху, не больше трёх.
 */
export function learnCandidates(items: readonly DeskItem[], skip: ReadonlySet<string>, now: Date = new Date()): DeskItem[] {
  return items
    .filter((i) => i.closed && hadWork(i) && !skip.has(i.id) && now.getTime() - Date.parse(i.closed.at) < LEARN_WINDOW_MS)
    .sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))
    .slice(0, LEARN_SHOWN);
}

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

/**
 * О каком деле речь — рядом с полем, не в поле: заголовок (из MR, Slack, Jira), причина и why (агент, рутина) — чужой
 * текст, а заметки тега уходят в промпты как указания. В тег идёт только то, что пользователь написал сам.
 */
export function noteContext(i: DeskItem): string {
  const why = i.why && i.why !== i.closed?.reason ? ` — ${i.why}` : '';
  return `«${i.title}»: ${i.closed?.reason ?? ''}${why}`.slice(0, 300);
}

/** Строка над доской: «Висит дольше N дней: K»; ничего не висит — undefined. */
export function staleText(w: DeskWeekReply | undefined): string | undefined {
  if (!w?.staleTotal) return undefined;
  return t('Висит дольше {days} {word}: {n}', { days: w.staleDays, word: plural(w.staleDays, 'дня', 'дней', 'дней'), n: w.staleTotal });
}

/** Итог недели одной строкой: «закрыто 5 · пришло 12 · движений 30». */
export function weekLine(w: DeskWeekReply): string {
  return [
    t('закрыто {n}', { n: w.closedTotal }),
    t('пришло {n}', { n: w.arrived.total }),
    t('движений {n}', { n: w.moves }),
  ].join(' · ');
}
