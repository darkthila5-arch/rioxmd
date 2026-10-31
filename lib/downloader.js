import fs from 'node:fs';
import { FOOTER_LINE, FOOTER_TEXT } from './brand.js';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { BOT_NAME, MENU_IMAGE, PREFIX, ROOT_DIR, sleep, state } from './config.js';
import { say } from './card.js';
import { qr, sendRich } from './menu.js';

/* ---------- downloader (TikTok / Facebook) ---------- */

export const MAX_DL_BYTES = Number(process.env.MAX_DL_MB || 50) * 1024 * 1024;
const PIN_HOSTS = /(^|\.)(pinterest\.[a-z.]{2,}|pin\.it)$/i;
const PINIMG_HOSTS = /(^|\.)pinimg\.com$/i;
// One table for every supported site: its name, its command, and which hosts are accepted.
// Sinhala "send a proper link" line shown under the error for each site (same style as the TikTok one).
const NAG = (site) => `හරියට ${site} ලින්ක් එක එවපං බං UttA😑`;
export const NAGS = { tiktok: NAG('ටික් ටොක්'), facebook: NAG('ෆේස්බුක්'), pinterest: NAG('පින්ටරස්ට්'), instagram: NAG('ඉන්ස්ටග්‍රෑම්'), twitter: NAG('ට්විටර්'), youtube: NAG('යූටියුබ්') };
const PLATFORMS = {
  tiktok:    { label: 'TikTok',      cmd: 'tt',  hosts: /(^|\.)tiktok\.com$/i },
  facebook:  { label: 'Facebook',    cmd: 'fb',  hosts: /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/i },
  pinterest: { label: 'Pinterest',   cmd: 'pin', hosts: PIN_HOSTS },
  instagram: { label: 'Instagram',   cmd: 'ig',  hosts: /(^|\.)(instagram\.com|instagr\.am)$/i },
  twitter:   { label: 'Twitter / X', cmd: 'tw',  hosts: /(^|\.)(twitter\.com|x\.com|t\.co)$/i },
};

// At most N downloads / yt-dlp runs at the same time (default 3). Extra ones wait in line, so many users
// downloading together can never exhaust the server's RAM and CPU.
const MAX_JOBS = Math.max(1, Number(process.env.MAX_DL_JOBS || 3));
let activeJobs = 0;
const jobQueue = [];
const acquireJob = () => (activeJobs < MAX_JOBS ? (activeJobs++, Promise.resolve()) : new Promise((r) => jobQueue.push(r)));
const releaseJob = () => { const next = jobQueue.shift(); if (next) next(); else activeJobs--; };
export async function limited(fn) {
  await acquireJob();
  try { return await fn(); } finally { releaseJob(); }
}
const pendingDl = new Map(); // token -> { info, platform, expires }

export function parseUrl(raw, platform) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const hosts = PLATFORMS[platform]?.hosts;
  return hosts?.test(u.hostname) ? u.toString() : null;
}

