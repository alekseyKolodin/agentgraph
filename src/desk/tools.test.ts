import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Exec } from '../git.js';
import {
  branchKeyOf, canonicalKey, deskCall, deskCommand, itemLine, deskClose, deskInputSchemas, deskList, deskPut, deskToolDescriptions, parseCloseArgs, parseDue, parseListArgs, parsePutArgs, resolveThing,
  type DeskCallCtx,
} from './tools.js';
import type { DeskApi, DeskBy, DeskFilter, DeskItem, DeskPatch } from './types.js';
import type { Thing } from '../things/types.js';

/** Хранилище в памяти: put заводит или дописывает сигнал (без правил движения), close, list по фильтру. */
function memDesk(): DeskApi & { puts: Array<{ key: string; patch: DeskPatch; by: DeskBy }>; items: Map<string, DeskItem> } {
  const items = new Map<string, DeskItem>();
  const puts: Array<{ key: string; patch: DeskPatch; by: DeskBy }> = [];
  const at = '2026-11-19T10:00:00.000Z';
  return {
    items,
    puts,
    async put(key, patch, by) {
      puts.push({ key, patch, by });
      const prev = items.get(key);
      const links = { runs: [...(prev?.links.runs ?? []), ...(patch.links?.runs ?? [])], sessions: [...(prev?.links.sessions ?? []), ...(patch.links?.sessions ?? [])], ...(prev?.links.branch || patch.links?.branch ? { branch: prev?.links.branch ?? patch.links?.branch } : {}) };
      const item: DeskItem = prev
        ? { ...prev, signals: [...prev.signals, ...(patch.signal ? [patch.signal] : [])], links, ...(patch.title ? { title: patch.title } : {}), ...(patch.due ? { due: patch.due } : {}) }
        : {
            id: String(items.size + 1), key, kind: patch.kind ?? 'Своё', title: patch.title ?? key, ...(patch.project ? { project: patch.project } : {}), column: patch.column ?? 'new',
            why: patch.why ?? '', signals: patch.signal ? [patch.signal] : [], ...(patch.due ? { due: patch.due } : {}), ...(patch.thing ? { thing: patch.thing } : {}),
            links, createdAt: at, movedAt: at, movedBy: by,
          };
      items.set(key, item);
      return item;
    },
    async close(key, reason) {
      const it = items.get(key);
      if (!it) return undefined;
      const out = { ...it, column: 'done' as const, closed: { at, reason } };
      items.set(key, out);
      return out;
    },
    async move(key, column, by) {
      const it = items.get(key);
      if (!it) return undefined;
      const out = { ...it, column, movedBy: by };
      items.set(key, out);
      return out;
    },
    async list(f: DeskFilter = {}) {
      const cols = f.column === undefined ? undefined : Array.isArray(f.column) ? f.column : [f.column];
      return [...items.values()].filter((i) => (!cols || cols.includes(i.column)) && (!f.project || i.project === f.project) && (!f.open || !i.closed));
    },
    async get(key) {
      return items.get(key);
    },
  };
}

const ctxOf = (api: DeskApi, over: Partial<DeskCallCtx> = {}): DeskCallCtx => ({
  api, by: 'session', source: 'session', session: 's1', project: () => 'shop', branch: async () => 'branch:/repo#feat/x', jiraHosts: () => [], why: 'из сессии', now: () => new Date('2026-11-19T10:00:00Z'), ...over,
});

