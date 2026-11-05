import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const ctl = await import('../lib/control.js');
const { registry } = await import('../commands/index.js');
const { handleMessage } = await import('../lib/router.js');

const A = 'a'.repeat(24), B = 'b'.repeat(24);
const cmd = (n) => registry.get(n);

test('no limit by default', () => {
  assert.equal(ctl.sessionAllowed(A), null);
  assert.equal(ctl.isCmdBlockedFor(A, cmd('ping')), false);
});

test('limit: only the listed commands work, for that number only; the list is kept when the limit is switched off', () => {
  ctl.setSessionLimit(A, true, ['ping', 'ping', 'alive']);
  assert.deepEqual(ctl.sessionLimit(A), { only: true, allowed: ['ping', 'alive'] });
  assert.equal(ctl.isCmdBlockedFor(A, cmd('ping')), false);
  assert.equal(ctl.isCmdBlockedFor(A, cmd('joke')), true);
  assert.equal(ctl.isCmdBlockedFor(B, cmd('joke')), false); // another number is not touched
  ctl.setSessionLimit(A, false, ['ping', 'alive']);
  assert.equal(ctl.isCmdBlockedFor(A, cmd('joke')), false);
  assert.deepEqual(ctl.sessionLimit(A).allowed, ['ping', 'alive']);
});

test('menu text hides the blocked commands, only inside that number\'s own context', () => {
  const text = ['╭─❮ GENERAL ❯', '│ ✦ .ping · .alive', '╰─', '', '╭─❮ FUN ❯', '│ ✦ .joke · .fact', '╰─', ''].join('\n');
  ctl.setSessionLimit(A, true, ['ping']);
  const forA = ctl.runAsSession(A, () => ctl.filterCaption(text));
  assert.match(forA, /\.ping/); assert.doesNotMatch(forA, /\.alive/); assert.doesNotMatch(forA, /\.joke/); assert.doesNotMatch(forA, /FUN/); // the empty FUN section is gone too
  assert.equal(ctl.runAsSession(B, () => ctl.filterCaption(text)), text);
  assert.equal(ctl.filterCaption(text), text); // outside any number: unchanged
  ctl.setSessionLimit(A, false, []);
});

test('router: a blocked command answers "not enabled for this number" and does not run; an allowed one runs; other numbers are free', async () => {
  const sent = [];
  const sock = { user: { id: '94700000000:1@s.whatsapp.net' }, sendMessage: async (_j, c) => { sent.push(c); return {}; }, signalRepository: {} };
  let n = 0;
  const msg = (text) => ({ key: { remoteJid: '94711111111@s.whatsapp.net', id: `T${++n}${Date.now()}`, fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Tester', message: { conversation: text } });
  const said = () => JSON.stringify(sent);
  ctl.setSessionLimit(A, true, ['ping']);
  await handleMessage(sock, msg('.coin'), A);
  assert.match(said(), /not enabled for this number/);
  sent.length = 0;
  await handleMessage(sock, msg('.coin'), B);
  assert.doesNotMatch(said(), /not enabled for this number/);
  assert.ok(sent.length > 0);
  ctl.setSessionLimit(A, false, []);
});
