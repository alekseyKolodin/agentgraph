// Черновик пространства с моделью: ввод (по описанию и проекту или из истории, модель, оценка цены), ход сессии с
// «Отменить», результат — карта, состояние, документы-навыки и папки для просмотра и правки. У существующего пространства
// карта, состояние и замена документа — разницей с текущими. Ничего не применяется само: сохраняет человек кнопкой —
// существующими запросами (POST /api/spaces, PUT /api/spaces/<slug> с базой начала черновика, PUT …/docs/<name>).
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SpaceDetail, SpaceDraftEstimate, SpaceDraftModel } from '@server/api-types';
import { ApiError, createSpace, errorText, estimateDraft, fetchSpaceDoc, keys, saveSpace, saveSpaceDoc } from '../../api';
import { setSessionSpace } from '../../api/sessions';
import { useConfirm } from '../../components/ConfirmDialog';
import { PickDirButton } from '../../components/PickDirButton';
import { t } from '../../lib/i18n';
import { LS } from '../../lib/storage';
import {
  ABOUT_MAX, anyTaken, createBody, danglingDocs, defaultSources, diffRows, diffStat, DOC_SKILL_MAX, docsToSave, DRAFT_MODEL_KEY, DRAFT_MODELS, draftSourceItems, elapsed, estimateLine,
  lineDiff, modelLabel, updatePatch, usd, type DraftEdit, type EditDoc,
} from '../../lib/space-draft';
import { dirLines, fieldCount, SPACE_MAP_WARN, SPACE_SLUG_RE } from '../../lib/spaces';
import { draftBody, draftKey, drafts, runDraft, type DraftEntry, type DraftSetup } from './draftStore';
import styles from './Draft.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

/** Ввод нового черновика: у существующего — его папки и источники по умолчанию, у нового — то, что пришло из формы. */
export function draftSetupOf(space: SpaceDetail | undefined, seed: Partial<DraftSetup> = {}): DraftSetup {
  const items = space ? draftSourceItems(space) : seed.items ?? [];
  return {
    mode: items.length ? 'history' : 'about',
    about: '',
    cwd: space ? space.cwd ?? space.workdir?.path ?? '' : '',
    dirs: space ? (space.dirs ?? []).join('\n') : '',
    items,
    sources: space ? defaultSources(items) : items.map((x) => x.id),
    model: LS.get<SpaceDraftModel>(DRAFT_MODEL_KEY, 'sonnet'),
    slug: '',
    title: '',
    bind: [],
    ...seed,
  };
}

/** Открыть черновик: идущий или готовый не сбрасывается, остальной — заново с этим вводом. */
export function openDraft(key: string, setup: DraftSetup, fresh = false): void {
  const cur = drafts.get(key);
  if (cur && !fresh && (cur.phase === 'running' || cur.phase === 'done')) return;
  drafts.set(key, { setup, phase: 'setup', log: [], bindOn: true });
}

type Props = {
  /** Существующее пространство; нет — новое. */
  space?: SpaceDetail;
  onClose: () => void;
  /** Существующее: несохранённые правки формы пропадут — спросить. */
  confirmDiscard?: () => Promise<boolean>;
  /** Записано: новое — его слаг (перейти к нему), существующее — перечитать. */
  onSaved: (slug: string) => void;
  /** Черновик из «Предложить пространства»: вернуться к предложениям. */
  onBackToGroups?: () => void;
};

export function DraftPanel({ space, onClose, confirmDiscard, onSaved, onBackToGroups }: Props) {
  const key = draftKey(space?.slug);
  const e = drafts.use(key);
  const { askConfirm } = useConfirm();
  useEffect(() => {
    if (!drafts.get(key)) openDraft(key, draftSetupOf(space));
  }, [key]);
  if (!e) return null;
  const close = async () => {
    if (e.phase === 'running') return;
    if (e.phase === 'done' && !(await askConfirm(t('Черновик не сохранён: закрыть его?'), { ok: t('Закрыть') }))) return;
    drafts.set(key, undefined);
    onClose();
  };
  return (
    <section className={styles.panel} aria-label={t('Черновик с моделью')}>
      <div className={styles.head}>
        <h3>{space ? t('Черновик карты с моделью') : t('Новое пространство с моделью')}</h3>
        <span className={cx('row', styles.push)}>
          {onBackToGroups && e.setup.fromGroups && e.phase !== 'running' && <button type="button" className="btn small ghost" onClick={onBackToGroups}>{t('← К предложениям')}</button>}
          {e.phase !== 'running' && <button type="button" className="btn small ghost" onClick={() => void close()}>{t('Закрыть')}</button>}
        </span>
      </div>
      {(e.phase === 'setup' || e.phase === 'error') && <Setup draftKey={key} entry={e} space={space} />}
      {e.phase === 'running' && <Running entry={e} />}
      {e.phase === 'done' && e.reply && e.edit && <Result draftKey={key} entry={e} space={space} confirmDiscard={confirmDiscard} onSaved={onSaved} />}
    </section>
  );
}