test('ссылка на MR GitLab и PR GitHub дают ключ вещи с путём проекта в нижнем регистре', () => {
  const gl = resolveThing('https://GitLab.Company.com/Grp/App/-/merge_requests/12/diffs');
  assert.equal(gl.key, 'mr:gitlab.company.com/grp/app/12');
  assert.deepEqual(gl.thing?.ref, { forge: 'gitlab', host: 'gitlab.company.com', project: 'Grp/App', number: 12 });
  assert.equal(gl.thing?.url, 'https://gitlab.company.com/Grp/App/-/merge_requests/12');
  assert.equal(resolveThing('https://github.com/o/r/pull/7/files').key, 'mr:github.com/o/r/7');
  assert.equal(resolveThing('https://x.atlassian.net/browse/abc-12').key, 'jira:x.atlassian.net/ABC-12');
  assert.equal(resolveThing('https://jira.co/secure/RapidBoard.jspa?selectedIssue=PAY-3', { jiraHosts: ['jira.co'] }).key, 'jira:jira.co/PAY-3');
  assert.match(resolveThing('https://jira.co/browse/PAY-3').key, /^own:url-/, 'хост не Jira по настройкам — своё дело по адресу');
});

test('ключ вещи — как есть; другой адрес — своё дело с ключом по адресу; мусор — ошибка', () => {
  assert.deepEqual(resolveThing(' mr:GitLab.com/A/B/1 '), { key: 'mr:gitlab.com/a/b/1', thing: { type: 'mr', ref: { host: 'gitlab.com', project: 'a/b', number: 1 } } });
  assert.deepEqual(resolveThing('own:abc'), { key: 'own:abc' });
  assert.equal(resolveThing('jira:x.atlassian.net/abc-1').key, 'jira:x.atlassian.net/ABC-1');
  assert.equal(canonicalKey('mr:gitlab.co/Grp/App/5'), 'mr:gitlab.co/grp/app/5');
  assert.equal(canonicalKey('mr:gitlab.co/app/5'), undefined, 'у MR путь из группы и проекта');
  const a = resolveThing('https://docs.example.com/page');
  const b = resolveThing('https://docs.example.com/page');
  assert.match(a.key, /^own:url-[0-9a-f]{16}$/);
  assert.equal(a.key, b.key, 'тот же адрес — то же дело');
  assert.equal(a.link, 'https://docs.example.com/page');
  assert.throws(() => resolveThing('просто текст'), /Не ключ вещи/);
  assert.throws(() => resolveThing('mr:a b'), /Не ключ вещи/);
});

test('разбор desk_put: лишнее, типы, пустые строки, срок, колонка', () => {
  assert.throws(() => parsePutArgs({ title: 'x', status: 'y' }), /Лишние параметры: status/);
  assert.throws(() => parsePutArgs({ title: 5 }), /title — строка/);
  assert.throws(() => parsePutArgs({ title: '', thing: '' }), /Нужен thing/);
  assert.throws(() => parsePutArgs({ title: 'x', column: 'later' }), /column: new \| plan/);
  assert.throws(() => parsePutArgs({ title: 'x', due: 'завтра' }), /due — дата/);
  assert.throws(() => parsePutArgs({ title: 'x'.repeat(201) }), /title длиннее 200/);
  assert.deepEqual(parsePutArgs({ title: ' Купить\n  молоко\u001b ', due: '2026-12-01', column: 'plan', kind: '', text: 'строка 1\nстрока 2' }), {
    title: 'Купить молоко', due: '2026-12-01', column: 'plan', text: 'строка 1\nстрока 2',
  });
  assert.equal(parseDue('2026-12-01 10:00'), '2026-12-01T10:00');
});

test('разбор desk_close и desk_list', () => {
  assert.throws(() => parseCloseArgs({ thing: 'own:1' }), /Нужен reason/);
  assert.throws(() => parseCloseArgs({ reason: 'x' }), /Нужен thing/);
  assert.deepEqual(parseListArgs({ column: 'plan' }), { column: ['plan'] });
  assert.deepEqual(parseListArgs({ column: ['new', 'work'], closed: true, project: 'shop' }), { column: ['new', 'work'], closed: true, project: 'shop' });
  assert.throws(() => parseListArgs({ closed: 'yes' }), /closed — true или false/);
});

