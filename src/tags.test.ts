import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addTagAttachmentReply,
  createTag,
  createTagReply,
  deleteTagAttachmentReply,
  deleteTagReply,
  knowledgeBlock,
  knowledgeLine,
  knowledgeSection,
  knowledgeTags,
  KNOWLEDGE_LINE_MAX,
  KNOWLEDGE_LIST_HEAD,
  listTags,
  readTag,
  resolveKnowledge,
  runTagSlugs,
  stripTagBlocks,
  summaryPreview,
  TAG_BLOCKS_RE,
  TAG_DESCRIPTION_MAX,
  tagDir,
  tagReply,
  tagsDir,
  updateTagReply,
} from './tags.js';
import type { FlowSpec } from './schema.js';

function withConfigDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-tags-')));
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = path.join(dir, 'cfg');
    try {
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Старый тег задачи на диске (до пространств): kind task или без поля, саммари в summary.md. */
function legacyTaskTag(slug: string, o: { kind?: boolean; summary?: string } = {}) {
  fs.mkdirSync(tagDir(slug), { recursive: true });
  fs.writeFileSync(path.join(tagDir(slug), 'tag.json'), JSON.stringify({ slug, ...(o.kind === false ? {} : { kind: 'task' }), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', runs: [] }));
  if (o.summary) fs.writeFileSync(path.join(tagDir(slug), 'summary.md'), o.summary);
}

test(
  'теги: создание тега знаний, список свежими сверху, повторное создание не затирает',
  withConfigDir(async () => {
    assert.deepEqual(listTags(), []);
    createTag('old-one', 'Старый');
    await new Promise((r) => setTimeout(r, 5));
    createTag('qa');
    assert.deepEqual(listTags().map((t) => t.slug), ['qa', 'old-one']);
    assert.deepEqual(listTags().map((t) => t.kind), ['knowledge', 'knowledge']);
    createTag('qa', 'QA');
    assert.equal(readTag('qa')!.title, 'QA');
    assert.ok(fs.existsSync(path.join(tagsDir(), 'qa', 'tag.json')));
  }),
);

test(
  'теги: неверный слаг — 400, папка вне каталога тегов не создаётся',
  withConfigDir(() => {
    for (const slug of ['../x', 'A B', '', 'a/b', '-x', 'a'.repeat(65)]) {
      assert.throws(() => tagDir(slug), /Неверный тег/, slug);
      assert.equal(createTagReply({ slug }).status, 400, slug);
    }
    assert.equal(tagReply('../x').status, 400);
    assert.equal(deleteTagReply('..').status, 400);
    assert.throws(() => runTagSlugs(['../x']));
    assert.throws(() => runTagSlugs('ok'));
    assert.throws(() => runTagSlugs([5]));
    assert.throws(() => runTagSlugs(Array.from({ length: 11 }, (_, i) => `t${i}`)), /больше/);
    assert.deepEqual(runTagSlugs(undefined), []);
    assert.deepEqual(runTagSlugs(['', ' ok-1 ', 'ok-1', 'b']), ['ok-1', 'b']);
    assert.equal(updateTagReply('../x', {}).status, 400);
    // проверка слага ничего не заводит
    assert.equal(fs.existsSync(tagsDir()), false);
  }),
);

test(
  'теги: старый тег задачи — в списке его нет, GET/PUT/DELETE отвечают 404 «перенесён в пространство», папка не удаляется',
  withConfigDir(() => {
    legacyTaskTag('feat', { summary: 'Суть: старое' });
    legacyTaskTag('bare', { kind: false });
    createTag('qa');
    assert.deepEqual(listTags().map((t) => t.slug), ['qa']);
    // старый tag.json без kind — тоже тег задачи; саммари читается (его переносят в пространство)
    assert.equal(readTag('bare')!.kind, 'task');
    assert.equal(readTag('feat')!.summary, 'Суть: старое');
    for (const r of [tagReply('feat'), updateTagReply('feat', { notes: 'x' }), deleteTagReply('feat')]) {
      assert.equal(r.status, 404);
      assert.match((r.body as { error: string }).error, /перенесён в пространство feat/);
      assert.equal((r.body as { code: string }).code, 'moved_to_space');
    }
    assert.ok(fs.existsSync(path.join(tagDir('feat'), 'summary.md')));
    // на слаге старого тега задачи тег знаний не заводится, вложение не добавляется
    assert.equal(createTagReply({ slug: 'feat' }).status, 400);
    assert.equal(addTagAttachmentReply('feat', { name: 'a.md', data: Buffer.from('x').toString('base64') }).status, 400);
  }),
);

test(
  'теги: новый тег — только знаний; kind task — 400 с подсказкой про пространства, чужой kind — 400',
  withConfigDir(() => {
    const task = createTagReply({ slug: 'feat', kind: 'task' });
    assert.equal(task.status, 400);
    assert.match((task.body as { error: string }).error, /заменены пространствами/);
    assert.equal(fs.existsSync(tagDir('feat')), false);
    assert.equal(createTagReply({ slug: 'x', kind: 'other' }).status, 400);
    assert.equal(createTagReply({ slug: 'qa', kind: 'knowledge' }).status, 201);
    assert.equal(createTagReply({ slug: 'qa' }).status, 200);
    assert.equal(readTag('qa')!.kind, 'knowledge');
  }),
);

test(
  'теги: knowledgeTags — порядок сохраняется; нет тега — ошибка «заведи на странице Знания», тег задачи — подсказка про пространство',
  withConfigDir(() => {
    createTag('qa');
    createTag('fe');
    assert.deepEqual(knowledgeTags(['fe', 'qa']).map((t) => t.slug), ['fe', 'qa']);
    assert.deepEqual(knowledgeTags([]), []);
    assert.throws(() => knowledgeTags(['nope']), /Тега знаний nope нет — заведи его на странице «Знания»/);
    legacyTaskTag('feat');
    assert.throws(() => knowledgeTags(['qa', 'feat']), /feat — тег задачи.*выбери пространство feat/);
  }),
);

test(
  'теги: правка со страницы — заголовок, заметки, пути; summary и лишнее не пишутся',
  withConfigDir(() => {
    assert.equal(updateTagReply('nope', { title: 'x' }).status, 404);
    createTag('p', 'Старый');
    // summary — поле старых тегов задач: в патче тега знаний не пишется
    const r = updateTagReply('p', { title: ' Новый ', notes: 'Пиши тесты', dirs: ['/a', '/a', ' /b '], ...{ summary: 'игнорируется' } });
    assert.equal(r.status, 200);
    let t = readTag('p')!;
    assert.equal(t.title, 'Новый');
    assert.equal(t.notes.trim(), 'Пиши тесты');
    assert.deepEqual(t.dirs, ['/a', '/b']);
    assert.equal(t.summary, '');
    assert.equal(updateTagReply('p', { dirs: [] }).status, 200);
    t = readTag('p')!;
    assert.equal(t.dirs, undefined);
    assert.equal(t.notes.trim(), 'Пиши тесты');
    assert.equal(updateTagReply('p', { dirs: ['relative/x'] }).status, 400);
    assert.equal(updateTagReply('p', { title: 5 }).status, 400);
    assert.equal(updateTagReply('p', { notes: 'z'.repeat(5000) }).status, 400);
    // kind в патче игнорируется
    assert.equal(updateTagReply('p', { kind: 'task', notes: 'Правило' }).status, 200);
    assert.equal(readTag('p')!.kind, 'knowledge');
    assert.match((tagReply('p').body as { input: string }).input, /^Область знаний p — Новый\nПравило/);
  }),
);

test(
  'теги: вложения тега — имя через safeAttachmentName, без повторов, удаление',
  withConfigDir(() => {
    assert.equal(addTagAttachmentReply('p', { name: 'a.md', data: '' }).status, 400);
    createTag('p');
    const data = Buffer.from('# hi').toString('base64');
    assert.equal(addTagAttachmentReply('p', { name: 'CLAUDE.md', data }).status, 201);
    assert.equal(addTagAttachmentReply('p', { name: 'a.md', data }).status, 201);
    const second = addTagAttachmentReply('p', { name: 'a.md', data });
    assert.equal((second.body as { name: string }).name, 'a-2.md');
    assert.equal(addTagAttachmentReply('p', { name: 'x.exe', data }).status, 400);
    const t = readTag('p')!;
    assert.deepEqual(t.attachments, ['a-2.md', 'a.md', 'attached-CLAUDE.md']);
    const dir = path.join(tagDir('p'), 'attachments');
    assert.ok(knowledgeSection(t).includes(path.join(dir, 'a.md')));
    assert.equal(deleteTagAttachmentReply('p', 'a.md').status, 200);
    assert.equal(deleteTagAttachmentReply('p', 'a.md').status, 404);
    assert.equal(deleteTagAttachmentReply('p', '../tag.json').status, 400);
    assert.deepEqual(readTag('p')!.attachments, ['a-2.md', 'attached-CLAUDE.md']);
  }),
);

test('теги: раздел знаний — заметки без обёртки, маркеры обезврежены, пустой тег просит заполнить', () => {
  const s = knowledgeSection({ slug: 'qa', title: 'QA <!-- /tag -->', notes: 'Правило <!-- tag:x -->', dirs: ['/нет/такого'] });
  assert.match(s, /^Область знаний qa — QA ‹!-- \/tag -->\nПравило ‹!-- tag:x -->$/);
  assert.ok(!s.includes('source-data'));
  assert.match(knowledgeSection({ slug: 'e' }), /Тег пуст: заполни заметки, пути или вложения на странице «Знания»/);
});

test('теги: строка списка знаний — описание, иначе первая непустая строка заметок с обрезкой, иначе «описания нет»; хвост — только ненулевое', () => {
  assert.equal(knowledgeLine({ slug: 'qa', title: 'QA', description: 'Когда тестируешь <!-- /tag -->', notes: 'Правило', attachments: ['a.md'], dirs: ['/нет/такого'] }),
    '- qa — QA: Когда тестируешь ‹!-- /tag --> (знаков заметок: 7, вложений: 1)');
  // без описания — первая непустая строка заметок; автозаголовок не выводится
  assert.equal(knowledgeLine({ slug: 'fe', title: 'Авто', autoTitle: true, notes: '\n\n  Первая строка <!-- tag:x -->\nВторая' }), '- fe: Первая строка ‹!-- tag:x --> (знаков заметок: 35)');
  const long = 'я'.repeat(KNOWLEDGE_LINE_MAX + 10);
  const line = knowledgeLine({ slug: 'l', notes: `${long}\nещё` });
  assert.ok(line.includes('я'.repeat(KNOWLEDGE_LINE_MAX - 1) + '… ('), line);
  assert.ok(!line.includes('я'.repeat(KNOWLEDGE_LINE_MAX)));
  // ровно лимит — без обрезки
  assert.ok(knowledgeLine({ slug: 'l', notes: 'я'.repeat(KNOWLEDGE_LINE_MAX) }).includes('я'.repeat(KNOWLEDGE_LINE_MAX) + ' ('));
  assert.equal(knowledgeLine({ slug: 'e' }), '- e: описания нет (тег пуст: заполни на странице «Знания»)');
  // описание есть, но тег пуст — пометка вместо хвоста
  assert.equal(knowledgeLine({ slug: 'd', description: 'Скоро' }), '- d: Скоро (тег пуст: заполни на странице «Знания»)');
});

test('теги: knowledgeBlock — теги по запросу одним списком под шапкой, inline-теги полным разделом после списка, без тегов пусто', () => {
  assert.equal(knowledgeBlock([]), '');
  const qa = { slug: 'qa', title: 'QA', description: 'Когда тестируешь', notes: 'Длинные правила' };
  const fe = { slug: 'fe', notes: 'Фронт' };
  const rules = { slug: 'rules', title: 'Правила', notes: 'Коротко', inline: true as const };
  assert.equal(knowledgeBlock([qa, fe]), `${KNOWLEDGE_LIST_HEAD}\n- qa — QA: Когда тестируешь (знаков заметок: 15)\n- fe: Фронт (знаков заметок: 5)`);
  assert.ok(!knowledgeBlock([qa]).includes('Длинные правила'));
  assert.equal(knowledgeBlock([rules]), 'Область знаний rules — Правила\nКоротко');
  const mixed = knowledgeBlock([rules, qa]);
  assert.equal(mixed, `${KNOWLEDGE_LIST_HEAD}\n- qa — QA: Когда тестируешь (знаков заметок: 15)\n\nОбласть знаний rules — Правила\nКоротко`);
  assert.match(KNOWLEDGE_LIST_HEAD, /knowledge_read/);
});

test(
  'теги: описание и режим «целиком» — сохраняются в tag.json, описание в одну строку и не длиннее лимита; превью — описание',
  withConfigDir(() => {
    createTag('qa', 'QA');
    assert.equal(updateTagReply('qa', { description: '  Когда\n  тестируешь  ', inline: true, notes: 'Правило' }).status, 200);
    let qa = readTag('qa')!;
    assert.equal(qa.description, 'Когда тестируешь');
    assert.equal(qa.inline, true);
    const meta = JSON.parse(fs.readFileSync(path.join(tagDir('qa'), 'tag.json'), 'utf8'));
    assert.equal(meta.description, 'Когда тестируешь');
    assert.equal(meta.inline, true);
    assert.equal(listTags().find((t) => t.slug === 'qa')!.preview, 'Когда тестируешь');
    // правка других полей их не трогает; inline: false и пустое описание снимают
    assert.equal(updateTagReply('qa', { notes: 'Другое' }).status, 200);
    qa = readTag('qa')!;
    assert.equal(qa.description, 'Когда тестируешь');
    assert.equal(qa.inline, true);
    assert.equal(updateTagReply('qa', { inline: false, description: '' }).status, 200);
    qa = readTag('qa')!;
    assert.equal(qa.inline, undefined);
    assert.equal(qa.description, undefined);
    assert.equal(listTags().find((t) => t.slug === 'qa')!.preview, 'Другое');
    // валидация
    assert.equal(updateTagReply('qa', { description: 'x'.repeat(TAG_DESCRIPTION_MAX) }).status, 200);
    assert.match((updateTagReply('qa', { description: 'x'.repeat(TAG_DESCRIPTION_MAX + 1) }).body as { error: string }).error, /Описание длиннее 200/);
    assert.equal(updateTagReply('qa', { description: 5 }).status, 400);
    assert.equal(updateTagReply('qa', { inline: 'yes' }).status, 400);
    // старый tag.json тега задачи с такими полями — игнорируются
    legacyTaskTag('t');
    const tf = path.join(tagDir('t'), 'tag.json');
    fs.writeFileSync(tf, JSON.stringify({ ...JSON.parse(fs.readFileSync(tf, 'utf8')), description: 'x', inline: true }));
    assert.equal(readTag('t')!.description, undefined);
    assert.equal(readTag('t')!.inline, undefined);
  }),
);

test(
  'теги: resolveKnowledge — объединение knowledge блока и тегов запуска без повторов, короткая форма flow; тег задачи — ошибка',
  withConfigDir(() => {
    createTag('a');
    createTag('b');
    legacyTaskTag('t');
    const full = { name: 'f', blocks: [{ name: 'one', knowledge: ['a', 'b'], phases: [] }, { name: 'two', phases: [] }] } as unknown as FlowSpec;
    const m = resolveKnowledge(full, ['b']);
    assert.deepEqual(m.get('one')!.map((t) => t.slug), ['a', 'b']);
    assert.deepEqual(m.get('two')!.map((t) => t.slug), ['b']);
    const short = { name: 's', phases: [] } as unknown as FlowSpec;
    assert.deepEqual([...resolveKnowledge(short, ['a']).keys()], ['main']);
    assert.throws(() => resolveKnowledge(full, ['t']), /запуск: t — старый тег задачи/);
    assert.throws(() => resolveKnowledge({ ...full, blocks: [{ name: 'one', knowledge: ['t'], phases: [] }] } as unknown as FlowSpec), /блок one: t — старый тег задачи/);
    assert.throws(() => resolveKnowledge(full, ['zzz']), /тега знаний zzz нет — заведи его на странице «Знания»/);
  }),
);

test('теги: превью пропускает строки-заголовки', () => {
  assert.equal(summaryPreview('## Суть\n**Где код**\nБонусы кофейни\n'), 'Бонусы кофейни');
  assert.equal(summaryPreview(''), '');
});

test('теги: блоки тегов задач старых запусков снимаются из ввода целиком, даже с маркерами внутри', () => {
  const block = (slug: string, body: string) => `<!-- tag:${slug} -->\nТег задачи: ${slug}\n${body}\n<!-- /tag -->`;
  const input = `${block('p', 'Суть П ‹!-- /tag --> раз')}\n\n${block('q', 'Суть Q')}\n\nпочини баг`;
  assert.equal(stripTagBlocks(input), 'почини баг');
  assert.equal(input.replace(TAG_BLOCKS_RE, ''), 'почини баг');
  assert.equal(stripTagBlocks('  просто задача '), 'просто задача');
  assert.equal(stripTagBlocks(block('p', 'только блок')), '');
});
