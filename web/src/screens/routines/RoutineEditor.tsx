// Редактор рутины (/routines/:slug, Editor.dc.html; правила — docs/ASSISTANTS.md §3–5): слева три раздела с номерами —
// «Когда» (источник или расписание, условия на поля, ИИ), «Что сделать» (flow, папка, задача, когда запускать) и «Как
// узнаю» (главная, уведомления, дело на доске, ответ в сервис); справа липкая проверка на истории: что из последних
// событий запустилось бы по правилу как оно есть сейчас, воронкой. Разделы правят только черновик — сохранение, проверку
// и переходы ведёт этот экран. Черновик сохраняется сам; включённую рутину сохраняет кнопка. Уход по ссылке из раздела
// («Источник ›», «Подключить Slack или Telegram…») не теряет правки молча: черновик сперва сохраняется, а то, что сохранить
// нельзя (не хватает настроек, включённая рутина), — только с подтверждением.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { RoutineView, RoutinesOverview } from '@server/routines/types';
import { ApiError, errorText } from '../../api';
import { deleteRoutine, routineKeys, runRoutine, saveRoutine, useRoutine, useRoutines } from '../../api/routines';
import { useConfirm } from '../../components/ConfirmDialog';
import { Field, TextArea } from '../../components/form';
import { useToast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { freshHistory, saveStatus, type CheckedHistory } from '../../lib/routines/editor';
import { buildSpec, draftFromSpec, draftMissing, draftUnsavedConds, isSchedule, type RoutineDraft } from '../../lib/routines/spec';
import { isDraft } from '../../lib/routines/view';
import { NotAvailable } from './RoutinesList';
import { cx, RoutineHead } from './parts';
import { HistoryPanel, LeaveProvider, MenuButton, NotifySection, useLeaveGuard, useRoutineSource, WhatSection, WhenSection } from './sections';
import s from './sections/Sections.module.css';
import styles from './Routines.module.css';

/** Черновик сохраняется сам через столько после последней правки. */
const AUTOSAVE_MS = 900;

/** Чего не хватает, словами: подсказка у выключенной кнопки сохранения. */
const MISSING_TEXT: Record<ReturnType<typeof draftMissing>[number], string> = {
  source: t('выбери источник'),
  flow: t('выбери flow'),
  block: t('выбери блок, перед которым остановиться'),
  kind: t('назови вид дела'),
  close: t('напиши, когда закрыть дело'),
};

export function RoutineEditor() {
  const slug = useParams().slug!;
  const one = useRoutine(slug);
  const all = useRoutines();
  if (one.isError) {
    return (
      <>
        <RoutineHead slug={slug} title={slug} />
        <NotAvailable error={one.error} />
      </>
    );
  }
  if (!one.data || !all.data) return <p className="muted">{t('Загрузка…')}</p>;
  return <Keyed slug={slug} r={one.data} data={all.data} />;
}

/**
 * Правка снаружи (YAML руками, другая вкладка, помощник) — форма заново с файла. Своё сохранение форму не пересоздаёт:
 * черновик сохраняется сам, пока человек печатает, и курсор при этом должен остаться на месте.
 */
function Keyed({ slug, r, data }: { slug: string; r: RoutineView; data: RoutinesOverview }) {
  const own = useRef<string | null>(null);
  const seen = useRef({ slug, yaml: r.yaml, n: 0 });
  /** Форму пересоздаёт правка снаружи: уходящая форма не должна дописать поверх неё своё несохранённое. */
  const external = useRef(false);
  if (seen.current.slug !== slug) seen.current = { slug, yaml: r.yaml, n: 0 };
  else if (seen.current.yaml !== r.yaml) {
    if (r.yaml !== own.current) {
      seen.current.n++;
      external.current = true;
    }
    seen.current.yaml = r.yaml;
  }
  // очистка уходящей формы уже отработала к этому моменту
  useEffect(() => {
    external.current = false;
  });
  return <Editor key={`${slug}:${seen.current.n}`} r={r} data={data} onSaved={(yaml) => void (own.current = yaml)} external={external} />;
}

function Editor({ r, data, onSaved, external }: { r: RoutineView; data: RoutinesOverview; onSaved: (yaml: string) => void; external: { current: boolean } }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { askConfirm } = useConfirm();
  const [d, setD] = useState<RoutineDraft>(() => draftFromSpec(r.spec));
  const [yamlOpen, setYamlOpen] = useState(false);
  /** Последняя проверка на истории и правило, по которому она сделана: счётчики в разделах — только пока оно то же. */
  const [hist, setHist] = useState<CheckedHistory | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const set = (patch: Partial<RoutineDraft>) => setD((x) => ({ ...x, ...patch }));

  const src = useRoutineSource(d, data);
  const { source, fields } = src;
  const spec = buildSpec(d, fields);
  const initial = useMemo(() => JSON.stringify(buildSpec(draftFromSpec(r.spec), fields)), [r.spec, fields]);
  const dirty = JSON.stringify(spec) !== initial;
  const draft = isDraft(r);
  const missing = draftMissing(d);
  // незаполненные строки условий в правило не идут, и по сравнению правил их не видно: статус говорит о них сам
  const unsavedConds = draftUnsavedConds(d).length > 0;

  const done = () => void qc.invalidateQueries({ queryKey: routineKeys.all });
  /** Сохранения идут строго по очереди: автосохранение не обгоняет «Включить» и не приходит после него. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<number | null>(null);
  /** Явное сохранение в очереди или идёт: автосохранение пропускается — явное сохранит то же самое и больше. */
  const explicit = useRef(false);
  const [autoFailed, setAutoFailed] = useState(false);
  /** auto — тихое сохранение черновика: кнопки не блокирует, форму не пересоздаёт. true — сохранилось. */
  const save = (enabled?: boolean, auto = false): Promise<boolean> => {
    if (!auto) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      explicit.current = true;
      setSaving(true);
    }
    // снимок на момент вызова: пока запрос ждёт очереди, форма может уйти дальше
    const body = spec;
    const job = async (): Promise<boolean> => {
      if (auto && explicit.current) return false;
      setProblems([]);
      try {
        // «Включить» снимает признак черновика; сохранение черновика его оставляет (buildSpec)
        const { draft: _draft, ...rest } = body;
        const next = await saveRoutine(r.slug, { spec: enabled ? { ...rest, enabled } : body });
        onSaved(next.yaml);
        setSavedAt(Date.now());
        setAutoFailed(false);
        qc.setQueryData(routineKeys.one(r.slug), next);
        done();
        if (enabled && !r.spec.enabled) void navigate(`/routines/${encodeURIComponent(r.slug)}/log`);
        return true;
      } catch (e) {
        const list = e instanceof ApiError ? (e.data as { problems?: string[] } | undefined)?.problems : undefined;
        setProblems(list?.length ? list : [errorText(e)]);
        if (auto) setAutoFailed(true);
        return false;
      } finally {
        if (!auto) {
          explicit.current = false;
          setSaving(false);
        }
      }
    };
    const p = chain.current.then(job, job);
    chain.current = p;
    return p;
  };
  // черновик сохраняется сам (docs/ASSISTANTS.md §3). Включённую рутину так не сохраняем: недописанное условие
  // пошло бы в работу на живых событиях — там сохраняет кнопка
  const specKey = JSON.stringify(spec);
  const autosave = draft && dirty && !missing.length && !saving;
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!autosave) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void saveRef.current(false, true);
    }, AUTOSAVE_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [autosave, specKey]);
  // ушли с экрана раньше, чем сработал таймер: последняя правка черновика уходит сейчас. Форму пересоздала правка
  // снаружи (YAML, другая вкладка) — не уходит: поверх чужой правки своё несохранённое не пишем
  const unsaved = useRef<typeof spec | null>(null);
  unsaved.current = autosave ? spec : null;
  useEffect(
    () => () => {
      if (unsaved.current && !external.current) void saveRoutine(r.slug, { spec: unsaved.current }, true).catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  /**
   * Уход по ссылке из раздела. Черновик, который можно сохранить, — сохранить сейчас (не вышло — остаёмся, причина
   * видна выше). Что сохранить нельзя — недостающие настройки, правки включённой рутины, незаполненное условие, — только
   * с подтверждением.
   */
  const leave = useLeaveGuard(async () => {
    if (draft && dirty && !missing.length) {
      if (!(await save(false))) return false;
      // сохранено: уходящая форма не шлёт то же самое второй раз; не сохранилась только незаполненная строка
      unsaved.current = null;
      return unsavedConds ? askConfirm(t('Незаполненное условие не сохранится. Уйти?'), { ok: t('Уйти'), danger: true }) : true;
    }
    if (!dirty && !unsavedConds) return true;
    const text = dirty
      ? draft
        ? t('Черновик не сохранён: не хватает настроек. Уйти и потерять правки?')
        : t('Есть несохранённые изменения. Уйти и потерять их?')
      : t('Незаполненное условие не сохранится. Уйти?');
    return askConfirm(text, { ok: t('Уйти'), danger: true });
  });
  const runNow = async () => {
    try {
      const res = await runRoutine(r.slug);
      done();
      if (res.runId) void navigate(`/run/${res.runId}`);
      else toast(t('Событие ждёт тебя на главной.'), () => void navigate('/'));
    } catch (e) {
      toast(errorText(e));
    }
  };
  const remove = async () => {
    if (!(await askConfirm(t('Удалить рутину «{name}»? Журнал срабатываний тоже удалится.', { name: r.spec.title }), { ok: t('Удалить'), danger: true }))) return;
    try {
      await deleteRoutine(r.slug);
      done();
      void navigate('/routines');
    } catch (e) {
      toast(errorText(e));
    }
  };

  const status = saveStatus({
    draft,
    dirty,
    missing: missing.length > 0,
    autoFailed,
    unsavedConds,
    savedAt: savedAt ? new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null,
  });
  const why = missing.length ? t('Не хватает: {list}', { list: missing.map((m) => MISSING_TEXT[m]).join(', ') }) : undefined;
  const fresh = freshHistory(hist, spec);
  const offOrDraft = draft || r.spec.enabled === false;

  return (
    <>
      <RoutineHead
        r={r}
        slug={r.slug}
        title={r.spec.title || r.slug}
        actions={
          <>
            {status && (
              <span className={cx('small', status.warn ? 'warn' : 'muted')} role="status" title={draft ? t('Черновик лежит на сервере: уход на другой экран ничего не стирает') : undefined}>
                {status.text}
              </span>
            )}
            {/* почему «Включить»/«Сохранить» выключены — словами рядом, не только в подсказке */}
            {why && <span className="small warn">{why}</span>}
            {r.spec.run && (
              <button type="button" className="btn" title={isSchedule(d) ? t('Запустить по расписанию сейчас, не дожидаясь времени') : t('Запустить flow сейчас, без события')} onClick={() => void runNow()}>
                {t('Запустить сейчас')}
              </button>
            )}
            {offOrDraft && !draft && (
              <button type="button" className="btn" disabled={saving || !dirty || missing.length > 0} title={why} onClick={() => void save(false)}>
                {t('Сохранить')}
              </button>
            )}
            {offOrDraft ? (
              <button type="button" className="btn primary" disabled={saving || missing.length > 0} title={why} onClick={() => void save(true)}>{t('Включить')}</button>
            ) : (
              <button type="button" className="btn primary" disabled={saving || !dirty || missing.length > 0} title={why} onClick={() => void save()}>{t('Сохранить')}</button>
            )}
            <MenuButton
              className="btn ghost icon-more"
              text="⋯"
              label={t('Ещё: YAML, удалить')}
              items={[
                { label: yamlOpen ? t('Закрыть YAML') : t('Открыть YAML'), onClick: () => setYamlOpen(!yamlOpen) },
                { label: t('Удалить…'), danger: true, title: t('Удалить рутину и её журнал — с подтверждением'), onClick: () => void remove() },
              ]}
            />
          </>
        }
      />
      {(problems.length > 0 || r.problems.length > 0) && (
        <div className={styles.problems} role="alert">
          {t('Правило не проходит проверку:')}
          <ul>
            {(problems.length ? problems : r.problems).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={s.editor}>
        <div className={s.main}>
          {yamlOpen && <YamlCard r={r} onYamlSaved={done} onClose={() => setYamlOpen(false)} />}
          <LeaveProvider value={leave}>
            <WhenSection d={d} set={set} data={data} src={src} hist={fresh} />
            <WhatSection d={d} set={set} src={src} />
            <NotifySection d={d} set={set} data={data} src={src} />
          </LeaveProvider>
        </div>
        <HistoryPanel className={s.aside} slug={r.slug} spec={spec} sourceTitle={isSchedule(d) ? t('расписания') : (source?.spec.title ?? d.source)} onResult={setHist} />
      </div>
    </>
  );
}

/** Правило файлом: YAML как есть. Сохранение YAML перечитывает форму с файла; несохранённая правка в разделах теряется. */
function YamlCard({ r, onYamlSaved, onClose }: { r: RoutineView; onYamlSaved: () => void; onClose: () => void }) {
  const [yaml, setYaml] = useState(r.yaml);
  const [yamlErr, setYamlErr] = useState('');
  // файл поменялся (автосохранение черновика из разделов) — текст за ним, пока YAML не правят руками: правку не стираем
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setYaml(r.yaml);
  }, [r.yaml]);
  const qc = useQueryClient();
  const saveYaml = async () => {
    setYamlErr('');
    try {
      const next = await saveRoutine(r.slug, { yaml });
      touched.current = false;
      setYaml(next.yaml);
      qc.setQueryData(routineKeys.one(r.slug), next);
      onYamlSaved();
    } catch (e) {
      const list = e instanceof ApiError ? (e.data as { problems?: string[] } | undefined)?.problems : undefined;
      setYamlErr(list?.length ? list.join('\n') : errorText(e));
    }
  };
  return (
    <div className={cx(s.card, s.fields, s.yamlCard)}>
      <Field label="YAML" help={t('Файл ~/.agentgraph/routines/{slug}.yaml. Несохранённая правка в разделах при сохранении YAML теряется.', { slug: r.slug })} issue={yamlErr ? { tone: 'err', text: yamlErr } : undefined}>
        <TextArea mono className={s.yaml} spellCheck={false} value={yaml} onChange={(e) => ((touched.current = true), setYaml(e.target.value))} />
      </Field>
      <div className={s.btns}>
        <button type="button" className="btn small" disabled={yaml === r.yaml} onClick={() => void saveYaml()}>{t('Сохранить YAML')}</button>
        <button type="button" className="btn small ghost" onClick={onClose}>{t('Закрыть')}</button>
      </div>
    </div>
  );
}
