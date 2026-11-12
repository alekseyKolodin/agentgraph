// Общее экранов задач: данные проекта из кэша оболочки, правки задач с мгновенной перерисовкой и очередью на задачу,
// перетаскивание нативным HTML5 drag and drop (без зависимостей) и возврат фокуса на карточку после переноса.
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { TeamTask, TeamTaskPatch } from '@server/api-types';
import { ApiError, errorText } from '../../../api';
import { createTask, deleteTask, moveTask, teamKeys, updateTask, useProject, useTasks, useTeam, type NewTask } from '../../../api/teamwork';
import { useToast } from '../../../components/Toast';
import { t } from '../../../lib/i18n';
import type { Drop } from '../../../lib/teamwork/board';
import { dropRank } from '../../../lib/teamwork/task';

/** Команда, проект и задачи: те же запросы, что держит экран проекта, — без лишних обращений к серверу. */
export function useProjectData(team: string, project: string) {
  const td = useTeam(team).data;
  const p = useProject(team, project).data;
  const q = useTasks(team, project);
  return { td, p, tasks: q.data ?? [], loaded: Boolean(q.data), me: td?.me.email, members: td?.memberList ?? [], readonly: td?.sync.state === 'readonly' };
}

export type TaskOps = ReturnType<typeof useTaskOps>;

type Overlay = (x: TeamTask) => TeamTask;
/**
 * Очереди записей задач одного проекта — общие для всех экранов (бэклог, доска, панель задачи): запись из панели встаёт
 * за переносом с доски той же задачи и берёт base из его ответа. server — версия задачи с сервера, пока у неё есть
 * очередь; pending — мгновенные правки, ещё не подтверждённые сервером.
 */
type Store = { queue: Map<string, Promise<unknown>>; server: Map<string, TeamTask>; pending: Map<string, Overlay[]> };
const stores = new Map<string, Store>();
const storeOf = (team: string, project: string): Store => {
  const k = `${team}/${project}`;
  let st = stores.get(k);
  if (!st) {
    st = { queue: new Map(), server: new Map(), pending: new Map() };
    stores.set(k, st);
  }
  return st;
};
const overlay = (st: Store, x: TeamTask): TeamTask => (st.pending.get(x.id) ?? []).reduce((y, f) => f(y), x);

/** Ключ списка задач проекта: ['teams', 'one', team, 'project', project, 'tasks'] (teamKeys.tasks). */
const isTasksKey = (k: readonly unknown[]): boolean => k.length === 6 && k[0] === 'teams' && k[1] === 'one' && k[3] === 'project' && k[5] === 'tasks';

const watched = new WeakSet<QueryClient>();
/**
 * Перечитанный список задач (событие `team`, фоновый опрос) не затирает мгновенные правки, что ещё ждут очереди: после
 * каждого ответа сервера на список они ложатся сверху. Подписка одна на клиент запросов.
 */
function watchTasks(qc: QueryClient): void {
  if (watched.has(qc)) return;
  watched.add(qc);
  qc.getQueryCache().subscribe((e) => {
    if (e.type !== 'updated' || e.action.type !== 'success' || e.action.manual) return;
    const k = e.query.queryKey;
    if (!isTasksKey(k)) return;
    const st = stores.get(`${String(k[2])}/${String(k[4])}`);
    if (!st?.pending.size) return;
    qc.setQueryData<TeamTask[]>(k, (all) => all?.map((x) => overlay(st, x)));
  });
}

/**
 * Правки задач: перенос и PATCH сразу правят кэш (ранг, статус, спринт, тело), потом уходят на сервер по очереди на
 * задачу. Запрос строится по последней версии с сервера, а не по кэшу с мгновенными правками: иначе «+ критерий» лёг бы
 * дважды. Ответ сервера заменяет задачу в кэше, сверху снова ложатся ещё не отправленные правки; base — из ответа
 * предыдущего запроса, поэтому две быстрые галочки подряд не дают 409. Ошибка — всплывашка; версия с сервера остаётся
 * прежней (409 — версия команды из ответа), упавшая правка снимается с кэша, следующие строятся без неё.
 */
