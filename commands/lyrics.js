// .lyrics <song name>   or   .lyrics <artist> - <title>
// Sinhala songs: Mathaka (https://mathaka.org, open Sinhala lyrics archive, ODbL licence, no key needed).
// Other songs:   lyrics.ovh (free, no key). Sinhala letters in the query go to Mathaka first; anything not found there
//                (or on lyrics.ovh) is tried on the other service.
// Optional env: LYRICS_MAX_CHARS (default 3500, longer lyrics are cut), LYRICS_API (lyrics.ovh address),
//               MATHAKA_API (default https://mathaka.org/api).
// Note: lyrics are copyrighted. Keep the length limit and use this for personal / small-community use.
import crypto from 'node:crypto';
import { PREFIX } from '../lib/config.js';

const OVH = () => (process.env.LYRICS_API || 'https://api.lyrics.ovh').replace(/\/+$/, '');
const MATHAKA = () => (process.env.MATHAKA_API || 'https://mathaka.org/api').replace(/\/+$/, '');
const MAX_CHARS = () => Math.max(500, Number(process.env.LYRICS_MAX_CHARS || 3500));
const COOLDOWN_MS = 6000;
const TIMEOUT_MS = 15000;
const SINHALA = /[඀-෿]/;
const lastUse = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of lastUse) if (now - t > 60e3) lastUse.delete(k);
}, 5 * 60e3).unref();

async function http(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { accept: 'application/json', ...(opts.headers || {}) } });
    if (res.status === 404) return null;
    if (!res.ok) { const e = new Error(`HTTP ${res.status} from ${new URL(url).host}`); e.status = res.status; throw e; }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- lyrics.ovh ---------- */
async function ovhFind(query) {
  const m = query.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  let artist, title;
  if (m) { artist = m[1].trim(); title = m[2].trim(); }
  else {
    const data = await http(`${OVH()}/suggest/${encodeURIComponent(query)}`);
    const hit = data?.data?.find((x) => x?.artist?.name && x?.title);
    if (!hit) return null;
    artist = hit.artist.name; title = hit.title_short || hit.title;
  }
  const data = await http(`${OVH()}/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
  const lyrics = String(data?.lyrics || '').trim();
  return lyrics ? { title, artist, lyrics, source: 'lyrics.ovh' } : null;
}

/* ---------- Mathaka (Sinhala) ---------- */
// Mathaka asks for a small proof-of-work token instead of an API key (about 1M hashes, under a second).
let token = null; // { value, until }

async function solve(prefix, targetHex) {
  const target = Buffer.from(targetHex.padStart(64, '0'), 'hex');
  for (let nonce = 0; ; nonce++) {
    const digest = crypto.createHash('sha256').update(prefix + nonce).digest();
    if (Buffer.compare(digest, target) <= 0) return `${prefix}:${nonce}`;
    if (nonce % 50000 === 49999) await new Promise((r) => setImmediate(r)); // let other chats run meanwhile
  }
}

async function getToken() {
  if (token && Date.now() < token.until) return token.value;
  const ch = await http(`${MATHAKA()}/request-challenge`, { method: 'POST' });
  if (!ch?.prefix || !ch?.target) throw new Error('Mathaka: bad challenge');
  const value = await solve(String(ch.prefix), String(ch.target));
  token = { value, until: Math.min(Date.now() + 4 * 60e3, Number(ch.expiresAt) || Infinity) };
  return value;
}

async function mathakaGet(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const value = await getToken();
    try { return await http(`${MATHAKA()}${path}`, { headers: { authorization: `Bearer ${value}` } }); }
    catch (err) { if (err.status === 401 || err.status === 403) { token = null; continue; } throw err; }
  }
  throw new Error('Mathaka: token rejected');
}

async function mathakaFind(query) {
  const found = await mathakaGet(`/search?q=${encodeURIComponent(query)}&limit=5`);
  const songs = (found?.songs || []).filter((s) => s?.id);
  if (!songs.length) return null;
  const song = await mathakaGet(`/songs/${encodeURIComponent(songs[0].id)}`);
  const lyrics = String(song?.lyrics || '').trim();
  if (!lyrics) return null;
  const singers = (song.singers || []).map((x) => x.name_si || x.name).filter(Boolean).join(', ');
  return {
    title: song.name_si || song.name || songs[0].name_si || songs[0].name,
    artist: singers || songs[0].artist_names_si || songs[0].artist_names || '',
    lyrics,
    source: 'Mathaka (mathaka.org)',
    others: songs.slice(1, 4).map((s) => `${s.name_si || s.name}${s.artist_names_si || s.artist_names ? ` - ${s.artist_names_si || s.artist_names}` : ''}`),
  };
}

async function search(query) {
  const order = SINHALA.test(query) ? [mathakaFind, ovhFind] : [ovhFind, mathakaFind];
  let firstError;
  for (const fn of order) {
    try { const hit = await fn(query); if (hit) return hit; }
    catch (err) { firstError ??= err; console.error('.lyrics source error:', err?.message || err); }
  }
  if (firstError) throw firstError; // nothing found AND a source failed: report the failure, not "not found"
  return null;
}

export default [
  {
    name: 'lyrics',
    aliases: ['lyric', 'lrc'],
    react: '🎤',
    async run({ jid, msg, sessionId, args, reply }) {
      const query = (args || []).join(' ').trim().slice(0, 150);
      if (!query) return reply(`🎤 Send a song name (Sinhala හෝ English).\nExample: *${PREFIX}lyrics shape of you*\nExample: *${PREFIX}lyrics පහන තියා මුදු සැදුවා*\nOr: *${PREFIX}lyrics ed sheeran - shape of you*`);

      const key = `${sessionId}:${msg?.key?.participant || msg?.key?.remoteJid || jid}`;
      const now = Date.now();
      if (now - (lastUse.get(key) || 0) < COOLDOWN_MS) return reply('⏳ ටිකක් ඉන්න, ආයෙ try කරන්න.');
      lastUse.set(key, now);

      try {
        const hit = await search(query);
        if (!hit) return reply(`😕 "${query}" හොයාගන්න බැරි වුණා.\nගීතයේ නම වෙනස් විදිහකට ලියලා බලන්න, නැත්නම් *${PREFIX}lyrics artist - song name* කියලා try කරන්න.`);

        let text = hit.lyrics.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
        const max = MAX_CHARS();
        const cut = text.length > max;
        if (cut) text = text.slice(0, max).replace(/\n[^\n]*$/, '').trim() + '\n…';
        const more = hit.others?.length ? `\n\n🔎 වෙනත් ප්‍රතිඵල:\n${hit.others.map((o) => `• ${o}`).join('\n')}` : '';
        return reply(`🎤 *${hit.title}*${hit.artist ? `\n👤 ${hit.artist}` : ''}\n\n${text}${cut ? '\n\n_(Lyrics are shortened)_' : ''}\n\n_Source: ${hit.source}_${more}`);
      } catch (err) {
        console.error('.lyrics error:', err?.message || err);
        return reply('😕 දැන් lyrics ගන්න බැරි වුණා, ටිකකින් ආයෙ try කරන්න.');
      }
    },
  },
];
