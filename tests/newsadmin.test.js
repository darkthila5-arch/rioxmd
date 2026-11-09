import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const { sessions } = await import('../lib/config.js');
const { getSetting, setSetting } = await import('../lib/storage.js');
const { NO_FOOTER, DEFAULT_FOOTER } = await import('../lib/brand.js');
const news = await import('../commands/news.js');

const sent = [];
sessions.set('s1', {
  status: 'connected', phone: '94771234567',
  sock: {
    sendMessage: async (jid, content) => { if (jid === '444@g.us') throw new Error('forbidden'); sent.push({ jid, content }); },
    groupGetInviteInfo: async () => ({ id: '111@g.us', subject: 'My Group' }),
    newsletterMetadata: async () => ({ id: '222@newsletter', name: 'My Channel' }),
    groupMetadata: async () => ({ subject: 'My Group' }),
  },
});

let items = [];
const rss = () => `<?xml version="1.0"?><rss><channel>${items.map((t) => `<item><title>${t}</title><link>https://example.lk/${encodeURIComponent(t)}</link><description>desc of ${t}</description></item>`).join('')}</channel></rss>`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => (String(url).startsWith('http') && /rss|feed|news\.google/.test(String(url))
  ? { ok: true, status: 200, text: async () => rss() }
  : { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) });

const cycle = async (titles) => { items = titles; await news.newsPollOnce(); };
const base = { link: 'https://chat.whatsapp.com/ABCDEF', sid: 's1', sources: ['derana'], footer: 'bot', days: 3 };

test('add: reads the group name, sets the end date, rejects bad input', async () => {
  const { entry } = await news.adminNewsAdd(base);
  assert.equal(entry.jid, '111@g.us'); assert.equal(entry.name, 'My Group'); assert.equal(entry.kind, 'group');
  assert.ok(Math.abs(entry.until - (Date.now() + 3 * 86400000)) < 5000);
  await assert.rejects(() => news.adminNewsAdd({ ...base, sid: 'nope' }), /online/);
  await assert.rejects(() => news.adminNewsAdd({ ...base, sources: [] }), /at least one/);
  await assert.rejects(() => news.adminNewsAdd({ ...base, days: -4 }), /Days/);
  await assert.rejects(() => news.adminNewsAdd({ ...base, footer: 'custom', custom: '  ' }), /custom footer/);
  await assert.rejects(() => news.adminNewsAdd({ ...base, link: 'hello' }), /could not read/);
  assert.equal(news.adminNewsView().items.length, 1);
});

test('same chat + same number again = renewed, not duplicated; empty days = no end', async () => {
  const r = await news.adminNewsAdd({ ...base, days: '' });
  assert.equal(r.renewed, true); assert.equal(r.entry.until, 0);
  assert.equal(news.adminNewsView().items.length, 1);
  await news.adminNewsUpdate(r.entry.id, { days: 3 });
});

test('posts new stories with the bot footer; first run posts nothing', async () => {
  sent.length = 0;
  await cycle(['Old story number one here']);          // first run: only remembered
  assert.equal(sent.length, 0);
  await cycle(['New story number two here', 'Old story number one here']);
  assert.equal(sent.length, 1);
  const c = sent[0].content;
  assert.equal(sent[0].jid, '111@g.us');
  assert.ok((c.text || c.caption).includes(DEFAULT_FOOTER));
  assert.equal(c[NO_FOOTER], undefined);
});

test('footer modes: channel name, bot + name, custom', async () => {
  const id = news.adminNewsView().items[0].id;
  let n = 2;
  const next = async () => { n += 1; sent.length = 0; await cycle([`Fresh story number ${n} here`, 'Old story number one here']); return sent[0].content; };
  news.adminNewsUpdate(id, { footer: 'channel' });
  let c = await next(); let t = c.text || c.caption;
  assert.ok(t.includes('> *My Group*')); assert.ok(!t.includes(DEFAULT_FOOTER)); assert.equal(c[NO_FOOTER], true);
  news.adminNewsUpdate(id, { footer: 'both' });
  c = await next(); t = c.text || c.caption;
  assert.ok(t.includes(DEFAULT_FOOTER) && t.includes('> *My Group*')); assert.equal(c[NO_FOOTER], undefined);
  news.adminNewsUpdate(id, { footer: 'custom', custom: 'Join us • rio' });
  c = await next(); t = c.text || c.caption;
  assert.ok(t.includes('> *Join us • rio*')); assert.ok(!t.includes(DEFAULT_FOOTER)); assert.equal(c[NO_FOOTER], true);
});

