// Helpers for commands/mediatools.js:  .tomp3  .topdf  .ocr
//   findMedia(msg, jid)         the photo / video / audio / document in this message, or in the message it replies to
//   downloadMedia(sock, media)  Buffer of that media (size checked)
//   toMp3(buf)                  video / audio / voice note -> MP3          (ffmpeg)
//   imageToPage(buf)            photo -> { jpeg, width, height } ready for a PDF page   (sharp)
//   renderTextPages(text)       text -> A4 text pages (drawn as pictures, so Sinhala / Tamil / emoji work)   (sharp + system fonts)
//   renderFooterImage(text)     one-line footer picture for the bottom of every PDF page               (sharp + system fonts)
//   buildPdf(pages, { title, footer, pageNumbers })  list of pages -> one PDF Buffer, footer + page number at the bottom of every page   (plain Node, no extra npm package)
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
// reserve = height (pt) kept free at the bottom for the footer line; 0 = no footer (the picture may use the whole page).
export const FOOTER_RESERVE = 34;
export function pageLayout(w, h, reserve = 0) {
  const ratio = h / w;
  if (ratio > 1.9 || ratio < 0.52) {
    let pw = A4[0];
    let ph = pw * ratio;
    if (ph > MAX_PAGE_UNITS - reserve) { ph = MAX_PAGE_UNITS - reserve; pw = ph / ratio; }
    return { pw, ph: ph + reserve, x: 0, y: reserve, dw: pw, dh: ph };
  }
  const landscape = w > h;
  const pw = landscape ? A4[1] : A4[0];
  const ph = landscape ? A4[0] : A4[1];
  const s = Math.min((pw - 2 * MARGIN) / w, (ph - 2 * MARGIN - reserve) / h);
  const dw = w * s;
  const dh = h * s;
  return { pw, ph, x: (pw - dw) / 2, y: reserve + (ph - reserve - dh) / 2, dw, dh };
}

const f2 = (n) => Number(n).toFixed(2);

// Width of a short ASCII string in Helvetica (only what the page number needs: digits, space, slash).
const helvWidth = (str, size) => { let u = 0; for (const c of str) u += c === ' ' || c === '/' ? 278 : 556; return (u * size) / 1000; };
const pdfStr = (str) => String(str ?? '').replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '').trim().slice(0, 90);

