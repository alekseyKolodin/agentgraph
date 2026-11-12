// «В работу ▸» (spec §8.8, §8.9; макет Main.dc.html, меню у карточки): выбор репо кода, если их несколько, → worktree ветки
// задачи (POST …/worktree) → форма запуска, заполненная из GET …/intake: flow (группы «Flow команды» и «Мои flow»), текст
// задачи — всё, что уйдёт агенту, видно и правится; папка — worktree; пространство проекта. Или терминальная сессия
// Claude Code с текстом задачи первым сообщением. Форма вкладки «Запуск» (screens/flow/RunForm) открывает только flow из
// flows/ этого компьютера, а flow команды живут в репо команды, поэтому здесь своя короткая форма; тело запроса собирает
// workRunBody по тем же полям, что и runBody формы запуска, плюс teamFlow и связь с задачей.
import { useEffect, useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDetail, TeamProject, TeamTask, TeamTaskIntake, TeamTaskWorktree } from '@server/api-types';
import { ApiError, errorText, keys, startRun, useFeature, useFlows, useSpaces } from '../../../api';
import { teamKeys } from '../../../api/teamwork';
import { SpacePicker } from '../../../components/SpacePicker';
import { t } from '../../../lib/i18n';
import { modelOptions } from '../../../lib/flow/tools';
import { withWorktreeNote } from '../../../lib/run-form';
import {
  defaultWorkFlow, myFlowInput, needsRepo, parseWorkFlow, taskRepo, workFlowKey, workRunBody, workSessionBody, type WorkFlow,
} from '../../../lib/teamwork/task';
import { projectPath } from '../shell';
import { fetchIntake, prepareTaskWorktree, startTaskSession } from './api';
import { MenuButton, type MenuEntry } from './parts';
import tw from '../Teamwork.module.css';
import styles from './Tasks.module.css';

export type WorkMode = 'run' | 'pick' | 'session';

/** Flow команды для «В работу» по умолчанию: defaultFlow, иначе teamwork-task, если он есть. */
export const teamDefaultFlow = (td: Pick<TeamDetail, 'defaultFlow' | 'flows'>): string | undefined =>
  td.defaultFlow && td.flows.includes(td.defaultFlow) ? td.defaultFlow : td.flows.includes('teamwork-task') ? 'teamwork-task' : undefined;

/** Пункты меню «В работу ▸»: запустить flow по умолчанию, другой flow, сессия. */
export function workMenu(td: TeamDetail, task: TeamTask, p: TeamProject, open: (mode: WorkMode) => void): MenuEntry[] {
  const flow = teamDefaultFlow(td);
  const repo = taskRepo(task, p);
  const cap = [repo, task.branch].filter(Boolean).join(' · ');
  const items: MenuEntry[] = [];
  if (cap) items.push({ cap });
  if (!p.repos.length) {
    items.push({ note: t('У проекта нет репо кода: добавьте его в настройках проекта') });
    return items;
  }
  if (flow) items.push({ key: 'run', label: t('Запустить {flow}', { flow }), small: t('flow команды по умолчанию'), onSelect: () => open('run') });
  items.push({ key: 'pick', label: t('Другой flow…'), small: t('flow команды и ваши'), onSelect: () => open('pick') });
  items.push({ key: 'session', label: t('Открыть сессию'), small: t('Claude Code в терминале, в worktree задачи'), onSelect: () => open('session') });
  if (task.status === 'todo' || !task.assignee) {
    items.push({ sep: 'h' });
    items.push({ note: task.assignee ? t('Задача перейдёт в «В работе»') : t('Задача перейдёт в «В работе», исполнитель — вы') });
  }
  return items;
}

/** Кнопка «В работу ▸» с меню и формой. */
export function ToWorkButton({ td, p, task, small = true, onOpen }: { td: TeamDetail; p: TeamProject; task: TeamTask; small?: boolean; onOpen?: (open: boolean) => void }) {
  const [mode, setMode] = useState<WorkMode>();
  if (task.error) return null;
  return (
    <>
      <MenuButton
        label={t('В работу')}
        title={t('Отправить задачу агенту: flow или сессия Claude Code в worktree задачи')}
        text={t('В работу ▸')}
        className={small ? 'btn small' : 'btn'}
        items={() => workMenu(td, task, p, setMode)}
        onOpen={onOpen}
      />
      {mode && <ToWorkDialog td={td} p={p} task={task} mode={mode} onClose={() => setMode(undefined)} />}
    </>
  );
}

