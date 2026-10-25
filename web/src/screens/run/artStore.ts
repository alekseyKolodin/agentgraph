// Артефакты открытого запуска (ui/artifacts.js: объект art и его функции) — модуль вне компонентов, как runState в store.ts.
// Список с сервера и снимки из событий, итоги шагов, черновики правки (живут до перезагрузки страницы, на любой запуск),
// окно артефакта, «Возобновить» и «Продолжить» при черновике или с ответом на паузу, диалог несохранённой правки.
// Событие artifacts правит только это состояние: панель, значки шагов и окно перерисовываются по его счётчику версий.
import { useSyncExternalStore } from 'react';
import type { RunStreamEvent } from '@server/api-types';
import { ApiError, errorText, fetchArtifact, fetchArtifacts, resumeRun, RUN_DELETED, saveArtifact } from '../../api';
import {
  allWarnings, artClock, artKey, artLite, artQuote, ART_EDIT_MAX, draftDirty, draftsDialog, draftSaveWhy, loadErrText, mergeItems, mergeStep, saveError, winEditable,
  type ArtDraft, type ArtItem, type ArtWarning, type ArtWin, type StepInfo,
} from '../../lib/run/artifacts';
import { PAUSE_ANSWER_MAX, textBytes } from '../../lib/run/view';
import { answerKey, dropPauseAnswer, dropRunPauseAnswers, hasPauseAnswers, pauseAnswerOf } from './pauseAnswer';
import { runState } from './store';

type ArtifactsEvent = Extract<RunStreamEvent, { type: 'artifacts' }>;
type Win = ArtWin & { seqCur: number; seqVer: number; opener: HTMLElement | null };
type ErrLike = { status?: number; code?: string; message: string; data?: unknown };
const errLike = (err: unknown): ErrLike => (err instanceof ApiError ? err : { message: err instanceof Error ? err.message : String(err) });

export const art = {
  /** Сервер умеет артефакты (фича artifacts): без неё ни панели, ни значков, ни запросов. Ставит страница запуска. */
  on: false,
  /** Запуск, к которому относится состояние панели. */
  runId: null as string | null,
  items: new Map<string, ArtItem>(),
  /** Ключи в порядке объявления. */
  order: [] as string[],
  info: null as { from?: string; live: boolean; continuable: boolean; continueReason?: string } | null,
  /** Предупреждения уровня запуска из последнего события; null — из отчёта. */
  runWarnings: null as string[] | null,
  /** Итоги шагов из событий: block|iteration|phase (условие — #cond). */
  steps: new Map<string, StepInfo>(),
  loaded: false,
  loading: false,
  error: '',
  loadedAt: null as Date | null,
  seq: 0,
  /** По смене паузы видно, что запуск возобновили. */
  lastPause: null as { runId: string; pause: string | null; at?: string } | null,
  /** Запуски, которые возобновляет эта вкладка. */
  resumingHere: new Set<string>(),
  /** Возобновили не отсюда, а черновики остались. */
  foreignResume: false,
  /** Ответ на паузу, который не ушёл: запуск возобновили не отсюда. */
  lostAnswer: '',
  /** Переподключение: переигранные паузы не считаем возобновлением не отсюда. */
  replayUntil: 0,
  /** runId\nkey → черновик правки. */
  drafts: new Map<string, ArtDraft>(),
  win: null as Win | null,
  /** После закрытия окна — вернуть фокус туда, откуда открыли. */
  focusBack: null as { opener: HTMLElement | null; key: string } | null,
  /** Сообщение под полем ответа на паузу; key — answerKey паузы. */
  answerMsg: { key: '', text: '', kind: '' as '' | 'err' },
  /** Открытый диалог несохранённой правки. */
  ask: null as { text: string; save: string; skip: string; resolve: (v: 'save' | 'skip' | 'cancel') => void } | null,
  version: 0,
};

const subs = new Set<() => void>();

export function artBump(): void {
  art.version++;
  subs.forEach((f) => f());
}

export const useArtStore = (): number =>
  useSyncExternalStore((f) => {
    subs.add(f);
    return () => subs.delete(f);
  }, () => art.version);

const curRun = () => runState.st?.run ?? null;
export const multiOf = (r: { blocks?: unknown[] } | null | undefined): boolean => (r?.blocks?.length ?? 0) > 1;

