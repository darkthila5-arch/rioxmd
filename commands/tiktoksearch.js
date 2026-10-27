// .tts <words>  ->  TikTok search shown as a swipeable card carousel (image + title + OPEN button).
// Tapping OPEN runs `.tt <video link>`, which opens the normal Video / Audio / Document download menu.
import fs from 'node:fs';
import path from 'node:path';
import { proto, generateWAMessageFromContent, prepareWAMessageMedia, isJidGroup } from '@whiskeysockets/baileys';
import { BOT_NAME, PREFIX, ROOT_DIR, USE_BUTTONS, sleep } from '../lib/config.js';
import { qr } from '../lib/menu.js';

const MAX_CARDS = 8;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FALLBACK_IMG = path.join(ROOT_DIR, 'public', 'ghost.png');

const abs = (v) => (v ? (v.startsWith('/') ? `https://www.tikwm.com${v}` : v) : null);
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
      url
    });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}
const pick = (j) => j?.data?.videos || j?.data?.data || j?.data?.items || j?.data || j?.result?.videos || j?.result || j?.videos || j?.items || j;

async function getJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`not JSON (HTTP ${res.status})`); }
}
const BROWSER = { 'user-agent': UA, accept: 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9' };
const form = (q) => new URLSearchParams({ keywords: q, count: '12', cursor: '0', hd: '1' });

// Providers are tried in order until one returns videos. Add your own with TIKTOK_SEARCH_URL (use {q} where the words go;
// it must return JSON with a list of videos). The free public APIs below can change or go down at any time.
const PROVIDERS = [
  ['tikwm', async (q) => {
    const j = await getJson('https://www.tikwm.com/api/feed/search', { method: 'POST', headers: { ...BROWSER, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://www.tikwm.com', referer: 'https://www.tikwm.com/' }, body: form(q) });
    if (j.code !== 0) throw new Error(j.msg || 'tikwm refused');
    return pick(j);
  }],
  ['tikwm-get', async (q) => {
    const j = await getJson(`https://tikwm.com/api/feed/search?${form(q)}`, { headers: { ...BROWSER, referer: 'https://tikwm.com/' } });
    if (j.code !== 0) throw new Error(j.msg || 'tikwm refused');
    return pick(j);
  }],
  ['siputzx', async (q) => pick(await getJson(`https://api.siputzx.my.id/api/s/tiktok?query=${encodeURIComponent(q)}`, { headers: BROWSER }))],
  ['agatz', async (q) => pick(await getJson(`https://api.agatz.xyz/api/tiktoksearch?message=${encodeURIComponent(q)}`, { headers: BROWSER }))],
  ['ryzen', async (q) => pick(await getJson(`https://api.ryzendesu.vip/api/search/tiktok?query=${encodeURIComponent(q)}`, { headers: BROWSER }))]
];
if (process.env.TIKTOK_SEARCH_URL) {
  PROVIDERS.unshift(['custom', async (q) => pick(await getJson(process.env.TIKTOK_SEARCH_URL.replace('{q}', encodeURIComponent(q)), { headers: BROWSER }))]);
}

async function searchTikTok(query) {
  const errors = [];
  for (const [name, fn] of PROVIDERS) {
    try {
      const list = normalize(await fn(query));
      if (list.length) return list;
      errors.push(`${name}: no results`);
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
      nativeFlowMessage: IM.NativeFlowMessage.create({ buttons: [qr('🎵 OPEN', `${PREFIX}tt ${r.url}`)], messageParamsJson: '' })
    });
  }));
  const interactiveMessage = IM.create({
    body: IM.Body.create({ text: `🔎 *TikTok results for* “${clip(query, 60)}”\nSwipe the cards and tap OPEN` }),
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
];
