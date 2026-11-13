// Правки сессии терминала в своём пространстве и во flow: решение хука записи до вызова и проверка после.
// Папка flow и папка настроек — временные: AGENTGRAPH_HOME задаётся до импорта (paths.ts читает его при загрузке).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sedit-')));
const prevHome = process.env.AGENTGRAPH_HOME;
const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
process.env.AGENTGRAPH_HOME = home;
process.env.AGENTGRAPH_CONFIG_DIR = path.join(home, 'cfg');
const { bashDecision, classifyEdit, cwdSpace, editDecision, flowWriteDetail, recheckEdit, spaceSettingsDetail, textAfter } = await import('./session-edit.js');
const { createSpace, spaceDir, spacesDir } = await import('./spaces.js');
const { saveFlowYaml } = await import('./flows.js');
const { FLOWS_DIR } = await import('./paths.js');
const { tagsDir } = await import('./tags.js');
const { teamsDir } = await import('./teamwork.js');
const { configDir } = await import('./settings.js');
type Scope = import('./session-edit.js').EditScope;

after(() => {
  if (prevHome === undefined) delete process.env.AGENTGRAPH_HOME;
  else process.env.AGENTGRAPH_HOME = prevHome;
  if (prevCfg === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
  else process.env.AGENTGRAPH_CONFIG_DIR = prevCfg;
  fs.rmSync(home, { recursive: true, force: true });
});

const proj = path.join(home, 'proj');
fs.mkdirSync(proj, { recursive: true });
createSpace('feat', { title: 'Корзина', gist: 'чиним корзину' });
createSpace('other', { gist: 'чужое' });
fs.mkdirSync(path.join(spaceDir('feat'), 'docs'), { recursive: true });
const leaf = (name: string) => `name: ${name}\nphases:\n  - { name: a, tools: [], prompt: x }\n`;
saveFlowYaml('fix-bug', leaf('fix-bug'), 'lib');

const scope = (o: Partial<Scope> = {}): Scope => ({ cwd: proj, spaces: ['feat'], flowsDir: FLOWS_DIR, ...o });
const decide = (file: string, input: Record<string, unknown> = { content: 'x' }, o: Partial<Scope> = {}, tool = 'Write') => editDecision(scope(o), tool, { file_path: file, ...input });
const own = (name: string) => path.join(spaceDir('feat'), name);

test('запись: своё пространство — вопрос с подробностями по каждой части; чужое, папка пространств, теги, команды и служебные файлы настроек — отказ; проект — решают правила', () => {
  const ask = (file: string, input?: Record<string, unknown>) => {
    const d = decide(file, input);
    assert.equal(d?.decision, 'ask', `${file}: ${JSON.stringify(d)}`);
    return d!.reason;
  };
  assert.match(ask(own('CLAUDE.md'), { content: '# Корзина' }), /^agentgraph: пространство feat — карта \(CLAUDE\.md\): её получат памятью все следующие сессии и запуски пространства\./);
  assert.match(ask(own('STATE.md'), { content: 'Суть' }), /состояние \(STATE\.md\)/);
  assert.match(ask(own('docs/spec.md')), /документ: его увидят следующие сессии/);
  assert.match(ask(own('.claude/settings.json')), /\.claude\/: настройки, скиллы и команды грузятся во все его сессии/);
  assert.match(ask(own('notes/x.md')), /файл в папке пространства/);
  const deny = (file: string) => {
    const d = decide(file);
    assert.equal(d?.decision, 'deny', file);
    return d!.reason;
  };
  assert.match(deny(path.join(spaceDir('other'), 'CLAUDE.md')), /в другом пространстве \(other\): сессия правит только своё пространство \(feat\)/);
  assert.match(deny(path.join(spacesDir(), '.migrated.json')), /в папке пространств, но не в пространстве этой сессии/);
  assert.match(deny(path.join(spacesDir(), 'brand-new', 'CLAUDE.md')), /в другом пространстве \(brand-new\)/);
  assert.match(deny(path.join(tagsDir(), 'qa', 'notes.md')), /в папке тегов знаний/);
  assert.match(deny(path.join(teamsDir(), 'pay', 'repo', 'x.md')), /в папке команд Teamwork/);
  assert.match(deny(path.join(configDir(), 'settings.json')), /служебный файл agentgraph/);
  assert.match(deny(path.join(configDir(), 'jira-token')), /служебный файл agentgraph/);
  // без пространства своё — ничьё: отказ и в его папке
  assert.match(editDecision(scope({ spaces: [] }), 'Write', { file_path: own('CLAUDE.md'), content: 'x' })!.reason as string, /только когда оно выбрано у сессии/);
  // проект, чтение и не пути — не дело хука
  assert.equal(decide(path.join(proj, 'src', 'a.ts')), undefined);
  assert.equal(editDecision(scope(), 'Read', { file_path: own('CLAUDE.md') }), undefined);
  assert.equal(editDecision(scope(), 'Write', { content: 'x' }), undefined);
});

test('запись: регистр, ссылка и относительный путь не уводят мимо — путь сверяется по realpath и без учёта регистра', () => {
  const upper = path.join(configDir(), 'SPACES', 'other', 'CLAUDE.md');
  assert.equal(decide(upper)?.decision, 'deny');
  assert.equal(decide(path.join(configDir(), 'Tags', 'qa', 'x.md'))?.decision, 'deny');
  // относительный путь — от рабочей папки claude в момент вызова
  const docs = path.join(spaceDir('feat'), 'docs');
  assert.equal(editDecision(scope({ toolCwd: docs }), 'Write', { file_path: '../../other/CLAUDE.md', content: 'x' })?.decision, 'deny');
  assert.equal(editDecision(scope({ toolCwd: docs }), 'Write', { file_path: 'spec.md', content: 'x' })?.decision, 'ask');
  // ссылка из проекта в чужое пространство
  const link = path.join(proj, 'sneaky');
  fs.symlinkSync(spaceDir('other'), link);
  assert.equal(decide(path.join(link, 'CLAUDE.md'))?.decision, 'deny');
  // .CLAUDE/ своего — тоже .claude/
  assert.match(decide(own('.CLAUDE/settings.json'))!.reason, /\.claude\//);
});

test('запись: у claude без onFailure: block пространство, выбранное на ходу, файлами не правится — подсказка про инструменты space_* и «Перезапустить»', () => {
  const d = decide(own('CLAUDE.md'), { content: 'x' }, { launched: ['other'] });
  assert.equal(d?.decision, 'deny');
  assert.match(d!.reason, /выбрано на ходу.*space_map_write.*«Перезапустить»/s);
  assert.equal(decide(own('CLAUDE.md'), { content: 'x' }, { launched: ['feat'] })?.decision, 'ask');
});

test('space.json: проверяется до вопроса, как у API — лишнее поле, чужой слаг, папка шире разумного, не JSON — отказ с ошибками; вопрос называет новые папки чтения', () => {
  const meta = own('space.json');
  const cur = JSON.parse(fs.readFileSync(meta, 'utf8')) as Record<string, unknown>;
  const write = (o: Record<string, unknown> | string) => decide(meta, { content: typeof o === 'string' ? o : JSON.stringify(o) });
  const specs = path.join(home, 'specs');
  fs.mkdirSync(specs);
  const ok = write({ ...cur, dirs: [specs], title: 'Корзина 2' });
  assert.equal(ok?.decision, 'ask');
  assert.match(ok!.reason, /настройки \(space\.json\)/);
  assert.match(ok!.reason, new RegExp(`заголовок → «Корзина 2»; откроет на чтение всем сессиям и запускам пространства: ${specs}`));
  // снимок до записи — для отката после
  assert.equal(ok?.decision === 'ask' && ok.before, fs.readFileSync(meta, 'utf8'));
  const bad = (o: Record<string, unknown> | string, re: RegExp) => {
    const d = write(o);
    assert.equal(d?.decision, 'deny', JSON.stringify(o));
    assert.match(d!.reason, re);
    assert.match(d!.reason, /Файл не записан — исправь и повтори/);
  };
  bad({ ...cur, dir: ['/x'] }, /лишние поля: dir/);
  bad({ ...cur, slug: 'other' }, /slug — имя папки пространства \(feat\)/);
  bad({ ...cur, dirs: [os.homedir()] }, /домашняя папка целиком/);
  bad({ ...cur, dirs: ['relative/x'] }, /абсолютный путь/);
  bad({ ...cur, cwd: path.join(home, 'nope') }, /Рабочей папки .* нет/);
  bad({ ...cur, createdAt: 'вчера' }, /createdAt — дата ISO строкой/);
  bad('{ "slug": ', /не JSON/);
  bad('[]', /JSON-объект/);
  // рабочая папка, которой уже нет, правке заголовка не мешает: неизменённое не перепроверяется (как у API)
  fs.writeFileSync(meta, JSON.stringify({ ...cur, cwd: path.join(home, 'gone') }));
  assert.equal(write({ ...cur, cwd: path.join(home, 'gone'), title: 'Новый' })?.decision, 'ask');
  // сломанный space.json правкой чинится
  fs.writeFileSync(meta, '{ broken');
  assert.equal(write(cur)?.decision, 'ask');
  fs.writeFileSync(meta, JSON.stringify(cur, null, 2));
});

test('space.json: history, migratedFrom и createdAt ведёт agentgraph — подделать их нельзя (history открыла бы чужие артефакты всем сессиям пространства)', () => {
  const meta = own('space.json');
  const cur = JSON.parse(fs.readFileSync(meta, 'utf8')) as Record<string, unknown>;
  const write = (o: Record<string, unknown>) => decide(meta, { content: JSON.stringify(o) });
  const forged = [
    { ...cur, history: [{ id: 'someone-elses-run', at: '2026-11-01T00:00:00.000Z', kind: 'run' }] },
    { ...cur, migratedFrom: { tag: 'x', at: '2026-01-01T00:00:00.000Z', runs: ['r1'] } },
    { ...cur, createdAt: '2020-01-01T00:00:00.000Z' },
  ];
  for (const o of forged) {
    const d = write(o);
    assert.equal(d?.decision, 'deny', JSON.stringify(o));
    assert.match(d!.reason, /ведёт agentgraph: их не меняют/);
  }
  // updatedAt и заголовок — можно; history как была — можно
  assert.equal(write({ ...cur, updatedAt: '2026-11-13T00:00:00.000Z', title: 'Т' })?.decision, 'ask');
  // и после записи: подделку, прошедшую мимо проверки до записи, сверка со снимком ловит и откатывает
  const before = fs.readFileSync(meta, 'utf8');
  fs.writeFileSync(meta, JSON.stringify(forged[0]));
  const target = (classifyEdit(scope(), 'Write', { file_path: meta, content: '' }) as { target: import('./session-edit.js').EditTarget }).target;
  assert.match(recheckEdit(target, before)!, /history ведёт agentgraph.*Возвращена версия до записи/);
  assert.equal(fs.readFileSync(meta, 'utf8'), before);
  // папки после записи сверяются со снимком, а не с уже записанным файлом: «/» не проходит и тут
  fs.writeFileSync(meta, JSON.stringify({ ...cur, dirs: ['/'] }));
  assert.match(recheckEdit(target, before)!, /корень диска.*Возвращена версия до записи/);
  assert.equal(fs.readFileSync(meta, 'utf8'), before);
});

test('карта и состояние длиннее предела API — отказ до вопроса; Edit считается по тексту файла', () => {
  assert.match(decide(own('CLAUDE.md'), { content: 'x'.repeat(20_001) })!.reason, /Карта длиннее 20000 знаков/);
  assert.match(decide(own('STATE.md'), { content: 'x'.repeat(2501) })!.reason, /Состояние длиннее 2500 знаков/);
  const map = fs.readFileSync(own('CLAUDE.md'), 'utf8');
  assert.ok(map.includes('чиним корзину'));
  assert.equal(decide(own('CLAUDE.md'), { old_string: 'чиним корзину', new_string: 'починили' }, {}, 'Edit')?.decision, 'ask');
  // посчитать, как Claude Code, не вышло (old_string не найден: кавычки-«ёлочки», CRLF) — не ложный отказ, а вопрос и
  // проверка после записи по снимку
  const odd = decide(own('CLAUDE.md'), { old_string: 'нет такого', new_string: 'y' }, {}, 'Edit');
  assert.equal(odd?.decision, 'ask');
  assert.match(odd!.reason, /Проверить заранее не вышло \(old_string не найден в файле\): agentgraph проверит файл после записи/);
  assert.equal(odd?.decision === 'ask' && odd.before, map);
  // claude.md в другом регистре — та же карта (APFS): предел длины держится
  assert.match(decide(own('claude.md'), { content: 'x'.repeat(20_001) })!.reason, /Карта длиннее 20000 знаков/);
});

test('flow: новый и изменённый — вопрос «схема в порядке»; ошибка схемы, занятое имя, глубже папки и вызов несуществующего — отказ с ошибками', () => {
  const existing = path.join(FLOWS_DIR, 'lib', 'fix-bug.yaml');
  const ok = decide(existing, { content: leaf('fix-bug').replace('prompt: x', 'prompt: y') });
  assert.equal(ok?.decision, 'ask');
  assert.match(ok!.reason, /^agentgraph: flow .*fix-bug\.yaml\. Изменит flow fix-bug \(папка lib\), схема в порядке\. Начатый запуск идёт по своему снимку; новый запуск, продолжение и вызов из другого flow возьмут эту версию$/);
  assert.match(decide(path.join(FLOWS_DIR, 'new-one.yaml'), { content: leaf('new-one') })!.reason, /Новый flow new-one, схема в порядке/);
  const bad = (file: string, content: string, re: RegExp) => {
    const d = decide(file, { content });
    assert.equal(d?.decision, 'deny', file);
    assert.match(d!.reason, re);
  };
  bad(path.join(FLOWS_DIR, 'broken.yaml'), 'name: broken\nphases: 5\n', /Невалидный flow/);
  bad(path.join(FLOWS_DIR, 'broken.yaml'), 'name: [', /Ошибка YAML/);
  bad(path.join(FLOWS_DIR, 'fix-bug.yaml'), leaf('fix-bug'), /Имя fix-bug уже занято flow в папке lib/);
  bad(path.join(FLOWS_DIR, 'a', 'b', 'deep.yaml'), leaf('deep'), /папке первого уровня/);
  bad(path.join(FLOWS_DIR, 'Bad_Name.yaml'), leaf('x'), /Недопустимое имя flow/);
  bad(path.join(FLOWS_DIR, 'caller.yaml'), 'name: caller\nblocks:\n  - name: call\n    flow: nope\n', /flow nope не загружается/);
  // Edit файла flow: проверяется текст после замены
  assert.match(decide(existing, { old_string: 'prompt: x', new_string: 'prompt: [' }, {}, 'Edit')!.reason, /Ошибка YAML/);
  // не YAML в папке flow — вопрос без проверки
  assert.match(decide(path.join(FLOWS_DIR, 'README.md'))!.reason, /^agentgraph: файл в папке flow/);
  // и для MCP flow_write — то же, с папкой нового flow; существующий в другую папку — ошибка
  assert.match(flowWriteDetail({ name: 'brand', yaml: leaf('brand'), folder: 'lib' }), /Новый flow brand \(папка lib\)/);
  assert.throws(() => flowWriteDetail({ name: 'fix-bug', yaml: leaf('fix-bug'), folder: 'other' }), /лежит в папке lib/);
  assert.throws(() => flowWriteDetail({ name: 'x', yaml: 'name: x\n' }), /Невалидный flow/);
});

test('после записи: сломанный space.json возвращается к снимку, новый сломанный flow удаляется, целый файл не трогается', () => {
  const meta = own('space.json');
  const good = fs.readFileSync(meta, 'utf8');
  fs.writeFileSync(meta, '{ "dir": 1 }');
  const target = (classifyEdit(scope(), 'Write', { file_path: meta, content: '' }) as { target: import('./session-edit.js').EditTarget }).target;
  assert.match(recheckEdit(target, good)!, /не проходит проверку agentgraph: .*лишние поля: dir.*Возвращена версия до записи/);
  assert.equal(fs.readFileSync(meta, 'utf8'), good);
  assert.equal(recheckEdit(target, good), undefined);
  const fresh = path.join(FLOWS_DIR, 'fresh.yaml');
  fs.writeFileSync(fresh, 'name: fresh\n');
  const ft = (classifyEdit(scope(), 'Write', { file_path: fresh, content: '' }) as { target: import('./session-edit.js').EditTarget }).target;
  assert.match(recheckEdit(ft, null)!, /Файл удалён: до записи его не было/);
  assert.equal(fs.existsSync(fresh), false);
  // документ не проверяется
  assert.equal(recheckEdit({ kind: 'space', slug: 'feat', part: 'doc', file: own('docs/a.md') }, null), undefined);
});

test('textAfter: Edit и MultiEdit — как у Claude Code: ровно одно вхождение или replace_all, $& в замене буквально, пустой old_string — только у нового файла', () => {
  assert.equal(textAfter('Write', { content: 'a' }, 'old'), 'a');
  assert.equal(textAfter('Edit', { old_string: 'b', new_string: '$&$1' }, 'abc'), 'a$&$1c');
  assert.equal(textAfter('Edit', { old_string: 'a', new_string: 'x', replace_all: true }, 'aba'), 'xbx');
  assert.throws(() => textAfter('Edit', { old_string: 'a', new_string: 'x' }, 'aba'), /больше одного раза/);
  assert.equal(textAfter('Edit', { old_string: '', new_string: 'new' }, undefined), 'new');
  assert.throws(() => textAfter('Edit', { old_string: '', new_string: 'x' }, 'есть'), /только у нового или пустого файла/);
  assert.throws(() => textAfter('Edit', { old_string: 'a', new_string: 'x' }, undefined), /файла ещё нет/);
  assert.equal(textAfter('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c', replace_all: true }] }, 'ab'), 'cc');
  assert.throws(() => textAfter('NotebookEdit', {}, 'x'), /только ноутбуки/);
});

