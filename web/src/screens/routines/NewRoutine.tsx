// «Новая рутина» (/routines/new, New.dc.html): тот же экран, что редактор (Editor.dc.html), — слева три раздела «Когда ·
// Что сделать · Как узнаю» из ./sections, справа чат помощника высотой в экран и под ним проверка на истории. В «Когда»
// источник выбирается карточками (подключённые, «По расписанию», «+ Подключить сервис»); разделы, которые заполнил
// помощник, помечены, пока человек их не поправит. Проверка на истории идёт по черновику до сохранения
// (/api/routines/form-draft/history/runs). «Включить» сохраняет рутину включённой и ведёт в «Срабатывания»,
// «Сохранить черновиком» — выключенной и открывает редактор.
// До сохранения набранное лежит на сервере черновиком формы (docs/ASSISTANTS.md §3): сохраняется само, и уход на другой
// экран — подключить сервис, собрать flow — ничего не стирает; по возврате форма открывается с ним.
// На сервер пишется только то, что тронул человек: открыть шаблон или черновик и посмотреть — не перезапись.
// ?tpl= — шаблон (lib/routines/templates.ts: источник + дело + готовый flow); он запоминается в черновике, и по тому же
// ?tpl= (или без него) форма открывается с черновиком, а не с голым шаблоном. ?source= — источник, только что
// подключённый на «Подключить сервис», ?reply= — подключённый там же канал «мне в Slack или Telegram»: применяются один
// раз и уходят из адреса. Готовый flow (templates/flows), которого у пользователя нет, копируется при сохранении.
// Запись черновика, его удаление и сохранение рутины идут строго по очереди: черновик не воскресает после сохранения.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { HistoryCheck, RoutineAssistantDraft, RoutinesOverview } from '@server/routines/types';
import { ApiError, errorText, useFlows } from '../../api';
import { dropFormDraft, ensureTemplateFlow, fetchFormDraft, routineKeys, saveFormDraft, saveRoutine, useFlowTemplates, useProfile, useRoutines } from '../../api/routines';
import { closeAssistant } from '../../api/assistant';
import { Input } from '../../components/form';
import { useToast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { LS } from '../../lib/storage';
import { draftToOpen, draftTouched, packDraft, pickNewFlow, shouldSaveDraft, unpackDraft, type FormChat, type FormDraftData } from '../../lib/routines/compose';
import { dirBlocks } from '../../lib/routines/dir';
import { freshHistory, mergeAssistant, type CheckedHistory, type SectionNo } from '../../lib/routines/editor';
import { matchFields } from '../../lib/routines/match';
import { defaultTitle } from '../../lib/routines/phrase';
import { buildSpec, draftFromSpec, draftMissing, draftUnsavedConds, isSchedule, SCHEDULE, slugify, type RoutineDraft } from '../../lib/routines/spec';
import { connectHref, isMeetingSource, profileLine, ROUTINE_TEMPLATES, sourceForTemplate, templateConds, templateDraft, templateOf } from '../../lib/routines/templates';
import { NotAvailable } from './RoutinesList';
import { ROUTINE_ASSISTANT, RoutineAssistant } from './RoutineAssistant';
import { useDirNote } from './CwdField';
import { cx } from './parts';
import { HistoryPanel, historyCacheKey, LeaveProvider, NotifySection, SourcePicks, useRoutineSource, WhatSection, WhenSection } from './sections';
import s from './sections/Sections.module.css';
import styles from './Routines.module.css';

/** Черновик формы уходит на сервер через столько после последней правки. */
const DRAFT_SAVE_MS = 700;
const FORM_DRAFT_KEY = ['routine-form-draft'];
/** Чат помощника свёрнут: запоминается в браузере. */
const FOLD_KEY = 'agentgraph.routineAssistantFolded';

/**
 * Очередь записи черновика формы: сохранения и удаление идут строго по очереди, удаление — после последнего
 * сохранения. Общая на все формы экрана: форма, открытая следом (шаблон, «Начать заново»), не обгоняет уходящую.
 */
let draftQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const p = draftQueue.then(job, job);
  draftQueue = p.catch(() => undefined);
  return p;
}
/** Разговор с помощником открытой формы — сразу, не дожидаясь записи черновика: шаблон, открытый следом, его продолжает. */
let liveChat: FormChat | undefined;

