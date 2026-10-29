// Транскрипт этапа и живой лог — для чтения, как в Claude Code: текст агента — markdown, вызов инструмента — одна строка
// «Имя главный-аргумент», результат — строка под ним, длинная серия вызовов — свёрнута в итог. Формат строк задаёт
// src/agent.ts handle(): текст агента как есть (бывает многострочным), «▸ Имя {json}» (JSON обрезан до 300 знаков),
// «  ↳ результат» (одной строкой, до 200 знаков); вопрос и ответ на него — «? …» и «= …» (src/runner.ts). Разбор только
// для показа: файл транскрипта и строки, которые читают модели (run_log чата), не меняются, разметка не стоит токенов.
import { plural, t } from '../i18n';
import { tildePath } from '../paths';

/** path — полный путь к файлу у Read, Edit, Write: target с ним обрезан, а ссылка «показать в Finder» нужна целиком. */
export type TxTool = { kind: 'tool'; name: string; target: string; path?: string; raw: string };
export type TxResult = { kind: 'result'; text: string; error: boolean };
export type TxStep = TxTool | TxResult;
/** Строка лога сама по себе: текст агента, вызов или результат. */
export type TxLine = { kind: 'text'; text: string } | TxStep;
export type TxBlock = { kind: 'text'; text: string } | { kind: 'qa'; ask: string; answer?: string } | { kind: 'steps'; steps: TxStep[] };

/** Серия длиннее — свёрнута в строку-итог: у исследовательских этапов подряд идут сотни поисков и загрузок. */
export const STEPS_OPEN_MAX = 8;

