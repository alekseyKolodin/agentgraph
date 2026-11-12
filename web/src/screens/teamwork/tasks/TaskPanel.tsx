// Заглушка волны 3 (ui-tasks): панель задачи поверх вкладки проекта (?task=ID) — поля, описание и критерии с галочками,
// комментарии, блок «Работа», «В работу ▸» (spec §11). Оболочка уже открывает её по адресу и закрывает по × и Esc.
import { useTasks } from '../../../api/teamwork';
import { t } from '../../../lib/i18n';
import { Stub } from '../parts';
import styles from '../Teamwork.module.css';

export type TaskPanelProps = { team: string; project: string; id: string; onClose: () => void };

export function TaskPanel({ team, project, id, onClose }: TaskPanelProps) {
  const q = useTasks(team, project);
  const task = q.data?.find((x) => x.id === id);
  return (
    <>
      <div className="dlg-head">
        <span><span className={styles.meta}>{id}</span> {task?.title ?? (q.data ? t('Задачи нет') : '')}</span>
        <button type="button" className="btn ghost small" aria-label={t('Закрыть')} title={t('Закрыть (Esc)')} onClick={onClose}>×</button>
      </div>
      <Stub title={t('Задача')} what={t('поля задачи, описание и критерии приёмки, комментарии, работа агентов, «В работу ▸»')} />
    </>
  );
}