// Pinterest: read the public pin page (og tags + embedded JSON) and pick the best image / video.
const decodeHtml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function parsePinHtml(html) {
  const text = String(html || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  const meta = (name) => {
    const m = text.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'))
      || text.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i'));
    return m ? decodeHtml(m[1]) : '';
  };
  const pinHost = (u) => { try { return PINIMG_HOSTS.test(new URL(u).hostname); } catch { return false; } };

  // video: prefer mp4 (720p first), skip HLS playlists
  const mp4s = [...new Set(text.match(/https:\/\/v\d*\.pinimg\.com\/videos\/[^"'\\\s<>]+?\.mp4/g) || [])];
  const video = mp4s.find((u) => /720p/i.test(u)) || mp4s[0] || (pinHost(meta('og:video')) && /\.mp4/i.test(meta('og:video')) ? meta('og:video') : '');

  // image: original size when possible
  let image = '';
  const orig = text.match(/"orig"\s*:\s*\{[^}]*?"url"\s*:\s*"(https:\/\/i\.pinimg\.com\/[^"]+)"/);
  if (orig) image = orig[1];
  if (!image) {
    const og = meta('og:image');
    if (pinHost(og)) image = og.replace(/\/\d+x(\d+)?\//, '/originals/');
  }
  const title = (meta('og:title') || meta('twitter:title') || '').replace(/\s*\|\s*Pinterest.*$/i, '').trim();
  const thumb = pinHost(meta('og:image')) ? meta('og:image') : image;
  return { title, video: video || '', image: image || '', thumb };
}

export async function pinterest(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9'
    },
    signal: AbortSignal.timeout(30000)
  });
  let finalHost = '';
  try { finalHost = new URL(res.url).hostname; } catch {}
  if (!PIN_HOSTS.test(finalHost)) throw new Error('Redirected outside Pinterest');
  if (!res.ok) throw new Error(`Pinterest page gave HTTP ${res.status}`);
  const parsed = parsePinHtml(await res.text());
  if (!parsed.video && !parsed.image) throw new Error('No media found on that pin');
  return { title: parsed.title, author: '', thumb: parsed.thumb || parsed.image, video: parsed.video, image: parsed.image, audio: null, headers: {} };
}

async function runYtDlp(url) {
  await ytdlpReady;
  return limited(() => new Promise((resolve, reject) => {
    execFile(state.ytdlp, ['-J', '--no-playlist', '--no-warnings', '-f', 'best[ext=mp4]/best', '--', url],
      { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try {
          const j = JSON.parse(stdout);
          if (!j.url) return reject(new Error('yt-dlp returned no direct url'));
          const headers = { ...(j.http_headers || {}) };
          if (j.cookies) headers.Cookie = j.cookies; // TikTok's CDN answers 403 without these
          resolve({ title: j.title || '', author: j.uploader || '', thumb: j.thumbnail || '', video: j.url, audio: null, headers, viaYtDlp: true });
        } catch (e) { reject(e); }
      });
  }));
}

export async function tikwm(url, attempt = 0) {
  const res = await fetch('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
    body: new URLSearchParams({ url, hd: '1' }),
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); }
  catch {
    if (attempt < 1 && res.status !== 403) { await sleep(1500); return tikwm(url, attempt + 1); } // free API allows ~1 request/second
    throw new Error(`tikwm gave an empty/invalid reply (HTTP ${res.status})`);
  }
  if (j.code !== 0 || !j.data) throw new Error(j.msg || 'tikwm failed');
  const abs = (v) => (v ? (v.startsWith('/') ? `https://www.tikwm.com${v}` : v) : null);
  const d = j.data;
  return { title: d.title || '', author: d.author?.nickname || '', thumb: abs(d.cover), video: abs(d.hdplay || d.play), audio: abs(d.music), headers: {} };
}

const ytdlpWorks = (bin) => new Promise((r) => execFile(bin, ['--version'], { timeout: 20000 }, (e) => r(!e)));
// Downloads the standalone yt-dlp binary (no Python needed) if it is not installed yet.
async function ensureYtDlp() {
  if (await ytdlpWorks(state.ytdlp)) return true;
  if (process.platform !== 'linux') { console.error('yt-dlp is not installed. Install it or set YTDLP_PATH.'); return false; }
  const asset = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  const target = path.join(ROOT_DIR, 'bin', 'yt-dlp');
  try {
    console.log('yt-dlp not found, downloading...');
    const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    state.ytdlp = target;
    const ok = await ytdlpWorks(state.ytdlp);
    console.log(ok ? 'yt-dlp installed.' : 'yt-dlp downloaded but does not run.');
    return ok;
  } catch (err) {
    console.error('Could not install yt-dlp:', err?.message || err);
    return false;
  }
}
export const ytdlpReady = ensureYtDlp();

async function resolveMedia(platform, url) {
  if (platform === 'pinterest') {
    try { return await pinterest(url); }
    catch (err) { console.error('Pinterest scrape failed, trying yt-dlp:', err?.message || err); }
  }
  if (platform === 'tiktok') {
    try { return await tikwm(url); }
    catch (err) { console.error('tikwm failed, trying yt-dlp:', err?.message || err); }
  }
  return runYtDlp(url);
}

// Streams the body and stops the moment it passes the size limit (the old code first loaded the WHOLE file into RAM, then checked).
export function fetchBuffer(url, headers = {}) {
  return limited(async () => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > MAX_DL_BYTES) { res.body?.cancel().catch(() => {}); throw new Error('TOO_BIG'); }
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_DL_BYTES) throw new Error('TOO_BIG'); // leaving the loop cancels the download
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  });
}

// Optional YouTube cookies (Netscape cookies.txt content in the YTDLP_COOKIES env) for when YouTube asks "confirm you're not a bot".
const COOKIE_FILE = path.join(os.tmpdir(), 'ytdlp-cookies.txt');
if (process.env.YTDLP_COOKIES) { try { fs.writeFileSync(COOKIE_FILE, process.env.YTDLP_COOKIES.replace(/\\n/g, '\n'), { mode: 0o600 }); } catch {} }
// Preferred: add cookies.txt as a Render "Secret File" (Environment -> Secret Files, filename cookies.txt). It is copied so yt-dlp can write to it.
const SECRET_COOKIES = process.env.YTDLP_COOKIES_FILE || '/etc/secrets/cookies.txt';
try { if (fs.existsSync(SECRET_COOKIES)) { fs.copyFileSync(SECRET_COOKIES, COOKIE_FILE); fs.chmodSync(COOKIE_FILE, 0o600); console.log('YouTube cookies loaded.'); } } catch (err) { console.error('Could not load cookies file:', err?.message || err); }
const cookieArgs = () => (fs.existsSync(COOKIE_FILE) ? ['--cookies', COOKIE_FILE] : []);

