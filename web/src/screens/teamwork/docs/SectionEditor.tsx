// Правка одного раздела на месте (spec §8.4, макет PrdEdit): панель «Ж К <> #», «С агентом…», «Текст / Markdown»;
// текст — CodeMirror с живой разметкой, требования — строками (номер закреплён, текст правится, перетаскивание и ⌥↑ ⌥↓,
// × удаляет, «+ Требование» — следующий номер, удалённые номера не возвращаются). «Сохранить раздел» (⌘S) шлёт раздел
// с хэшем на начало правки, Esc отменяет; 409 — обе версии рядом. Правка живёт в edits.ts и переживает уход с вкладки.
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDoc, TeamDocName, TeamTask } from '@server/api-types';
import { ApiError, errorText } from '../../../api';
import { saveDoc, teamKeys } from '../../../api/teamwork';
import { useConfirm } from '../../../components/ConfirmDialog';
import { useToast } from '../../../components/Toast';
import { t } from '../../../lib/i18n';
import { lastIssued, reqKindFor, rowChanges, sectionName, wrapMark } from '../../../lib/teamwork/doc-view';
import {
  addRequirementRow, addRequirementText, changesText, docFile, moveRequirementRow, parseRequirementRows, removeRequirementRow, requirementShort, sectionCommitMessage,
  serializeRequirementRows, splitSections, type ReqRow, type ReqSectionParts,
} from '../../../lib/teamwork/docs';
import { trackChanges } from '../../../lib/teamwork/track';
import { cx } from '../parts';
import { AgentAsk, type DraftDoc } from './AgentAsk';
import { DocText } from './DocText';
import { editBody, isDirty, patchEdit, setEdit, type SectionEdit } from './edits';
import { MdEditor, type EditTarget } from './MdEditor';
import styles from './Docs.module.css';

type Props = {
  team: string;
  project: string;
  name: TeamDocName;
  doc: TeamDoc;
  edit: SectionEdit;
  /** Задачи по требованию: видны рядом со строкой, не правятся. */
  byReq: Map<string, TeamTask[]>;
  tasks: readonly TeamTask[];
  /** Файлы документов проекта для ссылки «#». */
  files: readonly string[];
  /** Черновики с агентом доступны (ТЗ, архитектура, дизайн, не только чтение). */
  agent: boolean;
  onClosed: () => void;
};

const ser = serializeRequirementRows;

/** Новая правка раздела документа: тело, строки требований (у ТЗ), хэш раздела для проверки параллельной правки. */
export function startEdit(doc: TeamDoc, heading: string, withReqs: boolean): SectionEdit | undefined {
  const sec = splitSections(doc.text).find((s) => s.heading === heading);
  if (!sec) return undefined;
  const hash = doc.sections.find((s) => s.heading === heading)?.hash ?? '';
  const headLine = heading ? doc.text.replace(/\r\n?/g, '\n').split('\n')[sec.start]! : '';
  // пустые строки вокруг текста раздела в редакторе не нужны: при сохранении после заголовка ставится одна
  const body = sec.body.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  const parts = withReqs ? parseRequirementRows(body) : undefined;
  return { heading, hash, headLine, original: body, body, mode: 'text', ...(parts ? { rows: parts, originalRows: parts } : {}) };
}

