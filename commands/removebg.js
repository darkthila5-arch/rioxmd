// .removebg: remove the background of a photo. 👑 Premium only (`premium: true`).
// Needs a remove.bg API key in the environment:  REMOVEBG_API_KEY=xxxx   (free plan: about 50 previews a month)
// Use:  reply to a photo with .removebg   |   send a photo with .removebg as its caption
// The result is sent as a PNG *file* so the transparent background is kept (WhatsApp photos would turn it white).
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { BOT_NAME, PREFIX, logger } from '../lib/config.js';
import { unwrapMessage } from '../lib/text.js';

const KEY = (process.env.REMOVEBG_API_KEY || '').trim();
const MAX_IN = 10 * 1024 * 1024;
const GAP_MS = 15 * 1000;
const last = new Map();

export default [
  {
    name: 'removebg', aliases: ['rmbg', 'nobg', 'bgremove'], premium: true, react: '✂️',
    async run({ sock, msg, jid, sessionId, reply }) {
      const own = unwrapMessage(msg.message);
      const ctx = own.extendedTextMessage?.contextInfo || own.imageMessage?.contextInfo;
      const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
      let target = null;
      if (quoted?.imageMessage) target = { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: quoted };
      else if (own.imageMessage) target = msg;
      if (!target) return reply(`✂️ Reply to a photo with *${PREFIX}removebg*, or send a photo with *${PREFIX}removebg* as the caption.`);
      if (!KEY) return reply('⚠️ Background removal is not set up yet. The owner must add REMOVEBG_API_KEY (from remove.bg) to the server settings.');
      const wait = GAP_MS - (Date.now() - (last.get(sessionId) || 0));
      if (wait > 0) return reply(`⏳ Please wait ${Math.ceil(wait / 1000)}s before the next photo.`);
      last.set(sessionId, Date.now());
      try {
        const input = await downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        if (input.length > MAX_IN) { last.delete(sessionId); return reply('❌ That photo is too big (max 10 MB).'); }
        await reply('✂️ Removing the background...');
        const form = new FormData();
        form.append('image_file', new Blob([input], { type: 'image/jpeg' }), 'photo.jpg');
        form.append('size', 'auto');
        const res = await fetch('https://api.remove.bg/v1.0/removebg', { method: 'POST', headers: { 'X-Api-Key': KEY }, body: form, signal: AbortSignal.timeout(60000) });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.error('removebg API error:', res.status, body.slice(0, 200));
          last.delete(sessionId);
          if (res.status === 402 || res.status === 403) return reply('❌ The background remover has run out of credits. Tell the bot owner.');
          return reply('❌ Could not remove the background. Use a photo with a clear person or object.');
        }
        const png = Buffer.from(await res.arrayBuffer());
        return await sock.sendMessage(jid, { document: png, mimetype: 'image/png', fileName: 'no-background.png', caption: `✂️ Background removed\n_${BOT_NAME}_` }, { quoted: msg });
      } catch (err) {
        console.error('removebg error:', err?.message || err);
        last.delete(sessionId);
        return reply('❌ Something went wrong. Try again.');
      }
    },
  },
];
