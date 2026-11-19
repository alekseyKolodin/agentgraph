// Наблюдатель ветки (type: 'branch'): грязный checkout, впереди/позади upstream, есть ли MR по ветке.
// Ключ вещи — branch:<корень репо>#<ветка> (строкой по формату из types.ts; в реестр наблюдателей подключает things-core).
// Тратит только git и forge (glab/gh) — ни модели, ни fetch: «позади» считается по тому, что уже скачано.
import fs from 'node:fs';
import { aheadBehind, checkoutStatus, defaultBranch, exec, findBranchMr, localBranches, originUrl, parseRemote, worktreeList, type BranchMr, type Exec } from '../git.js';
import type { Thing, ThingState, Watcher } from './types.js';

export type BranchWatcherDeps = {
  exec?: Exec;
  now?: () => number;
  everyMs?: number;
};

const DEFAULT_EVERY_MS = 60_000;
const PARALLEL = 4;

/** 1 файл, 2 файла, 5 файлов. */
function plural(n: number, one: string, few: string, many: string): string {
  const m = n % 100;
  if (m >= 11 && m <= 14) return many;
  const d = n % 10;
  return d === 1 ? one : d >= 2 && d <= 4 ? few : many;
}
const files = (n: number): string => `${n} ${plural(n, 'файл', 'файла', 'файлов')}`;
const commits = (n: number): string => `${n} ${plural(n, 'коммит', 'коммита', 'коммитов')}`;

