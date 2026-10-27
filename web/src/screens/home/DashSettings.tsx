// Диалог «Подключения» с главной: список подключённого (Jira Cloud, репозитории для MR и веток) и «Добавить» —
// выбор типа из списка и форма только этого типа. Каждое подключение открывается и правится по отдельности.
// Токен Jira — только на запись: хранится на сервере, в браузер не отдаётся.
// Новый тип подключения — элемент в TYPES, его строки в rows() и формы в Body.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { IntegrationsInfo, ProjectInfo } from '@server/api-types';
import { api, errorText, keys } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import { PathLink } from '../../components/PathLink';
import { PickDirButton } from '../../components/PickDirButton';
import { t } from '../../lib/i18n';
import { useIntegrations } from './Dash';
import styles from './Dash.module.css';

type Msg = { text: string; tone: '' | 'ok' | 'err' };
const msgClass = (m: Msg) => `msg${m.tone ? ` ${m.tone}` : ''}`;
const NO_MSG: Msg = { text: '', tone: '' };

const EMPTY: IntegrationsInfo = { jira: null, presets: {}, projects: [], worktreesDir: '', glab: true, gh: true };

type TypeId = 'jira' | 'repo';

/** Типы подключений в «Добавить». */
const TYPES: { id: TypeId; title: string; sub: string }[] = [
  { id: 'jira', title: 'Jira Cloud', sub: t('Задачи на главной и запуск flow по задаче') },
  { id: 'repo', title: t('Git-репозиторий'), sub: t('MR через glab (GitLab), PR через gh (GitHub) и ветки проекта') },
];

type View = { at: 'list' } | { at: 'pick' } | { at: 'add'; type: TypeId } | { at: 'jira' } | { at: 'repo'; path: string };

type Row = { key: string; type: TypeId; title: string; sub: string; status: Msg; open: View };

function rows(info: IntegrationsInfo): Row[] {
  const out: Row[] = [];
  if (info.jira) {
    out.push({
      key: 'jira',
      type: 'jira',
      title: 'Jira Cloud',
      sub: [info.jira.baseUrl, info.jira.email].filter(Boolean).join(' · '),
      status: info.jira.hasToken ? { text: t('подключено'), tone: 'ok' } : { text: t('нет токена'), tone: 'err' },
      open: { at: 'jira' },
    });
  }
  for (const p of info.projects) {
    const cli = p.forge === 'gitlab' ? (info.glab ? '' : t('нет glab')) : p.forge === 'github' ? (info.gh ? '' : t('нет gh')) : t('нет origin');
    out.push({
      key: `repo:${p.path}`,
      type: 'repo',
      title: p.name,
      sub: p.remote ? `${p.remote.host}/${p.remote.path}` : p.path,
      status: cli ? { text: cli, tone: 'err' } : NO_MSG,
      open: { at: 'repo', path: p.path },
    });
  }
  return out;
}

const typeTitle = (id: TypeId) => TYPES.find((x) => x.id === id)!.title;

