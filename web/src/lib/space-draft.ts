// Черновик пространства от модели — логика без React: разница строк (карта и состояние против текущих), что сохранить
// (новое пространство: POST /api/spaces и документы; существующее: PUT с mapBase/stateBase начала черновика и документы),
// выбор источников по умолчанию, ссылки карты на документы, цена и время. Сервер — src/space-draft.ts.
import type { SpaceDetail, SpaceDraft, SpaceDraftEstimate, SpaceDraftModel, SpaceDraftReply, SpaceGroupsEstimate } from '@server/api-types';
import { t } from './i18n';
import { dirLines } from './spaces';

export const DRAFT_MODELS: SpaceDraftModel[] = ['haiku', 'sonnet', 'opus'];
/** Модель черновика и группировки — запоминается в браузере. */
export const DRAFT_MODEL_KEY = 'agentgraph.spaceDraftModel';
export const GROUPS_MODEL_KEY = 'agentgraph.spaceGroupModel';
/** Сколько свежих сессий и запусков отмечено в «Из истории» по умолчанию. */
export const DEFAULT_SOURCES = 5;
export const ABOUT_MAX = 2000;
/** Документ длиннее — уже справочник, а не навык (как DRAFT_DOC_MAX сервера). */
export const DOC_SKILL_MAX = 8000;

export const modelLabel = (m: SpaceDraftModel): string =>
  m === 'haiku' ? t('haiku — дёшево, проще') : m === 'sonnet' ? t('sonnet — по умолчанию') : t('opus — дороже, тщательнее');

/** Цена: два знака; меньше цента — три (группировка на haiku стоит доли цента), меньше 0,001 — «< $0.001». */
export function usd(n: number): string {
  if (n > 0 && n < 0.001) return '< $0.001';
  return n > 0 && n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

export const estimateLine = (e: Pick<SpaceDraftEstimate | SpaceGroupsEstimate, 'low' | 'high' | 'ceiling'>): string =>
  t('≈ {low}–{high}, не больше {ceiling}', { low: usd(e.low), high: usd(e.high), ceiling: usd(e.ceiling) });

/** 0:42, 1:05 — сколько идёт сессия. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// --- разница строк

export type DiffLine = { op: ' ' | '+' | '-'; text: string };
/** Строки разницы и свёрнутые неизменённые куски: skip — сколько строк скрыто. */
export type DiffRow = DiffLine | { skip: number };

/** Построчная разница по наибольшей общей подпоследовательности: карта — до 20 000 знаков, это сотни строк. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.replace(/\n$/, '').split('\n') : [];
  const b = after ? after.replace(/\n$/, '').split('\n') : [];
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: '-', text: a[i++]! });
    else out.push({ op: '+', text: b[j++]! });
  }
  while (i < n) out.push({ op: '-', text: a[i++]! });
  while (j < m) out.push({ op: '+', text: b[j++]! });
  return out;
}

/** Неизменённые куски длиннее 2·context строк сворачиваются: вокруг правок остаётся по context строк. */
export function diffRows(lines: DiffLine[], context = 2): DiffRow[] {
  const keep = lines.map((l, i) => l.op !== ' ' || lines.slice(Math.max(0, i - context), i + context + 1).some((x) => x.op !== ' '));
  const out: DiffRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) out.push(lines[i]!);
    else {
      let k = i;
      while (k < lines.length && !keep[k]) k++;
      out.push({ skip: k - i });
      i = k - 1;
    }
  }
  return out;
}

export const diffStat = (lines: DiffLine[]) => ({ add: lines.filter((l) => l.op === '+').length, del: lines.filter((l) => l.op === '-').length });

// --- ссылки карты на документы

