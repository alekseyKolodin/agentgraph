// Главная, блок «Мои задачи» (spec §11, docs/desk/SPEC.md 4.3): мои задачи во всех командах — в спринтах и в бэклоге — из
// GET /api/teams/mine, а колонка, «почему» и «новое» — из дел (GET /api/desk, поставщик Teamwork): задача и дело — одно.
// Строка: номер, заголовок (ссылка на панель задачи поверх доски), команда · проект · спринт или бэклог, статус названием
// колонки команды, «новое» с причиной (назначил коллега, его комментарий), «ждёт PAY-3», мой запуск или сессия по задаче
// и «В работу ▸». Открыл новую — дело отмечается виденным. Блок есть, только когда есть хотя бы одна команда; HomeScreen
// грузит этот файл лениво вместе с экранами Teamwork.
import type { MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type { TeamMine } from '@server/api-types';
import { putDesk, refreshDesk, useDesk } from '../../api/desk';
import { plural, t } from '../../lib/i18n';
import { blockedLabel } from '../../lib/teamwork/board';
import { canSendToWork, myTaskRows, rowWhere, unknownMe, workHref, type MyTaskRow } from '../../lib/teamwork/mine';
import { cx } from './parts';
import { taskBoardPath, TEAMS_PATH, teamPath } from './shell';
import { columnText } from './tasks/parts';
import { ToWorkButton } from './tasks/ToWork';
import tw from './Teamwork.module.css';
import styles from './MyTasks.module.css';

export function MyTasks({ mine, className }: { mine: TeamMine; className?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { rows, done } = myTaskRows(mine, useDesk().data?.items);
  // открыл новое — виденное: дело уходит из «Нового» (put от меня без правки)
  const seen = (r: MyTaskRow) => {
    if (r.item?.column !== 'new') return;
    void putDesk({}, r.item.key).then(() => refreshDesk(qc), () => undefined);
  };
  const noEmail = unknownMe(mine);
  return (
    <section className={className} aria-labelledby="home-my-tasks">
      <h2 id="home-my-tasks" title={t('Ваши задачи во всех командах: в спринтах и в бэклоге')}>
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
              seen(r);
              void navigate(to);
            };
            const b = r.badge;
            const fresh = r.item?.column === 'new';
            const where = rowWhere(r, t('бэклог'), (n) => t('спринт {n}', { n }));
            return (
              <li key={r.key} className={cx(styles.row, b?.state === 'waiting' && styles.wait)} onClick={open}>
                <span className={styles.id}>{r.task.id}</span>
                <div className={styles.main}>
                  <Link to={to} className={styles.title} title={r.task.title} onClick={() => seen(r)}>{r.task.title}</Link>
                  <div className={styles.meta}>
                    {fresh && (
                      <span className={styles.fresh} title={r.item!.why}>
                        <span className={styles.freshTag}>{t('новое')}</span>
                        {r.item!.why}
                      </span>
                    )}
                    <span className={styles.where} title={where}>{where}</span>
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
          {done ? t('Все ваши задачи готовы.') : t('Задач на вас нет.')}{' '}
          <Link to={mine.teams.length === 1 ? teamPath(mine.teams[0]!.slug) : TEAMS_PATH}>{mine.teams.length === 1 ? t('К команде') : t('К командам')}</Link>
        </p>
      )}
      {rows.length > 0 && done > 0 && <p className={styles.empty}>{t('Уже готово: ещё {n} {tasks}.', { n: done, tasks: plural(done, 'задача', 'задачи', 'задач') })}</p>}
      {noEmail.length > 0 && (
        <p className={cx(styles.empty, tw.tWait)}>
          {t('Git не знает ваш email, поэтому ваши задачи в командах {teams} не найти: git config --global user.email you@example.com', { teams: noEmail.map((x) => x.title).join(', ') })}
        </p>
      )}
      {/* teamwork.yaml команды не читается: задач в ней не найти, а пустой блок молчал бы почему */}
      {mine.teams.filter((x) => x.error).map((x) => (
        <p key={x.slug} className={cx(styles.empty, styles.fail)}>
          <Link to={teamPath(x.slug)}>{x.slug}</Link>
          {`: ${t('teamwork.yaml не читается — {error}', { error: x.error! })}`}
        </p>
      ))}
    </section>
  );
}
