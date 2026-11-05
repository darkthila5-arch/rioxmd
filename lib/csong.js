// .chsong look (host setting, /admin > Channels > "Channel song"):
//   normal    = the thumbnail picture with the song details, then the voice note (the old behaviour)
//   equalizer = a short silent looping clip (GIF style, 640x360) made from the song's own thumbnail, then the voice note:
//     layout "circle": a round, slowly turning badge in the middle with a ring of equalizer bars around it (glowing),
//                      on a blurred, darkened copy of the song's thumbnail. The badge shows the song's thumbnail ("thumbnail")
//                      or the logo of the channel / group the song is posted to ("channel") or a picture the host uploaded ("custom"): host setting "centre picture".
//                      The middle picture turns slowly, stays still, pulses with the beat, or both (setting "motion")
//     layout "bars"  : the thumbnail with chunky, glowing equalizer bars along the bottom (the picture fades smoothly into the bars, no black band)
//     layout "wave"  : the thumbnail with a smooth glowing wave line along the bottom (mirrored left / right, drawn from the song's own spectrum)
//     layout "blob"  : like "circle" (round badge in the middle, same centre picture and motion settings) but the ring of bars is one smooth, glowing shape
//                      around the badge (Avee style). Shape "wings" / "round", style "filled" / "outline" / "layers", and the usual colour.
//   Particles are a separate add-on that works with every layout (setting "particles" on / off + its own colour, default = same colour as the wave / bars):
//     soft glowing dots that float up over the picture.
//   Who gets the animation: the host's own number and numbers with active premium. Everybody else always gets the normal thumbnail.
//   The host's look is the default; a premium number can change every part of it for its own posts on /settings (resolveCsong).
//   The bars move with a few seconds of the real song. Made with ffmpeg (already in the Docker image), about 100 to 500 KB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { getSetting, setSetting } from './storage.js';

const G = '_global';
export const EQ_STYLES = { white: '0xffffff', cyan: '0x00e5ff', green: '0x39ff14', pink: '0xff2d95', gold: '0xffc400', orange: '0xff7a00', red: '0xff3b3b', blue: '0x3b82ff', purple: '0xb26bff' };
export const PARTICLE_STYLES = ['match', ...Object.keys(EQ_STYLES)]; // "match" = the same colour as the wave / bars / ring
export const EQ_LAYOUTS = ['circle', 'bars', 'wave', 'blob'];
export const EQ_MOTIONS = ['spin', 'still', 'pulse', 'both']; // middle picture: turns slowly / stays still / pulses with the beat / turns and pulses
export const EQ_CENTERS = ['thumbnail', 'channel', 'custom']; // circle layout: what sits inside the round badge (song thumbnail, channel / group logo, or a picture the host uploaded)
// Settings a premium number can change for itself (same names as the host's, but stored under the number). Empty = use the host's default.
export const CSONG_USER_KEYS = ['csongMode', 'csongEqLayout', 'csongEqStyle', 'csongEqCenter', 'csongEqMotion', 'csongEqSeconds', 'csongParticles', 'csongParticleStyle', 'csongBlobStyle', 'csongBlobShape'];
export const CSONG_USER_OPTIONS = { csongMode: ['normal', 'equalizer'], csongEqLayout: EQ_LAYOUTS, csongEqStyle: Object.keys(EQ_STYLES), csongEqCenter: EQ_CENTERS, csongEqMotion: EQ_MOTIONS, csongParticles: ['on', 'off'], csongParticleStyle: PARTICLE_STYLES, csongBlobStyle: ['filled', 'outline', 'layers'], csongBlobShape: ['wings', 'round'] };
export const PREMIUM_MAX_S = Math.min(30, Math.max(4, Number(process.env.CSONG_PREMIUM_MAX_S) || 15)); // longest clip for a premium number (the host is not limited)
const QUEUE_MAX = Math.max(1, Number(process.env.CSONG_QUEUE) || 3);                                 // clips waiting + being made; more than this get the normal thumbnail
const premiumActive = (sid) => Number(getSetting(sid, 'premium', null)?.until || 0) > Date.now();      // same rule as lib/brand.js (no import, keeps this file free of cycles)
const IMG_KEY = 'csongCenterImg'; // the uploaded picture, kept as base64 in the settings (disk or MongoDB), about 30 to 150 KB
export const EQ_MIN_S = 4, EQ_MAX_S = 30, EQ_DEFAULT_S = 8;

function motionOf() {
  const m = getSetting(G, 'csongEqMotion', null);
  if (EQ_MOTIONS.includes(m)) return m;
  return getSetting(G, 'csongEqSpin', true) === false ? 'still' : 'spin'; // older saved on / off setting
}

export function getCsong() {
  const seconds = Math.round(Number(getSetting(G, 'csongEqSeconds', EQ_DEFAULT_S)));
  const style = getSetting(G, 'csongEqStyle', 'white');
  const layout = getSetting(G, 'csongEqLayout', 'circle');
  const center = getSetting(G, 'csongEqCenter', 'thumbnail');
  const hasImage = Boolean(getSetting(G, IMG_KEY, null)?.b);
  return {
    mode: getSetting(G, 'csongMode', 'normal') === 'equalizer' ? 'equalizer' : 'normal',
    seconds: Number.isFinite(seconds) ? Math.min(EQ_MAX_S, Math.max(EQ_MIN_S, seconds)) : EQ_DEFAULT_S,
    style: EQ_STYLES[style] ? style : 'white',
    layout: EQ_LAYOUTS.includes(layout) ? layout : 'circle',
    center: EQ_CENTERS.includes(center) && (center !== 'custom' || hasImage) ? center : 'thumbnail', // "custom" without a picture = thumbnail
    motion: motionOf(),
    hasImage,
    blobStyle: EQ_BLOB_STYLES.includes(getSetting(G, 'csongBlobStyle', 'filled')) ? getSetting(G, 'csongBlobStyle', 'filled') : 'filled',
    blobShape: EQ_BLOB_SHAPES.includes(getSetting(G, 'csongBlobShape', 'wings')) ? getSetting(G, 'csongBlobShape', 'wings') : 'wings',
    particles: getSetting(G, 'csongParticles', 'off') === 'on',
    particleStyle: PARTICLE_STYLES.includes(getSetting(G, 'csongParticleStyle', 'match')) ? getSetting(G, 'csongParticleStyle', 'match') : 'match',
  };
}