test('when the days are over the news stops; new days start it again', async () => {
  const id = news.adminNewsView().items[0].id;
  const list = getSetting('_news', 'adminTargets', []).map((t) => ({ ...t, until: Date.now() - 1000 }));
  setSetting('_news', 'adminTargets', list);
  assert.equal(news.adminNewsView().items[0].expired, true);
  sent.length = 0;
  await cycle(['After the end story here', 'Old story number one here']);
  assert.equal(sent.length, 0);
  news.adminNewsUpdate(id, { days: 2 });
  assert.equal(news.adminNewsView().items[0].expired, false);
  sent.length = 0;
  await cycle(['Back again story here', 'After the end story here']);
  assert.equal(sent.length, 1);
});

test('remove', async () => {
  const id = news.adminNewsView().items[0].id;
  assert.ok(news.adminNewsRemove(id));
  assert.equal(news.adminNewsRemove(id), null);
  assert.equal(news.adminNewsView().items.length, 0);
});


test('adding tells the chat (its own details only), and counts the posts live', async () => {
  sent.length = 0;
  const a = await news.adminNewsAdd({ ...base, days: 4, footer: 'custom', custom: 'X' });
  assert.equal(a.notified, true);
  assert.equal(sent.length, 1); assert.equal(sent[0].jid, '111@g.us');
  const t1 = sent[0].content.text;
  assert.match(t1, /Auto news is ON/); assert.match(t1, /DERANA/); assert.match(t1, /Start: /); assert.match(t1, /End: .*\(4 days\)/);
  assert.ok(!/Other chats/.test(t1)); assert.ok(!/HIRU/.test(t1)); // only about this chat
  sent.length = 0;
  const b = await news.adminNewsAdd({ ...base, link: 'https://whatsapp.com/channel/0029VaAAA', sources: ['hiru', 'itn'], days: '' });
  assert.equal(sent[0].jid, '222@newsletter');
  const t2 = sent[0].content.text;
  assert.ok(!/Other chats/.test(t2)); assert.ok(!/My Group/.test(t2)); // never lists the other chats
  assert.match(t2, /HIRU NEWS, ITN NEWS/); assert.match(t2, /Start: /); assert.match(t2, /End: No end date/);
  // numbers start at 0 and go up with every posted story
  assert.deepEqual(news.adminNewsView().items.map((i) => i.stats.total), [0, 0]);
  await cycle(['Seed story alpha here', 'Back again story here']);
  await cycle(['Live story beta here', 'Seed story alpha here']);
  const v = news.adminNewsView();
  const g = v.items.find((i) => i.jid === '111@g.us'), c = v.items.find((i) => i.jid === '222@newsletter');
  assert.equal(g.stats.total, 2); assert.equal(g.stats.today, 2); assert.match(g.stats.lastTitle, /Live story beta/);
  assert.equal(c.stats.total, 4); // Hiru + ITN, two cycles
  assert.equal(v.totals.total, 6); assert.equal(v.totals.today, 6); assert.ok(v.poll.last > 0);
  void b;
});

test('chats added by command show up too and can be changed / removed', async () => {
  setSetting('s1', 'newsTargets', { '333@g.us': ['hiru'] });
  setSetting('s1', 'newsMeta', { '333@g.us': { name: 'Owner Group', addedAt: Date.now() } });
  let it = news.adminNewsView().items.find((i) => i.jid === '333@g.us');
  assert.equal(it.origin, 'command'); assert.equal(it.name, 'Owner Group'); assert.equal(it.id, 'c:s1:333@g.us'); assert.deepEqual(it.sources, ['hiru']);
  news.adminNewsUpdate(it.id, { sources: ['derana', 'itn'] });
  assert.deepEqual(news.adminNewsView().items.find((i) => i.jid === '333@g.us').sources, ['derana', 'itn']);
  assert.ok(news.adminNewsRemove(it.id));
  assert.equal(news.adminNewsView().items.some((i) => i.jid === '333@g.us'), false);
});