test('desk_put из сессии: своё дело — сессия, проект и ветка подставлены, сигнал от сессии', async () => {
  const api = memDesk();
  const r = await deskPut(ctxOf(api), { title: 'Ответить Пете', text: 'про релиз' });
  assert.equal(r.created, true);
  assert.match(r.item.key, /^own:/);
  const { patch, by } = api.puts[0];
  assert.equal(by, 'session');
  assert.deepEqual(patch.signal, { source: 'session', at: '2026-11-19T10:00:00.000Z', text: 'про релиз' });
  assert.deepEqual(patch.links, { sessions: ['s1'], branch: 'branch:/repo#feat/x' });
  assert.equal(patch.project, 'shop');
  assert.equal(patch.kind, 'Своё');
  assert.equal(patch.why, 'из сессии');
  assert.match(r.text, /^Дело заведено: own:.* — \[Новое\] Ответить Пете/);
});

test('desk_put по ссылке на MR дважды — одно дело, второй раз только сигнал; проект и ветку не перетирает', async () => {
  const api = memDesk();
  const url = 'https://gitlab.com/grp/app/-/merge_requests/5';
  const first = await deskPut(ctxOf(api), { thing: url });
  assert.equal(first.item.key, 'mr:gitlab.com/grp/app/5');
  assert.equal(api.puts[0].patch.kind, 'MR');
  assert.equal(api.puts[0].patch.title, 'MR grp/app!5', 'без заголовка — подпись вещи');
  assert.equal(api.puts[0].patch.links?.mr, url);
  assert.deepEqual(api.puts[0].patch.thing?.ref, { forge: 'gitlab', host: 'gitlab.com', project: 'grp/app', number: 5 });
  assert.equal(api.puts[0].patch.signal?.link, url);
  const again = await deskPut(ctxOf(api, { session: 's2', project: () => 'other' }), { thing: 'mr:gitlab.com/grp/app/5', text: 'ещё раз' });
  assert.equal(again.created, false);
  assert.equal(api.items.size, 1);
  const p2 = api.puts[1].patch;
  assert.equal(p2.project, undefined, 'проект у дела уже есть');
  assert.equal(p2.kind, undefined);
  assert.equal(p2.title, undefined);
  assert.equal(p2.why, undefined);
  assert.deepEqual(p2.links, { sessions: ['s2'] }, 'ветка у дела уже есть');
  assert.deepEqual(again.item.links.sessions, ['s1', 's2']);
  assert.match(again.text, /^Сигнал добавлен к делу: /);
});

test('desk_put у этапа flow: запуск в links.mentionedBy (не в runs) и в createdBy, рутина в сигнале, счётчик видит новое и повтор', async () => {
  const api = memDesk();
  const seen: boolean[] = [];
  const ctx = ctxOf(api, { by: 'flow', source: 'flow', session: undefined, run: 'r1', routine: 'review', branch: undefined, why: 'из запуска review', onPut: (_i, c) => seen.push(c) });
  await deskPut(ctx, { thing: 'jira:x.atlassian.net/ABC-1', title: 'Задача' });
  assert.deepEqual(api.puts[0].patch.thing, { type: 'jira', ref: { host: 'x.atlassian.net', key: 'ABC-1' } }, 'ключ строкой — вещь для наблюдателя');
  await deskPut(ctx, { thing: 'jira:x.atlassian.net/ABC-1' });
  assert.deepEqual(seen, [true, false]);
  assert.equal(api.puts[0].by, 'flow');
  assert.deepEqual(api.puts[0].patch.links, { mentionedBy: ['r1'] }, 'конец запуска why этого дела не перепишет');
  assert.deepEqual(api.puts[0].patch.createdBy, { run: 'r1', routine: 'review' });
  assert.equal(api.puts[1].patch.createdBy, undefined, 'у существующего дела createdBy не шлём');
  assert.equal(api.puts[0].patch.signal?.routine, 'review');
  assert.equal(api.puts[0].patch.kind, 'Jira');
});