export function setCsong({ mode, seconds, style, layout, center, motion, particles, particleStyle, blobStyle, blobShape }) {
  if (mode !== undefined) setSetting(G, 'csongMode', mode === 'equalizer' ? 'equalizer' : 'normal');
  if (seconds !== undefined) {
    const n = Math.round(Number(seconds));
    if (!Number.isFinite(n)) throw new Error('Seconds must be a number.');
    setSetting(G, 'csongEqSeconds', Math.min(EQ_MAX_S, Math.max(EQ_MIN_S, n)));
  }
  if (style !== undefined) {
    if (!EQ_STYLES[style]) throw new Error('Unknown equalizer colour.');
    setSetting(G, 'csongEqStyle', style);
  }
  if (layout !== undefined) {
    if (!EQ_LAYOUTS.includes(layout)) throw new Error('Unknown equalizer layout.');
    setSetting(G, 'csongEqLayout', layout);
  }
  if (center !== undefined) {
    if (!EQ_CENTERS.includes(center)) throw new Error('Unknown centre picture.');
    if (center === 'custom' && !getSetting(G, IMG_KEY, null)?.b) throw new Error('Choose and upload a picture first.');
    setSetting(G, 'csongEqCenter', center);
  }
  if (motion !== undefined) {
    if (!EQ_MOTIONS.includes(motion)) throw new Error('Unknown motion.');
    setSetting(G, 'csongEqMotion', motion);
  }
  if (blobStyle !== undefined) {
    if (!EQ_BLOB_STYLES.includes(blobStyle)) throw new Error('Unknown shape style.');
    setSetting(G, 'csongBlobStyle', blobStyle);
  }
  if (blobShape !== undefined) {
    if (!EQ_BLOB_SHAPES.includes(blobShape)) throw new Error('Unknown shape.');
    setSetting(G, 'csongBlobShape', blobShape);
  }
  if (particles !== undefined) setSetting(G, 'csongParticles', particles === true || particles === 'on' ? 'on' : 'off');
  if (particleStyle !== undefined) {
    if (!PARTICLE_STYLES.includes(particleStyle)) throw new Error('Unknown particle colour.');
    setSetting(G, 'csongParticleStyle', particleStyle);
  }
  return getCsong();
}

// A centre picture (the host's, under "_global", or a premium number's own): any JPG / PNG / WEBP / GIF, cut to a square, 512 px,
// saved as a small JPEG (transparent parts become dark grey), at most about 150 KB.
export function getCenterImage(sid = G) {
  const v = getSetting(sid, IMG_KEY, null);
  return v?.b ? Buffer.from(v.b, 'base64') : null;
}
export const hasCenterImage = (sid = G) => Boolean(getSetting(sid, IMG_KEY, null)?.b);
export async function setCenterImage(buf, sid = G) {
  const { default: sharp } = await import('sharp');
  const base = sharp(buf, { limitInputPixels: 40e6, failOn: 'error' }).rotate().flatten({ background: '#1f2937' }).resize({ width: 512, height: 512, fit: 'cover' });
  let out;
  for (const q of [88, 76, 64, 52, 40]) { out = await base.clone().jpeg({ quality: q }).toBuffer(); if (out.length <= 150 * 1024) break; }
  if (out.length > 200 * 1024) throw new Error('That picture is too detailed. Use a simpler one.');
  setSetting(sid, IMG_KEY, { b: out.toString('base64'), at: Date.now() });
  return out.length;
}
export function clearCenterImage(sid = G) {
  setSetting(sid, IMG_KEY, null);
  if (getSetting(sid, 'csongEqCenter', null) === 'custom') setSetting(sid, 'csongEqCenter', sid === G ? 'thumbnail' : null);
}

// The look for one number. Returns the finished settings plus:
//   allowed = this number may use the animation (the host's own number, or premium). Others always get mode "normal".
//   image   = the buffer for the middle of the round layout when center is "custom" (the number's own picture, or the host's default picture)
export function resolveCsong(sid, { host = false } = {}) {
  const base = getCsong();
  const premium = Boolean(sid) && premiumActive(sid);
  if (!premium && !host) return { ...base, mode: 'normal', allowed: false, premium: false, image: null };
  const cfg = { ...base, allowed: true, premium, image: null };
  let ownCustom = false;
  if (premium) {
    const own = (k) => getSetting(sid, k, null);
    const pick = (k, d) => (CSONG_USER_OPTIONS[k].includes(own(k)) ? own(k) : d);
    cfg.mode = pick('csongMode', base.mode);
    cfg.layout = pick('csongEqLayout', base.layout);
    cfg.style = pick('csongEqStyle', base.style);
    cfg.motion = pick('csongEqMotion', base.motion);
    cfg.blobStyle = pick('csongBlobStyle', base.blobStyle);
    cfg.blobShape = pick('csongBlobShape', base.blobShape);
    cfg.particles = pick('csongParticles', base.particles ? 'on' : 'off') === 'on';
    cfg.particleStyle = pick('csongParticleStyle', base.particleStyle);
    const sec = Math.round(Number(own('csongEqSeconds')));
    if (Number.isFinite(sec) && sec > 0) cfg.seconds = Math.min(EQ_MAX_S, Math.max(EQ_MIN_S, sec));
    if (CSONG_USER_OPTIONS.csongEqCenter.includes(own('csongEqCenter'))) { cfg.center = own('csongEqCenter'); ownCustom = cfg.center === 'custom'; }
    if (!host) cfg.seconds = Math.min(cfg.seconds, PREMIUM_MAX_S);
  }
  if (cfg.center === 'custom') { // the number's own picture when it chose "my own picture" itself, otherwise the host's default picture
    cfg.image = ownCustom ? getCenterImage(sid) : getCenterImage();
    if (!cfg.image) cfg.center = 'thumbnail';
  }
  return cfg;
}

