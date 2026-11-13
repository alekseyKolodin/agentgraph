#!/usr/bin/env node
// CLI: agentgraph "<задача>" | gen "<задача>" | edit flow "<правка>" | run flow.yaml | show flow.yaml | eval flow --tasks | ui
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import { parse as parseYaml } from 'yaml';
import { flowBlocks, isCallBlock, type FlowSpec, type Phase } from './schema.js';
import { describeNext } from './compose.js';
import { artifactAccess, declaredArtifacts } from './artifacts.js';
import { generateFlow } from './generate.js';
import { checkCalls, describeCondition, flowFileName, flowToYaml, loadFlow, resolveFlowFile } from './flows.js';
import { editBase, editFlow } from './edit.js';
import { runFlow, type QuestionRecord, type RunOptions } from './runner.js';
import type { AskAnswers } from './agent.js';
import { consoleReporter } from './reporters.js';
import { startServer, stopServer } from './server.js';
import { execveRestart } from './update.js';
import { RUNS_DIR, WEB_DIST_DIR } from './paths.js';
import { c, fmtUsd } from './ui.js';
import { knowledgeTags, listTags, runTagSlugs } from './tags.js';
import { createSpace, listSpaces, readSpace, setMigrationRunsDir, spaceReadDirs, spaceSlug, type Space } from './spaces.js';
import { pickAutoSpace, type AutoSpaceReport } from './auto-space.js';
import { pickRunTitle } from './run-title.js';
import { evalDir, formatEvalTable, loadTasks, runEval } from './eval.js';

// перенос тегов задач (первое обращение к пространствам) ищет их запуски в этой папке запусков
setMigrationRunsDir(RUNS_DIR);