test('desk_close: по ключу и по ссылке; нет дела — ошибка', async () => {
  const api = memDesk();
  await deskPut(ctxOf(api), { thing: 'https://github.com/o/r/pull/7', title: 'PR' });
  const r = await deskClose({ api, by: 'session' }, { thing: 'https://github.com/o/r/pull/7', reason: 'смержено' });
  assert.equal(r.item.closed?.reason, 'смержено');
  assert.match(r.text, /^Дело закрыто: mr:github\.com\/o\/r\/7 — \[закрыто: смержено\] PR/);
  await assert.rejects(deskClose({ api, by: 'session' }, { thing: 'own:none', reason: 'x' }), /Дела own:none нет/);
});

test('desk_list: открытые по умолчанию, колонка и проект в фильтре, строки с ключом', async () => {
  const api = memDesk();
  await deskPut(ctxOf(api), { title: 'Один', due: '2026-12-01' });
  await deskPut(ctxOf(api), { title: 'Два', column: 'plan' });
  const two = [...api.items.values()][1];
  await deskClose({ api, by: 'me' }, { thing: two.key, reason: 'готово' });
  const open = await deskList({ api }, {});
  assert.equal(open.items.length, 1);
  assert.match(open.text, /^own:.* — \[Новое\] Один \(Своё · shop · из сессии · срок 2026-12-01\)$/);
  assert.equal((await deskList({ api }, { closed: true })).items.length, 2);
  assert.equal((await deskList({ api }, { project: 'nope' })).text, 'Дел нет.');
  const calls: DeskFilter[] = [];
  await deskList({ api: { ...api, list: async (f) => (calls.push(f!), []) } }, { column: ['plan', 'work'], project: 'shop' });
  assert.deepEqual(calls, [{ column: ['plan', 'work'], project: 'shop', open: true }]);
});

test('deskCall: разбор и ответ по имени, чужой инструмент — undefined', async () => {
  const api = memDesk();
  assert.match((await deskCall('desk_put', { title: 'x' }, ctxOf(api)))!, /Дело заведено/);
  assert.match((await deskCall('desk_list', {}, ctxOf(api)))!, /\[Новое\] x/);
  assert.equal(await deskCall('other', {}, ctxOf(api)), undefined);
  await assert.rejects(deskCall('desk_put', { foo: 1 }, ctxOf(api)), /Лишние параметры/);
});

test('описания и схемы: подсказка вещи сессии, JSON Schema без $schema и без лишних полей', () => {
  const d = deskToolDescriptions('session', { thing: { key: 'mr:gitlab.com/a/b/1', title: 'Фикс' }, project: 'shop' });
  assert.match(d.desk_put, /thing: "mr:gitlab\.com\/a\/b\/1"/);
  assert.match(d.desk_put, /Сессия, проект и ветка подставятся сами/);
  assert.match(deskToolDescriptions('flow').desk_put, /Запуск, проект и ветка/);
  const s = deskInputSchemas();
  assert.equal(s.desk_put.$schema, undefined);
  assert.equal(s.desk_put.additionalProperties, false);
  assert.deepEqual(s.desk_close.required, ['thing', 'reason']);
  assert.deepEqual(Object.keys(s.desk_list.properties as object), ['column', 'project', 'closed']);
});

test('ключ ветки: основной checkout и текущая ветка; отделённый HEAD и не git — нет', async () => {
  const x = (head: string): Exec => async (_cmd, args) => {
    if (args.includes('--git-common-dir')) return '/repo/.git\n';
    if (args.includes('--abbrev-ref')) return head;
    throw new Error('?');
  };
  // repoRoot делает realpath корня: в тесте корня нет на диске — undefined
  assert.equal(await branchKeyOf('/nope', x('main\n')), undefined);
  const real = process.cwd();
  const y = (head: string): Exec => async (_cmd, args) => (args.includes('--git-common-dir') ? `${real}/.git\n` : head);
  const fs = await import('node:fs');
  const root = fs.realpathSync(real);
  assert.equal(await branchKeyOf(real, y('feat/x\n')), `branch:${root}#feat/x`);
  assert.equal(await branchKeyOf(real, y('HEAD\n')), undefined);
  assert.equal(await branchKeyOf(real, async () => { throw new Error('не git'); }), undefined);
});

