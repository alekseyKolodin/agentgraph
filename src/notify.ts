// Системные уведомления с сервера: агент спросил или запуск закончился, а UI закрыт.
// macOS: terminal-notifier, если установлен (клик открывает UI), иначе osascript; Linux: notify-send.
import { spawn, spawnSync } from 'node:child_process';

export type OsNotice = {
  title: string;
  body: string;
  /** Что открыть по клику: работает только с terminal-notifier. */
  url?: string;
  /** Уведомления одной группы заменяют друг друга (terminal-notifier). */
  group?: string;
  sound?: boolean;
};

/** AGENTGRAPH_NOTIFY: log — только строка в лог сервера (для проверок), off — молчать. */
const MODE = process.env.AGENTGRAPH_NOTIFY ?? 'os';
const BODY_MAX = 240;

let terminalNotifier: boolean | undefined;
const hasTerminalNotifier = () => (terminalNotifier ??= spawnSync('which', ['terminal-notifier'], { stdio: 'ignore' }).status === 0);

export function osNotify(n: OsNotice): void {
  if (MODE === 'off') return;
  const body = n.body.length > BODY_MAX ? n.body.slice(0, BODY_MAX - 1) + '…' : n.body;
  if (MODE === 'log') {
    console.log(`[notify] ${n.title} — ${body}${n.url ? ` → ${n.url}` : ''}`);
    return;
  }
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin' && hasTerminalNotifier()) {
    cmd = 'terminal-notifier';
    args = ['-title', n.title, '-message', body];
    if (n.url) args.push('-open', n.url);
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
