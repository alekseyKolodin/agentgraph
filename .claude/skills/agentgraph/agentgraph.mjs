#!/usr/bin/env node
// Хелпер скилла /agentgraph: запуск флоу через API UI-сервера agentgraph и ретрансляция вопросов агента в чат.
// Команды: ensure | flows | draft | start | continue | wait | answer | status | pause | resume | abort | artifacts | artifact | artifact-write.
// Вывод — JSON или короткий текст для Claude.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// скрипт лежит в <проект>/.claude/skills/agentgraph/; глобальный ~/.claude/skills/agentgraph — симлинк сюда,
// а node резолвит симлинк главного модуля, так что корень проекта считается от реального пути
const HOME = process.env.AGENTGRAPH_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BASE = process.env.AGENTGRAPH_URL || 'http://127.0.0.1:4747';
const LOG = path.join(os.tmpdir(), 'agentgraph-ui.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const fail = (msg, code = 1) => { console.error(`ошибка: ${msg}`); process.exit(code); };
const expandHome = (p) => path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));

// опции, которые можно повторять: значения собираются в массив
const REPEATABLE = new Set(['add-dir', 'attach']);

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      const v = next === undefined || next.startsWith('--') ? true : (i++, next);
      if (REPEATABLE.has(k)) (opt[k] ??= []).push(v);
      else opt[k] = v;
    } else pos.push(a);
  }
  return { pos, opt };
}

// Ошибка API несёт код ответа и тело: по code (conflict, locked, readonly…) хелпер объясняет, что делать дальше
async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status, code: data.code, data });
  return data;
}

// Сервер, поднятый до обновления agentgraph, новых полей не знает и молча их отбросит (resume без ответа — потеря ответа)
async function need(feature) {
  const features = (await api('GET', '/api/config')).features || [];
  if (!features.includes(feature)) fail('сервер запущен до обновления agentgraph: перезапусти npm run ui');
}

async function up() {
  try { await api('GET', '/api/config'); return true; } catch { return false; }
}

async function ensure() {
  if (await up()) return { server: BASE, started: false };
  if (!fs.existsSync(path.join(HOME, 'package.json'))) fail(`не найден проект agentgraph в ${HOME} (задай AGENTGRAPH_HOME)`);
  const fd = fs.openSync(LOG, 'a');
  const child = spawn('npm', ['run', 'ui'], { cwd: HOME, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await up()) return { server: BASE, started: true, pid: child.pid, log: LOG };
  }
  fail(`сервер не поднялся за 20с, лог: ${LOG}`);
}

const usesAsk = (f) => (f.phases || []).some((p) => p.tools.includes('AskUserQuestion'));

async function flows() {
  const list = await api('GET', '/api/flows');
  return list.map((f) => f.valid
    ? {
        name: f.name,
        folder: f.folder || undefined, // папка в flows/; имя флоу уникально и без неё
        description: f.description || '',
        phases: f.phases.map((p) => `${p.title || p.name} [${p.tools.join(', ') || '—'}]`),
        condition: f.condition,
        maxIterations: f.maxIterations,
        // несколько блоков подряд: у каждого свой цикл и условие
        blocks: f.blocks?.length > 1
          ? f.blocks.map((b) => `${b.title || b.name}: ${b.looped ? `цикл до ${b.maxIterations}, ${b.condition}` : 'один проход'} — ${b.phases.map((p) => p.title || p.name).join(' → ')}`)
          : undefined,
        asksUser: usesAsk(f),
        hasDefaultInput: Boolean(f.input),
      }
    : { name: f.name, folder: f.folder || undefined, invalid: f.error });
}

function readInput(opt) {
  if (opt['input-file']) return fs.readFileSync(String(opt['input-file']), 'utf8');
  if (typeof opt.input === 'string') return opt.input;
  return undefined;
}

