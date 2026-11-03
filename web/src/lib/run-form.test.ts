import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowSummary, TagDetail } from '@server/api-types';
import {
  appendDir, attachName, attachOverLimit, attachTypeError, attachWarn, connWarn, fileSize, recentChips, runBody, runMoreSum, sourceLabel,
  staleWorktreeCwd, TAG_SLUG_RE, tagAddedMsg, tagMissingMsg, tagOptionLabel, withWorktreeNote, worktreeProject, worktreeRequest,
} from './run-form';

const summary = (phases: { name: string; title?: string; tools: string[] }[]): FlowSummary =>
  ({ name: 'f', file: 'f.yaml', folder: '', valid: true, phases }) as FlowSummary;

test('вложения: тип, размер, лимиты, имя скриншота, размер файла', () => {
  assert.equal(attachTypeError('a.PNG', 10), undefined);
  assert.equal(attachTypeError('.png', 10), '.png: такой тип не поддерживается');
  assert.equal(attachTypeError('a.exe', 10), 'a.exe: такой тип не поддерживается');
  assert.equal(attachTypeError('a.pdf', 11 * 1024 * 1024), 'a.pdf: больше 10 МБ');
  assert.equal(attachOverLimit([{ size: 20 * 1024 * 1024 }], 'b.png', 6 * 1024 * 1024), 'b.png: вложения вместе больше 25 МБ');
  assert.equal(attachOverLimit(Array.from({ length: 10 }, () => ({ size: 1 })), 'b.png', 1), 'b.png: больше 10 файлов нельзя');
  assert.equal(attachOverLimit([], 'b.png', 1), undefined);
  assert.equal(attachName('image.png', new Date(2026, 9, 24, 9, 5, 7)), 'screenshot-090507.png');
  assert.equal(attachName('x.png'), 'x.png');
  assert.deepEqual([fileSize(900), fileSize(2048), fileSize(3 * 1024 * 1024)], ['900 Б', '2 КБ', '3.0 МБ']);
});

test('предупреждения: этапы без Read и ссылка на Jira без коннекторов', () => {
  assert.equal(attachWarn(summary([{ name: 'a', title: 'План', tools: ['Read'] }, { name: 'b', tools: [] }])), 'Этап b без Read вложений не увидит');
  assert.equal(attachWarn(summary([{ name: 'a', tools: [] }, { name: 'b', title: 'Код', tools: [] }])), 'Этапы a, Код без Read вложений не увидят');
  assert.equal(attachWarn(summary([{ name: 'a', tools: ['Read'] }])), '');
  const s = summary([{ name: 'a', tools: ['Read'] }]);
  assert.equal(connWarn('см. https://x.atlassian.net/browse/A-1', s), true);
  assert.equal(connWarn('без ссылок', s), false);
  assert.equal(connWarn('https://x.atlassian.net', summary([{ name: 'a', tools: ['mcp__claude_ai_Atlassian__getJiraIssue'] }])), false);
  assert.equal(connWarn('https://x.atlassian.net', summary([])), false);
});

test('теги знаний: слаг, подпись подсказки, сообщения', () => {
  assert.ok(TAG_SLUG_RE.test('loyalty-card') && !TAG_SLUG_RE.test('-x') && !TAG_SLUG_RE.test('Big'));
  assert.equal(tagOptionLabel({ slug: 'a', kind: 'knowledge', updatedAt: '', runs: 0, preview: 'первая\nвторая' }), 'первая');
  assert.equal(tagOptionLabel({ slug: 'a', kind: 'knowledge', title: 'QA', updatedAt: '', runs: 0, preview: 'x' }), 'QA');
  assert.equal(tagOptionLabel({ slug: 'a', kind: 'knowledge', updatedAt: '', runs: 0, preview: '' }), 'заметок ещё нет');
  const t = { kind: 'knowledge', summary: '', notes: '', attachments: [], runs: [] } as unknown as TagDetail;
  assert.equal(tagAddedMsg('k', t), 'k: тег знаний — тег пуст');
  assert.equal(tagAddedMsg('k', { ...t, dirs: ['/x'] }), 'k: тег знаний — этапы получат его знание');
  assert.match(tagMissingMsg('k'), /Тега знаний k нет: заведи его на странице «Знания»/);
});

test('папки: недавние чипы, дописать строкой без дублей, worktree прошлого запуска', () => {
  const dirs = Array.from({ length: 10 }, (_, i) => ({ path: `/p${i}`, label: `p${i}`, exists: i !== 1 }));
  assert.deepEqual(recentChips(dirs).map((d) => d.path), ['/p0', '/p2', '/p3', '/p4', '/p5', '/p6', '/p7', '/p8']);
  assert.equal(appendDir(' /a \n\n', '/b'), '/a\n/b');
  assert.equal(appendDir('/a\n/b', '/a'), '/a\n/b');
  assert.equal(staleWorktreeCwd('/wt/app/x', '/wt', null), true);
  assert.equal(staleWorktreeCwd('/wt/app/x', '/wt', { worktree: { path: '/wt/app/x' } }), false);
  assert.equal(staleWorktreeCwd('/repo', '/wt', null), false);
  assert.equal(staleWorktreeCwd('/wt/app/x', undefined, null), false);
});

