// Помощник «Правки» (ui/app.js aiEdit, renderAiResult): чат справа от схемы. Запрос человека — пузырём, ответ ИИ —
// отрисованный итог, «Что изменилось» строками с переходом к этапу, предупреждения плашкой, факты тихой строкой.
// Пока ИИ правит — шаги словами, таймер и «Прервать»; уточнение, отправленное в это время, уйдёт следующей правкой.
// Внизу — большое поле «Что поменять» (⌘↵). История живёт, пока открыт flow (store.ts → chat).
import { memo, useEffect, useRef } from 'react';
import { editFlow, errorText, useConfig } from '../../api';
import { aiModel, EditProgress, noteAiModel, StepList, TechLog } from '../../components/AiProgress';
import { MdText } from '../../components/MdText';
import { aiFacts, aiProgressStep, startProgress } from '../../lib/flow/ai-progress';
import { assistantReply, followUp, type ChangeRow } from '../../lib/flow/assistant';
import { collectSpec, findPhase, specChanges, toEditable } from '../../lib/flow/edit';
import { plural } from '../../lib/format';
import { t } from '../../lib/i18n';
import { LS } from '../../lib/storage';
import { openBlockPane, openFlowSettings, openPhasePane } from './actions';
import {
  flowState, markDirty, msgClass, NO_MSG, patchChat, pushChat, set, setAiProgress, useAiProgress, useFlowStore, type AiResult, type ChatMsg,
} from './store';
import styles from './Flow.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
type AiMsg = Extract<ChatMsg, { who: 'ai' }>;
type MeMsg = Extract<ChatMsg, { who: 'me' }>;

/** Запрос вернуть в поле «Что поменять» (правка не ушла или не удалась): перед тем, что там уже набрано. */
const restoreText = (text: string) => set({ aiText: [text, flowState.aiText].filter((x) => x.trim()).join('\n') });

/**
 * Правка с ИИ: база — то, что сейчас в схеме, вместе с несохранёнными правками (сломанный flow — текст YAML). queued —
 * уточнение из очереди: его пузырь уже в чате, prev — запрос, после которого оно ушло. Результат ложится в схему
 * несохранённым; ответ — сообщением в чат. Не ушла или не удалась — текст запроса возвращается в поле.
 */
async function runAiEdit(text: string, defaultCwd: string, queued?: { id: number; prev: string }): Promise<void> {
  const flow = flowState.flow;
  if (!flow || flowState.aiAbort) return;
  let base: { spec: Record<string, unknown> } | { yaml: string };
  try {
    base = flowState.spec ? { spec: collectSpec(flowState.spec) } : { yaml: flow.yaml };
  } catch (err) {
    // пузырь уточнения из очереди убирается, текст — обратно в поле; обычный запрос в поле и остался
    if (queued) {
      set({ chat: flowState.chat.filter((m) => m.id !== queued.id) });
      restoreText(text);
    }
    set({ aiMsg: { text: t('Сначала поправь схему: {error}', { error: errorText(err) }), tone: 'err' } });
    return;
  }
  const instruction = queued ? followUp(queued.prev, text) : text;
  if (queued) patchChat(queued.id, { queued: false });
  else set({ aiText: '' });
  const me = queued?.id ?? pushChat<MeMsg>({ who: 'me', text });
  // ответ — сразу после своего запроса: прерванная снаружи правка (flow открыли заново) не встанет под чужим запросом
  const answer = (msg: Omit<AiMsg, 'id'>) => {
    const id = pushChat<AiMsg>(msg);
    const at = flowState.chat.findIndex((m) => m.id === me);
    if (at < 0) return id;
    const mine = flowState.chat.find((m) => m.id === id)!;
    const rest = flowState.chat.filter((m) => m.id !== id);
    set({ chat: [...rest.slice(0, at + 1), mine, ...rest.slice(at + 1)] });
    return id;
  };
  // правку прервали снаружи (flow открыли заново, resetAi): тот же flow — запрос в чате не остаётся без ответа
  const orphan = () => {
    if (flowState.chat.some((m) => m.id === me)) answer({ who: 'ai', status: 'aborted', intro: '', rows: [], notes: [], facts: '', steps: [], log: [] });
  };
  const seq = flowState.editSeq;
  const ctl = new AbortController();
  // правка, которая идёт сейчас: чтение через функцию — после await она может быть уже другой
  const current = () => flowState.aiAbort;
  const model = aiModel();
  set({ aiAbort: ctl, aiProgress: startProgress('edit', Date.now()), aiMsg: NO_MSG, aiStartSeq: seq });
  const trail = () => ({ steps: flowState.aiProgress?.steps ?? [], log: flowState.aiProgress?.log ?? [] });
  let ok = false;
  try {
    const cwd = LS.raw('agentgraph.cwd') || defaultCwd;
    const r = await editFlow(flow.name, { instruction, ...base, cwd, model }, (e) => {
      if (current() !== ctl || !flowState.aiProgress) return;
      if (e.type === 'progress' && e.model) noteAiModel(model, e.model);
      setAiProgress(aiProgressStep(flowState.aiProgress, e, Date.now()));
    }, ctl.signal);
    if (current() !== ctl) return orphan();
    ok = true;
    const facts = aiFacts(r.model, r.durationMs, r.costUsd);
    if (!r.changed) {
      answer({ who: 'ai', status: 'same', intro: r.summary || t('ИИ ничего не поменял.'), rows: [], notes: [], facts, ...trail() });
      return;
    }
    const before = 'spec' in base ? toEditable(base.spec as never) : null;
    const after = toEditable(r.spec);
    const reply = assistantReply(r.summary, before, after);
    const stale = flowState.editSeq !== seq;
    const msgId = answer({ who: 'ai', status: 'done', ...reply, facts, stale, ...trail() });
    const ai: AiResult = {
      undo: { spec: flowState.spec, dirty: flowState.dirty, prev: flowState.ai, seq: flowState.editSeq },
      summary: r.summary,
      diff: specChanges(before, after),
      stale,
      cost: r.costUsd,
      model: r.model,
      durationMs: r.durationMs,
      seq: 0,
      msgId,
    };
    Object.assign(flowState, { ai, spec: after, aiMsg: NO_MSG, sel: null, graphSel: null });
    markDirty();
    ai.seq = flowState.editSeq;
  } catch (err) {
    if (current() !== ctl) return orphan();
    answer(ctl.signal.aborted
      ? { who: 'ai', status: 'aborted', intro: '', rows: [], notes: [], facts: '', ...trail() }
      : { who: 'ai', status: 'error', intro: '', rows: [], notes: [], facts: '', error: errorText(err), ...trail() });
    // запрос не выполнен — обратно в поле, чтобы не набирать заново
    restoreText(text);
  } finally {
    if (current() === ctl) {
      set({ aiAbort: null, aiProgress: null });
      // уточнение из очереди: после удачной правки — следующей правкой; после ошибки или «Прервать» — обратно в поле
      const next = flowState.aiQueue;
      const qMsg = [...flowState.chat].reverse().find((m): m is MeMsg => m.who === 'me' && Boolean(m.queued));
      if (next !== null) {
        set({ aiQueue: null });
        if (ok && qMsg) void runAiEdit(next, defaultCwd, { id: qMsg.id, prev: text });
        else {
          if (qMsg) set({ chat: flowState.chat.filter((m) => m.id !== qMsg.id) });
          restoreText(next);
        }
      }
    }
  }
}

