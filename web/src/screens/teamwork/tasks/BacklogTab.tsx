// Заглушка волны 3 (ui-tasks): бэклог — задачи без спринта по rank, «Следующий спринт» сверху, быстрое создание,
// перетаскивание, «Разбить ТЗ на задачи» с принятием предложения (spec §8.5).
import { useTasks } from '../../../api/teamwork';
import { t } from '../../../lib/i18n';
import { backlogTasks } from '../../../lib/teamwork/backlog';
import { Stub } from '../parts';
import styles from '../Teamwork.module.css';

export type BacklogTabProps = { team: string; project: string };

export function BacklogTab({ team, project }: BacklogTabProps) {
  const q = useTasks(team, project);
  const backlog = backlogTasks(q.data ?? []);
  return (
    <Stub title={t('Бэклог')} what={t('задачи без спринта по приоритету, следующий спринт, быстрое создание, разбивка ТЗ на задачи')}>
      <span className={styles.meta}>{t('задач в бэклоге: {n}', { n: backlog.length })}</span>
    </Stub>
  );
}
