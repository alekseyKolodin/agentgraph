// Помощник — один компонент на все разделы (docs/ASSISTANTS.md §1–2). В шапке видно, какая модель работает (её
// выбирает человек, выбор запоминается для раздела) и сколько потрачено; рядом — что помощник знает и умеет по уровням.
// Лента: сообщение человека → шаги помощника (каждый вызов инструмента: что сделал, чем кончилось, сколько стоило) →
// ответ. Разговор живёт на сервере: экран можно закрыть, помощник доработает, а по возврате лента откроется по id.
// Панель-чат в колонке справа от формы (New.dc.html): высотой в экран, лента растягивается, многострочное поле внизу
// (Enter — отправить, Shift+Enter — перенос), панель сворачивается до шапки; в свёрнутой шапке видно, что помощник
// работает, ответил или споткнулся.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AssistantStep, AssistantView } from '@server/assistant-types';
import { ApiError, errorText } from '../../api';
import { assistantKeys, closeAssistant, sendAssistant, startAssistant, stopAssistant, useAssistantAbout, useAssistantChat } from '../../api/assistant';
import { abilities, finishedActs, turnsOf } from '../../lib/assistant';
import { modelChip } from '../../lib/flow/ai-progress';
import { dur, usd } from '../../lib/format';
import { t } from '../../lib/i18n';
import { LS } from '../../lib/storage';
import { MdText } from '../MdText';
import { ModelPick } from '../ModelPick';
import styles from './AssistantPanel.module.css';

type Props<R> = {
  /** Адрес помощника раздела: /api/routines/assistant. */
  base: string;
  /** Ключ localStorage для выбранной модели раздела ('' — по умолчанию). */
  modelKey: string;
  title: string;
  placeholder: string;
  /** Что помощник сделает — одной фразой, пока разговор не начат. */
  intro: string;
  /** Разговор хранит экран (в своём черновике на сервере): по возврате лента открывается по id. */
  chatId: string | null;
  onChatId: (id: string | null) => void;
  /** Какой результат помощника экран уже принял: новый (resultRev больше) уходит в onResult один раз. */
  appliedRev: number;
  onResult: (result: R, rev: number) => void;
  /** Помощник что-то сделал (подключил источник, собрал flow): экран перечитывает свои списки. */
  onAct?: (steps: AssistantStep[]) => void;
  /** Что показать под лентой по текущему результату: чего не хватает, куда перейти. */
  footer?: (view: AssistantView<R>) => ReactNode;
  /** Что уходит помощнику вместе с сообщением: состояние экрана, как его видит человек сейчас (его правки). */
  extra?: () => Record<string, unknown> | undefined;
  /** Что помощник делает, одной строкой — в шапке. */
  sub: string;
  /** Панель свёрнута до шапки. */
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
};

