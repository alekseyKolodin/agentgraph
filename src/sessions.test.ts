import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  childPermissionMode, contextDelta, CONTEXT_BUDGET, findClaude, handleHook, idleAgents, launchDirs, parseClaudeVersion, parseHookInput, permissionReply, readSessionCtx,
  resumeTarget, safeRealpath, sessionArgs, sessionContext, sessionDirs, sessionEnv, sessionFlags, sessionName, sessionPrompt, sessionReadTargets, SESSION_PROMPT_MAX,
  sessionSettings, versionAtLeast, type HookDeps, type HookState, type SessionLaunch,
} from './sessions.js';
import { createTag, readTag, tagDir, tagsDir, updateTag } from './tags.js';
import { addSpaceDoc, createSpace, readSpace, spaceDir, spacesDir, writeSpaceState } from './spaces.js';

/** Пространство и теги знаний на диске — как их читает сессия. */
const ctxOf = (space: string | undefined, tags: string[]) => readSessionCtx(space, tags, { space: readSpace, tag: readTag });

function withConfigDir(fn: (root: string) => void) {
  return () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-sessions-')));
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    // папка настроек — рядом, а не внутри root: root служит папкой пространства, а предок папки настроек в пути
    // пространства не годится (tooBroadPath)
    const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-cfg-')));
    process.env.AGENTGRAPH_CONFIG_DIR = cfg;
    try {
      fn(root);
    } finally {
      if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prev;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  };
}

const launch = (o: Partial<SessionLaunch> = {}): SessionLaunch => ({
  id: '11111111-2222-4333-8444-555555555555',
  token: 'tok123',
  port: 4755,
  claudeSessionId: '11111111-2222-4333-8444-555555555555',
  resume: false,
  name: 'checkout',
  addDirs: ['/data/tags/a', '/files'],
  denyDirs: ['/data/tags', '/data/tags/a'],
  ...o,
});

const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test('sessionArgs: новый разговор — --session-id, название через =, хуки и MCP одним JSON, без модели и режима', () => {
  const args = sessionArgs(launch({ name: '-dash name' }));
  assert.deepEqual(args.slice(0, 2), ['--session-id=11111111-2222-4333-8444-555555555555', '--name=-dash name']);
  assert.ok(!args.includes('--model') && !args.includes('--permission-mode'));
  assert.ok(!args.some((a) => a.includes('append-system-prompt') || a === '--bare' || a === '--strict-mcp-config'));
  // без подтверждения — только чтение тегов знаний: space_write и session_new спрашивают человека
  assert.equal(flagValue(args, '--allowedTools'), 'mcp__agentgraph__knowledge_read');
  assert.deepEqual(args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : [])), ['/data/tags/a', '/files']);

  const settings = JSON.parse(flagValue(args, '--settings'));
  const start = settings.hooks.SessionStart[0].hooks[0];
  // HTTP-хуки на SessionStart Claude Code пропускает: только командой, -f и || true
  assert.equal(start.type, 'command');
  assert.match(start.command, /^curl -sSf --max-time 5 .*'X-Agentgraph-Session: tok123'.*'http:\/\/127\.0\.0\.1:4755\/api\/sessions\/11111111-2222-4333-8444-555555555555\/hook' \|\| true$/);
  for (const e of ['UserPromptSubmit', 'PostToolBatch', 'Stop', 'StopFailure', 'Notification', 'SessionEnd', 'PermissionRequest', 'PreToolUse']) {
    const h = settings.hooks[e][0].hooks[0];
    assert.deepEqual([h.type, h.url, h.headers], ['http', 'http://127.0.0.1:4755/api/sessions/11111111-2222-4333-8444-555555555555/hook', { 'X-Agentgraph-Session': 'tok123' }]);
  }
  // PreToolUse — только на session_new и space_write: остальные инструменты хук не задерживает
  assert.deepEqual(settings.hooks.PreToolUse.map((h: { matcher: string }) => h.matcher), ['mcp__agentgraph__session_new', 'mcp__agentgraph__space_write']);
  // //путь — абсолютный путь в правилах разрешений
  // Edit закрывает и Write: правило Write(путь) claude не применяет; сама папка — отдельным правилом
  assert.deepEqual(settings.permissions.deny, ['Edit(//data/tags)', 'Edit(//data/tags/**)', 'Edit(//data/tags/a)', 'Edit(//data/tags/a/**)']);
  // отдельные файлы — одним правилом
  const withFiles = JSON.parse(flagValue(sessionArgs(launch({ denyDirs: [], denyFiles: ['/s/*/space.json'] })), '--settings'));
  assert.deepEqual(withFiles.permissions.deny, ['Edit(//s/*/space.json)']);

  const mcp = JSON.parse(flagValue(args, '--mcp-config'));
  assert.deepEqual(mcp, {
    mcpServers: { agentgraph: { type: 'http', url: 'http://127.0.0.1:4755/api/sessions/11111111-2222-4333-8444-555555555555/mcp', headers: { 'X-Agentgraph-Session': 'tok123' }, alwaysLoad: true } },
  });
});

