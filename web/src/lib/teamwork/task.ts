// Задача Teamwork в панели и списках (spec §5.4, §8.5–8.9, макеты Task.dc.html, Backlog.dc.html, Main.dc.html): тело задачи
// как описание и критерии приёмки с галочками, правка тела без потери остального, «Переместить…» с клавиатуры, вход
// своего flow для «В работу ▸» и тела запросов запуска и сессии. Чистая логика без React и DOM.
import type { FlowSummary, TeamProject, TeamTask, TeamTaskIntake, TeamTaskStatus, TeamTaskWorktree } from '@server/api-types';
import { t } from '../i18n';
import { dropMove, statusText, without, type Drop } from './board';
import { fencedLines, splitLines } from './docs';

// ---------- тело задачи: описание и критерии приёмки

const ACC_HEAD = /^(критерии приёмки|критерии приемки|acceptance criteria)$/i;
const DESC_HEAD = /^(описание|description)$/i;
const H2 = /^##\s+(.*?)\s*#*\s*$/;
const CHECK = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/;

export type Criterion = { text: string; done: boolean };

type Parts = { lines: string[]; fenced: boolean[]; acc?: { head: number; end: number }; desc?: { head: number; end: number } };

/**
 * Строки тела, строки внутри оград кода (fencedLines — как у сервера), границы разделов критериев и описания. Хвостовые
 * переводы строк в lines не входят: правка возвращает их как были (rebuild), остальной текст не трогается.
 */
function parts(body: string): Parts {
  const lines = splitLines(body.replace(/\n+$/, ''));
  const fenced = fencedLines(lines);
  const heads: { at: number; heading: string }[] = [];
  lines.forEach((l, i) => {
    const m = fenced[i] ? null : l.match(H2);
    if (m) heads.push({ at: i, heading: m[1]!.trim() });
  });
  const range = (re: RegExp) => {
    const i = heads.findIndex((h) => re.test(h.heading));
    return i < 0 ? undefined : { head: heads[i]!.at, end: heads[i + 1]?.at ?? lines.length };
  };
  return { lines, fenced, acc: range(ACC_HEAD), desc: range(DESC_HEAD) };
}

/** Номера строк с галочками критериев: в разделе «Критерии приёмки», без раздела — во всём теле (как считает сервер). */
function criterionLines(p: Parts): number[] {
  const from = p.acc ? p.acc.head + 1 : 0;
  const to = p.acc ? p.acc.end : p.lines.length;
  const out: number[] = [];
  for (let i = from; i < to; i++) if (!p.fenced[i] && CHECK.test(p.lines[i]!)) out.push(i);
  return out;
}

export function criteriaOf(body: string): Criterion[] {
  const p = parts(body);
  return criterionLines(p).map((i) => {
    const m = p.lines[i]!.match(CHECK)!;
    return { text: m[4]!.trim(), done: m[2] !== ' ' };
  });
}

/** Тело после точечной правки строк: пустые строки и отступы как были, хвост — как в исходном теле (или один перевод строки). */
const rebuild = (body: string, lines: readonly string[]): string => {
  const text = lines.join('\n');
  if (!text.trim()) return '';
  return `${text}${body.match(/\n+$/)?.[0] ?? '\n'}`;
};

/** Сборка нового тела из кусков: лишние пустые строки только по краям. */
const assemble = (lines: readonly string[]): string => {
  const s = lines.join('\n').replace(/^\n+|\s+$/g, '');
  return s ? `${s}\n` : '';
};

/** Галочка критерия с номером index; номера — по порядку criteriaOf. Меняется одна строка. */
export function toggleCriterion(body: string, index: number, done: boolean): string {
  const p = parts(body);
  const at = criterionLines(p)[index];
  if (at === undefined) return body;
  p.lines[at] = p.lines[at]!.replace(CHECK, (_m, a: string, _x: string, b: string, text: string) => `${a}${done ? 'x' : ' '}${b}${text}`);
  return rebuild(body, p.lines);
}