// Where in the song the clip starts: a little way in (intros are often quiet), but always inside the song.
export const clipStart = (songSeconds, clipSeconds) => (songSeconds > 0 ? Math.max(0, Math.min(60, Math.floor(songSeconds * 0.2), Math.floor(songSeconds - clipSeconds - 2))) : 0);

const W = 640, H = 360, FPS = 20;
const CX = W / 2, CY = H / 2, R0 = 84, LEN = 66, N = 36, HS = 96; // circle layout: ring starts at radius R0, bars are up to LEN long, N bars on each half
const DISC = 156, RING = 170;                                       // badge size and the white ring around it
const NB = 48, EH = 128, BM = 14, BBOT = 12;                        // bars layout: 48 chunky bars, up to EH px tall, BM px side margin, BBOT px above the bottom edge
const WVH = 130, WVB = 14, WV_BANDS = 13, WV_SR = 22050, WV_N = 2048;                            // wave layout: the line is drawn in a strip WVH px tall at the bottom; WVB px of it lie under the resting line; WV_BANDS frequency bands per half
const run = (args, timeout) => new Promise((resolve, reject) => {
  execFile('ffmpeg', ['-y', '-v', 'error', ...args], { timeout }, (err, _o, stderr) => {
    if (!err) return resolve();
    const why = err.killed ? `timed out after ${Math.round(timeout / 1000)} s` : String(stderr || '').trim().split('\n').slice(-3).join(' | ') || String(err.message).slice(-150); // the END of the message holds the real reason
    reject(new Error(`ffmpeg: ${why.slice(0, 300)}`));
  });
});

// png / jpg / webp / gif by its first bytes (ffmpeg needs the right extension to read a picture file)
export function imageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.subarray(1, 4).toString() === 'PNG') return 'png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.subarray(0, 3).toString() === 'GIF') return 'gif';
  return null;
}

// The channel's (or group's) logo for the middle of the round layout. Channels: the picture path from newsletterMetadata;
// groups / chats: profilePictureUrl. Returns a picture buffer, or null (then the caller uses the song thumbnail instead).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const asUrl = (p) => { // a path ("/v/t61..."), a full url, or { url | direct_path }
  const v = typeof p === 'string' ? p : (p?.url || p?.direct_path || '');
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : `https://pps.whatsapp.net${v.startsWith('/') ? '' : '/'}${v}`;
};
export async function fetchChannelLogo(sock, jid) {
  const urls = [];
  try {
    if (/@newsletter$/.test(jid)) {
      const meta = await sock.newsletterMetadata('jid', jid);
      const t = meta?.thread_metadata || {};
      urls.push(asUrl(meta?.picture), asUrl(t.picture), asUrl(meta?.preview), asUrl(t.preview)); // full picture first, small preview last
    }
  } catch (err) { console.error('chsong channel logo (metadata):', err?.message || err); }
  try { urls.push(await sock.profilePictureUrl(jid, 'image', 10000)); } catch { /* channels often have none this way */ }
  for (const url of [...new Set(urls.filter(Boolean))]) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 1000 && imageExt(buf)) return buf;
    } catch { /* try the next one */ }
  }
  return null;
}

// Both layouts turn a small "bar chart" picture (one column per bar) into the final shape with ffmpeg's remap filter. For that they need two fixed
// "where does this pixel come from" maps (x and y). They never change, so they are made once and kept in the temp folder.
const mapsReady = {};
function ensureMaps(kind) {
  if (mapsReady[kind]) return mapsReady[kind];
  const dir = path.join(os.tmpdir(), `rio-eqmaps-v2-${kind}`), x = path.join(dir, 'x.png'), y = path.join(dir, 'y.png');
  mapsReady[kind] = (async () => {
    if (fs.existsSync(x) && fs.existsSync(y) && fs.statSync(x).size > 100 && fs.statSync(y).size > 100) return { x, y };
    fs.mkdirSync(dir, { recursive: true });
    let size, xe, ye;
    if (kind === 'ring') {
      size = `${W}x${H}`;
      const dx = `(X-${CX})`, dy = `(Y-${CY})`, r = `hypot(${dx},${dy})`, u = `(atan2(abs${dx},${dy})/PI*${N})`; // u = 0 at the bottom, N at the top (mirrored left / right)
      xe = `if(between(${r},${R0},${R0 + LEN})*lt(${u}-floor(${u}),0.58),min(floor(${u}),${N - 1}),${N})`;       // bar number, or the black spare column (= gap)
      ye = `if(between(${r},${R0},${R0 + LEN}),clip(${HS - 1}-(${r}-${R0})*${HS - 1}/${LEN},0,${HS - 1}),0)`;  // how far up the bar this pixel is
    } else { // 'flat': NB chunky bars side by side, EH px tall
      size = `${W}x${EH}`;
      const P = (W - 2 * BM) / NB, BW = (P * 0.7).toFixed(3);
      xe = `if(between(X,${BM},${W - BM})*lt(mod(X-${BM},${P.toFixed(4)}),${BW}),min(floor((X-${BM})/${P.toFixed(4)}),${NB - 1}),${NB})`;
      ye = `clip(Y*${HS - 1}/${EH - 1},0,${HS - 1})`;
    }
    const tmpX = `${x}.${process.pid}.png`, tmpY = `${y}.${process.pid}.png`;
    for (const [out, expr] of [[tmpX, xe], [tmpY, ye]]) await run(['-f', 'lavfi', '-i', `nullsrc=s=${size},format=gray16le,geq=lum='${expr}'`, '-frames:v', '1', '-pix_fmt', 'gray16be', out], 60000);
    fs.renameSync(tmpX, x); fs.renameSync(tmpY, y);
    return { x, y };
  })().catch((err) => { delete mapsReady[kind]; throw err; });
  return mapsReady[kind];
}