/** Артефакты для показа: живые данные (список или событие), до них — из отчёта, без прыжка вёрстки. */
export function artItems(): ArtItem[] {
  const r = curRun();
  if (art.order.length && art.runId === r?.id) return art.order.map((k) => art.items.get(k)).filter((x): x is ArtItem => Boolean(x));
  return (r?.artifacts?.items || []).map(artLite);
}

export const artDecisions = (): ArtItem | undefined => artItems().find((a) => a.decisions);

export function artWarnings(): ArtWarning[] {
  const r = curRun();
  return r ? allWarnings(r, art.runId === r.id ? art.steps : new Map(), art.runId === r.id ? art.runWarnings : null) : [];
}

// ---------- черновики

export const draftOf = (runId: string, key: string): ArtDraft | undefined => art.drafts.get(artKey(runId, key));
export const dirtyDrafts = (runId: string): ArtDraft[] => [...art.drafts.values()].filter((d) => d.runId === runId && draftDirty(d));
/** Есть ли что терять при уходе со страницы: черновик правки (недописанный ответ на паузу смотрит pauseAnswer.ts). */
export const hasDirtyDrafts = (): boolean => [...art.drafts.values()].some(draftDirty);

// запуск удалён (со страницы или из списка): его черновики и ответы на паузу больше некуда сохранить, и beforeunload
// не должен про них спрашивать
window.addEventListener(RUN_DELETED, (e) => {
  const runId = (e as CustomEvent<string>).detail;
  for (const [k, d] of art.drafts) if (d.runId === runId) art.drafts.delete(k);
  dropRunPauseAnswers(runId);
  artBump();
});

// черновики и недописанные ответы живут до перезагрузки страницы, на любом экране: уход спрашивает браузер
window.addEventListener('beforeunload', (e) => {
  if (!hasDirtyDrafts() && !hasPauseAnswers()) return;
  e.preventDefault();
  e.returnValue = '';
});

let draftSeq = 0;
function startDraft(runId: string, key: string, title: string, text: string, base: string, orig: string): ArtDraft {
  const d = { id: ++draftSeq, runId, key, title, text, orig, base };
  art.drafts.set(artKey(runId, key), d);
  return d;
}

// ---------- список

export async function artLoad(): Promise<void> {
  const r = curRun();
  if (!r?.artifacts) return;
  const runId = r.id;
  const seq = ++art.seq;
  art.loading = true;
  try {
    const data = await fetchArtifacts(runId);
    if (seq !== art.seq || runState.id !== runId) return;
    const m = mergeItems(art.items, data.items || [], true);
    art.items = m.items;
    art.order = m.order;
    art.info = { from: data.from, live: data.live, continuable: data.continuable, continueReason: data.continueReason };
    art.runWarnings = data.warnings || art.runWarnings;
    art.error = '';
    art.loaded = true;
    art.loadedAt = new Date();
  } catch (err) {
    if (seq !== art.seq || runState.id !== runId) return;
    art.error = loadErrText(errLike(err), 'Список артефактов не загрузился');
  } finally {
    if (seq === art.seq) art.loading = false;
  }
  artBump();
}

/** Панель на экране: список грузится сам, если его ещё нет (и не было ошибки). */
export function artEnsureLoaded(): void {
  if (!art.loaded && !art.loading && !art.error) void artLoad();
}

/** После сохранения: у живого запуска список обновит событие artifacts, у неживого событий нет — перечитываем. */
function refreshAfterSave(runId: string) {
  const r = curRun();
  if (r?.id !== runId || r.live) return;
  art.loaded = false;
  void artLoad();
}

/** Перечитать список (и открытое окно): конец запуска, ошибка потока, «Обновить», «Повторить». */
export function artReload(): void {
  const r = curRun();
  if (!r?.artifacts) return;
  art.loaded = false;
  art.error = '';
  void artLoad();
  if (art.win && art.win.runId === r.id) void winLoad();
  artBump();
}

// ---------- точки встраивания страницы запуска

/** Открыли запуск: новый — новое состояние панели; тот же — перечитать. Черновики живут дальше. */
export function artOpenRun(id: string): void {
  if (art.runId !== id) {
    if (art.win) closeWin(true);
    Object.assign(art, {
      runId: id, items: new Map(), order: [], info: null, runWarnings: null, steps: new Map(), loaded: false, error: '',
      loadedAt: null, lastPause: null, foreignResume: false, lostAnswer: '',
    });
  } else {
    art.loaded = false;
    art.error = '';
  }
  art.loading = false;
  art.seq++;
  artBump();
}

