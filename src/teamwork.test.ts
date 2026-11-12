// Чистая логика Teamwork: форматы файлов туда и обратно с сохранением неизвестных полей, битый файл даёт задачу с error,
// rank между любыми соседями, номера задач и требований, разделы markdown, зависимости разбивки, слияние полей.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptanceOf, checkDependencies, commentFileName, compareTasks, composeTask, docFile, docTitle, findSection, mergeRecords, mergeTaskTexts, mergeYamlTexts, shareableUrl,
  nextRequirementId, nextTaskId, parseComment, parseProject, parseRequirements, parseSprint, parseTask, parseTeamConfig, rankBetween, rankNear, remoteProblem,
  replaceSection, requirementMax, sectionHash, serializeComment, serializeProject, serializeSprint, serializeTask, serializeTeamConfig, sortTasks, splitSections,
  teamSlugFromUrl, updateYaml, validRank, type TaskFile,
} from './teamwork.js';
import type { TeamProposedTask } from './api-types.js';

const TASK = `---
id: PAY-12
title: Выгрузка счетов за период в CSV
type: feature
status: todo
sprint: 2
rank: a0V
assignee: alex@example.com
estimate: 3
repo: billing
branch: tw/PAY-12-csv-export
pr:
  url: https://github.com/acme/billing/pull/42
  state: open
blockedBy: [PAY-11]
createdAt: 2026-11-12T10:05:00Z
createdBy: alex@example.com
updatedAt: 2026-11-12T11:40:00Z
labels: [urgent]
---

## Описание

Бухгалтер выбирает период и получает CSV со всеми счетами за него.

## Критерии приёмки

- [ ] CSV в UTF-8 с BOM, разделитель \`;\`
- [x] Пустой период даёт файл только с заголовком
`;

