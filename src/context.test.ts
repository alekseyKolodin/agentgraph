import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { contextOptions, getContext, readContextFile, resetContextState, writeContextFile, type ContextDeps } from './context.js';

type Usage = Awaited<ReturnType<Query['getContextUsage']>>;

/** Временная папка и свой CLAUDE_CONFIG_DIR: плагины и кэш Claude Code ищутся в нём. */
function withTmp(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-ctx-')));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
    resetContextState();
    try {
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
      resetContextState();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function write(file: string, text = '# правила\n'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function usage(memoryFiles: Usage['memoryFiles'] = []): Usage {
  return {
    categories: [
      { name: 'System prompt', tokens: 2000, color: '', kind: 'used' },
      { name: 'Memory files', tokens: 300, color: '', kind: 'used' },
      { name: 'Free space', tokens: 900000, color: '', kind: 'free' },
    ],
    totalTokens: 2300,
    maxTokens: 1000000,
    rawMaxTokens: 1000000,
    percentage: 0,
    gridRows: [],
    model: 'claude-opus-5-5',
    memoryFiles,
    mcpTools: [{ name: 'mcp__jira__search', serverName: 'jira', tokens: 120 }],
    agents: [{ agentType: 'docs-librarian', source: 'userSettings', tokens: 290 }],
    skills: { totalSkills: 1, includedSkills: 1, tokens: 130, skillFrontmatter: [{ name: 'agentgraph', source: 'projectSettings', tokens: 130 }] },
    isAutoCompactEnabled: true,
    apiUsage: null,
  };
}

/** Фейковый query: считает вызовы, запоминает опции и закрытие. */
function fakeQuery(answer: () => Promise<Usage>) {
  const calls: Options[] = [];
  let closed = 0;
  const deps: ContextDeps = {
    query: ({ options }) => {
      calls.push(options);
      return { getContextUsage: () => answer(), close: () => { closed++; } };
    },
  };
  return { deps, calls, closed: () => closed };
}

const FLOW = `name: ctx-test
defaults:
  model: claude-sonnet-5-5
blocks:
  - name: first
    phases:
      - name: plan
        prompt: p
        tools: [Read, Edit, Bash]
      - name: review
        prompt: p
        tools: [Read]
  - name: second
    phases:
      - name: impl
        prompt: p
        add_dirs: [extra, missing]
        system: Ты тестовый этап.
        tools: [Read, Grep]
        model: claude-haiku-4-5-20251001
`;

test(
  'контекст: маппинг ответа SDK, editable по типу и месту, close и при ошибке',
  withTmp(async (dir) => {
    const proj = write(path.join(dir, 'proj', 'CLAUDE.md'));
    const local = write(path.join(dir, 'proj', 'CLAUDE.local.md'));
    const user = write(path.join(dir, 'claude', 'CLAUDE.md'));
    const plugin = write(path.join(dir, 'claude', 'plugins', 'x', 'CLAUDE.md'));
    const managed = write(path.join(dir, 'managed', 'CLAUDE.md'));
    const txt = write(path.join(dir, 'proj', '.claude', 'rules', 'a.txt'));
    const f = fakeQuery(async () => usage([
      { path: user, type: 'User', tokens: 10 },
      { path: proj, type: 'Project', tokens: 5 },
      { path: local, type: 'Local', tokens: 2 },
      { path: plugin, type: 'User', tokens: 1 },
      { path: managed, type: 'Managed', tokens: 1 },
      { path: txt, type: 'Project', tokens: 1 },
    ]));
    const v = await getContext({ cwd: path.join(dir, 'proj') }, f.deps);
    assert.equal(f.closed(), 1);
    assert.equal(f.calls[0].persistSession, false);
    assert.equal(v.model, 'claude-opus-5-5');
    assert.equal(v.totalTokens, 2300);
    assert.deepEqual(v.memoryFiles.map((m) => m.editable), [true, true, true, false, false, false]);
    assert.deepEqual(v.skills, [{ name: 'agentgraph', source: 'projectSettings', tokens: 130 }]);
    assert.deepEqual(v.agents, [{ name: 'docs-librarian', source: 'userSettings', tokens: 290 }]);
    assert.deepEqual(v.mcpTools, [{ name: 'mcp__jira__search', server: 'jira', tokens: 120 }]);
    // отложенные инструменты подключённого сервера, которых нет в листинге, — с нулём токенов
    const withStatus: ContextDeps = {
      query: () => ({
        getContextUsage: async () => usage(),
        close: () => {},
        mcpServerStatus: async () => [
          { name: 'artifacts', status: 'connected', tools: [{ name: 'artifact_read' }] },
          { name: 'jira', status: 'connected', tools: [{ name: 'search' }] },
          { name: 'down', status: 'failed', tools: [{ name: 'x' }] },
        ] as never,
      }),
      connectorsWaitMs: 20,
    };
    const s = await getContext({ cwd: path.join(dir, 'status'), force: true }, withStatus);
    assert.deepEqual(s.mcpTools, [{ name: 'mcp__jira__search', server: 'jira', tokens: 120 }, { name: 'mcp__artifacts__artifact_read', server: 'artifacts', tokens: 0 }]);
    assert.equal(v.systemPrompt, 'preset');
    assert.equal(v.tools, null);

    const bad = fakeQuery(async () => { throw new Error('нет ответа'); });
    await assert.rejects(getContext({ cwd: path.join(dir, 'other') }, bad.deps), /нет ответа/);
    assert.equal(bad.closed(), 1);

    // завис Claude Code: листинг падает по таймауту, процесс закрыт, следующий запрос спрашивает заново
    const hung = fakeQuery(() => new Promise(() => {}));
    await assert.rejects(getContext({ cwd: path.join(dir, 'hung') }, { ...hung.deps, timeoutMs: 20 }), /не ответил/);
    assert.equal(hung.closed(), 1);
    await getContext({ cwd: path.join(dir, 'hung') }, f.deps);
    assert.equal(f.calls.length, 2);
  }),
);

test(
  'контекст: опции этапа — add_dirs, system, tools, модель, поиск по блокам, нет директории → предупреждение',
  withTmp((dir) => {
    const flow = write(path.join(dir, 'ctx-test.yaml'), FLOW);
    const cwd = path.join(dir, 'proj');
    fs.mkdirSync(path.join(cwd, 'extra'), { recursive: true });

    const plain = contextOptions({ cwd, model: 'claude-opus-5-5' });
    assert.equal(plain.options.model, 'claude-opus-5-5');
    assert.equal(plain.options.tools, undefined);
    assert.deepEqual(plain.options.systemPrompt, { type: 'preset', preset: 'claude_code' });

    // этап второго блока: ищется во всех блоках
    const r = contextOptions({ cwd, flow, phase: 'impl', model: 'claude-opus-5-5' });
    assert.deepEqual(r.options.additionalDirectories, [path.join(cwd, 'extra'), path.join(cwd, 'missing')]);
    assert.equal(r.options.env?.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, '1');
    assert.deepEqual(r.options.systemPrompt, { type: 'custom', prompt: 'Ты тестовый этап.' });
    assert.deepEqual(r.options.tools, ['Read', 'Grep', 'Agent', 'Skill']);
    assert.equal(r.options.model, 'claude-haiku-4-5-20251001');
    assert.deepEqual(r.addDirs.map((d) => d.exists), [true, false]);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /missing/);

    // модель: этап → defaults flow → запрос
    const review = contextOptions({ cwd, flow, phase: 'review', model: 'claude-opus-5-5' });
    assert.equal(review.options.model, 'claude-sonnet-5-5');
    assert.deepEqual(review.options.tools, ['Read', 'Agent', 'Skill']);
    assert.equal(review.options.additionalDirectories, undefined);
    // flow без этапа: только модель из defaults
    assert.equal(contextOptions({ cwd, flow, model: 'claude-opus-5-5' }).options.model, 'claude-sonnet-5-5');
    // нет этапа или flow — 404, а не 500
    assert.throws(() => contextOptions({ cwd, flow, phase: 'nope' }), (err: { status?: number; message: string }) => err.status === 404 && /нет этапа nope/.test(err.message));
    assert.throws(() => contextOptions({ cwd, flow: path.join(dir, 'nope.yaml') }), (err: { status?: number }) => err.status === 404);
  }),
);

test(
  'контекст: этап flow с артефактами — неявные Read/Edit/Write в tools, условная папка артефактов в предупреждении, не в листинге',
  withTmp((dir) => {
    const flow = write(
      path.join(dir, 'ctx-art.yaml'),
      'name: ctx-art\nartifacts:\n  plan: {}\n  notes: {}\nphases:\n  - {name: w, tools: [], reads: [notes], writes: [plan], prompt: x}\n  - {name: n, tools: [Read], prompt: x}\n',
    );
    const cwd = path.join(dir, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    const r = contextOptions({ cwd, flow, phase: 'w' });
    assert.deepEqual(r.options.tools, ['Read', 'Edit', 'Write', 'Agent', 'Skill']);
    assert.deepEqual(Object.keys(r.options.mcpServers ?? {}), ['artifacts'], 'инструмент чтения по ключу виден на странице');
    assert.deepEqual(r.options.allowedTools?.filter((t) => t.startsWith('mcp__')), ['mcp__artifacts__artifact_map', 'mcp__artifacts__artifact_read', 'mcp__artifacts__artifact_search']);
    assert.equal(r.options.additionalDirectories, undefined);
    assert.equal(r.options.env?.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, undefined);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /папку артефактов запуска .*artifacts; читает: notes; пишет: plan\. Только для своих артефактов добавлены Read, Edit, Write\./);
    const n = contextOptions({ cwd, flow, phase: 'n' });
    assert.deepEqual(n.options.tools, ['Read', 'Agent', 'Skill']);
    assert.equal(n.options.mcpServers, undefined);
    assert.deepEqual(n.warnings, []);
  }),
);

test(
  'контекст: кэш на минуту, force спрашивает заново, параллельные вызовы делят один запрос',
  withTmp(async (dir) => {
    const f = fakeQuery(async () => usage());
    const req = { cwd: dir };
    await getContext(req, f.deps);
    await getContext(req, f.deps);
    assert.equal(f.calls.length, 1);
    await getContext({ ...req, force: true }, f.deps);
    assert.equal(f.calls.length, 2);
    await getContext({ ...req, model: 'claude-haiku-4-5-20251001' }, f.deps);
    assert.equal(f.calls.length, 3);

    let release!: () => void;
    const slow = fakeQuery(() => new Promise((resolve) => { release = () => resolve(usage()); }));
    const a = getContext({ cwd: dir, force: true }, slow.deps);
    const b = getContext({ cwd: dir, force: true }, slow.deps);
    release();
    assert.equal(await a, await b);
    assert.equal(slow.calls.length, 1);
  }),
);

test(
  'контекст: запись только по белому списку (realpath, .md), устаревший mtime → 409, успех сбрасывает кэш',
  withTmp(async (dir) => {
    const proj = write(path.join(dir, 'proj', 'CLAUDE.md'), 'было\n');
    const rule = write(path.join(dir, 'proj', '.claude', 'rules', 'link.md'));
    const txt = write(path.join(dir, 'proj', 'notes.txt'));
    const outside = write(path.join(dir, 'outside', 'secret.md'), 'чужое\n');
    const unlisted = write(path.join(dir, 'proj', 'README.md'));
    const f = fakeQuery(async () => usage([
      { path: proj, type: 'Project', tokens: 1 },
      { path: rule, type: 'Project', tokens: 1 },
      { path: txt, type: 'Project', tokens: 1 },
    ]));
    await getContext({ cwd: dir }, f.deps);
    const status = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as { status?: number }).status;
      }
      return 200;
    };

    assert.equal(status(() => writeContextFile(unlisted, 'x', fs.statSync(unlisted).mtimeMs)), 403);
    assert.equal(status(() => readContextFile(unlisted)), 403);
    // несуществующий путь вне листинга — тоже 403: по ответу не узнать, есть ли файл на диске
    const absent = path.join(dir, 'proj', 'nope.md');
    assert.equal(status(() => writeContextFile(absent, 'x', 0)), 403);
    assert.equal(status(() => readContextFile(absent)), 403);
    assert.equal(status(() => writeContextFile('', 'x', 0)), 403);
    assert.ok(!fs.existsSync(absent));
    assert.equal(status(() => writeContextFile(txt, 'x', fs.statSync(txt).mtimeMs)), 403);
    // разрешённый файл подменили симлинком наружу: сверка по realpath
    fs.rmSync(rule);
    fs.symlinkSync(outside, rule);
    assert.equal(status(() => writeContextFile(rule, 'x', fs.statSync(rule).mtimeMs)), 403);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'чужое\n');

    const read = readContextFile(proj);
    assert.equal(read.text, 'было\n');
    assert.equal(read.editable, true);
    assert.equal(status(() => writeContextFile(proj, 'стало\n', read.mtimeMs - 1000)), 409);
    assert.equal(fs.readFileSync(proj, 'utf8'), 'было\n');

    const saved = writeContextFile(proj, 'стало\n', read.mtimeMs);
    assert.equal(fs.readFileSync(proj, 'utf8'), 'стало\n');
    // вторая правка подряд — с mtime из ответа, без нового листинга
    writeContextFile(proj, 'ещё\n', saved.mtimeMs);
    assert.equal(fs.readFileSync(proj, 'utf8'), 'ещё\n');
    await getContext({ cwd: dir }, f.deps);
    assert.equal(f.calls.length, 2);

    // файл из листинга пропал с диска — 404
    fs.rmSync(proj);
    assert.equal(status(() => readContextFile(proj)), 404);
    assert.equal(status(() => writeContextFile(proj, 'x', 0)), 404);
    assert.ok(!fs.existsSync(proj));
  }),
);

