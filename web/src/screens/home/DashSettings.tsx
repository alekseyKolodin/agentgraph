// Диалог «Подключения» с главной (ui/dash.js openDashSettings): Jira Cloud (адрес, email, токен — токен только на запись)
// и проекты для MR и веток: имя, базовая ветка, файлы для worktree, добавить и убрать.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { IntegrationsInfo, ProjectInfo } from '@server/api-types';
import { api, errorText, keys } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import { PickDirButton } from '../../components/PickDirButton';
import { useIntegrations } from './Dash';
import styles from './Dash.module.css';

type Msg = { text: string; tone: '' | 'ok' | 'err' };
const msgClass = (m: Msg) => `msg${m.tone ? ` ${m.tone}` : ''}`;

const EMPTY: IntegrationsInfo = { jira: null, presets: {}, projects: [], worktreesDir: '', glab: true, gh: true };

export function DashSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const dlg = useRef<HTMLDialogElement>(null);
  const info = useIntegrations().data ?? EMPTY;
  // форма Jira перечитывается после каждого обновления данных: токен стирается, подсказка в поле — по факту
  const [version, setVersion] = useState(0);
  const jiraDefault = (i: IntegrationsInfo): Msg => (i.jira?.hasToken ? { text: 'подключено', tone: 'ok' } : { text: '', tone: '' });
  const [jiraMsg, setJiraMsg] = useState<Msg>(() => jiraDefault(info));
  const [projMsg, setProjMsg] = useState<Msg>({ text: '', tone: '' });
  const addInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) {
      setVersion((v) => v + 1);
      setJiraMsg(jiraDefault(info));
      d.showModal();
    }
    if (!open && d.open) d.close();
    // при открытии — по текущим данным; дальше их обновляет reloadInfo
  }, [open]);

  /** Данные изменились: перечитать /api/integrations — главная и диалог перерисуются; новые проекты загрузятся сами. */
  const reloadInfo = async (): Promise<IntegrationsInfo> => {
    const fresh = await qc.fetchQuery({ queryKey: keys.integrations, queryFn: () => api<IntegrationsInfo>('GET', '/api/integrations'), staleTime: 0 });
    setVersion((v) => v + 1);
    setJiraMsg(jiraDefault(fresh));
    return fresh;
  };

  const saveJira = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = e.currentTarget.elements as unknown as Record<'baseUrl' | 'email' | 'token', HTMLInputElement>;
    setJiraMsg({ text: 'Проверяю…', tone: '' });
    try {
      const r = await api<{ user: string }>('PUT', '/api/integrations/jira', { baseUrl: f.baseUrl.value, email: f.email.value, token: f.token.value || undefined });
      await reloadInfo();
      setJiraMsg({ text: `подключено как ${r.user}`, tone: 'ok' });
      void qc.resetQueries({ queryKey: ['jira'] });
    } catch (err) {
      setJiraMsg({ text: errorText(err), tone: 'err' });
    }
  };

  const disconnectJira = async () => {
    await api('DELETE', '/api/integrations/jira');
    qc.removeQueries({ queryKey: ['jira'] });
    await reloadInfo();
  };

  const addProject = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = addInput.current!;
    try {
      await api('POST', '/api/projects', { path: input.value });
      input.value = '';
      setProjMsg({ text: '', tone: '' });
      await reloadInfo();
    } catch (err) {
      setProjMsg({ text: errorText(err), tone: 'err' });
    }
  };

  return (
    <dialog
      ref={dlg}
      className={styles.dlgDash}
      onClose={onClose}
    >
      <header className="dlg-head">
        <h2>Подключения</h2>
        <button className="btn ghost" onClick={onClose}>Закрыть</button>
      </header>
      <form key={`jira:${version}`} className="form" onSubmit={saveJira}>
        <h3>Jira Cloud</h3>
        <div className="row">
          <label><span>Адрес</span><input name="baseUrl" defaultValue={info.jira?.baseUrl || ''} placeholder="https://company.atlassian.net" autoComplete="off" /></label>
          <label><span>Email аккаунта Atlassian</span><input name="email" type="email" defaultValue={info.jira?.email || ''} autoComplete="off" /></label>
        </div>
        <label>
          <span>API-токен (<a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener">создать</a>)</span>
          <input name="token" type="password" autoComplete="new-password" placeholder={info.jira?.hasToken ? 'сохранён; впиши новый, чтобы заменить' : ''} />
        </label>
        <p className="muted small">Хранится в <code>~/.agentgraph/jira-token</code>, обратно в браузер не отдаётся</p>
        <div className="row">
          <button type="submit" className="btn primary">Проверить и сохранить</button>
          {info.jira && <button type="button" className="btn danger" onClick={() => void disconnectJira()}>Отключить</button>}
          <span className={msgClass(jiraMsg)}>{jiraMsg.text}</span>
        </div>
      </form>
      <div className="form">
        <h3 title="Подхватываются из директорий проектов запусков">Проекты <span className="muted small">· MR через <code>glab</code>, PR через <code>gh</code></span></h3>
        {info.glab === false && info.projects.some((p) => p.forge === 'gitlab') && <p className="msg err">glab не найден: MR не загрузятся. Установи glab и выполни <code>glab auth login</code>.</p>}
        {info.gh === false && info.projects.some((p) => p.forge === 'github') && <p className="msg err">gh не найден: PR не загрузятся. Установи gh и выполни <code>gh auth login</code>.</p>}
        <div className={styles.projList}>
          {info.projects.length ? (
            info.projects.map((p) => <ProjectItem key={`${p.path}:${version}`} p={p} onChanged={reloadInfo} />)
          ) : (
            <p className="muted small">Пока нет.</p>
          )}
        </div>
        <form className={`row ${styles.projAdd}`} onSubmit={addProject}>
          <input ref={addInput} name="path" placeholder="/путь/к/репозиторию" autoComplete="off" spellCheck={false} />
          <PickDirButton start={() => addInput.current?.value ?? ''} onPick={(path) => { addInput.current!.value = path; addInput.current!.focus(); }} prompt="Выбери директорию проекта" className="btn small pick-dir" />
          <button type="submit" className="btn small">Добавить</button>
          <span className={msgClass(projMsg)}>{projMsg.text}</span>
        </form>
        <p className="muted small">Worktree создаются в <code>{info.worktreesDir || ''}</code>.</p>
      </div>
    </dialog>
  );
}

