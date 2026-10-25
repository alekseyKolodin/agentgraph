// Артефакты запуска без React и DOM (порт ui/artifacts.js): одна форма артефакта для отчёта, события и списка,
// итоги шагов (что изменил этап или проверка условия, предупреждения, отказы записи), тексты панели, строк, окна
// и диалога несохранённой правки. Состояние живёт в screens/run/artStore.ts, сюда оно приходит параметрами.
import type {
  ArtifactAuthor, ArtifactLite, ArtifactListItem, ArtifactMeta, ArtifactRead, ArtifactTasks, ConditionReport, Denial, PhaseReport, RunReport, StepDelta,
} from '@server/api-types';
import { plural } from '../format';

/** Правка в UI — до 1 МБ в байтах, как на сервере. */
export const ART_EDIT_MAX = 1024 * 1024;
export const ART_DENIAL: Record<string, string> = {
  'artifact-readonly': 'запись в артефакт, доступный только для чтения',
  'not-artifact': 'файл не артефакт этапа',
  'outside-artifacts': 'файл вне артефактов этапа',
  'runs-dir': 'запись в папку запусков',
  isolation: 'сабагент с изоляцией',
};

/** Артефакт на экране: из отчёта, события или списка; из списка — ещё путь, пропажа файла и правило правки. */
export type ArtItem = ArtifactLite & Partial<Pick<ArtifactListItem, 'path' | 'missing' | 'editable' | 'reason' | 'message'>>;
/** Итог шага по артефактам: этапа или проверки условия (у неё отказов нет). */
export type StepInfo = { changed: string[]; warnings: string[]; denials: Denial[] };
/** Предупреждение для панели: где (запуск, этап, проверка) и в какой итерации — для значка итерации. */
export type ArtWarning = { text: string; where: string; block?: string; iteration?: number };

export const artKey = (runId: string, key: string): string => `${runId}\n${key}`;
/** Ключ итога шага: block|iteration|phase, у проверки условия phase — #cond. */
export const artStepKey = (block: string | undefined, iteration: number, phase: string): string => `${block ?? ''}|${iteration}|${phase}`;
export const artIsMd = (file: string | undefined): boolean => /\.md$/i.test(file || '');
export const artQuote = (titles: string[]): string => titles.map((t) => `«${t}»`).join(', ');

