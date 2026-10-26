// Чат запуска (ui/app.js openChat, loadChat, sendChat, clearChatContext, renderChat; сервер — src/chat.ts): разговор с агентом
// про открытый запуск. Ход ответа живёт на сервере: ушли на другой запуск — ответ доиграет и ляжет в историю. Поэтому всё,
// что приходит по потоку, применяется, только если на экране тот же запуск; вернувшись, панель подтягивает ход опросом.
// Состояние — модуль вне компонента: поток ответа и черновики переживают уход со страницы.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import type { ChatMessage, ChatPayload } from '@server/api-types';
import { clearChat, errorText, fetchChat, postChat, stopChat } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import { ICON } from '../../components/shell/FlowList';
import { when, usd } from '../../lib/format';
import { modelOptions } from '../../lib/flow/tools';
import { t } from '../../lib/i18n';
import { chatMeta, chatText } from '../../lib/run/view';
import { LS } from '../../lib/storage';
import styles from './Run.module.css';

const CHAT_ACTIVITY_SHOWN = 30;
const POLL_MS = 2000;

const chat = {
  runId: null as string | null,
  data: null as ChatPayload | null,
  busy: false,
  /** Ход идущего ответа: текст и вызовы инструментов. */
  activity: [] as string[],
  /** Отправленное сообщение, пока сервер не подтвердил запись. */
  pendingText: null as string | null,
  /** Запуск, чей ответ читаем потоком из этой вкладки. */
  streaming: null as string | null,
  poll: undefined as ReturnType<typeof setTimeout> | undefined,
  /** Недописанные сообщения по запускам. */
  drafts: new Map<string, string>(),
  msg: '',
  open: LS.get('agentgraph.chatOpen', false),
  model: LS.get('agentgraph.chatModel', ''),
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
  if (!own) chat.activity = data.activity || [];
  clearTimeout(chat.poll);
  if (data.busy && !own) chat.poll = setTimeout(() => { if (chat.runId === runId) loadChat(runId).catch(() => {}); }, POLL_MS);
  render();
}

function openChat(runId: string, draft: string): string {
  let text = draft;
  if (chat.runId !== runId) {
    if (chat.runId) chat.drafts.set(chat.runId, draft);
    text = chat.drafts.get(runId) || '';
    Object.assign(chat, { runId, data: null, busy: chat.streaming === runId, activity: [], pendingText: null, msg: '' });
    clearTimeout(chat.poll);
  }
  render(true);
  loadChat(runId).catch((err) => {
    chat.msg = errorText(err);
    render();
  });
  return text;
}

function MsgView({ m, onOpenRun }: { m: ChatMessage; onOpenRun: (id: string) => void }) {
  if (m.role === 'note') return <div className={`${styles.cmsg} ${styles.note}`}>{m.text}</div>;
  return (
    <div className={[styles.cmsg, styles[m.role], m.error && styles.error].filter(Boolean).join(' ')}>
      {/* chatText экранирует текст сам и добавляет только pre, code, b */}
      <div className={styles.ctext} dangerouslySetInnerHTML={{ __html: chatText(m.text) }} />
      {m.openRun && <button type="button" className="btn small" onClick={() => onOpenRun(m.openRun!)}>{t('Открыть новый запуск')}</button>}
      {m.role === 'assistant' && <span className={styles.cmeta}>{`${when(m.at)}${m.costUsd ? ` · ${usd(m.costUsd)}` : ''}`}</span>}
    </div>
  );
}