test('sessionArgs: «Продолжить» — --resume, модель и режим — только выбранные', () => {
  const args = sessionArgs(launch({ resume: true, claudeSessionId: 'aaaa', model: 'haiku', permissionMode: 'plan' }));
  assert.equal(args[0], '--resume=aaaa');
  assert.ok(!args.some((a) => a.startsWith('--session-id')));
  assert.equal(flagValue(args, '--model'), 'haiku');
  assert.equal(flagValue(args, '--permission-mode'), 'plan');
});

test('sessionArgs: первое сообщение — последним, после `--`: --add-dir не заберёт его себе, дефис в начале — не флаг', () => {
  const args = sessionArgs(launch({ prompt: '--help почини корзину', model: 'haiku' }));
  assert.deepEqual(args.slice(-2), ['--', '--help почини корзину']);
  assert.equal(args.filter((a) => a === '--').length, 1);
  assert.ok(!sessionArgs(launch()).includes('--'));
});

test('sessionPrompt: пусто — без сообщения, не строка и слишком длинное — ошибка', () => {
  assert.equal(sessionPrompt(undefined), undefined);
  assert.equal(sessionPrompt('   '), undefined);
  assert.equal(sessionPrompt(' почини \n'), 'почини');
  assert.throws(() => sessionPrompt(42), /строка/);
  // предел — в байтах: Linux режет один аргумент на 128 КиБ, кириллица — два байта на знак
  assert.equal(sessionPrompt('x'.repeat(SESSION_PROMPT_MAX)), 'x'.repeat(SESSION_PROMPT_MAX));
  assert.throws(() => sessionPrompt('ж'.repeat(SESSION_PROMPT_MAX / 2 + 1)), /больше 100000 байт/);
});

test('childPermissionMode: текущий режим из хуков, иначе режим запуска, иначе manual; default и опасные — manual', () => {
  assert.equal(childPermissionMode('plan', 'auto'), 'plan');
  assert.equal(childPermissionMode('auto', 'manual'), 'auto');
  assert.equal(childPermissionMode(undefined, 'acceptEdits'), 'acceptEdits');
  assert.equal(childPermissionMode(undefined, undefined), 'manual');
  for (const m of ['default', 'bypassPermissions', 'dontAsk', 'что-то новое']) assert.equal(childPermissionMode(m, 'auto'), 'manual');
});

test('sessionFlags: пусто — без флагов; модель с дефисом или пробелом и режимы bypassPermissions/dontAsk — ошибка', () => {
  assert.deepEqual(sessionFlags({}), {});
  assert.deepEqual(sessionFlags({ model: ' sonnet ', permissionMode: '' }), { model: 'sonnet' });
  assert.deepEqual(sessionFlags({ model: 'claude-haiku-4-5[1m]', permissionMode: 'acceptEdits' }), { model: 'claude-haiku-4-5[1m]', permissionMode: 'acceptEdits' });
  assert.throws(() => sessionFlags({ model: '--dangerously-skip-permissions' }), /Неверная модель/);
  assert.throws(() => sessionFlags({ model: 'a b' }), /Неверная модель/);
  assert.throws(() => sessionFlags({ permissionMode: 'bypassPermissions' }), /Режим разрешений/);
  assert.throws(() => sessionFlags({ permissionMode: 'dontAsk' }), /Режим разрешений/);
});

test('sessionName: из формы одной строкой, иначе слаги тегов, иначе имя папки; не длиннее 80 знаков', () => {
  assert.equal(sessionName('  мой\n баг ', ['a'], '/p/shop'), 'мой баг');
  assert.equal(sessionName('', ['checkout', 'api-docs'], '/p/shop'), 'checkout · api-docs');
  assert.equal(sessionName(undefined, [], '/p/shop'), 'shop');
  assert.equal([...sessionName('я'.repeat(100), [], '/p')].length, 80);
});

