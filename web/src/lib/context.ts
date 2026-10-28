// Страница «Контекст» (порт логики ui/context.js): выбор проекта, flow и этапа, разметка токенов, списки, редактор файла.
// Без React и DOM.
import type { ContextView, FlowListItem, RecentDir } from '@server/api-types';
import { clock, plural } from './format';
import { t } from './i18n';

/** Запомненный выбор: тот же ключ и формат, что у старого UI. */
export const CTX_LS = 'agentgraph.context';
export type CtxSelection = { cwd: string; flow: string; phase: string; model: string };

export const CTX_KIND_LABEL: Record<string, string> = { used: t('занято'), deferred: t('вне окна'), buffer: t('резерв на сжатие'), free: t('свободно') };

export const ctxTokens = (n: number): string => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
/** Путь в домашней папке — с «~». */
export const ctxHome = (p: string, home: string | undefined): string => (home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);
export const ctxSum = (list: { tokens: number }[]): number => list.reduce((n, x) => n + x.tokens, 0);

/** Строка запроса GET /api/context: пустые поля не уходят; force — мимо минутного кэша сервера. */
export function ctxQuery(sel: CtxSelection, force: boolean): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sel)) if (v) q.set(k, v);
  if (force) q.set('force', '1');
  return q.toString();
}

/** Подсказки директории: по умолчанию, последняя директория формы запуска (сервер её не знает) и недавние существующие. */
export function ctxProjects(defaultCwd: string | undefined, lastCwd: string | null, recent: RecentDir[]): string[] {
  const paths = new Set([defaultCwd, lastCwd].filter((x): x is string => Boolean(x)));
  // пути, которых уже нет на диске, в подсказки не идут
  for (const d of recent) if (d.exists) paths.add(d.path);
  return [...paths].sort();
}

/** Выбор flow: только валидные, подпись — «папка/имя». */
export const ctxFlowOptions = (flows: FlowListItem[]): { value: string; label: string }[] =>
  flows.filter((f) => f.valid !== false).map((f) => ({ value: f.name, label: f.folder ? `${f.folder}/${f.name}` : f.name }));

type SpecPhase = { name: string; title?: string };
type SpecLike = { blocks?: { name: string; title?: string; phases?: SpecPhase[] }[]; phases?: SpecPhase[] };
export type PhaseOption = { value: string; label: string };
/** Этапы flow: при нескольких блоках — группами по блокам (label — группа), при одном — плоским списком (label пустой). */
export type PhaseGroup = { label: string; options: PhaseOption[] };

export function ctxPhaseGroups(spec: SpecLike | undefined): PhaseGroup[] {
  if (!spec) return [];
  // у блока-вызова своих этапов нет (их сессии — в вызываемом flow), в выборе его не показываем
  const blocks = (spec.blocks || [{ name: 'main', phases: spec.phases || [] }]).filter((b) => b.phases?.length);
  const opt = (p: SpecPhase): PhaseOption => ({ value: p.name, label: p.title || p.name });
  return blocks.length > 1
    ? blocks.map((b) => ({ label: b.title || b.name, options: (b.phases ?? []).map(opt) }))
    : [{ label: '', options: (blocks[0]?.phases ?? []).map(opt) }];
}

/** Шапка: «cwd · flow X, этап Y · модель M · данные на HH:MM». */
export function ctxMeta(d: Pick<ContextView, 'cwd' | 'flow' | 'phase' | 'model' | 'at'>, now?: Date): string {
  const what = [d.flow && `flow ${d.flow}`, d.phase && t('этап {phase}', { phase: d.phase })].filter(Boolean).join(', ');
  return `${d.cwd}${what ? ` · ${what}` : ''} · ${t('модель {model}', { model: d.model })} · ${t('данные на {time}', { time: clock(d.at, now) })}`;
}

// ---------- токены: полоса занятого и легенда

export type CtxBarPart = { c: number; width: string; title: string };
export type CtxLegendItem = { name: string; tokens: string; c: number | null; used: boolean; kind: string };

export function ctxTotals(d: Pick<ContextView, 'categories'>): { bar: CtxBarPart[]; legend: CtxLegendItem[] } {
  const used = d.categories.filter((c) => c.kind === 'used' && c.tokens > 0);
  const total = ctxSum(used) || 1;
  const bar = used.map((c, i) => ({ c: i % 8, width: `${(c.tokens / total) * 100}%`, title: `${c.name}: ${c.tokens}` }));
  const legend = d.categories.filter((c) => c.tokens > 0).map((c) => {
    const i = used.indexOf(c);
    return { name: c.name, tokens: ctxTokens(c.tokens), c: i >= 0 ? i % 8 : null, used: c.kind === 'used', kind: c.kind === 'used' ? '' : CTX_KIND_LABEL[c.kind] || c.kind };
  });
  return { bar, legend };
}

// ---------- память

/** Есть ли у проекта свой CLAUDE.md (в корне или в .claude/). */
export const ctxProjectMd = (d: Pick<ContextView, 'cwd' | 'memoryFiles'>): boolean =>
  d.memoryFiles.some((f) => f.path === `${d.cwd}/CLAUDE.md` || f.path === `${d.cwd}/.claude/CLAUDE.md`);

export type CtxNote = { text: string; err: boolean };

