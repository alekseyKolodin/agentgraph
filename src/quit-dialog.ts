// Диалог выхода из десктопного приложения (src/desktop/main.ts): что спросить, если идут сессии терминала и если в
// клонах команд Teamwork есть коммиты, которых нет в репо команды (spec §7.5). Чистая логика без Electron: main.ts
// собирает данные (liveSessionNames из sessions-server.ts, unsentTeams из teamwork-server.ts) и показывает ответ этой
// функции через dialog.showMessageBox; проверка — quit-dialog.test.ts.

/** Команда с неотправленными изменениями: сколько коммитов не ушло и последняя ошибка отправки. */
export type UnsentTeam = { title: string; unpushed: number; error?: string };

/** Что делать по кнопке: выйти, сначала отправить изменения команд, остаться. */
export type QuitChoice = 'quit' | 'push' | 'cancel';

/** Окно для dialog.showMessageBox: choices[i] — смысл кнопки buttons[i]. */
export type QuitPrompt = { message: string; detail: string; buttons: string[]; choices: QuitChoice[]; defaultId: number; cancelId: number };

const plural = (n: number, one: string, few: string, many: string): string =>
  n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many;

const joinAnd = (list: string[]): string => (list.length > 1 ? `${list.slice(0, -1).join(', ')} и ${list.at(-1)}` : list[0] ?? '');

/** «Идут 2 сессии Claude: «a» и «b».» */
export function sessionsLine(names: readonly string[]): string {
  const n = names.length;
  return `${n === 1 ? 'Идёт' : 'Идут'} ${n} ${plural(n, 'сессия', 'сессии', 'сессий')} Claude: ${joinAnd(names.map((x) => `«${x}»`))}.`;
}

/** Причина в одну строку и не длиннее 120 знаков: текст git бывает многострочным. */
const reason = (error: string): string => {
  const s = error.replace(/\s+/g, ' ').trim();
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
};

/** «Не отправлено в Teamwork: «Платежи» — 3 изменения (нет доступа к репо); «Дизайн» — 1 изменение.» */
export function teamsLine(teams: readonly UnsentTeam[]): string {
  const parts = teams.map((x) => `«${x.title}» — ${x.unpushed} ${plural(x.unpushed, 'изменение', 'изменения', 'изменений')}${x.error ? ` (${reason(x.error)})` : ''}`);
  return `Не отправлено в Teamwork: ${parts.join('; ')}.`;
}

const SESSIONS_NOTE =
  'Они завершатся; разговор сохранится, продолжить можно потом кнопкой «Продолжить».\n\nСостояние пространства по этим сессиям при таком выходе не пишется — обновить его можно потом кнопкой «Обновить состояние» на экране сессии.';
const TEAMS_NOTE = 'Изменения сохранены на этом компьютере и уйдут в репо команды при следующем запуске agentgraph, когда репо будет доступен.';

/**
 * Вопрос перед выходом; спрашивать не о чем — undefined. Сессии терминала — «Завершить сессии и закрыть» или «Отмена».
 * Неотправленные изменения команд — первой кнопкой «Отправить и закрыть» (main.ts синхронизирует команды и выходит, если
 * всё ушло), «Закрыть без отправки», «Отмена». pushFailed — отправка уже не удалась: «Отправить» больше не предлагается.
 */
export function quitPrompt(s: { sessions: readonly string[]; teams: readonly UnsentTeam[]; pushFailed?: boolean }): QuitPrompt | undefined {
  const sessions = s.sessions.length > 0;
  const teams = s.teams.length > 0;
  if (!sessions && !teams) return undefined;
  const detail = [sessions ? `${sessionsLine(s.sessions)} ${SESSIONS_NOTE}` : '', teams ? `${teamsLine(s.teams)} ${TEAMS_NOTE}` : ''].filter(Boolean).join('\n\n');
  if (!teams) return { message: 'Закрыть AgentGraph?', detail, buttons: ['Завершить сессии и закрыть', 'Отмена'], choices: ['quit', 'cancel'], defaultId: 0, cancelId: 1 };
  const close = sessions ? 'Завершить сессии и закрыть без отправки' : 'Закрыть без отправки';
  if (s.pushFailed) {
    return { message: 'Изменения Teamwork не отправились', detail, buttons: [close, 'Отмена'], choices: ['quit', 'cancel'], defaultId: 1, cancelId: 1 };
  }
  return {
    message: 'Закрыть AgentGraph?',
    detail,
    buttons: [sessions ? 'Отправить, завершить сессии и закрыть' : 'Отправить и закрыть', close, 'Отмена'],
    choices: ['push', 'quit', 'cancel'],
    defaultId: 0,
    cancelId: 2,
  };
}
