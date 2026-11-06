import './setup.js';
process.env.DELFROM_GAP_MS = '0'; // no waiting between deletes in tests
import test from 'node:test';
import assert from 'node:assert/strict';

const log = await import('../lib/grouplog.js');
const mod = await import('../commands/delfrom.js');
const cmd = mod.default[0];

const G = '120363000000000001@g.us';
const SID = 's'.repeat(24);
let n = 0;
const gmsg = (id, { fromMe = false, who = '94770000001@s.whatsapp.net', ts, message = { conversation: 'hi' }, jid = G } = {}) =>
  ({ key: { remoteJid: jid, id, fromMe, participant: fromMe ? undefined : who }, messageTimestamp: ts ?? 1000 + ++n, message });
const feed = (ids, opts) => { for (const id of ids) log.groupLogSeen(SID, gmsg(id, opts)); };

function ctx({ args = [], quoted, jid = G, who = '94770000009@s.whatsapp.net', failIds = new Set(), gate = null } = {}) {
  const out = [];
  const deletes = [];
  const sock = {
    user: { id: '94771234567:5@s.whatsapp.net' },
    groupMetadata: async () => ({ subject: 'G', participants: [{ id: '94771234567@s.whatsapp.net', admin: 'admin' }] }),
    sendMessage: async (_j, content) => {
      if (content.delete) {
        if (gate) await gate;
        if (failIds.has(content.delete.id)) throw new Error('not-authorized');
        deletes.push(content.delete);
      } else out.push(content);
      return { key: { id: 'x' } };
    },
  };
  const message = quoted
    ? { extendedTextMessage: { text: '.delfrom', contextInfo: { stanzaId: quoted, participant: '94770000001@s.whatsapp.net' } } }
    : { conversation: '.delfrom' };
  return {
    out, deletes,
    c: {
      sock, jid, sessionId: SID, args, command: 'delfrom',
      msg: { key: { remoteJid: jid, id: `C${++n}`, fromMe: false, participant: who }, message },
      reply: async (t) => { out.push({ reply: t }); return { key: { id: 'r' } }; },
      isOwner: true, isAdmin: true,
    },
  };
}
const said = (out) => out.map((o) => o.reply || o.text || '').filter(Boolean).join('\n');
test.beforeEach(() => { log._resetGroupLog(); mod.pending.clear(); });

/* ---------- the message log ---------- */
test('grouplog: only group messages with content; reactions / protocol messages skipped; a revoke removes the message', () => {
  feed(['A', 'B', 'C']);
  assert.equal(log.groupLogSize(SID, G), 3);
  log.groupLogSeen(SID, gmsg('P1', { jid: '94770000002@s.whatsapp.net' }));     // private chat
  log.groupLogSeen(SID, gmsg('R1', { message: { reactionMessage: { text: '👍' } } }));
  log.groupLogSeen(SID, gmsg('X1', { message: { protocolMessage: { type: 14 } } }));
  log.groupLogSeen(SID, { key: { remoteJid: G, id: 'S1' }, messageTimestamp: 1 }); // no content (group event)
  assert.equal(log.groupLogSize(SID, G), 3);
  log.groupLogSeen(SID, gmsg('D1', { message: { protocolMessage: { type: 0, key: { id: 'B' } } } })); // B deleted by somebody
  assert.deepEqual(log.messagesFrom(SID, G, 'A').list.map((e) => e.id), ['A', 'C']);
  log.groupLogSeen(SID, gmsg('A')); // same id again: no duplicate
  assert.equal(log.groupLogSize(SID, G), 2);
});
test('grouplog: messagesFrom = that message and everything after it, ordered by time even if they arrived late; unknown id = not found', () => {
  log.groupLogSeen(SID, gmsg('m1', { ts: 100 }));
  log.groupLogSeen(SID, gmsg('m3', { ts: 300 }));
  log.groupLogSeen(SID, gmsg('m2', { ts: 200 })); // arrived late
  assert.deepEqual(log.messagesFrom(SID, G, 'm2').list.map((e) => e.id), ['m2', 'm3']);
  assert.deepEqual(log.messagesFrom(SID, G, 'm1').list.map((e) => e.id), ['m1', 'm2', 'm3']);
  assert.equal(log.messagesFrom(SID, G, 'nope').found, false);
  assert.equal(log.messagesFrom('other'.padEnd(24, 'x'), G, 'm1').found, false); // another session has its own log
});
test('grouplog: a group keeps at most GROUPLOG_MAX messages (oldest dropped)', () => {
  for (let i = 0; i < 1100; i++) log.groupLogSeen(SID, gmsg(`k${i}`));
  assert.equal(log.groupLogSize(SID, G), 1000);
  assert.equal(log.messagesFrom(SID, G, 'k0').found, false);
  assert.equal(log.messagesFrom(SID, G, 'k1099').found, true);
});

