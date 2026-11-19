// «Новая рутина» (/routines/new, docs/routines/design/New.dc.html): четыре шага — что запускает (подключённый источник,
// расписание или «Другой сервис…»), какие записи (условия на поля, проверка словами, что пришло последним) или когда,
// что запустить (flow, пространство, папка, когда ждать меня), сообщать ли о результате. Сбоку — фраза-итог из выбора.
// «Дальше: проверка на истории» сохраняет рутину выключенной (черновиком) и открывает редактор с проверкой на истории.
// До этого набранное лежит на сервере черновиком формы (docs/ASSISTANTS.md §3): сохраняется само, и уход на другой
// экран — подключить сервис, собрать flow — ничего не стирает; по возврате форма открывается с ним.
// ?tpl= — шаблон (lib/routines/templates.ts: источник + дело + готовый flow), ?source= — источник, только что подключённый
// на «Подключить сервис». Готовый flow шаблона, которого у пользователя нет, сервер копирует при сохранении.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ComposeView, RoutineAssistantDraft, RoutinesOverview, SourceView } from '@server/routines/types';
import { errorText, useFeature, useFlows } from '../../api';
import { dropFormDraft, ensureTemplateFlow, fetchFormDraft, routineKeys, saveFormDraft, saveRoutine, testSource, useFlowTemplates, useProfile, useRoutines } from '../../api/routines';
import { closeAssistant } from '../../api/assistant';
import { useSpaces } from '../../api/spaces';
import { SpacePicker } from '../../components/SpacePicker';
import { useToast } from '../../components/Toast';
import { useNow } from '../../components/useNow';
import { t } from '../../lib/i18n';
import { draftTouched, packDraft, pickNewFlow, unpackDraft, type FormChat, type FormDraftData } from '../../lib/routines/compose';
import { dirBlocks } from '../../lib/routines/dir';
import { matchFields } from '../../lib/routines/match';
import { defaultTitle, eventNoun, replyHint, replyLabel, replyWhere, sentence, step2Title } from '../../lib/routines/phrase';
import { formatNext, nextRuns, PRESETS, presetLabel, toCron, type SchedulePreset } from '../../lib/routines/schedule';
import { foundRow } from '../../lib/routines/source';
import { buildSpec, draftFromSpec, draftMissing, isSchedule, REPLY_CHOICES, SCHEDULE, slugify, type ReplyChoice, type RoutineDraft } from '../../lib/routines/spec';
import { connectHref, isMeetingSource, profileLine, ROUTINE_TEMPLATES, sourceForTemplate, templateConds, templateDraft, templateOf } from '../../lib/routines/templates';
import { NotAvailable } from './RoutinesList';
import { ComposeBox } from './ComposeBox';
import { ROUTINE_ASSISTANT, RoutineAssistant } from './RoutineAssistant';
import { CwdField, useDirNote } from './CwdField';
import { Conditions, cx, Seg, useFlowBlocks, WaitClause } from './parts';
import styles from './Routines.module.css';


/** Засев дел по текущему списку — не больше стольких записей (SEED_MAX в src/routines/engine.ts). */
const SEED_MAX = 50;

/** Черновик формы уходит на сервер через столько после последней правки. */
const DRAFT_SAVE_MS = 700;
const FORM_DRAFT_KEY = ['routine-form-draft'];

/** Ссылка «Собрать новый flow…»: диалог «Новый flow» живёт в шапке списка Flow сайдбара (как «с чего начать» на главной). */
const sidebarNewFlow = () => document.querySelector<HTMLButtonElement>(`button[title="${CSS.escape(t('Создать flow'))}"]`);

export function NewRoutine() {
  const q = useRoutines();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const tpl = params.get('tpl');
  const source = params.get('source');
  // черновик формы читается один раз на открытие экрана: дальше его ведёт сама форма
  const saved = useQuery({ queryKey: FORM_DRAFT_KEY, queryFn: fetchFormDraft, staleTime: Infinity, gcTime: 0, retry: false, refetchOnWindowFocus: false });
  const [resets, setResets] = useState(0);
  if (q.isError) return <NotAvailable error={q.error} />;
  if (!q.data || saved.isPending) return <p className="muted">{t('Загрузка…')}</p>;
  // шаблон — явное «начать с него»: форма открывается с ним, а не с черновиком. После каждого сохранения форма кладёт
  // черновик и в этот кэш, поэтому «Назад» с шаблона возвращает набранное, а «Начать заново» его обнуляет
  const draft = tpl ? undefined : unpackDraft(saved.data?.data);
  const reset = () => {
    void dropFormDraft().catch(() => undefined);
    qc.setQueryData(FORM_DRAFT_KEY, null);
    setResets((n) => n + 1);
  };
  // другой шаблон — форма заново
  return <NewForm key={`${tpl ?? ''}:${source ?? ''}:${resets}`} data={q.data} saved={draft} savedAt={draft ? saved.data?.at : undefined} noSave={saved.isError} onReset={reset} />;
}

