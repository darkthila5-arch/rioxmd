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
    query: async (node) => { if (node.tag === 'message') sent.push({ id, node }); return { attrs: {} }; },
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
test('vote is the WA Web channel stanza: meta + votes/vote with the sha256 of the option name', async () => {
  const { pollVoteNode } = await import('../lib/boost.js');
  const n = pollVoteNode('123@newsletter', '55', 'Apple');
  assert.equal(n.tag, 'message'); assert.equal(n.attrs.type, 'poll'); assert.equal(n.attrs.server_id, '55'); assert.equal(n.attrs.to, '123@newsletter');
  assert.deepEqual(n.content.map((c) => c.tag), ['meta', 'votes']);
  assert.equal(n.content[0].attrs.polltype, 'vote');
  const vote = n.content[1].content[0];
  assert.equal(vote.tag, 'vote'); assert.ok(vote.content.equals(crypto.createHash('sha256').update('Apple').digest())); assert.equal(vote.content.length, 32);
});
test('the ack decides: accepted vs refused', async () => {
  sent.length = 0;
  const r = await sendPollVote(sessions.get('a').sock, '123@newsletter', '55', 'Apple');
  assert.equal(r.ok, true); assert.equal(sent[0].node.attrs.server_id, '55');
  const bad = { query: async () => ({ attrs: { error: '403' } }) };
  const r2 = await sendPollVote(bad, '123@newsletter', '55', 'Apple');
  assert.equal(r2.ok, false); assert.match(r2.ack, /403/);
});
test('first vote refused: the run stops and other numbers are not used', async () => {
  for (const r of sessions.values()) r.sock.query = async () => ({ attrs: { error: '479' } });
  sent.length = 0;
  await votePoll(LINK, 0, 3, 'all', false);
  for (let i = 0; i < 50 && adminBoost().pollRun?.running; i++) await new Promise((r) => setTimeout(r, 20));
  const run = adminBoost().pollRun;
  assert.equal(run.aborted, true); assert.equal(run.failed, 1); assert.match(run.note, /479/);
  for (const r of sessions.values()) r.sock.query = async (node) => { if (node.tag === 'message') sent.push({ node }); return { attrs: {} }; };
});
test('votePoll: N distinct numbers vote once each, count is capped', async () => {
  sent.length = 0;
  await votePoll(LINK, 1, 99, 'all', true);
  for (let i = 0; i < 50 && adminBoost().pollRun?.running; i++) await new Promise((r) => setTimeout(r, 20));
  const run = adminBoost().pollRun;
  assert.equal(run.total, 3); assert.equal(run.ok, 3); assert.equal(run.option, 'Apple');
  assert.equal(sent.length, 3);
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
  assert.equal(sent[0].node.tag, 'message');
});

test('raw messages query result with a plaintext poll is read; a live poll is cached', async () => {
  const { cachePollFromMessage } = await import('../lib/boost.js');
  cachePollFromMessage({ key: { remoteJid: '123@newsletter' }, newsletter_server_id: 77, message: { pollCreationMessageV3: { name: 'Live?', options: [{ optionName: 'Yes' }, { optionName: 'No' }] } } });
  const p = await loadPoll('https://whatsapp.com/channel/0029VaABCDEFGH/77');
  assert.equal(p.question, 'Live?'); assert.deepEqual(p.options, ['Yes', 'No']);
});
