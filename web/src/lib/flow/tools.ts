// Поля этапа в конструкторе: модели, effort, права, подсказки инструментов и коннекторы claude.ai (порт ui/app.js). Без React и DOM.
import type { ConnectorsView } from '@server/api-types';
import { plural } from '../format';
import type { EditPhase } from './edit';

export const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
export const MODELS: [string, string][] = [
  ['', 'по умолчанию'],
  ['claude-fable-5-1', 'Fable 5.1'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
];
/** Значение не из списка (вписано в YAML руками) — отдельным пунктом, чтобы не потерять при сохранении. */
export const modelOptions = (current = ''): [string, string][] => (MODELS.some(([id]) => id === current) ? MODELS : [...MODELS, [current, current]]);
export const PERMS = ['', 'default', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan', 'auto'];
export const TOOL_HINT: Record<string, string> = {
  Read: 'читать файлы', Grep: 'искать по содержимому', Glob: 'искать файлы по маске', Edit: 'править файлы',
  Write: 'создавать файлы', Bash: 'запускать команды', WebSearch: 'искать в вебе', WebFetch: 'читать страницы',
  AskUserQuestion: 'задать вопрос пользователю и дождаться ответа',
  Agent: 'сабагенты: включены в каждом этапе всегда', Skill: 'скиллы: включены в каждом этапе всегда',
};

/** Инструменты этапа для подсказки узла: свои и те, что движок добавляет в каждую сессию (Agent, Skill). */
export const toolsLabel = (tools: string[] | undefined, implicit: readonly string[]): string =>
  [...(tools || []), ...implicit.filter((t) => !(tools || []).includes(t))].join(', ');

// Коннекторы claude.ai (Jira, Confluence, Slack): этап получает их, только если перечислил их инструменты в tools,
// остальным раннер их выключает. Имя в этапе всегда mcp__claude_ai_<Коннектор>__<инструмент>.
export const CONN_PREFIX = 'mcp__claude_ai_';
// mcp__claude_ai_<Коннектор> — весь коннектор, mcp__claude_ai_<Коннектор>__<инструмент> — один инструмент
const CONN_NAME_RE = /^mcp__claude_ai_[A-Za-z0-9_-]+$/;
// промпт зовёт Jira, Confluence или Slack: имя инструмента, «Atlassian MCP», ссылка или «открой … в Jira»
const CONN_MENTION_RE = /\b(get|search|create|edit|add|update)\w*(jira|confluence)\w*|\bslack_\w+|atlassian\s*mcp|mcp\s*atlassian|atlassian\.net|slack\.com\/|(открой|прочитай|получи|загрузи|достань|возьми)[^.\n]{0,40}(jira|confluence|slack)/i;
const CONN_OPEN_MODES = ['bypassPermissions', 'auto'];

/** «mcp__claude_ai_Atlassian_Rovo__getJiraIssue» → ['Atlassian Rovo', 'getJiraIssue']; весь коннектор — инструмент ''. */
export function connParts(name: string): [string, string] {
  const [server = '', ...tool] = name.slice(CONN_PREFIX.length).split('__');
  return [server.replace(/_/g, ' '), tool.join('__')];
}
/** Запись всего коннектора, к которому относится инструмент: mcp__claude_ai_Slack__x → mcp__claude_ai_Slack. */
export const connWhole = (name: string): string => name.split('__').slice(0, 2).join('__');

/** Сервер старее UI не присылает name коннектора: берём его из имён инструментов. */
export function normalizeConnectors(view: ConnectorsView): ConnectorsView {
  for (const c of view.connectors) {
    c.name ??= c.tools[0] ? connWhole(c.tools[0].name) : `${CONN_PREFIX}${c.server.replace(/^claude\.ai /, '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }
  return view;
}

/** Добавить инструменты: весь коннектор заменяет его отдельные инструменты; отдельный при выданном целиком не нужен. */
export function addConnTools(tools: string[], names: string[]): string[] {
  let out = tools;
  for (const t of names) {
    const [, tool] = connParts(t);
    if (!tool) out = out.filter((x) => !(x.startsWith(CONN_PREFIX) && connWhole(x) === t && x !== t));
    else if (out.includes(connWhole(t))) continue;
    if (!out.includes(t)) out = [...out, t];
  }
  return out;
}

/** Ручной ввод имени: ошибка — текст для всплывашки, '' — имя подходит. */
export function connManualError(t: string): string {
  if (CONN_NAME_RE.test(t)) return '';
  return t.startsWith('mcp__')
    ? `В этапе имя коннектора — ${CONN_PREFIX}<Коннектор>__<инструмент> или ${CONN_PREFIX}<Коннектор>; имя вида mcp__<uuid>__… из desktop-сессии не подойдёт`
    : `Нужно имя вида ${CONN_PREFIX}<Коннектор>__<инструмент> или ${CONN_PREFIX}<Коннектор> (весь коннектор)`;
}

export type ConnChip = { name: string; text: string; title: string; cls: '' | 'on' | 'on write' | 'on unknown' | 'other' };

/** Чипы выданных этапу инструментов не из встроенных: коннекторы claude.ai и прочие MCP. */
export function connChips(p: EditPhase, builtin: Set<string>, view: ConnectorsView | null): ConnChip[] {
  const extra = (p.tools || []).filter((t) => !builtin.has(t));
  const live = new Map((view?.connectors || []).flatMap((c) => c.tools.map((x) => [x.name, x] as const)));
  const wholes = new Map((view?.connectors || []).map((c) => [c.name, c] as const));
  const writes = (c: ConnectorsView['connectors'][number]) => c.tools.filter((x) => !x.readOnly).length;
  return extra.map((t): ConnChip => {
    if (!t.startsWith(CONN_PREFIX)) return { name: t, text: t, title: `${t}: MCP-инструмент не из коннекторов claude.ai, выдача этапу не проверена`, cls: 'other' };
    const [server, tool] = connParts(t);
    if (!tool) {
      const c = wholes.get(t);
      const why = view && !c ? 'нет такого подключённого коннектора: проверь имя' : `все инструменты коннектора${c ? ` (${c.tools.length}, из них меняют данные — ${writes(c)})` : ', в том числе меняющие данные,'} разрешены без подтверждения; новые инструменты коннектора этап тоже получит`;
      return { name: t, text: `${server} · весь коннектор`, title: `${t} — ${why}`, cls: view && !c ? 'on unknown' : 'on write' };
    }
    const x = live.get(t);
    const cls = view && !x ? 'on unknown' : x && !x.readOnly ? 'on write' : 'on';
    const why = view && !x ? 'нет у подключённых коннекторов: проверь имя' : x && !x.readOnly ? 'меняет данные снаружи, и этап сделает это без подтверждения' : x?.description || '';
    return { name: t, text: `${server} · ${tool}`, title: `${t}${why ? ` — ${why}` : ''}`, cls };
  });
}

/** Примечание под чипами коннекторов: [тон, текст]. */
export function connNote(p: EditPhase, builtin: Set<string>, view: ConnectorsView | null): ['' | 'warn', string] {
  const conn = (p.tools || []).filter((t) => !builtin.has(t) && t.startsWith(CONN_PREFIX));
  const live = new Map((view?.connectors || []).flatMap((c) => c.tools.map((x) => [x.name, x] as const)));
  const write = conn.map((t) => {
    const [server, tool] = connParts(t);
    if (!tool) return `весь ${server}`;
    return live.get(t) && !live.get(t)!.readOnly ? tool : '';
  }).filter(Boolean);
  const mentions = CONN_MENTION_RE.test(`${p.prompt || ''}\n${p.handoff || ''}`);
  if (p.permission_mode && CONN_OPEN_MODES.includes(p.permission_mode)) return ['', `Права «${p.permission_mode}»: коннекторы этапу доступны и без списка.`];
  if (conn.length) {
    return write.length
      ? ['warn', `Этап получит коннекторы. Без подтверждения он сможет и менять данные: ${write.join(', ')}.`]
      : ['', 'Этап получит коннекторы. Перечисленные инструменты разрешены без подтверждения.'];
  }
  return mentions
    ? ['warn', 'Промпт обращается к Jira, Confluence или Slack, а коннекторов у этапа нет: вызвать их он не сможет. Добавь нужные инструменты.']
    : ['', 'Выключены: этап не получит Jira, Confluence и Slack и не потратит на них контекст. Нужны — добавь инструменты, которые он вызывает.'];
}

export type ConnOption = { value: string; label: string; title?: string };
export type ConnGroup = { label: string; options: ConnOption[] };

/** Выбор инструмента коннектора: группы по коннекторам, «★ весь коннектор» и «★ всё на чтение» сверху каждой. */
export function connPick(p: EditPhase, view: ConnectorsView): { groups: ConnGroup[]; ready: number; off: string[] } {
  const cs = view.connectors;
  const ready = cs.filter((c) => c.status === 'connected' && c.tools.length);
  const off = cs.filter((c) => c.status !== 'connected').map((c) => c.server.replace(/^claude\.ai /, ''));
  const tw = (n: number) => `${n} ${plural(n, 'инструмент', 'инструмента', 'инструментов')}`;
  const groups = ready.flatMap((c): ConnGroup[] => {
    // весь коннектор уже выдан — добавлять из него нечего
    if (p.tools.includes(c.name)) return [];
    const left = c.tools.filter((x) => !p.tools.includes(x.name));
    const read = left.filter((x) => x.readOnly);
    const w = c.tools.filter((x) => !x.readOnly).length;
    const options: ConnOption[] = [{ value: `whole:${c.name}`, label: `★ весь коннектор — ${tw(c.tools.length)}${w ? `, из них меняют данные — ${w}` : ''}` }];
    if (read.length > 1 && read.length < left.length) options.push({ value: `read:${c.name}`, label: `★ всё на чтение — ${tw(read.length)}` });
    for (const x of left) options.push({ value: x.name, label: `${x.tool}${x.readOnly ? '' : ' — меняет данные'}`, title: x.description || '' });
    return [{ label: c.server.replace(/^claude\.ai /, ''), options }];
  });
  return { groups, ready: ready.length, off };
}

/** Что добавить по выбранному пункту: whole:<коннектор>, read:<коннектор> или имя инструмента. */
export function connPicked(value: string, view: ConnectorsView | null): string[] {
  const [kind, name] = value.includes(':') ? (value.split(':') as [string, string]) : ['', value];
  if (kind === 'read') return (view?.connectors.find((x) => x.name === name)?.tools || []).filter((x) => x.readOnly).map((x) => x.name);
  return [name];
}
