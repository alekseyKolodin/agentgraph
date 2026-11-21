// Оркестрация из сессии терминала: инструменты flow_guide, flow_run, flow_status, flow_answer, flow_stop MCP-сервера
// сессии (sessions-mcp.ts). Запуск — тот же startRun, что у формы, с пометкой session в run.json: «Сейчас» показывает
// его под сессией, а сессия видит и трогает только свои запуски (и вызванные ими). Сервер даёт функции через deps.
// Оркестратор работает сам: flow_run без вопроса, без бюджета по умолчанию и без лимита запусков (решение владельца
// 21.11 — следить за ним человек не должен). Ответ flow_run — сводка того, что запущено (describeRun). Разовый YAML не
// задаёт права, лишние папки и плагины, а запуск не идёт в папках данных agentgraph (server.ts → prepareSessionRun):
// текст с инъекцией не должен дать сессии этап с полными правами.
import os from 'node:os';
import path from 'node:path';
import type { AskAnswers, FlowSummary, RunSummary } from './api-types.js';
import { statusLine, statusReport, type RunView } from './chat.js';
import { DESIGN_RULES, ORCHESTRATOR_RULES } from './generate.js';
import { flowBlocks, type FlowSpec } from './schema.js';
import type { FlowAnswerArgs, FlowRunArgs, FlowStatusArgs, SessionFlowsCtx } from './sessions-mcp.js';

/**
 * Что известно о сессии на момент вызова: пространство и теги выбирают на ходу; appUrl — адрес сервера agentgraph
 * (http://127.0.0.1:<порт>): ссылки на запуски и flow в ответах — на него, терминал сессии откроет их внутри приложения.
 */
export type FlowSessionRef = { id: string; name: () => string; cwd: () => string; space: () => string | undefined; tags: () => string[]; appUrl?: () => string };

/** Markdown-ссылка для пользователя на экран приложения; без адреса сервера — просто имя. */
export function appLink(ref: Pick<FlowSessionRef, 'appUrl'>, label: string, path: string): string {
  const base = ref.appUrl?.();
  return base ? `[${label.replace(/[[\]]/g, '')}](${base}${path})` : label;
}

/** Как называть запуск или flow пользователю: ссылкой с именем, не голым адресом. */
const LINK_NOTE = 'Пользователю называй его этой ссылкой (или id запуска): терминал agentgraph откроет экран внутри приложения; голый адрес не пиши.';

/** Что передаётся серверу для старта: flow или yaml и опции запуска от сессии. */
export type SessionRunStart = {
  flow?: string;
  yaml?: string;
  input: string;
  cwd: string;
  model?: string;
  budget?: number;
  space?: string;
  tags: string[];
  session: string;
};

/** Проверенный запуск: flow, разовый ли он и опции; prepare и start получают одно и то же. */
export type PreparedRun = { spec: FlowSpec; adhoc: boolean; o: SessionRunStart };

