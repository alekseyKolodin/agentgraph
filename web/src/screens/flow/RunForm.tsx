// Форма запуска на вкладке «Запуск» (ui/app.js renderFlow, startRun, wireAttachments, wireRecentDirs, wireRunTag,
// renderRunMoreSum, renderConnWarn; ui/dash.js renderRunLink, prepareWorktree, toFlow): задача, директория проекта и недавние
// папки, «Дополнительно» (теги, вложения, доп. директории, worktree, лимиты, модель), «Запустить» в липкой панели.
// Вход из «Запустить…» с главной приходит в location.state.intake; черновик разового запуска уходит со spec из конструктора.
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Intake } from '@server/api-types';
import {
  ApiError, errorText, fetchTag, hideRecentDir, keys, prepareWorktree, recentDirsKey, startRun, useConfig, useFeature, useRecentDirs, useTags,
} from '../../api';
import { TagBadge } from '../../components/Badge';
import { useConfirm } from '../../components/ConfirmDialog';
import { PickDirButton } from '../../components/PickDirButton';
import { ICON } from '../../components/shell/FlowList';
import { useToast } from '../../components/Toast';
import { collectSpec } from '../../lib/flow/edit';
import { modelOptions } from '../../lib/flow/tools';
import {
  appendDir, ATTACH_ACCEPT, attachName, attachOverLimit, attachTypeError, attachWarn, CONN_WARN_TEXT, connWarn, dirLines, fileSize,
  KIND_LABEL, recentChips, runBody, runMoreSum, sourceLabel, staleWorktreeCwd, TAG_SLUG_ERROR, TAG_SLUG_RE, tagAddedMsg, tagContext,
  tagNewMsg, tagOptionLabel, wantsAutoTag, withWorktreeNote, worktreeProject, worktreeRequest, type RunLink,
} from '../../lib/run-form';
import { LS } from '../../lib/storage';
import { useIntegrations } from '../home/Dash';
import { attachReads, nextAttachId, resetExtras, resetForm, runForm, setForm, useRunForm } from './formStore';
import { closeFlow, flowState, msgClass, NO_MSG, useFlowStore } from './store';
import { readBase64 } from '../../components/readBase64';
import styles from './RunForm.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files');