// Lets yt-dlp itself download the file (it knows the right headers/cookies for each site).
async function ytDlpFile(url, token, opts = {}) {
  await ytdlpReady;
  return limited(() => ytDlpFileNow(url, token, opts));
}
async function ytDlpFileNow(url, token, { format = 'best[ext=mp4]/best', cookies = false, extractorArgs = null } = {}) {
  const prefix = `rio-${token}-${Math.random().toString(36).slice(2, 6)}`;
  const template = path.join(os.tmpdir(), `${prefix}.%(ext)s`);
  const args = ['--no-playlist', '--no-warnings', '--max-filesize', `${Math.round(MAX_DL_BYTES / 1048576)}M`, '-f', format, '-o', template, ...(cookies ? cookieArgs() : []), ...(extractorArgs ? ['--extractor-args', extractorArgs] : []), '--', url];
  const run = (extra) => new Promise((resolve, reject) => {
    execFile(state.ytdlp, [...extra, ...args], { timeout: 240000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(err) : resolve(`${stdout}\n${stderr}`)));
  });
  let output;
  try { output = await run(['--js-runtimes', 'node']); } // newer yt-dlp needs a JavaScript runtime to read YouTube formats ("Requested format is not available"); Node is in the image
  catch (err) {
    if (!/no such option|unrecognized arguments/i.test(String(err?.message))) throw err;
    output = await run([]); // an older yt-dlp does not know the flag
  }
  const file = fs.readdirSync(os.tmpdir()).find((f) => f.startsWith(prefix) && !f.endsWith('.part'));
  if (!file) throw new Error(/larger than/i.test(output) ? 'TOO_BIG' : 'yt-dlp produced no file');
  const full = path.join(os.tmpdir(), file);
  try {
    const buf = fs.readFileSync(full);
    if (buf.length > MAX_DL_BYTES) throw new Error('TOO_BIG');
    return { buf, ext: path.extname(file).slice(1).toLowerCase() };
  } finally { try { fs.unlinkSync(full); } catch {} }
}
const ytDlpDownload = async (url, token) => (await ytDlpFile(url, token)).buf;

async function getVideoBuffer(info, token) {
  try { return await fetchBuffer(info.video, info.headers); }
  catch (err) {
    if (err?.message === 'TOO_BIG' || !info.sourceUrl) throw err;
    console.error('Direct download failed, using yt-dlp download:', err?.message || err);
    return ytDlpDownload(info.sourceUrl, token);
  }
}

export async function startDownload(sock, jid, msg, platform, rawUrl) {
  const reply = (t) => say(sock, jid, t, msg);
  const { label, cmd } = PLATFORMS[platform] || PLATFORMS.facebook;
  const url = parseUrl(rawUrl, platform);
  if (!url) return reply(`❌ Send a valid ${label} link.\n${NAGS[platform] || ''}\nExample: ${PREFIX}${cmd} <${label} link>`);
  await reply(`⏳ Fetching ${label} ${platform === 'pinterest' ? 'pin' : 'video'}...`);
  let info;
  try { info = await resolveMedia(platform, url); }
  catch (err) {
    console.error(`${label} resolve error:`, err?.stderr || err?.message || err);
    return reply(`❌ Could not fetch that ${label} video. It may be private, removed, or the downloader is unavailable.\n\nහරියට ගිහින් වීඩියෝ එක තීනවද බලලා දීපන් ලින්ක් එක 😑😒`);
  }
  info.sourceUrl = url;

  // Pinterest image pin: no format choice needed, send the picture straight away.
  if (platform === 'pinterest' && info.image && !info.video) {
    const cap = `📌 ${(info.title || 'Pinterest image').slice(0, 200)}\n\n${FOOTER_LINE}`;
    let buf = null;
    for (const candidate of [info.image, info.thumb]) {
      if (!candidate) continue;
      try { buf = await fetchBuffer(candidate); break; } catch (err) { console.error('Pinterest image download failed:', err?.message || err); }
    }
    if (!buf) return reply('❌ Could not download that image.\n\nෆොටෝ එක ගන්න බැරි උනා බං, ආයෙ ට්‍රයි කරපන් 😒');
    return sock.sendMessage(jid, { image: buf, caption: cap }, { quoted: msg });
  }

  const token = crypto.randomBytes(4).toString('hex');
  pendingDl.set(token, { info, platform, expires: Date.now() + 10 * 60 * 1000 });
  const p = PREFIX;
  const caption = [
    `╭━━━〔 📥 *${label.toUpperCase()} DOWNLOADER* 〕━━━⬣`,
    `┃ 🎬 ${(info.title || 'No title').slice(0, 120)}`,
    info.author ? `┃ 👤 ${info.author}` : null,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    '👇 Select the file format'
  ].filter((l) => l !== null).join('\n');
  const buttons = [
    qr('🎬 Video', `${p}dl video ${token}`),
    ...(platform === 'pinterest' ? [] : [qr('🎵 Audio', `${p}dl audio ${token}`)]),
    qr('📄 Document', `${p}dl doc ${token}`)
  ];
  return sendRich(sock, jid, { caption, buttons, footer: FOOTER_TEXT, image: info.thumb || MENU_IMAGE }, msg);
}

