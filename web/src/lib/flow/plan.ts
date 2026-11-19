// «Что произойдёт» на вкладке «Запуск» и строки прошлых запусков (docs/flow-redesign/SPEC.md → «Запуск»): по сохранённому
// flow — этапы (один блок) или блоки по строке, где спросит человека, когда закончит, что оставит; по истории flow — сколько
// стоил прошлый раз и где запуск встал. Без React и DOM.
import type { FlowRunRow, FlowRunStop } from '@server/api-types';
import { plural, statusLabel, usd } from '../format';
import { t } from '../i18n';
import type { EditBlock, EditPhase, EditSpec, EditUntil } from './edit';

/** Блоков больше — видны первые PLAN_HEAD и те, где спросит человека, остальное под «Показать все». */
export const PLAN_FOLD = 8;
export const PLAN_HEAD = 6;
/** Статусы идущего запуска (liveStatus сервера): «в прошлый раз» — только законченный. */
const LIVE = new Set(['running', 'waiting', 'paused']);
/** Блоки тегов задач в задаче старого запуска — дубль TAG_BLOCKS_RE из src/tags.ts (рантайм из src/ в UI не импортируется). */
const TAG_BLOCKS_RE = /<!-- tag:[a-z0-9-]+ -->[\s\S]*?<!-- \/tag -->\n*/g;

/** Задача запуска из его отчёта для «Взять задачу»: без блоков тегов задач старых запусков, как в сводке запуска. */
export const taskInput = (raw: string): string => raw.replace(TAG_BLOCKS_RE, '').trim();

export type PlanStep = { n: number; title: string; note?: string; asks: boolean };
export type PlanBlock = { n: number; name: string; title: string; meta: string; asks: boolean };
export type RunPlan = {
  /** «4 этапа по кругу, до 8 раз», «6 блоков по очереди, 17 этапов». */
  head: string;
  multi: boolean;
  /** Один блок: его этапы. */
  steps: PlanStep[];
  /** Несколько блоков: блоки по строке. */
  blocks: PlanBlock[];
  /** «Спросит тебя»: где; пусто — сам, без вопросов. */
  asks: string;
  /** «Закончит». */
  ends: string;
  /** «Оставит»: файлы артефактов; пусто — строки нет. */
  leaves: string;
  /** Блоки под «Показать все» (номера с 1); пусто — все видны. */
  folded: number[];
};

const word = (n: number, one: string, few: string, many: string) => `${n} ${plural(n, one, few, many)}`;
/** После «до», «после», «не больше»: «до 1 раза», «до 3 раз». */
const times = (n: number) => word(n, 'раза', 'раз', 'раз');
const phasesWord = (n: number) => word(n, 'этап', 'этапа', 'этапов');
const quote = (s: string) => `«${s}»`;

const phaseTitle = (p: EditPhase) => p.title?.trim() || p.name;
const blockTitle = (b: EditBlock, i: number) => b.title?.trim() || (b.flow ? t('Вызов flow {name}', { name: b.flow }) : b.name === 'main' ? t('Блок {n}', { n: i + 1 }) : b.name);
const asksUser = (p: EditPhase) => p.tools?.includes('AskUserQuestion') ?? false;
/** Блок может остановиться и спросить человека: этап с вопросом или пауза по маркеру. */
const blockAsks = (b: EditBlock) => Boolean(b.loop?.pause_marker) || b.phases.some(asksUser);

/** Условие конца цикла словами человека: когда цикл остановится сам. */
export function untilText(u: EditUntil | undefined, max: number): string {
  switch (u?.type) {
    case 'judge': return t('когда проверка скажет «готово», но не больше {n}', { n: times(max) });
    case 'command': return u.run ? t('когда пройдёт команда {run}, но не больше {n}', { run: `\`${u.run}\``, n: times(max) }) : t('после {n}', { n: times(max) });
    case 'marker': return t('когда этап напишет {marker}, но не больше {n}', { marker: u.marker || '<DONE>', n: times(max) });
    default: return t('после {n}', { n: times(max) });
  }
}

