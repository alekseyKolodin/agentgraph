// Инструменты дел desk_put, desk_close, desk_list (SPEC 3.2, этап 3: 3.5–3.7) — общие описания и обработчики для
// сервера agentgraph у сессии терминала (sessions-mcp.ts), MCP-сервера этапа flow (runner.ts) и командной строки
// (cli.ts). Хранилище приходит снаружи (DeskApi); что подставляется само — сессия, запуск, проект, ветка, источник
// сигнала, — тоже: модель называет только вещь, заголовок, вид, почему, срок и текст сигнала.
import crypto from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { exec, repoRoot, type Exec } from '../git.js';
import { branchKey, jiraKey, keyLabel, mrKey, parseKey } from '../things/keys.js';
import { settingsJiraHosts, thingLabel, thingOfUrl } from '../things/resolve.js';
import type { Thing, ThingType } from '../things/types.js';
import type { DeskApi, DeskBy, DeskColumn, DeskItem, DeskLinks, DeskPatch, DeskSignal } from './types.js';

export const DESK_PUT_TOOL = 'desk_put';
export const DESK_CLOSE_TOOL = 'desk_close';
export const DESK_LIST_TOOL = 'desk_list';
export const DESK_TOOLS = [DESK_PUT_TOOL, DESK_CLOSE_TOOL, DESK_LIST_TOOL] as const;

/** MCP-сервер этапа flow (рядом с artifacts и knowledge) и его имена для allowedTools: у запуска некого спрашивать. */
export const DESK_TOOLS_SERVER = 'desk';
export const DESK_TOOLS_ALLOW = DESK_TOOLS.map((t) => `mcp__${DESK_TOOLS_SERVER}__${t}`);

export const DESK_COLUMNS: readonly DeskColumn[] = ['new', 'plan', 'work', 'waiting', 'done'];
export const COLUMN_TITLE: Record<DeskColumn, string> = { new: 'Новое', plan: 'В плане', work: 'В работе', waiting: 'Ждёт других', done: 'Готово' };

export const TITLE_MAX = 200;
export const KIND_MAX = 40;
export const WHY_MAX = 300;
export const TEXT_MAX = 2000;
export const REASON_MAX = 300;
/** Больше строк desk_list не отдаёт: модели нужен обзор, а не выгрузка. */
export const LIST_MAX = 50;
/** Заголовок вещи места вызова в описании инструмента — не длиннее: это текст из MR или задачи, а не наш. */
const HINT_TITLE_MAX = 100;

/** Управляющие символы, кроме \t и \n: из текста модели и из дел (заголовки из Slack, GitLab) они дошли бы до экрана. */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const clean = (s: string): string => s.replace(CONTROL_RE, '');
const KEY_RE = /^(mr|jira|tw|branch|session|run|thread|own):\S+$/;

/**
 * Что подставляется само в месте вызова. by — кто подвинул (сессия, flow, человек из CLI), source — источник сигнала.
 * Проект и ветка — функции: у сессии пространство выбирают на ходу, ветку переключают, — берутся в момент вызова.
 */
export type DeskCallCtx = {
  api: DeskApi;
  by: DeskBy;
  source: string;
  project?: () => string | undefined;
  /** Ключ ветки branch:<корень>#<ветка> (см. branchKeyOf). */
  branch?: () => Promise<string | undefined>;
  session?: string;
  run?: string;
  /** Рутина, запустившая flow: в сигнал. */
  routine?: string;
  /** Вещь места вызова (MR, задача сессии или запуска): ключ, совпавший с её ключом, берёт её целиком — ref, адрес, заголовок. */
  thing?: Thing;
  /** Хосты Jira для ссылок на задачи; по умолчанию — из настроек (и *.atlassian.net). */
  jiraHosts?: () => readonly string[];
  /** «Почему» у нового дела, если модель не сказала: «из сессии …», «из запуска …». */
  why: string;
  /** Можно ли закрыть это дело отсюда; строка — почему нет. Нет — можно любое. */
  canClose?: (item: DeskItem) => string | undefined;
  /** Новое дело или сигнал к существующему — для счётчика дел запуска. */
  onPut?: (item: DeskItem, created: boolean) => void;
  now?: () => Date;
};

