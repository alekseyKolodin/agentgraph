// Связка flow: блок-вызов (flow: <имя>) — дочерний запуск другого flow, next — развилка после блока.
// Чистые функции: граф вызовов, задача вызываемого flow, выбор следующего блока, итог вызова. Внешнее (загрузка flow,
// проверка условия, сам дочерний запуск) приходит параметрами — раннер и сервер зовут их в своих точках входа.
import { flowBlocks, isCallBlock, NEXT_END, nextRules, type Block, type FlowSpec, type NextRule } from './schema.js';
import { referencedPhases, render, type TemplateContext } from './template.js';
import type { RunReport } from './api-types.js';

/**
 * Пока раннер не исполняет вызовы и развилку, запуск такого flow отклоняется: иначе блок-вызов прошёл бы как сессия
 * с задачей вызова вместо вызываемого flow, а next молча пропустился бы. Уйдёт вместе с подключением в раннер.
 */
export function assertRunnable(spec: FlowSpec): void {
  const blocks = flowBlocks(spec);
  const calls = blocks.filter(isCallBlock).map((b) => b.name);
  const branching = blocks.filter((b) => b.next !== undefined).map((b) => b.name);
  if (!calls.length && !branching.length) return;
  const what = [calls.length ? `вызов flow (блоки ${calls.join(', ')})` : '', branching.length ? `развилку next (блоки ${branching.join(', ')})` : ''].filter(Boolean).join(' и ');
  throw new Error(`Flow ${spec.name} нельзя запустить: раннер пока не исполняет ${what}`);
}

/** Глубина вызовов: flow → вызванный → его вызванный. Глубже — ошибка до старта. */
export const CALL_DEPTH_MAX = 3;

/** Имена flow, которые spec вызывает напрямую, по порядку блоков, без повторов. */
export function calledFlows(spec: FlowSpec): string[] {
  return [...new Set(flowBlocks(spec).filter(isCallBlock).map((b) => b.flow))];
}

/**
 * Граф вызовов от spec: каждый вызываемый flow есть и валиден, вызовы не замыкаются в круг (A → B → A),
 * цепочка не глубже CALL_DEPTH_MAX. load бросает, если flow нет или он невалиден. Пустой список — всё в порядке.
 */
export function callProblems(spec: FlowSpec, load: (name: string) => FlowSpec): string[] {
  const problems: string[] = [];
  const cache = new Map<string, FlowSpec | Error>();
  const get = (name: string): FlowSpec | Error => {
    if (!cache.has(name)) {
      try {
        cache.set(name, load(name));
      } catch (err) {
        cache.set(name, err instanceof Error ? err : new Error(String(err)));
      }
    }
    return cache.get(name)!;
  };
  const reported = new Set<string>();
  const once = (key: string, text: string) => {
    if (reported.has(key)) return;
    reported.add(key);
    problems.push(text);
  };
  const walk = (from: FlowSpec, chain: string[]) => {
    for (const b of flowBlocks(from).filter(isCallBlock)) {
      const path = [...chain, b.flow];
      const where = chain.length > 1 ? `${chain.join(' → ')}, блок ${b.name}` : `блок ${b.name}`;
      if (chain.includes(b.flow)) {
        once(`loop:${path.join('>')}`, `${where}: вызовы замыкаются в круг ${path.join(' → ')}`);
        continue;
      }
      const callee = get(b.flow);
      if (callee instanceof Error) {
        once(`load:${b.flow}`, `${where}: flow ${b.flow} не загружается: ${callee.message}`);
        continue;
      }
      if (path.length - 1 > CALL_DEPTH_MAX) {
        once(`depth:${path.join('>')}`, `${where}: вызовы глубже ${CALL_DEPTH_MAX} уровней (${path.join(' → ')})`);
        continue;
      }
      walk(callee, path);
    }
  };
  walk(spec, [spec.name]);
  return problems;
}

/**
 * Ссылки судей развилки: {{phases.X}} — этап этого или более раннего блока (next проверяется после блока,
 * этапы следующих ещё не выполнялись). Остальное про next проверяет схема (blockIssues в schema.ts).
 */
