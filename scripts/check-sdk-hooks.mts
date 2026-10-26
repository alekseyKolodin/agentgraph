// Проверка защиты артефактов на настоящей сессии Claude Code через Agent SDK — на продуктовом коде:
// buildRequest, artifactAccess, ArtifactStore.guard и sessionOptions те же, что у раннера.
// Прогоняй после каждого обновления Agent SDK:
//   npx tsx scripts/check-sdk-hooks.mts [--model claude-haiku-4-5-20251001] [--budget 5] [--only a,b] [--out папка]
// Сценарии: implicit (этап без своих инструментов: пути, ~, относительные, чужой артефакт, isolation, сабагент),
// modes (отказ хука при каждом permission_mode — переключением в одной сессии), explicit (Edit/Write в tools:
// папка запусков, чужой артефакт, правка по жёсткой ссылке), raw-throw (исключение в хуке без try/catch agent.ts),
// adddir (что грузится из доп. директории — по канарейкам в ответе модели), tools (инструмент чтения по ключу:
// карта файла 100 КБ, artifact_read у этапа с tools: [], сабагент, страница «Контекст»), example (flow с артефактами из CLI, стоимость).
// Каждая проверка засчитывается по двум доказательствам: попытка в логе хука (инструмент, путь, agent_id, режим) и
// состояние файлов на диске. Нет попытки — «не воспроизведено», а не «прошло». Несколько проверок идут в одной
// сессии: первые ходы Claude Code дорогие (запись кэша), последующие почти бесплатны.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { query, type HookCallback, type Options, type PermissionMode, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { sessionOptions } from '../src/agent.js';
import { artifactAccess, canonical, type Denial } from '../src/artifacts.js';
import { ArtifactStore, countDenial, nodeProbe } from '../src/artifact-store.js';
import { buildRequest, renderPhasePrompt } from '../src/runner.js';
import { ARTIFACT_TOOLS_ENABLED } from '../src/artifact-tools.js';
import { getContext } from '../src/context.js';
import { emptyContext } from '../src/template.js';
import type { FlowSpec, Phase } from '../src/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: 'claude-haiku-4-5-20251001' },
    budget: { type: 'string', default: '5' },
    only: { type: 'string' },
    modes: { type: 'string', default: 'default,acceptEdits,bypassPermissions,dontAsk,auto,plan' },
    out: { type: 'string' },
  },
});
const BUDGET = Number(args.budget);
/** Порог стоимости сценария example за прогон (AC-H6): flow на haiku 5.5, решение пользователя 2026-10-15. */
const EXAMPLE_COST_MAX = 2;
const only = args.only ? new Set(args.only.split(',')) : undefined;
const OUT = path.resolve(args.out ?? path.join(os.tmpdir(), `agentgraph-check-${new Date().toISOString().replace(/[:.]/g, '-')}`));
fs.mkdirSync(OUT, { recursive: true });

type Status = 'ok' | 'FAIL' | 'не воспроизведено' | 'факт';
type Result = { scenario: string; name: string; status: Status; detail: string };
/** Вызов инструмента глазами хуков: решение PreToolUse и исход (PostToolUse / PostToolUseFailure). */
type Call = {
  id: string;
  tool: string;
  /** Вход инструмента, как его получил хук. */
  input: Record<string, unknown>;
  /** Путь, как его написала модель в tool_use (до обработки Claude Code), если вызов из главной сессии. */
  raw?: unknown;
  agentId?: string;
  mode?: string;
  decision: string;
  reason?: string;
  outcome?: 'success' | 'failure';
  error?: string;
  /** Содержимое plan.md сразу после вызова (PostToolUse). */
  planAfter?: string;
};
const results: Result[] = [];
const costs: Record<string, number> = {};
let spent = 0;

// ---------- песочница: проект (git), папка запусков с запуском r1 и его артефактами

const box = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-sdkcheck-')));
const project = path.join(box, 'project');
const runsDir = path.join(box, 'runs');
const runDir = path.join(runsDir, 'r1');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(runDir, { recursive: true });
const CODE = path.join(project, 'code.ts');
const CODE_TEXT = 'export const value = "ORIGINAL";\n';
fs.writeFileSync(CODE, CODE_TEXT);
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=check@local', '-c', 'user.name=check', ...a], { cwd: project, stdio: 'ignore' });
git('init', '-q');
git('add', '.');
git('commit', '-qm', 'init');

const store = new ArtifactStore({
  runDir,
  declared: [
    { key: 'plan', title: 'План', file: 'plan.md', initial: 'PLAN-ORIGINAL\n', decisions: false },
    { key: 'notes', title: 'Заметки', file: 'notes.md', initial: 'NOTES-ORIGINAL\n', decisions: false },
    { key: 'big', title: 'Справочник', file: 'big.md', decisions: false },
  ],
  report: {},
  persist: () => {},
  readTool: ARTIFACT_TOOLS_ENABLED,
});
store.init();
const PLAN = path.join(store.dir, 'plan.md');
const NOTES = path.join(store.dir, 'notes.md');
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '<нет файла>');

