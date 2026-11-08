// Sri Lanka news: Hiru, Derana, ITN, Swarnavahini, Sirasa.
//   .news [hiru|derana|itn|swarna|sirasa]     latest headlines          (.hiru  .derana  .itn  .swarna  .sirasa  do the same for one channel)
//   .newson [hiru derana itn swarna sirasa]   auto-post new headlines to THIS chat (owner only; run it inside a group)
//   .newsadd <group/channel link or jid> [sources]    add a group or WhatsApp channel from anywhere
//   .newsoff   .newsdel <target>   .newslist
// The bot checks the news sites every few minutes and posts every NEW headline (picture + text + link) to the chats you added.
// Facebook pages cannot be read without Facebook's API, so the same stories are taken from the news sites' own feeds.
// Admin site (/admin -> News): add groups / channels with a number of days. News stops by itself when the days are over. Footer per target: bot | channel | both | custom.
// Env: NEWS_LANG = si (default) | en      NEWS_POLL_MIN = minutes between checks (default 3)
import crypto from 'node:crypto';
import { BOT_NAME, PREFIX, TIMEZONE, sessions, sleep } from '../lib/config.js';
import { FOOTER_LINE, NO_FOOTER, cleanBrandText } from '../lib/brand.js';
import { getSetting, setSetting } from '../lib/storage.js';
import { shorten } from './webtools.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LANG = (process.env.NEWS_LANG || 'si').toLowerCase() === 'en' ? 'en' : 'si';
const POLL_MS = Math.max(1, Number(process.env.NEWS_POLL_MIN || 3)) * 60 * 1000;
const FULL = (process.env.NEWS_FULL || 'on').toLowerCase() !== 'off';   // send the whole story, not only the first lines (NEWS_FULL=off = headline + short summary)
const MAX_CHARS = Math.max(500, Number(process.env.NEWS_MAX_CHARS || 3500)); // longest story text that is sent
const CAPTION_MAX = Math.max(600, Number(process.env.NEWS_CAPTION_MAX || 2000)); // a story with a picture is ONE message: the picture with the whole text as its caption, cut at a sentence end when longer than this
const MAX_PER_CYCLE = 3; // never flood the chats: at most 3 new stories per channel per check

