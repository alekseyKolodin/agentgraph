import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunSummary, SessionView, TagListItem } from '@server/api-types';
import type { DeskItem, DeskWeekReply } from '@server/desk/types';
import { closedWorkFrom, kindSlug, learnCandidates, noteContext, staleText, tagForKind, weekLine } from './desk-month';

const NOW = new Date('2026-11-19T12:00:00.000Z');
function item(key: string, o: Partial<DeskItem> = {}): DeskItem {
  return { id: key, key, kind: 'Ревью', title: key, column: 'plan', why: '', signals: [], links: { runs: [], sessions: [] }, createdAt: '2026-11-10T10:00:00.000Z', movedAt: '2026-11-18T10:00:00.000Z', movedBy: 'me', ...o };
}
const closed = (key: string, o: Partial<DeskItem> = {}) => item(key, { column: 'done', closed: { at: '2026-11-19T10:00:00.000Z', reason: 'смержен' }, ...o });
const run = (id: string, root?: string, status = 'done') => ({ id, status, ...(root ? { root } : {}) }) as RunSummary;
const session = (id: string, live = false) => ({ id, live }) as SessionView;

test('работа закрытых дел уходит с глаз: запуск и сессия только закрытого дела; связанные и с открытым — остаются; продолжение — по корню', () => {
  const f = closedWorkFrom([
    closed('own:a', { links: { runs: ['r1'], sessions: ['s1'], mentionedBy: ['r3'] }, createdBy: { run: 'r4' } }),
    closed('own:b', { links: { runs: ['r2'], sessions: ['s2'] } }),
    item('own:c', { links: { runs: ['r2'], sessions: [] }, createdBy: { session: 's2' } }),
  ])!;
  assert.deepEqual(['r1', 'r2', 'r3', 'r4', 'r9'].map((id) => f.run!(run(id))), [true, false, true, true, false]);
  assert.equal(f.run!(run('r1-cont', 'r1')), true);
  assert.equal(f.run!(run('r2-cont', 'r2')), false);
  assert.deepEqual(['s1', 's2', 's9'].map((id) => f.session!(session(id))), [true, false, false]);
  // дело закрыли посреди хода: живая сессия и идущий или ждущий запуск остаются
  assert.equal(f.session!(session('s1', true)), false);
  assert.deepEqual(['running', 'waiting', 'paused'].map((st) => f.run!(run('r1', undefined, st))), [false, false, false]);
  assert.equal(closedWorkFrom([item('own:c', { links: { runs: ['r1'], sessions: [] } })]), null);
});

test('записать знание: закрытые за три дня дела, где был запуск или сессия; закрытое наблюдателем без работы и отклонённое — нет', () => {
  const items = [
    closed('own:a', { links: { runs: ['r1'], sessions: [] } }),
    closed('own:watcher', { movedBy: 'watcher' }),
    closed('own:old', { links: { runs: [], sessions: ['s1'] }, closed: { at: '2026-11-10T10:00:00.000Z', reason: 'x' } }),
    closed('own:skip', { links: { runs: [], sessions: ['s1'] } }),
    item('own:open', { links: { runs: ['r2'], sessions: [] } }),
    closed('own:session', { links: { runs: [], sessions: [] }, createdBy: { session: 's3' }, closed: { at: '2026-11-19T11:00:00.000Z', reason: 'готово' } }),
  ];
  assert.deepEqual(learnCandidates(items, new Set(['own:skip']), NOW).map((i) => i.key), ['own:session', 'own:a']);
  // дело живо: своё, переложенное на вещь, и закрытая запись под открытым делом поставщика с тем же ключом
  const alive = [
    closed('own:linked', { links: { runs: ['r1'], sessions: [] }, closed: { at: '2026-11-19T10:00:00.000Z', reason: 'привязано к MR g/app!12' } }),
    closed('tw:t/p/PAY-1', { links: { runs: [], sessions: ['s1'] }, closed: { at: '2026-11-19T10:00:00.000Z', reason: 'стала задачей Teamwork' } }),
    item('tw:t/p/PAY-1', { links: { runs: [], sessions: ['s1'] } }),
  ];
  assert.deepEqual(learnCandidates(alive, new Set(), NOW), []);
});

test('тег по виду работы: найденный по заголовку или слагу; нет — новый со слагом латиницей', () => {
  const tags = [{ slug: 'code-review', kind: 'knowledge', title: 'Ревью', updatedAt: '', runs: 0, preview: '' }] as TagListItem[];
  assert.deepEqual(tagForKind('ревью ', tags), { slug: 'code-review', title: 'Ревью', exists: true });
  assert.deepEqual(tagForKind('Разбор встреч', tags), { slug: 'razbor-vstrech', title: 'Разбор встреч', exists: false });
  assert.equal(kindSlug('MR'), 'mr');
  assert.equal(kindSlug('!!!'), 'work');
});

test('черновик записи и строки обзора', () => {
  assert.equal(noteContext(closed('own:a', { title: 'Починить вход', why: 'автор ответил' })), '«Починить вход»: смержен — автор ответил');
  const w = { from: '', to: '', days: 7, staleDays: 7, closed: [{}, {}], closedTotal: 2, stale: [{}], staleTotal: 1, arrived: { total: 3, routines: [], other: 3 }, moves: 9 } as unknown as DeskWeekReply;
  assert.equal(staleText(w), 'Висит дольше 7 дней: 1');
  assert.equal(staleText({ ...w, stale: [], staleTotal: 0 }), undefined);
  assert.equal(staleText({ ...w, staleTotal: 80 }), 'Висит дольше 7 дней: 80');
  assert.equal(staleText({ ...w, staleDays: 1 }), 'Висит дольше 1 дня: 1');
  assert.equal(weekLine(w), 'закрыто 2 · пришло 3 · движений 9');
});