/** Этап «пишет plan, читает notes»; по умолчанию без своих инструментов — неявные Read/Edit/Write. */
const phaseOf = (over: Partial<Phase> = {}): Phase => ({ name: 'check', prompt: '', tools: [], reads: ['notes'], writes: ['plan'], ...over });
const spec = { name: 'check', phases: [phaseOf()] } as unknown as FlowSpec;

/** Опции сессии этапа ровно как у раннера (buildRequest + guard хранилища + sessionOptions), хуки обёрнуты для лога. */
function phaseOptions(phase: Phase, calls: Call[], denials: Denial[], over: Partial<Options> = {}): Options {
  const access = artifactAccess(phase);
  const req = buildRequest(spec, phase, '', { cwd: project, runsDir, runDir, model: args.model }, { dir: store.dir, access, ...(ARTIFACT_TOOLS_ENABLED ? { sources: store.sources(access) } : {}) });
  const guard = store.guard(phase.tools, access, (tool, reason) => countDenial(denials, tool, reason));
  return instrument({ ...sessionOptions({ ...req, guard }), persistSession: false, maxBudgetUsd: 1, maxTurns: 30, ...over }, calls);
}

/** Оборачивает PreToolUse (решение) и добавляет PostToolUse/PostToolUseFailure (исход) — всё в лог calls. */
function instrument(options: Options, calls: Call[], pre?: HookCallback): Options {
  const inner = pre ?? options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  const before: HookCallback = async (input, id, ctx) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const call: Call = { id: input.tool_use_id, tool: input.tool_name, input: (input.tool_input ?? {}) as Record<string, unknown>, agentId: input.agent_id, mode: input.permission_mode, decision: 'allow' };
    calls.push(call);
    if (!inner) return {};
    let out;
    try {
      out = await inner(input, id, ctx);
    } catch (err) {
      call.decision = 'throw';
      throw err;
    }
    const s = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
    call.decision = s?.permissionDecision ?? 'allow';
    call.reason = s?.permissionDecisionReason;
    return out;
  };
  const after: HookCallback = async (input) => {
    const c = 'tool_use_id' in input ? calls.find((x) => x.id === input.tool_use_id) : undefined;
    if (c && input.hook_event_name === 'PostToolUse') {
      c.outcome = 'success';
      c.planAfter = read(PLAN);
    }
    if (c && input.hook_event_name === 'PostToolUseFailure') {
      c.outcome = 'failure';
      c.error = input.error;
    }
    return {};
  };
  return { ...options, hooks: { ...options.hooks, PreToolUse: [{ hooks: [before] }], PostToolUse: [{ hooks: [after] }], PostToolUseFailure: [{ hooks: [after] }] } };
}

type RunOut = { cost: number; text: string; init?: Extract<SDKMessage, { type: 'system'; subtype: 'init' }>; errors: string[] };
/** Аргументы tool_use, как их написала модель главной сессии: id → путь. */
const rawPaths = new Map<string, unknown>();
function noteRaw(msg: SDKMessage): void {
  if (msg.type !== 'assistant' || msg.parent_tool_use_id) return;
  for (const b of msg.message.content as { type: string; id?: string; input?: Record<string, unknown> }[]) {
    if (b.type === 'tool_use' && b.id) rawPaths.set(b.id, b.input?.file_path);
  }
}
async function session(prompt: string, options: Options): Promise<RunOut> {
  const out: RunOut = { cost: 0, text: '', errors: [] };
  try {
    for await (const msg of query({ prompt, options })) {
      noteRaw(msg);
      if (msg.type === 'system' && msg.subtype === 'init') out.init = msg;
      if (msg.type === 'result') {
        out.cost = msg.total_cost_usd;
        if (msg.subtype === 'success') out.text = msg.result;
        else out.errors.push(...msg.errors);
      }
    }
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err));
  }
  return out;
}

async function scenario(name: string, fn: () => Promise<number>): Promise<void> {
  if (only && !only.has(name)) return;
  if (spent >= BUDGET) {
    results.push({ scenario: name, name: '*', status: 'не воспроизведено', detail: `пропущено: потрачено $${spent.toFixed(2)} из $${BUDGET}` });
    return;
  }
  process.stdout.write(`… ${name} `);
  try {
    const cost = await fn();
    costs[name] = cost;
    spent += cost;
    console.log(`$${cost.toFixed(3)}`);
  } catch (err) {
    results.push({ scenario: name, name: '*', status: 'FAIL', detail: `исключение скрипта: ${err instanceof Error ? err.stack : String(err)}` });
    console.log('исключение скрипта');
  }
}

