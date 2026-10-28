// .tts <words>  ->  TikTok search shown as a swipeable card carousel (image + title + 3 buttons).
//   VIDEO -> .ttdl <link>  sends the video straight away      AUDIO -> .ttmp3 <link>  sends the sound
//   MORE  -> .tt <link>    opens the normal Video / Audio / Document menu
import fs from 'node:fs';
import path from 'node:path';
import { proto, generateWAMessageFromContent, prepareWAMessageMedia, isJidGroup } from '@whiskeysockets/baileys';
import { BOT_NAME, PREFIX, ROOT_DIR, USE_BUTTONS, sleep } from '../lib/config.js';
import { qr } from '../lib/menu.js';
import { MAX_DL_BYTES, fetchBuffer, parseUrl, tikwm } from '../lib/downloader.js';

const MAX_CARDS = 8;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FALLBACK_IMG = path.join(ROOT_DIR, 'public', 'ghost.png');

const abs = (v) => (v ? (v.startsWith('/') ? `https://www.tikwm.com${v}` : v) : null);
const httpUrl = (v) => { const u = abs(typeof v === 'string' ? v : ''); return /^https?:\/\//i.test(u || '') ? u : null; };
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Turns the different reply shapes of the search providers into one list.
function normalize(items) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const id = it.video_id || it.aweme_id || it.id;
    const a = it.author;
    const handle = (typeof a === 'object' ? a?.unique_id || a?.uniqueId || a?.username : '') || it.unique_id || it.username || '';
    const author = (typeof a === 'string' ? a : a?.nickname || a?.name || handle) || '';
    const url = it.url || it.share_url || it.link || (id ? `https://www.tiktok.com/@${handle || 'user'}/video/${id}` : '');
    if (!/^https?:\/\/[^ ]*tiktok\.com\//i.test(url)) continue;
    out.push({
      title: it.title || it.desc || it.description || it.caption || '',
      author, handle,
      cover: abs(it.cover || it.origin_cover || it.thumbnail || it.thumb || it.video?.cover || it.dynamic_cover),
      plays: it.play_count ?? it.plays ?? it.stats?.playCount ?? it.statistics?.play_count,
      video: httpUrl(it.hdplay) || httpUrl(it.play) || httpUrl(it.video_url) || httpUrl(it.nowm),       // direct no-watermark file, when the provider sends it
      audio: httpUrl(it.music) || httpUrl(it.music_info?.play) || httpUrl(it.audio),
      url
    });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}
// Finds the list of videos wherever the provider put it (data.videos, meta, result.search_data, ...).
let lastRaw = null; // raw reply of the provider being tried (shown in the error log)
function pick(j, depth = 0) {
  if (depth === 0) lastRaw = j;
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object' || depth > 3) return [];
  for (const v of Object.values(j)) {
    if (Array.isArray(v) && v.some((x) => x && typeof x === 'object' && (x.video_id || x.aweme_id || x.id || x.url || x.play))) return v;
  }
  for (const v of Object.values(j)) { const r = pick(v, depth + 1); if (r.length) return r; }
  return [];
}

async function getJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`not JSON (HTTP ${res.status})`); }
}
const BROWSER = { 'user-agent': UA, accept: 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9' };
const form = (q) => new URLSearchParams({ keywords: q, count: '12', cursor: '0', hd: '1' });

// Web search fallback: Bing finds tiktok.com video links, then TikTok's own oEmbed gives each one's title + thumbnail.
function extractTikTokLinks(html) {
  const found = new Set();
  const scan = (t) => {
    for (const m of t.matchAll(/(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([\w.\-]+)\/video\/(\d+)/g)) found.add(`https://www.tiktok.com/@${m[1]}/video/${m[2]}`);
    for (const m of t.matchAll(/tiktok\.com\s*(?:›|&rsaquo;|&#8250;)\s*(@[\w.\-]+)\s*(?:›|&rsaquo;|&#8250;)\s*video\s*(?:›|&rsaquo;|&#8250;)\s*(\d+)/g)) found.add(`https://www.tiktok.com/${m[1]}/video/${m[2]}`); // Bing's breadcrumb style
  };
  const h = String(html || '').replace(/&amp;/g, '&');
  scan(h);
  for (const m of h.matchAll(/[?&]uddg=([^&"'\s]+)/g)) { try { scan(decodeURIComponent(m[1])); } catch { /* skip */ } }          // DuckDuckGo redirect links
  for (const m of h.matchAll(/[?&]u=a1([A-Za-z0-9_\-]+)/g)) { try { scan(Buffer.from(m[1], 'base64url').toString()); } catch { /* skip */ } } // Bing redirect links
  for (const m of h.matchAll(/https?%3a%2f%2f[^&"'\s]*tiktok\.com[^&"'\s]+/gi)) { try { scan(decodeURIComponent(m[0])); } catch { /* skip */ } }
  return [...found];
}
async function viaWebSearch(searchUrl, init) {
  const res = await fetch(searchUrl, { ...init, signal: AbortSignal.timeout(15000) });
  const html = await res.text();
  const links = extractTikTokLinks(html).slice(0, MAX_CARDS);
  if (!links.length) throw new Error(`no TikTok links (HTTP ${res.status}, ${html.length} bytes${/captcha|unusual traffic|verify you are/i.test(html) ? ', bot-check page' : ''})`);
  return Promise.all(links.map(async (url) => {
    try {
      const o = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, { headers: BROWSER });
      return { url, title: o.title, author: o.author_name, handle: o.author_unique_id, thumbnail: o.thumbnail_url };
    } catch { return { url }; } // keep the link even if its preview could not be read
  }));
}
const WEB_HEADERS = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' };
const q1 = encodeURIComponent;

// Providers are tried in order until one returns videos. The free public APIs change or die often (several already did),
// so for a reliable setup set ONE of these in Render:
//   TIKTOK_RAPIDAPI_KEY  = your RapidAPI key (subscribe to "TikTok Scraper" by tikwm on rapidapi.com, the free plan is enough)
//   TIKTOK_SEARCH_URL    = any JSON search API, with {q} where the words go
const PROVIDERS = [
  ['tikwm', async (q) => {
    const j = await getJson('https://www.tikwm.com/api/feed/search', { method: 'POST', headers: { ...BROWSER, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://www.tikwm.com', referer: 'https://www.tikwm.com/' }, body: form(q) });
    if (j.code !== 0) throw new Error(j.msg || 'tikwm refused');
    return pick(j);
  }],
  ['delirius', async (q) => pick(await getJson(`https://delirius-apiofc.vercel.app/search/tiktoksearch?query=${q1(q)}`, { headers: BROWSER }))],
  ['vreden', async (q) => pick(await getJson(`https://api.vreden.web.id/api/tiktoksearch?query=${q1(q)}`, { headers: BROWSER }))],
  ['davidcyril', async (q) => pick(await getJson(`https://apis.davidcyriltech.my.id/search/tiktok?query=${q1(q)}`, { headers: BROWSER }))],
  ['bing', (q) => viaWebSearch(`https://www.bing.com/search?q=${q1(`site:tiktok.com ${q}`)}&count=30&setlang=en`, { headers: WEB_HEADERS })]
];
if (process.env.TIKTOK_SEARCH_URL) {
  PROVIDERS.unshift(['custom', async (q) => pick(await getJson(process.env.TIKTOK_SEARCH_URL.replace('{q}', q1(q)), { headers: BROWSER }))]);
}
if (process.env.TIKTOK_RAPIDAPI_KEY) {
  PROVIDERS.unshift(['rapidapi', async (q) => {
    const j = await getJson(`https://tiktok-scraper7.p.rapidapi.com/feed/search?keywords=${q1(q)}&count=12&cursor=0`, {
      headers: { ...BROWSER, 'x-rapidapi-key': process.env.TIKTOK_RAPIDAPI_KEY.trim(), 'x-rapidapi-host': 'tiktok-scraper7.p.rapidapi.com' }
    });
    if (j?.message && !j.data) throw new Error(`RapidAPI says: ${String(j.message).slice(0, 150)}`); // e.g. "You are not subscribed to this API"
    if (j?.code !== undefined && j.code !== 0) throw new Error(`RapidAPI code ${j.code}: ${String(j.msg || '').slice(0, 150)}`);
    return pick(j);
  }]);
}

// Search results are remembered for an hour so a button only needs the short video id (no long link in the button, no extra lookup).
const dlCache = new Map(); // video id -> { url, video, audio, title, at }
const idOf = (url) => (String(url).match(/\/video\/(\d+)/) || [])[1] || '';
function remember(list) {
  const now = Date.now();
  for (const [k, v] of dlCache) if (now - v.at > 3600e3) dlCache.delete(k);
  for (const r of list) { const id = idOf(r.url); if (id) dlCache.set(id, { ...r, at: now }); }
}

async function searchTikTok(query) {
  const errors = [];
  for (const [name, fn] of PROVIDERS) {
    try {
      lastRaw = null;
      const raw = await fn(query);
      const list = normalize(raw);
      if (list.length) { console.log(`TikTok search: ${list.length} result(s) via ${name}`); remember(list); return list; }
      errors.push(`${name}: no results (${JSON.stringify(lastRaw ?? raw)?.slice(0, 200)})`); // shows what the provider actually sent
    } catch (err) { errors.push(`${name}: ${err?.message || err}`); }
    await sleep(300);
  }
  throw new Error(errors.join(' | '));
}

async function coverBuffer(url) {
  try {
    if (!url) throw new Error('no cover');
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) throw new Error('empty image');
    return buf;
  } catch { return fs.readFileSync(FALLBACK_IMG); } // a card still shows when one thumbnail fails
}

const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0));

async function sendCarousel(sock, jid, results, query, quoted) {
  const IM = proto.Message.InteractiveMessage;
  const cards = await Promise.all(results.map(async (r) => {
    const media = await prepareWAMessageMedia({ image: await coverBuffer(r.cover) }, { upload: sock.waUploadToServer });
    return IM.create({
      header: IM.Header.create({ title: '', subtitle: '', hasMediaAttachment: true, ...media }),
      body: IM.Body.create({ text: [`🎵 ${clip(r.title, 110) || 'TikTok video'}`, r.author ? `👤 ${clip(r.author, 40)}` : null, r.plays ? `▶️ ${compact(r.plays)} views` : null].filter(Boolean).join('\n') }),
      footer: IM.Footer.create({ text: BOT_NAME }),
      nativeFlowMessage: IM.NativeFlowMessage.create({ buttons: [qr('🎬 VIDEO', `${PREFIX}ttdl ${idOf(r.url) || r.url}`), qr('🎵 AUDIO', `${PREFIX}ttmp3 ${idOf(r.url) || r.url}`), qr('📂 MORE', `${PREFIX}tt ${r.url}`)], messageParamsJson: '' })
    });
  }));
  const interactiveMessage = IM.create({
    body: IM.Body.create({ text: `🔎 *TikTok results for* “${clip(query, 60)}”\nSwipe the cards and tap VIDEO or AUDIO` }),
    footer: IM.Footer.create({ text: BOT_NAME }),
    carouselMessage: IM.CarouselMessage.create({ cards, messageVersion: 1 })
  });
  const content = {
    viewOnceMessage: { message: { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, interactiveMessage } }
  };
  const waMsg = generateWAMessageFromContent(jid, content, { userJid: sock.user?.id, quoted });
  const additionalNodes = [{
    tag: 'biz', attrs: {},
    content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }]
  }];
  if (!isJidGroup(jid)) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id, additionalNodes });
}

function textList(results, query) {
  return [
    `🔎 *TikTok results for* “${clip(query, 60)}”`, '',
    ...results.map((r, i) => `*${i + 1}.* ${clip(r.title, 90) || 'TikTok video'}\n   👤 ${clip(r.author, 40)}\n   ${PREFIX}tt ${r.url}`),
    '', `Copy a line and send it to download. > ${BOT_NAME}`
  ].join('\n');
}

// Direct download used by the card buttons (no format menu in between). Accepts a video id (from a card) or a TikTok link.
async function sendDirect(sock, jid, msg, arg, kind, reply) {
  console.log(`TikTok ${kind} download requested:`, arg);
  const cached = dlCache.get(String(arg || ''));
  const url = cached?.url || (/^\d+$/.test(arg || '') ? `https://www.tiktok.com/@user/video/${arg}` : parseUrl(arg, 'tiktok'));
  if (!url) return reply(`❌ Send a valid TikTok link.\nExample: ${PREFIX}ttdl <TikTok link>`);
  await reply(kind === 'audio' ? '⏳ Preparing audio...' : '⏳ Downloading...');
  try {
    let buf = null, isAudio = false, title = cached?.title || '';
    const direct = kind === 'audio' ? (cached?.audio || cached?.video) : cached?.video; // file link that came with the search result
    if (direct) {
      try { buf = await fetchBuffer(direct); isAudio = kind === 'audio' && direct === cached.audio; }
      catch (err) { if (err?.message === 'TOO_BIG') throw err; console.error('Direct file failed, asking tikwm:', err?.message || err); }
    }
    if (!buf) {
      const info = await tikwm(url);
      title = info.title || title;
      if (kind === 'audio' && info.audio) { buf = await fetchBuffer(info.audio); isAudio = true; }
      else buf = await fetchBuffer(info.video, info.headers);
    }
    if (kind === 'audio') return await sock.sendMessage(jid, { audio: buf, mimetype: isAudio ? 'audio/mpeg' : 'audio/mp4', ptt: false }, { quoted: msg });
    return await sock.sendMessage(jid, { video: buf, mimetype: 'video/mp4', caption: `🎬 ${clip(title, 200)}\n\n> ${BOT_NAME}` }, { quoted: msg });
  } catch (err) {
    console.error('TikTok direct download error:', err?.message || err);
    if (err?.message === 'TOO_BIG') return reply(`❌ File is larger than ${Math.round(MAX_DL_BYTES / 1048576)} MB, so I can't send it.`);
    return reply(`❌ Download failed. Try ${PREFIX}tt <link> instead.`);
  }
}

export default [
  {
    name: 'tts', aliases: ['ttsearch', 'tiktoksearch'], react: '🔎',
    async run({ sock, msg, jid, args, reply }) {
      const query = args.join(' ').trim();
      if (!query) return reply(`❌ Type something to search.\nExample: ${PREFIX}tts funny cats`);
      await reply('🔎 Searching TikTok...');
      let results;
      try { results = await searchTikTok(query); }
      catch (err) {
        console.error('TikTok search error:', err?.message || err);
        return reply('❌ TikTok search failed. Try again in a few seconds.');
      }
      if (!results.length) return reply(`😕 No TikTok videos found for “${clip(query, 60)}”.`);
      if (USE_BUTTONS) {
        try { return await sendCarousel(sock, jid, results, query, msg); }
        catch (err) { console.error('Carousel send failed, using text list:', err?.message || err); }
      }
      return reply(textList(results, query));
    },
  },
  {
    name: 'ttdl', aliases: ['ttvideo'], react: '🎬',
    async run({ sock, msg, jid, args, reply }) { return sendDirect(sock, jid, msg, args[0], 'video', reply); },
  },
  {
    name: 'ttmp3', aliases: ['ttaudio'], react: '🎵',
    async run({ sock, msg, jid, args, reply }) { return sendDirect(sock, jid, msg, args[0], 'audio', reply); },
  },
];
