// «Сохранить как flow» у разового запуска (ui/app.js openSaveFlowDialog, saveRunFlow, #dlg-save-flow): снимок его flow — в flows/,
// затем открываем сохранённый flow. Сам запуск остаётся разовым.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { errorText, keys, saveRunFlow } from '../../api';
import { setOpen } from '../../components/shell/fold';
import { useOpenFlow } from '../flow/nav';

export function SaveFlowDialog({ runId, flow, open, onClose }: { runId: string; flow: string; open: boolean; onClose: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();
  const openFlow = useOpenFlow();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = dlg.current!;
    if (open && !d.open) {
      setName('');
      setFolder('');
      setMsg('');
      setBusy(false);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    try {
      const res = await saveRunFlow(runId, { name: name.trim() || undefined, folder: folder.trim() });
      onClose();
      if (res.folder) setOpen('folder:' + res.folder, true);
      await qc.invalidateQueries({ queryKey: keys.flows });
      await openFlow(res.name);
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dlg} onClose={(e) => !e.currentTarget.open && onClose()}>
      <form method="dialog" className="form" onSubmit={(e) => void submit(e)}>
        <h2>Сохранить как flow</h2>
        <p className="muted small">Flow этого разового запуска ляжет в flows/, и его можно будет запускать снова. Сам запуск останется разовым.</p>
        <label>
          <span>Имя</span>
          <input name="name" pattern="[a-z0-9\-]+" placeholder={`пусто — ${flow} или ${flow}-2, если занято`} autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>Папка</span>
          <input name="folder" list="folder-options" placeholder="без папки (выбери или впиши новую)" autoComplete="off" spellCheck={false} value={folder} onChange={(e) => setFolder(e.target.value)} />
        </label>
        <div className="row">
          <button type="submit" className="btn primary" disabled={busy}>Сохранить</button>
          <button type="button" className="btn ghost" onClick={onClose}>Отмена</button>
          <span className={`msg${msg ? ' err' : ''}`}>{msg}</span>
        </div>
      </form>
    </dialog>
  );
}
