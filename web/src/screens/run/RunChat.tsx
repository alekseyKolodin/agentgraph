// Чат запуска (ui/app.js openChat, loadChat, sendChat, clearChatContext, renderChat; сервер — src/chat.ts): разговор с агентом
// про открытый запуск. Док справа (на узком экране — шторка снизу), виден на всех вкладках; ширина — ручкой у края.
// Ход ответа живёт на сервере: ушли на другой запуск — ответ доиграет и ляжет в историю. Поэтому всё, что приходит по потоку,
// применяется, только если на экране тот же запуск; вернувшись, док подтягивает ход опросом.
// Ответ — markdown, над ним свёрнутая трасса шагов, под ним виджеты: таблицы, ссылки, кнопки действий, варианты ответа.
// Опасное агент только предлагает кнопкой: клик → подтверждение → POST …/chat/action, сервер выполнит действие один раз.
// Состояние — модуль вне компонента: поток ответа и черновики переживают уход со страницы.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatAction, ChatEffect, ChatLive, ChatMessage, ChatPayload } from '@server/api-types';
import { ApiError, clearChat, errorText, fetchChat, fetchRunFlow, keys, postChat, stopChat } from '../../api';
import { postChatAction } from '../../api/run';
import { useConfirm } from '../../components/ConfirmDialog';
import { MdText } from '../../components/MdText';
import { useToast } from '../../components/Toast';
import { when, usd } from '../../lib/format';
import { modelOptions } from '../../lib/flow/tools';
import { t } from '../../lib/i18n';
import { actionConfirm, applyLive, chatMeta, emptyLive, liveOf, repliesAt } from '../../lib/run/chat';
import { LS } from '../../lib/storage';
import { art, artReload } from './artStore';
import { ChatWidgetView, StepTrace } from './ChatWidgets';
import { bump, runState } from './store';
import styles from './Run.module.css';

const POLL_MS = 2000;
/** Узкий экран: док — шторка снизу (как раскладка оболочки, Shell.module.css). */
const NARROW = '(max-width: 800px)';
const WIDTH = { min: 320, def: 420 };
const HEIGHT = { min: 160, def: 0.6 };
const GRIP_STEP = 24;

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

const chat = {
  runId: null as string | null,
  data: null as ChatPayload | null,
  busy: false,
  /** Идущий ход: шаги, последний текст агента, виджеты. */
  live: emptyLive() as ChatLive,
  /** Отправленное сообщение, пока сервер не подтвердил запись. */
  pendingText: null as string | null,
  /** Запуск, чей ответ читаем потоком из этой вкладки. */
  streaming: null as string | null,
  /** Запуск, чей док сейчас на экране: ушли со страницы — опрос идущего ответа не продолжаем. */
  shown: null as string | null,
  poll: undefined as ReturnType<typeof setTimeout> | undefined,
  /** Недописанные сообщения по запускам. */
  drafts: new Map<string, string>(),
  /** Открыт ли док у запуска: выбор руками живёт до перезагрузки; без выбора — открыт у идущего (и у всех, если открывали в прошлый раз). */
  open: new Map<string, boolean>(),
  msg: '',
  model: LS.get('agentgraph.chatModel', ''),
  width: LS.get('agentgraph.chatWidth', WIDTH.def),
  height: LS.get('agentgraph.chatHeight', 0),
  /** Прокрутить вниз при следующей отрисовке. */
  stick: false,
  version: 0,
};
const subs = new Set<() => void>();
function render(stick = false) {
  if (stick) chat.stick = true;
  chat.version++;
  subs.forEach((f) => f());
}
const useChat = () =>
  useSyncExternalStore((f) => {
    subs.add(f);
    return () => subs.delete(f);
  }, () => chat.version);

