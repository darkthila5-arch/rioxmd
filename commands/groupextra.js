// Extra group commands: rules, poll, warn list, tag admins, lock / unlock group info, join requests, disappearing messages, group picture.
// Add a new command by adding one more object to this array.
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { PREFIX, jidNum, logger } from '../lib/config.js';
import { adminGuard, getGroupCfg, setGroupCfg } from '../lib/groups.js';
import { say } from '../lib/card.js';
import { unwrapMessage } from '../lib/text.js';

const tag = (jid) => `@${jidNum(jid)}`;
const onlyGroup = async (c) => (c.jid.endsWith('@g.us') ? true : (await c.reply('👥 This command only works in groups.'), false));
const EPHEMERAL = { off: 0, '24h': 86400, '7d': 604800, '90d': 7776000 };

export default [
  {
    name: 'rules',
    async run(c) {
      if (!(await onlyGroup(c))) return;
      if ((c.args[0] || '').toLowerCase() === 'set') {
        const g = await adminGuard(c, { botAdmin: false });
        if (!g) return;
        const text = c.args.slice(1).join(' ').trim();
        if (!text) return c.reply(`Usage: ${PREFIX}rules set <rules text>\nTip: use new lines in your message for a list.`);
        setGroupCfg(c.sessionId, c.jid, { rules: text.slice(0, 1500) });
        return c.reply('✅ Group rules saved. Everyone can read them with ' + PREFIX + 'rules');
      }
      if ((c.args[0] || '').toLowerCase() === 'reset') {
        const g = await adminGuard(c, { botAdmin: false });
        if (!g) return;
        setGroupCfg(c.sessionId, c.jid, { rules: '' });
        return c.reply('✅ Group rules cleared.');
      }
      const rules = getGroupCfg(c.sessionId, c.jid).rules;
      return c.reply(rules ? `📜 *GROUP RULES*\n\n${rules}` : `📜 No rules set yet.\nAdmins: ${PREFIX}rules set <text>`);
    },
  },
  {
    name: 'warnlist', aliases: ['warnings'],
    async run(c) {
      const g = await adminGuard(c, { botAdmin: false });
      if (!g) return;
      const warns = getGroupCfg(c.sessionId, c.jid).warns || {};
      const entries = Object.entries(warns).filter(([, n]) => n > 0);
      if (!entries.length) return c.reply('✅ Nobody has any warnings in this group.');
      const mentions = entries.map(([num]) => `${num}@s.whatsapp.net`);
      const lines = entries.map(([num, n], i) => `${i + 1}. @${num} — ${n}/3`);
      return say(c.sock, c.jid, `⚠️ *Warnings*\n\n${lines.join('\n')}`, c.msg, { mentions });
    },
  },
  {
    name: 'tagadmins', aliases: ['calladmin', 'report'],
    async run(c) {
      if (!(await onlyGroup(c))) return;
      const meta = await c.sock.groupMetadata(c.jid);
      const admins = meta.participants.filter((p) => p.admin).map((p) => p.id);
      const note = c.args.join(' ').trim() || 'Admins, you are needed here!';
      return say(c.sock, c.jid, `🚨 *${note}*\n\n${admins.map((id) => `• ${tag(id)}`).join('\n')}`, c.msg, { mentions: admins });
    },
  },
  {
    name: 'poll',
    async run(c) {
      const parts = c.args.join(' ').split('|').map((s) => s.trim()).filter(Boolean);
      if (parts.length < 3) return c.reply(`📊 Usage: ${PREFIX}poll Question | Option 1 | Option 2 | Option 3\nExample: ${PREFIX}poll Best snack? | Pizza | Burger | Rice`);
      const [name, ...values] = parts;
      return c.sock.sendMessage(c.jid, { poll: { name: name.slice(0, 200), values: values.slice(0, 12).map((v) => v.slice(0, 100)), selectableCount: 1 } }, { quoted: c.msg });
    },
  },
  {
    name: 'lockinfo', aliases: ['unlockinfo'],
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      const lock = c.command === 'lockinfo';
      await c.sock.groupSettingUpdate(c.jid, lock ? 'locked' : 'unlocked');
      return c.reply(lock ? '🔒 Only admins can now edit the group name, picture and description.' : '🔓 All members can now edit the group info.');
    },
  },
  {
    name: 'ephemeral', aliases: ['disappear'],
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      const sub = (c.args[0] || '').toLowerCase();
      if (!(sub in EPHEMERAL)) return c.reply(`⏳ Usage: ${PREFIX}ephemeral off | 24h | 7d | 90d`);
      await c.sock.groupToggleEphemeral(c.jid, EPHEMERAL[sub]);
      return c.reply(sub === 'off' ? '✅ Disappearing messages turned off.' : `✅ Disappearing messages set to ${sub}.`);
    },
  },
  {
    name: 'requests', aliases: ['joinrequests'],
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      let list;
      try { list = await c.sock.groupRequestParticipantsList(c.jid); }
      catch (err) { return c.reply(`❌ Could not read the join requests: ${err?.message || err}`); }
      if (!list?.length) return c.reply('✅ No pending join requests.');
      const ids = list.map((r) => r.jid || r.id).filter(Boolean);
      return say(c.sock, c.jid, `📥 *Pending join requests (${ids.length})*\n\n${ids.slice(0, 40).map((id, i) => `${i + 1}. ${tag(id)}`).join('\n')}\n\n${PREFIX}approveall · ${PREFIX}rejectall`, c.msg, { mentions: ids.slice(0, 40) });
    },
  },
  {
    name: 'approveall', aliases: ['rejectall'],
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      const approve = c.command === 'approveall';
      try {
        const list = await c.sock.groupRequestParticipantsList(c.jid);
        const ids = (list || []).map((r) => r.jid || r.id).filter(Boolean);
        if (!ids.length) return c.reply('✅ No pending join requests.');
        await c.sock.groupRequestParticipantsUpdate(c.jid, ids, approve ? 'approve' : 'reject');
        return c.reply(`${approve ? '✅ Approved' : '🚫 Rejected'} ${ids.length} join request(s).`);
      } catch (err) { return c.reply(`❌ Failed: ${err?.message || err}`); }
    },
  },
  {
    name: 'setgpp', aliases: ['setgrouppic'],
    async run(c) {
      const g = await adminGuard(c, { botAdmin: false });
      if (!g) return;
      const ctx = unwrapMessage(c.msg.message).extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
      let target = null;
      if (quoted?.imageMessage) target = { key: { remoteJid: c.jid, id: ctx.stanzaId, participant: ctx.participant }, message: quoted };
      else if (unwrapMessage(c.msg.message).imageMessage) target = c.msg;
      if (!target) return c.reply(`🖼️ Reply to an image with ${PREFIX}setgpp to set it as the group picture.`);
      try {
        const buf = await downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: c.sock.updateMediaMessage });
        await c.sock.updateProfilePicture(c.jid, buf);
        return c.reply('✅ Group picture updated.');
      } catch (err) { console.error('setgpp error:', err?.message || err); return c.reply('❌ Could not update the group picture. Make sure I am an admin.'); }
    },
  },
];
