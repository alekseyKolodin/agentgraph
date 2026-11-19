// Доска «Мои дела» (docs/desk/SPEC.md, этап 5, макет docs/desk/design/DeskPult.dc.html): пять колонок по состоянию,
// карточка с видом, проектом, сроком, возрастом, «почему твой ход» и действиями. Дела — только из api/desk.ts; сессии,
// запуски, пространства и проекты «Подключений» — чтобы найти связи дела и папку для сессии. Монтирует Главная
// (HomeScreen.tsx) с project — срезом по проекту; полоса над доской (вопросы агентов, сверка, «Начни с этого») — DeskTop.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionView } from '@server/api-types';
import type { DeskColumn as Column, DeskItem } from '@server/desk/types';
import { errorText, fetchIntegrations, keys, useConfig, useFeature, useRuns } from '../../../api';
import { closeDesk, linkDesk, moveDesk, refreshDesk, useDesk, useDeskCheck } from '../../../api/desk';
import { useRoutines } from '../../../api/routines';
import { continueSession, createSession, defaultSessionCwd, sessionKeys, thingIntake, useSessions } from '../../../api/sessions';
import { useSpaces } from '../../../api/spaces';
import { useToast } from '../../../components/Toast';
import { useNow } from '../../../components/useNow';
import { thingSessionPrompt } from '../../../lib/dash';
import {
  columnTitle,
  deskBoard,
  intakeTarget,
  itemPrompt,
  itemRuns,
  itemSessionName,
  itemSessions,
  sessionCwd,
  type DeskProject,
} from '../../../lib/desk-board';
import { quietBoard, type CheckTone } from '../../../lib/desk-top';
import { LIVE_STATUSES } from '../../../lib/home';
import { t } from '../../../lib/i18n';
import { termSize } from '../../../lib/sessions';
import { FlowPicker, pickerAt, type PickerState } from '../FlowPicker';
import { DeskCard, type CardActions } from './DeskCard';
import { DeskColumn } from './DeskColumn';
import { DeskTop } from './DeskTop';
import styles from './Desk.module.css';

/** Цвет квадрата проекта — категория по слагу: один проект — один цвет на всех карточках. */
function projectTone(slug: string): number {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 8) + 1;
}

/** Точка подсказки пустой доски — цвет сверки (не проверялось — серая). */
const QUIET_TONE: Record<CheckTone, string | undefined> = { ok: styles.toneOk, wait: styles.toneWait, fail: styles.toneFail, off: undefined };

/** Перенос, который сервер ещё не подтвердил: карточка уже в новой колонке; seq — чей (снимает только свой ответ). */
type Pending = Record<string, { to: Column; seq: number; item: DeskItem }>;

function withPending(i: DeskItem, to: Column | undefined, now: number): DeskItem {
  if (!to || to === i.column) return i;
  const at = new Date(now).toISOString();
  const { closed: _closed, ...rest } = i;
  return { ...rest, column: to, movedAt: at, movedBy: 'me', ...(to === 'done' ? { closed: { at, reason: i.closed?.reason ?? 'закрыто вручную' } } : {}) };
}