test('agentgraph desk add: заголовок или ссылка с заголовком; проект по папке или --project; by me, сигнал от cli', async () => {
  const api = memDesk();
  const ctx = { api: () => api, jiraHosts: () => [], project: () => 'shop', hasProject: (s: string) => s === 'shop' || s === 'pay', now: () => new Date('2026-11-19T10:00:00Z') };
  const a = await deskCommand('add', ['Позвонить', 'в', 'банк'], { due: '2026-11-20' }, ctx);
  assert.equal(a.code, 0);
  assert.match(a.lines[0], /^Дело заведено: own:.* — \[Новое\] Позвонить в банк \(Своё · shop · заведено из командной строки · срок 2026-11-20\)$/);
  assert.equal(api.puts[0].by, 'me');
  assert.equal(api.puts[0].patch.signal?.source, 'cli');
  assert.equal(api.puts[0].patch.links, undefined, 'сессии, запуска и ветки у командной строки нет');
  await deskCommand('add', ['https://github.com/o/r/pull/7', 'Ревью', 'PR'], { project: 'pay', kind: 'Ревью', column: ['plan'] }, ctx);
  assert.deepEqual([api.puts[1].key, api.puts[1].patch.title, api.puts[1].patch.project, api.puts[1].patch.kind, api.puts[1].patch.column], ['mr:github.com/o/r/7', 'Ревью PR', 'pay', 'Ревью', 'plan']);
  await assert.rejects(deskCommand('add', [], {}, ctx), /Укажи заголовок или ссылку/);
  await assert.rejects(deskCommand('add', ['x'], { project: 'nope' }, ctx), /Пространства nope нет/);
  await assert.rejects(deskCommand('add', ['x'], { column: ['new', 'plan'] }, ctx), /одна --column/);
  await assert.rejects(deskCommand('add', ['x'], { column: ['later'] }, ctx), /column: new/);
});

test('agentgraph desk list и close: колонки, причина по умолчанию, чужие флаги и неизвестная команда — ошибка', async () => {
  const api = memDesk();
  const ctx = { api: () => api, jiraHosts: () => [], project: () => undefined, hasProject: () => true };
  await deskCommand('add', ['Один'], {}, ctx);
  const key = api.puts[0].key;
  assert.deepEqual((await deskCommand('list', [], { column: ['plan'] }, ctx)).lines, ['Дел нет.']);
  assert.match((await deskCommand('list', [], {}, ctx)).lines[0], /\[Новое\] Один/);
  const c = await deskCommand('close', [key], {}, ctx);
  assert.match(c.lines[0], /\[закрыто: закрыто вручную\]/);
  await deskCommand('add', ['Два'], {}, ctx);
  await deskCommand('close', [api.puts[1].key, 'уже', 'не', 'нужно'], {}, ctx);
  assert.equal([...api.items.values()][1].closed?.reason, 'уже не нужно');
  await assert.rejects(deskCommand('close', [key], { kind: 'x' }, ctx), /--kind — не для desk close/);
  await assert.rejects(deskCommand('list', [], { due: '2026-01-01' }, ctx), /--due — не для desk list/);
  await assert.rejects(deskCommand('close', [], {}, ctx), /Укажи ключ дела/);
  await assert.rejects(deskCommand('move', [], {}, ctx), /desk: add, list или close/);
});

