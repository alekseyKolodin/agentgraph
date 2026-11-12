// Черновик агента прямо в документе режимом правок (spec §9.3, макет Prd): удалённое зачёркнуто, добавленное подсвечено,
// новое требование помечено «новое»; у каждой правки на полях причина из notes.json, «Принять» и «Отклонить». Разделы без
// правок свёрнуты, в оглавлении — число нерешённых. Наверху задание, «решено N из M», переходы, «Принять остальные»,
// «Документ / Исходник», «Отклонить черновик», «Записать принятые». Документ поменяли после старта — правки на чужих
// изменениях помечены конфликтом и принимаются только вручную; принятые сливаются с текущей версией (merge3). Решения
// и записанные правки помнит браузер (localStorage по запуску), нерешённые остаются — к ним можно вернуться.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDetail, TeamDocName, TeamDraftDetail, TeamProject } from '@server/api-types';
import { ApiError, errorText } from '../../../api';
import { teamKeys } from '../../../api/teamwork';
import { useConfirm } from '../../../components/ConfirmDialog';
import { useToast } from '../../../components/Toast';
import { plural, t } from '../../../lib/i18n';
import { LS } from '../../../lib/storage';
import { draftResult, draftRunning, reqAnchor, sectionAnchor, sectionName } from '../../../lib/teamwork/doc-view';
import { docLabel } from '../../../lib/teamwork/docs';
import {
  acceptRest, applyDecisions, decisionText, draftTitle, editLabel, foldText, lineDiff, markConflicts, stepEdit, trackChanges, type Decision, type Decisions, type TrackEdit,
  type TrackRow, type TrackSection, type WordSeg,
} from '../../../lib/teamwork/track';
import { Loading } from '../../sessions/Loading';
import { cx } from '../parts';
import { acceptDraft, draftKeys, useDraft } from './api';
import { DocText, RefCtx, scrollToAnchor } from './DocText';
import styles from './Docs.module.css';

/** Что браузер помнит о черновике документа: решения, записанные правки, закрыт ли черновик. */
export type DraftMemory = { d: Decisions; w: string[]; x?: boolean };
const memKey = (run: string, doc: string) => `agentgraph.teamwork.draft.${run}.${doc}`;
export const readMemory = (run: string, doc: string): DraftMemory => LS.get<DraftMemory>(memKey(run, doc), { d: {}, w: [] });
export const writeMemory = (run: string, doc: string, m: DraftMemory) => LS.set(memKey(run, doc), m);

type Props = { team: TeamDetail; project: TeamProject; name: TeamDocName; run: string; onClose: () => void; onRetry?: (d: TeamDraftDetail) => void };

export function DraftReview({ team, project, name, run, onClose, onRetry }: Props) {
  const q = useDraft(team.slug, project.slug, run);
  if (q.isPending) return <Loading className={styles.lead} />;
  if (q.isError) {
    return (
      <div className={styles.empty} role="alert">
        <h2>{t('Черновик не открылся')}</h2>
        <p>{errorText(q.error)}</p>
        <div className={styles.go}><button type="button" className="btn" onClick={onClose}>{t('← К документу')}</button></div>
      </div>
    );
  }
  return <Review team={team} project={project} name={name} detail={q.data} onClose={onClose} onRetry={onRetry} />;
}

