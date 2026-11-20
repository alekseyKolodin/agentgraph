// Слова о рутине для разделов редактора и «Новой рутины»: куда уйдёт ответ («в тред сообщения», «мне в Telegram») и
// название по умолчанию («Fireflies.ai → meeting-to-tasks»).
import type { SourceView } from '@server/routines/types';
import { t } from '../i18n';
import { describeSchedule, toCron } from './schedule';
import { isSchedule, type RoutineDraft } from './spec';

/** Куда уйдёт ответ: строка ответа в «Как узнаю» и подписи «Отвечать … вместо …». */
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

/** Название рутины по умолчанию: «Fireflies.ai → meeting-to-tasks». */
export function defaultTitle(d: RoutineDraft, sourceTitle: string | undefined): string {
  const from = isSchedule(d) ? describeSchedule(toCron(d.schedule)) : (sourceTitle ?? '');
  return d.flow ? `${from} → ${d.flow}` : from;
}