export function removeCriterion(body: string, index: number): string {
  const p = parts(body);
  const at = criterionLines(p)[index];
  if (at === undefined) return body;
  p.lines.splice(at, 1);
  return rebuild(body, p.lines);
}

export function editCriterion(body: string, index: number, text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return removeCriterion(body, index);
  const p = parts(body);
  const at = criterionLines(p)[index];
  if (at === undefined) return body;
  p.lines[at] = p.lines[at]!.replace(CHECK, (_m, a: string, x: string, b: string) => `${a}${x}${b}${clean}`);
  return rebuild(body, p.lines);
}

/**
 * Новый критерий в конец раздела «Критерии приёмки». Раздела нет — он появляется в конце тела, и галочки, которые до этого
 * считались критериями (без раздела — все в теле), переезжают в него же: иначе они перестали бы быть критериями.
 */
export function addCriterion(body: string, text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return body;
  const p = parts(body);
  const line = `- [ ] ${clean}`;
  if (!p.acc) {
    const ids = new Set(criterionLines(p));
    const rest = p.lines.filter((_, i) => !ids.has(i));
    return assemble([...rest, '', '## Критерии приёмки', '', ...[...ids].map((i) => p.lines[i]!), line]);
  }
  const ids = criterionLines(p);
  let at = ids.length ? ids[ids.length - 1]! + 1 : p.acc.head + 1;
  if (!ids.length) {
    // сразу под заголовком — пустая строка, как пишет сервер
    p.lines.splice(at, 0, '');
    at++;
  }
  p.lines.splice(at, 0, line);
  return rebuild(body, p.lines);
}

/** Строки, которые не относятся к описанию: раздел критериев (без раздела — сами галочки) и строка «## Описание». */
function notDescription(p: Parts): Set<number> {
  const drop = new Set<number>();
  if (p.acc) for (let i = p.acc.head; i < p.acc.end; i++) drop.add(i);
  else for (const i of criterionLines(p)) drop.add(i);
  if (p.desc) drop.add(p.desc.head);
  return drop;
}

/** Описание для чтения и правки: тело без критериев и без строки «## Описание»; код и пустые строки внутри — как были. */
export function descriptionOf(body: string): string {
  const p = parts(body);
  const drop = notDescription(p);
  return p.lines.filter((_, i) => !drop.has(i)).join('\n').replace(/^\s*\n/, '').trimEnd();
}

/** Тело с новым описанием: «## Описание» сверху, критерии — следом (раздел как был, без раздела — галочки в новый раздел). */
export function withDescription(body: string, text: string): string {
  const p = parts(body);
  const acc = p.acc ? p.lines.slice(p.acc.head, p.acc.end) : criterionLines(p).length ? ['## Критерии приёмки', '', ...criterionLines(p).map((i) => p.lines[i]!)] : [];
  const desc = text.replace(/^\s*\n/, '').trimEnd();
  return assemble([...(desc.trim() ? ['## Описание', '', desc] : []), ...(acc.length ? ['', ...acc] : [])]);
}

/** «Критерии приёмки · 2 из 5». */
export const criteriaTitle = (list: readonly Criterion[]): string =>
  list.length ? t('Критерии приёмки · {done} из {total}', { done: list.filter((c) => c.done).length, total: list.length }) : t('Критерии приёмки');

// ---------- «Переместить…» с клавиатуры

export type MoveItem = { key: string; label: string; drop: Drop; hint?: string };

/** Выше, ниже, в начало, в конец внутри списка (список — по рангу, с самой задачей). */
export function listMoves(list: readonly Pick<TeamTask, 'id' | 'rank'>[], id: string): MoveItem[] {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return [];
  const rest = without(list, id);
  const out: MoveItem[] = [];
  if (i > 0) out.push({ key: 'up', label: t('Выше'), hint: '⌥↑', drop: dropMove(rest, i - 1) });
  if (i < list.length - 1) out.push({ key: 'down', label: t('Ниже'), hint: '⌥↓', drop: dropMove(rest, i + 1) });
  if (i > 1) out.push({ key: 'top', label: t('В начало'), drop: dropMove(rest, 0) });
  if (i < list.length - 2) out.push({ key: 'bottom', label: t('В конец'), drop: dropMove(rest, rest.length) });
  return out;
}

