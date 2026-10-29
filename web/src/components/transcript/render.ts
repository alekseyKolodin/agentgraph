// Транскрипт и живой лог узлами DOM (разбор — lib/run/transcript.ts): окно транскрипта этапа, вкладка «Лог», хвосты лога
// на «Обзоре» и в инспекторе. Одна отрисовка на все места: живой лог пишется мимо React (screens/run/RunLog.tsx), окно —
// тем же кодом. Текст агента — markdown: renderMarkdown экранирует всё сам, его результат — единственное, что кладётся
// в innerHTML; остальное — textContent и ссылки на пути.
import { t } from '../../lib/i18n';
import { markdownFits, renderMarkdown } from '../../lib/md';
import { callsIn, logItem, parseLine, shownPath, stepsLine, STEPS_OPEN_MAX, type LogState, type TxBlock, type TxStep } from '../../lib/run/transcript';
import { appendPaths, PATH_TEXT_MAX, pathAnchor } from '../PathLink';
import styles from './Transcript.module.css';

const cx = (...list: (string | false | undefined)[]) => list.filter(Boolean).join(' ');

/** Для подписей путей: домашняя папка (~) и открытый запуск (его файлы — от папки запуска). */
export type TxCtx = { home?: string; run?: string };

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Текст с путями-ссылками; огромный — без ссылок, как PathText. */
function putText(node: HTMLElement, text: string): void {
  if (text.length > PATH_TEXT_MAX) node.textContent = text;
  else appendPaths(node, text);
}

/** Строка: колонка значка и тело. Значок не выделяется и не копируется вместе с текстом. */
function row(cls: string | undefined, glyph: string, tag = 'div'): { row: HTMLElement; body: HTMLElement } {
  const r = el(tag, cx(styles.row, cls));
  const g = el('span', styles.glyph, glyph);
  g.setAttribute('aria-hidden', 'true');
  const body = el('span', styles.body);
  r.append(g, body);
  return { row: r, body };
}

/** Текст агента — markdown; огромный или со сбоем рендерера — как есть. */
function textRow(text: string): HTMLElement {
  const { row: r, body } = row(styles.text, '●', 'div');
  if (markdownFits(text)) {
    try {
      const md = el('div', 'md');
      md.innerHTML = renderMarkdown(text);
      body.append(md);
      return r;
    } catch {
      /* как есть ниже */
    }
  }
  const plain = el('div', styles.plain);
  putText(plain, text);
  body.append(plain);
  return r;
}

/** Вызов «● Имя(аргумент)» — исходная строка в подсказке; результат «└ текст» — тише, под именем, ошибка красным. */
export function stepRow(s: TxStep, ctx: TxCtx): HTMLElement {
  if (s.kind === 'tool') {
    const { row: r, body } = row(styles.tool, '●');
    r.title = s.raw;
    body.append(el('span', styles.name, s.name));
    if (s.target) {
      const arg = el('span', styles.arg);
      // путь целиком — ссылкой с короткой подписью; пути внутри команды или шаблона поиска — тоже ссылки
      if (s.path) arg.append(pathAnchor(s.path, shownPath(s.path, ctx.home, ctx.run)));
      else appendPaths(arg, s.target);
      body.append(el('span', styles.paren, '('), arg, el('span', styles.paren, ')'));
    }
    return r;
  }
  const { row: r, body } = row(cx(styles.result, s.error && styles.err), '└');
  r.title = s.text;
  appendPaths(body, s.text);
  return r;
}

/** Вопрос агента «? …» и ответ человека «└ …» — с полосой цвета ожидания. */
function qaRow(kind: 'ask' | 'answer', text: string): HTMLElement {
  const { row: r, body } = row(kind === 'ask' ? styles.ask : styles.answer, kind === 'ask' ? '?' : '└');
  body.textContent = text;
  return r;
}

function stepsOpen(steps: TxStep[], ctx: TxCtx): HTMLElement {
  const g = el('div', styles.steps);
  for (const s of steps) g.append(stepRow(s, ctx));
  return g;
}

/** Серия вызовов: короткая — строками, длинная — итогом «214 действий · WebFetch 120 · …», строки — по раскрытию. */
function stepsEl(steps: TxStep[], ctx: TxCtx): HTMLElement {
  if (callsIn(steps) <= STEPS_OPEN_MAX) return stepsOpen(steps, ctx);
  const d = document.createElement('details');
  d.className = styles.fold!;
  const { row: sum, body } = row(styles.foldHead, '›', 'summary');
  sum.title = t('Показать все вызовы серии');
  const line = stepsLine(steps);
  body.append(el('span', styles.foldN, line.head));
  if (line.tools) body.append(el('span', styles.foldTools, ` · ${line.tools}`));
  if (line.errors) body.append(el('span', styles.foldErr, ` · ${line.errors}`));
  d.append(sum);
  // сотни строк серии строятся, только когда её раскрыли
  d.addEventListener('toggle', () => {
    if (d.open && d.childElementCount === 1) d.append(stepsOpen(steps, ctx));
  });
  return d;
}

/** Окно транскрипта этапа: блоки по порядку. */
export function renderTranscript(box: HTMLElement, blocks: TxBlock[], ctx: TxCtx): void {
  const out: HTMLElement[] = [];
  for (const b of blocks) {
    if (b.kind === 'text') out.push(textRow(b.text));
    else if (b.kind === 'steps') out.push(stepsEl(b.steps, ctx));
    else {
      const q = el('div', styles.qa);
      q.append(qaRow('ask', b.ask));
      if (b.answer !== undefined) q.append(qaRow('answer', b.answer));
      out.push(q);
    }
  }
  box.replaceChildren(...out);
}

/**
 * Строки живого лога «[этап] …» в кусок лога. fresh — кусок новый: он начинается с имени этапа, чтобы строки
 * не остались без него, когда старые куски уйдут из окна. Смена этапа — тихий разделитель с именем.
 */
export function appendLog(chunk: HTMLElement, lines: string[], st: LogState, ctx: TxCtx, fresh: boolean): void {
  chunk.classList.add(styles.tx!);
  if (fresh) st.phase = undefined;
  for (const line of lines) {
    const { phase, newPhase, item } = logItem(line, st);
    if (newPhase) chunk.append(el('div', styles.phase, phase));
    if (!item) continue;
    if (item.kind === 'ask' || item.kind === 'answer') chunk.append(qaRow(item.kind, item.text));
    else chunk.append(item.kind === 'text' ? textRow(item.text) : stepRow(item, ctx));
  }
}

const PHASE = /^\[([^\]\n]+)\] /;

/**
 * Строка хвоста лога — одна строка экрана: текст агента без разметки. withPhase — у хвоста всех этапов строки
 * начинаются с «[этап] »: имя — тихой подписью. Пустой текст — null.
 */
export function tailLine(line: string, ctx: TxCtx, withPhase: boolean): HTMLElement | null {
  const m = withPhase ? PHASE.exec(line) : null;
  const item = parseLine(m ? line.slice(m[0].length) : line);
  let r: HTMLElement;
  let body: HTMLElement;
  if (item.kind === 'text') {
    const text = item.text.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    ({ row: r, body } = row(styles.text, '●'));
    appendPaths(body, text);
  } else {
    r = stepRow(item, ctx);
    body = r.lastElementChild as HTMLElement;
  }
  r.classList.add(styles.compact!);
  if (m) body.prepend(el('span', styles.tailPhase, `${m[1]!} `));
  return r;
}
