// .chsong look (host setting, /admin > Channels > "Channel song"):
//   normal    = the thumbnail picture with the song details, then the voice note (the old behaviour)
//   equalizer = a short silent looping clip (GIF style, 640x360) made from the song's own thumbnail, then the voice note:
//     layout "circle": the thumbnail as a round, slowly turning badge in the middle with a ring of equalizer bars around it (glowing),
//                      on a blurred, darkened copy of the same thumbnail
//     layout "bars"  : the thumbnail with equalizer bars along the bottom
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
export const EQ_MIN_S = 4, EQ_MAX_S = 30, EQ_DEFAULT_S = 8;

export function getCsong() {
  const seconds = Math.round(Number(getSetting(G, 'csongEqSeconds', EQ_DEFAULT_S)));
  const style = getSetting(G, 'csongEqStyle', 'white');
  const layout = getSetting(G, 'csongEqLayout', 'circle');
  return {
    mode: getSetting(G, 'csongMode', 'normal') === 'equalizer' ? 'equalizer' : 'normal',
    seconds: Number.isFinite(seconds) ? Math.min(EQ_MAX_S, Math.max(EQ_MIN_S, seconds)) : EQ_DEFAULT_S,
    style: EQ_STYLES[style] ? style : 'white',
    layout: EQ_LAYOUTS.includes(layout) ? layout : 'circle',
  };
}

export function setCsong({ mode, seconds, style, layout }) {
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
  return getCsong();
}

// Where in the song the clip starts: a little way in (intros are often quiet), but always inside the song.
export const clipStart = (songSeconds, clipSeconds) => (songSeconds > 0 ? Math.max(0, Math.min(60, Math.floor(songSeconds * 0.2), Math.floor(songSeconds - clipSeconds - 2))) : 0);

