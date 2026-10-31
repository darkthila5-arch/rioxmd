// Sticker conversions for commands/stickertools.js
//   imageToSticker(buf, meta)  photo            -> static WebP sticker
//   videoToSticker(buf, meta)  video / gif      -> animated WebP sticker
//   stickerToPng(buf)          static sticker   -> PNG
//   stickerToMp4(buf)          animated sticker -> MP4
// meta = { name, author }: shown on WhatsApp as the sticker pack name and publisher (we use the bot name and the footer).
//
// Needs ffmpeg (in the Docker image). Animated sticker -> video also needs `anim_dump` from the Debian package `webp`
// (ffmpeg cannot decode animated WebP); the Dockerfile installs it. Everything else is plain Node, no extra npm packages.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const STICKER_SIZE = 512;
export const MAX_INPUT_BYTES = 20 * 1024 * 1024; // refuse bigger downloads
export const MAX_ANIM_SECONDS = 8;                // longer videos are cut to this
const MAX_STATIC_BYTES = 100 * 1024;              // WhatsApp's own limit for static stickers
const MAX_ANIM_BYTES = 900 * 1024;                // WhatsApp's limit for animated stickers is 1 MB
const MAX_FRAMES = 400;                           // safety limit when turning an animated sticker into a video
const MIN_VIDEO_MS = 3000;                        // short stickers are repeated until the video lasts about this long