/** Поток (пере)подключился: события переигрываются, список перечитываем сразу. Первое подключение — список уже грузится. */
export function artOnStreamOpen(): void {
  art.replayUntil = Date.now() + 2000;
  if (art.loaded || art.error) artReload();
}

/** Событие artifacts: снимок списка и итоги шагов. */
export function artOnEvent(e: ArtifactsEvent): void {
  if (!runState.st || runState.id !== art.runId) return;
  const m = mergeItems(art.items, e.items || [], false);
  art.items = m.items;
  art.order = m.order;
  for (const d of e.steps || (e.step ? [e.step] : [])) {
    const w = mergeStep(art.steps, d);
    if (w) art.runWarnings = w;
  }
  artBump();
  if (art.win && art.win.runId === runState.id && m.changed.includes(art.win.key)) winSync();
}

/** Пауза снята: если не этой вкладкой, а черновики остались — сказать, что их текст в шаг не попал. */
export function artTrackPause(r: { id: string; live?: boolean; pause?: string | null; pauseReason?: { at?: string } | null }): void {
  const now = r.live ? r.pause || null : null;
  const prev = art.lastPause?.runId === r.id ? art.lastPause : null;
  const moved = Boolean(prev) && (prev!.pause ?? null) !== now;
  if (prev?.pause && !now && r.live) {
    const here = art.resumingHere.has(r.id);
    const replay = Date.now() < art.replayUntil;
    const key = answerKey(r.id, prev.at || '');
    const answer = pauseAnswerOf(key);
    if (!here && !replay) {
      if (dirtyDrafts(r.id).length) art.foreignResume = true;
      if (prev.pause === 'paused' && answer.trim()) art.lostAnswer = answer;
    }
    dropPauseAnswer(key);
    art.resumingHere.delete(r.id);
  }
  if (now && !prev?.pause) {
    art.resumingHere.delete(r.id);
    art.foreignResume = false;
  }
  art.lastPause = { runId: r.id, pause: now, at: r.pauseReason?.at };
  if (moved) artBump();
}

export function setAnswerMsg(key: string, text: string, kind: '' | 'err' = ''): void {
  art.answerMsg = { key, text, kind };
  artBump();
}

// ---------- диалог несохранённой правки и «Возобновить» / «Продолжить»

export function askDrafts(text: { text: string; save: string; skip: string }): Promise<'save' | 'skip' | 'cancel'> {
  return new Promise((resolve) => {
    art.ask?.resolve('cancel');
    art.ask = { ...text, resolve };
    artBump();
  });
}

export function answerDrafts(v: 'save' | 'skip' | 'cancel'): void {
  const a = art.ask;
  if (!a) return;
  art.ask = null;
  artBump();
  a.resolve(v);
}

type Ui = { notify: (text: string) => Promise<unknown>; toast: (text: string) => void };
type ConfirmFn = (text: string, o?: { ok?: string; danger?: boolean }) => Promise<boolean>;

/** Сохранить черновики по очереди; на первой ошибке — что сохранено, а что нет. null — не всё сохранено. */
async function saveDrafts(drafts: ArtDraft[], stopped: string, ui: Ui): Promise<string[] | null> {
  const saved: string[] = [];
  for (const d of drafts) {
    let why: string;
    if (textBytes(d.text) > ART_EDIT_MAX) why = draftSaveWhy(null, true);
    else {
      try {
        await saveArtifact(d.runId, d.key, { text: d.text, base: d.base });
        art.drafts.delete(artKey(d.runId, d.key));
        saved.push(d.title);
        refreshAfterSave(d.runId);
        continue;
      } catch (err) {
        why = draftSaveWhy(errLike(err), false);
      }
    }
    artBump();
    await ui.notify(`${saved.length ? `Сохранено: ${artQuote(saved)}. ` : ''}Не сохранено: «${d.title}» — ${why}. ${stopped}`);
    return null;
  }
  artBump();
  return saved;
}

type ResumeRun = { pause?: 'requested' | 'paused' | null; pauseReason?: { at?: string } | null };

