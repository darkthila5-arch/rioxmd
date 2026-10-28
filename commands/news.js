// Sri Lanka news: Hiru, Derana, ITN.
//   .news [hiru|derana|itn]     latest headlines          (.hiru  .derana  .itn  do the same for one channel)
//   .newson [hiru derana itn]   auto-post new headlines to THIS chat (owner only; run it inside a group)
//   .newsadd <group/channel link or jid> [sources]    add a group or WhatsApp channel from anywhere
//   .newsoff   .newsdel <target>   .newslist
// The bot checks the news sites every few minutes and posts every NEW headline (picture + text + link) to the chats you added.
// Facebook pages cannot be read without Facebook's API, so the same stories are taken from the news sites' own feeds.
// Env: NEWS_LANG = si (default) | en      NEWS_POLL_MIN = minutes between checks (default 3)
import { BOT_NAME, PREFIX, sessions, sleep } from '../lib/config.js';
import { getSetting, setSetting } from '../lib/storage.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LANG = (process.env.NEWS_LANG || 'si').toLowerCase() === 'en' ? 'en' : 'si';
const POLL_MS = Math.max(1, Number(process.env.NEWS_POLL_MIN || 3)) * 60 * 1000;
const MAX_PER_CYCLE = 3; // never flood the chats: at most 3 new stories per channel per check

