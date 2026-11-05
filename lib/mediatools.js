// Helpers for commands/mediatools.js:  .tomp3  .topdf  .ocr
//   findMedia(msg, jid)         the photo / video / audio / document in this message, or in the message it replies to
//   downloadMedia(sock, media)  Buffer of that media (size checked)
//   toMp3(buf)                  video / audio / voice note -> MP3          (ffmpeg)
//   imageToPage(buf)            photo -> { jpeg, width, height } ready for a PDF page   (sharp)
//   buildPdf(pages, { title })  list of pages -> one PDF Buffer             (plain Node, no extra npm package)
//   ocrImage(buf, langs)        photo -> text                               (tesseract)
//
// Needs ffmpeg and tesseract on the server (both are in the Docker image). Nothing here touches WhatsApp except downloadMedia().
// User input never reaches a command line: ffmpeg / tesseract only get fixed options and file names made here.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { logger } from './config.js';
import { unwrapMessage } from './text.js';

export const MAX_INPUT_BYTES = Math.max(1, Number(process.env.MAX_MEDIA_MB || 30)) * 1024 * 1024; // refuse bigger downloads
export const MAX_AUDIO_SECONDS = Math.max(30, Number(process.env.MAX_MP3_SECONDS || 1200));        // longer audio is cut here (20 min)
export const MAX_PDF_PAGES = Math.max(1, Number(process.env.TOPDF_MAX_PAGES || 20));
const PAGE_MAX_PX = 2400;                                    // longest side of a PDF picture (about A4 at 200 dpi)
const TESSERACT = () => process.env.TESSERACT_PATH || 'tesseract';

/* ---------- limit how many heavy jobs run together ---------- */
export function createLimiter(max) {
  let running = 0;
  const waiting = [];
  return async (fn) => {
    if (running >= max) await new Promise((resolve) => waiting.push(resolve));
    running++;
    try { return await fn(); } finally { running--; waiting.shift()?.(); }
  };
}
const limited = createLimiter(Math.max(1, Number(process.env.MAX_MEDIA_JOBS || 2)));

function run(cmd, args, { timeout = 120000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      if (err.code === 'ENOENT') return reject(Object.assign(new Error(`${cmd} is not installed`), { missing: cmd }));
      reject(Object.assign(new Error(`${cmd} failed: ${String(stderr || err.message).slice(-300)}`), { stderr: String(stderr || '') }));
    });
  });
}

async function withTmp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rio-mt-'));
  try { return await fn(dir); } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/* ---------- find + download the media a command works on ---------- */
// Tests replace deps.download so no real WhatsApp download is needed.
export const deps = { download: downloadMediaMessage };

const num = (v) => (typeof v?.toNumber === 'function' ? v.toNumber() : Number(v || 0)); // protobuf sizes can be Long objects

function classify(m) {
  if (m.imageMessage) return { kind: 'image', part: m.imageMessage };
  if (m.videoMessage) return { kind: 'video', part: m.videoMessage };
  if (m.audioMessage) return { kind: 'audio', part: m.audioMessage };
  if (m.documentMessage) { // a file: photos / videos / audio sent "as a file" keep their real kind
    const mime = String(m.documentMessage.mimetype || '');
    const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document';
    return { kind, part: m.documentMessage };
  }
  return null;
}

// The message itself (media + caption), or else the message that was replied to. Returns { kind, part, target } or null.
export function findMedia(msg, jid) {
  const own = unwrapMessage(msg.message);
  const hit = classify(own);
  if (hit) return { ...hit, target: msg };
  const ctx = own.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
  const q = quoted && classify(quoted);
  if (!q) return null;
  return { ...q, target: { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: quoted } };
}

