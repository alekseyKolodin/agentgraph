// Заглушка волны 3 (ui-docs): документ проекта — ТЗ, архитектура или дизайн — чтение с оглавлением и правка по разделам
// (spec §8.4). Пока показывает, что документ есть, и его размер.
import type { TeamDocName } from '@server/api-types';
import { useDoc } from '../../../api/teamwork';
import { t } from '../../../lib/i18n';
import { docFile, docLabel } from '../../../lib/teamwork/docs';
import { Stub } from '../parts';
import styles from '../Teamwork.module.css';

export type DocTabProps = { team: string; project: string; doc: TeamDocName };

export function DocTab({ team, project, doc }: DocTabProps) {
  const q = useDoc(team, project, doc);
  return (
    <Stub title={docLabel(doc)} what={t('чтение документа с оглавлением и требованиями, правка по разделам, история и исходник')}>
      <span className={styles.meta}>{docFile(doc)}{q.data ? ` · ${t('{n} знаков', { n: q.data.text.length })} · ${t('разделов: {n}', { n: q.data.sections.length })}` : ''}</span>
    </Stub>
  );
}
