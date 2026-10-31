// .lyrics <song name>   or   .lyrics <artist> - <title>
// Finds a song with the free lyrics.ovh API (no key needed) and sends its lyrics.
// Optional env: LYRICS_MAX_CHARS (default 3500, longer lyrics are cut), LYRICS_API (default https://api.lyrics.ovh).
// Note: lyrics are copyrighted. Keep the length limit, and use this only for personal / small-community use.
import { PREFIX } from '../lib/config.js';

const API = () => (process.env.LYRICS_API || 'https://api.lyrics.ovh').replace(/\/+$/, '');
const MAX_CHARS = () => Math.max(500, Number(process.env.LYRICS_MAX_CHARS || 3500));
const COOLDOWN_MS = 6000;
const TIMEOUT_MS = 15000;
const lastUse = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of lastUse) if (now - t > 60e3) lastUse.delete(k);
}, 5 * 60e3).unref();

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`lyrics API ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// "artist - title" -> exact lookup; anything else -> search first.
async function findSong(query) {
  const m = query.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  const data = await getJson(`${API()}/suggest/${encodeURIComponent(query)}`);
  const hit = data?.data?.find((x) => x?.artist?.name && x?.title);
  return hit ? { artist: hit.artist.name, title: hit.title_short || hit.title } : null;
}

export default [
  {
    name: 'lyrics',
    aliases: ['lyric', 'lrc'],
    react: '🎤',
    async run({ jid, msg, sessionId, args, reply }) {
      const query = (args || []).join(' ').trim().slice(0, 150);
      if (!query) return reply(`🎤 Send a song name.\nExample: *${PREFIX}lyrics shape of you*\nOr: *${PREFIX}lyrics ed sheeran - shape of you*`);

      const key = `${sessionId}:${msg?.key?.participant || msg?.key?.remoteJid || jid}`;
      const now = Date.now();
      if (now - (lastUse.get(key) || 0) < COOLDOWN_MS) return reply('⏳ ටිකක් ඉන්න, ආයෙ try කරන්න.');
      lastUse.set(key, now);

      try {
        const song = await findSong(query);
        if (!song) return reply(`😕 "${query}" හොයාගන්න බැරි වුණා.\nTry: *${PREFIX}lyrics artist - song name*`);

        const data = await getJson(`${API()}/v1/${encodeURIComponent(song.artist)}/${encodeURIComponent(song.title)}`);
        let text = String(data?.lyrics || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
        if (!text) return reply(`😕 *${song.title}* (${song.artist}) සඳහා lyrics හොයාගන්න බැරි වුණා.`);

        const max = MAX_CHARS();
        const cut = text.length > max;
        if (cut) text = text.slice(0, max).replace(/\n[^\n]*$/, '').trim() + '\n…';
        return reply(`🎤 *${song.title}*\n👤 ${song.artist}\n\n${text}${cut ? '\n\n_(Lyrics are shortened)_' : ''}`);
      } catch (err) {
        console.error('.lyrics error:', err?.message || err);
        return reply('😕 දැන් lyrics ගන්න බැරි වුණා, ටිකකින් ආයෙ try කරන්න.');
      }
    },
  },
];
