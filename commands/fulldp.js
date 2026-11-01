// .fulldp: set the bot account's profile picture with the picture EXACTLY as it is: same size, no resize, no crop, no blur, no background layer.
// .setpp uses Baileys' updateProfilePicture(), which always shrinks and square-crops the picture to 720x720. Here the original bytes are sent
// to WhatsApp directly, so the newer WhatsApp versions show the DP in its original width / height when someone opens it
// (only the small round thumbnail is square).
// Tip: send the picture as a DOCUMENT (File) so WhatsApp does not compress it before the bot gets it, then reply to it with .fulldp.
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { PREFIX, logger } from '../lib/config.js';
import { resetBotDp } from '../lib/card.js';
import { unwrapMessage } from '../lib/text.js';

const MAX_BYTES = 20 * 1024 * 1024;

// Same request Baileys sends for the own account, but with the original picture bytes.
async function setRawPicture(sock, buf) {
  await sock.query({
    tag: 'iq',
    attrs: { to: '@s.whatsapp.net', type: 'set', xmlns: 'w:profile:picture' },
    content: [{ tag: 'picture', attrs: { type: 'image' }, content: buf }],
  });
}

// image message, or a document that is an image (documents are not compressed by WhatsApp, so they keep the true original)
const pickImage = (m) => {
  if (!m) return null;
  if (m.imageMessage) return { part: m.imageMessage };
  if (m.documentMessage && /^image\//i.test(m.documentMessage.mimetype || '')) return { part: m.documentMessage };
  return null;
};

export default [
  {
    name: 'fulldp', aliases: ['fullpp', 'setfulldp'], owner: true, react: '🖼️',
    async run({ sock, msg, jid, reply }) {
      const ctx = unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
      const found = pickImage(quoted) || pickImage(unwrapMessage(msg.message));
      if (!found) return reply(`🖼️ Reply to a picture with ${PREFIX}fulldp (or send the picture with ${PREFIX}fulldp as the caption).\nIt becomes the profile picture exactly as it is: same size, no crop, no blur.\n\n💡 Send it as a *File / Document* so WhatsApp does not compress it first.`);
      const target = quoted && pickImage(quoted)
        ? { key: { remoteJid: ctx.remoteJid || jid, id: ctx.stanzaId, participant: ctx.participant }, message: quoted }
        : msg;
      let buf;
      try { buf = await downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }); }
      catch (err) { console.error('fulldp download error:', err?.message || err); return reply('❌ Could not open that picture (it may have expired). Send it again.'); }
      if (buf.length > MAX_BYTES) return reply('❌ That picture is too big (over 20 MB).');
      const { width, height } = found.part;
      const dims = width && height ? `${width}x${height}` : 'original size';
      try {
        await setRawPicture(sock, buf);
      } catch (err) {
        // WhatsApp may refuse a format other than JPEG. Re-encode to JPEG at top quality WITHOUT changing the size, then try once more.
        const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
        console.error('fulldp upload error:', err?.message || err);
        if (jpeg) return reply(`❌ WhatsApp did not accept the picture (${(buf.length / 1048576).toFixed(1)} MB). Try a smaller file.`);
        try {
          const sharp = (await import('sharp')).default;
          await setRawPicture(sock, await sharp(buf).rotate().jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer()); // only the format changes, never the size
        } catch (err2) { console.error('fulldp retry error:', err2?.message || err2); return reply('❌ WhatsApp did not accept the picture. Try a JPEG picture.'); }
      }
      resetBotDp(sock); // the reply cards pick up the new DP
      return reply(`✅ Full DP set (${dims}, nothing resized or cropped).\nOpen your profile picture to check it.`);
    },
  },
];
