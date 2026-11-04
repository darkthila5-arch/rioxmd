import './setup.js';
process.env.BOOST_GAP_MS = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
const { sessions } = await import('../lib/config.js');
const { loadPoll, votePoll, sendPollVote, adminBoost } = await import('../lib/boost.js');
import crypto from 'node:crypto';

const LINK = 'https://whatsapp.com/channel/0029VaABCDEFGH/55';
const sent = [];
const mk = (id) => ({
  status: 'connected', phone: id,
  sock: {
    newsletterMetadata: async () => ({ id: '123@newsletter', name: 'Test channel' }),
    newsletterFetchMessages: async () => ({ tag: 'messages', content: [{ tag: 'message', attrs: { server_id: '55' }, content: [{ pollCreationMessage: { name: 'Best fruit?', options: [{ optionName: 'Mango' }, { optionName: 'Apple' }] } }] }] }),
    newsletterFollow: async () => {},
    relayMessage: async (jid, message, opts) => { sent.push({ id, jid, message, opts }); },
  },
});
for (const id of ['a', 'b', 'c']) sessions.set(id, mk(id));

test('loadPoll reads question and options', async () => {
  const p = await loadPoll(LINK);
  assert.equal(p.question, 'Best fruit?');
  assert.deepEqual(p.options, ['Mango', 'Apple']);
  assert.equal(p.online, 3);
});
test('loadPoll rejects a bad link', async () => {
  await assert.rejects(() => loadPoll('https://example.com/x'), /POLL post link/);
});
test('vote message carries sha256 of the option name', async () => {
  sent.length = 0;
  await sendPollVote(sessions.get('a').sock, '123@newsletter', '55', 'Apple');
  const v = sent[0].message.pollUpdateMessage.vote.selectedOptions[0];
  assert.ok(v.equals(crypto.createHash('sha256').update('Apple').digest()));
});
test('votePoll: N distinct numbers vote once each, count is capped', async () => {
  sent.length = 0;
  await votePoll(LINK, 1, 99, 'all', true);
  for (let i = 0; i < 50 && adminBoost().pollRun?.running; i++) await new Promise((r) => setTimeout(r, 20));
  const run = adminBoost().pollRun;
  assert.equal(run.total, 3); assert.equal(run.ok, 3); assert.equal(run.option, 'Apple');
  assert.equal(new Set(sent.map((s) => s.id)).size, 3);
  sent.length = 0;
  await votePoll(LINK, 0, 2, 'all', false);
  for (let i = 0; i < 50 && adminBoost().pollRun?.running; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 2);
});
test('votePoll rejects a wrong option index', async () => {
  await assert.rejects(() => votePoll(LINK, 7, 1, 'all', false), /Pick one/);
});

test('unreadable poll: load still works (manual mode) and a typed option can be voted', async () => {
  for (const r of sessions.values()) r.sock.newsletterFetchMessages = async () => ({ tag: 'messages', content: [] });
  const p = await loadPoll(LINK);
  assert.equal(p.unreadable, true); assert.ok(p.diag.length > 0);
  await assert.rejects(() => votePoll(LINK, 0, 1, 'all', false, ''), /Type the option text/);
  sent.length = 0;
  await votePoll(LINK, 0, 1, 'all', false, 'Mango');
  for (let i = 0; i < 50 && adminBoost().pollRun?.running; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].message.pollUpdateMessage.vote.selectedOptions[0].equals(crypto.createHash('sha256').update('Mango').digest()));
});
