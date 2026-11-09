import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const { sessions } = await import('../lib/config.js');

const calls = [];
const mk = (phone, status = 'connected', fail = false) => ({
  status, phone, state: { creds: { registered: true } },
  sock: { updateProfileStatus: async (t) => { if (fail) throw new Error('nope'); calls.push([phone, t]); }, user: { id: `${phone}:1@s.whatsapp.net` } },
});
sessions.set('aaaaaaaaaaaaaaaaaaaaaaa1', mk('94771111111'));
sessions.set('aaaaaaaaaaaaaaaaaaaaaaa2', mk('94772222222'));
sessions.set('aaaaaaaaaaaaaaaaaaaaaaa3', mk('94773333333', 'close'));

test('admin: change the WhatsApp About of one number and of many', async () => {
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
    assert.equal((await call('POST', '/api/admin/session/aaaaaaaaaaaaaaaaaaaaaaa1/about', { text: 'hi' }, false)).status, 401); // nobody else can
    const login = await call('POST', '/api/admin/login', { user: 'boss', password: 'correct-horse-battery' }, false);
    cookie = login.setCookie.split(';')[0];

    // one number
    assert.equal((await call('POST', '/api/admin/session/aaaaaaaaaaaaaaaaaaaaaaa1/about', { text: '   ' })).status, 400);
    assert.equal((await call('POST', '/api/admin/session/aaaaaaaaaaaaaaaaaaaaaaa1/about', { text: 'x'.repeat(140) })).status, 400);
    const one = await call('POST', '/api/admin/session/aaaaaaaaaaaaaaaaaaaaaaa1/about', { text: '  Powered by\n RIO  ' });
    assert.equal(one.status, 200); assert.deepEqual(calls.pop(), ['94771111111', 'Powered by RIO']);
    assert.equal((await call('POST', '/api/admin/session/aaaaaaaaaaaaaaaaaaaaaaa3/about', { text: 'hello' })).status, 409); // offline
    assert.equal((await call('POST', '/api/admin/session/bbbbbbbbbbbbbbbbbbbbbbbb/about', { text: 'hello' })).status, 404);

    // many numbers: runs in the background, one after another; the offline one is skipped
    assert.equal((await call('POST', '/api/admin/bulk', { action: 'about', ids: ['aaaaaaaaaaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaaaaaaaaaa2'], text: '' })).status, 400);
    const bulk = await call('POST', '/api/admin/bulk', { action: 'about', ids: ['aaaaaaaaaaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaaaaaaaaaa2', 'aaaaaaaaaaaaaaaaaaaaaaa3'], text: 'New about' });
    assert.equal(bulk.status, 200); assert.equal(bulk.json.queued, 3);
    for (let i = 0; i < 40 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(calls.map((c) => c[1]), ['New about', 'New about']);
    assert.deepEqual(calls.map((c) => c[0]).sort(), ['94771111111', '94772222222']);
  } finally { server.close(); }
});
