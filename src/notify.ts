// Системные уведомления с сервера: агент спросил или запуск закончился, а UI закрыт.
// macOS: terminal-notifier, если установлен (клик открывает UI), иначе osascript; Linux: notify-send.
import { spawn, spawnSync } from 'node:child_process';

export type Notice = {
  title: string;
  body: string;
  /** Экран UI, который открыть по клику: путь от корня («/run/<id>»). */
  path: string;
  /** Уведомления одной группы заменяют друг друга. */
  group?: string;
  sound?: boolean;
};

/**
 * AGENTGRAPH_NOTIFY: log — только строка в лог сервера (для проверок), off — молчать. Действует и на свой показ хоста.
 * Читается при каждом уведомлении, а не при загрузке модуля: десктоп берёт переменные из login-shell уже после импорта.
 */
const mode = (): string => process.env.AGENTGRAPH_NOTIFY ?? 'os';
/** Уведомления показываются как обычно: ни off, ни log. Иначе свой показ хоста (десктоп) уступает osNotify. */
export const noticesShown = (): boolean => mode() !== 'off' && mode() !== 'log';
const BODY_MAX = 240;

let terminalNotifier: boolean | undefined;
const hasTerminalNotifier = () => (terminalNotifier ??= spawnSync('which', ['terminal-notifier'], { stdio: 'ignore' }).status === 0);

/** origin — адрес UI: с ним путь уведомления становится ссылкой для клика (открывает её только terminal-notifier). */
export function osNotify(n: Notice, origin: string): void {
  if (mode() === 'off') return;
  const url = origin + n.path;
  const body = n.body.length > BODY_MAX ? n.body.slice(0, BODY_MAX - 1) + '…' : n.body;
  if (mode() === 'log') {
    console.log(`[notify] ${n.title} — ${body} → ${url}`);
    return;
  }
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin' && hasTerminalNotifier()) {
    cmd = 'terminal-notifier';
    args = ['-title', n.title, '-message', body];
    args.push('-open', url);
    if (n.group) args.push('-group', n.group);
    if (n.sound) args.push('-sound', 'default');
  } else if (process.platform === 'darwin') {
    // текст идёт аргументами, а не внутрь скрипта: кавычки и переводы строк в вопросе не ломают AppleScript
    cmd = 'osascript';
    args = ['-e', 'on run argv', '-e', `display notification (item 2 of argv) with title (item 1 of argv)${n.sound ? ' sound name "Glass"' : ''}`, '-e', 'end run', n.title, body];
  } else if (process.platform === 'linux') {
    cmd = 'notify-send';
    args = [n.title, body];
  } else {
    return;
  }
  const child = spawn(cmd, args, { stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
