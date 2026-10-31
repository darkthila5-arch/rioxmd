// .emojimix 😂+😍   -> one sticker made from two emojis (Google Emoji Kitchen via Tenor).
// Also works as: .emojimix 😂 😍   or   .emojimix 😂😍
// Not every pair exists in Emoji Kitchen; when one is missing the bot says so.
//
// Optional env var: EMOJIMIX_KEY = your own Tenor / Google API key (the built-in one is Google's public Emoji Kitchen demo key).
import { BOT_NAME, PREFIX } from '../lib/config.js';
import { DEFAULT_FOOTER, applyBrand } from '../lib/brand.js';
import { imageToSticker } from '../lib/stickers.js';

const TENOR_KEY = (process.env.EMOJIMIX_KEY || 'AIzaSyACvEq5cnT7AGpEvRcZ6MZRz_ktdgwXvrs').trim();
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

// Pull the emojis out of the text (a flag or a skin-tone emoji counts as one).
export function parseEmojis(text) {
  const parts = segmenter ? [...segmenter.segment(String(text || ''))].map((s) => s.segment) : Array.from(String(text || ''));
  return parts.filter((g) => /\p{Extended_Pictographic}/u.test(g));
}

async function fetchMixUrl(a, b) {
  const q = encodeURIComponent(`${a}_${b}`);
  const url = `https://tenor.googleapis.com/v2/featured?key=${TENOR_KEY}&client_key=emoji_kitchen_funbox&contentfilter=high&media_filter=png_transparent&component=proactive&collection=emoji_kitchen_v6&q=${q}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`tenor ${res.status}`);
  const data = await res.json();
  return data?.results?.[0]?.media_formats?.png_transparent?.url || data?.results?.[0]?.url || null;
}

async function fetchPng(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('bad url');
  const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_PNG_BYTES) throw new Error('image too big');
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_PNG_BYTES) throw new Error('image too big');
  return buf;
}

export default [
  {
    name: 'emojimix', aliases: ['emix', 'mixemoji'], react: '😎',
    async run({ sock, msg, jid, args, reply }) {
      const emojis = parseEmojis(Array.isArray(args) ? args.join(' ') : args);
      if (emojis.length !== 2) {
        return reply(`😎 *Emoji Mix*\nMix two emojis into one sticker.\n\nExample: ${PREFIX}emojimix 😂+😍\nSend exactly 2 emojis.`);
      }
      const [a, b] = emojis;
      try {
        let url = await fetchMixUrl(a, b);
        if (!url) url = await fetchMixUrl(b, a); // some pairs only exist the other way round
        if (!url) return reply(`😕 No mix exists for ${a} + ${b}. Try other emojis.`);
        const png = await fetchPng(url);
        const webp = await imageToSticker(png, { name: applyBrand(sock, BOT_NAME), author: applyBrand(sock, DEFAULT_FOOTER) });
        return sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
      } catch (err) {
        console.error('emojimix error:', err?.message || err);
        return reply('❌ Could not make that mix right now. Try again in a moment.');
      }
    },
  },
];
