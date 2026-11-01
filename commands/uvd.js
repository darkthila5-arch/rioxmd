// .uvd <ukussa.net link | video name>: download the video of a ukussa.net page and send it as a DOCUMENT (premium numbers, owner only).
// A name instead of a link: the site's search is used, the best matches are listed, and  .uvd 1  (or 2, 3 ...) picks one.
// Steps: read the page -> look for the video file (og:video, <video>/<source>, a .mp4 / .m3u8 / .webm link in the page or in an embedded player)
// -> download it with the page as Referer. If nothing is found, yt-dlp gets the page itself as a last try.
import dns from 'node:dns/promises';
import net from 'node:net';
import { MAX_DL_BYTES, fetchBuffer, tooBigText, ytDlpFile } from '../lib/downloader.js';
import { PREFIX } from '../lib/config.js';

const SITE = /(^|\.)ukussa\.net$/i;
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const VIDEO_RE = /https?:(?:\\?\/){2}[^\s"'<>\\]+?\.(?:mp4|m3u8|webm|mov|mkv)(?:\?[^\s"'<>\\]*)?/gi;

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  const m = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return m ? privateIp(m[1]) : v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}
async function assertPublic(raw) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error('bad link');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || net.isIP(host) || !host.includes('.')) throw new Error('bad link');
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error('bad link');
  return u;
}

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

async function getHtml(url, referer) {
  await assertPublic(url);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*', ...(referer ? { referer } : {}) }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`page ${res.status}`);
  const text = await res.text();
  return { html: text.slice(0, 2_000_000), finalUrl: res.url || url };
}