test('a chat added by command gets its own footer after saving one in /admin', async () => {
  setSetting('s1', 'newsTargets', { '555@g.us': ['hiru'] });
  setSetting('s1', 'newsMeta', { '555@g.us': { name: 'Cmd Group', addedAt: Date.now() } });
  const it = news.adminNewsView().items.find((i) => i.jid === '555@g.us');
  assert.equal(it.origin, 'command');
  news.adminNewsUpdate(it.id, { footer: 'custom', custom: 'My own footer' });
  const now = news.adminNewsView().items.filter((i) => i.jid === '555@g.us');
  assert.equal(now.length, 1); assert.equal(now[0].origin, 'web');
  assert.equal(now[0].footer.mode, 'custom'); assert.equal(now[0].footer.custom, 'My own footer');
  assert.equal(getSetting('s1', 'newsTargets', {})['555@g.us'], undefined);
  sent.length = 0;
  await cycle(['Brand new cmd story here', 'Old story number one here']);
  const c = sent.find((x) => x.jid === '555@g.us').content, t = c.text || c.caption;
  assert.ok(t.includes('> *My own footer*')); assert.ok(!t.includes(DEFAULT_FOOTER)); assert.equal(c[NO_FOOTER], true);
  news.adminNewsRemove(now[0].id);
});

test('if the chat cannot be told, it is still added and the problem is reported', async () => {
  const r = await news.adminNewsAdd({ ...base, link: '444@g.us' });
  assert.equal(r.notified, false); assert.match(r.notifyError, /forbidden/);
  assert.ok(news.adminNewsView().items.some((i) => i.jid === '444@g.us'));
  for (const i of news.adminNewsView().items) news.adminNewsRemove(i.id); // clean for the next test
  assert.equal(news.adminNewsView().items.length, 0);
});

/* ---- the /api/admin/news routes ---- */
test('admin routes: login, add, change, remove (and nobody else can)', async () => {
  process.env.ADMIN_USER = 'boss'; process.env.ADMIN_PASSWORD = 'correct-horse-battery'; process.env.WEB_SECRET = 'test-secret-test-secret-test-secret';
  const { default: express } = await import('express');
  const { mountWeb } = await import('../lib/web.js');
  const app = express(); app.use(express.json()); mountWeb(app);
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = realFetch;
  try {
    let cookie = '';
    const call = async (method, path, body, auth = true) => {
      const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-rio': '1', ...(auth && cookie ? { cookie } : {}) } });
      return { status: r.status, json: await r.json().catch(() => ({})), setCookie: r.headers.get('set-cookie') };
    };
    assert.equal((await call('GET', '/api/admin/news', undefined, false)).status, 401);
    const login = await call('POST', '/api/admin/login', { user: 'boss', password: 'correct-horse-battery' }, false);
    assert.equal(login.status, 200); cookie = login.setCookie.split(';')[0];
    const add = await call('POST', '/api/admin/news', { link: 'https://whatsapp.com/channel/0029VaXYZ', sid: 's1', sources: ['hiru', 'itn'], days: 5, footer: 'both' });
    assert.equal(add.status, 200); assert.equal(add.json.items.length, 1); assert.equal(add.json.items[0].kind, 'channel');
    assert.equal((await call('POST', '/api/admin/news', { link: 'x', sid: 's1', sources: ['hiru'] })).status, 400);
    const id = add.json.items[0].id;
    const upd = await call('PATCH', `/api/admin/news/${id}`, { footer: 'custom', custom: 'hello', days: 9 });
    assert.equal(upd.status, 200); assert.equal(upd.json.items[0].footer.mode, 'custom');
    assert.equal((await call('PATCH', `/api/admin/news/${id}`, { days: 'abc' })).status, 400);
    assert.equal((await call('DELETE', `/api/admin/news/${id}`)).json.items.length, 0);
    assert.equal((await call('DELETE', `/api/admin/news/${id}`)).status, 404);
  } finally { server.close(); }
});
