// .spotify <track link>  ->  reads the song name + artist from the Spotify link, finds it on YouTube and shows the same
// swipe cards as .song (AUDIO / VIDEO / DOC). Nothing is taken from Spotify itself (its audio is DRM protected): only the
// public title / artist of the link is used to search YouTube, and the download goes through the normal .ytdl flow.
//   .spotify https://open.spotify.com/track/xxxx      (spotify.link short links work too)
//   .spotify <song name>                              (same as .song, handy when you only have a name)
import { PREFIX, USE_BUTTONS } from '../lib/config.js';
import { FOOTER_LINE } from '../lib/brand.js';
import { qr } from '../lib/menu.js';
import { sendCards } from '../lib/carousel.js';
import { rememberSong, ytSearchList } from '../lib/downloader.js';

const MAX_CARDS = 5;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const mmss = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0));
const unHtml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'");

// Only open.spotify.com (and the spotify.link short links) are accepted: no other host is ever fetched.
export function parseSpotifyUrl(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (host === 'spotify.link') return { short: true, url: u.toString() };
  if (host !== 'open.spotify.com') return null;
  const m = u.pathname.match(/^\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{10,30})/);
  return m ? { type: m[1], id: m[2], url: `https://open.spotify.com/${m[1]}/${m[2]}` } : null;
}

async function get(url, asJson) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'follow', headers: { 'user-agent': UA, 'accept-language': 'en' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return asJson ? res.json() : res;
}

// spotify.link/xxxx -> the real open.spotify.com link (the final address must be open.spotify.com again).
async function expandShort(url) {
  const res = await get(url, false);
  const real = parseSpotifyUrl(res.url);
  return real && !real.short ? real : null;
}

// Song name + artist of a track link. The oEmbed answer has the name, the page title has "<song> - song and lyrics by <artist> | Spotify".
export async function trackMeta(url) {
  let title = '', artist = '';
  try { const j = await get(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, true); title = unHtml(j?.title); } catch { /* try the page */ }
  try {
    const html = await (await get(url, false)).text();
    const t = unHtml((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]);
    const m = t.match(/^(.*?)\s+-\s+(?:song|single|ep)(?: and lyrics)?\s+by\s+(.*?)\s*\|\s*Spotify$/i);
    if (m) { title = title || m[1]; artist = m[2]; }
    if (!title) title = unHtml((html.match(/property="og:title"\s+content="([^"]*)"/i) || html.match(/content="([^"]*)"\s+property="og:title"/i) || [])[1]);
    if (!artist) { const d = unHtml((html.match(/property="og:description"\s+content="([^"]*)"/i) || html.match(/content="([^"]*)"\s+property="og:description"/i) || [])[1]); artist = (d.match(/(?:^|·)\s*([^·]+?)\s*·\s*(?:Song|Single)/i) || [])[1] || ''; }
  } catch { /* oEmbed result (if any) is enough */ }
  return { title: clip(title, 120), artist: clip(artist, 80) };
}

const bodyOf = (r) => [`🎵 ${clip(r.title, 110)}`, r.author ? `👤 ${clip(r.author, 40)}` : null, r.duration ? `⏱️ ${mmss(r.duration)}` : null, r.views ? `▶️ ${compact(r.views)} views` : null].filter(Boolean).join('\n');

function textList(items, heading) {
  return [
    heading, '',
    ...items.map(({ r, token }, i) => `*${i + 1}.* ${clip(r.title, 90)}\n   👤 ${clip(r.author, 40)}  ⏱️ ${mmss(r.duration) || '-'}\n   ${PREFIX}ytdl audio ${token}\n   ${PREFIX}ytdl video ${token}`),
    '', `Copy a line and send it to download.\n${FOOTER_LINE}`
  ].join('\n');
}

export default [
  {
    name: 'spotify', aliases: ['sp', 'spdl', 'spotifydl'], react: '🎧',
    async run({ sock, msg, jid, args, reply }) {
      const input = args.join(' ').trim();
      if (!input) return reply(`🎧 Send a Spotify track link.\nExample: ${PREFIX}spotify https://open.spotify.com/track/...\n\nස්පොටිෆයි ලින්ක් එක ගහපන් බං 😑`);

      let query = input, heading = '';
      if (/^https?:\/\//i.test(input)) {
        let link = parseSpotifyUrl(input);
        if (!link) return reply('❌ That is not a Spotify link. Send an open.spotify.com track link.');
        await reply('🎧 Reading the Spotify link...');
        try { if (link.short) link = await expandShort(link.url); }
        catch (err) { console.error('Spotify short link error:', err?.message || err); link = null; }
        if (!link) return reply('❌ Could not open that Spotify link.');
        if (link.type !== 'track') return reply(`❌ Only single *track* links work for now (not ${link.type}s).\nOpen the song in Spotify > Share > Copy Song Link.`);
        const meta = await trackMeta(link.url);
        if (!meta.title) return reply('❌ Could not read the song from that link. Try ' + `${PREFIX}song <song name>` + ' instead.');
        query = `${meta.artist} ${meta.title}`.trim();
        heading = `🎧 *Spotify:* ${clip(meta.title, 70)}${meta.artist ? ` - ${clip(meta.artist, 50)}` : ''}`;
      }

      await reply('🔎 Searching YouTube...');
      let results;
      try { results = await ytSearchList(`${query} audio`, MAX_CARDS); }
      catch (err) {
        console.error('Spotify -> YouTube search error:', err?.stderr || err?.message || err);
        const bot = /confirm you.?re not a bot|sign in/i.test(String(err?.stderr || err?.message));
        return reply(bot ? '❌ YouTube blocked this server (bot check). Add fresh YouTube cookies, or try again later.' : '❌ YouTube search failed. Try again in a few seconds.');
      }
      if (!results.length) return reply(`😕 Nothing found for “${clip(query, 60)}”.`);

      const items = results.map((r) => ({ r, token: rememberSong(r) }));
      const title = `${heading || `🔎 *Results for* “${clip(query, 60)}”`}\nSwipe the cards and tap AUDIO, VIDEO or DOC`;
      if (USE_BUTTONS) {
        try {
          return await sendCards(sock, jid, {
            title, quoted: msg,
            cards: items.map(({ r, token }) => ({
              image: [r.thumb, r.thumb.replace('mqdefault', 'hqdefault')],
              body: bodyOf(r),
              buttons: [qr('🎵 AUDIO', `${PREFIX}ytdl audio ${token}`), qr('🎬 VIDEO', `${PREFIX}ytdl video ${token}`), qr('📄 DOC', `${PREFIX}ytdl doc ${token}`)]
            }))
          });
        } catch (err) { console.error('Spotify carousel failed, using text list:', err?.message || err); }
      }
      return reply(textList(items, heading || `🔎 *Results for* “${clip(query, 60)}”`));
    },
  },
];