// Floating particles (the "particles" add-on, any layout): two fixed pictures (black with soft white dots, seamless top to bottom) made once and kept in the temp folder.
// ffmpeg's "scroll" filter then moves them slowly upwards at two speeds (small slow dots behind, bigger faster ones in front).
function dotsPicture(count, rMin, rMax, seed) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const f = new Float32Array(W * H);
  for (let n = 0; n < count; n++) {
    const x0 = rnd() * W, y0 = rnd() * H, r = rMin + rnd() * (rMax - rMin), peak = 0.55 + rnd() * 0.45, reach = Math.ceil(r * 3);
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
      const x = ((Math.round(x0) + dx) % W + W) % W, y = ((Math.round(y0) + dy) % H + H) % H; // wraps round the edges, so the loop has no seam
      f[y * W + x] += peak * Math.exp(-(dx * dx + dy * dy) / (2 * r * r));
    }
  }
  const raw = Buffer.alloc(W * H);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.min(255, Math.round(f[i] * 255));
  return raw;
}
let dotsReady = null;
function ensureDots() {
  if (dotsReady) return dotsReady;
  const dir = path.join(os.tmpdir(), 'rio-eqmaps-v2-wave'), a = path.join(dir, 'dots-a.png'), b = path.join(dir, 'dots-b.png');
  dotsReady = (async () => {
    if (fs.existsSync(a) && fs.existsSync(b) && fs.statSync(a).size > 100 && fs.statSync(b).size > 100) return { a, b };
    fs.mkdirSync(dir, { recursive: true });
    const { default: sharp } = await import('sharp');
    for (const [file, raw] of [[a, dotsPicture(70, 0.8, 1.5, 7)], [b, dotsPicture(22, 1.8, 3.2, 21)]]) {
      const tmp = `${file}.${process.pid}.png`;
      await sharp(raw, { raw: { width: W, height: H, channels: 1 } }).png().toFile(tmp);
      fs.renameSync(tmp, file);
    }
    return { a, b };
  })().catch((err) => { dotsReady = null; throw err; });
  return dotsReady;
}