export async function downloadMedia(sock, media, maxBytes = MAX_INPUT_BYTES) {
  if (num(media.part.fileLength) > maxBytes) throw Object.assign(new Error('file too big'), { tooBig: true });
  let buf;
  try {
    buf = await deps.download(media.target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  } catch (err) {
    throw Object.assign(new Error(`download failed: ${err?.message || err}`), { download: true });
  }
  if (!buf?.length) throw Object.assign(new Error('empty download'), { download: true });
  if (buf.length > maxBytes) throw Object.assign(new Error('file too big'), { tooBig: true });
  return buf;
}

/* ---------- .tomp3 ---------- */
export function toMp3(input) {
  return limited(() => withTmp(async (dir) => {
    const inFile = path.join(dir, 'in.bin');
    const outFile = path.join(dir, 'out.mp3');
    await fs.writeFile(inFile, input);
    try {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inFile, '-vn', '-map', '0:a:0', '-map_metadata', '-1',
        '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', '-t', String(MAX_AUDIO_SECONDS), outFile], { timeout: 240000 });
    } catch (err) {
      if (/matches no streams|does not contain any stream|Stream map/i.test(err.stderr || err.message)) throw Object.assign(err, { noAudio: true });
      throw err;
    }
    const out = await fs.readFile(outFile);
    if (!out.length) throw Object.assign(new Error('empty mp3'), { noAudio: true });
    return out;
  }));
}

/* ---------- .topdf ---------- */
let sharpMod;
const getSharp = async () => (sharpMod ||= (await import('sharp')).default);