/** Панель чата под «Обзором». onAfterTurn — после ответа: чат мог поставить паузу, поменять лимит или продолжить запуск. */
export function RunChat({ runId, onAfterTurn }: { runId: string; onAfterTurn: () => void }) {
  useChat();
  const navigate = useNavigate();
  const { askConfirm, notify } = useConfirm();
  const field = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const afterTurn = useRef(onAfterTurn);
  afterTurn.current = onAfterTurn;

  useEffect(() => {
    field.current!.value = openChat(runId, field.current!.value);
    return () => {
      // ушли со страницы: недописанное — в черновик этого запуска, опрос не нужен
      if (chat.runId === runId) chat.drafts.set(runId, field.current?.value ?? '');
      clearTimeout(chat.poll);
    };
  }, [runId]);

  // у низа или явно просили — держим низ
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const box = log.current!;
    if (chat.stick || atBottom.current) box.scrollTop = box.scrollHeight;
    chat.stick = false;
  });

  const setMsg = (text: string) => {
    chat.msg = text;
    render();
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

  const send = async (ev?: { preventDefault: () => void }) => {
    ev?.preventDefault();
    const f = field.current!;
    const text = f.value.trim();
    const id = chat.runId;
    if (!text || !id) return;
    if (text === '/clear') {
      f.value = '';
      return clearContext(false);
    }
    if (chat.busy) return;
    f.value = '';
    chat.drafts.delete(id);
    Object.assign(chat, { busy: true, activity: [], pendingText: text, streaming: id, msg: '' });
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
        else if (e.type === 'log') apply(() => { chat.activity.push(e.line); chat.activity.splice(0, chat.activity.length - CHAT_ACTIVITY_SHOWN); });
        else if (e.type === 'done') apply(() => { chat.data = e.chat; chat.busy = false; chat.activity = []; });
        else apply(() => { chat.msg = e.error; });
      });
    } catch (err) {
      apply(() => {
        chat.msg = errorText(err);
        // сообщение не дошло до истории — вернём его в поле, чтобы не набирать заново
        if (chat.pendingText && field.current && !field.current.value) field.current.value = chat.pendingText;
      });
    } finally {
      if (chat.streaming === id) chat.streaming = null;
      // поток мог оборваться посреди ответа (перезапуск сервера): состояние — с сервера
      apply(() => { chat.busy = false; chat.pendingText = null; });
      if (chat.runId === id) loadChat(id).catch(() => {});
      afterTurn.current();
    }
  };

  const msgs = chat.runId === runId ? chat.data?.messages || [] : [];
  const busy = chat.runId === runId && chat.busy;
  return (
    <section className={`${styles.runChat}${chat.open ? '' : ` ${styles.collapsed}`}`}>
      <div className={styles.chatHead}>
        <button
          type="button"
          className="fold-head"
          aria-expanded={chat.open}
          onClick={() => {
            chat.open = !chat.open;
            LS.set('agentgraph.chatOpen', chat.open);
            render(true);
          }}
        >
          <span className="caret">{ICON.caret}</span>{t('Чат с агентом об этом запуске')}
        </button>
        <span className="muted small" title={chat.data?.sessionId ? t('Сессия чата: claude --resume {id} (в директории проекта запуска)', { id: chat.data.sessionId }) : ''}>
          {chatMeta(msgs, chat.data?.totalCostUsd, busy)}
        </span>
        <span className={`row ${styles.push}`}>
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
      <div className={styles.chatBody}>
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
              {msgs.map((m, i) => <MsgView key={i} m={m} onOpenRun={(id) => void navigate(`/run/${id}`)} />)}
              {chat.runId === runId && chat.pendingText && <MsgView m={{ role: 'user', text: chat.pendingText, at: '' }} onOpenRun={() => {}} />}
              {busy && (
                <div className={`${styles.cmsg} ${styles.assistant} ${styles.busy}`}>
                  {t('⏳ думает…')}{chat.activity.length > 0 && <div className={styles.activity}>{chat.activity.join('\n')}</div>}
                </div>
              )}
            </>
          ) : (
            <div className={styles.chatHint}>
              {t('Агент видит этот запуск: статус, блоки и итерации, выводы и транскрипты этапов, живой лог, репозиторий. Может поставить на паузу, возобновить, остановить запуск, поменять лимит итераций, ответить на вопрос агента, продолжить завершённый запуск.')}
            </div>
          )}
        </div>
        <form className={styles.chatForm} onSubmit={(e) => void send(e)}>
          <textarea
            ref={field}
            name="message"
            rows={2}
            placeholder={t('Спроси про запуск или попроси что-то сделать. Enter — отправить, Shift+Enter — перенос')}
            title={t('Например: «что сейчас происходит?», «почему упало?», «подними лимит итераций до 40», «поставь на паузу после этапа». /clear — очистить контекст')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) void send(e);
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
    </section>
  );
}
