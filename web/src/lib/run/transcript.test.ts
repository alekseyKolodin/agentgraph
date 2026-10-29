import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callsIn, jsonString, logItem, parseLine, parseTranscript, resultOf, shownPath, stepsLine, toolOf, type LogState, type TxStep } from './transcript';

test('строка вызова: имя и главный аргумент вместо JSON, путь — целиком для ссылки', () => {
  assert.deepEqual(parseLine('▸ WebSearch {"query":"Preply commission tutors complaint reddit 2025","mode":"standard"}'), {
    kind: 'tool', name: 'WebSearch', target: 'Preply commission tutors complaint reddit 2025',
    raw: 'WebSearch {"query":"Preply commission tutors complaint reddit 2025","mode":"standard"}',
  });
  const read = toolOf('Read', '{"file_path":"/Users/me/proj/artifacts/ideas.md","limit":41}');
  assert.equal(read.target, '/Users/me/proj/artifacts/ideas.md');
  assert.equal(read.path, '/Users/me/proj/artifacts/ideas.md');
  // у команды — первая строка, у MCP — имя без сервера
  assert.equal(toolOf('Bash', '{"command":"npm test\\nnpm run build","description":"Тесты"}').target, 'npm test');
  const mcp = toolOf('mcp__artifacts__artifact_read', '{"key":"ideas","section":"Шорт-лист"}');
  assert.equal(mcp.name, 'artifact_read');
  assert.equal(mcp.target, 'ideas');
  // вопрос агента лежит внутри questions[0]
  assert.equal(toolOf('AskUserQuestion', '{"questions":[{"question":"Какой стиль кнопки?","header":"Стиль"}]}').target, 'Какой стиль кнопки?');
  // инструмент без строковых полей — без аргумента
  assert.equal(toolOf('TodoWrite', '{"todos":[]}').target, '');
});

test('обрезанный JSON: значение до обрыва, с многоточием, без недописанного экранирования', () => {
  const cut = '{"description":"Сигналы: репетиторы","subagent_type":"general-purpose","prompt":"Ты собираешь сигналы.\\n\\nН…';
  assert.equal(toolOf('Agent', cut).target, 'Сигналы: репетиторы');
  assert.equal(jsonString(cut, 'prompt'), 'Ты собираешь сигналы.\n\nН…');
  // truncate в agent.ts дописывает «…» и после обрыва посреди экранирования
  assert.equal(jsonString('{"prompt":"a\\nb\\"c\\…', 'prompt'), 'a\nb"c…');
  assert.equal(jsonString('{"q":"\\u04…', 'q'), '…');
  assert.equal(jsonString('{"n":1}', 'q'), undefined);
  // путь, обрезанный посередине, ссылкой не делаем
  assert.equal(toolOf('Read', '{"file_path":"/Users/me/very/long…').path, undefined);
});

test('строка «▸» без JSON и строка «↳» без двух пробелов — текст агента', () => {
  assert.equal(parseLine('▸ Итог: всё готово').kind, 'text');
  assert.equal(parseLine('↳ не результат').kind, 'text');
  assert.equal(parseLine('  ↳ The file /x/a.md has been updated.').kind, 'result');
});

test('результат: поиск — запрос и заголовки, узнаваемые отказы — ошибка', () => {
  const search = resultOf('Web search results for query: "reddit r/landlord "is there a tool" 2026" Links: [{"title":"gummysearch.com","url":"https://g.com/"},{"title":"Back to \\"Snapshot\\"","…');
  assert.equal(search.text, '«reddit r/landlord "is there a tool" 2026» — gummysearch.com · Back to "Snapshot" …');
  assert.equal(search.error, false);
  // первый же заголовок обрезан — он с многоточием, а не сырой JSON
  assert.equal(resultOf('Web search results for query: "a" Links: [{"title":"Очень длинный заголо…').text, '«a» — Очень длинный заголо…');
  assert.equal(resultOf('Web search results for query: "a" Links: [{"ti…').text, '«a» …');
  for (const text of [
    'The server returned HTTP 403 Forbidden. The response body was not retrieved.',
    'Claude Code is unable to fetch from old.reddit.com',
    '<tool_use_error>File has not been read yet.</tool_use_error>',
    'API Error: 400 The following domains are not allowed',
    'Инструмент Bash не разрешён для этого этапа',
  ]) assert.equal(resultOf(text).error, true, text);
  assert.equal(resultOf('The file /x/a.md has been updated.').error, false);
});