test('источник и worktree: MR и PR по ключу, проект, тело запроса, заметка заменяется', () => {
  assert.equal(sourceLabel({ type: 'mr', key: 'g/app!7', title: '' }), 'MR');
  assert.equal(sourceLabel({ type: 'mr', key: 'o/app#5', title: '' }), 'PR');
  assert.equal(sourceLabel({ type: 'jira', key: 'A-1', title: '' }), 'Задача');
  assert.equal(sourceLabel({ type: 'branch', key: 'main', title: '' }), 'Ветка');
  const projects = [{ path: '/a' }, { path: '/b' }];
  assert.equal(worktreeProject(projects, null, '/b/sub'), '/b');
  assert.equal(worktreeProject(projects, { project: '/a' }, '/b'), '/a');
  assert.equal(worktreeProject(projects, null, '/c'), '/a');
  const pr = { source: { type: 'mr' as const, key: 'o/app#5', title: '' }, branch: 'feature/x', project: '/a' };
  assert.deepEqual(worktreeRequest(pr, '/a', 'feature/x'), { project: '/a', branch: 'feature/x', name: undefined, requireExisting: true });
  assert.deepEqual(worktreeRequest(pr, '/a', ' '), { project: '/a', branch: undefined, name: 'o/app#5', requireExisting: false });
  assert.deepEqual(worktreeRequest(null, '/a', 'new'), { project: '/a', branch: 'new', name: undefined, requireExisting: false });
  const first = withWorktreeNote('Задача', 'Директория проекта — новый git worktree /wt/a (ветка x).');
  assert.equal(first, 'Задача\n\nДиректория проекта — новый git worktree /wt/a (ветка x).');
  assert.equal(withWorktreeNote(first, 'Директория проекта — существующий git worktree /wt/a.'), 'Задача\n\nДиректория проекта — существующий git worktree /wt/a.');
  assert.equal(withWorktreeNote('', 'N'), 'N');
});

test('сводка «Дополнительно» и тело POST /api/runs', () => {
  const base = { space: '', tags: [], attach: 0, addDirs: '', worktree: false, maxIterations: '3', flowMaxIterations: 3, budget: '', modelLabel: '' };
  assert.deepEqual(runMoreSum(base), { text: 'пространство, знания, вложения, директории, worktree, лимиты, модель', set: false });
  assert.deepEqual(runMoreSum({ ...base, space: ' press-alert ', tags: ['a', 'b'], attach: 2, addDirs: '/x\n\n/y', worktree: true, maxIterations: '5', budget: '0.5', modelLabel: 'Haiku 4.5' }), {
    text: '◇ press-alert · #a #b · 2 файла · доп. директорий: 2 · worktree · до 5 итераций · до $0.5 · Haiku 4.5', set: true,
  });
  const can = { integrations: true, attachments: true, addDirs: true, tags: true, spaces: true };
  const body = runBody({ flow: 'f', input: 'x', cwd: '/r', maxIterations: '', maxBudgetUsd: '0.2', model: '', link: null, attach: [], addDirs: '', space: '', saveState: true, autoSpace: false, tags: [], can });
  assert.deepEqual(body, { flow: 'f', input: 'x', cwd: '/r', maxIterations: undefined, maxBudgetUsd: '0.2', model: undefined, addDirs: [] });
  const full = runBody({
    flow: 'f', spec: { name: 'd' }, input: 'x', cwd: '/r', maxIterations: '2', maxBudgetUsd: '', model: 'claude-haiku-4-5-20251001',
    link: { source: { type: 'mr', key: 'o/app#5', title: 't' }, worktree: { path: '/wt' }, branch: 'b', project: '/a' },
    attach: [{ id: 1, name: 'a.png', size: 1, data: 'QQ==' }], addDirs: '/x\n', space: ' p ', saveState: false, autoSpace: true, tags: ['t'], can,
  });
  // пространство выбрано — автопространство не уходит
  assert.deepEqual(full, {
    spec: { name: 'd' }, input: 'x', cwd: '/r', maxIterations: '2', maxBudgetUsd: undefined, model: 'claude-haiku-4-5-20251001',
    source: { type: 'mr', key: 'o/app#5', title: 't' }, worktree: { path: '/wt' }, attachments: [{ name: 'a.png', data: 'QQ==' }], addDirs: ['/x'],
    space: 'p', saveState: false, tags: ['t'],
  });
  const auto = runBody({ flow: 'f', input: 'x', cwd: '/r', maxIterations: '', maxBudgetUsd: '', model: '', link: null, attach: [], addDirs: '', space: ' ', saveState: true, autoSpace: true, tags: [], can });
  assert.equal(auto.autoSpace, true);
  assert.equal('space' in auto, false);
  // сервер без фич: полей нет
  const old = runBody({ flow: 'f', input: 'x', cwd: '/r', maxIterations: '', maxBudgetUsd: '', model: '', link: { source: { type: 'jira', key: 'A', title: '' } }, attach: [{ id: 1, name: 'a', size: 1, data: '' }], addDirs: '/x', space: 'p', saveState: true, autoSpace: true, tags: ['t'], can: { integrations: false, attachments: false, addDirs: false, tags: false, spaces: false } });
  assert.deepEqual(Object.keys(old), ['flow', 'input', 'cwd', 'maxIterations', 'maxBudgetUsd', 'model']);
});
