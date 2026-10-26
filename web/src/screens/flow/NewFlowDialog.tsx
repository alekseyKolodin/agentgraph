// Диалог «Новый flow» (ui/app.js openNewDialog, toggleNewMode, createFlow): сгенерировать из описания, собрать руками
// (две заготовки этапов) или разовый запуск — черновик, который в flows/ не сохраняется.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { blankFlow, errorText, generateFlow, keys, useConfig, useFeature } from '../../api';
import { PickDirButton } from '../../components/PickDirButton';
import { t } from '../../lib/i18n';
import { LS } from '../../lib/storage';
import { useOpenDraft, useOpenFlow } from './nav';
import { flowState, msgClass, NO_MSG, type Msg } from './store';

type Mode = 'generate' | 'blank' | 'once';

export function NewFlowDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const defaultCwd = useConfig().data?.defaultCwd ?? '';
  const adhoc = useFeature('adhoc-runs');
  const qc = useQueryClient();
  const openFlow = useOpenFlow();
  const openDraft = useOpenDraft();
  const [mode, setMode] = useState<Mode>('generate');
  const [folder, setFolder] = useState('');
  const [task, setTask] = useState('');
  const [cwd, setCwd] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<Msg>(NO_MSG);
  const [busy, setBusy] = useState(false);
  // генерация идёт и после закрытия диалога (Esc): повторное открытие не даёт запустить вторую платную параллельно
  const inflight = useRef(false);

  // каждое открытие — форма с нуля, директория — последняя директория проекта
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) {
      setMode('generate');
      setFolder('');
      setTask('');
      setName('');
      setCwd(LS.raw('agentgraph.cwd') || defaultCwd);
      setMsg(inflight.current ? { text: t('Прошлая генерация ещё идёт'), tone: '' } : NO_MSG);
      setBusy(inflight.current);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setMsg(NO_MSG);
    try {
      if (mode === 'once') {
        if (!task.trim()) throw new Error(t('Опиши задачу'));
        LS.setRaw('agentgraph.cwd', cwd.trim());
        setMsg({ text: t('Генерирую черновик… обычно 20–60 секунд'), tone: '' });
        const r = await generateFlow({ task: task.trim(), cwd: cwd.trim(), save: false });
        onClose();
        await openDraft(r);
        return;
      }
      let created: string;
      if (mode === 'generate') {
        if (!task.trim()) throw new Error(t('Опиши задачу'));
        LS.setRaw('agentgraph.cwd', cwd.trim());
        setMsg({ text: t('Генерирую… обычно 20–60 секунд'), tone: '' });
        created = (await generateFlow({ task: task.trim(), cwd: cwd.trim(), folder: folder.trim() })).name;
      } else {
        created = name.trim();
        if (!created) throw new Error(t('Укажи имя'));
        await blankFlow(created, folder.trim());
      }
      onClose();
      // новый flow открывается без вопроса о прежних несохранённых правках, как в старом UI
      flowState.dirty = false;
      await qc.invalidateQueries({ queryKey: keys.flows });
      await openFlow(created, 'builder');
    } catch (err) {
      setMsg({ text: errorText(err), tone: 'err' });
    } finally {
      inflight.current = false;
      setBusy(false);
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
        <div className="row">
          <button type="submit" className="btn primary" disabled={busy}>{mode === 'once' ? t('Сгенерировать') : t('Создать')}</button>
          <button type="button" className="btn ghost" onClick={onClose}>{t('Отмена')}</button>
          <span className={msgClass(msg)}>{msg.text}</span>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