test('транскрипт — блоки: текст строками подряд, серия вызовов, вопрос с ответом', () => {
  const src = [
    'Начинаю с этапа 1.',
    '',
    '- пункт',
    '▸ WebSearch {"query":"a"}',
    '▸ WebFetch {"url":"https://b.ru"}',
    '  ↳ Claude Code is unable to fetch from b.ru',
    '? Какой стиль? | Какой цвет?',
    '= Яркий | Синий',
    '  ↳ Your questions have been answered: "Какой стиль?"="Яркий"',
    '? это строка текста, а не вопрос',
    'Готово.',
    '',
  ].join('\n');
  const blocks = parseTranscript(src);
  assert.deepEqual(blocks.map((b) => b.kind), ['text', 'steps', 'qa', 'text']);
  assert.equal(blocks[0]!.kind === 'text' && blocks[0]!.text, 'Начинаю с этапа 1.\n\n- пункт');
  assert.equal(blocks[1]!.kind === 'steps' && blocks[1]!.steps.length, 3);
  assert.deepEqual(blocks[2], { kind: 'qa', ask: 'Какой стиль? | Какой цвет?', answer: 'Яркий | Синий' });
  assert.equal(blocks[3]!.kind === 'text' && blocks[3]!.text, '? это строка текста, а не вопрос\nГотово.');
  assert.deepEqual(parseTranscript(''), []);
});

test('итог серии: вызовы по убыванию, ошибки отдельно', () => {
  const steps: TxStep[] = [
    toolOf('WebFetch', '{"url":"a"}'), resultOf('The server returned HTTP 404 Not Found'),
    toolOf('WebSearch', '{"query":"b"}'), toolOf('WebFetch', '{"url":"c"}'), resultOf('ok'),
  ];
  assert.equal(callsIn(steps), 3);
  assert.deepEqual(stepsLine(steps), { head: '3 действия', tools: 'WebFetch 2 · WebSearch 1', errors: '1 с ошибкой' });
});

test('путь в строке вызова: файл запуска — от его папки, остальное — с ~', () => {
  const run = '2026-10-27_09-16-02-idea';
  assert.equal(shownPath(`/Users/me/agentgraph/runs/${run}/artifacts/ideas.md`, '/Users/me', run), 'artifacts/ideas.md');
  assert.equal(shownPath('/Users/me/agentgraph/runs/other/x.md', '/Users/me', run), '~/agentgraph/runs/other/x.md');
  assert.equal(shownPath('/etc/hosts', '/Users/me', undefined), '/etc/hosts');
});

test('многострочный ответ — целиком в ответе, повтор ответа от AskUserQuestion не показывается', () => {
  const src = [
    '▸ AskUserQuestion {"questions":[{"question":"Что важнее?"}]}',
    '? Что важнее?',
    'Подумай о нагрузке.',
    '= Скорость.',
    'И ещё: без Redis',
    '',
    '  ↳ Your questions have been answered: "Что важнее?"="Скорость. И ещё: без Redis"',
    '▸ Read {"file_path":"/x/a.md"}',
    'Дальше текст.',
  ].join('\n');
  const blocks = parseTranscript(src);
  assert.deepEqual(blocks.map((b) => b.kind), ['steps', 'qa', 'steps', 'text']);
  assert.deepEqual(blocks[1], { kind: 'qa', ask: 'Что важнее?\nПодумай о нагрузке.', answer: 'Скорость.\nИ ещё: без Redis' });
  assert.equal(blocks[2]!.kind === 'steps' && blocks[2]!.steps.length, 1);
  // «? » в тексте агента, а ответа до вызова нет — это текст
  assert.deepEqual(parseTranscript('? не вопрос\n▸ Read {"file_path":"/x"}').map((b) => b.kind), ['text', 'steps']);
});

test('живой лог: этап и его смена, вопрос и многострочный ответ, повтор ответа и пустой текст — пропуск', () => {
  const st: LogState = {};
  const kinds = (line: string) => {
    const r = logItem(line, st);
    return [r.phase, r.newPhase, r.item?.kind ?? null, r.item && 'text' in r.item ? r.item.text : null];
  };
  assert.deepEqual(kinds('[a] Начинаю.\n\n- пункт'), ['a', true, 'text', 'Начинаю.\n\n- пункт']);
  assert.deepEqual(kinds('[a] ▸ WebFetch {"url":"https://b.ru"}'), ['a', false, 'tool', null]);
  assert.deepEqual(kinds('[b]   ↳ ok'), ['b', true, 'result', 'ok']);
  assert.deepEqual(kinds('[a] ? Что важнее?'), ['a', true, 'ask', 'Что важнее?']);
  assert.deepEqual(kinds('[a] = Скорость.\nИ ещё: без Redis'), ['a', false, 'answer', 'Скорость.\nИ ещё: без Redis']);
  assert.deepEqual(kinds('[a]   ↳ Your questions have been answered: "x"="y"'), ['a', false, null, null]);
  assert.deepEqual(kinds('[a] '), ['a', false, null, null]);
  // «= …» без вопроса перед ним в том же этапе — текст
  assert.deepEqual(kinds('[a] = 2 + 2'), ['a', false, 'text', '= 2 + 2']);
});
