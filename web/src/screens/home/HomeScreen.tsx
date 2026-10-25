// Главная (ui/index.html #view-home, ui/app.js renderHome): вопросы агентов с ответом, идущие запуски, мои MR, которым
// нужно внимание, задачи и код, лента событий справа. «ждёт N мин», «идёт N мин» и время в ленте — раз в 30 секунд.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { HomeResponse } from '@server/api-types';
import { keys, useFeature, useFlows, useHome, type IntakeTarget } from '../../api';
import { requestNotify, useNotifyPermission } from '../../components/shell/notifications';
import { QuestionCard } from '../../components/question/QuestionCard';
import { homeMeta, inbox, withoutQuestion } from '../../lib/home';
import { Attention } from './Attention';
import { Dash } from './Dash';
import { DashSettings } from './DashSettings';
import { Feed } from './Feed';
import { FlowPicker, pickerAt, type PickerState } from './FlowPicker';
import { HomeRuns } from './HomeRuns';
import { Limits } from './Limits';
import styles from './Home.module.css';

const TICK_MS = 30_000;

/** Текущее время, обновляется раз в period: подписи «N мин назад» без перезапроса данных. */
function useNow(period: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(t);
  }, [period]);
  return now;
}

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

  // /api/home и ленту перезапрашивает сам React Query при каждом открытии главной (refetchOnMount): запуски из CLI
  // в общий поток не пишут, их события подхватываются при возврате на главную
  const runs = home.data?.runs ?? [];
  const items = inbox(runs);
  // без /api/home пустая главная соврала бы «ничего не идёт», а запуски могут идти
  const down = home.isError;
  const loadHomeSoon = () => setTimeout(() => void qc.invalidateQueries({ queryKey: keys.home }), 300);
  const onLaunch = useCallback((target: IntakeTarget, btn: HTMLElement) => setPicker(pickerAt(target, btn)), []);
  const closePicker = useCallback(() => setPicker(null), []);

  return (
    <>
      <header className="view-head">
        <div>
          <h1>Главная</h1>
          <p className="muted" title="Стоимость: оценка по прайсу API; с подписки не списывается">{homeMeta(runs, items.length)}</p>
        </div>
        {limits && <Limits />}
        <div className="row">
          <NotifyControl />
        </div>
      </header>
      <div className={`${styles.homeGrid}${feedOn ? '' : ` ${styles.noFeed}`}`}>
        <div className={styles.homeMain}>
          {items.length > 0 && (
            <section className={styles.homeSec}>
              <h2 title="Сначала те, что ждут дольше">Ждёт тебя</h2>
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
            </section>
          )}
          {runs.length > 0 && (
            <section className={styles.homeSec}>
              <h2>Идут</h2>
              <HomeRuns runs={runs} now={now} />
            </section>
          )}
          {attentionOn && <Attention onLaunch={onLaunch} />}
          {dashOn && <Dash onLaunch={onLaunch} onSettings={() => setSettings(true)} />}
          {down && (
            <p className={`run-paused ${styles.homeDown}`}>
              Главная заработает после перезапуска UI-сервера: этот сервер запущен до её появления и не отдаёт вопросы и идущие запуски. Пока они видны в списке слева. Перезапуск остановит идущие запуски — дождись их конца.
            </p>
          )}
          {/* дашборд сам объясняет, что делать: большая пустая заглушка под ним не нужна */}
          {!dashOn && !down && !items.length && !runs.length && (
            <div className={`empty ${styles.homeEmpty}`}>
              <h1>Ничего не идёт, вопросов нет</h1>
              <p title="Flow — цепочка этапов. Каждый этап идёт в отдельной сессии Claude Code со своим промптом и получает то, что ему передали предыдущие. После всех этапов проверяется условие, и цикл повторяется, пока оно не выполнится.">
                Выбери flow слева или создай новый.
              </p>
              <p className="muted small">Вопросы агентов со всех flow появятся здесь — отвечать можно не открывая запуск.</p>
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

/** Без разрешения браузера о вопросах сообщит сам сервер системным уведомлением; заблокированы — подсказка. */
function NotifyControl() {
  const perm = useNotifyPermission();
  if (perm === 'denied') {
    return <span className="muted small" title="Заблокированы в настройках браузера для этого адреса. Включи их там">Уведомления выключены</span>;
  }
  if (perm !== 'default') return null;
  return (
    <button className="btn" title="Показывать системное уведомление, когда агент задаёт вопрос, а вкладка не на виду" onClick={() => void requestNotify()}>
      Включить уведомления
    </button>
  );
}