export type SessionFlowsDeps = {
  /**
   * Проверки до старта (flow или YAML по схеме, папка — не папка данных agentgraph, теги — как у POST /api/runs), без
   * эффектов. Ошибка — исключением с текстом.
   */
  prepare: (o: SessionRunStart) => PreparedRun;
  /** Старт проверенного запуска; ответ — id. */
  start: (p: PreparedRun) => string;
  view: (id: string) => RunView | undefined;
  /** Чей запуск: id сессии из run.json — у дочернего запуска блока-вызова — его родителя (по цепочке). */
  ownerOf: (id: string) => string | undefined;
  /** Все запуски (как GET /api/runs, с session и parent) — для списка запусков сессии. */
  list: () => RunSummary[];
  answer: (id: string, questionId: string, answers: AskAnswers) => void;
  abort: (id: string) => void;
  flows: () => FlowSummary[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

/** Готовых flow в flow_guide не больше: обзор, а не выгрузка. */
const GUIDE_FLOWS_MAX = 40;
const LIVE = ['running', 'waiting', 'paused'];

/** Пример разового flow в flow_guide: проходит схему (session-flows.test.ts). */
export const FLOW_EXAMPLE = `name: fix-and-review
description: "Правка до зелёных тестов, затем независимое ревью"
input: задача — её заменит input вызова flow_run
blocks:
  - name: fix
    title: Правка до зелёных тестов
    loop:
      max_iterations: 4
      until:
        type: command
        run: npm test
    phases:
      - name: work
        title: Правка
        tools: [Read, Edit, Write, Grep, Glob, Bash]
        prompt: |
          Задача: {{input}}

          Если ниже есть замечания с прошлой итерации, начни с них: {{feedback}}
        handoff: 'раздел "## Итог" — что изменено (файлы), что проверено'
  - name: review
    title: Независимое ревью
    phases:
      - name: review
        title: Ревью
        tools: [Read, Grep, Glob, Bash]
        prompt: |
          Задача: {{input}}

          Что сделано: {{phases.work}}

          Проверь изменения против задачи: корректность, крайние случаи, тесты. Ничего не правь.
        handoff: список замечаний по серьёзности или «замечаний нет»`;

/** Текст flow_guide: как оркестратор исполняет flow, правила проектирования, пример YAML и готовые flow. */
export function flowGuideText(flows: FlowSummary[]): string {
  const ok = flows.filter((f) => f.valid);
  const list = ok.slice(0, GUIDE_FLOWS_MAX).map((f) => `- ${f.name}${f.description ? ` — ${f.description.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
  return [
    '# Как собрать flow agentgraph',
    'flow_run принимает готовый flow по имени (flow) или разовый YAML (yaml). Разовый не попадает в библиотеку; поле input в YAML можно не заполнять — его заменит input вызова. Агенты этапов не видят твой разговор: всё нужное — в input и промптах.',
    ORCHESTRATOR_RULES,
    '## Правила проектирования',
    DESIGN_RULES,
    '## Пример YAML',
    `\`\`\`yaml\n${FLOW_EXAMPLE}\n\`\`\``,
    '## Готовые flow',
    list.length ? list.join('\n') + (ok.length > list.length ? `\n…и ещё ${ok.length - list.length}` : '') : 'Готовых flow нет — собери разовый.',
  ].join('\n\n');
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** Строка запуска в списке flow_status без run. */
function summaryLine(r: RunSummary, ref: Pick<FlowSessionRef, 'appUrl'>): string {
  return `${r.id} — ${appLink(ref, r.title || `flow ${r.flow}`, `/run/${r.id}`)}${r.title ? ` (flow ${r.flow})` : ''} — ${r.status} — ${money(r.totalCostUsd)} — начат ${r.startedAt}`;
}

/**
 * Что разовый flow от сессии задавать не может: права без вопросов (permission_mode), лишние папки (add_dirs) и
 * плагины — их пользователь не видит в вопросе, а этап получил бы их без подтверждения (как и у генератора: tidyGenerated).
 */
export function sessionSpecProblems(spec: FlowSpec): string[] {
  const out: string[] = [];
  if (spec.defaults?.permission_mode) out.push('defaults.permission_mode');
  for (const b of flowBlocks(spec)) {
    if (b.plugins?.length) out.push(`блок ${b.name}: plugins`);
    for (const p of b.phases ?? []) {
      if (p.permission_mode) out.push(`этап ${p.name}: permission_mode`);
      if (p.add_dirs?.length) out.push(`этап ${p.name}: add_dirs`);
      if (p.plugins?.length) out.push(`этап ${p.name}: plugins`);
    }
  }
  return out;
}

const clipLine = (v: string, n: number) => {
  const one = v.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** Сводка запуска для ответа flow_run: что, где, с каким бюджетом, какие этапы с какими инструментами и проверки. */
export function describeRun(p: PreparedRun): string {
  const { spec, o } = p;
  const parts = [
    p.adhoc ? `разовый flow «${clipLine(spec.name, 60)}»` : `flow ${spec.name}`,
    `папка ${o.cwd}`,
    o.space ? `пространство ${o.space}` : 'без пространства',
    o.budget ? `бюджет до $${o.budget}` : 'без предела расхода',
    ...(o.model ? [`модель ${o.model}`] : []),
  ];
  const blocks = flowBlocks(spec).map((b) => {
    const phases = (b.phases ?? []).map((ph) => `${ph.name} [${(ph.tools ?? []).join(', ') || 'без инструментов'}]`).join(', ');
    const u = b.loop?.until;
    const check = u?.type === 'command' ? `; проверка: ${clipLine(u.run, 120)}` : u ? `; проверка: ${u.type}` : '';
    return `${b.name}${b.loop ? ` (до ${b.loop.max_iterations ?? '?'} итераций${check})` : ''}: ${phases}`;
  });
  return clipLine(`${parts.join('; ')}. Этапы: ${blocks.join(' → ')}. Задача: «${clipLine(o.input, 200)}»`, 1500);
}

/** Папка flow_run: абсолютная, ~ — домашняя, относительная — от папки сессии. */
export function runCwd(raw: string | undefined, sessionCwd: string): string {
  if (!raw) return sessionCwd;
  if (raw === '~' || raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(1));
  return path.resolve(sessionCwd, raw);
}

/** Чей запуск по списку запусков (session и parent из RunSummary): без чтения run.json. */
function ownerIn(byId: Map<string, RunSummary>, id: string): string | undefined {
  let r = byId.get(id);
  for (let depth = 0; r && depth < 20; depth++) {
    if (r.session) return r.session;
    r = r.parent ? byId.get(r.parent.runId) : undefined;
  }
  return undefined;
}

/** Состояние, по которому flow_status с ожиданием понимает, что что-то изменилось. */
const mark = (v: RunView) => `${v.status}|${v.pending.map((q) => q.id).join(',')}|${v.report.phases.length}|${v.report.pause ?? ''}`;

export function sessionFlowsCtx(ref: FlowSessionRef, deps: SessionFlowsDeps): SessionFlowsCtx {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  // читать можно любой запуск (его могли дать сессии кнопкой «Для сессии»), отвечать и останавливать — только свои
  const any = (id: string): RunView => {
    const v = deps.view(id);
    if (!v) throw new Error(`Запуска ${id} нет: flow_status без run покажет запуски этой сессии`);
    return v;
  };
  const mine = (id: string): RunView => {
    const v = any(id);
    if (deps.ownerOf(id) !== ref.id) throw new Error(`Запуск ${id} начат не этой сессией: отвечать его агентам и останавливать его может пользователь — на странице запуска`);
    return v;
  };
  const report = (v: RunView) =>
    `${statusLine(v, now())}\nСсылка: ${appLink(ref, v.report.title || `flow ${v.report.flow}`, `/run/${v.report.id}`)}\n${JSON.stringify(statusReport(v), null, 1)}`;
  const prepare = (a: FlowRunArgs): PreparedRun => {
    const space = ref.space();
    const p = deps.prepare({
      ...(a.flow ? { flow: a.flow } : {}),
      ...(a.yaml ? { yaml: a.yaml } : {}),
      input: a.input,
      cwd: runCwd(a.cwd, ref.cwd()),
      ...(a.model ? { model: a.model } : {}),
      ...(a.budget ? { budget: a.budget } : {}),
      ...(space ? { space } : {}),
      tags: ref.tags(),
      session: ref.id,
    });
    const problems = p.adhoc ? sessionSpecProblems(p.spec) : [];
    if (problems.length) throw new Error(`Разовый flow от сессии не задаёт права, лишние папки и плагины (${problems.join(', ')}): убери эти поля — этапы работают в папке запуска с инструментами из tools`);
    return p;
  };
  return {
    guide: () => flowGuideText(deps.flows()),
    run: async (a: FlowRunArgs) => {
      const p = prepare(a);
      const id = deps.start(p);
      return `Запуск ${id} начат: ${describeRun(p)}\nСсылка: ${appLink(ref, p.spec.name, `/run/${id}`)} — ${LINK_NOTE}\nПользователь видит его под этой сессией. Дальше — flow_status с run: "${id}" (wait_seconds — подождать изменения).`;
    },
    status: async (a: FlowStatusArgs) => {
      if (!a.run) {
        const all = deps.list();
        const byId = new Map(all.map((r) => [r.id, r]));
        const runs = all.filter((r) => ownerIn(byId, r.id) === ref.id);
        if (!runs.length) return 'У этой сессии запусков flow нет.';
        return [`Запуски этой сессии (${runs.length}), новые сверху:`, ...runs.slice(0, 30).map((r) => summaryLine(r, ref))].join('\n');
      }
      let v = any(a.run);
      if (a.wait && v.live && LIVE.includes(v.status)) {
        // ждём перемены: конец, пауза, новый вопрос или законченный этап — раз в секунду, не дольше wait
        const before = mark(v);
        const until = Date.now() + a.wait * 1000;
        while (Date.now() < until) {
          await sleep(1000);
          v = any(a.run);
          if (mark(v) !== before || !v.live) break;
        }
      }
      return report(v);
    },
    answer: (a: FlowAnswerArgs) => {
      const v = mine(a.run);
      const q = v.pending.find((x) => x.id === a.question);
      if (!q) throw new Error(`Вопроса ${a.question} у запуска ${a.run} нет или на него уже ответили: смотри pendingQuestions в flow_status`);
      deps.answer(a.run, a.question, a.answers);
      return `Ответ отправлен агенту этапа «${q.title || q.phase}» запуска ${a.run}.`;
    },
    stop: (run: string) => {
      const v = mine(run);
      if (!v.live) return `Запуск ${run} уже не идёт (${v.status}).`;
      deps.abort(run);
      return `Запуск ${run} остановлен.`;
    },
  };
}

/** Новость о запуске сессии для модели: конец, вопрос агента или пауза. */
export function runNoteText(
  e:
    | { type: 'end'; id: string; title: string; status: string; costUsd: number; error?: string }
    | { type: 'question'; id: string; title: string; phase: string; questions: string[] }
    | { type: 'pause'; id: string; title: string; phase?: string },
): string {
  if (e.type === 'pause') return `Запуск ${e.id} («${e.title}») встал на паузу${e.phase ? ` по просьбе этапа «${e.phase}»` : ''} и ждёт человека на странице запуска — скажи пользователю.`;
  if (e.type === 'question') return `Запуск ${e.id} («${e.title}») ждёт ответа агента «${e.phase}»: ${e.questions.join(' · ')} — ответь flow_answer или спроси пользователя.`;
  return `Запуск ${e.id} («${e.title}») закончился: ${e.status}, ${money(e.costUsd)}${e.error ? `, ошибка: ${e.error}` : ''} — проверь результат (flow_status).`;
}
