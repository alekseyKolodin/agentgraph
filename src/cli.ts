#!/usr/bin/env node
// CLI: agentgraph "<задача>" | gen "<задача>" | edit flow "<правка>" | run flow.yaml | show flow.yaml | eval flow --tasks | ui
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import { parse as parseYaml } from 'yaml';
import { flowBlocks, type FlowSpec, type Phase } from './schema.js';
import { artifactAccess, declaredArtifacts } from './artifacts.js';
import { generateFlow } from './generate.js';
import { describeCondition, flowFileName, flowToYaml, loadFlow, resolveFlowFile } from './flows.js';
import { editBase, editFlow } from './edit.js';
import { runFlow, type QuestionRecord, type RunOptions } from './runner.js';
import type { AskAnswers } from './agent.js';
import { consoleReporter } from './reporters.js';
import { startServer } from './server.js';
import { RUNS_DIR, WEB_DIST_DIR } from './paths.js';
import { c, fmtUsd } from './ui.js';
import { createTag, listTags, readTag, runTagSlugs, splitRunTags, tagsRunDirs, withTagsInput } from './tags.js';
import { pickAutoTag, type AutoTagReport } from './auto-tag.js';
import { pickRunTitle } from './run-title.js';
import { evalDir, formatEvalTable, loadTasks, runEval } from './eval.js';

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
  agentgraph tags                  список тегов (задачи и области знаний) с началом саммари или заметок
  agentgraph ui                    поднять веб-интерфейс (по умолчанию http://127.0.0.1:4747)

Опции:
  --cwd <dir>             директория проекта (по умолчанию текущая)
  -o, --out <file>        куда сохранить сгенерированный flow
  --once                  разовый запуск: flow не пишется в flows/, его копия — только runs/<id>/flow.yaml
  --input <text>          переопределить задачу ({{input}}) при запуске готового flow
  --max-iterations <n>    переопределить лимит итераций (у каждого блока с циклом)
  --max-budget <usd>      лимит стоимости, $: остановить запуск, если оценка превысит
  --model <id>            модель по умолчанию для всех сессий
  --tag <slug>            тег (можно несколько раз). Тег задачи: саммари, заметки и пути — в задачу, после done — обновить саммари.
                          Тег знаний: в промпты этапов каждого блока — строка с описанием, полный текст этап берёт инструментом
                          knowledge_read по запросу (тег с «всегда в промпт» — целиком). Новый слаг — тег задачи
  --no-save-tag           с --tag: не обновлять саммари тегов задачи после запуска
  --auto-tag              без тега задачи среди --tag: ИИ по тексту задачи заведёт новый тег задачи (слаг занят — с суффиксом -2…),
                          после done запишет его саммари. Продолжить фичу — --tag <её слаг>
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
  --max-budget, --model, --max-iterations действуют на каждый запуск; --tag, --auto-tag, --once, -o, --input с eval несовместимы.
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
  };

  const [cmd, ...rest] = positionals;
  if (values.once && ['gen', 'edit', 'run', 'show', 'ui', 'tags', 'eval'].includes(cmd)) return fail('--once — только для формы agentgraph "<задача>": сгенерировать и запустить без сохранения');
  if (values.once && values.out) return fail('--once не сохраняет flow: убери -o или --once');
  const tags = runTagSlugs(values.tag);
  const autoTag = values['auto-tag'];
  if (autoTag && values['no-save-tag']) return fail('--auto-tag с --no-save-tag: автотег без саммари бесполезен');
  if (values['no-save-tag'] && !tags.length) return fail('--no-save-tag — только вместе с --tag');
  if (tags.length && ['gen', 'edit', 'show', 'ui', 'tags', 'eval'].includes(cmd)) return fail('--tag — только для запуска: agentgraph run <flow> --tag <slug>');
  if (autoTag && ['gen', 'edit', 'show', 'ui', 'tags', 'eval'].includes(cmd)) return fail('--auto-tag — только для запуска: agentgraph run <flow> --auto-tag');
  if (cmd !== 'eval' && (values.tasks || values.runs || values.compare || values.json)) return fail('--tasks, --runs, --compare и --json — только для eval: agentgraph eval <flow> --tasks <tasks.yaml>');
  if (cmd === 'eval' && values.out) return fail('eval ничего не генерирует: убери -o');
  if (cmd === 'eval' && values.input) return fail('eval берёт задачи из --tasks: убери --input');
  switch (cmd) {
    case 'tags': {
      const list = listTags();
      if (!list.length) console.log(c.dim('Тегов нет: заведи при запуске, agentgraph run <flow> --tag <slug>'));
      for (const t of list) {
        const first = t.preview.split('\n').find((l) => l.trim()) ?? '';
        const knows = t.kind === 'knowledge';
        console.log(`${c.bold(t.slug)}${t.title ? ` — ${t.title}` : ''} ${c.dim(`· ${knows ? 'знание' : `задача · запусков: ${t.runs}`} · ${t.updatedAt.slice(0, 16).replace('T', ' ')}`)}`);
        console.log(c.dim(`  ${first || (knows ? 'заметок ещё нет' : 'саммари ещё нет')}`));
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
      fs.writeFileSync(file, r.yaml.endsWith('\n') ? r.yaml : r.yaml + '\n');
      console.log(`\n${c.green('✓')} Сохранил ${c.bold(file)}`);
      printPlan(r.spec);
      return 0;
    }
    case 'run': {
      if (!rest[0]) return fail('Укажи flow: agentgraph run flows/<name>.yaml');
      const spec = loadFlow(rest[0]);
      if (values.input) spec.input = values.input;
      const tagOpts = await withTags(spec, tags, !values['no-save-tag'], autoTag);
      printPlan(spec);
      const report = await runFlow(spec, { ...runOpts, ...tagOpts, nameRun: nameRunFor(spec) });
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
      const url = await startServer({ port: values.port ? Number(values.port) : 4747, host: '127.0.0.1', defaultCwd: cwd, notify: !values['no-notify'] });
      console.log(`${c.green('●')} agentgraph ui: ${c.bold(url)}  ${c.dim(`(директория проекта по умолчанию: ${cwd})`)}`);
      // npm run ui собирает UI сам (scripts/ensure-web.mts); agentgraph ui и tsx src/cli.ts ui — нет
      if (!fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) console.warn(c.yellow('UI не собран, на / его нет: npm run build:web (или запускай через npm run ui)'));
      return await new Promise<number>(() => {});
    }
    default: {
      const task = positionals.join(' ').trim();
      const { spec } = await generate(task, cwd, values.out, values.model, abort, !values.once);
      const tagOpts = await withTags(spec, tags, !values['no-save-tag'], autoTag);
      const report = await runFlow(spec, { ...runOpts, adhoc: values.once, ...tagOpts, nameRun: nameRunFor(spec) });
      return report.status === 'done' ? 0 : 2;
    }
  }
}

