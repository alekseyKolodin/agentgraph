// Плашка над схемой «Правка ИИ ещё не сохранена» (ui/app.js saveBuilder, aiUndo): есть, только когда есть что сохранять.
// После правки ИИ — что поменялось, «Отменить правку» и «Сохранить»; после ручных правок — без «Отменить правку».
// У черновика разового запуска — «Применить» (сервер только проверяет, в flows/ ничего не пишется).
import { useQueryClient } from '@tanstack/react-query';
import { checkFlow, errorText, keys, saveFlowSpec } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import { prevAfterUndo, rowsSummary } from '../../lib/flow/assistant';
import { collectSpec, SpecError } from '../../lib/flow/edit';
import { t } from '../../lib/i18n';
import { revealField } from './actions';
import { applySaved, emit, flowState, msgClass, NO_MSG, patchChat, saveStart, set, useFlowStore } from './store';
import styles from './Flow.module.css';

export function UnsavedBar() {
  const st = useFlowStore();
  const qc = useQueryClient();
  const { askConfirm } = useConfirm();
  const flow = st.flow;
  if (!flow || !st.spec) return null;
  const draft = Boolean(flow.draft);
  const ai = st.dirty ? st.ai : null;

  const save = async () => {
    const f = flowState.flow;
    if (!f || !flowState.spec) return;
    set({ bMsg: NO_MSG });
    const start = saveStart();
    try {
      const spec = collectSpec(flowState.spec);
      // черновик разового запуска: сервер только проверяет, в flows/ ничего не пишет
      const r = f.draft ? await checkFlow({ spec }) : await saveFlowSpec(f.name, spec);
      if (!applySaved(r, r.yaml, false, start)) {
        // пока сохранялось, открыли другой flow: сообщение ему не нужно, список flow — обновить
        if (!f.draft) await qc.invalidateQueries({ queryKey: keys.flows });
        return;
      }
      const done = f.draft ? t('Применено') : t('Сохранено');
      set({ bMsg: { text: done, tone: 'ok' } });
      setTimeout(() => {
        if (!flowState.dirty && flowState.bMsg.text === done) set({ bMsg: NO_MSG });
      }, 2500);
      if (!f.draft) await qc.invalidateQueries({ queryKey: keys.flows });
    } catch (err) {
      if (flowState.flow !== start.flow) return;
      set({ bMsg: { text: errorText(err), tone: 'err' } });
      if (err instanceof SpecError && err.field) revealField(err.field, styles.flash!);
    }
  };

  const undo = async () => {
    const cur = flowState.ai;
    if (!cur || flowState.aiAbort) return;
    if (flowState.editSeq !== cur.seq && !(await askConfirm(t('После правки ИИ ты менял схему. Отменить правку ИИ вместе с этими изменениями?'), { ok: t('Отменить', undefined, 'undo') }))) return;
    // за время вопроса могли сохранить или поправить ещё раз
    if (flowState.ai !== cur) return;
    // прошлая правка ИИ снова последняя: если руками между ними и после не правили, её отмена не спрашивает
    const prev = prevAfterUndo(cur, flowState.editSeq);
    Object.assign(flowState, { spec: cur.undo.spec, dirty: cur.undo.dirty, ai: prev, sel: null, graphSel: null, bMsg: NO_MSG });
    emit();
    if (cur.msgId) patchChat(cur.msgId, { undone: true });
  };

  if (!st.dirty) {
    // сохранили — короткое «Сохранено» на месте плашки
    return st.bMsg.text ? <p className={msgClass(st.bMsg, `msg ${styles.savedNote}`)} role="status">{st.bMsg.text}</p> : null;
  }

  const rows = ai?.msgId ? (st.chat.find((m) => m.id === ai.msgId && m.who === 'ai') as { rows?: Parameters<typeof rowsSummary>[0] } | undefined)?.rows ?? [] : [];
  const title = ai
    ? draft ? t('Правка ИИ ещё не применена') : t('Правка ИИ ещё не сохранена')
    : draft ? t('Есть неприменённые изменения') : t('Есть несохранённые изменения');
  const after = ai && st.editSeq !== ai.seq ? t('После неё ты правил схему вручную.') : '';
  const how = draft ? t('Запуск черновика идёт по тому, что сейчас на схеме; «Применить» проверит flow.') : t('Пока не сохранишь, запуск идёт по старой версии.');
  const text = [ai ? rowsSummary(rows) : '', after, how].filter(Boolean).join(' ');

  return (
    <section className={styles.unsaved} aria-label={title}>
      <div className={styles.unsavedText}>
        <b>{title}</b>
        <span>{text}</span>
        {st.bMsg.text && <pre className={msgClass(st.bMsg)}>{st.bMsg.text}</pre>}
      </div>
      {ai && (
        <button
          type="button"
          className="btn"
          // пока идёт следующая правка, её база — эта правка: отмена сейчас вернулась бы с её результатом
          disabled={Boolean(st.aiAbort)}
          title={st.aiAbort ? t('Дождись конца идущей правки или прерви её') : t('Вернуть схему, какой она была до правки ИИ')}
          onClick={() => void undo()}
        >
          {t('Отменить правку')}
        </button>
      )}
      <button
        type="button"
        className="btn primary"
        title={draft ? t('Проверить и применить к черновику; в flows/ ничего не пишется') : t('Записать flow в flows/')}
        onClick={() => void save()}
      >
        {draft ? t('Применить') : t('Сохранить')}
      </button>
    </section>
  );
}
