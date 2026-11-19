// Главная — доска дел (docs/desk/SPEC.md, этап 5; макет docs/desk/design/DeskPult.dc.html). Полосу над доской — ожидания
// рутин и «догнать», вопросы агентов, сессии, ждущие ответа, сверку «N из N», «Начни с этого» и срез по проектам — рисует
// сама доска (DeskTop внутри DeskBoard). Одна вещь — одно место: свои MR, «Не доделано», «Мои задачи», «Ждёт тебя» и «Идут»
// стали карточками; идущие запуски и сессии — в «Сейчас» боковой панели. Журнала событий нет: итог запуска, который требует действия, приходит делом на доску (src/desk/run-end.ts); «Все запуски» в шапке открывает список запусков в боковой панели. Ни дел, ни рутин — плитки
// шаблонов рутин «Моих дел». `/?desk=<ключ>` (ссылка из «Кода») показывает карточку, `?project=<слаг>` — срез по проекту
// ('' — без проекта).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useConfig, useFeature, useRuns } from '../../api';
import { useDesk } from '../../api/desk';
import { useRoutines } from '../../api/routines';
import { useSessions } from '../../api/sessions';
import { requestNotify, useNotifyPermission } from '../../components/shell/notifications';
import { setPanel } from '../../components/shell/panel';
import { useNow } from '../../components/useNow';
import { hasConnections } from '../../lib/dash';
import { DESK_PARAM, deskEmpty, deskMeta } from '../../lib/desk';
import { inProject } from '../../lib/desk-board';
import { t } from '../../lib/i18n';
import { NewFlowDialog } from '../flow/NewFlowDialog';
import { RoutineTemplates } from '../routines/RoutineTemplates';
import { useIntegrations } from './Dash';
import { DashSettings } from './DashSettings';
import { DeskBoard } from './desk/DeskBoard';
import { Limits } from './Limits';
import dashStyles from './Dash.module.css';
import styles from './Home.module.css';

const TICK_MS = 30_000;

export function HomeScreen() {
  const [params, setParams] = useSearchParams();
  const limits = useFeature('limits');
  const dashOn = useFeature('integrations');
  // ничего не подключено — строка с «Подключениями»; пока не знаем — без неё
  const integrations = useIntegrations(dashOn);
  const connected = integrations.data ? hasConnections(integrations.data) : undefined;
  // сервер старше доски: /api/config ответил, а дел в нём нет
  const config = useConfig().data;
  const oldServer = config !== undefined && !config.features.includes('desk');
  const now = useNow(TICK_MS);
  const [settings, setSettings] = useState(false);
  const desk = useDesk();
  const items = desk.data?.items;
  // рутины — только чтобы понять, пуста ли доска; их ожидания и «догнать» рисует полоса над доской (DeskTop)
  const routinesOn = useFeature('routines');
  const routines = useRoutines(routinesOn);
  const sessionsOn = useFeature('sessions');
  const sessionList = useSessions(sessionsOn);
  const history = useRuns();
  // первый раз: ни одного запуска и ни одной сессии — подсказываем, с чего начать (только по ответам, не пока грузятся)
  const fresh = history.isSuccess && !history.data.length && (!sessionsOn || (sessionList.isSuccess && !sessionList.data.sessions.length));
  // ни дел, ни рутин: доску наполняют рутины — ведём к их шаблонам
  const empty = deskEmpty(items, routinesOn ? routines.data?.routines : undefined);
  // срез по проекту — в адресе: переживает уход и возврат, им можно поделиться; пишет его доска (пилюли проектов)
  const project = params.get('project') ?? undefined;
  const onProject = (slug: string | undefined) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (slug !== undefined) next.set('project', slug);
      else next.delete('project');
      next.delete(DESK_PARAM);
      return next;
    }, { replace: true });
  const shown = project === undefined ? items : items?.filter((i) => inProject(i, project));
  useShowCard(params.get(DESK_PARAM), items !== undefined);

  return (
    <>
      <header className="view-head">
        <div>
          <h1>{t('Мои дела')}</h1>
          <p className="muted">{deskMeta(shown, new Date(now))}</p>
        </div>
        {limits && <Limits />}
        <div className="row">
          <NotifyControl />
          <button type="button" className="btn small ghost" title={t('Список всех запусков в боковой панели: поиск, статусы, скрытые')} onClick={() => setPanel({ panel: 'runs', hidden: false })}>
            {t('Все запуски')}
          </button>
        </div>
      </header>
      {/* пустая доска сама говорит, с чего начать: вторая подсказка рядом — шум */}
      {fresh && !empty && <Start sessions={sessionsOn} />}
      {empty && <DeskEmpty />}
      {/* сервер старше доски: у него нет /api/desk — честно говорим, а не рисуем пустые колонки */}
      {oldServer ? (
        <p className={`run-paused ${styles.homeDown}`}>
          {t('Доска заработает после перезапуска UI-сервера: этот сервер запущен до её появления. Перезапуск остановит идущие запуски — дождись их конца.')}
        </p>
      ) : (
        <DeskBoard project={project} onProject={onProject} />
      )}
      {dashOn && connected === false && <Connect onSettings={() => setSettings(true)} />}
      {dashOn && <DashSettings open={settings} onClose={() => setSettings(false)} />}
    </>
  );
}

