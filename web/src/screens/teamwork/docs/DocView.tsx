// Документ для чтения (spec §8.4, макет PrdRead): оглавление по «## » сбоку — не уезжает и подсвечивает текущий раздел, у
// раздела требований подпункты FR-N, внизу итог покрытия; колонка текста 640px кеглем --fs-read; строки требований с
// номером и задачами на полях (без задач — янтарным и «Создать задачу»); ссылки на задачи, требования и документы.
// Нажатие на раздел или «Править» превращает его в редактор на месте (SectionEditor), остальной документ — для чтения.
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDetail, TeamDoc, TeamDocName, TeamProject, TeamTask } from '@server/api-types';
import { errorText } from '../../../api';
import { createTask, teamKeys } from '../../../api/teamwork';
import { useConfirm } from '../../../components/ConfirmDialog';
import { t } from '../../../lib/i18n';
import { editMovedDown, isReqSection, readChunks, repeatedSections, reqAnchor, sectionAnchor, sectionName, taskWhere } from '../../../lib/teamwork/doc-view';
import { coverage, currentSection, docFile, docHeadLine, parseRequirements, requirementShort, serializeRequirementRows, splitSections, type DocSection } from '../../../lib/teamwork/docs';
import { useReturnFocus } from '../focus';
import { cx } from '../parts';
import { TASK_PARAM } from '../shell';
import { DocText, RefCtx, scrollToAnchor, type RefContext } from './DocText';
import { editBody, getEdit, isDirty, patchEdit, setEdit, useEdit } from './edits';
import { docFiles, introHash, SectionEditor, startEdit } from './SectionEditor';
import styles from './Docs.module.css';
import tw from '../Teamwork.module.css';

type Props = {
  team: TeamDetail;
  project: TeamProject;
  name: TeamDocName;
  doc: TeamDoc;
  tasks: readonly TeamTask[];
  /** Править нельзя: формат репо новее. */
  readonly: boolean;
  /** Черновики с агентом для этого документа есть (ТЗ, архитектура, дизайн). */
  agent: boolean;
  /** Кнопки шапки документа справа: «История», «Исходник», «Черновик с агентом…». */
  actions: ReactNode;
};

const READ_LINE = 120;

