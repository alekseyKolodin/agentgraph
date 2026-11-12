import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TeamTaskIntake } from '@server/api-types';
import { boardColumns } from './board';
import { task } from './fixtures';
import {
  addCriterion, columnMoves, criteriaOf, dropRank, criteriaTitle, defaultWorkFlow, descriptionOf, dropIndex, editCriterion, listMoves, myFlowInput, needsRepo, parseWorkFlow,
  removeCriterion, samePlace, sideMove, taskRepo, toggleCriterion, withDescription, workFlowKey, workRunBody, workSessionBody,
} from './task';

const BODY = `## Описание

Бухгалтер выбирает период и получает CSV.

## Критерии приёмки

- [x] CSV в UTF-8 с BOM
- [ ] Пустой период — только заголовок
`;

test('тело задачи: критерии из раздела «Критерии приёмки», описание без него и без строки «## Описание»', () => {
  assert.deepEqual(criteriaOf(BODY), [{ text: 'CSV в UTF-8 с BOM', done: true }, { text: 'Пустой период — только заголовок', done: false }]);
  assert.equal(descriptionOf(BODY), 'Бухгалтер выбирает период и получает CSV.');
  assert.equal(criteriaTitle(criteriaOf(BODY)), 'Критерии приёмки · 1 из 2');
  // без раздела критерии — галочки во всём теле, как считает сервер
  assert.deepEqual(criteriaOf('Текст\n- [ ] один\n'), [{ text: 'один', done: false }]);
  // галочки внутри ограды кода — не критерии
  assert.deepEqual(criteriaOf('## Критерии приёмки\n\n```\n- [ ] не он\n```\n- [ ] он\n'), [{ text: 'он', done: false }]);
});

test('тело задачи: галочка, правка и удаление критерия меняют только свою строку', () => {
  const on = toggleCriterion(BODY, 1, true);
  assert.deepEqual(criteriaOf(on).map((c) => c.done), [true, true]);
  assert.equal(descriptionOf(on), descriptionOf(BODY));
  assert.deepEqual(criteriaOf(toggleCriterion(BODY, 0, false)).map((c) => c.done), [false, false]);
  assert.equal(toggleCriterion(BODY, 5, true), BODY);
  assert.deepEqual(criteriaOf(editCriterion(BODY, 0, '  CSV  в CP1251 ')), [{ text: 'CSV в CP1251', done: true }, { text: 'Пустой период — только заголовок', done: false }]);
  assert.deepEqual(criteriaOf(removeCriterion(BODY, 0)).map((c) => c.text), ['Пустой период — только заголовок']);
  assert.deepEqual(criteriaOf(editCriterion(BODY, 1, ' ')).length, 1);
});

test('тело задачи: новый критерий — в конец раздела, без раздела — раздел в конце тела', () => {
  assert.deepEqual(criteriaOf(addCriterion(BODY, 'Тест на каждый пункт')).map((c) => c.text), ['CSV в UTF-8 с BOM', 'Пустой период — только заголовок', 'Тест на каждый пункт']);
  assert.equal(addCriterion('## Описание\n\nТекст\n', 'Один'), '## Описание\n\nТекст\n\n## Критерии приёмки\n\n- [ ] Один\n');
  assert.equal(addCriterion('', 'Один'), '## Критерии приёмки\n\n- [ ] Один\n');
  assert.equal(addCriterion('## Критерии приёмки\n', 'Один'), '## Критерии приёмки\n\n- [ ] Один\n');
  assert.equal(addCriterion(BODY, '   '), BODY);
});

test('тело задачи: новое описание встаёт под «## Описание», критерии остаются как были', () => {
  const next = withDescription(BODY, 'Новый текст\n\nвторой абзац');
  assert.equal(descriptionOf(next), 'Новый текст\n\nвторой абзац');
  assert.deepEqual(criteriaOf(next), criteriaOf(BODY));
  assert.equal(withDescription('', 'Текст'), '## Описание\n\nТекст\n');
  assert.equal(withDescription(BODY, ''), '## Критерии приёмки\n\n- [x] CSV в UTF-8 с BOM\n- [ ] Пустой период — только заголовок\n');
  // тело без разделов: описание — весь текст, галочки уходят в раздел критериев
  assert.equal(descriptionOf('просто текст'), 'просто текст');
  assert.equal(withDescription('старое\n- [ ] пункт', 'новое'), '## Описание\n\nновое\n\n## Критерии приёмки\n\n- [ ] пункт\n');
});

