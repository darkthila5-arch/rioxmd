import './setup.js';
process.env.ADMIN_USER = 'boss';
process.env.ADMIN_PASSWORD = 'correct-horse-battery';
process.env.WEB_SECRET = 'test-secret-test-secret-test-secret';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { sessions } = await import('../lib/config.js');
const { getSetting } = await import('../lib/storage.js');
const { mountWeb, parseSettings, readSettings, isPairingOpen, BOOLS } = await import('../lib/web.js');

const A = 'a'.repeat(24), B = 'b'.repeat(24), C = 'c'.repeat(24);
const sent = [];
const fake = (phone, online = true) => ({
  status: online ? 'connected' : 'disconnected', phone, state: { creds: { registered: true } }, retries: 0,
  sock: online ? { user: { id: `${phone}:1@s.whatsapp.net` }, end() {}, sendMessage: async (jid, body) => { sent.push([jid, body.text]); } } : null,
});
sessions.set(A, fake('94771234567'));
sessions.set(B, fake('94779876543'));
sessions.set(C, fake('94770001111', false));

const app = express();
app.use(express.json());
mountWeb(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

let cookie = '';
const call = async (method, path, body, { auth = true, header = true } = {}) => {
  const r = await fetch(base + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(header ? { 'x-rio': '1' } : {}), ...(auth && cookie ? { cookie } : {}) },
  });
  return { status: r.status, json: await r.json().catch(() => ({})), setCookie: r.headers.get('set-cookie') };
};

test('parseSettings accepts the new presence options and rejects bad input', () => {
  for (const k of ['autoRead', 'autoTyping', 'autoRecording', 'alwaysOnline']) assert.ok(BOOLS.includes(k));
  assert.deepEqual(parseSettings({ autoRead: true, mode: 'private' }), [['autoRead', true], ['mode', 'private']]);
  assert.throws(() => parseSettings({ autoRead: 'yes' }));
  assert.throws(() => parseSettings({ mode: 'friends' }));
  assert.throws(() => parseSettings({ callStream: true }));
  assert.throws(() => parseSettings({ webPass: 'x' }), /Unknown setting/);
  assert.throws(() => parseSettings({}));
  assert.throws(() => parseSettings([]));
});

test('admin routes need a login and the x-rio header', async () => {
  assert.equal((await call('GET', '/api/admin/overview')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { user: 'boss', password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { user: 'boss', password: 'correct-horse-battery' }, { header: false })).status, 403);
  const ok = await call('POST', '/api/admin/login', { user: 'boss', password: 'correct-horse-battery' });
  assert.equal(ok.status, 200);
  cookie = ok.setCookie.split(';')[0];
  const o = await call('GET', '/api/admin/overview');
  assert.equal(o.status, 200);
  assert.equal(o.json.sessions.length, 3);
  assert.equal(o.json.connected, 2);
  assert.equal(o.json.pairingOpen, true);
  assert.ok(!JSON.stringify(o.json).includes('94771234567'), 'numbers stay masked');
});

test('bulk settings change only the ticked numbers', async () => {
  const r = await call('POST', '/api/admin/bulk', { ids: [A, B], action: 'settings', patch: { autoRead: true, alwaysOnline: true } });
  assert.equal(r.json.done, 2);
  assert.equal(getSetting(A, 'autoRead', false), true);
  assert.equal(getSetting(B, 'alwaysOnline', false), true);
  assert.equal(getSetting(C, 'autoRead', false), false);
  assert.equal(readSettings(A).autoRead, true);
});

test('bulk with "all" reaches every linked number, bad ids are ignored, bad patches change nothing', async () => {
  assert.equal((await call('POST', '/api/admin/bulk', { ids: 'all', action: 'settings', patch: { viewOnce: true } })).json.done, 3);
  assert.equal(getSetting(C, 'viewOnce', false), true);
  assert.equal((await call('POST', '/api/admin/bulk', { ids: ['zzz', '../etc'], action: 'settings', patch: { viewOnce: false } })).status, 400);
  assert.equal((await call('POST', '/api/admin/bulk', { ids: [A], action: 'settings', patch: { statusSeen: true, mode: 'oops' } })).status, 400);
  assert.equal(getSetting(A, 'statusSeen', false), false, 'a rejected patch is never half applied');
  assert.equal((await call('POST', '/api/admin/bulk', { ids: [A], action: 'format-disk' })).status, 400);
});

test('bulk reset puts everything back to the defaults', async () => {
  await call('POST', '/api/admin/bulk', { ids: [A], action: 'reset' });
  assert.equal(getSetting(A, 'autoRead', false), false);
  assert.equal(getSetting(A, 'viewOnce', false), false);
  assert.equal(getSetting(B, 'autoRead', false), true, 'other numbers are untouched');
});

test('bulk notice goes to each online number, one at a time, and offline ones are skipped', async () => {
  sent.length = 0;
  assert.equal((await call('POST', '/api/admin/bulk', { ids: [A, B, C], action: 'notice', text: 'Maintenance at 10pm' })).json.queued, 3);
  assert.equal((await call('POST', '/api/admin/bulk', { ids: [A], action: 'restart' })).status, 409, 'a second job waits for the first');
  assert.equal((await call('POST', '/api/admin/bulk', { ids: [A], action: 'notice', text: '' })).status, 409);
  for (let i = 0; i < 60 && (await call('GET', '/api/admin/overview')).json.bulk; i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(sent.length, 2);
  assert.ok(sent.every(([jid, text]) => jid.endsWith('@s.whatsapp.net') && text.includes('Maintenance at 10pm')));
  const log = (await call('GET', '/api/admin/overview')).json.audit.map((a) => `${a.action} ${a.detail}`).join('\n');
  assert.match(log, /bulk notice 2 done, 1 skipped/);
});

test('a single number: notice, reset and detail', async () => {
  sent.length = 0;
  assert.equal((await call('POST', `/api/admin/session/${A}/notice`, { text: 'hello' })).status, 200);
  assert.equal(sent.length, 1);
  assert.equal((await call('POST', `/api/admin/session/${C}/notice`, { text: 'hello' })).status, 409);
  assert.equal((await call('POST', `/api/admin/session/${A}/notice`, { text: '   ' })).status, 400);
  const d = await call('GET', `/api/admin/session/${A}`);
  assert.equal(d.json.linked, true);
  assert.equal(d.json.settings.autoRead, false);
  assert.equal((await call('GET', `/api/admin/session/${'f'.repeat(24)}`)).status, 404);
});

test('admin can pause and reopen new links', async () => {
  assert.equal(isPairingOpen(), true);
  await call('POST', '/api/admin/pairing', { open: false });
  assert.equal(isPairingOpen(), false);
  assert.equal((await call('GET', '/api/admin/overview')).json.pairingOpen, false);
  assert.equal((await call('POST', '/api/admin/pairing', { open: 'no' })).status, 400);
  await call('POST', '/api/admin/pairing', { open: true });
  assert.equal(isPairingOpen(), true);
});
