// Главная (ui/index.html #view-home, ui/app.js renderHome): вопросы агентов с ответом и сессии терминала, которые ждут
// тебя, идущие запуски и работающие сессии, мои MR, которым нужно внимание, задачи и код, лента событий справа. Ни
// запусков, ни сессий ещё не было — строка «с чего начать». «ждёт N мин», «идёт N мин» и время в ленте — раз в 30 секунд.
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { HomeResponse } from '@server/api-types';
import { keys, useFeature, useFlows, useHome, useRuns, type IntakeTarget } from '../../api';
import { useSessions } from '../../api/sessions';
import { requestNotify, useNotifyPermission } from '../../components/shell/notifications';
import { QuestionCard } from '../../components/question/QuestionCard';
import { useNow } from '../../components/useNow';
import { homeMeta, inbox, withoutQuestion } from '../../lib/home';
import { t } from '../../lib/i18n';
import { homeSessions } from '../../lib/sessions';
import { NewFlowDialog } from '../flow/NewFlowDialog';
import { Attention } from './Attention';
import { Dash } from './Dash';
import { DashSettings } from './DashSettings';
import { Feed } from './Feed';
import { FlowPicker, pickerAt, type PickerState } from './FlowPicker';
import { HomeRuns } from './HomeRuns';
import { HomeSessions } from './HomeSessions';
import { Limits } from './Limits';
import styles from './Home.module.css';

const TICK_MS = 30_000;

export function HomeScreen() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const home = useHome();
  const limits = useFeature('limits');
  const dashOn = useFeature('integrations');
  const attentionOn = useFeature('attention') && dashOn;
  const feedOn = useFeature('feed');
  const now = useNow(TICK_MS);
  const [picker, setPicker] = useState<PickerState>(null);
  // список flow — заранее: выбор у «Запустить…» открывается сразу с ним (старый UI грузил flow при старте)
  useFlows();
  const [settings, setSettings] = useState(false);
  // сессии терминала: тот же список, что у «Сейчас» в сайдбаре, — пока есть живые, он обновляется сам
  const sessionsOn = useFeature('sessions');
  const sessionList = useSessions(sessionsOn);
  const sessions = homeSessions(sessionList.data?.sessions ?? []);
  const history = useRuns();

  // /api/home и ленту перезапрашивает сам React Query при каждом открытии главной (refetchOnMount): запуски из CLI
  // в общий поток не пишут, их события подхватываются при возврате на главную
  const runs = home.data?.runs ?? [];
  const items = inbox(runs);
  // без /api/home пустая главная соврала бы «ничего не идёт», а запуски могут идти
  const down = home.isError;
  const loadHomeSoon = () => setTimeout(() => void qc.invalidateQueries({ queryKey: keys.home }), 300);
  const waiting = items.length + sessions.waiting.length;
  const going = runs.length + sessions.live.length;
  // первый раз: ни одного запуска и ни одной сессии — подсказываем, с чего начать (только по ответам, не пока грузятся)
  const fresh = !down && history.isSuccess && !history.data.length && (!sessionsOn || (sessionList.isSuccess && !sessionList.data.sessions.length));
  const onLaunch = useCallback((target: IntakeTarget, btn: HTMLElement) => setPicker(pickerAt(target, btn)), []);
  const closePicker = useCallback(() => setPicker(null), []);

  return (
    <>
      <header className="view-head">
        <div>
          <h1>{t('Главная')}</h1>
          <p className="muted" title={t('Стоимость: оценка по прайсу API; с подписки не списывается')}>{homeMeta(runs, items.length)}</p>
        </div>
        {limits && <Limits />}
        <div className="row">
          <NotifyControl />
        </div>
      </header>
      <div className={`${styles.homeGrid}${feedOn ? '' : ` ${styles.noFeed}`}`}>
        <div className={styles.homeMain}>
          {fresh && <Start sessions={sessionsOn} />}
          {waiting > 0 && (
            <section className={styles.homeSec}>
              <h2 title={t('Вопросы агентов, сначала те, что ждут дольше; под ними — сессии, где ход за тобой')}>{t('Ждёт тебя')}</h2>
              <div>
                {items.map(({ q, run }) => (
                  <QuestionCard
                    key={q.id}
                    q={q}
                    run={run}
                    onHome
                    now={now}
                    onOpenRun={() => void navigate(`/run/${run.id}`)}
                    // ответ ушёл: убираем вопрос из входящих сразу, не дожидаясь события
                    onAnswered={() => qc.setQueryData<HomeResponse>(keys.home, (d) => (d ? { runs: withoutQuestion(d.runs, run.id, q.id) } : d))}
                    onFailed={loadHomeSoon}
                  />
                ))}
              </div>
              {sessions.waiting.length > 0 && <HomeSessions sessions={sessions.waiting} now={now} />}
            </section>
          )}
          {going > 0 && (
            <section className={styles.homeSec}>
              <h2>{t('Идут')}</h2>
              {runs.length > 0 && <HomeRuns runs={runs} now={now} />}
              {sessions.live.length > 0 && <HomeSessions sessions={sessions.live} now={now} />}
            </section>
          )}
          {attentionOn && <Attention onLaunch={onLaunch} />}
          {dashOn && <Dash onLaunch={onLaunch} onSettings={() => setSettings(true)} />}
          {down && (
            <p className={`run-paused ${styles.homeDown}`}>
              {t('Главная заработает после перезапуска UI-сервера: этот сервер запущен до её появления и не отдаёт вопросы и идущие запуски. Пока они видны в списке слева. Перезапуск остановит идущие запуски — дождись их конца.')}
            </p>
          )}
          {/* дашборд сам объясняет, что делать: большая пустая заглушка под ним не нужна */}
          {!dashOn && !down && !fresh && !waiting && !going && (
            <div className={`empty ${styles.homeEmpty}`}>
              <h1>{t('Ничего не идёт, вопросов нет')}</h1>
              <p title={t('Flow — цепочка этапов. Каждый этап идёт в отдельной сессии Claude Code со своим промптом и получает то, что ему передали предыдущие. После всех этапов проверяется условие, и цикл повторяется, пока оно не выполнится.')}>
                {t('Выбери flow слева или создай новый.')}
              </p>
              <p className="muted small">{t('Вопросы агентов со всех flow появятся здесь — отвечать можно не открывая запуск.')}</p>
            </div>
          )}
        </div>
        {feedOn && <Feed now={now} />}
      </div>
      <FlowPicker state={picker} onClose={closePicker} />
      {dashOn && <DashSettings open={settings} onClose={() => setSettings(false)} />}
    </>
  );
}

/**
 * Диалог «Новый flow» — один, в сайдбаре: генерация идёт в нём и переживает уход с главной. Свой экземпляр здесь
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

/** Без разрешения браузера о вопросах сообщит сам сервер системным уведомлением; заблокированы — подсказка. */
function NotifyControl() {
  const perm = useNotifyPermission();
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