function Setup({ draftKey: key, entry: e, space }: { draftKey: string; entry: DraftEntry; space?: SpaceDetail }) {
  const s = e.setup;
  const set = (p: Partial<DraftSetup>) => drafts.patch(key, (cur) => ({ setup: { ...cur.setup, ...p } }));
  const [est, setEst] = useState<SpaceDraftEstimate | null>(null);
  const [estErr, setEstErr] = useState('');
  const body = draftBody(s, space);
  const bodyKey = JSON.stringify(body);
  // оценка без модели: пересчитывается, когда ввод перестал меняться
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      estimateDraft(body).then(
        (r) => live && (setEst(r), setEstErr('')),
        (err) => live && (setEst(null), setEstErr(errorText(err))),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [bodyKey]);
  const history = s.mode === 'history';
  const toggle = (id: string) => set({ sources: s.sources.includes(id) ? s.sources.filter((x) => x !== id) : [...s.sources, id] });
  return (
    <div className={cx('form', styles.setup)}>
      <p className="muted small">
        {t('Модель только читает (Read, Grep, Glob) и пишет черновик: карту как CLAUDE.md после /init — проверенные команды, устройство, подводные камни, куда за чем, — до пяти документов-навыков и, если есть из чего, состояние. Ничего не сохраняется само: ты смотришь, правишь и сохраняешь.')}
      </p>
      {s.items.length > 0 && (
        <div className="tabs" role="tablist" aria-label={t('Из чего писать')}>
          <button type="button" role="tab" aria-selected={!history} className={cx('tab', !history && 'active')} onClick={() => set({ mode: 'about' })}>{t('По описанию и проекту')}</button>
          <button type="button" role="tab" aria-selected={history} className={cx('tab', history && 'active')} onClick={() => set({ mode: 'history' })}>{t('Из истории')}</button>
        </div>
      )}
      {!space && (
        <div className={styles.twoCol}>
          <label>
            <span>{t('Слаг')}</span>
            <input autoComplete="off" spellCheck={false} placeholder={t('предложит модель')} value={s.slug} onChange={(ev) => set({ slug: ev.target.value })} />
          </label>
          <label>
            <span>{t('Заголовок')}</span>
            <input autoComplete="off" placeholder={t('предложит модель')} value={s.title} onChange={(ev) => set({ title: ev.target.value })} />
          </label>
        </div>
      )}
      <label>
        <span title={t('Пара строк: что за фича или проект, зачем, где код, что важно. Это данные для модели, а не инструкции ей')}>{t('О чём работа')}</span>
        <textarea rows={3} maxLength={ABOUT_MAX} placeholder={t('Пуш о тревоге на Android и iOS: приложение в ~/code/android, бэкенд отправки — в ~/code/api')} value={s.about} onChange={(ev) => set({ about: ev.target.value })} />
      </label>
      <label>
        <span title={t('Модель изучит её на чтение: README, сборку, тесты, CI, ключевые модули')}>{t('Рабочая папка')}</span>
        <div className="path-field">
          <input autoComplete="off" spellCheck={false} placeholder="/Users/me/code/shop" value={s.cwd} onChange={(ev) => set({ cwd: ev.target.value })} />
          <PickDirButton prompt={t('Рабочая папка пространства')} start={() => s.cwd} onPick={(p) => set({ cwd: p })} />
        </div>
      </label>
      <label>
        <span title={t('Другие репозитории и папки работы, по одному на строку: модель прочитает и их')}>{t('Папки')}</span>
        <textarea rows={2} className={styles.mono} spellCheck={false} placeholder="/Users/me/code/api" value={s.dirs} onChange={(ev) => set({ dirs: ev.target.value })} />
      </label>
      {history && (
        <fieldset className={styles.sources}>
          <legend className="field-label">{t('Сессии и запуски — модель прочтёт их ходы, задачи и итоги')}</legend>
          <ul>
            {s.items.map((x) => (
              <li key={x.id}>
                <label className={styles.check}>
                  <input type="checkbox" checked={s.sources.includes(x.id)} onChange={() => toggle(x.id)} />
                  <span className={styles.itemName}>{x.name}</span>
                  <span className="muted small">{x.sub}</span>
                </label>
              </li>
            ))}
          </ul>
          <span className="muted small">{t('Выбрано: {n} из {all}, не больше 12 сессий и 12 запусков', { n: s.sources.length, all: s.items.length })}</span>
        </fieldset>
      )}
      <div className={styles.runRow}>
        <label className={styles.model}>
          <span>{t('Модель')}</span>
          <select
            value={s.model}
            onChange={(ev) => {
              const model = ev.target.value as SpaceDraftModel;
              LS.set(DRAFT_MODEL_KEY, model);
              set({ model });
            }}
          >
            {DRAFT_MODELS.map((m) => <option key={m} value={m}>{modelLabel(m)}</option>)}
          </select>
        </label>
        <button type="button" className="btn primary" disabled={!est} onClick={() => void runDraft(key, space)}>{t('Написать черновик')}</button>
        <span className={cx('small', estErr ? 'err' : 'muted')} title={est ? t('Оценка приблизительная: сколько модель прочитает, заранее неизвестно. Потолок — гарантия: дальше сессия остановится') : undefined}>
          {estErr || (est ? t('Оценка: {line}', { line: estimateLine(est) }) : t('Считаю оценку…'))}
        </span>
      </div>
      {est && est.reads.length > 0 && <p className="muted small mono">{t('Читать сможет: {dirs}', { dirs: est.reads.join(', ') })}</p>}
      {e.failure && <p className={e.failure.code === 'aborted' ? 'msg' : 'msg err'}>{e.failure.code === 'aborted' ? e.failure.error : t('Черновик не получился: {error}. Потрачено: {cost}', { error: e.failure.error, cost: usd(e.failure.costUsd) })}</p>}
    </div>
  );
}

