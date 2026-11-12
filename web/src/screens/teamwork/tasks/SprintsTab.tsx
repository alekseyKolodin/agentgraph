// Заглушка волны 3 (ui-tasks): спринты — запуск и завершение с итогом, история закрытых спринтов (spec §8.6).
import { useProject } from '../../../api/teamwork';
import { t } from '../../../lib/i18n';
import { closedSprints } from '../../../lib/teamwork/sprint';
import { Stub } from '../parts';
import styles from '../Teamwork.module.css';

export type SprintsTabProps = { team: string; project: string };

export function SprintsTab({ team, project }: SprintsTabProps) {
  const p = useProject(team, project);
  const sprints = p.data?.sprints ?? [];
  return (
    <Stub title={t('Спринты')} what={t('запуск и завершение спринта с итогом, история закрытых спринтов')}>
      <span className={styles.meta}>{t('спринтов: {n}, закрытых: {closed}', { n: sprints.length, closed: closedSprints(sprints).length })}</span>
    </Stub>
  );
}