/** Подпись блока в строке: «3 этапа · до 12 раз», «вызывает flow review», «1 этап». */
function blockMeta(b: EditBlock): string {
  const loop = b.loop ? t('до {n}', { n: times(b.loop.max_iterations) }) : '';
  if (b.flow !== undefined) return [t('вызывает flow {name}', { name: b.flow || '?' }), loop].filter(Boolean).join(' · ');
  return [phasesWord(b.phases.length), loop].filter(Boolean).join(' · ');
}

/** Файлы, которые flow оставит: артефакты запуска по ключу (файл или <ключ>.md), больше трёх — «и ещё N». */
function leavesText(spec: EditSpec): string {
  const files = Object.entries(spec.artifacts ?? {}).map(([k, a]) => a.file || `${k}.md`);
  if (!files.length) return '';
  if (files.length <= 3) return files.join(', ');
  return t('{files} и ещё {n}', { files: files.slice(0, 2).join(', '), n: files.length - 2 });
}

/** «Что произойдёт» по сохранённому flow (полная форма — toEditable). */
export function runPlan(spec: EditSpec): RunPlan {
  const blocks = spec.blocks;
  const leaves = leavesText(spec);
  if (blocks.length === 1) {
    const b = blocks[0]!;
    const steps = b.phases.map((p, i): PlanStep => {
      const asks = asksUser(p);
      const mates = p.group ? b.phases.map((q, j) => (q.group === p.group && j !== i ? j + 1 : 0)).filter(Boolean) : [];
      const note = asks ? t('может остановиться и спросить тебя') : mates.length ? t('одновременно с этапом {n}', { n: mates.join(', ') }) : undefined;
      return { n: i + 1, title: phaseTitle(p), asks, ...(note ? { note } : {}) };
    });
    const call = b.flow !== undefined;
    const count = call ? t('вызов flow {name}', { name: b.flow || '?' }) : phasesWord(b.phases.length);
    const head = b.loop ? t('{count} по кругу, до {n}', { count, n: times(b.loop.max_iterations) }) : t('{count}, один проход', { count });
    const askAt = b.phases.filter(asksUser).map((p) => quote(phaseTitle(p)));
    const asks = askAt.length
      ? t('на этапе {where}', { where: askAt.join(', ') })
      : b.loop?.pause_marker ? t('когда понадобится твоё решение — встанет на паузу') : '';
    const ends = b.loop ? untilText(b.loop.until, b.loop.max_iterations) : t('после одного прохода');
    return { head, multi: false, steps, blocks: [], asks, ends, leaves, folded: [] };
  }
  const list = blocks.map((b, i): PlanBlock => ({ n: i + 1, name: b.name, title: blockTitle(b, i), meta: blockMeta(b), asks: blockAsks(b) }));
  const phaseCount = blocks.reduce((n, b) => n + b.phases.length, 0);
  const head = t('{blocks} по очереди, {phases}', { blocks: word(blocks.length, 'блок', 'блока', 'блоков'), phases: phasesWord(phaseCount) });
  const askBlocks = list.filter((b) => b.asks);
  // имена — пока их не больше двух; дальше строка была бы длиннее самого списка блоков, где они и так отмечены
  const asks = !askBlocks.length
    ? ''
    : askBlocks.length === 1
      ? t('в блоке {block}', { block: quote(askBlocks[0]!.title) })
      : askBlocks.length === 2
        ? t('в блоках {a} и {b}', { a: quote(askBlocks[0]!.title), b: quote(askBlocks[1]!.title) })
        : askBlocks.length === list.length
          ? t('в каждом блоке')
          : t('в {n} из {of} — отмечены ниже', { n: word(askBlocks.length, 'блоке', 'блоках', 'блоках'), of: list.length });
  const last = blocks.at(-1)!;
  const lastTitle = quote(list.at(-1)!.title);
  const ends = last.loop
    ? t('после блока {block}: {until}', { block: lastTitle, until: untilText(last.loop.until, last.loop.max_iterations) })
    : t('после блока {block}', { block: lastTitle });
  const folded = blocks.length > PLAN_FOLD ? list.filter((b) => b.n > PLAN_HEAD && !b.asks).map((b) => b.n) : [];
  return { head, multi: true, steps: [], blocks: list, asks, ends, leaves, folded };
}