type FormProps = {
  data: RoutinesOverview;
  /** Черновик формы с сервера. */
  saved?: FormDraftData;
  savedAt?: string;
  /** Черновик с сервера не прочитался: что там лежит, неизвестно — автосохранение выключено, чтобы его не затереть. */
  noSave: boolean;
  onReset: () => void;
};

function NewForm({ data, saved, savedAt: restoredAt, noSave, onReset }: FormProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const tpl = params.get('tpl');
  const tplInfo = templateOf(tpl);
  const toast = useToast();
  // форма открывается с черновиком; вернулись с «Подключить сервис» — ещё и с новым источником
  const fromParam = params.get('source');
  /** Черновик был про другой источник: условия на его поля к новому не подходят, ответ подстраивается заново. */
  const swapped = Boolean(saved && fromParam && saved.d.source && saved.d.source !== fromParam);
  const [d, setD] = useState<RoutineDraft>(() => {
    if (saved) return fromParam ? { ...saved.d, source: fromParam, ...(swapped ? { conds: [] } : {}) } : saved.d;
    const slug = params.get('source') ?? sourceForTemplate(tpl, data.sources);
    const picked = data.sources.find((s) => s.slug === slug);
    return { ...templateDraft(tpl, { source: picked, digestInput: t('Что в моих MR требует ответа сегодня') }), source: slug };
  });
  // встречи: «кто я» из профиля дописывается к задаче flow, пока человек её не правил
  const profile = useProfile(tpl === 'meetings');
  const me = profileLine(profile.data?.profile);
  useEffect(() => {
    if (tpl !== 'meetings' || !me) return;
    const plain = templateDraft(tpl).input;
    setD((x) => (x.input === plain ? { ...x, input: templateDraft(tpl, { me }).input } : x));
  }, [tpl, me]);
  const [titleEdited, setTitleEdited] = useState(Boolean(saved?.titleEdited));
  const [savedAt, setSavedAt] = useState<string | null>(restoredAt ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<RoutineDraft>) => setD((x) => ({ ...x, ...patch }));

  const source = data.sources.find((s) => s.slug === d.source);
  // шаблон «Встречи…», а источника встреч нет: не подсовываем чужой сервис, зовём подключить Fireflies
  const needFireflies = tpl === 'meetings' && !d.source && !data.sources.some(isMeetingSource);
  // у шаблона нет подключённого источника: зовём подключить нужный
  const needSource = Boolean(tplInfo?.connect) && !d.source && !needFireflies;
  const kind = source ? data.kinds.find((k) => k.kind === source.spec.kind) : undefined;
  const fields = useMemo(() => matchFields(kind), [kind]);
  const replyTargets = data.sources.filter((s) => s.canReply);
  const canReplySource = Boolean(source?.canReply);
  const srcInfo = source ? { title: source.spec.title, kind: source.spec.kind } : undefined;

  // куда отвечать: в источник, если он умеет; иначе — первый источник с ответом; некуда — «Не сообщать». «Не сообщать»,
  // поставленное здесь, а не человеком, снимается, как только отвечать снова есть куда
  const autoOff = useRef(false);
  // источник пришёл из черновика «Опиши словами»: ответ и «куда писать» там уже выбраны, не переписываем
  const fromCompose = useRef<string | null>(saved && !swapped ? d.source : null);
  useEffect(() => {
    const skip = fromCompose.current === d.source;
    fromCompose.current = null;
    if (!d.source || skip) return;
    const back = autoOff.current && d.reply === 'off' ? { reply: 'draft' as const } : {};
    if (canReplySource || replyTargets[0]) {
      autoOff.current = false;
      set({ replyTo: canReplySource ? 'source' : replyTargets[0]!.slug, ...back });
    } else if (d.reply !== 'off') {
      autoOff.current = true;
      set({ reply: 'off' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.source]);

  const title = titleEdited ? d.title : tplInfo ? t(tplInfo.title) : defaultTitle(d, source?.spec.title);
  // обход проекта и «задача в работу» идут в папке проекта (своей или пространства): без неё обходить и править нечего
  const missing = [...draftMissing(d), ...(tplInfo?.needsDir && d.flow === tplInfo.flow && !d.cwd.trim() && !d.space ? (['cwd'] as const) : [])];
  const missingText = missing.map((m) => ({ source: t('выбери, что запускает'), flow: t('выбери flow'), block: t('выбери блок, перед которым ждать'), kind: t('назови вид дела'), close: t('напиши, когда закрыть дело'), cwd: t('выбери папку проекта или пространство') })[m]).join(', ');
  const flows = useFlows();
  const dirNote = useDirNote(d.cwd, d.worktree);
  const dirErr = dirBlocks(dirNote);

  // черновик формы — на сервер: сам, через паузу после правки. Пустую форму не пишем; форму, которую ещё не трогали
  // (открыли шаблон и посмотрели), — тоже: она затёрла бы черновик, с которым человек сюда пришёл
  // разговор с помощником — часть черновика: по возврате на форму лента открывается, а принятый результат второй раз не ложится
  const hasAssistant = useFeature('routine-assistant');
  const [chat, setChat] = useState<FormChat | undefined>(saved?.chat);
  const touched = draftTouched(d) || Boolean(chat);
  /** Какие flow были, когда ушли собирать новый: живёт в черновике, пока форма открыта, а не в одном запросе. */
  const flowsBefore = useRef<string[] | undefined>(undefined);
  const payload = JSON.stringify(packDraft({ ...d, title: titleEdited ? d.title : '' }, titleEdited, flowsBefore.current, chat));
  const lastSaved = useRef<string | null>(null);
  if (lastSaved.current === null) lastSaved.current = saved ? JSON.stringify(packDraft({ ...saved.d, title: saved.titleEdited ? saved.d.title : '' }, saved.titleEdited, undefined, saved.chat)) : payload;
  /** Форма больше не черновик: рутина сохранена правилом или человек начал заново. */
  const closed = useRef(false);
  const timer = useRef<number | null>(null);
  const stopTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  /** Отправить черновик сейчас. leaving — уходим с экрана: запрос должен дойти и после смены экрана. */
  const send = (text: string, leaving = false) => {
    stopTimer();
    lastSaved.current = text;
    const data = JSON.parse(text) as FormDraftData;
    // keepalive-запрос браузер не пошлёт с телом больше 64 КБ
    return saveFormDraft(data, leaving && text.length < 30_000)
      .then((r) => {
        qc.setQueryData(FORM_DRAFT_KEY, { at: r.at, data });
        return r;
      });
  };
  const pending = !noSave && touched && payload !== lastSaved.current;
  useEffect(() => {
    if (!pending || closed.current) return;
    timer.current = window.setTimeout(() => {
      void send(payload)
        .then((r) => setSavedAt(r.at))
        .catch(() => undefined);
    }, DRAFT_SAVE_MS);
    return stopTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, pending]);
  // ушли с экрана раньше паузы (сайдбар, шаблон, «Назад»): последняя правка уходит сейчас
  const unsent = useRef<string | null>(null);
  unsent.current = pending ? payload : null;
  useEffect(
    () => () => {
      if (unsent.current && !closed.current) void send(unsent.current, true).catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  /** Уходим с формы по ссылке или кнопке: сохранить сейчас, не дожидаясь паузы. */
  const flush = (before?: string[]) => {
    if (noSave) return;
    if (before) flowsBefore.current = before;
    void send(JSON.stringify(packDraft({ ...d, title: titleEdited ? d.title : '' }, titleEdited, flowsBefore.current, chat)), true).catch(() => undefined);
  };
  // вернулись со сборки flow: единственный flow, которого не было до ухода, подставляется сам
  const [pickedFlow, setPickedFlow] = useState('');
  const pickDone = useRef(false);
  useEffect(() => {
    if (pickDone.current || !saved?.flowsBefore || !flows.data) return;
    pickDone.current = true;
    const fresh = pickNewFlow(saved.flowsBefore, flows.data.filter((f) => f.valid).map((f) => f.name));
    if (fresh && !d.flow) {
      set({ flow: fresh });
      setPickedFlow(fresh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flows.data]);
  const buildFlow = (names: string[]) => {
    flush(names);
    toast(t('Черновик рутины сохранён. Собери flow и вернись в «Новую рутину» — он подставится сам.'));
  };

  const applyCompose = useCallback((v: Extract<ComposeView, { state: 'ready' }>) => {
    // узел «ИИ рутины» из собранного черновика — новый узел: «спросить меня» у него включено, как у созданного руками
    const next = { ...draftFromSpec(v.spec), checkAsk: true };
    fromCompose.current = next.source;
    setD(next);
    setTitleEdited(true);
  }, []);

  /** Помощник заполнил черновик: форма берёт его целиком; «спросить меня» у узла ИИ — как он поставил. */
  const applyAssistant = useCallback((r: RoutineAssistantDraft, rev: number) => {
    const next = draftFromSpec(r.spec);
    fromCompose.current = next.source;
    setD(next);
    setTitleEdited(true);
    setChat((c) => (c ? { ...c, rev } : c));
  }, []);
  /** Помощник подключил источник или собрал flow: списки формы перечитываются, чтобы новое было видно в шагах ниже. */
  const assistantActed = useCallback(() => {
    void qc.invalidateQueries({ queryKey: routineKeys.all });
    void qc.invalidateQueries({ queryKey: ['flows'] });
  }, [qc]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      // готовый flow шаблона, которого у пользователя нет, — копия в flows/Мои дела
      if (tplInfo?.flow && d.flow === tplInfo.flow && !(flows.data ?? []).some((f) => f.name === d.flow)) {
        await ensureTemplateFlow(d.flow);
        void qc.invalidateQueries({ queryKey: ['flows'] });
      }
      const spec = buildSpec({ ...d, title, enabled: false, draft: true }, fields);
      const slug = slugify(title, data.routines.map((r) => r.slug));
      await saveRoutine(slug, { spec });
      // рутина сохранена правилом-черновиком: черновик формы больше не нужен
      closed.current = true;
      stopTimer();
      void dropFormDraft().catch(() => undefined);
      // разговор с помощником был про этот черновик: дальше рутину ведёт редактор
      if (chat) void closeAssistant(ROUTINE_ASSISTANT, chat.id).catch(() => undefined);
      qc.setQueryData(FORM_DRAFT_KEY, null);
      void qc.invalidateQueries({ queryKey: routineKeys.all });
      void navigate(`/routines/${encodeURIComponent(slug)}`);
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  return (
    <>
      <Link to="/routines" className={styles.back}>‹ {t('Рутины')}</Link>
      <header className="view-head">
        <h1>{t('Новая рутина')}</h1>
      </header>
      {(savedAt || saved) && (
        <p className={styles.saved} role="status">
          {saved ? t('Открыт черновик, сохранённый {time}.', { time: draftTime(savedAt ?? restoredAt) }) : t('Черновик сохранён в {time}.', { time: draftTime(savedAt) })}{' '}
          {t('Он лежит на сервере: можно уйти на другой экран и вернуться.')}{' '}
          <button
            type="button"
            className="btn small ghost"
            onClick={() => {
              closed.current = true;
              stopTimer();
              if (chat) void closeAssistant(ROUTINE_ASSISTANT, chat.id).catch(() => undefined);
              onReset();
            }}
          >
            {t('Начать заново')}
          </button>
        </p>
      )}
      {noSave && <p className={styles.warn} role="alert">{t('Черновик с сервера не прочитался, поэтому автосохранение выключено: иначе первая правка затёрла бы его. Обнови страницу.')}</p>}
      {hasAssistant ? (
        <RoutineAssistant
          chatId={chat?.id ?? null}
          onChatId={(id) => setChat(id ? { id, rev: 0 } : undefined)}
          appliedRev={chat?.rev ?? 0}
          onDraft={applyAssistant}
          onAct={assistantActed}
          onConnect={() => flush()}
          form={() => (draftTouched(d) ? buildSpec({ ...d, title, enabled: false, draft: true }, fields) : undefined)}
        />
      ) : (
        <ComposeBox onReady={applyCompose} onConnect={() => flush()} />
      )}
      <nav className={styles.tplRow} aria-label={t('Начать с шаблона')}>
        <span className={styles.lbl}>{t('С шаблона:')}</span>
        {ROUTINE_TEMPLATES.map((x) => (
          <Link key={x.tpl} className={styles.chip} aria-current={x.tpl === tpl ? 'true' : undefined} to={`/routines/new?tpl=${x.tpl}`} title={t(x.sub)}>
            {t(x.title)}
          </Link>
        ))}
      </nav>
      <div className={styles.newGrid}>
        <div>
          <Step n={1} id="s1" title={t('Что запускает')}>
            {needFireflies && (
              <span className={styles.hint}>
                {t('Источника встреч пока нет.')} <Link to={`/routines/connect?from=new&tpl=${tpl}`}>{t('Подключить Fireflies.ai')}</Link> {t('(готовый рецепт, нужен ключ API) или выбери другой источник.')}
              </span>
            )}
            {needSource && tplInfo?.connect && (
              <span className={styles.hint}>
                {t('Для шаблона нужен источник: {what}.', { what: t(tplInfo.connect) })} <Link to={connectHref(tplInfo)}>{t('Подключить сервис')}</Link>
              </span>
            )}
            <div className={styles.picks} role="group" aria-labelledby="s1">
              {data.sources.map((s) => {
                const k = data.kinds.find((x) => x.kind === s.spec.kind);
                return (
                  <button key={s.slug} type="button" className={styles.pick} aria-pressed={d.source === s.slug} onClick={() => set({ source: s.slug, conds: templateConds(tpl, matchFields(k)), check: '', mode: d.mode === 'auto' && isSchedule(d) ? 'suggest' : d.mode })}>
                    <b>{s.spec.title}</b>
                    <span>{s.spec.description || k?.summary || s.spec.kind}</span>
                  </button>
                );
              })}
              <button type="button" className={styles.pick} aria-pressed={isSchedule(d)} onClick={() => set({ source: SCHEDULE, conds: [], check: '', mode: 'auto' })}>
                <b>{t('Расписание')}</b>
                <span>{t('в заданное время')}</span>
              </button>
              <Link className={cx(styles.pick, styles.dashed)} to={tplInfo ? `/routines/connect?from=new&tpl=${tplInfo.tpl}` : '/routines/connect?from=new'} onClick={() => flush()}>
                <b>{t('Другой сервис…')}</b>
                <span>{t('Опиши словами, что должно запускать')}</span>
              </Link>
            </div>
          </Step>
          <Step n={2} id="s2" title={isSchedule(d) ? t('Когда') : step2Title(source?.spec.kind)}>
            {isSchedule(d) ? <ScheduleStep d={d} set={set} /> : source ? <SourceStep d={d} set={set} source={source} fields={fields} kindTitle={kind?.title} /> : <span className={styles.hint}>{t('Сначала выбери, что запускает.')}</span>}
          </Step>
          <Step n={3} id="s3" title={t('Что запустить')}>
            <FlowStep d={d} set={set} tplFlow={tplInfo?.flow} onBuildFlow={buildFlow} />
            {pickedFlow && d.flow === pickedFlow && <span className={styles.hint}>{t('Подставил flow «{name}», который ты только что собрал.', { name: pickedFlow })}</span>}
            {d.taskOn && <TaskNote d={d} set={set} />}
          </Step>
          <Step n={4} id="s4" title={t('Сообщать о результате')}>
            <Seg<ReplyChoice> label={t('Сообщать о результате')} value={d.reply} onChange={(reply) => set({ reply })} options={REPLY_CHOICES.map((c) => ({ value: c, label: replyLabel(c), disabled: c !== 'off' && !canReplySource && !replyTargets.length }))} />
            {d.reply !== 'off' && (
              <div className={styles.sentence}>
                {t('Писать')}{' '}
                <select className={styles.slot} aria-label={t('Куда писать')} value={d.replyTo} onChange={(e) => set({ replyTo: e.target.value })}>
                  {canReplySource && <option value="source">{replyWhere(source?.spec.kind, 'source', data.sources)}</option>}
                  {replyTargets.filter((s) => s.slug !== d.source).map((s) => (
                    <option key={s.slug} value={s.slug}>{replyWhere(undefined, s.slug, data.sources)}</option>
                  ))}
                </select>
              </div>
            )}
            <span className={styles.hint}>{!canReplySource && !replyTargets.length && d.source ? (source?.spec.kind === 'connector' ? t('Отвечать некуда: у этого источника не выбран инструмент ответа. Ответить можно из flow — дай этапу инструмент коннектора; или подключи сервис заново с шагом «Как отвечать».') : t('Отвечать некуда: подключи Telegram или Slack, и рутина сможет писать туда.')) : replyHint(d.reply)}</span>
          </Step>
        </div>
        <aside className={styles.summary} aria-label={t('Что получится')}>
          <span className={styles.lbl}>{t('Получится')}</span>
          <p>{sentence(d, srcInfo, fields)}</p>
          <label className={styles.field}>
            <span className={styles.lbl}>{t('Название')}</span>
            <input
              className={styles.inp}
              value={title}
              onChange={(e) => {
                setTitleEdited(true);
                set({ title: e.target.value });
              }}
            />
          </label>
          <button type="button" className="btn primary" disabled={saving || missing.length > 0 || dirErr || !title.trim()} title={missingText || (dirErr ? dirNote?.text : undefined)} onClick={() => void save()}>
            {t('Дальше: проверка на истории')}
          </button>
          {missing.length > 0 && <span className={styles.hint}>{missingText[0]!.toUpperCase() + missingText.slice(1)}.</span>}
          {!missing.length && dirErr && <span className={styles.err}>{dirNote?.text}</span>}
          {error && <span className={styles.err}>{error}</span>}
          <span className={styles.hint}>{t('Рутина сохранится выключенным черновиком. На следующем экране — проверка на истории, остановки и лимиты, и там её можно включить.')}</span>
        </aside>
      </div>
    </>
  );
}

/** Время сохранения черновика: сегодня — часы и минуты, раньше — с датой. */
function draftTime(at: string | null | undefined): string {
  const d = at ? new Date(at) : new Date();
  const today = d.toDateString() === new Date().toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function Step({ n, id, title, children }: { n: number; id: string; title: string; children: ReactNode }) {
  return (
    <section className={styles.step} aria-labelledby={id}>
      <span className={styles.num}>{n}</span>
      <div className={styles.stepBody}>
        <h2 className={styles.sh} id={id}>{title}</h2>
        {children}
      </div>
    </section>
  );
}

type StepProps = { d: RoutineDraft; set: (p: Partial<RoutineDraft>) => void };

function ScheduleStep({ d, set }: StepProps) {
  const now = useNow(60_000);
  const next = formatNext(nextRuns(toCron(d.schedule), new Date(now), 3), new Date(now));
  return (
    <>
      <div className={styles.inline}>
        <Seg<SchedulePreset> label={t('Как часто')} value={d.schedule.preset} onChange={(preset) => set({ schedule: { ...d.schedule, preset } })} options={PRESETS.map((p) => ({ value: p, label: presetLabel(p) }))} />
        {d.schedule.preset !== 'hourly' && (
          <label className={styles.inline}>
            <span className={styles.lbl}>{t('Время')}</span>
            <input className={cx(styles.inp, styles.mono, styles.inlineSel)} type="time" value={d.schedule.time} onChange={(e) => set({ schedule: { ...d.schedule, time: e.target.value || '09:30' } })} />
          </label>
        )}
      </div>
      {next && <span className={styles.mono}>{t('Ближайшие: {list}', { list: next })}</span>}
      <label className={styles.field}>
        <span className={styles.lbl}>{t('Задача для flow')}</span>
        <input className={styles.inp} value={d.input} onChange={(e) => set({ input: e.target.value })} />
      </label>
      <span className={styles.hint}>{t('Работает, пока открыто приложение. Пропущенное время спросит один раз после запуска.')}</span>
    </>
  );
}

function SourceStep({ d, set, source, fields, kindTitle }: StepProps & { source: SourceView; fields: ReturnType<typeof matchFields>; kindTitle: string | undefined }) {
  const [checkOpen, setCheckOpen] = useState(Boolean(d.check));
  // что пришло последним: пробная проверка источника (без модели), раз на источник
  // ключ вне ['routines']: событие `routines` в общем потоке снимает весь префикс, а пробная проверка — это опрос
  // сервиса (у connector — сессия модели), повторять её на каждое событие нельзя
  const sample = useQuery({ queryKey: ['routine-sample', source.slug], queryFn: () => testSource(source.spec), staleTime: 5 * 60_000, retry: false });
  return (
    <>
      <Conditions conds={d.conds} fields={fields} onChange={(conds) => set({ conds })} lead={<>{t('Запускать')} {eventNoun(source.spec.kind)}</>} />
      {checkOpen ? (
        <label className={styles.field}>
          <span className={styles.lbl}>{t('ИИ рутины: какие события запускать')}</span>
          <textarea className={styles.inp} rows={3} value={d.check} placeholder={t('Например: это баг-репорт — описано, что сломалось. Вопросы и обсуждения не считаются.')} onChange={(e) => set({ check: e.target.value })} />
          <span className={styles.hint}>{t('Своими словами, необязательно. Модель читает каждое событие, которое прошло условия, и решает: запустить, пропустить или, если не уверена, спросить тебя. Модель узла и его исходы — на следующем экране, в узле «ИИ рутины».')}</span>
        </label>
      ) : (
        <div>
          <button type="button" className={cx(styles.slot, styles.add)} title={t('Отбор по смыслу: дешёвая модель читает текст события по этому условию')} onClick={() => setCheckOpen(true)}>
            {t('+ ИИ рутины')}
          </button>
        </div>
      )}
      <div className={styles.field}>
        <span className={styles.lbl}>{t('Последнее, что пришло из источника')}</span>
        {sample.isPending && <span className={styles.hint}>{t('Проверяю {source}…', { source: kindTitle ?? source.spec.title })}</span>}
        {sample.isError && <span className={styles.err}>{errorText(sample.error)}</span>}
        {sample.data && !sample.data.ok && <span className={styles.err}>{sample.data.error ?? t('Источник не ответил')}</span>}
        {sample.data?.ok && (
          <div className={styles.foundList}>
            {sample.data.sample.length ? (
              sample.data.sample.map((e) => {
                const r = foundRow(e);
                return (
                  <div key={e.id} className={styles.found}>
                    <span title={e.text}>{r.title}</span>
                    <span className={styles.mono}>{r.meta}</span>
                  </div>
                );
              })
            ) : (
              <span className={styles.hint}>{t('Пока пусто.')}</span>
            )}
          </div>
        )}
      </div>
      {/* рутина с делом: первый опрос заводит дела по текущему списку (SPEC 3.4), flow на них не запустится */}
      <span className={styles.hint}>
        {d.taskOn && d.taskFrom === 'event'
          ? t('Эти записи не запустят flow: подходящие под условия станут делами — первый опрос заведёт их по текущему списку источника, из {n} последних записей. Дальше — только новые.', { n: SEED_MAX })
          : t('Эти записи не запустятся. Рутина начнёт с тех, что появятся после включения.')}
      </span>
    </>
  );
}

/** Дело шаблона одной строкой: что заводится и как; подробно — в редакторе после сохранения. */
function TaskNote({ d, set }: StepProps) {
  return (
    <div className={styles.field}>
      <span className={styles.lbl}>{t('Дело')}</span>
      <span className={styles.sentence}>
        {d.taskFrom === 'flow'
          ? t('Дела «{kind}» заводит flow — по одному на вещь, о которой он узнал.', { kind: d.taskKind })
          : t('Событие становится делом «{kind}» в «Моих делах»: одно дело на MR или задачу, из какого бы источника ни пришло. Ответили или обновили — дело вернётся в план, смержили или закрыли — уйдёт в «Готово».', { kind: d.taskKind })}{' '}
        {/* дела из flow заводит сам flow (инструменты desk_* есть у каждого этапа): снять блок task их не остановит */}
        {d.taskFrom === 'event' && <button type="button" className="btn small ghost" onClick={() => set({ taskOn: false })}>{t('Не заводить дело')}</button>}
      </span>
      <span className={styles.hint}>{t('Вид, колонку и закрытие можно поменять в редакторе после сохранения.')}</span>
    </div>
  );
}

function FlowStep({ d, set, tplFlow, onBuildFlow }: StepProps & { /** Готовый flow шаблона: карточка есть, даже если у пользователя его ещё нет. */ tplFlow?: string; /** Уходим собирать flow: какие flow есть сейчас — по возврате новый подставится сам. */ onBuildFlow: (names: string[]) => void }) {
  const flows = useFlows();
  const templates = useFlowTemplates();
  const spacesOn = useFeature('spaces');
  const spaces = useSpaces(spacesOn);
  const blocks = useFlowBlocks(d.flow);
  const [query, setQuery] = useState('');
  const valid = (flows.data ?? []).filter((f) => f.valid);
  const q = query.trim().toLowerCase();
  const shown = valid.filter((f) => !q || f.name.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q));
  // выбранный flow всегда виден, даже вне первых шести
  const top = shown.slice(0, 6);
  const chosen = valid.find((f) => f.name === d.flow);
  if (chosen && !top.includes(chosen)) top.unshift(chosen);
  // готовый flow шаблона, которого ещё нет у пользователя: скопируется при сохранении
  const tplCard = tplFlow && !valid.some((f) => f.name === tplFlow) ? (templates.data ?? []).find((x) => x.name === tplFlow) ?? { name: tplFlow, description: '' } : undefined;
  const openNewFlow = () => {
    onBuildFlow(valid.map((f) => f.name));
    sidebarNewFlow()?.click();
  };
  return (
    <>
      {valid.length > 6 && <input className={cx(styles.inp, styles.flowSearch)} type="search" placeholder={t('Найти flow')} aria-label={t('Найти flow')} value={query} onChange={(e) => setQuery(e.target.value)} />}
      <div className={styles.picks} role="group" aria-labelledby="s3">
        {tplCard && (
          <button type="button" className={styles.pick} aria-pressed={d.flow === tplCard.name} title={t('Готовый flow: при сохранении появится у тебя в папке «Мои дела», его можно править')} onClick={() => set({ flow: tplCard.name, pauseBefore: [], mode: d.mode === 'until_pause' ? 'suggest' : d.mode })}>
            <b>{tplCard.name}</b>
            <span>{tplCard.description ? `${tplCard.description} · ${t('готовый')}` : t('готовый flow')}</span>
          </button>
        )}
        {top.map((f) => (
          <button key={f.name} type="button" className={styles.pick} aria-pressed={f.name === d.flow} onClick={() => set({ flow: f.name, pauseBefore: [], mode: d.mode === 'until_pause' ? 'suggest' : d.mode })}>
            <b>{f.name}</b>
            <span>{f.description || (f.blocks?.length ? t('{n} блоков', { n: f.blocks.length }) : t('без описания'))}</span>
          </button>
        ))}
        {flows.isPending && <span className={styles.hint}>{t('Загрузка…')}</span>}
        {flows.data && !shown.length && <span className={styles.hint}>{t('Ничего не нашлось.')}</span>}
      </div>
      <div className={styles.inline}>
        {spacesOn && <span>{t('в пространстве')}</span>}
        {spacesOn && <SpacePicker id="routine-space" value={d.space} onChange={(space) => set({ space })} options={spaces.data?.spaces ?? []} loading={spaces.isPending} label={t('в пространстве')} compact placeholder={t('без пространства')} className={styles.flowSearch} inputClassName={styles.slot} />}
        <span className={styles.barGap} />
        <button type="button" className="btn small ghost" title={t('Описать задачу словами — ИИ соберёт flow. Черновик рутины сохранится: вернёшься — новый flow подставится сам')} onClick={openNewFlow}>{t('Собрать новый flow…')}</button>
      </div>
      {!isSchedule(d) && (
        <div className={styles.field}>
          <span className={styles.lbl}>{t('Задача для flow')}</span>
          <textarea className={styles.inp} rows={2} aria-label={t('Задача для flow')} placeholder={t('Задача flow; событие дописывается к ней как данные')} value={d.input} onChange={(e) => set({ input: e.target.value })} />
          <span className={styles.hint}>{t('К задаче flow получит событие: заголовок, автора, ссылку, текст и поля. Передавать их отдельно не нужно: что именно придёт — «Что получит flow» в проверке справа.')}</span>
        </div>
      )}
      <div className={styles.field}>
        <span className={styles.lbl}>{t('Папка проекта')}</span>
        <CwdField value={d.cwd} onChange={(cwd) => set({ cwd })} worktree={d.worktree} onWorktree={(worktree) => set({ worktree })} />
      </div>
      <div className={styles.field}>
        <span className={styles.lbl}>{t('Ждать меня')}</span>
        <WaitClause mode={d.mode} blocks={blocks} pauseBefore={d.pauseBefore} onChange={(mode, pauseBefore) => set({ mode, pauseBefore })} />
      </div>
    </>
  );
}
