import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const { registry } = await import('../commands/index.js');

function ctx(name, args = []) {
  const out = [];
  const sock = {
    user: { id: '94771234567:5@s.whatsapp.net' },
    sendMessage: async (_j, c) => { out.push(c); return { key: { id: 'x' } }; },
    profilePictureUrl: async () => { throw new Error('none'); },
    groupMetadata: async () => ({ subject: 'G', participants: [{ id: '94771234567@s.whatsapp.net', admin: 'admin' }] }),
    groupFetchAllParticipating: async () => ({}),
    updateBlockStatus: async () => {}, readMessages: async () => {},
  };
  return { out, c: {
    sock, jid: '94770000000@s.whatsapp.net', sessionId: 'c'.repeat(24), args, command: name, name: 'Tester', footer: 'f',
    msg: { key: { remoteJid: '94770000000@s.whatsapp.net', id: 'M', fromMe: true }, message: { conversation: `.${name}` } },
    reply: async (t) => { out.push({ reply: t }); return { key: { id: 'r' } }; },
    isOwner: true, isAdmin: false, targetJid: () => '94770000001@s.whatsapp.net',
  } };
}
const text = (out) => out.map((o) => o.reply || o.text || o.caption || '').join('\n');

test('registry loads with no empty names', () => {
  assert.ok(new Set(registry.values()).size >= 100);
  for (const [n, cmd] of registry) assert.equal(typeof cmd.run, 'function', n);
});
test('every command runs without crashing when called with no arguments', async () => {
  const bad = [];
  for (const cmd of new Set(registry.values())) {
    const { c } = ctx(cmd.name);
    try { await Promise.race([cmd.run(c), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))]); }
    catch (e) { bad.push(`${cmd.name}: ${e.message}`); }
  }
  assert.deepEqual(bad, []);
});
test('calc: maths works, anything else is refused', async () => {
  const run = async (a) => { const { c, out } = ctx('calc', a); await registry.get('calc').run(c); return text(out); };
  assert.match(await run(['25*4+10']), /110/);
  assert.match(await run(['2^10']), /1024/);
  assert.match(await run(['process.exit()']), /only calculate/);
  assert.match(await run(['1/0']), /only calculate/);
});
test('password: right length, secure random, no repeats across calls', async () => {
  const get = async (n) => { const { c, out } = ctx('password', [String(n)]); await registry.get('password').run(c); return text(out).match(/`(.+?)`/)[1]; };
  assert.equal((await get(20)).length, 20);
  assert.equal((await get(1)).length, 6);   // minimum
  assert.equal((await get(99)).length, 32); // maximum
  assert.notEqual(await get(16), await get(16));
});
test('.ig and .tw are recognised (they used to say "send a valid Facebook link")', async () => {
  for (const [cmd, label] of [['ig', 'Instagram'], ['tw', 'Twitter']]) {
    const { c, out } = ctx(cmd, ['not-a-link']);
    await registry.get(cmd).run(c);
    assert.match(text(out), new RegExp(label));
    assert.doesNotMatch(text(out), /Facebook/);
  }
});
