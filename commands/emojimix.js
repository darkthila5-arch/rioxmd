// .emojimix 😂+😍   -> one sticker made from two emojis (Google Emoji Kitchen).
// Also works as: .emojimix 😂 😍   or   .emojimix 😂😍
// Not every pair exists in Emoji Kitchen; when one is missing the bot says so.
//
// Images come straight from Google's Emoji Kitchen files (gstatic.com), no API key needed.
// Optional env var: EMOJIMIX_DATES = extra date folders (comma separated, like 20260101) for newly released mixes.
import { BOT_NAME, PREFIX } from '../lib/config.js';
import { DEFAULT_FOOTER, applyBrand } from '../lib/brand.js';
import { imageToSticker } from '../lib/stickers.js';

const BASE = 'https://www.gstatic.com/android/keyboard/emojikitchen';
// Google adds a new dated folder whenever it releases new mixes. Add newer dates here (or in EMOJIMIX_DATES, comma separated) if new emojis do not work.
const DATES = [...new Set([
  ...(process.env.EMOJIMIX_DATES || '').split(/[,\s]+/).filter(Boolean),
  '20201001', '20210218', '20210521', '20210831', '20211115', '20220110', '20220203', '20220406', '20220506', '20220815',
  '20221101', '20230118', '20230301', '20230405', '20230803', '20231115', '20240206', '20240610', '20241015', '20250130',
])];
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
const cache = new Map(); // "a|b" -> png url (or null), so repeated mixes cost nothing
const CACHE_MAX = 500;

// Pull the emojis out of the text (a skin-tone or ZWJ emoji counts as one).
export function parseEmojis(text) {
  const parts = segmenter ? [...segmenter.segment(String(text || ''))].map((s) => s.segment) : Array.from(String(text || ''));
  return parts.filter((g) => /\p{Extended_Pictographic}/u.test(g));
}

// "😂" -> "u1f602", "☺️" -> "u263a-ufe0f" (this is how Google names the folders and files).
export function codeOf(emoji, keepFe0f = true) {
  const cps = Array.from(emoji).map((c) => c.codePointAt(0)).filter((cp) => keepFe0f || cp !== 0xfe0f);
  return cps.map((cp) => `u${cp.toString(16)}`).join('-');
}

// Every address that could hold this pair: both orders, with / without the FE0F variation selector, every date folder.
export function candidateUrls(a, b) {
  const urls = [];
  const names = (e) => [...new Set([codeOf(e, true), codeOf(e, false)])];
  for (const [l, r] of [[a, b], [b, a]]) {
    for (const ln of names(l)) for (const rn of names(r)) for (const d of DATES) urls.push(`${BASE}/${d}/${ln}/${ln}_${rn}.png`);
  }
  return urls;
}

async function exists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch { return false; }
}

// Checks the candidates a few at a time and returns the first address that exists.
async function findMixUrl(a, b) {
  const key = `${a}|${b}`;
  if (cache.has(key)) return cache.get(key);
  const urls = candidateUrls(a, b);
  let found = null;
  for (let i = 0; i < urls.length && !found; i += 10) {
    const batch = urls.slice(i, i + 10);
    const hits = await Promise.all(batch.map(async (u) => ((await exists(u)) ? u : null)));
    found = hits.find(Boolean) || null;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, found);
  return found;
}

async function fetchPng(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== 'www.gstatic.com') throw new Error('bad url');
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
        const url = await findMixUrl(a, b); // checks both orders
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