test(
  'контекст: запись посреди листинга — старый результат не ложится в кэш, следующий запрос спрашивает заново',
  withTmp(async (dir) => {
    const proj = write(path.join(dir, 'proj', 'CLAUDE.md'), 'было\n');
    const files = [{ path: proj, type: 'Project', tokens: 1 }];
    await getContext({ cwd: dir }, fakeQuery(async () => usage(files)).deps);

    const release: (() => void)[] = [];
    const slow = fakeQuery(() => new Promise((resolve) => { release.push(() => resolve(usage(files))); }));
    // «Обновить» и сразу «Сохранить»: листинг уже идёт, когда файл меняется
    const before = getContext({ cwd: dir, force: true }, slow.deps);
    writeContextFile(proj, 'стало\n', fs.statSync(proj).mtimeMs);
    // запрос после записи не присоединяется к идущему листингу
    const after = getContext({ cwd: dir }, slow.deps);
    assert.equal(slow.calls.length, 2);
    // старый листинг заканчивается последним и не должен затереть свежий
    release[1]();
    const fresh = await after;
    release[0]();
    assert.notEqual(await before, fresh);
    assert.equal(await getContext({ cwd: dir }, slow.deps), fresh);
    assert.equal(slow.calls.length, 2);
  }),
);

test(
  'контекст: этап с коннекторами claude.ai — ждём подключения, их инструменты в листинге; без коннекторов — не ждём',
  withTmp(async (dir) => {
    const flow = write(path.join(dir, 'conn.yaml'), `name: conn
phases:
  - name: intake
    prompt: p
    tools: [Read, mcp__claude_ai_Atlassian_Rovo__getJiraIssue]
  - name: code
    prompt: p
    tools: [Read]
  - name: whole
    prompt: p
    tools: [Read, mcp__claude_ai_Atlassian_Rovo]
`);
    const cwd = path.join(dir, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    const rovo = (status: string) => ({ name: 'claude.ai Atlassian Rovo', scope: 'claudeai', status, ...(status === 'connected' ? { tools: [{ name: 'getJiraIssue' }, { name: 'createJiraIssue' }] } : {}) });
    const gmail = { name: 'claude.ai Gmail', scope: 'claudeai', status: 'needs-auth' };
    const snaps = [[], [rovo('pending'), gmail], [rovo('connected'), gmail]];
    let polls = 0;
    const deps: ContextDeps = {
      query: () => ({
        getContextUsage: async () => usage(),
        close: () => {},
        mcpServerStatus: async () => snaps[Math.min(polls++, snaps.length - 1)] as never,
      }),
      connectorsWaitMs: 2000,
    };
    const v = await getContext({ cwd, flow, phase: 'intake' }, deps);
    assert.ok(polls >= 3, 'ждали, пока коннектор подключится');
    assert.deepEqual(v.mcpTools.filter((t) => t.server.startsWith('claude.ai')).map((t) => t.name), ['mcp__claude_ai_Atlassian_Rovo__getJiraIssue', 'mcp__claude_ai_Atlassian_Rovo__createJiraIssue']);
    assert.ok(v.warnings.some((w) => /подключены: в контексте описания всех их инструментов \(2\), вызвать этап может только перечисленные в tools \(1\)/.test(w)), v.warnings.join('\n'));
    // неподключённый коннектор, которого этап не просил, не упоминается
    assert.ok(!v.warnings.some((w) => /Gmail/.test(w)));

    // этап без коннекторов: сессия их не получает, ждать нечего — один опрос (отложенные инструменты), без предупреждений
    polls = 0;
    const c = await getContext({ cwd, flow, phase: 'code' }, deps);
    assert.equal(polls, 1);
    assert.ok(!c.warnings.some((w) => /Коннекторы|Не подключены/.test(w)));

    // коннектор этапа не авторизован: так и сказано
    const noAuth: ContextDeps = {
      query: () => ({ getContextUsage: async () => usage(), close: () => {}, mcpServerStatus: async () => [rovo('needs-auth'), gmail] as never }),
      connectorsWaitMs: 50,
    };
    const n = await getContext({ cwd, flow, phase: 'intake', force: true }, noAuth);
    assert.ok(n.warnings.some((w) => /ни один не подключился/.test(w)));
    assert.ok(n.warnings.some((w) => w === 'Не подключены коннекторы этапа: claude.ai Atlassian Rovo (needs-auth).'), n.warnings.join('\n'));

    // весь коннектор одной записью: разрешены все его инструменты
    const all: ContextDeps = {
      query: () => ({ getContextUsage: async () => usage(), close: () => {}, mcpServerStatus: async () => [rovo('connected'), gmail] as never }),
      connectorsWaitMs: 50,
    };
    const w = await getContext({ cwd, flow, phase: 'whole' }, all);
    assert.ok(w.warnings.some((x) => /\(2\), вызвать этап может только перечисленные в tools \(2\)/.test(x)), w.warnings.join('\n'));
  }),
);

test(
  'контекст: промпт этапа по источникам — шаблон, handoff, директории, теги по запросу одной частью и целиком своей; предупреждения о тегах целиком и об источниках',
  withTmp(async (dir) => {
    const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = path.join(dir, 'cfg');
    try {
      const { createTag, updateTag } = await import('./tags.js');
      createTag('qa', 'QA', 'knowledge');
      updateTag('qa', { description: 'правила проверки', notes: 'коротко' });
      createTag('big', 'Большой', 'knowledge');
      updateTag('big', { notes: 'x'.repeat(3000), inline: true });
      const cwd = path.join(dir, 'proj');
      fs.mkdirSync(path.join(cwd, 'extra'), { recursive: true });
      const flow = write(
        path.join(dir, 'ctx-prompt.yaml'),
        'name: ctx-prompt\nblocks:\n  - name: b\n    knowledge: [qa, big]\n    phases:\n      - {name: w, tools: [], add_dirs: [extra], prompt: "Задача {{input}}, прошлое {{prev}} и {{ phases.w }}", handoff: "итог"}\n      - {name: plain, tools: [], prompt: p}\n',
      );
      const r = contextOptions({ cwd, flow, phase: 'w' });
      const p = r.prompt!;
      assert.deepEqual(p.parts.map((x) => x.kind), ['prompt', 'handoff', 'dirs', 'knowledge-lines', 'knowledge-inline']);
      assert.equal(p.parts[0].chars, 'Задача {{input}}, прошлое {{prev}} и {{ phases.w }}'.length);
      assert.ok(p.parts[2].chars > path.join(cwd, 'extra').length);
      assert.match(p.parts[3].name, /по запросу: qa/);
      assert.equal(p.parts[4].name, 'Тег знаний big целиком');
      assert.ok(p.parts[4].chars >= 3000);
      assert.deepEqual(p.vars, ['input', 'prev', 'phases.w']);
      assert.equal(p.chars, p.parts.reduce((n, x) => n + x.chars, 0));
      assert.ok(r.warnings.some((w) => /Теги знаний целиком \(big\) занимают \d+% промпта/.test(w)), r.warnings.join('\n'));
      // этап без хвостов: одна часть, без предупреждений
      const plain = contextOptions({ cwd, flow, phase: 'plain' });
      assert.deepEqual(plain.prompt!.parts.map((x) => x.kind), ['prompt', 'knowledge-lines', 'knowledge-inline']);
      // без этапа состава промпта нет
      assert.equal(contextOptions({ cwd, flow }).prompt, undefined);
      // предупреждение об источниках: 2 файла памяти + 1 тег целиком + свой system = 4
      const { sourcesWarning } = await import('./context.js');
      assert.match(sourcesWarning(2, 1, true)!, /из 4 источников: 2 файл\(ов\) CLAUDE.md и правил, 1 тег\(ов\) знаний целиком, свой системный промпт/);
      assert.equal(sourcesWarning(2, 1, false), undefined);
    } finally {
      if (prevCfg === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prevCfg;
    }
  }),
);
