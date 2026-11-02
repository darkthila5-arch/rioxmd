// .chsong look (host setting, /admin > Channels > "Channel song"):
//   normal    = the thumbnail picture with the song details, then the voice note (the old behaviour)
//   equalizer = a short silent looping clip (GIF style, 640x360) made from the song's own thumbnail, then the voice note:
//     layout "circle": a round, slowly turning badge in the middle with a ring of equalizer bars around it (glowing),
//                      on a blurred, darkened copy of the song's thumbnail. The badge shows the song's thumbnail ("thumbnail")
//                      or the logo of the channel / group the song is posted to ("channel") or a picture the host uploaded ("custom"): host setting "centre picture".
//                      The middle picture turns slowly, stays still, pulses with the beat, or both (setting "motion")
//     layout "bars"  : the thumbnail with chunky, glowing equalizer bars along the bottom (the picture fades smoothly into the bars, no black band)
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
export const EQ_STYLES = { white: '0xffffff', cyan: '0x00e5ff', green: '0x39ff14', pink: '0xff2d95', gold: '0xffc400' };
export const EQ_LAYOUTS = ['circle', 'bars'];
export const EQ_MOTIONS = ['spin', 'still', 'pulse', 'both']; // middle picture: turns slowly / stays still / pulses with the beat / turns and pulses
export const EQ_CENTERS = ['thumbnail', 'channel', 'custom']; // circle layout: what sits inside the round badge (song thumbnail, channel / group logo, or a picture the host uploaded)
// Settings a premium number can change for itself (same names as the host's, but stored under the number). Empty = use the host's default.
export const CSONG_USER_KEYS = ['csongMode', 'csongEqLayout', 'csongEqStyle', 'csongEqCenter', 'csongEqMotion', 'csongEqSeconds'];
export const CSONG_USER_OPTIONS = { csongMode: ['normal', 'equalizer'], csongEqLayout: EQ_LAYOUTS, csongEqStyle: Object.keys(EQ_STYLES), csongEqCenter: EQ_CENTERS, csongEqMotion: EQ_MOTIONS };
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
  };
}

export function setCsong({ mode, seconds, style, layout, center, motion }) {
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

async function render(pic, audio, ext, { seconds = EQ_DEFAULT_S, style = 'white', layout = 'circle', start = 0, badge = null, motion = 'spin' } = {}) {
  const maps = await ensureMaps(layout === 'bars' ? 'flat' : 'ring'), shade = layout === 'bars' ? await ensureShade() : null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eq-${crypto.randomBytes(3).toString('hex')}-`));
  const a = path.join(dir, `a.${String(ext || 'm4a').replace(/[^\w]/g, '') || 'm4a'}`), p = path.join(dir, 'p.jpg'), out = path.join(dir, 'out.mp4');
  const bExt = imageExt(badge), b = path.join(dir, `b.${bExt || 'jpg'}`);
  const t = String(Math.min(EQ_MAX_S, Math.max(EQ_MIN_S, Math.round(seconds)))), color = EQ_STYLES[style] || EQ_STYLES.white;
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
    let args, graph;
    if (layout === 'bars') {
      // the picture stays bright and fades smoothly towards the bottom (no hard black band), the bars glow on top of the soft shade
      graph = [
        `[0:v]${bg},fps=${FPS},format=gbrp[pic]`, '[4:v]format=gbrp[sh]', '[pic][sh]blend=all_mode=multiply[bg]',
        `[1:a]${hear},showfreqs=s=${NB}x${HS}:rate=${FPS}:mode=bar:fscale=log:ascale=sqrt:win_size=2048:colors=${color},format=gbrp,pad=${NB + 1}:${HS}:0:0:black[src]`,
        '[2:v]format=gray16le[xm]', '[3:v]format=gray16le[ym]',
        `[src][xm][ym]remap,format=gbrp,pad=${W}:${H}:0:${H - EH - BBOT}:black,split[b1][b2]`,
        '[b2]gblur=sigma=6[glow]', '[b1][glow]blend=all_mode=addition[bars]',
        '[bg][bars]blend=all_mode=screen,format=yuv420p[v]',
      ].join(';');
      args = [...still, ...song, ...loop(maps.x), ...loop(maps.y), ...loop(shade), '-filter_complex', graph];
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
      const iA = i++, iX = i++, iY = i++;
      graph = [
        `[0:v]${bg},gblur=sigma=7,eq=brightness=-0.16,format=gbrp[bg]`,
        `${badgeSrc}${DISC}:${DISC},${disc()},${spin ? "rotate=a='t*0.8':c=none:ow=iw:oh=ih" : 'null'}[badge]`,
        `color=c=white:s=${RING}x${RING}:r=${FPS},${disc()}[ring]`,
        `[ring][badge]overlay=(W-w)/2:(H-h)/2:format=auto${cmdFile ? `,sendcmd=f=${cmdFile},scale@p=w=${BASE}:h=${BASE}:eval=frame` : ''}[disc]`,
        `[${iA}:a]${hear},showfreqs=s=${N}x${HS}:rate=${FPS}:mode=bar:fscale=log:ascale=sqrt:win_size=2048:colors=${color},format=gbrp,pad=${N + 1}:${HS}:0:0:black[src]`,
        `[${iX}:v]format=gray16le[xm]`, `[${iY}:v]format=gray16le[ym]`,
        '[src][xm][ym]remap,format=gbrp,split[b1][b2]',
        '[b2]gblur=sigma=5[glow]', '[b1][glow]blend=all_mode=addition[bars]',
        '[bg][bars]blend=all_mode=screen[t]',
        '[t][disc]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p[v]',
      ].join(';');
      args = [...still, ...(hasBadge ? loop(b) : pic ? loop(p) : []), ...song, ...loop(maps.x), ...loop(maps.y), '-filter_complex', graph];
    }
    await run([...args, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-r', String(FPS), '-t', t, '-movflags', '+faststart', out], 90000 + Number(t) * 6000);
    return fs.readFileSync(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