/** Колонки доски для «Переместить…»: в конец колонки, кроме своей; columns — названия колонок команды. */
export function columnMoves(
  cols: Record<TeamTaskStatus, readonly Pick<TeamTask, 'id' | 'rank'>[]>, status: TeamTaskStatus, columns?: Partial<Record<TeamTaskStatus, string>>,
): MoveItem[] {
  return (Object.keys(cols) as TeamTaskStatus[])
    .filter((s) => s !== status)
    .map((s) => ({ key: s, label: t('В колонку «{name}»', { name: columns?.[s] || statusText(s) }), drop: dropMove(cols[s], cols[s].length, { status: s }) }));
}

/** Соседняя колонка для ⌥← ⌥→: то же место по счёту, за краем — в конец. */
export function sideMove(
  cols: Record<TeamTaskStatus, readonly Pick<TeamTask, 'id' | 'rank'>[]>, order: readonly TeamTaskStatus[], id: string, dir: -1 | 1,
): { status: TeamTaskStatus; drop: Drop } | undefined {
  const from = order.findIndex((s) => cols[s].some((x) => x.id === id));
  if (from < 0) return undefined;
  const to = order[from + dir];
  if (!to) return undefined;
  const index = cols[order[from]!].findIndex((x) => x.id === id);
  return { status: to, drop: dropMove(cols[to], Math.min(index, cols[to].length), { status: to }) };
}

/**
 * Ранг задачи после переноса так, как его поставит сервер: без соседей (пустой список) ранг не меняется, с соседом —
 * ранг из dropMove. Мгновенная перерисовка с другим рангом прыгала бы, когда придёт ответ.
 */
export const dropRank = (drop: Drop, current: string): string => (drop.move.after || drop.move.before ? drop.rank : current);

/**
 * Место вставки при перетаскивании: index — строка под курсором в списке с переносимой задачей, after — курсор в нижней
 * половине строки. Ответ — позиция в списке без переносимой задачи (для dropMove).
 */
export function dropIndex(list: readonly { id: string }[], dragged: string, index: number, after: boolean): number {
  const at = index + (after ? 1 : 0);
  const from = list.findIndex((x) => x.id === dragged);
  return from >= 0 && from < at ? at - 1 : at;
}

/** Перенос ничего не меняет: та же позиция в том же списке без смены статуса и спринта. */
export function samePlace(list: readonly { id: string }[], dragged: string, index: number): boolean {
  const from = list.findIndex((x) => x.id === dragged);
  return from >= 0 && from === index;
}

// ---------- поля

export const ESTIMATES: readonly number[] = [1, 2, 3, 5, 8];

/** Шаг перехода задачи в «В работу ▸»: у задачи нет репо, а у проекта их несколько — сначала выбор. */
export const needsRepo = (task: Pick<TeamTask, 'repo'>, project: Pick<TeamProject, 'repos'>): boolean => !task.repo && project.repos.length > 1;

/** Репо задачи: своё, иначе единственное репо проекта. */
export const taskRepo = (task: Pick<TeamTask, 'repo'>, project: Pick<TeamProject, 'repos'>): string | undefined =>
  task.repo || (project.repos.length === 1 ? project.repos[0]!.key : undefined);

// ---------- «В работу ▸»: вход своего flow, тела запуска и сессии

const FORM_LINE = /^(\s*)(Тикет|Ticket|Задача|Task|Ветка|Branch)(\s*:\s*)<[^<>\n]*>\s*$/i;