test('cwdSpace: сессия в папке пространства — его слаг (и глубже), вне — нет; spaceSettingsDetail — что изменится, плохая папка — ошибка', () => {
  assert.equal(cwdSpace(path.join(spaceDir('feat'), 'docs')), 'feat');
  assert.equal(cwdSpace(spaceDir('feat')), 'feat');
  assert.equal(cwdSpace(spacesDir()), undefined);
  assert.equal(cwdSpace(proj), undefined);
  assert.match(spaceSettingsDetail('feat', { title: 'Новая корзина' }), /заголовок → «Новая корзина»/);
  assert.match(spaceSettingsDetail('feat', { cwd: proj }), new RegExp(`рабочая папка → ${proj}`));
  assert.throws(() => spaceSettingsDetail('feat', { dirs: ['/'] }), /корень диска/);
  assert.throws(() => spaceSettingsDetail('nope', { title: 'x' }), /Пространства nope нет/);
});

test('сессия в папке пространства: своё целиком — с вопросом, включая .claude/ и space.json; чужое и заведённое после старта — отказ; папка команд — отказ при любой рабочей папке', () => {
  const cwd = spaceDir('feat');
  const at = (file: string, toolCwd?: string) => editDecision(scope({ cwd, spaces: [cwdSpace(cwd)!], ...(toolCwd ? { toolCwd } : {}) }), 'Write', { file_path: file, content: '{}' })?.decision;
  assert.equal(at(path.join(cwd, '.claude', 'settings.json')), 'ask');
  assert.equal(at('docs/spec.md'), 'ask');
  assert.equal(at('CLAUDE.md'), 'ask');
  createSpace('late');
  for (const p of [path.join(spaceDir('late'), 'CLAUDE.md'), '../other/STATE.md', path.join(spacesDir(), 'x.md')]) assert.equal(at(p), 'deny', p);
  for (const c of [cwd, proj]) {
    for (const p of [path.join(teamsDir(), 'pay', 'repo', 'flows', 'teamwork-prd.yaml'), path.join(configDir(), 'TEAMS', 'pay', 'trust.json')]) {
      assert.equal(editDecision(scope({ cwd: c }), 'Edit', { file_path: p, old_string: 'a', new_string: 'b' })?.decision, 'deny', `${c}: ${p}`);
    }
  }
});

