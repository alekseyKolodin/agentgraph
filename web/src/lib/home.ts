// Главная (ui/app.js renderHome, homeRunHtml, sideLiveInfo, questionCardHtml, submitAnswer): входящие вопросы, строки идущих
// запусков, «Сейчас» в сайдбаре и сбор ответа на вопрос агента. Без React и DOM.
import type { AskAnswers, AskQuestion, HomeCond, HomeRun, QuestionRecord } from '@server/api-types';
import { ago, excerpt, usd } from './format';
import { t } from './i18n';

/** Подряд одинаковых провалов в конце, после которых запуск «буксует» (как в ленте страницы запуска). */
export const STUCK_MIN = 5;
/** Статусы идущего запуска. */
export const LIVE_STATUSES = ['running', 'waiting', 'paused'];

export type InboxItem = { q: QuestionRecord; run: HomeRun };

/** Вопросы всех идущих запусков, сначала те, что ждут дольше. */
export const inbox = (runs: HomeRun[]): InboxItem[] =>
  runs.flatMap((run) => run.questions.map((q) => ({ q, run }))).sort((a, b) => a.q.askedAt.localeCompare(b.q.askedAt));

/** Сколько вопросов ждут ответа: счётчик у «Главной» и в заголовке вкладки. */
export const inboxCount = (runs: HomeRun[]): number => runs.reduce((k, r) => k + r.questions.length, 0);

/** Заголовок вкладки: «(2) agentgraph», на странице запуска — с его именем (без имени — flow): «(2) Кнопка · agentgraph». */
export const docTitle = (questions: number, run = ''): string => `${questions ? `(${questions}) ` : ''}${run ? `${run} · ` : ''}agentgraph`;

/** Подпись под «Главная»: «идут 2 · вопросов 1 · ≈$0.42»; без запусков — пусто. */
export const homeMeta = (runs: HomeRun[], questions: number): string =>
  runs.length ? t('идут {n} · вопросов {q} · ≈{cost}', { n: runs.length, q: questions, cost: usd(runs.reduce((n, r) => n + r.totalCostUsd, 0)) }) : '';

/** Подряд одинаковые провалы в конце: «буксует», если их STUCK_MIN и больше. */
export function homeStuck(conds: HomeCond[]): { from: number; to: number; text: string } | null {
  const tail: { key: string; c: HomeCond }[] = [];
  for (const c of [...conds].reverse()) {
    if (c.done) break;
    const key = excerpt(c.text, 200).replace(/\d+/g, '#').toLowerCase();
    if (tail.length && tail[0]!.key !== key) break;
    tail.push({ key, c });
  }
  if (tail.length < STUCK_MIN) return null;
  const first = tail.at(-1)!.c;
  const last = tail[0]!.c;
  return { from: first.iteration, to: last.iteration, text: last.summary || excerpt(last.text, 120) };
}

/** «этапы «a», «b»» у параллельной группы, «этап «a»» у одного, пусто между шагами. */
function nowText(r: Pick<Partial<HomeRun>, 'running' | 'current'>): string {
  if (r.running && r.running.length > 1) return t('этапы {list}', { list: r.running.map((x) => t('«{title}»', { title: x.title })).join(', ') });
  return r.current ? t('этап «{title}»', { title: r.current.title }) : '';
}

export type HomeRunView = {
  tone: 'live' | 'wait';
  title: string;
  /** Серая подпись справа от имени: flow (если есть имя), проект, блок и итерация. */
  meta: string;
  /** Что происходит сейчас и почему — одна строка. */
  sum: string;
  /** Мини-лента итераций идущего блока; пусто — блок без цикла. */
  ticks: ('ok' | 'fail' | 'live')[];
  /** «12 мин · $0.40». */
  cost: string;
  costTitle: string;
  /** Пауза по просьбе агента у flow с артефактом решений: кнопка «Ответить». */
  answer: boolean;
};

