// .chsong look (host setting, /admin > Channels > "Channel song"):
//   normal    = the thumbnail picture with the song details, then the voice note (the old behaviour)
//   equalizer = a short video: the thumbnail with an animated equalizer (bars that move with the music) + the same details, then the voice note
// The equalizer clip is made with ffmpeg (already in the Docker image) from the first few seconds of the song: 640x360, 15 fps, well under 1 MB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { getSetting, setSetting } from './storage.js';

const G = '_global';
export const EQ_STYLES = { cyan: '0x00e5ff', green: '0x39ff14', pink: '0xff2d95', gold: '0xffc400', white: '0xffffff' };
export const EQ_MIN_S = 8, EQ_MAX_S = 60, EQ_DEFAULT_S = 30;

export function getCsong() {
  const seconds = Math.round(Number(getSetting(G, 'csongEqSeconds', EQ_DEFAULT_S)));
  const style = getSetting(G, 'csongEqStyle', 'cyan');
  return {
    mode: getSetting(G, 'csongMode', 'normal') === 'equalizer' ? 'equalizer' : 'normal',
    seconds: Number.isFinite(seconds) ? Math.min(EQ_MAX_S, Math.max(EQ_MIN_S, seconds)) : EQ_DEFAULT_S,
    style: EQ_STYLES[style] ? style : 'cyan',
  };
}

export function setCsong({ mode, seconds, style }) {
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
  return getCsong();
}

const W = 640, H = 360, EH = 126, FPS = 15;
let chain = Promise.resolve(); // one clip at a time: ffmpeg is heavy on a small server

// pic: jpg buffer (or null = plain dark background), audio: the downloaded song, ext: its file extension. Returns an mp4 buffer.
export function makeEqualizerVideo(pic, audio, ext, { seconds = EQ_DEFAULT_S, style = 'cyan' } = {}) {
  const job = chain.then(() => run(pic, audio, ext, seconds, style));
  chain = job.catch(() => {});
  return job;
}

function run(pic, audio, ext, seconds, style) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eq-${crypto.randomBytes(3).toString('hex')}-`));
  const a = path.join(dir, `a.${String(ext || 'm4a').replace(/[^\w]/g, '') || 'm4a'}`), p = path.join(dir, 'p.jpg'), out = path.join(dir, 'out.mp4');
  const t = String(Math.min(EQ_MAX_S, Math.max(EQ_MIN_S, Math.round(seconds))));
  fs.writeFileSync(a, audio);
  if (pic) fs.writeFileSync(p, pic);
  const done = (fn) => { try { fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };
  const bgIn = pic ? ['-loop', '1', '-framerate', String(FPS), '-t', t, '-i', p] : ['-f', 'lavfi', '-t', t, '-i', `color=c=0x111827:s=${W}x${H}:r=${FPS}`];
  const graph = [
    // picture: fill 640x360, darken a strip at the bottom so the bars can be seen on any picture
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},drawbox=x=0:y=${H - EH - 8}:w=${W}:h=${EH + 8}:color=black@0.55:t=fill,format=gbrp[bg]`,
    // music -> frequency bars, laid on the bottom strip with a "screen" blend (black = nothing)
    `[1:a]aformat=channel_layouts=mono,volume=4,showfreqs=s=${W}x${EH}:rate=${FPS}:mode=bar:fscale=log:ascale=sqrt:win_size=1024:colors=${EQ_STYLES[style] || EQ_STYLES.cyan},format=gbrp,pad=${W}:${H}:0:${H - EH}:black[eq]`,
    '[bg][eq]blend=all_mode=screen:shortest=1,format=yuv420p[v]',
  ].join(';');
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-v', 'error', ...bgIn, '-t', t, '-i', a, '-filter_complex', graph, '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '29', '-r', String(FPS), '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', out],
    { timeout: 120000 }, (err, _o, stderr) => {
      if (err) return done(() => reject(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 200)}`)));
      done(() => resolve(fs.readFileSync(out)));
    });
  });
}