/**
 * Вход своего flow (не из команды): анкета flow со строками «Задача:» и «Ветка:», ниже текст задачи — как composeInput
 * сервера (src/intake.ts). Без плейсхолдеров в анкете — только текст задачи.
 */
export function myFlowInput(template: string | undefined, fill: { task: string; branch?: string }, context: string): string {
  const parts: string[] = [];
  const lines = (template ?? '').split('\n');
  if (lines.some((l) => FORM_LINE.test(l))) {
    parts.push(
      lines
        .map((line) => {
          const m = line.match(FORM_LINE);
          if (!m) return line;
          const v = /^(Тикет|Ticket|Задача|Task)$/i.test(m[2]!) ? fill.task : fill.branch;
          return v ? `${m[1]}${m[2]}${m[3]}${v}` : line;
        })
        .join('\n')
        .trim(),
    );
  }
  parts.push(context.trim());
  return parts.join('\n\n');
}

/** Выбор flow в форме «В работу»: flow команды или свой. */
export type WorkFlow = { kind: 'team'; name: string } | { kind: 'mine'; name: string };

export const workFlowKey = (f: WorkFlow): string => `${f.kind}:${f.name}`;
export const parseWorkFlow = (key: string): WorkFlow | undefined => {
  const m = key.match(/^(team|mine):(.+)$/);
  return m ? { kind: m[1] as WorkFlow['kind'], name: m[2]! } : undefined;
};

/** Flow по умолчанию: flow команды из intake, иначе первый flow команды, иначе первый свой. */
export function defaultWorkFlow(intake: Pick<TeamTaskIntake, 'teamFlow' | 'teamFlows'>, mine: readonly Pick<FlowSummary, 'name'>[]): WorkFlow | undefined {
  if (intake.teamFlow) return { kind: 'team', name: intake.teamFlow.name };
  if (intake.teamFlows[0]) return { kind: 'team', name: intake.teamFlows[0] };
  return mine[0] ? { kind: 'mine', name: mine[0].name } : undefined;
}

export type WorkRunForm = { input: string; space: string; model: string; budget: string };

/**
 * Тело POST /api/runs для задачи (заметка work, «Что звать UI»): flow команды — teamFlow, свой — flow; папка — worktree;
 * связь teamwork, источник, доп. папка проекта и пространство — из intake.
 */
export function workRunBody(intake: TeamTaskIntake, wt: Pick<TeamTaskWorktree, 'path' | 'branch'>, flow: WorkFlow, f: WorkRunForm): Record<string, unknown> {
  const budget = Number(f.budget);
  return {
    ...(flow.kind === 'team' ? { teamFlow: { team: intake.teamwork.team, name: flow.name } } : { flow: flow.name }),
    teamwork: intake.teamwork,
    input: f.input,
    cwd: wt.path,
    worktree: { path: wt.path, branch: wt.branch },
    addDirs: intake.addDirs,
    source: intake.source,
    ...(f.space.trim() ? { space: f.space.trim(), saveState: true } : {}),
    ...(f.model.trim() ? { model: f.model.trim() } : {}),
    ...(f.budget.trim() && Number.isFinite(budget) && budget > 0 ? { maxBudgetUsd: budget } : {}),
  };
}

/** Тело POST /api/sessions для задачи: папка — worktree, первое сообщение — текст задачи, пространство проекта. */
export function workSessionBody(intake: TeamTaskIntake, wt: Pick<TeamTaskWorktree, 'path'>, f: Pick<WorkRunForm, 'input' | 'space' | 'model'>): Record<string, unknown> {
  return {
    cwd: wt.path,
    prompt: f.input,
    tags: [],
    saveState: true,
    teamwork: intake.teamwork,
    name: `${intake.source.key} · ${intake.source.title ?? ''}`.replace(/ · $/, '').slice(0, 80),
    ...(f.space.trim() ? { space: f.space.trim() } : {}),
    ...(f.model.trim() ? { model: f.model.trim() } : {}),
  };
}