export async function sendDownload(sock, jid, msg, kind, token) {
  const reply = (t) => say(sock, jid, t, msg);
  const entry = pendingDl.get(String(token || ''));
  if (!entry || entry.expires < Date.now()) return reply(`⌛ This download request expired. Send the link again with ${PREFIX}tt or ${PREFIX}fb.`);
  const { info } = entry;
  const safeName = `${BOT_NAME.replace(/\W+/g, '-')}-${String(token)}`;
  try {
    await reply(kind === 'audio' ? '⏳ Preparing audio...' : '⏳ Downloading...');
    if (kind === 'audio') {
      const buf = info.audio ? await fetchBuffer(info.audio) : await getVideoBuffer(info, token);
      return sock.sendMessage(jid, { audio: buf, mimetype: info.audio ? 'audio/mpeg' : 'audio/mp4', ptt: false }, { quoted: msg });
    }
    const buf = await getVideoBuffer(info, token);
    if (kind === 'doc') {
      return sock.sendMessage(jid, { document: buf, mimetype: 'video/mp4', fileName: `${safeName}.mp4`, caption: `📄\n\n${FOOTER_LINE}` }, { quoted: msg });
    }
    return sock.sendMessage(jid, { video: buf, mimetype: 'video/mp4', caption: `🎬 ${(info.title || '').slice(0, 200)}\n\n${FOOTER_LINE}` }, { quoted: msg });
  } catch (err) {
    console.error('Send download error:', err?.message || err);
    if (err?.message === 'TOO_BIG') return reply(`❌ File is larger than ${Math.round(MAX_DL_BYTES / 1048576)} MB, so I can't send it.`+'\n\nෆයිල් එක ලොකු වැඩියි බං, පොඩි එකක් බලපන් 😑');
    return reply('❌ Download failed. Please try again.'+'\n\nමොකක්හරි අවුලක් බං, ආයෙ ට්‍රයි කරපන් 😒');
  }
}

/* ---------- YouTube song / video ---------- */
const YT_HOSTS = /(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com)$/i;
const MAX_SONG_MIN = Number(process.env.MAX_SONG_MIN || 20);

// Runs a yt-dlp command that prints JSON (-J). Gives up after 45 s so a blocked server fails fast instead of hanging.
const ytJson = (target, cookies, extra = []) => limited(async () => {
  const run = (runtime) => new Promise((resolve, reject) => {
    execFile(state.ytdlp, ['-J', '--no-warnings', '--skip-download', ...runtime, ...extra, ...(cookies ? cookieArgs() : []), '--', target],
      { timeout: 45000, maxBuffer: 30 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); } catch (x) { reject(x); }
      });
  });
  try { return await run(['--js-runtimes', 'node']); }
  catch (err) { if (!/no such option|unrecognized arguments/i.test(String(err?.message))) throw err; return run([]); } // older yt-dlp
});

// Account cookies first; if YouTube refuses them (expired / wrong format) the same thing is tried again without cookies.
async function cookieFallback(fn) {
  if (!fs.existsSync(COOKIE_FILE)) return fn(false);
  try { return await fn(true); }
  catch (err) {
    if (err?.message === 'TOO_BIG') throw err;
    console.error('YouTube with cookies failed, retrying without:', String(err?.stderr || err?.message || err).split('\n').filter(Boolean).pop());
    return fn(false);
  }
}

const ytThumb = (id) => (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : ''); // 16:9 picture without black bars
function ytInfoOf(e) {
  return {
    title: e.title || 'Unknown', author: e.uploader || e.channel || '', duration: Number(e.duration || 0),
    views: Number(e.view_count || 0),
    thumb: e.thumbnail || ytThumb(e.id), sourceUrl: e.webpage_url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : '')
  };
}