// Google News is the safety net: it lists the newest stories of any site, so a source still works when its own feed is missing.
const gnews = (site) => `https://news.google.com/rss/search?q=${encodeURIComponent(`site:${site}`)}&hl=${LANG}&gl=LK&ceid=LK:${LANG}`;
const html = (page, re) => ({ html: page, re }); // fallback: read the site's own home page and pick the story links
const SOURCES = {
  hiru: { name: 'HIRU NEWS', icon: '🔴', feeds: [
    'https://www.hirunews.lk/rss', 'https://www.hirunews.lk/feed', 'https://www.hirunews.lk/rss.xml',
    html('https://www.hirunews.lk/', /<a[^>]+href=["']((?:https?:\/\/(?:www\.)?hirunews\.lk)?\/(?:[a-z]{2}\/)?\d{4,}[^"']*)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi),
    gnews('hirunews.lk')] },
  derana: { name: 'ADA DERANA', icon: '🔵', feeds: [LANG === 'si' ? 'https://sinhala.adaderana.lk/rss.php' : 'https://www.adaderana.lk/rss.php', gnews('adaderana.lk')] },
  itn: { name: 'ITN NEWS', icon: '🟢', feeds: [
    'https://www.itnnews.lk/feed/', 'https://itnnews.lk/feed/', 'https://www.itnnews.lk/?feed=rss2',
    html('https://www.itnnews.lk/', /<a[^>]+href=["'](https?:\/\/(?:www\.)?itnnews\.lk\/\d{4}\/\d{2}\/\d{2}\/[^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi),
    gnews('itnnews.lk')] }
};
const ALL = Object.keys(SOURCES);

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const dec = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const plain = (s) => dec(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const keyOf = (title) => title.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '').slice(0, 90); // same story = same key, whichever feed it came from

async function fetchText(url, ms = 15000) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/rss+xml,application/xml,*/*' }, signal: AbortSignal.timeout(ms), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Google News links hide the real article inside the id (base64). Decoding it gives the real link, so the page can be opened for its picture.
function decodeGoogle(link) {
  const m = String(link).match(/news\.google\.com\/(?:rss\/)?articles\/([^?/]+)/);
  if (!m) return link;
  try {
    const u = Buffer.from(m[1], 'base64url').toString('latin1').match(/https?:\/\/[\x21-\x7e]+/);
    if (u) return u[0];
  } catch { /* keep the Google link */ }
  return link;
}
function parseHtml(page, f) {
  const out = [], seen = new Set();
  for (const m of String(page).matchAll(f.re)) {
    let link = dec(m[1]).trim();
    if (link.startsWith('/')) link = new URL(link, f.html).toString();
    const title = plain(m[2]);
    if (title.length < 15 || seen.has(link)) continue; // short anchors are menu items, not headlines
    seen.add(link);
    out.push({ id: keyOf(title), title, link, summary: '', image: '' });
  }
  return out;
}

function parseFeed(xml, isGoogle) {
  const items = [];
  for (const m of String(xml).matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)) {
    const b = m[0];
    const get = (n) => { const r = b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i')); return r ? dec(r[1]).trim() : ''; };
    let title = plain(get('title'));
    if (isGoogle) title = title.replace(/\s+-\s+[^-]+$/, ''); // Google adds " - Publisher"
    let link = get('link') || (b.match(/<link[^>]+href=["']([^"']+)/i) || [])[1] || '';
    link = dec(link).trim();
    if (isGoogle) link = decodeGoogle(link);
    const raw = get('description') || get('summary') || get('content:encoded') || get('content');
    const image = (b.match(/<(?:media:content|media:thumbnail|enclosure)[^>]+url=["']([^"']+)/i) || [])[1] || (raw.match(/<img[^>]+src=["']([^"']+)/i) || [])[1] || '';
    let summary = plain(raw);
    if (isGoogle || summary.toLowerCase().startsWith(title.toLowerCase().slice(0, 30))) summary = ''; // Google's "summary" is just the title again
    if (!title || !link) continue;
    items.push({ id: keyOf(title), title, link, summary, image: /^https?:\/\//i.test(image) ? dec(image) : '' });
  }
  return items;
}

const working = {}; // source -> index of the feed that last worked
const warned = new Set();
const feedUrl = (f) => (typeof f === 'string' ? f : f.html);
async function latest(key) {
  const feeds = SOURCES[key].feeds;
  const order = [...new Set([working[key] ?? 0, ...feeds.keys()])];
  const errs = [];
  for (const i of order) {
    const f = feeds[i], url = feedUrl(f);
    try {
      const body = await fetchText(url);
      const items = typeof f === 'string' ? parseFeed(body, url.includes('news.google.com')) : parseHtml(body, f);
      if (items.length) { if (working[key] !== i) { working[key] = i; console.log(`News: ${key} uses ${url}`); } return items.slice(0, 15); }
      errs.push(`${url}: no stories`);
    } catch (err) { errs.push(`${url}: ${err?.message || err}`); }
    if (!warned.has(url)) { warned.add(url); console.log(`News: ${key} source skipped - ${errs[errs.length - 1]}`); } // logged once per source
  }
  throw new Error(errs.join(' | '));
}

const metaOf = (html, name) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i'));
  return m ? dec(m[1]).trim() : '';
};
// The feed rarely has the picture, so a new story's own page is opened for its og:image and description.
async function enrich(item) {
  if ((item.image && item.summary) || item.link.includes('news.google.com')) return item;
  try {
    const html = await fetchText(item.link, 8000);
    return { ...item, image: item.image || metaOf(html, 'og:image'), summary: item.summary || plain(metaOf(html, 'og:description') || metaOf(html, 'description')) };
  } catch { return item; }
}
async function imageBuffer(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 1000 && buf.length < 6 * 1048576 ? buf : null;
  } catch { return null; }
}

const captionOf = (key, it) => [
  `${SOURCES[key].icon} *${SOURCES[key].name}*`, '',
  `*${clip(it.title, 220)}*`,
  it.summary ? `\n${clip(it.summary, 380)}` : '',
  `\n🔗 ${it.link}`,
  `\n> ${BOT_NAME}`
].join('\n');

async function post(sock, jid, key, item, img) {
  const caption = captionOf(key, item);
  try {
    await sock.sendMessage(jid, img ? { image: img, caption } : { text: caption });
  } catch (err) {
    if (!img) throw err;
    await sock.sendMessage(jid, { text: caption }); // the picture failed, still send the story
  }
}

/* ---------- targets (per linked WhatsApp number, saved with the other settings) ---------- */
const getTargets = (sid) => getSetting(sid, 'newsTargets', {});
function setTarget(sid, jid, keys) { setSetting(sid, 'newsTargets', { ...getTargets(sid), [jid]: keys }); }
function removeTarget(sid, jid) { const t = { ...getTargets(sid) }; const had = jid in t; delete t[jid]; setSetting(sid, 'newsTargets', t); return had; }
const pickKeys = (args) => { const ks = args.map((a) => a.toLowerCase()).filter((a) => SOURCES[a]); return ks.length ? [...new Set(ks)] : ALL; };

async function resolveTarget(sock, raw) {
  const t = String(raw || '').trim();
  if (/@(g\.us|newsletter)$/.test(t)) return t;
  const ch = t.match(/whatsapp\.com\/channel\/([\w-]+)/i);
  if (ch) return (await sock.newsletterMetadata('invite', ch[1])).id;
  const gr = t.match(/chat\.whatsapp\.com\/([\w-]+)/i);
  if (gr) return (await sock.groupGetInviteInfo(gr[1])).id;
  return null;
}

/* ---------- the auto poster ---------- */
let busy = false;
async function poll() {
  if (busy) return;
  busy = true;
  try {
    const wants = {}; // source -> [{ sock, jid }]
    for (const [sid, rec] of sessions) {
      if (!rec?.sock || rec.status !== 'connected') continue;
      for (const [jid, keys] of Object.entries(getTargets(sid))) for (const k of keys) (wants[k] ||= []).push({ sock: rec.sock, jid });
    }
    const seenAll = { ...getSetting('_news', 'seen', {}) };
    let changed = false;
    for (const key of ALL) {
      let items;
      try { items = await latest(key); } catch (err) { console.error(`News ${key} failed:`, err?.message || err); continue; }
      const first = !seenAll[key]; // very first run: remember what exists, post nothing (no flood of old stories)
      const seen = new Set(seenAll[key] || []);
      const fresh = items.filter((i) => !seen.has(i.id));
      if (!fresh.length && !first) continue;
      for (const i of [...items].reverse()) seen.add(i.id);
      seenAll[key] = [...seen].slice(-100);
      changed = true;
      if (first || !wants[key]?.length) continue;
      for (const item of fresh.slice(0, MAX_PER_CYCLE).reverse()) { // oldest first
        const full = await enrich(item);
        const img = await imageBuffer(full.image);
        for (const t of wants[key]) {
          try { await post(t.sock, t.jid, key, full, img); } catch (err) { console.error(`News post to ${t.jid} failed:`, err?.message || err); }
          await sleep(1500); // slow and steady: bulk posting is what gets numbers banned
        }
      }
    }
    if (changed) setSetting('_news', 'seen', seenAll);
  } catch (err) { console.error('News poll error:', err?.message || err); }
  finally { busy = false; }
}
if (!globalThis.__rioNewsTimer) {
  globalThis.__rioNewsTimer = true;
  setTimeout(() => { poll(); setInterval(poll, POLL_MS).unref?.(); }, 2 * 60 * 1000).unref?.(); // wait 2 min after start so saved settings are loaded first
}

/* ---------- commands ---------- */
async function headlines(reply, keys, n) {
  const parts = await Promise.all(keys.map(async (k) => {
    try {
      const items = (await latest(k)).slice(0, n);
      return [`${SOURCES[k].icon} *${SOURCES[k].name}*`, ...items.map((i, x) => `${x + 1}. ${clip(i.title, 120)}\n   ${i.link}`)].join('\n');
    } catch { return `${SOURCES[k].icon} *${SOURCES[k].name}*\n❌ Could not load right now.`; }
  }));
  return reply(`📰 *Latest news*\n\n${parts.join('\n\n')}`);
}
const one = (key) => ({ name: key, react: SOURCES[key].icon, async run({ reply }) { return headlines(reply, [key], 6); } });
const names = (keys) => keys.map((k) => SOURCES[k].name).join(', ');

export default [
  { name: 'news', aliases: ['lknews'], react: '📰', async run({ reply, args }) { const ks = args.length ? pickKeys(args) : ALL; return headlines(reply, ks, ks.length === 1 ? 6 : 3); } },
  one('hiru'), one('derana'), one('itn'),
  {
    name: 'newson', aliases: ['autonews'], owner: true, react: '📰',
    async run({ reply, sessionId, jid, args }) {
      const keys = pickKeys(args);
      setTarget(sessionId, jid, keys);
      return reply(`✅ Auto news is ON for this chat.\n📰 ${names(keys)}\nNew headlines are posted here by themselves (checked every ${Math.round(POLL_MS / 60000)} min).\nTurn off: ${PREFIX}newsoff`);
    }
  },
  {
    name: 'newsadd', owner: true, react: '➕',
    async run({ sock, reply, sessionId, args }) {
      if (!args[0]) return reply(`Usage: ${PREFIX}newsadd <group link | channel link | jid> [hiru derana itn]\nExample: ${PREFIX}newsadd https://whatsapp.com/channel/xxxx hiru derana`);
      let target = null;
      try { target = await resolveTarget(sock, args[0]); } catch (err) { console.error('newsadd resolve error:', err?.message || err); }
      if (!target) return reply('❌ I could not read that. Send a WhatsApp group link, a channel link, or a jid ending in @g.us / @newsletter.');
      const keys = pickKeys(args.slice(1));
      setTarget(sessionId, target, keys);
      return reply(`✅ Added ${target.endsWith('@newsletter') ? 'channel' : 'group'}:\n${target}\n📰 ${names(keys)}\n\nThe linked number must be a member (groups) or an admin/owner (channels), otherwise WhatsApp will not let the bot post there.`);
    }
  },
  {
    name: 'newsoff', aliases: ['stopnews'], owner: true, react: '🔕',
    async run({ reply, sessionId, jid }) { return reply(removeTarget(sessionId, jid) ? '🔕 Auto news is OFF for this chat.' : 'ℹ️ Auto news was not on for this chat.'); }
  },
  {
    name: 'newsdel', owner: true, react: '➖',
    async run({ sock, reply, sessionId, args }) {
      let target = null;
      try { target = await resolveTarget(sock, args[0]); } catch { /* fall through */ }
      return reply(target && removeTarget(sessionId, target) ? `🔕 Removed:\n${target}` : `ℹ️ Not found. See ${PREFIX}newslist`);
    }
  },
  {
    name: 'newslist', owner: true, react: '📋',
    async run({ reply, sessionId }) {
      const t = Object.entries(getTargets(sessionId));
      if (!t.length) return reply(`📋 No chats yet.\nRun ${PREFIX}newson inside a group, or ${PREFIX}newsadd <link>.`);
      return reply(`📋 *Auto news chats*\n\n${t.map(([j, k], i) => `${i + 1}. ${j.endsWith('@newsletter') ? '📢' : '👥'} ${j}\n   ${names(k)}`).join('\n')}`);
    }
  }
];