const W = 640, H = 360, FPS = 20;
const CX = W / 2, CY = H / 2, R0 = 84, LEN = 66, N = 36, HS = 96; // circle layout: ring starts at radius R0, bars are up to LEN long, N bars on each half
const DISC = 156, RING = 170;                                       // badge size and the white ring around it
const run = (args, timeout) => new Promise((resolve, reject) => {
  execFile('ffmpeg', ['-y', '-v', 'error', ...args], { timeout }, (err, _o, stderr) => (err ? reject(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 200)}`)) : resolve()));
});

// The round layout needs two fixed "where does this pixel come from" maps (x and y) that turn a flat bar chart into a ring.
// They never change, so they are made once and kept in the temp folder.
let mapsReady = null;
function ensureMaps() {
  if (mapsReady) return mapsReady;
  const dir = path.join(os.tmpdir(), 'rio-eqmaps-v1'), x = path.join(dir, 'x.png'), y = path.join(dir, 'y.png');
  mapsReady = (async () => {
    if (fs.existsSync(x) && fs.existsSync(y) && fs.statSync(x).size > 100 && fs.statSync(y).size > 100) return { x, y };
    fs.mkdirSync(dir, { recursive: true });
    const dx = `(X-${CX})`, dy = `(Y-${CY})`, r = `hypot(${dx},${dy})`, u = `(atan2(abs${dx},${dy})/PI*${N})`; // u = 0 at the bottom, N at the top (mirrored left / right)
    const xe = `if(between(${r},${R0},${R0 + LEN})*lt(${u}-floor(${u}),0.58),min(floor(${u}),${N - 1}),${N})`;       // bar number, or the black spare column (= gap)
    const ye = `if(between(${r},${R0},${R0 + LEN}),clip(${HS - 1}-(${r}-${R0})*${HS - 1}/${LEN},0,${HS - 1}),0)`;  // how far up the bar this pixel is
    const tmpX = `${x}.${process.pid}.png`, tmpY = `${y}.${process.pid}.png`;
    for (const [out, expr] of [[tmpX, xe], [tmpY, ye]]) await run(['-f', 'lavfi', '-i', `nullsrc=s=${W}x${H},format=gray16le,geq=lum='${expr}'`, '-frames:v', '1', '-pix_fmt', 'gray16be', out], 60000);
    fs.renameSync(tmpX, x); fs.renameSync(tmpY, y);
    return { x, y };
  })().catch((err) => { mapsReady = null; throw err; });
  return mapsReady;
}

let chain = Promise.resolve(); // one clip at a time: ffmpeg is heavy on a small server

// pic: jpg buffer (or null = plain dark background), audio: the downloaded song, ext: its file extension.
// opts: { seconds, style, layout, start } (start = second of the song where the clip begins). Returns a silent mp4 buffer (send it with gifPlayback: true).
export function makeEqualizerVideo(pic, audio, ext, opts = {}) {
  const job = chain.then(() => render(pic, audio, ext, opts));
  chain = job.catch(() => {});
  return job;
}

async function render(pic, audio, ext, { seconds = EQ_DEFAULT_S, style = 'white', layout = 'circle', start = 0 } = {}) {
  const maps = layout === 'bars' ? null : await ensureMaps();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eq-${crypto.randomBytes(3).toString('hex')}-`));
  const a = path.join(dir, `a.${String(ext || 'm4a').replace(/[^\w]/g, '') || 'm4a'}`), p = path.join(dir, 'p.jpg'), out = path.join(dir, 'out.mp4');
  const t = String(Math.min(EQ_MAX_S, Math.max(EQ_MIN_S, Math.round(seconds)))), color = EQ_STYLES[style] || EQ_STYLES.white;
  try {
    fs.writeFileSync(a, audio);
    if (pic) fs.writeFileSync(p, pic);
    const still = pic ? ['-loop', '1', '-framerate', String(FPS), '-t', t, '-i', p] : ['-f', 'lavfi', '-t', t, '-i', `color=c=0x374151:s=${W}x${H}:r=${FPS}`];
    const song = ['-ss', String(Math.max(0, Math.floor(start))), '-t', t, '-i', a];
    // audio -> bars (a little treble boost so the right side of the ring moves as much as the left)
    const hear = 'aformat=channel_layouts=mono,dynaudnorm=f=150:g=5,treble=g=7:f=2000,volume=2.2';
    let args, graph;
    if (layout === 'bars') {
      const EH = 126;
      graph = [
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},drawbox=x=0:y=${H - EH - 8}:w=${W}:h=${EH + 8}:color=black@0.55:t=fill,format=gbrp[bg]`,
        `[1:a]${hear},showfreqs=s=${W}x${EH}:rate=${FPS}:mode=bar:fscale=log:ascale=sqrt:win_size=1024:colors=${color},format=gbrp,pad=${W}:${H}:0:${H - EH}:black[eq]`,
        '[bg][eq]blend=all_mode=screen:shortest=1,format=yuv420p[v]',
      ].join(';');
      args = [...still, ...song, '-filter_complex', graph];
    } else {
      const disc = (extra = '') => `format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(hypot(X-W/2+0.5,Y-H/2+0.5),W/2-1),255,0)'${extra}`; // round alpha mask
      const badgeSrc = pic ? '[1:v]crop=\'min(iw,ih)\':\'min(iw,ih)\',scale=' : `color=c=0x6b7280:s=${DISC}x${DISC}:r=${FPS},scale=`;
      graph = [
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,gblur=sigma=7,eq=brightness=-0.16,format=gbrp[bg]`,
        `${badgeSrc}${DISC}:${DISC},${disc()},rotate=a='t*0.8':c=none:ow=iw:oh=ih[badge]`,
        `color=c=white:s=${RING}x${RING}:r=${FPS},${disc()}[ring]`,
        '[ring][badge]overlay=(W-w)/2:(H-h)/2:format=auto[disc]',
        `[${pic ? 2 : 1}:a]${hear},showfreqs=s=${N}x${HS}:rate=${FPS}:mode=bar:fscale=log:ascale=sqrt:win_size=2048:colors=${color},format=gbrp,pad=${N + 1}:${HS}:0:0:black[src]`,
        `[${pic ? 3 : 2}:v]format=gray16le[xm]`, `[${pic ? 4 : 3}:v]format=gray16le[ym]`,
        '[src][xm][ym]remap,format=gbrp,split[b1][b2]',
        '[b2]gblur=sigma=5[glow]', '[b1][glow]blend=all_mode=addition[bars]',
        '[bg][bars]blend=all_mode=screen[t]',
        '[t][disc]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p[v]',
      ].join(';');
      const mapIn = (f) => ['-loop', '1', '-framerate', String(FPS), '-t', t, '-i', f];
      // inputs: 0 = background picture, 1 = the same picture for the badge (only when there is a picture), then the song and the two maps
      args = [...still, ...(pic ? still : []), ...song, ...mapIn(maps.x), ...mapIn(maps.y), '-filter_complex', graph];
    }
    await run([...args, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-r', String(FPS), '-t', t, '-movflags', '+faststart', out], 120000);
    return fs.readFileSync(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