/**
 * `/?desk=<ключ>`: прокрутить к карточке дела и коротко подсветить. Карточка доски помечена `data-desk-key`; дела уже
 * нет на доске (закрыто, другой срез) — тихо ничего. Один раз на ключ.
 */
function useShowCard(key: string | null, loaded: boolean) {
  useEffect(() => {
    if (!key || !loaded) return;
    // доска рисуется в том же кадре, что и данные, — ищем на следующем
    const id = window.setTimeout(() => {
      const card = document.querySelector<HTMLElement>(`[data-desk-key="${CSS.escape(key)}"]`);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove(styles.deskFlash!);
      void card.offsetWidth;
      card.classList.add(styles.deskFlash!);
    }, 0);
    return () => window.clearTimeout(id);
  }, [key, loaded]);
}

/** Ни дел, ни рутин: доску наполняют рутины — шаблоны «Моих дел», flow к ним готовы. */
function DeskEmpty() {
  return (
    <section className={styles.deskEmpty} aria-label={t('Пустая доска')}>
      <h2>{t('Дел пока нет')}</h2>
      <p className="muted">{t('Дела заводят рутины: назначили ревью, пришла задача Jira, прошла встреча. Выбери шаблон — flow к нему уже готов.')}</p>
      <RoutineTemplates deskOnly />
      <Link className="btn small ghost" to="/routines">{t('Все шаблоны и своя рутина')}</Link>
    </section>
  );
}

/**
 * Диалог «Новый flow» — один, в шапке списка Flow панели меню (смонтирован, даже когда виден другой список или панель
 * скрыта; сам диалог — в портале): генерация идёт в нём и переживает уход с главной. Свой экземпляр здесь
 * размонтировался бы с главной, а с ним — ход платной генерации и защита от второй параллельной.
 */
const sidebarNewFlow = () => document.querySelector<HTMLButtonElement>(`button[title="${CSS.escape(t('Создать flow'))}"]`);

/** Ни запусков, ни сессий ещё не было: строка «с чего начать» — сессия (форма откроется сама) или новый flow. */
function Start({ sessions }: { sessions: boolean }) {
  const navigate = useNavigate();
  // сайдбара с кнопкой нет (так не бывает, но всё же) — свой диалог
  const [newFlow, setNewFlow] = useState(false);
  const openNewFlow = () => {
    const btn = sidebarNewFlow();
    if (btn) btn.click();
    else setNewFlow(true);
  };
  return (
    <section className={styles.homeStart} aria-label={t('С чего начать')}>
      <p>
        <b>{sessions ? t('Начни с сессии или flow') : t('Начни с flow')}</b>
        <span className="muted">
          {' · '}
          {sessions
            ? t('сессия — Claude Code в терминале, flow — цепочка этапов, которые идут сами')
            : t('flow — цепочка этапов, которые идут сами')}
        </span>
      </p>
      {sessions && <button type="button" className="btn primary" onClick={() => void navigate('/sessions')}>{t('Новая сессия')}</button>}
      <button type="button" className={sessions ? 'btn' : 'btn primary'} onClick={openNewFlow}>{t('Новый flow')}</button>
      <NewFlowDialog open={newFlow} onClose={() => setNewFlow(false)} />
    </section>
  );
}

/** Ничего не подключено: одна тихая строка с «Подключениями» — задачи и MR потом будут в разделе «Код», дела — на доске. */
function Connect({ onSettings }: { onSettings: () => void }) {
  return (
    <section className={`${styles.homeSec} ${styles.homeConnect}`}>
      <div className={`${dashStyles.dashHead} ${dashStyles.dashQuiet}`}>
        <h2 title={t('Подключи Jira или git-репозиторий: задачи, MR и ветки появятся в разделе «Код», а дела о них — на доске')}>
          {t('Задачи и код')} <span className="muted small">{t('— ничего не подключено')}</span>
        </h2>
        <button className="btn small" onClick={onSettings}>{t('Подключения')}</button>
      </div>
    </section>
  );
}

/**
 * Без разрешения браузера о вопросах сообщит сам сервер системным уведомлением; заблокированы — подсказка.
 * В десктопном приложении (`host-notify`) уведомления показывает оно само: включать нечего.
 */
function NotifyControl() {
  const perm = useNotifyPermission();
  const hostNotifies = useFeature('host-notify');
  if (hostNotifies) return null;
  if (perm === 'denied') {
    return <span className="muted small" title={t('Заблокированы в настройках браузера для этого адреса. Включи их там')}>{t('Уведомления выключены')}</span>;
  }
  if (perm !== 'default') return null;
  return (
    <button className="btn" title={t('Показывать системное уведомление, когда агент задаёт вопрос или сессия ждёт тебя, а вкладка не на виду')} onClick={() => void requestNotify()}>
      {t('Включить уведомления')}
    </button>
  );
}