/** Ссылка «Собрать новый flow…»: диалог «Новый flow» живёт в шапке списка Flow сайдбара (как «с чего начать» на главной). */
const sidebarNewFlow = () => document.querySelector<HTMLButtonElement>(`button[title="${CSS.escape(t('Создать flow'))}"]`);

/** Чего не хватает, словами: подсказка у выключенных кнопок и в пустой проверке на истории. */
const MISSING_TEXT = {
  source: t('выбери, что запускает'),
  flow: t('выбери flow'),
  block: t('выбери блок, перед которым остановиться'),
  kind: t('назови вид дела'),
  close: t('напиши, когда закрыть дело'),
  cwd: t('выбери папку проекта или пространство'),
  title: t('назови рутину'),
  gone: t('выбери источник заново: прежнего больше нет'),
  conds: t('допиши или убери пустое условие'),
};

/** Поля формы словами — что помощник хотел поменять, а человек уже поправил сам. */
const FIELD_TEXT: Partial<Record<keyof RoutineDraft, string>> = {
  title: t('название'),
  source: t('источник'),
  conds: t('условия'),
  condsMode: t('условия'),
  check: t('условие для ИИ'),
  checkModel: t('модель ИИ'),
  checkAsk: t('«не уверен»'),
  schedule: t('расписание'),
  missed: t('расписание'),
  flow: 'flow',
  input: t('задачу для flow'),
  space: t('пространство'),
  cwd: t('папку'),
  worktree: t('рабочее дерево'),
  pauseBefore: t('когда запускать'),
  mode: t('когда запускать'),
  usd: t('лимиты'),
  perDay: t('лимиты'),
  parallel: t('лимиты'),
  model: t('модель flow'),
  reply: t('ответ'),
  replyTo: t('ответ'),
  replyOn: t('ответ'),
  notifyOs: t('уведомления'),
  taskOn: t('дело'),
  taskKind: t('дело'),
  taskColumn: t('дело'),
  taskFrom: t('дело'),
  taskSame: t('дело'),
  taskRepeat: t('дело'),
  taskClose: t('дело'),
  knowledge: t('знания'),
};

export function NewRoutine() {
  const q = useRoutines();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const urlTpl = params.get('tpl');
  // черновик формы читается один раз на открытие экрана: дальше его ведёт сама форма
  const saved = useQuery({ queryKey: FORM_DRAFT_KEY, queryFn: fetchFormDraft, staleTime: Infinity, gcTime: 0, retry: false, refetchOnWindowFocus: false });
  const [resets, setResets] = useState(0);
  if (q.isError) return <NotAvailable error={q.error} />;
  if (!q.data || saved.isPending) return <p className="muted">{t('Загрузка…')}</p>;
  // черновик открывается, если адрес не просит другой шаблон (перезагрузка, возврат с «Подключить сервис»); другой
  // шаблон — явное «начать с него», разговор с помощником при этом остаётся. Шаблон черновика — его, если в адресе нет
  const all = unpackDraft(saved.data?.data);
  const draft = draftToOpen(all, urlTpl);
  const tpl = urlTpl ?? draft?.tpl ?? null;
  const reset = () => {
    liveChat = undefined;
    // удаление — после записей, что ещё в очереди: они уже не уйдут (форма закрыта), а ушедшие не воскресят черновик
    void enqueue(() => dropFormDraft()).catch(() => undefined);
    qc.setQueryData(FORM_DRAFT_KEY, null);
    qc.removeQueries({ queryKey: historyCacheKey() });
    setResets((n) => n + 1);
    void navigate('/routines/new', { replace: true });
  };
  // другой шаблон — форма заново; ?source= и ?reply= форму не пересоздают: она применяет их один раз сама
  return (
    <NewForm
      key={`${urlTpl ?? ''}:${resets}`}
      data={q.data}
      tpl={tpl}
      saved={draft}
      savedChat={liveChat ?? all?.chat}
      savedAt={draft ? saved.data?.at : undefined}
      noSave={saved.isError}
      onReset={reset}
    />
  );
}

