// Web tools.
//   .short <link>   (aliases .shorten .shorturl)   short link (is.gd, then TinyURL if is.gd is down)
//   .ss <link>      (aliases .screenshot .ssweb)   screenshot of a web page.  .ss <link> full = the whole page, not only the top
// Both take the link after the command or from the message that was replied to.
// The screenshot is made by an outside service (thum.io, then Microlink), so this server never opens the page itself.
// Optional env: SCREENSHOT_URL = your own screenshot service; write {url} where the encoded page address goes.
import { PREFIX } from '../lib/config.js';
import { createLimiter } from '../lib/mediatools.js';
import { unwrapMessage } from '../lib/text.js';

const TIMEOUT_MS = 15000;
const SHOT_TIMEOUT_MS = 50000;
const MAX_SHOT_BYTES = 8 * 1048576;
const UA = { 'user-agent': 'RIO-X-MD/1.4 (WhatsApp bot)' };

const lastUse = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of lastUse) if (t - v > 120e3) lastUse.delete(k); }, 5 * 60e3).unref();
function tooSoon(key, ms) {
  const now = Date.now();
  if (now - (lastUse.get(key) || 0) < ms) return true;
  lastUse.set(key, now);
  return false;
}
const who = (sessionId, msg, jid) => `${sessionId}|${msg.key?.participant || jid}`;

/* ---------- reading the link ---------- */
const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

// "example.com/page" or "https://example.com/page" -> a clean https/http address. Anything else (other schemes, logins inside the
// link, local / private addresses, no dot in the name) -> null.
export function normalizeUrl(raw) {
  let s = String(raw || '').trim().replace(/^[<"'(]+|[>"').,;!?]+$/g, '');
  if (!s || s.length > 2000) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+(:\d{1,5})?([/?#]|$)/u.test(s)) return null; // a plain word is not a link
    s = `https://${s}`;
  }
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('[')) return null; // "localhost", IPv6 and one-word hosts
  if (/\.(local|localhost|internal|lan|home|corp|test|invalid)$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_V4.test(host)) return null;
  return u.toString();
}

function quotedText(msg) {
  const q = unwrapMessage(msg.message).extendedTextMessage?.contextInfo?.quotedMessage;
  if (!q) return '';
  const m = unwrapMessage(q);
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';
}

// The link typed after the command, else the first link in the replied-to message.
function linkFrom(args, msg) {
  const typed = args.find((a) => normalizeUrl(a));
  if (typed) return normalizeUrl(typed);
  const found = quotedText(msg).match(/(?:https?:\/\/|www\.)[^\s<>"']+/i)?.[0];
  return found ? normalizeUrl(found) : null;
}

/* ---------- .short ---------- */
async function isgd(url) {
  const res = await fetch(`https://is.gd/create.php?${new URLSearchParams({ format: 'json', url })}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: UA });
  const data = await res.json().catch(() => null);
  if (data?.shorturl) return String(data.shorturl);
  throw new Error(`is.gd: ${data?.errormessage || `HTTP ${res.status}`}`);
}
async function tinyurl(url) {
  const res = await fetch(`https://tinyurl.com/api-create.php?${new URLSearchParams({ url })}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: UA });
  const text = (await res.text()).trim();
  if (res.ok && /^https?:\/\/(www\.)?tinyurl\.com\/\S+$/i.test(text)) return text;
  throw new Error(`tinyurl: HTTP ${res.status}`);
}
export async function shorten(url) {
  const errors = [];
  for (const svc of [isgd, tinyurl]) {
    try { return await svc(url); } catch (err) { errors.push(err?.message || String(err)); }
  }
  throw new Error(errors.join(' | '));
}

const short = {
  name: 'short', aliases: ['shorten', 'shorturl'], react: '🔗',
  async run({ msg, jid, sessionId, args, reply }) {
    const url = linkFrom(args, msg);
    if (!url) return reply(`🔗 *Link shortener*\nUsage: ${PREFIX}short <link>  (or reply to a message that has a link)\nExample: ${PREFIX}short https://example.com/a/very/long/address`);
    if (tooSoon(`short|${who(sessionId, msg, jid)}`, 3000)) return reply('⏳ Wait a few seconds before the next one.');
    try {
      const link = await shorten(url);
      return await reply(`🔗 *Short link*\n${link}\n\n📎 ${url.length > 70 ? `${url.slice(0, 67)}...` : url}`);
    } catch (err) {
      console.error('short error:', err?.message || err);
      return reply('❌ The link shortener is not answering right now. Try again in a little while.');
    }
  },
};

/* ---------- .ss ---------- */
const shotLimit = createLimiter(Math.max(1, Number(process.env.MAX_SS_JOBS || 2)));

// Screenshot services, tried in this order. Each gets the page address and returns the address of the picture.
const providers = (url, full) => [
  ...(process.env.SCREENSHOT_URL ? [process.env.SCREENSHOT_URL.replace('{url}', encodeURIComponent(url))] : []),
  `https://image.thum.io/get/${full ? 'fullpage/' : ''}width/1280/noanimate/${url}`,
  `https://api.microlink.io/?${new URLSearchParams({ url, screenshot: 'true', meta: 'false', embed: 'screenshot.url', 'viewport.width': '1280', 'viewport.height': '800', ...(full ? { 'screenshot.fullPage': 'true' } : {}) })}`,
];

const isImage = (b) => b.length > 2048 && (
  (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||                 // PNG
  (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||                                  // JPEG
  (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'));  // WebP

export async function screenshot(url, full = false) {
  const errors = [];
  for (const endpoint of providers(url, full)) {
    try {
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(SHOT_TIMEOUT_MS), headers: UA, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (Number(res.headers.get('content-length') || 0) > MAX_SHOT_BYTES) throw new Error('picture too big');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_SHOT_BYTES) throw new Error('picture too big');
      if (!isImage(buf)) throw new Error('not a picture');
      return buf;
    } catch (err) { errors.push(`${new URL(endpoint).host}: ${err?.message || err}`); }
  }
  throw new Error(errors.join(' | '));
}

const ss = {
  name: 'ss', aliases: ['screenshot', 'ssweb'], react: '📸',
  async run({ sock, msg, jid, sessionId, args, reply }) {
    const full = args.some((a) => /^(full|fullpage)$/i.test(a));
    const url = linkFrom(args.filter((a) => !/^(full|fullpage)$/i.test(a)), msg);
    if (!url) return reply(`📸 *Website screenshot*\nUsage: ${PREFIX}ss <link>  (or reply to a message that has a link)\n${PREFIX}ss <link> full = the whole page\nExample: ${PREFIX}ss example.com`);
    if (tooSoon(`ss|${who(sessionId, msg, jid)}`, 10000)) return reply('⏳ One screenshot at a time please. Try again in a few seconds.');
    reply('⏳ Taking the screenshot… this can take up to a minute.').catch(() => {});
    try {
      const image = await shotLimit(() => screenshot(url, full));
      return await sock.sendMessage(jid, { image, caption: `📸 ${url.length > 120 ? `${url.slice(0, 117)}...` : url}` }, { quoted: msg });
    } catch (err) {
      console.error('ss error:', err?.message || err);
      return reply('❌ Could not take a screenshot of that page. The site may block screenshots, or the service is busy. Try again later.');
    }
  },
};

export default [short, ss];