// Строки лога целиком, без вложенных квантификаторов: на длинной строке работают линейно.
// JSON вызова всегда объект: «▸ » в начале строки текста агента без «{» после имени — это текст.
const TOOL = /^▸ (\S+) (\{[^\n]*)$/;
const RESULT = /^ {2}↳ ([^\n]*)$/;
// вопрос и ответ бывают многострочными: в поле ответа Enter — перевод строки
const ASK = /^\? ([\s\S]+)$/;
const ANSWER = /^= ([\s\S]*)$/;
/** Результат AskUserQuestion повторяет ответ, который уже показан под вопросом. */
const ANSWERED = /^(?:Your questions have been answered|The user answered|User has answered)/;
/** Строк вопроса до «= …» дальше не ищем: «? » в тексте агента без ответа не разбирается заново на каждой строке. */
const ASK_LOOK = 50;

/** Главный аргумент инструмента: по нему строка вызова читается без JSON. У остальных — первая строка-значение. */
const MAIN: Record<string, string> = {
  Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path',
  Bash: 'command', Grep: 'pattern', Glob: 'pattern', WebSearch: 'query', WebFetch: 'url', Agent: 'description', Task: 'description',
  Skill: 'skill', AskUserQuestion: 'question', ToolSearch: 'query', TodoWrite: 'content',
};

const TARGET_MAX = 200;

/**
 * Значение строкового поля из JSON, который мог обрезаться посередине: ищем «"ключ":"» где угодно (вложенный вопрос
 * AskUserQuestion тоже) и читаем до незаэкранированной кавычки или до конца. Без ключа — первое строковое поле.
 */
export function jsonString(json: string, key?: string): string | undefined {
  let at: number;
  if (key) {
    const i = json.indexOf(`"${key}":"`);
    if (i < 0) return undefined;
    at = i + key.length + 4;
  } else {
    const m = /"[^"\\\n]{1,64}":"/.exec(json);
    if (!m) return undefined;
    at = m.index + m[0].length;
  }
  let end = at;
  while (end < json.length && json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
  const body = json.slice(at, Math.min(end, json.length));
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    // обрезано посреди экранирования: «\…» или «\u12…» в конце (truncate в src/agent.ts дописывает «…»)
    const more = body.endsWith('…') ? '…' : '';
    const cut = body.slice(0, body.length - more.length).replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '');
    try {
      return (JSON.parse(`"${cut}"`) as string) + more;
    } catch {
      return cut + more;
    }
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Строка вызова: имя (у MCP — без сервера, как в трассе чата), главный аргумент коротко. */
export function toolOf(name: string, json: string): TxTool {
  const parts = name.startsWith('mcp__') ? name.split('__') : [];
  const shown = parts.length > 2 ? parts.slice(2).join('__') : name;
  const key = parts.length ? undefined : MAIN[name];
  const value = (key ? jsonString(json, key) : undefined) ?? jsonString(json) ?? '';
  // у команды — первая строка: дальше обычно heredoc или длинный скрипт
  const main = name === 'Bash' ? value.split('\n')[0]! : value;
  const path = key?.endsWith('_path') && value.startsWith('/') && !value.endsWith('…') ? { path: value } : {};
  return { kind: 'tool', name: shown, target: clip(oneLine(main), TARGET_MAX), ...path, raw: `${name} ${json}` };
}

/**
 * Ошибка инструмента по тексту результата: в транскрипте признака is_error нет, а красным стоит выделять только
 * узнаваемые отказы — Claude Code, веб-инструментов и guard этапа (src/agent.ts).
 */
const ERROR = /^(?:<tool_use_error>|Error:|\w+Error:|API Error|The server returned HTTP [45]\d\d|Claude Code is unable to fetch|Request failed with status code [45]\d\d|timeout of \d+ms exceeded|self[- ]signed certificate|Инструмент \S+ не разрешён|Пользователь не ответил:|\S+ разрешён этапу, но)/;
// в запросе бывают свои кавычки без экранирования: «"reddit "is there a tool" 2026" Links:»
const SEARCH = /^Web search results for query: "([^\n]*?)" Links: /;

/** Результат одной строкой. У поиска вместо JSON ссылок — запрос и заголовки найденного (последний бывает обрезан). */
export function resultOf(text: string): TxResult {
  const s = SEARCH.exec(text);
  if (s) {
    const rest = text.slice(s[0].length);
    const titles = rest.split('"title":"').slice(1).map((piece) => jsonString(`"t":"${piece}`, 't') ?? '').filter(Boolean);
    const found = titles.length ? ` — ${titles.join(' · ')}` : '';
    const more = rest.endsWith('…') && !found.endsWith('…') ? ' …' : '';
    return { kind: 'result', text: `«${s[1]!}»${found}${more}`, error: false };
  }
  return { kind: 'result', text, error: ERROR.test(text) };
}

/** Одна строка лога без соседей: вызов, результат или текст. Вопрос и ответ различают parseTranscript и живой лог. */
export function parseLine(line: string): TxLine {
  const tool = TOOL.exec(line);
  if (tool) return toolOf(tool[1]!, tool[2]!);
  const res = RESULT.exec(line);
  if (res) return resultOf(res[1]!);
  return { kind: 'text', text: line };
}

const askOf = (line: string): string | undefined => ASK.exec(line)?.[1];
const answerOf = (line: string): string | undefined => ANSWER.exec(line)?.[1];
const isStep = (line: string): boolean => TOOL.test(line) || RESULT.test(line);

/**
 * Транскрипт этапа — блоки: текст агента (строки подряд), вопрос с ответом, серия вызовов с результатами.
 * Вопрос — «? …» и строки до «= …», ответ — «= …» и строки до вызова или результата: в файле многострочный
 * ответ идёт строками. Нет «= …» до вызова — это строки текста агента. Результат AskUserQuestion сразу за ответом
 * его повторяет и не показывается.
 */
export function parseTranscript(src: string): TxBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out: TxBlock[] = [];
  let text: string[] = [];
  const flushText = () => {
    // пустые строки по краям — разделители между блоками, не текст
    while (text.length && !text[0]!.trim()) text.shift();
    while (text.length && !text.at(-1)!.trim()) text.pop();
    if (text.length) out.push({ kind: 'text', text: text.join('\n') });
    text = [];
  };
  /** Где ответ на вопрос в строке i: номер строки «= …» или -1. */
  const answerAt = (i: number): number => {
    for (let j = i + 1; j < lines.length && j <= i + ASK_LOOK; j++) {
      if (answerOf(lines[j]!) !== undefined) return j;
      if (isStep(lines[j]!)) return -1;
    }
    return -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const a = askOf(line) !== undefined ? answerAt(i) : -1;
    if (a > 0) {
      let end = a + 1;
      while (end < lines.length && !isStep(lines[end]!)) end++;
      flushText();
      out.push({ kind: 'qa', ask: askOf(lines.slice(i, a).join('\n'))!, answer: answerOf(lines.slice(a, end).join('\n').trimEnd())! });
      i = end < lines.length && ANSWERED.test(RESULT.exec(lines[end]!)?.[1] ?? '') ? end : end - 1;
      continue;
    }
    const item = parseLine(line);
    if (item.kind !== 'tool' && item.kind !== 'result') {
      text.push(line);
      continue;
    }
    flushText();
    const last = out.at(-1);
    if (last?.kind === 'steps') last.steps.push(item);
    else out.push({ kind: 'steps', steps: [item] });
  }
  flushText();
  return out;
}