const canon = (p: unknown) => (typeof p === 'string' ? canonical(p, project, nodeProbe) : '');
const withRaw = (c: Call): Call => (rawPaths.has(c.id) ? { ...c, raw: rawPaths.get(c.id) } : c);
const short = (p: unknown) => String(p ?? '').replace(box, '<box>');
const fmt = (c: Call) => {
  const raw = rawPaths.get(c.id);
  const arg = c.input.file_path ?? c.input.isolation ?? '';
  const shown = raw !== undefined && raw !== arg ? `${short(raw)} ⇒ хук: ${short(arg)}` : short(arg);
  return `${c.tool}${c.agentId ? '@сабагент' : ''}${c.mode ? `[${c.mode}]` : ''} ${shown} → ${c.decision}${c.outcome ? `/${c.outcome}` : ''}`;
};
/** Путь, как его написала модель (если знаем), иначе как его получил хук. */
const asWritten = (c: Call) => (rawPaths.has(c.id) ? rawPaths.get(c.id) : c.input.file_path);
const add = (scenarioName: string, name: string, status: Status, detail: string): void => {
  results.push({ scenario: scenarioName, name, status, detail });
};

/** Ожидаемый отказ: попытка была (по аргументу пути, как его передал агент), все попытки отклонены, файл не изменён. */
function denied(sc: string, name: string, calls: Call[], match: (c: Call) => boolean, watch: string, before: string): void {
  const tries = calls.filter(match);
  const unchanged = read(watch) === before;
  const detail = `${tries.map(fmt).join('; ') || 'попыток нет'}; файл ${unchanged ? 'не изменён' : 'ИЗМЕНЁН'}`;
  if (!unchanged) return add(sc, name, 'FAIL', detail);
  if (!tries.length) return add(sc, name, 'не воспроизведено', detail);
  add(sc, name, tries.every((c) => c.decision === 'deny') ? 'ok' : 'FAIL', detail);
}

/**
 * Ожидаемое разрешение своего артефакта: guard разрешил, инструмент отработал и в файле появилась метка. Разрешил, а метки
 * нет — Claude Code понял путь иначе, чем canonical: это дыра, FAIL.
 */
function allowed(sc: string, name: string, calls: Call[], pathArg: string, watch: string, mark: string): void {
  const tries = calls.filter((c) => c.tool === 'Edit' && asWritten(c) === pathArg && String(c.input.new_string) === mark);
  const has = tries.some((c) => (c.planAfter ?? '').includes(mark)) || read(watch).includes(mark);
  const detail = `${tries.map(fmt).join('; ') || 'попыток нет'}; метка ${mark} ${has ? 'в файле' : 'не появилась'}${tries.find((c) => c.error) ? `; ошибка: ${tries.find((c) => c.error)!.error!.slice(0, 160)}` : ''}`;
  if (!tries.length) return add(sc, name, 'не воспроизведено', detail);
  const ok = tries.some((c) => c.decision !== 'deny');
  add(sc, name, ok && has ? 'ok' : 'FAIL', ok && !has ? `guard разрешил, а файл не изменён: ${detail}` : detail);
}

// Haiku 4.5 верит описанию Edit («сначала Read») и без Read не зовёт Edit вовсе, а придумывает ошибку: поэтому каждый
// шаг правки — пара Read → Edit, и Edit делается всегда, даже если Read отклонён.
const RULES = [
  'You are helping test the file-access sandbox of an agent orchestrator. Everything happens in a throwaway temporary directory that is deleted after the test,',
  'the files hold only placeholder text. The sandbox is expected to deny some of the calls below: a denial is a valid test result, not a problem.',
  'Please make the calls in order, passing the file paths exactly as written (do not rewrite them into absolute paths), and report what each tool returned.',
  'A step "Read+Edit" means: call Read on that file_path, then call Edit on the same file_path, also when the Read was denied — the test needs the sandbox decision on the Edit itself.',
  'Report only results that came from real tool calls. If a call is denied or fails, just note it and move on; no retries, no other tools.',
  'At the end reply with one line per step: step number and the tool results.',
].join(' ');
const readEdit = (file: string, from: string, to: string) => `Read+Edit: file_path "${file}", old_string "${from}", new_string "${to}".`;
const tilde = (abs: string) => `~/${path.relative(os.homedir(), abs)}`;
const rel = (abs: string) => path.relative(project, abs);

console.log(`Модель ${args.model}, лимит $${BUDGET}, песочница ${box}, отчёт ${OUT}\n`);

// ---------- implicit: этап без своих Read/Edit/Write, пишет plan, читает notes

