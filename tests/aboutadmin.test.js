import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const { sessions } = await import('../lib/config.js');
const { getSetting, setSetting } = await import('../lib/storage.js');
const about = await import('../lib/about.js');

const ID = (c) => c.repeat(24);
const calls = [];
// a fake WhatsApp connection that remembers its About, like the real one
const mk = (phone, status = 'connected', start = null) => {
  let current = start;
  return {
    status, phone, state: { creds: { registered: true } },
    sock: {
      user: { id: `${phone}:1@s.whatsapp.net` },
      updateProfileStatus: async (t) => { calls.push([phone, t]); current = t; },
      fetchStatus: async (jid) => [{ id: jid, status: { status: current, setAt: new Date() } }],
    },
  };
};
sessions.set(ID('a'), mk('94771111111', 'connected', 'old about'));
sessions.set(ID('b'), mk('94772222222'));
sessions.set(ID('c'), mk('94773333333', 'close'));
const wait = async (fn, ms = 10000) => { for (let i = 0; i < ms / 100; i++) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

test('default About: "POWERED BY RIO X MD", host can change it or switch it off', async () => {
  assert.equal(about.getDefaultAbout(), 'POWERED BY RIO X MD');
  calls.length = 0;
  assert.equal(await about.applyDefaultAbout(sessions.get(ID('b')).sock, ID('b')), true);
  assert.deepEqual(calls, [['94772222222', 'POWERED BY RIO X MD']]);
  setSetting('_global', 'botmedia_about', 'My own about');
  calls.length = 0; await about.applyDefaultAbout(sessions.get(ID('b')).sock, ID('b'));
  assert.deepEqual(calls, [['94772222222', 'My own about']]);
  setSetting('_global', 'botmedia_aboutAuto', false);
  calls.length = 0; assert.equal(await about.applyDefaultAbout(sessions.get(ID('b')).sock, ID('b')), false);
  assert.equal(calls.length, 0);
  setSetting('_global', 'botmedia_about', null); setSetting('_global', 'botmedia_aboutAuto', true);
  assert.equal(about.cleanAboutText('  a\n b  '), 'a b');
  assert.throws(() => about.cleanAboutText(''), /Write/); assert.throws(() => about.cleanAboutText('x'.repeat(140)), /139/);
});

test('admin: change / read the WhatsApp About of one number and of many', async () => {
  process.env.ADMIN_USER = 'boss'; process.env.ADMIN_PASSWORD = 'correct-horse-battery'; process.env.WEB_SECRET = 'test-secret-test-secret-test-secret';
  const { default: express } = await import('express');
  const { mountWeb } = await import('../lib/web.js');
  const app = express(); app.use(express.json()); mountWeb(app);
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let cookie = '';
    const call = async (method, path, body, auth = true) => {
      const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-rio': '1', ...(auth && cookie ? { cookie } : {}) } });
      return { status: r.status, json: await r.json().catch(() => ({})), setCookie: r.headers.get('set-cookie') };
    };
    assert.equal((await call('POST', `/api/admin/session/${ID('a')}/about`, { text: 'hi' }, false)).status, 401); // nobody else can
    cookie = (await call('POST', '/api/admin/login', { user: 'boss', password: 'correct-horse-battery' }, false)).setCookie.split(';')[0];

    // the current About is read from WhatsApp and shown
    const live = await call('GET', `/api/admin/session/${ID('a')}/about`);
    assert.equal(live.json.about, 'old about');
    assert.equal((await call('GET', '/api/admin/overview')).status, 200);
    assert.ok(await wait(async () => (await call('GET', '/api/admin/overview')).json.sessions.find((x) => x.id === ID('a'))?.about === 'old about'), 5000);

    // one number
    assert.equal((await call('POST', `/api/admin/session/${ID('a')}/about`, { text: '   ' })).status, 400);
    assert.equal((await call('POST', `/api/admin/session/${ID('a')}/about`, { text: 'x'.repeat(140) })).status, 400);
    calls.length = 0;
    const one = await call('POST', `/api/admin/session/${ID('a')}/about`, { text: '  Powered by\n RIO  ' });
    assert.equal(one.status, 200); assert.deepEqual(calls.pop(), ['94771111111', 'Powered by RIO']);
    assert.equal(one.json.about, 'Powered by RIO'); assert.equal(one.json.confirmed, true); // read back from "WhatsApp"
    assert.equal((await call('POST', `/api/admin/session/${ID('c')}/about`, { text: 'hello' })).status, 409); // offline
    assert.equal((await call('POST', `/api/admin/session/${ID('d')}/about`, { text: 'hello' })).status, 404);

    // the Bot media → About card
    const view = await call('GET', '/api/admin/about');
    assert.equal(view.json.effective, 'POWERED BY RIO X MD'); assert.equal(view.json.auto, true); assert.equal(view.json.numbers.length, 3);
    assert.equal((await call('POST', '/api/admin/about/default', { text: 'x'.repeat(140) })).status, 400);
    const saved = await call('POST', '/api/admin/about/default', { text: 'Hello from the host', auto: false });
    assert.equal(saved.json.effective, 'Hello from the host'); assert.equal(saved.json.auto, false);
    assert.equal((await call('POST', '/api/admin/about/default', { text: '', auto: true })).json.effective, 'POWERED BY RIO X MD'); // empty = built-in

    // many numbers: runs in the background, one after another; the offline one is skipped and the result is reported
    assert.equal((await call('POST', '/api/admin/bulk', { action: 'about', ids: [ID('a'), ID('b')], text: '' })).status, 400);
    calls.length = 0;
    const bulk = await call('POST', '/api/admin/bulk', { action: 'about', ids: 'all', text: 'POWERED BY RIO X MD' });
    assert.equal(bulk.status, 200); assert.equal(bulk.json.queued, 3);
    assert.ok(await wait(async () => (await call('GET', '/api/admin/overview')).json.lastBulk?.action === 'about', 15000));
    const lb = (await call('GET', '/api/admin/overview')).json.lastBulk;
    assert.equal(lb.ok, 2); assert.equal(lb.failed, 1);
    assert.deepEqual(calls.map((c) => c[1]), ['POWERED BY RIO X MD', 'POWERED BY RIO X MD']);
    const after = (await call('GET', '/api/admin/about')).json.numbers;
    assert.equal(after.find((n) => n.id === ID('b')).about, 'POWERED BY RIO X MD');
  } finally { server.close(); }
});