/** project — срез по проекту ('' — без проекта), onProject — сменить срез (пилюли проектов в DeskTop; Главная держит его в адресе). */
export function DeskBoard({ project, onProject }: { project?: string; onProject?: (project: string | undefined) => void }) {
  const on = useFeature('desk');
  const open = useDesk({ open: true });
  // рутины и сверка — только для подсказки пустой доски: рутины есть, а дел нет
  const routinesOn = useFeature('routines');
  const routines = useRoutines(routinesOn);
  const check = useDeskCheck();
  // «Готово» — закрытые: доска показывает сегодняшние
  const closed = useDesk({ column: ['done'], open: false });
  const sessionsOn = useFeature('sessions');
  const sessions = useSessions(sessionsOn).data?.sessions ?? [];
  const runs = useRuns().data ?? [];
  const spaces = useSpaces(useFeature('spaces')).data?.spaces ?? [];
  const integrationsOn = useFeature('integrations');
  const projects = useQuery({ queryKey: keys.integrations, queryFn: fetchIntegrations, staleTime: 5 * 60_000, enabled: integrationsOn }).data?.projects ?? [];
  const config = useConfig().data;
  const now = useNow(60_000);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [pending, setPending] = useState<Pending>({});
  const [dragging, setDragging] = useState<string>();
  const [picker, setPicker] = useState<PickerState>(null);
  const [said, setSaid] = useState('');
  const focusKey = useRef<string | null>(null);
  const seq = useRef(0);

  const all = useMemo(() => {
    const byKey = new Map<string, DeskItem>();
    for (const i of [...(closed.data?.items ?? []), ...(open.data?.items ?? [])]) byKey.set(i.key, i);
    // закрытое уходит из открытых раньше, чем приходит в закрытые (два запроса): пока перенос не снят — снимок дела, иначе
    // карточка на миг пропадёт вместе с фокусом
    for (const [key, p] of Object.entries(pending)) if (!byKey.has(key)) byKey.set(key, p.item);
    return [...byKey.values()].map((i) => withPending(i, pending[i.key]?.to, now));
  }, [open.data, closed.data, pending, now]);

  const related = useMemo(() => {
    const m = new Map<string, { sessions: SessionView[]; runs: typeof runs }>();
    for (const i of all) m.set(i.key, { sessions: itemSessions(i, sessions), runs: itemRuns(i, runs) });
    return m;
  }, [all, sessions, runs]);
  const busy = (i: DeskItem) => {
    const r = related.get(i.key);
    return Boolean(r && (r.runs.some((x) => LIVE_STATUSES.includes(x.status)) || r.sessions.some((s) => s.live)));
  };
  const view = deskBoard(all, { now, project: project as DeskProject, busy });
  const spaceTitle = new Map(spaces.map((s) => [s.slug, s.title || s.slug]));

  // перенос, закрытие или привязка с клавиатуры: карточка теперь в другой колонке (или под новым ключом) — фокус за ней,
  // как только она появится
  useEffect(() => {
    const key = focusKey.current;
    const el = key ? document.querySelector<HTMLElement>(`[data-desk-key="${CSS.escape(key)}"]`) : null;
    if (!el) return;
    focusKey.current = null;
    if (document.activeElement !== el) el.focus();
  });

  if (!on) return null;
  // полоса над доской (вопросы агентов, сверка, «Начни с этого», срез) — и пока дела грузятся или не загрузились: вопросы от них не зависят
  const top = <DeskTop project={project} onProject={onProject} busy={busy} />;
  if (open.isError) return <>{top}<p className={`${styles.msg} ${styles.err}`}>{t('Дела не загрузились: {error}', { error: errorText(open.error) })}</p></>;
  if (!open.data) return <>{top}<p className={styles.msg}>{t('Загружаю дела…')}</p></>;

  /** Объявление диктору; тот же текст подряд — с невидимой разницей, иначе второй раз он промолчит. */
  const say = (text: string) => setSaid((prev) => (prev === text ? `${text}\u00a0` : text));

  /** Оптимистичный перенос: карточка сразу в to, ответ сервера снимает только свой перенос (seq), потом — перечитать. */
  const optimistic = (i: DeskItem, to: Column, keyboard: boolean, call: () => Promise<unknown>, done: string, fail: (err: unknown) => string) => {
    const mine = ++seq.current;
    if (keyboard) focusKey.current = i.key;
    setPending((p) => ({ ...p, [i.key]: { to, seq: mine, item: i } }));
    call()
      .then(() => say(done))
      .catch((err: unknown) => {
        toast(fail(err));
        // карточка вернётся на место — фокус за ней
        if (keyboard) focusKey.current = i.key;
      })
      .finally(
        () =>
          void refreshDesk(qc).finally(() =>
            setPending((p) => {
              if (p[i.key]?.seq !== mine) return p;
              const { [i.key]: _, ...rest } = p;
              return rest;
            }),
          ),
      );
  };

  const move = (i: DeskItem, to: Column, keyboard: boolean) => {
    if (i.column === to) return;
    optimistic(i, to, keyboard, () => moveDesk(i.key, to), t('«{title}» — в колонке «{column}»', { title: i.title, column: columnTitle(to) }), (err) => t('Не перенеслось: {error}', { error: errorText(err) }));
  };

  // закрытое сегодня остаётся на доске — в «Готово», фокус туда
  const close = (i: DeskItem, reason: string, keyboard: boolean) =>
    optimistic(i, 'done', keyboard, () => closeDesk(i.key, reason), t('«{title}» закрыто', { title: i.title }), (err) => t('Не закрылось: {error}', { error: errorText(err) }));

  /** Сессия по делу: папка и первое сообщение — из вещи (вход трекера, как «Начать сессию» в «Код») или из самого дела. */
  const startSession = async (i: DeskItem) => {
    try {
      const target = intakeTarget(i, projects);
      const prompt = target && target.type !== 'branch' ? thingSessionPrompt((await thingIntake(target)).input) : itemPrompt(i);
      const thing = i.thing && i.thing.type !== 'own' && i.thing.type !== 'thread' ? { type: i.thing.type, key: i.key, ref: i.thing.ref, ...(i.thing.url ? { url: i.thing.url } : {}), title: i.title } : undefined;
      const space = i.project && spaceTitle.has(i.project) ? i.project : undefined;
      const s = await createSession({
        cwd: sessionCwd(i, { projects, spaces, fallback: defaultSessionCwd(config?.defaultCwd) }) ?? '',
        ...(space ? { space } : {}),
        tags: [],
        saveState: true,
        name: itemSessionName(i),
        prompt,
        // сервер сам переносит дело в «В работе» и кладёт сессию в его ссылки
        source: { item: i.id, ...(thing ? { thing } : {}) },
        ...termSize(window.innerWidth, window.innerHeight),
      });
      qc.setQueryData(sessionKeys.one(s.id), s);
      void qc.invalidateQueries({ queryKey: sessionKeys.list, exact: true });
      void refreshDesk(qc);
      void navigate(`/sessions/${encodeURIComponent(s.id)}`);
    } catch (err) {
      toast(t('Сессия не началась: {error}', { error: errorText(err) }));
      throw err;
    }
  };

  const resume = async (s: SessionView) => {
    if (s.live) {
      void navigate(`/sessions/${encodeURIComponent(s.id)}`);
      return;
    }
    try {
      const next = await continueSession(s.id);
      qc.setQueryData(sessionKeys.one(next.id), next);
      void qc.invalidateQueries({ queryKey: sessionKeys.list, exact: true });
      void navigate(`/sessions/${encodeURIComponent(next.id)}`);
    } catch (err) {
      toast(t('Сессия не продолжилась: {error}', { error: errorText(err) }));
      throw err;
    }
  };

  const actions = (i: DeskItem): CardActions => {
    const target = intakeTarget(i, projects);
    return {
      move: (to, keyboard) => move(i, to, keyboard),
      close: (reason, keyboard) => close(i, reason, keyboard),
      ...(sessionsOn ? { startSession: () => startSession(i), continueSession: resume } : {}),
      ...(target ? { runFlow: (btn: HTMLElement) => setPicker(pickerAt(target, btn)) } : {}),
      link: (url) =>
        linkDesk(i.key, url).then(
          (next) => {
            say(t('«{title}» привязано к вещи', { title: next.title }));
            // карточка своего дела исчезла — фокус на дело вещи, когда оно придёт
            focusKey.current = next.key;
            void refreshDesk(qc);
          },
          (err: unknown) => {
            throw new Error(errorText(err));
          },
        ),
    };
  };

  const byKey = new Map(all.map((i) => [i.key, i]));
  // ни одного открытого дела, но рутины есть (ни дел, ни рутин — Главная ведёт к шаблонам сама, DeskEmpty): почему пусто —
  // словами сверки. Пока рутины грузятся — молчим, чтобы не мигать
  const quiet = !open.data.items.length && (!routinesOn || (routines.data !== undefined && routines.data.routines.length > 0)) ? quietBoard(check.data, new Date(now)) : undefined;
  return (
    <div className={styles.board}>
      {top}
      {quiet && (
        <section className={styles.quiet} aria-label={quiet.title}>
          <span className={`${styles.quietDot} ${QUIET_TONE[quiet.tone] ?? ''}`} aria-hidden="true" />
          <div className={styles.quietText}>
            <b>{quiet.title}</b>
            <span title={quiet.line}>{quiet.line}</span>
          </div>
          <Link className="btn small ghost" to="/routines">{t('Шаблоны рутин')}</Link>
        </section>
      )}
      <div className={styles.scroll}>
        <div className={styles.cols}>
          {view.columns.map((col) => (
            <DeskColumn
              key={col.column}
              col={col}
              dragging={dragging}
              onDrop={(key, to) => {
                setDragging(undefined);
                const i = byKey.get(key);
                if (i) move(i, to, false);
              }}
            >
              {col.items.map((i) => {
                const r = related.get(i.key);
                return (
                  <DeskCard
                    key={i.key}
                    item={i}
                    n={view.order.get(i.key)}
                    now={now}
                    // срез по проекту — подпись проекта на каждой карточке лишняя
                    project={i.project && project === undefined ? { title: spaceTitle.get(i.project) ?? i.project, tone: projectTone(i.project) } : undefined}
                    sessions={r?.sessions ?? []}
                    runs={r?.runs ?? []}
                    act={actions(i)}
                    drag={{ dragging: dragging === i.key, start: () => setDragging(i.key), end: () => setDragging(undefined) }}
                  />
                );
              })}
            </DeskColumn>
          ))}
        </div>
      </div>
      <p className={styles.sr} aria-live="polite">{said}</p>
      <FlowPicker state={picker} onClose={() => setPicker(null)} />
    </div>
  );
}
