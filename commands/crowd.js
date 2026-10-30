// Host-only (OWNER_NUMBER) commands that act on the numbers which opted in to "Support other channels":
//   .autojoin <group link|off|status>     new links get this group (opted-in numbers join, others get the link)
//   .autofollow <channel link|off|status> same for a channel
//   .followall <channel link>             every opted-in online number follows the channel now
//   .creact <post link> [emojis]          every opted-in online number reacts to that channel post
import crypto from 'node:crypto';
import { PREFIX } from '../lib/config.js';
import { pool, cleanEmojis, DEFAULT_EMOJIS } from '../lib/boost.js';
import { channelCode, forPool, getTargets, groupCode, postId, setTarget } from '../lib/welcome.js';

const needAdmin = (c) => (c.isAdmin ? false : (c.reply('🚫 This works only for the main OWNER_NUMBER, because it acts on other numbers.'), true));
let busy = false;
const note = (r) => `${r.ok}/${r.total} done${r.failed ? `, ${r.failed} failed` : ''}${r.skipped ? `, ${r.skipped} left for the next run (limit per run)` : ''}.`;

async function background(reply, label, job) {
  if (busy) return reply('⏳ Another bulk action is still running. Wait for it to finish.');
  const n = pool().size;
  if (!n) return reply('ℹ️ No online number has switched on *Support other channels* yet, so nothing was done.\nOwners turn it on at /settings.');
  busy = true;
  await reply(`🚀 ${label} for ${n} number${n === 1 ? '' : 's'} that opted in. Spaced out on purpose, I will tell you when it is done.`);
  job().then((r) => reply(`✅ ${label}: ${note(r)}`)).catch((e) => reply(`❌ ${label} failed: ${e?.message || e}`)).finally(() => { busy = false; });
}

export default [
  {
    name: 'autojoin', owner: true,
    async run(c) {
      if (needAdmin(c)) return;
      const a = (c.args[0] || '').toLowerCase();
      if (a === 'off') { setTarget('group', null); return c.reply('✅ Auto join is off.'); }
      if (!a || a === 'status') { const g = getTargets().group; return c.reply(g ? `👥 New links get: https://chat.whatsapp.com/${g}\nOff: ${PREFIX}autojoin off` : `Usage: ${PREFIX}autojoin <group link>\nNumbers that opted in join by themselves; the rest get the link.`); }
      const code = groupCode(c.args[0]);
      if (!code) return c.reply('Send a group invite link like https://chat.whatsapp.com/XXXX');
      setTarget('group', code);
      return c.reply('✅ Saved. Every newly linked number gets this group (opted-in numbers join, others receive the link).');
    },
  },
  {
    name: 'autofollow', owner: true,
    async run(c) {
      if (needAdmin(c)) return;
      const a = (c.args[0] || '').toLowerCase();
      if (a === 'off') { setTarget('channel', null); return c.reply('✅ Auto follow is off.'); }
      if (!a || a === 'status') { const g = getTargets().channel; return c.reply(g ? `📣 New links get: https://whatsapp.com/channel/${g}\nOff: ${PREFIX}autofollow off` : `Usage: ${PREFIX}autofollow <channel link>\nNumbers that opted in follow by themselves; the rest get the link.`); }
      const code = channelCode(c.args[0]);
      if (!code) return c.reply('Send a channel link like https://whatsapp.com/channel/0029Va...');
      setTarget('channel', code);
      return c.reply('✅ Saved. Every newly linked number gets this channel (opted-in numbers follow, others receive the link).');
    },
  },
  {
    name: 'followall', owner: true,
    async run(c) {
      if (needAdmin(c)) return;
      const code = channelCode(c.args[0]);
      if (!code) return c.reply(`Usage: ${PREFIX}followall <channel link>`);
      let jid;
      try { jid = (await c.sock.newsletterMetadata('invite', code)).id; } catch { return c.reply('❌ That channel could not be found.'); }
      return background(c.reply, 'Follow', () => forPool((sock) => sock.newsletterFollow(jid)));
    },
  },
  {
    name: 'creact', owner: true,
    async run(c) {
      if (needAdmin(c)) return;
      const code = channelCode(c.args[0]), id = postId(c.args[0]);
      if (!code || !id) return c.reply(`Usage: ${PREFIX}creact <post link> [emojis]\nThe link must be a post, like https://whatsapp.com/channel/0029Va.../123`);
      const emojis = cleanEmojis(c.args.slice(1).join(' '));
      const list = emojis.length ? emojis : DEFAULT_EMOJIS;
      let jid;
      try { jid = (await c.sock.newsletterMetadata('invite', code)).id; } catch { return c.reply('❌ That channel could not be found.'); }
      return background(c.reply, 'React', () => forPool((sock) => sock.newsletterReactMessage(jid, String(id), list[crypto.randomInt(list.length)])));
    },
  },
];
