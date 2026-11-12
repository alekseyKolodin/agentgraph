// Репо кода из моих папок (spec §5.3): выбор среди моих проектов — тот же список, что «Задачи и код» на главной
// (GET /api/integrations), «Другая папка…» (системный диалог или путь руками) и «Ввести ссылку». Папка читается сервером
// (POST …/repo-info): ссылка — origin, ветка — origin/HEAD; они уходят в project.yaml, а сама папка — только в мой local.json
// (repos[].local). Ничего не скачивается: у коллег agentgraph находит их папку этого репо по origin. Строка формы — RepoDraftRow,
// подсказка для ненайденного репо — CloneHint.
import { useState, type KeyboardEvent } from 'react';
import type { TeamRepoInfo } from '@server/api-types';
import { errorText, useConfig, useFeature } from '../../api';
import { fetchRepoInfo } from '../../api/teamwork';
import { PickDirButton } from '../../components/PickDirButton';
import { useToast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { tildePath } from '../../lib/paths';
import { cloneCommand, draftFromInfo, draftState, typedDraft, type DraftState, type RepoDraft } from '../../lib/teamwork/repos';
import { useIntegrations } from '../home/Dash';
import { cx } from './parts';
import styles from './Teamwork.module.css';

/** Что уже есть в проекте и в форме: такие папки и ссылки второй раз не добавляются, ключи не повторяются. */
export type RepoTaken = { paths: ReadonlySet<string>; urls: ReadonlySet<string>; keys: readonly string[] };

/**
 * Выбор репо: мои проекты (имя, папка, origin; без origin — с пометкой), «Другая папка…», «Ввести ссылку». Папка без origin
 * не добавляется сама: предупреждение и «Ввести ссылку» (ручная строка с этой папкой).
 */
export function RepoChooser({ team, taken, onAdd, onClose }: { team: string; taken: RepoTaken; onAdd: (d: RepoDraft) => void; onClose: () => void }) {
  const home = useConfig().data?.home;
  const canPick = useFeature('pick-dir');
  const info = useIntegrations();
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [noOrigin, setNoOrigin] = useState<TeamRepoInfo | undefined>();
  const [typedPath, setTypedPath] = useState('');
  const choose = async (path: string) => {
    setBusy(path);
    setErr('');
    setNoOrigin(undefined);
    try {
      const r = await fetchRepoInfo(team, path);
      if (r.problem === 'not_git') setErr(t('{path} — не git-репозиторий', { path: tildePath(r.path, home) }));
      else if (taken.paths.has(r.path) || (r.url && taken.urls.has(r.url))) setErr(t('Это репо уже есть в проекте'));
      else if (r.problem) setNoOrigin(r);
      else onAdd(draftFromInfo(r, taken.keys));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy('');
    }
  };
  const projects = info.data?.projects ?? [];
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  return (
    <div className={styles.chooser} role="group" aria-label={t('Выбор репо кода')} onKeyDown={onKey}>
      <span className={styles.cap} style={{ margin: 0 }}>{t('Мои проекты на этом компьютере')}</span>
      {info.isError && <p className="msg err">{errorText(info.error)}</p>}
      {info.isPending && <span className={styles.note}>{t('Загружаю проекты…')}</span>}
      {info.data && projects.length === 0 && <span className={styles.note}>{t('Проектов на главной пока нет — выберите папку репо.')}</span>}
      {projects.length > 0 && (
        <ul className={styles.chooserList}>
          {projects.map((p, i) => {
            const isTaken = taken.paths.has(p.path);
            return (
              <li key={p.path}>
                <button
                  type="button"
                  autoFocus={i === 0}
                  disabled={isTaken || busy !== ''}
                  aria-busy={busy === p.path || undefined}
                  title={isTaken ? t('Уже в проекте') : p.remote ? t('Добавить: ссылка и ветка — из git этой папки') : t('У папки нет origin: ссылку придётся ввести')}
                  onClick={() => void choose(p.path)}
                >
                  <b>{p.name}</b>
                  <span className={styles.meta}>{tildePath(p.path, home)}</span>
                  <span className={cx(styles.origin, !p.remote && styles.none)}>
                    {isTaken ? t('уже в проекте') : busy === p.path ? t('читаю git…') : p.remote ? `${p.remote.host}/${p.remote.path}` : t('нет origin')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {noOrigin && (
        <div className={styles.chooserWarn} role="alert">
          <span className={cx(styles.note, styles.warn)}>
            {noOrigin.problem === 'bad_origin'
              ? t('origin папки {path} не годится как ссылка ({url}) — участники не найдут репо автоматически', { path: tildePath(noOrigin.path, home), url: noOrigin.url ?? '' })
              : t('У этой папки нет origin — участники не найдут репо автоматически')}
          </span>
          <button type="button" className="btn small" onClick={() => onAdd(draftFromInfo(noOrigin, taken.keys))}>{t('Ввести ссылку')}</button>
        </div>
      )}
      {err && <p className="msg err" role="alert">{err}</p>}
      {!canPick && (
        <form
          className={styles.repoPick}
          onSubmit={(e) => {
            e.preventDefault();
            if (typedPath.trim()) void choose(typedPath.trim());
          }}
        >
          <input value={typedPath} placeholder={t('/path/to/repo')} spellCheck={false} aria-label={t('Папка репо кода')} onChange={(e) => setTypedPath(e.target.value)} />
          <button type="submit" className="btn small" disabled={busy !== '' || !typedPath.trim()}>{t('Взять папку')}</button>
        </form>
      )}
      <div className={styles.chooserFoot}>
        <PickDirButton className="btn small" prompt={t('Папка репо кода')} title={t('Выбрать папку репо в Finder')} start={() => ''} onPick={(p) => void choose(p)}>{t('Другая папка…')}</PickDirButton>
        <button type="button" className="btn ghost small" disabled={busy !== ''} title={t('Ссылка как для git clone — если папки этого репо у вас нет')} onClick={() => onAdd(typedDraft())}>{t('Ввести ссылку')}</button>
        <span className={styles.grow} />
        <button type="button" className="btn ghost small" onClick={onClose}>{t('Отмена')}</button>
      </div>
    </div>
  );
}

const HINT: Partial<Record<DraftState, () => string>> = {
  no_url: () => t('Нужна ссылка: без неё репо не добавится'),
  no_key: () => t('Нужен ключ'),
  bad_key: () => t('Ключ — латиница, цифры, дефис и подчёркивание'),
  dup_key: () => t('Такой ключ уже есть'),
  dup_url: () => t('Это репо уже есть в проекте'),
};

/** Строка репо: ключ (правится) и ссылка с веткой и моей папкой; у ручной строки ссылка — поле. */
export function RepoDraftRow({ draft, all, existing, onChange, onRemove }: {
  draft: RepoDraft;
  all: readonly RepoDraft[];
  existing?: readonly { key: string; url: string }[];
  onChange: (patch: Partial<RepoDraft>) => void;
  onRemove: () => void;
}) {
  const home = useConfig().data?.home;
  const state = draftState(draft, all, existing);
  // подсказку «нужна ссылка» не показываем у только что открытой пустой ручной строки
  const hint = state === 'no_url' && !draft.local && !draft.key.trim() ? undefined : HINT[state]?.();
  const badKey = state === 'bad_key' || state === 'dup_key' || (state === 'no_key' && draft.url.trim() !== '');
  return (
    <div className={styles.repoRow}>
      <input className={styles.mono} value={draft.key} placeholder={t('ключ: billing')} spellCheck={false} autoComplete="off" aria-label={t('Ключ репо')} aria-invalid={badKey || undefined} title={t('Короткое имя репо в задачах и у агента')} onChange={(e) => onChange({ key: e.target.value })} />
      <div className={styles.repoCell}>
        {draft.typed ? (
          <input className={styles.mono} value={draft.url} autoFocus={!draft.url} placeholder="git@github.com:acme/billing.git" spellCheck={false} autoComplete="off" aria-label={t('Ссылка на репо кода')} onChange={(e) => onChange({ url: e.target.value })} />
        ) : (
          <span className={styles.u} title={t('Ссылка — origin этой папки')}>{draft.url}</span>
        )}
        <span className={styles.meta}>
          {[draft.defaultBranch, draft.local && t('папка {path} — только у вас', { path: tildePath(draft.local, home) })].filter(Boolean).join(' · ')}
        </span>
      </div>
      <button type="button" className="btn ghost small" aria-label={t('Убрать репо')} title={t('Убрать репо')} onClick={onRemove}>×</button>
      {hint && <span className={cx(styles.note, styles.warn, styles.repoHint)}>{hint}</span>}
    </div>
  );
}

/** «git clone <ссылка>» для репо, которого нет на этом компьютере: склонировать самому и указать папку. */
export function CloneHint({ url }: { url: string }) {
  const toast = useToast();
  const cmd = cloneCommand(url);
  const copy = () => {
    (navigator.clipboard ? navigator.clipboard.writeText(cmd) : Promise.reject(new Error())).then(
      () => toast(t('Команда скопирована')),
      () => toast(t('Не скопировалось: выделите команду и скопируйте')),
    );
  };
  return (
    <span className={styles.clone}>
      <code title={t('agentgraph не клонирует репо кода: склонируйте сами и укажите папку')}>{cmd}</code>
      <button type="button" className="btn ghost small" onClick={copy}>{t('Копировать')}</button>
    </span>
  );
}
