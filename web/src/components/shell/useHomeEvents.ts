// Общий поток событий всех запусков (ui/app.js connectEvents): главная, счётчик вопросов, «Сейчас», лента и уведомления.
// Живёт в оболочке, на любом экране: без него, пока открыт один запуск, вопрос из другого flow было не увидеть.
import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { HomeEvent } from '@server/api-types';
import { keys, useEventStream, useFeature } from '../../api';
import { FEED_EVENTS } from '../../lib/feed';
import { statusLabel, usd } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useToast } from '../Toast';
import { browserNotifies, tabAway, useNotifyPermission } from './notifications';

/** После них в списке запусков меняются статус, итерации или стоимость. */
const RUN_LIST_EVENTS = new Set(['start', 'end', 'question', 'answer', 'pause', 'iteration', 'phase_end', 'condition', 'title', 'digest']);
/** События идут пачками (этап закончился — начался следующий): данные забираем раз на пачку. */
const SOON_MS = 300;

export function useHomeEvents(): void {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const feedOn = useFeature('feed');
  const permission = useNotifyPermission();
  const path = useLocation().pathname;
  // обработчики событий читают текущий экран без переподключения потока
  const where = useRef(path);
  where.current = path;

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);
  const soon = useCallback(
    (key: readonly string[]) => {
      const id = key.join('/');
      clearTimeout(timers.current.get(id));
      timers.current.set(id, setTimeout(() => void qc.invalidateQueries({ queryKey: key }), SOON_MS));
    },
    [qc],
  );

  // Вкладка не на виду — системное уведомление; на виду, но открыт другой экран — всплывашка. На главной и на странице этого запуска карточка и так появится.
  const announceQuestion = (e: HomeEvent) => {
    const q = e.question!;
    const text = q.questions.map((x) => x.question).join(' · ');
    const title = t('{flow}: вопрос от «{phase}»', { flow: e.flow, phase: q.title || q.phase });
    if (tabAway()) {
      if (browserNotifies()) {
        const n = new Notification(title, { body: text, tag: q.id });
        n.onclick = () => {
          window.focus();
          n.close();
          void navigate('/');
        };
      }
      return;
    }
    const visibleHere = where.current === '/' || where.current === `/run/${e.runId}`;
    if (!visibleHere) toast(`${title}. ${text}`, () => void navigate('/'));
  };

  // Конец запуска объявляем только уведомлением, когда вкладка не на виду; остановку руками — нет, её только что нажали.
  // Конец дочернего запуска блока-вызова — нет: о связке скажет конец родителя (как и сервер в системных уведомлениях).
  const announceEnd = (e: HomeEvent) => {
    if (e.status === 'aborted' || e.parent || !tabAway() || !browserNotifies()) return;
    const n = new Notification(t('{flow}: запуск завершён', { flow: e.flow }), { body: `${statusLabel(e.status ?? '')} · ${usd(e.costUsd)}`, tag: e.runId });
    n.onclick = () => {
      window.focus();
      n.close();
      void navigate(`/run/${e.runId}`);
    };
  };

  // notify=1 — уведомления покажет эта вкладка, системные с сервера не нужны; разрешение сменилось — переподключаемся
  useEventStream<HomeEvent>(`/api/events${permission === 'granted' ? '?notify=1' : ''}`, {
    // при переподключении события за время обрыва потеряны: забираем состояние заново
    onOpen: () => {
      soon(keys.home);
      soon(keys.runs);
      if (feedOn) soon(keys.feed);
    },
    onEvent: (e) => {
      if (e.type === 'question' && e.question) announceQuestion(e);
      if (e.type === 'end') announceEnd(e);
      soon(keys.home);
      if (feedOn && FEED_EVENTS.has(e.type)) soon(keys.feed);
      if (RUN_LIST_EVENTS.has(e.type)) soon(keys.runs);
    },
  });
}