async function ytSearchInfo(target) {
  await ytdlpReady;
  const j = await cookieFallback((cookies) => ytJson(target, cookies, ['--no-playlist']));
  const e = j.entries ? j.entries[0] : j;
  if (!e) throw new Error('NO_RESULT');
  return ytInfoOf(e);
}

// Several results at once (for the picture cards). --flat-playlist keeps it fast: one search request, no per-video lookups.
async function ytSearchList(query, n = 8) {
  await ytdlpReady;
  const j = await cookieFallback((cookies) => ytJson(`ytsearch${n + 4}:${query}`, cookies, ['--flat-playlist']));
  const out = [];
  for (const e of j.entries || []) {
    const id = String(e?.id || '');
    if (!/^[\w-]{11}$/.test(id)) continue;
    if (e.live_status === 'is_live' || e.live_status === 'is_upcoming') continue;
    if (e.duration && Number(e.duration) > MAX_SONG_MIN * 60) continue;
    out.push({ ...ytInfoOf({ ...e, id, thumbnail: ytThumb(id), webpage_url: `https://www.youtube.com/watch?v=${id}` }) });
    if (out.length >= n) break;
  }
  return out;
}

// Stores a search result so a button only needs the short token (valid 30 min by default).
function rememberSong(info, ttl = 30 * 60 * 1000) {
  const token = crypto.randomBytes(4).toString('hex');
  pendingDl.set(token, { info, platform: 'youtube', expires: Date.now() + ttl });
  return token;
}