/** Итог свёрнутой серии: «214 действий · WebFetch 120 · WebSearch 80 · Agent 3», с ошибками — «· 12 с ошибкой». */
export function stepsLine(steps: TxStep[]): { head: string; tools: string; errors: string } {
  const counts = new Map<string, number>();
  let errors = 0;
  for (const s of steps) {
    if (s.kind === 'tool') counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
    else if (s.error) errors++;
  }
  const n = [...counts.values()].reduce((a, b) => a + b, 0);
  const tools = [...counts].sort((a, b) => b[1] - a[1]).map(([name, k]) => `${name} ${k}`).join(' · ');
  return {
    head: `${n} ${plural(n, 'действие', 'действия', 'действий')}`,
    tools,
    errors: errors ? t('{n} с ошибкой', { n: errors }) : '',
  };
}

/** Вызовов в серии: по ним решается, свернуть ли её. */
export const callsIn = (steps: TxStep[]): number => steps.reduce((n, s) => n + (s.kind === 'tool' ? 1 : 0), 0);

/** Путь в строке вызова: файл папки запуска — от неё (как в трассе чата), остальное — от домашней папки, с ~. */
export function shownPath(p: string, home: string | undefined, run: string | undefined): string {
  const mark = run ? `/runs/${run}/` : '';
  const at = mark ? p.indexOf(mark) : -1;
  return at >= 0 ? p.slice(at + mark.length) : tildePath(p, home);
}

/** Живой лог между строками: этап последней строки и этап, чей вопрос (asked) или ответ (answered) только что пришёл. */
export type LogState = { phase?: string; asked?: string; answered?: string };
export type LogItem = TxLine | { kind: 'ask'; text: string } | { kind: 'answer'; text: string };

/**
 * Строка живого лога «[этап] …»: этап, сменился ли он, и что в строке. Строка события — блок целиком, поэтому «? …» —
 * вопрос агента, «= …» сразу за ним в том же этапе — ответ (runner.ts пишет их подряд). item null — показывать нечего:
 * пустой текст или результат AskUserQuestion, повторяющий ответ.
 */
export function logItem(line: string, st: LogState): { phase: string; newPhase: boolean; item: LogItem | null } {
  const m = /^\[([^\]\n]+)\] /.exec(line);
  const phase = m ? m[1]! : '';
  const rest = m ? line.slice(m[0].length) : line;
  const newPhase = Boolean(phase) && phase !== st.phase;
  if (phase) st.phase = phase;
  const { asked, answered } = st;
  st.asked = st.answered = undefined;
  const ask = askOf(rest);
  if (ask !== undefined) {
    st.asked = phase;
    return { phase, newPhase, item: { kind: 'ask', text: ask } };
  }
  const answer = asked === phase ? answerOf(rest) : undefined;
  if (answer !== undefined) {
    st.answered = phase;
    return { phase, newPhase, item: { kind: 'answer', text: answer } };
  }
  const item = parseLine(rest);
  if (item.kind === 'text' && !item.text.trim()) return { phase, newPhase, item: null };
  if (item.kind === 'result' && answered === phase && ANSWERED.test(item.text)) return { phase, newPhase, item: null };
  return { phase, newPhase, item };
}