// All video file links found in a page, best first (mp4 before m3u8).
function findVideos(html, base) {
  const out = [];
  const add = (v) => {
    if (!v) return;
    try { out.push(new URL(decode(v).replace(/\\\//g, '/').replace(/\\u0026/g, '&'), base).href); } catch { /* ignore */ }
  };
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["']og:video(?::secure_url|:url)?["'][^>]*content=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:video(?::secure_url|:url)?["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<(?:video|source)\b[^>]*\bsrc=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/["'](?:file|src|source|video_url|contentUrl|url)["']\s*:\s*["']([^"']+?\.(?:mp4|m3u8|webm|mov)[^"']*)["']/gi)) add(m[1]);
  for (const m of html.matchAll(VIDEO_RE)) add(m[0]);
  const seen = new Set();
  const list = out.filter((u) => /\.(mp4|m3u8|webm|mov|mkv)(\?|#|$)/i.test(u) || /og:video/.test(u) || true).filter((u) => (seen.has(u) ? false : seen.add(u)));
  const rank = (u) => (/\.mp4(\?|$)/i.test(u) ? 0 : /\.webm(\?|$)/i.test(u) ? 1 : /\.m3u8(\?|$)/i.test(u) ? 3 : 2);
  return list.sort((a, b) => rank(a) - rank(b));
}
const iframes = (html, base) => [...html.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => { try { return new URL(decode(m[1]), base).href; } catch { return null; } }).filter(Boolean).slice(0, 3);

function fileName(pageUrl, ext) {
  const slug = decodeURIComponent(new URL(pageUrl).pathname.split('/').filter(Boolean).pop() || 'video').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 50) || 'video';
  return `${slug}.${ext || 'mp4'}`;
}

/* ---------- search by name ---------- */
const SEARCH_URLS = [
  (q) => `https://ukussa.net/?s=${encodeURIComponent(q)}`,
  (q) => `https://ukussa.net/search/${encodeURIComponent(q)}`,
  (q) => `https://ukussa.net/search?q=${encodeURIComponent(q)}`,
  (q) => `https://ukussa.net/search?query=${encodeURIComponent(q)}`,
  (q) => `https://ukussa.net/?search=${encodeURIComponent(q)}`,
];
const SKIP_PATH = /^\/(category|categories|tag|tags|page|author|wp-|feed|search|login|register|contact|about|privacy|dmca|terms|cdn-cgi)(\/|$)/i;
const stripTags = (t) => decode(String(t || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const slugTitle = (u) => decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[-_+]+/g, ' ').trim();
function findResults(html, base) {
  const out = [], seen = new Set();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let u; try { u = new URL(decode(href), base); } catch { continue; }
    if (!SITE.test(u.hostname) || /[?&](s|q|search|query)=/.test(u.search) || SKIP_PATH.test(u.pathname) || u.pathname.replace(/\//g, '').length < 4) continue;
    u.hash = '';
    const title = stripTags(m[2]) || stripTags(m[1].match(/\btitle=["']([^"']+)["']/i)?.[1]) || stripTags(m[2].match(/\balt=["']([^"']+)["']/i)?.[1]) || slugTitle(u);
    if (title.length < 3 || /^(read more|more|next|previous|home|watch|download|login|register)$/i.test(title) || seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ url: u.href, title: title.slice(0, 80) });
    if (out.length >= 8) break;
  }
  return out;
}
// Returns { list, notes }: notes = short reasons when nothing was found (shown to the owner so a failure can be traced).
async function searchSite(q) {
  const notes = [];
  try { // WordPress sites answer this with clean JSON
    await assertPublic('https://ukussa.net/');
    const res = await fetch(`https://ukussa.net/wp-json/wp/v2/posts?per_page=8&_fields=link,title&search=${encodeURIComponent(q)}`, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = await res.json();
      const list = (Array.isArray(data) ? data : []).map((d) => ({ url: d.link, title: stripTags(d.title?.rendered).slice(0, 80) })).filter((d) => d.url && SITE.test(new URL(d.url).hostname));
      if (list.length) return { list, notes };
      notes.push('api: empty');
    } else notes.push(`api: ${res.status}`);
  } catch (e) { notes.push(`api: ${e?.message || e}`.slice(0, 40)); }
  for (const make of SEARCH_URLS) {
    const url = make(q);
    try {
      const { html, finalUrl } = await getHtml(url);
      const list = findResults(html, finalUrl);
      if (list.length) return { list, notes };
      notes.push(`${new URL(url).pathname.slice(0, 10)}${new URL(url).search.slice(0, 4)}: 0 links (${html.length} bytes)`);
    } catch (e) { notes.push(`${new URL(url).pathname.slice(0, 10)}: ${e?.message || e}`.slice(0, 40)); }
  }
  console.error('uvd search found nothing:', notes.join(' | '));
  return { list: [], notes };
}
const picks = new Map(); // chat + sender -> { list, at }  (the last search, for  .uvd 1 )
const pickKey = (jid, msg) => `${jid}|${msg.key?.participant || ''}`;

export default [
  {
    name: 'uvd', aliases: ['uvdl'], owner: true, premium: true, react: '📥',
    async run({ sock, msg, jid, args, reply }) {
      const input = args.join(' ').trim();
      let page = null;
      try { const u = new URL(args[0] || ''); if (/^https?:$/.test(u.protocol) && SITE.test(u.hostname)) page = u; } catch { /* not a link */ }
      if (!page && /^[1-8]$/.test(input)) { // pick from the last search
        const last = picks.get(pickKey(jid, msg));
        const item = last && Date.now() - last.at < 15 * 60 * 1000 ? last.list[Number(input) - 1] : null;
        if (!item) return reply(`❌ No search to pick from. Search first: *${PREFIX}uvd <video name>*`);
        page = new URL(item.url);
      }
      if (!page) {
        if (!input || /^https?:\/\//i.test(input)) return reply(`📥 Use:\n*${PREFIX}uvd <video name>* (search, then ${PREFIX}uvd 1 to pick)\n*${PREFIX}uvd <link>*\nThe video comes back as a document.`);
        await reply(`🔎 Searching *${input}*...`);
        const { list, notes } = await searchSite(input);
        if (!list.length) return reply(`❌ Nothing found for that name. Try other words, or send the video link.\n\n🛠️ ${notes.slice(0, 4).join('\n🛠️ ')}`);
        picks.set(pickKey(jid, msg), { list, at: Date.now() });
        if (picks.size > 200) picks.delete(picks.keys().next().value);
        return reply(['╭━━━〔 🔎 *RESULTS* 〕━━━⬣', ...list.map((r, i) => `┃ ${i + 1}. ${r.title}`), '╰━━━━━━━━━━━━━━━━━━━━⬣', '', `▸ Send *${PREFIX}uvd <number>* (example: ${PREFIX}uvd 1) to download.`].join('\n'));
      }
      await reply('⏳ Getting the video...');
      let buf = null, ext = 'mp4', lastErr = null;
      try {
        let { html, finalUrl } = await getHtml(page.href);
        let cands = findVideos(html, finalUrl);
        if (!cands.length) { // maybe the player is in an iframe
          for (const f of iframes(html, finalUrl)) {
            try { const r = await getHtml(f, finalUrl); cands = findVideos(r.html, r.finalUrl); if (cands.length) { finalUrl = r.finalUrl; break; } } catch { /* next */ }
          }
        }
        for (const c of cands.slice(0, 4)) {
          if (/\.m3u8(\?|#|$)/i.test(c)) { // a stream list: yt-dlp / ffmpeg joins the pieces
            try { const r = await ytDlpFile(c, 'uvd', { format: 'best' }); buf = r.buf; ext = r.ext || 'mp4'; break; } catch (e) { lastErr = e; continue; }
          }
          try {
            await assertPublic(c);
            buf = await fetchBuffer(c, { 'user-agent': UA, referer: page.href });
            ext = (c.match(/\.(mp4|webm|mov|mkv)(\?|#|$)/i)?.[1] || 'mp4').toLowerCase();
            break;
          } catch (e) { lastErr = e; if (e?.message === 'TOO_BIG') break; }
        }
      } catch (e) { lastErr = e; console.error('uvd page error:', e?.message || e); }
      if (!buf && lastErr?.message !== 'TOO_BIG') { // last try: let yt-dlp read the page itself
        try { const r = await ytDlpFile(page.href, 'uvd'); buf = r.buf; ext = r.ext || 'mp4'; } catch (e) { lastErr = e; console.error('uvd yt-dlp error:', e?.message || e); }
      }
      if (!buf) {
        if (lastErr?.message === 'TOO_BIG') return reply(tooBigText());
        return reply('❌ Could not find a video on that page.\nCheck the link, or tell the host admin (the page layout may have changed).');
      }
      try {
        return await sock.sendMessage(jid, { document: buf, mimetype: ext === 'webm' ? 'video/webm' : 'video/mp4', fileName: fileName(page.href, ext), caption: `📥 ${(buf.length / 1048576).toFixed(1)} MB` }, { quoted: msg });
      } catch (e) {
        console.error('uvd send error:', e?.message || e);
        return reply('❌ Could not send the file. Try again.');
      }
    },
  },
];