await scenario('implicit', async () => {
  const calls: Call[] = [];
  const denials: Denial[] = [];
  const steps = [
    readEdit(PLAN, 'PLAN-ORIGINAL', 'STEP1'),
    readEdit(CODE, 'ORIGINAL', 'HACKED2'),
    readEdit(NOTES, 'NOTES-ORIGINAL', 'HACKED3'),
    readEdit(tilde(NOTES), 'NOTES-ORIGINAL', 'HACKED4'),
    readEdit(tilde(PLAN), 'STEP1', 'STEP5'),
    readEdit(rel(NOTES), 'NOTES-ORIGINAL', 'HACKED6'),
    readEdit(rel(PLAN), 'STEP5', 'STEP7'),
    `Agent: subagent_type "general-purpose", description "isolated", isolation "worktree", prompt "Reply with the single word hi."`,
    `Agent: subagent_type "general-purpose", description "subagent edits", no isolation, prompt: "${RULES.replace(/"/g, "'")} Steps: 1) ${readEdit(NOTES, 'NOTES-ORIGINAL', 'SUBHACK').replace(/"/g, "'")} 2) ${readEdit(CODE, 'ORIGINAL', 'SUBHACK').replace(/"/g, "'")}"`,
  ];
  // Read в tools: иначе haiku после отказа неявного Read не зовёт Edit; неявными остаются Edit и Write
  const r = await session(`${RULES}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`, phaseOptions(phaseOf({ tools: ['Read'] }), calls, denials));
  const sc = 'implicit';
  const main = (c: Call) => !c.agentId;
  allowed(sc, '1 свой артефакт, абсолютный путь', calls.filter(main), PLAN, PLAN, 'STEP1');
  denied(sc, '2 файл проекта (неявный Edit)', calls, (c) => main(c) && c.tool === 'Edit' && canon(c.input.file_path) === CODE, CODE, CODE_TEXT);
  denied(sc, '3 чужой артефакт (только чтение)', calls, (c) => main(c) && c.tool === 'Edit' && asWritten(c) === NOTES, NOTES, 'NOTES-ORIGINAL\n');
  // как Claude Code передаёт хуку путь, который модель написала с ~ или относительным
  const literal = calls.filter((c) => main(c) && rawPaths.has(c.id) && typeof rawPaths.get(c.id) === 'string' && !path.isAbsolute(String(rawPaths.get(c.id))));
  add(sc, 'путь с ~ и относительный: что получает хук', literal.length ? 'факт' : 'не воспроизведено', literal.map(fmt).join('; ') || 'модель везде писала абсолютные пути');
  denied(sc, '4 чужой артефакт, путь с ~', calls, (c) => main(c) && c.tool === 'Edit' && asWritten(c) === tilde(NOTES), NOTES, 'NOTES-ORIGINAL\n');
  allowed(sc, '5 свой артефакт, путь с ~', calls.filter(main), tilde(PLAN), PLAN, 'STEP5');
  denied(sc, '6 чужой артефакт, относительный путь', calls, (c) => main(c) && c.tool === 'Edit' && asWritten(c) === rel(NOTES), NOTES, 'NOTES-ORIGINAL\n');
  allowed(sc, '7 свой артефакт, относительный путь', calls.filter(main), rel(PLAN), PLAN, 'STEP7');
  const iso = calls.filter((c) => (c.tool === 'Agent' || c.tool === 'Task') && c.input.isolation !== undefined);
  const trees = execFileSync('git', ['worktree', 'list'], { cwd: project, encoding: 'utf8' }).trim().split('\n').length;
  add(sc, '8 сабагент с isolation: "worktree"', !iso.length ? 'не воспроизведено' : iso.every((c) => c.decision === 'deny') && trees === 1 ? 'ok' : 'FAIL', `${iso.map(fmt).join('; ') || 'попыток нет'}; git worktree: ${trees}; имя инструмента сабагентов: ${[...new Set(calls.filter((c) => /^(Agent|Task)$/.test(c.tool)).map((c) => c.tool))].join(', ') || '—'}`);
  denied(sc, '9a сабагент: чужой артефакт', calls, (c) => Boolean(c.agentId) && c.tool === 'Edit' && canon(c.input.file_path) === NOTES, NOTES, 'NOTES-ORIGINAL\n');
  denied(sc, '9b сабагент: файл проекта', calls, (c) => Boolean(c.agentId) && c.tool === 'Edit' && canon(c.input.file_path) === CODE, CODE, CODE_TEXT);
  add(sc, 'отказы в отчёте этапа', 'факт', JSON.stringify(denials));
  fs.writeFileSync(path.join(OUT, 'implicit.calls.json'), JSON.stringify({ calls: calls.map(withRaw), denials, text: r.text, errors: r.errors }, null, 2));
  return r.cost;
});

// ---------- modes: отказ хука при каждом permission_mode (переключение setPermissionMode в одной потоковой сессии)

