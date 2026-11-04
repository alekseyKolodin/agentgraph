// Бейджи (ui/app.js badge, tagBadge, ADHOC_TAG): статус запуска — цвет по классу статуса из base.css, подпись по-русски;
// пространство, тег знаний (и тег задачи старых запусков); «разовый» у черновика и разового запуска.
import { Link } from 'react-router';
import type { TagKind } from '@server/api-types';
import { statusLabel } from '../lib/format';
import { t } from '../lib/i18n';

export function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{statusLabel(status)}</span>;
}

export function TagBadge({ slug, kind = 'knowledge' }: { slug: string; kind?: TagKind }) {
  // слаг — и в подсказке: в узком месте пилюля обрезается многоточием
  return kind === 'knowledge'
    ? <span className="badge tag knowledge" title={`#${slug}\n${t('Тег знаний: строка в промпте, полный текст — по запросу инструментом knowledge_read')}`}>#{slug}</span>
    : <span className="badge tag" title={`#${slug}\n${t('Тег задачи старого запуска: теперь пространство {slug}', { slug })}`}>#{slug}</span>;
}

/** Пространство запуска или сессии: ромб и слаг; link — ссылкой на страницу пространства (клик не уходит в строку). */
export function SpaceBadge({ slug, link = false }: { slug: string; link?: boolean }) {
  const title = `${slug}\n${t('Пространство: карта, документы, состояние «где мы сейчас»')}`;
  return link
    ? <Link className="badge space" to={`/spaces/${encodeURIComponent(slug)}`} title={title} onClick={(e) => e.stopPropagation()}>◇ {slug}</Link>
    : <span className="badge space" title={title}>◇ {slug}</span>;
}

export function AdhocBadge() {
  return <span className="badge adhoc" title={t('Разовый запуск: flow не сохранён в flows/, его копия — в папке запуска')}>{t('разовый')}</span>;
}