/** Переход по строке «Что изменилось»: этап или блок — его поля справа, файл и настройки — «Настройки flow». */
function openRow(r: ChangeRow): void {
  const spec = flowState.spec;
  if (!spec) return;
  if (r.what === 'phase') {
    const at = findPhase(spec, r.name);
    if (at) openPhasePane(at.bi, at.i, styles.flash!);
  } else if (r.what === 'block') {
    const bi = spec.blocks.findIndex((b) => b.name === r.name);
    if (bi >= 0) openBlockPane(bi);
  } else openFlowSettings(r.what === 'artifact' ? 'artifacts' : 'description');
}

const KIND_LABEL: Record<ChangeRow['kind'], string> = { new: 'новый', edit: 'правка', gone: 'удалён' };
const KIND_CLASS: Record<ChangeRow['kind'], string | undefined> = { new: styles.tagNew, edit: styles.tagEdit, gone: styles.tagGone };

/** Строки «Что изменилось»: «новый · Утверждение партии. Показывает идеи…» — клик ведёт к этапу на схеме. */
function ChangeList({ rows }: { rows: ChangeRow[] }) {
  return (
    <div className={styles.chgList}>
      <span className={styles.cap}>{t('Что изменилось')}</span>
      {rows.map((r, k) => (
        <button
          key={k}
          type="button"
          className={styles.chgRow}
          disabled={r.kind === 'gone'}
          title={r.kind === 'gone' ? undefined : r.what === 'phase' ? t('Открыть этап') : t('Открыть')}
          onClick={() => openRow(r)}
        >
          <span className={styles.chgKind}><span className={cx(styles.tag, KIND_CLASS[r.kind])}>{t(KIND_LABEL[r.kind])}</span></span>
          <span><b>{r.label}.</b> {r.text}</span>
        </button>
      ))}
    </div>
  );
}