export function DocView({ team, project, name, doc, tasks, readonly, agent, actions }: Props) {
  const { askConfirm } = useConfirm();
  const loc = useLocation();
  const edit = useEdit(team.slug, project.slug, name);
  const isPrd = name === 'prd';
  const sections = useMemo(() => splitSections(doc.text), [doc.text]);
  const reqs = useMemo(() => doc.requirements ?? parseRequirements(doc.text), [doc]);
  const cov = useMemo(() => coverage(reqs, tasks), [reqs, tasks]);
  const ctx = useMemo<RefContext>(() => ({ team: team.slug, project: project.slug, doc: name, prefix: team.prefix, reqs: new Set(isPrd ? reqs.map((r) => r.id) : []) }), [team.slug, project.slug, name, team.prefix, reqs, isPrd]);
  // в архитектуре и дизайне ссылки на FR-N ведут в ТЗ: номера оттуда не известны, ссылаемся на любые
  const refCtx = useMemo<RefContext>(() => (isPrd ? ctx : { ...ctx, reqs: undefined }), [ctx, isPrd]);
  const [current, setCurrent] = useState(0);
  const article = useRef<HTMLElement>(null);
  const [creating, setCreating] = useState<{ id: string; text: string } | null>(null);

  // текущий раздел по прокрутке: последний, чей верх выше линии чтения (прокручивать может любой предок)
  useEffect(() => {
    const onScroll = () => {
      const els = article.current?.querySelectorAll<HTMLElement>('[data-sec]');
      if (!els?.length) return;
      const tops = [...els].map((el) => ({ heading: el.dataset.sec!, top: el.getBoundingClientRect().top }));
      setCurrent(Number(currentSection(tops, READ_LINE)) || 0);
    };
    onScroll();
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, [sections.length]);

  // якорь в адресе (#FR-3 из другого документа или ссылка) — прокрутить к нему один раз, когда документ на экране;
  // сохранение раздела и синхронизация меняют документ, но не должны уводить от редактора к якорю
  const scrolledTo = useRef('');
  useEffect(() => {
    if (!loc.hash || scrolledTo.current === loc.hash) return;
    let id: string;
    try {
      id = decodeURIComponent(loc.hash.slice(1));
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      if (!document.getElementById(id)) return;
      scrolledTo.current = loc.hash;
      scrollToAnchor(id);
    }, 50);
    return () => clearTimeout(timer);
  }, [loc.hash, doc.base]);

  const openEdit = async (heading: string) => {
    if (readonly) return;
    if (edit?.heading === heading) return;
    if (edit && isDirty(edit, serializeRequirementRows) && !(await askConfirm(t('Раздел «{section}» не сохранён. Бросить его правку и открыть другой?', { section: sectionName(edit.heading) }), { ok: t('Бросить'), danger: true }))) return;
    const sec = sections.find((s) => s.heading === heading);
    const next = startEdit(doc, heading, isPrd && Boolean(sec && heading && isReqSection(heading, sec.body)));
    setEdit(team.slug, project.slug, name, next);
    // у начала документа хэша от сервера нет — считаем сами, чтобы и его сохранение проверялось на параллельную правку
    if (next && !heading && !next.hash) {
      const hash = await introHash(doc);
      if (hash && getEdit(team.slug, project.slug, name)?.heading === '') patchEdit(team.slug, project.slug, name, { hash });
    }
  };

  // сервер адресует раздел заголовком и правит первый такой: повтор заголовка на месте не правится, правка — у первого
  const repeated = useMemo(() => repeatedSections(sections), [sections]);
  // заголовок правки повторился уже во время правки (pull вставил выше такой же, и первый теперь — чужой): сервер запишет в
  // первый — редактора на месте нет, правка видна, как у пропавшего раздела. Правка того же первого раздела коллегой — не то:
  // там обычный 409 с обеими версиями
  const lost = Boolean(edit && editMovedDown(sections, edit.heading, edit.original, edit.repeats));
  const editing = edit && !lost ? sections.findIndex((s) => s.heading === edit.heading) : -1;
  const dirty = edit ? isDirty(edit, serializeRequirementRows) : false;
  const toTop = (i: number) => (e: MouseEvent) => {
    e.preventDefault();
    scrollToAnchor(sectionAnchor(i));
  };
  const files = docFiles(project.docs.map((d) => d.name));

  return (
    <RefCtx.Provider value={refCtx}>
      <div className={styles.wrap}>
        <nav className={styles.toc} aria-label={t('Содержание: {doc}', { doc: name })}>
          <span className={styles.cap}>{t('Содержание')}</span>
          {sections.map((s, i) => {
            if (!s.heading) return null;
            const items = isPrd ? reqs.filter((r) => r.section === s.heading) : [];
            const on = i === current;
            return (
              <div key={i} style={{ display: 'contents' }}>
                <a href={`#${sectionAnchor(i)}`} className={cx(on && styles.on)} aria-current={on ? 'true' : undefined} onClick={toTop(i)}>
                  <span>{s.heading}</span>
                  {editing === i ? (
                    <span className={cx(styles.n, styles.tWait)}>{dirty ? t('не сохранено') : t('правка')}</span>
                  ) : items.length ? (
                    <span className={styles.n}>{items.length}{items.some((r) => !cov.byReq.get(r.id)?.length) && <span className={cx(tw.dot, tw.s6, tw.wait)} aria-label={t('есть требования без задач')} />}</span>
                  ) : null}
                </a>
                {on && items.length > 0 && editing !== i && (
                  <div className={styles.frs}>
                    {items.map((r) => (
                      <a key={r.id} href={`#${reqAnchor(r.id)}`} onClick={(e) => { e.preventDefault(); scrollToAnchor(reqAnchor(r.id)); }}>
                        {r.id}
                        <span className={styles.tx}>{requirementShort(r.text, 28)}</span>
                        {!cov.byReq.get(r.id)?.length && <span className={cx(tw.dot, tw.s6, tw.wait)} aria-label={t('без задач')} />}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {isPrd && cov.total > 0 && (
            <div className={styles.cov}>
              <span>{cov.text}</span>
              {cov.missingText && <span className={styles.tWait}>{cov.missingText}</span>}
            </div>
          )}
        </nav>

        <article className={styles.doc} ref={article} aria-label={t('Документ {file}', { file: name })}>
          <div className={styles.dhead}>
            <span className={styles.meta}>{docHeadLine(doc, team.memberList)}</span>
            <span className={styles.grow} />
            {!readonly && !edit && <span className={styles.hint}>{t('Нажмите на раздел, чтобы править')}</span>}
            {actions}
          </div>
          {edit && editing < 0 && <OrphanEdit team={team.slug} project={project.slug} name={name} repeated={lost} />}
          {sections.map((s, i) =>
            i === editing && edit ? (
              <div key={`edit:${edit.heading}`} id={sectionAnchor(i)} data-sec={i}>
                <SectionEditor
                  team={team.slug}
                  project={project.slug}
                  name={name}
                  doc={doc}
                  edit={edit}
                  byReq={cov.byReq}
                  tasks={tasks}
                  files={files}
                  agent={agent && !readonly}
                  onClosed={() => undefined}
                />
              </div>
            ) : (
              <SectionRead
                key={i}
                index={i}
                section={s}
                isPrd={isPrd}
                team={team}
                project={project}
                byReq={cov.byReq}
                editable={!readonly && !repeated.has(i)}
                repeatOf={!readonly && repeated.has(i) ? docFile(name) : undefined}
                onEdit={() => void openEdit(s.heading)}
                onCreate={(id, text) => setCreating({ id, text })}
              />
            ),
          )}
          {!sections.length && <p className={styles.hint}>{t('Документ пуст.')}</p>}
        </article>
      </div>
      {creating && <CreateTaskDialog team={team.slug} project={project.slug} req={creating} onClose={() => setCreating(null)} />}
    </RefCtx.Provider>
  );
}

type ReadProps = {
  index: number;
  section: DocSection;
  isPrd: boolean;
  team: TeamDetail;
  project: TeamProject;
  byReq: Map<string, TeamTask[]>;
  editable: boolean;
  /** Повтор заголовка: на месте не правится; значение — файл документа для подсказки. */
  repeatOf?: string;
  onEdit: () => void;
  onCreate: (id: string, text: string) => void;
};

/** Раздел для чтения: заголовок с «Править», куски markdown и строки требований. Клик по тексту (не по ссылке) — править. */
function SectionRead({ index, section, isPrd, team, project, byReq, editable, repeatOf, onEdit, onCreate }: ReadProps) {
  const { notify } = useConfirm();
  const chunks = useMemo(() => readChunks(section.body, isPrd && Boolean(section.heading)), [section.body, isPrd, section.heading]);
  const click = (e: MouseEvent) => {
    if (!editable) return;
    if ((e.target as Element).closest('a, button, input, textarea, summary, [role="link"]')) return;
    if (window.getSelection()?.toString()) return;
    onEdit();
  };
  return (
    <section className={cx(styles.sec, editable && styles.editable)} id={sectionAnchor(index)} data-sec={index} onClick={click} aria-label={section.heading || undefined}>
      {section.heading ? (
        <div className={styles.row}>
          <span className={styles.sp} />
          <div className={styles.sh}>
            <h2>{section.heading}</h2>
            {editable && <button type="button" className={cx('btn ghost small', styles.ed)} onClick={onEdit}>{t('Править')}</button>}
            {repeatOf && (
              // кнопка, а не подсказка в title: объяснение доступно с клавиатуры и экранному диктору
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => void notify(t('Заголовок «{section}» в документе не один: на месте правится только первый такой раздел. Переименуйте повтор в {file}, чтобы править и его.', { section: section.heading, file: repeatOf }))}
              >
                {t('повтор заголовка — не правится здесь')}
              </button>
            )}
          </div>
          {isPrd && chunks.some((c) => c.kind === 'reqs') ? <span className={styles.mg} style={{ paddingTop: 40 }}><span className={styles.cap}>{t('задачи')}</span></span> : <span className={styles.sp} />}
        </div>
      ) : (
        <div className={cx(styles.row, styles.lead)}>
          <span className={styles.sp} />
          <div>{editable && <button type="button" className={cx('btn ghost small', styles.ed)} style={{ float: 'right' }} onClick={onEdit}>{t('Править')}</button>}</div>
          <span className={styles.sp} />
        </div>
      )}
      {chunks.map((c, k) =>
        c.kind === 'md' ? (
          <div key={k} className={styles.row}>
            <span className={styles.sp} />
            <DocText text={c.text} />
            <span className={styles.sp} />
          </div>
        ) : (
          <div key={k} className={styles.reqs}>
            {c.rows.map((r) => {
              const linked = byReq.get(r.id) ?? [];
              return (
                <div key={r.id} className={cx(styles.row, styles.req)} id={reqAnchor(r.id)}>
                  <a className={styles.rid} href={`#${reqAnchor(r.id)}`} onClick={(e) => { e.preventDefault(); scrollToAnchor(reqAnchor(r.id)); }}>{r.id}</a>
                  <DocText text={r.text} />
                  <div className={styles.mg}>
                    {linked.map((x) => {
                      const w = taskWhere(x, project.sprints, team.columns);
                      return (
                        <span key={x.id}>
                          <TaskLink id={x.id} title={x.title} />
                          <span className={cx(styles.s, w.tone === 'ok' && styles.tOk)}>{w.text}</span>
                        </span>
                      );
                    })}
                    {!linked.length && (
                      <>
                        <span className={styles.tWait}>{t('нет задач')}</span>
                        {editable && <span><button type="button" className={styles.linkBtn} onClick={() => onCreate(r.id, r.text)}>{t('Создать задачу')}</button></span>}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ),
      )}
    </section>
  );
}

/** Номер задачи на полях — открывает панель задачи поверх вкладки. */
function TaskLink({ id, title }: { id: string; title?: string }) {
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  q.set(TASK_PARAM, id);
  return <Link to={{ pathname: loc.pathname, search: `?${q.toString()}` }} title={title}>{id}</Link>;
}

/** «Создать задачу» у требования без задач: задача в бэклоге с covers, потом её панель. */
function CreateTaskDialog({ team, project, req, onClose }: { team: string; project: string; req: { id: string; text: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const loc = useLocation();
  const dlg = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(requirementShort(req.text, 100));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useReturnFocus(dlg);
  useEffect(() => {
    dlg.current?.showModal();
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const task = await createTask(team, project, { title: title.trim(), covers: [req.id], type: 'feature' });
      await qc.invalidateQueries({ queryKey: teamKeys.tasks(team, project) });
      onClose();
      const q = new URLSearchParams(loc.search);
      q.set(TASK_PARAM, task.id);
      void navigate({ pathname: loc.pathname, search: `?${q.toString()}` });
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dlg}
      className={tw.dlg}
      aria-labelledby="tw-req-task"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form method="dialog" className={tw.dlgBody} onSubmit={(e) => void submit(e)}>
        <h2 id="tw-req-task"><span className={tw.id}>{req.id}</span>{t('Задача по требованию')}</h2>
        <p>{req.text}</p>
        <div className={tw.f}>
          <label htmlFor="tw-req-task-title">{t('Заголовок задачи')}</label>
          <input id="tw-req-task-title" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
        </div>
        <span className={tw.meta}>{t('Задача ляжет в бэклог и будет закрывать {id}', { id: req.id })}</span>
        {err && <p className="msg err">{err}</p>}
        <div className={tw.foot}>
          <span className={tw.grow} />
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>{t('Отмена')}</button>
          <button type="submit" className="btn primary" disabled={busy || !title.trim()}>{busy ? t('Создаю…') : t('Создать задачу')}</button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * Раздел, который правили, исчез из документа (его переименовали или удалили, документ перечитался) или его заголовок
 * повторился (repeated): правка не пропадает молча — её текст виден, его можно скопировать или бросить.
 */
function OrphanEdit({ team, project, name, repeated }: { team: string; project: string; name: TeamDocName; repeated: boolean }) {
  const edit = useEdit(team, project, name);
  const [copied, setCopied] = useState(false);
  if (!edit) return null;
  const text = editBody(edit, serializeRequirementRows);
  return (
    <div className={styles.orphan} role="alert">
      <h3>
        {repeated
          ? t('Заголовок «{section}» теперь в документе не один: не понять, какой раздел вы правили, на месте правка не сохранится. Ваша несохранённая правка:', { section: sectionName(edit.heading) })
          : t('Раздела «{section}» больше нет в документе: его переименовали или удалили. Ваша несохранённая правка:', { section: sectionName(edit.heading) })}
      </h3>
      <pre>{text}</pre>
      <div className={styles.go}>
        <button
          type="button"
          className="btn small"
          onClick={() => void navigator.clipboard?.writeText(`${edit.headLine ? `${edit.headLine}\n\n` : ''}${text}`).then(() => setCopied(true), () => setCopied(false))}
        >
          {copied ? t('Скопировано') : t('Скопировать')}
        </button>
        <button type="button" className="btn small ghost" onClick={() => setEdit(team, project, name, undefined)}>{t('Бросить правку')}</button>
      </div>
    </div>
  );
}
