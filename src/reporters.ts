// Консольный вывод событий раннера (для CLI).
import fs from 'node:fs';
import path from 'node:path';
import { truncate } from './agent.js';
import { WRITE_TOOLS, type Denial } from './artifacts.js';
import { ARTIFACTS_DIR } from './artifact-store.js';
import type { BlockReport, RunEvent, RunReport, RunStatus, TagSummaryReport } from './runner.js';
import { c, fmtMs, fmtUsd } from './ui.js';

const CONDITION_LABEL: Record<BlockReport['condition'], string> = {
  command: 'условие — команда',
  judge: 'условие — судья',
  marker: 'условие — маркер',
  none: 'без условия',
};

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'выполняется',
  done: 'готово',
  max_iterations: 'лимит итераций',
  failed: 'ошибка',
  budget_exceeded: 'лимит стоимости',
  aborted: 'прервано',
  interrupted: 'оборвался',
};

export function consoleReporter(verbose: boolean): (e: RunEvent) => void {
  const colorStatus = (s: RunStatus) =>
    s === 'done' ? c.green(STATUS_LABEL[s]) : s === 'max_iterations' ? c.yellow(STATUS_LABEL[s]) : c.red(STATUS_LABEL[s]);

  let multi = false;
  let block: BlockReport | undefined;
  // этапы параллельной группы печатаются отдельными строками с именем, их лог — с префиксом [этап]: иначе строки склеятся
  const grouped = new Map<string, string>();
  // событие artifacts несёт состояние шага целиком: печатаем только то, чего ещё не печатали
  const printed = new Set<string>();
  const once = (key: string) => !printed.has(key) && Boolean(printed.add(key));

  return (e) => {
    switch (e.type) {
      case 'start':
        console.log(`${c.bold('Flow')} ${e.report.flow}  ·  ${c.dim(e.report.runDir)}`);
        if (e.report.description) console.log(c.dim(e.report.description));
        if (e.report.artifacts) {
          const from = e.report.artifacts.from ? `, из запуска ${e.report.artifacts.from}` : '';
          console.log(c.dim(`Артефакты: ${e.report.artifacts.items.map((m) => m.title).join(', ')}${from}`));
          for (const w of e.report.artifacts.warnings) if (once(`run|${w}`)) console.log(c.yellow(`⚠ ${w}`));
        }
        break;
      case 'artifacts': {
        const d = e.step;
        if (!d) break;
        const where = `${d.block}|${d.iteration}`;
        const many = d.phases.length > 1;
        for (const p of d.phases) {
          const who = many ? `${p.phase}: ` : '';
          const changed = p.changed.filter((k) => once(`${where}|${p.phase}|c|${k}`));
          if (changed.length) console.log(c.dim(`  ${who}изменил: ${changed.join(', ')}`));
          const denied = denialLine(p.denials);
          if (denied && once(`${where}|${p.phase}|d|${denied}`)) console.log(c.yellow(`  ${who}${denied}`));
          for (const w of p.warnings) if (once(`${where}|${p.phase}|w|${w}`)) console.log(c.yellow(`  ⚠ ${who}${w}`));
        }
        if (d.condition) {
          const changed = d.condition.changed.filter((k) => once(`${where}|cond|c|${k}`));
          if (changed.length) console.log(c.dim(`  проверка условия изменила: ${changed.join(', ')}`));
          for (const w of d.condition.warnings) if (once(`${where}|cond|w|${w}`)) console.log(c.yellow(`  ⚠ ${w}`));
        }
        for (const w of d.run ?? []) if (once(`run|${w}`)) console.log(c.yellow(`⚠ ${w}`));
        break;
      }
      case 'block_start': {
        multi = e.total > 1;
        block = e.block;
        if (!multi) break;
        const b = e.block;
        const how = b.looped ? `цикл до ${b.maxIterations}, ${CONDITION_LABEL[b.condition] ?? b.condition}` : 'один проход';
        console.log(`\n${c.bold(`━━━ Блок ${b.index + 1}/${e.total}: ${b.title} ━━━`)} ${c.dim(how)}`);
        break;
      }
      case 'block_end':
        if (e.block.status === 'max_iterations' && e.block.onFail === 'continue') {
          console.log(c.yellow(`↷ Блок ${e.block.title}: условие не выполнено за ${e.block.iterations} итераций, по on_fail: continue иду дальше`));
        }
        break;
      case 'iteration':
        if (!block?.looped) break;
        console.log(multi ? `\n${c.bold(`── итерация ${e.iteration}/${e.max}`)}` : `\n${c.bold(`━━━ Итерация ${e.iteration}/${e.max} ━━━`)}`);
        break;
      case 'phase_start':
        if (e.group) {
          grouped.set(e.phase, e.title);
          console.log(`${c.cyan('▶')} ${e.title} ${c.dim(`[${e.tools.join(', ') || 'без инструментов'}] · параллельно, группа ${e.group}`)}`);
          break;
        }
        process.stdout.write(`${c.cyan('▶')} ${e.title} ${c.dim(`[${e.tools.join(', ') || 'без инструментов'}]`)} … `);
        if (verbose) process.stdout.write('\n');
        break;
      case 'log':
        // префикс на каждой строке: многострочное сообщение одного участника перемешается со строками соседа
        if (verbose) process.stdout.write(c.dim(grouped.has(e.phase) ? e.line.replace(/^/gm, `[${e.phase}] `) : e.line) + '\n');
        break;
      case 'phase_end': {
        const r = e.report;
        const used = [r.model, r.effort].filter(Boolean).join(' · ');
        const stats = c.dim(`${r.turns} ходов · ${fmtMs(r.durationMs)} · ${fmtUsd(r.costUsd)} · ${r.chars} знаков${used ? ` · ${used}` : ''}`);
        const who = grouped.has(r.phase) ? `${grouped.get(r.phase)} ` : '';
        grouped.delete(r.phase);
        if (r.ok) console.log(`${c.green('✓')} ${who}${stats}`);
        else console.log(`${c.yellow('!')} ${who}${r.subtype} ${stats}${r.errors.length ? '\n  ' + c.red(r.errors.join('\n  ')) : ''}`);
        break;
      }
      case 'condition_start':
        if (e.kind === 'command') process.stdout.write(`${c.cyan('$')} ${e.detail} … `);
        else if (e.kind === 'judge') process.stdout.write(`${c.cyan('⚖')} судья … `);
        break;
      case 'condition': {
        const r = e.report;
        if (r.type === 'command' || r.type === 'judge') console.log(r.done ? c.green('ok') : c.yellow('не ok'));
        console.log(
          r.type === 'none'
            ? c.dim('• Итерация завершена (условия нет)')
            : r.done
              ? `${c.green('✔ Условие выполнено')}${r.detail ? c.dim(` — ${truncate(r.detail, 200)}`) : ''}`
              : `${c.yellow('↻ Условие не выполнено')}${r.detail ? c.dim(` — ${truncate(r.detail, 200)}`) : ''}`,
        );
        break;
      }
      case 'question':
        if (verbose) console.log(c.dim(`\n(ожидаю ответ на вопрос этапа ${e.question.phase})`));
        break;
      case 'answer':
        console.log(c.dim(`ответ принят, продолжаю этап ${e.question.phase}`));
        break;
      case 'tag_summary_start':
        process.stdout.write(`${c.cyan('✎')} Обновляю саммари тега ${e.tag} … `);
        break;
      case 'tag_summary':
        console.log(e.report.ok ? c.green(`ok ${c.dim(fmtUsd(e.report.costUsd))}`) : c.yellow('не вышло'));
        break;
      case 'title':
        // без -v строка этапа ещё не закончена («▶ этап … »): имя тогда печатается в итоге
        if (verbose && e.title) console.log(c.dim(`Имя запуска: ${e.title}`));
        break;
      case 'end': {
        const r = e.report;
        if (r.title) console.log(`\n${c.bold('Имя запуска:')} ${r.title}`);
        console.log(`${r.title ? '' : '\n'}${c.bold('Итог:')} ${colorStatus(r.status)}  ·  итераций: ${r.iterations}  ·  оценка по прайсу API: ${fmtUsd(r.totalCostUsd)}`);
        if (r.error) console.log(c.red(r.error));
        for (const s of r.tagSummaries ?? []) console.log(tagLine(s));
        printFinal(r);
        console.log(c.dim(`Логи: ${r.runDir}`));
        if (r.artifacts) console.log(c.dim(`Артефакты: ${path.join(r.runDir, ARTIFACTS_DIR)}`));
        break;
      }
    }
  };
}