test('sessionEnv: вычищает только маркеры хоста и сессии, вход и провайдер пользователя остаются; NO_PROXY и терминал', () => {
  const env = sessionEnv(
    {
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CODE_MESSAGING_SOCKET: 's',
      CLAUDE_CODE_MESSAGING_TOKEN: 't',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_HOST_SESSION_ID: 'h',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_SAFE_MODE: '1',
      CLAUDE_CODE_EXECPATH: '/x',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'agentgraph',
      CLAUDE_PID: '1',
      CLAUDE_EFFORT: 'xhigh',
      CLAUDE_PREVIEW_PORT: '1',
      // маркеры, которые выставляют Claude Code и Claude desktop, если сервер запущен из них
      CLAUDE_CODE_DISABLE_CRON: '1',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES: '1',
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      CLAUDE_CODE_TERMINAL_MCP_TOOLS: '1',
      CLAUDE_CODE_REPORT_FINDINGS: '1',
      CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
      CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: '1',
      CLAUDE_CODE_DESKTOP_APP_VERSION: '1.0',
      CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
      MCP_CONNECTION_NONBLOCKING: '1',
      MCP_SERVER_CONNECTION_BATCH_SIZE: '5',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9000',
      ANTHROPIC_BASE_URL: 'https://proxy',
      HTTPS_PROXY: 'http://corp:3128',
      NO_PROXY: 'corp.local, localhost',
      no_proxy: '',
    },
    true,
  );
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('CLAUDE') || k.startsWith('MCP_')).sort(), [
    'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  ]);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://proxy');
  assert.equal(env.HTTPS_PROXY, 'http://corp:3128');
  assert.equal(env.NO_PROXY, 'corp.local,localhost,127.0.0.1');
  assert.equal(env.no_proxy, '127.0.0.1,localhost');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(sessionEnv({}, false).NO_PROXY, '127.0.0.1,localhost');
  // приложение из Finder без локали: pbcopy внутри claude испортил бы кириллицу; заданную локаль не трогаем
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(sessionEnv({ LANG: 'ru_RU.UTF-8' }, false).LANG, 'ru_RU.UTF-8');
  assert.deepEqual([sessionEnv({ LC_ALL: 'en_US.UTF-8' }, false).LANG, sessionEnv({ LC_CTYPE: 'UTF-8' }, false).LANG], [undefined, undefined]);
  assert.equal(sessionEnv({}, false).CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, undefined);
});

test(
  'launchDirs: пути внутри проекта и содержащие его не трогаются; запрет записи — на всю папку тегов, всю папку пространств, артефакты и открытые папки',
  withConfigDir(() => {
    const root = tagsDir();
    const spaces = spacesDir();
    const art = '/ag/runs/r1/artifacts';
    const r = launchDirs(['/p/shop/docs', '/p', '/specs', `${root}/a/attachments`, `${spaces}/feat`, '/odd(dir)', '/glob[1]', art], '/p/shop', '/s/files', [art]);
    assert.deepEqual(r.addDirs, ['/specs', `${root}/a/attachments`, `${spaces}/feat`, art, '/s/files']);
    assert.deepEqual(r.denyDirs, [root, spaces, art, '/specs']);
    assert.deepEqual(r.denyFiles, []);
  }),
);

test(
  'launchDirs: проект в домашней папке — папки тегов, пространств и артефакты внутри него всё равно закрыты для записи',
  withConfigDir((home) => {
    const root = tagsDir();
    const art = path.join(home, 'ag', 'runs', 'r1', 'artifacts');
    const r = launchDirs([art], home, '/s/files', [art]);
    assert.deepEqual(r.addDirs, ['/s/files']);
    assert.deepEqual(r.denyDirs, [root, spacesDir(), art]);
    // cwd внутри папки тегов — её не закрываем: это и есть проект
    assert.deepEqual(launchDirs([], path.join(root, 'a'), '/s/files').denyDirs, [spacesDir()]);
  }),
);