// Продолжает завершённый запуск текущей версией флоу: блоки, прошедшие целиком, не повторяются.
async function cont(pos, opt) {
  const id = pos[0];
  if (!id) fail('укажи id завершённого запуска');
  if (opt['max-iterations']) fail('--max-iterations при продолжении не принимается: он переопределил бы лимит всех циклов; лимит блока задаётся в flow');
  const r = await api('POST', `/api/runs/${id}/continue`, { maxBudgetUsd: opt['max-budget'], model: opt.model });
  return { id: r.id, ui: `${BASE}/run/${r.id}`, continuedFrom: id, skipped: r.skipped };
}

// План flow для показа пользователю: этапы с инструментами (они разрешаются без подтверждения), условие, блоки
function plan(f) {
  return {
    name: f.name,
    description: f.description || '',
    phases: f.phases.map((p) => `${p.title || p.name} [${p.tools.join(', ') || '—'}]`),
    condition: f.condition,
    maxIterations: f.maxIterations,
    blocks: f.blocks?.length > 1
      ? f.blocks.map((b) => `${b.title || b.name}: ${b.looped ? `цикл до ${b.maxIterations}, ${b.condition}` : 'один проход'} — ${b.phases.map((p) => p.title || p.name).join(' → ')}`)
      : undefined,
    asksUser: usesAsk(f),
  };
}

// Черновик разового запуска: сгенерировать flow, не сохраняя в flows/; YAML — во временный файл для start --spec-file
async function draft(pos, opt) {
  const task = opt['task-file'] ? fs.readFileSync(String(opt['task-file']), 'utf8') : typeof opt.task === 'string' ? opt.task : undefined;
  if (!task?.trim()) fail('укажи задачу: --task-file F или --task TEXT');
  const cwd = opt.cwd && opt.cwd !== true ? expandHome(opt.cwd) : undefined;
  if (cwd && !fs.existsSync(cwd)) fail(`нет директории ${cwd}`);
  await need('adhoc-runs');
  const r = await api('POST', '/api/flows/generate', { task, cwd, model: opt.model, save: false });
  const file = opt.out && opt.out !== true
    ? expandHome(opt.out)
    : path.join(os.tmpdir(), `agentgraph-draft-${r.name}-${Date.now()}.yaml`);
  fs.writeFileSync(file, r.yaml);
  return { specFile: file, costUsd: r.costUsd, ...plan(r.summary), next: 'покажи план пользователю и после явного согласия: start --spec-file <specFile> --cwd DIR' };
}

async function start(pos, opt) {
  const flow = pos[0];
  const specFile = opt['spec-file'] && opt['spec-file'] !== true ? expandHome(opt['spec-file']) : undefined;
  if (flow && specFile) fail('укажи что-то одно: имя flow или --spec-file');
  if (!flow && !specFile) fail('укажи имя flow или --spec-file (разовый запуск)');
  if (specFile && !fs.existsSync(specFile)) fail(`нет файла ${specFile}`);
  if (!opt.cwd || opt.cwd === true) fail('укажи --cwd: директорию проекта');
  const cwd = expandHome(opt.cwd);
  if (!fs.existsSync(cwd)) fail(`нет директории ${cwd}`);
  // доп. директории на весь запуск и вложения к задаче; типы и лимиты вложений проверит сервер
  const addDirs = (opt['add-dir'] || []).map((d) => {
    if (d === true) fail('--add-dir: укажи директорию');
    const dir = expandHome(d);
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) fail(`нет директории ${dir}`);
    return dir;
  });
  const attachments = (opt.attach || []).map((f) => {
    if (f === true) fail('--attach: укажи файл');
    const file = expandHome(f);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) fail(`нет файла ${file}`);
    return { name: path.basename(file), data: fs.readFileSync(file).toString('base64') };
  });
  // сервер, поднятый до обновления agentgraph, эти поля молча отбросит: проверяем, что он их знает
  if (addDirs.length || attachments.length) {
    const features = (await api('GET', '/api/config')).features || [];
    const need = [...(attachments.length ? ['attachments'] : []), ...(addDirs.length ? ['run-add-dirs'] : [])];
    if (need.some((f) => !features.includes(f))) fail('сервер запущен до обновления agentgraph: перезапусти npm run ui');
  }
  // разовый запуск: flow не из flows/, а YAML черновика; в run.json — adhoc
  if (specFile) await need('adhoc-runs');
  const r = await api('POST', '/api/runs', {
    ...(specFile ? { yaml: fs.readFileSync(specFile, 'utf8') } : { flow }),
    input: readInput(opt),
    cwd,
    addDirs: addDirs.length ? addDirs : undefined,
    attachments: attachments.length ? attachments : undefined,
    maxIterations: opt['max-iterations'],
    maxBudgetUsd: opt['max-budget'],
    model: opt.model,
  });
  return { id: r.id, ui: `${BASE}/run/${r.id}`, ...(specFile ? { adhoc: true } : {}) };
}