export function SectionEditor({ team, project, name, doc, edit, byReq, tasks, files, agent, onClosed }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { askConfirm } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [seq, setSeq] = useState(0);
  const target = useRef<EditTarget | null>(null);
  const box = useRef<HTMLElement>(null);
  const patch = (p: Partial<SectionEdit>) => patchEdit(team, project, name, p);
  const dirty = isDirty(edit, ser);
  const reqMode = edit.mode === 'text' && Boolean(edit.rows);
  const message = `${project}: ${sectionCommitMessage(name, sectionName(edit.heading))}`;

  const changes = useMemo(() => {
    if (!dirty) return 0;
    if (reqMode && edit.rows && edit.originalRows) {
      const text = (p: ReqSectionParts) => [...p.intro, '\u0000', ...p.outro].join('\n').trim();
      return rowChanges(edit.originalRows.rows, edit.rows.rows) + (text(edit.rows) !== text(edit.originalRows) ? 1 : 0) || 1;
    }
    return trackChanges(edit.originalRows ? ser(edit.originalRows) : edit.original, editBody(edit, ser)).total || 1;
  }, [edit, dirty, reqMode]);

  // при открытии раздел виден целиком
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  const cancel = async () => {
    if (busy) return;
    if (dirty && !(await askConfirm(t('Бросить правку раздела «{section}»? Изменения пропадут.', { section: sectionName(edit.heading) }), { ok: t('Бросить'), danger: true }))) return;
    setEdit(team, project, name, undefined);
    onClosed();
  };

  const save = async (hash = edit.hash) => {
    if (busy) return;
    if (!dirty) {
      setEdit(team, project, name, undefined);
      onClosed();
      return;
    }
    setBusy(true);
    setErr('');
    const body = editBody(edit, ser).replace(/^(?:[ \t]*\n)+/, '').trimEnd();
    const text = edit.headLine ? `${edit.headLine}\n${body ? `\n${body}\n` : ''}` : `${body}\n`;
    try {
      const r = await saveDoc(team, project, name, { text, section: edit.heading, ...(hash ? { hash } : {}), message });
      qc.setQueryData(teamKeys.doc(team, project, name), r);
      void qc.invalidateQueries({ queryKey: teamKeys.project(team, project), exact: true });
      void qc.invalidateQueries({ queryKey: teamKeys.history(team, project).slice(0, 6) });
      setEdit(team, project, name, undefined);
      onClosed();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data && typeof e.data === 'object' && 'current' in e.data) {
        const current = (e.data as { current: TeamDoc }).current;
        qc.setQueryData(teamKeys.doc(team, project, name), current);
        const sec = splitSections(current.text).find((s) => s.heading === edit.heading);
        patch({ theirs: { text: sec?.body ?? '', hash: current.sections.find((s) => s.heading === edit.heading)?.hash ?? '' } });
      } else if (e instanceof ApiError && e.status === 404) {
        setErr(t('Раздела «{section}» больше нет в документе: его удалили или переименовали. Скопируйте свой текст и откройте документ заново.', { section: sectionName(edit.heading) }));
      } else setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // ⌘S и Esc редактора CodeMirror и строк требований уже обработаны там (defaultPrevented)
  const keys = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void cancel();
    }
  };

  const toggleMode = (mode: SectionEdit['mode']) => {
    if (mode === edit.mode) return;
    if (edit.originalRows) {
      // раздел требований: «Markdown» — исходник из строк, обратно — строки из исходника
      if (mode === 'md') patch({ mode, body: ser(edit.rows ?? edit.originalRows) });
      else patch({ mode, rows: parseRequirementRows(edit.body) });
      setSeq((n) => n + 1);
    } else patch({ mode });
  };

  // требования: следующий номер — с учётом выданных раньше и добавленных в этой правке
  const kind = reqKindFor(edit.heading, edit.rows?.rows ?? []);
  const nextId = edit.rows ? addRequirementRow(edit.rows, kind, doc.requirements ?? [], lastIssued(doc.nextRequirement, kind)).id : '';

  return (
    <section ref={box} className={styles.edit} aria-label={t('Правка раздела «{section}»', { section: sectionName(edit.heading) })} onKeyDown={keys}>
      <div className={styles.etb} role="toolbar" aria-label={t('Форматирование')}>
        <span className={styles.h}>{sectionName(edit.heading)}</span>
        <button type="button" className={styles.tb} aria-label={t('Жирный')} title={t('Жирный · ⌘B')} onMouseDown={(e) => e.preventDefault()} onClick={() => target.current?.wrap('**')}><b>{t('Ж')}</b></button>
        <button type="button" className={styles.tb} aria-label={t('Курсив')} title={t('Курсив · ⌘I')} onMouseDown={(e) => e.preventDefault()} onClick={() => target.current?.wrap('*')}><i>{t('К')}</i></button>
        <button type="button" className={cx(styles.tb, styles.mono)} aria-label={t('Код')} title={t('Код')} onMouseDown={(e) => e.preventDefault()} onClick={() => target.current?.wrap('`')}>&lt;/&gt;</button>
        <LinkPick tasks={tasks} doc={doc} files={files} onPick={(text) => target.current?.insert(text)} />
        {agent && (
          <>
            <span className={styles.vsep} />
            <AgentAsk
              team={team}
              project={project}
              doc={name as DraftDoc}
              section={edit.heading}
              buttonClass={styles.tb}
              note={dirty ? t('Агент видит раздел из репо, без вашей несохранённой правки.') : undefined}
            >
              {t('С агентом…')}
            </AgentAsk>
          </>
        )}
        <span className={styles.seg} role="group" aria-label={t('Вид правки')}>
          <button type="button" className={cx(edit.mode === 'text' && styles.on)} aria-pressed={edit.mode === 'text'} onClick={() => toggleMode('text')}>{t('Текст')}</button>
          <button type="button" className={cx(edit.mode === 'md' && styles.on)} aria-pressed={edit.mode === 'md'} onClick={() => toggleMode('md')}>Markdown</button>
        </span>
      </div>

      {edit.theirs && <Clash edit={edit} busy={busy} onMine={() => { const h = edit.theirs!.hash; patch({ theirs: undefined, hash: h }); void save(h); }} onTheirs={() => {
        const th = edit.theirs!;
        const parts = edit.originalRows ? parseRequirementRows(th.text) : undefined;
        setEdit(team, project, name, { ...edit, theirs: undefined, hash: th.hash, original: th.text, body: th.text, ...(parts ? { rows: parts, originalRows: parts, mode: 'text' } : {}) });
        setSeq((n) => n + 1);
      }} />}

      {reqMode && edit.rows ? (
        <ReqRowsEditor
          parts={edit.rows}
          original={edit.originalRows!}
          byReq={byReq}
          nextId={nextId}
          seq={seq}
          onChange={(rows) => patch({ rows })}
          onAdd={() => {
            const r = addRequirementRow(edit.rows!, kind, doc.requirements ?? [], lastIssued(doc.nextRequirement, kind));
            patch({ rows: r.parts });
            return r.id;
          }}
          onTarget={(tg) => (target.current = tg)}
          onSave={() => void save()}
          onCancel={() => void cancel()}
          intro={(text, which) => (
            <MdEditor
              key={`${which}-${seq}`}
              value={text}
              live
              label={which === 'intro' ? t('Текст перед требованиями') : t('Текст после требований')}
              onChange={(v) => patch({ rows: { ...edit.rows!, [which]: v.split('\n') } })}
              onSave={() => void save()}
              onCancel={() => void cancel()}
              onTarget={(tg) => (target.current = tg)}
            />
          )}
        />
      ) : (
        <div className={styles.ebody}>
          <MdEditor
            key={`md-${seq}`}
            value={edit.body}
            live={edit.mode === 'text'}
            label={t('Текст раздела «{section}»', { section: sectionName(edit.heading) })}
            placeholderText={t('Текст раздела в markdown')}
            autoFocus
            onChange={(body) => patch({ body })}
            onSave={() => void save()}
            onCancel={() => void cancel()}
            onTarget={(tg) => (target.current = tg)}
            ref={(tg) => {
              if (tg && !target.current) target.current = tg;
            }}
          />
        </div>
      )}

      {err && <p className="msg err" style={{ margin: '0 12px' }}>{err}</p>}
      <div className={styles.efoot}>
        <span className={styles.meta}>{dirty ? changesText(changes, message) : t('без изменений')}</span>
        <span className={styles.kbd} aria-hidden="true">Esc</span>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void cancel()}>{t('Отмена')}</button>
        <span className={styles.kbd} aria-hidden="true">⌘S</span>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? t('Сохраняю…') : t('Сохранить раздел')}</button>
      </div>
    </section>
  );
}