test('задача: разбор и запись туда и обратно, неизвестное поле frontmatter сохраняется, критерии считаются по разделу', () => {
  const t = parseTask(TASK, 'projects/p/tasks/PAY-12.md');
  assert.equal(t.error, undefined);
  assert.equal(t.id, 'PAY-12');
  assert.equal(t.title, 'Выгрузка счетов за период в CSV');
  assert.equal(t.sprint, 2);
  assert.equal(t.rank, 'a0V');
  assert.deepEqual(t.blockedBy, ['PAY-11']);
  assert.deepEqual(t.pr, { url: 'https://github.com/acme/billing/pull/42', state: 'open' });
  assert.equal(t.createdAt, '2026-11-12T10:05:00Z');
  assert.deepEqual(t.acceptance, { done: 1, total: 2 });
  assert.deepEqual(t.extra, { labels: ['urgent'] });
  assert.match(t.body, /^## Описание/);
  const again = parseTask(serializeTask(t), t.file);
  const strip = ({ base: _b, ...x }: TaskFile) => x;
  assert.deepEqual(strip(again), strip(t));
  assert.match(serializeTask(t), /labels:\n {2}- urgent/);
  // критерии вне раздела «Критерии приёмки» не считаются, когда раздел есть; без раздела — весь текст
  assert.deepEqual(acceptanceOf('- [ ] a\n\n## Критерии приёмки\n\n- [x] b\n'), { done: 1, total: 1 });
  assert.deepEqual(acceptanceOf('- [ ] a\n- [x] b\n```\n- [ ] в коде\n```\n'), { done: 1, total: 2 });
});

test('задача: битый файл — задача с error и телом как есть, а не исключение', () => {
  const noFm = parseTask('# просто текст\n', 'projects/p/tasks/PAY-1.md');
  assert.equal(noFm.id, 'PAY-1');
  assert.match(noFm.error ?? '', /frontmatter/);
  assert.equal(noFm.body, '# просто текст\n');
  const badYaml = parseTask('---\nid: [\n---\nтело\n', 'x/PAY-2.md');
  assert.match(badYaml.error ?? '', /YAML/);
  assert.match(parseTask('---\ntitle: без id\n---\n', 'x/PAY-3.md').error ?? '', /поле id/);
  assert.match(parseTask('---\nid: PAY-4\ntitle: t\nstatus: later\n---\n', 'x/PAY-4.md').error ?? '', /status/);
  assert.match(parseTask('---\nid: PAY-9\ntitle: t\n---\n', 'x/PAY-5.md').error ?? '', /не совпадает/);
  // необязательные поля по умолчанию
  const min = parseTask('---\nid: PAY-6\ntitle: t\n---\n', 'x/PAY-6.md');
  assert.equal(min.error, undefined);
  assert.equal(min.type, 'feature');
  assert.equal(min.status, 'todo');
  assert.equal(min.rank, '');
  assert.deepEqual(min.covers, []);
});

test('teamwork.yaml: разбор, колонки по умолчанию, неизвестные поля и комментарии при правке по месту', () => {
  const text = `format: 1 # версия
title: Платёжная команда
prefix: pay
columns:
  todo: К работе
members:
  - name: Алексей
    email: Alex@example.com
    github: alex
  - email: bob@example.com
defaultFlow: teamwork-task
custom: yes
`;
  const cfg = parseTeamConfig(text);
  assert.equal(cfg.prefix, 'PAY');
  assert.equal(cfg.columns.review, 'Ревью');
  assert.deepEqual(cfg.members, [{ name: 'Алексей', email: 'alex@example.com', github: 'alex' }, { name: 'bob@example.com', email: 'bob@example.com' }]);
  assert.deepEqual(cfg.extra, { custom: 'yes' });
  assert.match(serializeTeamConfig(cfg), /custom: yes/);
  const updated = updateYaml(text, { title: 'Новое', defaultFlow: undefined });
  assert.match(updated, /format: 1 # версия/);
  assert.match(updated, /title: Новое/);
  assert.doesNotMatch(updated, /defaultFlow/);
  assert.match(updated, /custom: yes/);
  assert.throws(() => parseTeamConfig('title: x\n'), /format/);
  assert.throws(() => parseTeamConfig('format: 1\nprefix: p\n'), /prefix/);
  assert.throws(() => parseTeamConfig('format: 1\nprefix: [\n'), /YAML/);
});

test('project.yaml и спринт: туда и обратно, lastRequirement и неизвестные поля не теряются', () => {
  const p = parseProject('slug: invoice-export\ntitle: Экспорт\nsummary: Суть\nstatus: active\nrepos:\n  - key: billing\n    url: git@github.com:acme/billing.git\n    defaultBranch: main\ncreatedAt: 2026-11-12T10:00:00Z\nlastRequirement:\n  FR: 7\nowner: team-a\n');
  assert.equal(p.slug, 'invoice-export');
  assert.deepEqual(p.repos, [{ key: 'billing', url: 'git@github.com:acme/billing.git', defaultBranch: 'main' }]);
  assert.deepEqual(p.lastRequirement, { FR: 7 });
  assert.equal(p.createdAt, '2026-11-12T10:00:00Z');
  const p2 = parseProject(serializeProject(p));
  assert.deepEqual(p2, p);
  assert.equal(p2.extra.owner, 'team-a');
  assert.throws(() => parseProject('title: без slug\n'), /slug/);
  assert.equal(parseProject('title: x\n', 'from-dir').slug, 'from-dir');
  const s = parseSprint('number: 2\ntitle: Спринт 2\ngoal: Цель\nstatus: active\nstartedAt: 2026-11-12T12:00:00Z\nstartedBy: a@b\nclosedAt:\nresult:\n  done: [PAY-10]\n  carried: []\n  returned: [PAY-14]\nvelocity: 12\n');
  assert.equal(s.status, 'active');
  assert.equal(s.closedAt, undefined);
  assert.deepEqual(s.result, { done: ['PAY-10'], carried: [], returned: ['PAY-14'] });
  assert.deepEqual(parseSprint(serializeSprint(s)), s);
  assert.equal(parseSprint('title: без номера\n', 3).number, 3);
  assert.throws(() => parseSprint('title: без номера\n'), /number/);
});

test('rank: общие с UI примеры, между любыми соседями, ошибки на a ≥ b и хвостовом нуле', () => {
  assert.equal(rankBetween(), 'V');
  assert.equal(rankBetween('V'), 'l');
  assert.equal(rankBetween(undefined, 'V'), 'G');
  assert.equal(rankBetween('V', 'W'), 'VV');
  // много вставок между двумя соседями и в конец — порядок строк сохраняется
  let a = 'V';
  const b = 'W';
  for (let i = 0; i < 50; i++) {
    const m = rankBetween(a, b);
    assert.ok(a < m && m < b, `${a} < ${m} < ${b}`);
    a = m;
  }
  let last = '';
  for (let i = 0; i < 100; i++) {
    const m = rankBetween(last || undefined);
    assert.ok(m > last);
    last = m;
  }
  let first = rankBetween(undefined, 'A');
  for (let i = 0; i < 50; i++) {
    const m = rankBetween(undefined, first);
    assert.ok(m < first && m > '');
    first = m;
  }
  assert.throws(() => rankBetween('W', 'V'), /rank/);
  assert.throws(() => rankBetween('V', 'V'), /rank/);
  assert.throws(() => rankBetween('V0'), /хвостовой/);
  assert.throws(() => rankBetween('a b'), /символы/);
  // rankNear: правленный руками rank соседа и перевёрнутые соседи не роняют запись
  assert.equal(rankNear('V0', 'W'), rankBetween(undefined, 'W'));
  assert.equal(rankNear('W', 'V'), rankBetween('W'));
  assert.equal(rankNear('', ''), 'V');
  assert.equal(rankNear('V', 'W'), 'VV');
  assert.equal(validRank('a-b'), undefined);
  // одинаковые rank сортируются по номеру
  const sorted = sortTasks([{ id: 'PAY-10', rank: 'V' }, { id: 'PAY-2', rank: 'V' }, { id: 'PAY-5', rank: 'G' }]);
  assert.deepEqual(sorted.map((t) => t.id), ['PAY-5', 'PAY-2', 'PAY-10']);
  assert.equal(compareTasks({ id: 'PAY-1', rank: 'V' }, { id: 'PAY-1', rank: 'V' }), 0);
});

test('номера задач: максимум плюс один по всем проектам, чужой префикс не считается', () => {
  assert.equal(nextTaskId([], 'PAY'), 'PAY-1');
  assert.equal(nextTaskId(['PAY-3', 'PAY-12', 'OPS-40', 'PAY-x'], 'PAY'), 'PAY-13');
});

const PRD = `# ТЗ

Вводный абзац.

## Цель

Текст цели.

## Требования

- FR-1. Выгрузка CSV
- FR-3. Пустой период даёт заголовок

\`\`\`md
## Не раздел
- FR-9. не требование
\`\`\`

## Нефункциональные требования

- NFR-2. Ответ за секунду
`;

test('разделы: по «## » вне блоков кода, хэш раздела, замена раздела не трогает остальные', () => {
  const secs = splitSections(PRD);
  assert.deepEqual(secs.map((s) => s.heading), ['', 'Цель', 'Требования', 'Нефункциональные требования']);
  assert.equal(secs[0].text, '# ТЗ\n\nВводный абзац.\n\n');
  assert.ok(secs[2].text.startsWith('## Требования\n'));
  assert.ok(secs[2].text.includes('## Не раздел'));
  assert.equal(secs.map((s) => s.text).join(''), PRD);
  const h = sectionHash(secs[1].text);
  assert.equal(sectionHash('## Цель\n\nТекст цели.'), h);
  const next = replaceSection(PRD, 'Цель', '## Цель\n\nНовая цель.\n\n\n');
  assert.match(next, /## Цель\n\nНовая цель.\n\n## Требования/);
  assert.equal(splitSections(next).length, 4);
  assert.equal(findSection(next, 'Требования')?.text, secs[2].text);
  assert.notEqual(sectionHash(findSection(next, 'Цель')!.text), h);
  // последний раздел: без лишней пустой строки в конце; неизвестный — ошибка
  assert.ok(replaceSection(PRD, 'Нефункциональные требования', '## Нефункциональные требования\n\n- NFR-2. Быстро').endsWith('- NFR-2. Быстро\n'));
  assert.throws(() => replaceSection(PRD, 'Нет такого', 'x'), /Раздела/);
  assert.deepEqual(splitSections(''), []);
  assert.deepEqual(splitSections('только текст\n').map((s) => s.heading), ['']);
});

test('требования: строки FR/NFR в любом разделе, не в коде; следующий номер учитывает lastRequirement', () => {
  assert.deepEqual(parseRequirements(PRD), [
    { id: 'FR-1', text: 'Выгрузка CSV', section: 'Требования' },
    { id: 'FR-3', text: 'Пустой период даёт заголовок', section: 'Требования' },
    { id: 'NFR-2', text: 'Ответ за секунду', section: 'Нефункциональные требования' },
  ]);
  assert.deepEqual(requirementMax(PRD), { FR: 3, NFR: 2 });
  assert.equal(nextRequirementId(PRD, 'FR'), 'FR-4');
  assert.equal(nextRequirementId(PRD, 'FR', { FR: 7 }), 'FR-8');
  assert.equal(nextRequirementId(PRD, 'NFR', { FR: 7 }), 'NFR-3');
  assert.equal(nextRequirementId('', 'NFR'), 'NFR-1');
});

const proposed = (key: string, dependsOn: string[], estimate?: number): TeamProposedTask => ({ key, title: key, type: 'feature', description: '', acceptance: [], dependsOn, covers: [], ...(estimate !== undefined ? { estimate } : {}) });

test('зависимости: неизвестная ссылка — ошибка у задачи, цикл — с цепочкой, волны по незавершённым, цепочка по очкам', () => {
  const existing = [{ id: 'PAY-1', status: 'in_progress' as const }, { id: 'PAY-2', status: 'done' as const }];
  const r = checkDependencies([proposed('t1', [], 3), proposed('t2', ['t1', 'PAY-1'], 5), proposed('t3', ['PAY-2'], 1), proposed('t4', ['t2', 'nope'], 2)], existing);
  assert.deepEqual(r.errors, [{ key: 't4', error: 'Неизвестная зависимость: nope' }]);
  assert.equal(r.cycle, undefined);
  // t1 и t3 можно начать сейчас (PAY-2 готова), PAY-1 в работе — волна 1; t2 ждёт их — волна 2; t4 — волна 3
  assert.deepEqual(r.waves, { 'PAY-1': 1, t1: 1, t2: 2, t3: 1, t4: 3 });
  assert.deepEqual(r.chain, { keys: ['t1', 't2', 't4'], points: 10 });
  const cyc = checkDependencies([proposed('3', ['5']), proposed('5', ['3']), proposed('7', [])], []);
  assert.deepEqual(cyc.cycle, ['3', '5', '3']);
  assert.deepEqual(cyc.errors.map((e) => e.key).sort(), ['3', '5']);
  assert.match(cyc.errors[0].error, /3 → 5 → 3/);
  assert.equal(cyc.waves['7'], 1);
  assert.deepEqual(checkDependencies([], []), { errors: [], waves: {}, chain: { keys: [], points: 0 } });
  // цепочка цикла идёт по стрелкам графа, от предшественника к зависимой задаче: a ждёт b, b ждёт c, c ждёт a → a → c → b → a
  const three = checkDependencies([proposed('a', ['b']), proposed('b', ['c']), proposed('c', ['a'])], []);
  assert.deepEqual(three.cycle, ['a', 'c', 'b', 'a']);
  assert.match(three.errors[0].error, /a → c → b → a/);
  // самозависимость — цикл из одного ключа; повтор ключа — ошибка
  assert.deepEqual(checkDependencies([proposed('a', ['a'])], []).cycle, ['a', 'a']);
  assert.match(checkDependencies([proposed('a', []), proposed('a', [])], []).errors[0].error, /повторяется/);
});

test('слияние полей: только моё, только их, одинаково, по-разному — значение команды и конфликт; снятое поле — тоже значение', () => {
  const base = { status: 'todo', assignee: 'a', estimate: 3, rank: 'V' };
  const r = mergeRecords(base, { status: 'in_progress', assignee: 'a', estimate: 5, rank: 'V', repo: 'x' }, { status: 'review', estimate: 3, rank: 'V', branch: 'b' });
  assert.deepEqual(r.merged, { status: 'review', estimate: 5, rank: 'V', branch: 'b', repo: 'x' });
  assert.deepEqual(r.conflicts, [{ field: 'status', ours: 'in_progress', theirs: 'review' }]);
  // без базы: разные значения — конфликт, одинаковые — нет
  assert.deepEqual(mergeRecords(undefined, { a: 1, b: 2 }, { a: 1, b: 3 }).conflicts, [{ field: 'b', ours: 2, theirs: 3 }]);
});

test('слияние файлов задачи и YAML: поля по отдельности, тело через mergeText, конфликт тела — текст команды', async () => {
  const file = 'x/PAY-1.md';
  const base = composeTask({ id: 'PAY-1', title: 't', type: 'feature', status: 'todo', rank: 'V', blockedBy: [] }, 'описание\n');
  const mine = composeTask({ id: 'PAY-1', title: 't', type: 'feature', status: 'in_progress', rank: 'V', blockedBy: [], assignee: 'me' }, 'описание\n');
  const theirs = composeTask({ id: 'PAY-1', title: 'новое имя', type: 'feature', status: 'todo', rank: 'V', blockedBy: [], note: 1 }, 'описание\n\n- [ ] пункт\n');
  const ok = await mergeTaskTexts(base, mine, theirs, file, () => undefined);
  const t = parseTask(ok.text, file);
  assert.deepEqual(ok.conflicts, []);
  assert.equal(t.status, 'in_progress');
  assert.equal(t.assignee, 'me');
  assert.equal(t.title, 'новое имя');
  assert.equal(t.extra.note, 1);
  assert.match(t.body, /пункт/);
  // оба меняли тело по-разному и mergeText не слил — тело команды и конфликт body; поля всё равно сливаются
  const mine2 = composeTask({ id: 'PAY-1', title: 't', type: 'feature', status: 'todo', rank: 'V', blockedBy: [], estimate: 2 }, 'моё описание\n');
  const bad = await mergeTaskTexts(base, mine2, theirs, file, () => undefined);
  assert.deepEqual(bad.conflicts.map((c) => c.field), ['body']);
  assert.match(parseTask(bad.text, file).body, /пункт/);
  assert.equal(parseTask(bad.text, file).estimate, 2);
  // mergeText слил — его результат
  const merged = await mergeTaskTexts(base, mine2, theirs, file, async (b, m, th) => `${b}|${m}|${th}`);
  assert.deepEqual(merged.conflicts, []);
  assert.match(parseTask(merged.text, file).body, /описание\n\|моё описание/);
  // YAML: итог поверх текста команды, её комментарии остаются
  const y = mergeYamlTexts('number: 1\nstatus: planned\n', 'number: 1\nstatus: active\n', 'number: 1 # первый\nstatus: planned\ngoal: g\n');
  assert.deepEqual(y.conflicts, []);
  assert.match(y.text, /number: 1 # первый/);
  assert.match(y.text, /status: active/);
  assert.match(y.text, /goal: g/);
  const yc = mergeYamlTexts('status: planned\n', 'status: active\n', 'status: closed\n');
  assert.deepEqual(yc.conflicts, [{ field: 'status', ours: 'active', theirs: 'closed' }]);
  assert.match(yc.text, /status: closed/);
});

test('слияние задачи: updatedAt и updatedBy без конфликта — более поздняя правка со своим автором, настоящий конфликт остаётся', async () => {
  const file = 'x/PAY-1.md';
  const fm = (o: Record<string, unknown>) => ({ id: 'PAY-1', title: 't', type: 'feature', status: 'todo', rank: 'V', blockedBy: [], ...o });
  const base = composeTask(fm({ updatedAt: '2026-11-12T10:00:00.000Z', updatedBy: 'base@example.com' }), 'описание\n');
  // разные поля, оба поставили свою метку: конфликтов нет, метка — их (позже)
  const mine = composeTask(fm({ status: 'in_progress', updatedAt: '2026-11-12T10:00:01.000Z', updatedBy: 'me@example.com' }), 'описание\n');
  const theirs = composeTask(fm({ assignee: 'bob', updatedAt: '2026-11-12T10:00:01.100Z', updatedBy: 'bob@example.com' }), 'описание\n');
  const r = await mergeTaskTexts(base, mine, theirs, file, () => undefined);
  assert.deepEqual(r.conflicts, []);
  const t = parseTask(r.text, file);
  assert.deepEqual([t.status, t.assignee, t.updatedAt, t.updatedBy], ['in_progress', 'bob', '2026-11-12T10:00:01.100Z', 'bob@example.com']);
  // моя правка позже — метка моя; одно поле по-разному — единственный конфликт, значение команды
  const mine2 = composeTask(fm({ estimate: 5, updatedAt: '2026-11-12T10:00:02.000Z', updatedBy: 'me@example.com' }), 'описание\n');
  const theirs2 = composeTask(fm({ estimate: 3, updatedAt: '2026-11-12T10:00:01.900Z', updatedBy: 'bob@example.com' }), 'описание\n');
  const r2 = await mergeTaskTexts(base, mine2, theirs2, file, () => undefined);
  assert.deepEqual(r2.conflicts, [{ field: 'estimate', ours: 5, theirs: 3 }]);
  const t2 = parseTask(r2.text, file);
  assert.deepEqual([t2.estimate, t2.updatedAt, t2.updatedBy], [3, '2026-11-12T10:00:02.000Z', 'me@example.com']);
  // без базы и с одинаковым временем — метка команды
  const r3 = await mergeTaskTexts(undefined, composeTask(fm({ updatedAt: '2026-11-12T10:00:00.000Z', updatedBy: 'me@example.com' }), ''), composeTask(fm({ updatedAt: '2026-11-12T10:00:00.000Z', updatedBy: 'bob@example.com' }), ''), file, () => undefined);
  assert.deepEqual(r3.conflicts, []);
  assert.equal(parseTask(r3.text, file).updatedBy, 'bob@example.com');
});

test('комментарии: имя файла по времени и handle, разбор и запись', () => {
  assert.equal(commentFileName('2026-11-12T10:31:05.123Z', 'Alice.Smith@example.com'), '2026-11-12T10-31-05Z-alice.smith.md');
  assert.equal(commentFileName('2026-11-12T10:31:05Z', '@@'), '2026-11-12T10-31-05Z-user.md');
  const text = serializeComment({ author: 'a@b.c', name: 'A', at: '2026-11-12T10:31:05Z', text: 'Привет\n', extra: { pinned: true } });
  const c = parseComment(text, 'comments/PAY-1/2026-11-12T10-31-05Z-a.md');
  assert.deepEqual(c, { id: '2026-11-12T10-31-05Z-a', author: 'a@b.c', name: 'A', at: '2026-11-12T10:31:05Z', text: 'Привет', extra: { pinned: true } });
  assert.equal(parseComment('без frontmatter', 'x.md'), undefined);
});

test('документы: имя → файл, docs/ только безопасные имена .md; заголовок по первой «# »', () => {
  assert.equal(docFile('prd'), 'prd.md');
  assert.equal(docFile('docs/Заметки встречи.md'), 'docs/Заметки встречи.md');
  assert.equal(docFile('docs/../x.md'), undefined);
  assert.equal(docFile('docs/a/b.md'), undefined);
  assert.equal(docFile('docs/.hidden.md'), undefined);
  assert.equal(docFile('docs/pic.png'), undefined);
  assert.equal(docFile('other'), undefined);
  assert.equal(docTitle('# Заголовок ##\n\nтекст', 'f'), 'Заголовок');
  assert.equal(docTitle('```\n# не заголовок\n```\n', 'f'), 'f');
});

test('ссылка на репо: допустимые формы, отказ на пробелы и ведущий «-»; слаг команды из ссылки', () => {
  for (const ok of ['https://github.com/acme/team.git', 'http://host/x', 'ssh://git@host:2222/a/b.git', 'git@github.com:acme/payments-team.git', 'host:path/x', 'file:///tmp/x.git', '/tmp/x.git']) {
    assert.equal(remoteProblem(ok), undefined, ok);
  }
  assert.match(remoteProblem('') ?? '', /Укажи/);
  assert.match(remoteProblem('-oProxyCommand=evil') ?? '', /«-»/);
  assert.match(remoteProblem('https://a b') ?? '', /пробелы/);
  assert.match(remoteProblem('x\ny') ?? '', /пробелы/);
  assert.match(remoteProblem('relative/path') ?? '', /Ссылка на репо/);
  assert.match(remoteProblem('ext::sh -c evil') ?? '', /пробелы/);
  assert.match(remoteProblem('ext::/tmp/evil') ?? '', /ext::/);
  assert.match(remoteProblem('fd::3') ?? '', /fd::/);
  assert.equal(teamSlugFromUrl('git@github.com:acme/Payments-Team.git'), 'payments-team');
  assert.equal(teamSlugFromUrl('https://gitlab.com/g/sub/x.git/'), 'x');
  assert.equal(teamSlugFromUrl('/tmp/bare.git'), 'bare');
  assert.equal(teamSlugFromUrl('///'), 'team');
});

test('ссылка для репо команды: у https без логина и токена, у ssh без пароля, остальное как есть', () => {
  assert.equal(shareableUrl('https://alex:ghp_secret@github.com/acme/billing.git'), 'https://github.com/acme/billing.git');
  assert.equal(shareableUrl('https://ghp_secret@github.com/acme/billing.git'), 'https://github.com/acme/billing.git');
  assert.equal(shareableUrl('ssh://git:pw@host:2222/a/b.git'), 'ssh://git@host:2222/a/b.git');
  assert.equal(shareableUrl('ssh://git@host:2222/a/b.git'), 'ssh://git@host:2222/a/b.git');
  assert.equal(shareableUrl('git@github.com:acme/billing.git'), 'git@github.com:acme/billing.git');
  assert.equal(shareableUrl('https://github.com/acme/billing.git'), 'https://github.com/acme/billing.git');
});