function Running({ entry: e }: { entry: DraftEntry }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className={styles.running}>
      <div className={styles.wait}>
        <span className={styles.dot} />
        {t('Модель читает проект и пишет черновик… {time}', { time: elapsed(now - (e.startedAt ?? now)) })}
        {e.model && <span className="muted small mono">{e.model}</span>}
        <button type="button" className={cx('btn small ghost', styles.push)} onClick={() => e.abort?.abort()}>{t('Отменить')}</button>
      </div>
      {e.log.length > 0 && <pre className={styles.log}>{e.log.join('\n')}</pre>}
      <p className="muted small">{t('Обычно 1–3 минуты. Можно уйти с экрана: черновик дождётся здесь. Закрытие вкладки отменит его.')}</p>
    </div>
  );
}

/** Разница строк: неизменённые куски свёрнуты. */
function Diff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  if (!lines.some((l) => l.op !== ' ')) return <p className="muted small">{t('Без изменений')}</p>;
  return (
    <pre className={styles.diff}>
      {diffRows(lines).map((r, i) =>
        'skip' in r ? (
          <span key={i} className={styles.skip}>{t('⋯ без изменений: {n}', { n: r.skip })}</span>
        ) : (
          <span key={i} className={cx(styles.line, r.op === '+' && styles.add, r.op === '-' && styles.del)}>{`${r.op} ${r.text}`}</span>
        ),
      )}
    </pre>
  );
}

function Stat({ before, after }: { before: string; after: string }) {
  const s = useMemo(() => diffStat(lineDiff(before, after)), [before, after]);
  return <span className={cx('mono small', styles.stat)}><span className="ok">+{s.add}</span> <span className="err">−{s.del}</span></span>;
}

