// Строка синхронизации (spec §7, §11; макет SyncStates.dc.html): текст, тон и действие по TeamSync. Без React и DOM.
import type { TeamConflict, TeamSync } from '@server/api-types';
import { plural, t } from '../i18n';
import { clock } from '../format';

export type SyncTone = 'ok' | 'live' | 'wait' | 'off';
export type SyncAction = { kind: 'retry' | 'resolve' | 'update'; label: string };
export type SyncLine = { text: string; tone: SyncTone; action?: SyncAction };

/** «12 с назад», «3 мин назад», «2 ч назад», старше суток — дата и время. */
export function agoShort(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return t('{s} с назад', { s });
  if (s < 3600) return t('{m} мин назад', { m: Math.floor(s / 60) });
  if (s < 86400) return t('{h} ч назад', { h: Math.floor(s / 3600) });
  return clock(iso, new Date(now));
}

export const changesWord = (n: number): string => `${n} ${plural(n, 'изменение', 'изменения', 'изменений')}`;

/** «конфликт в PAY-12», «конфликт в prd.md», несколько — «конфликтов: 3». */
export function conflictText(sync: Pick<TeamSync, 'conflicts'>, conflicts?: readonly TeamConflict[]): string {
  const n = conflicts?.length ?? sync.conflicts;
  if (n === 1 && conflicts?.[0]) {
    const c = conflicts[0];
    return t('конфликт в {what}', { what: c.task ?? (c.doc ? (c.doc.startsWith('docs/') ? c.doc : `${c.doc}.md`) : c.file) });
  }
  return n <= 1 ? t('конфликт') : t('конфликтов: {n}', { n });
}

/**
 * Строка синхронизации в шапке команды и проекта. Клик по строке синхронизирует сейчас; action — кнопка в строке.
 * Тон: ok — зелёная точка, live — идёт, wait — янтарная, off — только чтение.
 */
export function syncLine(sync: TeamSync, o: { conflicts?: readonly TeamConflict[]; format?: number; now?: number } = {}): SyncLine {
  switch (sync.state) {
    case 'pushing':
      return { text: sync.unpushed ? `${t('отправляется')} · ${changesWord(sync.unpushed)}` : t('отправляется…'), tone: 'live' };
    case 'pending': {
      const head = sync.unpushed ? t('не отправлено: {changes}', { changes: changesWord(sync.unpushed) }) : t('не отправлено');
      // без ошибки отправка просто ждёт таймера: «Повторить» тут нечего — кнопка отправляет сейчас
      return { text: sync.error ? `${head} — ${sync.error}` : head, tone: 'wait', action: { kind: 'retry', label: sync.error ? t('Повторить') : t('Отправить сейчас') } };
    }
    case 'conflict': {
      const text = conflictText(sync, o.conflicts);
      return { text: sync.error ? `${text} — ${sync.error}` : text, tone: 'wait', action: { kind: 'resolve', label: t('Разобрать') } };
    }
    case 'readonly':
      return {
        text: o.format !== undefined ? t('только чтение: формат {n} новее этой версии agentgraph', { n: o.format }) : t('только чтение: формат новее этой версии agentgraph'),
        tone: 'off', action: { kind: 'update', label: t('Обновить agentgraph') },
      };
    default: {
      // получить или отправить не вышло, а отправлять нечего (нет сети, история переписана, клон посреди rebase руками,
      // другой процесс agentgraph): причина — текстом сервера, а не «синхронизировано»
      if (sync.error) return { text: `${t('не синхронизировано')} — ${sync.error}`, tone: 'wait', action: { kind: 'retry', label: t('Повторить') } };
      const at = sync.lastPushAt && sync.lastFetchAt ? (sync.lastPushAt > sync.lastFetchAt ? sync.lastPushAt : sync.lastFetchAt) : sync.lastPushAt ?? sync.lastFetchAt;
      return { text: at ? `${t('синхронизировано')} · ${agoShort(at, o.now)}` : t('синхронизировано'), tone: 'ok' };
    }
  }
}

/**
 * Вопрос перед отключением команды после 409 unpushed (spec §8.2): неотправленные коммиты списком и нерешённые конфликты, где
 * есть моя версия, — она лежит только в этом клоне и пропадёт вместе с ним.
 */
export function disconnectQuestion(d: { unpushed?: number; commits?: readonly string[]; conflicts?: number }): string {
  const lines: string[] = [];
  const n = d.unpushed ?? d.commits?.length ?? 0;
  if (n) lines.push(t('Не отправлено изменений: {n}.', { n }), ...(d.commits ?? []).map((c) => `· ${c}`));
  if (d.conflicts) lines.push(t('Нерешённых конфликтов: {n} — ваши версии из них есть только в этом клоне.', { n: d.conflicts }));
  lines.push(t('Это пропадёт вместе с клоном. Всё равно отключить?'));
  return lines.join('\n');
}

/** Несохранённая правка раздела документа вместо строки синхронизации: «не сохранено: раздел «Требования»». */
export function unsavedLine(sections: readonly string[]): SyncLine | undefined {
  if (!sections.length) return undefined;
  const list = sections.map((s) => `«${s}»`).join(', ');
  return { text: t('не сохранено: {word} {list}', { word: plural(sections.length, 'раздел', 'разделы', 'разделы'), list }), tone: 'wait' };
}

/** Поля файлов команды (задача, спринт, проект, teamwork.yaml) по-человечески; незнакомое поле — как в файле. */
const FIELD_LABEL: Record<string, string> = {
  title: 'Название', pr: 'PR', format: 'Формат', status: 'Статус', sprint: 'Спринт', assignee: 'Исполнитель', estimate: 'Оценка', type: 'Тип', repo: 'Репо', branch: 'Ветка',
  blockedBy: 'Ждёт', covers: 'Требования', rank: 'Место в списке', body: 'Описание', text: 'Текст', goal: 'Цель', summary: 'Суть одной строкой', repos: 'Репо кода',
  members: 'Участники', columns: 'Колонки', prefix: 'Префикс задач', defaultFlow: 'Flow для «В работу»',
};

/** title у задачи — «Заголовок», как в её панели; у проекта, команды и спринта — «Название», как в их формах. */
export const fieldLabel = (field: string, task = false): string =>
  task && field === 'title' ? t('Заголовок') : Object.hasOwn(FIELD_LABEL, field) ? t(FIELD_LABEL[field]!) : field;