type FormProps = {
  data: RoutinesOverview;
  /** Шаблон формы: из адреса или из черновика. */
  tpl: string | null;
  /** Черновик формы с сервера. */
  saved?: FormDraftData;
  /** Разговор с помощником: остаётся и при шаблоне. */
  savedChat?: FormChat;
  savedAt?: string;
  /** Черновик с сервера не прочитался: что там лежит, неизвестно — автосохранение выключено, чтобы его не затереть. */
  noSave: boolean;
  onReset: () => void;
};

function NewForm({ data, tpl, saved, savedChat, savedAt: restoredAt, noSave, onReset }: FormProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [params] = useSearchParams();
  const tplInfo = templateOf(tpl);
  // вернулись с «Подключить сервис» — с новым источником или каналом ответа: применяются один раз, при открытии формы
  const [back] = useState(() => ({ source: params.get('source'), reply: params.get('reply') }));
  const fromParam = back.source;
  /** Черновик был про другой источник: условия на его поля к новому не подходят, ответ подстраивается заново. */
  const swapped = Boolean(saved && fromParam && saved.d.source && saved.d.source !== fromParam);
  const [d, setD] = useState<RoutineDraft>(() => {
    // подключили, куда писать мне: ответ уходит туда (если сервис умеет отвечать), источник рутины прежний
    const replyTo = back.reply && data.sources.some((x) => x.slug === back.reply && x.canReply) ? back.reply : '';
    const withReply = (x: RoutineDraft): RoutineDraft => (replyTo ? { ...x, replyTo, reply: x.reply === 'off' ? 'draft' : x.reply } : x);
    if (saved) return withReply(fromParam ? { ...saved.d, source: fromParam, ...(swapped ? { conds: [] } : {}) } : saved.d);
    const slug = fromParam ?? sourceForTemplate(tpl, data.sources);
    const picked = data.sources.find((x) => x.slug === slug);
    return withReply({ ...templateDraft(tpl, { source: picked, digestInput: t('Что в моих MR требует ответа сегодня') }), source: slug });
  });
  // применённые ?source= и ?reply= уходят из адреса: перезагрузка не должна снова перебить ими черновик
  useEffect(() => {
    if (!back.source && !back.reply) return;
    const next = new URLSearchParams(params);
    next.delete('source');
    next.delete('reply');
    const q = next.toString();
    void navigate(`/routines/new${q ? `?${q}` : ''}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // форма с нуля (шаблон, пустая): итог проверки прошлой формы ей не принадлежит
  useState(() => {
    if (!saved) qc.removeQueries({ queryKey: historyCacheKey() });
  });
  const dRef = useRef(d);
  dRef.current = d;
  /** Форма больше не черновик: рутина сохраняется или сохранена, человек начал заново. */
  const closed = useRef(false);
  // встречи: «кто я» из профиля дописывается к задаче flow, пока человек её не правил
  const profile = useProfile(tpl === 'meetings');
  const me = profileLine(profile.data?.profile);
  useEffect(() => {
    if (tpl !== 'meetings' || !me) return;
    const plain = templateDraft(tpl).input;
    setD((x) => (x.input === plain ? { ...x, input: templateDraft(tpl, { me }).input } : x));
  }, [tpl, me]);
  const [titleEdited, setTitleEdited] = useState(Boolean(saved?.titleEdited));
  const titleEditedRef = useRef(titleEdited);
  titleEditedRef.current = titleEdited;
  const [savedAt, setSavedAt] = useState<string | null>(restoredAt ?? null);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  /** Последняя проверка на истории по правилу как оно есть сейчас: по ней счётчики в «Когда». */
  const [hist, setHist] = useState<CheckedHistory | null>(null);
  /** Разделы, которые заполнил помощник и человек ещё не правил: метка у заголовка. */
  const [filled, setFilled] = useState<SectionNo[]>(saved?.filled ?? []);
  /** Что помощник хотел поменять, а человек уже поправил сам: осталось его — экран говорит об этом. */
  const [kept, setKept] = useState<string[]>([]);
  const [folded, setFolded] = useState(() => LS.get<boolean>(FOLD_KEY, false));
  /**
   * Форму тронул человек: правка, помощник, уход собирать flow или подключать сервис. Только такую форму можно писать на
   * сервер — открыть шаблон или черновик и посмотреть не значит перезаписать черновик (автоподстановки не в счёт).
   */
  const [human, setHuman] = useState(Boolean(back.source || back.reply));
  const humanRef = useRef(human);
  const markHuman = () => {
    humanRef.current = true;
    setHuman(true);
  };
  const set = (patch: Partial<RoutineDraft>) => setD((x) => ({ ...x, ...patch }));
  /** Правка раздела руками: метка «заполнил помощник» у него снимается. */
  const setIn = (n: SectionNo) => (patch: Partial<RoutineDraft>) => {
    markHuman();
    setFilled((f) => (f.includes(n) ? f.filter((x) => x !== n) : f));
    set(patch);
  };

  const src = useRoutineSource(d, data);
  const { source, kind, fields } = src;
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  // шаблон «Встречи…», а источника встреч нет: не подсовываем чужой сервис, зовём подключить Fireflies
  const needFireflies = tpl === 'meetings' && !d.source && !data.sources.some(isMeetingSource);
  // у шаблона нет подключённого источника: зовём подключить нужный
  const needSource = Boolean(tplInfo?.connect) && !d.source && !needFireflies;
  const replyTargets = data.sources.filter((x) => x.canReply);
  const canReplySource = Boolean(source?.canReply);

  // куда отвечать: в источник, если он умеет; иначе — первый источник с ответом; некуда — «Не сообщать». «Не сообщать»,
  // поставленное здесь, а не человеком, снимается, как только отвечать снова есть куда
  const autoOff = useRef(false);
  // источник пришёл из черновика или от помощника: ответ и «куда писать» там уже выбраны, не переписываем
  const fromCompose = useRef<string | null>(saved && !swapped ? d.source : null);
  useEffect(() => {
    const skip = fromCompose.current === d.source;
    fromCompose.current = null;
    if (!d.source || skip) return;
    const reBack = autoOff.current && d.reply === 'off' ? { reply: 'draft' as const } : {};
    if (canReplySource || replyTargets[0]) {
      autoOff.current = false;
      set({ replyTo: canReplySource ? 'source' : replyTargets[0]!.slug, ...reBack });
    } else if (d.reply !== 'off') {
      autoOff.current = true;
      set({ reply: 'off' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.source]);

  const title = titleEdited ? d.title : tplInfo ? t(tplInfo.title) : defaultTitle(d, source?.spec.title);
  // обход проекта и «задача в работу» идут в папке проекта (своей или пространства): без неё обходить и править нечего
  const needDir = Boolean(tplInfo?.needsDir && d.flow === tplInfo.flow && !d.cwd.trim() && !d.space);
  // источника, выбранного в черновике, больше нет (удалили, пока черновик лежал)
  const gone = Boolean(d.source) && !isSchedule(d) && !source;
  const missing = [...draftMissing(d), ...(gone ? (['gone'] as const) : []), ...(needDir ? (['cwd'] as const) : []), ...(title.trim() ? [] : (['title'] as const))];
  // недописанная строка условия в правило не попадёт: включать так нельзя (молча работало бы шире), черновиком — можно
  const missingOn = [...missing, ...(draftUnsavedConds(d).length ? (['conds'] as const) : [])];
  const flows = useFlows();
  const templates = useFlowTemplates();
  const dirNote = useDirNote(d.cwd, d.worktree);
  const dirErr = dirBlocks(dirNote);
  const whyOf = (list: ReadonlyArray<keyof typeof MISSING_TEXT>) => (list.length ? t('Не хватает: {list}', { list: list.map((m) => MISSING_TEXT[m]).join(', ') }) : dirErr ? dirNote?.text : undefined);
  const why = whyOf(missing);
  const whyOn = whyOf(missingOn);

  // черновик формы — на сервер: сам, через паузу после правки человека. Разговор с помощником — часть черновика: по
  // возврате на форму лента открывается, а принятый результат второй раз не ложится
  const [chat, setChat] = useState<FormChat | undefined>(savedChat ?? saved?.chat);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  // закрытая форма (рутина сохранена, «Начать заново») свой разговор дальше не передаёт: он закрыт
  if (!closed.current) liveChat = chat;
  /** Форма, как она ушла помощнику с последним сообщением: его результат ложится только туда, где он что-то поменял. */
  const sentBase = useRef<RoutineDraft | undefined>(undefined);
  const touched = draftTouched(d) || Boolean(chat);
  /** Какие flow были, когда ушли собирать новый: живёт в черновике, пока форма открыта, а не в одном запросе. */
  const flowsBefore = useRef<string[] | undefined>(saved?.flowsBefore);
  const pack = () => JSON.stringify(packDraft({ ...d, title: titleEdited ? d.title : '' }, titleEdited, { flowsBefore: flowsBefore.current, chat, filled, ...(tpl ? { tpl } : {}) }));
  const payload = pack();
  const lastSaved = useRef<string | null>(null);
  lastSaved.current ??= saved ? JSON.stringify(packDraft({ ...saved.d, title: saved.titleEdited ? saved.d.title : '' }, saved.titleEdited, { flowsBefore: saved.flowsBefore, chat: saved.chat, filled: saved.filled, ...(saved.tpl ? { tpl: saved.tpl } : {}) })) : '';
  const timer = useRef<number | null>(null);
  const stopTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  /**
   * Отправить черновик: в очередь записи. leaving — уходим с экрана: запрос должен дойти и после смены экрана. Форма,
   * закрытая, пока запись ждала очереди (рутина сохраняется, «Начать заново»), её уже не шлёт.
   */
  const send = (text: string, leaving = false) => {
    stopTimer();
    lastSaved.current = text;
    const body = JSON.parse(text) as FormDraftData;
    // keepalive-запрос браузер не пошлёт с телом больше 64 КБ
    return enqueue(() => (closed.current ? Promise.resolve(null) : saveFormDraft(body, leaving && text.length < 30_000))).then((r) => {
      if (r) qc.setQueryData(FORM_DRAFT_KEY, { at: r.at, data: body });
      return r;
    });
  };
  const pending = touched && shouldSaveDraft({ human, noSave, closed: closed.current, payload, last: lastSaved.current });
  useEffect(() => {
    if (!pending) return;
    timer.current = window.setTimeout(() => {
      void send(payload)
        .then((r) => r && setSavedAt(r.at))
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
  /** Уходим с формы по ссылке или кнопке: сохранить сейчас, не дожидаясь паузы, — если форму трогал человек. */
  const flush = (before?: string[]) => {
    if (before) flowsBefore.current = before;
    if (noSave || closed.current || !humanRef.current) return;
    void send(pack(), true).catch(() => undefined);
  };
  const leave = (to: string) => {
    flush();
    void navigate(to);
  };
  /** «Подключить сервис»: черновик сохраняется, по возврате новый сервис выбран (for=reply — каналом ответа). */
  const connect = (href = `/routines/connect?from=new${tplInfo ? `&tpl=${tplInfo.tpl}` : ''}`) => leave(href);
  // вернулись со сборки flow: единственный flow, которого не было до ухода, подставляется сам
  const [pickedFlow, setPickedFlow] = useState('');
  const pickDone = useRef(false);
  useEffect(() => {
    if (pickDone.current || !saved?.flowsBefore || !flows.data) return;
    pickDone.current = true;
    const fresh = pickNewFlow(saved.flowsBefore, flows.data.filter((f) => f.valid).map((f) => f.name));
    if (fresh && !d.flow) {
      markHuman();
      set({ flow: fresh });
      setPickedFlow(fresh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flows.data]);
  const buildFlow = () => {
    markHuman();
    flush((flows.data ?? []).filter((f) => f.valid).map((f) => f.name));
    toast(t('Черновик рутины сохранён. Собери flow и вернись в «Новую рутину» — он подставится сам.'));
    sidebarNewFlow()?.click();
  };

  /**
   * Помощник прислал черновик: ложится только то, что он поменял относительно формы, ушедшей с сообщением. Поле, которое
   * человек тем временем поправил сам и иначе, остаётся его — об этом строка под чатом. Разделы с правками помощника
   * получают метку.
   */
  const applyAssistant = useCallback((r: RoutineAssistantDraft, rev: number) => {
    if (closed.current) return;
    const theirs = draftFromSpec(r.spec);
    const mine = dRef.current;
    const base = chatRef.current?.base;
    const m = mergeAssistant(base, mine, theirs, fieldsRef.current);
    const keptKeys: Array<keyof RoutineDraft> = [...m.kept];
    // название: человек его не правил после сообщения — берётся название помощника
    const baseTitle = base?.title ?? '';
    if (theirs.title.trim() && theirs.title !== baseTitle) {
      if (!titleEditedRef.current || mine.title === baseTitle) {
        m.next.title = theirs.title;
        setTitleEdited(true);
      } else keptKeys.push('title');
    }
    if (m.next.source !== mine.source) fromCompose.current = m.next.source;
    humanRef.current = true;
    setHuman(true);
    setD(m.next);
    setFilled((f) => [...new Set([...f, ...m.changed])].sort());
    setKept([...new Set(keptKeys.map((k) => FIELD_TEXT[k] ?? String(k)))]);
    setChat((c) => (c ? { ...c, rev } : c));
  }, []);
  /** Помощник подключил источник или собрал flow: списки формы перечитываются, чтобы новое было видно в разделах. */
  const assistantActed = useCallback(() => {
    void qc.invalidateQueries({ queryKey: routineKeys.all });
    void qc.invalidateQueries({ queryKey: ['flows'] });
  }, [qc]);

  // проверка на истории: по правилу формы, ещё до сохранения. Название в проверку не идёт — его правка не делает её устаревшей
  const checkSpec = buildSpec({ ...d, title: 'form-draft', enabled: false, draft: true }, fields);

  /** enable — «Включить»: рутина сразу работает; иначе — выключенный черновик, дальше её ведёт редактор. */
  const save = async (enable: boolean) => {
    // с этой минуты черновик формы не пишется: запись, ушедшая после сохранения, воскресила бы его
    closed.current = true;
    stopTimer();
    setSaving(true);
    setProblems([]);
    try {
      // готовый flow (templates/flows), которого у пользователя нет, — копия в flows/Мои дела; с какого бы шаблона его ни взяли
      if (d.flow && !(flows.data ?? []).some((f) => f.name === d.flow) && (templates.data ?? []).some((x) => x.name === d.flow)) {
        await ensureTemplateFlow(d.flow);
        void qc.invalidateQueries({ queryKey: ['flows'] });
      }
      const spec = buildSpec({ ...d, title, enabled: enable, draft: !enable }, fields);
      const slug = slugify(title, data.routines.map((r) => r.slug));
      const view = await saveRoutine(slug, { spec });
      // итог проверки черновика, если он по правилу как оно есть, — редактору: на сервере ответы ИИ переходят к рутине
      const checked = qc.getQueryData<{ res: HistoryCheck; spec: string }>(historyCacheKey());
      if (checked && checked.spec === JSON.stringify(checkSpec)) {
        qc.setQueryData(historyCacheKey(slug), { res: checked.res, spec: JSON.stringify(buildSpec(draftFromSpec(view.spec), fields)) });
      }
      void enqueue(() => dropFormDraft(slug)).catch(() => undefined);
      // разговор с помощником был про этот черновик: дальше рутину ведёт редактор
      if (chat) void closeAssistant(ROUTINE_ASSISTANT, chat.id).catch(() => undefined);
      liveChat = undefined;
      qc.setQueryData(FORM_DRAFT_KEY, null);
      qc.removeQueries({ queryKey: historyCacheKey() });
      void qc.invalidateQueries({ queryKey: routineKeys.all });
      void navigate(`/routines/${encodeURIComponent(slug)}${enable ? '/log' : ''}`);
    } catch (e) {
      closed.current = false;
      const list = e instanceof ApiError ? (e.data as { problems?: string[] } | undefined)?.problems : undefined;
      setProblems(list?.length ? list : [errorText(e)]);
      setSaving(false);
    }
  };
  const restart = () => {
    closed.current = true;
    stopTimer();
    if (chat) void closeAssistant(ROUTINE_ASSISTANT, chat.id).catch(() => undefined);
    onReset();
  };

  const status = noSave ? '' : pending ? t('сохраняю черновик…') : savedAt ? (saved && savedAt === restoredAt ? t('открыт черновик от {time} · можно уйти и вернуться', { time: draftTime(savedAt) }) : t('черновик сохранён в {time} · можно уйти и вернуться', { time: draftTime(savedAt) })) : '';
  const blocked = saving || missing.length > 0 || dirErr;
  const blockedOn = saving || missingOn.length > 0 || dirErr;

  const checkMissing = draftMissing(d).filter((m) => m !== 'source');
  const histEmpty = isSchedule(d)
    ? t('У расписания нет событий: проверять на истории нечего. Ближайшие запуски — в разделе «Когда».')
    : !d.source
      ? t('Выбери слева, что запускает рутину, — здесь будет видно, что из последних событий запустилось бы.')
      : !source
        ? t('Источник «{slug}» не найден.', { slug: d.source })
        : checkMissing.length
          ? t('Не хватает: {list}. Тогда проверю правило на последних событиях.', { list: checkMissing.map((m) => MISSING_TEXT[m]).join(', ') })
          : undefined;
  // сама проверка не стоит денег, только если не читает модель: «ИИ рутины» и опрос «Сервиса через Claude» — по кнопке
  const autoCheck = !d.check.trim() && kind?.delivery !== 'model';

  const tplFlow = tplInfo?.flow ? { name: tplInfo.flow, description: (templates.data ?? []).find((x) => x.name === tplInfo.flow)?.description } : undefined;
  const pickHint = needFireflies ? (
    <>
      {t('Источника встреч пока нет.')}{' '}
      <button type="button" className={s.link} onClick={() => connect()}>{t('Подключить Fireflies.ai')}</button> {t('(готовый рецепт, нужен ключ API) или выбери другой источник.')}
    </>
  ) : needSource && tplInfo?.connect ? (
    <>
      {t('Для шаблона нужен источник: {what}.', { what: t(tplInfo.connect) })}{' '}
      <button type="button" className={s.link} onClick={() => connect(connectHref(tplInfo))}>{t('Подключить сервис')}</button>
    </>
  ) : undefined;

  return (
    <LeaveProvider value={leave}>
      <Link to="/routines" className={styles.back}>‹ {t('Рутины')}</Link>
      <header className="view-head">
        <div className={styles.titleRow}>
          <h1>{t('Новая рутина')}</h1>
          <span className={cx(styles.pill, styles.pillDraft)}>{t('черновик')}</span>
        </div>
        <div className="row">
          {status && (
            <span className="small muted" role="status" title={t('Черновик лежит на сервере: уход на другой экран ничего не стирает')}>
              {status}
            </span>
          )}
          {(savedAt || touched) && (
            <button type="button" className="btn ghost" disabled={saving} title={t('Стереть черновик и начать с пустой формы. Разговор с помощником закроется')} onClick={restart}>
              {t('Начать заново')}
            </button>
          )}
          <button type="button" className="btn" disabled={blocked} title={why ?? t('Сохранить выключенной: дальше — редактор, проверка на истории, остановки и лимиты')} onClick={() => void save(false)}>
            {t('Сохранить черновиком')}
          </button>
          <button type="button" className="btn primary" disabled={blockedOn} title={whyOn ?? t('Сохранить и включить: рутина начнёт с новых событий')} onClick={() => void save(true)}>
            {t('Включить')}
          </button>
        </div>
      </header>
      {/* что держит «Включить» — видно, а не только в подсказке у кнопки; пустую форму не попрекаем */}
      {touched && !saving && whyOn && <p className={styles.why}>{whyOn}{whyOn !== why ? ` · ${t('черновиком сохранить можно')}` : ''}</p>}
      {noSave && <p className={styles.warn} role="alert">{t('Черновик с сервера не прочитался, поэтому автосохранение выключено: иначе первая правка затёрла бы его. Обнови страницу.')}</p>}
      {problems.length > 0 && (
        <div className={styles.problems} role="alert">
          {t('Правило не проходит проверку:')}
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={styles.newTop}>
        <label className={styles.newName}>
          <span className={s.lbl}>{t('Название')}</span>
          <Input
            value={title}
            disabled={saving}
            placeholder={t('Например: Ревью MR из Slack')}
            onChange={(e) => {
              markHuman();
              setTitleEdited(true);
              set({ title: e.target.value });
            }}
          />
        </label>
        <nav className={styles.tplRow} aria-label={t('Начать с шаблона')}>
          <span className={s.lbl}>{t('С шаблона:')}</span>
          {ROUTINE_TEMPLATES.map((x) => (
            <Link key={x.tpl} className={styles.chip} aria-current={x.tpl === tpl ? 'true' : undefined} to={`/routines/new?tpl=${x.tpl}`} title={t(x.sub)} onClick={() => flush()}>
              {t(x.title)}
            </Link>
          ))}
        </nav>
      </div>
      <div className={s.editor}>
        {/* пока рутина сохраняется, форма не правится: правка ушла бы мимо сохранённого */}
        <fieldset className={cx(s.main, styles.lock)} disabled={saving}>
          <WhenSection
            d={d}
            set={setIn(1)}
            data={data}
            src={src}
            hist={histEmpty ? null : freshHistory(hist, checkSpec)}
            filled={filled.includes(1)}
            picker={
              <SourcePicks
                d={d}
                data={data}
                hint={pickHint}
                onPick={(slug) => {
                  const k = data.kinds.find((x) => x.kind === data.sources.find((v) => v.slug === slug)?.spec.kind);
                  setIn(1)({ source: slug, conds: templateConds(tpl, matchFields(k)), check: '', mode: d.mode === 'auto' && isSchedule(d) ? 'suggest' : d.mode });
                }}
                onSchedule={() => setIn(1)({ source: SCHEDULE, conds: [], check: '', mode: 'auto' })}
                onConnect={() => connect()}
              />
            }
          />
          <WhatSection d={d} set={setIn(2)} src={src} filled={filled.includes(2)} extras={{ tplFlow, onBuildFlow: buildFlow, note: pickedFlow && d.flow === pickedFlow ? t('Подставил flow «{name}», который ты только что собрал.', { name: pickedFlow }) : undefined }} />
          <NotifySection d={d} set={setIn(3)} data={data} src={src} filled={filled.includes(3)} onConnect={() => connect(`/routines/connect?from=new&for=reply${tplInfo ? `&tpl=${tplInfo.tpl}` : ''}`)} />
        </fieldset>
        <div className={cx(s.aside, styles.newSide)}>
          <RoutineAssistant
            chatId={chat?.id ?? null}
            onChatId={(id) => {
              markHuman();
              setChat(id ? { id, rev: 0, ...(sentBase.current ? { base: sentBase.current } : {}) } : undefined);
            }}
            appliedRev={chat?.rev ?? 0}
            onDraft={applyAssistant}
            onAct={assistantActed}
            onConnect={() => flush()}
            form={() => {
              // снимок формы, ушедшей с сообщением: результат помощника ляжет только туда, где он что-то поменял
              const snap = { ...d, title };
              sentBase.current = snap;
              setChat((c) => (c ? { ...c, base: snap } : c));
              setKept([]);
              return draftTouched(d) ? buildSpec({ ...d, title, enabled: false, draft: true }, fields) : undefined;
            }}
            collapsed={folded}
            onCollapse={(v) => {
              setFolded(v);
              LS.set(FOLD_KEY, v);
            }}
          />
          {kept.length > 0 && (
            <p className={s.warn} role="status">
              {t('Помощник предлагал поменять: {list}. Ты уже поправил это сам — оставил твоё. Если нужно его, скажи ему ещё раз.', { list: kept.join(', ') })}
            </p>
          )}
          <HistoryPanel
            spec={checkSpec}
            sourceTitle={source?.spec.title ?? d.source}
            onResult={setHist}
            empty={histEmpty}
            auto={autoCheck}
            note={t('Считается сразу, ещё до включения. Эти события уже были, поэтому сами не запустятся: рутина начнёт с новых.')}
          />
        </div>
      </div>
    </LeaveProvider>
  );
}

/** Время сохранения черновика: сегодня — часы и минуты, раньше — с датой. */
function draftTime(at: string | null | undefined): string {
  const d = at ? new Date(at) : new Date();
  const today = d.toDateString() === new Date().toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
