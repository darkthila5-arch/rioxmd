// .cfc  ("Custom Follow Card" / welcome history) — a 👑 premium upgrade to the plain .welcome message.
// Instead of one template line, a group keeps its own TITLE plus a small HISTORY of up to MAX_CFC_MSGS messages
// (rules, links, pictures-as-text, anything). When somebody joins, the bot sends the title line first, then every
// saved message in order — same idea as a pinned "new member pack". .welcome / .goodbye are untouched and still
// work on their own; a group can use either, both, or neither.
//   .cfc                     show status (on/off, title, message count) and this usage list
//   .cfc on / off            switch the welcome history on or off (on needs at least one saved message)
//   .cfc settitle <title>    the bold line new members see first (defaults to the group name if never set)
//   .cfc add <message>       append one message to the history (max MAX_CFC_MSGS; placeholders: {user} {group} {count} {desc})
//   .cfc del <number>        remove one saved message (number from .cfc preview)
//   .cfc preview             sends the whole thing here right now, so the admin can check it before turning it on
//   .cfc clear               empty the history (title and on/off are kept)
//   .cfc reset               back to default: off, title cleared, history emptied
// Like .welcome / .goodbye this needs a group admin (or the number's own owner / the bot host). Being a 👑 premium
// command is handled by the router: the host admin (OWNER_NUMBER / OWNER_LID) can always use it; any other number
// needs active premium (/admin or .premium shows the plan) — see lib/router.js.
import { PREFIX } from '../lib/config.js';
import { adminGuard, getGroupCfg, setGroupCfg, sendCfcHistory, MAX_CFC_MSGS } from '../lib/groups.js';

const onoff = (v) => (v ? '✅ ON' : '❌ OFF');
const MAX_TITLE = 150;
const MAX_MSG = 700;

function statusText(cfg) {
  return [
    '╭━━━〔 🗂️ *CFC STATUS* 〕━━━⬣',
    `┃ Enabled: ${onoff(cfg.cfcOn)}`,
    `┃ Title: ${cfg.cfcTitle || '(not set — the group name is used)'}`,
    `┃ Messages: ${cfg.cfcHistory.length}/${MAX_CFC_MSGS}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    '*Usage:*',
    `${PREFIX}cfc on`,
    `${PREFIX}cfc off`,
    `${PREFIX}cfc settitle <title>`,
    `${PREFIX}cfc add <message>`,
    `${PREFIX}cfc del <number>`,
    `${PREFIX}cfc preview`,
    `${PREFIX}cfc clear`,
    `${PREFIX}cfc reset`,
    '',
    '_Placeholders you can use inside a saved message: {user} {group} {count} {desc}_',
    '_👑 Premium command — the bot host owner never needs premium for this._',
  ].join('\n');
}

export default [
  {
    name: 'cfc', aliases: ['welcomehistory', 'whistory'], premium: true, react: '🗂️',
    async run(c) {
      const { reply, args, sessionId, jid, sock } = c;
      const g = await adminGuard(c, { botAdmin: false }); // group, sender is an admin (or the number's owner / host) — same rule as .welcome
      if (!g) return;
      const cfg = getGroupCfg(sessionId, jid);
      const sub = (args[0] || '').toLowerCase();

      if (!sub) return reply(statusText(cfg));

      if (sub === 'on' || sub === 'off') {
        if (sub === 'on' && cfg.cfcHistory.length === 0) return reply(`⚠️ Add at least one message first: ${PREFIX}cfc add <message>`);
        setGroupCfg(sessionId, jid, { cfcOn: sub === 'on' });
        return reply(`✅ CFC welcome history: *${sub === 'on' ? 'ON' : 'OFF'}*`);
      }

      if (sub === 'settitle') {
        const title = args.slice(1).join(' ').trim();
        if (!title) return reply(`Usage: ${PREFIX}cfc settitle <title>`);
        setGroupCfg(sessionId, jid, { cfcTitle: title.slice(0, MAX_TITLE) });
        return reply('✅ CFC title saved for this group.');
      }

      if (sub === 'add') {
        const text = args.slice(1).join(' ').trim();
        if (!text) return reply(`Usage: ${PREFIX}cfc add <message>\nPlaceholders: {user} {group} {count} {desc}`);
        if (cfg.cfcHistory.length >= MAX_CFC_MSGS) return reply(`⚠️ This group already has ${MAX_CFC_MSGS}/${MAX_CFC_MSGS} CFC messages.\nRemove one with ${PREFIX}cfc del <number> or start over with ${PREFIX}cfc clear.`);
        const history = [...cfg.cfcHistory, text.slice(0, MAX_MSG)];
        setGroupCfg(sessionId, jid, { cfcHistory: history });
        return reply(`✅ Added message ${history.length}/${MAX_CFC_MSGS} to this group CFC history.`);
      }

      if (sub === 'del' || sub === 'remove') {
        const n = Number(args[1]);
        if (!cfg.cfcHistory.length) return reply('🗂️ This group has no CFC messages yet.');
        if (!Number.isInteger(n) || n < 1 || n > cfg.cfcHistory.length) return reply(`Usage: ${PREFIX}cfc del <number>  (1-${cfg.cfcHistory.length}; see ${PREFIX}cfc preview for the numbers)`);
        const history = cfg.cfcHistory.filter((_, i) => i !== n - 1);
        setGroupCfg(sessionId, jid, { cfcHistory: history });
        return reply(`✅ Removed message ${n}. ${history.length}/${MAX_CFC_MSGS} left.`);
      }

      if (sub === 'preview') {
        if (!cfg.cfcHistory.length) return reply(`🗂️ No CFC messages yet. Add one with ${PREFIX}cfc add <message>`);
        await sendCfcHistory(sock, jid, cfg, g.meta, null); // no real @mention for a preview — nobody actually joined
        return reply(`👆 That is what a new member will see (title + ${cfg.cfcHistory.length} message${cfg.cfcHistory.length === 1 ? '' : 's'}).`);
      }

      if (sub === 'clear') {
        if (!cfg.cfcHistory.length) return reply('🗂️ This group has no CFC messages to clear.');
        setGroupCfg(sessionId, jid, { cfcHistory: [] });
        return reply('✅ CFC message history cleared. The title and on/off switch are unchanged.');
      }

      if (sub === 'reset') {
        setGroupCfg(sessionId, jid, { cfcOn: false, cfcTitle: '', cfcHistory: [] });
        return reply('✅ CFC fully reset: off, title cleared, all messages removed.');
      }

      return reply(statusText(cfg));
    },
  },
];