// ---- Fallback: a separate download service. When YouTube blocks THIS server (bot check / no formats), another server fetches the file. ----
// Set your own in Render:  YT_API_URL = a JSON API for audio with {u} where the (encoded) YouTube link goes,  YT_VIDEO_API_URL = same for video.
// For rapidapi.com URLs the key from RAPIDAPI_KEY is added for you. Free public APIs die often, so the built-in ones are only a best-effort extra.
function apiProviders(kind) {
  const list = [];
  const custom = ((kind === 'video' ? process.env.YT_VIDEO_API_URL : process.env.YT_API_URL) || '').trim();
  if (custom) list.push(['custom', custom]);
  const v = kind === 'video';
  list.push(
    ['davidcyril', `https://apis.davidcyriltech.my.id/youtube/${v ? 'mp4' : 'mp3'}?url={u}`],
    ['siputzx', `https://api.siputzx.my.id/api/d/${v ? 'ytmp4' : 'ytmp3'}?url={u}`],
    ['ryzendesu', `https://api.ryzendesu.vip/api/downloader/${v ? 'ytmp4' : 'ytmp3'}?url={u}`]
  );
  return list;
}
// Finds the download link anywhere in a provider's reply (skips thumbnails / pictures).
function findLink(j, depth = 0) {
  if (!j || typeof j !== 'object' || depth > 4) return null;
  const isUrl = (x) => typeof x === 'string' && /^https?:\/\//i.test(x) && !/\.(jpe?g|png|webp|gif)(\?|$)/i.test(x);
  for (const [k, x] of Object.entries(j)) if (/download|dl_?url|mp3|mp4|audio|video|^url$|^link$/i.test(k) && isUrl(x)) return x;
  for (const [k, x] of Object.entries(j)) { if (/thumb|image|cover|poster|avatar/i.test(k)) continue; const r = findLink(x, depth + 1); if (r) return r; }
  return null;
}
// RapidAPI "Youtube MP4/MP3 Downloader" (Opachi): POST a request, then ask for its status until downloadUrl appears.
const OPACHI = (process.env.YT_OPACHI_BASE || 'https://youtube-mp4-mp3-downloader.p.rapidapi.com').replace(/\/$/, '');
const rapidKey = () => (process.env.YT_RAPIDAPI_KEY || process.env.RAPIDAPI_KEY || process.env.TIKTOK_RAPIDAPI_KEY || '').trim();
async function viaOpachi(url, kind) {
  const key = rapidKey();
  const id = (url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [])[1];
  if (!key || !id) throw new Error(!key ? 'no RapidAPI key' : 'no video id');
  const host = new URL(OPACHI).hostname;
  const headers = { 'content-type': 'application/json', 'x-rapidapi-key': key, 'x-rapidapi-host': host };
  const body = kind === 'video' ? { id, type: 'merged', quality: 480, container: 'mp4' } : { id, type: 'audio', container: 'm4a' };
  const json = async (res) => { try { return await res.json(); } catch { throw new Error(`not JSON (HTTP ${res.status})`); } };
  let j = await json(await fetch(`${OPACHI}/api/v2/request`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }));
  if (!j?.uid) throw new Error(String(j?.message || JSON.stringify(j)).slice(0, 150)); // e.g. "You are not subscribed to this API"
  const uid = j.uid, deadline = Date.now() + 100000;
  while (!j.downloadUrl) {
    if (j.error || /error|fail/i.test(String(j.state || ''))) throw new Error(`API ${j.state || 'error'}: ${String(j.error || j.message || '').slice(0, 100)}`);
    if (Date.now() > deadline) throw new Error(`timed out (state ${j.state})`);
    await sleep(2000);
    const next = await json(await fetch(`${OPACHI}/api/v2/request/status?uid=${encodeURIComponent(uid)}`, { headers, signal: AbortSignal.timeout(30000) }));
    if (!next.state && !next.downloadUrl) throw new Error(`status check: ${String(next.message || JSON.stringify(next)).slice(0, 150)}`);
    j = next;
  }
  const link = j.downloadUrl.startsWith('/') ? `${OPACHI}${j.downloadUrl}` : j.downloadUrl;
  let buf;
  try { buf = await fetchBuffer(link); }
  catch (err) { if (err?.message === 'TOO_BIG') throw err; buf = await fetchBuffer(link, headers); } // some links need the key too
  if (buf.length < 10 * 1024) throw new Error('file was empty');
  console.log(`YouTube ${kind} via RapidAPI OK (${Math.round(buf.length / 1024)} KB)`);
  return { buf, ext: kind === 'video' ? 'mp4' : 'm4a' };
}
async function ytViaApi(url, kind) {
  const errors = [];
  if (rapidKey()) {
    try { return await viaOpachi(url, kind); }
    catch (err) { if (err?.message === 'TOO_BIG') throw err; errors.push(`rapidapi: ${err?.message || err}`); }
  }
  for (const [name, tpl] of apiProviders(kind)) {
    try {
      const api = tpl.replace('{u}', encodeURIComponent(url)).replace('{id}', (url.match(/(?:v=|youtu\.be\/)([\w-]{11})/) || [])[1] || '');
      const headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', accept: 'application/json' };
      const host = new URL(api).hostname;
      const rkey = rapidKey();
      if (/rapidapi\.com$/i.test(host) && rkey) { headers['x-rapidapi-key'] = rkey.trim(); headers['x-rapidapi-host'] = host; }
      const res = await fetch(api, { headers, signal: AbortSignal.timeout(45000) });
      const text = await res.text();
      let j; try { j = JSON.parse(text); } catch { throw new Error(`not JSON (HTTP ${res.status})`); }
      const link = findLink(j);
      if (!link) throw new Error(`no download link (${JSON.stringify(j).slice(0, 100)})`);
      const buf = await fetchBuffer(link);
      if (buf.length < 10 * 1024 || buf[0] === 0x3c || buf[0] === 0x7b) throw new Error('reply was not a media file'); // '<' html or '{' json
      const ext = kind === 'video' ? 'mp4' : ((link.match(/\.(mp3|m4a|mp4|webm|ogg|opus)(\?|$)/i) || [])[1] || 'mp3').toLowerCase();
      console.log(`YouTube ${kind} via ${name} API OK`);
      return { buf, ext };
    } catch (err) {
      if (err?.message === 'TOO_BIG') throw err;
      errors.push(`${name}: ${err?.message || err}`);
    }
  }
  throw new Error(`API fallback failed: ${errors.join(' | ')}`);
}

// A search result saved by rememberSong(), or null when the token is unknown / expired.
function getSong(token) {
  const e = pendingDl.get(String(token || ''));
  return e && e.platform === 'youtube' && e.expires > Date.now() ? e.info : null;
}
// Title + channel of one video WITHOUT yt-dlp (YouTube's oEmbed page answers even when this server is blocked); yt-dlp only if that fails.
async function ytQuickInfo(url) {
  const id = (String(url).match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [])[1];
  if (id) {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const o = await res.json();
        if (o?.title) return { title: o.title, author: o.author_name || '', duration: 0, views: 0, thumb: ytThumb(id), sourceUrl: `https://www.youtube.com/watch?v=${id}` };
      }
    } catch { /* yt-dlp below */ }
  }
  return ytSearchInfo(url);
}