function Review({ team, project, name, detail, onClose, onRetry }: { team: TeamDetail; project: TeamProject; name: TeamDocName; detail: TeamDraftDetail; onClose: () => void; onRetry?: (d: TeamDraftDetail) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { askConfirm } = useConfirm();
  const run = detail.run;
  const doc = detail.documents?.find((d) => d.name === name);
  const [mem, setMem] = useState<DraftMemory>(() => readMemory(run, name));
  const [cur, setCur] = useState<string | undefined>();
  const [view, setView] = useState<'doc' | 'src'>('doc');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [showTheirs, setShowTheirs] = useState(false);
  const save = (m: DraftMemory) => {
    setMem(m);
    writeMemory(run, name, m);
  };
  const running = draftRunning(detail.status);

  const model = useMemo(() => {
    if (!doc) return undefined;
    const tr = trackChanges(doc.base, doc.next, detail.notes ?? [], mem.d, name);
    const written = new Set(mem.w);
    // своя прошлая запись — не «чужие изменения»: документ сейчас равен базе с записанными правками
    const own = applyDecisions(doc.base, doc.next, Object.fromEntries(mem.w.map((id) => [id, 'accept' as const])));
    const byOthers = doc.moved && doc.current.trimEnd() !== own.trimEnd();
    const conflicts = new Set(byOthers ? markConflicts(tr.edits, doc.current).filter((e) => e.conflict && !written.has(e.id)).map((e) => e.id) : []);
    return { tr, written, byOthers, conflicts };
  }, [doc, detail.notes, mem, name]);

  useEffect(() => {
    if (!cur) return;
    document.getElementById(`edit-${cur}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [cur]);

  if (!doc || !model) {
    return (
      <div className={styles.empty} role="alert">
        <h2>{detail.error ? t('Черновик не читается') : t('В черновике нет документа «{doc}»', { doc: docLabel(name) })}</h2>
        {detail.error && <p>{detail.error}</p>}
        <div className={styles.go}>
          <Link className="btn" to={`/run/${encodeURIComponent(run)}`}>{t('Открыть запуск')}</Link>
          {detail.error && onRetry && <button type="button" className="btn" onClick={() => onRetry(detail)}>{t('Повторить черновик')}</button>}
          <button type="button" className="btn ghost" onClick={onClose}>{t('← К документу')}</button>
        </div>
      </div>
    );
  }
  const { tr, written, byOthers, conflicts } = model;
  const edits = tr.edits;
  const decide = (id: string, d: Decision | undefined) => {
    const next = { ...mem.d };
    if (d) next[id] = d;
    else delete next[id];
    save({ ...mem, d: next });
    setCur(id);
  };
  const pending = edits.filter((e) => mem.d[e.id] === 'accept' && !written.has(e.id));
  const unresolved = edits.filter((e) => !mem.d[e.id]).length;

  const write = async () => {
    if (!pending.length || busy) return;
    setBusy(true);
    setNotice('');
    const accepted: Decisions = Object.fromEntries(Object.entries(mem.d).filter(([, v]) => v === 'accept'));
    const written: Decisions = Object.fromEntries(mem.w.map((id) => [id, 'accept' as const]));
    const r = draftResult(doc, accepted, written);
    if (r.gone) {
      setNotice(t('Документ удалили из репо после старта черновика: записывать некуда.'));
      setBusy(false);
      return;
    }
    // запись заменит чьи-то правки, сделанные после старта черновика, — только с явного согласия
    if (r.lost.length) {
      const list = r.lost.map((x) => `«${x.length > 120 ? `${x.slice(0, 120)}…` : x}»`).join('\n');
      if (!(await askConfirm(t('Запись заменит правки, сделанные в документе после старта черновика:\n{list}\nЗаписать всё равно?', { list }), { ok: t('Записать'), danger: true }))) {
        setBusy(false);
        return;
      }
    }
    try {
      const res = await acceptDraft(team.slug, project.slug, run, { doc: doc.name, text: r.text, base: r.base });
      if ('name' in res) qc.setQueryData(teamKeys.doc(team.slug, project.slug, name), res);
      const m: DraftMemory = { ...mem, w: [...new Set([...mem.w, ...pending.map((e) => e.id)])] };
      const left = edits.filter((e) => !m.d[e.id]).length;
      if (!left) m.x = true;
      save(m);
      void qc.invalidateQueries({ queryKey: teamKeys.project(team.slug, project.slug) });
      toast(t('Записано: {n} {w}', { n: pending.length, w: plural(pending.length, 'правка', 'правки', 'правок') }));
      if (!left) onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'conflict') {
        setNotice(t('Документ успели изменить, пока вы решали. Правки пересчитаны на свежую версию: проверьте конфликты и запишите ещё раз.'));
        setShowTheirs(true);
        await qc.invalidateQueries({ queryKey: draftKeys.one(team.slug, project.slug, run) });
      } else if (e instanceof ApiError && e.status === 409 && e.code === 'busy') setNotice(t('Черновик ещё идёт: дождитесь конца запуска.'));
      else setNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    if (!(await askConfirm(t('Отклонить черновик? В документ ничего не попадёт; запуск останется в списке запусков.'), { ok: t('Отклонить черновик'), danger: true }))) return;
    save({ ...mem, x: true });
    onClose();
  };
  const go = (dir: 1 | -1) => {
    const e = stepEdit(edits, cur, dir);
    if (!e) return;
    setOpen((s) => new Set(s).add(e.section));
    setCur(e.id);
  };
  const minutes = detail.finishedAt ? Math.max(1, Math.round((Date.parse(detail.finishedAt) - Date.parse(detail.startedAt)) / 60000)) : 0;

  return (
    <RefCtx.Provider value={{ team: team.slug, project: project.slug, doc: name, prefix: team.prefix }}>
      <section className={styles.draft} aria-label={t('Черновик агента')}>
        <div className={styles.draftH}>
          <h2>{edits.length ? draftTitle(edits.length) : t('Черновик агента без правок')}</h2>
          <span className={styles.meta}>{[detail.flow, detail.section !== undefined ? t('раздел «{section}»', { section: sectionName(detail.section) }) : '', minutes ? t('{n} мин', { n: minutes }) : '', running ? t('ещё идёт') : ''].filter(Boolean).join(' · ')}</span>
          <span className={styles.grow} />
          <Link to={`/run/${encodeURIComponent(run)}`}>{t('Открыть запуск')}</Link>
        </div>
        {detail.brief && <p className={styles.brief2}><b>{t('Задание')}</b>{detail.brief}</p>}
        {doc.dropped?.length ? <p className={styles.warn}>{t('Агент правил не только раздел «{section}»: правки в {list} отброшены.', { section: sectionName(detail.section ?? ''), list: doc.dropped.map((h) => `«${h}»`).join(', ') })}</p> : null}
        {(detail.warnings ?? []).map((w) => <p key={w} className={styles.warn}>{w}</p>)}
        {byOthers && <p className={styles.warn}>{conflicts.size ? t('Документ поменяли после старта черновика: {n} {w} на изменённых местах — принимаются только вручную.', { n: conflicts.size, w: plural(conflicts.size, 'правка', 'правки', 'правок') }) : t('Документ поменяли после старта черновика; принятые правки сольются с текущей версией.')} <button type="button" className={styles.linkBtn} onClick={() => setShowTheirs((v) => !v)}>{showTheirs ? t('Скрыть') : t('Что изменили')}</button></p>}
        {notice && <p className={styles.warn} role="alert">{notice}</p>}
        <div className={styles.draftF}>
          {edits.length > 0 && (
            <span className={styles.prog}>
              <span className={styles.pbar} role="img" aria-label={tr.progress}>
                {edits.map((e) => <i key={e.id} className={cx(mem.d[e.id] === 'accept' && styles.ok, mem.d[e.id] === 'reject' && styles.no)} />)}
              </span>
              <span className={styles.meta}>{tr.progress}</span>
            </span>
          )}
          <span className={styles.nav2}>
            <button type="button" className="btn ghost small" aria-label={t('Предыдущая правка')} title={t('Предыдущая правка')} disabled={!edits.length} onClick={() => go(-1)}>↑</button>
            <button type="button" className="btn ghost small" aria-label={t('Следующая правка')} title={t('Следующая правка')} disabled={!edits.length} onClick={() => go(1)}>↓</button>
          </span>
          <button type="button" className="btn small" disabled={!unresolved || running} title={conflicts.size ? t('Конфликтные правки — только вручную') : undefined} onClick={() => save({ ...mem, d: acceptRest(edits.filter((e) => !conflicts.has(e.id)), mem.d) })}>{t('Принять остальные')}</button>
          <span className={styles.seg} role="group" aria-label={t('Вид')}>
            <button type="button" className={cx(view === 'doc' && styles.on)} aria-pressed={view === 'doc'} onClick={() => setView('doc')}>{t('Документ')}</button>
            <button type="button" className={cx(view === 'src' && styles.on)} aria-pressed={view === 'src'} onClick={() => setView('src')}>{t('Исходник')}</button>
          </span>
          <span className={styles.grow} />
          <button type="button" className="btn ghost" onClick={() => void reject()}>{t('Отклонить черновик')}</button>
          <button type="button" className="btn primary" disabled={!pending.length || busy || running} title={running ? t('Черновик ещё идёт') : undefined} onClick={() => void write()}>
            {busy ? t('Записываю…') : t('Записать принятые · {n}', { n: pending.length })}
          </button>
        </div>
      </section>

      {showTheirs && byOthers && (
        <div className={styles.lead}>
          <p className={styles.sub}>{t('Что изменили в репо после старта черновика')}</p>
          <Diff a={doc.base} b={doc.current} />
        </div>
      )}

      {view === 'src' ? (
        <Diff a={doc.base} b={doc.next} />
      ) : !edits.length ? (
        <div className={styles.empty}>
          <p>{running ? t('Агент ещё пишет: правки появятся, когда он сохранит документ.') : t('Агент ничего не поменял в документе.')}</p>
          <div className={styles.go}><button type="button" className="btn" onClick={onClose}>{t('← К документу')}</button></div>
        </div>
      ) : (
        <div className={styles.wrap}>
          <nav className={styles.toc} aria-label={t('Содержание с правками')}>
            <span className={styles.cap}>{t('Содержание')}</span>
            {tr.sections.map((s, i) =>
              s.heading ? (
                <a key={i} href={`#${sectionAnchor(i)}`} className={cx(!s.edits.length && styles.dim, s.edits.some((e) => e.id === cur) && styles.on)} onClick={(e) => {
                  e.preventDefault();
                  setOpen((o) => new Set(o).add(s.heading));
                  setTimeout(() => scrollToAnchor(sectionAnchor(i)), 0);
                }}>
                  <span>{s.heading}</span>
                  {s.unresolved > 0 && <span className={styles.n}><span className={styles.chg} />{s.unresolved < s.edits.length ? t('{n} из {total}', { n: s.unresolved, total: s.edits.length }) : s.unresolved}</span>}
                </a>
              ) : null,
            )}
          </nav>
          <article className={styles.doc} aria-label={t('{doc} с правками агента', { doc: docLabel(name) })}>
            {groupSections(tr.sections, open).map((g, k) =>
              g.kind === 'fold' ? (
                <div key={k} className={styles.fold}>
                  <span>{foldText(g.sections.map((s) => sectionName(s.section.heading)))}</span>
                  <button type="button" onClick={() => setOpen((o) => new Set([...o, ...g.sections.map((s) => s.section.heading)]))}>{t('Показать')}</button>
                </div>
              ) : (
                <ReviewSection
                  key={k}
                  index={g.index}
                  section={g.section}
                  total={edits.length}
                  decisions={mem.d}
                  written={written}
                  conflicts={conflicts}
                  cur={cur}
                  locked={running}
                  onDecide={decide}
                />
              ),
            )}
          </article>
        </div>
      )}
    </RefCtx.Provider>
  );
}