/** Время изменения: сегодня — часы и минуты, иначе ещё день и месяц. */
export function artClock(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? t : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${t}`;
}

/** Последний автор словами; multi — у запуска несколько блоков, и блок называется. */
export function artAuthor(a: ArtifactAuthor | undefined, multi: boolean): string {
  const where = (x: { block?: string; iteration: number }) => `${multi && x.block ? `блок ${x.block}, ` : ''}итерация ${x.iteration}`;
  switch (a?.kind) {
    case 'phase': return `этап ${a.phase} (${where(a)})`;
    case 'unknown': return `неизвестно: изменён во время этапа ${a.phase} (${where(a)}) не через UI`;
    case 'user': return a.via === 'skill' ? 'пользователь через скилл' : 'пользователь';
    case 'outside': return 'снаружи: вне этапов между шагами';
    case 'condition': return `проверка условия (${where(a)})`;
    case 'initial': return 'заготовка flow';
    default: return 'ещё не заполнялся';
  }
}

/** «Кем изменён» для конфликта. */
export function artBy(a: ArtifactAuthor | undefined): string {
  switch (a?.kind) {
    case 'phase': return `этапом ${a.phase}`;
    case 'unknown': return `во время этапа ${a.phase}, не через UI`;
    case 'user': return a.via === 'skill' ? 'через скилл' : 'пользователем в UI (другая вкладка или окно)';
    case 'outside': return 'снаружи, вне этапов';
    case 'condition': return 'проверкой условия';
    default: return 'неизвестно кем';
  }
}

/** Одна форма артефакта: в отчёте — ArtifactMeta (versions — массив), в событии и списке — ArtifactLite. */
export function artLite(a: ArtifactMeta | ArtItem): ArtItem {
  if (Array.isArray(a.versions)) {
    const m = a as ArtifactMeta;
    const last = m.versions.at(-1);
    return {
      key: m.key, title: m.title || m.key, file: m.file, size: m.size, hash: m.hash,
      author: last?.author ?? { kind: 'empty' }, ...(last?.at ? { at: last.at } : {}),
      versions: m.versions.length, lockedBy: [],
      ...(m.decisions ? { decisions: true as const } : {}), ...(m.fromRun ? { fromRun: m.fromRun } : {}),
      ...(m.tasks ? { tasks: m.tasks } : {}),
    };
  }
  const l = a as ArtItem;
  return { ...l, title: l.title || l.key, lockedBy: l.lockedBy || [] };
}

/**
 * Новый снимок артефактов. Из события путь и правило правки остаются от последнего списка (fromList — это список).
 * changed — ключи, у которых сменились хэш или блокировка.
 */
export function mergeItems(prev: Map<string, ArtItem>, list: (ArtifactLite | ArtifactListItem)[], fromList: boolean): { items: Map<string, ArtItem>; order: string[]; changed: string[] } {
  const sig = (a: ArtItem) => `${a.hash}|${(a.lockedBy || []).join(',')}`;
  const before = new Map([...prev].map(([k, a]) => [k, sig(a)]));
  const items = new Map<string, ArtItem>();
  for (const raw of list) {
    const it = artLite(raw);
    const p = prev.get(it.key);
    items.set(it.key, fromList || !p ? it : { path: p.path, editable: p.editable, reason: p.reason, message: p.message, ...it });
  }
  return { items, order: list.map((a) => a.key), changed: [...items.values()].filter((a) => before.get(a.key) !== sig(a)).map((a) => a.key) };
}

/** Итоги шага из события в карту итогов; возвращает предупреждения уровня запуска, если они пришли. */
export function mergeStep(steps: Map<string, StepInfo>, d: StepDelta): string[] | undefined {
  if (d.block === undefined) return d.run;
  if (d.condition) steps.set(artStepKey(d.block, d.iteration!, '#cond'), { changed: d.condition.changed || [], warnings: d.condition.warnings || [], denials: [] });
  for (const p of d.phases || []) steps.set(artStepKey(d.block, d.iteration!, p.phase), { changed: p.changed || [], warnings: p.warnings || [], denials: p.denials || [] });
  return d.run;
}

type StepRep = Pick<PhaseReport, 'artifacts'> & { denials?: Denial[] };

/** Итог шага: из события (свежее) или из отчёта этапа или условия. phase = null — проверка условия. */
export function stepOf(steps: Map<string, StepInfo>, block: string | undefined, iteration: number, phase: string | null, rep?: StepRep): StepInfo | null {
  const k = artStepKey(block, iteration, phase ?? '#cond');
  if (steps.has(k)) return steps.get(k)!;
  if (!rep || (!rep.artifacts && !rep.denials?.length)) return null;
  return { changed: rep.artifacts?.changed || [], warnings: rep.artifacts?.warnings || [], denials: rep.denials || [] };
}

type WarnRun = Pick<RunReport, 'artifacts'> & { blocks?: unknown[]; phases: PhaseReport[]; conditions: ConditionReport[] };

/** Все предупреждения запуска: уровня запуска, этапов и проверок условия. runWarnings — из последнего события; null — из отчёта. */
export function allWarnings(r: WarnRun, steps: Map<string, StepInfo>, runWarnings: string[] | null): ArtWarning[] {
  if (!r.artifacts) return [];
  const multi = (r.blocks?.length ?? 0) > 1;
  const where = (block: string | undefined, it: number, who: string) => `${who}${multi && block ? `, блок ${block}` : ''}, итерация ${it}`;
  const out: ArtWarning[] = (runWarnings ?? r.artifacts.warnings ?? []).map((text) => ({ text, where: 'запуск' }));
  const seen = new Set<string>();
  const add = (k: string, s: StepInfo | null, block: string | undefined, it: number, who: string) => {
    seen.add(k);
    for (const text of s?.warnings || []) out.push({ text, block: block ?? '', iteration: it, where: where(block, it, who) });
  };
  for (const p of r.phases) add(artStepKey(p.block, p.iteration, p.phase), stepOf(steps, p.block, p.iteration, p.phase, p), p.block, p.iteration, `этап ${p.phase}`);
  for (const c of r.conditions) add(artStepKey(c.block, c.iteration, '#cond'), stepOf(steps, c.block, c.iteration, null, c), c.block, c.iteration, 'проверка условия');
  // итог шага пришёл, а отчёт этапа ещё нет (или этап упал без отчёта)
  for (const [k, s] of steps) {
    if (seen.has(k)) continue;
    const [block, it, ph] = k.split('|') as [string, string, string];
    add(k, s, block, Number(it), ph === '#cond' ? 'проверка условия' : `этап ${ph}`);
  }
  return out;
}

/** Строка карточки этапа или условия: что изменил, сколько отказов записи и почему, предупреждения. null — пусто. */
export function stepLine(s: StepInfo | null): { changed: string[]; denied: number; why: string; warnings: string[] } | null {
  if (!s) return null;
  const denied = s.denials.reduce((n, d) => n + (d.count || 0), 0);
  const why = s.denials.map((d) => `${d.tool}: ${ART_DENIAL[d.reason] || d.reason}${d.count > 1 ? ` ×${d.count}` : ''}`).join('; ');
  if (!s.changed.length && !denied && !s.warnings.length) return null;
  return { changed: s.changed, denied, why, warnings: s.warnings };
}

/** Число предупреждений артефактов в итерации блока: значок в заголовке итерации. */
export const iterWarnCount = (warns: ArtWarning[], block: string | undefined, it: number): number =>
  warns.filter((w) => w.iteration === it && w.block === (block ?? '')).length;

export const iterWarnText = (n: number): string => `${plural(n, 'предупреждение', 'предупреждения', 'предупреждений')} артефактов`;

/** Бейдж пунктов чек-листа: «открыто N из M»; всё закрыто — спокойный цвет. */
export function tasksBadge(t: ArtifactTasks): { text: string; title: string; done: boolean } {
  const open = Number(t.open) || 0;
  const done = Number(t.done) || 0;
  return { text: `открыто ${open} из ${open + done}`, title: `Пункты чек-листа: открыто ${open}, закрыто ${done}`, done: !open };
}

/** Кто держит артефакт: спросивший этап ждёт ответа — так и сказать. asking — этапы, чей вопрос ждёт ответа. */
export function lockText(asking: string[], lock: string[]): string {
  const asker = lock.filter((p) => asking.includes(p));
  return asker.length ? `этап ${asker.join(', ')} ждёт ответа и пишет` : `пишет этап ${lock.join(', ')}`;
}

type AttnRun = { live?: boolean; pause?: string | null; pauseReason?: unknown; questions: { phase: string; answers?: unknown }[] };
/** Агент ждёт пользователя: подсветка панели и точка у вкладки. */
export const artAttention = (r: AttnRun): boolean => Boolean(r.live && ((r.pause === 'paused' && r.pauseReason) || r.questions.some((q) => !q.answers)));
/** Этапы, чей вопрос ждёт ответа. */
export const artAsking = (r: AttnRun): string[] => (r.live ? r.questions.filter((q) => !q.answers).map((q) => q.phase) : []);

/** Пометка: текст и вид (lock, warn, draft, err, blank, tasks); title — подсказка. */
export type ArtMark = { text: string; cls?: string; title?: string };

/** Сводка в свёрнутой строке панели: число, последний изменённый, кто пишет, предупреждения, черновики, пауза. */
export function summaryParts(o: { items: ArtItem[]; warns: number; drafts: number; asking: string[]; live: boolean; paused: boolean; multi: boolean; now?: Date }): (string | ArtMark)[] {
  const parts: (string | ArtMark)[] = [`${o.items.length} ${plural(o.items.length, 'артефакт', 'артефакта', 'артефактов')}`];
  const last = o.items.filter((a) => a.at && a.author?.kind !== 'empty').sort((a, b) => b.at!.localeCompare(a.at!))[0];
  if (last) parts.push(`последний изменён: ${last.title} — ${artAuthor(last.author, o.multi)}, ${artClock(last.at, o.now)}`);
  const lock = [...new Set(o.items.flatMap((a) => a.lockedBy || []))];
  if (lock.length) parts.push({ text: `✎ ${lockText(o.asking, lock)}`, cls: 'lock' });
  if (o.warns) parts.push({ text: `⚠ предупреждений: ${o.warns}`, cls: 'warn' });
  if (o.drafts) parts.push({ text: `не сохранено: ${o.drafts}`, cls: 'draft' });
  if (o.live && o.paused) parts.push({ text: 'на паузе: можно править' });
  return parts;
}

/** Пометки строки артефакта в панели. */
export function rowMarks(a: ArtItem, o: { warns: ArtWarning[]; dirty: boolean; asking: string[] }): ArtMark[] {
  const marks: ArtMark[] = [];
  const lock = a.lockedBy || [];
  if (lock.length) marks.push({ text: `✎ ${lockText(o.asking, lock)}`, cls: 'lock' });
  if (a.tasks) {
    const t = tasksBadge(a.tasks);
    marks.push({ text: t.text, cls: t.done ? 'tasks done' : 'tasks', title: t.title });
  }
  const w = o.warns.filter((x) => x.text.includes(`«${a.title}»`));
  if (w.length) marks.push({ text: `⚠ предупреждений: ${w.length}`, cls: 'warn', title: w.map((x) => `${x.where}: ${x.text}`).join('\n') });
  if (o.dirty) marks.push({ text: 'не сохранено', cls: 'draft' });
  if (a.missing) marks.push({ text: 'файл исчез: перед следующим шагом будет создан пустым', cls: 'err' });
  else if (!a.size) marks.push({ text: 'пока пусто', cls: 'blank' });
  if (a.size > ART_EDIT_MAX) marks.push({ text: 'только чтение: больше 1 МБ' });
  if (a.decisions) marks.push({ text: 'ответы на паузы' });
  if (a.fromRun) marks.push({ text: 'из прошлого запуска', title: a.fromRun });
  return marks;
}

/** Строка подсказки панели. */
export type HintLine =
  | { kind: 'from'; id: string; known: boolean }
  | { kind: 'text'; text: string; warn?: boolean }
  | { kind: 'continue'; text: string }
  | { kind: 'lost' };

/** Подсказка под шапкой панели: откуда артефакты, когда править, правило правки неживого, возобновили не отсюда. */
export function hintLines(o: {
  from?: string; fromKnown: boolean; live: boolean; paused: boolean; items: ArtItem[]; foreignDrafts: string[]; lostAnswer: boolean;
}): HintLine[] {
  const out: HintLine[] = [];
  if (o.from) out.push({ kind: 'from', id: o.from, known: o.fromKnown });
  if (o.live) {
    out.push({
      kind: 'text',
      text: o.paused ? 'Запуск на паузе: правка попадёт в следующий шаг.' : 'Править надёжнее на паузе: идущий этап уже получил свою версию, правка учтётся со следующего шага.',
    });
  } else {
    // правило правки у неживого запуска одно на все артефакты (кроме «больше 1 МБ») — берём его из списка сервера
    const it = o.items.find((a) => a.reason && a.reason !== 'too-big');
    if (it?.reason === 'continuable') out.push({ kind: 'continue', text: `${it.message}.` });
    else if (it?.message) out.push({ kind: 'text', text: `${it.message}.` });
  }
  if (o.foreignDrafts.length) {
    out.push({
      kind: 'text',
      warn: true,
      text: `Запуск возобновлён не отсюда, текст не сохранён: ${artQuote(o.foreignDrafts)}. Идущий шаг его не увидит; сохрани правку, и её получит следующий шаг.`,
    });
  }
  if (o.lostAnswer) out.push({ kind: 'lost' });
  return out;
}

// ---------- черновики и диалог перед «Возобновить» / «Продолжить»

export type ArtDraft = { id: number; runId: string; key: string; title: string; text: string; orig: string; base: string };
export const draftDirty = (d: ArtDraft | undefined): boolean => Boolean(d && d.text !== d.orig);

/** resume — запуск на паузе; requested — пауза ещё не встала; continue — продолжение остановленного. */
export type DraftsMode = 'resume' | 'requested' | 'continue';

export function draftsDialog(titles: string[], mode: DraftsMode): { text: string; save: string; skip: string } {
  const [save, skip] = {
    resume: ['Сохранить и возобновить', 'Возобновить без правки'],
    requested: ['Сохранить', 'Возобновить без правки'],
    continue: ['Сохранить и продолжить', 'Продолжить без правки'],
  }[mode] as [string, string];
  const tail = {
    resume: 'Без сохранения следующий шаг её не увидит.',
    requested: 'Запуск ещё доделывает текущий шаг: «Сохранить» запишет правку, пауза останется в силе.',
    continue: 'Продолжение возьмёт артефакты с диска: без сохранения правка в него не попадёт.',
  }[mode];
  return { text: `Несохранённая правка ${titles.length > 1 ? 'артефактов' : 'артефакта'} ${artQuote(titles)}. ${tail}`, save, skip };
}

/** Почему черновик не сохранился при сохранении пачкой (перед возобновлением или продолжением). */
export function draftSaveWhy(err: { status?: number; code?: string; message: string } | null, tooBig: boolean): string {
  if (tooBig) return 'текст больше 1 МБ';
  if (err?.code === 'conflict') return 'файл изменён после того, как ты его открыл: открой артефакт, там «Перечитать» и «Сохранить поверх»';
  return err?.status ? err.message : 'сервер недоступен';
}

// ---------- окно артефакта

/** Открытое окно: текущая версия с сервера, выбранная старая, конфликт записи, строка статуса. */
export type ArtWin = {
  runId: string;
  key: string;
  title: string;
  cur: ArtifactRead | null;
  ver: ArtifactRead | null;
  conflict: { hash?: string; author?: ArtifactAuthor; at?: string } | null;
  error: string;
  msg: string;
  msgKind: '' | 'ok' | 'warn' | 'err';
  loading: boolean;
  saving: boolean;
  saveFailed: boolean;
};

/** Состояние окна выводится из данных и черновика: блокировка и изменение файла приходят событиями в любой момент. */
export type WinState = 'version' | 'view' | 'locked' | 'conflict' | 'edit';

export const winEditable = (w: Pick<ArtWin, 'cur'>): boolean => Boolean(w.cur && typeof w.cur.text === 'string' && w.cur.editable);

export function winState(w: ArtWin, d: ArtDraft | undefined): WinState {
  if (w.ver) return 'version';
  if (!d) return 'view';
  if (!winEditable(w)) return 'locked';
  if (w.conflict || (w.cur?.hash && d.base !== w.cur.hash)) return 'conflict';
  return 'edit';
}

/** Почему правки нет: текст недоступен или правило сервера. */
export function winReason(w: Pick<ArtWin, 'cur'>): string {
  const cur = w.cur;
  if (!cur) return '';
  if (cur.text === null && cur.textMessage) return cur.textMessage;
  return cur.editable ? '' : cur.message || 'Сейчас артефакт не правится';
}

/** Строка статуса окна: причина недоступности, ошибка, итог действия, подсказка про паузу. */
export function winStatus(w: ArtWin, st: WinState, run: { live?: boolean; pause?: string | null } | null): { text: string; kind: string } {
  const editable = winEditable(w);
  const reason = winReason(w);
  let text = '';
  let kind: string = '';
  if (w.error) {
    text = w.error;
    kind = 'err';
  } else if (w.loading && !w.cur) text = 'Загружаю…';
  else if (reason && (st === 'locked' || st === 'view' || st === 'version')) {
    text = reason;
    kind = st === 'locked' ? 'warn' : '';
  } else if (w.msg) {
    /* итог действия важнее общей подсказки */
  } else if ((st === 'view' || st === 'edit') && run?.live && run.pause !== 'paused' && editable) {
    text = 'Править надёжнее на паузе: идущий этап уже получил свою версию, правка учтётся со следующего шага.';
  } else if ((st === 'view' || st === 'edit') && w.cur?.reason === 'continuable') text = `${w.cur.message}.`;
  if (w.msg) {
    text = text ? `${text} ${w.msg}` : w.msg;
    kind = w.msgKind || kind;
  }
  return { text, kind };
}

/** Баннер окна: старая версия, конфликт, возобновление не отсюда. */
export function winNote(w: ArtWin, st: WinState, foreign: boolean, multi: boolean): { text: string; kind: '' | 'warn' | 'err' } | null {
  const notes: { kind: 'info' | 'warn' | 'err'; text: string }[] = [];
  if (st === 'version' && w.ver?.version) {
    const v = w.ver.version;
    notes.push({ kind: 'info', text: `Версия ${v.n} от ${artClock(v.at)}, автор: ${artAuthor(v.author, multi)} — не текущая.` });
  }
  if (st === 'conflict') {
    const c = w.conflict ?? { author: w.cur?.author, at: w.cur?.at };
    notes.push({ kind: 'err', text: `Файл изменён после того, как ты его открыл (${artBy(c.author)}${c.at ? `, ${artClock(c.at)}` : ''}); твой текст здесь. «Перечитать» заменит его версией с диска, «Сохранить поверх» запишет твой.` });
  }
  if ((st === 'edit' || st === 'conflict' || st === 'locked') && foreign) notes.push({ kind: 'warn', text: 'Запуск возобновлён не отсюда, текст не сохранён: идущий шаг его не увидит.' });
  if (!notes.length) return null;
  return { text: notes.map((n) => n.text).join(' '), kind: notes.some((n) => n.kind === 'err') ? 'err' : notes.some((n) => n.kind === 'warn') ? 'warn' : '' };
}

/** Варианты выбора версии: текущая и прошлые, от новых к старым. */
export function versionOptions(cur: ArtifactRead | null, multi: boolean): { value: string; label: string }[] {
  const versions = cur?.versions || [];
  const last = versions.at(-1);
  return [
    { value: '', label: `текущая${last ? ` · версия ${last.n}` : ''}` },
    ...versions.slice(0, -1).reverse().map((v) => ({ value: String(v.n), label: `версия ${v.n} · ${artAuthor(v.author, multi)} · ${artClock(v.at)}${v.stored ? '' : ' · без копии'}` })),
  ];
}

/** Ошибка записи из окна: что показать и что поменять в окне. */
export function saveError(err: { status?: number; code?: string; message: string; data?: unknown }): {
  msg: string; kind: 'err' | 'warn'; conflict?: ArtWin['conflict']; readonly?: { reason?: string; message: string };
} {
  const keep = 'Текст остался в редакторе.';
  const data = (err.data ?? {}) as { hash?: string; author?: ArtifactAuthor; at?: string; reason?: string };
  switch (err.code) {
    case 'conflict':
      return { msg: '', kind: 'err', conflict: { hash: data.hash, author: data.author, at: data.at } };
    case 'locked':
    case 'readonly':
      return { msg: keep, kind: 'warn', readonly: { reason: data.reason, message: err.message } };
    case 'not_paused':
      return { msg: `${err.message}. Нажми «Сохранить».`, kind: 'err' };
    case 'missing':
      return { msg: `Файл артефакта исчез с диска: перед следующим шагом он будет создан пустым, тогда сохрани снова. ${keep}`, kind: 'err' };
    case 'too_big':
      return { msg: `${err.message}. ${keep}`, kind: 'err' };
    default:
      return {
        msg: err.status ? `Не сохранено: ${err.message}. ${keep} Скопируй его, если он нужен.` : `Сервер недоступен: правка не сохранена. ${keep} Сохрани снова, когда сервер поднимется.`,
        kind: 'err',
      };
  }
}

/** Ошибка загрузки списка или артефакта. */
export function loadErrText(err: { status?: number; code?: string; message: string }, what: string): string {
  if (!err.status) return `${what}: сервер недоступен`;
  if (err.code === 'missing') return 'Файл артефакта исчез с диска: перед следующим шагом он будет создан пустым';
  return `${what}: ${err.message}`;
}
