// Релиз: новая версия по semver и раздел CHANGELOG.md из заголовков коммитов feat:/fix: с прошлого релиза.
// Чистые функции; git, npm version и запись файлов — в scripts/release.mts.

export type Bump = 'major' | 'minor' | 'patch';
export const BUMPS: readonly Bump[] = ['major', 'minor', 'patch'];

/** Коммит релиза: по этому заголовку scripts/release.mts находит прошлый релиз. */
export const RELEASE_SUBJECT = (version: string) => `chore(release): v${version}`;
/** Источник уходит и в `git log -E --grep`: только POSIX ERE, без `\d`. */
export const RELEASE_SUBJECT_RE = /^chore\(release\): v[0-9]+\.[0-9]+\.[0-9]+$/;

export const CHANGELOG_HEADER =
  '# Changelog\n\nВерсии agentgraph. Раздел пишет `npm run release`, тег `v<версия>` ставит `npm run share -- --push`.\n';

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function bumpVersion(version: string, bump: Bump): string {
  const m = SEMVER_RE.exec(version);
  if (!m) throw new Error(`версия не в формате X.Y.Z: ${version}`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const GROUPS = [
  { type: 'feat', title: 'Новое' },
  { type: 'fix', title: 'Исправления' },
] as const;

const COMMIT_RE = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/;

/** Пункты по группам: feat → «Новое», fix → «Исправления»; остальные типы и коммиты без типа в changelog не идут. */
export function groupCommits(subjects: string[]): { title: string; items: string[] }[] {
  return GROUPS.map(({ type, title }) => ({
    title,
    items: subjects.flatMap((s) => {
      const m = COMMIT_RE.exec(s.trim());
      if (!m || m[1] !== type) return [];
      return [m[2] ? `${m[2]}: ${m[3]}` : m[3]];
    }),
  })).filter((g) => g.items.length > 0);
}

export function changelogSection(version: string, date: string, subjects: string[]): string | null {
  const groups = groupCommits(subjects);
  if (groups.length === 0) return null;
  const body = groups.map((g) => `### ${g.title}\n\n${g.items.map((i) => `- ${i}`).join('\n')}\n`).join('\n');
  return `## ${version} — ${date}\n\n${body}`;
}

/** Новый раздел — над прошлыми релизами, под шапкой; пустой файл получает шапку. */
export function prependSection(changelog: string, section: string): string {
  const text = changelog.trim() ? changelog : CHANGELOG_HEADER;
  const at = text.search(/^## /m);
  if (at < 0) return `${text.trimEnd()}\n\n${section}`;
  return `${text.slice(0, at)}${section}\n${text.slice(at)}`;
}