// Google News is the safety net: it lists the newest stories of any site, so a source still works when its own feed is missing.
const gnews = (site, when = '') => `https://news.google.com/rss/search?q=${encodeURIComponent(`site:${site}${when ? ` when:${when}` : ''}`)}&hl=${LANG}&gl=LK&ceid=LK:${LANG}`;
const html = (page, re, clean) => ({ html: page, re, clean }); // fallback: read the site's own home page and pick the story links
const wpjson = (url) => ({ json: url });              // fallback: the site's WordPress REST API (title, link, picture)
const reader = (page, host, path) => ({ md: `https://r.jina.ai/${page}`, host, path }); // last resort: a public "reader" service opens the page for us and returns it as markdown
// newsfirst.lk list anchors hold: headline, headline again, "COLOMBO(News1st) - first lines", date and a "more" label. Keep one headline.
const nfTitle = (t) => {
  let x = String(t).replace(/\s*COLOMBO\s*\(.*$/i, '').replace(/\s*\d{2}-\d{2}-\d{4}\b.*$/, '').trim();
  const w = x.split(' ');
  if (w.length % 2 === 0 && w.length > 1 && w.slice(0, w.length / 2).join(' ') === w.slice(w.length / 2).join(' ')) x = w.slice(0, w.length / 2).join(' ');
  return x;
};
const SOURCES = {
  hiru: { name: 'HIRU NEWS', icon: '🔴', feeds: [
    'https://www.hirunews.lk/rss', 'https://www.hirunews.lk/feed', 'https://www.hirunews.lk/rss.xml',
    html('https://www.hirunews.lk/', /<a[^>]+href=["']((?:https?:\/\/(?:www\.)?hirunews\.lk)?\/(?:[a-z]{2}\/)?\d{4,}[^"']*)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi),
    gnews('hirunews.lk')] },
  derana: { name: 'ADA DERANA', icon: '🔵', feeds: [LANG === 'si' ? 'https://sinhala.adaderana.lk/rss.php' : 'https://www.adaderana.lk/rss.php', gnews('adaderana.lk')] },
  itn: { name: 'ITN NEWS', icon: '🟢', feeds: [
    'https://www.itnnews.lk/feed/', 'https://itnnews.lk/feed/', 'https://www.itnnews.lk/?feed=rss2',
    'https://www.itnnews.lk/latest-news/feed/', 'https://www.itnnews.lk/breaking-news/feed/',
    wpjson('https://www.itnnews.lk/wp-json/wp/v2/posts?per_page=15&_embed=wp:featuredmedia&_fields=title,link,excerpt,_links,_embedded'),
    html('https://www.itnnews.lk/', /<a[^>]+href=["'](https?:\/\/(?:www\.)?itnnews\.lk\/\d{4}\/\d{2}\/\d{2}\/[^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi),
    reader('https://www.itnnews.lk/', 'itnnews\\.lk'),
    gnews('itnnews.lk')] },
  swarna: { name: 'SWARNAVAHINI NEWS', icon: '🟡', feeds: [
    'https://swarnavahininews.lk/feed/',
    wpjson('https://swarnavahininews.lk/wp-json/wp/v2/posts?per_page=15&_embed=wp:featuredmedia&_fields=title,link,excerpt,_links,_embedded'),
    html('https://swarnavahininews.lk/', /<a[^>]+href=["'](https?:\/\/swarnavahininews\.lk\/\?p=\d+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi),
    gnews('swarnavahininews.lk', '2d')] },
  sirasa: { name: 'SIRASA NEWS', icon: '🟣',
    skip: /\barchives?\b|about-?us|latest (breaking )?news|top stories|\||^ministry of [a-z ]+$/i, // section pages that Google lists for the site
    feeds: [
      html(LANG === 'si' ? 'https://sinhala.newsfirst.lk/' : 'https://english.newsfirst.lk/', /<a[^>]+href=["']((?:https?:\/\/(?:[a-z]+\.)?newsfirst\.lk)?\/\d{4}\/\d{1,2}\/\d{1,2}\/[^"'?#]+)["'][^>]*>([\s\S]{0,2500}?)<\/a>/gi, nfTitle),
      html(LANG === 'si' ? 'https://sinhala.newsfirst.lk/latest-news' : 'https://english.newsfirst.lk/latest-news', /<a[^>]+href=["']((?:https?:\/\/(?:[a-z]+\.)?newsfirst\.lk)?\/\d{4}\/\d{1,2}\/\d{1,2}\/[^"'?#]+)["'][^>]*>([\s\S]{0,2500}?)<\/a>/gi, nfTitle),
      gnews('newsfirst.lk', '2d')] }
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
    const title = f.clean ? f.clean(plain(m[2])) : plain(m[2]);
    if (title.length < 15 || seen.has(link)) continue; // short anchors are menu items, not headlines
    seen.add(link);
    out.push({ id: keyOf(title), title, link, summary: '', image: '' });
  }
  return out;
}

// WordPress REST API: [{ title: { rendered }, link, excerpt: { rendered }, _embedded: { 'wp:featuredmedia': [{ source_url }] } }]
const num = (t) => String(t || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
function parseJson(body) {
  let arr;
  try { arr = JSON.parse(body); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const p of arr) {
    const title = plain(num(p?.title?.rendered));
    const link = String(p?.link || '');
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const img = p?._embedded?.['wp:featuredmedia']?.[0]?.source_url || p?.jetpack_featured_media_url || '';
    out.push({ id: keyOf(title), title, link, summary: plain(num(p?.excerpt?.rendered)), image: /^https?:\/\//i.test(img) ? img : '' });
  }
  return out;
}
// Markdown from a reader service: "### [Headline](https://site/2026/11/06/123/)" and "[![](picture)](https://site/2026/11/06/123/ "Headline")"
function parseMd(body, f) {
  const text = String(body);
  const link = `https?:\\/\\/(?:www\\.)?${f.host}\\/${f.path || '\\d{4}\\/\\d{2}\\/\\d{2}\\/\\d+\\/?'}`;
  const pics = new Map();
  for (const m of text.matchAll(new RegExp(`\\[!\\[[^\\]]*\\]\\((https?:\\/\\/[^)\\s]+)\\)\\]\\((${link})`, 'g'))) if (!pics.has(m[2])) pics.set(m[2], m[1]);
  const out = [], seen = new Set();
  for (const m of text.matchAll(new RegExp(`\\[([^\\[\\]]{15,300}?)\\]\\((${link})(?:\\s+"[^"]*")?\\)`, 'g'))) {
    const title = plain(m[1]), url = m[2];
    if (title.length < 15 || seen.has(url)) continue;
    seen.add(url);
    out.push({ id: keyOf(title), title, link: url, summary: '', image: pics.get(url) || '' });
  }
  return out;
}

// ---- full story text ----
// Block tags become line breaks, everything else is dropped, so every paragraph of a page is one line.
const paras = (h) => dec(num(String(h || '')
  .replace(/<(script|style|noscript|svg|iframe|form|nav|footer|header|aside|button|select)\b[\s\S]*?<\/\1>/gi, '')
  .replace(/<\/?(?:br|p|div|li|h[1-6]|tr|section|article|blockquote)\b[^>]*>/gi, '\n')
  .replace(/<[^>]*>/g, ''))).split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
// a reader service answers in markdown: drop pictures, keep the words of links, skip headings / lists / tables
const mdLines = (md) => String(md || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split('\n')
  .map((l) => (/^\s*(#|[-*>|]|Title:|URL Source:|Markdown Content:)/.test(l) ? '' : l.replace(/\s+/g, ' ').trim()));
const JUNK = /most visited website|all rights reserved|©|copyright|powered by|follow us|share this|read more|related (news|posts?)|appeared first on|click here|subscribe|advertisement|facebook|whatsapp|twitter|instagram|youtube|tiktok|බෙදාගන්න|සමාන පුවත්|අපව අනුගමනය/i;
const ENDS = /[.?!…”"'’)\]»:]\s*$/;
// The story is the biggest group of long, neighbouring lines. When the page's own description is known, the group that contains it wins.
function pickCluster(lines, title, desc) {
  const nt = norm(title).slice(0, 40), nd = norm(desc).slice(0, 30);
  const clusters = []; let cur = [], gap = 0;
  const close = () => { if (cur.length) clusters.push(cur); cur = []; gap = 0; };
  for (const l of lines) {
    if (!l) continue;
    if (nt && norm(l).startsWith(nt)) continue;      // the headline itself
    if (JUNK.test(l)) { close(); continue; }         // share / follow / footer lines end a story
    // A story paragraph ends like a sentence. The list of other headlines under a story (sidebar / "latest news") does not, so it ends the story.
    if (cur.length && l.length >= 20 && !ENDS.test(l)) { close(); }
    if (l.length >= 50) { cur.push(l); gap = 0; }
    else if (cur.length && l.length >= 20 && gap < 2) { cur.push(l); gap++; } // a short line inside the story
    else { gap++; if (gap > 2 || !cur.length) close(); }
  }
  close();
  const size = (c) => c.reduce((n, l) => n + l.length, 0);
  const pick = (nd && clusters.find((c) => c.some((l) => norm(l).includes(nd)))) || [...clusters].sort((a, b) => size(b) - size(a))[0];
  const text = pick ? [...new Set(pick)].join('\n\n') : '';
  return text.length >= 100 ? text : '';
}
// Cut at a paragraph or sentence end, never in the middle of a word.
function cutText(t, n) {
  if (t.length <= n) return t;
  const head = t.slice(0, n);
  const at = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  return `${(at > n * 0.6 ? head.slice(0, at + 1) : head).trim()}…`;
}
function splitText(t, n) {
  const out = []; let cur = '';
  for (const p of t.split('\n\n')) {
    if (cur && cur.length + p.length + 2 > n) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
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
    const encoded = isGoogle ? '' : get('content:encoded');
    const feedBody = encoded ? pickCluster(paras(encoded), title, summary) : '';
    items.push({ id: keyOf(title), title, link, summary, body: feedBody, image: /^https?:\/\//i.test(image) ? dec(image) : '' });
  }
  return items;
}

const working = {}; // source -> index of the feed that last worked
const warned = new Set();
const feedUrl = (f) => (typeof f === 'string' ? f : (f.html || f.json || f.md));
async function latest(key) {
  const feeds = SOURCES[key].feeds;
  const order = [...new Set([working[key] ?? 0, ...feeds.keys()])];
  const errs = [];
  for (const i of order) {
    const f = feeds[i], url = feedUrl(f);
    try {
      const body = await fetchText(url);
      const items = typeof f === 'string' ? parseFeed(body, url.includes('news.google.com')) : f.json ? parseJson(body) : f.md ? parseMd(body, f) : parseHtml(body, f);
      const ok = SOURCES[key].skip ? items.filter((x) => !SOURCES[key].skip.test(x.title)) : items;
      if (ok.length) { if (working[key] !== i) { working[key] = i; console.log(`News: ${key} uses ${url}`); } return ok.slice(0, 15); }
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
  if (item.link.includes('news.google.com')) return item;
  if (item.image && item.body) return item; // the feed already had everything
  let html = '', md = '';
  try { html = await fetchText(item.link, 10000); }
  catch { // the site refuses this server: let a public reader service open the story page instead
    if (FULL) { try { md = await fetchText(`https://r.jina.ai/${item.link}`, 20000); } catch { /* summary only */ } }
  }
  const summary = item.summary || (html ? plain(metaOf(html, 'og:description') || metaOf(html, 'description')) : '');
  const image = item.image || (html ? metaOf(html, 'og:image') : '');
  let body = item.body || '';
  if (FULL && !body) body = html ? pickCluster(paras(html), item.title, summary) : md ? pickCluster(mdLines(md), item.title, summary) : '';
  return { ...item, image, summary, body };
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

// Some sites repeat the headline inside the description (and add a tagline). Drop that so the post is not the same text twice.
const norm = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
function cleanSummary(title, summary) {
  let t = String(summary || '').replace(/\s*Most visited website in Sri Lanka\.?\s*$/i, '').trim();
  const nt = norm(title).slice(0, 40);
  if (nt && norm(t).startsWith(nt)) t = t.startsWith(title) ? t.slice(title.length).trim() : '';
  return norm(t) === norm(title) ? '' : t;
}
// Date and time of sending, in the bot's TIMEZONE (default Asia/Colombo), e.g. "📅 Fri, 30 Oct 2026  •  🕒 04:15 PM"
function stamp(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: TIMEZONE }).format(now);
  const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TIMEZONE }).format(now);
  return `📅 ${date}  •  🕒 ${time}`;
}
const captionOf = (key, it, footer = FOOTER_LINE) => [
  `${SOURCES[key].icon} *${SOURCES[key].name}*`, '',
  `*${clip(it.title, 220)}*`,
  cleanSummary(it.title, it.summary) ? `\n${clip(cleanSummary(it.title, it.summary), 380)}` : '',
  `\n🔗 ${it.link}`,
  `\n${stamp()}`,
  `${footer}`
].join('\n');

// Footer under a news post. mode: bot (default) | channel (the group / channel name) | both (bot footer + name) | custom (own text).
// `own` = the footer is not the bot footer, so the automatic bot footer must not be added on top (NO_FOOTER).
function footerOf(t) {
  const f = t?.footer || {};
  const name = cleanBrandText(t?.name || '', 80), custom = cleanBrandText(f.custom || '', 120);
  const line = (x) => `> *${x}*`;
  if (f.mode === 'channel' && name) return { text: line(name), own: true };
  if (f.mode === 'both' && name) return { text: `${FOOTER_LINE}\n${line(name)}`, own: false };
  if (f.mode === 'custom' && custom) return { text: line(custom), own: true };
  return { text: FOOTER_LINE, own: false };
}

// Long links (newsfirst.lk has the whole Sinhala headline percent-encoded in the address, Google News links are even longer) are shortened with the same service as .short.
// Short links (like swarnavahininews.lk/?p=123) stay as they are. If the shortener is down the original link is used. Results are remembered.
const shortCache = new Map();
async function shortLink(url) {
  const u = String(url || '');
  if (u.length <= 70) return u;
  if (shortCache.has(u)) return shortCache.get(u);
  let out = u;
  try { out = await shorten(u); } catch { /* keep the long link */ }
  if (out !== u) { if (shortCache.size > 500) shortCache.delete(shortCache.keys().next().value); shortCache.set(u, out); }
  return out;
}

async function post(sock, jid, key, item, img, fo = footerOf(null)) {
  item = { ...item, link: await shortLink(item.link) };
  const own = (c) => (fo.own ? { ...c, [NO_FOOTER]: true } : c);
  const body = FULL ? String(item.body || '').trim() : '';
  if (body.length < 120) { // no full text: headline + short summary, as before
    const caption = captionOf(key, item, fo.text);
    try {
      await sock.sendMessage(jid, own(img ? { image: img, caption } : { text: caption }));
    } catch (err) {
      if (!img) throw err;
      await sock.sendMessage(jid, own({ text: caption })); // the picture failed, still send the story
    }
    return;
  }
  // Full story = ONE message: the picture with headline, text, link, time and footer as its caption.
  const head = `${SOURCES[key].icon} *${SOURCES[key].name}*\n\n*${clip(item.title, 220)}*`;
  const tail = `🔗 ${item.link}\n\n${stamp()}\n${fo.text}`;
  if (img) {
    const room = Math.max(200, CAPTION_MAX - head.length - tail.length - 4);
    try { await sock.sendMessage(jid, own({ image: img, caption: `${head}\n\n${cutText(body, room)}\n\n${tail}` })); return; }
    catch { /* the picture failed: the story goes out as one text message below */ }
  }
  // No picture: one text message (only a very long story is split into a few messages).
  const parts = splitText(cutText(body, MAX_CHARS), 3000);
  const headSent = false;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const text = [!headSent && i === 0 ? head : '', parts[i], last ? tail : ''].filter(Boolean).join('\n\n');
    await sock.sendMessage(jid, last ? own({ text }) : { text, [NO_FOOTER]: true });
    if (!last) await sleep(800);
  }
}

/* ---------- targets (per linked WhatsApp number, saved with the other settings) ---------- */
const getTargets = (sid) => getSetting(sid, 'newsTargets', {});
function setTarget(sid, jid, keys, meta) { // meta = { name } of the chat, kept so the web page can show it
  setSetting(sid, 'newsTargets', { ...getTargets(sid), [jid]: keys });
  const all = getSetting(sid, 'newsMeta', {}), old = all[jid] || {};
  setSetting(sid, 'newsMeta', { ...all, [jid]: { name: meta?.name || old.name || '', addedAt: old.addedAt || Date.now() } });
}
function removeTarget(sid, jid) {
  const t = { ...getTargets(sid) }; const had = jid in t; delete t[jid]; setSetting(sid, 'newsTargets', t);
  if (had) { const m = { ...getSetting(sid, 'newsMeta', {}) }; delete m[jid]; setSetting(sid, 'newsMeta', m); dropStats(sid, jid); }
  return had;
}
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

/* ---------- live numbers: how many news were posted to each chat (shown live on /admin -> News) ---------- */
const statKey = (sid, jid) => `${sid}|${jid}`;
const dayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const getStats = () => getSetting('_news', 'stats', {});
function dropStats(sid, jid) { const all = { ...getStats() }; if (delete all[statKey(sid, jid)]) setSetting('_news', 'stats', all); }
function noteStat(sid, jid, ok, text) { // ok = a story was posted; otherwise text is the error
  const all = { ...getStats() }, k = statKey(sid, jid), s = { ...(all[k] || {}) }, d = dayKey();
  if (ok) { s.total = (s.total || 0) + 1; s.today = s.day === d ? (s.today || 0) + 1 : 1; s.day = d; s.last = Date.now(); s.title = clip(text, 100); s.err = ''; }
  else { s.err = clip(text, 140); s.errAt = Date.now(); }
  all[k] = s; setSetting('_news', 'stats', all);
}
function statView(sid, jid) {
  const s = getStats()[statKey(sid, jid)] || {};
  return { total: s.total || 0, today: s.day === dayKey() ? s.today || 0 : 0, last: s.last || 0, lastTitle: s.title || '', err: s.err || '', errAt: s.errAt || 0 };
}
let lastPollAt = 0;

/* ---------- admin targets (/admin -> News): a group or channel + the sources + a number of days + a footer ---------- */
// Saved once for the whole bot (not per number). Each entry: { id, jid, kind, name, sid (the number that posts), sources, footer: { mode, custom }, days, until (0 = no end), addedAt }
const DAY = 86400000;
const FOOTER_MODES = ['bot', 'channel', 'both', 'custom'];
const adminList = () => { const v = getSetting('_news', 'adminTargets', []); return Array.isArray(v) ? v : []; };
const saveAdmin = (list) => setSetting('_news', 'adminTargets', list);
const isExpired = (t, now = Date.now()) => Number(t.until) > 0 && Number(t.until) <= now;

async function resolveInfo(sock, raw) {
  const t = String(raw || '').trim();
  const nameOf = (m) => String(m?.name || m?.thread_metadata?.name?.text || '').slice(0, 80);
  if (/@newsletter$/.test(t)) { let name = ''; try { name = nameOf(await sock.newsletterMetadata('jid', t)); } catch { /* name stays empty */ } return { jid: t, kind: 'channel', name }; }
  if (/@g\.us$/.test(t)) { let name = ''; try { name = String((await sock.groupMetadata(t)).subject || '').slice(0, 80); } catch { /* name stays empty */ } return { jid: t, kind: 'group', name }; }
  const ch = t.match(/whatsapp\.com\/channel\/([\w-]+)/i);
  if (ch) { const m = await sock.newsletterMetadata('invite', ch[1]); return { jid: m.id, kind: 'channel', name: nameOf(m) }; }
  const gr = t.match(/chat\.whatsapp\.com\/([\w-]+)/i);
  if (gr) { const m = await sock.groupGetInviteInfo(gr[1]); return { jid: m.id, kind: 'group', name: String(m.subject || '').slice(0, 80) }; }
  return null;
}
function cleanSources(v) {
  const ks = (Array.isArray(v) ? v : []).map((x) => String(x).toLowerCase()).filter((x) => SOURCES[x]);
  if (!ks.length) throw new Error('Pick at least one news channel (Hiru, Derana, ITN, Swarnavahini or Sirasa).');
  return [...new Set(ks)];
}
function cleanFooter(mode, custom, name) {
  const m = FOOTER_MODES.includes(mode) ? mode : 'bot';
  const c = cleanBrandText(custom || '', 120);
  if (m === 'custom' && !c) throw new Error('Type the custom footer text.');
  if ((m === 'channel' || m === 'both') && !name) throw new Error('The name of this group / channel could not be read, so it cannot be used as the footer. Choose "Bot footer" or "Custom footer".');
  return { mode: m, custom: c };
}
function cleanDays(v) {
  if (v == null || v === '' || Number(v) === 0) return 0; // no end date
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > 3650) throw new Error('Days must be a whole number from 1 to 3650 (leave empty for no end).');
  return n;
}
const untilOf = (days) => (days ? Date.now() + days * DAY : 0);

// Every chat that gets news: the ones added on the web page and the ones the owner added with .newson / .newsadd / .hiru on ...
function allTargets() {
  const now = Date.now(), out = adminList().map((t) => ({ ...t, origin: 'web', expired: isExpired(t, now) }));
  const taken = new Set(out.map((t) => statKey(t.sid, t.jid)));
  for (const sid of sessions.keys()) {
    const meta = getSetting(sid, 'newsMeta', {});
    for (const [jid, keys] of Object.entries(getTargets(sid))) {
      if (taken.has(statKey(sid, jid))) continue;
      out.push({ id: `c:${sid}:${jid}`, jid, kind: jid.endsWith('@newsletter') ? 'channel' : 'group', name: meta[jid]?.name || '', sid, sources: keys, footer: { mode: 'bot', custom: '' }, days: 0, until: 0, addedAt: meta[jid]?.addedAt || 0, origin: 'command', expired: false });
    }
  }
  return out;
}
async function chatMeta(sock, jid) { // the name of the chat the command was used in
  try {
    if (jid.endsWith('@newsletter')) { const m = await sock.newsletterMetadata('jid', jid); return { name: String(m?.name || m?.thread_metadata?.name?.text || '').slice(0, 80) }; }
    if (jid.endsWith('@g.us')) return { name: String((await sock.groupMetadata(jid)).subject || '').slice(0, 80) };
  } catch { /* no name: the web page shows the id */ }
  return { name: '' };
}
// Sent INTO the chat that was just added: news is on, which channels, start date and end date. Only about THIS chat.
async function announce(sock, e) {
  const names = e.sources.map((k) => SOURCES[k]?.name || k).join(', ');
  const when = (ts) => {
    const d = new Date(ts);
    const date = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: TIMEZONE }).format(d);
    const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TIMEZONE }).format(d);
    return `${date}  •  ${time}`;
  };
  const start = e.addedAt || Date.now();
  const end = e.until ? `${when(e.until)} (${e.days} day${e.days === 1 ? '' : 's'})` : 'No end date';
  const fo = footerOf(e);
  const text = ['✅ *Auto news is ON*', '', `📰 ${names}`, `🟢 Start: ${when(start)}`, `🔴 End: ${end}`, '', 'New headlines are posted here by themselves.', '', fo.text].join('\n');
  await sock.sendMessage(e.jid, fo.own ? { text, [NO_FOOTER]: true } : { text });
}

export function adminNewsView() {
  const now = Date.now();
  const items = allTargets().map((t) => {
    const rec = sessions.get(t.sid);
    return { id: t.id, origin: t.origin, jid: t.jid, kind: t.kind, name: t.name || '', sid: t.sid, phone: rec?.phone || '', online: rec?.status === 'connected', sources: t.sources, footer: t.footer, days: t.days || 0, until: t.until || 0, expired: t.expired, addedAt: t.addedAt, stats: statView(t.sid, t.jid) };
  });
  return {
    ok: true, now, poll: { everyMin: Math.round(POLL_MS / 60000), last: lastPollAt },
    totals: { today: items.reduce((n, i) => n + i.stats.today, 0), total: items.reduce((n, i) => n + i.stats.total, 0) },
    sources: ALL.map((k) => ({ key: k, name: SOURCES[k].name, icon: SOURCES[k].icon })),
    items
  };
}
export async function adminNewsAdd(b = {}) {
  const sid = String(b.sid || '');
  const rec = sessions.get(sid);
  if (!rec?.sock || rec.status !== 'connected') throw new Error('Choose a linked number that is online. That number posts the news.');
  const raw = String(b.link || '').trim().slice(0, 300);
  if (!raw) throw new Error('Paste a WhatsApp group link, a channel link, or a jid.');
  let info = null;
  try { info = await resolveInfo(rec.sock, raw); } catch (err) { console.error('News admin resolve error:', err?.message || err); }
  if (!info) throw new Error('I could not read that. Use a WhatsApp group link, a channel link, or a jid ending in @g.us / @newsletter.');
  const sources = cleanSources(b.sources);
  const footer = cleanFooter(b.footer, b.custom, info.name);
  const days = cleanDays(b.days);
  const list = adminList();
  const old = list.find((t) => t.jid === info.jid && t.sid === sid); // same chat + same number: replace it (renew)
  const entry = { id: old?.id || crypto.randomBytes(5).toString('hex'), jid: info.jid, kind: info.kind, name: info.name, sid, sources, footer, days, until: untilOf(days), addedAt: Date.now() };
  saveAdmin(old ? list.map((t) => (t === old ? entry : t)) : [...list, entry]);
  dropStats(sid, info.jid); // a fresh start: the live counter begins at 0
  let notified = true, notifyError = '';
  try { await announce(rec.sock, entry); } catch (err) { notified = false; notifyError = clip(err?.message || err, 120); console.error('News admin announce error:', err?.message || err); }
  return { entry, renewed: !!old, notified, notifyError };
}
const parseCmdId = (id) => { const m = String(id).match(/^c:([\w-]{1,60}):(.+)$/); return m ? { sid: m[1], jid: m[2] } : null; };
export function adminNewsUpdate(id, b = {}) {
  const c = parseCmdId(id);
  if (c) { // added with a command: only the news channels can be changed here
    if (!(c.jid in getTargets(c.sid))) throw new Error('That chat is not in the list any more.');
    if (b.footer !== undefined || b.days !== undefined) throw new Error('Footer and days are for chats added on this page. Remove this chat and add it here to use them.');
    const keys = b.sources !== undefined ? cleanSources(b.sources) : getTargets(c.sid)[c.jid];
    setTarget(c.sid, c.jid, keys);
    return { jid: c.jid, name: getSetting(c.sid, 'newsMeta', {})[c.jid]?.name || '', sources: keys, days: 0, footer: { mode: 'bot' } };
  }
  const list = adminList();
  const t = list.find((x) => x.id === String(id));
  if (!t) throw new Error('That chat is not in the list any more.');
  const next = { ...t };
  if (b.sources !== undefined) next.sources = cleanSources(b.sources);
  if (b.footer !== undefined) next.footer = cleanFooter(b.footer, b.custom ?? t.footer?.custom, t.name);
  if (b.days !== undefined) { next.days = cleanDays(b.days); next.until = untilOf(next.days); } // days counted from today
  saveAdmin(list.map((x) => (x === t ? next : x)));
  return next;
}
export function adminNewsRemove(id) {
  const c = parseCmdId(id);
  if (c) {
    const name = getSetting(c.sid, 'newsMeta', {})[c.jid]?.name || '';
    return removeTarget(c.sid, c.jid) ? { jid: c.jid, name } : null;
  }
  const list = adminList();
  const t = list.find((x) => x.id === String(id));
  if (!t) return null;
  saveAdmin(list.filter((x) => x !== t));
  dropStats(t.sid, t.jid);
  return t;
}

/* ---------- the auto poster ---------- */
let busy = false;
async function poll() {
  if (busy) return;
  busy = true;
  try {
    const wants = {}; // source -> [{ sock, jid, t }]   (t = the admin target, with its footer; none for chats added by command)
    const taken = new Set();
    const now = Date.now();
    for (const t of adminList()) { // added in /admin -> News; stops by itself when the days are over
      if (isExpired(t, now)) continue;
      const rec = sessions.get(t.sid);
      if (!rec?.sock || rec.status !== 'connected') continue;
      taken.add(`${t.sid}|${t.jid}`);
      for (const k of t.sources || []) if (SOURCES[k]) (wants[k] ||= []).push({ sock: rec.sock, sid: t.sid, jid: t.jid, t });
    }
    for (const [sid, rec] of sessions) {
      if (!rec?.sock || rec.status !== 'connected') continue;
      for (const [jid, keys] of Object.entries(getTargets(sid))) {
        if (taken.has(`${sid}|${jid}`)) continue;
        for (const k of keys) (wants[k] ||= []).push({ sock: rec.sock, sid, jid });
      }
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
          try { await post(t.sock, t.jid, key, full, img, footerOf(t.t)); noteStat(t.sid, t.jid, true, full.title); } catch (err) { console.error(`News post to ${t.jid} failed:`, err?.message || err); noteStat(t.sid, t.jid, false, err?.message || 'could not post'); }
          await sleep(1500); // slow and steady: bulk posting is what gets numbers banned
        }
      }
    }
    if (changed) setSetting('_news', 'seen', seenAll);
  } catch (err) { console.error('News poll error:', err?.message || err); }
  finally { busy = false; lastPollAt = Date.now(); }
}
export const newsPollOnce = poll; // used by the tests
if (!globalThis.__rioNewsTimer) {
  globalThis.__rioNewsTimer = true;
  setTimeout(() => { poll(); setInterval(poll, POLL_MS).unref?.(); }, 2 * 60 * 1000).unref?.(); // wait 2 min after start so saved settings are loaded first
}

/* ---------- commands ---------- */
async function headlines(reply, keys, n, showWhy = false) {
  const parts = await Promise.all(keys.map(async (k) => {
    try {
      const items = await Promise.all((await latest(k)).slice(0, n).map(async (i) => ({ ...i, link: await shortLink(i.link) })));
      return [`${SOURCES[k].icon} *${SOURCES[k].name}*`, ...items.map((i, x) => `${x + 1}. ${clip(i.title, 120)}\n   ${i.link}`)].join('\n');
    } catch (err) {
      const why = showWhy ? `\n_${clip(String(err?.message || err).replace(/https?:\/\/(www\.)?/g, '').split(' | ').map((x) => clip(x, 70)).join('\n'), 500)}_` : ''; // owner only: which address failed and why
      return `${SOURCES[k].icon} *${SOURCES[k].name}*\n❌ Could not load right now.${why}`;
    }
  }));
  return reply(`📰 *Latest news*\n\n${parts.join('\n\n')}`);
}
// .hiru            latest headlines        .hiru on / .hiru off   switch this one channel on or off for THIS chat (owner only)
const one = (key) => ({
  name: key, aliases: [`${key}news`], react: SOURCES[key].icon,
  async run({ sock, reply, args, sessionId, jid, isOwner }) {
    const sw = (args[0] || '').toLowerCase();
    if (sw === 'on' || sw === 'off') {
      if (!isOwner) return reply('🚫 Only the bot owner can change auto news.');
      const cur = new Set(getTargets(sessionId)[jid] || []);
      if (sw === 'on') cur.add(key); else cur.delete(key);
      if (cur.size) setTarget(sessionId, jid, [...cur], sw === 'on' ? await chatMeta(sock, jid) : undefined); else removeTarget(sessionId, jid);
      return reply(`${SOURCES[key].icon} ${SOURCES[key].name} auto news is ${sw.toUpperCase()} for this chat.${cur.size ? `\n📰 Now on: ${[...cur].map((k) => SOURCES[k].name).join(', ')}` : ''}`);
    }
    return headlines(reply, [key], 6, isOwner);
  }
});
const names = (keys) => keys.map((k) => SOURCES[k].name).join(', ');

export default [
  { name: 'news', aliases: ['lknews'], react: '📰', async run({ reply, args, isOwner }) { const ks = args.length ? pickKeys(args) : ALL; return headlines(reply, ks, ks.length === 1 ? 6 : 3, isOwner); } },
  one('hiru'), one('derana'), one('itn'), one('swarna'), one('sirasa'),
  {
    name: 'newson', adminOnly: true, aliases: ['autonews'], owner: true, react: '📰',
    async run({ sock, reply, sessionId, jid, args }) {
      const keys = pickKeys(args);
      setTarget(sessionId, jid, keys, await chatMeta(sock, jid));
      return reply(`✅ Auto news is ON for this chat.\n📰 ${names(keys)}\nNew headlines are posted here by themselves (checked every ${Math.round(POLL_MS / 60000)} min).\nTurn off: ${PREFIX}newsoff`);
    }
  },
  {
    name: 'newsadd', adminOnly: true, owner: true, react: '➕',
    async run({ sock, reply, sessionId, args }) {
      if (!args[0]) return reply(`Usage: ${PREFIX}newsadd <group link | channel link | jid> [hiru derana itn swarna sirasa]\nExample: ${PREFIX}newsadd https://whatsapp.com/channel/xxxx hiru derana`);
      let info = null;
      try { info = await resolveInfo(sock, args[0]); } catch (err) { console.error('newsadd resolve error:', err?.message || err); }
      if (!info) return reply('❌ I could not read that. Send a WhatsApp group link, a channel link, or a jid ending in @g.us / @newsletter.');
      const target = info.jid, keys = pickKeys(args.slice(1));
      setTarget(sessionId, target, keys, { name: info.name });
      let told = true; // tell the chat itself that news is now on (and which other chats get news)
      try { await announce(sock, { jid: target, kind: info.kind, name: info.name, sources: keys, footer: { mode: 'bot' }, days: 0, until: 0, addedAt: Date.now() }); } catch (err) { told = false; console.error('newsadd announce error:', err?.message || err); }
      return reply(`✅ Added ${info.kind}${info.name ? ` *${info.name}*` : ''}:\n${target}\n📰 ${names(keys)}\n${told ? '📨 The chat was told that news is on.' : '⚠️ I could not send a message there. Check that this number is a member (groups) or an admin/owner (channels).'}\n\nThe linked number must be a member (groups) or an admin/owner (channels), otherwise WhatsApp will not let the bot post there.`);
    }
  },
  {
    name: 'newsoff', adminOnly: true, aliases: ['stopnews'], owner: true, react: '🔕',
    async run({ reply, sessionId, jid }) { return reply(removeTarget(sessionId, jid) ? '🔕 Auto news is OFF for this chat.' : 'ℹ️ Auto news was not on for this chat.'); }
  },
  {
    name: 'newsdel', adminOnly: true, owner: true, react: '➖',
    async run({ sock, reply, sessionId, args }) {
      let target = null;
      try { target = await resolveTarget(sock, args[0]); } catch { /* fall through */ }
      return reply(target && removeTarget(sessionId, target) ? `🔕 Removed:\n${target}` : `ℹ️ Not found. See ${PREFIX}newslist`);
    }
  },
  {
    name: 'newslist', adminOnly: true, owner: true, react: '📋',
    async run({ reply, sessionId }) {
      const t = Object.entries(getTargets(sessionId));
      if (!t.length) return reply(`📋 No chats yet.\nRun ${PREFIX}newson inside a group, or ${PREFIX}newsadd <link>.`);
      return reply(`📋 *Auto news chats*\n\n${t.map(([j, k], i) => `${i + 1}. ${j.endsWith('@newsletter') ? '📢' : '👥'} ${j}\n   ${names(k)}`).join('\n')}`);
    }
  }
];