export function DashSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const dlg = useRef<HTMLDialogElement>(null);
  const info = useIntegrations().data ?? EMPTY;
  const [view, setView] = useState<View>({ at: 'list' });

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) {
      setView({ at: 'list' });
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  /** Данные изменились: перечитать /api/integrations — главная и диалог перерисуются; новые проекты загрузятся сами. */
  const reloadInfo = async (): Promise<IntegrationsInfo> =>
    qc.fetchQuery({ queryKey: keys.integrations, queryFn: () => api<IntegrationsInfo>('GET', '/api/integrations'), staleTime: 0 });

  const back = () => setView({ at: 'list' });
  const project = view.at === 'repo' ? info.projects.find((p) => p.path === view.path) : undefined;

  let title = t('Подключения');
  if (view.at === 'pick') title = t('Новое подключение');
  else if (view.at === 'add') title = typeTitle(view.type);
  else if (view.at === 'jira') title = 'Jira Cloud';
  else if (view.at === 'repo') title = project?.name ?? t('Репозиторий');

  return (
    <dialog ref={dlg} className={styles.dlgDash} onClose={onClose}>
      <header className="dlg-head">
        <div className={styles.connHead}>
          {view.at !== 'list' && (
            <button className="btn ghost small" onClick={() => setView(view.at === 'add' ? { at: 'pick' } : { at: 'list' })} title={t('Назад')}>←</button>
          )}
          <h2>{title}</h2>
        </div>
        <button className="btn ghost" onClick={onClose}>{t('Закрыть')}</button>
      </header>

      {view.at === 'list' && <ConnList info={info} onOpen={setView} onAdd={() => setView({ at: 'pick' })} />}

      {view.at === 'pick' && (
        <ul className={styles.connList}>
          {TYPES.map((ty) => {
            // Jira одна: уже подключённая открывается на правку
            const taken = ty.id === 'jira' && !!info.jira;
            return (
              <li key={ty.id}>
                <button className={styles.connRow} onClick={() => setView(taken ? { at: 'jira' } : { at: 'add', type: ty.id })}>
                  <span className={styles.connMain}>
                    <b>{ty.title}</b>
                    <span className="muted small">{ty.sub}</span>
                  </span>
                  <span className="muted small">{taken ? t('уже подключена — открыть') : '→'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {((view.at === 'add' && view.type === 'jira') || view.at === 'jira') && (
        <JiraForm info={info} reloadInfo={reloadInfo} onDisconnected={back} />
      )}

      {view.at === 'add' && view.type === 'repo' && (
        <RepoAdd
          reloadInfo={reloadInfo}
          onAdded={(fresh, path) => {
            // сервер хранит путь по-своему (корень репозитория): открыть добавленный — тот, которого не было
            const added = fresh.projects.find((p) => p.path === path) ?? fresh.projects.find((p) => !info.projects.some((o) => o.path === p.path));
            setView(added ? { at: 'repo', path: added.path } : { at: 'list' });
          }}
        />
      )}

      {view.at === 'repo' && (project ? (
        <ProjectForm key={project.path} p={project} info={info} onChanged={reloadInfo} onRemoved={back} />
      ) : (
        <p className="muted small">{t('Репозитория уже нет в списке.')}</p>
      ))}
    </dialog>
  );
}

function ConnList({ info, onOpen, onAdd }: { info: IntegrationsInfo; onOpen: (v: View) => void; onAdd: () => void }) {
  const list = rows(info);
  return (
    <div className="form">
      {list.length ? (
        <ul className={styles.connList}>
          {list.map((r) => (
            <li key={r.key}>
              <button className={styles.connRow} onClick={() => onOpen(r.open)}>
                <span className={styles.connType}>{r.type === 'jira' ? 'Jira' : 'Git'}</span>
                <span className={styles.connMain}>
                  <b>{r.title}</b>
                  <span className="muted small mono">{r.sub}</span>
                </span>
                {r.status.text && <span className={`small ${r.status.tone}`}>{r.status.text}</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{t('Пока ничего не подключено. Репозитории подхватываются из директорий проектов запусков.')}</p>
      )}
      <div className="row">
        <button className="btn primary" onClick={onAdd}>{t('Добавить подключение')}</button>
      </div>
    </div>
  );
}

function JiraForm({ info, reloadInfo, onDisconnected }: { info: IntegrationsInfo; reloadInfo: () => Promise<IntegrationsInfo>; onDisconnected: () => void }) {
  const qc = useQueryClient();
  const { askConfirm } = useConfirm();
  // форма перечитывается после сохранения: токен стирается, подсказка в поле — по факту
  const [version, setVersion] = useState(0);
  const [msg, setMsg] = useState<Msg>(info.jira?.hasToken ? { text: t('подключено'), tone: 'ok' } : NO_MSG);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = e.currentTarget.elements as unknown as Record<'baseUrl' | 'email' | 'token', HTMLInputElement>;
    setMsg({ text: t('Проверяю…'), tone: '' });
    try {
      const r = await api<{ user: string }>('PUT', '/api/integrations/jira', { baseUrl: f.baseUrl.value, email: f.email.value, token: f.token.value || undefined });
      await reloadInfo();
      setVersion((v) => v + 1);
      setMsg({ text: t('подключено как {user}', { user: r.user }), tone: 'ok' });
      void qc.resetQueries({ queryKey: ['jira'] });
    } catch (err) {
      setMsg({ text: errorText(err), tone: 'err' });
    }
  };

  const disconnect = async () => {
    if (!(await askConfirm(t('Отключить Jira? Адрес, email и токен будут удалены.'), { ok: t('Отключить'), danger: true }))) return;
    await api('DELETE', '/api/integrations/jira');
    qc.removeQueries({ queryKey: ['jira'] });
    await reloadInfo();
    onDisconnected();
  };

  return (
    <form key={version} className="form" onSubmit={save}>
      <div className="row">
        <label><span>{t('Адрес')}</span><input name="baseUrl" defaultValue={info.jira?.baseUrl || ''} placeholder="https://company.atlassian.net" autoComplete="off" /></label>
        <label><span>{t('Email аккаунта Atlassian')}</span><input name="email" type="email" defaultValue={info.jira?.email || ''} autoComplete="off" /></label>
      </div>
      <label>
        <span>{t('API-токен')} (<a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener">{t('создать')}</a>)</span>
        <input name="token" type="password" autoComplete="new-password" placeholder={info.jira?.hasToken ? t('сохранён; впиши новый, чтобы заменить') : ''} />
      </label>
      <p className="muted small">{t('Хранится в')} <code>~/.agentgraph/jira-token</code>{t(', обратно в браузер не отдаётся')}</p>
      <div className="row">
        <button type="submit" className="btn primary">{t('Проверить и сохранить')}</button>
        {info.jira && <button type="button" className="btn danger" onClick={() => void disconnect()}>{t('Отключить')}</button>}
        <span className={msgClass(msg)}>{msg.text}</span>
      </div>
    </form>
  );
}

function RepoAdd({ reloadInfo, onAdded }: { reloadInfo: () => Promise<IntegrationsInfo>; onAdded: (fresh: IntegrationsInfo, path: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<Msg>(NO_MSG);

  useEffect(() => input.current?.focus(), []);

  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const path = input.current!.value.trim();
    try {
      await api('POST', '/api/projects', { path });
      onAdded(await reloadInfo(), path);
    } catch (err) {
      setMsg({ text: errorText(err), tone: 'err' });
    }
  };

  return (
    <form className="form" onSubmit={add}>
      <label>
        <span>{t('Путь к репозиторию')}</span>
        <div className={`row ${styles.projAdd}`}>
          <input ref={input} name="path" placeholder={t('/путь/к/репозиторию')} autoComplete="off" spellCheck={false} />
          <PickDirButton start={() => input.current?.value ?? ''} onPick={(path) => { input.current!.value = path; input.current!.focus(); }} prompt={t('Выбери директорию проекта')} className="btn pick-dir" />
        </div>
      </label>
      <p className="muted small">{t('По origin определяется, откуда брать MR: GitLab — через')} <code>glab</code>{t(', GitHub — PR через')} <code>gh</code>.</p>
      <div className="row">
        <button type="submit" className="btn primary">{t('Добавить')}</button>
        <span className={msgClass(msg)}>{msg.text}</span>
      </div>
    </form>
  );
}

function ProjectForm({ p, info, onChanged, onRemoved }: { p: ProjectInfo; info: IntegrationsInfo; onChanged: () => Promise<unknown>; onRemoved: () => void }) {
  const { askConfirm } = useConfirm();
  const [msg, setMsg] = useState<Msg>(NO_MSG);
  const form = useRef<HTMLFormElement>(null);
  const field = (name: string) => (form.current!.elements.namedItem(name) as HTMLInputElement).value;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/projects', { path: p.path, name: field('name'), base: field('base'), copyFiles: field('copyFiles') });
      setMsg({ text: t('сохранено'), tone: 'ok' });
      await onChanged();
    } catch (err) {
      setMsg({ text: errorText(err), tone: 'err' });
    }
  };
  const remove = async () => {
    if (!(await askConfirm(t('Убрать проект {name} с главной? Репозиторий не трогается; автоподхват его больше не вернёт, добавить можно руками.', { name: p.name }), { ok: t('Убрать'), danger: true }))) return;
    await api('DELETE', '/api/projects', { path: p.path });
    await onChanged();
    onRemoved();
  };

  return (
    <form ref={form} className="form" onSubmit={save}>
      <div className={styles.connFacts}>
        <PathLink className="muted small mono" path={p.path} />
        {p.remote ? <span className="muted small">{`${p.remote.host}/${p.remote.path}`}</span> : <span className="small warn">{t('нет origin на GitLab или GitHub')}</span>}
      </div>
      {info.glab === false && p.forge === 'gitlab' && <p className="msg err">{t('glab не найден: MR не загрузятся. Установи glab и выполни')} <code>glab auth login</code>.</p>}
      {info.gh === false && p.forge === 'github' && <p className="msg err">{t('gh не найден: PR не загрузятся. Установи gh и выполни')} <code>gh auth login</code>.</p>}
      <div className="row">
        <label><span>{t('Имя')}</span><input name="name" defaultValue={p.name} /></label>
        <label><span>{t('Базовая ветка для новых')}</span><input name="base" defaultValue={p.base || ''} placeholder="origin/HEAD" /></label>
      </div>
      <label><span>{t('Копировать в worktree (через запятую)')}</span><input name="copyFiles" defaultValue={(p.copyFiles || []).join(', ')} placeholder="local.properties" /></label>
      <p className="muted small">{t('Worktree создаются в')} <code>{info.worktreesDir ? <PathLink path={info.worktreesDir} /> : ''}</code>.</p>
      <div className="row">
        <button type="submit" className="btn primary">{t('Сохранить')}</button>
        <button type="button" className="btn danger" onClick={() => void remove()}>{t('Убрать')}</button>
        <span className={msgClass(msg)}>{msg.text}</span>
      </div>
    </form>
  );
}