/** История с сервера. Ответ идёт, а читаем его не мы (вернулись на запуск, другая вкладка) — опрашиваем, пока не закончится. */
async function loadChat(runId: string): Promise<void> {
  const data = await fetchChat(runId);
  if (chat.runId !== runId) return;
  chat.data = data;
  // свой поток ещё читается (ушли и вернулись посреди ответа): ход и конец придут по нему
  const own = chat.streaming === runId;
  chat.busy = data.busy || own;
  if (!own) chat.live = liveOf(data);
  clearTimeout(chat.poll);
  if (data.busy && !own && chat.shown === runId) chat.poll = setTimeout(() => { if (chat.shown === runId) loadChat(runId).catch(() => {}); }, POLL_MS);
  render();
}

function openChat(runId: string, draft: string, live: boolean): string {
  let text = draft;
  chat.shown = runId;
  if (!chat.open.has(runId)) chat.open.set(runId, live || LS.get('agentgraph.chatOpen', false));
  if (chat.runId !== runId) {
    if (chat.runId) chat.drafts.set(chat.runId, draft);
    text = chat.drafts.get(runId) || '';
    Object.assign(chat, { runId, data: null, busy: chat.streaming === runId, live: emptyLive(), pendingText: null, msg: '' });
    clearTimeout(chat.poll);
  }
  render(true);
  loadChat(runId).catch((err) => {
    chat.msg = errorText(err);
    render();
  });
  return text;
}

// ---------- размер дока: CSS-переменная на корне документа, раскладку (отступ под док) считает CSS

const clampW = (w: number) => Math.round(Math.min(Math.max(w, WIDTH.min), window.innerWidth * 0.7));
const clampH = (h: number) => Math.round(Math.min(Math.max(h, HEIGHT.min), window.innerHeight * 0.85));
function applySize() {
  const root = document.documentElement.style;
  root.setProperty('--run-chat-w', `${clampW(chat.width)}px`);
  root.setProperty('--run-chat-h', `${clampH(chat.height || window.innerHeight * HEIGHT.def)}px`);
}
function clearSize() {
  document.documentElement.style.removeProperty('--run-chat-w');
  document.documentElement.style.removeProperty('--run-chat-h');
}
function setSize(narrow: boolean, px: number, save: boolean) {
  if (narrow) chat.height = clampH(px);
  else chat.width = clampW(px);
  applySize();
  if (save) LS.set(narrow ? 'agentgraph.chatHeight' : 'agentgraph.chatWidth', narrow ? chat.height : chat.width);
}

/** Ручка у края дока: тянуть мышью или стрелками с клавиатуры. */
function Grip() {
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const narrow = matchMedia(NARROW).matches;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setSize(narrow, narrow ? window.innerHeight - ev.clientY : window.innerWidth - ev.clientX, false);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setSize(narrow, narrow ? chat.height : chat.width, true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const narrow = matchMedia(NARROW).matches;
    const grow = narrow ? { ArrowUp: 1, ArrowDown: -1 } : { ArrowLeft: 1, ArrowRight: -1 };
    const d = grow[e.key as keyof typeof grow];
    if (!d) return;
    e.preventDefault();
    const cur = narrow ? chat.height || window.innerHeight * HEIGHT.def : chat.width;
    setSize(narrow, cur + d * GRIP_STEP, true);
  };
  return (
    <div
      className={styles.dockGrip}
      role="separator"
      aria-orientation={matchMedia(NARROW).matches ? 'horizontal' : 'vertical'}
      aria-label={t('Размер чата: тянуть или стрелки')}
      title={t('Размер чата: тянуть или стрелки')}
      tabIndex={0}
      onPointerDown={down}
      onKeyDown={key}
    />
  );
}