export function AssistantPanel<R>({ base, modelKey, title, placeholder, intro, chatId, onChatId, appliedRev, onResult, onAct, footer, extra, sub, collapsed, onCollapse }: Props<R>) {
  const qc = useQueryClient();
  const about = useAssistantAbout(base);
  const [model, setModel] = useState(() => LS.get<string>(modelKey, ''));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const q = useAssistantChat<R>(base, chatId);
  const v = chatId ? q.data : undefined;
  const working = v?.state === 'working';
  // сервер перезапускался или разговор вытеснен: его больше нет, но всё сделанное им (источник, flow, черновик в форме) осталось
  const [lost, setLost] = useState(false);
  const gone = q.error instanceof ApiError && q.error.status === 404;
  useEffect(() => {
    if (!gone) return;
    setLost(true);
    onChatId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gone]);
  /** Разговор назван, но ещё не прочитан с сервера: сообщение сейчас завело бы второй разговор. */
  const loading = Boolean(chatId) && q.isPending;

  // новый результат экран принимает один раз
  useEffect(() => {
    if (v && v.result !== undefined && v.resultRev > appliedRev) onResult(v.result, v.resultRev);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.resultRev, appliedRev]);

  // законченные действия — экрану; шаги разговора, открытого по возврате, уже отражены в его списках
  const seen = useRef<AssistantStep[] | undefined>(undefined);
  useEffect(() => {
    if (!v) return;
    const done = seen.current ? finishedActs(seen.current, v.steps) : [];
    seen.current = v.steps;
    if (done.length) onAct?.(done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.steps]);

  // лента держится у последней строки, пока помощник работает, и после разворачивания панели
  const feed = useRef<HTMLDivElement>(null);
  const size = v ? v.messages.length + v.steps.length : 0;
  useEffect(() => {
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [size, working, collapsed]);
  // свёрнутая панель: что появилось в ленте с тех пор, как её свернули, — знак «новое» в шапке
  const [seenSize, setSeenSize] = useState(size);
  useEffect(() => {
    if (!collapsed) setSeenSize(size);
  }, [collapsed, size]);
  const fresh = collapsed && size > seenSize;
  const failed = Boolean(error) || v?.state === 'error';

  const send = async () => {
    const body = text.trim();
    if (!body || working || busy || loading) return;
    setBusy(true);
    setError('');
    try {
      const state = extra?.();
      const fresh = () => startAssistant<R>(base, body, model.trim(), state);
      // разговора на сервере уже нет (перезапуск, вытеснение) — сообщение начинает новый, а не теряется
      const r = chatId && v ? await sendAssistant<R>(base, chatId, body, model.trim(), state).catch((e) => (e instanceof ApiError && e.status === 404 ? fresh() : Promise.reject(e))) : await fresh();
      setLost(false);
      qc.setQueryData(assistantKeys.chat(base, r.id), r);
      if (r.id !== chatId) {
        seen.current = r.steps;
        onChatId(r.id);
      }
      setText('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!chatId) return;
    try {
      qc.setQueryData(assistantKeys.chat(base, chatId), await stopAssistant<R>(base, chatId));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const restart = () => {
    if (chatId) void closeAssistant(base, chatId).catch(() => undefined);
    seen.current = undefined;
    setError('');
    setLost(false);
    onChatId(null);
  };

  const can = about.data ? abilities(about.data) : undefined;
  const turns = v ? turnsOf(v) : [];
  const defaultModel = about.data?.defaultModel ?? '';

  const modelPick = (
    <span className={styles.who}>
      <span className={styles.lbl}>{t('Модель')}</span>
      <ModelPick
        value={model}
        onChange={(m) => {
          setModel(m);
          LS.set(modelKey, m);
        }}
        defaultLabel={defaultModel ? t('{model}, по умолчанию', { model: defaultModel }) : t('по умолчанию')}
        label={t('Модель помощника')}
        title={t('Модель, на которой работает помощник. Выбор запоминается для раздела, менять можно посреди разговора — со следующего сообщения.')}
        disabled={working}
        selectClassName={styles.model}
        inputClassName={styles.modelId}
      />
      {v && v.costUsd >= 0.005 && (
        <span className={styles.cost} title={t('Сколько потрачено за разговор: сам помощник и модели, которые он запускал в шагах')}>
          {usd(v.costUsd)}
        </span>
      )}
    </span>
  );

  return (
    <section className={`${styles.box}${collapsed ? ` ${styles.folded}` : ''}`} aria-label={title}>
      <div className={styles.dockHead}>
        <svg className={styles.mark2} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M7 1.5l1.3 3.2 3.2 1.3-3.2 1.3L7 10.5 5.7 7.3 2.5 6l3.2-1.3z" stroke="currentColor" fill="none" strokeWidth="1.2" />
        </svg>
        <h2>{title}</h2>
        <span className={styles.sub}>{sub}</span>
        {collapsed && working && <span className={styles.dot} role="img" aria-label={t('Помощник работает')} title={t('Помощник работает')} />}
        {collapsed && !working && failed && <span className={styles.flagErr} role="img" aria-label={t('Помощник споткнулся — разверни, чтобы увидеть')} title={t('Помощник споткнулся — разверни, чтобы увидеть')} />}
        {collapsed && !working && !failed && fresh && <span className={styles.flagNew} title={t('В ленте новое — разверни, чтобы прочитать')}>{t('новое')}</span>}
        <button
          type="button"
          className="btn small ghost"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('Развернуть помощника') : t('Свернуть помощника')}
          title={collapsed ? t('Развернуть помощника') : t('Свернуть помощника')}
          onClick={() => onCollapse(!collapsed)}
        >
          {collapsed ? '+' : '—'}
        </button>
      </div>
      {!collapsed && (
        <div className={styles.dockBody}>
          <div className={styles.dockTools}>{modelPick}</div>

          {about.data && can && (
            <details className={styles.about}>
              <summary>{t('Что помощник знает и умеет')}</summary>
              <div className={styles.cols}>
                <Ability title={t('Знает')} items={about.data.knows} />
                <Ability title={t('Смотрит сам')} items={can.reads} />
                <Ability title={t('Делает сам — шаг виден в ленте')} items={can.acts} />
                <Ability title={t('Только ты')} items={can.onlyYou} />
              </div>
            </details>
          )}

          <div className={styles.feed} ref={feed} role="log" aria-label={t('Разговор с помощником')}>
            <div className={styles.hello}>{intro}</div>
            {turns.map((turn) => (
              <div key={turn.turn} className={styles.turn}>
                {turn.user && <div className={styles.user}>{turn.user.text}</div>}
                {turn.steps.length > 0 && (
                  <ol className={styles.steps} aria-label={t('Шаги помощника')}>
                    {turn.steps.map((st) => (
                      <Step key={st.id} s={st} />
                    ))}
                  </ol>
                )}
                {turn.reply && (
                  <div className={styles.reply}>
                    <MdText text={turn.reply.text} />
                    <span className={styles.meta}>
                      {[turn.reply.model ? modelChip(turn.reply.model) : '', turn.reply.costUsd && turn.reply.costUsd >= 0.005 ? usd(turn.reply.costUsd) : ''].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                )}
              </div>
            ))}
            {working && v && (
              <div className={styles.thinking} role="status">
                <span className={styles.dot} aria-hidden="true" />
                {v.steps.some((st) => st.state === 'run') ? t('Выполняет шаг…') : t('Думает…')}
                <span className={styles.chip} title={t('Модель сессии: {model}', { model: v.model })}>{modelChip(v.model)}</span>
              </div>
            )}
          </div>

          {v?.state === 'error' && v.error && <span className={styles.err}>{v.error}</span>}
          {lost && <span className={styles.note}>{t('Разговор не сохранился: приложение перезапускалось. Всё, что помощник успел сделать, осталось — напиши ему заново.')}</span>}
          {q.isError && !gone && <span className={styles.err}>{errorText(q.error)}</span>}
          {error && <span className={styles.err}>{error}</span>}
          {v && footer?.(v)}

          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              className={styles.inp}
              rows={3}
              aria-label={v ? t('Сообщение помощнику') : title}
              placeholder={v ? t('Что поправить или сделать ещё') : placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // как в чате: Enter отправляет, Shift+Enter — новая строка (ввод иероглифов Enter не крадёт)
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className={styles.row}>
              {!working && <span className={styles.note}>{t('Enter — отправить, Shift+Enter — новая строка')}</span>}
              {working && <span className={styles.note}>{t('Можно уйти с экрана: помощник доработает, лента будет здесь.')}</span>}
              <span className={styles.gap} />
              {v && !working && (
                <button type="button" className="btn ghost small" onClick={restart} title={t('Закрыть этот разговор и начать с чистого листа. Сделанное помощником останется')}>
                  {t('Новый разговор')}
                </button>
              )}
              {working ? (
                <button type="button" className="btn small" onClick={() => void stop()} title={t('Прервать помощника. Сделанное до остановки останется')}>
                  {t('Остановить')}
                </button>
              ) : (
                <button type="submit" className="btn primary small" disabled={busy || loading || !text.trim()} title={t('Отправить — Enter')}>
                  {t('Отправить')}
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

function Ability({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className={styles.lbl}>{title}</div>
      <ul>
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

const MARK = { run: '', ok: '✓', fail: '✕' } as const;

function Step({ s }: { s: AssistantStep }) {
  const state = { run: t('выполняется'), ok: t('сделано'), fail: t('не вышло') }[s.state];
  const meta = [s.costUsd && s.costUsd >= 0.005 ? usd(s.costUsd) : '', s.ms !== undefined && s.ms >= 1000 ? dur(s.ms) : ''].filter(Boolean).join(' · ');
  return (
    <li className={`${styles.step} ${styles[s.state]}`}>
      <span className={styles.mark} title={state} aria-label={state}>
        {MARK[s.state]}
      </span>
      <span className={styles.body}>
        <span className={styles.label}>
          {s.label}
          {s.level === 'act' && (
            <span className={styles.act} title={t('Помощник что-то изменил: подключил, собрал или заполнил. Остальные шаги только смотрят')}>
              {t('действие')}
            </span>
          )}
        </span>
        {(s.note || s.detail) && <span className={styles.detail}>{s.state === 'run' ? s.note : s.detail}</span>}
      </span>
      {meta && <span className={styles.meta}>{meta}</span>}
    </li>
  );
}