test('тело задачи: правка галочки не трогает остальной текст — код с пустыми строками, отступы, хвост', () => {
  const body = '  отступ первой строки\n\n```ts\nfunction a() {}\n\n\nfunction b() {}\n```\n\n## Критерии приёмки\n\n- [ ] один\n- [ ] два\n\n';
  const next = toggleCriterion(body, 1, true);
  assert.equal(next, body.replace('- [ ] два', '- [x] два'));
  assert.equal(removeCriterion(body, 0), body.replace('- [ ] один\n', ''));
  assert.equal(editCriterion(body, 0, 'ноль'), body.replace('- [ ] один', '- [ ] ноль'));
  // галочки внутри ограды кода не считаются и не правятся
  assert.deepEqual(criteriaOf('```\n- [ ] нет\n```\n- [ ] да\n'), [{ text: 'да', done: false }]);
});

test('тело без раздела критериев: галочки — критерии, не описание; правка описания и новый критерий их не теряют и не дублируют', () => {
  const body = 'Сделать X\n- [ ] a\n- [x] b\n';
  assert.equal(descriptionOf(body), 'Сделать X');
  const edited = withDescription(body, 'Сделать Y');
  assert.equal(edited, '## Описание\n\nСделать Y\n\n## Критерии приёмки\n\n- [ ] a\n- [x] b\n');
  assert.deepEqual(criteriaOf(edited), criteriaOf(body));
  const added = addCriterion(body, 'c');
  assert.equal(added, 'Сделать X\n\n## Критерии приёмки\n\n- [ ] a\n- [x] b\n- [ ] c\n');
  assert.deepEqual(criteriaOf(added).map((c) => c.text), ['a', 'b', 'c']);
  // «## Описание» без раздела критериев — то же
  const withHead = '## Описание\n\nТекст\n- [ ] a\n';
  assert.equal(descriptionOf(withHead), 'Текст');
  assert.deepEqual(criteriaOf(withDescription(withHead, 'Новый')), [{ text: 'a', done: false }]);
});

test('«Переместить…»: выше, ниже, в начало, в конец — соседи для сервера', () => {
  const list = [task({ id: 'A', rank: 'a' }), task({ id: 'B', rank: 'b' }), task({ id: 'C', rank: 'c' }), task({ id: 'D', rank: 'd' })];
  const m = listMoves(list, 'C');
  assert.deepEqual(m.map((x) => x.key), ['up', 'down', 'top']);
  assert.deepEqual(m[0]!.drop.move, { after: 'A', before: 'B' });
  assert.deepEqual(m[1]!.drop.move, { after: 'D' });
  assert.deepEqual(m[2]!.drop.move, { before: 'A' });
  assert.deepEqual(listMoves(list, 'A').map((x) => x.key), ['down', 'bottom']);
  assert.deepEqual(listMoves(list, 'X'), []);
});

test('доска: «В колонку…» — в конец чужих колонок с названием команды, ⌥← ⌥→ — та же строка соседней колонки', () => {
  const tasks = [task({ id: 'A', sprint: 2, rank: 'a' }), task({ id: 'B', sprint: 2, rank: 'b' }), task({ id: 'C', sprint: 2, rank: 'c', status: 'in_progress' })];
  const cols = boardColumns(tasks, 2);
  const moves = columnMoves(cols, 'todo', { in_progress: 'Делаем' });
  assert.deepEqual(moves.map((x) => x.label), ['В колонку «Делаем»', 'В колонку «ревью»', 'В колонку «готово»']);
  assert.deepEqual(moves[0]!.drop.move, { status: 'in_progress', after: 'C' });
  const side = sideMove(cols, ['todo', 'in_progress', 'review', 'done'], 'B', 1);
  assert.equal(side?.status, 'in_progress');
  assert.deepEqual(side?.drop.move, { status: 'in_progress', after: 'C' });
  assert.equal(sideMove(cols, ['todo', 'in_progress', 'review', 'done'], 'A', -1), undefined);
});

test('перенос: ранг как у сервера — без соседей прежний, с соседом из dropMove', () => {
  assert.equal(dropRank({ move: { sprint: 3 }, rank: 'V' }, 'zV'), 'zV');
  assert.equal(dropRank({ move: { sprint: 3, after: 'PAY-9' }, rank: 'zl' }, 'a'), 'zl');
});

test('перетаскивание: место без переносимой задачи и перенос на своё же место', () => {
  const list = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  // A на нижнюю половину B: после B, то есть позиция 1 в списке без A
  assert.equal(dropIndex(list, 'A', 1, true), 1);
  assert.equal(dropIndex(list, 'C', 0, false), 0);
  assert.equal(dropIndex(list, 'X', 2, true), 3);
  assert.equal(samePlace(list, 'B', dropIndex(list, 'B', 1, false)), true);
  assert.equal(samePlace(list, 'B', dropIndex(list, 'B', 0, true)), true);
  assert.equal(samePlace(list, 'B', dropIndex(list, 'B', 2, true)), false);
});

