// Per-session branding (premium only): bot name, footer text and logo picture.
// Saved with the other per-session settings as brandName / brandFooter / brandLogo.
// Branding only applies while the number has active premium. When premium ends the saved values stay, but the defaults are used.
//
// One choke point: registerSock() wraps sock.sendMessage, so every text / caption / link-preview card a session sends
// has the default bot name and the default footer (DEFAULT_FOOTER below) swapped for that session's own. Interactive (button / carousel)
// messages are built by hand, so those call applyBrand() themselves.
// This file must not import premium.js / card.js / menu.js (they import this one).
import dns from 'node:dns/promises';
import net from 'node:net';
import { BOT_NAME } from './config.js';
import { getSetting } from './storage.js';

export const DEFAULT_FOOTER = '🍃💗⃝⃘⃘̬ٜٜٜ̬͞͠. ©ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʀɪᴏ x ᴍᴅ 𒈒';
export const BRAND_KEYS = ['brandName', 'brandFooter', 'brandLogo'];
export const BRAND_LIMITS = { brandName: 30, brandFooter: 60, brandLogo: 400 };

const socks = new WeakMap(); // sock -> session id
const hasPremium = (sid) => Number(getSetting(sid, 'premium', null)?.until || 0) > Date.now();

// Text cleaning: no control characters, no line breaks, no leading ">" (would turn into a quote), trimmed and capped.
export function cleanBrandText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').replace(/^[>\s]+/, '').trim().slice(0, max);
}

/* ---------- which brand does this connection use? ---------- */
export function registerSock(sock, sid) {
  socks.set(sock, sid);
  if (sock.__brandWrapped) return;
  sock.__brandWrapped = true;
  const original = sock.sendMessage.bind(sock);
  sock.sendMessage = (jid, content, options) => original(jid, brandContent(sock, content), options);
}

export function brandOf(sock) {
  const sid = socks.get(sock);
  if (!sid || !hasPremium(sid)) return null;
  const name = cleanBrandText(getSetting(sid, 'brandName', ''), BRAND_LIMITS.brandName);
  const footer = cleanBrandText(getSetting(sid, 'brandFooter', ''), BRAND_LIMITS.brandFooter);
  const logo = String(getSetting(sid, 'brandLogo', '') || '');
  return name || footer || logo ? { name, footer, logo } : null;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SWAP = new RegExp(`${esc(BOT_NAME)}|${esc(DEFAULT_FOOTER)}`, 'g');
// One pass, so a custom name that contains the default text is never replaced twice.
export function applyBrand(sock, text) {
  if (typeof text !== 'string') return text;
  const b = brandOf(sock);
  if (!b || (!b.name && !b.footer)) return text;
  return text.replace(SWAP, (m) => (m === BOT_NAME ? b.name || m : b.footer || m));
}

function brandContent(sock, content) {
  if (!content || typeof content !== 'object' || !brandOf(sock)) return content;
  const out = { ...content };
  if (typeof out.text === 'string') out.text = applyBrand(sock, out.text);
  if (typeof out.caption === 'string') out.caption = applyBrand(sock, out.caption);
  const ad = out.contextInfo?.externalAdReply;
  if (ad) out.contextInfo = { ...out.contextInfo, externalAdReply: { ...ad, title: applyBrand(sock, ad.title), body: applyBrand(sock, ad.body) } };
  return out;
}

/* ---------- logo picture (the user gives a link; it is downloaded safely and cached) ---------- */
const MAX_LOGO_BYTES = 3 * 1024 * 1024;
const LOGO_TYPES = /^image\/(jpeg|jpg|png|webp)$/i;

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateIp(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

// Link rules: https only, a real host name (no IP address, no localhost), nothing that points inside the server.
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('That is not a valid link.'); }
  if (u.protocol !== 'https:') throw new Error('The logo link must start with https://');
  if (u.username || u.password) throw new Error('The logo link cannot contain a login.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) || host === 'localhost' || !host.includes('.')) throw new Error('Use a normal picture link (a host name, not an IP address).');
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error('That link could not be reached.'); }
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error('That link is not allowed.');
  return u;
}

async function downloadLogo(raw) {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) { // redirects are followed by hand so every step is checked
    const u = await assertPublicUrl(url);
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; RIO-X-MD)' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), u).href; continue; }
    if (!res.ok) throw new Error(`The picture could not be downloaded (HTTP ${res.status}).`);
    if (!LOGO_TYPES.test(String(res.headers.get('content-type') || '').split(';')[0].trim())) throw new Error('The link must be a JPG, PNG or WEBP picture.');
    if (Number(res.headers.get('content-length') || 0) > MAX_LOGO_BYTES) throw new Error('The picture is too big (max 3 MB).');
    const chunks = []; let size = 0;
    for await (const c of res.body) { // stop early when there is no Content-Length
      size += c.length;
      if (size > MAX_LOGO_BYTES) { try { await res.body.cancel(); } catch {} throw new Error('The picture is too big (max 3 MB).'); }
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    if (buf.length < 200) throw new Error('The picture is empty.');
    return buf;
  }
  throw new Error('Too many redirects.');
}

const LOGO_TTL = 60 * 60 * 1000, LOGO_RETRY = 2 * 60 * 1000;
const logoCache = new Map(); // url -> { buf, at } | { pending }
export function getLogo(url) {
  const c = logoCache.get(url);
  if (c?.pending) return c.pending;
  if (c && Date.now() - c.at < (c.buf ? LOGO_TTL : LOGO_RETRY)) return Promise.resolve(c.buf);
  const pending = downloadLogo(url)
    .catch((err) => { console.error('Brand logo error:', err?.message || err); return null; })
    .then((buf) => {
      logoCache.set(url, { buf, at: Date.now() });
      if (logoCache.size > 200) logoCache.delete(logoCache.keys().next().value);
      return buf;
    });
  logoCache.set(url, { pending });
  return pending;
}
// Buffer of this session's logo, or null (not premium, no logo, or the download failed). Callers then use the default picture.
export async function logoBuffer(sock) {
  const b = brandOf(sock);
  return b?.logo ? getLogo(b.logo) : null;
}
// Used when the user saves a logo link: fails with a readable message if the link is not a usable picture.
export async function checkLogo(url) {
  logoCache.delete(url);
  const buf = await downloadLogo(url);
  logoCache.set(url, { buf, at: Date.now() });
  return true;
}