test(
  'launchDirs: сессия в папке пространства правит его карту и документы — с вопросом на каждую правку; .claude/, space.json и другие пространства закрыты',
  withConfigDir(() => {
    const own = path.join(spacesDir(), 'feat');
    const other = path.join(spacesDir(), 'other');
    fs.mkdirSync(own, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const r = launchDirs([own], own, '/s/files');
    assert.deepEqual(r.addDirs, ['/s/files']);
    assert.deepEqual(r.denyDirs.sort(), [tagsDir(), other, path.join(own, '.claude')].sort());
    assert.deepEqual(r.denyFiles, [path.join(spacesDir(), '*', 'space.json'), path.join(spacesDir(), '.migrated.json')]);
    assert.deepEqual(r.askDirs, [own]);
    const settings = sessionSettings(launch({ ...r })) as { permissions: { ask: string[] } };
    assert.ok(settings.permissions.ask.includes(`Edit(/${own}/**)`));
    // вне папки пространств вопроса на папку нет
    assert.deepEqual(launchDirs([own], '/p', '/s/files').askDirs, []);
  }),
);

test('sessionSettings: session_new и space_write — в permissions.ask (вопрос и без хука); onFailure: block у хука — только claude 2.1.295+', () => {
  const ask = ['mcp__agentgraph__session_new', 'mcp__agentgraph__space_write'];
  const hooksOf = (v?: string) => (sessionSettings(launch(v ? { claudeVersion: v } : {})) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> }; permissions: { ask: string[] } });
  for (const v of [undefined, '2.1.285', '2.1.317']) assert.deepEqual(hooksOf(v).permissions.ask, ask, String(v));
  assert.deepEqual(hooksOf('2.1.317').hooks.PreToolUse.map((h) => [h.matcher, h.hooks[0].onFailure]), ask.map((m) => [m, 'block']));
  // старый claude ключа не знает — ему не шлём; неизвестная версия — тоже
  assert.ok(hooksOf('2.1.285').hooks.PreToolUse.every((h) => !('onFailure' in h.hooks[0])));
  assert.ok(hooksOf().hooks.PreToolUse.every((h) => !('onFailure' in h.hooks[0])));
  assert.deepEqual([versionAtLeast('2.1.295', '2.1.295'), versionAtLeast('2.2.0 (Claude Code)', '2.1.295'), versionAtLeast('2.1.29', '2.1.295'), versionAtLeast(undefined, '1.0.0')], [true, true, false, false]);
});

test(
  'launchDirs: ~/.agentgraph — ссылка: запрет записи и по лексическому пути, и по настоящему',
  withConfigDir((root) => {
    const real = path.join(root, 'real-cfg');
    fs.mkdirSync(path.join(real, 'spaces'), { recursive: true });
    fs.mkdirSync(path.join(real, 'tags'), { recursive: true });
    const link = path.join(root, 'link-cfg');
    fs.symlinkSync(real, link);
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = link;
    try {
      const r = launchDirs([], '/p', '/s/files');
      for (const d of [path.join(link, 'spaces'), path.join(real, 'spaces'), path.join(link, 'tags'), path.join(real, 'tags')]) assert.ok(r.denyDirs.includes(d), d);
    } finally {
      process.env.AGENTGRAPH_CONFIG_DIR = prev;
    }
  }),
);

test('permissionReply: Glob с фигурными скобками не пропускается без вопроса — {..,x} раскрылся бы наружу', () => {
  const t = { dirs: ['/space'], files: [] };
  const id = (p: string) => p;
  const glob = (pattern: string) => permissionReply({ hook_event_name: 'PermissionRequest', tool_name: 'Glob', tool_input: { path: '/space', pattern } }, t, id);
  assert.ok(glob('**/*.md').hookSpecificOutput);
  assert.deepEqual(glob('{..,x}/*'), {});
  assert.deepEqual(glob('{/,}etc/*'), {});
});

test('findClaude: сначала PATH, потом CLI из пакета SDK; нет ни того, ни другого — undefined', () => {
  const exec = (set: string[]) => (p: string) => set.includes(p);
  assert.equal(findClaude({ PATH: '/a:/b' }, { executable: exec(['/b/claude', '/sdk/claude']), sdk: () => '/sdk/claude' }), '/b/claude');
  assert.equal(findClaude({ PATH: 'rel:/a' }, { executable: exec(['rel/claude', '/sdk/claude']), sdk: () => '/sdk/claude' }), '/sdk/claude');
  assert.equal(findClaude({}, { executable: exec([]), sdk: () => '/sdk/claude' }), undefined);
  assert.equal(parseClaudeVersion('2.1.311 (Claude Code)\n'), '2.1.311');
});