/**
 * «Возобновить» со страницы запуска и с главной (pauseRun(false) + artBeforeResume): черновики → выбор; ответ на паузу —
 * resume с ответом (он допишется в артефакт решений), иначе обычное возобновление. На странице этого запуска сообщения
 * об ответе — под его полем, с главной — окном. run — запуск с главной; у открытого берётся его состояние.
 */
export async function artResume(runId: string, homeRun: ResumeRun | undefined, ui: Ui): Promise<void> {
  const onPage = runState.id === runId && Boolean(runState.st);
  const run: ResumeRun | undefined = onPage ? runState.st!.run : homeRun;
  const paused = run?.pause === 'paused';
  const drafts = dirtyDrafts(runId);
  let saved: string[] = [];
  if (drafts.length) {
    const choice = await askDrafts(draftsDialog(drafts.map((d) => d.title), paused ? 'resume' : 'requested'));
    if (choice === 'cancel') return;
    if (choice === 'save') {
      const ok = await saveDrafts(drafts, 'Запуск не возобновлён.', ui);
      if (!ok) return;
      saved = ok;
      if (!paused) {
        ui.toast(`Сохранено: ${artQuote(saved)}. Пауза осталась: запуск встанет после текущего шага`);
        return;
      }
    }
  }
  const key = answerKey(runId, run?.pauseReason?.at || '');
  const answer = paused && run?.pauseReason ? pauseAnswerOf(key).trim() : '';
  art.resumingHere.add(runId);
  if (!answer) {
    try {
      await resumeRun(runId);
    } catch (err) {
      await ui.notify(errorText(err));
    }
    return;
  }
  const say = async (text: string) => (onPage ? setAnswerMsg(key, text, 'err') : void (await ui.notify(text)));
  if (textBytes(answer) > PAUSE_ANSWER_MAX) {
    art.resumingHere.delete(runId);
    return say('Ответ больше 64 КБ: сократи его. Запуск остался на паузе.');
  }
  try {
    if (onPage) setAnswerMsg(key, 'Записываю ответ…');
    await resumeRun(runId, answer);
    dropPauseAnswer(key);
    if (onPage) setAnswerMsg(key, '');
    ui.toast(`${saved.length ? `Сохранено: ${artQuote(saved)}. ` : ''}Ответ записан, запуск возобновлён`);
  } catch (err) {
    art.resumingHere.delete(runId);
    const what = saved.length ? `Правка ${artQuote(saved)} сохранена, но ответ не записан` : 'Ответ не записан';
    await say(`${what}: ${err instanceof ApiError ? err.message : 'сервер недоступен'}. Запуск остался на паузе, текст ответа — в поле.`);
  }
}

/** «Продолжить с места остановки»: черновики старого запуска → выбор. true — продолжать. */
export async function artBeforeContinue(runId: string, ui: Ui): Promise<boolean> {
  const drafts = dirtyDrafts(runId);
  if (!drafts.length) return true;
  const choice = await askDrafts(draftsDialog(drafts.map((d) => d.title), 'continue'));
  if (choice === 'cancel') return false;
  if (choice === 'save') return Boolean(await saveDrafts(drafts, 'Запуск не продолжен.', ui));
  return true;
}

/** Уход к другому запуску с черновиком в этом — подтверждение. */
export async function artConfirmLeave(curId: string, askConfirm: ConfirmFn): Promise<boolean> {
  const drafts = dirtyDrafts(curId);
  if (!drafts.length) return true;
  return askConfirm(
    `Несохранённая правка ${artQuote(drafts.map((d) => d.title))} в этом запуске. Черновик останется до перезагрузки страницы: вернуться к нему можно здесь же. Перейти?`,
    { ok: 'Перейти' },
  );
}

// ---------- окно артефакта

export async function openWin(key: string, opener: HTMLElement | null): Promise<void> {
  const r = curRun();
  if (!r?.artifacts) return;
  if (art.win) closeWin(true);
  const it = art.items.get(key) ?? artItems().find((a) => a.key === key);
  art.win = {
    runId: r.id, key, title: it?.title || key, cur: null, ver: null, conflict: null, error: '', msg: '', msgKind: '', loading: true, saving: false, saveFailed: false,
    seqCur: 0, seqVer: 0, opener,
  };
  artBump();
  await winLoad();
}

