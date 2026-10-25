// Бейджи (ui/app.js badge, tagBadge, ADHOC_TAG): статус запуска — цвет по классу статуса из base.css, подпись по-русски;
// тег задачи и тег знаний; «разовый» у черновика и разового запуска.
import type { TagKind } from '@server/api-types';
import { statusLabel } from '../lib/format';

export function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{statusLabel(status)}</span>;
}

export function TagBadge({ slug, kind = 'task' }: { slug: string; kind?: TagKind }) {
  return kind === 'knowledge'
    ? <span className="badge tag knowledge" title="Тег области знаний: заметки, пути и вложения для промптов этапов">#{slug}</span>
    : <span className="badge tag" title="Тег задачи: саммари фичи между запусками">#{slug}</span>;
}

export function AdhocBadge() {
  return <span className="badge adhoc" title="Разовый запуск: flow не сохранён в flows/, его копия — в папке запуска">разовый</span>;
}