test(
  'sessionContext: пространство — шапка, карта памятью (запущено с ним) или «прочитай», документы, состояние данными, space_write; теги знаний строкой',
  withConfigDir(() => {
    createSpace('checkout', { title: 'Корзина', gist: 'валидация' });
    writeSpaceState('checkout', '**Суть** валидация', { id: 'r1', at: '', kind: 'run' });
    addSpaceDoc('checkout', { name: 'spec.md', data: Buffer.from('# Спека').toString('base64') });
    createTag('api');
    updateTag('api', { description: 'Когда трогаешь API' });
    const ctx = ctxOf('checkout', ['api', 'missing']);
    const text = sessionContext(ctx, 'checkout');
    assert.match(text, /^Контекст agentgraph для этой сессии: пространство и теги знаний\./);
    assert.ok(text.includes('Пространство agentgraph «Корзина» (checkout)'));
    assert.match(text, /уже в контексте как память/);
    assert.ok(text.includes(`Документы пространства в ${path.join(spaceDir('checkout'), 'docs')} (открывай инструментом Read, когда нужны): spec.md (`), text);
    assert.ok(text.includes('<source-data>\n**Суть** валидация\n</source-data>'));
    assert.match(text, /space_write/);
    assert.ok(text.includes('knowledge_read') && text.includes('- api: Когда трогаешь API'));
    // процесс запущен без этого пространства — карта не в памяти
    assert.match(sessionContext(ctx, undefined), /прочитай её инструментом Read/);
    assert.equal(sessionContext({ knowledge: [] }), '');
    // удалённое пространство и тег задачи среди тегов — в контекст не идут
    assert.deepEqual(ctxOf('nope', []), { knowledge: [] });
  }),
);

test(
  'sessionContext: не влезло в бюджет — короче список документов, потом теги «целиком» строкой; и так не влезло — обрезка с пометкой',
  withConfigDir(() => {
    createSpace('s');
    for (let i = 0; i < 30; i++) addSpaceDoc('s', { name: `doc-${String(i).padStart(2, '0')}-${'x'.repeat(150)}.md`, data: Buffer.from('x').toString('base64') });
    createTag('big');
    updateTag('big', { notes: 'Первая строка big\n' + 'y'.repeat(3900), inline: true });
    const ctx = ctxOf('s', ['big']);
    const text = sessionContext(ctx, 's');
    assert.ok(text.length <= CONTEXT_BUDGET, String(text.length));
    assert.ok(text.includes('…и ещё 25.'), 'документы — пять и «ещё»');
    assert.ok(text.includes('yyyy'), 'тег целиком ещё влезает');
    const tight = sessionContext(ctx, 's', 2500);
    assert.ok(tight.includes('Документов пространства: 30'));
    assert.ok(tight.includes('- big: Первая строка big'));
    assert.ok(!tight.includes('yyyy'));
    const cut = sessionContext(ctx, 's', 200);
    assert.equal(cut.length, 200);
    assert.ok(cut.endsWith('…(контекст agentgraph обрезан по лимиту хука)'));
  }),
);

test(
  'contextDelta: новое пространство — раздел с «прочитай карту», снятое — строка; теги — строки добавленных и снятых; изменений нет — пусто',
  withConfigDir(() => {
    createSpace('a', { title: 'А' });
    createSpace('b', { title: 'Б' });
    createTag('k1');
    createTag('k2');
    assert.equal(contextDelta(ctxOf('a', ['k1']), { space: 'a', tags: ['k1'] }, 'a'), '');
    const swap = contextDelta(ctxOf('b', ['k1', 'k2']), { space: 'a', tags: ['k1', 'old'] }, 'a');
    assert.match(swap, /^Контекст agentgraph этой сессии изменился\./);
    assert.ok(swap.includes('Пространство a снято'));
    assert.ok(swap.includes('Пространство agentgraph «Б» (b)'));
    assert.match(swap, /прочитай её инструментом Read/);
    assert.ok(swap.includes('- k2: описания нет') && !swap.includes('- k1'));
    assert.ok(swap.includes('Тег old снят'));
    const gone = contextDelta(ctxOf(undefined, []), { space: 'a', tags: [] }, 'a');
    assert.ok(gone.includes('Пространство a снято') && !gone.includes('Пространство agentgraph'));
    // вернули пространство, с которым запущен процесс, — карта снова «уже в памяти»
    assert.match(contextDelta(ctxOf('a', []), { tags: [] }, 'a'), /уже в контексте как память/);
  }),
);

const deps = (root = '/nowhere'): HookDeps => ({
  readCtx: (space, tags) => ctxOf(space, tags),
  readTargets: (c) => sessionReadTargets(c, path.join(root, 'runs')),
  realpath: safeRealpath,
});
const state = (o: Partial<HookState> = {}): HookState => ({ tags: [], injected: null, status: 'starting', claudeSessionIds: [], started: false, turns: 0, ...o });

