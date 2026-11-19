// Подключение GitLab и GitHub идёт через утилиты glab и gh, а не через ключ в форме: ошибка проверки («glab не
// установлен», «401») человеку ничего не говорит. Здесь — что за ней стоит и что сделать, словами.
import { t } from '../i18n';

export type ForgeTool = { tool: 'glab' | 'gh'; name: string; defaultHost: string; install: string };

/** Утилита вида источника; другие виды (Slack, Jira…) — undefined. */
export function forgeTool(kind: string | undefined): ForgeTool | undefined {
  if (kind === 'gitlab') return { tool: 'glab', name: 'GitLab', defaultHost: 'gitlab.com', install: 'brew install glab' };
  if (kind === 'github') return { tool: 'gh', name: 'GitHub', defaultHost: 'github.com', install: 'brew install gh' };
  return undefined;
}

/** Команда входа: для своего сервера (не gitlab.com / github.com) — с его адресом. */
export function loginCommand(f: ForgeTool, host: string | undefined): string {
  const h = (host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${f.tool} auth login${h && h !== f.defaultHost ? ` --hostname ${h}` : ''}`;
}

/** Ошибка проверки → что делать. undefined — ошибка не про утилиту, показываем как есть. */
export function forgeProblem(kind: string | undefined, error: string | undefined, host?: string): string | undefined {
  const f = forgeTool(kind);
  if (!f || !error) return undefined;
  if (/не установлен|not found|ENOENT|command not found/i.test(error)) {
    return t('Утилита {tool} не найдена. Установи её в терминале: {install} — и нажми «Проверить» ещё раз.', { tool: f.tool, install: f.install });
  }
  if (/\b(401|403)\b|unauthori[sz]ed|auth login|not logged|no token|credentials|не авториз|токен/i.test(error)) {
    return t('{tool} не вошёл в {name}. Выполни в терминале: {login} — и нажми «Проверить» ещё раз.', { tool: f.tool, name: f.name, login: loginCommand(f, host) });
  }
  return undefined;
}
