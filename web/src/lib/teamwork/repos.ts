// Репо кода проекта из моих папок (spec §5.3): строки формы «Репо кода» — выбранная папка (ссылка и ветка из git, папка
// остаётся только у меня) или ссылка, введённая руками; что из них уходит в create/update проекта; подсказка git clone для
// репо, которого нет на этом компьютере. Без React и DOM.
import type { TeamRepoInfo } from '@server/api-types';

/** Ключ репо, как его проверяет сервер (KEY_RE в src/teamwork-server.ts). */
export const REPO_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;

/** Строка «Репо кода» в форме. */
export type RepoDraft = {
  id: number;
  key: string;
  url: string;
  defaultBranch?: string;
  /** Моя папка этого репо: уходит в repos[].local и хранится только в local.json, в project.yaml не попадает. */
  local?: string;
  /** Ссылка вводится руками («Ввести ссылку»), а не взята из origin папки. */
  typed: boolean;
};

/** Репо в теле create/update проекта. */
export type RepoBody = { key: string; url: string; defaultBranch?: string; local?: string };

/** Состояние строки: ready — уйдёт в запрос; empty — пустая ручная строка, пропускается; остальное держит кнопку. */
export type DraftState = 'ready' | 'empty' | 'no_url' | 'no_key' | 'bad_key' | 'dup_key' | 'dup_url';

let seq = 0;
const nextId = () => ++seq;

/** Ключ, которого ещё нет: billing → billing-2 → billing-3. */
export function freeKey(key: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((k) => k.toLowerCase()));
  if (!used.has(key.toLowerCase())) return key;
  for (let n = 2; ; n++) {
    const k = `${key.slice(0, 38)}-${n}`;
    if (!used.has(k.toLowerCase())) return k;
  }
}

/**
 * Строка из выбранной папки. С origin — готовая (ссылка из git); без origin или с негодным origin — ручная строка с этой
 * папкой: репо не добавится, пока не введут ссылку.
 */
export function draftFromInfo(info: TeamRepoInfo, takenKeys: Iterable<string>): RepoDraft {
  const typed = !info.url || info.problem !== undefined;
  return {
    id: nextId(),
    key: freeKey(info.key, takenKeys),
    url: typed ? '' : info.url!,
    ...(info.defaultBranch ? { defaultBranch: info.defaultBranch } : {}),
    local: info.path,
    typed,
  };
}

/** Пустая ручная строка «Ввести ссылку». */
export function typedDraft(): RepoDraft {
  return { id: nextId(), key: '', url: '', typed: true };
}

/** Что со строкой среди всех строк формы и уже сохранённых репо проекта (existing — их ключи и ссылки). */
export function draftState(d: RepoDraft, all: readonly RepoDraft[], existing: readonly { key: string; url: string }[] = []): DraftState {
  const key = d.key.trim();
  const url = d.url.trim();
  if (!key && !url && d.typed && !d.local) return 'empty';
  if (!url) return 'no_url';
  if (!key) return 'no_key';
  if (!REPO_KEY_RE.test(key)) return 'bad_key';
  const others = [...existing, ...all.filter((x) => x.id !== d.id && !(x.typed && !x.key.trim() && !x.url.trim() && !x.local))];
  if (others.some((x) => x.key.trim().toLowerCase() === key.toLowerCase())) return 'dup_key';
  if (others.some((x) => x.url.trim() === url)) return 'dup_url';
  return 'ready';
}

/** Репо для запроса: готовые строки, пустые пропускаются; хоть одна недоделанная — undefined (кнопка выключена). */
export function reposBody(drafts: readonly RepoDraft[], existing: readonly { key: string; url: string }[] = []): RepoBody[] | undefined {
  const out: RepoBody[] = [];
  for (const d of drafts) {
    const st = draftState(d, drafts, existing);
    if (st === 'empty') continue;
    if (st !== 'ready') return undefined;
    out.push({ key: d.key.trim(), url: d.url.trim(), ...(d.defaultBranch ? { defaultBranch: d.defaultBranch } : {}), ...(d.local ? { local: d.local } : {}) });
  }
  return out;
}

/** Команда для репо, которого нет на этом компьютере: склонировать самому (agentgraph не клонирует). */
export function cloneCommand(url: string): string {
  return `git clone ${/^[\w@%+=:,./~-]+$/.test(url) ? url : `'${url.replace(/'/g, `'\\''`)}'`}`;
}
