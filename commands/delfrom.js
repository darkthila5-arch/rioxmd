// .delfrom  (aliases .delbelow .clearfrom)   GROUP ADMINS: reply to a message, and that message and every message after it is deleted for everyone.
//   .delfrom          (reply to the first message to delete)  counts the messages and asks for confirmation
//   .delfrom yes      confirms (within 60 seconds)
//   .delfrom stop     stops a delete that is running
// The bot must be a group admin. It can only delete messages it SAW (lib/grouplog.js): nothing from before it started, or while it was offline.
// Deleting is slow on purpose (DELFROM_GAP_MS, default 700 ms between messages) so WhatsApp does not flag the number; DELFROM_MAX (default 300) is the most per run.
import { PREFIX, jidNum } from '../lib/config.js';
import { adminGuard } from '../lib/groups.js';
import { unwrapMessage } from '../lib/text.js';
import { groupLogForget, messagesFrom } from '../lib/grouplog.js';

const MAX = Math.max(5, Number(process.env.DELFROM_MAX || 300));
const GAP = Math.max(0, Number(process.env.DELFROM_GAP_MS ?? 700));
const CONFIRM_MS = 60 * 1000;
const BREAK_AFTER = 5; // this many failures in a row (no permission, rate limit ...) stops the run

export const pending = new Map(); // "session|group|who" -> { targetId, at }
const jobs = new Map();           // "session|group" -> { stop }
setInterval(() => { const t = Date.now(); for (const [k, v] of pending) if (t - v.at > CONFIRM_MS) pending.delete(k); }, 30 * 1000).unref();

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const ctxOf = (msg) => unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
const usage = [
  '🗑️ *Delete from a message downwards* (group admins)',
  `1) Reply to the FIRST message you want gone with ${PREFIX}delfrom`,
  `2) I count the messages and ask you to confirm: send ${PREFIX}delfrom yes`,
  `${PREFIX}delfrom stop = stop while it is running`,
  `I can only delete messages I saw while I was running (at most ${MAX} at a time), and WhatsApp leaves "This message was deleted" in the chat.`,
].join('\n');

async function runDelete(c, gk, targetId) {
  if (jobs.has(gk)) return c.reply(`⏳ A delete is already running in this group. ${PREFIX}delfrom stop cancels it.`);
  const { found, list } = messagesFrom(c.sessionId, c.jid, targetId);
  if (!found) return c.reply('❌ I do not remember that message any more. Reply to a newer one.');
  if (list.length > MAX) return c.reply(`❌ That is ${list.length} messages, more than the safety limit of ${MAX}. Reply to a message closer to the end.`);

  const job = { stop: false };
  jobs.set(gk, job);
  const done = [];
  let fail = 0, streak = 0, firstErr = '';
  try {
    for (const e of list) {
      if (job.stop) break;
      try {
        await c.sock.sendMessage(c.jid, { delete: { remoteJid: c.jid, fromMe: e.fromMe, id: e.id, ...(e.fromMe || !e.participant ? {} : { participant: e.participant }) } });
        done.push(e.id); streak = 0;
      } catch (err) {
        fail++; streak++; firstErr ||= String(err?.message || err).slice(0, 80);
        if (streak >= BREAK_AFTER) break;
      }
      await sleep(GAP + Math.floor(Math.random() * GAP * 0.5));
    }
  } finally {
    jobs.delete(gk);
    groupLogForget(c.sessionId, c.jid, done);
  }
  const left = list.length - done.length - fail;
  const lines = [`✅ Deleted ${done.length} message(s).`];
  if (fail) lines.push(`⚠️ ${fail} could not be deleted${firstErr ? ` (${firstErr})` : ''}.`);
  if (left > 0 && (job.stop || streak >= BREAK_AFTER)) lines.push(job.stop ? `🛑 Stopped: ${left} message(s) are still there.` : `🛑 Stopped after ${BREAK_AFTER} errors in a row: ${left} message(s) are still there.`);
  // Not a reply: the command message it would quote is already gone.
  return c.sock.sendMessage(c.jid, { text: lines.join('\n') }).catch(() => {});
}

export default [{
  name: 'delfrom', aliases: ['delbelow', 'clearfrom'], react: '🗑️',
  async run(c) {
    const g = await adminGuard(c); // group only, sender must be a group admin (or the owner), the bot must be an admin
    if (!g) return;
    const sub = String(c.args[0] || '').toLowerCase();
    const gk = `${c.sessionId}|${c.jid}`;
    const who = `${gk}|${c.msg.key?.fromMe ? 'me' : jidNum(c.msg.key?.participant || '')}`;

    if (sub === 'stop' || sub === 'cancel') {
      const job = jobs.get(gk);
      pending.delete(who);
      if (!job) return c.reply('Nothing is running.');
      job.stop = true;
      return c.reply('🛑 Stopping after the message that is being deleted now.');
    }
    if (sub === 'yes' || sub === 'confirm') {
      const p = pending.get(who);
      pending.delete(who);
      if (!p || Date.now() - p.at > CONFIRM_MS) return c.reply(`Nothing is waiting for confirmation. Reply to a message with ${PREFIX}delfrom first.`);
      return runDelete(c, gk, p.targetId);
    }

    const info = ctxOf(c.msg);
    if (!info?.stanzaId) return c.reply(usage);
    const { found, list } = messagesFrom(c.sessionId, c.jid, info.stanzaId);
    if (!found) return c.reply('❌ I do not remember that message (it is older than I have been running, or I was offline). Reply to a newer message.');
    if (list.length > MAX) return c.reply(`❌ That is ${list.length} messages, more than the safety limit of ${MAX}. Reply to a message closer to the end.`);
    pending.set(who, { targetId: info.stanzaId, at: Date.now() });
    return c.reply(`⚠️ This will delete *${list.length}* message(s) for everyone: the one you replied to and everything after it (including these commands).\nSend ${PREFIX}delfrom yes within 60 seconds to confirm.`);
  },
}];
