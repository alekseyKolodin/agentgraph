// Буфер живого лога запуска (порт appendLog/flushLog из ui/app.js) — без DOM. Строки копятся и забираются раз в кадр
// пачкой; в DOM держится хвост (не больше LOG_MAX_LINES строк, куски по LOG_CHUNK_LINES), весь лог этапа — в его транскрипте.

export const LOG_MAX_LINES = 3000;
export const LOG_CHUNK_LINES = 200;
export const LOG_LINE_MAX = 4000;
/** С этого числа строк окно лога получает фиксированную высоту и contain: strict (класс tall). */
export const LOG_TALL_LINES = 60;
/** Хвост на «Обзоре» и в инспекторе этапа. */
export const LOG_TAIL_LINES = 6;
const TAIL_LINE_MAX = 240;

export class RunLogBuffer {
  /** Строки, ещё не попавшие в DOM. */
  queue: string[] = [];
  /** Очередь переполнилась (переигрывание длинного запуска, вкладка в фоне): DOM собрать заново. */
  reset = false;
  /** Последние строки всех этапов, обрезанные для одной строки. */
  tail: string[] = [];
  /** Последние строки по этапам: строка лога начинается с [этап]. */
  byPhase = new Map<string, string[]>();

  append(line: string): void {
    const q = this.queue;
    q.push(line.length > LOG_LINE_MAX ? `${line.slice(0, LOG_LINE_MAX)}… (ещё знаков: ${line.length - LOG_LINE_MAX}, полный текст в транскрипте этапа)` : line);
    // всё старше хвоста в DOM уже не попадёт
    if (q.length >= LOG_MAX_LINES + LOG_CHUNK_LINES) {
      q.splice(0, q.length - LOG_MAX_LINES);
      this.reset = true;
    }
    const short = line.length > TAIL_LINE_MAX ? `${line.slice(0, TAIL_LINE_MAX)}…` : line;
    this.tail.push(short);
    if (this.tail.length > LOG_TAIL_LINES) this.tail.shift();
    const ph = /^\[([^\]]+)\] /.exec(line);
    if (ph) {
      const list = this.byPhase.get(ph[1]!) || [];
      list.push(short.slice(ph[0].length));
      if (list.length > LOG_TAIL_LINES) list.shift();
      this.byPhase.set(ph[1]!, list);
    }
  }

  /** Забрать накопленное для DOM: строки и признак «собрать заново». */
  take(): { lines: string[]; reset: boolean } {
    const out = { lines: this.queue, reset: this.reset };
    this.queue = [];
    this.reset = false;
    return out;
  }

  clear(): void {
    this.queue = [];
    this.reset = false;
    this.tail = [];
    this.byPhase = new Map();
  }
}

/** Кусок лога в DOM: n строк. */
export type LogChunk = { n: number };

/**
 * Раскладка новых строк по кускам: сколько дописать в последний кусок (fill) и какие новые куски создать (chunks — числа строк);
 * drop — сколько первых кусков убрать, чтобы строк осталось не больше LOG_MAX_LINES (последний кусок не убирается).
 */
export function planLogChunks(existing: number[], added: number): { fill: number; chunks: number[]; drop: number } {
  let rest = added;
  const last = existing.at(-1);
  const fill = last !== undefined && last < LOG_CHUNK_LINES ? Math.min(rest, LOG_CHUNK_LINES - last) : 0;
  rest -= fill;
  const chunks: number[] = [];
  while (rest > 0) {
    const n = Math.min(rest, LOG_CHUNK_LINES);
    chunks.push(n);
    rest -= n;
  }
  const all = [...existing.slice(0, -1), ...(last !== undefined ? [last + fill] : []), ...chunks];
  let total = all.reduce((a, b) => a + b, 0);
  let drop = 0;
  while (total > LOG_MAX_LINES && all.length - drop > 1) total -= all[drop++]!;
  return { fill, chunks, drop };
}