/* ---------- running ffmpeg without flooding the server ---------- */
const MAX_JOBS = Math.max(1, Number(process.env.MAX_STICKER_JOBS || 2));
let running = 0;
const waiting = [];
async function limited(fn) {
  if (running >= MAX_JOBS) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

function run(cmd, args, timeout = 90000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(Object.assign(new Error(`${cmd} is not installed`), { missing: cmd }));
      reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(-300)}`));
    });
  });
}

async function withTmp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rio-stk-'));
  try { return await fn(dir); } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/* ---------- WebP container: read chunks, add the EXIF chunk that carries the pack name / author ---------- */
function readChunks(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not a WebP file');
  const chunks = [];
  for (let p = 12; p + 8 <= buf.length;) {
    const type = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const end = Math.min(p + 8 + size, buf.length);
    chunks.push({ type, data: buf.subarray(p + 8, end) });
    p += 8 + size + (size & 1);
  }
  return chunks;
}

function writeChunks(chunks) {
  const parts = [];
  for (const { type, data } of chunks) {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    parts.push(head, data);
    if (data.length & 1) parts.push(Buffer.alloc(1));
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

function imageSize(chunk) { // width / height of a plain VP8 or VP8L picture
  const d = chunk.data;
  if (chunk.type === 'VP8 ' && d.length >= 10) return { w: d.readUInt16LE(6) & 0x3fff, h: d.readUInt16LE(8) & 0x3fff, alpha: false };
  if (chunk.type === 'VP8L' && d.length >= 5) {
    const bits = d.readUInt32LE(1);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1, alpha: !!((bits >> 28) & 1) };
  }
  return null;
}

function vp8x(flags, w, h) {
  const d = Buffer.alloc(10);
  d[0] = flags;
  d.writeUIntLE(w - 1, 4, 3);
  d.writeUIntLE(h - 1, 7, 3);
  return { type: 'VP8X', data: d };
}

export function makeExif(name, author) {
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
    'sticker-pack-name': String(name || ''),
    'sticker-pack-publisher': String(author || ''),
    emojis: [],
  }), 'utf8');
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
  const exif = Buffer.concat([tiff, json]);
  exif.writeUInt32LE(json.length, 14);
  return exif;
}

// Puts the sticker pack name / author into a WebP file (static or animated).
export function addStickerMeta(webp, { name, author }) {
  let chunks = readChunks(webp).filter((c) => c.type !== 'EXIF');
  if (chunks[0]?.type === 'VP8X') {
    chunks[0] = { type: 'VP8X', data: Buffer.from(chunks[0].data) };
    chunks[0].data[0] |= 0x08; // "has EXIF" flag
  } else {
    const pic = chunks.map(imageSize).find(Boolean);
    if (!pic) throw new Error('unsupported WebP');
    chunks = [vp8x(0x08 | (pic.alpha ? 0x10 : 0), pic.w, pic.h), ...chunks];
  }
  chunks.push({ type: 'EXIF', data: makeExif(name, author) });
  return writeChunks(chunks);
}

// Size, frame count and frame times of an animated WebP.
export function webpInfo(buf) {
  const chunks = readChunks(buf);
  const head = chunks.find((c) => c.type === 'VP8X');
  const durations = chunks.filter((c) => c.type === 'ANMF' && c.data.length >= 16).map((c) => c.data.readUIntLE(12, 3));
  const animated = durations.length > 0 || !!(head && (head.data[0] & 0x02));
  let w = STICKER_SIZE, h = STICKER_SIZE;
  if (head) { w = head.data.readUIntLE(4, 3) + 1; h = head.data.readUIntLE(7, 3) + 1; }
  else { const pic = chunks.map(imageSize).find(Boolean); if (pic) ({ w, h } = pic); }
  return { animated, width: w, height: h, durations };
}

/* ---------- to sticker ---------- */
// Fit inside 512x512 and fill the rest with transparent pixels (nothing is cropped or stretched).
const FIT = `format=rgba,scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1`;

export function imageToSticker(input, meta) {
  return limited(() => withTmp(async (dir) => {
    const src = path.join(dir, 'in'), out = path.join(dir, 'out.webp');
    await fs.writeFile(src, input);
    let best = null;
    for (const q of [80, 60, 40, 25]) { // keep the picture as good as possible while staying under WhatsApp's size limit
      await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-frames:v', '1', '-vf', FIT, '-c:v', 'libwebp', '-lossless', '0', '-quality', String(q), '-compression_level', '6', '-f', 'webp', out], 60000);
      const buf = await fs.readFile(out);
      if (!best || buf.length < best.length) best = buf;
      if (buf.length <= MAX_STATIC_BYTES) break;
    }
    return addStickerMeta(best, meta);
  }));
}

export function videoToSticker(input, meta) {
  return limited(() => withTmp(async (dir) => {
    const src = path.join(dir, 'in'), out = path.join(dir, 'out.webp');
    await fs.writeFile(src, input);
    let best = null;
    for (const [fps, q] of [[15, 50], [12, 38], [10, 28], [8, 20]]) { // smaller and smaller until it fits (WhatsApp: max 1 MB)
      await run('ffmpeg', ['-y', '-v', 'error', '-t', String(MAX_ANIM_SECONDS), '-i', src, '-an', '-vf', `fps=${fps},${FIT}`, '-c:v', 'libwebp', '-lossless', '0', '-quality', String(q), '-compression_level', '6', '-preset', 'default', '-loop', '0', '-f', 'webp', out], 120000);
      const buf = await fs.readFile(out);
      if (!best || buf.length < best.length) best = buf;
      if (buf.length <= MAX_ANIM_BYTES) break;
    }
    if (best.length > 1024 * 1024) throw Object.assign(new Error('sticker too big'), { tooBig: true });
    return addStickerMeta(best, meta);
  }));
}

/* ---------- from sticker ---------- */
export function stickerToPng(input) {
  return limited(() => withTmp(async (dir) => {
    const src = path.join(dir, 'in.webp'), out = path.join(dir, 'out.png');
    await fs.writeFile(src, input);
    await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-frames:v', '1', out], 60000);
    return fs.readFile(out);
  }));
}

export async function stickerToMp4(input) {
  const info = webpInfo(input);
  if (!info.animated) throw Object.assign(new Error('not animated'), { notAnimated: true });
  if (info.durations.length > MAX_FRAMES) throw Object.assign(new Error('too many frames'), { tooLong: true });
  return limited(() => withTmp(async (dir) => {
    const src = path.join(dir, 'in.webp'), out = path.join(dir, 'out.mp4');
    await fs.writeFile(src, input);
    // anim_dump puts the frames together correctly (partial frames, blending) and writes one full PNG per frame.
    await run('anim_dump', ['-folder', dir, '-prefix', 'f_', src], 60000);
    const frames = (await fs.readdir(dir)).filter((f) => /^f_\d+\.png$/.test(f)).sort();
    if (!frames.length) throw new Error('no frames');
    const secs = frames.map((_, i) => Math.max(Number(info.durations[i] ?? 100), 20) / 1000); // 0 ms frames are shown for 100 ms by browsers; avoid zero / tiny values
    const total = secs.reduce((a, b) => a + b, 0) * 1000;
    const loops = Math.min(20, Math.max(1, Math.ceil(MIN_VIDEO_MS / Math.max(total, 1)))); // repeat short loops so the video is not over in a blink
    const list = [];
    for (let l = 0; l < loops; l++) frames.forEach((f, i) => list.push(`file '${f}'`, `duration ${secs[i].toFixed(3)}`));
    list.push(`file '${frames[frames.length - 1]}'`); // the concat demuxer ignores the last duration unless the file is repeated
    await fs.writeFile(path.join(dir, 'list.txt'), list.join('\n'));
    const even = (n) => Math.max(2, n - (n % 2));
    const filter = `color=c=black:s=${even(info.width)}x${even(info.height)}:r=25[bg];[bg][0:v]overlay=shortest=1:format=auto,format=yuv420p`;
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-filter_complex', filter, '-r', '25', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-movflags', '+faststart', '-an', out], 120000);
    return fs.readFile(out);
  }));
}