/** 409: раздел за время правки изменил кто-то другой — его версия и моя рядом. */
function Clash({ edit, busy, onMine, onTheirs }: { edit: SectionEdit; busy: boolean; onMine: () => void; onTheirs: () => void }) {
  const mine = editBody(edit, ser);
  return (
    <div className={styles.clash} role="alert">
      <h3>{t('Раздел «{section}» уже изменил кто-то другой, пока вы правили', { section: sectionName(edit.heading) })}</h3>
      <div className={styles.both}>
        <div>
          <span className={styles.sub}>{t('Сейчас в репо')}</span>
          <div className={styles.box}>{edit.theirs!.text.trim() ? <DocText text={edit.theirs!.text} /> : <span className={styles.hint}>{t('раздел пуст или удалён')}</span>}</div>
        </div>
        <div>
          <span className={styles.sub}>{t('Ваша версия')}</span>
          <div className={styles.box}>{mine.trim() ? <DocText text={mine} /> : <span className={styles.hint}>{t('пусто')}</span>}</div>
        </div>
      </div>
      <div className={styles.go}>
        <button type="button" className="btn small" disabled={busy || !edit.theirs!.hash} title={edit.theirs!.hash ? undefined : t('Раздела больше нет в документе')} onClick={onMine}>{t('Сохранить мою поверх')}</button>
        <button type="button" className="btn small ghost" disabled={busy} onClick={onTheirs}>{t('Взять версию из репо и править её')}</button>
      </div>
    </div>
  );
}

