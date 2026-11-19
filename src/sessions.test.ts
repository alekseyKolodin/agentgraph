import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASK_TEXT_MAX, childPermissionMode, contextDelta, CONTEXT_BUDGET, findClaude, handleHook, idleAgents, launchDirs, parseClaudeVersion, parseHookInput, permissionReply, questionOf, readSessionCtx,
  resumeTarget, safeRealpath, sessionArgs, sessionContext, sessionDirs, sessionEnv, sessionFlags, sessionName, sessionPrompt, sessionReadTargets, SESSION_PROMPT_MAX,
  sessionSettings, versionAtLeast, type HookDeps, type HookState, type SessionLaunch, type WriteCall,
} from './sessions.js';
import { configDir } from './settings.js';
import { createTag, readTag, tagDir, tagsDir, updateTag } from './tags.js';
import { addSpaceDoc, createSpace, readSpace, spaceDir, spacesDir, writeSpaceState } from './spaces.js';
import { teamsDir } from './teamwork.js';

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
/** Инструменты agentgraph с вопросом в любом режиме — порядок как в sessionSettings. */
const ASK_FULL = ['session_new', 'space_write', 'space_map_write', 'space_state_write', 'space_settings', 'flow_write', 'team_task_update', 'team_doc_write', 'knowledge_note'].map((t) => `mcp__agentgraph__${t}`);

test('sessionArgs: новый разговор — --session-id, название через =, хуки и MCP одним JSON, без модели и режима', () => {
  const args = sessionArgs(launch({ name: '-dash name' }));
  assert.deepEqual(args.slice(0, 2), ['--session-id=11111111-2222-4333-8444-555555555555', '--name=-dash name']);
  assert.ok(!args.includes('--model') && !args.includes('--permission-mode'));
  assert.ok(!args.some((a) => a.includes('append-system-prompt') || a === '--bare' || a === '--strict-mcp-config'));
  // без подтверждения — только чтение тегов знаний: space_write и session_new спрашивают человека
  assert.equal(flagValue(args, '--allowedTools'), 'mcp__agentgraph__knowledge_read,mcp__agentgraph__desk_list');
  assert.deepEqual(args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : [])), ['/data/tags/a', '/files']);

  const settings = JSON.parse(flagValue(args, '--settings'));
  const start = settings.hooks.SessionStart[0].hooks[0];
  // HTTP-хуки на SessionStart Claude Code пропускает: только командой, -f и || true
  assert.equal(start.type, 'command');
  assert.match(start.command, /^curl -sSf --max-time 5 .*'X-Agentgraph-Session: tok123'.*'http:\/\/127\.0\.0\.1:4755\/api\/sessions\/11111111-2222-4333-8444-555555555555\/hook' \|\| true$/);
  for (const e of ['UserPromptSubmit', 'PostToolBatch', 'Stop', 'StopFailure', 'Notification', 'SessionEnd', 'PermissionRequest', 'PreToolUse', 'PostToolUse']) {
    const h = settings.hooks[e][0].hooks[0];
    assert.deepEqual([h.type, h.url, h.headers], ['http', 'http://127.0.0.1:4755/api/sessions/11111111-2222-4333-8444-555555555555/hook', { 'X-Agentgraph-Session': 'tok123' }]);
  }
  // PreToolUse — на инструменты agentgraph, которые пишут, на запись файлов и на Bash (сверка в bypassPermissions):
  // остальные инструменты хук не задерживает
  assert.deepEqual(settings.hooks.PreToolUse.map((h: { matcher: string }) => h.matcher), [...ASK_FULL, 'Edit|Write|MultiEdit|NotebookEdit', 'Bash']);
  // PostToolUse — на любой инструмент: снять «ждёт разрешения»; запись файлов — ещё и проверка записанного и событие для UI
  assert.deepEqual(settings.hooks.PostToolUse.map((h: { matcher?: string }) => h.matcher), [undefined]);
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
  'launchDirs: пути внутри проекта и содержащие его не трогаются; запрет записи — на папку тегов, команд, чужие пространства, артефакты, открытые папки и служебные файлы настроек; своё пространство и папка flow — вопросом',
  withConfigDir(() => {
    const root = tagsDir();
    const spaces = spacesDir();
    const art = '/ag/runs/r1/artifacts';
    fs.mkdirSync(path.join(spaces, 'feat'), { recursive: true });
    fs.mkdirSync(path.join(spaces, 'other'), { recursive: true });
    fs.writeFileSync(path.join(configDir(), 'settings.json'), '{}');
    fs.writeFileSync(path.join(configDir(), 'jira-token'), 'x');
    const reads = ['/p/shop/docs', '/p', '/specs', `${root}/a/attachments`, `${spaces}/feat`, `${spaces}/other/docs`, `${teamsDir()}/pay/repo`, '/odd(dir)', '/glob[1]', art, '/flows/lib'];
    const r = launchDirs(reads, '/p/shop', '/s/files', [art], { spaces: ['feat'], flowsDir: '/flows' });
    assert.deepEqual(r.addDirs, ['/specs', `${root}/a/attachments`, `${spaces}/feat`, `${spaces}/other/docs`, `${teamsDir()}/pay/repo`, art, '/flows/lib', '/s/files']);
    // своё пространство и папка чтения в папке flow запретом не закрыты: их правку решают вопрос и хук записи; чужое — закрыто
    assert.deepEqual(r.denyDirs, [root, teamsDir(), art, '/specs', path.join(spaces, 'other')]);
    assert.deepEqual(r.denyFiles, [path.join(spaces, '.migrated.json'), path.join(configDir(), 'jira-token'), path.join(configDir(), 'settings.json')]);
    assert.deepEqual(r.askDirs, [path.join(spaces, 'feat'), '/flows']);
    // без своего пространства — закрыта вся папка пространств, как раньше; папка flow — по-прежнему вопросом
    const none = launchDirs([], '/p/shop', '/s/files', [], { flowsDir: '/flows' });
    assert.ok(none.denyDirs.includes(spaces));
    assert.deepEqual(none.askDirs, ['/flows']);
  }),
);

