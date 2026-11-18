// «Продолжить» с пределом живых сессий: сервер отвечает 409 limit — вместо ошибки диалог с живыми сессиями, где ход за
// тобой (сначала простаивающие, потом ждущие ответа). «Завершить и продолжить» гасит выбранную и продолжает эту с тем же
// первым сообщением. Работающие сессии не предлагаются: их ход ещё идёт.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionList, SessionView } from '@server/api-types';
import { api, ApiError, errorText } from '../../api';
import { continueSession, endSession, fetchSession, putSession, sessionKeys, useSessions } from '../../api/sessions';
import { t } from '../../lib/i18n';
import { askNote, endCandidates, sessionSub } from '../../lib/sessions';
import styles from './Sessions.module.css';

type Pending = { id: string; prompt?: string; resolve: (v: SessionView | undefined) => void };

const isLimit = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'limit';

/**
 * resume(id, prompt) — продолжить сессию; упёрлись в предел — открывает диалог и ждёт выбора: свежая сессия или
 * undefined (диалог закрыли). Другие ошибки — как есть. dialog — вставить в разметку экрана.
 */
export function useContinue(): { resume: (id: string, prompt?: string) => Promise<SessionView | undefined>; dialog: ReactNode } {
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  // открытый диалог — и в ref: новый 409 поверх него и уход с экрана отпускают ждущий промис (иначе кнопка ждёт вечно)
  const current = useRef<Pending | null>(null);
  useEffect(() => () => current.current?.resolve(undefined), []);
  const open = (p: Pending) => {
    current.current?.resolve(undefined);
    current.current = p;
    setPending(p);
  };
  const resume = async (id: string, prompt?: string) => {
    try {
      return await continueSession(id, prompt);
    } catch (err) {
      if (!isLimit(err)) throw err;
      // список живых — свежий: кого предложить завершить, решает их статус сейчас
      await qc.fetchQuery({ queryKey: sessionKeys.list, queryFn: () => api<SessionList>('GET', '/api/sessions'), staleTime: 0 }).catch(() => undefined);
      return new Promise<SessionView | undefined>((resolve) => open({ id, prompt, resolve }));
    }
  };
  const close = (v: SessionView | undefined) => {
    current.current?.resolve(v);
    current.current = null;
    setPending(null);
  };
  return { resume, dialog: pending && <LimitDialog key={pending.id} p={pending} onDone={close} /> };
}

function LimitDialog({ p, onDone }: { p: Pending; onDone: (v: SessionView | undefined) => void }) {
  const qc = useQueryClient();
  const list = useSessions(true).data;
  const dlg = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!dlg.current?.open) dlg.current?.showModal();
  }, []);
  const all = list?.sessions ?? [];
  const candidates = endCandidates(all, p.id);
  const working = all.filter((s) => s.live && s.id !== p.id && s.status === 'working').length;
  const endAndGo = async (other: SessionView) => {
    setBusy(other.id);
    setError('');
    try {
      // список мог устареть, пока диалог открыт: ход пошёл — не гасим claude посреди работы
      const now = await fetchSession(other.id);
      if (!now.live || now.status !== 'waiting') {
        putSession(qc, now);
        setError(now.live ? t('«{name}» уже работает: выбери другую', { name: now.name }) : t('«{name}» уже завершена: попробуй продолжить ещё раз', { name: now.name }));
        return;
      }
      putSession(qc, await endSession(other.id));
      const v = await continueSession(p.id, p.prompt);
      void qc.invalidateQueries({ queryKey: sessionKeys.list, exact: true });
      dlg.current?.close();
      onDone(v);
    } catch (err) {
      // успели открыть ещё одну — предел снова занят: список обновится, можно выбрать ещё
      setError(isLimit(err) ? t('Предел снова занят: выбери ещё одну') : errorText(err));
      void qc.invalidateQueries({ queryKey: sessionKeys.list, exact: true });
    } finally {
      setBusy('');
    }
  };
  const cancel = () => {
    dlg.current?.close();
    onDone(undefined);
  };
  return (
    <dialog
      ref={dlg}
      aria-labelledby="session-limit-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) cancel();
      }}
    >
      <h2 id="session-limit-title">{t('Живых сессий уже {n}', { n: list?.max ?? all.filter((s) => s.live).length })}</h2>
      <p className="muted">
        {candidates.length
          ? t('Чтобы продолжить, заверши одну из тех, где ход за тобой: разговор сохранится, её тоже можно будет продолжить.')
          : t('Все живые сессии сейчас работают: дождись конца хода или заверши одну на её странице.')}
      </p>
      {candidates.length > 0 && (
        <ul className={styles.limitList} aria-label={t('Сессии, которые можно завершить')}>
          {candidates.map((s) => {
            const note = askNote(s);
            return (
              <li key={s.id} className={styles.limitRow}>
                <span className={styles.limitName} title={s.name}>{s.name}</span>
                <span className={styles.limitSub} title={s.cwd}>{sessionSub(s)}</span>
                {note && <span className={`${styles.limitSub} ${styles.asks}`} title={note}>{note}</span>}
                <button type="button" className="btn small" disabled={Boolean(busy)} title={t('Завершить claude (SIGHUP) этой сессии и продолжить ту')} onClick={() => void endAndGo(s)}>
                  {busy === s.id ? t('Завершаю…') : t('Завершить и продолжить')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {working > 0 && candidates.length > 0 && <p className="muted">{t('Ещё работают: {n} — их не предлагаем, ход идёт.', { n: working })}</p>}
      {error && <p className="msg err">{error}</p>}
      <div className="row">
        <button type="button" className="btn ghost" disabled={Boolean(busy)} onClick={cancel}>{t('Отмена')}</button>
      </div>
    </dialog>
  );
}
