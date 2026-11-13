// Диалог доверия к flow команды (spec §14). Flow команды лежит в общем репо и пишет его любой участник, а запускается он на
// этом компьютере с правами пользователя. Сервер отвечает на запуск неодобренной версии 409 flow_untrusted; useFlowTrust
// оборачивает запуск (черновик, разбивка, «В работу ▸»): показывает дифф от одобренной версии или шаблона agentgraph,
// команды shell и инструменты flow, по «Доверять этой версии» одобряет ровно увиденный хэш (POST …/flows/:name/trust) и
// повторяет запуск; «Отмена» — запуска нет. Пока смотрели, flow поменялся снова — диалог показывает новую версию.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { TeamFlowTrust, TeamFlowTrusted } from '@server/api-types';
import { api, errorText } from '../../api';
import { when } from '../../lib/format';
import { t } from '../../lib/i18n';
import { trustDiff, untrustedFlow } from '../../lib/teamwork/flow-trust';
import { cx } from './parts';
import styles from './FlowTrust.module.css';

const enc = encodeURIComponent;

/** «Доверять этой версии»: одобрить flow с этим хэшем; 409 flow_untrusted — flow уже другой. */
export const trustTeamFlow = (team: string, name: string, hash: string) => api<TeamFlowTrusted>('POST', `/api/teams/${enc(team)}/flows/${enc(name)}/trust`, { hash });

type Ask = { flow: TeamFlowTrust; resolve: (ok: boolean) => void };

/**
 * guard(запуск) — запуск, а на 409 flow_untrusted — диалог и после одобрения повтор; undefined — человек нажал «Отмена».
 * review(flow) — открыть диалог для уже известной версии (вкладка «Процесс»): true — одобрена. dialog — отрисовать рядом.
 */
export function useFlowTrust(): { guard: <T>(action: () => Promise<T>) => Promise<T | undefined>; review: (flow: TeamFlowTrust) => Promise<boolean>; dialog: ReactNode } {
  const [ask, setAsk] = useState<Ask | null>(null);
  /** Открытый вопрос: новый вопрос поверх (двойной клик по «Повторить») отменяет прежний, а не подвешивает его запуск. */
  const current = useRef<Ask | null>(null);
  const review = useCallback(
    (flow: TeamFlowTrust) =>
      new Promise<boolean>((resolve) => {
        current.current?.resolve(false);
        const a: Ask = {
          flow,
          resolve: (ok) => {
            if (current.current === a) {
              current.current = null;
              setAsk(null);
            }
            resolve(ok);
          },
        };
        current.current = a;
        setAsk(a);
      }),
    [],
  );
  const guard = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      for (;;) {
        try {
          return await action();
        } catch (e) {
          const flow = untrustedFlow(e);
          if (!flow) throw e;
          if (!(await review(flow))) return undefined;
        }
      }
    },
    [review],
  );
  const dialog = ask ? <FlowTrustDialog key={ask.flow.hash} flow={ask.flow} onDone={ask.resolve} /> : null;
  return { guard, review, dialog };
}

function FlowTrustDialog({ flow: first, onDone }: { flow: TeamFlowTrust; onDone: (ok: boolean) => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [flow, setFlow] = useState(first);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // фокус после закрытия — туда, откуда открыли (кнопка запуска)
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const el = dlg.current;
    if (el && !el.open) el.showModal();
    return () => {
      setTimeout(() => {
        if (!el?.isConnected && opener.current?.isConnected) opener.current.focus();
      });
    };
  }, []);

  const diff = trustDiff(flow);
  const trust = async () => {
    setBusy(true);
    setErr('');
    try {
      await trustTeamFlow(flow.team, flow.name, flow.hash);
      onDone(true);
    } catch (e) {
      const next = untrustedFlow(e);
      if (next) {
        // pull принёс ещё одну версию: одобрять старую бессмысленно — показываем новую
        setFlow(next);
        setChanged(true);
      } else setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const title =
    flow.base?.kind === 'trusted'
      ? t('Flow команды {name} изменился', { name: flow.name })
      : flow.base?.kind === 'template'
        ? t('Flow команды {name} отличается от шаблона', { name: flow.name })
        : t('Новый flow команды {name}', { name: flow.name });
  const from =
    flow.base?.kind === 'trusted'
      ? flow.base.at
        ? t('Изменения от версии, которой вы доверяли {date}', { date: when(flow.base.at) })
        : t('Изменения от версии, которой вы доверяли')
      : flow.base?.kind === 'template'
        ? t('Изменения от шаблона agentgraph')
        : t('Весь flow: раньше вы его не запускали');
  // диалог — в body и без всплытия: его открывают из карточек доски и других диалогов
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return createPortal(
    <dialog
      ref={dlg}
      className={styles.dlg}
      data-flow-trust=""
      aria-labelledby="tw-trust-title"
      onClick={stop}
      onKeyDown={stop}
      onPointerDown={stop}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onDone(false);
      }}
    >
      <div className={styles.body}>
        <h2 id="tw-trust-title">{title}</h2>
        <p>{t('Flow команды запускается на этом компьютере с вашими правами, а менять его может любой участник с доступом к репо команды. Запуск пойдёт, только если вы доверяете этой версии.')}</p>
        {changed && <p className="msg warn">{t('Пока вы смотрели, flow изменился ещё раз — это новая версия.')}</p>}
        {flow.commands.length > 0 && (
          <div className={styles.risk}>
            <span className={styles.lbl}>{t('Выполнит на этом компьютере команды')}</span>
            <ul className={styles.cmds}>
              {flow.commands.map((c) => <li key={c}><code>{c}</code></li>)}
            </ul>
          </div>
        )}
        {flow.tools.length > 0 && (
          <p className={styles.tools}>
            <span className={styles.lbl}>{t('Даст агенту')}</span> {flow.tools.join(', ')}
          </p>
        )}
        <div className={styles.f}>
          <span className={styles.lbl}>
            {from}
            {flow.base && <span className={styles.stat}> · +{diff.added} −{diff.removed}</span>}
          </span>
          <pre className={styles.diff} aria-label={t('Изменения flow')}>
            {diff.rows.map((r, i) =>
              'skip' in r ? (
                <span key={i} className={styles.skip}>{t('⋯ без изменений: {n}', { n: r.skip })}</span>
              ) : (
                <span key={i} className={cx(styles.line, r.op === '+' && styles.add, r.op === '-' && styles.del)}>{`${r.op} ${r.text}`}</span>
              ),
            )}
          </pre>
        </div>
        {err && <p className="msg err">{err}</p>}
        <p className={styles.hint}>{t('Одобрение — только на этом компьютере. Следующая правка flow снова спросит.')}</p>
        <div className={styles.foot}>
          <span className={styles.grow} />
          {/* фокус — на безопасном действии: Enter не одобряет чужой flow не глядя */}
          <button type="button" className="btn ghost" disabled={busy} autoFocus onClick={() => onDone(false)}>{t('Отмена')}</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void trust()}>{busy ? t('Одобряю…') : t('Доверять этой версии')}</button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