function MsgView({ m, i, runId, busy, replies, onAct, onReply, msg }: {
  m: ChatMessage;
  i: number;
  runId: string;
  busy: boolean;
  replies: boolean;
  onAct: (i: number, a: ChatAction, o: { saveToFlows?: boolean }) => Promise<void>;
  onReply: (text: string) => void;
  msg: (text: string) => void;
}) {
  const navigate = useNavigate();
  if (m.role === 'note') return <div className={cx(styles.cmsg, styles.note)}>{m.text}</div>;
  if (m.role === 'user') return <div className={cx(styles.cmsg, styles.user)}>{m.text}</div>;
  return (
    <div className={cx(styles.cmsg, styles.assistant, m.error && styles.error)}>
      {m.steps && <StepTrace steps={m.steps} runId={runId} />}
      {m.text && <MdText text={m.text} />}
      {m.widgets?.map((w, k) => (
        <ChatWidgetView key={k} w={w} runId={runId} disabled={busy} replies={replies} onAct={(a, o) => onAct(i, a, o)} onReply={onReply} msg={msg} />
      ))}
      {/* старые истории: чат сам продолжал запуск и оставлял ссылку */}
      {m.openRun && <button type="button" className="btn small" onClick={() => void navigate(`/run/${m.openRun}`)}>{t('Открыть новый запуск')}</button>}
      <span className={styles.cmeta}>{`${when(m.at)}${m.costUsd ? ` · ${usd(m.costUsd)}` : ''}`}</span>
    </div>
  );
}

