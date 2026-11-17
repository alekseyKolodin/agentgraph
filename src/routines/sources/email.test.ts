import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunCommand } from '../kind.js';
import { bodyText, decodeWords, emailEvent, emailKind, imapDate } from './email.js';
import { makeCtx } from './testkit.js';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const MAIL = (uid: number) =>
  [
    `From: =?UTF-8?B?${b64('Анна')}?= <ann@example.com>`,
    `Subject: =?utf-8?Q?=D0=A2=D0=B5=D1=81=D1=82_${uid}?=`,
    'Date: Mon, 16 Nov 2026 09:00:00 +0000',
    'Message-ID: <abc@example.com>',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64('Привет, мир'),
    '',
  ].join('\r\n');

const cfg = { host: 'imap.example.com', user: 'me@example.com' };

test('заголовки: слова в base64 и quoted-printable декодируются, склейка соседних слов', () => {
  assert.equal(decodeWords(`=?UTF-8?B?${b64('Привет')}?= =?UTF-8?B?${b64(' мир')}?=`), 'Привет мир');
  assert.equal(decodeWords('=?utf-8?Q?=D0=A2=D0=B5=D1=81=D1=82_1?='), 'Тест 1');
  assert.equal(decodeWords('plain'), 'plain');
});

test('письмо → событие: автор, тема, текст из base64, время, id по папке и UID', () => {
  const e = emailEvent('mail', { mailbox: 'INBOX' }, 12, MAIL(12));
  assert.equal(e.id, 'INBOX:12');
  assert.equal(e.title, 'Тест 12');
  assert.equal(e.text, 'Привет, мир');
  assert.equal(e.author, 'ann@example.com');
  assert.equal(e.at, '2026-11-16T09:00:00.000Z');
  assert.equal(e.fields.from, 'Анна <ann@example.com>');
  assert.equal(e.fields.subject, 'Тест 12');
});

