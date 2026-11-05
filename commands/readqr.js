// .readqr   (aliases .scanqr .qrread .decodeqr)   QR code in a photo -> the text / link inside it.
// Reply to a photo with .readqr, or send the photo with .readqr as the caption.
// Needs the npm package "jsqr" (pure JavaScript) and "sharp" (already used by the bot). Run `npm install` after updating.
// The content is only SHOWN, never opened: a link inside a QR code can be a scam, so check it before you tap it.
import { PREFIX } from '../lib/config.js';
import { MAX_INPUT_BYTES, downloadMedia, findMedia } from '../lib/mediatools.js';

const COOLDOWN_MS = 5000;
const MAX_SHOWN = 3000;
const lastUse = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of lastUse) if (t - v > 60e3) lastUse.delete(k); }, 5 * 60e3).unref();

// Several tries, because a QR in a real photo is often small, dark or low contrast.
const ATTEMPTS = [
  { size: 1200, grey: false },
  { size: 700, grey: false },
  { size: 1600, grey: true },
];

// jsqr needs RGBA (4 bytes per pixel). sharp can return 1, 2, 3 or 4 channels (for example after greyscale), so always expand to RGBA here.
export function toRgba(data, width, height, channels) {
  const px = width * height;
  if (channels === 4 && data.length === px * 4) return new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  if (![1, 2, 3, 4].includes(channels) || data.length < px * channels) throw new Error(`unexpected pixel data (${channels} channels)`);
  const out = new Uint8ClampedArray(px * 4);
  for (let i = 0; i < px; i++) {
    const o = i * channels;
    const r = data[o], g = channels >= 3 ? data[o + 1] : r, b = channels >= 3 ? data[o + 2] : r;
    const a = channels === 2 ? data[o + 1] : channels === 4 ? data[o + 3] : 255;
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
  }
  return out;
}

async function pixels(sharp, input, { size, grey }) {
  let img = sharp(input, { failOn: 'none', limitInputPixels: 80e6 }).rotate().flatten({ background: '#ffffff' });
  img = img.resize(size, size, { fit: 'inside', withoutEnlargement: false });
  if (grey) img = img.greyscale().normalise().sharpen();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data: toRgba(data, info.width, info.height, info.channels), width: info.width, height: info.height };
}

// photo (Buffer) -> decoded text, or '' when there is no readable QR. `decode` can be replaced in tests.
export async function readQr(input, decode) {
  let sharp;
  try { sharp = (await import('sharp')).default; } catch { throw Object.assign(new Error('sharp is not installed'), { missing: 'sharp' }); }
  if (!decode) {
    try { decode = (await import('jsqr')).default; } catch { throw Object.assign(new Error('jsqr is not installed'), { missing: 'jsqr' }); }
  }
  let sawImage = false;
  for (const attempt of ATTEMPTS) {
    let px;
    try { px = await pixels(sharp, input, attempt); } catch { continue; }
    sawImage = true;
    const hit = decode(px.data, px.width, px.height, { inversionAttempts: 'attemptBoth' });
    if (hit && typeof hit.data === 'string' && hit.data) return hit.data;
  }
  if (!sawImage) throw Object.assign(new Error('bad image'), { badImage: true });
  return '';
}

// A short label so people can see what kind of QR it is.
export function qrKind(text) {
  const t = text.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return '🔗 Link';
  if (/^WIFI:/i.test(t)) return '📶 Wi-Fi';
  if (/^mailto:/i.test(t)) return '📧 Email';
  if (/^(tel|sms|smsto):/i.test(t)) return '📞 Phone';
  if (/^BEGIN:VCARD/i.test(t)) return '👤 Contact';
  if (/^geo:/i.test(t)) return '📍 Location';
  return '📝 Text';
}

export function qrReplyText(text) {
  const shown = text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}\n…` : text;
  const lines = [`🔳 *QR code read* (${qrKind(text)})`, '', shown];
  if (/^https?:\/\//i.test(text.trim())) lines.push('', '⚠️ I did not open this link. Check it before you tap it.');
  return lines.join('\n');
}

const sizeOf = (part) => (typeof part?.fileLength?.toNumber === 'function' ? part.fileLength.toNumber() : Number(part?.fileLength || 0));

export default [
  {
    name: 'readqr', aliases: ['scanqr', 'qrread', 'decodeqr'], react: '🔳',
    async run({ sock, msg, jid, sessionId, reply }) {
      const usage = `🔳 *Read a QR code*\n\nReply to a photo that has a QR code with ${PREFIX}readqr (or send the photo with ${PREFIX}readqr as the caption).\nTo make a QR code use ${PREFIX}qr <text>.`;
      const media = findMedia(msg, jid);
      if (!media) return reply(usage);
      if (media.kind !== 'image') return reply(`🖼️ ${PREFIX}readqr works with photos only.\n\n${usage}`);
      if (sizeOf(media.part) > MAX_INPUT_BYTES) return reply('❌ That picture is too big.');
      const key = `${sessionId}|${jid}|${msg.key?.fromMe ? 'me' : (msg.key?.participant || '')}`;
      if (Date.now() - (lastUse.get(key) || 0) < COOLDOWN_MS) return reply('⏳ One at a time please. Try again in a few seconds.');
      lastUse.set(key, Date.now());
      try {
        const input = await downloadMedia(sock, media);
        const text = await readQr(input);
        if (!text) return await reply('🔍 I could not find a QR code in that picture. Try a clearer, closer photo with the whole code in view.');
        return await reply(qrReplyText(text));
      } catch (err) {
        console.error('readqr error:', err?.message || err);
        if (err?.missing) return reply('❌ The QR reader is not installed on the server (the host must run npm install).');
        if (err?.download) return reply('❌ Could not download that picture. Forward it again and reply to the new one.');
        if (err?.tooBig) return reply('❌ That picture is too big.');
        if (err?.badImage) return reply('❌ I could not read that picture. Try another one.');
        return reply('❌ Could not read that QR code. Try another picture.');
      }
    }
  }
];