test(
  'launchDirs: проект в домашней папке — папки тегов, пространств, команд и артефакты внутри него всё равно закрыты для записи',
  withConfigDir((home) => {
    const root = tagsDir();
    const art = path.join(home, 'ag', 'runs', 'r1', 'artifacts');
    const r = launchDirs([art], home, '/s/files', [art]);
    assert.deepEqual(r.addDirs, ['/s/files']);
    assert.deepEqual(r.denyDirs, [root, teamsDir(), spacesDir(), art]);
    // cwd внутри папки тегов — её не закрываем: это и есть проект; папка команд закрыта всё равно
    assert.deepEqual(launchDirs([], path.join(root, 'a'), '/s/files').denyDirs, [teamsDir(), spacesDir()]);
    // сессия в клоне команды (терминал из задачи открывается в worktree репо кода, но если открыли сам клон) — он проект
    assert.deepEqual(launchDirs([], path.join(teamsDir(), 'pay', 'repo'), '/s/files').denyDirs, [root, spacesDir()]);
  }),
);

test(
  'launchDirs: сессия в папке пространства правит его целиком — карту, документы, space.json и .claude/ — с вопросом на каждую правку; другие пространства закрыты',
  withConfigDir(() => {
    const own = path.join(spacesDir(), 'feat');
    const other = path.join(spacesDir(), 'other');
    fs.mkdirSync(path.join(own, '.claude'), { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const r = launchDirs([own], own, '/s/files');
    assert.deepEqual(r.addDirs, ['/s/files']);
    // .claude/ и space.json своего больше не закрыты
    assert.deepEqual(r.denyDirs.sort(), [tagsDir(), teamsDir(), other].sort());
    assert.deepEqual(r.denyFiles, [path.join(spacesDir(), '.migrated.json')]);
    assert.deepEqual(r.askDirs, [own]);
    const settings = sessionSettings(launch({ ...r, claudeVersion: '2.1.317' })) as { permissions: { ask: string[]; deny: string[] }; hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> } };
    assert.ok(settings.permissions.ask.includes(`Edit(/${own}/**)`));
    assert.ok(!settings.permissions.deny.some((d) => d.includes('.claude') || d.includes('space.json')));
    // своё пространство выбрано и открыто в его же папке — одно и то же
    assert.deepEqual(launchDirs([own], own, '/s/files', [], { spaces: ['feat'] }).askDirs, [own]);
    // хук записи — у каждой сессии, и в папке пространства, и вне её; сбой хука блокирует запись
    assert.deepEqual(settings.hooks.PreToolUse.filter((h) => h.matcher.includes('Edit')).map((h) => [h.matcher, h.hooks[0].onFailure]), [['Edit|Write|MultiEdit|NotebookEdit', 'block']]);
    const plain = sessionSettings(launch({ ...launchDirs([own], '/p', '/s/files') })) as { hooks: { PreToolUse: Array<{ matcher: string }> } };
    assert.ok(plain.hooks.PreToolUse.some((h) => h.matcher.includes('Edit')));
  }),
);

test('хуки: запись файла — решение writeGuard: deny и ask с причиной, нет решения — пустой ответ (решают правила и режим), упал — отказ', () => {
  const write = (guard: HookDeps['writeGuard']) => handleHook(state(), { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/x' } }, { ...deps(), writeGuard: guard }).reply;
  assert.deepEqual(write(() => ({ decision: 'deny', reason: 'нельзя' })), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'нельзя' } });
  assert.deepEqual(write(() => ({ decision: 'ask', reason: 'карта пространства' })), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'карта пространства' } });
  assert.deepEqual(write(() => undefined), {});
  assert.match(JSON.stringify(write(() => { throw new Error('boom'); })), /"deny".*Проверка записи не удалась \(boom\)/);
  // рабочая папка claude и id вызова из входа хука доходят до проверки: от папки — относительные пути, id — снимок;
  // режим проверке не нужен — решение от него не зависит
  let seen: WriteCall | undefined;
  const input = parseHookInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.md' }, cwd: '/sp/own/docs', permission_mode: 'acceptEdits', tool_use_id: 'tu1' })!;
  handleHook(state(), input, { ...deps(), writeGuard: (_t, _i, call) => { seen = call; return undefined; } });
  assert.deepEqual(seen, { cwd: '/sp/own/docs', toolUseId: 'tu1' });
});