/** Строка идущего запуска: что происходит сейчас и почему, в одну-две строки — сводка, а не карточка. */
export function homeRunView(r: HomeRun, project: string, artifacts: boolean, now: number = Date.now()): HomeRunView {
  const blocks = r.blocks || [];
  const multi = blocks.length > 1;
  const cur = blocks.find((b) => b.status === 'running');
  const conds = r.conds || [];
  const last = conds.at(-1);
  const current = nowText(r);
  const where = [multi && cur ? t('блок {i}/{n}', { i: blocks.indexOf(cur) + 1, n: blocks.length }) : '', cur?.looped ? t('итер. {i}/{n}', { i: cur.iterations, n: cur.maxIterations }) : '']
    .filter(Boolean)
    .join(' · ');
  const stuck = cur?.looped ? homeStuck(conds) : null;
  let tone: HomeRunView['tone'] = 'live';
  let sum: string;
  if (r.status === 'waiting') {
    tone = 'wait';
    sum = current ? t('Ждёт ответа: {current} — вопрос выше', { current }) : t('Ждёт ответа — вопрос выше');
  } else if (r.pause === 'paused') {
    tone = 'wait';
    sum = r.pauseReason ? t('На паузе: этап «{phase}» попросил остановиться', { phase: r.pauseReason.phase }) : t('На паузе');
  } else if (stuck) {
    tone = 'wait';
    sum = t('Буксует: итерации {from}–{to} падают с одним и тем же — «{text}»', { from: stuck.from, to: stuck.to, text: stuck.text });
  } else {
    // сводка модели «где мы» важнее вердикта: в ней он уже пересказан; без неё — итог или начало замечаний
    const why = last && !last.done && cur?.looped ? t('итерация {n} не прошла: «{text}»', { n: last.iteration, text: last.summary || excerpt(last.text, 120) }) : '';
    sum = [current ? t('Сейчас {current}', { current }) : t('Между шагами'), r.digest?.text || why].filter(Boolean).join(' · ');
  }
  if (r.pause === 'requested') sum += ` · ${t('пауза после шага')}`;
  // мини-лента: вердикты итераций идущего блока и текущая; длинная — последние 16
  const ticks: HomeRunView['ticks'] = cur?.looped ? [...conds.map((c): 'ok' | 'fail' => (c.done ? 'ok' : 'fail')), 'live' as const].slice(-16) : [];
  const since = ago(r.startedAt, now);
  return {
    tone,
    title: r.title || r.flow,
    meta: [r.title ? r.flow : '', project, where].filter(Boolean).join(' · '),
    sum,
    ticks,
    cost: `${since} · ${usd(r.totalCostUsd)}`,
    costTitle: t('Идёт {since} · оценка по прайсу API', { since }),
    answer: artifacts && r.pause === 'paused' && Boolean(r.pauseReason) && Boolean(r.decisions),
  };
}

/** Запуск для «Сейчас»: строка /api/home или, без неё, запись списка запусков (там нет блоков и этапов). */
export type LiveSource = Pick<HomeRun, 'id' | 'flow' | 'status'> & Partial<Pick<HomeRun, 'title' | 'blocks' | 'running' | 'current' | 'pause' | 'conds'>>;

export type LiveRow = { r: LiveSource; tone: 'live' | 'wait'; sub: string; it: string };

/** Подпись запуска в «Сейчас» (ui/app.js sideLiveInfo). */
export function sideLiveInfo(r: LiveSource): Omit<LiveRow, 'r'> {
  const cur = (r.blocks || []).find((b) => b.status === 'running');
  const it = cur?.looped ? `${cur.iterations}/${cur.maxIterations}` : '';
  const current = nowText(r);
  if (r.status === 'waiting') return { tone: 'wait', sub: `${t('ждёт ответа')}${current ? ` · ${current}` : ''}`, it };
  if (r.pause === 'paused' || r.status === 'paused') return { tone: 'wait', sub: t('на паузе'), it };
  const stuck = cur?.looped ? homeStuck(r.conds || []) : null;
  if (stuck) return { tone: 'wait', sub: t('буксует: итерации {from}–{to}', { from: stuck.from, to: stuck.to }), it };
  return { tone: 'live', sub: current || t('между шагами'), it };
}