/** Что знает модель о месте вызова: для описаний инструментов. */
export type DeskHint = {
  /** Вещь, о которой сессия или запуск (MR, задача): её ключ модель может передать в thing. */
  thing?: Pick<Thing, 'key' | 'title'>;
  project?: string;
};

export type DeskPutArgs = { thing?: string; title?: string; kind?: string; why?: string; due?: string; column?: DeskColumn; text?: string };
export type DeskCloseArgs = { thing: string; reason: string };
export type DeskListArgs = { column?: DeskColumn[]; project?: string; closed?: boolean };

// ---------- ключ вещи

/** Ключ дела, вещь для наблюдателя (если есть), ссылка в сигнал и заголовок вещи. */
export type ThingRef = { key: string; thing?: DeskItem['thing']; link?: string; title?: string };

const asDeskThing = (t: Thing): NonNullable<DeskItem['thing']> => ({ type: t.type, ref: t.ref, ...(t.url ? { url: t.url } : {}) });

/**
 * Ключ в каноническом виде (src/things/keys.ts): хост и путь MR — в нижнем регистре, ключ Jira — в верхнем; ключ ветки —
 * через branchKey. Не ключ вещи — undefined. Ключи, собранные мимо keys.ts (work-links.ts), сходятся с ключами ссылок.
 */
export function canonicalKey(key: string): string | undefined {
  let k = key.trim();
  if (!KEY_RE.test(k)) return undefined;
  // parseKey ждёт ключ задачи заглавными: jira:host/abc-1 — та же задача, что ABC-1
  if (k.startsWith('jira:')) k = k.replace(/[^/]+$/, (t) => t.toUpperCase());
  const p = parseKey(k);
  if (!p) return undefined;
  const r = p.ref;
  try {
    if (p.type === 'mr') return mrKey(String(r.host), String(r.project), Number(r.number));
    if (p.type === 'jira') return jiraKey(String(r.host), String(r.key));
    if (p.type === 'branch') return branchKey(String(r.root), String(r.branch));
  } catch {
    return undefined;
  }
  return k;
}

/**
 * Что передала модель или человек → дело: ключ вещи — канонический (совпал с вещью места вызова — она целиком); адрес
 * MR/PR или задачи Jira — их вещь (thingOfUrl); другой адрес — своё дело с ключом по адресу (тот же адрес — то же дело)
 * и ссылкой в сигнале. Не ключ и не адрес — ошибка.
 */
export function resolveThing(raw: string, o: { jiraHosts?: readonly string[]; known?: Thing } = {}): ThingRef {
  const s = clean(raw).trim();
  if (!s) throw new Error('Пустой ключ вещи');
  const known = o.known ? canonicalKey(o.known.key) : undefined;
  const fromKnown = (key: string): ThingRef | undefined =>
    o.known && known === key ? { key, thing: asDeskThing(o.known), ...(o.known.url ? { link: o.known.url } : {}), ...(o.known.title ? { title: o.known.title } : {}) } : undefined;
  if (/^https?:\/\//i.test(s)) {
    const t = thingOfUrl(s, o.jiraHosts ?? []);
    if (t) return fromKnown(t.key) ?? { key: t.key, thing: asDeskThing(t), ...(t.url ? { link: t.url } : {}) };
    try {
      new URL(s);
    } catch {
      throw new Error(`Не адрес: ${s}`);
    }
    return { key: `own:url-${crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)}`, link: s };
  }
  const key = canonicalKey(s);
  if (!key) throw new Error(`Не ключ вещи и не ссылка: ${s}. Ключи: mr:<хост>/<проект>/<номер>, jira:<хост>/<KEY-1>, branch:<корень>#<ветка>, own:<id>; или адрес MR, PR, задачи`);
  const hit = fromKnown(key);
  if (hit) return hit;
  const p = parseKey(key)!;
  return { key, ...(p.type !== 'own' ? { thing: { type: p.type, ref: p.ref } } : {}) };
}

const KIND_BY_TYPE: Partial<Record<ThingType, string>> = { mr: 'MR', jira: 'Jira', teamwork: 'Задача', branch: 'Ветка', thread: 'Тред' };

