// Общие детали экранов Teamwork (волны 2–3): инициалы участника, полоса спринта, вкладки, крошки, заглушка «будет в следующей
// волне». Стили — Teamwork.module.css; классы sprint strip общие с макетом Board (st.done / review / in_progress / todo).
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { TeamMember, TeamTaskStatus } from '@server/api-types';
import { STRIP_ORDER } from '../../lib/teamwork/board';
import { t } from '../../lib/i18n';
import { initialsOf, TEAMS_PATH } from './shell';
import styles from './Teamwork.module.css';

export const cx = (...list: (string | false | null | undefined)[]): string => list.filter(Boolean).join(' ');

/** Кружок с инициалами: участник, email или никто (пунктир — «без исполнителя»). */
export function Who({ member, email, className, title }: { member?: Pick<TeamMember, 'name' | 'email'>; email?: string; className?: string; title?: string }) {
  const name = member?.name;
  const mail = member?.email ?? email;
  if (!name && !mail) return <span className={cx(styles.who, styles.none, className)} aria-label={t('Без исполнителя')} title={title ?? t('Без исполнителя')} />;
  const label = name ? (mail ? `${name} · ${mail}` : name) : mail!;
  return <span className={cx(styles.who, className)} title={title ?? label} aria-label={label}>{initialsOf(name, mail)}</span>;
}

/** Инициалы участников команды в ряд: шапка команды и проекта. */
export function People({ members, max = 6 }: { members: readonly TeamMember[]; max?: number }) {
  if (!members.length) return null;
  const shown = members.slice(0, max);
  const rest = members.length - shown.length;
  return (
    <span className={styles.people} aria-label={t('Участники: {names}', { names: members.map((m) => m.name || m.email).join(', ') })}>
      {shown.map((m) => <Who key={m.email} member={m} />)}
      {rest > 0 && <span className={styles.who} title={members.slice(max).map((m) => m.name || m.email).join('\n')}>+{rest}</span>}
    </span>
  );
}

/**
 * Полоса спринта: по ячейке на задачу в порядке готово → ревью → в работе → к работе (STRIP_ORDER). counts — из
 * TeamProjectBrief.sprint.counts или sprintStrip(tasks).counts; big — крупные ячейки обзора проекта.
 */
export function SprintStrip({ counts, label, big }: { counts: Record<TeamTaskStatus, number>; label: string; big?: boolean }) {
  const cells = STRIP_ORDER.flatMap((s) => Array<TeamTaskStatus>(counts[s] ?? 0).fill(s));
  return (
    <span className={cx(styles.strip, big && styles.big)} role="img" aria-label={label} title={label}>
      {cells.map((s, i) => <span key={i} className={cx(styles.st, styles[s])} />)}
    </span>
  );
}

export type TabItem = { key: string; to: string; label: string; count?: number; mark?: boolean; title?: string };

/** Подчёркнутые вкладки-ссылки под шапкой (как .tabs «Пульта»): count — моно справа от подписи, mark — синяя точка «идёт». Активная — по active, не по адресу: у вкладок команды он отличается только ?tab=. */
export function Tabs({ items, active, label }: { items: readonly TabItem[]; active: string; label: string }) {
  return (
    <nav className={styles.tabs} aria-label={label}>
      {items.map((it) => (
        <Link key={it.key} to={it.to} className={cx(styles.tab, it.key === active && styles.active)} aria-current={it.key === active ? 'page' : undefined} title={it.title}>
          {it.label}
          {it.count !== undefined && <span className={styles.n}>{it.count}</span>}
          {it.mark && <span className={styles.mark} aria-hidden="true" />}
        </Link>
      ))}
    </nav>
  );
}

/** Крошки над шапкой: «Teamwork › Команда». */
export function Crumbs({ items }: { items: readonly { to: string; label: string }[] }) {
  return (
    <p className={styles.crumbs}>
      <Link to={TEAMS_PATH}>Teamwork</Link>
      {items.map((it) => (
        <span key={it.to}>
          {' › '}
          <Link to={it.to}>{it.label}</Link>
        </span>
      ))}
    </p>
  );
}

/** Заглушка вкладки или панели волны 3: что здесь будет и с какими данными. */
export function Stub({ title, what, children }: { title: string; what: string; children?: ReactNode }) {
  return (
    <section className={styles.stub} aria-label={title}>
      <h2>{title}</h2>
      <p>{t('Будет в следующей волне: {what}', { what })}</p>
      {children}
    </section>
  );
}

/** Ошибка запроса одной строкой. */
export function ErrorLine({ text }: { text: string }) {
  return text ? <p className="msg err">{text}</p> : null;
}