/** Ответ ИИ: сообщения не меняются на месте (patchChat — новый объект), поэтому memo по ссылке. */
const AiReply = memo(function AiReply({ m }: { m: AiMsg }) {
  const steps = m.steps.length;
  return (
    <div className={cx(styles.aiReply, m.undone && styles.undone)} role="group" aria-label={t('Ответ ИИ')}>
      {m.status === 'error' && <p className="msg err">{m.error}</p>}
      {m.status === 'aborted' && <p className="muted small">{t('Правка прервана — flow не изменился.')}</p>}
      {m.intro && <MdText text={m.intro} />}
      {m.rows.length > 0 && <ChangeList rows={m.rows} />}
      {m.notes.length > 0 && (
        <div className={styles.notePlate} role="note">
          <b>{t('Обрати внимание.')}</b>{' '}
          {m.notes.length === 1 ? m.notes[0] : <ul>{m.notes.map((n, k) => <li key={k}>{n}</li>)}</ul>}
        </div>
      )}
      {m.stale && (
        <div className={styles.notePlate} role="note">
          {t('Правки в схеме, сделанные пока ИИ работал, в результат не вошли: «Отменить правку» вернёт их.')}
        </div>
      )}
      {m.undone && <p className="muted small">{t('Эту правку отменили.')}</p>}
      {(steps > 0 || m.log.length > 0) && (
        <details className={styles.trail}>
          <summary>{steps ? t('Ход правки · {n} {word}', { n: steps, word: plural(steps, 'шаг', 'шага', 'шагов') }) : t('Ход правки')}</summary>
          {steps > 0 && <StepList steps={m.steps} />}
          <TechLog lines={m.log} />
        </details>
      )}
      {m.facts && <span className={styles.facts} title={t('Модель · сколько шла правка · цена')}>{m.facts}</span>}
    </div>
  );
});

/** Помощник целиком: лента сообщений, ход идущей правки, поле «Что поменять». hidden — открыты поля этапа. */
export function Assistant({ hidden }: { hidden: boolean }) {
  const st = useFlowStore();
  const progress = useAiProgress();
  const defaultCwd = useConfig().data!.defaultCwd;
  const busy = Boolean(st.aiAbort);
  const feed = useRef<HTMLDivElement>(null);

  // новое сообщение или шаг — лента вниз, к последнему; но не тогда, когда человек прокрутил вверх читать историю
  const tail = `${st.chat.length}:${progress?.steps.length ?? -1}:${hidden}`;
  const pinned = useRef(true);
  useEffect(() => {
    const el = feed.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [tail]);

  const send = (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    const text = flowState.aiText.trim();
    if (!text) return set({ aiMsg: { text: t('Опиши, что поменять'), tone: '' } });
    if (flowState.aiAbort) {
      // уточнение во время правки: копится одной очередью и уходит, когда правка закончится
      const queued = [...flowState.chat].reverse().find((m): m is MeMsg => m.who === 'me' && Boolean(m.queued));
      const joined = flowState.aiQueue ? `${flowState.aiQueue}\n${text}` : text;
      if (queued) patchChat(queued.id, { text: joined });
      else pushChat<MeMsg>({ who: 'me', text, queued: true });
      set({ aiQueue: joined, aiText: '', aiMsg: NO_MSG });
      return;
    }
    pinned.current = true;
    void runAiEdit(text, defaultCwd);
  };

  const warn = busy && st.editSeq !== st.aiStartSeq
    ? t('Ты правишь схему, пока ИИ работает: эти правки в его результат не войдут — «Отменить правку» вернёт их.')
    : undefined;
  const hint = busy ? t('Можно дописать уточнение: оно уйдёт следующим шагом') : st.dirty ? t('Правка ляжет поверх несохранённой') : t('Изменения лягут в схему несохранёнными');

  return (
    <div className={styles.assistant} hidden={hidden}>
      <div
        ref={feed}
        className={styles.chatFeed}
        aria-label={t('Сообщения помощника')}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {st.chat.length === 0 && !progress && (
          <div className={styles.chatEmpty}>
            <p>{t('Опиши, что поменять во flow, — ИИ поправит схему, а ты проверишь изменения и сохранишь.')}</p>
            <p className="muted small">{t('ИИ видит этот flow с несохранёнными правками и верхний уровень папки проекта. Меняет только flow, запусков не делает.')}</p>
          </div>
        )}
        {st.chat.map((m) => (m.who === 'me'
          ? (
            <div key={m.id} className={cx(styles.bubble, m.queued && styles.queued)}>
              {m.text}
              {m.queued && <span className={styles.queuedNote}>{t('уйдёт, когда закончится текущая правка')}</span>}
            </div>
          )
          : <AiReply key={m.id} m={m} />))}
        {progress && (
          <>
            <EditProgress progress={progress} onAbort={() => flowState.aiAbort?.abort()} warn={warn} />
            <p className="muted small">{t('Этапы на схеме загораются зелёным по мере правки. Flow не изменится, пока ты не сохранишь.')}</p>
          </>
        )}
      </div>
      <form className={styles.composer} onSubmit={send}>
        <label htmlFor="ai-ask" className={styles.cap}>{t('Что поменять')}</label>
        <textarea
          id="ai-ask"
          name="instruction"
          rows={4}
          placeholder={t('Например: добавь ревью после реализации')}
          value={st.aiText}
          onChange={(e) => set({ aiText: e.target.value, ...(flowState.aiMsg.text ? { aiMsg: NO_MSG } : {}) })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e);
          }}
        />
        <div className={styles.composerRow}>
          <span className={styles.hint}>{hint}</span>
          <span className={styles.grow} />
          <span className={styles.kbd} aria-hidden="true">⌘↵</span>
          <button type="submit" className="btn" title={t('⌘/Ctrl+Enter')}>{busy ? t('Дописать') : t('Отправить')}</button>
        </div>
        {st.aiMsg.text && <p className={msgClass(st.aiMsg)}>{st.aiMsg.text}</p>}
      </form>
    </div>
  );
}
