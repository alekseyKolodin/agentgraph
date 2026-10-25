// Релиз agentgraph: поднять версию в package.json и package-lock.json, дописать раздел в CHANGELOG.md из заголовков
// коммитов feat:/fix: с прошлого релиза (коммит «chore(release): vX.Y.Z») и закоммитить это одним коммитом.
// Публикация и тег v<версия> — отдельным шагом: npm run share -- --push (или /agentgraph-ship).
//
//   npm run release -- minor              -> 0.1.0 → 0.2.0
//   npm run release -- patch --dry-run    -> только показать раздел changelog, ничего не менять
//   npm run release -- minor --from <ref> -> коммиты после <ref>, а не после прошлого релиза (первый релиз)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BUMPS, RELEASE_SUBJECT, RELEASE_SUBJECT_RE, bumpVersion, changelogSection, prependSection, type Bump } from '../src/release.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'dry-run': { type: 'boolean', default: false }, from: { type: 'string' } },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const git = (...a: string[]) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trimEnd();

const bump = positionals[0] as Bump;
if (positionals.length !== 1 || !BUMPS.includes(bump)) fail(`Использование: npm run release -- <${BUMPS.join('|')}> [--dry-run] [--from <ref>]`);

const dry = args['dry-run'];
if (!dry && git('status', '--porcelain')) fail('Есть незакоммиченные изменения: релиз делается из чистого дерева.');

// Прошлый релиз — последний коммит «chore(release): vX.Y.Z» в истории HEAD.
const last = args.from ?? git('log', '-1', '--format=%H', '-E', `--grep=${RELEASE_SUBJECT_RE.source}`);
if (!last) fail('Прошлого релиза в истории нет: укажи начало первым релизом, --from <ref>.');
const subjects = git('log', '--no-merges', '--format=%s', `${last}..HEAD`).split('\n').filter(Boolean);

const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;
const next = bumpVersion(current, bump);
const section = changelogSection(next, new Date().toISOString().slice(0, 10), subjects);
if (!section) fail(`С ${last.slice(0, 7)} нет коммитов feat:/fix: — выпускать нечего.`);

console.log(`${current} → ${next}, коммитов с ${git('rev-parse', '--short', last)}: ${subjects.length}\n\n${section}`);
if (dry) process.exit(0);

execFileSync('npm', ['version', next, '--no-git-tag-version'], { cwd: ROOT, stdio: 'ignore' });
const before = fs.existsSync(CHANGELOG) ? fs.readFileSync(CHANGELOG, 'utf8') : '';
fs.writeFileSync(CHANGELOG, prependSection(before, section));
git('add', 'package.json', 'package-lock.json', 'CHANGELOG.md');
git('commit', '-q', '-m', RELEASE_SUBJECT(next));

console.log(`Закоммичено: ${RELEASE_SUBJECT(next)}`);
console.log('CHANGELOG.md уходит в публичный origin: проверь пункты (поправить — git commit --amend), затем npm run share -- --push.');
