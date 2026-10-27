// «Починить и продолжить»: правка flow идущего запуска на паузе. Чистые функции без fs и сервера: что поменять нельзя
// (flowEditProblems) и что поменялось (flowChanges). Раннер зовёт их в остановленной контрольной точке, а директории,
// плагины и теги знаний новой версии проверяет сам — теми же функциями, что на старте.
import { parseDocument } from 'yaml';
import { flowBlocks, MAIN_BLOCK, type Block, type FlowSpec } from './schema.js';

/** Где стоит запуск: block — индекс идущего блока (все до него завершены), iterations — сколько итераций он начал. */
export type FixPoint = {
  block: number;
  iterations: number;
  /** Лимит итераций блока по flow (blockMaxIterations с --max-iterations запуска). */
  limit: (b: Block) => number;
};

/**
 * Правку или повтор итерации применить нельзя; запуск при этом не меняется. code — для клиента: not_paused — раннер не
 * стоит в контрольной точке, incompatible — правка не подходит идущему запуску (problems), not_started — у блока ещё нет
 * итераций, limit — лимит итераций уже максимальный, restarted — итерацию уже перезапустили на этой паузе.
 */
export class RunFixError extends Error {
  constructor(
    message: string,
    readonly code: 'not_paused' | 'incompatible' | 'not_started' | 'limit' | 'restarted',
    readonly problems?: string[],
  ) {
    super(message);
  }
}

/** Пометка синтетической проверки условия у итерации, оборванной повтором (detail в ConditionReport). */
export const RESTART_DETAIL = 'перезапущено пользователем';

/** JSON с ключами по алфавиту и без undefined: одинаковые flow из разного YAML дают одну строку. */
export function canon(v: unknown): string {
  return JSON.stringify(v ?? null, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

/**
 * Что мешает идущему запуску перейти на next с prev. Можно менять всё, что ещё впереди: этапы и условие идущего блока,
 * будущие блоки, defaults. Нельзя — имя, задачу (для неё есть указание), объявления артефактов (хранилище уже создано),
 * раскладку логов (один блок или несколько), пройденные блоки и место идущего блока.
 */
export function flowEditProblems(prev: FlowSpec, next: FlowSpec, at: FixPoint): string[] {
  const out: string[] = [];
  if (next.name !== prev.name) out.push(`name: у запуска flow ${prev.name} — правка не может сменить имя`);
  if ((next.input ?? '') !== (prev.input ?? '')) out.push('input: задача запуска правкой flow не меняется — дай указание');
  if (canon(next.artifacts ?? {}) !== canon(prev.artifacts ?? {})) {
    out.push('artifacts: объявления артефактов идущего запуска не меняются — их хранилище уже создано');
  }
  const pb = flowBlocks(prev);
  const nb = flowBlocks(next);
  if (pb.length > 1 !== nb.length > 1) {
    out.push(pb.length > 1 ? `blocks: у запуска ${pb.length} блока — свести их в один на ходу нельзя` : 'blocks: у запуска один блок — добавить блоки на ходу нельзя');
  }
  for (let i = 0; i < Math.min(at.block, pb.length); i++) {
    const was = pb[i];
    if (nb[i]?.name !== was.name) out.push(`блок ${was.name} уже пройден: убрать или переставить его нельзя`);
    else if (canon(nb[i]) !== canon(was)) out.push(`блок ${was.name} уже пройден: менять его нельзя`);
  }
  const cur = pb[at.block];
  const now = nb[at.block];
  if (cur && now?.name !== cur.name) out.push(`блок ${cur.name} идёт сейчас: он должен остаться ${at.block + 1}-м`);
  else if (cur && now) {
    const was = at.limit(cur);
    const will = at.limit(now);
    if (will !== was && will < at.iterations) out.push(`блок ${cur.name} уже на итерации ${at.iterations}: лимит ${will} меньше`);
  }
  return out;
}

/**
 * Правка из YAML (draftSpec) приходит в короткой форме, если блок один: имя блока при этом теряется и стало бы main.
 * У запуска с одним именованным блоком возвращаем правке полную форму с его именем — иначе события пошли бы под чужим блоком.
 */
export function keepBlockName(prev: FlowSpec, next: FlowSpec): FlowSpec {
  const pb = flowBlocks(prev);
  if (next.blocks || pb.length !== 1 || pb[0].name === MAIN_BLOCK) return next;
  const { loop, phases, ...rest } = next;
  return { ...rest, blocks: [{ name: pb[0].name, ...(loop ? { loop } : {}), phases: phases ?? [] }] };
}

/** Поля, которые flowChanges сравнивает отдельно (блоки и этапы) или которые не меняются (flowEditProblems). */
const SPEC_SKIP = new Set(['name', 'input', 'artifacts', 'blocks', 'phases', 'loop']);

/**
 * Что поменялось от prev к next, по строке на изменение: «этап review: prompt, model», «+ этап lint», «− блок deploy»,
 * «блок main: loop», «defaults». Пустой список — версии одинаковые.
 */
export function flowChanges(prev: FlowSpec, next: FlowSpec): string[] {
  const out: string[] = [];
  const keys = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diff = (a: object, b: object, skip: Set<string>) =>
    keys(a, b).filter((k) => !skip.has(k) && canon((a as Record<string, unknown>)[k]) !== canon((b as Record<string, unknown>)[k]));
  out.push(...diff(prev, next, SPEC_SKIP));

  const pb = flowBlocks(prev);
  const nb = flowBlocks(next);
  const pbm = new Map(pb.map((b) => [b.name, b]));
  const nbm = new Map(nb.map((b) => [b.name, b]));
  const common = (list: Block[], other: Map<string, Block>) => list.filter((b) => other.has(b.name)).map((b) => b.name);
  if (canon(common(pb, nbm)) !== canon(common(nb, pbm))) out.push('порядок блоков');
  for (const b of pb) if (!nbm.has(b.name)) out.push(`− блок ${b.name}`);
  for (const b of nb) if (!pbm.has(b.name)) out.push(`+ блок ${b.name}`);

  // имена этапов уникальны во всём flow: этап, перенесённый в другой блок, — тот же этап
  const phases = (list: Block[]) => new Map(list.flatMap((b) => b.phases.map((p) => [p.name, p] as const)));
  const pp = phases(pb);
  const np = phases(nb);
  for (const b of nb) {
    const was = pbm.get(b.name);
    if (!was) continue;
    const fields = diff(was, b, new Set(['phases']));
    if (fields.length) out.push(`блок ${b.name}: ${fields.join(', ')}`);
    const order = (blk: Block, other: Block) => blk.phases.filter((p) => other.phases.some((q) => q.name === p.name)).map((p) => p.name);
    if (canon(order(was, b)) !== canon(order(b, was))) out.push(`блок ${b.name}: порядок этапов`);
  }
  for (const [name] of pp) if (!np.has(name)) out.push(`− этап ${name}`);
  for (const [name, p] of np) {
    const was = pp.get(name);
    if (!was) out.push(`+ этап ${name}`);
    else {
      const fields = diff(was, p, new Set());
      if (fields.length) out.push(`этап ${name}: ${fields.join(', ')}`);
    }
  }
  return out;
}

/**
 * YAML правки для flows/: тот же текст (комментарии и порядок ключей сохраняются), но input — как у flow в flows/
 * (base; нет — без input). В снимке запуска input — задача этого запуска, в flows/ ей не место.
 */
export function withFlowInput(yamlText: string, base: string | undefined): string {
  const doc = parseDocument(yamlText);
  if (base === undefined) doc.delete('input');
  else doc.set('input', base);
  return doc.toString({ lineWidth: 0 });
}
