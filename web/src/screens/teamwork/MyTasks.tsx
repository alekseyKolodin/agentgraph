// Главная, блок «Мои задачи» (spec §11): задачи активных спринтов во всех командах, где исполнитель — я, из одного запроса
// GET /api/teams/mine. Строка: номер, заголовок (ссылка на панель задачи поверх доски), команда · проект · спринт, статус
// названием колонки команды, «ждёт PAY-3», мой запуск или сессия по задаче и «В работу ▸». Блок есть, только когда есть
// хотя бы одна команда; HomeScreen грузит этот файл лениво вместе с экранами Teamwork.
import type { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { TeamMine } from '@server/api-types';
import { plural, t } from '../../lib/i18n';
import { blockedLabel } from '../../lib/teamwork/board';
import { canSendToWork, myTaskRows, unknownMe, workHref } from '../../lib/teamwork/mine';
import { cx } from './parts';
import { taskBoardPath, TEAMS_PATH, teamPath } from './shell';
import { columnText } from './tasks/parts';
import { ToWorkButton } from './tasks/ToWork';
import tw from './Teamwork.module.css';
import styles from './MyTasks.module.css';

export function MyTasks({ mine, className }: { mine: TeamMine; className?: string }) {
  const navigate = useNavigate();
  const { rows, done } = myTaskRows(mine);
  const noEmail = unknownMe(mine);
  return (
    <section className={className} aria-labelledby="home-my-tasks">
      <h2 id="home-my-tasks" title={t('Задачи активных спринтов во всех командах, где исполнитель — вы')}>
        {t('Мои задачи')}
        {rows.length > 0 && <span className={styles.count}>{rows.length}</span>}
      </h2>
      {rows.length > 0 && (
        <ul className={styles.list}>
          {rows.map((r) => {
            const to = taskBoardPath(r.team.slug, r.project.slug, r.task.id);
            // клик по строке мимо ссылок и кнопок — открыть задачу; меню и форма «В работу» (портал) сюда не считаются
            const open = (e: MouseEvent<HTMLLIElement>) => {
              const el = e.target as HTMLElement;
              if (!e.currentTarget.contains(el) || el.closest('a, button, input, select, textarea, dialog, [role="menu"]')) return;
              void navigate(to);
            };
            const b = r.badge;
            return (
              <li key={r.key} className={cx(styles.row, b?.state === 'waiting' && styles.wait)} onClick={open}>
                <span className={styles.id}>{r.task.id}</span>
                <div className={styles.main}>
                  <Link to={to} className={styles.title} title={r.task.title}>{r.task.title}</Link>
                  <div className={styles.meta}>
                    <span className={styles.where} title={`${r.team.title} · ${r.project.title} · ${r.project.sprint.title}`}>
                      {`${r.team.title} · ${r.project.title} · ${r.project.sprint.title}`}
                    </span>
                    {r.waiting.length > 0 && <span className={styles.q}>{blockedLabel(r.waiting)}</span>}
                    {b && (
                      <Link to={workHref(b.work)} className={cx(styles.work, b.state === 'waiting' && tw.tWait, b.state === 'failed' && styles.fail)} title={b.text}>
                        <span className={cx(tw.dot, tw.s6, b.state === 'waiting' && tw.wait, b.state === 'failed' && tw.fail)} aria-hidden="true" />
                        {b.text}
                      </Link>
                    )}
                  </div>
                </div>
                <span className={styles.status}>{columnText(r.task.status, r.team.columns)}</span>
                <span className={styles.acts}>
                  {b?.state === 'waiting' && <Link className="btn small" to={workHref(b.work)}>{t('Ответить')}</Link>}
                  {canSendToWork(r) && <ToWorkButton td={r.team} p={r.project} task={r.task} />}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {!rows.length && mine.teams.some((x) => x.me) && (
        <p className={styles.empty}>
          {done ? t('Все ваши задачи в активных спринтах готовы.') : t('В активных спринтах задач на вас нет.')}{' '}
          <Link to={mine.teams.length === 1 ? teamPath(mine.teams[0]!.slug) : TEAMS_PATH}>{mine.teams.length === 1 ? t('К команде') : t('К командам')}</Link>
        </p>
      )}
      {rows.length > 0 && done > 0 && <p className={styles.empty}>{t('Уже готово: ещё {n} {tasks}.', { n: done, tasks: plural(done, 'задача', 'задачи', 'задач') })}</p>}
      {noEmail.length > 0 && (
        <p className={cx(styles.empty, tw.tWait)}>
          {t('Git не знает ваш email, поэтому задачи в «{teams}» не найти: git config --global user.email you@example.com', { teams: noEmail.map((x) => x.title).join('», «') })}
        </p>
      )}
    </section>
  );
}