/** Повторы в строке «Модель и лимиты»: один блок — его лимит или заданный; несколько — «у каждого блока свои, от N до M». */
export function repeatsText(spec: EditSpec, override: string): string {
  const own = Number(override);
  const loops = spec.blocks.filter((b) => b.loop).map((b) => b.loop!.max_iterations);
  if (!loops.length) return t('без повторов');
  if (override.trim() && own > 0) return spec.blocks.length > 1 ? t('у каждого блока не больше {n}', { n: times(own) }) : t('до {n}', { n: times(own) });
  if (spec.blocks.length === 1) return t('до {n}', { n: times(loops[0]!) });
  const lo = Math.min(...loops);
  const hi = Math.max(...loops);
  return lo === hi ? t('у каждого блока до {n}', { n: times(hi) }) : t('у каждого блока свои, от {lo} до {hi}', { lo, hi });
}

/** Где встал запуск, словами: «Упал в блоке 4 «Матрица», этап «Закрыть пробелы»», «Дошёл до блока 4 из 6», «Упал на этапе «Поиск»». */
export function stopText(status: string, stop: FlowRunStop | undefined): string {
  if (!stop) return '';
  const multi = stop.blocks > 1;
  if (status === 'failed') {
    if (multi) return stop.phase ? t('Упал в блоке {n}, этап {phase}', { n: stop.block, phase: quote(stop.phase) }) : t('Упал в блоке {n} {block}', { n: stop.block, block: quote(stop.blockTitle) });
    return stop.phase ? t('Упал на этапе {phase}', { phase: quote(stop.phase) }) : '';
  }
  if (status === 'max_iterations') return multi ? t('Кончились повторы в блоке {n} {block}', { n: stop.block, block: quote(stop.blockTitle) }) : t('Кончились повторы');
  if (status === 'budget_exceeded') return multi ? t('Упёрся в лимит денег в блоке {n} из {of}', { n: stop.block, of: stop.blocks }) : t('Упёрся в лимит денег');
  return multi ? t('Дошёл до блока {n} из {of}', { n: stop.block, of: stop.blocks }) : '';
}

/** Задача запуска одной строкой: имя от модели, иначе первая непустая строка задачи; пусто — «без задачи». */
export const runTask = (r: Pick<FlowRunRow, 'title' | 'input'>): string =>
  r.title?.trim() || r.input.split('\n').map((s) => s.trim()).find(Boolean) || t('без задачи');

/** «В прошлый раз»: последний законченный запуск — цена и чем кончился. Запусков нет — пусто. */
export function lastTime(runs: FlowRunRow[] | undefined): { cost: string; note: string } | null {
  const r = runs?.find((x) => !LIVE.has(x.status));
  if (!r) return null;
  if (r.status === 'done') return { cost: usd(r.costUsd), note: t('за готовый запуск') };
  const where = r.stop && r.stop.blocks > 1 ? t('до блока {n}', { n: r.stop.block }) : '';
  return { cost: usd(r.costUsd), note: [statusLabel(r.status), where].filter(Boolean).join(', ') };
}

/** Кнопка продолжения у прошлого запуска: «Продолжить с блока 4»; у одного блока — «Продолжить»; нельзя — пусто. */
export function continueLabel(r: Pick<FlowRunRow, 'continueAt' | 'stop'>): string {
  if (!r.continueAt) return '';
  return (r.stop?.blocks ?? 1) > 1 ? t('Продолжить с блока {n}', { n: r.continueAt }) : t('Продолжить');
}