// Wave layout. The line is drawn by this file, not by ffmpeg's own spectrum filter: the clip's sound is read, split into WV_BANDS frequency bands
// (bass at the outer edge, treble in the middle, mirrored), levelled so every song fills the height, smoothed in time (quick rise, slower fall), joined into
// one smooth curve and drawn with soft, even edges into a raw grey video (one frame = one picture of the line). ffmpeg then only colours it and adds the glow.
function fft(re, im) { // in place, radix 2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half, vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// PCM (mono 16 bit, WV_SR Hz) -> one array of WV_BANDS levels (0..1) per video frame
export function waveLevels(pcm, frames) {
  const total = Math.floor(pcm.length / 2), hann = new Float64Array(WV_N), binHz = WV_SR / WV_N, fMin = 50, fMax = 10000;
  for (let i = 0; i < WV_N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WV_N - 1));
  const edges = Array.from({ length: WV_BANDS + 1 }, (_, b) => fMin * Math.pow(fMax / fMin, b / WV_BANDS));
  const re = new Float64Array(WV_N), im = new Float64Array(WV_N), mag = new Float64Array(WV_N / 2 + 1), db = [];
  for (let f = 0; f < frames; f++) {
    const centre = Math.round((f + 0.5) * WV_SR / FPS);
    for (let i = 0; i < WV_N; i++) { const k = centre - WV_N / 2 + i; re[i] = (k >= 0 && k < total ? pcm.readInt16LE(k * 2) / 32768 : 0) * hann[i]; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(re[i], im[i]) / (WV_N / 4);
    const row = new Float64Array(WV_BANDS);
    for (let b = 0; b < WV_BANDS; b++) {
      const lo = edges[b] / binHz, hi = edges[b + 1] / binHz, fc = Math.sqrt(edges[b] * edges[b + 1]);
      let m;
      if (hi - lo < 1) { const p = (lo + hi) / 2, i0 = Math.floor(p), fr = p - i0; m = mag[i0] * (1 - fr) + mag[Math.min(mag.length - 1, i0 + 1)] * fr; }
      else { let sum = 0, n = 0; for (let i = Math.ceil(lo); i <= Math.min(mag.length - 1, Math.floor(hi)); i++) { sum += mag[i] * mag[i]; n++; } m = n ? Math.sqrt(sum / n) : 0; }
      row[b] = 20 * Math.log10(m + 1e-7) + 3 * Math.log2(fc / 300); // decibels, with a gentle lift to the treble (music has far less energy up there)
    }
    db.push(row);
  }
  const all = db.flatMap((r) => Array.from(r)).sort((x, y) => x - y);
  const hi = all[Math.floor(all.length * 0.985)] ?? 0;
  const lo = Math.min(all[Math.floor(all.length * 0.12)] ?? -100, hi - 14); // at least 14 dB between "nothing" and "full height", so a quiet song does not look empty
  const env = new Float64Array(WV_BANDS), out = [];
  for (const row of db) {
    const v = Array.from(row, (x) => Math.pow(Math.min(1, Math.max(0, (x - lo) / (hi - lo))), 1.25));
    const sm = v.map((x, b) => 0.2 * v[Math.max(0, b - 1)] + 0.6 * x + 0.2 * v[Math.min(WV_BANDS - 1, b + 1)]);
    for (let b = 0; b < WV_BANDS; b++) env[b] += (sm[b] - env[b]) * (sm[b] > env[b] ? 0.72 : 0.22);
    out.push(Float64Array.from(env));
  }
  return out;
}

// one picture of the line: levels (WV_BANDS values 0..1) -> grey W x WVH, white = line (anti-aliased, the same thickness on slopes), fading out at both ends
const smooth = (x) => x * x * (3 - 2 * x);
export function wavePicture(levels, buf = Buffer.alloc(W * WVH)) {
  buf.fill(0);
  const yb = WVH - WVB, yt = 16, left = [{ x: 0, y: yb + 40 }];
  for (let b = 0; b < WV_BANDS; b++) left.push({ x: W * (0.07 + 0.43 * b / (WV_BANDS - 1)), y: yb - (0.05 + 0.95 * levels[b]) * (yb - yt) });
  const pts = [...left, ...left.slice(0, -1).reverse().map((q) => ({ x: W - q.x, y: q.y }))];
  const m = pts.map((q, i) => (i === 0 ? (pts[1].y - q.y) / (pts[1].x - q.x) : i === pts.length - 1 ? (q.y - pts[i - 1].y) / (q.x - pts[i - 1].x) : (pts[i + 1].y - pts[i - 1].y) / (pts[i + 1].x - pts[i - 1].x)));
  const Y = new Float64Array(W);
  for (let x = 0, i = 0; x < W; x++) {
    while (i < pts.length - 2 && x > pts[i + 1].x) i++;
    const a = pts[i], c = pts[i + 1], h = c.x - a.x, t = Math.min(1, Math.max(0, (x - a.x) / h)), t2 = t * t, t3 = t2 * t;
    Y[x] = (2 * t3 - 3 * t2 + 1) * a.y + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * c.y + (t3 - t2) * h * m[i + 1];
  }
  const HALF = 1.9;
  for (let x = 0; x < W; x++) {
    const y = Y[x], slope = (Y[Math.min(W - 1, x + 1)] - Y[Math.max(0, x - 1)]) / (x === 0 || x === W - 1 ? 1 : 2), k = Math.sqrt(1 + slope * slope);
    const fade = smooth(Math.min(1, Math.min(x, W - 1 - x) / 70)), ext = Math.min(48, Math.ceil(3.4 * k) + 1);
    for (let r = Math.max(0, Math.floor(y - ext)); r <= Math.min(WVH - 1, Math.ceil(y + ext)); r++) {
      const a = Math.min(1, Math.max(0, (HALF + 0.9 - Math.abs(r + 0.5 - y) / k) / 1.8)) * fade, v = Math.round(a * 255);
      if (v > buf[r * W + x]) buf[r * W + x] = v;
    }
  }
  return buf;
}

// the whole clip: audio file -> raw grey video file (frames x W x WVH bytes)
const pcmOf = (audioPath, start, t) => new Promise((resolve, reject) => { // the clip's sound as mono 16 bit samples
  execFile('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, Math.floor(start))), '-t', String(t), '-i', audioPath, '-vn', '-ac', '1', '-ar', String(WV_SR), '-f', 's16le', '-'],
    { timeout: 60000, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, out, stderr) => (err ? reject(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 200)}`)) : resolve(out)));
});
async function writeWaveVideo(audioPath, start, t, outFile) {
  const frames = Math.floor(Number(t) * FPS), levels = waveLevels(await pcmOf(audioPath, start, t), frames), fd = fs.openSync(outFile, 'w'), buf = Buffer.alloc(W * WVH);
  try { for (const l of levels) { wavePicture(l, buf); fs.writeSync(fd, buf); } } finally { fs.closeSync(fd); }
  return frames;
}

// Blob layout ("Avee style"): a smooth, glowing shape around the round badge. Same sound analysis as the wave layout; the levels become the distance of the
// shape's edge from the centre, all the way round (mirrored left / right). "wings": bass makes two big wings at the top, treble sits low at the bottom.
// "round": bass at the bottom, treble at the top, like the ring. Styles: "filled" (solid), "outline" (glowing line, dim inside), "layers" (3 shapes, the
// older ones smaller and dimmer). Drawn by this file into a raw grey video (BS x BS px per frame), coloured and glowed by ffmpeg.
const BS = 336, BC = BS / 2, BR0 = 90, BLEN = 78, BTAB = 720;
export const EQ_BLOB_STYLES = ['filled', 'outline', 'layers'];
export const EQ_BLOB_SHAPES = ['wings', 'round'];
const BLAYERS = { filled: [{ lag: 0, scale: 1, int: 255 }], outline: [{ lag: 0, scale: 1, int: 255 }], layers: [{ lag: 0, scale: 1, int: 120 }, { lag: 3, scale: 0.78, int: 185 }, { lag: 6, scale: 0.58, int: 255 }] }; // the biggest shape is the dimmest, the smaller ones inside are brighter
let blobGrid = null;
function blobPixels() { // the pixels near the shape's edge (the middle is always inside, the corners always outside), with distance and angle, made once
  if (blobGrid) return blobGrid;
  const idx = [], dist = [], ang = [], mid = [];
  for (let y = 0; y < BS; y++) for (let x = 0; x < BS; x++) {
    const dx = x + 0.5 - BC, dy = y + 0.5 - BC, d = Math.hypot(dx, dy);
    if (d < BR0 - 3) { mid.push(y * BS + x); continue; }
    if (d > BR0 + BLEN + 6) continue;
    idx.push(y * BS + x); dist.push(d); ang.push(((Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * BTAB); // 0 at the top, clockwise
  }
  blobGrid = { idx: Int32Array.from(idx), dist: Float32Array.from(dist), ang: Float32Array.from(ang), mid: Int32Array.from(mid) };
  return blobGrid;
}
function blurCircular(a, radius, passes) {
  let src = a, dst = new Float64Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < src.length; i++) { let s = 0; for (let k = -radius; k <= radius; k++) s += src[(i + k + src.length) % src.length]; dst[i] = s / (2 * radius + 1); }
    [src, dst] = [dst, src];
  }
  return src;
}
function blobTable(levels, shape, scale) { // levels (0..1 per band) -> the edge's distance from the centre for BTAB angles round the circle
  const nb = levels.length, raw = new Float64Array(BTAB), bass = (levels[0] + levels[1] + levels[2]) / 3;
  for (let i = 0; i < BTAB; i++) {
    const th = i / BTAB * 2 * Math.PI, phi = th <= Math.PI ? th : 2 * Math.PI - th, deg = phi * 180 / Math.PI; // 0 = top, 180 = bottom, same on both sides
    const u = shape === 'wings' ? Math.min(1, Math.abs(deg - 40) / 140) : (180 - deg) / 180, p = u * (nb - 1), i0 = Math.min(nb - 2, Math.floor(p)), fr = p - i0;
    const lev = Math.pow(levels[i0] * (1 - fr) + levels[i0 + 1] * fr, 1.15);
    if (shape === 'wings') { // two wings (ears) at about 38 degrees either side of the top, always there and as tall as the bass is loud; the rest follows the other sounds
      const lobe = Math.exp(-(((deg - 38) / 17) ** 2));
      raw[i] = Math.max(lobe * Math.min(1.1, 0.4 + 0.85 * bass), 0.7 * lev * (1 - 0.5 * smooth(phi / Math.PI)));
    } else raw[i] = lev;
  }
  const sm = blurCircular(raw, 9, 2), out = new Float32Array(BTAB + 1);
  for (let i = 0; i < BTAB; i++) out[i] = BR0 + (0.05 + 0.95 * Math.min(1, sm[i] * 1.12)) * BLEN * scale;
  out[BTAB] = out[0];
  return out;
}
export function blobPicture(history, f, { style = 'filled', shape = 'wings' } = {}, buf = Buffer.alloc(BS * BS)) {
  const g = blobPixels(), layers = BLAYERS[style] || BLAYERS.filled, tabs = layers.map((l) => blobTable(history[Math.max(0, f - l.lag)], shape, l.scale));
  const inside = style === 'outline' ? 46 : 255;
  buf.fill(0);
  for (let n = 0; n < g.mid.length; n++) buf[g.mid[n]] = inside; // the middle (always covered)
  for (let n = 0; n < g.idx.length; n++) {
    const d = g.dist[n], a = g.ang[n], i0 = Math.floor(a), fr = a - i0;
    let val = 0;
    for (let j = 0; j < layers.length; j++) {
      const t = tabs[j], r = t[i0] * (1 - fr) + t[i0 + 1] * fr, cover = Math.min(1, Math.max(0, r - d + 0.5));
      const ratio = (t[i0 + 1] - t[i0]) / (2 * Math.PI / BTAB) / Math.max(1, d), k = Math.sqrt(1 + ratio * ratio); // slope of the edge, so the line is equally thick everywhere
      const edge = Math.min(1, Math.max(0, (2.4 + 0.9 - Math.abs(d - r) / k) / 1.8));
      if (style === 'outline') val = Math.max(val, cover * 46, edge * 255);
      else if (style === 'layers') val = Math.max(val, cover * layers[j].int, edge * Math.min(255, layers[j].int + 75));
      else val = Math.max(val, cover * 255);
    }
    buf[g.idx[n]] = Math.round(val);
  }
  return buf;
}
async function writeBlobVideo(audioPath, start, t, outFile, opts) {
  const frames = Math.floor(Number(t) * FPS), levels = waveLevels(await pcmOf(audioPath, start, t), frames), fd = fs.openSync(outFile, 'w'), buf = Buffer.alloc(BS * BS);
  try { for (let f = 0; f < frames; f++) { blobPicture(levels, f, opts, buf); fs.writeSync(fd, buf); } } finally { fs.closeSync(fd); }
  return frames;
}

// "0xrrggbb" -> ffmpeg colorchannelmixer arguments that turn a white picture into that colour
const tint = (c) => { const n = parseInt(String(c).replace(/^0x/i, ''), 16); return `rr=${(((n >> 16) & 255) / 255).toFixed(3)}:gg=${(((n >> 8) & 255) / 255).toFixed(3)}:bb=${((n & 255) / 255).toFixed(3)}`; };

// The soft shade at the bottom of the bars layout is a fixed grey picture (white = untouched, darker = shaded) made once and multiplied over the
// thumbnail. Doing the same maths per pixel on every frame (geq) is far too slow for a 30 s clip on a small server.
let shadeReady = null;
function ensureShade() {
  if (shadeReady) return shadeReady;
  const dir = path.join(os.tmpdir(), 'rio-eqmaps-v2-flat'), f = path.join(dir, 'shade.png');
  shadeReady = (async () => {
    if (fs.existsSync(f) && fs.statSync(f).size > 100) return f;
    fs.mkdirSync(dir, { recursive: true });
    const Y0 = Math.round(H * 0.4), tmp = `${f}.${process.pid}.png`;
    await run(['-f', 'lavfi', '-i', `nullsrc=s=${W}x${H},format=gray,geq=lum='255*(1-0.72*pow(clip((Y-${Y0})/${H - Y0},0,1),1.35))'`, '-frames:v', '1', tmp], 60000);
    fs.renameSync(tmp, f);
    return f;
  })().catch((err) => { shadeReady = null; throw err; });
  return shadeReady;
}

// Pulse: how big the round badge is on every frame. The song's low sounds (kick drum, bass) are measured 20 times a second, so the badge swells
// on the beat and settles back. Written as a "sendcmd" file that ffmpeg's scale filter reads while it renders.
const PULSE = 0.16, BASE = 2 * Math.round(RING / (1 + PULSE) / 2); // at rest the badge is smaller, on the loudest beat it grows to its normal size (never over the bars)
function pulseSizes(audioPath, start, t) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, Math.floor(start))), '-t', t, '-i', audioPath, '-vn', '-ac', '1', '-ar', '8000', '-af', 'lowpass=f=180', '-f', 's16le', '-'],
      { timeout: 60000, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, out, stderr) => {
        if (err) return reject(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 200)}`));
        const per = Math.floor(8000 / FPS), frames = Math.floor(out.length / 2 / per), rms = [];
        for (let f = 0; f < frames; f++) { let sum = 0; for (let i = 0; i < per; i++) { const v = out.readInt16LE((f * per + i) * 2); sum += v * v; } rms.push(Math.sqrt(sum / per)); }
        const sorted = [...rms].sort((a, b) => a - b), top = sorted[Math.floor(sorted.length * 0.95)] || 1, low = sorted[Math.floor(sorted.length * 0.2)] || 0;
        let env = 0;
        resolve(rms.map((r) => { const x = Math.min(1, Math.max(0, (r - low) / Math.max(1, top - low))); env = Math.max(x, env * 0.8); return 2 * Math.round(BASE * (1 + PULSE * env) / 2); })); // even sizes only
      });
  });
}

