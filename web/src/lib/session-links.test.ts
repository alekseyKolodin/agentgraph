import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appPathOf, flowForSession, runForSession, terminalLinks } from './session-links';

test('ссылки в терминале: адрес своего сервера с любым портом — путь экрана; знаки препинания в конце — не часть ссылки', () => {
  const line = 'Запуск идёт: http://127.0.0.1:52364/run/2026-11-21_12-00-00-fix. Смотри и http://localhost:4750/flow/fix-and-review, ок';
  const links = terminalLinks(line);
  assert.deepEqual(links.map((l) => [l.text, l.path]), [
    ['http://127.0.0.1:52364/run/2026-11-21_12-00-00-fix', '/run/2026-11-21_12-00-00-fix'],
    ['http://localhost:4750/flow/fix-and-review', '/flow/fix-and-review'],
  ]);
  // позиции — по строке: выделится ровно адрес
  assert.equal(line.slice(links[0]!.start, links[0]!.end), links[0]!.text);
});

test('ссылки в терминале: id запуска сам по себе — ссылка на запуск; в адресе — не вторая ссылка', () => {
  const links = terminalLinks('│ Запуск 2026-11-21_12-00-00-fix-and-review-2 начат, смотри /x/runs/2026-10-30_00-18-58-kai-mvp/run.json');
  assert.deepEqual(links.map((l) => l.path), ['/run/2026-11-21_12-00-00-fix-and-review-2', '/run/2026-10-30_00-18-58-kai-mvp']);
  assert.equal(terminalLinks('http://127.0.0.1:1/run/2026-11-21_12-00-00-a').length, 1);
});

test('ссылки в терминале: чужие адреса, другие пути и похожие на дату строки — не ссылки', () => {
  assert.deepEqual(terminalLinks('https://gitlab.com/run/x http://127.0.0.1:3000/api/runs 2026-11-21 12-00 v2026-11-21_12-00'), []);
});

test('OSC 8: свой сервер — путь внутри приложения, остальное — null', () => {
  assert.equal(appPathOf('http://127.0.0.1:52364/run/2026-11-21_12-00-00-fix'), '/run/2026-11-21_12-00-00-fix');
  assert.equal(appPathOf('http://localhost:4750/sessions/abc?x=1'), '/sessions/abc?x=1');
  assert.equal(appPathOf('https://example.com/run/1'), null);
  assert.equal(appPathOf('http://127.0.0.1:52364/api/runs'), null);
  assert.equal(appPathOf('javascript:alert(1)'), null);
});

test('«Для сессии»: о запуске — id, flow_status и папка; о flow — путь, flow_run и flow_write', () => {
  const r = runForSession({ id: '2026-11-21_12-00-00-fix', flow: 'fix', title: 'Ускорить сборку', runDir: '/home/runs/2026-11-21_12-00-00-fix' });
  assert.match(r, /«Ускорить сборку» \(flow fix\), id 2026-11-21_12-00-00-fix/);
  assert.match(r, /flow_status с run: "2026-11-21_12-00-00-fix"/);
  assert.match(r, /\/home\/runs\/2026-11-21_12-00-00-fix$/);
  assert.match(runForSession({ id: 'x', flow: 'fix', runDir: '/r' }), /«fix»/);
  const f = flowForSession({ name: 'fix', file: '/home/flows/lib/fix.yaml' });
  assert.match(f, /«fix» — \/home\/flows\/lib\/fix\.yaml/);
  assert.match(f, /flow_run с flow: "fix"/);
});
