// Редактор рутины (/routines/:slug, docs/routines/design/v2, правила — docs/ASSISTANTS.md §3–5): слева граф с
// фиксированным порядком узлов — Триггер → Условия по полям → ИИ рутины → Дело → Запустить flow → Ждать меня → Ответить;
// клик по узлу открывает справа его настройки. На узле видно, кто работает (без модели, модель, человек) и сколько событий
// дошло до него на проверке на истории. Под настройками — «Проверить на истории»: что из последних событий источника
// запустилось бы по правилу как оно есть сейчас. Черновик сохраняется сам; включённую рутину сохраняет кнопка.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { HistoryCheck, HistoryRun, RoutineView, RoutinesOverview, SourceKindView, SourceView } from '@server/routines/types';
import { ApiError, errorText, useFeature, useFlows } from '../../api';
import { deleteRoutine, fetchHistoryRun, routineKeys, runRoutine, saveRoutine, saveSource, sendFeedback, startHistory, useRoutine, useRoutines, useSourceSample } from '../../api/routines';
import { useSpaces } from '../../api/spaces';
import { useConfirm } from '../../components/ConfirmDialog';
import { ModelPick } from '../../components/ModelPick';
import { SpacePicker } from '../../components/SpacePicker';
import { SourceReplyPanel } from './ReplySetup';
import { useToast } from '../../components/Toast';
import { useNow } from '../../components/useNow';
import { usd } from '../../lib/format';
import { modelChip } from '../../lib/flow/ai-progress';
import { plural, t } from '../../lib/i18n';
import { DEFAULT_CHECK_MODEL, routineNodes, type GraphNode, type NodeId } from '../../lib/routines/graph';
import { everyLabel, pollChoices } from '../../lib/routines/source';
import { matchFields } from '../../lib/routines/match';
import { replyLabel, replyWhere } from '../../lib/routines/phrase';
import { pickCondition, withSampleFields } from '../../lib/routines/sample';
import { formatNext, nextRuns, PRESETS, presetLabel, toCron, type SchedulePreset } from '../../lib/routines/schedule';
import { buildSpec, draftFromSpec, draftMissing, draftRuns, isCloseText, isSchedule, REPLY_CHOICES, type ReplyChoice, type RoutineDraft } from '../../lib/routines/spec';
import { estimateText, historyVerdict, isDraft, taskVerdict, type Verdict } from '../../lib/routines/view';
import { NotAvailable } from './RoutinesList';
import { CwdField } from './CwdField';
import { EventSample, FlowInput } from './EventSample';
import { Conditions, cx, RoutineHead, Seg, useFlowBlocks, WaitClause } from './parts';
import { RoutineGraph } from './RoutineGraph';
import styles from './Routines.module.css';