/** Док чата на странице запуска. live — запуск идёт: док открыт по умолчанию. onAfterTurn — обновить список запусков. */
export function RunChat({ runId, live, onAfterTurn }: { runId: string; live: boolean; onAfterTurn: () => void }) {
  useChat();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { askConfirm, notify } = useConfirm();
  const toast = useToast();
  const field = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const afterTurn = useRef(onAfterTurn);
  afterTurn.current = onAfterTurn;

  useEffect(() => {
    field.current!.value = openChat(runId, field.current!.value, live);
    return () => {
      // ушли со страницы: недописанное — в черновик этого запуска, опрос не нужен
      if (chat.runId === runId) chat.drafts.set(runId, field.current?.value ?? '');
      if (chat.shown === runId) chat.shown = null;
      clearTimeout(chat.poll);
    };
  }, [runId]);

  useEffect(() => {
    applySize();
    const onResize = () => applySize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      clearSize();
    };
  }, []);

  // у низа или явно просили — держим низ
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const box = log.current;
    if (!box) return;
    if (chat.stick || atBottom.current) box.scrollTop = box.scrollHeight;
    chat.stick = false;
  });

  const setMsg = (text: string) => {
    chat.msg = text;
    render();
  };

  /** Что ход или клик поменял: артефакты и flow перечитать, список запусков обновить; новый запуск по кнопке — перейти к нему. */
  const applyEffect = (e: ChatEffect, go: boolean) => {
    if (e.kind === 'artifacts') {
      if (art.on && runState.id === runId) artReload();
    } else if (e.kind === 'flow') {
      void qc.invalidateQueries({ queryKey: keys.flows });
      fetchRunFlow(runId)
        .then((spec) => {
          if (runState.id !== runId) return;
          runState.flow = { id: runId, spec };
          bump();
        })
        .catch(() => {});
    } else {
      afterTurn.current();
      if (go && e.runId) void navigate(`/run/${e.runId}`);
    }
  };

  const toggle = () => {
    const next = !chat.open.get(runId);
    chat.open.set(runId, next);
    LS.set('agentgraph.chatOpen', next);
    render(true);
    if (next) requestAnimationFrame(() => field.current?.focus());
  };

  /** Как /clear: новая сессия, история пуста. С кнопки — с подтверждением, командой /clear — сразу. */
  const clearContext = async (confirm: boolean) => {
    const id = chat.runId;
    if (!id) return;
    if (chat.busy) return setMsg(t('Агент ещё отвечает: прерви ответ или дождись его'));
    if (confirm && chat.data?.messages.length && !(await askConfirm(t('Очистить контекст чата? Агент забудет разговор, сообщения пропадут с экрана.'), { ok: t('Очистить') }))) return;
    try {
      const data = await clearChat(id);
      if (chat.runId === id) {
        chat.data = data;
        setMsg('');
      }
    } catch (err) {
      setMsg(errorText(err));
    }
  };

  const send = async (raw?: string) => {
    const f = field.current;
    const text = (raw ?? f?.value ?? '').trim();
    const id = chat.runId;
    if (!text || !id) return;
    if (text === '/clear') {
      if (f && raw === undefined) f.value = '';
      return clearContext(false);
    }
    if (chat.busy) return;
    if (f && raw === undefined) f.value = '';
    if (raw === undefined) chat.drafts.delete(id);
    Object.assign(chat, { busy: true, live: emptyLive(), pendingText: text, streaming: id, msg: '' });
    render(true);
    const apply = (fn: () => void) => {
      if (chat.runId === id) {
        fn();
        render();
      }
    };
    try {
      LS.set('agentgraph.chatModel', chat.model);
      await postChat(id, { message: text, model: chat.model || undefined }, (e) => {
        if (e.type === 'saved') apply(() => { chat.data = e.chat; chat.pendingText = null; });
        else if (e.type === 'done') apply(() => { chat.data = e.chat; chat.busy = false; chat.live = emptyLive(); });
        else if (e.type === 'error') apply(() => { chat.msg = e.error; });
        else if (e.type === 'effect') {
          if (chat.runId === id) applyEffect(e, false);
        } else apply(() => applyLive(chat.live, e));
      });
    } catch (err) {
      apply(() => {
        chat.msg = errorText(err);
        // сообщение не дошло до истории — вернём его в поле, чтобы не набирать заново
        if (raw === undefined && chat.pendingText && field.current && !field.current.value) field.current.value = chat.pendingText;
      });
    } finally {
      if (chat.streaming === id) chat.streaming = null;
      // поток мог оборваться посреди ответа (перезапуск сервера): состояние — с сервера
      apply(() => { chat.busy = false; chat.pendingText = null; });
      if (chat.runId === id) loadChat(id).catch(() => {});
      afterTurn.current();
    }
  };

  /** Кнопка под ответом: подтверждение с тем, что именно случится, затем сервер сверит состояние и выполнит один раз. */
  const act = async (msgIndex: number, a: ChatAction, o: { saveToFlows?: boolean }) => {
    const id = chat.runId;
    if (!id) return;
    const c = actionConfirm(a, runState.st?.run.flow ?? '');
    if (!(await askConfirm(c.text, { ok: c.ok, danger: c.danger }))) return;
    try {
      const r = await postChatAction(id, { msgIndex, actionId: a.id, ...o });
      if (chat.runId === id) {
        chat.data = r.chat;
        render();
      }
      if (r.action.state === 'done') toast(r.action.result || t('Готово'));
      else await notify(r.action.result || t('Не вышло'));
      for (const e of r.effects) applyEffect(e, true);
    } catch (err) {
      // 409 used: на сервере итог уже есть — показываем его
      const fresh = err instanceof ApiError ? (err.data as { chat?: ChatPayload } | undefined)?.chat : undefined;
      if (fresh && chat.runId === id) {
        chat.data = fresh;
        render();
      }
      await notify(errorText(err));
    }
  };

  const mine = chat.runId === runId;
  const msgs = mine ? chat.data?.messages || [] : [];
  const busy = mine && chat.busy;
  const open = chat.open.get(runId) ?? live;
  const meta = chatMeta(msgs, chat.data?.totalCostUsd, busy);
  const replyAt = busy ? -1 : repliesAt(msgs);
  const pick = (text: string) => void send(text);

  // свёрнутый док прячет тело, а не убирает его: поле ввода, черновик и прокрутка остаются
  return (
    <aside className={cx(styles.chatDock, !open && styles.closed)} aria-label={t('Чат запуска')}>
      {open && <Grip />}
      <button type="button" className={styles.dockRail} hidden={open} onClick={toggle} title={t('Открыть чат с агентом об этом запуске')} aria-expanded={false}>
        <span className={styles.railTitle}>{t('Чат')}</span>
        {busy && <span className={styles.railDot} aria-label={t('агент отвечает…')} />}
        {meta && <span className={styles.railMeta}>{meta}</span>}
      </button>
      <div className={styles.dockBody} hidden={!open}>
        <div className={styles.chatHead}>
          <button type="button" className={cx('fold-head', styles.chatTitle)} aria-expanded onClick={toggle} title={t('Свернуть чат')}>
            {t('Чат с агентом об этом запуске')}
          </button>
          <span className={styles.chatMeta} title={chat.data?.sessionId ? t('Сессия чата: claude --resume {id} (в директории проекта запуска)', { id: chat.data.sessionId }) : ''}>
            {meta}
          </span>
          <span className={cx('row', styles.push)}>
            <select
              title={t('Модель чата')}
              value={chat.model}
              onChange={(e) => {
                chat.model = e.target.value;
                render();
              }}
            >
              {modelOptions(chat.model).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <button type="button" className="btn small ghost" title={t('Как /clear: агент забудет разговор, следующее сообщение начнёт новый')} disabled={busy || !msgs.length} onClick={() => void clearContext(true)}>
              {t('Очистить контекст')}
            </button>
          </span>
        </div>
        <div
          ref={log}
          className={styles.chatLog}
          onScroll={(e) => {
            const box = e.currentTarget;
            atBottom.current = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
          }}
        >
          {msgs.length || chat.pendingText || busy ? (
            <>
              {msgs.map((m, i) => (
                <MsgView key={i} m={m} i={i} runId={runId} busy={busy} replies={i === replyAt} onAct={act} onReply={pick} msg={(text) => toast(text)} />
              ))}
              {mine && chat.pendingText && <div className={cx(styles.cmsg, styles.user)}>{chat.pendingText}</div>}
              {busy && (
                <div className={cx(styles.cmsg, styles.assistant, styles.busy)}>
                  <span className={styles.thinking}>{t('думает…')}</span>
                  <StepTrace steps={chat.live.steps} runId={runId} live />
                  {chat.live.text && <p className={styles.liveText}>{chat.live.text}</p>}
                  {chat.live.widgets.map((w, k) => (
                    <ChatWidgetView key={k} w={w} runId={runId} disabled replies={false} onAct={async () => {}} onReply={() => {}} msg={(text) => toast(text)} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className={styles.chatHint}>
              <p>{t('Агент видит этот запуск: статус, этапы, выводы и транскрипты, живой лог, артефакты, flow и репозиторий.')}</p>
              <p>{t('Сам ставит на паузу, возобновляет, меняет лимит итераций и отвечает на вопрос агента. Остановить запуск, записать артефакт, сохранить flow, ответить на паузу, продолжить или запустить заново — предложит кнопкой: сработает после твоего подтверждения.')}</p>
            </div>
          )}
        </div>
        <form className={styles.chatForm} onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea
            ref={field}
            name="message"
            rows={2}
            placeholder={t('Спроси про запуск или попроси что-то сделать. Enter — отправить, Shift+Enter — перенос')}
            title={t('Например: «что сейчас происходит?», «почему упало?», «подними лимит итераций до 40», «поставь на паузу после этапа». /clear — очистить контекст')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="row">
            <button type="submit" className="btn primary" disabled={busy}>{t('Отправить')}</button>
            {busy && (
              <button type="button" className="btn ghost" onClick={() => void stopChat(runId).catch((err) => notify(errorText(err)))}>{t('Прервать')}</button>
            )}
            <span className={`msg${chat.msg ? ' err' : ''}`}>{chat.msg}</span>
          </div>
        </form>
      </div>
    </aside>
  );
}
