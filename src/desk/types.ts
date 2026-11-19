// Дела — состояние настоящей вещи (MR, задача, ветка, тред, своё) на личной доске.
// Спецификация: docs/desk/SPEC.md, раздел 3.2 и этап 3; план — docs/desk/plan-3.md.
// Только типы — файл читает и веб. Контракт этапа 3: менять только дописывая поля.

import type { ThingType } from '../things/types.js';
import type { CheckResult } from '../routines/types.js';

export type DeskColumn = 'new' | 'plan' | 'work' | 'waiting' | 'done';

/** Кто подвинул дело последним. Перенос руками ('me') держится до следующего изменения вещи. */
export type DeskBy = 'me' | 'watcher' | 'routine' | 'flow' | 'session';

/** Один сигнал о деле: сообщение в Slack, назначение в GitLab, пункт встречи, вызов из сессии. */
export type DeskSignal = {
  /** Слаг источника рутины, 'session', 'flow', 'cli', 'watcher'. */
  source: string;
  link?: string;
  author?: string;
  at: string;
  text?: string;
  /** Куда отвечать (тред Slack и т.п.) — как в событии рутины. */
  replyTo?: Record<string, unknown>;
  /** Рутина, которая завела сигнал. */
  routine?: string;
};

export type DeskLinks = {
  /** Запуски по делу (начаты с карточки, рутина): их конец пишет итог в why. */
  runs: string[];
  sessions: string[];
  branch?: string;
  mr?: string;
  /**
   * Запуски, которые завели или дополнили дело инструментом desk_put (src/desk/tools.ts). Не запуски по делу: их конец
   * why не трогает. Хранилище дописывает их, как runs.
   */
  mentionedBy?: string[];
};

/** Кто завёл дело: запуск flow (инструментом desk_put), сессия, рутина. У дел, заведённых руками, поля нет. */
export type DeskCreatedBy = { run?: string; session?: string; routine?: string };

export type DeskItem = {
  id: string;
  /** Ключ вещи (src/things/keys.ts); у своих дел — own:<id>. */
  key: string;
  thing?: { type: ThingType; ref: Record<string, unknown>; url?: string };
  /** Свободный текст: «Ревью», «Jira», «Встреча», «Забытое», «Своё». */
  kind: string;
  title: string;
  /** Слаг пространства (projectOfPath). */
  project?: string;
  column: DeskColumn;
  /** Почему сейчас такой ход — одна строка для карточки. */
  why: string;
  signals: DeskSignal[];
  due?: string;
  links: DeskLinks;
  createdAt: string;
  /** Возраст в колонке. */
  movedAt: string;
  movedBy: DeskBy;
  closed?: { at: string; reason: string };
  /** Кто завёл: запуск flow закрывает и правит только дела, заведённые им самим (или его цепочкой). */
  createdBy?: DeskCreatedBy;
  /** Последний ход по вещи от наблюдателя: правила срабатывают только на его изменение. */
  turn?: 'me' | 'others' | 'none';
  /** Отпечаток последнего применённого состояния вещи (closed + turn + updatedAt), чтобы правило сработало один раз. */
  seen?: string;
  /**
   * Правило закрытия (task.close рутины): 'thing' или нет — сверка закрывает, когда вещь закрыта; 'never' — только руками;
   * иная строка — условие словами (на этапе 3 сверка его не исполняет — как 'never').
   */
  close?: string;
  /**
   * Запуски, начатые по делу (рутиной или с карточки): их конец пишет итог в why. Ссылка от flow или сессии
   * (desk_put) — только ссылка, итог чужого запуска дело не трогает.
   */
  started?: string[];
};

/**
 * Что можно передать в put. Нет дела с key — заводится (title обязателен по смыслу, иначе берётся из вещи/ключа);
 * есть — сигнал дописывается и применяются правила движения (SPEC 3.2).
 */
export type DeskPatch = {
  kind?: string;
  title?: string;
  project?: string;
  /** Куда класть новое (по умолчанию 'new'); существующее дело руками не двигает — для этого move. */
  column?: DeskColumn;
  why?: string;
  signal?: DeskSignal;
  due?: string;
  thing?: DeskItem['thing'];
  links?: Partial<DeskLinks>;
  /** Пришло новое по тому же: 'plan' — из «Ждёт других»/«Готово» в «В плане» (по умолчанию), 'keep' — колонка та же. */
  onRepeat?: 'plan' | 'keep';
  /** Правило закрытия дела (DeskItem.close); у существующего дела переданное перезаписывает. */
  close?: string;
  /** Кто завёл — только новому делу; у существующего не меняется. */
  createdBy?: DeskCreatedBy;
};

export type DeskFilter = { column?: DeskColumn | DeskColumn[]; project?: string; kind?: string; key?: string; open?: boolean };

/** Операции хранилища (src/desk/index.ts). Остальные модули зависят только от этого интерфейса. */
export interface DeskApi {
  put(key: string, patch: DeskPatch, by: DeskBy): Promise<DeskItem>;
  close(key: string, reason: string, by: DeskBy): Promise<DeskItem | undefined>;
  /** Перенос руками или с карточки (начат запуск/сессия → 'work'). */
  move(key: string, column: DeskColumn, by: DeskBy, why?: string): Promise<DeskItem | undefined>;
  list(filter?: DeskFilter): Promise<DeskItem[]>;
  get(key: string): Promise<DeskItem | undefined>;
}

/** Строка журнала движений desk/log.jsonl. */
export type DeskMove = { at: string; key: string; from?: DeskColumn; to: DeskColumn; by: DeskBy; why?: string };

/**
 * HTTP (src/server.ts → src/desk/routes.ts):
 *   GET  /api/desk?column=&project=&open=1  → { items: DeskItem[]; check: CheckResult }
 *   POST /api/desk/put   { key, patch }     → DeskItem         (by: 'me')
 *   POST /api/desk/move  { key, column }    → DeskItem
 *   POST /api/desk/close { key, reason }    → DeskItem
 * Изменения доски приходят в общий поток событий как { type: 'desk' }.
 */
export type DeskChange = { type: 'desk'; runId: ''; flow: '' };

/** GET /api/desk: дела по фильтру и итог последней сверки (нет — сверки ещё не было). */
export type DeskListReply = { items: DeskItem[]; check?: CheckResult };