test('репо задачи: своё, единственное в проекте, выбор при нескольких', () => {
  const one = { repos: [{ key: 'billing', url: 'u' }] };
  const two = { repos: [{ key: 'billing', url: 'u' }, { key: 'web', url: 'w' }] };
  assert.equal(taskRepo({}, one), 'billing');
  assert.equal(taskRepo({}, two), undefined);
  assert.equal(taskRepo({ repo: 'web' }, two), 'web');
  assert.equal(needsRepo({}, two), true);
  assert.equal(needsRepo({ repo: 'web' }, two), false);
  assert.equal(needsRepo({}, one), false);
});

const intake: TeamTaskIntake = {
  input: 'Задача: PAY-12\nВетка: tw/PAY-12\n\nтекст', context: 'Задача Teamwork PAY-12\n<source-data>…</source-data>',
  source: { type: 'teamwork', key: 'PAY-12', title: 'Выгрузка', project: '/code/billing' }, teamwork: { team: 'pay', project: 'export', task: 'PAY-12' },
  teamFlow: { team: 'pay', name: 'teamwork-task' }, teamFlows: ['teamwork-task', 'teamwork-split'], branch: 'tw/PAY-12', repos: [], addDirs: ['/teams/pay/repo/projects/export'],
  space: 'billing', work: [],
};

test('«В работу ▸»: вход своего flow — анкета со строками «Задача:» и «Ветка:», ниже текст задачи', () => {
  const tpl = 'Задача: <номер>\nВетка: <ветка>\nЧто ещё: <...>';
  assert.equal(myFlowInput(tpl, { task: 'PAY-12 — Выгрузка', branch: 'tw/PAY-12' }, 'ТЕКСТ'), 'Задача: PAY-12 — Выгрузка\nВетка: tw/PAY-12\nЧто ещё: <...>\n\nТЕКСТ');
  assert.equal(myFlowInput('Опиши задачу', { task: 'PAY-12' }, 'ТЕКСТ'), 'ТЕКСТ');
  assert.equal(myFlowInput(undefined, { task: 'PAY-12' }, ' ТЕКСТ '), 'ТЕКСТ');
});

test('«В работу ▸»: flow по умолчанию и ключ выбора в списке', () => {
  assert.deepEqual(defaultWorkFlow(intake, [{ name: 'mine' }]), { kind: 'team', name: 'teamwork-task' });
  assert.deepEqual(defaultWorkFlow({ teamFlows: ['x'] }, []), { kind: 'team', name: 'x' });
  assert.deepEqual(defaultWorkFlow({ teamFlows: [] }, [{ name: 'mine' }]), { kind: 'mine', name: 'mine' });
  assert.equal(defaultWorkFlow({ teamFlows: [] }, []), undefined);
  assert.deepEqual(parseWorkFlow(workFlowKey({ kind: 'mine', name: 'a/b' })), { kind: 'mine', name: 'a/b' });
  assert.equal(parseWorkFlow('other'), undefined);
});

test('«В работу ▸»: тело запуска — flow команды через teamFlow, папка и worktree задачи, связь и пространство', () => {
  const wt = { path: '/wt/billing/tw-PAY-12', branch: 'tw/PAY-12' };
  const team = workRunBody(intake, wt, { kind: 'team', name: 'teamwork-task' }, { input: 'ВХОД', space: 'billing', model: '', budget: '1.5' });
  assert.deepEqual(team, {
    teamFlow: { team: 'pay', name: 'teamwork-task' }, teamwork: intake.teamwork, input: 'ВХОД', cwd: wt.path, worktree: wt, addDirs: intake.addDirs, source: intake.source,
    space: 'billing', saveState: true, maxBudgetUsd: 1.5,
  });
  const mine = workRunBody(intake, wt, { kind: 'mine', name: 'example/hello' }, { input: 'В', space: ' ', model: 'haiku', budget: 'abc' });
  assert.equal(mine.flow, 'example/hello');
  assert.equal(mine.teamFlow, undefined);
  assert.equal(mine.space, undefined);
  assert.equal(mine.model, 'haiku');
  assert.equal(mine.maxBudgetUsd, undefined);
});

test('«В работу ▸»: тело сессии — worktree, текст задачи первым сообщением, связь с задачей', () => {
  const body = workSessionBody(intake, { path: '/wt' }, { input: 'ТЕКСТ', space: 'billing', model: '' });
  assert.deepEqual(body, { cwd: '/wt', prompt: 'ТЕКСТ', tags: [], saveState: true, teamwork: intake.teamwork, name: 'PAY-12 · Выгрузка', space: 'billing' });
});