// Photo -> JPEG (turned upright, transparent parts white, 3 colour channels, at most PAGE_MAX_PX on the long side).
export function imageToPage(input) {
  return limited(async () => {
    const sharp = await getSharp();
    try {
      const { data, info } = await sharp(input, { failOn: 'none', limitInputPixels: 80e6 })
        .rotate()
        .resize(PAGE_MAX_PX, PAGE_MAX_PX, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .toColourspace('srgb')
        .jpeg({ quality: 85 })
        .toBuffer({ resolveWithObject: true });
      return { jpeg: data, width: info.width, height: info.height };
    } catch (err) {
      throw Object.assign(new Error(`unreadable image: ${err?.message || err}`), { badImage: true });
    }
  });
}

const A4 = [595.28, 841.89];
const MARGIN = 24;
const MAX_PAGE_UNITS = 14400; // PDF viewers refuse pages bigger than this

// Where the picture goes on its page. Normal photos: A4 (upright or sideways), centred with a small margin.
// Very long / very wide pictures (chat screenshots, banners): the page takes the shape of the picture instead of a tiny strip on A4.
export function pageLayout(w, h) {
  const ratio = h / w;
  if (ratio > 1.9 || ratio < 0.52) {
    let pw = A4[0];
    let ph = pw * ratio;
    if (ph > MAX_PAGE_UNITS) { ph = MAX_PAGE_UNITS; pw = ph / ratio; }
    return { pw, ph, x: 0, y: 0, dw: pw, dh: ph };
  }
  const landscape = w > h;
  const pw = landscape ? A4[1] : A4[0];
  const ph = landscape ? A4[0] : A4[1];
  const s = Math.min((pw - 2 * MARGIN) / w, (ph - 2 * MARGIN) / h);
  const dw = w * s;
  const dh = h * s;
  return { pw, ph, x: (pw - dw) / 2, y: (ph - dh) / 2, dw, dh };
}

const f2 = (n) => Number(n).toFixed(2);

// One PDF with one picture per page. pages = [{ jpeg: Buffer, width, height }]
export function buildPdf(pages, { title = '' } = {}) {
  if (!pages?.length) throw new Error('no pages');
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); parts.push(buf); size += buf.length; };
  const obj = (n, body) => { offsets[n] = size; push(`${n} 0 obj\n${body}\nendobj\n`); };
  const streamObj = (n, dict, data) => {
    offsets[n] = size;
    push(`${n} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`);
    push(data);
    push('\nendstream\nendobj\n');
  };

  const kids = pages.map((_, i) => `${4 + 3 * i} 0 R`).join(' ');
  const safeTitle = String(title).replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '').slice(0, 80);
  const date = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  push(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4 + binary marker
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  obj(3, `<< /Producer (RIO X MD)${safeTitle ? ` /Title (${safeTitle})` : ''} /CreationDate (D:${date}Z) >>`);
  pages.forEach((p, i) => {
    if (p.jpeg[0] !== 0xff || p.jpeg[1] !== 0xd8) throw new Error('page is not a JPEG');
    const L = pageLayout(p.width, p.height);
    const page = 4 + 3 * i;
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f2(L.pw)} ${f2(L.ph)}] /Resources << /XObject << /Im0 ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`);
    streamObj(page + 1, '', Buffer.from(`q ${f2(L.dw)} 0 0 ${f2(L.dh)} ${f2(L.x)} ${f2(L.y)} cm /Im0 Do Q`, 'latin1'));
    streamObj(page + 2, `/Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, p.jpeg);
  });

  const count = 4 + 3 * pages.length - 1; // objects 1 .. count
  const xref = size;
  let table = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(`${table}trailer\n<< /Size ${count + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/* ---------- .ocr ---------- */
export const DEFAULT_OCR_LANGS = ['sin', 'eng'];
const OCR_WORDS = { en: 'eng', eng: 'eng', english: 'eng', si: 'sin', sin: 'sin', sinhala: 'sin', ta: 'tam', tam: 'tam', tamil: 'tam' };
export const OCR_NAMES = { eng: 'English', sin: 'Sinhala', tam: 'Tamil' };

// "si" / "en" / "si+en" -> ['sin'] / ['eng'] / ['sin','eng'].  Anything that is not a language word -> null.
export function parseOcrLang(word) {
  const parts = String(word || '').toLowerCase().split(/[+,]/).filter(Boolean);
  if (!parts.length || parts.some((p) => !OCR_WORDS[p])) return null;
  return [...new Set(parts.map((p) => OCR_WORDS[p]))];
}

let langCache = null; // Promise<Set<string>>
export function ocrLangs() {
  langCache ||= run(TESSERACT(), ['--list-langs'], { timeout: 15000 })
    .then((out) => new Set(out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean)))
    .catch((err) => { langCache = null; throw err; }); // not installed now, maybe later: do not remember a failure
  return langCache;
}
export const resetOcrLangs = () => { langCache = null; };

// Cleans what tesseract printed: no form feeds, no trailing spaces, no more than one empty line in a row.
export function cleanOcrText(text) {
  return String(text || '').replace(/\f/g, '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Returns { text, langs, skipped }. langs = what was used; skipped = wanted languages that are not installed on this server.
export async function ocrImage(input, wanted = DEFAULT_OCR_LANGS) {
  const have = await ocrLangs();
  const langs = wanted.filter((l) => have.has(l));
  const skipped = wanted.filter((l) => !have.has(l));
  if (!langs.length) throw Object.assign(new Error('language data missing'), { noLang: skipped });
  const sharp = await getSharp();
  return limited(() => withTmp(async (dir) => {
    const inFile = path.join(dir, 'in.png');
    try {
      const meta = await sharp(input, { failOn: 'none', limitInputPixels: 80e6 }).metadata();
      const width = meta.width || 0;
      const target = width < 1200 ? 1600 : width > 3200 ? 3200 : width; // tiny photos are enlarged, huge ones shrunk: tesseract likes about 300 dpi
      await sharp(input, { failOn: 'none', limitInputPixels: 80e6 }).rotate().flatten({ background: '#ffffff' }).grayscale().normalise()
        .resize({ width: target, withoutEnlargement: false }).png().toFile(inFile);
    } catch (err) {
      throw Object.assign(new Error(`unreadable image: ${err?.message || err}`), { badImage: true });
    }
    const out = await run(TESSERACT(), [inFile, 'stdout', '-l', langs.join('+'), '--dpi', '300'], { timeout: 120000, env: { OMP_THREAD_LIMIT: '1' } });
    return { text: cleanOcrText(out), langs, skipped };
  }));
}
