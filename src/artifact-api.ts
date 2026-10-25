// HTTP API артефактов запуска без HTTP: обработчики получают запуск глазами сервера (ArtifactRun) и возвращают
// код ответа и тело. server.ts только собирает ArtifactRun и отправляет ответ; логика и коды ошибок — здесь.
// Ошибки: тело { error, code, ... } — error читают UI и хелпер скилла, code — машинная причина.
import { artifactEditability, artifactTasks, isArtifactKey, type Editability } from './artifacts.js';
import { ANSWER_MAX, type ArtifactStore } from './artifact-store.js';
import type { ArtifactList, ArtifactRead, ArtifactSaved } from './api-types.js';

export type ApiReply = { status: number; body: Record<string, unknown> };

/** Запуск глазами API артефактов. Собирает server.ts: у живого — из LiveRun, у неживого — из run.json. */
export type ArtifactRun = {
  /** Статус глазами сервера: у оборвавшегося запуска interrupted, а не running. */
  status: string;
  /** Идёт в этом сервере: живое хранилище, блокировка, пауза. */
  live: boolean;
  /** Идёт из CLI: running в run.json, процесс жив. */
  cliAlive: boolean;
  /** canContinue для неживого запуска. */
  continuable: boolean;
  continueReason?: string;
  /** Этапы, чьи вопросы ждут ответа. */
  pendingQuestion: string[];
  pause: 'requested' | 'paused' | null;
  /** Хранилище для чтения: у живого — его хранилище, у неживого — open(readonly), без записи run.json. */
  view: ArtifactStore;
  /** Хранилище для записи: у живого — то же, у неживого — open() на этот запрос (сверка с диском, сохранение run.json). */
  writable: () => ArtifactStore;
  /** Снять паузу живого запуска. */
  resume?: () => void;
};

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): ApiReply => ({ status, body: { error, code, ...extra } });

const unknownKey = (run: ArtifactRun, key: string): ApiReply =>
  fail(404, 'unknown_key', `Нет артефакта ${key}. Артефакты запуска: ${run.view.list().map((a) => a.key).join(', ') || 'нет'}`);

/** Ключ из адреса: только объявленный ключ; путь (../run.json, %2F) и ключи вроде constructor — неизвестный ключ. */
function knownKey(run: ArtifactRun, raw: string): string | undefined {
  return isArtifactKey(raw) && run.view.list().some((a) => a.key === raw) ? raw : undefined;
}

/** Можно ли править артефакт сейчас и почему: одно правило для списка, чтения и записи. */
export function editabilityOf(run: ArtifactRun, key: string): Editability {
  const info = run.view.fileInfo(key);
  return artifactEditability(
    { status: run.status },
    {
      live: run.live,
      lockedBy: run.view.lockedBy(key),
      pendingQuestion: run.pendingQuestion,
      cliAlive: run.cliAlive,
      continuable: run.continuable,
      continueReason: run.continueReason,
      size: info?.size ?? 0,
      path: info?.path,
    },
  );
}

/** GET /api/runs/:id/artifacts — список без чтения файлов: метаданные из отчёта, наличие и размер через lstat, пункты чек-листа — из метаданных. */
export function listArtifacts(run: ArtifactRun): ApiReply {
  const items = run.view.list().map((a) => {
    const info = run.view.fileInfo(a.key);
    return { ...a, path: info?.path, ...(info && !info.present ? { missing: true } : {}), ...editabilityOf(run, a.key) };
  });
  return {
    status: 200,
    body: { items, ...run.view.runInfo(), live: run.live, continuable: run.continuable, ...(run.continueReason ? { continueReason: run.continueReason } : {}) } satisfies ArtifactList,
  };
}

/**
 * GET /api/runs/:id/artifacts/:key[?version=N] — текст, хэш (база для записи), метаданные, версии и можно ли править.
 * Файл больше 8 МБ и версия без копии — text: null с причиной. unrecorded — файл изменён после последней записанной версии.
 */
export function readArtifact(run: ArtifactRun, rawKey: string, version?: string | null): ApiReply {
  const key = knownKey(run, rawKey);
  if (!key) return unknownKey(run, rawKey);
  const lite = run.view.list().find((a) => a.key === key)!;
  const info = run.view.fileInfo(key)!;
  const meta = {
    key,
    title: lite.title,
    file: lite.file,
    path: info.path,
    versions: run.view.versionsOf(key) ?? [],
    lockedBy: lite.lockedBy,
    ...(lite.decisions ? { decisions: true } : {}),
    ...(lite.fromRun ? { fromRun: lite.fromRun } : {}),
    ...editabilityOf(run, key),
  };
  if (version !== undefined && version !== null) {
    const n = Number(version);
    if (!Number.isInteger(n) || n < 1) return fail(400, 'bad_request', `Номер версии — целое число от 1: ${version}`);
    const v = run.view.readVersion(key, n);
    if (!v.ok) return fail(404, v.code, v.message);
    const head = { ...meta, version: { n: v.n, at: v.at, author: v.author, size: v.size, stored: v.stored } };
    if (!v.stored) return { status: 200, body: { ...head, text: null, textMessage: 'Копия не сохранена: файл больше 1 МБ или история запуска больше 200 МБ' } satisfies ArtifactRead };
    return { status: 200, body: { ...head, text: v.text } satisfies ArtifactRead };
  }
  const r = run.view.read(key);
  if (!r.ok && r.code === 'too_big') {
    return { status: 200, body: { ...meta, text: null, textMessage: r.message, size: info.size, author: lite.author, ...(lite.at ? { at: lite.at } : {}) } satisfies ArtifactRead };
  }
  if (!r.ok) return fail(404, r.code, r.message, { path: info.path });
  // пункты чек-листа текущей версии: из метаданных, а у изменённого после записи файла — по его тексту
  const tasks = r.hash !== lite.hash ? artifactTasks(lite.file, r.text) : lite.tasks;
  return {
    status: 200,
    body: {
      ...meta,
      text: r.text,
      hash: r.hash,
      size: r.size,
      mtimeMs: r.mtimeMs,
      author: lite.author,
      ...(lite.at ? { at: lite.at } : {}),
      ...(r.hash !== lite.hash ? { unrecorded: true } : {}),
      ...(tasks ? { tasks } : {}),
    } satisfies ArtifactRead,
  };
}