type Group = { kind: 'fold'; sections: { section: TrackSection; index: number }[] } | { kind: 'section'; section: TrackSection; index: number };

/** Разделы без правок подряд сворачиваются одной строкой, пока их не раскрыли. */
function groupSections(sections: readonly TrackSection[], open: ReadonlySet<string>): Group[] {
  const out: Group[] = [];
  sections.forEach((section, index) => {
    if (section.edits.length || open.has(section.heading)) {
      out.push({ kind: 'section', section, index });
      return;
    }
    const last = out[out.length - 1];
    if (last?.kind === 'fold') last.sections.push({ section, index });
    else out.push({ kind: 'fold', sections: [{ section, index }] });
  });
  return out;
}

type SectionProps = {
  index: number;
  section: TrackSection;
  total: number;
  decisions: Decisions;
  written: ReadonlySet<string>;
  conflicts: ReadonlySet<string>;
  cur: string | undefined;
  locked: boolean;
  onDecide: (id: string, d: Decision | undefined) => void;
};

function ReviewSection({ index, section, total, decisions, written, conflicts, cur, locked, onDecide }: SectionProps) {
  const rows = section.rows.filter((r) => !(r.kind === 'same' && r.block === 'heading' && r.level === 2));
  return (
    <section id={sectionAnchor(index)} data-sec={index}>
      {section.heading && (
        <div className={styles.row}>
          <span className={styles.sp} />
          <div className={styles.sh}><h2>{section.heading}</h2></div>
          <span className={styles.sp} />
        </div>
      )}
      {rows.map((r, i) =>
        r.kind === 'same' ? (
          <SameRow key={i} row={r} />
        ) : (
          <EditRow
            key={r.edit.id}
            edit={r.edit}
            total={total}
            decision={decisions[r.edit.id]}
            written={written.has(r.edit.id)}
            conflict={conflicts.has(r.edit.id)}
            current={cur === r.edit.id}
            locked={locked}
            onDecide={onDecide}
          />
        ),
      )}
    </section>
  );
}

