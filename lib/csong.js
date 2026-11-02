// .chsong look (host setting, /admin > Channels > "Channel song"):
//   normal    = the thumbnail picture with the song details, then the voice note (the old behaviour)
//   equalizer = a short silent looping clip (GIF style, 640x360) made from the song's own thumbnail, then the voice note:
//     layout "circle": a round, slowly turning badge in the middle with a ring of equalizer bars around it (glowing),
//                      on a blurred, darkened copy of the song's thumbnail. The badge shows the song's thumbnail ("thumbnail")
//                      or the logo of the channel / group the song is posted to ("channel") or a picture the host uploaded ("custom"): host setting "centre picture".
//                      The middle picture turns slowly, or stays still (host setting "spin")
//     layout "bars"  : the thumbnail with chunky, glowing equalizer bars along the bottom (the picture fades smoothly into the bars, no black band)
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
export const EQ_CENTERS = ['thumbnail', 'channel', 'custom']; // circle layout: what sits inside the round badge (song thumbnail, channel / group logo, or a picture the host uploaded)
const IMG_KEY = 'csongCenterImg'; // the uploaded picture, kept as base64 in the settings (disk or MongoDB), about 30 to 120 KB
export const EQ_MIN_S = 4, EQ_MAX_S = 30, EQ_DEFAULT_S = 8;

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
    spin: getSetting(G, 'csongEqSpin', true) !== false, // the middle picture turns slowly (true) or stays still (false)
    hasImage,
  };
}

export function setCsong({ mode, seconds, style, layout, center, spin }) {
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
  if (spin !== undefined) {
    if (typeof spin !== 'boolean') throw new Error('Spin must be on or off.');
    setSetting(G, 'csongEqSpin', spin);
  }
  return getCsong();
}

// The host's own centre picture: any JPG / PNG / WEBP / GIF, cut to a square, 512 px, saved as a small JPEG (transparent parts become dark grey).
export function getCenterImage() {
  const v = getSetting(G, IMG_KEY, null);
  return v?.b ? Buffer.from(v.b, 'base64') : null;
}
export async function setCenterImage(buf) {
  const { default: sharp } = await import('sharp');
  const base = sharp(buf, { limitInputPixels: 40e6, failOn: 'error' }).rotate().flatten({ background: '#1f2937' }).resize({ width: 512, height: 512, fit: 'cover' });
  let out;
  for (const q of [90, 80, 68, 55]) { out = await base.clone().jpeg({ quality: q }).toBuffer(); if (out.length <= 250 * 1024) break; }
  setSetting(G, IMG_KEY, { b: out.toString('base64'), at: Date.now() });
  return out.length;
}
export function clearCenterImage() {
  setSetting(G, IMG_KEY, null);
  if (getSetting(G, 'csongEqCenter', 'thumbnail') === 'custom') setSetting(G, 'csongEqCenter', 'thumbnail');
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

let chain = Promise.resolve(); // one clip at a time: ffmpeg is heavy on a small server

// pic: jpg buffer of the song thumbnail (or null = plain dark background), audio: the downloaded song, ext: its file extension.
// opts: { seconds, style, layout, start, badge, spin } (start = second of the song where the clip begins; badge = picture for the middle of the round layout,
// e.g. the channel logo or the host's own picture, default = the thumbnail; spin = false keeps the middle picture still). Returns a silent mp4 buffer (send it with gifPlayback: true).
export function makeEqualizerVideo(pic, audio, ext, opts = {}) {
  const job = chain.then(() => render(pic, audio, ext, opts));
  chain = job.catch(() => {});
  return job;
}

async function render(pic, audio, ext, { seconds = EQ_DEFAULT_S, style = 'white', layout = 'circle', start = 0, badge = null, spin = true } = {}) {
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
        '[ring][badge]overlay=(W-w)/2:(H-h)/2:format=auto[disc]',
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