/** Ключ ветки папки: branch:<основной checkout>#<текущая ветка>. Не git, отделённый HEAD или ошибка git — undefined. */
export async function branchKeyOf(cwd: string, x: Exec = exec): Promise<string | undefined> {
  try {
    const root = await repoRoot(cwd, x);
    if (!root) return undefined;
    const branch = (await x('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10_000 })).trim();
    if (!branch || branch === 'HEAD') return undefined;
    return `branch:${root.replace(/\\/g, '/')}#${branch}`;
  } catch {
    return undefined;
  }
}

// ---------- разбор аргументов

function onlyKeys(args: Record<string, unknown>, keys: string[]): void {
  const extra = Object.keys(args).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`Лишние параметры: ${extra.join(', ')}. Есть только ${keys.join(', ')}`);
}

/** Строка: не строка — ошибка; пустая (модели шлют "" в необязательных) — как не задано; длиннее max — ошибка. */
function text(args: Record<string, unknown>, k: string, max: number, oneLine = true): string | undefined {
  const v = args[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${k} — строка`);
  let s = v.replace(CONTROL_RE, '');
  if (oneLine) s = s.replace(/\s+/g, ' ');
  s = s.trim();
  if (!s) return undefined;
  if (s.length > max) throw new Error(`${k} длиннее ${max} знаков (${s.length})`);
  return s;
}

function column(v: unknown, k = 'column'): DeskColumn {
  if (typeof v !== 'string' || !DESK_COLUMNS.includes(v as DeskColumn)) throw new Error(`${k}: ${DESK_COLUMNS.join(' | ')}`);
  return v as DeskColumn;
}

/** Срок: дата YYYY-MM-DD или дата со временем ISO 8601. */
export function parseDue(v: string): string {
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(s) || Number.isNaN(Date.parse(s))) throw new Error(`due — дата YYYY-MM-DD или ISO 8601, а не «${s}»`);
  return s.replace(' ', 'T');
}

const PUT_KEYS = ['thing', 'title', 'kind', 'why', 'due', 'column', 'text'];

export function parsePutArgs(args: Record<string, unknown>): DeskPutArgs {
  onlyKeys(args, PUT_KEYS);
  const out: DeskPutArgs = {};
  const thing = text(args, 'thing', 2000);
  if (thing) out.thing = thing;
  const title = text(args, 'title', TITLE_MAX);
  if (title) out.title = title;
  const kind = text(args, 'kind', KIND_MAX);
  if (kind) out.kind = kind;
  const why = text(args, 'why', WHY_MAX);
  if (why) out.why = why;
  const due = text(args, 'due', 40);
  if (due) out.due = parseDue(due);
  if (args.column !== undefined && args.column !== null && args.column !== '') out.column = column(args.column);
  const t = text(args, 'text', TEXT_MAX, false);
  if (t) out.text = t;
  if (!out.thing && !out.title) throw new Error('Нужен thing (ключ или ссылка на вещь) или title — заголовок своего дела');
  return out;
}

export function parseCloseArgs(args: Record<string, unknown>): DeskCloseArgs {
  onlyKeys(args, ['thing', 'reason']);
  const thing = text(args, 'thing', 2000);
  if (!thing) throw new Error('Нужен thing — ключ дела (из desk_list) или ссылка на вещь');
  const reason = text(args, 'reason', REASON_MAX);
  if (!reason) throw new Error('Нужен reason — почему дело закрыто, одной строкой');
  return { thing, reason };
}

export function parseListArgs(args: Record<string, unknown>): DeskListArgs {
  onlyKeys(args, ['column', 'project', 'closed']);
  const out: DeskListArgs = {};
  const c = args.column;
  if (c !== undefined && c !== null && c !== '') out.column = (Array.isArray(c) ? c : [c]).map((x) => column(x));
  const project = text(args, 'project', 200);
  if (project) out.project = project;
  if (args.closed !== undefined && args.closed !== null) {
    if (typeof args.closed !== 'boolean') throw new Error('closed — true или false');
    out.closed = args.closed;
  }
  return out;
}

// ---------- обработчики: ответ — текст модели, ошибка — исключением

/**
 * Строка дела для модели и терминала: ключ, колонка, заголовок, вид, почему, срок. Одна строка без управляющих символов:
 * заголовки и «почему» заводят рутины из чужого текста (Slack, GitLab), а строку печатает терминал.
 */
export function itemLine(i: DeskItem): string {
  const one = (v: string) => clean(v).replace(/\s+/g, ' ').trim();
  const where = i.closed ? `закрыто: ${one(i.closed.reason)}` : COLUMN_TITLE[i.column] ?? one(String(i.column));
  const tail = [i.kind, i.project, i.why, i.due ? `срок ${i.due}` : ''].filter(Boolean).map((v) => one(String(v))).join(' · ');
  return `${one(i.key)} — [${where}] ${one(i.title)}${tail ? ` (${tail})` : ''}`;
}

/**
 * desk_put: дела по ключу нет — заводится в колонке column (по умолчанию «Новое») с видом по типу вещи; есть — сигнал
 * дописывается, правила движения применяет хранилище. Проект и ветка — только новому делу и делу без них: дело о MR,
 * к которому вернулись из другой папки, своего проекта не теряет.
 */
export async function deskPut(ctx: DeskCallCtx, a: DeskPutArgs): Promise<{ item: DeskItem; created: boolean; text: string }> {
  const ref: ThingRef = a.thing ? resolveThing(a.thing, refOpts(ctx)) : { key: `own:${crypto.randomUUID()}` };
  const before = await ctx.api.get(ref.key);
  if (!before && !a.title && !ref.thing && !ref.link) throw new Error('У своего дела нужен title — заголовок одной строкой');
  const at = (ctx.now?.() ?? new Date()).toISOString();
  const signal: DeskSignal = {
    source: ctx.source,
    at,
    ...(ref.link ? { link: ref.link } : {}),
    ...(a.text ? { text: a.text } : {}),
    ...(ctx.routine ? { routine: ctx.routine } : {}),
  };
  const project = !before?.project ? ctx.project?.() : undefined;
  const branch = !before?.links.branch && ctx.branch ? await ctx.branch() : undefined;
  const links: Partial<DeskLinks> = {
    ...(ctx.run ? { runs: [ctx.run] } : {}),
    ...(ctx.session ? { sessions: [ctx.session] } : {}),
    ...(branch ? { branch } : {}),
    ...(ref.thing?.type === 'mr' && ref.thing.url ? { mr: ref.thing.url } : {}),
  };
  const type = ref.thing?.type;
  // заголовок нового дела без title: вещи («MR grp/App!12», «ABC-12») или адрес своего дела по ссылке
  const label = ref.title ?? (ref.thing ? thingLabel({ key: ref.key, ...ref.thing }) : undefined) ?? ref.link ?? keyLabel(ref.key);
  const patch: DeskPatch = {
    ...(a.title ? { title: a.title } : before ? {} : { title: clean(label).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) }),
    ...(a.kind ? { kind: a.kind } : before ? {} : { kind: (type && KIND_BY_TYPE[type]) ?? 'Своё' }),
    ...(project ? { project } : {}),
    ...(a.column ? { column: a.column } : {}),
    ...(a.why ? { why: a.why } : before ? {} : { why: ctx.why }),
    ...(a.due ? { due: a.due } : {}),
    ...(ref.thing ? { thing: ref.thing } : {}),
    ...(Object.keys(links).length ? { links } : {}),
    signal,
  };
  const item = await ctx.api.put(ref.key, patch, ctx.by);
  // новое — если его не было до вызова и в нём один сигнал: два этапа параллельной группы о той же вещи оба не видят
  // дела до put, но завело его только первое
  const created = !before && item.signals.length <= 1;
  ctx.onPut?.(item, created);
  const moved = before && before.column !== item.column ? `, перенесено из «${COLUMN_TITLE[before.column]}»` : '';
  const reopened = before?.closed && !item.closed ? ', снова открыто' : '';
  const head = created ? 'Дело заведено' : `Сигнал добавлен к делу${moved}${reopened}`;
  return { item, created, text: `${head}: ${itemLine(item)}` };
}

const refOpts = (ctx: Pick<DeskCallCtx, 'thing' | 'jiraHosts'>) => ({ jiraHosts: (ctx.jiraHosts ?? settingsJiraHosts)(), ...(ctx.thing ? { known: ctx.thing } : {}) });

/** desk_close: дело по ключу или ссылке на вещь; нет такого или закрывать его отсюда нельзя (canClose) — ошибка. */
export async function deskClose(ctx: Pick<DeskCallCtx, 'api' | 'by' | 'thing' | 'jiraHosts' | 'canClose'>, a: DeskCloseArgs): Promise<{ item: DeskItem; text: string }> {
  const { key } = resolveThing(a.thing, refOpts(ctx));
  const missing = () => new Error(`Дела ${key} нет: ключи открытых дел — в desk_list`);
  if (ctx.canClose) {
    const cur = await ctx.api.get(key);
    if (!cur) throw missing();
    const why = ctx.canClose(cur);
    if (why) throw new Error(why);
  }
  const item = await ctx.api.close(key, a.reason, ctx.by);
  if (!item) throw missing();
  return { item, text: `Дело закрыто: ${itemLine(item)}` };
}

/** desk_list: открытые дела (closed: true — и закрытые), по колонкам и проекту; не больше LIST_MAX строк. */
export async function deskList(ctx: Pick<DeskCallCtx, 'api'>, a: DeskListArgs): Promise<{ items: DeskItem[]; text: string }> {
  const items = await ctx.api.list({
    ...(a.column?.length ? { column: a.column.length === 1 ? a.column[0] : a.column } : {}),
    ...(a.project ? { project: a.project } : {}),
    ...(a.closed ? {} : { open: true }),
  });
  if (!items.length) return { items, text: 'Дел нет.' };
  const lines = items.slice(0, LIST_MAX).map(itemLine);
  if (items.length > LIST_MAX) lines.push(`…и ещё ${items.length - LIST_MAX}: сузь по column или project`);
  return { items, text: lines.join('\n') };
}

// ---------- описания инструментов

const columnsHelp = DESK_COLUMNS.map((c) => `${c} — ${COLUMN_TITLE[c]}`).join(', ');

/** Параметры инструментов (zod): из них — схема SDK у этапа flow и JSON Schema у сессии. Проверку делают parse*Args. */
export const DESK_PUT_SHAPE = {
  thing: z
    .string()
    .optional()
    .describe('Ключ вещи (mr:…, jira:…, branch:…, own:…) или ссылка на MR, PR, задачу Jira. Не задано — своё дело с заголовком title. Повторный вызов с той же вещью дописывает сигнал в то же дело.'),
  title: z.string().optional().describe(`Заголовок дела одной строкой, до ${TITLE_MAX} знаков. Обязателен у своего дела.`),
  kind: z.string().optional().describe('Вид дела коротко: Ревью, Jira, Встреча, Забытое, Своё. Не задано — по типу вещи.'),
  why: z.string().optional().describe(`Почему сейчас ход за пользователем — одна строка для карточки, до ${WHY_MAX} знаков.`),
  due: z.string().optional().describe('Срок: YYYY-MM-DD или дата со временем ISO 8601.'),
  column: z.enum(DESK_COLUMNS as [DeskColumn, ...DeskColumn[]]).optional().describe(`Куда положить новое дело (по умолчанию new): ${columnsHelp}. Существующее дело не двигает.`),
  text: z.string().optional().describe(`Текст сигнала — что именно пришло или что нужно сделать, до ${TEXT_MAX} знаков.`),
};
export const DESK_CLOSE_SHAPE = {
  thing: z.string().describe('Ключ дела из desk_list или ссылка на его вещь (MR, PR, задача).'),
  reason: z.string().describe('Почему закрыто — одной строкой: «смержено», «ответил в треде», «не актуально».'),
};
export const DESK_LIST_SHAPE = {
  column: z.array(z.enum(DESK_COLUMNS as [DeskColumn, ...DeskColumn[]])).optional().describe(`Только эти колонки: ${columnsHelp}. Не задано — все.`),
  project: z.string().optional().describe('Только дела этого проекта (слаг пространства).'),
  closed: z.boolean().optional().describe('true — и закрытые дела. По умолчанию только открытые.'),
};

/** Описания для модели: where — сессия терминала или этап flow; hint — вещь и проект места вызова. */
export function deskToolDescriptions(where: 'session' | 'flow', hint: DeskHint = {}): Record<(typeof DESK_TOOLS)[number], string> {
  const self = where === 'session' ? 'Сессия, проект и ветка подставятся сами.' : 'Запуск, проект и ветка подставятся сами.';
  const key = hint.thing ? (canonicalKey(hint.thing.key) ?? clean(hint.thing.key)) : '';
  const title = hint.thing?.title ? clean(hint.thing.title).replace(/[\s«»"]+/g, ' ').trim().slice(0, HINT_TITLE_MAX) : '';
  const thing = hint.thing ? ` ${where === 'session' ? 'Сессия' : 'Запуск'} о вещи ${key}${title ? ` («${title}»)` : ''}: дело о ней — с thing: "${key}".` : '';
  const project = hint.project ? ` Проект: ${hint.project}.` : '';
  return {
    [DESK_PUT_TOOL]:
      'Завести дело на личной доске пользователя «Мои дела» или добавить сигнал к существующему: дело — это вещь (MR, задача Jira, ветка) или своё дело, по которому ход за пользователем. ' +
      `Одно дело на вещь: повторный вызов с тем же thing дописывает сигнал, а не заводит второе. ${self}${thing}${project} ` +
      (where === 'session' ? 'Вызывай, когда пользователь просит запомнить, отложить или завести дело.' : 'Вызывай, когда задача этапа — завести дела или когда нашлось то, что пользователь должен сделать сам.'),
    [DESK_CLOSE_TOOL]:
      'Закрыть дело на доске «Мои дела»: сделано или больше не нужно. Ключ — из desk_list или ссылка на вещь. Закрытое дело откроется снова, если по вещи придёт новый сигнал.' +
      (where === 'flow' ? ' Запуск закрывает только дела, которые завёл или дополнил сам, и дело о своей вещи.' : ''),
    [DESK_LIST_TOOL]: 'Дела пользователя на доске «Мои дела» строками «ключ — [колонка] заголовок (вид · проект · почему · срок)». Только чтение. Ключ нужен desk_put и desk_close.',
  };
}

/** JSON Schema параметров для tools/list сессии — из тех же zod-описаний. */
export function deskInputSchemas(): Record<(typeof DESK_TOOLS)[number], Record<string, unknown>> {
  const json = (shape: z.ZodRawShape) => {
    const { $schema: _, ...rest } = z.toJSONSchema(z.object(shape).strict()) as Record<string, unknown>;
    return rest;
  };
  return { [DESK_PUT_TOOL]: json(DESK_PUT_SHAPE), [DESK_CLOSE_TOOL]: json(DESK_CLOSE_SHAPE), [DESK_LIST_TOOL]: json(DESK_LIST_SHAPE) };
}

/** Вызов по имени с сырыми аргументами: разбор, обработчик, текст ответа. Не наш инструмент — undefined. */
export async function deskCall(name: unknown, args: Record<string, unknown>, ctx: DeskCallCtx): Promise<string | undefined> {
  if (name === DESK_PUT_TOOL) return (await deskPut(ctx, parsePutArgs(args))).text;
  if (name === DESK_CLOSE_TOOL) return (await deskClose(ctx, parseCloseArgs(args))).text;
  if (name === DESK_LIST_TOOL) return (await deskList(ctx, parseListArgs(args))).text;
  return undefined;
}

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** MCP-сервер дел для сессии этапа flow (in-process, как knowledge и artifacts); ctx — в момент вызова: хранилище открывается только тогда. */
export function deskToolsServer(ctx: () => DeskCallCtx, hint: DeskHint = {}) {
  const d = deskToolDescriptions('flow', hint);
  const run = (name: string) => async (args: Record<string, unknown>): Promise<ToolText> => {
    try {
      return { content: [{ type: 'text', text: (await deskCall(name, args, ctx())) ?? '' }] };
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  };
  return createSdkMcpServer({
    name: DESK_TOOLS_SERVER,
    tools: [
      tool(DESK_PUT_TOOL, d[DESK_PUT_TOOL], DESK_PUT_SHAPE, run(DESK_PUT_TOOL), { annotations: { readOnlyHint: false, destructiveHint: false } }),
      tool(DESK_CLOSE_TOOL, d[DESK_CLOSE_TOOL], DESK_CLOSE_SHAPE, run(DESK_CLOSE_TOOL), { annotations: { readOnlyHint: false, destructiveHint: false } }),
      tool(DESK_LIST_TOOL, d[DESK_LIST_TOOL], DESK_LIST_SHAPE, run(DESK_LIST_TOOL), { annotations: { readOnlyHint: true } }),
    ],
  });
}

// ---------- командная строка: agentgraph desk add | list | close

export type DeskCliOpts = { kind?: string; due?: string; project?: string; column?: string[]; why?: string };
export type DeskCliCtx = {
  /** Хранилище открывается, только когда команда разобрана. */
  api: () => DeskApi;
  /** Проект по папке, где запущена команда; --project — вместо него. */
  project: () => string | undefined;
  /** Есть ли пространство с таким слагом: опечатка в --project не заводит дело в несуществующий проект. */
  hasProject: (slug: string) => boolean;
  /** Хосты Jira для ссылок; по умолчанию — из настроек. */
  jiraHosts?: () => readonly string[];
  now?: () => Date;
};

export const DESK_CLI_HELP = `  agentgraph desk add <заголовок|ссылка> [заголовок] [--kind <вид>] [--due <YYYY-MM-DD>] [--project <слаг>] [--column <колонка>] [--why <почему>]
                                   завести дело на доске «Мои дела» (ссылка на MR, PR, задачу или ключ вещи — дело о ней)
  agentgraph desk list [--column <колонка>]… [--project <слаг>]   открытые дела
  agentgraph desk close <ключ|ссылка> [причина]                     закрыть дело
                                   колонки: ${DESK_COLUMNS.join(', ')}`;

const looksLikeThing = (s: string) => /^https?:\/\//i.test(s) || (KEY_RE.test(s) && !/\s/.test(s));

/** agentgraph desk …: ответ — строки для терминала и код выхода; ошибка разбора — исключением с текстом для человека. */
export async function deskCommand(sub: string | undefined, rest: string[], o: DeskCliOpts, ctx: DeskCliCtx): Promise<{ code: number; lines: string[] }> {
  const flags = (allowed: (keyof DeskCliOpts)[]) => {
    const extra = (Object.keys(o) as (keyof DeskCliOpts)[]).filter((k) => o[k] !== undefined && !(Array.isArray(o[k]) && !o[k]!.length) && !allowed.includes(k));
    if (extra.length) throw new Error(`${extra.map((k) => `--${k}`).join(', ')} — не для desk ${sub}`);
  };
  if (o.project && !ctx.hasProject(o.project)) throw new Error(`Пространства ${o.project} нет: agentgraph spaces — список`);
  switch (sub) {
    case 'add': {
      flags(['kind', 'due', 'project', 'column', 'why']);
      if ((o.column?.length ?? 0) > 1) throw new Error('desk add: одна --column');
      const [first, ...tail] = rest;
      if (!first?.trim()) throw new Error('Укажи заголовок или ссылку: agentgraph desk add "<заголовок>"');
      const thing = looksLikeThing(first.trim()) ? first.trim() : undefined;
      const title = (thing ? tail : rest).join(' ').trim();
      const args = parsePutArgs({ thing, title, kind: o.kind, due: o.due, why: o.why, column: o.column?.[0] });
      const project = o.project ?? ctx.project();
      const r = await deskPut(
        { api: ctx.api(), by: 'me', source: 'cli', project: () => project, why: 'заведено из командной строки', ...(ctx.jiraHosts ? { jiraHosts: ctx.jiraHosts } : {}), ...(ctx.now ? { now: ctx.now } : {}) },
        args,
      );
      return { code: 0, lines: [r.text] };
    }
    case 'list': {
      flags(['column', 'project']);
      const args = parseListArgs({ column: o.column?.length ? o.column : undefined, project: o.project });
      const r = await deskList({ api: ctx.api() }, args);
      return { code: 0, lines: r.text.split('\n') };
    }
    case 'close': {
      flags([]);
      const [key, ...why] = rest;
      if (!key?.trim()) throw new Error('Укажи ключ дела: agentgraph desk close <ключ> [причина] (ключи — agentgraph desk list)');
      const args = parseCloseArgs({ thing: key, reason: why.join(' ').trim() || 'закрыто вручную' });
      const r = await deskClose({ api: ctx.api(), by: 'me', ...(ctx.jiraHosts ? { jiraHosts: ctx.jiraHosts } : {}) }, args);
      return { code: 0, lines: [r.text] };
    }
    default:
      throw new Error(`desk: add, list или close\n${DESK_CLI_HELP}`);
  }
}
