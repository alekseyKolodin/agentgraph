// Логика экранов «Сессии» без React и DOM: подписи статуса, строка сессии в «Сейчас», чипы тегов на ходу, адрес
// WebSocket, путь перетащенного файла для командной строки claude.
import type { SessionTagChip, SessionView } from '@server/api-types';
import { baseName } from './format';
import { t } from './i18n';

/** Тон точки и подписи: live — работает, wait — ход за тобой, off — завершена или запускается, fail — не запустилась. */
export type SessionTone = 'live' | 'wait' | 'off' | 'fail';

export function sessionTone(s: Pick<SessionView, 'status' | 'outcome'>): SessionTone {
  if (s.status === 'working') return 'live';
  if (s.status === 'waiting') return 'wait';
  return s.outcome ? 'fail' : 'off';
}

/** Подпись статуса для шапки и таблицы. */
export function sessionStatusLabel(s: Pick<SessionView, 'status' | 'outcome' | 'exitCode'>): string {
  switch (s.status) {
    case 'starting':
      return t('Запускается');
    case 'working':
      return t('Работает');
    case 'waiting':
      return t('Ждёт тебя');
    default:
      if (s.outcome === 'untrusted') return t('Папка не доверена');
      if (s.outcome === 'failed') return t('Не запустилась · код {code}', { code: s.exitCode ?? '?' });
      return s.exitCode === undefined ? t('Завершена') : t('Завершена · код {code}', { code: s.exitCode });
  }
}

/** Вторая строка в «Сейчас»: «сессия · shop · работает». */
export function sessionSub(s: Pick<SessionView, 'cwd' | 'status'>): string {
  const state = s.status === 'working' ? t('работает') : s.status === 'waiting' ? t('ждёт тебя') : t('запускается');
  return t('сессия · {dir} · {state}', { dir: baseName(s.cwd), state });
}

/** Подсказка у чипа тега, который ещё не дошёл до модели. */
export function chipHint(chip: SessionTagChip): string {
  if (chip.state === 'pending') return t('Модель увидит тег со следующим своим шагом или твоим сообщением');
  if (chip.state === 'removed') return t('Снятие дойдёт до модели со следующим её шагом или твоим сообщением');
  return '';
}

/** Строка под чипами: что из изменений тегов ещё не дошло до модели; изменений нет — пусто. */
export function pendingNote(chips: SessionTagChip[]): string {
  const added = chips.filter((c) => c.state === 'pending').map((c) => c.slug);
  const removed = chips.filter((c) => c.state === 'removed').map((c) => c.slug);
  if (!added.length && !removed.length) return '';
  const parts = [...(added.length ? [added.join(', ')] : []), ...(removed.length ? [t('снятие {tags}', { tags: removed.join(', ') })] : [])];
  const what = parts.join(t(' и '));
  return added.length + removed.length > 1
    ? t('{what} дойдут до модели со следующим её шагом или твоим сообщением', { what })
    : t('{what} дойдёт до модели со следующим её шагом или твоим сообщением', { what });
}

/** WebSocket экрана сессии на том же хосте, что и страница: Origin совпадёт с Host, и сервер пустит. */
export const sessionWsUrl = (loc: { protocol: string; host: string }, id: string): string =>
  `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/sessions/${encodeURIComponent(id)}/ws`;

/**
 * Путь для командной строки claude — как его вставляет Terminal.app при перетаскивании: пробелы и спецсимволы shell
 * экранируются обратной косой чертой. Так claude узнаёт в нём файл (картинку — прикладывает).
 */
export const shellPath = (p: string): string => p.replace(/[\s!"#$&'()*;<>?[\\\]^`{|}]/g, '\\$&');

/** Пути файлов из text/uri-list (так их отдают некоторые платформы при перетаскивании из файлового менеджера). */
export function fileUris(list: string): string[] {
  return list
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('file://'))
    .flatMap((l) => {
      try {
        const u = new URL(l);
        return u.host && u.host !== 'localhost' ? [] : [decodeURIComponent(u.pathname)];
      } catch {
        return [];
      }
    });
}

/** Перевод строки в поле ввода claude без отправки: Shift+Enter шлёт то же, что Option+Enter (ESC CR). */
export const NEWLINE_SEQ = '\x1b\r';