/** docs/<имя>.md в карте (как docRefs сервера). */
export function docRefs(map: string): string[] {
  return [...new Set([...map.matchAll(/(?:^|[^\w/.-])docs\/([^\s`'"()<>[\]{}|,;:]+\.md)\b/g)].map((m) => m[1]!))];
}

/** Документы, на которые карта ссылается, но их не будет: не отмечены в черновике и не лежат в пространстве. */
export const danglingDocs = (map: string, chosen: string[], existing: string[]): string[] => docRefs(map).filter((n) => !chosen.includes(n) && !existing.includes(n));

// --- источники «Из истории»

export type DraftSourceItem = { kind: 'session' | 'run'; id: string; name: string; sub: string; at: string; loose?: boolean };

/** Сессии и запуски пространства (свежие сверху) и сессии без пространства из тех же папок — последними. */
export function draftSourceItems(s: Pick<SpaceDetail, 'sessions' | 'runs' | 'looseSessions'>): DraftSourceItem[] {
  const own: DraftSourceItem[] = [
    ...s.sessions.map((x) => ({ kind: 'session' as const, id: x.id, name: x.name, sub: t('сессия · ходов: {n}', { n: x.turns }), at: x.lastActivityAt })),
    ...s.runs.map((r) => ({ kind: 'run' as const, id: r.id, name: r.title || r.flow, sub: t('запуск · {flow} · {status}', { flow: r.flow, status: r.status }), at: r.finishedAt ?? r.startedAt })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const loose = (s.looseSessions ?? []).map((x) => ({ kind: 'session' as const, id: x.id, name: x.name, sub: t('сессия без пространства · ходов: {n}', { n: x.turns }), at: x.lastActivityAt, loose: true }));
  return [...own, ...loose];
}

/** По умолчанию отмечены DEFAULT_SOURCES свежих сессий и столько же запусков пространства; сессии без пространства — нет. */
export function defaultSources(items: DraftSourceItem[]): string[] {
  const own = items.filter((x) => !x.loose);
  return [...own.filter((x) => x.kind === 'session').slice(0, DEFAULT_SOURCES), ...own.filter((x) => x.kind === 'run').slice(0, DEFAULT_SOURCES)].map((x) => x.id);
}

// --- что правит человек и что уходит в сохранение

/** Документ черновика в правке: on — сохранить; replaces — уже есть с таким именем (галочка снята, замена — явно). */
export type EditDoc = { name: string; text: string; replaces?: number; on: boolean };

/** Черновик в правке: поля — тексты форм, take — что сохранить у существующего пространства. */
export type DraftEdit = {
  slug: string;
  title: string;
  map: string;
  state: string;
  cwd: string;
  dirs: string;
  docs: EditDoc[];
  take: { map: boolean; state: boolean; cwd: boolean; dirs: boolean };
};

/** Черновик модели → правка. У существующего отмечено то, что отличается от текущего; документ-замена — снят. */
export function editOf(d: SpaceDraft, space?: Pick<SpaceDetail, 'map' | 'state' | 'cwd' | 'dirs'>): DraftEdit {
  const dirs = d.dirs.join('\n');
  return {
    slug: d.slug ?? '',
    title: d.title,
    map: d.map,
    state: d.state ?? '',
    cwd: d.cwd ?? '',
    dirs,
    docs: d.docs.map((x) => ({ ...x, on: x.replaces === undefined })),
    take: {
      map: !space || d.map.trim() !== space.map.trim(),
      state: Boolean(d.state?.trim()) && (!space || d.state!.trim() !== space.state.trim()),
      cwd: Boolean(d.cwd) && (!space || d.cwd !== (space.cwd ?? '')),
      dirs: d.dirs.length > 0 && (!space || dirs !== (space.dirs ?? []).join('\n')),
    },
  };
}

/** Тело POST /api/spaces нового пространства из правки (папки — как у формы: строки, пустые выброшены). */
export function createBody(e: DraftEdit): { slug: string; title?: string; map?: string; state?: string; cwd?: string; dirs?: string[] } {
  const dirs = dirLines(e.dirs);
  return {
    slug: e.slug.trim(),
    ...(e.title.trim() ? { title: e.title.trim() } : {}),
    ...(e.map.trim() ? { map: e.map } : {}),
    ...(e.state.trim() ? { state: e.state } : {}),
    ...(e.cwd.trim() ? { cwd: e.cwd.trim() } : {}),
    ...(dirs.length ? { dirs } : {}),
  };
}

/**
 * PUT /api/spaces/<slug> существующего: только отмеченное, база — mtime карты и состояния на момент НАЧАЛА черновика:
 * их переписали, пока модель работала, — сервер ответит 409. Пусто — сохранять пространство не нужно (только документы).
 */
export function updatePatch(e: DraftEdit, base: SpaceDraftReply['base']): { map?: string; state?: string; cwd?: string; dirs?: string[]; mapBase?: number; stateBase?: number } {
  return {
    ...(e.take.map ? { map: e.map, mapBase: base.mapMtimeMs ?? 0 } : {}),
    ...(e.take.state ? { state: e.state, stateBase: base.stateMtimeMs ?? 0 } : {}),
    ...(e.take.cwd ? { cwd: e.cwd.trim() } : {}),
    ...(e.take.dirs ? { dirs: dirLines(e.dirs) } : {}),
  };
}

/** Документы к записи: отмеченные; base — 0 у нового (файла быть не должно), mtime — у заменяемого. */
export const docsToSave = (e: DraftEdit): { name: string; text: string; base: number }[] =>
  e.docs.filter((d) => d.on && d.name.trim() && d.text.trim()).map((d) => ({ name: d.name.trim(), text: d.text, base: d.replaces ?? 0 }));

/** Есть ли что сохранить у существующего пространства. */
export const anyTaken = (e: DraftEdit): boolean => Object.values(e.take).some(Boolean) || docsToSave(e).length > 0;