test('ключ вещи места вызова (собран мимо keys.ts) и ссылка на неё — одно дело; вещь берётся целиком с заголовком', async () => {
  const api = memDesk();
  const known: Thing = { type: 'mr', key: 'mr:gitlab.co/Grp/App/5', ref: { forge: 'gitlab', host: 'gitlab.co', project: 'Grp/App', number: 5 }, url: 'https://gitlab.co/Grp/App/-/merge_requests/5', title: 'Фикс корзины' };
  const ctx = ctxOf(api, { thing: known });
  const a = await deskPut(ctx, { thing: 'mr:gitlab.co/Grp/App/5' });
  assert.equal(a.item.key, 'mr:gitlab.co/grp/app/5');
  const p = api.puts[0].patch;
  assert.equal(p.title, 'Фикс корзины');
  assert.deepEqual(p.thing, { type: 'mr', ref: known.ref, url: known.url });
  assert.equal(p.links?.mr, known.url);
  assert.equal(p.signal?.link, known.url);
  const b = await deskPut(ctxOf(api), { thing: 'https://gitlab.co/Grp/App/-/merge_requests/5' });
  assert.equal(b.created, false);
  assert.equal(api.items.size, 1);
  const d = deskToolDescriptions('flow', { thing: { key: known.key, title: 'Фикс «x»\u001b]52;c;AAA\u0007 ' + 'я'.repeat(200) } });
  assert.match(d.desk_put, /о вещи mr:gitlab\.co\/grp\/app\/5 \(«Фикс x ]52;c;AAA я+»\)/);
  assert.ok(!/[\u0000-\u001f]/.test(d.desk_put), 'управляющих символов в описании нет');
  assert.ok(d.desk_put.length < 1000);
});

test('своё дело по адресу без title — заголовок из адреса; без title и без вещи — ошибка', async () => {
  const api = memDesk();
  await deskPut(ctxOf(api), { thing: 'https://docs.example.com/page' });
  assert.equal(api.puts[0].patch.title, 'https://docs.example.com/page');
  await assert.rejects(deskPut(ctxOf(api), {}), /нужен title/);
});

test('новое дело считается один раз: второй put той же вещи, не видевший первого, — сигнал', async () => {
  const api = memDesk();
  const seen: boolean[] = [];
  const blind: DeskApi = { ...api, get: async () => undefined };
  const ctx = ctxOf(blind, { onPut: (_i, c) => seen.push(c) });
  await deskPut(ctx, { thing: 'own:x', title: 'x' });
  await deskPut(ctx, { thing: 'own:x', title: 'x' });
  assert.deepEqual(seen, [true, false]);
});

test('desk_close с owns: чужое дело — ошибка, хранилище не трогается; своё — закрывается', async () => {
  const api = memDesk();
  await deskPut(ctxOf(api), { thing: 'own:a', title: 'a' });
  await deskPut(ctxOf(api), { thing: 'own:b', title: 'b' });
  const ctx = { api, by: 'flow' as const, owns: (i: DeskItem) => i.key === 'own:b' };
  await assert.rejects(deskClose(ctx, { thing: 'own:a', reason: 'x' }), /Дело own:a завёл не этот запуск/);
  assert.equal(api.items.get('own:a')?.closed, undefined);
  assert.equal((await deskClose(ctx, { thing: 'own:b', reason: 'готово' })).item.closed?.reason, 'готово');
  await assert.rejects(deskClose(ctx, { thing: 'own:nope', reason: 'x' }), /Дела own:nope нет/);
});

test('desk_put с owns: к чужому делу — только сигнал с onRepeat keep, без why, срока, заголовка, колонки и ссылок, кроме mentionedBy', async () => {
  const api = memDesk();
  await deskPut(ctxOf(api), { thing: 'own:a', title: 'a', why: 'моё' });
  const ctx = ctxOf(api, { by: 'flow', source: 'flow', session: undefined, run: 'r9', owns: () => false });
  const r = await deskPut(ctx, { thing: 'own:a', title: 'Новый', why: 'взлом', due: '2030-01-01', column: 'done', kind: 'X', text: 'привет' });
  assert.equal(r.created, false);
  assert.match(r.text, /^Только сигнал \(завёл не этот запуск; title, kind, why, due, column не применены\)/);
  const p = api.puts[1].patch;
  assert.deepEqual(Object.keys(p).sort(), ['links', 'onRepeat', 'signal']);
  assert.equal(p.onRepeat, 'keep');
  assert.deepEqual(p.links, { mentionedBy: ['r9'] });
  assert.equal(p.signal?.text, 'привет');
});

