// Связь сессии терминала и экранов agentgraph без React и DOM: что в выводе терминала — ссылка внутрь приложения
// (адрес своего сервера на localhost с путём экрана, id запуска), и текст «Для сессии» — что дать сессии о flow или
// запуске, чтобы она с ним работала (flow_run, flow_status, путь к файлам).

/** Экраны приложения, на которые ведёт ссылка из терминала (первый сегмент пути). */
const APP_SCREENS = ['run', 'flow', 'sessions', 'spaces', 'tags', 'routines', 'teamwork', 'code', 'context'];

/** Адрес своего сервера: localhost или 127.0.0.1 с любым портом (сессия могла увидеть порт прошлого запуска приложения). */
const APP_URL_RE = new RegExp(`https?://(?:localhost|127\\.0\\.0\\.1)(?::\\d{1,5})?(/(?:${APP_SCREENS.join('|')})(?:[/?#][^\\s"'<>()\\[\\]\`]*)?)`, 'g');
/** Id запуска: 2026-11-21_12-00-00-<имя flow>[-N] (makeRunDir в src/runner.ts). */
const RUN_ID_RE = /\b\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9_-]*/g;
/** Знаки препинания в конце ссылки — это конец фразы, а не часть адреса. */
const TRAIL_RE = /[.,;:!?»…-]+$/;

/** Ссылка в строке терминала: [start, end) — позиции в строке, path — путь экрана внутри приложения. */
export type TerminalLink = { start: number; end: number; text: string; path: string };

/**
 * Ссылки внутрь приложения в строке вывода терминала: адреса своего сервера (с путём экрана) и id запусков. Id внутри
 * адреса отдельной ссылкой не считается.
 */
export function terminalLinks(line: string): TerminalLink[] {
  const out: TerminalLink[] = [];
  for (const m of line.matchAll(APP_URL_RE)) {
    const text = m[0].replace(TRAIL_RE, '');
    const path = m[1]!.slice(0, m[1]!.length - (m[0].length - text.length));
    out.push({ start: m.index!, end: m.index! + text.length, text, path });
  }
  for (const m of line.matchAll(RUN_ID_RE)) {
    const text = m[0].replace(TRAIL_RE, '');
    const start = m.index!;
    if (out.some((l) => start < l.end && start + text.length > l.start)) continue;
    out.push({ start, end: start + text.length, text, path: `/run/${text}` });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Путь экрана приложения из адреса ссылки (OSC 8): свой сервер — путь, иначе null (открывается снаружи). */
export function appPathOf(uri: string): string | null {
  APP_URL_RE.lastIndex = 0;
  const m = new RegExp(`^${APP_URL_RE.source}$`).exec(uri.trim());
  return m ? m[1]! : null;
}

/** Текст «Для сессии» о запуске: имя, id, как узнать состояние и где файлы запуска. */
export function runForSession(r: { id: string; flow: string; title?: string; runDir: string }): string {
  return `Запуск agentgraph «${r.title || r.flow}» (flow ${r.flow}), id ${r.id}. Состояние, этапы и итоги — flow_status с run: "${r.id}"; файлы запуска (run.json, выводы этапов, артефакты) — ${r.runDir}`;
}

/** Текст «Для сессии» о flow: имя, файл и как его запустить или поправить. */
export function flowForSession(f: { name: string; file: string }): string {
  return `Flow agentgraph «${f.name}» — ${f.file}. Запустить — flow_run с flow: "${f.name}"; поправить — прочитай файл и перепиши его flow_write.`;
}
