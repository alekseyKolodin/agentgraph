// Шаблоны рутин (docs/desk/SPEC.md, этап 4.7): источник + блок task + готовый flow (templates/flows, 4.6). Ключ шаблона
// уходит в /routines/new?tpl=…; там выбирается подходящий подключённый источник и заполняются шаги. Готовый flow сервер
// копирует в папку flow пользователя при сохранении, если такого flow ещё нет (POST /api/routines/flow-templates/:name).
// «Мои дела» за четыре шаблона: ревью из GitLab/GitHub, ревью по ссылке в Slack, задачи Jira, встречи → дела.
import type { MatchField, SourceView } from '@server/routines/types';
import { parseMatch, type Condition } from './match';
import { emptyDraft, SCHEDULE, type RoutineDraft } from './spec';

export type TemplateKey = 'review-forge' | 'review-slack' | 'jira' | 'meetings' | 'sweep' | 'bug' | 'digest';

export type RoutineTemplate = {
  tpl: TemplateKey;
  /** Ключи i18n: заголовок и подпись карточки шаблона. */
  title: string;
  sub: string;
  /** Готовый flow из templates/flows: при сохранении копируется к flow пользователя, если его нет. */
  flow?: string;
  /** Шаблон «Моих дел» (заводит дела): такие идут первыми. */
  desk?: boolean;
  /** Каким источником подключить, если подходящего нет: рецепт или вид на «Подключить сервис». */
  connect?: string;
  /** Куда сразу вести «Подключить сервис»: вид источника из «Готовых» и сервис, который в нём отметить (по имени). */
  connectTo?: { kind: string; service?: string };
  /** Flow идёт в папке проекта (своей или пространства): без неё шаблон не сохранить. */
  needsDir?: boolean;
};

export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = [
  { tpl: 'review-forge', title: 'Ревью: назначили в GitLab или GitHub', sub: 'Дело «Ревью» и первое ревью агентом', flow: 'desk-review-mr', desk: true, connect: 'GitLab или GitHub' },
  { tpl: 'review-slack', title: 'Ревью: кинули ссылку в Slack', sub: 'Сообщение со ссылкой на MR — то же дело «Ревью»', flow: 'desk-review-mr', desk: true, connect: 'Slack через Claude', connectTo: { kind: 'connector', service: 'slack' } },
  { tpl: 'jira', title: 'Jira: назначили на меня', sub: 'Дело «Jira» и запуск «задача в работу» по кнопке', flow: 'desk-task-start', desk: true, connect: 'Jira', needsDir: true },
  { tpl: 'meetings', title: 'Встречи → дела', sub: 'Пункты действий на мне — делами', flow: 'desk-meeting-tasks', desk: true, connect: 'Fireflies.ai' },
  { tpl: 'sweep', title: 'Каждое утро → обход проекта', sub: 'Незакоммиченное и ветки без MR — делами', flow: 'desk-projects-sweep', desk: true, needsDir: true },
  { tpl: 'bug', title: 'Баг в канале → таска и фикс', sub: 'Сообщение в Slack или Telegram' },
  { tpl: 'digest', title: 'Каждое утро → сводка', sub: 'Расписание' },
];

export const templateOf = (tpl: string | null | undefined): RoutineTemplate | undefined => ROUTINE_TEMPLATES.find((x) => x.tpl === tpl);

/**
 * «Подключить сервис» для шаблона: с вида, который шаблону нужен (Slack-ревью — коннектор Claude, SPEC 9.1), сразу
 * в «Готовые» с этим видом и сервисом; иначе — обычная страница. tpl переживает подключение и возвращает на форму.
 */
export function connectHref(tpl: Pick<RoutineTemplate, 'tpl' | 'connectTo'>): string {
  const p = new URLSearchParams({ from: 'new', tpl: tpl.tpl });
  if (tpl.connectTo) {
    p.set('mode', 'ready');
    p.set('kind', tpl.connectTo.kind);
    if (tpl.connectTo.service) p.set('service', tpl.connectTo.service);
  }
  return `/routines/connect?${p.toString()}`;
}

/** Параметр адреса «Подключить сервис» (kind, service): только слаг, иначе нет. */
export const connectParam = (v: string | null): string | undefined => (v && /^[a-z0-9-]{1,32}$/.test(v) ? v : undefined);

/** Подключённые сервисы коннектора, чьё имя или сервер содержит подсказку шаблона (slack): их отметить сразу. */
export const servicesFor = <S extends { server: string; title: string }>(ready: readonly S[], hint: string | undefined): string[] =>
  hint ? ready.filter((s) => `${s.server} ${s.title}`.toLowerCase().includes(hint.toLowerCase())).map((s) => s.server) : [];

const MESSAGE_KINDS = ['slack', 'telegram'];
const CODE_KINDS = ['gitlab', 'github'];
const MEETING_RE = /fireflies|otter|granola|fathom|zoom|meet\b|meeting|transcript|встреч|созвон|транскрипт/i;
const SLACK_RE = /slack/i;

const text = (s: SourceView): string => `${s.spec.kind} ${s.spec.title} ${s.spec.description ?? ''} ${JSON.stringify(s.spec.config ?? {})}`;

/** Источник встреч: Fireflies и подобные — по виду, названию и описанию (рецепт кладёт их в title/description). */
export const isMeetingSource = (s: SourceView): boolean => MEETING_RE.test(`${s.spec.kind} ${s.spec.title} ${s.spec.description ?? ''}`);

/** Slack через коннектор Claude (вид connector, SPEC 9.1): по названию, описанию и инструментам скрипта. */
export const isSlackConnector = (s: SourceView): boolean => s.spec.kind === 'connector' && SLACK_RE.test(text(s));

