// .addmeta: tries to add Meta AI (WhatsApp's own AI account) to this group. Group admins only, and the bot must be a group admin.
import { PREFIX, jidNum } from '../lib/config.js';
import { adminGuard } from '../lib/groups.js';
import { say } from '../lib/card.js';

const META_AI = '13135550002@s.whatsapp.net';
const HOW = `Members can now ask it by typing *@Meta AI* and then their question.`;

export default [
  {
    name: 'addmeta', aliases: ['metaai'],
    async run(c) {
      const g = await adminGuard(c); // group only, sender must be a group admin, the bot must be a group admin
      if (!g) return;
      if (g.meta.participants.some((p) => [p.id, p.lid, p.jid].some((x) => x && jidNum(x) === jidNum(META_AI)))) {
        return c.reply(`🤖 Meta AI is already in this group.\n\n${HOW}`);
      }
      try {
        const res = await c.sock.groupParticipantsUpdate(c.jid, [META_AI], 'add');
        const status = String(res?.[0]?.status || '200');
        if (status === '200') return say(c.sock, c.jid, `🤖 *Meta AI* added to the group.\n\n${HOW}`, c.msg);
        const why = status === '403' ? 'its privacy settings do not allow being added' : status === '408' ? 'it recently left the group' : status === '409' ? 'it is already in the group' : status === '404' ? 'WhatsApp does not allow adding it as a member' : `WhatsApp refused (code ${status})`;
        return c.reply(`❌ Could not add Meta AI: ${why}.\n\nTip: WhatsApp's Meta AI is not a normal member. If it is available in your country, type *@Meta AI* and a question right in the chat.`);
      } catch (err) {
        return c.reply(`❌ Could not add Meta AI: ${err?.message || err}\n\nTip: type *@Meta AI* and a question right in the chat if it is available in your country.`);
      }
    },
  },
];
