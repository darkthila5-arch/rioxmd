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
      // Try in order, stop at the first one WhatsApp accepts:
      // 1) original bytes  2) clean JPEG, same size (fixes progressive / CMYK / odd JPEGs)  3) square canvas, whole picture kept (no crop)  4) Baileys' normal 720x720 DP
      let mode = 'exact';
      const attempts = [
        ['exact', async () => setRawPicture(sock, buf)],
        ['jpeg', async () => {
          const sharp = (await import('sharp')).default;
          await setRawPicture(sock, await sharp(buf).rotate().toColorspace('srgb').jpeg({ quality: 95, chromaSubsampling: '4:4:4', progressive: false }).toBuffer());
        }],
        ['square', async () => {
          const sharp = (await import('sharp')).default;
          const img = sharp(buf).rotate();
          const m = await img.metadata();
          const side = Math.max(m.width || 0, m.height || 0);
          if (!side) throw new Error('unknown size');
          const bg = await sharp(buf).rotate().resize(side, side, { fit: 'cover' }).blur(40).toBuffer();
          const out = await sharp(bg).composite([{ input: await img.toBuffer(), gravity: 'centre' }]).toColorspace('srgb').jpeg({ quality: 95 }).toBuffer();
          await setRawPicture(sock, out);
        }],
        ['standard', async () => {
          const sharp = (await import('sharp')).default;
          const out = await sharp(buf).rotate().resize(720, 720, { fit: 'cover' }).jpeg({ quality: 95 }).toBuffer();
          await sock.updateProfilePicture(sock.user.id, out);
        }],
      ];
      let ok = false, lastErr;
      for (const [name, fn] of attempts) {
        try { await fn(); ok = true; mode = name; break; }
        catch (err) { lastErr = err; console.error(`fulldp ${name} failed:`, err?.message || err); }
      }
      if (!ok) return reply(`❌ WhatsApp did not accept the picture (${(buf.length / 1048576).toFixed(1)} MB, ${dims}).\nReason: ${String(lastErr?.message || lastErr).slice(0, 80)}`);
      resetBotDp(sock); // the reply cards pick up the new DP
      const note = { exact: 'nothing resized or cropped', jpeg: 'same size, re-saved as clean JPEG', square: 'whole picture kept on a square background', standard: 'WhatsApp would not take the full size, so a normal 720x720 DP was set' }[mode];
      return reply(`✅ DP set (${dims}: ${note}).\nOpen your profile picture to check it.`);
    },
  },
];