// YouTube keeps changing which player clients give free formats ("Requested format is not available" = that client gave none).
// So the same download is tried with a few different clients. The FIRST error is the one reported, because later ones
// (e.g. the bot check you get when retrying without cookies) hide the real reason.
const CLIENT_TRIES = [null, 'youtube:player_client=web_safari,mweb', 'youtube:player_client=tv', ...(process.env.YTDLP_EXTRACTOR_ARGS ? [process.env.YTDLP_EXTRACTOR_ARGS] : [])];
const STALE_COOKIES = /cookies.*(no longer valid|invalid|netscape|rotated)|does not look like a netscape/i;
async function ytDownload(url, token, { format, kind = 'audio' }) {
  const hasCookies = fs.existsSync(COOKIE_FILE);
  let first = null;
  if ((process.env.YT_PREFER_API || '').toLowerCase() === 'on') { // this server is always blocked: skip yt-dlp and go straight to the API
    try { return await ytViaApi(url, kind); }
    catch (err) { if (err?.message === 'TOO_BIG') throw err; console.error('YouTube', err?.message || err, '(trying yt-dlp)'); }
  }
  for (const extractorArgs of CLIENT_TRIES) {
    try { return await ytDlpFile(url, token, { format, cookies: hasCookies, extractorArgs }); }
    catch (err) {
      if (err?.message === 'TOO_BIG') throw err;
      first = first || err;
      console.error(`YouTube download failed (${extractorArgs || 'default client'}):`, String(err?.stderr || err?.message || err).split('\n').filter(Boolean).slice(-2).join(' | '));
      if (hasCookies && STALE_COOKIES.test(String(err?.stderr || err?.message))) break; // the cookies themselves are bad: more clients will not help
    }
  }
  if (hasCookies && STALE_COOKIES.test(String(first?.stderr || first?.message))) {
    try { return await ytDlpFile(url, token, { format, cookies: false }); } catch { /* try the API next */ }
  }
  try { return await ytViaApi(url, kind); }
  catch (err) { if (err?.message === 'TOO_BIG') throw err; console.error('YouTube', err?.message || err); }
  throw first; // the real yt-dlp reason, not the API's
}