export async function winLoad(): Promise<void> {
  const w = art.win;
  if (!w) return;
  const seq = ++w.seqCur;
  w.loading = true;
  try {
    const data = await fetchArtifact(w.runId, w.key);
    if (art.win !== w || seq !== w.seqCur) return;
    w.cur = data;
    w.title = data.title || w.title;
    w.error = '';
  } catch (err) {
    if (art.win !== w || seq !== w.seqCur) return;
    w.error = loadErrText(errLike(err), 'Артефакт не загрузился');
  }
  w.loading = false;
  artBump();
}

export async function winVersion(n: number): Promise<void> {
  const w = art.win;
  if (!w) return;
  const seq = ++w.seqVer;
  if (!n) {
    w.ver = null;
    artBump();
    return;
  }
  try {
    const data = await fetchArtifact(w.runId, w.key, n);
    if (art.win !== w || seq !== w.seqVer) return;
    w.ver = data;
    w.error = '';
  } catch (err) {
    if (art.win !== w || seq !== w.seqVer) return;
    w.ver = null;
    w.error = loadErrText(errLike(err), `Версия ${n} не загрузилась`);
  }
  artBump();
}

/** Событие сменило хэш или блокировку открытого артефакта. Блокировку показываем сразу, точную причину и текст — с сервера. */
function winSync() {
  const w = art.win;
  if (!w?.cur || w.saving) return;
  const it = art.items.get(w.key);
  if (!it) return;
  if (it.lockedBy.length) {
    Object.assign(w.cur, { editable: false, reason: 'writing', lockedBy: it.lockedBy, message: `Пишет этап ${it.lockedBy.join(', ')}: правка откроется после конца шага` });
  }
  artBump();
  void winLoad();
}

export function winMsg(text: string, kind: ArtWin['msgKind'] = ''): void {
  if (!art.win) return;
  art.win.msg = text;
  art.win.msgKind = kind;
  artBump();
}

/** Закрыть окно: несохранённый текст остаётся черновиком, пустую правку не храним. silent — фокус не возвращать. */
export function closeWin(silent = false): void {
  const w = art.win;
  if (!w) return;
  const d = draftOf(w.runId, w.key);
  if (d && !draftDirty(d)) art.drafts.delete(artKey(w.runId, w.key));
  art.win = null;
  art.focusBack = silent ? null : { opener: w.opener, key: w.key };
  artBump();
}

export function winEdit(): void {
  const w = art.win;
  if (!w || !winEditable(w)) return;
  startDraft(w.runId, w.key, w.title, w.cur!.text!, w.cur!.hash!, w.cur!.text!);
  w.conflict = null;
  w.msg = '';
  artBump();
}

export async function winFromVersion(askConfirm: ConfirmFn): Promise<void> {
  const w = art.win;
  if (!w?.ver || !winEditable(w)) return;
  if (draftDirty(draftOf(w.runId, w.key)) && !(await askConfirm('В редакторе уже есть несохранённая правка. Заменить её текстом этой версии?', { ok: 'Заменить' }))) return;
  startDraft(w.runId, w.key, w.title, w.ver.text!, w.cur!.hash!, w.cur!.text!);
  w.ver = null;
  w.conflict = null;
  w.msg = '';
  artBump();
}

export async function winDiscard(askConfirm: ConfirmFn): Promise<void> {
  const w = art.win;
  const d = w && draftOf(w.runId, w.key);
  if (!w || !d) return;
  if (draftDirty(d) && !(await askConfirm(`Отбросить несохранённую правку «${w.title}»? Текст пропадёт.`, { ok: 'Отбросить', danger: true }))) return;
  art.drafts.delete(artKey(w.runId, w.key));
  w.conflict = null;
  w.saveFailed = false;
  w.msg = '';
  artBump();
  void winLoad();
}

export async function winReload(askConfirm: ConfirmFn): Promise<void> {
  const w = art.win;
  if (!w) return;
  if (draftDirty(draftOf(w.runId, w.key)) && !(await askConfirm('Перечитать файл с диска? Твоя правка пропадёт: скопируй её, если нужна.', { ok: 'Перечитать' }))) return;
  art.drafts.delete(artKey(w.runId, w.key));
  w.conflict = null;
  w.msg = '';
  await winLoad();
  if (art.win === w && winEditable(w)) winEdit();
  else artBump();
}