test(
  'хуки: SessionStart любого source отдаёт полный контекст, запоминает разговор; доставлено — пространство и все теги',
  withConfigDir(() => {
    createTag('a');
    createSpace('feat', { title: 'Фича' });
    const OLD = '11111111-2222-4333-8444-555555555555';
    const NEW = '99999999-2222-4333-8444-555555555555';
    const r = handleHook(
      state({ space: 'feat', launchSpace: 'feat', tags: ['a'], injected: { space: 'feat', tags: ['a'] }, claudeSessionIds: [OLD] }),
      { hook_event_name: 'SessionStart', source: 'clear', session_id: NEW, transcript_path: `/t/${NEW}.jsonl` },
      deps(),
    );
    const out = r.reply.hookSpecificOutput as { hookEventName: string; additionalContext: string };
    assert.equal(out.hookEventName, 'SessionStart');
    assert.ok(out.additionalContext.includes('Пространство agentgraph «Фича» (feat)'));
    assert.ok(out.additionalContext.includes('- a: описания нет'));
    assert.deepEqual(r.patch, { claudeSessionIds: [OLD, NEW], transcriptPath: `/t/${NEW}.jsonl`, started: true, status: 'waiting' });
    assert.deepEqual(r.delivered, { space: 'feat', tags: ['a'] });
    // --resume сессии до пространств: в транскрипте выше — контекст её тега задачи от прошлой версии, он устарел
    const text = (o: Partial<HookState>, source: string) =>
      (handleHook(state({ space: 'feat', launchSpace: 'feat', ...o }), { hook_event_name: 'SessionStart', source }, deps()).reply.hookSpecificOutput as { additionalContext: string }).additionalContext;
    assert.ok(text({ preSpacesTags: ['feat'] }, 'resume').startsWith('В разговоре выше может быть контекст тегов задач (feat) от прошлой версии agentgraph: он устарел'));
    assert.ok(!text({ preSpacesTags: ['feat'] }, 'startup').includes('прошлой версии'));
    assert.ok(!text({}, 'resume').includes('прошлой версии'));
  }),
);

test(
  'хуки: UserPromptSubmit без SessionStart — весь контекст, потом только изменения; без изменений — пустой ответ',
  withConfigDir(() => {
    createTag('a');
    createTag('b');
    const first = handleHook(state({ tags: ['a'] }), { hook_event_name: 'UserPromptSubmit', prompt: 'почини' }, deps());
    assert.ok(JSON.stringify(first.reply).includes('Контекст agentgraph для этой сессии'));
    assert.deepEqual([first.patch.status, first.patch.turns, first.delivered, first.turn], ['working', 1, { tags: ['a'] }, { prompt: 'почини' }]);
    const same = handleHook(state({ tags: ['a'], injected: { tags: ['a'] }, turns: 1 }), { hook_event_name: 'UserPromptSubmit', prompt: 'ещё' }, deps());
    assert.deepEqual([same.reply, same.delivered], [{}, undefined]);
    createSpace('feat');
    const batch = handleHook(state({ space: 'feat', tags: ['a', 'b'], injected: { tags: ['a'] }, status: 'working' }), { hook_event_name: 'PostToolBatch' }, deps());
    const ctx = (batch.reply.hookSpecificOutput as { additionalContext: string }).additionalContext;
    assert.ok(ctx.includes('- b: описания нет') && !ctx.includes('- a:'));
    assert.ok(ctx.includes('Пространство agentgraph feat'));
    assert.deepEqual([batch.delivered, batch.turn, batch.patch.turns], [{ space: 'feat', tags: ['a', 'b'] }, undefined, undefined]);
  }),
);

test(
  'хуки: пачка инструментов сабагента изменения тегов не забирает — они дойдут до основного разговора',
  withConfigDir(() => {
    createTag('a');
    createTag('b');
    const r = handleHook(state({ tags: ['a', 'b'], injected: { tags: ['a'] }, status: 'working' }), { hook_event_name: 'PostToolBatch', agent_id: 'sub-1' }, deps());
    assert.deepEqual([r.reply, r.delivered, r.patch.status], [{}, undefined, 'working']);
    assert.equal(parseHookInput({ hook_event_name: 'PostToolBatch', agent_id: 'sub-1' })?.agent_id, 'sub-1');
  }),
);

