// Логика экранов «Сессии» без React и DOM: подписи статуса, строка сессии в «Сейчас», чипы пространства и тегов знаний
// на ходу, адрес WebSocket, путь перетащенного файла для командной строки claude, буфер обмена из OSC 52, состояние
// пространства.
import type { SessionSpaceChip, SessionTagChip, SessionView } from '@server/api-types';
import { ago, baseName, clock, feedTime, plural } from './format';
import { t } from './i18n';

/** Тон точки и подписи: live — работает, wait — ход за тобой, off — завершена или запускается, fail — не запустилась. */
export type SessionTone = 'live' | 'wait' | 'off' | 'fail';

export function sessionTone(s: Pick<SessionView, 'status' | 'outcome'>): SessionTone {
  if (s.status === 'working') return 'live';
  if (s.status === 'waiting') return 'wait';
  return s.outcome ? 'fail' : 'off';
}

/** Подпись статуса для шапки и таблицы. Код выхода claude — не здесь, а в подсказке (sessionExitTitle). */
export function sessionStatusLabel(s: Pick<SessionView, 'status' | 'outcome'>): string {
  switch (s.status) {
    case 'starting':
      return t('Запускается');
    case 'working':
      return t('Работает');
    case 'waiting':
      return t('Ждёт тебя');
    default:
      if (s.outcome === 'untrusted') return t('Папка не доверена');
      if (s.outcome === 'failed') return t('Не запустилась');
      return t('Завершена');
  }
}

/**
 * Почему у завершённой нет транскрипта (resumable: false): не было ни одного сообщения или файл удалили (claude чистит
 * старые сам, cleanupPeriodDays). «Продолжить» в обоих случаях начнёт новый разговор.
 */
export const noTranscriptWhy = (s: Pick<SessionView, 'turns'>): string =>
  s.turns > 0 ? t('транскрипт прошлого разговора удалён') : t('в прошлом не было ни одного сообщения');

/** Код выхода claude для подсказки у статуса завершённой сессии; неизвестен или сессия идёт — пусто. */
export const sessionExitTitle = (s: Pick<SessionView, 'live' | 'exitCode'>): string =>
  !s.live && s.exitCode !== undefined ? t('Код выхода claude: {code}', { code: s.exitCode }) : '';

/** SIGHUP: так claude гасят «Завершить» и выход из приложения. */
const SIGHUP_EXIT = 129;

/** Что случилось с завершённой сессией — текст карточки поверх её последнего экрана. Неизвестный код не называем. */
export function sessionEndText(s: Pick<SessionView, 'outcome' | 'exitCode' | 'endedBy'>): string {
  if (s.outcome === 'untrusted') return t('Claude вышел, не начав сессию: доверие к папке не принято. Контекст agentgraph не доставлялся.');
  if (s.outcome === 'failed') {
    return s.exitCode === undefined
      ? t('claude завершился, не начав сессию: причина — в выводе терминала.')
      : t('claude завершился с кодом {code}, не начав сессию: причина — в выводе терминала.', { code: s.exitCode });
  }
  if (s.endedBy === 'button') return t('Сессию завершили кнопкой «Завершить».');
  if (s.endedBy === 'app') return t('Claude остановлен вместе с приложением.');
  // записи до endedBy: SIGHUP — значит, его погасил agentgraph
  if (s.exitCode === SIGHUP_EXIT) return t('Claude остановлен кнопкой «Завершить» или вместе с приложением.');
  if (s.exitCode === undefined || s.exitCode === 0) return t('Claude вышел.');
  return t('Claude вышел с кодом {code}.', { code: s.exitCode });
}

/**
 * Сессии на главной: ждущие — в «Ждёт тебя» (дольше ждущие сверху), работающие и запускающиеся — в «Идут». Диалог
 * доверия к папке на экране — тоже ждёт тебя: без ответа claude не начнёт.
 */
export function homeSessions<S extends Pick<SessionView, 'live' | 'status' | 'delivery' | 'waitingSince' | 'lastActivityAt'>>(list: S[]): { waiting: S[]; live: S[] } {
  const since = (s: S) => s.waitingSince ?? s.lastActivityAt;
  const waits = (s: S) => s.status === 'waiting' || s.delivery === 'trust';
  return {
    waiting: list.filter((s) => s.live && waits(s)).sort((a, b) => since(a).localeCompare(since(b))),
    live: list.filter((s) => s.live && !waits(s) && (s.status === 'working' || s.status === 'starting')),
  };
}

/** Подпись строки сессии на главной: «◇ press-alert · ждёт 5 мин» — пространство (без него — папка) и что с ней сейчас. */
export function homeSessionMeta(s: Pick<SessionView, 'cwd' | 'space' | 'status' | 'delivery' | 'waitingSince' | 'lastActivityAt' | 'turns'>, now: number = Date.now()): string {
  const where = s.space ? `◇ ${s.space}` : baseName(s.cwd);
  const state =
    s.delivery === 'trust'
      ? t('ждёт: доверие к папке')
      : s.status === 'waiting'
      ? t('ждёт {time}', { time: ago(s.waitingSince ?? s.lastActivityAt, now) })
      : s.status === 'working'
        ? t('работает')
        : t('запускается');
  return [where, state, ...(s.turns ? [`${s.turns} ${plural(s.turns, 'ход', 'хода', 'ходов')}`] : [])].join(' · ');
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
  // выбрано на ходу: идущий claude запущен без него — карта пришла строкой «прочитай», памятью — после перезапуска
  if (live && chip.state === 'on' && !chip.memory) return t('Пространство выбрано на ходу: карта (CLAUDE.md) — строкой «прочитай» (памятью — после «Перезапустить» в меню ⋯), документы — по запросу, состояние — в контексте');
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
export function canUpdateState(s: Pick<SessionView, 'space' | 'spaceChip' | 'updatingState' | 'newTurns' | 'stateSpaces'>): { show: boolean; ok: boolean; why: string } {
  // куда уйдут ходы, считает сервер (по пространству, где сделан ход); старый сервер — в текущее пространство
  const spaces = s.stateSpaces ?? (s.space && !s.spaceChip?.missing ? [s.space] : []);
  if (!spaces.length && (!s.space || s.spaceChip?.missing)) return { show: false, ok: false, why: '' };
  if (s.updatingState) return { show: true, ok: false, why: t('Состояние уже пишется') };
  if (!s.newTurns) return { show: true, ok: false, why: t('Новых ходов с прошлого обновления нет') };
  if (!spaces.length) return { show: true, ok: false, why: t('Новые ходы сделаны без пространства или в удалённом: записать их некуда') };
  if (spaces.length > 1 || spaces[0] !== s.space) return { show: true, ok: true, why: t('Сессия haiku перепишет состояние пространств {list}: каждому — ходы, сделанные в нём', { list: spaces.join(', ') }) };
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