export function useTaskOps(team: string, project: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = teamKeys.tasks(team, project);
  const st = storeOf(team, project);
  watchTasks(qc);

  const list = () => qc.getQueryData<TeamTask[]>(key) ?? [];
  const put = (task: TeamTask) => qc.setQueryData<TeamTask[]>(key, (all) => (all ?? []).map((x) => (x.id === task.id ? task : x)));
  const local = (id: string, fn: Overlay) => qc.setQueryData<TeamTask[]>(key, (all) => (all ?? []).map((x) => (x.id === id ? fn(x) : x)));
  /**
   * После записи: строка синхронизации, счётчики команды и спринты проекта — заново, точно по ключам: префикс захватил бы
   * и список задач, а его перечитка посреди очереди дёргает карточки (событие `team` придёт тоже — его гасит watchTasks).
   */
  const touched = () => {
    void qc.invalidateQueries({ queryKey: teamKeys.team(team), exact: true });
    void qc.invalidateQueries({ queryKey: teamKeys.project(team, project), exact: true });
  };
  const failed = (err: unknown) => {
    toast(err instanceof ApiError && err.code === 'conflict' ? t('Задачу успели изменить: показана версия команды') : errorText(err));
    void qc.invalidateQueries({ queryKey: key, exact: true });
  };

  /**
   * Запись задачи в очередь: optimistic — сразу в кэш; job получает версию с сервера и отдаёт ответ сервера, поверх
   * которого в кэш снова ложатся правки, что ещё ждут очереди.
   */
  const run = (id: string, optimistic: Overlay | undefined, job: (cur: TeamTask) => Promise<TeamTask | undefined>, after?: Promise<unknown>): Promise<TeamTask | undefined> => {
    const cached = list().find((x) => x.id === id);
    if (cached && !st.server.has(id)) st.server.set(id, cached);
    if (optimistic) {
      local(id, optimistic);
      st.pending.set(id, [...(st.pending.get(id) ?? []), optimistic]);
    }
    const forget = () => {
      const left = (st.pending.get(id) ?? []).filter((f) => f !== optimistic);
      if (left.length) st.pending.set(id, left);
      else st.pending.delete(id);
    };
    const step = async () => {
      const cur = st.server.get(id) ?? list().find((x) => x.id === id);
      if (!cur) return undefined;
      try {
        const r = await job(cur);
        forget();
        if (!r) {
          put(overlay(st, cur));
          return cur;
        }
        st.server.set(id, r);
        put(overlay(st, r));
        touched();
        return r;
      } catch (err) {
        forget();
        const current = err instanceof ApiError && err.code === 'conflict' ? (err.data as { current?: TeamTask } | undefined)?.current : undefined;
        if (current) st.server.set(id, current);
        const base = st.server.get(id);
        if (base) put(overlay(st, base));
        throw err;
      }
    };
    const prev = Promise.all([st.queue.get(id), after?.catch(() => undefined)]);
    const next = prev.then(step, step).catch((err: unknown) => {
      failed(err);
      return undefined;
    });
    st.queue.set(id, next);
    void next.finally(() => {
      if (st.queue.get(id) !== next) return;
      st.queue.delete(id);
      st.server.delete(id);
      st.pending.delete(id);
    });
    return next;
  };

  /**
   * Перенос: статус, спринт и место между соседями. after — запись, после которой отправлять запрос (групповой перенос:
   * сосед следующей задачи — предыдущая, её ранг на сервере должен быть уже новым); в кэше перенос виден сразу.
   */
  const move = (id: string, drop: Drop, after?: Promise<unknown>) => {
    const { move: m } = drop;
    return run(
      id,
      (x) => {
        const next: TeamTask = { ...x, rank: dropRank(drop, x.rank) };
        if (m.status) next.status = m.status;
        if (m.sprint !== undefined) {
          if (m.sprint === null) delete next.sprint;
          else next.sprint = m.sprint;
        }
        return next;
      },
      () => moveTask(team, project, id, m),
      after,
    );
  };

  /** PATCH с base последней версии с сервера; make получает эту версию (правки тела — по свежему тексту). */
  const patch = (id: string, make: TeamTaskPatch | ((cur: TeamTask) => TeamTaskPatch | undefined), optimistic?: Overlay) =>
    run(id, optimistic, async (cur) => {
      const p = typeof make === 'function' ? make(cur) : make;
      return p ? updateTask(team, project, id, { ...p, base: cur.base }) : undefined;
    });

  const create = async (task: NewTask): Promise<TeamTask | undefined> => {
    try {
      const r = await createTask(team, project, task);
      qc.setQueryData<TeamTask[]>(key, (all) => [...(all ?? []), r]);
      touched();
      return r;
    } catch (err) {
      failed(err);
      return undefined;
    }
  };

  const remove = async (ids: readonly string[]): Promise<number> => {
    let n = 0;
    for (const id of ids) {
      try {
        await deleteTask(team, project, id);
        n++;
      } catch (err) {
        failed(err);
        break;
      }
    }
    void qc.invalidateQueries({ queryKey: key, exact: true });
    touched();
    return n;
  };

  return { move, patch, create, remove, list };
}