const HELP = `agentgraph — задача -> flow.yaml -> цепочка сессий Claude в цикле

Использование:
  agentgraph "<задача>"            сгенерировать flow и сразу запустить
  agentgraph "<задача>" --once     разовый запуск: сгенерировать и запустить, flow не сохранять
  agentgraph gen "<задача>"        только сгенерировать flow.yaml
  agentgraph edit <flow> "<правка>" поправить flow по описанию (ИИ правит файл на месте)
  agentgraph run <flow|file.yaml>  запустить готовый flow
  agentgraph show <flow|file.yaml> показать план flow
  agentgraph eval <flow|file.yaml> --tasks <tasks.yaml> [--runs N] [--compare <flow2|file.yaml>] [--json out.json]
                                   сквозной eval: прогнать набор задач через flow, посчитать долю решённых
  agentgraph spaces                список пространств (фича или проект: карта, документы, состояние «где мы сейчас»)
  agentgraph tags                  список тегов знаний с описанием или началом заметок
  agentgraph ui                    поднять веб-интерфейс (по умолчанию http://127.0.0.1:4747)

Опции:
  --cwd <dir>             директория проекта (по умолчанию текущая)
  -o, --out <file>        куда сохранить сгенерированный flow
  --once                  разовый запуск: flow не пишется в flows/, его копия — только runs/<id>/flow.yaml
  --input <text>          переопределить задачу ({{input}}) при запуске готового flow
  --max-iterations <n>    переопределить лимит итераций (у каждого блока с циклом)
  --max-budget <usd>      лимит стоимости, $: остановить запуск, если оценка превысит
  --model <id>            модель по умолчанию для всех сессий
  --space <slug>          пространство запуска: его карта (CLAUDE.md) — памятью у всех этапов, документы — по запросу,
                          состояние «где мы сейчас» — в конец промпта каждого этапа; после done — обновить состояние.
                          Нового слага — пустое пространство (карту заполни на странице пространства)
  --no-save-state         с --space: не обновлять состояние пространства после запуска
  --auto-space            без --space: ИИ по тексту задачи заведёт новое пространство (слаг занят — с суффиксом -2…),
                          после done запишет его состояние. Продолжить фичу — --space <её слаг>
  --knowledge <slug>      тег знаний (можно несколько раз): в промпты этапов каждого блока — строка с описанием, полный
                          текст этап берёт инструментом knowledge_read (тег с «всегда в промпт» — целиком)
  --port <n>              порт для ui
  --no-notify             ui: без системных уведомлений о вопросах агента и конце запуска
  -v, --verbose           печатать ход сессий (текст и вызовы инструментов)
  -h, --help

Eval (agentgraph eval):
  --tasks <tasks.yaml>    набор задач (обязательно):
                            tasks:
                              - name: fix-tests                 # латиница, цифры, - и _
                                input: "Почини падающие тесты"  # задача ({{input}})
                                cwd: ~/code/repo                # необязательно; иначе --cwd (от папки tasks.yaml)
                                setup: git checkout -- . && git clean -fd   # необязательно: shell перед каждым прогоном
                                check: npm test                 # необязательно: shell после прогона, 0 = решена
                                timeout_sec: 600                # необязательно: таймаут setup и check
                          без check задача решена, если запуск done; с check — done и код выхода 0
  --runs <n>              прогонов каждой задачи на каждый flow (по умолчанию 1; советуем 2: поломки
                          проявляются в одном из двух прогонов)
  --compare <flow2>       второй flow на том же наборе: в итоге раздел «перевернувшиеся задачи»
  --json <file>           копия results.json по этому пути (основной — runs/evals/<дата>-<flow>[-vs-<flow2>]/results.json)
  --max-budget, --model, --max-iterations действуют на каждый запуск; --space, --auto-space, --knowledge, --once, -o, --input с eval несовместимы.
  Вопросы агента (AskUserQuestion) в eval отклоняются, пауз нет: flow с AskUserQuestion и pause_marker для eval не годятся.
  Запуски eval лежат в runs/ как обычные (имя «eval <flow> · <задача> #<n>») и видны в UI.
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      out: { type: 'string', short: 'o' },
      once: { type: 'boolean', default: false },
      input: { type: 'string' },
      'max-iterations': { type: 'string' },
      'max-budget': { type: 'string' },
      model: { type: 'string' },
      space: { type: 'string' },
      'no-save-state': { type: 'boolean', default: false },
      'auto-space': { type: 'boolean', default: false },
      knowledge: { type: 'string', multiple: true },
      // теги задач заменены пространствами: старые флаги — только чтобы подсказать новые
      tag: { type: 'string', multiple: true },
      'no-save-tag': { type: 'boolean', default: false },
      'auto-tag': { type: 'boolean', default: false },
      port: { type: 'string' },
      'no-notify': { type: 'boolean', default: false },
      tasks: { type: 'string' },
      runs: { type: 'string' },
      compare: { type: 'string' },
      json: { type: 'string' },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return positionals.length === 0 && !values.help ? 1 : 0;
  }

  const cwd = path.resolve(values.cwd ?? process.cwd());
  const abort = new AbortController();
  process.on('SIGINT', () => {
    console.log(c.red('\nПрерывание: останавливаю текущую сессию…'));
    abort.abort();
  });
  const runOpts = {
    cwd,
    runsDir: RUNS_DIR,
    maxIterations: values['max-iterations'] ? Number(values['max-iterations']) : undefined,
    maxBudgetUsd: values['max-budget'] ? Number(values['max-budget']) : undefined,
    model: values.model,
    abort,
    onEvent: consoleReporter(values.verbose),
    onQuestion: askInTerminal,
    runChild: childInTerminal(values.verbose, 1),
  };

  const [cmd, ...rest] = positionals;
  const noRun = ['gen', 'edit', 'show', 'ui', 'tags', 'spaces', 'eval'];
  if (values.once && ['run', ...noRun].includes(cmd)) return fail('--once — только для формы agentgraph "<задача>": сгенерировать и запустить без сохранения');
  if (values.once && values.out) return fail('--once не сохраняет flow: убери -o или --once');
  if (values.tag?.length || values['no-save-tag'] || values['auto-tag']) {
    return fail('Теги задач заменены пространствами: --space <slug> (вместо тега задачи), --no-save-state, --auto-space; теги знаний — --knowledge <slug>');
  }
  const space = spaceSlug(values.space);
  const knowledge = runTagSlugs(values.knowledge);
  const autoSpace = values['auto-space'];
  if (autoSpace && values['no-save-state']) return fail('--auto-space с --no-save-state: автопространство без состояния бесполезно');
  if (autoSpace && space) return fail('--auto-space заводит новое пространство: с --space <slug> он ни к чему');
  if (values['no-save-state'] && !space) return fail('--no-save-state — только вместе с --space');
  if ((space || knowledge.length) && noRun.includes(cmd)) return fail('--space и --knowledge — только для запуска: agentgraph run <flow> --space <slug>');
  if (autoSpace && noRun.includes(cmd)) return fail('--auto-space — только для запуска: agentgraph run <flow> --auto-space');
  if (cmd !== 'eval' && (values.tasks || values.runs || values.compare || values.json)) return fail('--tasks, --runs, --compare и --json — только для eval: agentgraph eval <flow> --tasks <tasks.yaml>');
  if (cmd === 'eval' && values.out) return fail('eval ничего не генерирует: убери -o');
  if (cmd === 'eval' && values.input) return fail('eval берёт задачи из --tasks: убери --input');
  switch (cmd) {
    case 'spaces': {
      const list = listSpaces();
      if (!list.length) console.log(c.dim('Пространств нет: заведи на странице «Пространства» или при запуске, agentgraph run <flow> --space <slug>'));
      for (const s of list) {
        const first = s.preview.split('\n').find((l) => l.trim()) ?? '';
        const what = [s.hasMap ? 'карта' : 'без карты', `документов: ${s.docs}`, s.updatedAt.slice(0, 16).replace('T', ' ')];
        console.log(`${c.bold(s.slug)}${s.title ? ` — ${s.title}` : ''} ${c.dim(`· ${what.join(' · ')}`)}`);
        console.log(c.dim(`  ${first || 'состояния ещё нет'}`));
      }
      return 0;
    }
    case 'tags': {
      const list = listTags();
      if (!list.length) console.log(c.dim('Тегов знаний нет: заведи на странице «Знания»'));
      for (const t of list) {
        const first = t.preview.split('\n').find((l) => l.trim()) ?? '';
        console.log(`${c.bold(t.slug)}${t.title ? ` — ${t.title}` : ''} ${c.dim(`· знание · ${t.updatedAt.slice(0, 16).replace('T', ' ')}`)}`);
        console.log(c.dim(`  ${first || 'заметок ещё нет'}`));
      }
      return 0;
    }
    case 'gen': {
      const task = rest.join(' ').trim();
      if (!task) return fail('Укажи задачу: agentgraph gen "<задача>"');
      await generate(task, cwd, values.out, values.model, abort);
      return 0;
    }
    case 'edit': {
      const [target, ...words] = rest;
      const instruction = words.join(' ').trim();
      if (!target || !instruction) return fail('Укажи flow и правку: agentgraph edit <flow> "<что поменять>"');
      const file = resolveFlowFile(target);
      const yaml = fs.readFileSync(file, 'utf8');
      // имя из поля name, даже если флоу сломан (редактор его починит); нет поля — из имени файла
      let name = path.basename(file).replace(/\.ya?ml$/, '');
      try {
        const raw = parseYaml(yaml) as { name?: unknown } | null;
        if (typeof raw?.name === 'string' && raw.name) name = raw.name;
      } catch {
        // YAML не разбирается — остаётся имя файла
      }
      process.stdout.write(`${c.cyan('✎')} Правлю flow ${c.bold(name)} … `);
      const r = await editFlow(name, instruction, editBase(name, { yaml }), { cwd, model: values.model, abort });
      console.log(c.dim(`оценка ${fmtUsd(r.costUsd)}`));
      if (r.summary) console.log(`\n${r.summary}`);
      if (!r.changed) {
        console.log(c.dim('\nФайл не изменился'));
        return 0;
      }
      // как сохранение в UI: вызываемые flow есть, без круга и не глубже лимита
      checkCalls(r.spec);
      fs.writeFileSync(file, r.yaml.endsWith('\n') ? r.yaml : r.yaml + '\n');
      console.log(`\n${c.green('✓')} Сохранил ${c.bold(file)}`);
      printPlan(r.spec);
      return 0;
    }
    case 'run': {
      if (!rest[0]) return fail('Укажи flow: agentgraph run flows/<name>.yaml');
      const spec = loadFlow(rest[0]);
      if (values.input) spec.input = values.input;
      const spaceOpts = await withSpace(spec, space, knowledge, !values['no-save-state'], autoSpace);
      printPlan(spec);
      const report = await runFlow(spec, { ...runOpts, ...spaceOpts, nameRun: nameRunFor(spec) });
      return report.status === 'done' ? 0 : 2;
    }
    case 'show': {
      if (!rest[0]) return fail('Укажи flow: agentgraph show flows/<name>.yaml');
      printPlan(loadFlow(rest[0]), true);
      return 0;
    }
    case 'eval': {
      if (!rest[0]) return fail('Укажи flow: agentgraph eval <flow> --tasks <tasks.yaml>');
      if (!values.tasks) return fail('Укажи набор задач: agentgraph eval <flow> --tasks <tasks.yaml>');
      const runs = values.runs ? Number(values.runs) : 1;
      if (!Number.isInteger(runs) || runs < 1) return fail('--runs: целое число от 1');
      const flows = [{ name: '', spec: loadFlow(rest[0]) }];
      if (values.compare) flows.push({ name: '', spec: loadFlow(values.compare) });
      // подпись flow в таблице — его имя; два варианта одного flow из файлов с одним name различаем суффиксом
      flows[0].name = flows[0].spec.name;
      if (flows[1]) flows[1].name = flows[1].spec.name === flows[0].name ? `${flows[1].spec.name} (2)` : flows[1].spec.name;
      const tasks = loadTasks(values.tasks);
      const outDir = evalDir(RUNS_DIR, flows.map((f) => f.name));
      console.log(`${c.bold('Eval')} ${flows.map((f) => f.name).join(c.dim(' vs '))}  ·  задач: ${tasks.length}, прогонов на задачу: ${runs}  ·  ${c.dim(outDir)}`);
      const result = await runEval({
        flows,
        tasks,
        runs,
        cwd,
        runsDir: RUNS_DIR,
        outDir,
        tasksFile: path.resolve(values.tasks),
        maxBudgetUsd: runOpts.maxBudgetUsd,
        maxIterations: runOpts.maxIterations,
        model: values.model,
        abort,
        onEvent: values.verbose ? runOpts.onEvent : undefined,
      });
      if (values.json) {
        fs.mkdirSync(path.dirname(path.resolve(values.json)), { recursive: true });
        fs.writeFileSync(path.resolve(values.json), JSON.stringify(result, null, 2));
      }
      console.log(`\n${formatEvalTable(result, true)}`);
      console.log(c.dim(`\nРезультаты: ${path.join(outDir, 'results.json')}${values.json ? `, копия ${path.resolve(values.json)}` : ''}`));
      return result.aborted ? 2 : 0;
    }
    case 'ui': {
      // автообновление: после него процесс перезапускается на месте с теми же аргументами (src/update.ts)
      const url = await startServer({ port: values.port ? Number(values.port) : 4747, host: '127.0.0.1', defaultCwd: cwd, notify: !values['no-notify'], update: true, restart: execveRestart(stopServer) });
      console.log(`${c.green('●')} agentgraph ui: ${c.bold(url)}  ${c.dim(`(директория проекта по умолчанию: ${cwd})`)}`);
      // npm run ui собирает UI сам (scripts/ensure-web.mts); agentgraph ui и tsx src/cli.ts ui — нет
      if (!fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) console.warn(c.yellow('UI не собран, на / его нет: npm run build:web (или запускай через npm run ui)'));
      return await new Promise<number>(() => {});
    }
    default: {
      const task = positionals.join(' ').trim();
      const { spec } = await generate(task, cwd, values.out, values.model, abort, !values.once);
      const spaceOpts = await withSpace(spec, space, knowledge, !values['no-save-state'], autoSpace);
      const report = await runFlow(spec, { ...runOpts, adhoc: values.once, ...spaceOpts, nameRun: nameRunFor(spec) });
      return report.status === 'done' ? 0 : 2;
    }
  }
}

/** Имя запуска придумывает модель, как у сервера: параллельно этапам, сбой — запуск без имени. */
function nameRunFor(spec: FlowSpec): NonNullable<RunOptions['nameRun']> {
  return (input, signal) => pickRunTitle(input, { flow: spec.name }, { signal });
}

/**
 * Пространство и теги знаний запуска, как у сервера: нового слага — пустое пространство, папки пространства — отдельно
 * от addDirs; теги знаний — в knowledge запуска (их разделы раннер добавит этапам каждого блока). autoSpace без
 * --space — новое пространство заводит ИИ по тексту задачи (pickAutoSpace); сбой подбора — запуск без пространства.
 */
async function withSpace(
  spec: FlowSpec,
  slug: string | undefined,
  knowledgeSlugs: string[],
  saveState: boolean,
  autoSpace: boolean,
): Promise<Pick<RunOptions, 'space' | 'saveState' | 'spaceDirs' | 'knowledge' | 'autoSpace'>> {
  const knowledge = knowledgeTags(knowledgeSlugs);
  let space: Space | undefined;
  if (slug) {
    space = readSpace(slug) ?? createSpace(slug);
    console.log(c.dim(`Пространство ${space.slug}: ${space.map.trim() ? 'карта — памятью этапов' : 'карты нет'}, ${space.state.trim() ? 'состояние — в промпты этапов' : 'состояния ещё нет'}`));
  }
  let picked: AutoSpaceReport | undefined;
  if (autoSpace) {
    process.stdout.write(`${c.cyan('✎')} Завожу пространство … `);
    picked = await pickAutoSpace(spec.input ?? '', { flow: spec.name });
    space = picked.slug ? readSpace(picked.slug) : undefined;
    if (space) console.log(`${c.green('✓')} Пространство заведено: ${c.bold(space.slug)}${space.title ? ` — ${space.title}` : ''} ${c.dim(`оценка ${fmtUsd(picked.costUsd)}`)}`);
    else console.log(c.yellow(`Пространство не заведено: ${picked.error ?? 'его нет на диске'}. Запуск пойдёт без пространства`));
  }
  for (const t of knowledge) console.log(c.dim(`Тег знаний ${t.slug}: уйдёт в промпты этапов каждого блока`));
  if (space && !saveState) console.log(c.dim('Состояние пространства после запуска не обновится'));
  return {
    // автопространство без состояния бесполезно: галочка для него не действует
    ...(space ? { space: space.slug, saveState: picked ? true : saveState, spaceDirs: spaceReadDirs(space, RUNS_DIR) } : {}),
    ...(knowledge.length ? { knowledge: knowledge.map((t) => t.slug) } : {}),
    ...(picked ? { autoSpace: picked } : {}),
  };
}

/** save: false — разовый запуск: flow не пишется на диск (и flowFileName не создаёт папку). */
async function generate(task: string, cwd: string, out: string | undefined, model: string | undefined, abort: AbortController, save = true) {
  console.log(`${c.cyan('✎')} Генерирую flow для задачи …`);
  // генератор сначала читает проект: без этих строк CLI минуту-другую молчит
  const log = (line: string) => {
    if (line.startsWith('▸ ')) console.log(c.dim(`  ${line.length > 120 ? line.slice(0, 119) + '…' : line}`));
  };
  const { spec, result } = await generateFlow(task, { cwd, model, abort, log });
  console.log(c.dim(`оценка ${fmtUsd(result.costUsd)}`));
  if (!save) {
    console.log(`${c.green('✓')} Разовый запуск: flow не сохраняется, его копия ляжет в папку запуска (flow.yaml)`);
    printPlan(spec);
    return { spec, file: undefined };
  }
  let file: string;
  if (out) {
    file = path.resolve(out);
  } else {
    const named = flowFileName(spec.name);
    spec.name = named.name;
    file = named.file;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, flowToYaml(spec));
  console.log(`${c.green('✓')} Сохранил ${c.bold(file)}`);
  printPlan(spec);
  return { spec, file };
}

function printPlan(spec: FlowSpec, full = false): void {
  console.log(`\n${c.bold(spec.name)}${spec.description ? c.dim(' — ' + spec.description) : ''}`);
  const blocks = flowBlocks(spec);
  const multi = blocks.length > 1;
  const pad = multi ? '    ' : '  ';
  const arts = declaredArtifacts(spec);
  if (arts.length) {
    const list = arts.map((a) => `${a.title === a.key ? a.key : `${a.title} (${a.key})`} — ${a.file}${a.decisions ? ', ответы на паузу' : ''}`);
    console.log(`  ${c.bold('Артефакты:')} ${list.join('; ')}`);
  }
  blocks.forEach((b, bi) => {
    const loop = b.loop
      ? `цикл: до ${b.loop.max_iterations} итераций, ${describeCondition(b)}${b.on_fail === 'continue' ? ', затем дальше в любом случае' : ''}`
      : 'один проход';
    if (multi) console.log(`  ${c.bold(`Блок ${bi + 1}. ${b.title ?? b.name}`)} ${c.dim(`— ${loop}`)}`);
    else console.log(`  ${loop}`);
    // блок-вызов: его этапы — в вызываемом flow; задача вызова — шаблон input
    if (isCallBlock(b)) {
      console.log(`${pad}↪ ${c.bold(`вызов flow ${b.flow}`)} ${c.dim('— отдельный запуск, итог уходит дальше в {{prev}}')}`);
      if (full && b.input !== undefined) console.log(c.dim(indent(b.input.trim(), pad + '   ')));
    } else {
      b.phases.forEach((p, i) => {
        console.log(`${pad}${i + 1}. ${c.bold(p.title ?? p.name)} ${c.dim(`[${p.tools.join(', ') || 'без инструментов'}]${arts.length ? accessLine(p) : ''}`)}`);
        if (full) console.log(c.dim(indent(p.prompt.trim(), pad + '   ')));
      });
    }
    const until = b.loop?.until;
    if (full && until?.type === 'judge') console.log(`${pad}судья:\n${c.dim(indent(until.prompt.trim(), pad + '   '))}`);
    if (b.next !== undefined) console.log(`${pad}${c.dim(`после блока: ${describeNext(b)}`)}`);
  });
  console.log();
}

/** Дочерний запуск блока-вызова в терминале: его ход печатается под строкой блока, с отступом «│ » на уровень вызова. */
function childInTerminal(verbose: boolean, depth: number): NonNullable<RunOptions['runChild']> {
  return (spec, o) => runFlow(spec, { ...o, onEvent: consoleReporter(verbose, '│ '.repeat(depth)), runChild: childInTerminal(verbose, depth + 1) });
}

/** Вопросы агента в терминале: номер варианта (через запятую для multiSelect) или свой текст. */
async function askInTerminal(q: QuestionRecord): Promise<AskAnswers> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answers: AskAnswers = {};
  try {
    console.log(`\n${c.bold(`❓ Этап «${q.title}» спрашивает:`)}`);
    if (q.preface) console.log(`\n${q.preface}`);
    for (const item of q.questions) {
      console.log(`\n${c.cyan(item.header)}: ${item.question}`);
      item.options.forEach((o, i) => console.log(`  ${i + 1}. ${c.bold(o.label)}${o.description ? c.dim(' — ' + o.description) : ''}`));
      console.log(c.dim(item.multiSelect ? '  (номера через запятую или свой ответ)' : '  (номер или свой ответ)'));
      const raw = (await rl.question('Ответ: ')).trim();
      const idx = raw.split(',').map((x) => parseInt(x.trim(), 10) - 1).filter((i) => !Number.isNaN(i) && i >= 0 && i < item.options.length);
      answers[item.question] = idx.length ? idx.map((i) => item.options[i].label).join(', ') : raw;
    }
  } finally {
    rl.close();
  }
  return answers;
}

/** « · читает: plan · пишет: progress» — доступ этапа к артефактам; без доступа — пусто. */
function accessLine(p: Phase): string {
  const a = artifactAccess(p);
  const read = a.read.filter((k) => !a.write.includes(k));
  return `${read.length ? ` · читает: ${read.join(', ')}` : ''}${a.write.length ? ` · пишет: ${a.write.join(', ')}` : ''}`;
}

function indent(s: string, pad: string): string {
  return s.split('\n').map((l) => pad + l).join('\n');
}

function fail(msg: string): number {
  console.error(c.red(msg));
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(c.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