let chain = Promise.resolve(); // one clip at a time: ffmpeg is heavy on a small server

// pic: jpg buffer of the song thumbnail (or null = plain dark background), audio: the downloaded song, ext: its file extension.
// opts: { seconds, style, layout, start, badge, spin } (start = second of the song where the clip begins; badge = picture for the middle of the round layout,
// e.g. the channel logo or the host's own picture, default = the thumbnail; spin = false keeps the middle picture still). Returns a silent mp4 buffer (send it with gifPlayback: true).
let pending = 0; // clips waiting or being made
export function makeEqualizerVideo(pic, audio, ext, opts = {}) {
  if (pending >= QUEUE_MAX) return Promise.reject(new Error(`BUSY: ${pending} animations are already being made`)); // the caller posts the normal thumbnail instead
  pending++;
  const job = chain.then(() => render(pic, audio, ext, opts));
  chain = job.catch(() => {});
  return job.finally(() => { pending--; });
}

async function render(pic, audio, ext, { seconds = EQ_DEFAULT_S, style = 'white', layout = 'circle', start = 0, badge = null, motion = 'spin', particles = false, particleStyle = 'match', blobStyle = 'filled', blobShape = 'wings' } = {}) {
  const wave = layout === 'wave', blob = layout === 'blob';
  const maps = wave || blob ? null : await ensureMaps(layout === 'bars' ? 'flat' : 'ring'), shade = layout === 'bars' ? await ensureShade() : null, dots = particles ? await ensureDots() : null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eq-${crypto.randomBytes(3).toString('hex')}-`));
  const a = path.join(dir, `a.${String(ext || 'm4a').replace(/[^\w]/g, '') || 'm4a'}`), p = path.join(dir, 'p.jpg'), out = path.join(dir, 'out.mp4'), wv = path.join(dir, 'wave.raw');
  const bExt = imageExt(badge), b = path.join(dir, `b.${bExt || 'jpg'}`);
  const t = String(Math.min(EQ_MAX_S, Math.max(EQ_MIN_S, Math.round(seconds)))), color = EQ_STYLES[style] || EQ_STYLES.white;
  const dotColor = EQ_STYLES[particleStyle] || color; // "match" (or anything unknown) = the same colour as the animation
  try {
    fs.writeFileSync(a, audio);
    if (pic) fs.writeFileSync(p, pic);
    if (badge && bExt) fs.writeFileSync(b, badge);
    const loop = (f) => ['-loop', '1', '-framerate', String(FPS), '-t', t, '-i', f];
    const still = pic ? loop(p) : ['-f', 'lavfi', '-t', t, '-i', `color=c=0x374151:s=${W}x${H}:r=${FPS}`];
    const spin = motion === 'spin' || motion === 'both', pulse = motion === 'pulse' || motion === 'both';
    const song = ['-ss', String(Math.max(0, Math.floor(start))), '-t', t, '-i', a];
    // audio -> bars (a little treble boost so the right side moves as much as the left)
    const hear = 'aformat=channel_layouts=mono,dynaudnorm=f=150:g=5,treble=g=7:f=2000,volume=2.2';
    const bg = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
    let inputs, graph;
    if (wave) {
      // the picture stays bright; the line (drawn above from the song's spectrum) is coloured and given a tight and a wide glow
      await writeWaveVideo(a, start, t, wv);
      graph = [
        `[0:v]${bg},fps=${FPS},eq=brightness=-0.05:saturation=1.1,format=gbrp[bg]`,
        `[1:v]format=gbrp,colorchannelmixer=${tint(color)},pad=${W}:${H}:0:${H - WVH}:black,split=3[w1][w2][w3]`,
        '[w2]gblur=sigma=5[g1]', '[w3]gblur=sigma=16[g2]',
        '[w1][g1]blend=all_mode=addition[x1]', '[x1][g2]blend=all_mode=addition[wv]',
        '[bg][wv]blend=all_mode=screen[vb]',
      ];
      inputs = [...still, '-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', `${W}x${WVH}`, '-framerate', String(FPS), '-i', wv];
    } else if (layout === 'bars') {
      // the picture stays bright and fades smoothly towards the bottom (no hard black band), the bars glow on top of the soft shade
      graph = [
        `[0:v]${bg},fps=${FPS},format=gbrp[pic]`, '[4:v]format=gbrp[sh]', '[pic][sh]blend=all_mode=multiply[bg]',
        `[1:a]${hear},showfreqs=s=${NB}x${HS}:rate=${FPS}:mode=bar:fscale=log:ascale=sqrt:win_size=2048:colors=${color},format=gbrp,pad=${NB + 1}:${HS}:0:0:black[src]`,
        '[2:v]format=gray16le[xm]', '[3:v]format=gray16le[ym]',
        `[src][xm][ym]remap,format=gbrp,pad=${W}:${H}:0:${H - EH - BBOT}:black,split[b1][b2]`,
        '[b2]gblur=sigma=6[glow]', '[b1][glow]blend=all_mode=addition[bars]',
        '[bg][bars]blend=all_mode=screen[vb]',
      ];
      inputs = [...still, ...song, ...loop(maps.x), ...loop(maps.y), ...loop(shade)];
    } else {
      let cmdFile = null;
      if (pulse) { // one line per frame: time + new size
        const sizes = await pulseSizes(a, start, t);
        cmdFile = path.join(dir, 'pulse.cmd');
        fs.writeFileSync(cmdFile, sizes.map((z, f) => `${(f / FPS).toFixed(3)} scale@p w ${z}, scale@p h ${z};`).join('\n'));
      }
      const hasBadge = Boolean(badge && bExt), custom = hasBadge || Boolean(pic);
      const disc = (extra = '') => `format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(hypot(X-W/2+0.5,Y-H/2+0.5),W/2-1),255,0)'${extra}`; // round alpha mask
      // inputs: 0 = background picture, then (only when there is a picture for the middle) 1 = badge picture, then the song and the two maps
      let i = 1;
      const badgeSrc = custom ? `[${i++}:v]crop='min(iw,ih)':'min(iw,ih)',scale=` : `color=c=0x6b7280:s=${DISC}x${DISC}:r=${FPS},scale=`;
      let iA, iX, iY, iB;
      if (blob) { iB = i++; await writeBlobVideo(a, start, t, wv, { style: blobStyle, shape: blobShape }); } else { iA = i++; iX = i++; iY = i++; } // blob: one raw picture of the shape per frame instead of the bars' sound + maps
      graph = [
        `[0:v]${bg},gblur=sigma=7,eq=brightness=-0.16,format=gbrp[bg]`,
        `${badgeSrc}${DISC}:${DISC},${disc()},${spin ? "rotate=a='t*0.8':c=none:ow=iw:oh=ih" : 'null'}[badge]`,
        `color=c=white:s=${RING}x${RING}:r=${FPS},${disc()}[ring]`,
        `[ring][badge]overlay=(W-w)/2:(H-h)/2:format=auto${cmdFile ? `,sendcmd=f=${cmdFile},scale@p=w=${BASE}:h=${BASE}:eval=frame` : ''}[disc]`,
        ...(blob ? [`[${iB}:v]format=gbrp,colorchannelmixer=${tint(color)},pad=${W}:${H}:${(W - BS) / 2}:${(H - BS) / 2}:black,split[b1][b2]`] : [
          `[${iA}:a]${hear},showfreqs=s=${N}x${HS}:rate=${FPS}:mode=bar:fscale=log:ascale=sqrt:win_size=2048:colors=${color},format=gbrp,pad=${N + 1}:${HS}:0:0:black[src]`,
          `[${iX}:v]format=gray16le[xm]`, `[${iY}:v]format=gray16le[ym]`,
          '[src][xm][ym]remap,format=gbrp,split[b1][b2]']),
        `[b2]gblur=sigma=${blob ? 7 : 5}[glow]`, '[b1][glow]blend=all_mode=addition[bars]',
        '[bg][bars]blend=all_mode=screen[t]',
        '[t][disc]overlay=(W-w)/2:(H-h)/2:format=auto[vb]',
      ];
      inputs = [...still, ...(hasBadge ? loop(b) : pic ? loop(p) : []), ...(blob ? ['-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', `${BS}x${BS}`, '-framerate', String(FPS), '-i', wv] : [...song, ...loop(maps.x), ...loop(maps.y)])];
    }
    if (particles) { // add-on for every layout: two layers of soft dots drifting upwards over the finished picture, in their own colour
      const n = inputs.filter((x) => x === '-i').length, mix = tint(dotColor);
      graph.push(
        '[vb]format=gbrp[vq]',
        `[${n}:v]scroll=v=-0.0035:h=0.0012,format=gbrp,colorchannelmixer=${mix}[pa]`, `[${n + 1}:v]scroll=v=-0.0085:h=-0.002,format=gbrp,colorchannelmixer=${mix}[pb]`,
        '[vq][pa]blend=all_mode=screen[q1]', '[q1][pb]blend=all_mode=screen,format=yuv420p[v]',
      );
      inputs.push(...loop(dots.a), ...loop(dots.b));
    } else graph.push('[vb]format=yuv420p[v]');
    await run([...inputs, '-filter_complex', graph.join(';'), '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-r', String(FPS), '-t', t, '-movflags', '+faststart', out], 90000 + Number(t) * 6000);
    return fs.readFileSync(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
