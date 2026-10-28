// Бейджи (ui/app.js badge, tagBadge, ADHOC_TAG): статус запуска — цвет по классу статуса из base.css, подпись по-русски;
// тег задачи и тег знаний; «разовый» у черновика и разового запуска.
import type { TagKind } from '@server/api-types';
import { statusLabel } from '../lib/format';
import { t } from '../lib/i18n';

export function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{statusLabel(status)}</span>;
}

export function TagBadge({ slug, kind = 'task' }: { slug: string; kind?: TagKind }) {
  // слаг — и в подсказке: в узком месте пилюля обрезается многоточием
  return kind === 'knowledge'
    ? <span className="badge tag knowledge" title={`#${slug}\n${t('Тег области знаний: заметки, пути и вложения для промптов этапов')}`}>#{slug}</span>
    : <span className="badge tag" title={`#${slug}\n${t('Тег задачи: саммари фичи между запусками')}`}>#{slug}</span>;
}

export function AdhocBadge() {
  return <span className="badge adhoc" title={t('Разовый запуск: flow не сохранён в flows/, его копия — в папке запуска')}>{t('разовый')}</span>;
}