export function nextProblems(spec: FlowSpec): string[] {
  const blocks = flowBlocks(spec);
  const blockOf = new Map<string, number>();
  blocks.forEach((b, bi) => b.phases.forEach((p) => blockOf.set(p.name, bi)));
  const problems: string[] = [];
  blocks.forEach((b, bi) => {
    nextRules(b).forEach((r, k) => {
      if (r.if?.type !== 'judge') return;
      for (const ref of referencedPhases(r.if.prompt)) {
        const at = blockOf.get(ref);
        const where = `блок ${b.name}, next[${k}] судья`;
        if (at === undefined) problems.push(`${where}: неизвестный этап {{phases.${ref}}}`);
        else if (at > bi) problems.push(`${where}: {{phases.${ref}}} — этап из следующего блока ${blocks[at].name}, к этому моменту он ещё не выполнялся`);
      }
    });
  });
  return problems;
}

/**
 * Задача вызываемого flow на итерации блока-вызова: шаблон input с переменными этапа или, без него,
 * задача запуска, итог прошлого шага и замечания проверки — пустые разделы не пишутся.
 */
export function callInput(block: Pick<Block, 'input'>, ctx: TemplateContext): string {
  if (block.input !== undefined) return render(block.input, ctx);
  const parts = [ctx.input];
  if (ctx.prev.trim()) parts.push(`## Результат предыдущего шага\n${ctx.prev}`);
  if (ctx.feedback.trim()) parts.push(`## Замечания проверки\n${ctx.feedback}`);
  return parts.join('\n\n');
}

/** Куда ведёт правило: индекс блока, blocks.length — конец запуска. */
export function nextTarget(blocks: Pick<Block, 'name'>[], rule: Pick<NextRule, 'goto'>): number {
  return rule.goto === NEXT_END ? blocks.length : blocks.findIndex((b) => b.name === rule.goto);
}

/** Выбор после блока: to — индекс следующего блока (blocks.length — конец), rule — номер сработавшего правила next. */
export type NextChoice = { to: number; rule?: number };

/**
 * Следующий блок после блока bi: правила next по порядку, первое выполненное решает; правило без if выполнено всегда.
 * check проверяет условие правила (marker, command или judge, как until) и зовётся только для правил с if.
 * Ни одно не выполнилось или next нет — следующий блок по порядку.
 */
export async function pickNext(
  blocks: Block[],
  bi: number,
  check: (cond: NonNullable<NextRule['if']>, rule: number) => Promise<boolean>,
): Promise<NextChoice> {
  const rules = nextRules(blocks[bi]);
  for (const [k, r] of rules.entries()) {
    if (!r.if || (await check(r.if, k))) return { to: nextTarget(blocks, r), rule: k };
  }
  return { to: bi + 1 };
}

/** Блоки, через которые перешли с from на to: не выполняются. */
export function bypassedBlocks(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from + 1; i < to; i++) out.push(i);
  return out;
}

/** Итог вызова для родителя — в той же форме, что результат сессии этапа (SessionResult). */
export type CallOutcome = { ok: boolean; subtype: string; text: string; costUsd: number; turns: number; durationMs: number; errors: string[] };

/**
 * Итог дочернего запуска как результат этапа-вызова: успех — только done; текст — выводы его последнего шага
 * (у группы — склейка «### этап», как {{prev}} после группы). read читает вывод по пути относительно папки дочернего.
 */
export function callOutcome(
  flow: string,
  child: Pick<RunReport, 'id' | 'status' | 'error' | 'final' | 'totalCostUsd'>,
  read: (rel: string) => string | undefined,
  durationMs: number,
): CallOutcome {
  const outs = (child.final ?? []).map((f) => ({ phase: f.phase, output: read(f.output) ?? '' }));
  const text = outs.length === 1 ? outs[0].output : outs.map((o) => `### ${o.phase}\n${o.output}`).join('\n\n');
  const ok = child.status === 'done';
  const errors = ok ? [] : [`Вызванный flow ${flow} завершился статусом ${child.status} (запуск ${child.id})${child.error ? `: ${child.error}` : ''}`];
  return { ok, subtype: child.status, text, costUsd: child.totalCostUsd, turns: 0, durationMs, errors };
}

/** Правила next блока для людей: «маркер <BUG> → fix; иначе → build». Пусто — next нет. */
export function describeNext(block: Pick<Block, 'next'>): string {
  const rules = nextRules(block);
  const to = (goto: string) => (goto === NEXT_END ? 'конец' : goto);
  return rules
    .map((r) => {
      if (!r.if) return rules.length > 1 ? `иначе → ${to(r.goto)}` : `→ ${to(r.goto)}`;
      const cond = r.if.type === 'marker' ? `маркер ${r.if.marker}` : r.if.type === 'command' ? `команда \`${r.if.run.replace(/\s+/g, ' ').trim()}\`` : 'судья';
      return `${cond} → ${to(r.goto)}`;
    })
    .join('; ');
}