/** Ввод в редакторе: текст черновика; перерисовка — только если сменилась «несохранённость» или сброшено сообщение. */
export function winInput(text: string): void {
  const w = art.win;
  const d = w && draftOf(w.runId, w.key);
  if (!w || !d) return;
  const was = draftDirty(d);
  d.text = text;
  let changed = was !== draftDirty(d);
  if (w.saveFailed || w.msgKind === 'ok') {
    w.msg = '';
    w.saveFailed = false;
    changed = true;
  }
  if (changed) artBump();
}

/** Пауза ввода: предупреждение «больше 1 МБ» появляется и уходит само. */
export function winSizeCheck(): void {
  const w = art.win;
  const d = w && draftOf(w.runId, w.key);
  if (!w || !d) return;
  const big = textBytes(d.text) > ART_EDIT_MAX;
  if (big !== w.msg.startsWith('Текст больше 1 МБ')) winMsg(big ? 'Текст больше 1 МБ: так не сохранится.' : '', big ? 'err' : '');
}

const authorAt = (a: { at?: string } | object): string | undefined => ('at' in a ? (a as { at?: string }).at : undefined);

/** «Сохранить», «Сохранить и возобновить», «Сохранить поверх». */
export async function winSave(opts: { resume?: boolean; force?: boolean }, ui: Ui & { askConfirm: ConfirmFn }): Promise<void> {
  const w = art.win;
  const d = w && draftOf(w.runId, w.key);
  if (!w || !d || w.saving) return;
  if (!winEditable(w)) return; // aria-disabled: причина уже в строке статуса
  if (textBytes(d.text) > ART_EDIT_MAX) return winMsg('Текст больше 1 МБ: так не сохранится, сократи его. Текст остался в редакторе.', 'err');
  if (opts.force && !(await ui.askConfirm('Сохранить поверх? Изменение файла после того, как ты его открыл, будет заменено твоим текстом; прежняя версия останется в истории.', { ok: 'Сохранить поверх', danger: true }))) return;
  const base = opts.force ? w.conflict?.hash ?? w.cur?.hash : d.base;
  const runId = w.runId;
  // ответ на паузу в поле или черновики других артефактов: эта правка сохраняется отдельно, а возобновление идёт
  // обычным путём «Возобновить» — он спросит про остальные черновики и запишет ответ по порядку
  const run = runState.id === runId ? runState.st?.run : undefined;
  const answer = run?.pauseReason ? pauseAnswerOf(answerKey(runId, run.pauseReason.at || '')).trim() : '';
  const chain = Boolean(opts.resume) && Boolean(answer || dirtyDrafts(runId).some((x) => x.key !== w.key));
  const atomic = Boolean(opts.resume) && !chain;
  w.saving = true;
  w.msg = 'Сохраняю…';
  w.msgKind = '';
  artBump();
  if (atomic) art.resumingHere.add(runId);
  try {
    const r = await saveArtifact(runId, w.key, { text: d.text, base, resume: atomic });
    art.drafts.delete(artKey(runId, w.key));
    refreshAfterSave(runId);
    if (art.win !== w) return;
    w.conflict = null;
    w.saveFailed = false;
    const at = artClock(authorAt(r.author));
    const readers = r.readers?.length ? ` Этап ${r.readers.join(', ')} уже получил прежнюю версию: правка учтётся со следующего шага.` : '';
    if (chain) {
      closeWin();
      ui.toast(`«${w.title}» сохранён в ${at}`);
      void artResume(runId, undefined, ui);
      return;
    }
    if (atomic) {
      closeWin();
      ui.toast(`«${w.title}» сохранён в ${at}, запуск возобновлён`);
      return;
    }
    w.msg = `Сохранено в ${at}.${readers}`;
    w.msgKind = 'ok';
    w.saving = false;
    await winLoad();
  } catch (err) {
    if (atomic) art.resumingHere.delete(runId);
    if (art.win !== w) return;
    const e = saveError(errLike(err));
    w.msgKind = e.kind;
    w.saveFailed = true;
    w.msg = e.msg;
    if (e.conflict) w.conflict = e.conflict;
    if (e.readonly && w.cur) Object.assign(w.cur, { editable: false, reason: e.readonly.reason, message: e.readonly.message });
    if (e.conflict) void winLoad();
  } finally {
    w.saving = false;
    artBump();
  }
}

