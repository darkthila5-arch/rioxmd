// .getdp: download someone's profile picture (premium numbers only, `premium: true`).
// Use:  .getdp 94771234567   |   reply to / @mention a person with .getdp   |   .getdp alone in a private chat = that chat's person.
// Sends the picture in the best size WhatsApp gives out (privacy settings of that person can hide it).
import { jidNum } from '../lib/config.js';

async function fetchUrl(sock, jid) {
  for (const type of ['image', 'preview']) {
    try { const url = await sock.profilePictureUrl(jid, type, 10000); if (url) return url; }
    catch (err) { if (type === 'preview') throw err; }
  }
  return null;
}

export default [
  {
    name: 'getdp', aliases: ['getpp', 'dpget', 'stealdp'], premium: true, react: '🖼️',
    async run({ sock, msg, jid, args, targetJid, reply }) {
      const target = targetJid();
      if (!target) return reply('🖼️ Use *.getdp 94771234567*, or reply to / @mention a person with *.getdp*.');
      const num = jidNum(target);
      let url = null;
      try { url = await fetchUrl(sock, target); }
      catch (err) { console.error('getdp error:', err?.message || err); }
      if (!url) return reply(`❌ No profile picture for *${num}*.\nThey have no DP, or their privacy settings hide it from you.`);
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        return await sock.sendMessage(jid, { image: buf, caption: `🖼️ Profile picture of *${num}*` }, { quoted: msg });
      } catch (err) {
        console.error('getdp download error:', err?.message || err);
        return reply('❌ Could not download that picture. Try again.');
      }
    },
  },
];