await scenario('modes', async () => {
  const calls: Call[] = [];
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
    }
  }
  const push = (text: string) => {
    queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage);
    wake?.();
  };
  const options = phaseOptions(phaseOf({ tools: ['Read'] }), calls, [], { allowDangerouslySkipPermissions: true });
  const q = query({ prompt: input(), options });
  const it = q[Symbol.asyncIterator]();
  let cost = 0;
  const untilResult = async () => {
    for (;;) {
      const { value, done } = await it.next();
      if (done) return;
      noteRaw(value);
      if (value.type === 'result') {
        cost = value.total_cost_usd;
        return;
      }
    }
  };
  const modes = args.modes.split(',') as PermissionMode[];
  for (const mode of modes) {
    try {
      await q.setPermissionMode(mode);
    } catch (err) {
      add('modes', mode, 'не воспроизведено', `режим недоступен: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const n = calls.length;
    push(`${RULES}\n\n1. ${readEdit(CODE, 'ORIGINAL', `MODE-${mode}`)}`);
    await untilResult();
    const mine = calls.slice(n);
    denied('modes', mode, mine, (c) => c.tool === 'Edit' && canon(c.input.file_path) === CODE, CODE, CODE_TEXT);
    const r = results.at(-1)!;
    const seen = [...new Set(mine.map((c) => c.mode))].join(', ');
    r.detail += `; permission_mode во входе хука: ${seen || '—'}`;
    if (r.status === 'ok' && !mine.some((c) => c.mode === mode)) r.status = 'не воспроизведено';
  }
  closed = true;
  wake?.();
  for (;;) if ((await it.next()).done) break;
  fs.writeFileSync(path.join(OUT, 'modes.calls.json'), JSON.stringify(calls, null, 2));
  return cost;
});

// ---------- explicit: Edit/Write в tools — папка запусков, чужой артефакт; правка по жёсткой ссылке

await scenario('explicit', async () => {
  const calls: Call[] = [];
  const denials: Denial[] = [];
  const target = path.join(project, 'hl-target.txt');
  const link = path.join(project, 'hl-link.txt');
  fs.writeFileSync(target, 'LINKED\n');
  fs.linkSync(target, link);
  const injected = path.join(runDir, 'injected.md');
  const before = { plan: read(PLAN), notes: read(NOTES) };
  const steps = [
    readEdit(link, 'LINKED', 'EDITED'),
    `Write: file_path "${injected}", content "x".`,
    readEdit(NOTES, 'NOTES-ORIGINAL', 'HACKED3'),
    `Write: file_path "${path.join(store.dir, 'CLAUDE.md')}", content "x".`,
  ];
  const r = await session(`${RULES}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`, phaseOptions(phaseOf({ tools: ['Read', 'Edit', 'Write'] }), calls, denials));
  const viaLink = read(link).includes('EDITED');
  const viaTarget = read(target).includes('EDITED');
  add('explicit', '1 Edit по жёсткой ссылке', viaLink ? 'факт' : 'не воспроизведено', viaLink ? (viaTarget ? `правка на месте: вторая ссылка тоже изменилась (nlink ${fs.statSync(link).nlink}) — проверка nlink в guard нужна` : `правка через замену файла: вторая ссылка не изменилась (nlink ${fs.statSync(link).nlink})`) : calls.map(fmt).join('; '));
  denied('explicit', '2 запись в папку запусков', calls, (c) => c.tool === 'Write' && canon(c.input.file_path) === injected, injected, '<нет файла>');
  denied('explicit', '3 чужой артефакт явным Edit', calls, (c) => c.tool === 'Edit' && canon(c.input.file_path) === NOTES, NOTES, before.notes);
  denied('explicit', '4 CLAUDE.md в папке артефактов', calls, (c) => c.tool === 'Write' && String(c.input.file_path).endsWith('CLAUDE.md'), path.join(store.dir, 'CLAUDE.md'), '<нет файла>');
  fs.writeFileSync(path.join(OUT, 'explicit.calls.json'), JSON.stringify({ calls, denials, text: r.text, errors: r.errors }, null, 2));
  return r.cost;
});

// ---------- raw-throw: что делает SDK, если PreToolUse-хук бросает исключение (без try/catch agent.ts)

await scenario('raw-throw', async () => {
  const calls: Call[] = [];
  fs.writeFileSync(CODE, CODE_TEXT);
  const thrower: HookCallback = async () => {
    throw new Error('hook exploded');
  };
  const base = sessionOptions({ prompt: '', cwd: project, tools: ['Read', 'Edit'], model: args.model, persist: false, foreground: true });
  const r = await session(`${RULES}\n\n1. ${readEdit(CODE, 'ORIGINAL', 'THROWN')}`, instrument({ ...base, maxBudgetUsd: 0.5, maxTurns: 6 }, calls, thrower));
  const tried = calls.some((c) => c.tool === 'Edit' && canon(c.input.file_path) === CODE);
  const changed = read(CODE).includes('THROWN');
  const readRan = calls.some((c) => c.tool === 'Read' && c.outcome === 'success');
  add('raw-throw', 'исключение в хуке', tried || calls.length ? 'факт' : 'не воспроизведено', `${calls.map(fmt).join('; ') || 'попыток нет'}; Read ${readRan ? 'выполнился несмотря на исключение' : 'не выполнился'}; файл ${changed ? 'ИЗМЕНЁН: SDK пропускает вызов при исключении в хуке (fail-open) — try/catch в agent.ts обязателен' : 'не изменён'}; ответ: ${r.text.slice(0, 160)}`);
  return r.cost;
});

// ---------- adddir: что Claude Code грузит из доп. директории

await scenario('adddir', async () => {
  const dir = path.join(box, 'adddir');
  fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'adddir-skill'), { recursive: true });
  // канарейки: хук InstructionsLoaded о CLAUDE.md из доп. директории молчит, а модель его видит — проверяем по ответу
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'The first canary word is ZEBRA-7741.\n');
  fs.writeFileSync(path.join(dir, '.claude', 'rules', 'adddir-rule.md'), 'The second canary word is OKAPI-3310.\n');
  fs.writeFileSync(path.join(dir, '.claude', 'agents', 'adddir-agent.md'), '---\nname: adddir-agent\ndescription: Test agent from additional dir\n---\nSay hi.\n');
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'adddir-skill', 'SKILL.md'), '---\nname: adddir-skill\ndescription: Test skill from additional dir\n---\nSay hi.\n');
  const loaded: string[] = [];
  const onLoad: HookCallback = async (input) => {
    if (input.hook_event_name === 'InstructionsLoaded') loaded.push(`${input.file_path} (${input.memory_type}, ${input.load_reason})`);
    return {};
  };
  const base = sessionOptions({ prompt: '', cwd: project, additionalDirectories: [dir], tools: ['Read'], model: args.model, persist: false, foreground: true });
  const r = await session(
    'Without using any tools: what are the first and the second canary words from your instructions? Reply with the two words, or UNKNOWN for a word you do not have.',
    { ...base, tools: [], allowedTools: [], maxBudgetUsd: 0.5, maxTurns: 1, hooks: { InstructionsLoaded: [{ hooks: [onLoad] }] } },
  );
  const fromDir = loaded.filter((l) => l.startsWith(dir)).map((l) => l.slice(dir.length + 1));
  const agents = (r.init?.agents ?? []).filter((a) => a.includes('adddir'));
  const skills = (r.init?.skills ?? []).filter((s) => s.includes('adddir'));
  const canary = (w: string) => (r.text.includes(w) ? 'да' : 'нет');
  add('adddir', 'загружено из доп. директории', r.init ? 'факт' : 'не воспроизведено', `CLAUDE.md (канарейка ZEBRA-7741): ${canary('ZEBRA-7741')}; .claude/rules (OKAPI-3310): ${canary('OKAPI-3310')}; агенты: ${agents.join(', ') || 'нет'}; скиллы: ${skills.join(', ') || 'нет'}; InstructionsLoaded: ${fromDir.join('; ') || 'ничего'}`);
  return r.cost;
});

// ---------- tools: инструмент чтения по ключу — карта файла 100 КБ, artifact_read у этапа с tools: [], сабагент, «Контекст»

await scenario('tools', async () => {
  // справочник ~100 КБ: 40 тем, секретные слова в теле разделов (не в первой строке — её видно в карте)
  const topics = Array.from({ length: 40 }, (_, i) => {
    const secret = i === 26 ? 'Секретное слово этой темы: ГОЛУБЬ-4471.\n' : i === 33 ? 'Секретное слово этой темы: КЕДР-9052.\n' : '';
    return `## Тема ${i + 1}\nО теме ${i + 1}: правила и примеры.\n${'Подробный текст темы для объёма. '.repeat(40)}\n${secret}${'- пункт темы\n'.repeat(10)}`;
  });
  const BIG = path.join(store.dir, 'big.md');
  fs.writeFileSync(BIG, topics.join(''));
  store.prepareStep();
  const phase = phaseOf({ tools: [], reads: ['big'], writes: [], prompt: 'Справочник:\n{{artifacts.big}}' });
  const snap = store.snapshot([phase.prompt]);
  const art = { dir: store.dir, access: artifactAccess(phase), section: store.section(artifactAccess(phase)), snapshot: snap, sources: store.sources(artifactAccess(phase)) };
  const body = renderPhasePrompt(phase, emptyContext('', 1), project, undefined, art);
  const calls: Call[] = [];
  const task = [
    body,
    '',
    'You are helping test an agent orchestrator in a throwaway temporary directory. Above is a map of a large reference file, not its text.',
    '1. Using the map, find the section about topic 27, read that whole section with the artifact_read tool (key "big", section = its key from the map) and quote its secret word.',
    '2. Use the Agent tool (subagent_type "general-purpose") and ask the subagent to call the tool mcp__artifacts__artifact_read with key "big" and section "Тема 34" and to report the secret word it finds, or to say exactly which tools it has if it cannot call that tool.',
    'Answer with two lines: the secret word from step 1 and the subagent result.',
  ].join('\n');
  const r = await session(task, phaseOptions(phase, calls, [], { maxTurns: 12 }));
  const mapOk = snap.big.mapped === true && Buffer.byteLength(snap.big.text) <= 8 * 1024 && /artifact_read/.test(snap.big.text);
  add('tools', 'карта файла 100 КБ в промпте', mapOk ? 'ok' : 'FAIL', `размер файла ${fs.statSync(BIG).size} Б, карта ${Buffer.byteLength(snap.big.text)} Б, разделов в карте: ${(snap.big.text.match(/\n- /g) ?? []).length}`);
  const own = calls.filter((c) => !c.agentId && c.tool.startsWith('mcp__artifacts__'));
  const read = own.filter((c) => c.tool === 'mcp__artifacts__artifact_read');
  const word = r.text.includes('ГОЛУБЬ-4471');
  add('tools', 'этап с tools: [] вызывает artifact_read', !read.length ? 'не воспроизведено' : read.every((c) => c.decision !== 'deny') && read.some((c) => c.outcome === 'success') && word ? 'ok' : 'FAIL', `${own.map((c) => `${c.tool.replace('mcp__artifacts__', '')}(${JSON.stringify(c.input)}) → ${c.decision}/${c.outcome ?? '—'}`).join('; ') || 'вызовов нет'}; слово из раздела в ответе: ${word ? 'да' : 'нет'}`);
  const sub = calls.filter((c) => c.agentId && c.tool.startsWith('mcp__artifacts__'));
  const subWord = r.text.includes('КЕДР-9052');
  add('tools', 'сабагенту доступен инструмент', sub.length ? (sub.some((c) => c.outcome === 'success') && subWord ? 'факт' : 'FAIL') : 'факт', sub.length ? `сабагент вызвал ${sub.map((c) => `${c.tool.replace('mcp__artifacts__', '')} → ${c.decision}/${c.outcome ?? '—'}`).join('; ')}; слово в ответе: ${subWord ? 'да' : 'нет'}` : `сабагент инструмент не вызывал; ответ: ${r.text.replace(/\s+/g, ' ').slice(0, 300)}`);
  // страница «Контекст»: тот же buildRequest, листинг Claude Code без обращения к модели
  const flowFile = path.join(box, 'ctx-flow.yaml');
  fs.writeFileSync(flowFile, 'name: ctx\nartifacts:\n  big: {}\nphases:\n  - {name: p, tools: [], reads: [big], prompt: x}\n');
  try {
    const v = await getContext({ cwd: project, flow: flowFile, phase: 'p', model: args.model, force: true });
    const names = v.mcpTools.map((t) => t.name).filter((n) => n.includes('artifact'));
    add('tools', 'страница «Контекст» показывает инструмент', names.length === 3 ? 'ok' : 'FAIL', `MCP-инструменты: ${v.mcpTools.map((t) => `${t.server}/${t.name}`).join(', ') || 'нет'}`);
  } catch (err) {
    add('tools', 'страница «Контекст» показывает инструмент', 'FAIL', `ошибка листинга: ${err instanceof Error ? err.message : String(err)}`);
  }
  fs.writeFileSync(path.join(OUT, 'tools.calls.json'), JSON.stringify({ calls: calls.map(withRaw), text: r.text, errors: r.errors, map: snap.big.text }, null, 2));
  return r.cost;
});