test('папка команд: относительный путь от проекта и папка настроек в другом регистре — отказ', () => {
  const cfgName = path.basename(configDir());
  assert.equal(editDecision(scope({ toolCwd: proj }), 'Write', { file_path: `../${cfgName}/Teams/pay/repo/x.md`, content: 'x' })?.decision, 'deny');
  assert.equal(decide(path.join(path.dirname(configDir()), cfgName.toUpperCase(), 'teams', 'pay', 'trust.json'))?.decision, 'deny');
});

test('папка настроек шире разумного (AGENTGRAPH_CONFIG_DIR — домашняя) или проект сессии — её файлы не «служебные»', () => {
  const prev = process.env.AGENTGRAPH_CONFIG_DIR;
  process.env.AGENTGRAPH_CONFIG_DIR = os.homedir();
  try {
    assert.equal(decide(path.join(os.homedir(), 'notes.md')), undefined);
  } finally {
    process.env.AGENTGRAPH_CONFIG_DIR = prev;
  }
  // сессия, открытая в самой папке настроек, правит её файлы как проект (как launchDirs)
  assert.equal(editDecision(scope({ cwd: configDir() }), 'Write', { file_path: path.join(configDir(), 'settings.json'), content: '{}' }), undefined);
  assert.equal(decide(path.join(configDir(), 'settings.json'))?.decision, 'deny');
});