test('хуки: PostToolUse записи — что сказал afterWrite, уходит модели decision: block с причиной; упал — тоже; не запись — пусто', () => {
  const post = (tool: string, after: HookDeps['afterWrite']) => handleHook(state(), { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: '/x' }, tool_use_id: 'tu1' }, { ...deps(), afterWrite: after }).reply;
  assert.deepEqual(post('Write', () => 'space.json сломан — возвращена версия до записи'), { decision: 'block', reason: 'space.json сломан — возвращена версия до записи' });
  assert.deepEqual(post('Edit', () => undefined), {});
  assert.match(String(post('Edit', () => { throw new Error('boom'); }).reason), /Проверка после записи не удалась: boom/);
  let called = false;
  assert.deepEqual(post('Bash', () => { called = true; return 'x'; }), {});
  assert.equal(called, false);
});

test('sessionSettings: инструменты agentgraph, которые пишут, — в permissions.ask (вопрос и без хука), как и папки askDirs; onFailure: block у хука — только claude 2.1.295+', () => {
  const ask = ASK_FULL;
  const hooksOf = (v?: string) => (sessionSettings(launch(v ? { claudeVersion: v } : {})) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> }; permissions: { ask: string[] } });
  for (const v of [undefined, '2.1.285', '2.1.317']) assert.deepEqual(hooksOf(v).permissions.ask, ask, String(v));
  // Bash — без onFailure: block: эвристика bypassPermissions не останавливает каждую команду, когда сервер недоступен
  assert.deepEqual(hooksOf('2.1.317').hooks.PreToolUse.map((h) => [h.matcher, h.hooks[0].onFailure]), [...[...ask, 'Edit|Write|MultiEdit|NotebookEdit'].map((m) => [m, 'block']), ['Bash', undefined]]);
  // папки с вопросом: сама папка и всё внутри
  assert.deepEqual((sessionSettings(launch({ askDirs: ['/cfg/spaces', '/flows'] })) as { permissions: { ask: string[] } }).permissions.ask.slice(ask.length), ['Edit(//cfg/spaces)', 'Edit(//cfg/spaces/**)', 'Edit(//flows)', 'Edit(//flows/**)']);
  // старый claude ключа не знает — ему не шлём; неизвестная версия — тоже
  assert.ok(hooksOf('2.1.285').hooks.PreToolUse.every((h) => !('onFailure' in h.hooks[0])));
  assert.ok(hooksOf().hooks.PreToolUse.every((h) => !('onFailure' in h.hooks[0])));
  assert.deepEqual([versionAtLeast('2.1.295', '2.1.295'), versionAtLeast('2.2.0 (Claude Code)', '2.1.295'), versionAtLeast('2.1.29', '2.1.295'), versionAtLeast(undefined, '1.0.0')], [true, true, false, false]);
});

