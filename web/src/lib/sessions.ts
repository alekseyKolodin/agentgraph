// Логика экранов «Сессии» без React и DOM: подписи статуса, строка сессии в «Сейчас», чипы пространства и тегов знаний
// на ходу, адрес WebSocket, путь перетащенного файла для командной строки claude, буфер обмена из OSC 52, состояние
// пространства.
import type { SessionSpaceChip, SessionTagChip, SessionView } from '@server/api-types';
import { baseName, clock, feedTime } from './format';
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

/** Вторая строка в «Сейчас»: «◇ press-alert · работает · 5 мин назад» — пространство (без него — папка), статус, активность. */
export function sessionSub(s: Pick<SessionView, 'cwd' | 'status' | 'space'> & Partial<Pick<SessionView, 'lastActivityAt'>>, now: Date = new Date()): string {
  const state = s.status === 'working' ? t('работает') : s.status === 'waiting' ? t('ждёт тебя') : t('запускается');
  // чем сессии различаются: пространство (без него — папка), статус и когда была активность — а не повтор папки
  const where = s.space ? `◇ ${s.space}` : baseName(s.cwd);
  return [where, state, ...(s.lastActivityAt ? [feedTime(s.lastActivityAt, now)] : [])].join(' · ');
}

/** Подсказка у чипа тега или пространства, которые ещё не дошли до модели. */
export function chipHint(chip: Pick<SessionTagChip, 'state'>): string {
  if (chip.state === 'pending') return t('Модель увидит это со следующим своим шагом или твоим сообщением');
  if (chip.state === 'removed') return t('Снятие дойдёт до модели со следующим её шагом или твоим сообщением');
  return '';
}

/** Подсказка у чипа пространства: что оно даёт и что из этого ещё не дошло. */
export function spaceChipHint(chip: SessionSpaceChip, live: boolean): string {
  if (chip.missing) return t('Пространства {slug} больше нет: сессия идёт без него', { slug: chip.slug });
  const base = t('Пространство: карта (CLAUDE.md) — памятью, документы — по запросу, состояние — в контексте');
  if (live && chip.state === 'pending') return `${base}\n${t('Раздел придёт со следующим шагом; карту в память — «Перезапустить» в меню ⋯')}`;
  return [base, chipHint(chip)].filter(Boolean).join('\n');
}

/** Строка под чипами: что из изменений пространства и тегов ещё не дошло до модели; изменений нет — пусто. */
export function pendingNote(chips: Pick<SessionTagChip, 'slug' | 'state'>[]): string {
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

/**
 * Тело OSC 52 («c;<base64>») → текст для буфера обмена. Так копирует claude: выделение мышью в его полноэкранном
 * интерфейсе. Запрос содержимого буфера («?»), пустое и не base64 — null: читать буфер программе в терминале не даём.
 */
export function osc52Text(data: string): string | null {
  const i = data.indexOf(';');
  const b64 = i < 0 ? '' : data.slice(i + 1);
  if (!b64 || b64 === '?') return null;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Кнопка «Обновить состояние»: есть ли она (нужно пространство), можно ли нажать и почему нет. */
export function canUpdateState(s: Pick<SessionView, 'space' | 'spaceChip' | 'updatingState' | 'newTurns'>): { show: boolean; ok: boolean; why: string } {
  if (!s.space || s.spaceChip?.missing) return { show: false, ok: false, why: '' };
  if (s.updatingState) return { show: true, ok: false, why: t('Состояние уже пишется') };
  if (!s.newTurns) return { show: true, ok: false, why: t('Новых ходов с прошлого обновления нет') };
  return { show: true, ok: true, why: t('Сессия haiku перепишет состояние пространства по ходам после прошлого обновления') };
}

/** Состояние пространства для строки сессии и карточки завершённой; без пространства — null. */
export function stateNote(
  s: Pick<SessionView, 'space' | 'updatingState' | 'stateUpdate' | 'statePending'>,
  now: Date = new Date(),
): { text: string; tone: '' | 'ok' | 'warn' | 'err'; title?: string } | null {
  if (s.updatingState) return { text: t('Состояние пространства: пишу…'), tone: '' };
  if (s.statePending === 'app-closed') return { text: t('Состояние не обновлено: приложение закрыли'), tone: 'warn', title: t('При выходе из приложения состояние не пишется: обнови его кнопкой') };
  const u = s.stateUpdate;
  if (u && !u.ok) return { text: t('Состояние не записано: ошибка'), tone: 'err', title: u.error };
  if (u?.ok) return { text: t('Состояние записано в {space} · {time}', { space: u.space, time: clock(u.at, now) }), tone: 'ok', title: `$${u.costUsd.toFixed(3)}` };
  return s.space ? { text: t('Состояние пространства: не обновлялось'), tone: '' } : null;
}
