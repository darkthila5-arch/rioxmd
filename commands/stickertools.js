// Sticker converters.
//   .tosticker   photo            -> sticker
//   .toasticker  video / gif      -> animated sticker
//   .toimg       sticker          -> photo
//   .tovideo     animated sticker -> video
// Use them by replying to the media, or send the media with the command as its caption.
// Every sticker gets the bot name as its pack name and the footer as its publisher (premium branding is respected).
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { BOT_NAME, PREFIX, logger } from '../lib/config.js';
import { DEFAULT_FOOTER, applyBrand } from '../lib/brand.js';
import { unwrapMessage } from '../lib/text.js';
import { MAX_ANIM_SECONDS, MAX_INPUT_BYTES, imageToSticker, stickerToMp4, stickerToPng, videoToSticker, webpInfo } from '../lib/stickers.js';

// The media this command works on: the message itself (media + caption) or the message that was replied to.
function findMedia(msg, jid) {
  const own = unwrapMessage(msg.message);
  const ownPart = own.imageMessage || own.videoMessage || own.stickerMessage;
  if (ownPart) {
    const kind = own.imageMessage ? 'image' : own.videoMessage ? 'video' : 'sticker';
    return { kind, part: ownPart, target: msg };
  }
  const ctx = own.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
  if (!quoted) return null;
  const part = quoted.imageMessage || quoted.videoMessage || quoted.stickerMessage;
  if (!part) return null;
  const kind = quoted.imageMessage ? 'image' : quoted.videoMessage ? 'video' : 'sticker';
  return { kind, part, target: { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: quoted } };
}

const stickerMeta = (sock) => ({ name: applyBrand(sock, BOT_NAME), author: applyBrand(sock, DEFAULT_FOOTER) });

function failText(err) {
  const m = String(err?.message || err);
  if (err?.missing === 'ffmpeg' || /ffmpeg is not installed/.test(m)) return '❌ ffmpeg is not installed on the server, so this command cannot work.';
  if (err?.missing === 'anim_dump') return '❌ The server is missing the *webp* package (anim_dump), needed to turn animated stickers into video.';
  if (err?.tooBig) return `❌ The animated sticker came out bigger than WhatsApp allows (1 MB). Try a shorter or simpler video (up to ${MAX_ANIM_SECONDS} seconds is used).`;
  if (err?.tooLong) return '❌ That animated sticker has too many frames to convert.';
  return '❌ Could not convert that file. Try another one.';
}

// One helper for all four commands.
//   accept: which kind of media this command takes; hint: what to say for the wrong kind.
function converter({ name, aliases = [], react, accept, usage, wrong, busy, work }) {
  return {
    name, aliases, react,
    async run({ sock, msg, jid, reply }) {
      const media = findMedia(msg, jid);
      if (!media) return reply(usage);
      if (media.kind !== accept) return reply(wrong[media.kind] || usage);
      if (Number(media.part.fileLength || 0) > MAX_INPUT_BYTES) return reply(`❌ That file is bigger than ${Math.round(MAX_INPUT_BYTES / 1048576)} MB.`);
      let input;
      try {
        input = await downloadMediaMessage(media.target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      } catch (err) { console.error(`${name} download error:`, err?.message || err); return reply('❌ Could not download that file. Forward it again and reply to the new one.'); }
      if (!input?.length || input.length > MAX_INPUT_BYTES) return reply(`❌ That file is bigger than ${Math.round(MAX_INPUT_BYTES / 1048576)} MB.`);
      const check = await work.precheck?.(input, media);
      if (check) return reply(check);
      if (busy) reply(busy).catch(() => {});
      try {
        return await work.send({ sock, jid, msg, input, media });
      } catch (err) {
        console.error(`${name} error:`, err?.message || err);
        return reply(failText(err));
      }
    },
  };
}

export default [
  converter({
    name: 'tosticker', react: '🎨', accept: 'image',
    usage: `🎨 *Photo → Sticker*\nReply to a photo with ${PREFIX}tosticker (or send the photo with ${PREFIX}tosticker as the caption).\nFor a video / GIF use ${PREFIX}toasticker.`,
    wrong: {
      video: `🎞️ That is a video. Use ${PREFIX}toasticker to make an animated sticker.`,
      sticker: `That is already a sticker. Use ${PREFIX}toimg to turn it into a photo.`,
    },
    work: {
      async send({ sock, jid, msg, input }) {
        const webp = await imageToSticker(input, stickerMeta(sock));
        return sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
      },
    },
  }),
  converter({
    name: 'toasticker', aliases: ['toanimsticker'], react: '🎞️', accept: 'video',
    usage: `🎞️ *Video / GIF → Animated sticker*\nReply to a video or GIF with ${PREFIX}toasticker (or send it with ${PREFIX}toasticker as the caption).\nOnly the first ${MAX_ANIM_SECONDS} seconds are used.\nFor a photo use ${PREFIX}tosticker.`,
    wrong: {
      image: `🖼️ That is a photo. Use ${PREFIX}tosticker to make a sticker.`,
      sticker: `That is already a sticker. Use ${PREFIX}tovideo (animated) or ${PREFIX}toimg (still) to convert it.`,
    },
    busy: '⏳ Making your animated sticker…',
    work: {
      async send({ sock, jid, msg, input }) {
        const webp = await videoToSticker(input, stickerMeta(sock));
        return sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
      },
    },
  }),
  converter({
    name: 'toimg', aliases: ['toimage'], react: '🖼️', accept: 'sticker',
    usage: `🖼️ *Sticker → Photo*\nReply to a sticker with ${PREFIX}toimg.\nFor an animated sticker use ${PREFIX}tovideo.`,
    wrong: {
      image: `That is already a photo. Use ${PREFIX}tosticker to make a sticker.`,
      video: `🎞️ That is a video. Use ${PREFIX}toasticker to make an animated sticker.`,
    },
    work: {
      precheck(input) {
        try { if (webpInfo(input).animated) return `🎞️ That sticker is animated. Use ${PREFIX}tovideo to get a video (${PREFIX}toimg is for still stickers).`; }
        catch { return '❌ That does not look like a sticker file.'; }
        return null;
      },
      async send({ sock, jid, msg, input }) {
        const png = await stickerToPng(input);
        return sock.sendMessage(jid, { image: png, caption: `🖼️ Sticker → Photo\n*${BOT_NAME}*` }, { quoted: msg });
      },
    },
  }),
  converter({
    name: 'tovideo', aliases: ['tomp4'], react: '🎬', accept: 'sticker',
    usage: `🎬 *Animated sticker → Video*\nReply to an animated sticker with ${PREFIX}tovideo.\nFor a still sticker use ${PREFIX}toimg.`,
    wrong: {
      image: `That is a photo. Use ${PREFIX}tosticker to make a sticker.`,
      video: `That is already a video. Use ${PREFIX}toasticker to make an animated sticker.`,
    },
    busy: '⏳ Converting to video…',
    work: {
      precheck(input) {
        try { if (!webpInfo(input).animated) return `🖼️ That sticker is not animated. Use ${PREFIX}toimg to get a photo.`; }
        catch { return '❌ That does not look like a sticker file.'; }
        return null;
      },
      async send({ sock, jid, msg, input }) {
        const mp4 = await stickerToMp4(input);
        return sock.sendMessage(jid, { video: mp4, mimetype: 'video/mp4', caption: `🎬 Sticker → Video\n*${BOT_NAME}*` }, { quoted: msg });
      },
    },
  }),
];