export function RunForm({ intake, intakeKey }: { intake: Intake | undefined; intakeKey: string }) {
  const st = useFlowStore();
  const flow = st.flow!;
  const summary = flow.summary;
  const f = useRunForm();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { askConfirm, notify } = useConfirm();
  const config = useConfig().data;
  const defaultCwd = config?.defaultCwd ?? '';
  const can = {
    tags: useFeature('tags'),
    autoTag: useFeature('auto-tag'),
    attachments: useFeature('attachments'),
    addDirs: useFeature('run-add-dirs'),
    recent: useFeature('recent-dirs'),
    hideRecent: useFeature('recent-dirs-hide'),
    integrations: useFeature('integrations'),
  };
  const info = useIntegrations(can.integrations).data;
  const projects = info?.projects ?? [];
  const recent = recentChips(useRecentDirs(can.recent).data ?? []);
  const tagList = useTags(can.tags).data?.tags ?? [];
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const dropStale = (link: RunLink | null) => {
    if (!staleWorktreeCwd(runForm.cwd, info?.worktreesDir, link)) return;
    setForm({ cwd: defaultCwd });
    if (LS.raw('agentgraph.cwd')?.startsWith(info!.worktreesDir + '/')) localStorage.removeItem('agentgraph.cwd');
  };
  /** Привязка и строка worktree (renderRunLink): проект и ветка — заново, сообщение стирается. */
  const showLink = (link: RunLink | null) =>
    setForm({
      link,
      wtProject: projects.length ? worktreeProject(projects, link, runForm.cwd) : '',
      wtBranch: link?.worktree?.branch ?? link?.branch ?? '',
      wtMsg: NO_MSG,
    });
  const unlink = () => {
    dropStale(null);
    showLink(null);
  };

  // flow открыли или сохранили — форма заново; другой flow или черновик — и вложения. Вход из «Запустить…» — поверх
  // свежей формы, как toFlow после openFlow
  useLayoutEffect(() => {
    // без конфига нет директории по умолчанию: форма заполнится, когда он придёт
    if (!config) return;
    if (runForm.extrasSeq !== st.extrasSeq) resetExtras(st.extrasSeq);
    const fresh = intake && intakeKey && runForm.intakeKey !== intakeKey;
    if (runForm.formSeq === st.formSeq && !fresh) return;
    resetForm(summary, defaultCwd, st.formSeq);
    if (can.integrations) unlink();
    // недавние папки и теги — заново при каждом открытии flow, как loadRecentDirs и loadTags в openFlow
    void qc.invalidateQueries({ queryKey: recentDirsKey });
    void qc.invalidateQueries({ queryKey: keys.tags });
    if (fresh) {
      setForm({ input: intake.input, ...(intake.source.project ? { cwd: intake.source.project } : {}), intakeKey, focusSeq: runForm.focusSeq + 1 });
      showLink({ source: intake.source, branch: intake.branch, project: intake.source.project });
    }
  }, [st.formSeq, st.extrasSeq, intakeKey, config]);

  // проекты пришли позже формы (прямая ссылка на flow): чужой путь worktree — прочь, проект worktree — по директории
  useEffect(() => {
    if (!info) return;
    dropStale(runForm.link);
    if (!runForm.wtProject) showLink(runForm.link);
  }, [info]);

  useEffect(() => {
    if (!f.focusSeq) return;
    const el = taskRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, 0);
    el.scrollTop = 0;
  }, [f.focusSeq]);

  const setMore = (open: boolean) => {
    LS.set('agentgraph.runMore', open);
    setForm({ more: open });
  };

  // ---------- директория проекта: смена (как change старого поля) снимает worktree с привязки
  const cwdAtFocus = useRef('');
  const cwdChanged = () => {
    const l = runForm.link;
    if (l?.worktree) showLink({ ...l, worktree: undefined });
  };
  const pickCwd = (path: string) => {
    setForm({ cwd: path });
    cwdChanged();
  };

  // ---------- вложения
  const readAttachments = async (files: File[]) => {
    const gen = runForm.extrasSeq;
    const errors: string[] = [];
    for (const file of files) {
      const name = attachName(file.name);
      let err = attachTypeError(name, file.size) ?? attachOverLimit(runForm.attach, name, file.size);
      if (!err) {
        try {
          const data = await readBase64(file);
          // форму сбросили (сменили flow): файлы прежней формы не нужны, но об отказах уже собранных скажем
          if (gen !== runForm.extrasSeq) break;
          err = attachOverLimit(runForm.attach, name, file.size);
          if (!err) setForm({ attach: [...runForm.attach, { id: nextAttachId(), name, size: file.size, data }] });
        } catch (e) {
          if (gen !== runForm.extrasSeq) break;
          err = `${name}: не прочитался (${e instanceof Error ? e.message : String(e)})`;
        }
      }
      if (err) errors.push(err);
    }
    if (errors.length) toast(errors.join('; '));
  };
  const addAttachments = (files: File[]) => {
    // файлы бросили на форму или вставили в задачу: их чипы и предупреждения — в «Дополнительно»
    setMore(true);
    const p: Promise<void> = readAttachments(files).finally(() => attachReads.delete(p));
    attachReads.add(p);
  };
  const [drop, setDrop] = useState(false);

  // ---------- теги
  const kindOf = (t: string) => f.tagInfo.get(t)?.kind || 'task';
  const hasTask = f.tags.some((t) => kindOf(t) === 'task');
  const addTag = async () => {
    const slug = runForm.tagText.trim();
    setForm({ tagMsg: NO_MSG });
    if (!slug) return;
    if (!TAG_SLUG_RE.test(slug)) {
      setForm({ tagMsg: { text: TAG_SLUG_ERROR, tone: 'err' } });
      return;
    }
    setForm({ tagText: '' });
    if (runForm.tags.includes(slug)) return;
    setForm({ tags: [...runForm.tags, slug] });
    const seq = runForm.tagSeq;
    try {
      const r = await fetchTag(slug);
      // пока шёл запрос, тег убрали или открыли другой flow: панель не трогаем
      if (seq !== runForm.tagSeq || !runForm.tags.includes(slug)) return;
      setForm({ tagInfo: new Map(runForm.tagInfo).set(slug, { kind: r.kind || 'task', title: r.title || '', input: r.input || '' }), tagMsg: { text: tagAddedMsg(slug, r), tone: '' } });
    } catch (err) {
      if (seq !== runForm.tagSeq) return;
      setForm({ tagMsg: err instanceof ApiError && err.status === 404 ? { text: tagNewMsg(slug), tone: '' } : { text: errorText(err), tone: 'err' } });
    }
  };
  const removeTag = (slug: string) => {
    const tagInfo = new Map(runForm.tagInfo);
    tagInfo.delete(slug);
    setForm({ tags: runForm.tags.filter((t) => t !== slug), tagInfo, tagMsg: NO_MSG });
  };

  // ---------- worktree
  const wtProject = f.wtProject || worktreeProject(projects, f.link, f.cwd);
  const makeWorktree = async () => {
    setForm({ wtBusy: true, wtMsg: { text: 'Готовлю worktree…', tone: '' } });
    const link = runForm.link;
    const name = flowState.flow?.name;
    try {
      const r = await prepareWorktree(worktreeRequest(link, wtProject, runForm.wtBranch));
      // пока git работал, пользователь мог уйти на другой flow или сменить источник: чужую форму не трогаем
      if (flowState.flow?.name !== name || runForm.link !== link || !alive.current) {
        toast(`Worktree готов: ${r.path}`);
        return;
      }
      // заметку видно в задаче до запуска: сервер сам ничего не дописывает
      setForm({ cwd: r.path, input: withWorktreeNote(runForm.input, r.note) });
      showLink({ ...(link || {}), project: wtProject, worktree: { path: r.path, branch: r.branch } });
      setForm({ wtMsg: { text: r.created ? 'создан' : 'уже был — переиспользую', tone: 'ok' } });
    } catch (err) {
      setForm({ wtMsg: { text: errorText(err), tone: 'err' } });
    } finally {
      setForm({ wtBusy: false });
    }
  };

  // ---------- «Запустить»
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (runForm.busy) return;
    // тег вписан, но не добавлен (Enter не нажимали): добавляем, чтобы он не пропал молча
    if (can.tags && runForm.tagText.trim()) {
      await addTag();
      // неверный слаг остаётся в поле с ошибкой: запуск без него ушёл бы молча
      if (runForm.tagText.trim()) return setMore(true);
    }
    const flowRef = flowState.flow;
    const draft = Boolean(flowRef?.draft);
    // черновик запускается тем, что сейчас в конструкторе, — тот же объект, что ушёл бы в «Применить»
    let spec: unknown;
    if (draft) {
      try {
        spec = collectSpec(flowState.spec!);
      } catch (err) {
        setForm({ msg: { text: `Сначала поправь конструктор: ${errorText(err)}`, tone: 'err' } });
        return;
      }
    } else if (flowState.dirty && !(await askConfirm('В конструкторе есть несохранённые изменения, запуск пойдёт по сохранённой версии. Продолжить?', { ok: 'Запустить' }))) return;
    setForm({ busy: true, msg: { text: 'Запускаю…', tone: '' } });
    // форма, с которой нажали «Запустить»: если пока дочитывались вложения открыли другой flow, запуск не отправляем
    const gen = runForm.extrasSeq;
    try {
      // файл, который ещё читается, иначе не попал бы в запрос, а после сброса пропал бы молча
      if (attachReads.size) setForm({ msg: { text: 'Дочитываю вложения…', tone: '' } });
      while (attachReads.size) await Promise.allSettled([...attachReads]);
      if (gen !== runForm.extrasSeq || flowState.flow !== flowRef) {
        setForm({ msg: NO_MSG });
        return;
      }
      // автотег: без выбранного тега задачи (новый слаг — тоже тег задачи) сервер сначала спросит модель, это секунды
      const autoTag = can.autoTag && wantsAutoTag(runForm.autoTag, runForm.tags, runForm.tagInfo);
      setForm({ msg: { text: autoTag ? 'Завожу тег и запускаю…' : 'Запускаю…', tone: '' } });
      // путь worktree — разовый, рабочей директорией по умолчанию для следующих запусков он не становится
      if (!(can.integrations && runForm.link?.worktree)) LS.setRaw('agentgraph.cwd', runForm.cwd.trim());
      LS.setRaw('agentgraph.budget', runForm.budget);
      LS.setRaw('agentgraph.model', runForm.model.trim());
      const r = await startRun(runBody({
        flow: flowRef!.name,
        spec,
        input: runForm.input,
        cwd: runForm.cwd,
        maxIterations: runForm.maxIterations,
        maxBudgetUsd: runForm.budget,
        model: runForm.model,
        link: runForm.link,
        attach: runForm.attach,
        addDirs: runForm.addDirs,
        tags: runForm.tags,
        saveTag: runForm.saveTag,
        autoTag,
        can: { integrations: can.integrations, attachments: can.attachments, addDirs: can.addDirs, tags: can.tags },
      }));
      setForm({ msg: NO_MSG });
      // запуск уже идёт: окно ошибки не ждём, новый тег — сразу в список поля «Теги»
      if (r.autoTag && 'error' in r.autoTag && r.autoTag.error) void notify(`Тег не заведён: ${r.autoTag.error}. Запуск идёт без тега.`);
      else if (r.autoTag && 'slug' in r.autoTag) void qc.invalidateQueries({ queryKey: keys.tags });
      // вложения ушли в этот запуск: «Открыть flow» не должно молча приложить их к следующему
      if (gen === runForm.extrasSeq) resetExtras();
      await qc.invalidateQueries({ queryKey: keys.runs });
      // черновик стал запуском: дальше его flow — снимок в папке запуска, уходить с него можно без вопроса
      if (draft && flowState.flow === flowRef) {
        flowState.approved = true;
        setTimeout(() => {
          if (flowState.flow === flowRef) closeFlow();
        });
      }
      void navigate(`/run/${r.id}`);
    } catch (err) {
      setForm({ msg: { text: errorText(err), tone: 'err' } });
    } finally {
      setForm({ busy: false });
    }
  };

  const multiBlock = (summary?.blocks?.length ?? 0) > 1;
  const models = modelOptions(f.modelBase);
  const sum = runMoreSum({
    tags: f.tags,
    attach: f.attach.length,
    addDirs: f.addDirs,
    worktree: Boolean(f.link?.worktree),
    maxIterations: f.maxIterations,
    flowMaxIterations: summary?.maxIterations,
    budget: f.budget,
    modelLabel: f.model ? (models.find(([id]) => id === f.model)?.[1] ?? f.model) : '',
  });
  const blindWarn = attachWarn(summary);
  const source = f.link?.source;

  const recentRow = (onPick: (path: string) => void) =>
    recent.length > 0 && (
      <div className={cx('chips', styles.recentDirs)}>
        {recent.map((d) => (
          // «×» — соседняя кнопка в span: кнопка внутри кнопки невалидна
          <span key={d.path} className={cx('chip', styles.recentChip)}>
            <button type="button" data-dir={d.path} title={d.path} onClick={() => onPick(d.path)}>{d.label}</button>
            {can.hideRecent && <HideRecent path={d.path} />}
          </span>
        ))}
      </div>
    );

  return (
    <form
      className={cx('form', styles.runForm, drop && styles.drop)}
      onSubmit={(e) => void submit(e)}
      onDragOver={(e) => {
        if (!can.attachments || !hasFiles(e)) return;
        e.preventDefault();
        setDrop(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(false);
      }}
      onDrop={(e) => {
        setDrop(false);
        if (!can.attachments || !hasFiles(e)) return;
        e.preventDefault();
        addAttachments([...e.dataTransfer.files]);
      }}
    >
      <datalist id="run-tag-list">
        {tagList.map((t) => <option key={t.slug} value={t.slug}>{tagOptionLabel(t)}</option>)}
      </datalist>
      <label>
        <span title="Подставится в {{input}}">Задача</span>
        <textarea
          ref={taskRef}
          name="input"
          rows={5}
          placeholder="Что нужно сделать"
          value={f.input}
          onChange={(e) => setForm({ input: e.target.value })}
          // вставка скриншота; обычную вставку текста не трогаем. Excel, Numbers и Word кладут в буфер рядом с текстом
          // ещё и картинку: если текст есть, вставляется он
          onPaste={(e: ClipboardEvent) => {
            const files = [...(e.clipboardData?.files || [])];
            if (!can.attachments || !files.length || [...e.clipboardData.types].includes('text/plain')) return;
            e.preventDefault();
            addAttachments(files);
          }}
        />
      </label>
      {connWarn(f.input, summary) && <p className="msg warn">{CONN_WARN_TEXT}</p>}
      {can.integrations && source && (
        <div className={cx('row', styles.runSource)}>
          <span className="muted small">{`${sourceLabel(source)}:`}</span>
          {source.url ? <a href={source.url} target="_blank" rel="noopener"><b>{source.key}</b></a> : <b>{source.key}</b>}
          <span className={cx('small', styles.dashName)}>{source.title}</span>
          {f.link?.worktree && (
            <span className="chip on" title={f.link.worktree.path}>{`worktree${f.link.worktree.branch ? ` · ${f.link.worktree.branch}` : ''}`}</span>
          )}
          <button type="button" className="btn small ghost" title="Запуск не будет привязан к источнику (текст задачи останется)" onClick={unlink}>Отвязать</button>
        </div>
      )}
      <label>
        <span>Директория проекта</span>
        <div className="path-field">
          <input
            name="cwd"
            placeholder="/path/to/repo"
            value={f.cwd}
            onChange={(e) => setForm({ cwd: e.target.value })}
            onFocus={(e) => (cwdAtFocus.current = e.target.value)}
            onBlur={(e) => {
              if (e.target.value !== cwdAtFocus.current) cwdChanged();
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.currentTarget.value === cwdAtFocus.current) return;
              cwdAtFocus.current = e.currentTarget.value;
              cwdChanged();
            }}
          />
          <PickDirButton prompt="Выбери директорию проекта" start={() => runForm.cwd} onPick={pickCwd} />
        </div>
      </label>
      {recentRow(pickCwd)}
      <details className={styles.runMore} open={f.more} onToggle={(e) => e.currentTarget.open !== runForm.more && setMore(e.currentTarget.open)}>
        <summary>
          <span className="caret">{ICON.caret}</span>
          <span className={styles.runMoreTitle}>Дополнительно</span>
          <span className={cx(styles.runMoreSum, sum.set && styles.set)}>{sum.text}</span>
        </summary>
        <div className={styles.runMoreBody}>
          {can.tags && (
            <div className={styles.runTag}>
              <label>
                <span title="Тег задачи — саммари фичи из прошлых запусков: встанет в начало задачи, описывать фичу заново не нужно. Тег знаний — что должны знать этапы (фронтенд, бэкенд, QA): уйдёт в промпты этапов каждого блока. Тегов может быть несколько. Новый слаг — новый тег задачи. Править теги — на странице «Теги»">Теги</span>
                <input
                  name="tag"
                  list="run-tag-list"
                  placeholder="без тегов — или выбери из списка, или впиши новый и нажми Enter: loyalty-card"
                  autoComplete="off"
                  spellCheck={false}
                  value={f.tagText}
                  onChange={(e) => {
                    setForm({ tagText: e.target.value });
                    // выбор из списка (datalist): как change старого поля — сразу добавить
                    if ((e.nativeEvent as InputEvent).inputType === 'insertReplacementText' || !(e.nativeEvent instanceof InputEvent)) void addTag();
                  }}
                  // уход с поля — как change; input не берём, чтобы не дёргать сервер на каждую букву
                  onBlur={() => void addTag()}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    void addTag();
                  }}
                />
              </label>
              <div className="chips">
                {f.tags.map((t) => (
                  <span key={t} className="chip attach-chip">
                    <TagBadge slug={t} kind={kindOf(t)} />
                    <span className="muted small">{KIND_LABEL[kindOf(t)]}</span>
                    <button type="button" className="attach-x" title="Убрать тег из запуска" onClick={() => removeTag(t)}>×</button>
                  </span>
                ))}
              </div>
              {f.tags.length > 0 && (
                <div className={styles.runTagContext} title="Что сервер вставит от выбранных тегов: тег задачи — в начало задачи, тег знаний — в конец промптов этапов. Поле «Задача» остаётся только задачей">
                  {f.tags.map((t) => {
                    const c = tagContext(f.tagInfo.get(t));
                    return (
                      <details key={t}>
                        <summary>
                          <TagBadge slug={t} kind={c.kind} />{` ${f.tagInfo.get(t)?.title || ''} `}<span className="muted small">{`${KIND_LABEL[c.kind]} · ${c.where}`}</span>
                        </summary>
                        <pre className={styles.tagContextText}>{c.text}</pre>
                      </details>
                    );
                  })}
                </div>
              )}
              {can.autoTag && (
                <label
                  className={styles.inlineCheck}
                  title={hasTask ? 'Тег задачи уже выбран: новый не заведётся' : 'ИИ по тексту задачи заведёт новый тег задачи (слаг занят — с суффиксом -2…), после «готово» запишет его саммари. Существующие теги не переиспользуются: чтобы продолжить фичу, выберите её тег в поле «Теги»'}
                >
                  <input
                    type="checkbox"
                    name="autoTag"
                    checked={f.autoTag}
                    disabled={hasTask}
                    onChange={(e) => {
                      LS.setRaw('agentgraph.autoTag', e.target.checked ? '1' : '0');
                      setForm({ autoTag: e.target.checked });
                    }}
                  />
                  <span>Завести тег задачи автоматически</span>
                </label>
              )}
              {hasTask && (
                <label className={styles.inlineCheck} title="После запуска со статусом «готово» короткая сессия по каждому тегу перепишет его саммари: суть, где код, решения, где читать подробнее">
                  <input type="checkbox" name="saveTag" checked={f.saveTag} onChange={(e) => setForm({ saveTag: e.target.checked })} />
                  <span>Обновить саммари тегов после запуска</span>
                </label>
              )}
              <span className={msgClass(f.tagMsg)}>{f.tagMsg.text}</span>
            </div>
          )}
          {can.attachments && (
            <div className={styles.runAttach}>
              <div className="row">
                <span className="field-label">Вложения</span>
                <button type="button" className="btn small" title="Картинки, PDF и текстовые файлы: до 10 файлов, до 10 МБ каждый, до 25 МБ вместе" onClick={() => fileRef.current?.click()}>Добавить файлы…</button>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  accept={ATTACH_ACCEPT}
                  onChange={(e) => {
                    addAttachments([...(e.target.files || [])]);
                    e.target.value = '';
                  }}
                />
                <span className="muted small">или перетащи файлы на форму, скриншот — вставь в поле задачи</span>
              </div>
              <div className="chips">
                {f.attach.map((a) => (
                  <span key={a.id} className="chip attach-chip">
                    {`${a.name} · ${fileSize(a.size)}`}
                    <button type="button" className="attach-x" title="Убрать" onClick={() => setForm({ attach: runForm.attach.filter((x) => x.id !== a.id) })}>×</button>
                  </span>
                ))}
              </div>
              {f.attach.length > 0 && blindWarn && <p className="msg warn">{blindWarn}</p>}
            </div>
          )}
          {can.addDirs && (
            <div className={styles.runAdddirs}>
              <label>
                <span title="Куда агенты всех этапов могут ходить, кроме директории проекта: по пути на строку. Например, соседний репозиторий с правилами">Дополнительные директории</span>
                <div className="path-field">
                  <textarea name="addDirs" rows={2} placeholder="~/projects/qa-rules" value={f.addDirs} onChange={(e) => setForm({ addDirs: e.target.value })} />
                  <PickDirButton
                    prompt="Выбери дополнительную директорию"
                    start={() => dirLines(runForm.addDirs).at(-1) ?? ''}
                    onPick={(path) => setForm({ addDirs: appendDir(runForm.addDirs, path) })}
                  />
                </div>
              </label>
              {recentRow((path) => setForm({ addDirs: appendDir(runForm.addDirs, path) }))}
            </div>
          )}
          {can.integrations && projects.length > 0 && (
            <div className={styles.runLink}>
              <div className="row">
                <span className="field-label">Отдельный git worktree:</span>
                <select title="Проект" value={wtProject} onChange={(e) => setForm({ wtProject: e.target.value })}>
                  {projects.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
                </select>
                <input
                  className={styles.wtBranch}
                  placeholder="ветка (пусто — от базовой)"
                  autoComplete="off"
                  spellCheck={false}
                  value={f.wtBranch}
                  onChange={(e) => setForm({ wtBranch: e.target.value })}
                />
                <button type="button" className="btn small" title="Создать worktree и подставить в директорию" disabled={f.wtBusy} onClick={() => void makeWorktree()}>Подготовить worktree</button>
                <span className={msgClass(f.wtMsg)}>{f.wtMsg.text}</span>
              </div>
            </div>
          )}
          <div className={cx('row', styles.runLimits)}>
            <label>
              <span>{multiBlock ? 'Лимит итераций каждого цикла' : 'Лимит итераций'}</span>
              <input name="maxIterations" type="number" min={1} max={50} placeholder={multiBlock ? 'как в блоках' : ''} value={f.maxIterations} onChange={(e) => setForm({ maxIterations: e.target.value })} />
            </label>
            <label>
              <span>Лимит стоимости, $</span>
              <input name="maxBudgetUsd" type="number" min={0} step="any" placeholder="без лимита" value={f.budget} onChange={(e) => setForm({ budget: e.target.value })} />
            </label>
            <label>
              <span>Модель</span>
              <select name="model" value={f.model} onChange={(e) => setForm({ model: e.target.value })}>
                {models.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
          </div>
        </div>
      </details>
      <div className={styles.runBar}>
        <button type="submit" className="btn primary" disabled={!summary || f.busy}>Запустить</button>
        <span className={msgClass(f.msg)}>{f.msg.text}</span>
      </div>
    </form>
  );
}

/** «×» у недавней папки: убрать из недавних в обоих рядах; поля директорий не трогаются, даже если там этот путь. */
function HideRecent({ path }: { path: string }) {
  const qc = useQueryClient();
  const { notify } = useConfirm();
  return (
    <button
      type="button"
      className="attach-x"
      title="Убрать из недавних: путь вернётся, если с ним будет новый запуск"
      onClick={async (e) => {
        e.stopPropagation();
        const b = e.currentTarget;
        b.disabled = true;
        try {
          qc.setQueryData(recentDirsKey, await hideRecentDir(path));
        } catch (err) {
          b.disabled = false;
          await notify(errorText(err));
        }
      }}
    >
      ×
    </button>
  );
}