/** Текст черновика: у существующего — разница или правка, у нового — правка. */
function TextPart({ label, hint, before, value, onChange, take, onTake, warnAt }: {
  label: string;
  hint: string;
  before?: string;
  value: string;
  onChange: (v: string) => void;
  take?: boolean;
  onTake?: (v: boolean) => void;
  warnAt?: number;
}) {
  const [view, setView] = useState<'diff' | 'text'>(before === undefined ? 'text' : 'diff');
  const long = warnAt !== undefined && value.length > warnAt;
  return (
    <div className={styles.part}>
      <div className={styles.partHead}>
        {onTake ? (
          <label className={styles.check}>
            <input type="checkbox" checked={take} onChange={(ev) => onTake(ev.target.checked)} />
            <strong>{label}</strong>
          </label>
        ) : <strong>{label}</strong>}
        {before !== undefined && <Stat before={before} after={value} />}
        <span className="muted small">{hint}</span>
        {before !== undefined && (
          <span className={cx('row', styles.push, styles.views)}>
            <button type="button" className={cx('btn small ghost', view === 'diff' && styles.on)} onClick={() => setView('diff')}>{t('Разница')}</button>
            <button type="button" className={cx('btn small ghost', view === 'text' && styles.on)} onClick={() => setView('text')}>{t('Текст')}</button>
          </span>
        )}
      </div>
      {view === 'diff' && before !== undefined ? <Diff before={before} after={value} /> : <textarea className={styles.mono} rows={Math.min(24, Math.max(6, value.split('\n').length + 1))} spellCheck={false} value={value} onChange={(ev) => onChange(ev.target.value)} />}
      <div className={styles.foot}>
        <span className={cx('small', long ? 'warn' : 'muted')}>{long ? t('Длиннее {n} знаков: карта уходит в каждый запрос модели — подробности лучше в документы', { n: warnAt! }) : ''}</span>
        <span className="muted small mono">{fieldCount(value)}</span>
      </div>
    </div>
  );
}

function DocPart({ slug, doc, onChange }: { slug?: string; doc: EditDoc; onChange: (d: EditDoc | null) => void }) {
  const [open, setOpen] = useState(false);
  const [old, setOld] = useState<string | null>(null);
  useEffect(() => {
    if (!open || old !== null || doc.replaces === undefined || !slug) return;
    fetchSpaceDoc(slug, doc.name).then((d) => setOld(d.text), () => setOld(''));
  }, [open]);
  const long = doc.text.length > DOC_SKILL_MAX;
  return (
    <li className={styles.doc}>
      <div className={styles.partHead}>
        <label className={styles.check}>
          <input type="checkbox" checked={doc.on} onChange={(ev) => onChange({ ...doc, on: ev.target.checked })} />
          <input className={cx('mono', styles.docName)} value={doc.name} spellCheck={false} aria-label={t('Имя документа')} onChange={(ev) => onChange({ ...doc, name: ev.target.value })} />
        </label>
        <span className={cx('small', long ? 'warn' : 'muted')}>{t('{n} знаков', { n: doc.text.length })}</span>
        {doc.replaces !== undefined && <span className="warn small" title={t('Документ с этим именем уже есть: отметь, чтобы заменить его')}>{t('заменит существующий')}</span>}
        <span className={cx('row', styles.push)}>
          <button type="button" className="btn small ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('Свернуть') : t('Читать')}</button>
          <button type="button" className="btn small ghost danger" title={t('Убрать из черновика')} onClick={() => onChange(null)}>×</button>
        </span>
      </div>
      {open && (doc.replaces !== undefined && old !== null ? (
        <>
          <Diff before={old} after={doc.text} />
          <textarea className={styles.mono} rows={10} spellCheck={false} value={doc.text} onChange={(ev) => onChange({ ...doc, text: ev.target.value })} />
        </>
      ) : <textarea className={styles.mono} rows={Math.min(24, Math.max(8, doc.text.split('\n').length + 1))} spellCheck={false} value={doc.text} onChange={(ev) => onChange({ ...doc, text: ev.target.value })} />)}
    </li>
  );
}