function SameRow({ row }: { row: Extract<TrackRow, { kind: 'same' }> }) {
  if (row.requirement) {
    return (
      <div className={cx(styles.row, styles.req)} id={reqAnchor(row.requirement)}>
        <span className={styles.rid}>{row.requirement}</span>
        <DocText text={row.content} />
        <span className={styles.sp} />
      </div>
    );
  }
  return (
    <div className={styles.row}>
      <span className={styles.sp} />
      <DocText text={row.text} />
      <span className={styles.sp} />
    </div>
  );
}

/** Пословный дифф: удалённое зачёркнуто, добавленное подсвечено. */
const Words = ({ words }: { words: readonly WordSeg[] }) => (
  <>
    {words.map((w, i) => (
      <span key={i}>
        {i > 0 && ' '}
        {w.kind === 'del' ? <del className={styles.d}>{w.text}</del> : w.kind === 'ins' ? <ins className={styles.i}>{w.text}</ins> : w.text}
      </span>
    ))}
  </>
);

/** Метка блока перед текстом правки: пункт списка, заголовок. */
const blockMark = (e: TrackEdit): string => (e.block === 'item' ? '• ' : e.block === 'heading' ? '## ' : '');

function EditRow({ edit, total, decision, written, conflict, current, locked, onDecide }: {
  edit: TrackEdit; total: number; decision: Decision | undefined; written: boolean; conflict: boolean; current: boolean; locked: boolean; onDecide: (id: string, d: Decision | undefined) => void;
}) {
  const body: ReactNode =
    edit.kind === 'changed' && edit.words ? <Words words={edit.words} /> : edit.kind === 'added' ? <ins className={styles.i}>{edit.nextContent ?? edit.next}</ins> : <del className={styles.d}>{edit.oldContent ?? edit.old}</del>;
  const label = decisionText(decision);
  return (
    <div id={`edit-${edit.id}`} className={cx(styles.row, styles.erow2, edit.requirement && styles.req, edit.kind === 'added' && styles.added, edit.kind === 'removed' && styles.removed)}>
      {edit.requirement ? (
        <span className={styles.rid}>{edit.requirement}{edit.kind === 'added' && <span className={styles.newMark}>{t('новое')}</span>}</span>
      ) : (
        <span className={styles.sp} />
      )}
      <div className={cx(styles.rd, edit.block === 'code' && styles.plain)} style={{ whiteSpace: edit.block === 'code' || edit.block === 'other' ? 'pre-wrap' : undefined }}>
        {blockMark(edit) && <span className={styles.hint}>{blockMark(edit)}</span>}
        {body}
      </div>
      <div className={cx(styles.cc, current && styles.cur, decision === 'accept' && styles.done, decision === 'reject' && styles.rej, conflict && !decision && styles.clash2)} aria-label={t('Правка {label}', { label: editLabel(edit, total) })}>
        <span className={styles.n}>
          {editLabel(edit, total)}
          {label && <> · <span className={decision === 'accept' ? styles.tOk : undefined}>{label}</span></>}
          {written && <> · {t('записано')}</>}
        </span>
        {edit.why && <span className={styles.why}>{edit.why}</span>}
        {conflict && !written && <span className={styles.tWait}>{t('Это место поменяли после старта черновика: принять — значит заменить чужую правку.')}</span>}
        <span className={styles.acts}>
          {written ? null : decision ? (
            <button type="button" className="btn ghost small" disabled={locked} onClick={() => onDecide(edit.id, undefined)}>{t('Отменить')}</button>
          ) : (
            <>
              <button type="button" className="btn small" disabled={locked} onClick={() => onDecide(edit.id, 'accept')}>{conflict ? t('Принять вручную') : t('Принять')}</button>
              <button type="button" className="btn ghost small" disabled={locked} onClick={() => onDecide(edit.id, 'reject')}>{t('Отклонить')}</button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/** Построчный дифф; длинные куски без изменений свёрнуты до трёх строк контекста. */
export function Diff({ a, b }: { a: string; b: string }) {
  const lines = useMemo(() => lineDiff(a, b), [a, b]);
  const CONTEXT = 3;
  const keep = lines.map((l, i) => l.kind !== 'same' || lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.kind !== 'same'));
  const out: ReactNode[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (!keep[i]) {
      skipped++;
      return;
    }
    if (skipped) {
      out.push(<div key={`s${i}`} className={styles.skip}>{t('… {n} {w} без изменений', { n: skipped, w: plural(skipped, 'строка', 'строки', 'строк') })}</div>);
      skipped = 0;
    }
    out.push(<div key={i} className={styles[l.kind]}>{l.text}</div>);
  });
  if (skipped) out.push(<div key="end" className={styles.skip}>{t('… {n} {w} без изменений', { n: skipped, w: plural(skipped, 'строка', 'строки', 'строк') })}</div>);
  if (!lines.some((l) => l.kind !== 'same')) return <p className={styles.hint}>{t('Без изменений.')}</p>;
  return <div className={styles.diff} role="region" aria-label={t('Построчный дифф')}>{out}</div>;
}