/** Подходящий подключённый источник шаблона; нет — ''. */
export function sourceForTemplate(tpl: string | null | undefined, sources: SourceView[]): string {
  const pick = (ok: (s: SourceView) => boolean) => sources.find(ok)?.slug ?? '';
  switch (tpl) {
    case 'digest':
    case 'sweep':
      return SCHEDULE;
    case 'bug':
      return pick((s) => MESSAGE_KINDS.includes(s.spec.kind));
    case 'review-forge':
      return pick((s) => CODE_KINDS.includes(s.spec.kind));
    case 'review-slack':
      // Slack на работе подключён через коннектор Claude; свой токен бота (вид slack) — тоже годится
      return pick(isSlackConnector) || pick((s) => s.spec.kind === 'slack');
    case 'jira':
      return pick((s) => s.spec.kind === 'jira');
    case 'meetings':
      return pick(isMeetingSource);
    default:
      return '';
  }
}

/**
 * Условия шаблона, которые умеет выбранный источник: человек сам выбрал источник (а не подставился подходящий) — условие
 * шаблона («ссылка на MR в тексте», «событие — ревью») остаётся, если у источника есть такое поле (и такое значение, когда
 * значения перечислены); иначе оно не сработает
 * никогда и рутина молчала бы, поэтому его нет. Без шаблона и у расписания — пусто.
 */
export function templateConds(tpl: string | null | undefined, fields: readonly MatchField[]): Condition[] {
  if (!templateOf(tpl)) return [];
  // поле есть, а значения («review») у него нет — условие не сработает никогда, как и без поля
  const ok = (c: Condition) => {
    const f = fields.find((x) => x.key === c.field);
    return Boolean(f) && (!f!.options?.length || c.value.split(',').every((v) => f!.options!.includes(v.trim())));
  };
  return templateDraft(tpl).conds.filter(ok);
}

/** Ссылка на MR (GitLab) или PR (GitHub) в тексте сообщения: условие без модели для «кинули ссылку в Slack». */
export const MR_LINK_MATCH = { 'text~': ['/merge_requests/', '/pull/'] };

export type TemplateCtx = {
  /** Подключённый источник шаблона (если нашёлся). */
  source?: SourceView;
  /** Кто я — строкой из профиля: для встреч («какие пункты мои»). */
  me?: string;
  /** Утренняя сводка: задача по умолчанию (переведённая). */
  digestInput?: string;
};

/**
 * Шаги «Новой рутины» по шаблону: источник, условия, flow, задача, блок task, когда ждать, ответ. Всё остальное — как
 * у пустой рутины. Ответ: у ревью — черновик туда, откуда пришло, если источник умеет отвечать (GitLab/GitHub, Slack с
 * настроенным инструментом ответа); иначе — без ответа рутины: итог ревью виден на странице запуска и в деле.
 */
export function templateDraft(tpl: string | null | undefined, ctx: TemplateCtx = {}): RoutineDraft {
  const base = emptyDraft();
  const source = ctx.source?.slug ?? sourceForTemplate(tpl, []);
  const canReply = Boolean(ctx.source?.canReply);
  const reply: Partial<RoutineDraft> = canReply ? { reply: 'draft', replyTo: 'source', replyOn: ['end'] } : { reply: 'off' };
  const task = (kind: string, more: Partial<RoutineDraft> = {}): Partial<RoutineDraft> => ({ taskOn: true, taskKind: kind, taskFrom: 'event', taskSame: 'thing', taskRepeat: 'plan', taskClose: 'thing', ...more });
  switch (tpl) {
    case 'review-forge':
      return { ...base, source, conds: parseMatch({ event: 'review' }), flow: 'desk-review-mr', mode: 'suggest', ...task('Ревью'), ...reply };
    case 'review-slack':
      return { ...base, source, conds: parseMatch(MR_LINK_MATCH), flow: 'desk-review-mr', mode: 'suggest', ...task('Ревью'), ...reply };
    case 'jira':
      // правки — в новом рабочем дереве проекта: задача из Jira не трогает твою рабочую папку
      return { ...base, source, conds: parseMatch({ change: ['assigned', 'new'] }), flow: 'desk-task-start', mode: 'suggest', worktree: 'new', ...task('Jira'), reply: 'off' };
    case 'meetings':
      return {
        ...base,
        source,
        flow: 'desk-meeting-tasks',
        input: ['Заведи дела по пунктам действий этой встречи, которые на мне.', ctx.me ? `Кто я: ${ctx.me}.` : ''].filter(Boolean).join(' '),
        mode: 'auto',
        usd: '1',
        ...task('Встреча', { taskFrom: 'flow' }),
        reply: 'off',
      };
    case 'sweep':
      return { ...base, source: SCHEDULE, flow: 'desk-projects-sweep', mode: 'auto', usd: '1', ...task('Забытое', { taskFrom: 'flow' }), reply: 'off' };
    case 'digest':
      return { ...base, source: SCHEDULE, mode: 'auto', input: ctx.digestInput ?? '' };
    default:
      return { ...base, source, mode: source === SCHEDULE ? 'auto' : 'suggest' };
  }
}

/** Кто я из профиля одной строкой: имена, почта, логины GitLab/GitHub. Пусто — ''. */
export function profileLine(p: { names?: string[]; emails?: string[]; gitlab?: string; github?: string; jiraEmail?: string } | undefined): string {
  if (!p) return '';
  const parts = [...(p.names ?? []), ...(p.emails ?? []), p.jiraEmail, p.gitlab && `@${p.gitlab} (GitLab)`, p.github && `@${p.github} (GitHub)`].filter((x): x is string => Boolean(x && x.trim()));
  return [...new Set(parts)].join(', ');
}
