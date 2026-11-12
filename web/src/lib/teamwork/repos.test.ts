import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloneCommand, draftFromInfo, draftState, freeKey, keyFromUrl, keyOf, reposBody, typedDraft, withUrl, type RepoDraft } from './repos';

test('репо из папки: с origin — готовая строка со ссылкой, веткой и папкой; без origin — ручная строка с папкой', () => {
  const d = draftFromInfo({ path: '/u/code/billing', key: 'billing', url: 'git@github.com:acme/billing.git', defaultBranch: 'main' }, []);
  assert.deepEqual({ ...d, id: 0 }, { id: 0, key: 'billing', url: 'git@github.com:acme/billing.git', defaultBranch: 'main', local: '/u/code/billing', typed: false });
  const lonely = draftFromInfo({ path: '/u/lonely', key: 'lonely', defaultBranch: 'trunk', problem: 'no_origin' }, ['lonely']);
  assert.deepEqual([lonely.key, lonely.url, lonely.local, lonely.typed], ['lonely-2', '', '/u/lonely', true]);
  // негодный origin в ссылку не попадает
  assert.equal(draftFromInfo({ path: '/u/odd', key: 'odd', url: 'not a link', problem: 'bad_origin' }, []).url, '');
});

test('свободный ключ: занятый получает -2, -3; регистр не важен', () => {
  assert.equal(freeKey('billing', []), 'billing');
  assert.equal(freeKey('billing', ['Billing']), 'billing-2');
  assert.equal(freeKey('billing', ['billing', 'billing-2']), 'billing-3');
});

test('строки формы: пустая ручная пропускается, без ссылки, плохой ключ и повторы держат кнопку; папка уходит в local', () => {
  const ok: RepoDraft = { id: 1, key: 'billing', url: 'git@github.com:acme/billing.git', defaultBranch: 'main', local: '/u/billing', typed: false };
  const empty = { ...typedDraft(), id: 2 };
  assert.equal(draftState(empty, [ok, empty]), 'empty');
  assert.deepEqual(reposBody([ok, empty]), [{ key: 'billing', url: 'git@github.com:acme/billing.git', defaultBranch: 'main', local: '/u/billing' }]);
  // папка без origin: пока нет ссылки — не добавится
  const noUrl: RepoDraft = { id: 3, key: 'lonely', url: '', local: '/u/lonely', typed: true };
  assert.equal(draftState(noUrl, [noUrl]), 'no_url');
  assert.equal(reposBody([ok, noUrl]), undefined);
  assert.deepEqual(reposBody([{ ...noUrl, url: 'git@github.com:acme/lonely.git' }]), [{ key: 'lonely', url: 'git@github.com:acme/lonely.git', local: '/u/lonely' }]);
  assert.equal(draftState({ ...ok, key: 'плохой' }, [ok]), 'bad_key');
  assert.equal(draftState({ ...ok, key: '' }, [ok]), 'no_key');
  const twin: RepoDraft = { ...ok, id: 4, url: 'git@github.com:acme/other.git' };
  assert.equal(draftState(twin, [ok, twin]), 'dup_key');
  // повтор с уже сохранёнными репо проекта
  assert.equal(draftState({ ...ok, key: 'x' }, [], [{ key: 'billing', url: ok.url }]), 'dup_url');
  // ручная строка без папки — без local
  assert.deepEqual(reposBody([{ id: 5, key: 'a', url: 'https://git.example/a.git', typed: true }]), [{ key: 'a', url: 'https://git.example/a.git' }]);
});

test('подсказка клонирования: обычная ссылка как есть, с пробелом — в кавычках', () => {
  assert.equal(cloneCommand('git@github.com:acme/billing.git'), 'git clone git@github.com:acme/billing.git');
  assert.equal(cloneCommand('/Volumes/My Drive/repo.git'), "git clone '/Volumes/My Drive/repo.git'");
});

test('ключ по ссылке: последний сегмент без .git; следует за ссылкой, пока его не правили руками', () => {
  assert.equal(keyFromUrl('git@github.com:acme/billing.git'), 'billing');
  assert.equal(keyFromUrl('https://gitlab.example/group/Sub Group/My.Repo.git/'), 'my-repo');
  assert.equal(keyFromUrl(''), '');
  assert.equal(keyOf('---'), '');
  let d = withUrl(typedDraft(), 'git@github.com:acme/adapter', ['ledger']);
  assert.equal(d.key, 'adapter');
  d = withUrl(d, 'git@github.com:acme/adapter.git', []);
  assert.equal(d.key, 'adapter');
  d = withUrl(d, 'git@github.com:acme/ledger.git', ['ledger']);
  assert.equal(d.key, 'ledger-2');
  // правленый руками ключ ссылка не трогает
  d = withUrl({ ...d, key: 'mine' }, 'git@github.com:acme/other.git', []);
  assert.equal(d.key, 'mine');
});
