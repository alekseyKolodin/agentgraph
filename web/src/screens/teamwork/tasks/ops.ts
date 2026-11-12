// Общее экранов задач: данные проекта из кэша оболочки, правки задач с мгновенной перерисовкой и очередью на задачу,
// перетаскивание нативным HTML5 drag and drop (без зависимостей) и возврат фокуса на карточку после переноса.
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamTask, TeamTaskPatch } from '@server/api-types';
import { ApiError, errorText } from '../../../api';
import { createTask, deleteTask, moveTask, teamKeys, updateTask, useProject, useTasks, useTeam, type NewTask } from '../../../api/teamwork';
import { useToast } from '../../../components/Toast';
import { t } from '../../../lib/i18n';
import type { Drop } from '../../../lib/teamwork/board';

/** Команда, проект и задачи: те же запросы, что держит экран проекта, — без лишних обращений к серверу. */
export function useProjectData(team: string, project: string) {
  const td = useTeam(team).data;
  const p = useProject(team, project).data;
  const q = useTasks(team, project);
  return { td, p, tasks: q.data ?? [], loaded: Boolean(q.data), me: td?.me.email, members: td?.memberList ?? [], readonly: td?.sync.state === 'readonly' };
}

export type TaskOps = ReturnType<typeof useTaskOps>;

/**
 * Правки задач: перенос и PATCH сразу правят кэш (ранг, статус, спринт, тело), потом уходят на сервер по очереди на
 * задачу. Запрос строится по последней версии с сервера, а не по кэшу с мгновенными правками: иначе «+ критерий» лёг бы
 * дважды. Ответ сервера заменяет задачу в кэше, сверху снова ложатся ещё не отправленные правки; base — из ответа
 * предыдущего запроса, поэтому две быстрые галочки подряд не дают 409. Ошибка — всплывашка и перечитка.
 */
export function useTaskOps(team: string, project: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = teamKeys.tasks(team, project);
  const queue = useRef(new Map<string, Promise<unknown>>());
  /** Версия задачи с сервера, пока у неё есть очередь записей. */
  const server = useRef(new Map<string, TeamTask>());
  /** Мгновенные правки, ещё не подтверждённые сервером, по задаче. */
  const pending = useRef(new Map<string, ((x: TeamTask) => TeamTask)[]>());

  const list = () => qc.getQueryData<TeamTask[]>(key) ?? [];
  const put = (task: TeamTask) => qc.setQueryData<TeamTask[]>(key, (all) => (all ?? []).map((x) => (x.id === task.id ? task : x)));
  const local = (id: string, fn: (x: TeamTask) => TeamTask) => qc.setQueryData<TeamTask[]>(key, (all) => (all ?? []).map((x) => (x.id === id ? fn(x) : x)));
  /** После записи: строка синхронизации, счётчики вкладок и обзор — заново (событие `team` придёт тоже). */
  const touched = () => {
    void qc.invalidateQueries({ queryKey: teamKeys.team(team) });
    void qc.invalidateQueries({ queryKey: teamKeys.project(team, project) });
  };
  const failed = (err: unknown) => {
    toast(err instanceof ApiError && err.code === 'conflict' ? t('Задачу успели изменить: показана версия команды') : errorText(err));
    if (err instanceof ApiError && err.code === 'conflict') {
      const cur = (err.data as { current?: TeamTask } | undefined)?.current;
      if (cur) put(cur);
    }
    void qc.invalidateQueries({ queryKey: key });
  };

  /**
   * Запись задачи в очередь: optimistic — сразу в кэш; job получает версию с сервера и отдаёт ответ сервера, поверх
   * которого в кэш снова ложатся правки, что ещё ждут очереди.
   */
  const run = (id: string, optimistic: ((x: TeamTask) => TeamTask) | undefined, job: (cur: TeamTask) => Promise<TeamTask | undefined>): Promise<TeamTask | undefined> => {
    const cached = list().find((x) => x.id === id);
    if (cached && !server.current.has(id)) server.current.set(id, cached);
    const mine = pending.current.get(id) ?? [];
    if (optimistic) {
      local(id, optimistic);
      mine.push(optimistic);
      pending.current.set(id, mine);
    }
    const forget = () => {
      const left = (pending.current.get(id) ?? []).filter((f) => f !== optimistic);
      pending.current.set(id, left);
      return left;
    };
    const step = async () => {
      const cur = server.current.get(id) ?? list().find((x) => x.id === id);
      if (!cur) return undefined;
      try {
        const r = await job(cur);
        if (!r) {
          forget();
          return cur;
        }
        server.current.set(id, r);
        put(forget().reduce((x, f) => f(x), r));
        touched();
        return r;
      } catch (err) {
        forget();
        server.current.delete(id);
        throw err;
      }
    };
    const prev = queue.current.get(id) ?? Promise.resolve();
    const next = prev.then(step, step).catch((err: unknown) => {
      failed(err);
      return undefined;
    });
    queue.current.set(id, next);
    void next.finally(() => {
      if (queue.current.get(id) !== next) return;
      queue.current.delete(id);
      server.current.delete(id);
      pending.current.delete(id);
    });
    return next;
  };

  /** Перенос: статус, спринт и место между соседями. */
  const move = (id: string, drop: Drop) => {
    const { move: m, rank } = drop;
    return run(
      id,
      (x) => {
        const next: TeamTask = { ...x, rank };
        if (m.status) next.status = m.status;
        if (m.sprint !== undefined) {
          if (m.sprint === null) delete next.sprint;
          else next.sprint = m.sprint;
        }
        return next;
      },
      () => moveTask(team, project, id, m),
    );
  };

  /** PATCH с base последней версии с сервера; make получает эту версию (правки тела — по свежему тексту). */
  const patch = (id: string, make: TeamTaskPatch | ((cur: TeamTask) => TeamTaskPatch | undefined), optimistic?: (x: TeamTask) => TeamTask) =>
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
    void qc.invalidateQueries({ queryKey: key });
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
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
  /** Обработчики пустого места списка: бросок туда — в конец. */
  zone: (list: string, length: number) => { onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void };
  /** Класс-подсказка для строки: черта сверху или снизу. */
  mark: (list: string, index: number) => 'before' | 'after' | undefined;
};

const MIME = 'application/x-agentgraph-task';

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
      setOver((o) => (o && o.list === list && o.index === length ? o : { list, index: length, after: false }));
    },
    onDrop: (e) => finish(e, { list, index: length, after: false }),
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
 * следующей отрисовки найти [data-task="id"] в контейнере и вернуть фокус.
 */
export function useKeepFocus() {
  const box = useRef<HTMLElement | null>(null);
  const want = useRef<string | undefined>(undefined);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    const id = want.current;
    if (!id || !box.current) return;
    const el = box.current.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"]`);
    if (el && document.activeElement !== el) el.focus();
    want.current = undefined;
  });
  const focus = useCallback((id: string) => {
    want.current = id;
    setSeq((n) => n + 1);
  }, []);
  return { box, focus, seq };
}
