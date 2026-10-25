import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ATTACHMENT_FILE_MAX,
  ATTACHMENTS_COUNT_MAX,
  attachmentContentType,
  copyAttachments,
  dedupeNames,
  safeAttachmentName,
  saveAttachments,
  validateAttachments,
} from './attachments.js';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-att-'));

test('имя вложения: только basename, без .., разделителей и \\0', () => {
  assert.equal(safeAttachmentName('../x.png'), 'x.png');
  assert.equal(safeAttachmentName('a/b.png'), 'b.png');
  assert.equal(safeAttachmentName('a\\b.png'), 'b.png');
  assert.equal(safeAttachmentName('sh\0ot.png'), 'shot.png');
  assert.equal(safeAttachmentName('..'), 'file');
  assert.equal(safeAttachmentName(''), 'file');
  assert.equal(safeAttachmentName('/'), 'file');
});

test('имя вложения: без управляющих символов и не длиннее 200 байт, расширение сохраняется', () => {
  assert.equal(safeAttachmentName('a\nb\r\t\x1b.png'), 'ab.png');
  const long = safeAttachmentName(`${'я'.repeat(300)}.png`);
  assert.ok(Buffer.byteLength(long) <= 200);
  assert.ok(long.endsWith('я.png'));
});

test('CLAUDE.md и CLAUDE.local.md в любом регистре переименовываются, чтобы не стать инструкциями агентов', () => {
  assert.equal(safeAttachmentName('CLAUDE.md'), 'attached-CLAUDE.md');
  assert.equal(safeAttachmentName('claude.md'), 'attached-claude.md');
  assert.equal(safeAttachmentName('CLAUDE.local.md'), 'attached-CLAUDE.local.md');
  assert.equal(safeAttachmentName('x/claude.LOCAL.md'), 'attached-claude.LOCAL.md');
  assert.equal(safeAttachmentName('../.CLAUDE.md'), 'attached-CLAUDE.md');
  // повторный вызов (saveAttachments) имя не меняет
  assert.equal(safeAttachmentName('attached-CLAUDE.md'), 'attached-CLAUDE.md');
  assert.equal(safeAttachmentName('notCLAUDE.md'), 'notCLAUDE.md');
  const list = validateAttachments([{ name: 'CLAUDE.md', data: b64('1') }, { name: 'attached-CLAUDE.md', data: b64('2') }]);
  assert.deepEqual(list.map((a) => a.name), ['attached-CLAUDE.md', 'attached-CLAUDE-2.md']);
  const dir = tmp();
  try {
    saveAttachments(dir, validateAttachments([{ name: 'claude.md', data: b64('x') }, { name: 'CLAUDE.local.md', data: b64('y') }]));
    const files = fs.readdirSync(path.join(dir, 'attachments')).map((f) => f.toLowerCase());
    assert.ok(!files.includes('claude.md') && !files.includes('claude.local.md'), files.join(', '));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('дубли имён получают суффикс -2, -3', () => {
  assert.deepEqual(dedupeNames(['a.png', 'a.png', 'b.md', 'A.png']), ['a.png', 'a-2.png', 'b.md', 'A-3.png']);
  const list = validateAttachments([{ name: 'image.png', data: b64('1') }, { name: 'image.png', data: b64('2') }]);
  assert.deepEqual(list.map((a) => a.name), ['image.png', 'image-2.png']);
});

test('проверка: тип, размер, сумма, число файлов, base64', () => {
  assert.deepEqual(validateAttachments(undefined), []);
  assert.equal(validateAttachments([{ name: 'Shot.PNG', data: b64('x') }])[0].bytes.toString(), 'x');
  assert.throws(() => validateAttachments([{ name: 'run.exe', data: b64('x') }]), /run\.exe: такой тип/);
  assert.throws(() => validateAttachments([{ name: 'spec.docx', data: b64('x') }]), /не поддерживается/);
  assert.throws(() => validateAttachments([{ name: 'big.png', data: b64(Buffer.alloc(ATTACHMENT_FILE_MAX + 1)) }]), /big\.png: файл больше/);
  const nine = Buffer.alloc(9 * 1024 * 1024);
  assert.throws(() => validateAttachments(['a', 'b', 'c'].map((n) => ({ name: `${n}.png`, data: b64(nine) }))), /вместе больше/);
  const many = Array.from({ length: ATTACHMENTS_COUNT_MAX + 1 }, (_, i) => ({ name: `${i}.md`, data: b64('x') }));
  assert.throws(() => validateAttachments(many), /больше 10/);
  assert.throws(() => validateAttachments([{ name: 'a.md', data: 'не base64!' }]), /не в base64/);
  assert.throws(() => validateAttachments([{ name: 'a.md', data: 'abc' }]), /не в base64/);
  assert.throws(() => validateAttachments([{ name: 'a.md' }]), /name, data/);
  assert.throws(() => validateAttachments('a.md'), /список/);
});

test('saveAttachments пишет только внутрь attachments/ и возвращает пути от папки запуска', () => {
  const dir = tmp();
  try {
    const rel = saveAttachments(dir, validateAttachments([{ name: '../../evil.md', data: b64('hi') }, { name: 'shot.png', data: b64('png') }]));
    assert.deepEqual(rel, ['attachments/evil.md', 'attachments/shot.png']);
    assert.equal(fs.readFileSync(path.join(dir, 'attachments/evil.md'), 'utf8'), 'hi');
    assert.deepEqual(fs.readdirSync(dir), ['attachments']);
    assert.deepEqual(saveAttachments(dir, []), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('два вложения с одинаковым длинным именем — два разных файла, суффикс не теряется при усечении', () => {
  const dir = tmp();
  try {
    const name = `${'я'.repeat(300)}.png`;
    const list = validateAttachments([{ name, data: b64('1') }, { name, data: b64('2') }]);
    assert.ok(list.every((a) => Buffer.byteLength(a.name) <= 200));
    assert.ok(list[1].name.endsWith('-2.png'));
    const rel = saveAttachments(dir, list);
    assert.notEqual(rel[0], rel[1]);
    assert.deepEqual(rel.map((r) => fs.readFileSync(path.join(dir, r), 'utf8')), ['1', '2']);
    assert.equal(fs.readdirSync(path.join(dir, 'attachments')).length, 2);
    // повторное имя в обход validateAttachments не затирает файл молча
    assert.throws(() => saveAttachments(path.join(dir, 'again'), [list[0], list[0]]), /Повторное имя/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copyAttachments копирует вложения прошлого запуска, без папки — ничего', () => {
  const from = tmp();
  const to = tmp();
  try {
    assert.deepEqual(copyAttachments(from, to), []);
    assert.equal(fs.existsSync(path.join(to, 'attachments')), false);
    saveAttachments(from, validateAttachments([{ name: 'b.md', data: b64('b') }, { name: 'a.png', data: b64('a') }]));
    assert.deepEqual(copyAttachments(from, to), ['attachments/a.png', 'attachments/b.md']);
    assert.equal(fs.readFileSync(path.join(to, 'attachments/b.md'), 'utf8'), 'b');
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
});

test('copyAttachments переименовывает CLAUDE.md, оставшийся в старом запуске', () => {
  const from = tmp();
  const to = tmp();
  try {
    fs.mkdirSync(path.join(from, 'attachments'));
    fs.writeFileSync(path.join(from, 'attachments/CLAUDE.md'), 'инструкции');
    assert.deepEqual(copyAttachments(from, to), ['attachments/attached-CLAUDE.md']);
    assert.deepEqual(fs.readdirSync(path.join(to, 'attachments')), ['attached-CLAUDE.md']);
    assert.equal(fs.readFileSync(path.join(to, 'attachments/attached-CLAUDE.md'), 'utf8'), 'инструкции');
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
});

test('Content-Type вложения: картинки и PDF, остальное — текст', () => {
  assert.equal(attachmentContentType('attachments/x.PNG'), 'image/png');
  assert.equal(attachmentContentType('x.jpg'), 'image/jpeg');
  assert.equal(attachmentContentType('x.pdf'), 'application/pdf');
  assert.equal(attachmentContentType('x.md'), undefined);
});
