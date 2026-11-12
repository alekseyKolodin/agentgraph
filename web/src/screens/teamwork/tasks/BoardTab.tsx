// Заглушка волны 3 (ui-tasks): доска активного спринта — четыре колонки по статусам, карточки с исполнителем, оценкой,
// значками запуска и PR, фильтры, «В работу ▸» (spec §8.7–8.9).
import { useProject, useTasks } from '../../../api/teamwork';
import { t } from '../../../lib/i18n';
import { activeSprint, sprintStrip, sprintTasks } from '../../../lib/teamwork/board';
import { Stub } from '../parts';
import styles from '../Teamwork.module.css';

export type BoardTabProps = { team: string; project: string };

export function BoardTab({ team, project }: BoardTabProps) {
  const p = useProject(team, project);
  const q = useTasks(team, project);
  const active = activeSprint(p.data?.sprints ?? []);
  const strip = active ? sprintStrip(sprintTasks(q.data ?? [], active.number)) : undefined;
  return (
    <Stub title={t('Доска')} what={t('колонки по статусам, карточки задач, фильтры, перенос мышью и с клавиатуры, «В работу ▸»')}>
      <span className={styles.meta}>{active && strip ? `${active.title} · ${strip.progress}` : t('Спринт не запущен')}</span>
    </Stub>
  );
}
