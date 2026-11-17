// Фраза-итог «Получится» сбоку от «Новой рутины» и подписи слотов: собирается из выбранного в шагах — когда, какие
// условия, что запустить и где, когда ждать человека, куда и как ответить.
import type { MatchField, SourceView } from '@server/routines/types';
import { t } from '../i18n';
import { conditionReady, conditionText } from './match';
import { describeSchedule, toCron } from './schedule';
import { isSchedule, type ReplyChoice, type RoutineDraft } from './spec';

/** Виды, у которых событие — сообщение (тред, чат, письмо): «приходит новое сообщение», шаг 2 — «Какие сообщения». */
const MESSAGES = new Set(['slack', 'telegram', 'email']);
/** Виды кода и задач: «Какое событие». */
const EVENTS = new Set(['gitlab', 'github', 'jira']);

/** Заголовок шага 2 по виду выбранного источника. */
export function step2Title(kind: string | undefined): string {
  if (kind === undefined) return t('Когда');
  if (MESSAGES.has(kind)) return t('Какие сообщения');
  if (EVENTS.has(kind)) return t('Какое событие');
  return t('Какие записи');
}

/** «для каждой новой встречи» в шаге 2: что считается событием у вида. */
export function eventNoun(kind: string | undefined): string {
  if (kind && MESSAGES.has(kind)) return t('для каждого нового сообщения');
  if (kind && EVENTS.has(kind)) return t('для каждого нового события');
  return t('для каждой новой записи');
}

/** Куда уйдёт ответ: слот «Писать …» шага 4 и строка «Ответить» редактора. */
export function replyWhere(kind: string | undefined, replyTo: string, sources: Pick<SourceView, 'slug' | 'spec'>[]): string {
  if (replyTo && replyTo !== 'source') {
    const s = sources.find((x) => x.slug === replyTo);
    return t('мне в {where}', { where: s?.spec.title ?? replyTo });
  }
  switch (kind) {
    case 'slack':
      return t('в тред сообщения');
    case 'telegram':
      return t('в тот же чат');
    case 'gitlab':
    case 'github':
      return t('комментарием в MR');
    case 'jira':
      return t('комментарием в задаче');
    case 'email':
      return t('ответом на письмо');
    default:
      return t('туда, откуда пришло');
  }
}

/** Подсказка под переключателем шага 4. */
export function replyHint(c: ReplyChoice): string {
  return { draft: t('Текст ждёт на главной и уходит, когда ты его одобришь.'), auto: t('Рутина пишет сама: когда ждёт тебя и когда закончила.'), off: t('Итог будет виден только в agentgraph.') }[c];
}

export function replyLabel(c: ReplyChoice): string {
  return { draft: t('После моей проверки'), auto: t('Сразу'), off: t('Не сообщать') }[c];
}

/** «Когда …» — начало фразы: расписание или источник с условиями и проверкой словами. */
export function whenText(d: RoutineDraft, source: { title: string; kind: string } | undefined, fields: MatchField[]): string {
  if (isSchedule(d)) return describeSchedule(toCron(d.schedule));
  if (!source) return t('Когда что-то происходит');
  const head = MESSAGES.has(source.kind)
    ? t('Когда в {source} приходит новое сообщение', { source: source.title })
    : EVENTS.has(source.kind)
      ? t('Когда в {source} появляется новое событие', { source: source.title })
      : t('Когда в {source} появляется новая запись', { source: source.title });
  const conds = d.conds.filter(conditionReady).map((c) => conditionText(c, fields));
  const where = conds.length ? t(', где {conds}', { conds: conds.join(t(' и ')) }) : '';
  const check = d.check.trim() ? t(' и оно подходит под условие словами') : '';
  return head + where + check;
}

/** Фраза целиком: «По будням в 09:30 запустить mr-digest в ◇ billing. Ответ уходит после твоей проверки.» */
export function sentence(d: RoutineDraft, source: { title: string; kind: string } | undefined, fields: MatchField[]): string {
  const when = whenText(d, source, fields);
  const flow = d.flow || '…';
  const run = isSchedule(d) ? t(' запустить {flow}', { flow }) : t(', запустить {flow}', { flow });
  const space = d.space ? t(' в ◇ {space}', { space: d.space }) : '';
  const wait =
    d.mode === 'suggest'
      ? t(' Перед запуском спросит тебя.')
      : d.mode === 'until_pause' && d.pauseBefore.length
        ? t(' Остановится перед {blocks}.', { blocks: d.pauseBefore.map((b) => `«${b}»`).join(', ') })
        : '';
  const reply = { draft: t(' Ответ уходит после твоей проверки.'), auto: t(' О результате пишет сама.'), off: '' }[d.reply];
  return `${when}${run}${space}.${wait}${reply}`;
}

/** Название рутины по умолчанию: «Fireflies.ai → meeting-to-tasks». */
export function defaultTitle(d: RoutineDraft, sourceTitle: string | undefined): string {
  const from = isSchedule(d) ? describeSchedule(toCron(d.schedule)) : (sourceTitle ?? '');
  return d.flow ? `${from} → ${d.flow}` : from;
}