export const ctxAddDirs = (d: Pick<ContextView, 'addDirs'>, home: string | undefined): CtxNote[] =>
  d.addDirs.map((x) => ({ text: `${ctxHome(x.path, home)}${x.exists ? '' : t(' — нет')}`, err: !x.exists }));

/** Тег знаний блока: слаг, режим («по запросу» — строка в промпте и knowledge_read, «в промпте целиком») и описание; ошибки — как раньше. */
export const ctxKnowledge = (d: Pick<ContextView, 'knowledge'>): CtxNote[] =>
  (d.knowledge || []).map((k) => {
    const ok = k.exists && k.kind === 'knowledge';
    const mode = k.mode === 'inline' ? t('в промпте целиком') : k.mode === 'on-demand' ? t('по запросу') : '';
    const detail = ok ? [mode, k.description].filter(Boolean).join(': ') : '';
    return {
      text: `${k.slug}${!k.exists ? t(' — нет') : k.kind !== 'knowledge' ? t(' — тег задачи') : detail ? ` — ${detail}` : ''}`,
      err: !ok,
    };
  });

// ---------- промпт этапа по источникам

export type CtxPromptRow = { name: string; chars: string; share: string; inline: boolean };
/** Знаков на токен для оценки «≈ токенов»: русский текст плотнее английского, берём среднее. */
const CHARS_PER_TOKEN = 3.2;
export const ctxPromptTokens = (chars: number): string => t('≈ {n} токенов', { n: ctxTokens(Math.round(chars / CHARS_PER_TOKEN)) });
export const ctxChars = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Части промпта по убыванию размера с долей в процентах; теги целиком помечены. */
export function ctxPromptRows(p: { parts: { name: string; kind: string; chars: number }[]; chars: number }): CtxPromptRow[] {
  const total = p.chars || 1;
  return [...p.parts]
    .sort((a, b) => b.chars - a.chars)
    .map((x) => ({ name: x.name, chars: ctxChars(x.chars), share: `${Math.round((x.chars / total) * 100)}%`, inline: x.kind === 'knowledge-inline' }));
}

/** Подпись переменных: «подстановки {{input}}, {{prev}} добавятся в запуске» или что их нет. */
export const ctxPromptVars = (vars: string[]): string =>
  vars.length
    ? t('Подстановки {vars} добавятся в запуске, их размер заранее неизвестен.', { vars: vars.map((v) => `{{${v}}}`).join(', ') })
    : t('Переменных шаблона нет: промпт в запуске будет ровно таким.');

export const ctxOpenTitle = (editable: boolean): string => (editable ? t('Открыть и править') : t('Только просмотр: managed-политика, плагин или не .md'));

// ---------- списки: скиллы, сабагенты, MCP

export type CtxRow = { name: string; source: string; tokens: number };

/** Строки списка — по убыванию токенов. */
export const ctxRows = (list: CtxRow[]): CtxRow[] => [...list].sort((a, b) => b.tokens - a.tokens);
/** Подпись в заголовке списка: «· N, Xk». */
export const ctxListSum = (list: CtxRow[]): string => `· ${list.length}, ${ctxTokens(ctxSum(list))}`;

/** MCP — по серверам: число инструментов и их токены вместе. */
export function ctxMcpServers(d: Pick<ContextView, 'mcpTools'>): CtxRow[] {
  const by = new Map<string, { tokens: number }[]>();
  for (const tool of d.mcpTools) {
    if (!by.has(tool.server)) by.set(tool.server, []);
    by.get(tool.server)!.push(tool);
  }
  return [...by].map(([server, tools]) => ({ name: server, source: `${tools.length} ${plural(tools.length, 'инструмент', 'инструмента', 'инструментов')}`, tokens: ctxSum(tools) }));
}

export const CTX_HINT = {
  skills: t('Описания скиллов всегда в контексте, тело скилла грузится при вызове'),
  agents: t('Описания сабагентов для инструмента Agent; встроенные не показаны'),
  mcp: t('MCP-серверы и их инструменты'),
};

// ---------- редактор CLAUDE.md и правил

/** Открытый файл: текст в поле, сохранённый текст, mtime для проверки при записи, конфликт (409) и сообщение. */
export type CtxEdit = { path: string; text: string; saved: string; mtimeMs: number; editable: boolean; conflict: boolean; msg: string };

export const ctxDirty = (e: CtxEdit | null): boolean => Boolean(e && e.editable && e.text !== e.saved);

/** Кнопки и сообщение шапки редактора. */
export function ctxEditState(e: CtxEdit): { save: boolean; saveDisabled: boolean; cancel: string; reload: boolean; msgClass: string; msg: string } {
  const dirty = ctxDirty(e);
  return {
    save: e.editable,
    saveDisabled: !dirty,
    cancel: e.editable ? t('Отменить') : t('Закрыть'),
    reload: e.conflict,
    msgClass: e.conflict ? 'msg err' : 'msg',
    msg: e.msg || (e.editable ? (dirty ? t('Есть несохранённая правка') : '') : t('Только просмотр')),
  };
}

export const CTX_TEXT = {
  close: t('Закрыть файл без сохранения?'),
  reload: t('Перечитать файл с диска? Твоя правка пропадёт: скопируй её, если нужна.'),
  other: t('В открытом файле есть несохранённая правка. Открыть другой без сохранения?'),
  loading: t('Спрашиваю Claude Code…'),
  empty: t('Выбери директорию проекта: листинг займёт пару секунд.'),
};