test(
  'launchDirs: ~/.agentgraph — ссылка: запрет и вопрос записи и по лексическому пути, и по настоящему',
  withConfigDir((root) => {
    const real = path.join(root, 'real-cfg');
    fs.mkdirSync(path.join(real, 'spaces'), { recursive: true });
    fs.mkdirSync(path.join(real, 'tags'), { recursive: true });
    fs.mkdirSync(path.join(real, 'teams'), { recursive: true });
    const link = path.join(root, 'link-cfg');
    fs.symlinkSync(real, link);
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = link;
    try {
      const r = launchDirs([], '/p', '/s/files');
      for (const d of [path.join(link, 'spaces'), path.join(real, 'spaces'), path.join(link, 'tags'), path.join(real, 'tags'), path.join(link, 'teams'), path.join(real, 'teams')]) assert.ok(r.denyDirs.includes(d), d);
      // своё пространство — вопросом по обоим путям
      fs.mkdirSync(path.join(real, 'spaces', 'feat'));
      const mine = launchDirs([], '/p', '/s/files', [], { spaces: ['feat'] });
      for (const d of [path.join(link, 'spaces', 'feat'), path.join(real, 'spaces', 'feat')]) assert.ok(mine.askDirs.includes(d), d);
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

test('хуки: режим разрешений основного разговора запоминается, сабагента — нет; PreToolUse спрашивает только про инструменты agentgraph, которые пишут', () => {
  assert.equal(handleHook(state(), { hook_event_name: 'UserPromptSubmit', prompt: 'x', permission_mode: 'plan' }, deps()).patch.permissionMode, 'plan');
  assert.equal(handleHook(state({ permissionMode: 'plan' }), { hook_event_name: 'Stop', permission_mode: 'plan' }, deps()).patch.permissionMode, undefined);
  assert.equal(handleHook(state(), { hook_event_name: 'PostToolBatch', agent_id: 'a1', permission_mode: 'auto' }, deps()).patch.permissionMode, undefined);
  assert.deepEqual(parseHookInput({ hook_event_name: 'Stop', permission_mode: 'auto' }), { hook_event_name: 'Stop', permission_mode: 'auto' });
  for (const tool of ASK_FULL) {
    const ask = handleHook(state(), { hook_event_name: 'PreToolUse', tool_name: tool, permission_mode: 'auto' }, deps()).reply;
    assert.equal((ask.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'ask', tool);
  }
  assert.deepEqual(handleHook(state(), { hook_event_name: 'PreToolUse', tool_name: 'mcp__agentgraph__knowledge_read' }, deps()).reply, {});
  assert.deepEqual(handleHook(state(), { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, deps()).reply, {});
});

test('хуки: инструменты agentgraph с вопросом спрашивают в любом режиме, bypassPermissions тоже (claude 2.1.285+); в dontAsk — отказ с причиной; не прошедший проверку вызов — отказ без вопроса в любом режиме', () => {
  const decide = (tool: string, mode?: string, detail?: HookDeps['askDetail']) =>
    handleHook(state(), { hook_event_name: 'PreToolUse', tool_name: tool, ...(mode ? { permission_mode: mode } : {}) }, { ...deps(), claudeVersion: () => '2.1.285 (Claude Code)', ...(detail ? { askDetail: detail } : {}) }).reply.hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
  const modes = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk'];
  for (const mode of modes) {
    for (const tool of ASK_FULL) {
      const d = decide(tool, mode);
      // dontAsk: правило ask claude там превращает в отказ без вопроса — отказываем сами, модель узнаёт причину
      if (mode === 'dontAsk') assert.deepEqual([d.permissionDecision, /В режиме dontAsk claude не показывает вопрос.*Shift\+Tab/.test(d.permissionDecisionReason)], ['deny', true], tool);
      else assert.equal(d.permissionDecision, 'ask', `${mode} ${tool}`);
    }
    // askDetail сказал { deny } (схема flow не прошла): человека не спрашиваем, модель получает ошибки
    const bad = decide('mcp__agentgraph__flow_write', mode, () => ({ deny: 'phases: Required' }));
    assert.deepEqual([bad.permissionDecision, bad.permissionDecisionReason], ['deny', 'phases: Required'], mode);
  }
  assert.match(decide('mcp__agentgraph__flow_write', 'default', () => 'flows/x.yaml: новый flow').permissionDecisionReason, /flow запишется.*\. flows\/x\.yaml: новый flow$/);
});

test('хуки: claude старше 2.1.285 или неизвестной версии в bypassPermissions вместо вопроса — отказ (и инструменту agentgraph, и записи); в dontAsk — отказ режима при любой версии; в остальных режимах — вопрос; отказ записи остаётся отказом', () => {
  const pre = (tool: string, mode: string, version: string | undefined, guard?: HookDeps['writeGuard']) =>
    handleHook(state(), { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: '/sp/own/CLAUDE.md' }, permission_mode: mode }, { ...deps(), claudeVersion: () => version, ...(guard ? { writeGuard: guard } : {}) }).reply.hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
  const askWrite: HookDeps['writeGuard'] = () => ({ decision: 'ask', reason: 'карта пространства' });
  for (const version of ['2.1.284 (Claude Code)', undefined, 'мусор']) {
    for (const mode of ['bypassPermissions', 'dontAsk']) {
      for (const d of [pre('mcp__agentgraph__space_map_write', mode, version), pre('Write', mode, version, askWrite)]) {
        assert.equal(d.permissionDecision, 'deny', `${mode} ${version}`);
        if (mode === 'dontAsk') assert.match(d.permissionDecisionReason, /В режиме dontAsk claude не показывает вопрос/);
        else assert.match(d.permissionDecisionReason, new RegExp(`В режиме ${mode} claude ${version === '2.1.284 (Claude Code)' ? '2\\.1\\.284' : 'неизвестной версии'} может не показать вопрос.*2\\.1\\.285`));
      }
      assert.equal(pre('Write', mode, version, () => ({ decision: 'deny', reason: 'чужое пространство' })).permissionDecisionReason, 'чужое пространство');
    }
    for (const mode of ['default', 'acceptEdits', 'auto']) {
      assert.equal(pre('mcp__agentgraph__space_map_write', mode, version).permissionDecision, 'ask', `${mode} ${version}`);
      assert.equal(pre('Write', mode, version, askWrite).permissionDecision, 'ask', `${mode} ${version}`);
    }
  }
  assert.equal(pre('Write', 'bypassPermissions', '2.1.318 (Claude Code)', askWrite).permissionDecision, 'ask');
  // dontAsk и у нового claude: вопрос до человека не дойдёт — отказ с причиной, а не тихий отказ правила ask
  const dontAsk = pre('Write', 'dontAsk', '2.1.318 (Claude Code)', askWrite);
  assert.deepEqual([dontAsk.permissionDecision, dontAsk.permissionDecisionReason.startsWith('карта пространства. В режиме dontAsk')], ['deny', true]);
});

test('хуки: Bash сверяется со своим пространством и папкой flow только в bypassPermissions — вопрос с причиной (у старого claude — отказ), своё вместе с закрытым — отказ; в остальных режимах проверка не зовётся; упавшая проверка — вопрос', () => {
  let called = 0;
  const guard: HookDeps['bashGuard'] = (command, call) => {
    called++;
    assert.equal(call.cwd, '/proj');
    if (command.includes('/sp/other')) return { decision: 'deny', reason: 'Команда Bash трогает и своё, и чужое' };
    return command.includes('/sp/own') ? { decision: 'ask', reason: 'Команда Bash упоминает папку пространства own' } : undefined;
  };
  const bash = (command: unknown, mode: string, o: Partial<HookDeps> = {}) =>
    handleHook(state(), { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, permission_mode: mode, cwd: '/proj' }, { ...deps(), claudeVersion: () => '2.1.318 (Claude Code)', bashGuard: guard, ...o }).reply as { hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } };
  assert.deepEqual(bash('cp a /sp/own/x.md', 'bypassPermissions').hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Команда Bash упоминает папку пространства own' });
  assert.deepEqual(bash('npm test', 'bypassPermissions'), {});
  assert.equal(called, 2);
  for (const mode of ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk']) assert.deepEqual(bash('cp a /sp/own/x.md', mode), {}, mode);
  assert.equal(called, 2);
  assert.match(bash('cp a /sp/own/x.md', 'bypassPermissions', { claudeVersion: () => '2.1.284' }).hookSpecificOutput!.permissionDecisionReason, /В режиме bypassPermissions claude 2\.1\.284 может не показать вопрос/);
  assert.deepEqual(bash(42, 'bypassPermissions'), {});
  // своё и закрытое в одной команде — отказ проверки, а не вопрос
  assert.deepEqual(bash('cp /sp/own/a /sp/other/b', 'bypassPermissions').hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Команда Bash трогает и своё, и чужое' });
  const broken = bash('ls', 'bypassPermissions', { bashGuard: () => { throw new Error('нет папки'); } }).hookSpecificOutput!;
  assert.deepEqual([broken.permissionDecision, broken.permissionDecisionReason], ['ask', 'Проверка команды не удалась (нет папки)']);
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

test('вопрос в конце ответа: последний абзац кончается «?» — вопрос, иначе просто конец хода', () => {
  assert.equal(questionOf('Готово, закоммитил.'), undefined);
  assert.equal(questionOf(''), undefined);
  assert.equal(questionOf('Поправил корзину.\n\nТак делать или иначе?'), 'Так делать или иначе?');
  // разметка и хвост после знака не мешают; в тексте — без звёздочек и решёток
  assert.equal(questionOf('Сделал.\n\n**Продолжить с миграцией?**'), 'Продолжить с миграцией?');
  assert.equal(questionOf('## Что дальше?'), 'Что дальше?');
  assert.equal(questionOf('Можно так (вариант A)?\r\n'), 'Можно так (вариант A)?');
  // абзац склеивается в одну строку
  assert.equal(questionOf('Итог.\n\nЕсть два пути.\nКакой берём?'), 'Есть два пути. Какой берём?');
  // вопрос в середине, а кончается утверждением — не ждёт ответа
  assert.equal(questionOf('Нужен ли кэш? Сделал без него, тесты зелёные.'), undefined);
  assert.equal(questionOf('Что выбрать?\n\nСделал оба варианта.'), undefined);
  // блок кода в конце — не вопрос, даже если в коде «?»
  assert.equal(questionOf('Вот так?\n\n```ts\nconst a = b ?? c?\n```'), undefined);
});

test('вопрос в конце ответа: список вариантов после вопроса — тоже вопрос; список без вопроса — нет', () => {
  assert.equal(questionOf('Как сделать?\n\n1. Через A\n2. Через B'), 'Как сделать? 1. Через A 2. Через B');
  assert.equal(questionOf('Нашёл две причины.\n\nКакой вариант берём?\n- **A**: быстрее\n- B: надёжнее'), 'Какой вариант берём? - A: быстрее - B: надёжнее');
  assert.equal(questionOf('Сделал:\n\n- тесты\n- миграцию'), undefined);
  assert.equal(questionOf('- тесты\n- миграцию'), undefined);
  // после списка снова текст — последний абзац уже не список
  assert.equal(questionOf('Как?\n\n- A\n- B\n\nВыбрал A.'), undefined);
});

test('вопрос в конце ответа: заголовок-вопрос над списком, цитата чужого вопроса и код с отступом — не вопрос; «(y/n)» и цитата-вопрос — вопрос', () => {
  assert.equal(questionOf('## Почему падало?\n\n- гонка в кэше\n- таймаут'), undefined);
  assert.equal(questionOf('**Что изменилось?**\n- поправил кэш\n- добавил тест'), undefined);
  assert.equal(questionOf('Исправил по твоему вопросу «почему тест падает?»'), undefined);
  assert.equal(questionOf('Пример:\n\n    const x = a ?? b?'), undefined);
  assert.equal(questionOf('Всё готово. Want me to commit? (y/n)'), 'Всё готово. Want me to commit? (y/n)');
  assert.equal(questionOf('> Нужен ли кэш?'), 'Нужен ли кэш?');
});

test('вопрос в конце ответа: длинный абзац режется с начала, вопрос остаётся', () => {
  const q = questionOf(`${'очень длинное объяснение '.repeat(50)}так делаем?`)!;
  assert.ok(q.length <= ASK_TEXT_MAX, String(q.length));
  assert.ok(q.startsWith('…') && q.endsWith('так делаем?'), q);
});

test('хуки: «ждёт ответа» — только после вопроса, запроса разрешения или формы; простой конец хода вопроса не ставит', () => {
  const at = '2026-11-18T10:00:00.000Z';
  const d = { ...deps(), now: () => at };
  const stop = (answer: string, o: Partial<HookState> = {}) => handleHook(state({ status: 'working', ...o }), { hook_event_name: 'Stop', last_assistant_message: answer }, d).patch;
  assert.deepEqual(stop('Сделал.\n\nКоммитить?'), { status: 'waiting', ask: { kind: 'question', text: 'Коммитить?', at } });
  assert.deepEqual(stop('Готово.'), { status: 'waiting' });
  // прошлый вопрос не залипает: новый ход кончился без вопроса — снят
  const old = { kind: 'question' as const, text: 'Коммитить?', at: '2026-11-17T10:00:00.000Z' };
  assert.deepEqual(stop('Готово.', { ask: old }), { status: 'waiting', ask: null });
  assert.equal(handleHook(state({ status: 'working', ask: old }), { hook_event_name: 'StopFailure' }, d).patch.ask, null);
  const note = (type: string, o: Partial<HookState> = {}) => handleHook(state({ status: 'working', ...o }), { hook_event_name: 'Notification', notification_type: type, message: 'Claude needs your permission to use Bash' }, d).patch;
  assert.deepEqual(note('permission_prompt').ask, { kind: 'permission', text: 'Claude needs your permission to use Bash', at });
  assert.equal(note('elicitation_dialog').ask?.kind, 'elicitation');
  // простой — ход за человеком, но вопроса нет
  assert.deepEqual([note('idle_prompt').status, 'ask' in note('idle_prompt')], ['waiting', false]);
  // разрешение уже записал PermissionRequest — уведомление его не затирает
  const perm = { kind: 'permission' as const, text: 'Bash: npm test', at };
  assert.equal('ask' in note('permission_prompt', { ask: perm }), false);
});

test('хуки: PermissionRequest, который решает человек, — сессия ждёт ответа с инструментом и аргументом; AskUserQuestion — вопрос', () => {
  const at = '2026-11-18T10:00:00.000Z';
  const d = { ...deps(), now: () => at };
  const req = (tool: string, input: Record<string, unknown>) => handleHook(state({ status: 'working' }), { hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: input }, d);
  const bash = req('Bash', { command: 'npm test', description: 'тесты' });
  assert.deepEqual([bash.reply, bash.patch], [{}, { status: 'waiting', ask: { kind: 'permission', text: 'Bash: npm test', at, tool: 'Bash' } }]);
  assert.deepEqual(req('AskUserQuestion', { questions: [{ question: 'Какую базу берём?', options: [] }, { question: 'Нужны миграции?' }] }).patch.ask, { kind: 'question', text: 'Какую базу берём? · Нужны миграции?', at, tool: 'AskUserQuestion' });
  assert.equal(req('WebFetch', {}).patch.ask?.text, 'WebFetch');
});

test('хуки: разрешения просит сабагент — шаги другого сабагента вопрос не снимают, его собственный шаг — снимает', () => {
  const at = '2026-11-18T10:00:00.000Z';
  const d = { ...deps(), now: () => at };
  const req = handleHook(state({ status: 'working' }), { hook_event_name: 'PermissionRequest', agent_id: 'a', tool_name: 'Bash', tool_input: { command: 'make' } }, d).patch;
  assert.deepEqual(req.ask, { kind: 'permission', text: 'Bash: make', at, agent: 'a', tool: 'Bash' });
  const asked = state({ status: 'waiting', injected: { tags: [] }, ask: req.ask! });
  assert.deepEqual(handleHook(asked, { hook_event_name: 'PostToolBatch', agent_id: 'b' }, d).patch, {});
  assert.deepEqual(handleHook(asked, { hook_event_name: 'PostToolBatch', agent_id: 'a' }, d).patch, { ask: null, status: 'working' });
  // вопрос основного разговора сабагент тоже не снимает
  const main = state({ status: 'waiting', ask: { kind: 'permission', text: 'Bash: ls', at } });
  assert.deepEqual(handleHook(main, { hook_event_name: 'PostToolBatch', agent_id: 'b' }, d).patch, {});
});

test('хуки: PostToolUse разрешённого инструмента снимает «ждёт разрешения» — по вызову, а чужой вызов не снимает', () => {
  const at = '2026-11-18T10:00:00.000Z';
  const d = { ...deps(), now: () => at };
  const asked = handleHook(state({ status: 'working' }), { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'sleep 90' }, tool_use_id: 'tu-1' }, d).patch;
  assert.equal(asked.ask?.toolUseId, 'tu-1');
  const waiting = state({ status: 'waiting', ask: asked.ask! });
  // параллельный вызов другого инструмента закончился — разрешения всё ещё ждёт Bash
  assert.deepEqual(handleHook(waiting, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'tu-2' }, d).patch, {});
  assert.deepEqual(handleHook(waiting, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-1' }, d).patch, { ask: null, status: 'working' });
  // хук без id вызова: совпадение по инструменту
  const noId = state({ status: 'waiting', ask: { kind: 'permission', text: 'Bash: ls', at, tool: 'Bash' } });
  assert.deepEqual(handleHook(noId, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, d).patch, { ask: null, status: 'working' });
  // вопрос сабагента снимает только его шаг
  assert.deepEqual(handleHook(state({ status: 'waiting', ask: { ...noId.ask!, agent: 'a' } }), { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, d).patch, {});
});

test(
  'хуки: чтение, пропущенное без вопроса, ожидания не ставит; ответ и шаг модели снимают вопрос, /clear — тоже, «Продолжить» — нет',
  withConfigDir((root) => {
    const specs = path.join(root, 'specs');
    fs.mkdirSync(specs);
    createTag('k');
    updateTag('k', { dirs: [specs] });
    const read = handleHook(state({ tags: ['k'], injected: { tags: ['k'] }, status: 'working' }), { hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: { file_path: path.join(specs, 'a.md') } }, deps(root));
    assert.deepEqual(read.patch, {});
    const ask = { kind: 'question' as const, text: 'Коммитить?', at: '2026-11-17T10:00:00.000Z' };
    const after = (input: Parameters<typeof handleHook>[1]) => handleHook(state({ status: 'waiting', injected: { tags: [] }, ask }), input, deps()).patch;
    assert.equal(after({ hook_event_name: 'UserPromptSubmit', prompt: 'да' }).ask, null);
    assert.equal(after({ hook_event_name: 'PostToolBatch' }).ask, null);
    assert.equal(after({ hook_event_name: 'SessionStart', source: 'clear' }).ask, null);
    assert.equal('ask' in after({ hook_event_name: 'SessionStart', source: 'resume' }), false);
    // без вопроса снимать нечего: в правке поля нет
    assert.equal('ask' in handleHook(state({ status: 'waiting' }), { hook_event_name: 'UserPromptSubmit', prompt: 'x' }, deps()).patch, false);
  }),
);

test('parseHookInput: текст уведомления (message) берётся', () => {
  assert.equal(parseHookInput({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'нужно разрешение' })?.message, 'нужно разрешение');
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