/* ---------- the command ---------- */
test('delfrom: groups only; without a reply it explains; an unknown message is refused', async () => {
  let r = ctx({ jid: '94770000002@s.whatsapp.net' });
  await cmd.run(r.c);
  assert.match(said(r.out), /only works in groups/);
  r = ctx();
  await cmd.run(r.c);
  assert.match(said(r.out), /Delete from a message downwards/);
  r = ctx({ quoted: 'GHOST' });
  await cmd.run(r.c);
  assert.match(said(r.out), /do not remember that message/);
  assert.equal(r.deletes.length, 0);
});
test('delfrom: counts, asks to confirm, then deletes that message and all after it (own messages without participant)', async () => {
  feed(['m1', 'm2']);
  log.groupLogSeen(SID, gmsg('m3', { who: '94770000003@s.whatsapp.net' }));
  log.groupLogSeen(SID, gmsg('m4', { fromMe: true }));
  log.groupLogSeen(SID, gmsg('m5', { who: '94770000005@s.whatsapp.net' }));
  const ask = ctx({ quoted: 'm3' });
  await cmd.run(ask.c);
  assert.match(said(ask.out), /delete \*3\* message/);
  assert.equal(ask.deletes.length, 0, 'nothing is deleted before the confirmation');

  const yes = ctx({ args: ['yes'] });
  await cmd.run(yes.c);
  assert.deepEqual(yes.deletes.map((d) => d.id), ['m3', 'm4', 'm5']);
  assert.deepEqual(yes.deletes[0], { remoteJid: G, fromMe: false, id: 'm3', participant: '94770000003@s.whatsapp.net' });
  assert.deepEqual(yes.deletes[1], { remoteJid: G, fromMe: true, id: 'm4' });
  assert.match(said(yes.out), /Deleted 3 message/);
  assert.deepEqual(log.messagesFrom(SID, G, 'm1').list.map((e) => e.id), ['m1', 'm2']); // deleted ones are forgotten, older ones stay

  const again = ctx({ args: ['yes'] });
  await cmd.run(again.c);
  assert.match(said(again.out), /Nothing is waiting/);
  assert.equal(again.deletes.length, 0);
});
test('delfrom: "yes" without a request, from another person, or too late does nothing', async () => {
  feed(['a1', 'a2']);
  const ask = ctx({ quoted: 'a1', who: '94770000009@s.whatsapp.net' });
  await cmd.run(ask.c);
  const other = ctx({ args: ['yes'], who: '94770000008@s.whatsapp.net' }); // a different admin did not ask
  await cmd.run(other.c);
  assert.match(said(other.out), /Nothing is waiting/);
  for (const v of mod.pending.values()) v.at -= 61 * 1000; // too late
  const late = ctx({ args: ['yes'], who: '94770000009@s.whatsapp.net' });
  await cmd.run(late.c);
  assert.match(said(late.out), /Nothing is waiting/);
  assert.equal(late.deletes.length + other.deletes.length, 0);
});
test('delfrom: errors are counted; 5 errors in a row stop the run', async () => {
  feed(['e1', 'e2', 'e3', 'e4']);
  await cmd.run(ctx({ quoted: 'e1' }).c);
  const some = ctx({ args: ['yes'], failIds: new Set(['e2']) });
  await cmd.run(some.c);
  assert.deepEqual(some.deletes.map((d) => d.id), ['e1', 'e3', 'e4']);
  assert.match(said(some.out), /Deleted 3/); assert.match(said(some.out), /1 could not be deleted \(not-authorized\)/);

  feed(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']);
  await cmd.run(ctx({ quoted: 'f1' }).c);
  const all = ctx({ args: ['yes'], failIds: new Set(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']) });
  await cmd.run(all.c);
  assert.match(said(all.out), /Stopped after 5 errors/);
  assert.match(said(all.out), /2 message\(s\) are still there/);
});
test('delfrom: more than DELFROM_MAX messages is refused', async () => {
  for (let i = 0; i < 310; i++) log.groupLogSeen(SID, gmsg(`z${i}`));
  const r = ctx({ quoted: 'z0' });
  await cmd.run(r.c);
  assert.match(said(r.out), /310 messages, more than the safety limit of 300/);
  const ok = ctx({ quoted: 'z20' });
  await cmd.run(ok.c);
  assert.match(said(ok.out), /delete \*290\*/);
});
test('delfrom: stop cancels a running delete; a second run in the same group is refused while one is running', async () => {
  feed(['s1', 's2', 's3', 's4']);
  await cmd.run(ctx({ quoted: 's1' }).c);
  let release;
  const gate = new Promise((ok) => { release = ok; });
  const run = ctx({ args: ['yes'], gate });
  const running = cmd.run(run.c);
  await new Promise((ok) => setTimeout(ok, 20));

  await cmd.run(ctx({ quoted: 's2', who: '94770000007@s.whatsapp.net' }).c);
  const second = ctx({ args: ['yes'], who: '94770000007@s.whatsapp.net' });
  await cmd.run(second.c);
  assert.match(said(second.out), /already running/);

  const stop = ctx({ args: ['stop'] });
  await cmd.run(stop.c);
  assert.match(said(stop.out), /Stopping/);
  release();
  await running;
  assert.equal(run.deletes.length, 1); // the one in flight finishes, the rest is left alone
  assert.match(said(run.out), /Deleted 1/); assert.match(said(run.out), /Stopped: 3 message/);
  const nothing = ctx({ args: ['stop'] });
  await cmd.run(nothing.c);
  assert.match(said(nothing.out), /Nothing is running/);
});