test('flow внутри проекта сессии (репо agentgraph): ошибка схемы запущенного сервера — предупреждение в вопросе, а не отказ, и без отката после записи', () => {
  // проект сессии — дом данных целиком: папка flow внутри него
  const d = editDecision(scope({ cwd: home }), 'Write', { file_path: path.join(FLOWS_DIR, 'next.yaml'), content: 'name: next\nphases: 5\n' });
  assert.equal(d?.decision, 'ask');
  assert.match(d!.reason, /⚠ Запущенный agentgraph эту версию не примет: Невалидный flow/);
  const file = path.join(FLOWS_DIR, 'next.yaml');
  fs.writeFileSync(file, 'name: next\nphases: 5\n');
  const t = (classifyEdit(scope({ cwd: home }), 'Write', { file_path: file, content: '' }) as { target: import('./session-edit.js').EditTarget }).target;
  assert.match(recheckEdit(t, null)!, /до перезапуска сервера с новой схемой/);
  assert.ok(fs.existsSync(file));
  fs.rmSync(file);
  // вне проекта — отказ, как раньше
  assert.equal(decide(file, { content: 'name: next\nphases: 5\n' })?.decision, 'deny');
});

test('после записи: откат нового сломанного flow в новой папке убирает и опустевшую папку', () => {
  const file = path.join(FLOWS_DIR, 'fresh-dir', 'fresh.yaml');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'name: fresh\n');
  const t = (classifyEdit(scope(), 'Write', { file_path: file, content: '' }) as { target: import('./session-edit.js').EditTarget }).target;
  assert.match(recheckEdit(t, null)!, /Файл удалён: до записи его не было\. Опустевшая папка flow удалена/);
  assert.equal(fs.existsSync(path.dirname(file)), false);
  // в корне папки flow сама папка остаётся
  fs.writeFileSync(path.join(FLOWS_DIR, 'root-bad.yaml'), 'name: root-bad\n');
  const rt = (classifyEdit(scope(), 'Write', { file_path: path.join(FLOWS_DIR, 'root-bad.yaml'), content: '' }) as { target: import('./session-edit.js').EditTarget }).target;
  recheckEdit(rt, null);
  assert.ok(fs.existsSync(FLOWS_DIR));
});

