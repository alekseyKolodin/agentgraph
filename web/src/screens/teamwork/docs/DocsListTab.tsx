// Заглушка волны 3 (ui-docs): прочие документы проекта из docs/ — список, открытие и новый документ.
import { useProject } from '../../../api/teamwork';
import { t } from '../../../lib/i18n';
import { Stub } from '../parts';
import styles from '../Teamwork.module.css';

export type DocsListTabProps = { team: string; project: string };

export function DocsListTab({ team, project }: DocsListTabProps) {
  const q = useProject(team, project);
  const docs = (q.data?.docs ?? []).filter((d) => d.name.startsWith('docs/'));
  return (
    <Stub title={t('Документы')} what={t('список документов из docs/, открытие и новый документ')}>
      <span className={styles.meta}>{docs.length ? docs.map((d) => d.name.replace(/^docs\//, '')).join(' · ') : t('в docs/ пока пусто')}</span>
    </Stub>
  );
}
