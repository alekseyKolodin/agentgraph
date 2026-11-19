// Полоса над доской (docs/desk/plan-5.md, 5.2; макет — docs/desk/design/DeskPult.dc.html, верх доски): вопросы агентов
// (ожидания рутин, вопросы запусков, сессии, где ход за тобой — те же данные, что у Главной), «Начни с этого», сверка
// «N из N» с раскрытием по источникам, «Висит дольше N дней» с обзором недели и «Записать знание» после закрытого дела
// (этап 6, DeskMonth.tsx) и срез по проектам. Монтируется над доской в DeskBoard.tsx; выбранный проект —
// снаружи (project / onProject), чтобы доска и срез показывали одно. Логика — lib/desk-top.ts.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { HomeResponse } from '@server/api-types';
import type { DeskCheckSource } from '@server/desk/types';
import { keys, useFeature, useHome, useSpaces } from '../../../api';
import { useDesk, useDeskCheck } from '../../../api/desk';
import { useRoutines } from '../../../api/routines';
import { useSessions } from '../../../api/sessions';
import { QuestionCard } from '../../../components/question/QuestionCard';
import { useNow } from '../../../components/useNow';
import type { DeskItem } from '@server/desk/types';
import { inProject, startQueue } from '../../../lib/desk-board';
import { checkedAgo, checkSummary, checkText, checkTone, projectSlices, type CheckTone } from '../../../lib/desk-top';
import { inbox, withoutQuestion } from '../../../lib/home';
import { t } from '../../../lib/i18n';
import { activeWaits } from '../../../lib/routines/view';
import { homeSessions } from '../../../lib/sessions';
import { HomeSessions } from '../HomeSessions';
import { RoutineHome } from '../RoutineWaits';
import { LearnPrompts, useStaleDays, WeekChip, WeekPanel } from './DeskMonth';
import styles from './DeskTop.module.css';

const TICK_MS = 30_000;
/** Сколько дел назвать после первого («дальше: …»). */
const NEXT_SHOWN = 2;

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
const TONE: Record<CheckTone, string | undefined> = { ok: styles.ok, wait: styles.wait, fail: styles.fail, off: styles.off };

export type DeskTopProps = {
  /** Выбранный проект среза: слаг пространства, '' — без проекта, нет — все. */
  project?: string;
  onProject?: (project: string | undefined) => void;
  /**
   * По делу уже работает агент или открыта сессия — не «мой ход» (считает доска по живым запускам и сессиям дела). Та же
   * функция, что у номеров «В плане»: «Начни с этого» и №1 на доске — одно дело.
   */
  busy?: (i: DeskItem) => boolean;
};

export function DeskTop({ project, onProject, busy }: DeskTopProps) {
  const now = useNow(TICK_MS);
  const [week, setWeek] = useState(false);
  const [staleDays, setStaleDays] = useStaleDays();
  return (
    <div className={styles.top}>
      <Questions now={now} />
      <StartWith now={now} project={project} busy={busy} />
      <LearnPrompts now={now} />
      <div className={styles.strip}>
        <CheckStrip now={now} />
        <WeekChip open={week} onToggle={() => setWeek((v) => !v)} staleDays={staleDays} />
        <span className={styles.gap} />
        <Projects project={project} onProject={onProject} />
      </div>
      {week && <WeekPanel staleDays={staleDays} onStaleDays={setStaleDays} />}
    </div>
  );
}

/**
 * Вопросы агентов: ожидания рутин (и «догнать»), вопросы запусков с ответом на месте, сессии терминала, ждущие ответа.
 * Сломанные источники здесь не повторяются — они в сверке «N из N».
 */
function Questions({ now }: { now: number }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const home = useHome();
  const routines = useRoutines(useFeature('routines'));
  const sessionsOn = useFeature('sessions');
  const sessionList = useSessions(sessionsOn);
  const waitingSessions = homeSessions(sessionList.data?.sessions ?? []).waiting;
  const items = inbox(home.data?.runs ?? []);
  const waits = activeWaits(routines.data?.waits ?? []);
  const catchUp = routines.data?.catchUp ?? [];
  const loadHomeSoon = () => setTimeout(() => void qc.invalidateQueries({ queryKey: keys.home }), 300);
  // RoutineHome — всегда: он сам решает, показывать ли себя (строка решения «ушло» живёт, когда ожиданий уже нет)
  return (
    <section className={styles.questions} aria-label={t('Вопросы агентов')}>
      <RoutineHome waits={waits} catchUp={catchUp} routines={routines.data?.routines ?? []} now={now} />
      {items.map(({ q, run }) => (
        <QuestionCard
          key={q.id}
          q={q}
          run={run}
          onHome
          now={now}
          onOpenRun={() => void navigate(`/run/${run.id}`)}
          // ответ ушёл: убираем вопрос сразу, не дожидаясь события
          onAnswered={() => qc.setQueryData<HomeResponse>(keys.home, (d) => (d ? { runs: withoutQuestion(d.runs, run.id, q.id) } : d))}
          onFailed={loadHomeSoon}
        />
      ))}
      {waitingSessions.length > 0 && <HomeSessions sessions={waitingSessions} now={now} />}
    </section>
  );
}