test('хуки: режим разрешений основного разговора запоминается, сабагента — нет; PreToolUse спрашивает только про session_new и space_write', () => {
  assert.equal(handleHook(state(), { hook_event_name: 'UserPromptSubmit', prompt: 'x', permission_mode: 'plan' }, deps()).patch.permissionMode, 'plan');
  assert.equal(handleHook(state({ permissionMode: 'plan' }), { hook_event_name: 'Stop', permission_mode: 'plan' }, deps()).patch.permissionMode, undefined);
  assert.equal(handleHook(state(), { hook_event_name: 'PostToolBatch', agent_id: 'a1', permission_mode: 'auto' }, deps()).patch.permissionMode, undefined);
  assert.deepEqual(parseHookInput({ hook_event_name: 'Stop', permission_mode: 'auto' }), { hook_event_name: 'Stop', permission_mode: 'auto' });
  for (const tool of ['mcp__agentgraph__session_new', 'mcp__agentgraph__space_write']) {
    const ask = handleHook(state(), { hook_event_name: 'PreToolUse', tool_name: tool, permission_mode: 'auto' }, deps()).reply;
    assert.equal((ask.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'ask', tool);
  }
  assert.deepEqual(handleHook(state(), { hook_event_name: 'PreToolUse', tool_name: 'mcp__agentgraph__knowledge_read' }, deps()).reply, {});
  assert.deepEqual(handleHook(state(), { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, deps()).reply, {});
});

test('хуки: id разговора не UUID в историю разговоров не попадает (он ушёл бы в --resume)', () => {
  const r = handleHook(state({ claudeSessionIds: ['11111111-2222-4333-8444-555555555555'] }), { hook_event_name: 'Stop', session_id: '--dangerously-skip-permissions', transcript_path: '/t/x.jsonl' }, deps());
  assert.deepEqual([r.patch.claudeSessionIds, r.patch.transcriptPath], [undefined, undefined]);
});

test('хуки: Stop и StopFailure — ждёт тебя, Notification об ожидании — тоже; SessionEnd с clear сессию не завершает', () => {
  const stop = handleHook(state({ status: 'working' }), { hook_event_name: 'Stop', last_assistant_message: 'Готово' }, deps());
  assert.deepEqual([stop.patch.status, stop.turn], ['waiting', { answer: 'Готово' }]);
  assert.equal(handleHook(state({ status: 'working' }), { hook_event_name: 'StopFailure' }, deps()).patch.status, 'waiting');
  for (const type of ['permission_prompt', 'idle_prompt', 'elicitation_dialog']) {
    assert.equal(handleHook(state({ status: 'working' }), { hook_event_name: 'Notification', notification_type: type }, deps()).patch.status, 'waiting');
  }
  assert.equal(handleHook(state({ status: 'working' }), { hook_event_name: 'Notification', notification_type: 'auth_success' }, deps()).patch.status, undefined);
  const end = handleHook(state({ status: 'waiting', claudeSessionIds: ['s1'] }), { hook_event_name: 'SessionEnd', reason: 'clear', session_id: 's1' }, deps());
  assert.deepEqual([end.reply, end.patch], [{}, {}]);
});

test(
  'PermissionRequest: чтение внутри папки текущего тега — allow только этого вызова, папка рабочей не становится; снаружи, запись и ссылка наружу — решает человек',
  withConfigDir((root) => {
    const specs = path.join(root, 'specs');
    fs.mkdirSync(specs);
    fs.writeFileSync(path.join(specs, 'a.md'), 'x');
    fs.symlinkSync('/etc', path.join(specs, 'etc'));
    createTag('k');
    updateTag('k', { dirs: [specs] });
    const ask = (tool: string, input: Record<string, unknown>) =>
      handleHook(state({ tags: ['k'], injected: { tags: ['k'] } }), { hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: input }, deps(root)).reply;
    const allow = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    // без updatedPermissions: addDirectories сделал бы папку рабочей, а в acceptEdits — открытой на запись
    assert.deepEqual(ask('Read', { file_path: path.join(specs, 'a.md') }), allow);
    assert.deepEqual(ask('Grep', { path: specs, pattern: 'x' }), allow);
    assert.deepEqual(ask('Glob', { path: specs, pattern: '**/*.md' }), allow);
    assert.deepEqual(ask('Glob', { path: specs, pattern: '/Users/me/.ssh/*' }), {});
    assert.deepEqual(ask('Glob', { path: specs, pattern: '../*' }), {});
    assert.deepEqual(ask('Read', { file_path: path.join(specs, '..', 'other.md') }), {});
    assert.deepEqual(ask('Read', { file_path: path.join(specs, 'etc', 'hosts') }), {});
    assert.deepEqual(ask('Write', { file_path: path.join(specs, 'a.md') }), {});
    assert.deepEqual(ask('Read', { file_path: 'specs/a.md' }), {});
    assert.deepEqual(permissionReply({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'cat x' } }, { dirs: [specs], files: [] }, safeRealpath), {});
  }),
);

test(
  'PermissionRequest: путь тега — файл: читать можно только его, а не всю папку, где он лежит',
  withConfigDir((root) => {
    const notes = path.join(root, 'notes.md');
    fs.writeFileSync(notes, 'x');
    fs.writeFileSync(path.join(root, 'id_rsa'), 'secret');
    createTag('k');
    updateTag('k', { dirs: [notes] });
    const t = sessionReadTargets(ctxOf(undefined, ['k']), path.join(root, 'runs'));
    assert.deepEqual(t, { dirs: [], files: [notes] });
    const ask = (tool: string, input: Record<string, unknown>) => permissionReply({ hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: input }, t, safeRealpath);
    assert.ok(ask('Read', { file_path: notes }).hookSpecificOutput);
    assert.deepEqual(ask('Read', { file_path: path.join(root, 'id_rsa') }), {});
    assert.deepEqual(ask('Grep', { path: root, pattern: 'secret' }), {});
  }),
);

test('parseHookInput: только объект с hook_event_name; лишние поля и не-строки отбрасываются', () => {
  assert.equal(parseHookInput(null), undefined);
  assert.equal(parseHookInput({ session_id: 'x' }), undefined);
  assert.deepEqual(parseHookInput({ hook_event_name: 'Stop', session_id: 's', prompt: 5, extra: 1, tool_input: [1] }), { hook_event_name: 'Stop', session_id: 's' });
});

test('«Продолжить»: --resume, только если транскрипт последнего разговора есть; иначе новый разговор', () => {
  const tp = '/p/-shop/b2.jsonl';
  assert.equal(resumeTarget({ claudeSessionIds: ['b1', 'b2'], transcriptPath: tp }, (p) => p === tp), 'b2');
  assert.equal(resumeTarget({ claudeSessionIds: ['b1', 'b2'], transcriptPath: tp }, () => false), undefined);
  assert.equal(resumeTarget({ claudeSessionIds: ['b1', 'b3'], transcriptPath: tp }, () => true), undefined);
  assert.equal(resumeTarget({ claudeSessionIds: [] }, () => true), undefined);
});

test('idleAgents: простаивающие разговоры из `claude agents --json`; мусор — пусто', () => {
  assert.deepEqual([...idleAgents(JSON.stringify([{ sessionId: 'a', status: 'idle' }, { sessionId: 'b', status: 'busy' }, null]))], ['a']);
  assert.deepEqual([...idleAgents('not json')], []);
});

test(
  'пространство на ходу: PermissionRequest пропускает чтение в его папке, его путях и артефактах; файл-путь — только его; папки сессии — своя папка пространства и пути',
  withConfigDir((root) => {
    const specs = path.join(root, 'specs');
    fs.mkdirSync(specs);
    const note = path.join(root, 'note.md');
    fs.writeFileSync(note, 'x');
    fs.writeFileSync(path.join(root, 'secret'), 'x');
    const runsDir = path.join(root, 'runs');
    fs.mkdirSync(path.join(runsDir, 'r1', 'artifacts'), { recursive: true });
    createSpace('feat', { dirs: [specs, note] });
    writeSpaceState('feat', 'ok', { id: 'r1', at: '', kind: 'run' });
    const ctx = ctxOf('feat', []);
    const t = sessionReadTargets(ctx, runsDir);
    assert.deepEqual(t.dirs.sort(), [spaceDir('feat'), specs, path.join(runsDir, 'r1', 'artifacts')].sort());
    assert.deepEqual(t.files, [note]);
    const ask = (input: Record<string, unknown>) => permissionReply({ hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: input }, t, safeRealpath);
    assert.ok(ask({ file_path: path.join(spaceDir('feat'), 'CLAUDE.md') }).hookSpecificOutput);
    assert.ok(ask({ file_path: note }).hookSpecificOutput);
    assert.deepEqual(ask({ file_path: path.join(root, 'secret') }), {});
    // путь-файл не открывает свою папку целиком: --add-dir — только папки, файл читается через хук
    assert.deepEqual(sessionDirs(ctx, runsDir), [spaceDir('feat'), specs, path.join(runsDir, 'r1', 'artifacts')]);
    assert.ok(fs.existsSync(tagDir('nothing')) === false);
  }),
);