type RowsProps = {
  parts: ReqSectionParts;
  original: ReqSectionParts;
  byReq: Map<string, TeamTask[]>;
  nextId: string;
  seq: number;
  onChange: (p: ReqSectionParts) => void;
  onAdd: () => string;
  onTarget: (t: EditTarget) => void;
  onSave: () => void;
  onCancel: () => void;
  intro: (text: string, which: 'intro' | 'outro') => ReactNode;
};

/** Строки требований: номер закреплён, текст правится; перетаскивание за ⋮⋮ или ⌥↑ ⌥↓; × — удалить. */
function ReqRowsEditor({ parts, original, byReq, nextId, seq, onChange, onAdd, onTarget, onSave, onCancel, intro }: RowsProps) {
  const { askConfirm } = useConfirm();
  const list = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const was = useMemo(() => new Map(original.rows.map((r) => [r.id, r.text.trim()])), [original]);
  // фокус — после перерисовки строк: таймер, а не кадр (в скрытой вкладке кадры стоят)
  const focusRow = (id: string, on: 'text' | 'grip' = 'text') =>
    setTimeout(() => list.current?.querySelector<HTMLElement>(on === 'grip' ? `button[data-grip="${id}"]` : `textarea[data-id="${id}"]`)?.focus(), 0);

  const setText = (id: string, text: string) => onChange({ ...parts, rows: parts.rows.map((r) => (r.id === id ? { ...r, text: text.replace(/\s*\n\s*/g, ' ') } : r)) });
  /** Перенос строки; фокус остаётся на ней — на поле текста или на ⋮⋮, откуда переносили с клавиатуры. */
  const move = (from: number, to: number, on: 'text' | 'grip' = 'text') => {
    if (to < 0 || to >= parts.rows.length || from === to) return;
    const id = parts.rows[from]!.id;
    onChange(moveRequirementRow(parts, from, to));
    focusRow(id, on);
  };
  const remove = async (row: ReqRow) => {
    const linked = byReq.get(row.id) ?? [];
    if (linked.length && !(await askConfirm(t('На {id} ссылаются задачи {tasks}. Удалить требование? Номер больше никто не займёт.', { id: row.id, tasks: linked.map((x) => x.id).join(', ') }), { ok: t('Удалить'), danger: true }))) return;
    onChange(removeRequirementRow(parts, row.id));
  };
  const add = () => focusRow(onAdd());

  const rowTarget = (el: HTMLTextAreaElement, id: string): EditTarget => ({
    wrap: (mark) => {
      const r = wrapMark(el.value, el.selectionStart, el.selectionEnd, mark);
      setText(id, r.text);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(r.from, r.to);
      });
    },
    insert: (text) => {
      const v = el.value;
      const at = el.selectionStart;
      setText(id, v.slice(0, at) + text + v.slice(el.selectionEnd));
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(at + text.length, at + text.length);
      });
    },
    focus: () => el.focus(),
  });

  const introText = parts.intro.join('\n');
  const outroText = parts.outro.join('\n');
  return (
    <>
      {introText.trim() && <div className={styles.ebody}>{intro(introText, 'intro')}</div>}
      <div className={styles.erows} ref={list} role="list" aria-label={t('Требования раздела')}>
        {parts.rows.map((row, i) => {
          const linked = byReq.get(row.id) ?? [];
          const changed = !was.has(row.id) || was.get(row.id) !== row.text.trim();
          return (
            <div
              key={row.id}
              role="listitem"
              className={cx(styles.erow, drag === i && styles.dragging, over === i && drag !== null && drag !== i && styles.over)}
              onDragOver={(e: DragEvent) => {
                if (drag === null) return;
                e.preventDefault();
                setOver(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag !== null) move(drag, i);
                setDrag(null);
                setOver(null);
              }}
            >
              <button
                type="button"
                className={styles.grip}
                draggable
                aria-label={t('Переместить {id}', { id: row.id })}
                title={t('Перетащите или ⌥↑ ⌥↓')}
                onDragStart={(e) => {
                  setDrag(i);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', row.id);
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOver(null);
                }}
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault();
                    move(i, i + (e.key === 'ArrowUp' ? -1 : 1), 'grip');
                  }
                }}
                data-grip={row.id}
              >
                ⋮⋮
              </button>
              <span className={styles.id}>{row.id}{changed && <span className={styles.chg} aria-label={t('изменено')} title={t('изменено')} />}</span>
              <AutoText
                id={row.id}
                value={row.text}
                seq={seq}
                label={t('Текст {id}', { id: row.id })}
                onChange={(v) => setText(row.id, v)}
                onFocusEl={(el) => onTarget(rowTarget(el, row.id))}
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault();
                    move(i, i + (e.key === 'ArrowUp' ? -1 : 1));
                  } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    const next = parts.rows[i + 1];
                    if (next) focusRow(next.id);
                    else add();
                  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    e.stopPropagation();
                    onSave();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    onCancel();
                  }
                }}
              />
              <span className={cx(styles.lk, !linked.length && styles.tWait)} title={linked.map((x) => `${x.id} · ${x.title}`).join('\n') || undefined}>
                {linked.length ? linked.map((x) => x.id).join(' · ') : t('нет задач')}
              </span>
              <button type="button" className={styles.x} aria-label={t('Удалить {id}', { id: row.id })} title={t('Удалить требование')} onClick={() => void remove(row)}>×</button>
            </div>
          );
        })}
      </div>
      <div className={styles.addr}>
        <button type="button" className="btn small" onClick={add}>{addRequirementText(nextId)}</button>
        <span className={styles.hint}>{t('Номера не меняются: задачи ссылаются на них. Удалённый номер никто не займёт.')}</span>
      </div>
      {outroText.trim() && <div className={styles.ebody}>{intro(outroText, 'outro')}</div>}
    </>
  );
}