function ProjectItem({ p, onChanged }: { p: ProjectInfo; onChanged: () => Promise<unknown> }) {
  const { askConfirm } = useConfirm();
  const [msg, setMsg] = useState<Msg>({ text: '', tone: '' });
  const form = useRef<HTMLFormElement>(null);
  const field = (name: string) => (form.current!.elements.namedItem(name) as HTMLInputElement).value;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/projects', { path: p.path, name: field('name'), base: field('base'), copyFiles: field('copyFiles') });
      setMsg({ text: 'сохранено', tone: 'ok' });
      await onChanged();
    } catch (err) {
      setMsg({ text: errorText(err), tone: 'err' });
    }
  };
  const remove = async () => {
    if (!(await askConfirm(`Убрать проект ${field('name')} с главной? Репозиторий не трогается; автоподхват его больше не вернёт, добавить можно руками.`, { ok: 'Убрать' }))) return;
    await api('DELETE', '/api/projects', { path: p.path });
    await onChanged();
  };

  return (
    <form ref={form} className={styles.projItem} onSubmit={save}>
      <div className="row">
        <b>{p.name}</b>
        <span className="muted small mono">{p.path}</span>
        {p.remote ? <span className="muted small">{`${p.remote.host}/${p.remote.path}`}</span> : <span className="small warn">нет origin на GitLab или GitHub</span>}
      </div>
      <div className="row">
        <label><span>Имя</span><input name="name" defaultValue={p.name} /></label>
        <label><span>Базовая ветка для новых</span><input name="base" defaultValue={p.base || ''} placeholder="origin/HEAD" /></label>
        <label><span>Копировать в worktree (через запятую)</span><input name="copyFiles" defaultValue={(p.copyFiles || []).join(', ')} placeholder="local.properties" /></label>
      </div>
      <div className="row">
        <button className="btn small">Сохранить</button>
        <button type="button" className="btn small danger" onClick={() => void remove()}>Убрать</button>
        <span className={msgClass(msg)}>{msg.text}</span>
      </div>
    </form>
  );
}
