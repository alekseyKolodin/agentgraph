import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeed, rssKind } from './rss.js';
import { fakeFetch, makeCtx } from './testkit.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel><title>Блог &amp; новости</title><link>https://example.com</link><atom:link href="https://example.com/feed" rel="self"/>
<item><title><![CDATA[Релиз 1.5 «Осень»]]></title><link>https://example.com/r15</link><guid isPermaLink="false">post-15</guid><pubDate>Mon, 16 Nov 2026 09:00:00 GMT</pubDate><dc:creator>Анна</dc:creator><category>релизы</category><description>Коротко &lt;b&gt;о&lt;/b&gt; релизе</description><content:encoded><![CDATA[<p>Полный текст</p><p>второй абзац</p>]]></content:encoded></item>
<item><title>Без guid</title><link>https://example.com/noguid</link><description>Просто</description></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Релизы</title>
<entry><id>tag:example.com,2026:1</id><title>v2.0</title><link rel="alternate" href="https://example.com/v2"/><link rel="enclosure" href="https://example.com/v2.zip"/><updated>2026-11-16T10:00:00Z</updated><author><name>Боб</name></author><summary type="html">&lt;p&gt;Новое&lt;/p&gt;</summary><category term="stable"/></entry>
</feed>`;

test('RSS 2.0: заголовок ленты, CDATA, content:encoded, автор, теги, id по guid или ссылке', () => {
  const f = parseFeed(RSS);
  assert.equal(f.title, 'Блог & новости');
  assert.equal(f.items.length, 2);
  assert.equal(f.items[0].id, 'post-15');
  assert.equal(f.items[0].title, 'Релиз 1.5 «Осень»');
  assert.equal(f.items[0].text, 'Полный текст\nвторой абзац');
  assert.equal(f.items[0].author, 'Анна');
  assert.deepEqual(f.items[0].categories, ['релизы']);
  assert.equal(f.items[1].id, 'https://example.com/noguid');
});

test('Atom: id, альтернативная ссылка, автор, summary без тегов', () => {
  const f = parseFeed(ATOM);
  assert.equal(f.title, 'Релизы');
  assert.equal(f.items[0].id, 'tag:example.com,2026:1');
  assert.equal(f.items[0].link, 'https://example.com/v2');
  assert.equal(f.items[0].author, 'Боб');
  assert.equal(f.items[0].text, 'Новое');
  assert.deepEqual(f.items[0].categories, ['stable']);
});

test('не лента — понятная ошибка', () => {
  assert.throws(() => parseFeed('<html><body>привет</body></html>'), /не RSS и не Atom/);
});

test('poll: запись → событие, время из pubDate, поля ленты для условий', async () => {
  const { fetch, calls } = fakeFetch(() => RSS);
  const events = await rssKind.poll!(makeCtx({ slug: 'blog', config: { url: 'https://example.com/feed' }, fetch }));
  assert.equal(calls[0].url.href, 'https://example.com/feed');
  assert.equal(events[0].id, 'post-15');
  assert.equal(events[0].at, '2026-11-16T09:00:00.000Z');
  assert.equal(events[0].fields.feed, 'Блог & новости');
  assert.equal(events[0].link, 'https://example.com/r15');
});

test('poll: ошибки — нет адреса, не http, HTTP-статус', async () => {
  await assert.rejects(() => rssKind.poll!(makeCtx({ config: {} })), /Не указан адрес/);
  await assert.rejects(() => rssKind.poll!(makeCtx({ config: { url: 'file:///etc/passwd' } })), /http/);
  const { fetch } = fakeFetch(() => new Response('x', { status: 503 }));
  await assert.rejects(() => rssKind.poll!(makeCtx({ config: { url: 'https://example.com/f' }, fetch })), /503/);
});