// .ytcheck : shows WHY YouTube downloads fail (JS runtime, cookies, formats) in a few lines.
async function ytDiagnose(url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ') {
  await ytdlpReady;
  const hasCookies = fs.existsSync(COOKIE_FILE);
  const { err, out } = await new Promise((resolve) => {
    execFile(state.ytdlp, ['-v', '-F', '--no-playlist', '--js-runtimes', 'node', ...(hasCookies ? cookieArgs() : []), '--', url],
      { timeout: 90000, maxBuffer: 10 * 1024 * 1024 }, (e, so, se) => resolve({ err: e, out: `${so}\n${se}` }));
  });
  const lines = out.split('\n').map((l) => l.trim());
  const pick = (re) => lines.filter((l) => re.test(l)).map((l) => l.slice(0, 190));
  const formats = lines.filter((l) => /^\S+\s+(mp4|m4a|webm|mhtml|3gp)\s/.test(l));
  const audio = formats.filter((l) => /audio only/i.test(l)).length;
  return [
    `🍪 Cookies file: ${hasCookies ? 'found' : 'NOT found'}`,
    `🌐 API fallback: ${rapidKey() ? 'RapidAPI key found' : 'no RapidAPI key'}${process.env.YT_API_URL ? ' + YT_API_URL' : ''}${(process.env.YT_PREFER_API || '').toLowerCase() === 'on' ? ' (API first)' : ''}`,
    ...pick(/^\[debug\] yt-dlp version/).slice(0, 1),
    ...pick(/JS runtimes?|JavaScript runtime|\[jsc/i).slice(0, 3),
    ...pick(/Found YouTube account cookies|LOGIN_INFO|PO Token Providers/i).slice(0, 2),
    ...pick(/^(WARNING|ERROR)/).filter((l) => !/Skipping client|\[debug\]/.test(l)).slice(0, 5),
    `📦 Formats found: ${formats.length} (audio only: ${audio})${err ? ' ❌' : ' ✅'}`
  ].join('\n');
}

export async function startSong(sock, jid, msg, query) {
  const reply = (t) => say(sock, jid, t, msg);
  if (!query) return reply(`🎵 Send a song name or YouTube link.\nExample: ${PREFIX}song shape of you`);
  let target = `ytsearch1:${query}`;
  if (/^https?:\/\//i.test(query)) {
    let u; try { u = new URL(query); } catch {}
    if (!u || !YT_HOSTS.test(u.hostname)) return reply(`❌ Only YouTube links are supported here.\n${NAGS.youtube}`);
    target = u.toString();
  }
  await reply('🔎 Searching YouTube...');
  let info;
  try { info = await ytSearchInfo(target); }
  catch (err) {
    console.error('YouTube search error:', err?.stderr || err?.message || err);
    const bot = /confirm you.?re not a bot|sign in/i.test(String(err?.stderr || err?.message));
    return reply(bot ? '❌ YouTube blocked this server (bot check). Add YouTube cookies in the YTDLP_COOKIES env, or try again later.'+'\n\nයූටියුබ් එක අපිව බ්ලොක් කරලා බං, පොඩ්ඩකින් ට්‍රයි කරපන් 😒' : '❌ Could not find or open that video.\n\nවීඩියෝ එක හොයාගන්න බැරි උනා බං, නම හරියට ගහපන් 😑');
  }
  if (info.duration && info.duration > MAX_SONG_MIN * 60) return reply(`❌ That video is longer than ${MAX_SONG_MIN} minutes.\n\nවීඩියෝ එක ගොඩක් දිගයි බං, පොඩි එකක් බලපන් 😒`);
  const token = crypto.randomBytes(4).toString('hex');
  pendingDl.set(token, { info, platform: 'youtube', expires: Date.now() + 10 * 60 * 1000 });
  const mins = info.duration ? `${Math.floor(info.duration / 60)}:${String(Math.floor(info.duration % 60)).padStart(2, '0')}` : '-';
  const p = PREFIX;
  const caption = [
    '╭━━━〔 🎵 *YOUTUBE DOWNLOADER* 〕━━━⬣',
    `┃ 🎬 ${info.title.slice(0, 120)}`,
    info.author ? `┃ 👤 ${info.author}` : null,
    `┃ ⏱️ ${mins}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    '👇 Select the file format'
  ].filter((l) => l !== null).join('\n');
  const buttons = [
    qr('🎵 Audio', `${p}ytdl audio ${token}`),
    qr('📄 Document', `${p}ytdl doc ${token}`),
    qr('🎬 Video', `${p}ytdl video ${token}`)
  ];
  return sendRich(sock, jid, { caption, buttons, footer: FOOTER_TEXT, image: info.thumb || MENU_IMAGE }, msg);
}

export async function sendSong(sock, jid, msg, kind, token) {
  const reply = (t) => say(sock, jid, t, msg);
  const entry = pendingDl.get(String(token || ''));
  if (!entry || entry.platform !== 'youtube' || entry.expires < Date.now()) return reply(`⌛ This request expired. Search again with ${PREFIX}song.`);
  const { info } = entry;
  const name = (info.title || 'song').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'song';
  try {
    await reply(kind === 'video' ? '⏳ Downloading video...' : '⏳ Downloading audio...');
    if (kind === 'video') {
      const { buf } = await ytDownload(info.sourceUrl, token, { format: 'best[ext=mp4][height<=480]/best[ext=mp4]/best', kind: 'video' });
      return sock.sendMessage(jid, { video: buf, mimetype: 'video/mp4', caption: `🎬 ${info.title.slice(0, 200)}\n\n${FOOTER_LINE}` }, { quoted: msg });
    }
    const { buf, ext } = await ytDownload(info.sourceUrl, token, { format: 'bestaudio[ext=m4a]/bestaudio/best' });
    const mimes = { m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg; codecs=opus', opus: 'audio/ogg; codecs=opus' };
    if (kind === 'audio' && mimes[ext]) return sock.sendMessage(jid, { audio: buf, mimetype: mimes[ext], ptt: false }, { quoted: msg });
    return sock.sendMessage(jid, { document: buf, mimetype: mimes[ext] || 'application/octet-stream', fileName: `${name}.${ext || 'm4a'}`, caption: `🎵 ${info.title.slice(0, 200)}` }, { quoted: msg });
  } catch (err) {
    console.error('Song download error:', err?.stderr || err?.message || err);
    if (err?.message === 'TOO_BIG') return reply(`❌ File is larger than ${Math.round(MAX_DL_BYTES / 1048576)} MB, so I can't send it.`+'\n\nෆයිල් එක ලොකු වැඩියි බං, පොඩි එකක් බලපන් 😑');
    if (/confirm you.?re not a bot|sign in/i.test(String(err?.stderr || err?.message))) return reply('❌ YouTube blocked this server (bot check). Add YouTube cookies in the YTDLP_COOKIES env, or try again later.'+'\n\nයූටියුබ් එක අපිව බ්ලොක් කරලා බං, පොඩ්ඩකින් ට්‍රයි කරපන් 😒');
    if (/format is not available/i.test(String(err?.stderr || err?.message))) return reply(`❌ YouTube gave no downloadable formats to this server (JS runtime / cookies problem). Owner: send ${PREFIX}ytcheck to see why.`);
    return reply('❌ Download failed. Please try again.'+'\n\nමොකක්හරි අවුලක් බං, ආයෙ ට්‍රයි කරපන් 😒');
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingDl) if (v.expires < now) pendingDl.delete(k);
}, 60 * 1000).unref();

// used by commands/channelsong.js and commands/songsearch.js
export { ytSearchInfo, ytSearchList, rememberSong, getSong, ytQuickInfo, ytDlpFile, cookieFallback, ytDownload, ytDiagnose };
