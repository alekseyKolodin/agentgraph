// Диалог выхода из десктопного приложения (src/desktop/main.ts): что спросить, если идут сессии терминала и если в
// клонах команд Teamwork есть коммиты, которых нет в репо команды (spec §7.5). Без Electron: main.ts передаёт askQuit
// источники данных (liveSessionNames из sessions-server.ts, unsentTeams и pushTeams из teamwork-server.ts) и показ окна
// через dialog.showMessageBox; проверка — quit-dialog.test.ts.

/** Команда с неотправленными изменениями: сколько коммитов не ушло, последняя ошибка отправки, идёт ли отправка сейчас. */
export type UnsentTeam = { slug: string; title: string; unpushed: number; error?: string; pushing?: boolean };

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

/** «Не отправлено в Teamwork: «Платежи» — 3 изменения (нет доступа к репо); «Дизайн» — 1 изменение (ещё отправляется).» */
export function teamsLine(teams: readonly UnsentTeam[]): string {
  const why = (x: UnsentTeam) => (x.pushing ? ' (ещё отправляется)' : x.error ? ` (${reason(x.error)})` : '');
  const parts = teams.map((x) => `«${x.title}» — ${x.unpushed} ${plural(x.unpushed, 'изменение', 'изменения', 'изменений')}${why(x)}`);
  return `Не отправлено в Teamwork: ${parts.join('; ')}.`;
}

const SESSIONS_NOTE =
  'Они завершатся; разговор сохранится, продолжить можно потом кнопкой «Продолжить».\n\nСостояние пространства по этим сессиям при таком выходе не пишется — обновить его можно потом кнопкой «Обновить состояние» на экране сессии.';
const TEAMS_NOTE = 'Изменения сохранены на этом компьютере и уйдут в репо команды при следующем запуске agentgraph, когда репо будет доступен.';
const UNKNOWN_LINE =
  'Не удалось проверить, всё ли отправлено в Teamwork. Неотправленные изменения, если они есть, сохранены на этом компьютере и уйдут в репо команды при следующем запуске agentgraph.';

/**
 * Вопрос перед выходом; спрашивать не о чем — undefined. Сессии терминала — «Завершить сессии и закрыть» или «Отмена».
 * Неотправленные изменения команд — первой кнопкой «Отправить и закрыть» (askQuit синхронизирует команды и выходит, если
 * всё ушло), «Закрыть без отправки», «Отмена». pushFailed — отправка уже не удалась или не успела: «Отправить» больше не
 * предлагается. teams undefined — проверить не удалось (git не ответил вовремя или упал): выход всё равно спрашивает, с
 * «Отмена» по умолчанию, а не закрывается молча (D-16).
 */
export function quitPrompt(s: { sessions: readonly string[]; teams: readonly UnsentTeam[] | undefined; pushFailed?: boolean }): QuitPrompt | undefined {
  const sessions = s.sessions.length > 0;
  if (!s.teams) {
    const detail = [sessions ? `${sessionsLine(s.sessions)} ${SESSIONS_NOTE}` : '', UNKNOWN_LINE].filter(Boolean).join('\n\n');
    return { message: 'Закрыть AgentGraph?', detail, buttons: [sessions ? 'Завершить сессии и закрыть' : 'Закрыть', 'Отмена'], choices: ['quit', 'cancel'], defaultId: 1, cancelId: 1 };
  }
  const teams = s.teams.length > 0;
  if (!sessions && !teams) return undefined;
  const detail = [sessions ? `${sessionsLine(s.sessions)} ${SESSIONS_NOTE}` : '', teams ? `${teamsLine(s.teams)} ${TEAMS_NOTE}` : ''].filter(Boolean).join('\n\n');
  if (!teams) return { message: 'Закрыть AgentGraph?', detail, buttons: ['Завершить сессии и закрыть', 'Отмена'], choices: ['quit', 'cancel'], defaultId: 0, cancelId: 1 };
  const close = sessions ? 'Завершить сессии и закрыть без отправки' : 'Закрыть без отправки';
  if (s.pushFailed) {
    const message = s.teams.some((x) => x.pushing) ? 'Изменения Teamwork ещё отправляются' : 'Изменения Teamwork не отправились';
    return { message, detail, buttons: [close, 'Отмена'], choices: ['quit', 'cancel'], defaultId: 1, cancelId: 1 };
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

/** Откуда askQuit берёт данные и как показывает окно: main.ts передаёт настоящие, тест — подменённые. */
export type QuitDeps = {
  /** Имена живых сессий терминала. */
  sessions: () => string[];
  /** Команды с неотправленными коммитами. */
  unsent: () => Promise<UnsentTeam[]>;
  /** Синхронизировать команды сейчас. */
  push: (slugs: string[]) => Promise<void>;
  /** Показать окно; ответ — номер нажатой кнопки. */
  show: (p: QuitPrompt) => Promise<number>;
  /** Сколько ждать подсчёта коммитов и отправки: выход не должен висеть на git. */
  unsentWaitMs?: number;
  pushWaitMs?: number;
};

/** Ответ или запасное значение, если не успел за ms. */
const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);

/**
 * Что спросить перед выходом (макет QuitDialog, spec §7.5); true — выходить. «Отправить и закрыть» синхронизирует команды
 * (не дольше pushWaitMs) и выходит, если всё ушло; не ушло или ещё уходит — тот же вопрос без «Отправить», с причиной.
 */
export async function askQuit(d: QuitDeps): Promise<boolean> {
  const unsentWait = d.unsentWaitMs ?? 3_000;
  const sessions = d.sessions();
  // не успели или упали — undefined: об этом спрашиваем, а не выходим молча
  let teams: UnsentTeam[] | undefined = await within<UnsentTeam[] | undefined>(d.unsent(), unsentWait, undefined);
  let pushFailed = false;
  for (;;) {
    const p = quitPrompt({ sessions, teams, pushFailed });
    if (!p) return true;
    const choice = p.choices[await d.show(p)] ?? 'cancel';
    if (choice !== 'push' || !teams) return choice === 'quit';
    await within(d.push(teams.map((x) => x.slug)), d.pushWaitMs ?? 20_000, undefined);
    teams = (await within<UnsentTeam[] | undefined>(d.unsent(), unsentWait, undefined)) ?? teams;
    // всё ушло: про сессии человек уже ответил той же кнопкой
    if (!teams.length) return true;
    pushFailed = true;
  }
}