// ---------- перетаскивание

/** Куда бросят: список и позиция строки под курсором; after — нижняя половина строки. */
export type DropAt = { list: string; index: number; after: boolean };

export type Dnd = {
  dragging: string | undefined;
  over: DropAt | undefined;
  /** Обработчики строки или карточки: тянуть можно за всю строку. */
  item: (id: string, list: string, index: number) => {
    draggable: true;
    'data-dnd': string;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
  /** Обработчики пустого места списка: бросок в зазор между строками — по высоте курсора, ниже всех — в конец. */
  zone: (list: string, length: number) => { onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void };
  /** Класс-подсказка для строки: черта сверху или снизу. */
  mark: (list: string, index: number) => 'before' | 'after' | undefined;
};

const MIME = 'application/x-agentgraph-task';

/** Место броска в зоне списка: перед первой строкой, чья середина ниже курсора; ниже всех — length. */
function zoneIndex(zone: HTMLElement, y: number, length: number): number {
  const items = [...zone.querySelectorAll<HTMLElement>(':scope > [data-dnd]')];
  const i = items.findIndex((it) => {
    const r = it.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  return i < 0 ? length : i;
}

/** Нативный drag and drop списков задач: onDrop(id, from, to) получает место вставки в списке с переносимой задачей. */
export function useDnd(onDrop: (id: string, from: string, at: DropAt) => void): Dnd {
  const [dragging, setDragging] = useState<{ id: string; list: string }>();
  const [over, setOver] = useState<DropAt>();
  const drop = useRef(onDrop);
  drop.current = onDrop;
  const ours = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes(MIME);
  const finish = (e: DragEvent, at: DropAt) => {
    if (!ours(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData(MIME);
    setOver(undefined);
    setDragging(undefined);
    try {
      const { id, list } = JSON.parse(raw) as { id: string; list: string };
      drop.current(id, list, at);
    } catch {
      /* чужие данные */
    }
  };
  const item: Dnd['item'] = (id, list, index) => ({
    draggable: true,
    'data-dnd': id,
    onDragStart: (e) => {
      e.dataTransfer.setData(MIME, JSON.stringify({ id, list }));
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
      setDragging({ id, list });
    },
    onDragEnd: () => {
      setDragging(undefined);
      setOver(undefined);
    },
    onDragOver: (e) => {
      if (!ours(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      setOver((o) => (o && o.list === list && o.index === index && o.after === after ? o : { list, index, after }));
    },
    onDrop: (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      finish(e, { list, index, after: e.clientY > r.top + r.height / 2 });
    },
  });
  const zone: Dnd['zone'] = (list, length) => ({
    onDragOver: (e) => {
      if (!ours(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const index = zoneIndex(e.currentTarget as HTMLElement, e.clientY, length);
      setOver((o) => (o && o.list === list && o.index === index && !o.after ? o : { list, index, after: false }));
    },
    onDrop: (e) => finish(e, { list, index: zoneIndex(e.currentTarget as HTMLElement, e.clientY, length), after: false }),
    onDragLeave: (e) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOver((o) => (o?.list === list ? undefined : o));
    },
  });
  const mark: Dnd['mark'] = (list, index) => {
    if (!over || over.list !== list || !dragging) return undefined;
    if (over.index === index) return over.after ? 'after' : 'before';
    return undefined;
  };
  return { dragging: dragging?.id, over, item, zone, mark };
}

/**
 * Фокус на карточке после переноса: карточку с другой колонки React создаёт заново, фокус пропадает. focus(id) — после
 * следующей отрисовки найти [data-task="id"] в контейнере и вернуть фокус; focus(id, true) — элемент с этим id (заголовок
 * колонки, когда соседней карточки нет).
 */
export function useKeepFocus() {
  const box = useRef<HTMLElement | null>(null);
  const want = useRef<{ id: string; byId: boolean } | undefined>(undefined);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    const w = want.current;
    if (!w || !box.current) return;
    const el = w.byId ? box.current.querySelector<HTMLElement>(`#${CSS.escape(w.id)}`) : box.current.querySelector<HTMLElement>(`[data-task="${CSS.escape(w.id)}"]`);
    if (el && document.activeElement !== el) el.focus();
    want.current = undefined;
  });
  const focus = useCallback((id: string, byId = false) => {
    want.current = { id, byId };
    setSeq((n) => n + 1);
  }, []);
  return { box, focus, seq };
}