export function branchWatcher(deps: BranchWatcherDeps = {}): Watcher {
  const x = deps.exec ?? exec;
  const now = deps.now ?? Date.now;

  const refOf = (t: Thing): { root: string; branch: string } | undefined => {
    const root = typeof t.ref.root === 'string' ? t.ref.root : '';
    const branch = typeof t.ref.branch === 'string' ? t.ref.branch : '';
    return root && branch ? { root, branch } : undefined;
  };

  function watchable(t: Thing): true | string {
    if (t.type !== 'branch') return 'не ветка';
    const r = refOf(t);
    if (!r) return 'у вещи нет корня репозитория или имени ветки';
    if (!fs.existsSync(r.root)) return `папки репозитория нет на диске: ${r.root}`;
    return true;
  }

  /** С чем сравнивать, чтобы понять «есть ли в ветке своя работа»: база репозитория. */
  async function baseOf(root: string, branch: string): Promise<{ ref: string; ahead: number } | undefined> {
    const def = await defaultBranch(root, x);
    const candidates = [...new Set([def && `origin/${def}`, 'origin/main', 'origin/master', def, 'main', 'master'].filter((c): c is string => Boolean(c) && c !== branch))];
    for (const ref of candidates) {
      const ab = await aheadBehind(root, branch, ref, x);
      if (ab) return { ref, ahead: ab.ahead };
    }
    return undefined;
  }

  async function snapshot(t: Thing, root: string, branch: string): Promise<ThingState> {
    const info = (await localBranches(root, x)).find((b) => b.name === branch);
    if (!info) return gone(t, `ветки ${branch} нет в ${root}`, now());

    // грязным бывает checkout, где ветка открыта: основной или отдельный worktree; не открыта нигде — чистая
    const wt = (await worktreeList(root, x).catch(() => [])).find((w) => w.branch === branch);
    const dirty = wt ? await checkoutStatus(wt.path, x) : { total: 0, untracked: 0, conflicted: 0 };

    const upstream = info.upstream ? await aheadBehind(root, branch, info.upstream, x) : undefined;
    const base = await baseOf(root, branch);
    const aheadOfBase = base?.ahead;
    const behind = upstream?.behind ?? 0;

    const remote = parseRemote((await originUrl(root, x)) ?? '');
    // MR спрашиваем, только когда ответ что-то решает: чистая ветка со своей работой
    const needMr = !dirty.total && (aheadOfBase ?? 1) > 0;
    let mr: BranchMr | undefined;
    let mrError: string | undefined;
    if (needMr) {
      if (!remote) mrError = 'у репозитория нет origin на GitLab или GitHub';
      else {
        try {
          mr = await findBranchMr(remote, branch, x);
        } catch (err) {
          mrError = (err as Error).message;
        }
      }
    }

    // не отправлено: сверх upstream; нет upstream — всё, что сверх базы. Есть MR — ветку уже отправляли (push без -u), «сверх базы» не считаем
    const unpushed = upstream ? upstream.ahead : mr ? 0 : aheadOfBase ?? 0;
    const tail = behind > 0 ? ` · позади upstream на ${commits(behind)}` : '';
    const mrText = mr ? `MR ${mr.iid} ${mr.state === 'opened' ? 'открыт' : mr.state === 'merged' ? 'смержен' : 'закрыт'}` : '';

    let turn: ThingState['turn'] = 'none';
    let closed: ThingState['closed'];
    let why: string;
    if (dirty.total) {
      turn = 'me';
      why = `${files(dirty.total)} не закоммичено${dirty.conflicted ? `, конфликтов: ${dirty.conflicted}` : ''}`;
    } else if (unpushed > 0) {
      turn = 'me';
      why = info.upstream ? `${commits(unpushed)} не отправлено в ${info.upstream}` : `ветка не отправлена в origin: ${commits(unpushed)}`;
      if (mrText) why += ` · ${mrText}`;
    } else if (mr?.state === 'merged') {
      closed = 'merged';
      why = `${mrText}, ветка чистая`;
    } else if (mr?.state === 'opened') {
      closed = 'done';
      why = `ветка чистая, ${mrText}`;
    } else if (!needMr) {
      closed = 'done';
      why = 'ветка чистая, нового в ней нет';
    } else if (mrError) {
      why = `в ветке ${commits(aheadOfBase ?? 0)}; MR проверить не удалось: ${mrError}`;
    } else {
      turn = 'me';
      why = mr ? `${mrText} без слияния, в ветке ${commits(aheadOfBase ?? 0)}` : `в ветке ${commits(aheadOfBase ?? 0)} без MR`;
    }

    return {
      exists: true,
      closed,
      turn: closed ? 'none' : turn,
      why: why + tail,
      title: branch,
      updatedAt: info.updated || new Date(now()).toISOString(),
      facts: {
        root,
        branch,
        worktree: wt?.path ?? null,
        subject: info.subject,
        dirty: dirty.total,
        untracked: dirty.untracked,
        conflicted: dirty.conflicted,
        upstream: info.upstream ?? null,
        ahead: upstream?.ahead ?? null,
        behind: upstream?.behind ?? null,
        base: base?.ref ?? null,
        aheadOfBase: aheadOfBase ?? null,
        mr: mr ?? null,
        mrError: mrError ?? null,
      },
    };
  }

  return {
    type: 'branch',
    everyMs: deps.everyMs ?? DEFAULT_EVERY_MS,
    canWatch: watchable,
    async state(things, signal) {
      const out = new Map<string, ThingState>();
      for (let i = 0; i < things.length && !signal.aborted; i += PARALLEL) {
        await Promise.all(
          things.slice(i, i + PARALLEL).map(async (t) => {
            const w = watchable(t);
            const r = refOf(t);
            if (w !== true || !r) return void out.set(t.key, gone(t, w === true ? 'нет ветки' : w, now()));
            try {
              out.set(t.key, await snapshot(t, r.root, r.branch));
            } catch (err) {
              out.set(t.key, gone(t, `репозиторий ${r.root} не прочитался: ${(err as Error).message}`, now()));
            }
          }),
        );
      }
      return out;
    },
  };
}

function gone(t: Thing, error: string, at: number): ThingState {
  return { exists: false, turn: 'none', why: 'состояние не отслеживается', title: t.title ?? String(t.ref.branch ?? ''), updatedAt: new Date(at).toISOString(), facts: { root: t.ref.root, branch: t.ref.branch }, error };
}