/** Строка о теге в итоге: обновлено саммари или почему нет. */
function tagLine(s: TagSummaryReport): string {
  if (s.ok) return c.green(`Саммари тега ${s.tag} обновлено`) + c.dim(` · ${fmtUsd(s.costUsd)}`);
  const why = s.error ?? s.skipped ?? 'нет данных';
  return (s.error ? c.yellow : c.dim)(`Саммари тега ${s.tag} не обновлено: ${why}`);
}

/** «отказов записи: N · отказов чтения: M» по отказам guard этапа; пусто — отказов не было. */
function denialLine(denials: Denial[]): string {
  const sum = (write: boolean) => denials.filter((d) => WRITE_TOOLS.includes(d.tool) === write).reduce((n, d) => n + d.count, 0);
  const parts = [];
  if (sum(true)) parts.push(`отказов записи: ${sum(true)}`);
  if (sum(false)) parts.push(`отказов доступа: ${sum(false)}`);
  return parts.join(' · ');
}

const FINAL_OUTPUT_MAX = 4000;

/** Вывод последнего шага под строкой «Итог:»; у группы — каждый участник под своим заголовком. Длинный обрезается. */
function printFinal(r: RunReport): void {
  const final = r.final ?? [];
  for (const f of final) {
    const file = f.output ? path.join(r.runDir, f.output) : '';
    let text: string | undefined;
    try {
      text = file ? fs.readFileSync(file, 'utf8').trim() : undefined;
    } catch {
      // файла вывода нет — печатаем только заголовок
    }
    const head = `${f.ok ? c.green('✓') : c.yellow('!')} ${final.length > 1 ? `Вывод этапа ${f.title}` : `Вывод последнего этапа (${f.title})`}`;
    console.log(`\n${c.bold(head)}`);
    if (text === undefined) {
      console.log(c.dim(file ? `нет файла ${file}` : 'вывода нет'));
      continue;
    }
    if (text.length > FINAL_OUTPUT_MAX) {
      console.log(text.slice(0, FINAL_OUTPUT_MAX).trimEnd() + '…');
      console.log(c.dim(`(показано ${FINAL_OUTPUT_MAX} из ${text.length} знаков, полностью: ${file})`));
    } else console.log(text);
  }
}
