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

async function searchTikTok(query, attempt = 0) {
  const res = await fetch('https://www.tikwm.com/api/feed/search', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams({ keywords: query, count: '12', cursor: '0', hd: '1' }),
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); }
  catch {
    if (attempt < 1) { await sleep(1500); return searchTikTok(query, attempt + 1); } // free API allows ~1 request/second
    throw new Error(`empty reply (HTTP ${res.status})`);
  }
  if (j.code !== 0 || !j.data) throw new Error(j.msg || 'search failed');
  return (j.data.videos || [])
    .filter((v) => v.video_id)
    .slice(0, MAX_CARDS)
    .map((v) => ({
      title: v.title || '',
      author: v.author?.nickname || v.author?.unique_id || '',
      handle: v.author?.unique_id || '',
      cover: abs(v.cover || v.origin_cover),
      plays: v.play_count,
      url: `https://www.tiktok.com/@${v.author?.unique_id || 'user'}/video/${v.video_id}`
    }));
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
