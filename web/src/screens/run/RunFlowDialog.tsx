// «Править flow запуска» на паузе: снимок runs/<id>/flow.yaml в YamlEditor, применение — в тот же запуск (PUT /api/runs/:id/flow).
// В flows/<имя>.yaml правка попадает только с галочкой. Несовместимая правка (пройденные блоки, артефакты, имя) — список причин,
// запуск при этом идёт по-старому. Граф перечитает снимок сам — по событию flow.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, errorText, fetchRunFile } from '../../api';
import { applyRunFlow } from '../../api/run';
import { useToast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import type { RunView } from '../../lib/run/events';
import { YamlEditor, type YamlEditorHandle } from '../flow/YamlEditor';
import styles from './RunFlowDialog.module.css';

export default function RunFlowDialog({ r, onClose }: { r: RunView; onClose: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const editor = useRef<YamlEditorHandle>(null);
  const toast = useToast();
  const [yaml, setYaml] = useState<string | null>(null);
  // сколько правок было у прочитанного снимка: чужая правка после чтения — отказ stale, а не тихий откат
  const [base, setBase] = useState(0);
  const [seq, setSeq] = useState(0);
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; problems: string[] }>({ text: '', problems: [] });

  useEffect(() => {
    dlg.current!.showModal();
    // снимок мог смениться прошлой правкой: читаем мимо кэша
    const version = r.flowEdits?.length ?? 0;
    fetchRunFile(r.id, 'flow.yaml', true)
      .then((res) => {
        if (!res.ok) throw new Error(res.text);
        setBase(version);
        setYaml(res.text);
        setSeq((n) => n + 1);
      })
      .catch((e) => setErr({ text: errorText(e), problems: [] }));
  }, [r.id]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const text = editor.current?.value() ?? '';
    setBusy(true);
    setErr({ text: '', problems: [] });
    try {
      const { edit } = await applyRunFlow(r.id, text, save, base);
      onClose();
      const done = edit.changed.length
        ? t('Flow запуска поправлен: {list}', { list: edit.changed.join('; ') })
        : edit.savedToFlows ? t('Запуск уже идёт по этой версии; в flows/ сохранено') : t('Изменений нет: запуск идёт по этой версии');
      // правка запуска действует, а в flows/ записать не вышло — это сообщение сервера
      toast(edit.saveError ? `${done}. ${edit.saveError}` : done);
    } catch (e) {
      const problems = e instanceof ApiError && e.code === 'incompatible' ? ((e.data as { problems?: string[] } | null)?.problems ?? []) : [];
      setErr({ text: problems.length ? t('Правка не подходит идущему запуску — он пойдёт по-старому:') : errorText(e), problems });
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dlg} className={styles.dlg} onClose={onClose}>
      <form method="dialog" className="form" onSubmit={(e) => void submit(e)}>
        <h2>{t('Править flow запуска')}</h2>
        <p className="muted small">
          {t('Правка действует только в этом запуске: следующие шаги пойдут по ней. Пройденные блоки, имя, задачу и объявления артефактов менять нельзя.')}
        </p>
        {yaml === null
          ? <p className="muted small">{err.text ? '' : t('Загружаю снимок…')}</p>
          : <YamlEditor ref={editor} value={yaml} seq={seq} className={styles.editor} />}
        {!r.adhoc && (
          <label className={styles.save}>
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
            {t('Сохранить и в flows/{name}.yaml', { name: r.flow })}
          </label>
        )}
        {err.text && <p className="msg err" role="alert">{err.text}</p>}
        {err.problems.length > 0 && (
          <ul className={styles.problems}>
            {err.problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        )}
        <div className="row">
          <button type="submit" className="btn primary" disabled={busy || yaml === null}>{t('Применить к запуску')}</button>
          <button type="button" className="btn ghost" onClick={onClose}>{t('Отмена')}</button>
        </div>
      </form>
    </dialog>
  );
}
