// .song <name>  ->  YouTube search shown as a swipeable card carousel (picture + title + 3 buttons), like .tts does for TikTok.
//   AUDIO -> .ytdl audio <id>     VIDEO -> .ytdl video <id>     DOC -> .ytdl doc <id>   (sent as a file)
// .song <YouTube link> still opens the single Audio / Document / Video menu.
import { BOT_NAME, PREFIX, USE_BUTTONS } from '../lib/config.js';
import { qr } from '../lib/menu.js';
import { sendCards } from '../lib/carousel.js';
import { rememberSong, startSong, ytDiagnose, ytSearchList } from '../lib/downloader.js';

const MAX_CARDS = 8;
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const mmss = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0));

const bodyOf = (r) => [`🎵 ${clip(r.title, 110)}`, r.author ? `👤 ${clip(r.author, 40)}` : null, r.duration ? `⏱️ ${mmss(r.duration)}` : null, r.views ? `▶️ ${compact(r.views)} views` : null].filter(Boolean).join('\n');

function textList(items, query) {
  return [
    `🔎 *YouTube results for* “${clip(query, 60)}”`, '',
    ...items.map(({ r, token }, i) => `*${i + 1}.* ${clip(r.title, 90)}\n   👤 ${clip(r.author, 40)}  ⏱️ ${mmss(r.duration) || '-'}\n   ${PREFIX}ytdl audio ${token}\n   ${PREFIX}ytdl video ${token}`),
    '', `Copy a line and send it to download. > ${BOT_NAME}`
  ].join('\n');
}

export default [
  {
    name: 'song', aliases: ['play', 'yt', 'ytmp3'], react: '🎵',
    async run({ sock, msg, jid, args, reply }) {
      const query = args.join(' ').trim();
      if (!query) return reply(`🎵 Send a song name or YouTube link.\nExample: ${PREFIX}song shape of you`);
      if (/^https?:\/\//i.test(query)) return startSong(sock, jid, msg, query); // a link: one result, same as before

      await reply('🔎 Searching YouTube...');
      let results;
      try { results = await ytSearchList(query, MAX_CARDS); }
      catch (err) {
        console.error('YouTube search error:', err?.stderr || err?.message || err);
        const bot = /confirm you.?re not a bot|sign in/i.test(String(err?.stderr || err?.message));
        return reply(bot ? '❌ YouTube blocked this server (bot check). Add fresh YouTube cookies (cookies.txt secret file), or try again later.'+'\n\nයූටියුබ් එක අපිව බ්ලොක් කරලා බං, පොඩ්ඩකින් ට්‍රයි කරපන් 😒' : '❌ YouTube search failed. Try again in a few seconds.'+'\n\nමොකක්හරි අවුලක් බං, ආයෙ ට්‍රයි කරපන් 😒');
      }
      if (!results.length) return reply(`😕 No songs found for “${clip(query, 60)}”.`);

      const items = results.map((r) => ({ r, token: rememberSong(r) }));
      if (USE_BUTTONS) {
        try {
          return await sendCards(sock, jid, {
            title: `🔎 *YouTube results for* “${clip(query, 60)}”\nSwipe the cards and tap AUDIO, VIDEO or DOC`,
            quoted: msg,
            cards: items.map(({ r, token }) => ({
              image: [r.thumb, r.thumb.replace('mqdefault', 'hqdefault')],
              body: bodyOf(r),
              buttons: [qr('🎵 AUDIO', `${PREFIX}ytdl audio ${token}`), qr('🎬 VIDEO', `${PREFIX}ytdl video ${token}`), qr('📄 DOC', `${PREFIX}ytdl doc ${token}`)]
            }))
          });
        } catch (err) { console.error('Song carousel failed, using text list:', err?.message || err); }
      }
      return reply(textList(items, query));
    },
  },
  {
    name: 'ytcheck', owner: true, react: '🩺',
    async run({ reply }) {
      await reply('🩺 Checking YouTube downloads (about 10 to 30 seconds)...');
      try { return await reply(await ytDiagnose()); }
      catch (err) { return reply(`❌ Check failed: ${clip(err?.message || err, 150)}`); }
    },
  },
];