/** Строки «Сейчас»: ждущие тебя — первыми. */
export function liveRows(src: LiveSource[]): LiveRow[] {
  return src.map((r) => ({ r, ...sideLiveInfo(r) })).sort((a, b) => (a.tone === 'wait' ? 0 : 1) - (b.tone === 'wait' ? 0 : 1));
}

/** Счётчик «Сейчас»: «ждут 1 · идут 2». */
export function liveCount(rows: LiveRow[]): { text: string; wait: boolean } {
  const waits = rows.filter((x) => x.tone === 'wait').length;
  return {
    text: [waits ? t('ждут {n}', { n: waits }) : '', rows.length > waits ? t('идут {n}', { n: rows.length - waits }) : ''].filter(Boolean).join(' · '),
    wait: waits > 0,
  };
}

/** Подсказка строки «Сейчас»: имя, под ним flow и подпись. */
export const liveRowTitle = ({ r, sub }: LiveRow): string => `${r.title || r.flow}\n${r.title ? `flow ${r.flow} · ` : ''}${sub}`;

// ---------- карточка вопроса

/** Где спросил агент: «блок b · этап «Ревью» · итерация 2». Блок — только у многоблочного flow. */
export const questionWhere = (q: QuestionRecord, run: Partial<Pick<HomeRun, 'blocks'>>): string =>
  [(run.blocks?.length ?? 0) > 1 ? t('блок {b}', { b: q.block }) : '', t('этап «{title}»', { title: q.title || q.phase }), t('итерация {n}', { n: q.iteration })].filter(Boolean).join(' · ');

/** Итог прошлой итерации для контекста вопроса на главной: только если условие не выполнено. */
export function questionLastCond(q: QuestionRecord, run: Partial<Pick<HomeRun, 'conds'>>): HomeCond | null {
  const last = (run.conds || []).filter((c) => c.iteration < q.iteration).at(-1);
  return last && !last.done ? last : null;
}

/** Вариант, который рекомендует агент: «… (Recommended)» или «… (рекомендую)». */
const RECOMMENDED = /\s*\((?:recommended|рекоменд[а-яё]*)\)\s*$/i;

export const optionView = (label: string): { label: string; rec: boolean } => ({ label: label.replace(RECOMMENDED, ''), rec: RECOMMENDED.test(label) });

/** Значение скрытого варианта «Свой ответ». */
export const OTHER = '__other__';

/** Длинное вступление (preface) сворачивается до начала. */
export const PREFACE_INLINE_MAX = 400;

/**
 * Ответ на вопрос из выбранного в форме. picked[i] — отмеченные значения i-го вопроса (с OTHER), other[i] — свой текст.
 * missing — не на все вопросы ответили; ignored — свой ответ написан, но выбран вариант (он не уйдёт агенту).
 */
export function collectAnswers(questions: AskQuestion[], picked: string[][], other: string[]): { answers: AskAnswers; missing: boolean; ignored: string[] } {
  const answers: AskAnswers = {};
  const ignored: string[] = [];
  questions.forEach((item, qi) => {
    const sel = picked[qi] ?? [];
    const own = (other[qi] ?? '').trim();
    const labels = sel.filter((v) => v !== OTHER);
    if (sel.includes(OTHER) && own) labels.push(own);
    else if (!sel.length && own) labels.push(own);
    else if (own) ignored.push(item.header || item.question);
    answers[item.question] = labels.join(', ');
  });
  return { answers, missing: Object.values(answers).some((v) => !v), ignored };
}

/** Текст подтверждения, когда свой ответ написан, но не выбран. */
export const ignoredConfirmText = (ignored: string[]): string =>
  t('Свой ответ написан, но не выбран — он не уйдёт агенту:\n{list}\nОтправить без него?', { list: ignored.map((x) => `• ${x}`).join('\n') });

/** Ответ ушёл: убираем вопрос из входящих сразу, не дожидаясь события. */
export const withoutQuestion = (runs: HomeRun[], runId: string, qid: string): HomeRun[] =>
  runs.map((r) => (r.id === runId ? { ...r, questions: r.questions.filter((x) => x.id !== qid) } : r));