/** Адрес вещи для «Открыть» — только http(s). */
const webUrl = (u: string | undefined): string | undefined => (u && /^https?:\/\//i.test(u) ? u : undefined);

/**
 * «Начни с этого»: первое по правилу без модели (startQueue — то же, что номера «В плане» на доске) и два следующих
 * строкой «дальше: …». Начинать нечего — блока нет.
 */
function StartWith({ now, project, busy }: { now: number; project?: string; busy?: (i: DeskItem) => boolean }) {
  const desk = useDesk();
  const all = desk.data?.items ?? [];
  const order = startQueue(all.filter((i) => inProject(i, project)), { now, ...(busy ? { busy } : {}) });
  const first = order[0];
  if (!first) return null;
  const { item } = first;
  const url = webUrl(item.thing?.url) ?? webUrl(item.links.mr);
  const next = order.slice(1, 1 + NEXT_SHOWN);
  return (
    <section className={styles.start} aria-label={t('С чего начать')}>
      <div className={styles.startMain}>
        <span className={styles.startLabel}>{t('Начни с этого')}</span>
        <div className={styles.startHead}>
          <span className={styles.kind}>{item.kind}</span>
          <span className={styles.startTitle} title={item.title}>{item.title}</span>
        </div>
        {item.why && <span className={styles.startWhy}>{item.why}</span>}
        <span className={styles.startReason}>{first.text}</span>
      </div>
      <div className={styles.startSide}>
        {url && (
          <a className="btn primary" href={url} target="_blank" rel="noopener noreferrer" title={url}>{t('Открыть')}</a>
        )}
        {next.length > 0 && (
          <span className={styles.startNext} title={next.map((p) => p.item.title).join('\n')}>
            {t('дальше: {list}', { list: next.map((p) => p.item.title).join(', ') })}
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * Сверка (макет: строка над доской): «Проверено N минут назад», по чипу на источник — точка и название, у поломки — что
 * сломано (красным), «N из N в порядке» раскрывает список с итогом каждой проверки; есть сломанный источник — «Починить»
 * ведёт к рутинам. Сервер без сверки — ничего.
 */
function CheckStrip({ now }: { now: number }) {
  const check = useDeskCheck();
  const [open, setOpen] = useState(false);
  if (!check.data) return null;
  const date = new Date(now);
  const sum = checkSummary(check.data);
  const ago = checkedAgo(check.data, date);
  const nameOf = (s: DeskCheckSource) => (s.kind === 'watcher' ? t('Наблюдатели дел') : s.title);
  return (
    <div className={styles.check}>
      {ago && <span className={styles.ago}>{ago}</span>}
      {check.data.sources.map((s) => {
        const tone = checkTone(s);
        const problem = sum.problems.includes(s);
        const text = checkText(s, date);
        return (
          <span key={`${s.kind}:${s.slug}`} className={cx(styles.source, tone === 'fail' && styles.failText)} title={`${nameOf(s)}: ${text}`}>
            <span className={cx(styles.dot, TONE[tone])} aria-hidden="true" />
            <span className={styles.sourceText}>{problem ? `${nameOf(s)}: ${text}` : nameOf(s)}</span>
          </span>
        );
      })}
      {sum.problems.some((s) => s.kind === 'source') && (
        <Link className="btn small" to="/routines" title={t('Открыть рутины и источники')}>{t('Починить')}</Link>
      )}
      <button
        type="button"
        className={styles.chip}
        aria-expanded={open}
        title={open ? t('Свернуть список источников') : t('Каждый источник и наблюдатели: когда проверены и что нашли')}
        onClick={() => setOpen((v) => !v)}
      >
        {t('{ok} из {total} в порядке', { ok: sum.ok, total: sum.total })}
        <span className={styles.caret} aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <ul className={styles.list} aria-label={t('Сверка по источникам')}>
          {check.data.sources.map((s) => (
            <li key={`${s.kind}:${s.slug}`} className={styles.row}>
              <span className={cx(styles.dot, TONE[checkTone(s)])} aria-hidden="true" />
              <span className={styles.rowTitle}>{nameOf(s)}</span>
              <span className={cx(styles.rowText, checkTone(s) === 'fail' && styles.failText)}>{checkText(s, date)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Срез по проектам: «Все N» и пространства с открытыми делами; «идёт N» — сессии и запуски пространства сейчас. */
function Projects({ project, onProject }: DeskTopProps) {
  const desk = useDesk();
  const spaces = useSpaces(useFeature('spaces'));
  const { all, slices } = projectSlices(desk.data?.items ?? [], spaces.data?.spaces ?? []);
  // один проект (или ни одного) — срез ничего не делит
  if (slices.length < 2 && project === undefined) return null;
  const pick = (p: string | undefined) => onProject?.(p === project ? undefined : p);
  return (
    <div className={styles.projects} role="group" aria-label={t('Срез по проектам')}>
      <button type="button" className={cx(styles.pill, project === undefined && styles.on)} aria-pressed={project === undefined} onClick={() => onProject?.(undefined)}>
        {t('Все')} <span className={styles.n}>{all}</span>
      </button>
      {slices.map((s) => (
        <button
          key={s.project || '-'}
          type="button"
          className={cx(styles.pill, project === s.project && styles.on)}
          aria-pressed={project === s.project}
          title={s.live ? t('Сейчас идёт: {n}', { n: s.live }) : undefined}
          onClick={() => pick(s.project)}
        >
          {s.live > 0 && <span className={cx(styles.dot, styles.live)} aria-hidden="true" />}
          {s.title} <span className={styles.n}>{s.count}</span>
        </button>
      ))}
    </div>
  );
}