// «Сохранить как flow» у разового запуска: без --name — свободное имя от имени запуска
async function saveFlow(pos, opt) {
  if (!pos[0]) fail('укажи id запуска');
  await need('adhoc-runs');
  return api('POST', `/api/runs/${pos[0]}/save-flow`, {
    name: opt.name && opt.name !== true ? opt.name : undefined,
    folder: opt.folder && opt.folder !== true ? opt.folder : '',
  });
}

const pendingQuestion = (run) => (run.live ? run.questions.find((q) => !q.answers) : undefined);

// Кто последним изменил артефакт — как в разделе «Артефакты запуска» промпта этапов
function who(a) {
  if (!a) return undefined;
  const at = a.at ? ` ${new Date(a.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '';
  switch (a.kind) {
    case 'phase': return `этап ${a.phase}, итерация ${a.iteration}${at}`;
    case 'unknown': return `неизвестно: во время этапа ${a.phase} не этапом с правом записи${at}`;
    case 'user': return `пользователь (${a.via === 'skill' ? 'скилл' : a.via === 'chat' ? 'чат' : 'UI'})${at}`;
    case 'outside': return `снаружи, между шагами${at}`;
    case 'condition': return `проверка условия, итерация ${a.iteration}${at}`;
    case 'initial': return 'заготовка flow';
    case 'empty': return 'ещё не заполнялся';
    default: return a.kind;
  }
}

// Артефакты в сводке запуска: ключ, файл, последний автор; decisions — куда идёт ответ на паузу
function artifactsOf(run) {
  const items = run.artifacts?.items;
  if (!items?.length) return {};
  const dir = path.join(run.runDir, 'artifacts');
  return {
    artifacts: items.map((m) => ({
      key: m.key,
      title: m.title,
      path: path.join(dir, m.file),
      lastChange: who(m.versions?.at(-1)?.author),
      versions: m.versions?.length ?? 0,
      decisions: m.decisions || undefined,
      fromRun: m.fromRun,
      tasks: m.tasks || undefined,
    })),
    decisions: items.find((m) => m.decisions)?.key,
    artifactWarnings: run.artifacts.warnings?.length ? run.artifacts.warnings : undefined,
  };
}

function summary(run) {
  const abs = (f) => (f ? path.join(run.runDir, f) : undefined);
  const multi = (run.blocks?.length ?? 0) > 1;
  return {
    id: run.id,
    flow: run.flow,
    status: run.live ? (run.pause === 'paused' ? 'paused' : 'running') : run.status,
    live: Boolean(run.live),
    // requested — текущий шаг доигрывает, потом запуск встанет на паузу
    pause: run.live ? run.pause : undefined,
    // паузу попросил агент (loop.pause_marker): text — его вопросы, output — вывод этапа целиком
    pauseReason: run.live && run.pauseReason ? { ...run.pauseReason, output: abs(run.pauseReason.output) } : undefined,
    iterations: `${run.iterations}/${run.maxIterations}`,
    costUsd: Number(run.totalCostUsd || 0).toFixed(2),
    error: run.error,
    runDir: run.runDir,
    ui: `${BASE}/run/${run.id}`,
    blocks: multi
      ? run.blocks.map((b) => ({ block: b.title || b.name, status: b.status, iterations: `${b.iterations}/${b.maxIterations}` }))
      : undefined,
    phases: run.phases.map((p) => ({
      block: multi ? p.block : undefined,
      iteration: p.iteration,
      phase: p.phase,
      title: p.title,
      ok: p.ok,
      subtype: p.ok ? undefined : p.subtype,
      costUsd: Number(p.costUsd || 0).toFixed(2),
      turns: p.turns,
      output: abs(p.files?.output),
      errors: p.errors?.length ? p.errors : undefined,
    })),
    conditions: run.conditions.map((c) => ({
      block: multi ? c.block : undefined,
      iteration: c.iteration,
      type: c.type,
      done: c.done,
      detail: c.detail,
      feedback: c.feedback ? c.feedback.slice(0, 1500) : undefined,
    })),
    questions: run.questions.map((q) => ({ phase: q.title || q.phase, iteration: q.iteration, answers: q.answers })),
    ...artifactsOf(run),
    // можно ли продолжить (AG continue) — ответ сервера, не догадка по статусу
    continuable: run.live ? undefined : run.continuable,
    continueReason: run.live || run.continuable ? undefined : run.continueReason,
  };
}

// Ждёт, пока запуск задаст вопрос, встанет на паузу или завершится. Запускать в фоне: Claude получит уведомление на выходе.
async function wait(pos, opt) {
  const id = pos[0];
  if (!id) fail('укажи id запуска');
  const timeout = Number(opt.timeout || 0) * 1000;
  const t0 = Date.now();
  let seenPhases = -1;
  for (;;) {
    let run;
    try { run = await api('GET', `/api/runs/${id}`); } catch (err) {
      if (!(await up())) fail('UI-сервер недоступен: живой запуск жил в его процессе и, скорее всего, прерван');
      throw err;
    }
    if (run.phases.length !== seenPhases) {
      for (const p of run.phases.slice(Math.max(seenPhases, 0))) {
        const where = (run.blocks?.length ?? 0) > 1 ? `${p.block}, итерация ${p.iteration}` : `итерация ${p.iteration}`;
        console.log(`· ${where}: ${p.title || p.phase} — ${p.ok ? 'ок' : p.subtype}, $${Number(p.costUsd).toFixed(2)}`);
      }
      seenPhases = run.phases.length;
    }
    const q = pendingQuestion(run);
    if (q) {
      out('=== QUESTION ===');
      return {
        runId: id,
        questionId: q.id,
        phase: q.title || q.phase,
        iteration: q.iteration,
        // текст агента прямо перед вопросом: таблица или список, о которых спрашивают
        ...(q.preface ? { preface: q.preface } : {}),
        // ключ ответа = текст вопроса; значение = label варианта, список через ", " или свой текст
        questions: q.questions.map((x) => ({ question: x.question, header: x.header, multiSelect: Boolean(x.multiSelect), options: x.options })),
      };
    }
    if (!run.live) {
      out('=== END ===');
      return summary(run);
    }
    if (run.pause === 'paused') {
      const decisions = run.artifacts?.items?.some((m) => m.decisions);
      out(!run.pauseReason
        ? '=== PAUSED (возобновить: resume, потом снова wait) ==='
        : decisions
          ? '=== PAUSED: агент ждёт решения пользователя (вопросы — pauseReason.text; ответ: resume <id> --answer-file F — запишется в артефакт decisions; потом снова wait) ==='
          : '=== PAUSED: агент ждёт решения пользователя (вопросы — pauseReason.text; ответы записать, затем resume и снова wait) ===');
      return summary(run);
    }
    if (timeout && Date.now() - t0 > timeout) {
      out('=== TIMEOUT (запуск ещё идёт, перезапусти wait) ===');
      return summary(run);
    }
    await sleep(3000);
  }
}

async function answer(pos, opt) {
  const [id, questionId] = pos;
  if (!id || !questionId) fail('нужно: answer <runId> <questionId> --json \'{"текст вопроса":"ответ"}\'');
  const raw = opt.file ? fs.readFileSync(String(opt.file), 'utf8') : opt.json;
  if (!raw || raw === true) fail('передай ответы через --json или --file');
  let answers;
  try { answers = JSON.parse(raw); } catch { fail('ответы — невалидный JSON'); }
  await api('POST', `/api/runs/${id}/answer`, { questionId, answers });
  return { ok: true };
}

// Возобновить; с --answer-file — ответ на паузу по просьбе агента: сервер допишет его в артефакт decisions
// и в отчёт, а при ошибке записи оставит паузу.
async function resume(pos, opt) {
  const id = pos[0];
  if (!id) fail('укажи id запуска');
  if (!opt['answer-file']) return api('POST', `/api/runs/${id}/resume`);
  if (opt['answer-file'] === true) fail('--answer-file: укажи файл с ответом');
  const answer = fs.readFileSync(expandHome(opt['answer-file']), 'utf8');
  if (!answer.trim()) fail('файл ответа пуст: чтобы возобновить без ответа, вызови resume без --answer-file');
  await need('artifacts');
  try {
    return await api('POST', `/api/runs/${id}/resume`, { answer, via: 'skill' });
  } catch (err) {
    if (err.code === 'no_decisions') fail(`${err.message}. Запуск остался на паузе`);
    if (err.code) fail(`${err.message} (${err.code})`);
    throw err;
  }
}

// Список артефактов запуска: файл, последний автор, можно ли сейчас править и почему
async function artifacts(pos) {
  const id = pos[0];
  if (!id) fail('укажи id запуска');
  await need('artifacts');
  const r = await api('GET', `/api/runs/${id}/artifacts`);
  return {
    live: r.live,
    continuable: r.live ? undefined : r.continuable,
    from: r.from,
    warnings: r.warnings?.length ? r.warnings : undefined,
    items: r.items.map((a) => ({
      key: a.key,
      title: a.title,
      path: a.path,
      size: a.size,
      lastChange: who({ ...a.author, at: a.author?.at ?? a.at }),
      versions: a.versions,
      decisions: a.decisions || undefined,
      // пункты чек-листа: { open, done }; нет — чек-листа нет
      tasks: a.tasks || undefined,
      missing: a.missing || undefined,
      editable: a.editable,
      // почему нельзя или куда попадёт правка
      note: a.message,
    })),
  };
}

// Артефакт целиком: шапка (хэш — база для artifact-write --base) и текст; --out F — текст в файл, шапка в stdout
async function artifact(pos, opt) {
  const [id, key] = pos;
  if (!id || !key) fail('нужно: artifact <runId> <key> [--version N] [--out FILE]');
  await need('artifacts');
  const v = opt.version && opt.version !== true ? `?version=${encodeURIComponent(opt.version)}` : '';
  const a = await api('GET', `/api/runs/${id}/artifacts/${encodeURIComponent(key)}${v}`);
  const head = {
    key: a.key,
    title: a.title,
    path: a.path,
    version: a.version ? { n: a.version.n, lastChange: who(a.version.author), stored: a.version.stored } : undefined,
    versions: a.versions.map((x) => `${x.n}: ${who(x.author)}${x.stored ? '' : ' (копия не сохранена)'}`),
    hash: a.version ? undefined : a.hash,
    lastChange: a.version ? undefined : who({ ...a.author, at: a.author?.at ?? a.at }),
    unrecorded: a.unrecorded || undefined,
    tasks: a.version ? undefined : a.tasks,
    editable: a.editable,
    note: a.message,
    text: a.text === null ? a.textMessage : undefined,
  };
  if (opt.out && opt.out !== true && a.text !== null) {
    fs.writeFileSync(expandHome(opt.out), a.text);
    return { ...head, out: expandHome(opt.out) };
  }
  out(head);
  if (a.text !== null) {
    console.log('=== TEXT ===');
    process.stdout.write(a.text);
  }
  return undefined;
}

// Запись артефакта из файла как правка пользователя. База — --base (хэш из artifact, когда правка сделана по прочитанному
// тексту: чужое изменение после чтения даст conflict) или хэш из свежего GET. --resume — «Сохранить и возобновить» (только на паузе).
async function artifactWrite(pos, opt) {
  const [id, key] = pos;
  if (!id || !key) fail('нужно: artifact-write <runId> <key> --file F [--base HASH] [--resume]');
  if (!opt.file || opt.file === true) fail('--file: укажи файл с новым текстом артефакта');
  const text = fs.readFileSync(expandHome(opt.file), 'utf8');
  await need('artifacts');
  const url = `/api/runs/${id}/artifacts/${encodeURIComponent(key)}`;
  const base = opt.base && opt.base !== true ? String(opt.base) : (await api('GET', url)).hash;
  try {
    const r = await api('PUT', url, { text, base, resume: Boolean(opt.resume), via: 'skill' });
    return {
      ok: true,
      hash: r.hash,
      resumed: r.resumed,
      // эти этапы уже получили прежнюю версию: правка дойдёт до них со следующего шага
      readers: r.readers?.length ? r.readers : undefined,
    };
  } catch (err) {
    const d = err.data || {};
    switch (err.code) {
      case 'conflict': fail(`${err.message}: последним изменил ${who({ ...d.author, at: d.author?.at ?? d.at }) || 'неизвестно'}. Перечитай (artifact) и повтори с новой базой ${d.hash}`);
      case 'locked': fail(`${err.message}. Подожди конца шага (или поставь паузу: pause) и повтори`);
      case 'readonly': fail(`${err.message} (${d.reason})`);
      case 'not_paused': fail(`${err.message}. Без --resume правка сохраняется и на идущем запуске`);
      default: throw err;
    }
  }
}

const { pos, opt } = parseArgs(process.argv.slice(2));
const cmd = pos.shift();
try {
  switch (cmd) {
    case 'ensure': out(await ensure()); break;
    case 'flows': await ensure(); out(await flows()); break;
    case 'draft': await ensure(); out(await draft(pos, opt)); break;
    case 'start': await ensure(); out(await start(pos, opt)); break;
    case 'save-flow': out(await saveFlow(pos, opt)); break;
    case 'continue': await ensure(); out(await cont(pos, opt)); break;
    case 'wait': out(await wait(pos, opt)); break;
    case 'answer': out(await answer(pos, opt)); break;
    case 'status': out(summary(await api('GET', `/api/runs/${pos[0]}`))); break;
    case 'pause': out(await api('POST', `/api/runs/${pos[0]}/pause`)); break;
    case 'resume': out(await resume(pos, opt)); break;
    case 'abort': out(await api('POST', `/api/runs/${pos[0]}/abort`)); break;
    case 'artifacts': out(await artifacts(pos)); break;
    case 'artifact': { const r = await artifact(pos, opt); if (r) out(r); break; }
    case 'artifact-write': out(await artifactWrite(pos, opt)); break;
    default: fail('команды: ensure | flows | draft --task-file F [--cwd DIR] [--out F.yaml] [--model M] | start (<flow> | --spec-file F.yaml) --cwd DIR [--input TEXT | --input-file F] [--add-dir DIR]... [--attach FILE]... [--max-iterations N] [--max-budget USD] [--model M] | continue <id> [--max-budget USD] [--model M] | wait <id> [--timeout SEC] | answer <id> <qid> --json J | status <id> | pause <id> | resume <id> [--answer-file F] | abort <id> | save-flow <id> [--name N] [--folder D] | artifacts <id> | artifact <id> <key> [--version N] [--out F] | artifact-write <id> <key> --file F [--base HASH] [--resume]');
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