/** Поле текста требования: высота по содержимому, без переводов строки (требование — одна строка файла). */
function AutoText({ id, value, seq, label, onChange, onFocusEl, onKeyDown }: {
  id: string; value: string; seq: number; label: string; onChange: (v: string) => void; onFocusEl: (el: HTMLTextAreaElement) => void; onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const el = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const a = el.current;
    if (!a) return;
    a.style.height = 'auto';
    a.style.height = `${a.scrollHeight}px`;
  }, [value, seq]);
  return (
    <textarea
      ref={el}
      data-id={id}
      rows={1}
      value={value}
      aria-label={label}
      placeholder={t('Текст требования')}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => onFocusEl(e.currentTarget)}
      onKeyDown={onKeyDown}
    />
  );
}

/** «#»: вставить номер задачи, требования или путь документа — в тексте он станет ссылкой. */
function LinkPick({ tasks, doc, files, onPick }: { tasks: readonly TeamTask[]; doc: TeamDoc; files: readonly string[]; onPick: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const needle = q.trim().toLowerCase();
  const hit = (...s: string[]) => !needle || s.some((x) => x.toLowerCase().includes(needle));
  const groups: { label: string; items: { id: string; tx: string }[] }[] = [
    { label: t('Задачи'), items: tasks.filter((x) => hit(x.id, x.title)).slice(0, 30).map((x) => ({ id: x.id, tx: x.title })) },
    { label: t('Требования'), items: (doc.requirements ?? []).filter((r) => hit(r.id, r.text)).slice(0, 30).map((r) => ({ id: r.id, tx: requirementShort(r.text) })) },
    { label: t('Документы'), items: files.filter((f) => hit(f)).map((f) => ({ id: f, tx: '' })) },
  ].filter((g) => g.items.length);
  const pick = (id: string) => {
    setOpen(false);
    setQ('');
    onPick(id);
  };
  return (
    <div className={styles.popWrap} ref={wrap}>
      <button type="button" className={styles.tb} aria-label={t('Ссылка на задачу, требование или документ')} title={t('Ссылка на задачу, требование или документ')} aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}>#</button>
      {open && (
        <div className={cx(styles.pop, styles.left)} role="dialog" aria-label={t('Ссылка')}>
          <input
            autoFocus
            value={q}
            placeholder={t('Номер, заголовок или файл')}
            aria-label={t('Найти')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const first = groups[0]?.items[0];
                if (first) pick(first.id);
              }
            }}
          />
          <div className={styles.picks}>
            {groups.map((g) => (
              <div key={g.label}>
                <div className={styles.g}>{g.label}</div>
                {g.items.map((it) => (
                  <button key={it.id} type="button" onClick={() => pick(it.id)}>
                    <span className={styles.id}>{it.id}</span>
                    {it.tx && <span className={styles.tx}>{it.tx}</span>}
                  </button>
                ))}
              </div>
            ))}
            {!groups.length && <span className={styles.hint}>{t('ничего не нашлось')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Файлы документов проекта для ссылки «#»: prd.md, architecture.md, design.md и docs/*. */
export const docFiles = (names: readonly TeamDocName[]): string[] => names.map(docFile);