test('multipart: берётся text/plain, quoted-printable разворачивается', () => {
  const raw = ['Content-Type: multipart/alternative; boundary="BB"', '', '--BB', 'Content-Type: text/html; charset=utf-8', '', '<p>html</p>', '--BB', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', '=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82=', '=21', '--BB--', ''].join('\n');
  const [head, ...rest] = raw.split('\n\n');
  const headers = { 'content-type': 'multipart/alternative; boundary="BB"' };
  assert.equal(bodyText({ headers, body: rest.join('\n\n') }), 'Привет!');
  assert.ok(head);
});

test('письмо только с HTML: теги убираются', () => {
  assert.equal(bodyText({ headers: { 'content-type': 'text/html' }, body: '<p>Один</p><p>Два&nbsp;три</p><script>x()</script>' }), 'Один\nДва три');
});

test('дата IMAP SINCE: 17-Nov-2026', () => {
  assert.equal(imapDate(new Date('2026-11-17T12:00:00Z')), '17-Nov-2026');
});

/** run, который выполняет команду настоящим шеллом, но с подменённым curl в PATH. */
function shellRun(dir: string): { run: RunCommand; calls: Array<{ cmd: string; env: Record<string, string> }> } {
  const calls: Array<{ cmd: string; env: Record<string, string> }> = [];
  const run: RunCommand = (cmd, opts) =>
    new Promise((resolve) => {
      calls.push({ cmd, env: opts.env });
      execFile('sh', ['-c', cmd], { env: { ...opts.env, PATH: `${dir}:${opts.env.PATH}` } }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
    });
  return { run, calls };
}

function fakeCurl(dir: string, script: string): void {
  fs.writeFileSync(path.join(dir, 'curl'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

test('почта: настоящий шелл с подменённым curl — пароль идёт конфигом на stdin, не в аргументах; поиск, письма, курсор', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mail-'));
  try {
    fakeCurl(
      dir,
      `cat > "${dir}/stdin.txt"
printf '%s\\n' "$@" >> "${dir}/args.txt"
case "$*" in
  *"UID SEARCH"*) echo '* SEARCH 4 5';;
  *"UID FETCH 4 "*) printf 'Subject: Раз\\r\\nFrom: a@x.com\\r\\n\\r\\nтекст 4\\r\\n';;
  *"UID FETCH 5 "*) printf 'Subject: Два\\r\\nFrom: b@x.com\\r\\n\\r\\nтекст 5\\r\\n';;
esac`,
    );
    const { run, calls } = shellRun(dir);
    const ctx = makeCtx({ slug: 'mail', config: cfg, secrets: { EMAIL_PASSWORD: 'pa"ss\\word' }, run });
    const kind = emailKind({ now: () => new Date('2026-11-17T12:00:00Z') });
    const events = await kind.poll!(ctx);
    assert.deepEqual(events.map((e) => [e.id, e.title, e.text]), [['INBOX:4', 'Раз', 'текст 4'], ['INBOX:5', 'Два', 'текст 5']]);
    assert.deepEqual(ctx.cursorValue(), { lastUid: 5 });
    // пароль экранирован в конфиге curl и не попал ни в аргументы, ни в текст команды
    assert.equal(fs.readFileSync(path.join(dir, 'stdin.txt'), 'utf8'), 'user = "me@example.com:pa\\"ss\\\\word"\n');
    const args = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8');
    assert.ok(!args.includes('pa"ss'));
    assert.ok(args.includes('UID SEARCH UNSEEN SINCE 10-Nov-2026'));
    assert.ok(args.includes('UID FETCH 4 (BODY.PEEK[HEADER])'), 'первый заход: только заголовки, без \\Seen');
    assert.ok(!args.includes(';UID='), 'BODY[] без PEEK не используется');
    assert.ok(calls.every((c) => !c.cmd.includes('word') && c.env.EMAIL_PASSWORD === 'pa"ss\\word'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('почта: второй заход ищет по UID после курсора, старое письмо из «UID n:*» отсекается', async () => {
  const seen: string[] = [];
  const run: RunCommand = async (cmd) => {
    seen.push(cmd);
    if (cmd.includes('UID SEARCH')) return { code: 0, stdout: '* SEARCH 5\r\n', stderr: '' };
    return { code: 0, stdout: 'Subject: x\r\n\r\ny', stderr: '' };
  };
  const ctx = makeCtx({ config: { ...cfg, from: 'alerts@example.com' }, secrets: { EMAIL_PASSWORD: 'p' }, run, cursor: { lastUid: 5 } });
  const events = await emailKind().poll!(ctx);
  assert.deepEqual(events, []);
  assert.ok(seen[0].includes('UID SEARCH UID 6:* FROM "alerts@example.com"'));
  assert.deepEqual(ctx.cursorValue(), { lastUid: 5 });
});

test('почта: ошибка curl — понятный текст и подсказка про пароль приложения, пароля в тексте нет', async () => {
  const run: RunCommand = async () => ({ code: 0, stdout: '', stderr: 'curl: (67) Login denied for pa55word\n__curl_exit=67\n' });
  await assert.rejects(
    () => emailKind().poll!(makeCtx({ config: cfg, secrets: { EMAIL_PASSWORD: 'pa55word' }, run })),
    (e: Error) => /Login denied/.test(e.message) && /пароль приложения/.test(e.message) && !e.message.includes('pa55word'),
  );
});

test('почта: нет настроек или пароля — ошибка до запуска; опасные символы в отправителе отклоняются', async () => {
  const run: RunCommand = async () => {
    throw new Error('не должен запускаться');
  };
  await assert.rejects(() => emailKind().poll!(makeCtx({ config: {}, run })), /сервера/);
  await assert.rejects(() => emailKind().poll!(makeCtx({ config: cfg, run })), /EMAIL_PASSWORD/);
  await assert.rejects(() => emailKind().poll!(makeCtx({ config: { ...cfg, from: 'a" ALL' }, secrets: { EMAIL_PASSWORD: 'p' }, run })), /недопустимые/);
});

test('почта: последующие письма тянутся через BODY.PEEK с PARTIAL, ответ FETCH с литералами собирается в письмо', async () => {
  const seen: string[] = [];
  const header = 'Subject: Привет\r\nFrom: a@x.com\r\n\r\n';
  const text = 'тело письма';
  const run: RunCommand = async (cmd) => {
    seen.push(cmd);
    if (cmd.includes('UID SEARCH')) return { code: 0, stdout: '* SEARCH 8\r\n', stderr: '' };
    const h = Buffer.byteLength(header);
    const t = Buffer.byteLength(text);
    return { code: 0, stdout: `* 1 FETCH (UID 8 BODY[HEADER] {${h}}\r\n${header} BODY[TEXT]<0> {${t}}\r\n${text})\r\n`, stderr: '' };
  };
  const ctx = makeCtx({ config: cfg, secrets: { EMAIL_PASSWORD: 'p' }, run, cursor: { lastUid: 7 } });
  const [e] = await emailKind().poll!(ctx);
  assert.equal(e.title, 'Привет');
  assert.equal(e.text, 'тело письма');
  assert.ok(seen[1].includes('UID FETCH 8 (BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.60000>)'));
  assert.ok(!/BODY\[\]/.test(seen[1]));
});

test('почта: большое письмо — head оборвал канал, curl вернул 23: это не ошибка, курсор двигается', async () => {
  const run: RunCommand = async (cmd) => {
    if (cmd.includes('UID SEARCH')) return { code: 0, stdout: '* SEARCH 3\r\n', stderr: '' };
    return { code: 0, stdout: 'Subject: Большое\r\n\r\nначало', stderr: 'curl: (23) Failure writing output to destination\n__curl_exit=23\n' };
  };
  const ctx = makeCtx({ config: cfg, secrets: { EMAIL_PASSWORD: 'p' }, run, cursor: { lastUid: 2 } });
  const [e] = await emailKind().poll!(ctx);
  assert.equal(e.title, 'Большое');
  assert.deepEqual(ctx.cursorValue(), { lastUid: 3 });
  // а 23 без единого байта — настоящая ошибка
  const empty: RunCommand = async () => ({ code: 0, stdout: '', stderr: '__curl_exit=23\n' });
  await assert.rejects(() => emailKind().poll!(makeCtx({ config: cfg, secrets: { EMAIL_PASSWORD: 'p' }, run: empty })), /код 23|23/);
});