// One PDF with one picture per page. pages = [{ jpeg: Buffer, width, height }]
//   footer      = { image: { jpeg, width, height, dpi }, text }  small line at the bottom of every page. Without an image (no fonts / no sharp)
//                 the text is written with the built-in Helvetica font (plain English letters only).
//   pageNumbers = "2 / 5" at the bottom right of every page.
// Without footer and pageNumbers the PDF is exactly as before.
export function buildPdf(pages, { title = '', footer = null, pageNumbers = false } = {}) {
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

  const total = pages.length;
  const fImg = footer?.image?.jpeg?.[0] === 0xff && footer.image.jpeg[1] === 0xd8 ? footer.image : null;
  const fText = pdfStr(footer?.text);
  const showFooter = Boolean(fImg || fText || pageNumbers);
  const fontObj = 4 + 3 * total;           // shared objects come after the pages
  const imgObj = fImg ? fontObj + 1 : 0;
  const lastObj = showFooter ? (fImg ? fontObj + 1 : fontObj) : 3 + 3 * total;

  // Footer drawing for one page: thin line, footer text / picture on the left, page number on the right.
  const footerOps = (pw, num) => {
    const mx = 28;
    const fs = 8;
    const label = pageNumbers ? `${num} / ${total}` : '';
    const numW = label ? helvWidth(label, fs) : 0;
    let ops = `q 0.78 G 0.5 w ${f2(mx)} 25 m ${f2(pw - mx)} 25 l S Q`;
    if (fImg) {
      const k = 72 / (fImg.dpi || 300);
      let fw = fImg.width * k;
      let fh = fImg.height * k;
      const maxW = pw - 2 * mx - numW - 14;
      if (fw > maxW) { const sc = maxW / fw; fw *= sc; fh *= sc; }
      ops += `\nq ${f2(fw)} 0 0 ${f2(fh)} ${f2(mx)} ${f2(13 - fh / 2)} cm /Ft Do Q`;
    } else if (fText) {
      ops += `\nBT /F1 ${fs} Tf 0.4 g ${f2(mx)} 10 Td (${fText.slice(0, 70)}) Tj ET`;
    }
    if (label) ops += `\nBT /F1 ${fs} Tf 0.4 g ${f2(pw - mx - numW)} 10 Td (${label}) Tj ET`;
    return ops;
  };

  const kids = pages.map((_, i) => `${4 + 3 * i} 0 R`).join(' ');
  const safeTitle = String(title).replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '').slice(0, 80);
  const date = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  push(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4 + binary marker
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`);
  obj(3, `<< /Producer (RIO X MD)${safeTitle ? ` /Title (${safeTitle})` : ''} /CreationDate (D:${date}Z) >>`);
  pages.forEach((p, i) => {
    if (p.jpeg[0] !== 0xff || p.jpeg[1] !== 0xd8) throw new Error('page is not a JPEG');
    let L = pageLayout(p.width, p.height, showFooter ? FOOTER_RESERVE : 0);
    let draw = showFooter;
    if (draw && L.pw < 200) { L = pageLayout(p.width, p.height, 0); draw = false; } // a very narrow strip has no room for a footer
    const page = 4 + 3 * i;
    const res = draw
      ? `/Resources << /XObject << /Im0 ${page + 2} 0 R${fImg ? ` /Ft ${imgObj} 0 R` : ''} >> /Font << /F1 ${fontObj} 0 R >> >>`
      : `/Resources << /XObject << /Im0 ${page + 2} 0 R >> >>`;
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f2(L.pw)} ${f2(L.ph)}] ${res} /Contents ${page + 1} 0 R >>`);
    let content = `q ${f2(L.dw)} 0 0 ${f2(L.dh)} ${f2(L.x)} ${f2(L.y)} cm /Im0 Do Q`;
    if (draw) content += `\n${footerOps(L.pw, i + 1)}`;
    streamObj(page + 1, '', Buffer.from(content, 'latin1'));
    streamObj(page + 2, `/Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, p.jpeg);
  });
  if (showFooter) {
    obj(fontObj, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    if (fImg) streamObj(imgObj, `/Type /XObject /Subtype /Image /Width ${fImg.width} /Height ${fImg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, fImg.jpeg);
  }

  const xref = size;
  let table = `xref\n0 ${lastObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= lastObj; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(`${table}trailer\n<< /Size ${lastObj + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/* ---------- text pages and the footer picture (.topdf text, footer on every page) ---------- */
// Text is drawn as a picture (sharp + Pango + the server's fonts), so Sinhala, Tamil and emoji work. The Docker image has the Noto fonts.
// The text inside the PDF is therefore not selectable / searchable: it is a picture, like the photo pages.
export const MAX_TEXT_CHARS = Math.max(500, Number(process.env.TOPDF_MAX_TEXT_CHARS || 5000)); // per ".topdf text" message
const MAX_TEXT_LINES = 250;
const PDF_FONT = String(process.env.PDF_FONT || 'Noto Sans').replace(/[<>&"]/g, '').trim() || 'Noto Sans';
const TEXT_W = 1200;                                                             // text page picture, px
const TEXT_PAD = 66;                                                             // inner margin, px (about 30 pt)
const TEXT_H = Math.round((TEXT_W * (A4[1] - 2 * MARGIN - FOOTER_RESERVE)) / (A4[0] - 2 * MARGIN)); // same shape as the free area of an A4 page with footer
const TEXT_DPI = Math.round((TEXT_W / (A4[0] - 2 * MARGIN)) * 72);              // 12 pt text ends up 12 pt on the page
const FOOTER_DPI = 300;

const escMarkup = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Clean the text: no control characters, \n line breaks, at most 2 empty lines in a row, capped. Returns { text, truncated }.
export function prepText(raw) {
  let t = String(raw ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  let truncated = false;
  const chars = Array.from(t);
  if (chars.length > MAX_TEXT_CHARS) { t = chars.slice(0, MAX_TEXT_CHARS).join('').trimEnd(); truncated = true; }
  const lines = t.split('\n');
  if (lines.length > MAX_TEXT_LINES) { t = lines.slice(0, MAX_TEXT_LINES).join('\n').trimEnd(); truncated = true; }
  return { text: t, truncated };
}

// ink[y] = number of dark pixels in row y of one tall text picture. Returns the [from, to) row ranges of the pages: a page is cut
// in a gap between two lines (3 empty rows in a row), looking only at the lower 40% of the page; if there is no gap, where there is least ink.
export function splitRows(ink, avail) {
  const H = ink.length;
  const out = [];
  let y = 0;
  while (y < H) {
    while (y < H && ink[y] === 0) y++;   // no empty rows at the top of a page
    if (y >= H) break;
    let end = Math.min(H, y + avail);
    if (end < H) {
      const floor = y + Math.floor(avail * 0.6);
      let cut = -1;
      for (let r = end; r > floor; r--) if (ink[r - 1] === 0 && ink[r - 2] === 0 && ink[r - 3] === 0) { cut = r; break; }
      if (cut < 0) {
        let best = Infinity;
        for (let r = end; r > floor; r--) if (ink[r - 1] < best) { best = ink[r - 1]; cut = r; }
      }
      end = cut;
    }
    out.push([y, end]);
    y = end;
  }
  return out;
}

// Text -> { pages: [{ jpeg, width, height }], truncated }. At most maxPages pages.
export async function renderTextPages(raw, { maxPages = MAX_PDF_PAGES } = {}) {
  const { text, truncated: cut } = prepText(raw);
  if (!text) throw Object.assign(new Error('no text'), { noText: true });
  return limited(async () => {
    const sharp = await getSharp();
    try {
      const png = await sharp({ text: { text: `<span foreground="#1a1a1a">${escMarkup(text)}</span>`, font: `${PDF_FONT} 12`, width: TEXT_W - 2 * TEXT_PAD, dpi: TEXT_DPI, align: 'left', wrap: 'word-char', rgba: true } })
        .flatten({ background: '#ffffff' }).toColourspace('srgb').png().toBuffer();
      const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
      const ink = new Uint32Array(info.height);
      for (let y = 0; y < info.height; y++) {
        let n = 0;
        const row = y * info.width * info.channels;
        for (let x = 0; x < info.width; x++) if (data[row + x * info.channels] < 200) n++;
        ink[y] = n;
      }
      const ranges = splitRows(ink, TEXT_H - 2 * TEXT_PAD);
      let truncated = cut;
      if (ranges.length > maxPages) { ranges.length = Math.max(0, maxPages); truncated = true; }
      const pages = [];
      for (const [from, to] of ranges) {
        const piece = await sharp(png).extract({ left: 0, top: from, width: info.width, height: to - from }).toBuffer();
        const jpeg = await sharp({ create: { width: TEXT_W, height: TEXT_H, channels: 3, background: '#ffffff' } })
          .composite([{ input: piece, left: TEXT_PAD, top: TEXT_PAD }])
          .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
        pages.push({ jpeg, width: TEXT_W, height: TEXT_H });
      }
      if (!pages.length) throw new Error('nothing was drawn');
      return { pages, truncated };
    } catch (err) {
      throw Object.assign(new Error(`could not draw the text: ${err?.message || err}`), { badText: true });
    }
  });
}

// One line of footer text -> small JPEG for the bottom of the PDF pages. Returns null when it cannot be drawn (the PDF then uses plain Helvetica text).
export async function renderFooterImage(text) {
  const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return null;
  try {
    return await limited(async () => {
      const sharp = await getSharp();
      const { data, info } = await sharp({ text: { text: `<span foreground="#666666">${escMarkup(clean)}</span>`, font: `${PDF_FONT} 8`, dpi: FOOTER_DPI, wrap: 'none', rgba: true } })
        .flatten({ background: '#ffffff' }).toColourspace('srgb')
        .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
      return { jpeg: data, width: info.width, height: info.height, dpi: FOOTER_DPI };
    });
  } catch (err) {
    logger.warn?.(`pdf footer picture failed: ${err?.message || err}`);
    return null;
  }
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