const HISTORY_LIMIT = 30;
/** Как часто экран спрашивает, что проверка на истории уже проверила. */
const HISTORY_POLL_MS = 700;
/** Черновик сохраняется сам через столько после последней правки. */
const AUTOSAVE_MS = 900;

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
  const [sel, setSel] = useState<NodeId | 'yaml'>('trigger');
  /** Последняя проверка на истории: по ней счётчики на узлах графа. */
  const [hist, setHist] = useState<HistoryCheck | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  // частота опроса живёт в источнике, а не в рутине: выбранное хранится по слагу источника и сохраняется вместе с правилом
  const [everyBy, setEveryBy] = useState<Record<string, string>>({});
  const set = (patch: Partial<RoutineDraft>) => setD((x) => ({ ...x, ...patch }));

  const source = data.sources.find((s) => s.slug === d.source);
  const kind = source ? data.kinds.find((k) => k.kind === source.spec.kind) : undefined;
  const fields = useMemo(() => matchFields(kind), [kind]);
  // что приходит с сервиса: пример события в узлах «Условия по полям» и «ИИ рутины», его поля — в списке «Поле» условия
  const sample = useSourceSample(!isSchedule(d) && source ? source.slug : undefined);
  const condFields = useMemo(() => withSampleFields(fields, sample.data), [fields, sample.data]);
  const [condOpen, setCondOpen] = useState<number | null>(null);
  const spec = buildSpec(d, fields);
  const initial = useMemo(() => JSON.stringify(buildSpec(draftFromSpec(r.spec), fields)), [r.spec, fields]);
  const everyChanged = Object.entries(everyBy).filter(([slug, v]) => data.sources.find((s) => s.slug === slug)?.spec.every !== v);
  const specDirty = JSON.stringify(spec) !== initial;
  const everyDirty = !isSchedule(d) && everyChanged.some(([slug]) => slug === d.source);
  const dirty = specDirty || everyDirty;
  const draft = isDraft(r);
  const missing = draftMissing(d);
  const runs = draftRuns(d);

  // сменили источник: ответ «туда, откуда пришло» возможен, только если новый источник умеет отвечать; иначе — первый
  // источник с ответом или «Не сообщать» (сырое «source» у источника без reply давало бы ошибку в журнале на каждом событии)
  const replyFor = (slug: string): Partial<RoutineDraft> => {
    if (d.reply === 'off') return {};
    if (data.sources.find((s) => s.slug === slug)?.canReply) return { replyTo: 'source' };
    if (d.replyTo !== 'source' && d.replyTo !== slug) return {};
    const target = data.sources.find((s) => s.slug !== slug && s.canReply);
    return target ? { replyTo: target.slug } : { reply: 'off' };
  };
  const done = () => void qc.invalidateQueries({ queryKey: routineKeys.all });
  /** Сохранения идут строго по очереди: автосохранение не обгоняет «Включить» и не приходит после него. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<number | null>(null);
  /** Явное сохранение в очереди или идёт: автосохранение пропускается — явное сохранит то же самое и больше. */
  const explicit = useRef(false);
  const [autoFailed, setAutoFailed] = useState(false);
  /** auto — тихое сохранение черновика: кнопки не блокирует, форму не пересоздаёт, источник не трогает. */
  const save = (enabled?: boolean, auto = false): Promise<void> => {
    if (!auto) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      explicit.current = true;
      setSaving(true);
    }
    // снимок на момент вызова: пока запрос ждёт очереди, форма может уйти дальше
    const body = spec;
    const src = data.sources.find((s) => s.slug === d.source);
    const every = !isSchedule(d) ? everyBy[d.source] : undefined;
    const job = async () => {
      if (auto && explicit.current) return;
      setProblems([]);
      try {
        // новая частота опроса — в файл источника: движок читает его на каждом тике, перезапуск не нужен. Источник общий
        // для включённых рутин, поэтому автосохранение черновика его не меняет — только кнопка
        if (!auto && src && every && src.spec.every !== every) await saveSource(src.slug, { ...src.spec, every });
        // «Включить» снимает признак черновика; сохранение черновика его оставляет (buildSpec)
        const { draft: _draft, ...rest } = body;
        const next = await saveRoutine(r.slug, { spec: enabled ? { ...rest, enabled } : body });
        onSaved(next.yaml);
        setSavedAt(Date.now());
        setAutoFailed(false);
        qc.setQueryData(routineKeys.one(r.slug), next);
        done();
        if (enabled && !r.spec.enabled) void navigate(`/routines/${encodeURIComponent(r.slug)}/log`);
      } catch (e) {
        const list = e instanceof ApiError ? (e.data as { problems?: string[] } | undefined)?.problems : undefined;
        setProblems(list?.length ? list : [errorText(e)]);
        if (auto) setAutoFailed(true);
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
  const autosave = draft && specDirty && !missing.length && !saving;
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

  // источник «через Claude» без настроенного ответа: «в источник» ответить нечем
  const replyNotSet = !isSchedule(d) && d.reply !== 'off' && source?.spec.kind === 'connector' && !source.canReply && d.replyTo === 'source';
  const nodes = routineNodes(d, {
    ...(source ? { source: { title: source.spec.title, kind: source.spec.kind, every: everyBy[d.source] ?? source.spec.every } } : {}),
    ...(kind ? { delivery: kind.delivery } : {}),
    replyWhere: replyNotSet ? t('ответ в источник не настроен') : replyWhere(source?.spec.kind, d.replyTo, data.sources),
    hist,
    missing,
  });
  const node = sel === 'yaml' ? undefined : (nodes.find((n) => n.id === sel) ?? nodes[0]);

  return (
    <>
      <RoutineHead
        r={r}
        slug={r.slug}
        title={r.spec.title || r.slug}
        actions={
          <>
            {r.spec.run && (
              <button type="button" className="btn" title={isSchedule(d) ? t('Запустить по расписанию сейчас, не дожидаясь времени') : t('Запустить flow сейчас, без события')} onClick={() => void runNow()}>
                {t('Запустить сейчас')}
              </button>
            )}
            <button type="button" className="btn ghost danger" onClick={() => void remove()}>{t('Удалить')}</button>
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
      <div className={styles.graphGrid}>
        <section className={styles.graphCol} aria-label={t('Граф рутины')}>
          <RoutineGraph nodes={nodes} selected={node?.id} onSelect={setSel} />
          <p className={styles.graphNote}>
            {t('Порядок узлов фиксированный: дешёвые проверки стоят раньше ИИ.')}
            {hist && !isSchedule(d) ? ` ${t('Числа — сколько событий прошло узел на проверке на истории.')}` : ''}
          </p>
          <div>
            <button type="button" className="btn small ghost" aria-pressed={sel === 'yaml'} onClick={() => setSel('yaml')}>{t('Открыть YAML')}</button>
          </div>
        </section>
        <div className={styles.nodeCol}>
          {node ? (
            <NodePanel node={node}>
              {node.id === 'trigger' && (
                <div className={styles.clause}>
                  <span className={styles.k}>{t('Когда')}</span>
                  <div className={styles.clauseBody}>
                    {isSchedule(d) ? (
                      <ScheduleClause d={d} set={set} />
                    ) : (
                      <>
                        <div className={styles.sentence}>
                          {t('в')}{' '}
                          <select className={styles.slot} aria-label={t('Источник')} value={d.source} onChange={(e) => (setCondOpen(null), set({ source: e.target.value, conds: [], ...replyFor(e.target.value) }))}>
                            {data.sources.map((s) => (
                              <option key={s.slug} value={s.slug}>{s.spec.title}</option>
                            ))}
                            {!source && <option value={d.source}>{d.source}</option>}
                          </select>{' '}
                          {t('приходит событие')}
                        </div>
                        {source && <PollClause source={source} kind={kind} value={everyBy[d.source]} onChange={(v) => setEveryBy((x) => ({ ...x, [d.source]: v }))} />}
                        {source && kind?.delivery !== 'live' && (
                          <span className={styles.hint}>{t('Частота опроса — не расписание: рутина сработает на каждое новое событие источника, а не раз в этот интервал.')}</span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
              {node.id === 'conds' && (
                <div className={styles.clause}>
                  <span className={styles.k}>{t('Пропускать')}</span>
                  <div className={styles.clauseBody}>
                    <Conditions conds={d.conds} fields={condFields} onChange={(conds) => set({ conds })} lead={<>{t('событие, если')}</>} opened={condOpen} onOpened={setCondOpen} />
                    <span className={styles.hint}>{t('Точные условия на поля события: канал, автор, поле равно или содержит. Модель здесь не работает — это быстро и бесплатно. Всё, что нельзя выразить полем, решает следующий узел.')}</span>
                  </div>
                </div>
              )}
              {node.id === 'conds' && source && (
                <EventSample
                  key={source.slug}
                  source={source}
                  kind={kind}
                  sample={sample}
                  onPick={(f) => {
                    set({ conds: [...d.conds, pickCondition(f)] });
                    setCondOpen(d.conds.length);
                  }}
                />
              )}
              {node.id === 'ai' && <AiClause d={d} set={set} hist={hist} runs={runs} sample={source && <EventSample key={source.slug} source={source} kind={kind} sample={sample} />} />}
              {node.id === 'task' && <TaskClause d={d} set={set} />}
              {node.id === 'run' && (
                <>
                  <RunClause d={d} set={set} />
                  {runs && !isSchedule(d) && source && <FlowInput key={source.slug} source={source} kind={kind} sample={sample} task={d.input} />}
                  {runs && <RunExtras d={d} set={set} />}
                </>
              )}
              {node.id === 'wait' && (
                <div className={styles.clause}>
                  <span className={styles.k}>{t('Ждать меня')}</span>
                  <div className={styles.clauseBody}>
                    {runs ? <WaitBlocks d={d} set={set} /> : <span className={styles.hint}>{t('Рутина ничего не запускает: ждать нечего. Выбери flow в узле «Запустить flow».')}</span>}
                    {runs && !isSchedule(d) && Boolean(d.check.trim()) && d.checkAsk && (
                      <span className={styles.hint}>{t('Сверх этого: когда «ИИ рутины» не уверен, событие ждёт тебя на главной, какой бы режим здесь ни стоял.')}</span>
                    )}
                  </div>
                </div>
              )}
              {node.id === 'reply' && (runs ? <ReplyClause d={d} set={set} data={data} kindCanReply={Boolean(source?.canReply)} replyNotSet={replyNotSet} source={source} /> : (
                <div className={styles.clause}>
                  <span className={styles.k}>{t('Ответить')}</span>
                  <span className={styles.hint}>{t('Рутина без flow только заводит дела: отвечать в источник нечем.')}</span>
                </div>
              ))}
            </NodePanel>
          ) : (
            <div className={styles.rule}>
              {/* сохранение из узлов меняет файл: поле YAML открывается заново с него, а не со старым текстом */}
              <YamlClause key={r.yaml} r={r} onYamlSaved={done} />
            </div>
          )}
          <History slug={r.slug} spec={spec} sourceTitle={isSchedule(d) ? t('расписания') : (source?.spec.title ?? d.source)} onResult={setHist} />
        </div>
      </div>
      <div className={styles.bar}>
        {draft ? (
          <span className={cx('small', (specDirty && missing.length > 0) || autoFailed || everyDirty ? 'warn' : 'muted')} title={t('Черновик лежит на сервере: уход на другой экран ничего не стирает')}>
            {autoFailed && specDirty
              ? t('черновик не сохранён: причина выше. Поправь — сохранится сам')
              : specDirty
                ? (missing.length ? t('черновик не сохранён: не хватает настроек') : t('сохраняю черновик…'))
                : everyDirty
                  ? t('частота опроса не сохранена: она общая для источника')
                  : savedAt
                    ? t('черновик сохранён в {time}', { time: new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
                    : t('черновик сохранён')}
          </span>
        ) : (
          dirty && <span className="warn small">{t('есть несохранённые изменения')}</span>
        )}
        <span className={styles.barGap} />
        {missing.includes('block') && <span className="warn small">{t('Выбери блок, перед которым ждать.')}</span>}
        {missing.includes('kind') && <span className="warn small">{t('Назови вид дела.')}</span>}
        {missing.includes('close') && <span className="warn small">{t('Напиши, когда закрыть дело.')}</span>}
        {draft || r.spec.enabled === false ? (
          <>
            {!draft && (
              <button type="button" className="btn" disabled={saving || !dirty || missing.length > 0} onClick={() => void save(false)}>
                {t('Сохранить')}
              </button>
            )}
            {draft && everyDirty && (
              <button type="button" className="btn" disabled={saving || missing.length > 0} title={t('Частота опроса живёт в источнике и действует на все его рутины, поэтому сама не сохраняется')} onClick={() => void save(false)}>
                {t('Сохранить частоту опроса')}
              </button>
            )}
            <button type="button" className="btn primary" disabled={saving || missing.length > 0} onClick={() => void save(true)}>{t('Включить')}</button>
          </>
        ) : (
          <button type="button" className="btn primary" disabled={saving || !dirty || missing.length > 0} onClick={() => void save()}>{t('Сохранить')}</button>
        )}
      </div>
    </>
  );
}

type ClauseProps = { d: RoutineDraft; set: (p: Partial<RoutineDraft>) => void };

/** Что делает узел, одной фразой: шапка панели настроек. */
function nodeAbout(id: NodeId): string {
  return {
    trigger: t('С чего всё начинается: источник отдаёт новые события или наступает время по расписанию.'),
    conds: t('Первый отбор — по полям события, без модели.'),
    ai: t('Модель читает событие и решает, что с ним делать.'),
    task: t('Событие становится делом на доске «Мои дела».'),
    run: t('Что запускается по событию и где.'),
    wait: t('Где рутина останавливается и ждёт твоего решения.'),
    reply: t('Сообщать ли о результате туда, откуда пришло событие.'),
  }[id];
}

function NodePanel({ node, children }: { node: GraphNode; children: ReactNode }) {
  return (
    <section className={styles.rule} aria-label={t('Настройки узла «{title}»', { title: node.title })}>
      <header className={styles.nodeHead}>
        <h2>{node.title}</h2>
        <span className={cx(styles.nodeWho, node.who.kind === 'model' && styles.model, node.who.kind === 'me' && styles.me)}>{node.who.label}</span>
        <span className={styles.nodeAbout}>{nodeAbout(node.id)}</span>
      </header>
      {children}
    </section>
  );
}

/**
 * Узел «ИИ рутины» (when.check, when.model, when.ask — docs/ASSISTANTS.md §5): что это, что модель получает и что
 * решает, условие словами, модель и сколько узел стоил на последней проверке на истории.
 */
function AiClause({ d, set, hist, runs, sample }: ClauseProps & { hist: HistoryCheck | null; /** Рутина запускает flow: без него спрашивать не о чем. */ runs: boolean; /** Пример события: что модель прочитает. */ sample?: ReactNode }) {
  const on = Boolean(d.check.trim());
  const check = hist?.check;
  return (
    <>
      <div className={styles.clause}>
        <span className={styles.k}>{t('Что это')}</span>
        <div className={styles.clauseBody}>
          <span>{t('Модель читает каждое событие, которое прошло условия по полям, и решает, что с ним делать. Нужен там, где по полям не отобрать: «это баг, а не вопрос», «просят меня, а не упоминают». Работает до запуска flow, поэтому лишнее отсекается дёшево.')}</span>
          {!on && <span className={styles.warn}>{t('Сейчас узел выключен: условия словами нет, и дальше идёт всё, что прошло условия по полям. Напиши условие ниже — и узел начнёт читать события.')}</span>}
        </div>
      </div>
      <div className={styles.clause}>
        <span className={styles.k}>{t('Получает')}</span>
        <ul className={styles.plain}>
          <li>{t('текст события и его поля')}</li>
          <li>{t('твоё условие словами')}</li>
          <li>{t('недавно запущенные события — чтобы не запускать то же самое дважды')}</li>
          <li>{t('твои поправки из «Срабатываний»: «зря запустилась», «это подходит», «не повтор»')}</li>
        </ul>
      </div>
      {sample}
      <div className={styles.clause}>
        <label className={styles.k} htmlFor="cond">{t('Условие')}</label>
        <div className={styles.clauseBody}>
          <textarea id="cond" className={styles.inp} rows={3} placeholder={t('Например: это запрос на ревью именно мне. Обсуждение чужого MR, где меня просто упомянули, не подходит.')} value={d.check} onChange={(e) => set({ check: e.target.value })} />
          <span className={styles.hint}>{t('Пиши как коллеге. Пусто — узел выключен. Что событие — данные, а не команды, модель знает сама.')}</span>
        </div>
      </div>
      <div className={styles.clause}>
        <span className={styles.k}>{t('Решает')}</span>
        <div className={styles.clauseBody}>
          <ul className={styles.plain}>
            <li><b>{t('Запустить')}</b> — {t('событие идёт дальше по графу')}</li>
            <li><b>{t('Пропустить')}</b> — {t('запись в «Срабатываниях» с причиной; повтор недавнего — тоже сюда')}</li>
          </ul>
          <label className={styles.checkRow}>
            <input type="checkbox" checked={d.checkAsk && runs} disabled={!on || !runs} onChange={(e) => set({ checkAsk: e.target.checked })} />
            <span><b>{t('Спросить меня')}</b> — {t('когда модель не уверена, событие ждёт тебя на главной с её сомнением, а не отсеивается молча')}</span>
          </label>
          {on && runs && !d.checkAsk && <span className={styles.hint}>{t('Без этого неуверенный ответ считается «пропустить»: лишний запуск стоит денег.')}</span>}
          {on && !runs && <span className={styles.hint}>{t('Рутина без flow только заводит дела: спрашивать не о чем, неуверенный ответ считается «пропустить».')}</span>}
        </div>
      </div>
      <div className={styles.clause}>
        <span className={styles.k}>{t('Модель')}</span>
        <div className={styles.clauseBody}>
          <div className={styles.inline}>
            <ModelPick
              value={d.checkModel}
              onChange={(checkModel) => set({ checkModel })}
              defaultLabel={DEFAULT_CHECK_MODEL}
              label={t('Модель узла «ИИ рутины»')}
              disabled={!on}
              selectClassName={cx(styles.inp, styles.inlineSel)}
              inputClassName={cx(styles.inp, styles.mono, styles.flowSearch)}
            />
          </div>
          <span className={styles.hint}>
            {check
              ? t('На последней проверке на истории узел прочитал {n} {w}: {usd}{model}. Сменишь модель — проверь на истории снова.', {
                  n: check.events,
                  w: plural(check.events, 'событие', 'события', 'событий'),
                  usd: usd(check.costUsd),
                  model: check.model ? ` · ${modelChip(check.model)}` : '',
                }) + (check.cached ? ` ${t('Из них {n} — ответы прошлой проверки: то же событие по тому же условию модель не перечитывает.', { n: check.cached })}` : '')
              : t('Быстрая модель дешевле и обычно справляется; на спорных событиях точнее сильная. Сколько узел стоит на твоих событиях, покажет «Проверить на истории» ниже.')}
          </span>
        </div>
      </div>
    </>
  );
}

function ScheduleClause({ d, set }: ClauseProps) {
  const now = useNow(60_000);
  const next = formatNext(nextRuns(toCron(d.schedule), new Date(now), 3), new Date(now));
  const custom = d.schedule.preset === 'custom';
  return (
    <>
      <div className={styles.inline}>
        <Seg<SchedulePreset>
          label={t('Как часто')}
          value={d.schedule.preset}
          onChange={(preset) => set({ schedule: { ...d.schedule, preset, cron: preset === 'custom' ? toCron(d.schedule) : d.schedule.cron } })}
          options={[...PRESETS, 'custom' as const].map((p) => ({ value: p, label: presetLabel(p) }))}
        />
        {!custom && d.schedule.preset !== 'hourly' && (
          <input className={cx(styles.inp, styles.mono, styles.inlineSel)} type="time" aria-label={t('Время')} value={d.schedule.time} onChange={(e) => set({ schedule: { ...d.schedule, time: e.target.value || '09:30' } })} />
        )}
        {custom && <input className={cx(styles.inp, styles.mono, styles.flowSearch)} aria-label="cron" placeholder="30 9 * * 1-5" value={d.schedule.cron ?? ''} onChange={(e) => set({ schedule: { ...d.schedule, cron: e.target.value } })} />}
      </div>
      <span className={styles.mono}>{next ? t('Ближайшие: {list}', { list: next }) : t('Расписание не разобрать: cron из 5 полей, «минута час день месяц день-недели».')}</span>
      <div className={styles.sentence}>
        {t('Пропущенное, пока приложение закрыто,')}{' '}
        <select className={styles.slot} aria-label={t('Пропущенное время')} value={d.missed} onChange={(e) => set({ missed: e.target.value as 'ask' | 'skip' })}>
          <option value="ask">{t('спросить один раз')}</option>
          <option value="skip">{t('пропустить молча')}</option>
        </select>
      </div>
    </>
  );
}

/**
 * «Как часто спрашивать сервис» — интервал опроса источника (every). Он общий для всех рутин источника, поэтому рядом
 * сказано, сколько их; у live-источников (Slack, Telegram) опроса нет — события приходят сразу.
 */
function PollClause({ source, kind, value, onChange }: { source: SourceView; kind: SourceKindView | undefined; value: string | undefined; onChange: (v: string) => void }) {
  if (kind?.delivery === 'live') return <span className={styles.hint}>{t('События из «{title}» приходят сразу, опрашивать сервис не нужно.', { title: source.spec.title })}</span>;
  const current = value ?? source.spec.every ?? '5m';
  const others = source.usedBy.length;
  return (
    <div className={styles.poll}>
      <label className={styles.sentence} htmlFor="poll-every">
        {t('Спрашивать «{title}»', { title: source.spec.title })}{' '}
        <select id="poll-every" className={styles.slot} value={current} onChange={(e) => onChange(e.target.value)}>
          {pollChoices(kind?.minEvery, current).map((v) => (
            <option key={v} value={v}>{everyLabel(v)}</option>
          ))}
        </select>
      </label>
      <span className={styles.hint}>
        {others > 1 ? t('Частота общая для источника: ей пользуются рутин — {n}. ', { n: others }) : ''}
        {kind?.minEvery ? t('Не чаще, чем {every}. ', { every: everyLabel(kind.minEvery) }) : ''}
        {t('Сохраняется вместе с правилом и действует сразу, без перезапуска. «Проверить сейчас» — в «Источниках» на списке рутин.')}
      </span>
    </div>
  );
}

function RunClause({ d, set }: ClauseProps) {
  const flows = useFlows();
  const spacesOn = useFeature('spaces');
  const spaces = useSpaces(spacesOn);
  const list = (flows.data ?? []).filter((f) => f.valid);
  // рутина с делом из события может ничего не запускать: событие только заводит дело
  const taskOnly = d.taskOn && d.taskFrom === 'event';
  const runs = draftRuns(d);
  return (
    <div className={styles.clause}>
      <span className={styles.k}>{t('Запустить')}</span>
      <div className={styles.clauseBody}>
        <div className={styles.inline}>
          <select className={styles.slot} aria-label="Flow" value={d.flow} onChange={(e) => set({ flow: e.target.value, pauseBefore: [], mode: d.mode === 'until_pause' ? 'suggest' : d.mode })}>
            {taskOnly && <option value="">{t('ничего — только завести дело')}</option>}
            {!list.some((f) => f.name === d.flow) && (d.flow || !taskOnly) && <option value={d.flow}>{d.flow || t('выбери flow')}</option>}
            {list.map((f) => (
              <option key={f.name} value={f.name}>{f.name}</option>
            ))}
          </select>
          {spacesOn && runs && (
            <>
              <span>{t('в')}</span>
              <SpacePicker id="routine-edit-space" value={d.space} onChange={(space) => set({ space })} options={spaces.data?.spaces ?? []} loading={spaces.isPending} compact placeholder={t('без пространства')} className={styles.flowSearch} inputClassName={styles.slot} />
            </>
          )}
        </div>
        {runs && (
          <label className={styles.clauseBody}>
            <span className={styles.lbl}>{t('Что поручить flow')}</span>
            <textarea className={styles.inp} rows={2} placeholder={t('Например: сделай ревью MR и оставь замечания. Пусто — задача из самого flow')} value={d.input} onChange={(e) => set({ input: e.target.value })} />
          </label>
        )}
        {runs && !isSchedule(d) && (
          <span className={styles.hint}>
            {t('К задаче flow получит событие: заголовок, автора, ссылку, текст и поля. Передавать их отдельно не нужно: что именно придёт — ниже, в «Получит».')}
          </span>
        )}
      </div>
    </div>
  );
}

const KINDS = ['Ревью', 'Jira', 'Встреча', 'Задача', 'Своё'];
/** Засев дел по текущему списку — не больше стольких записей (SEED_MAX в src/routines/engine.ts). */
const SEED_MAX = 50;

/**
 * «Дело» (блок task, docs/desk/design/RulePult.dc.html): «Завести дело как Ревью в Новое. Тем же делом считать ту же
 * вещь; пришло новое — вернуть в план. Закрыть, когда вещь закрыта». Дела из flow заводит сам flow (desk_put).
 */
function TaskClause({ d, set }: ClauseProps) {
  const closeChoice = isCloseText(d.taskClose) ? 'text' : d.taskClose;
  const spacesOn = useFeature('spaces');
  // у рутины без flow проект дела выбирается здесь (с flow — пространство запуска в «Запустить»)
  const ownProject = spacesOn && !draftRuns(d);
  const spaces = useSpaces(ownProject);
  return (
    <div className={styles.clause}>
      <span className={styles.k}>{t('Дело')}</span>
      <div className={styles.clauseBody}>
        <Seg<'off' | 'on'>
          label={t('Заводить дело')}
          value={d.taskOn ? 'on' : 'off'}
          onChange={(v) => set(v === 'on' ? { taskOn: true, taskKind: d.taskKind || KINDS[0]! } : { taskOn: false })}
          options={[
            { value: 'off', label: t('не заводить') },
            { value: 'on', label: t('завести дело'), title: t('Событие становится делом в «Моих делах»: одно дело на вещь, сколько бы событий о ней ни пришло') },
          ]}
        />
        {d.taskOn && (
          <>
            <div className={styles.sentence}>
              {t('Завести дело как')}{' '}
              <input
                className={cx(styles.slot, styles.taskKind)}
                list="routine-task-kinds"
                size={Math.max(d.taskKind.length, 6)}
                aria-label={t('Вид дела')}
                value={d.taskKind}
                onChange={(e) => set({ taskKind: e.target.value })}
              />
              <datalist id="routine-task-kinds">
                {KINDS.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>{' '}
              {t('в')}{' '}
              <select className={styles.slot} aria-label={t('Колонка')} value={d.taskColumn} onChange={(e) => set({ taskColumn: e.target.value as RoutineDraft['taskColumn'] })}>
                <option value="new">{t('Новое')}</option>
                <option value="plan">{t('В плане')}</option>
              </select>
              {'. '}
              {t('Заводит')}{' '}
              <select className={styles.slot} aria-label={t('Кто заводит дело')} value={d.taskFrom} onChange={(e) => set({ taskFrom: e.target.value as RoutineDraft['taskFrom'] })}>
                <option value="event">{t('само событие')}</option>
                <option value="flow">{t('flow, инструментом desk_put')}</option>
              </select>
            </div>
            {ownProject && (
              <div className={styles.inline}>
                <span>{t('Проект дела')}</span>
                <SpacePicker id="routine-task-space" value={d.space} onChange={(space) => set({ space })} options={spaces.data?.spaces ?? []} loading={spaces.isPending} compact placeholder={t('без проекта')} className={styles.flowSearch} inputClassName={styles.slot} />
              </div>
            )}
            {d.taskFrom === 'event' && (
              <>
                <div className={styles.sentence}>
                  {t('Тем же делом считать')}{' '}
                  <select className={styles.slot} aria-label={t('Что считать тем же делом')} value={d.taskSame} onChange={(e) => set({ taskSame: e.target.value as RoutineDraft['taskSame'] })}>
                    <option value="">{t('ту же вещь, иначе тот же разговор')}</option>
                    <option value="thing">{t('ту же вещь (MR, задачу)')}</option>
                    <option value="thread">{t('тот же разговор (тред)')}</option>
                    <option value="event">{t('ничего — каждое событие отдельно')}</option>
                  </select>
                  {'; '}
                  {t('пришло новое по тому же —')}{' '}
                  <select
                    className={styles.slot}
                    aria-label={t('Пришло новое по тому же делу')}
                    value={d.taskRepeat}
                    onChange={(e) => set({ taskRepeat: e.target.value as RoutineDraft['taskRepeat'] })}
                  >
                    <option value="plan">{t('вернуть в план')}</option>
                    <option value="keep">{t('оставить, где лежит')}</option>
                  </select>
                </div>
                <div className={styles.sentence}>
                  {t('Закрыть, когда')}{' '}
                  <select className={styles.slot} aria-label={t('Когда закрыть дело')} value={closeChoice} onChange={(e) => set({ taskClose: e.target.value === 'text' ? '' : e.target.value })}>
                    <option value="thing">{t('вещь закрыта (MR смержен, задача готова)')}</option>
                    <option value="never">{t('закрою сам')}</option>
                    <option value="text">{t('условие словами…')}</option>
                  </select>
                </div>
                {closeChoice === 'text' && (
                  <>
                    <input
                      className={styles.inp}
                      aria-label={t('Условие закрытия')}
                      placeholder={t('Например: в треде ответили «готово»')}
                      value={d.taskClose}
                      onChange={(e) => set({ taskClose: e.target.value })}
                    />
                    <span className={styles.hint}>{t('Условие словами пока не проверяется само: такое дело закроешь руками.')}</span>
                  </>
                )}
              </>
            )}
            <span className={styles.hint}>
              {d.taskFrom === 'flow'
                ? t('Дела заводит flow инструментом desk_put — по одному на вещь, о которой он узнал.')
                : t('Одно дело на вещь: сколько бы сигналов о ней ни пришло из этой и других рутин, дело одно.')}
            </span>
            {d.taskFrom === 'event' && !isSchedule(d) && d.check.trim() && (
              <span className={styles.hint}>{t('Первый опрос заведёт дела по текущему списку источника: до {n} записей, и каждую проверит словами — это расход модели.', { n: SEED_MAX })}</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function WaitBlocks({ d, set }: ClauseProps) {
  const blocks = useFlowBlocks(d.flow);
  return <WaitClause mode={d.mode} blocks={blocks} pauseBefore={d.pauseBefore} onChange={(mode, pauseBefore) => set({ mode, pauseBefore })} />;
}

const ON: Array<{ v: 'start' | 'pause' | 'end'; label: string }> = [
  { v: 'start', label: t('когда начал') },
  { v: 'pause', label: t('когда жду тебя') },
  { v: 'end', label: t('в конце') },
];

/** Узел «Ответить»: сообщать ли о результате, куда и когда. */
function ReplyClause({ d, set, data, kindCanReply, replyNotSet, source }: ClauseProps & { data: RoutinesOverview; kindCanReply: boolean; replyNotSet: boolean; source: SourceView | undefined }) {
  const [setupOpen, setSetupOpen] = useState(false);
  const targets = data.sources.filter((s) => s.slug !== d.source && s.canReply);
  const kind = data.sources.find((s) => s.slug === d.source)?.spec.kind;
  const toggleOn = (v: 'start' | 'pause' | 'end') => set({ replyOn: d.replyOn.includes(v) ? d.replyOn.filter((x) => x !== v) : [...d.replyOn, v] });
  return (
        <div className={styles.clause}>
          <span className={styles.k}>{t('Ответить')}</span>
          <div className={styles.clauseBody}>
            <Seg<ReplyChoice> label={t('Сообщать о результате')} value={d.reply} onChange={(reply) => set({ reply })} options={REPLY_CHOICES.map((c) => ({ value: c, label: replyLabel(c), disabled: c !== 'off' && !kindCanReply && !targets.length }))} />
            {d.reply !== 'off' && (
              <div className={styles.sentence}>
                <select className={styles.slot} aria-label={t('Куда писать')} value={d.replyTo} onChange={(e) => set({ replyTo: e.target.value })}>
                  {kindCanReply && <option value="source">{replyWhere(kind, 'source', data.sources)}</option>}
                  {targets.map((s) => (
                    <option key={s.slug} value={s.slug}>{replyWhere(undefined, s.slug, data.sources)}</option>
                  ))}
                  {!kindCanReply && !targets.some((s) => s.slug === d.replyTo) && <option value={d.replyTo}>{d.replyTo}</option>}
                </select>
                ,{' '}
                <span className={styles.chipsInline}>
                  {ON.map((o) => (
                    <button key={o.v} type="button" className={styles.chip} aria-pressed={d.replyOn.includes(o.v)} onClick={() => toggleOn(o.v)}>{o.label}</button>
                  ))}
                </span>
              </div>
            )}
            {replyNotSet && (
              <span className={styles.hint}>
                {t('Ответ в источник не настроен: у «Сервиса через Claude» нет инструмента для ответа. Отвечать можно из flow: дай этапу инструмент коннектора. Или выбери инструмент ответа для этого источника.')}{' '}
                {!setupOpen && <button type="button" className="btn small ghost" onClick={() => setSetupOpen(true)}>{t('Настроить ответ')}</button>}
              </span>
            )}
            {replyNotSet && setupOpen && source && <SourceReplyPanel source={source} mode={d.reply} onClose={() => setSetupOpen(false)} />}
          </div>
        </div>
  );
}

/** Узел «Запустить flow», вторая половина: где работать, лимиты и модель flow. */
function RunExtras({ d, set }: ClauseProps) {
  return (
    <>
      <div className={styles.clause}>
        <span className={styles.k}>{t('Где')}</span>
        <div className={styles.clauseBody}>
          <div className={styles.sentence}>
            {t('в')}{' '}
            <select className={styles.slot} aria-label={t('Рабочее дерево')} value={d.worktree} onChange={(e) => set({ worktree: e.target.value as 'new' | 'none' })}>
              <option value="none">{t('рабочей папке')}</option>
              <option value="new">{t('новом рабочем дереве')}</option>
            </select>
          </div>
          <CwdField value={d.cwd} onChange={(cwd) => set({ cwd })} />
        </div>
      </div>
      <div className={styles.clause}>
        <span className={styles.k}>{t('Лимит')}</span>
        <div className={styles.inline}>
          <label className={styles.inline}>
            <input className={cx(styles.inp, styles.mono, styles.inlineSel)} size={5} inputMode="decimal" aria-label={t('Бюджет на запуск, $')} placeholder="$" value={d.usd} onChange={(e) => set({ usd: e.target.value })} />
            <span>{t('на запуск,')}</span>
          </label>
          <label className={styles.inline}>
            <input className={cx(styles.inp, styles.mono, styles.inlineSel)} size={3} inputMode="numeric" aria-label={t('Запусков в день')} value={d.perDay} onChange={(e) => set({ perDay: e.target.value })} />
            <span>{t('запусков в день,')}</span>
          </label>
          <label className={styles.inline}>
            <input className={cx(styles.inp, styles.mono, styles.inlineSel)} size={3} inputMode="numeric" aria-label={t('Одновременно')} value={d.parallel} onChange={(e) => set({ parallel: e.target.value })} />
            <span>{t('одновременно')}</span>
          </label>
        </div>
      </div>
      <div className={styles.clause}>
        <span className={styles.k}>{t('Модель')}</span>
        <div className={styles.clauseBody}>
          <div className={styles.inline}>
            <ModelPick value={d.model} onChange={(model) => set({ model })} defaultLabel={t('как в flow')} label={t('Модель flow в запусках рутины')} selectClassName={cx(styles.inp, styles.inlineSel)} inputClassName={cx(styles.inp, styles.mono, styles.flowSearch)} />
          </div>
          <span className={styles.hint}>{t('«Как в flow» — каждый этап идёт на своей модели из flow. Своя модель здесь заменяет её во всех этапах запусков этой рутины.')}</span>
        </div>
      </div>
    </>
  );
}

/** Правило файлом: YAML как есть. Сохранение YAML перечитывает форму с файла. */
function YamlClause({ r, onYamlSaved }: { r: RoutineView; onYamlSaved: () => void }) {
  const [yaml, setYaml] = useState(r.yaml);
  const [yamlErr, setYamlErr] = useState('');
  const qc = useQueryClient();
  const saveYaml = async () => {
    setYamlErr('');
    try {
      const next = await saveRoutine(r.slug, { yaml });
      qc.setQueryData(routineKeys.one(r.slug), next);
      onYamlSaved();
    } catch (e) {
      const list = e instanceof ApiError ? (e.data as { problems?: string[] } | undefined)?.problems : undefined;
      setYamlErr(list?.length ? list.join('\n') : errorText(e));
    }
  };
  return (
    <div className={styles.clause}>
      <span className={styles.k}>YAML</span>
      <div className={styles.clauseBody}>
        <textarea className={cx(styles.inp, styles.yaml)} spellCheck={false} aria-label="YAML" value={yaml} onChange={(e) => setYaml(e.target.value)} />
        <div className="row">
          <button type="button" className="btn small" disabled={yaml === r.yaml} onClick={() => void saveYaml()}>{t('Сохранить YAML')}</button>
          <span className={styles.hint}>{t('Файл ~/.agentgraph/routines/{slug}.yaml. Несохранённая правка в узлах при этом теряется.', { slug: r.slug })}</span>
        </div>
        {yamlErr && <span className={styles.err} role="alert">{yamlErr}</span>}
      </div>
    </div>
  );
}

/**
 * «Проверить на истории»: последние события источника против правила как оно есть в форме. Строки, где правило решило
 * бы иначе, чем человек раньше («расходится»), видны всегда, с «Учесть» — ответ человека уходит в примеры проверки
 * словами, и проверка идёт заново. Сверху — «Запустилось бы N из M» и оценка в неделю. Пока проверка идёт, уже
 * проверенные события видны сразу, под ними — строка «смотрю дальше»: модель читает события по несколько, это минуты.
 */
function History({ slug, spec, sourceTitle, onResult }: { slug: string; spec: ReturnType<typeof buildSpec>; sourceTitle: string; /** Итог проверки — наверх: по нему счётчики на узлах графа. */ onResult?: (r: HistoryCheck | null) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  // итог живёт в кэше запросов (ключ вне ['routines']): «Сохранить» монтирует редактор заново, и проверка не должна
  // уходить ещё раз — с проверкой словами это до 30 вызовов модели
  const cacheKey = ['routine-history', slug];
  const cached = qc.getQueryData<{ res: HistoryCheck; spec: string }>(cacheKey);
  const [res, setRes] = useState<HistoryCheck | null>(cached?.res ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [skips, setSkips] = useState(false);
  const [checkedSpec, setCheckedSpec] = useState(cached?.spec ?? '');
  const key = JSON.stringify(spec);
  // счётчики на узлах — только пока проверка сделана по правилу как оно есть сейчас
  const fresh = res && checkedSpec === key ? res : null;
  useEffect(() => {
    onResult?.(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh]);
  /** Идущая проверка: что уже проверено. */
  const [progress, setProgress] = useState<HistoryRun | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const run = async () => {
    setBusy(true);
    setError('');
    setProgress(null);
    try {
      // ушли с экрана — проверка на сервере идёт дальше; вернулись — startHistory отдаёт её же, а не начинает вторую
      let job = await startHistory(slug, spec, HISTORY_LIMIT);
      while (job.state === 'working') {
        if (!alive.current) return;
        setProgress(job);
        await new Promise((r) => window.setTimeout(r, HISTORY_POLL_MS));
        job = await fetchHistoryRun(slug, job.id);
      }
      if (!job.result) throw new Error(job.error || t('Проверка не удалась'));
      setRes(job.result);
      setCheckedSpec(key);
      qc.setQueryData(cacheKey, { res: job.result, spec: key });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  const learn = async (eventId: string, verdict: Verdict) => {
    setBusy(true);
    try {
      await sendFeedback(slug, eventId, verdict);
    } catch (e) {
      toast(errorText(e));
      setBusy(false);
      return;
    }
    await run();
  };
  // сама — только при первом открытии рутины; дальше — по кнопке
  useEffect(() => {
    if (!cached) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  const live = busy ? progress : null;
  const events = live ? live.events : (res?.events ?? []);
  const withAi = 'check' in spec.when && Boolean(spec.when.check?.trim());
  const rows = events.map((e) => {
    const tv = taskVerdict(e.task);
    return { e, v: historyVerdict(e), task: tv && { ...tv, closed: e.task?.action === 'closed' } };
  });
  const runs = rows.filter((r) => r.v.run).length;
  // запуски и расхождения видны всегда, остальные пропуски — по кнопке
  const asks = rows.filter((r) => r.e.unsure).length;
  const hidden = rows.filter((r) => !r.v.run && !r.v.disagrees && !r.e.unsure);
  const shown = skips ? rows : rows.filter((r) => r.v.run || r.v.disagrees || r.e.unsure);
  const stale = res && !live && checkedSpec !== key;
  const est = estimateText(res?.estimate);
  // рутина с делом: главное — сколько дел было бы на доске; запуски — рядом, если рутина ещё и запускает flow
  const tasks = res?.tasks;
  return (
    <section className={styles.history} aria-label={t('Проверка на истории')}>
      <div className={styles.histHead}>
        <span className={styles.lbl}>
          {live ? t('Проверяю правило на последних событиях {source}', { source: sourceTitle }) : res ? t('Проверка на последних {n} событиях {source}', { n: events.length, source: sourceTitle }) : t('Проверить на истории')}
        </span>
        <span className={styles.barGap} />
        <button type="button" className={cx('btn small', !stale && res ? 'ghost' : '')} disabled={busy} title={t('Прогнать правило по последним событиям источника. Проверка словами тратит немного модели')} onClick={() => void run()}>
          {busy ? t('Проверяю…') : res ? t('Проверить снова') : t('Проверить на истории')}
        </button>
      </div>
      {error && <span className={styles.err}>{error}</span>}
      {(live ? live.total > 0 : res) && (
        <>
          <div className={styles.histHead}>
            {live ? (
              <>
                <span className={styles.histBig}>{t('Пока запустилось бы {k} из {n}', { k: runs, n: events.length })}</span>
                <span className={styles.mono}>{t('проверено {k} из {n}', { k: events.length, n: live.total })}</span>
              </>
            ) : tasks !== undefined ? (
              <>
                <span className={styles.histBig}>{t('На доске было бы {n} {w}', { n: tasks, w: plural(tasks, 'новое дело', 'новых дела', 'новых дел') })}</span>
                {spec.run && <span className={styles.mono}>{t('запустилось бы {k} из {n}', { k: runs, n: events.length })}</span>}
              </>
            ) : (
              <span className={styles.histBig}>{t('Запустилось бы {k} из {n}', { k: runs, n: events.length })}</span>
            )}
            {asks > 0 && <span className={styles.mono} title={t('События, в которых «ИИ рутины» не уверен: они ждали бы тебя на главной')}>{t('спросит тебя: {n}', { n: asks })}</span>}
            {!live && est && <span className={styles.mono} title={t('По средней стоимости прошлых запусков рутины или flow')}>{est}</span>}
            {stale && <span className="warn small">{t('правило поменялось — проверь снова')}</span>}
          </div>
          {!live && res && res.disagreements > 0 && (
            <span className="err small">
              {t('С твоими прошлыми ответами расходится {n} {w}.', { n: res.disagreements, w: plural(res.disagreements, 'событие', 'события', 'событий') })}
            </span>
          )}
          <div>
            {shown.map(({ e, v, task }) => (
              <div key={e.event.id} className={cx(styles.dr, v.disagrees && styles.bad)}>
                <span className={cx(styles.drV, v.run && styles.run, e.unsure && styles.ask, task?.closed && styles.closed)}>{e.unsure ? v.text : (task?.text ?? v.text)}</span>
                <span title={e.event.text}>{e.event.title || e.event.text}</span>
                {v.disagrees && e.past && (
                  <button type="button" className={cx('btn small', styles.drAct)} disabled={busy} title={t('Взять твой прошлый ответ в примеры проверки словами и проверить снова')} onClick={() => void learn(e.event.id, e.past!)}>
                    {t('Учесть')}
                  </button>
                )}
                {(task?.why || v.why) && <span className={cx(styles.drWhy, v.disagrees && styles.bad)}>{[task?.why, v.why].filter(Boolean).join(' · ')}</span>}
              </div>
            ))}
            {!live && !events.length && <span className={styles.hint}>{t('Событий из источника пока нет: проверить не на чем.')}</span>}
          </div>
          {hidden.length > 0 && (
            <button type="button" className={cx('btn small ghost', styles.selfStart)} aria-expanded={skips} onClick={() => setSkips(!skips)}>
              {skips ? t('Скрыть пропущенные') : t('Показать {n} пропущенных', { n: hidden.length })}
            </button>
          )}
          {!live && res?.preview && (
            <details className={styles.preview}>
              <summary>{t('Что получит flow — на событии «{title}»', { title: events.find((e) => e.event.id === res.preview!.eventId)?.event.title ?? res.preview.eventId })}</summary>
              <pre className={styles.previewText}>{[res.preview.task ?? t('(задача из input flow)'), res.preview.event].join('\n\n')}</pre>
            </details>
          )}
        </>
      )}
      {live && (
        <div className={styles.histProgress} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          <span>
            {live.total === 0
              ? t('Читаю последние события {source}…', { source: sourceTitle })
              : withAi
                ? t('Смотрю дальше: осталось {n} из {total}. «ИИ рутины» читает события по несколько сразу; прочитанные раньше не перечитывает.', { n: live.total - events.length, total: live.total })
                : t('Смотрю дальше: осталось {n} из {total}.', { n: live.total - events.length, total: live.total })}
          </span>
        </div>
      )}
    </section>
  );
}

