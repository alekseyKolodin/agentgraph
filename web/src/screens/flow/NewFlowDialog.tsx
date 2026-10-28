// Диалог «Новый flow» (ui/app.js openNewDialog, toggleNewMode, createFlow): сгенерировать из описания, собрать руками
// (две заготовки этапов) или разовый запуск — черновик, который в flows/ не сохраняется. Генерация видна по ходу
// (AiProgress): модель, шаг, таймер. Диалог скрыли, а вкладка открыта — генерация идёт дальше, по готовности — тост.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { FlowAiDone } from '@server/api-types';
import { blankFlow, errorText, generateFlow, keys, useConfig, useFeature, type FlowGenerated } from '../../api';
import { AiModelSelect, AiProgress, aiModel, noteAiModel } from '../../components/AiProgress';
import { useConfirm } from '../../components/ConfirmDialog';
import { PickDirButton } from '../../components/PickDirButton';
import { useToast } from '../../components/Toast';
import { aiFacts, aiProgressStep, startProgress, type AiProgress as Progress } from '../../lib/flow/ai-progress';
import { t } from '../../lib/i18n';
import { LS } from '../../lib/storage';
import { useOpenDraft, useOpenFlow } from './nav';
import { flowState, msgClass, NO_MSG, set, type Msg } from './store';

type Mode = 'generate' | 'blank' | 'once';

