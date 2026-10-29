// Автообновление в UI без React: плашка в сайдбаре, тексты шагов и предупреждений, когда перезагрузить страницу.
import type { UpdateStatus, UpdateStep } from '@server/api-types';
import { plural, t } from './i18n';

/** Плашка у названия в сайдбаре; null — показывать нечего. */
export function updateBadge(s: UpdateStatus | undefined): { text: string; tone: 'new' | 'busy' | 'fail' } | null {
  switch (s?.state) {
    case 'available':
      return { text: t('Обновление'), tone: 'new' };
    case 'updating':
    case 'restarting':
      return { text: t('Обновляется…'), tone: 'busy' };
    case 'updated':
      return { text: t('Перезапустите'), tone: 'new' };
    case 'failed':
      return { text: t('Обновление не удалось'), tone: 'fail' };
    default:
      return null;
  }
}

export function stepLabel(step: UpdateStep | undefined): string {
  switch (step) {
    case 'fetch':
      return t('Получаю изменения (git fetch)…');
    case 'merge':
      return t('Переключаю код на новую версию (git merge --ff-only)…');
    case 'install':
      return t('Ставлю зависимости (npm install)…');
    case 'build':
      return t('Собираю сервер (npm run build)…');
    case 'web':
      return t('Собираю интерфейс (npm run build:web)…');
    case 'restart':
      return t('Перезапускаю agentgraph…');
    default:
      return t('Обновляю…');
  }
}

/** Что перезапуск остановит; null — ничего. */
export function busyWarning(busy: UpdateStatus['busy']): string | null {
  const parts: string[] = [];
  if (busy.runs) parts.push(t('{n} {runs} — их можно будет продолжить', { n: busy.runs, runs: plural(busy.runs, 'запуск', 'запуска', 'запусков') }));
  if (busy.sessions.length) parts.push(t('сессии терминала {names} — разговор сохранится', { names: busy.sessions.map((n) => `«${n}»`).join(', ') }));
  return parts.length ? t('Перезапуск остановит: {what}.', { what: parts.join('; ') }) : null;
}

/** Процесс перезапускается: ждём, пока поднимется новый сервер. */
export const isRestarting = (s: UpdateStatus | undefined) => s?.state === 'restarting';

/**
 * Пора перезагрузить страницу: этот UI видел перезапуск, а сервер снова отвечает и уже не перезапускается —
 * это новый процесс с новой сборкой UI.
 */
export const backAfterRestart = (sawRestart: boolean, s: UpdateStatus | undefined, failed: boolean) =>
  sawRestart && !failed && !!s && s.state !== 'restarting' && s.state !== 'updating';