test('Bash: команда с папкой своего пространства или папкой flow (как есть, ~/, $HOME/, в другом регистре) или из рабочей папки внутри них — причина для вопроса; проект, чужое пространство и сессия без пространства — нет', () => {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const b = (cmd: string, o: Partial<Scope> = {}) => bashDecision(scope(o), cmd);
    const rel = path.relative(home, spaceDir('feat'));
    assert.match(b(`cp a.md ${own('notes.md')}`)?.reason ?? '', /^Команда Bash упоминает папку пространства feat \(.*\): в режиме bypassPermissions/);
    assert.ok(b(`echo x > ~/${rel}/CLAUDE.md`), '~/');
    assert.ok(b(`cat "$HOME/${rel}/STATE.md"`), '$HOME');
    assert.ok(b(`ls \${HOME}/${rel}`), '${HOME}');
    assert.ok(b(`ls ${spaceDir('feat').toUpperCase()}`), 'регистр');
    assert.match(b(`sed -i '' s/a/b/ ${path.join(FLOWS_DIR, 'lib', 'fix-bug.yaml')}`)?.reason ?? '', /упоминает папку flow/);
    assert.match(b('touch CLAUDE.md', { toolCwd: spaceDir('feat') })?.reason ?? '', /выполняется из папки пространства feat/);
    assert.equal(b(`npm test && cp a ${path.join(proj, 'b')}`), undefined);
    // чужое пространство для Bash держит правило deny из --settings, эвристика его не касается
    assert.equal(b(`cp a ${path.join(spaceDir('other'), 'x.md')}`), undefined);
    assert.equal(b(`cp a ${own('x.md')}`, { spaces: [] }), undefined);
    // граница пути: своё feat не ловит соседнее feat-2, папка flow — flows-old
    createSpace('feat-2');
    assert.equal(b(`cp a ${path.join(spaceDir('feat-2'), 'x.md')}`), undefined);
    assert.equal(b(`cp a ${FLOWS_DIR}-old/x.yaml`), undefined);
    // кавычки, обратный слэш, // и /./ не уводят мимо
    assert.ok(b(`cp a "$HOME"/${rel}/x.md`), '"$HOME"');
    assert.ok(b(`cp a ~/"${rel}/x.md"`), 'кавычки внутри');
    assert.ok(b(`cp a ${spacesDir()}//feat/./x.md`), '// и /./');
    // относительный путь от рабочей папки: папка flow внутри проекта сессии (репо agentgraph)
    const repoCwd = path.dirname(FLOWS_DIR);
    assert.match(b(`sed -i '' s/a/b/ flows/lib/fix-bug.yaml`, { cwd: repoCwd })?.reason ?? '', /упоминает папку flow/);
    assert.ok(b('cp x ./flows/', { cwd: repoCwd }), './flows/');
    assert.equal(b('cat src/flows.ts my-flows/a', { cwd: repoCwd }), undefined);
    // своё вместе с закрытым — отказ: одобрение вопроса не должно касаться закрытого
    const mixed = (cmd: string) => b(cmd);
    assert.match(JSON.stringify(mixed(`cp ${own('CLAUDE.md')} ${path.join(spaceDir('other'), 'CLAUDE.md')}`)), /"decision":"deny".*пространство other.*раздели команду/);
    assert.match(mixed(`cp ${own('a')} ${path.join(tagsDir(), 'qa', 'b')}`)?.reason ?? '', /папку тегов знаний/);
    assert.match(mixed(`cp ${own('a')} ${path.join(teamsDir(), 't')}`)?.reason ?? '', /папку команд Teamwork/);
    assert.match(mixed(`rm -rf ${own('a')} ${spacesDir()}`)?.reason ?? '', /папку пространств целиком/);
    assert.equal(mixed(`cp ${own('a')} ${own('b')}`)?.decision, 'ask');
    // папка flow через ссылку: команда с настоящим путём ловится по realpath
    const link = path.join(home, 'flows-link');
    fs.symlinkSync(FLOWS_DIR, link);
    assert.ok(b(`cp a ${path.join(FLOWS_DIR, 'x.yaml')}`, { flowsDir: link }), 'realpath');
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
});