export function NewFlowDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const defaultCwd = useConfig().data?.defaultCwd ?? '';
  const adhoc = useFeature('adhoc-runs');
  const qc = useQueryClient();
  const openFlow = useOpenFlow();
  const openDraft = useOpenDraft();
  const toast = useToast();
  const { askConfirm } = useConfirm();
  const [mode, setMode] = useState<Mode>('generate');
  const [folder, setFolder] = useState('');
  const [task, setTask] = useState('');
  const [cwd, setCwd] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<Msg>(NO_MSG);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  // генерация идёт и после закрытия диалога (Esc, «Скрыть»): повторное открытие показывает её ход, вторую платную параллельно не запустить
  const inflight = useRef<AbortController | null>(null);
  // открыт ли диалог сейчас: генерация, закончившись при скрытом диалоге, не уводит с экрана, а показывает тост
  const shown = () => Boolean(dlg.current?.open);
  // готовое при скрытом диалоге: тост пропадает через 10 секунд, а оплаченный результат (черновик живёт только здесь) — нет
  const [ready, setReady] = useState<{ r: FlowGenerated & FlowAiDone; draft: boolean } | null>(null);
  // скрытая генерация упала: при следующем открытии форма та же, с ошибкой, текст задачи не пропадает
  const keepForm = useRef(false);

  // каждое открытие — форма с нуля, директория — последняя директория проекта; идёт генерация, готов результат или
  // была ошибка — форма та, с которой генерацию начали
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) {
      const keep = keepForm.current;
      keepForm.current = false;
      if (!inflight.current && !ready && !keep) {
        setMode('generate');
        setFolder('');
        setTask('');
        setName('');
        setCwd(LS.raw('agentgraph.cwd') || defaultCwd);
        setMsg(NO_MSG);
      }
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  /** Генерация потоком: ход — в AiProgress; модель — выбранная в диалоге. */
  const generate = async (body: { task: string; cwd: string; folder?: string; save?: false }, ctl: AbortController) => {
    const model = aiModel();
    setProgress(startProgress('generate', Date.now()));
    return generateFlow({ ...body, model }, (e) => {
      if (e.type === 'progress' && e.model) noteAiModel(model, e.model);
      setProgress((p) => (p ? aiProgressStep(p, e, Date.now()) : p));
    }, ctl.signal);
  };

  /** Открыть сгенерированное в конструкторе и сказать под панелью ИИ, какая модель, сколько шло и почём. */
  const openGenerated = async (r: FlowGenerated & FlowAiDone, draft: boolean) => {
    // openFlow сам спрашивает про идущую правку ИИ, openDraft — нет: черновик молча оборвал бы оплаченную правку
    if (draft && flowState.aiAbort && !(await askConfirm(t('ИИ ещё правит flow. Прервать правку и перейти?'), { ok: t('Прервать') }))) return;
    const opened = draft ? await openDraft(r) : await openFlow(r.name, 'builder');
    if (!opened) return;
    setReady((x) => (x?.r === r ? null : x));
    set({ aiMsg: { text: t('Flow сгенерирован: {facts}', { facts: aiFacts(r.model, r.durationMs, r.costUsd) }), tone: '' } });
  };

  /** Готово при скрытом диалоге: тост, а результат ждёт в диалоге до открытия. */
  const readyHidden = (r: FlowGenerated & FlowAiDone, draft: boolean) => {
    setReady({ r, draft });
    toast(draft ? t('Черновик {name} готов — открыть', { name: r.name }) : t('Flow {name} готов — открыть', { name: r.name }), () => void openGenerated(r, draft));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (inflight.current) return;
    const ctl = new AbortController();
    inflight.current = ctl;
    setBusy(true);
    setMsg(NO_MSG);
    setReady(null);
    try {
      if (mode === 'once') {
        if (!task.trim()) throw new Error(t('Опиши задачу'));
        LS.setRaw('agentgraph.cwd', cwd.trim());
        const r = await generate({ task: task.trim(), cwd: cwd.trim(), save: false }, ctl);
        if (!shown()) return readyHidden(r, true);
        onClose();
        await openGenerated(r, true);
        return;
      }
      let created: FlowGenerated & FlowAiDone | null = null;
      let target: string;
      if (mode === 'generate') {
        if (!task.trim()) throw new Error(t('Опиши задачу'));
        LS.setRaw('agentgraph.cwd', cwd.trim());
        created = await generate({ task: task.trim(), cwd: cwd.trim(), folder: folder.trim() }, ctl);
        target = created.name;
        await qc.invalidateQueries({ queryKey: keys.flows });
        // диалог скрыли, пока шла генерация: flow уже в flows/, но с экрана (и несохранённых правок) не уводим
        if (!shown()) return readyHidden(created, false);
      } else {
        target = name.trim();
        if (!target) throw new Error(t('Укажи имя'));
        await blankFlow(target, folder.trim());
        await qc.invalidateQueries({ queryKey: keys.flows });
      }
      onClose();
      // новый flow открывается без вопроса о прежних несохранённых правках, как в старом UI
      flowState.dirty = false;
      if (created) await openGenerated(created, false);
      else await openFlow(target, 'builder');
    } catch (err) {
      const text = ctl.signal.aborted ? t('Генерация прервана') : errorText(err);
      setMsg({ text, tone: ctl.signal.aborted ? '' : 'err' });
      if (!shown() && !ctl.signal.aborted) {
        keepForm.current = true;
        toast(t('Новый flow не создан: {error}', { error: text }));
      }
    } finally {
      inflight.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  const hint = mode === 'once'
    ? t('Займёт 20–60 секунд и несколько десятков центов (по прайсу API). Черновик откроется в конструкторе: поправь и запусти. Он живёт только в этой вкладке, в flows/ не сохраняется.')
    : t('Займёт 20–60 секунд и несколько десятков центов (по прайсу API). Потом правишь в конструкторе.');

  // кнопка «Новый flow» стоит в шапке секции сайдбара: диалог — в body, чтобы стили сайдбара (.side-head h2) его не задевали
  return createPortal(
    <dialog
      ref={dlg}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form method="dialog" className="form" onSubmit={(e) => void submit(e)}>
        <h2>{t('Новый flow')}</h2>
        <div className="row radios">
          <label><input type="radio" name="mode" value="generate" checked={mode === 'generate'} onChange={() => setMode('generate')} /> {t('Сгенерировать из описания')}</label>
          <label><input type="radio" name="mode" value="blank" checked={mode === 'blank'} onChange={() => setMode('blank')} /> {t('Собрать руками')}</label>
          {adhoc && (
            <label title={t('Flow сгенерируется черновиком: поправишь и запустишь, в flows/ он не сохранится')}>
              <input type="radio" name="mode" value="once" checked={mode === 'once'} onChange={() => setMode('once')} /> {t('Разовый запуск (не сохранять flow)')}
            </label>
          )}
        </div>
        {/* разовый запуск в flows/ не пишется: папка ему не нужна */}
        {mode !== 'once' && (
          <label>
            <span>{t('Папка')}</span>
            <input name="folder" list="folder-options" placeholder={t('без папки (выбери или впиши новую)')} autoComplete="off" spellCheck={false} value={folder} onChange={(e) => setFolder(e.target.value)} />
          </label>
        )}
        {mode !== 'blank' && (
          <div>
            <label>
              <span>{t('Для какой задачи flow')}</span>
              <textarea name="task" rows={5} placeholder={t('Например: чинить падающие тесты, не трогая сами тесты')} value={task} onChange={(e) => setTask(e.target.value)} />
            </label>
            <label>
              <span>{t('Директория проекта')}</span>
              <div className="path-field">
                <input name="cwd" placeholder={t('/path/to/repo — генератор посмотрит её верхний уровень')} value={cwd} onChange={(e) => setCwd(e.target.value)} />
                <PickDirButton prompt={t('Выбери директорию проекта')} start={() => cwd} onPick={setCwd} />
              </div>
            </label>
            <label>
              <span>{t('Модель')}</span>
              <AiModelSelect className="" disabled={busy} />
            </label>
            <p className="muted small">{hint}</p>
          </div>
        )}
        {mode === 'blank' && (
          <div>
            <label>
              <span>{t('Имя')}</span>
              <input name="name" pattern="[a-z0-9\-]+" placeholder={t('my-flow, латиница, цифры, дефис')} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="muted small">{t('Откроется конструктор с двумя этапами-заготовками.')}</p>
          </div>
        )}
        {progress && <AiProgress progress={progress} onAbort={() => inflight.current?.abort()} />}
        {ready && (
          <div className="row">
            <span className="msg ok">{ready.draft ? t('Черновик {name} готов', { name: ready.r.name }) : t('Flow {name} готов', { name: ready.r.name })}</span>
            <button type="button" className="btn" onClick={() => {
              // как из тоста: несохранённые правки открытого flow не сбрасываем молча — openFlow спросит
              const { r, draft } = ready;
              onClose();
              void openGenerated(r, draft);
            }}>{t('Открыть')}</button>
          </div>
        )}
        <div className="row">
          <button type="submit" className="btn primary" disabled={busy}>{mode === 'once' ? t('Сгенерировать') : t('Создать')}</button>
          {progress
            ? <button type="button" className="btn ghost" title={t('Генерация продолжится в этой вкладке; когда flow будет готов, внизу справа появится уведомление')} onClick={onClose}>{t('Скрыть')}</button>
            : <button type="button" className="btn ghost" onClick={onClose}>{t('Отмена')}</button>}
          <span className={msgClass(msg)}>{msg.text}</span>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