/**
 * PUT /api/runs/:id/artifacts/:key { text, base, resume?, via? } — запись пользователем.
 * 200 { hash, author, readers, resumed }; 400 bad_request; 404 unknown_key/missing; 409 not_paused (resume не на паузе, до записи)
 * или conflict (+ hash, author, at); 423 locked (+ phases); 403 readonly (+ reason); 413 too_big.
 */
export function writeArtifact(run: ArtifactRun, rawKey: string, body: Record<string, unknown>): ApiReply {
  const key = knownKey(run, rawKey);
  if (!key) return unknownKey(run, rawKey);
  if (typeof body.text !== 'string' || typeof body.base !== 'string') return fail(400, 'bad_request', 'Нужны поля text и base (хэш версии, которую правили)');
  if (body.resume !== undefined && typeof body.resume !== 'boolean') return fail(400, 'bad_request', 'Поле resume — true или false');
  const via = body.via === 'skill' ? 'skill' : 'ui';
  if (body.resume && !(run.live && run.pause === 'paused')) {
    return fail(409, 'not_paused', 'Запуск не на паузе: «Сохранить и возобновить» недоступно, ничего не записано');
  }
  const e = editabilityOf(run, key);
  if (!e.editable) {
    if (e.reason === 'writing' || e.reason === 'asking') return fail(423, 'locked', e.message ?? 'Артефакт сейчас пишет этап', { reason: e.reason, phases: e.phases ?? [] });
    return fail(403, 'readonly', e.message ?? 'Артефакт сейчас не правится', { reason: e.reason });
  }
  const r = run.writable().userWrite(key, body.text, body.base, via);
  if (!r.ok) {
    switch (r.code) {
      case 'conflict':
        return fail(409, 'conflict', r.message, { hash: r.hash, author: r.author, ...(r.at ? { at: r.at } : {}) });
      case 'locked':
        return fail(423, 'locked', r.message, { reason: 'writing', phases: r.phases });
      case 'too_big':
        return fail(413, 'too_big', r.message);
      default:
        return fail(404, r.code, r.message);
    }
  }
  if (body.resume) run.resume?.();
  return { status: 200, body: { ok: true, hash: r.hash, author: r.author, readers: r.readers, resumed: Boolean(body.resume) } satisfies ArtifactSaved };
}

/**
 * Ответ на паузу по просьбе агента (POST /api/runs/:id/resume с непустым answer) у живого запуска; run — его артефакты
 * (нет у flow без артефактов). Запись в артефакт decisions
 * и в report.pauses[].answer, затем возобновление. Ошибка записи — пауза остаётся, ответ не потерян (он у клиента).
 * 409 not_paused, 400 no_decisions/bad_request, 413 too_big, 423 locked, 404 missing.
 */
export function answerPause(pause: ArtifactRun['pause'], run: ArtifactRun | undefined, answer: string, via: 'ui' | 'skill'): ApiReply {
  if (pause !== 'paused') return fail(409, 'not_paused', 'Запуск не на паузе: ответ не записан');
  if (!run || !run.view.hasDecisions()) return fail(400, 'no_decisions', 'Во flow нет артефакта с decisions: true — ответ некуда записать. Возобнови без ответа');
  if (Buffer.byteLength(answer) > ANSWER_MAX) return fail(413, 'too_big', 'Ответ больше 64 КБ');
  const r = run.writable().appendAnswer(answer, via);
  if (!r.ok) {
    const status = { no_decisions: 400, empty: 400, not_paused: 409, too_big: 413, locked: 423, missing: 404 }[r.code];
    return fail(status, r.code, r.message);
  }
  run.resume?.();
  return { status: 200, body: { ok: true, answered: true, hash: r.hash } };
}

/**
 * Поля карточки идущего запуска на главной (/api/home) для ответа на паузу: pauseReason — пауза по просьбе агента
 * (этап, итерация, время — по нему UI находит недописанный ответ), decisions — во flow есть артефакт решений.
 * Без паузы агента и без decisions полей нет: карточка прежняя.
 */
export function homePauseFields(
  pause: ArtifactRun['pause'],
  reason: { phase: string; iteration: number; at?: string } | undefined,
  hasDecisions: boolean,
): { pauseReason?: { phase: string; iteration: number; at?: string }; decisions?: true } {
  return {
    ...(pause && reason ? { pauseReason: { phase: reason.phase, iteration: reason.iteration, ...(reason.at ? { at: reason.at } : {}) } } : {}),
    ...(hasDecisions ? { decisions: true as const } : {}),
  };
}