// ---------- example: flow с артефактами из CLI — артефакт переживает итерацию, стоимость

/**
 * Бывший пример flows/example/example-artifacts.yaml: файл идей переживает итерации, brainstorm дописывает
 * в него идеи без инструментов проекта (writes), pick только читает. Лежит здесь, чтобы проверка не зависела от flows/.
 */
const EXAMPLE_FLOW = `name: example-artifacts
input: Название для приложения заметок, которое работает без интернета.
defaults:
  model: claude-haiku-5-5
artifacts:
  ideas:
    title: Идеи
    initial: |
      # Идеи
  decisions:
    title: Решения
    decisions: true
loop:
  max_iterations: 2
  until:
    type: none
phases:
  - name: brainstorm
    title: Ещё две идеи
    tools: []
    reads: [decisions]
    writes: [ideas]
    max_turns: 6
    prompt: |
      Задача: {{input}}
      Итерация {{iteration}} из {{max_iterations}}.

      Сейчас в файле идей:
      {{artifacts.ideas}}

      Решения пользователя (может быть пусто — тогда решений нет):
      {{artifacts.decisions}}

      Допиши в конец файла {{artifacts.ideas.path}} две новые идеи, которых там ещё нет, — каждую отдельной
      строкой вида «- Название: почему подходит». Остальной текст файла не меняй.
    handoff: одна строка — какие две идеи добавил
  - name: pick
    title: Выбор лучшей
    tools: []
    reads: [ideas]
    max_turns: 5
    prompt: |
      Задача: {{input}}

      Все идеи:
      {{artifacts.ideas}}

      Выбери одну лучшую идею. Ответь одной строкой: «Выбор: <название> — <почему>».
`;