/** Имя запуска придумывает модель, как у сервера: параллельно этапам, сбой — запуск без имени. */
function nameRunFor(spec: FlowSpec): NonNullable<RunOptions['nameRun']> {
  return (input, signal) => pickRunTitle(input, { flow: spec.name }, { signal });
}

/**
 * Теги запуска, как у сервера: несуществующие заводятся тегами задачи, блоки тегов задачи — в начало задачи, папки чтения —
 * отдельно от addDirs; теги знаний — в knowledge запуска (их разделы раннер добавит этапам каждого блока).
 * autoTag и нет тега задачи — новый тег заводит ИИ по тексту задачи (pickAutoTag); сбой подбора — запуск без тега.
 */
async function withTags(spec: FlowSpec, slugs: string[], saveTag: boolean, autoTag: boolean): Promise<Pick<RunOptions, 'tags' | 'saveTag' | 'tagDirs' | 'knowledge' | 'autoTag'>> {
  for (const s of slugs) createTag(s);
  const split = splitRunTags(slugs);
  let picked: AutoTagReport | undefined;
  if (autoTag && !split.task.length) {
    process.stdout.write(`${c.cyan('✎')} Завожу тег задачи … `);
    picked = await pickAutoTag(spec.input ?? '', { flow: spec.name });
    const tag = picked.slug ? readTag(picked.slug) : undefined;
    if (tag) {
      split.task.push(tag);
      console.log(`${c.green('✓')} Тег заведён: ${c.bold(tag.slug)}${tag.title ? ` — ${tag.title}` : ''} ${c.dim(`оценка ${fmtUsd(picked.costUsd)}`)}`);
    } else console.log(c.yellow(`Тег не заведён: ${picked.error ?? 'тега нет на диске'}. Запуск пойдёт без тега`));
  } else if (autoTag) console.log(c.dim('--auto-tag ни на что не влияет: тег задачи уже выбран через --tag'));
  const { task, knowledge } = split;
  if (task.length) spec.input = withTagsInput(spec.input ?? '', task);
  for (const t of task) console.log(c.dim(`Тег ${t.slug}: ${t.summary.trim() || t.notes.trim() ? 'добавлен в задачу' : 'новый, саммари ещё нет'}`));
  for (const t of knowledge) console.log(c.dim(`Тег знаний ${t.slug}: уйдёт в промпты этапов каждого блока`));
  if (!saveTag) console.log(c.dim(task.length ? 'Саммари тегов после запуска не обновится' : '--no-save-tag ни на что не влияет: тегов задачи среди выбранных нет'));
  return {
    ...(task.length ? { tags: task.map((t) => t.slug), saveTag, tagDirs: tagsRunDirs(task, RUNS_DIR) } : {}),
    ...(knowledge.length ? { knowledge: knowledge.map((t) => t.slug) } : {}),
    ...(picked ? { autoTag: picked } : {}),
  };
}

/** save: false — разовый запуск: flow не пишется на диск (и flowFileName не создаёт папку). */
async function generate(task: string, cwd: string, out: string | undefined, model: string | undefined, abort: AbortController, save = true) {
  process.stdout.write(`${c.cyan('✎')} Генерирую flow для задачи … `);
  const { spec, result } = await generateFlow(task, { cwd, model, abort });
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
    b.phases.forEach((p, i) => {
      console.log(`${pad}${i + 1}. ${c.bold(p.title ?? p.name)} ${c.dim(`[${p.tools.join(', ') || 'без инструментов'}]${arts.length ? accessLine(p) : ''}`)}`);
      if (full) console.log(c.dim(indent(p.prompt.trim(), pad + '   ')));
    });
    const until = b.loop?.until;
    if (full && until?.type === 'judge') console.log(`${pad}судья:\n${c.dim(indent(until.prompt.trim(), pad + '   '))}`);
  });
  console.log();
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