type Phase = { kind: 'repo' } | { kind: 'prep'; text: string } | { kind: 'form' } | { kind: 'error'; text: string; noLocal?: boolean };

/** Форма «В работу»: репо → worktree → intake → запуск или сессия. */
export function ToWorkDialog({ td, p, task, mode, onClose }: { td: TeamDetail; p: TeamProject; task: TeamTask; mode: WorkMode; onClose: () => void }) {
  const team = td.slug;
  const project = p.slug;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const dlg = useRef<HTMLDialogElement>(null);
  const flowSel = useRef<HTMLSelectElement>(null);
  const alive = useRef(true);
  /** Заметка worktree (скопированные файлы и т. п.): видна в тексте задачи до запуска, как в форме вкладки «Запуск». */
  const wtNote = useRef('');
  const mine = useFlows().data ?? [];
  /** Свои flow на момент вызова: prepare и смена flow идут асинхронно, список мог прийти позже первой отрисовки. */
  const mineRef = useRef(mine);
  mineRef.current = mine;
  const spacesOn = useFeature('spaces');
  const spaces = useSpaces(spacesOn);
  const session = mode === 'session';
  const [repo, setRepo] = useState(taskRepo(task, p) ?? '');
  const [phase, setPhase] = useState<Phase>(needsRepo(task, p) ? { kind: 'repo' } : { kind: 'prep', text: t('Готовлю worktree…') });
  const [wt, setWt] = useState<TeamTaskWorktree>();
  const [intake, setIntake] = useState<TeamTaskIntake>();
  const [flow, setFlow] = useState<WorkFlow>();
  const [input, setInput] = useState('');
  const [space, setSpace] = useState('');
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  /** Текст под только что выбранный flow команды ещё едет: запуск с текстом прежнего flow не отправляем. */
  const [loadingFlow, setLoadingFlow] = useState(false);
  const [err, setErr] = useState('');

  // закрытие формы возвращает фокус туда, откуда её открыли (кнопка «В работу ▸»); элемент запомнен до showModal, а
  // фокус возвращается, только когда диалога уже нет в документе (StrictMode «размонтирует» понарошку, DOM остаётся)
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const el = dlg.current;
    return () => {
      setTimeout(() => {
        if (!el?.isConnected && opener.current?.isConnected) opener.current.focus();
      });
    };
  }, []);
  // у команды нет своих flow, а список «Мои flow» пришёл после intake — flow по умолчанию из него
  useEffect(() => {
    if (session || flow || !intake || phase.kind !== 'form') return;
    const f = defaultWorkFlow(intake, mine);
    if (!f) return;
    setFlow(f);
    setInput(inputFor(f, intake));
  }, [mine.length, phase.kind]);
  /** Подготовка worktree стартует один раз: в StrictMode эффект монтирования идёт дважды, второй POST гонялся бы с первым. */
  const started = useRef(false);
  useEffect(() => {
    alive.current = true;
    if (!dlg.current?.open) dlg.current?.showModal();
    if (!started.current && phase.kind === 'prep') {
      started.current = true;
      void prepare(repo);
    }
    return () => void (alive.current = false);
  }, []);

  /** Вход под выбранный flow: flow команды — анкета сервера (intake), свой — анкета этого flow и текст задачи. */
  const inputFor = (f: WorkFlow | undefined, it: TeamTaskIntake): string => {
    const note = (text: string) => (wtNote.current ? withWorktreeNote(text, wtNote.current) : text);
    if (session || !f) return note(it.context);
    if (f.kind === 'team') return note(it.input);
    const summary = mineRef.current.find((x) => x.name === f.name);
    return note(myFlowInput(summary?.input, { task: `${it.source.key} — ${it.source.title ?? task.title}`, branch: it.branch }, it.context));
  };

  const prepare = async (repoKey: string) => {
    setPhase({ kind: 'prep', text: t('Готовлю worktree…') });
    try {
      const w = await prepareTaskWorktree(team, project, task.id, repoKey || undefined);
      if (!alive.current) return;
      wtNote.current = w.note;
      setWt(w);
      setPhase({ kind: 'prep', text: t('Собираю текст задачи…') });
      const it = await fetchIntake(team, project, task.id, { repo: w.repo.key });
      if (!alive.current) return;
      setIntake(it);
      const f = defaultWorkFlow(it, mineRef.current);
      setFlow(f);
      setInput(inputFor(f, it));
      setSpace(it.space ?? '');
      setPhase({ kind: 'form' });
      // ветка и репо записались в задачу: карточка и панель — заново
      void qc.invalidateQueries({ queryKey: teamKeys.tasks(team, project) });
      if (mode === 'pick') setTimeout(() => flowSel.current?.focus());
    } catch (e) {
      if (!alive.current) return;
      setPhase({ kind: 'error', text: errorText(e), noLocal: e instanceof ApiError && e.code === 'no_local' });
    }
  };

  /** Поколение выбора flow: ответ intake для flow, который уже сменили, не затирает текст нового. */
  const flowSeq = useRef(0);
  const changeFlow = async (key: string) => {
    const f = parseWorkFlow(key);
    if (!f || !intake) return;
    const seq = ++flowSeq.current;
    const before = flow;
    setFlow(f);
    setErr('');
    if (f.kind === 'mine') {
      setLoadingFlow(false);
      return setInput(inputFor(f, intake));
    }
    setLoadingFlow(true);
    try {
      const it = await fetchIntake(team, project, task.id, { repo: wt?.repo.key, flow: f.name });
      if (!alive.current || seq !== flowSeq.current) return;
      setLoadingFlow(false);
      setIntake(it);
      setInput(inputFor(f, it));
    } catch (e) {
      if (seq !== flowSeq.current) return;
      setLoadingFlow(false);
      // текст и intake остались от прежнего flow — выбор возвращается к нему, чтобы не уйти с чужой анкетой
      setFlow(before);
      setErr(errorText(e));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!intake || !wt || busy || loadingFlow) return;
    if (!input.trim()) return setErr(t('Текст задачи пустой'));
    setBusy(true);
    setErr('');
    try {
      if (session) {
        const s = await startTaskSession(workSessionBody(intake, wt, { input, space: spacesOn ? space : '', model }));
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        void qc.invalidateQueries({ queryKey: teamKeys.all });
        onClose();
        void navigate(`/sessions/${encodeURIComponent(s.id)}`);
      } else {
        if (!flow) return setErr(t('Выберите flow'));
        const r = await startRun(workRunBody(intake, wt, flow, { input, space: spacesOn ? space : '', model, budget }));
        void qc.invalidateQueries({ queryKey: keys.runs });
        void qc.invalidateQueries({ queryKey: teamKeys.all });
        onClose();
        void navigate(`/run/${encodeURIComponent(r.id)}`);
      }
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const title = session ? t('Сессия по задаче {id}', { id: task.id }) : t('Запуск по задаче {id}', { id: task.id });
  // диалог — в body: карточка доски перетаскивается, а клики и клавиши формы не должны доходить до неё по дереву React
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  return createPortal(
    <dialog
      onClick={stop}
      onKeyDown={stop}
      onPointerDown={stop}
      onDragStart={stop}
      ref={dlg}
      className={styles.dlg}
      aria-labelledby="tw-work-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form className={styles.dlgBody} onSubmit={(e) => void submit(e)}>
        <h2 id="tw-work-title">{title}</h2>
        <p><span className={styles.id}>{task.id}</span> {task.title}</p>
        {phase.kind === 'repo' && (
          <div className={styles.f}>
            <label htmlFor="tw-work-repo">{t('Репо кода')}</label>
            <select id="tw-work-repo" value={repo} autoFocus onChange={(e) => setRepo(e.target.value)}>
              <option value="">{t('выберите репо')}</option>
              {p.repos.map((r) => <option key={r.key} value={r.key}>{r.key}{r.local ? '' : ` · ${t('нет на этом компьютере')}`}</option>)}
            </select>
            <span className={styles.hint}>{t('У проекта несколько репо кода, а у задачи репо не задано. Выбор запишется в задачу.')}</span>
          </div>
        )}
        {phase.kind === 'prep' && <p className="msg">{phase.text}</p>}
        {phase.kind === 'error' && (
          <div className={styles.f}>
            <p className="msg err">{phase.text}</p>
            {phase.noLocal && <p>{t('Укажите папку репо кода на этом компьютере на обзоре проекта, потом повторите.')} <Link to={projectPath(team, project)} onClick={onClose}>{t('К обзору проекта')}</Link></p>}
          </div>
        )}
        {phase.kind === 'form' && intake && wt && (
          <>
            {!session && (
              <div className={styles.f}>
                <label htmlFor="tw-work-flow">Flow</label>
                <select id="tw-work-flow" ref={flowSel} value={flow ? workFlowKey(flow) : ''} onChange={(e) => void changeFlow(e.target.value)}>
                  {!flow && <option value="">{t('выберите flow')}</option>}
                  {intake.teamFlows.length > 0 && (
                    <optgroup label={t('Flow команды')}>
                      {intake.teamFlows.map((n) => <option key={n} value={workFlowKey({ kind: 'team', name: n })}>{n}</option>)}
                    </optgroup>
                  )}
                  {mine.length > 0 && (
                    <optgroup label={t('Мои flow')}>
                      {mine.map((f) => <option key={f.name} value={workFlowKey({ kind: 'mine', name: f.name })}>{f.name}</option>)}
                    </optgroup>
                  )}
                </select>
              </div>
            )}
            <div className={styles.f}>
              <label htmlFor="tw-work-input">{session ? t('Первое сообщение') : t('Задача')}</label>
              <textarea id="tw-work-input" value={input} autoFocus={mode !== 'pick'} spellCheck={false} onChange={(e) => setInput(e.target.value)} />
              <span className={styles.hint}>{t('Всё, что уйдёт агенту. Текст команды — внутри source-data: это данные, а не инструкции.')}</span>
            </div>
            <div className={styles.f}>
              <span className={styles.lbl}>{t('Папка — worktree задачи')}</span>
              <div className={styles.path} title={wt.path}>{wt.path}</div>
              <span className={styles.hint}>{t('{repo} · ветка {branch}', { repo: wt.repo.key, branch: wt.branch })}{wt.created ? '' : ` · ${t('уже был — переиспользую')}`}</span>
            </div>
            {spacesOn && (
              <SpacePicker id="tw-work-space" value={space} onChange={setSpace} options={spaces.data?.spaces ?? []} loading={spaces.isPending} label={t('Пространство')} inputClassName={tw.pickInput} />
            )}
            <details className={styles.more}>
              <summary>{t('Модель и лимиты')}</summary>
              <div className={styles.two}>
                <div className={styles.f}>
                  <label htmlFor="tw-work-model">{t('Модель')}</label>
                  <select id="tw-work-model" value={model} onChange={(e) => setModel(e.target.value)}>
                    {modelOptions(model).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                  </select>
                </div>
                {!session && (
                  <div className={styles.f}>
                    <label htmlFor="tw-work-budget">{t('Бюджет, $')}</label>
                    <input id="tw-work-budget" inputMode="decimal" value={budget} placeholder={t('как в flow')} onChange={(e) => setBudget(e.target.value)} />
                  </div>
                )}
              </div>
            </details>
          </>
        )}
        {err && <p className="msg err">{err}</p>}
        <div className={styles.dfoot}>
          {phase.kind === 'form' && task.status === 'todo' && <span className={styles.hint}>{task.assignee ? t('Задача перейдёт в «В работе»') : t('Задача перейдёт в «В работе», исполнитель — вы')}</span>}
          <span className={styles.grow} />
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>{t('Отмена')}</button>
          {phase.kind === 'repo' && <button type="button" className="btn primary" disabled={!repo} onClick={() => void prepare(repo)}>{t('Дальше')}</button>}
          {phase.kind === 'error' && <button type="button" className="btn" onClick={() => (needsRepo(task, p) && !wt ? setPhase({ kind: 'repo' }) : void prepare(repo))}>{t('Повторить')}</button>}
          {phase.kind === 'form' && (
            <button type="submit" className="btn primary" disabled={busy || loadingFlow || (!session && !flow)}>
              {busy ? t('Запускаю…') : session ? t('Открыть сессию') : t('Запустить')}
            </button>
          )}
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