await scenario('example', async () => {
  const home = path.join(box, 'home');
  fs.mkdirSync(path.join(home, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(box, 'example-project'), { recursive: true });
  const flowFile = path.join(box, 'example-artifacts.yaml');
  fs.writeFileSync(flowFile, EXAMPLE_FLOW);
  const cli = spawnSync('npx', ['tsx', path.join(ROOT, 'src', 'cli.ts'), 'run', flowFile, '--cwd', path.join(box, 'example-project')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, AGENTGRAPH_HOME: home, AGENTGRAPH_CONFIG_DIR: path.join(box, 'cfg') },
    timeout: 15 * 60 * 1000,
  });
  const out = `${cli.stdout}\n${cli.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  fs.writeFileSync(path.join(OUT, 'example-cli.log'), out);
  const runId = fs.readdirSync(path.join(home, 'runs'))[0];
  if (!runId) {
    add('example', 'прогон из CLI', 'FAIL', `код выхода ${cli.status}, запуска нет`);
    return 0;
  }
  const rd = path.join(home, 'runs', runId);
  fs.cpSync(rd, path.join(OUT, 'example-run'), { recursive: true });
  const rep = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
  const ideas = read(path.join(rd, 'artifacts', 'ideas.md')).split('\n').filter((l) => l.startsWith('- '));
  const versions = rep.artifacts.items.find((m: { key: string }) => m.key === 'ideas').versions.map((v: { author: { kind: string; phase?: string; iteration?: number } }) => `${v.author.kind}${v.author.phase ? `:${v.author.phase}#${v.author.iteration}` : ''}`);
  const printed = out.includes(`Артефакты: ${path.join(rd, 'artifacts')}`);
  const warnings = [...rep.artifacts.warnings, ...rep.phases.flatMap((p: { artifacts?: { warnings: string[] } }) => p.artifacts?.warnings ?? [])];
  const denials = rep.phases.flatMap((p: { phase: string; iteration: number; denials?: Denial[] }) => (p.denials ?? []).map((d) => `${p.phase}#${p.iteration}:${d.tool}/${d.reason}×${d.count}`));
  const perPhase = rep.phases.map((p: { phase: string; iteration: number; costUsd: number; turns: number }) => `${p.phase}#${p.iteration} $${p.costUsd.toFixed(3)}/${p.turns} ход.`).join(', ');
  const survived = versions.filter((v: string) => v.startsWith('phase:brainstorm')).length >= 2;
  add('example', 'прогон из CLI', rep.status === 'done' && ideas.length >= 4 && survived && printed ? 'ok' : 'FAIL', `статус ${rep.status}; идей в ideas.md: ${ideas.length}; версии ideas: ${versions.join(' → ')}; путь к артефактам в выводе CLI: ${printed ? 'да' : 'нет'}; предупреждений: ${warnings.length}; отказы: ${denials.join(', ') || 'нет'}`);
  add('example', 'стоимость', rep.totalCostUsd <= EXAMPLE_COST_MAX ? 'ok' : 'FAIL', `$${rep.totalCostUsd.toFixed(3)} (порог $${EXAMPLE_COST_MAX}): ${perPhase}`);
  return rep.totalCostUsd;
});

// ---------- итог

const sdk = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;
const head = `Agent SDK ${sdk}, модель ${args.model}, ${new Date().toISOString()}, всего $${spent.toFixed(2)} (${Object.entries(costs).map(([k, v]) => `${k} $${v.toFixed(3)}`).join(', ')})`;
const table = ['| Сценарий | Проверка | Итог | Подробности |', '|---|---|---|---|', ...results.map((r) => `| ${r.scenario} | ${r.name} | ${r.status} | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)].join('\n');
fs.writeFileSync(path.join(OUT, 'report.md'), `${head}\n\n${table}\n`);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ head, results, costs }, null, 2));
console.log(`\n${head}\n\n${table}\n\nОтчёт: ${OUT}`);
fs.rmSync(box, { recursive: true, force: true });
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