test('строка дела — без управляющих символов и переводов строк: заголовки из Slack печатает терминал', () => {
  const i = { id: '1', key: 'own:1', kind: 'Своё', title: 'Hi\u001b]52;c;QUJD\u0007\nthere', column: 'new', why: 'a\u009bb', signals: [], links: { runs: [], sessions: [] }, createdAt: '', movedAt: '', movedBy: 'me' } as DeskItem;
  assert.equal(itemLine(i), 'own:1 — [Новое] Hi]52;c;QUJD there (Своё · ab)');
});

test('desk_put с owns: своё дело, закрытое не этим запуском (руками), — только сигнал, не переоткрывается; закрытое им самим — как обычно', async () => {
  const api = memDesk();
  const ctx = ctxOf(api, { by: 'flow', source: 'flow', session: undefined, run: 'r1', owns: () => true });
  await deskPut(ctx, { thing: 'own:a', title: 'a' });
  api.items.set('own:a', { ...api.items.get('own:a')!, column: 'done', closed: { at: '', reason: 'руками' }, movedBy: 'me' });
  const r = await deskPut(ctx, { thing: 'own:a', why: 'снова' });
  assert.match(r.text, /^Только сигнал \(закрыто не этим запуском; why не применены\)/);
  assert.equal(api.puts.at(-1)!.patch.onRepeat, 'keep');
  api.items.set('own:a', { ...api.items.get('own:a')!, movedBy: 'flow' });
  await deskPut(ctx, { thing: 'own:a', why: 'снова' });
  assert.equal(api.puts.at(-1)!.patch.why, 'снова');
  assert.equal(api.puts.at(-1)!.patch.onRepeat, undefined);
});

test('ключ ветки собирается через branchKey: тот же вид, что у наблюдателя ветки', async () => {
  const real = process.cwd();
  const fs = await import('node:fs');
  const { branchKey } = await import('../things/keys.js');
  const x: Exec = async (_cmd, args) => (args.includes('--git-common-dir') ? `${real}/.git\n` : 'refs/heads/feat/y\n');
  assert.equal(await branchKeyOf(real, x), branchKey(fs.realpathSync(real), 'feat/y'));
});

test('ключ с пробелом (своё дело рутины из desk_list): desk_put и desk_close находят заведённое; нового не заводят', async () => {
  const api = memDesk();
  await api.put('own:folder/a b.md@1', { title: 'файл' }, 'routine');
  const put = await deskPut(ctxOf(api), { thing: 'own:folder/a b.md@1', text: 'глянул' });
  assert.deepEqual([put.created, put.item.key], [false, 'own:folder/a b.md@1']);
  const r = await deskClose({ api, by: 'session' }, { thing: 'own:folder/a b.md@1', reason: 'разобрал' });
  assert.equal(r.item.closed?.reason, 'разобрал');
  await assert.rejects(deskPut(ctxOf(api), { thing: 'own:нет такого файла', title: 'x' }), /Не ключ вещи/);
});

test('desk_close: afterClose дописывает к ответу (у сессии — предложение записать знание), пусто — только «закрыто»', async () => {
  const api = memDesk();
  await api.put('own:a', { title: 'a' }, 'me');
  await api.put('own:b', { title: 'b' }, 'me');
  const ctx = { api, by: 'session' as const, afterClose: (i: DeskItem) => (i.key === 'own:a' ? 'Предложи записать вывод' : undefined) };
  assert.match((await deskClose(ctx, { thing: 'own:a', reason: 'готово' })).text, /^Дело закрыто: .*\nПредложи записать вывод$/);
  assert.doesNotMatch((await deskClose(ctx, { thing: 'own:b', reason: 'готово' })).text, /\n/);
});
