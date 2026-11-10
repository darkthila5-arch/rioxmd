// .ban / .unban / .banlist: stop a person from using the bot (host owner only).
// Uses the same ban list as /admin -> Banned numbers, so it works on every linked number and the router already ignores banned people.
// Use:  .ban 94771234567   |   reply to / @mention someone with .ban   |   .unban 94771234567   |   .banlist
import { OWNER_NUMBER, OWNER_LIDS, PREFIX, jidNum, sessions } from '../lib/config.js';
import { bannedList, setBanned } from '../lib/control.js';

const protectedIds = (sock) => {
  const ids = new Set([OWNER_NUMBER, ...OWNER_LIDS, jidNum(sock.user?.id), jidNum(sock.user?.lid)].filter(Boolean));
  for (const s of sessions.values()) if (s.phone) ids.add(String(s.phone).replace(/\D/g, '')); // never ban a linked bot number
  return ids;
};

// Needs a clear target (number, reply or @mention). Alone in a private chat it would pick the chat itself, so that is refused.
function pickTarget(args, targetJid, jid) {
  const typed = (args[0] || '').replace(/\D/g, '');
  if (typed.length >= 8) return typed;
  const t = targetJid();
  if (!t || (!jid.endsWith('@g.us') && t === jid && !args.length)) return null;
  return jidNum(t);
}

export default [
  {
    name: 'ban', aliases: ['banuser'], adminOnly: true, owner: true, react: '🔨',
    async run({ sock, jid, args, targetJid, reply }) {
      const num = pickTarget(args, targetJid, jid);
      if (!num) return reply(`🔨 Usage: *${PREFIX}ban 94771234567* (or reply to / @mention the user)\nBanned people are ignored by the bot on every number.`);
      if (protectedIds(sock).has(num)) return reply("❌ You can't ban the owner or a linked bot number.");
      if (bannedList().includes(num)) return reply(`ℹ️ *${num}* is already banned.`);
      try { setBanned(num, true); } catch (err) { return reply(`❌ ${err.message}`); }
      return reply(`🔨 Banned *${num}*.\nThe bot will ignore them. Undo with *${PREFIX}unban ${num}*.`);
    },
  },
  {
    name: 'unban', aliases: ['unbanuser'], adminOnly: true, owner: true, react: '✅',
    async run({ jid, args, targetJid, reply }) {
      const num = pickTarget(args, targetJid, jid);
      if (!num) return reply(`✅ Usage: *${PREFIX}unban 94771234567* (or reply to / @mention the user)`);
      if (!bannedList().includes(num)) return reply(`ℹ️ *${num}* is not banned.`);
      try { setBanned(num, false); } catch (err) { return reply(`❌ ${err.message}`); }
      return reply(`✅ Unbanned *${num}*.`);
    },
  },
  {
    name: 'banlist', aliases: ['banned'], adminOnly: true, owner: true, react: '📋',
    async run({ reply }) {
      const list = bannedList();
      if (!list.length) return reply('📋 Nobody is banned.');
      return reply(`📋 *Banned (${list.length})*\n\n${list.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nRemove one with *${PREFIX}unban <number>*`);
    },
  },
];