function Result({ draftKey: key, entry: e, space, confirmDiscard, onSaved }: { draftKey: string; entry: DraftEntry; space?: SpaceDetail; confirmDiscard?: () => Promise<boolean>; onSaved: (slug: string) => void }) {
  const qc = useQueryClient();
  const r = e.reply!;
  const ed = e.edit!;
  const edit = (p: Partial<DraftEdit>) => drafts.patch(key, (cur) => ({ edit: { ...cur.edit!, ...p } }));
  const take = (k: keyof DraftEdit['take'], v: boolean) => edit({ take: { ...ed.take, [k]: v } });
  const setDoc = (i: number, d: EditDoc | null) => edit({ docs: d ? ed.docs.map((x, j) => (j === i ? d : x)) : ed.docs.filter((_, j) => j !== i) });
  const chosen = ed.docs.filter((d) => d.on).map((d) => d.name.trim());
  const dangling = danglingDocs(ed.map, chosen, space?.docs.map((d) => d.name) ?? []);
  const msg = (cls: string, text: string) => drafts.patch(key, { saveMsg: { cls, text }, saving: false });

  /** Документы по одному: записанные уходят из черновика, несохранённые остаются с ошибкой — повтор пишет только их. */
  const writeDocs = async (slug: string): Promise<string[]> => {
    const errors: string[] = [];
    for (const d of docsToSave(ed)) {
      try {
        await saveSpaceDoc(slug, d.name, d.text, d.base);
        drafts.patch(key, (cur) => ({ edit: { ...cur.edit!, docs: cur.edit!.docs.filter((x) => x.name.trim() !== d.name) } }));
      } catch (err) {
        errors.push(`${d.name}: ${errorText(err)}`);
      }
    }
    return errors;
  };

  const saveExisting = async () => {
    if (!space) return;
    if (confirmDiscard && !(await confirmDiscard())) return;
    drafts.patch(key, { saving: true, saveMsg: { cls: 'msg', text: t('Сохраняю…') } });
    const patch = updatePatch(ed, r.base);
    if (Object.keys(patch).length) {
      try {
        await saveSpace(space.slug, patch);
        // записано: повтор (документы) не отправит карту второй раз со старой базой
        drafts.patch(key, (cur) => ({ edit: { ...cur.edit!, take: { map: false, state: false, cwd: false, dirs: false } } }));
      } catch (err) {
        return msg('msg err', err instanceof ApiError && err.status === 409 ? t('Пока модель писала черновик, карту или состояние изменили: {error}. Закрой черновик и напиши заново по свежей карте.', { error: errorText(err) }) : errorText(err));
      }
    }
    const errors = await writeDocs(space.slug);
    void qc.invalidateQueries({ queryKey: keys.spaces });
    if (errors.length) return msg('msg err', t('Не записались документы: {list}', { list: errors.join('; ') }));
    drafts.set(key, undefined);
    onSaved(space.slug);
  };

  const saveNew = async () => {
    const body = createBody(ed);
    if (!SPACE_SLUG_RE.test(body.slug)) return msg('msg err', t('Слаг пространства: строчные латинские буквы, цифры и дефис'));
    drafts.patch(key, { saving: true, saveMsg: { cls: 'msg', text: t('Создаю…') } });
    let slug = e.created;
    if (!slug) {
      try {
        slug = (await createSpace(body)).slug;
        drafts.patch(key, { created: slug });
      } catch (err) {
        return msg('msg err', errorText(err));
      }
    }
    const errors = await writeDocs(slug);
    if (e.bindOn) {
      for (const id of e.setup.bind) {
        try {
          await setSessionSpace(id, slug);
        } catch (err) {
          errors.push(`${t('сессия')} ${id.slice(0, 8)}: ${errorText(err)}`);
        }
      }
      drafts.patch(key, (cur) => ({ setup: { ...cur.setup, bind: [] } }));
    }
    void qc.invalidateQueries({ queryKey: keys.spaces });
    if (errors.length) return msg('msg err', t('Пространство {slug} создано, но не всё записалось: {list}', { slug, list: errors.join('; ') }));
    drafts.set(key, undefined);
    onSaved(slug);
  };

  const canSave = space ? anyTaken(ed) : Boolean(ed.slug.trim()) && ed.map.length <= 20_000;
  return (
    <div className={cx('form', styles.result)}>
      <div className={styles.meta}>
        <span className="small">{t('Черновик готов')}: <span className="mono">{r.model ?? e.setup.model}</span> · {elapsed(r.durationMs)} · {usd(r.costUsd)}</span>
        <button type="button" className="btn small ghost" disabled={e.saving} title={t('Вернуться к вводу: этот черновик пропадёт')} onClick={() => drafts.patch(key, { phase: 'setup', reply: undefined, edit: undefined })}>{t('Написать заново')}</button>
      </div>
      {r.warnings.length > 0 && <ul className={styles.warnings}>{r.warnings.map((w) => <li key={w} className="warn small">{w}</li>)}</ul>}
      {r.draft.doubts.length > 0 && (
        <div className={styles.doubts}>
          <span className="field-label">{t('Модель не выяснила')}</span>
          <ul>{r.draft.doubts.map((d) => <li key={d} className="small">{d}</li>)}</ul>
        </div>
      )}
      {!space && (
        <div className={styles.twoCol}>
          <label>
            <span>{t('Слаг')}</span>
            <input autoComplete="off" spellCheck={false} value={ed.slug} onChange={(ev) => edit({ slug: ev.target.value })} />
          </label>
          <label>
            <span title={t('Заголовок станет твоим: он пойдёт в текст для модели')}>{t('Заголовок')}</span>
            <input autoComplete="off" value={ed.title} onChange={(ev) => edit({ title: ev.target.value })} />
          </label>
        </div>
      )}
      <TextPart
        label={t('Карта (CLAUDE.md)')}
        hint={t('память каждой сессии и этапа')}
        before={space?.map}
        value={ed.map}
        onChange={(map) => edit({ map })}
        take={space ? ed.take.map : undefined}
        onTake={space ? (v) => take('map', v) : undefined}
        warnAt={SPACE_MAP_WARN}
      />
      {dangling.length > 0 && <p className="warn small">{t('Карта ссылается на документы, которых не будет: {list} — отметь их ниже или поправь карту', { list: dangling.map((n) => `docs/${n}`).join(', ') })}</p>}
      <div className={styles.part}>
        <div className={styles.partHead}>
          <strong>{t('Документы-навыки')}</strong>
          <span className="muted small">{t('открываются агентом по запросу; отметь, какие сохранить')}</span>
        </div>
        {ed.docs.length ? <ul className={styles.docs}>{ed.docs.map((d, i) => <DocPart key={i} slug={space?.slug} doc={d} onChange={(x) => setDoc(i, x)} />)}</ul> : <p className="muted small">{t('Документов модель не предложила.')}</p>}
      </div>
      {(ed.state || space?.state) && (
        <TextPart
          label={t('Состояние')}
          hint={t('«где мы сейчас», идёт модели данными')}
          before={space?.state}
          value={ed.state}
          onChange={(state) => edit({ state })}
          take={space ? ed.take.state : undefined}
          onTake={space ? (v) => take('state', v) : undefined}
        />
      )}
      <div className={styles.part}>
        <div className={styles.partHead}><strong>{t('Папки')}</strong></div>
        <label className={styles.check}>
          {space && <input type="checkbox" checked={ed.take.cwd} onChange={(ev) => take('cwd', ev.target.checked)} />}
          <span>{t('Рабочая папка')}</span>
          {space && <span className={cx('muted small mono', styles.now)} title={space.cwd}>{t('сейчас: {path}', { path: space.cwd || '—' })}</span>}
        </label>
        <input className={styles.mono} autoComplete="off" spellCheck={false} value={ed.cwd} onChange={(ev) => edit({ cwd: ev.target.value })} />
        <label className={styles.check}>
          {space && <input type="checkbox" checked={ed.take.dirs} onChange={(ev) => take('dirs', ev.target.checked)} />}
          <span>{t('Папки только для чтения')}</span>
          {space && <span className="muted small mono">{t('сейчас: {n}', { n: (space.dirs ?? []).length })}</span>}
        </label>
        <textarea className={styles.mono} rows={Math.max(2, dirLines(ed.dirs).length + 1)} spellCheck={false} value={ed.dirs} onChange={(ev) => edit({ dirs: ev.target.value })} />
      </div>
      <div className={styles.saveRow}>
        {!space && e.setup.bind.length > 0 && (
          <label className={styles.check}>
            <input type="checkbox" checked={e.bindOn} onChange={(ev) => drafts.patch(key, { bindOn: ev.target.checked })} />
            <span>{t('Привязать сессии предложения к пространству: {n}', { n: e.setup.bind.length })}</span>
          </label>
        )}
        <button type="button" className="btn primary" disabled={!canSave || e.saving} onClick={() => void (space ? saveExisting() : saveNew())}>
          {space ? t('Сохранить выбранное') : e.created ? t('Дописать документы') : t('Создать пространство')}
        </button>
        {e.saveMsg && <span className={e.saveMsg.cls}>{e.saveMsg.text}</span>}
      </div>
    </div>
  );
}
